import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, constants, copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { CoreConfig } from "../config.js";
import type { Logger } from "../logger.js";

const exec = promisify(execFile);

/**
 * Fetches the Suunto CLI from a GitHub release and caches it on the volume.
 *
 * The repository is configuration, not a constant. Upstream is the default,
 * but the reason this bot exists at all was a feature that lived on a fork for
 * months before it merged — so `SUUNTOOL_REPO` can point at any fork that
 * publishes release binaries, and `SUUNTOOL_VERSION` picks the tag.
 *
 * Done at startup rather than baked into the image for the same reason:
 * switching repository or version is a ConfigMap edit and a restart, not an
 * image rebuild. The download is cached per repository and tag under
 * `DATA_DIR/bin`, so a restart with the same settings touches the network only
 * to resolve `latest`.
 *
 * Release layouts differ. Upstream ships `suuntool_<ver>_linux_amd64.tar.gz`
 * (GoReleaser); a hand-cut fork release may ship a bare
 * `suuntool-something_linux_amd64`. `pickAsset` matches on platform and
 * architecture rather than on a filename template, and both shapes install.
 */

export interface ReleaseAsset {
  readonly name: string;
  readonly url: string;
}

export interface SuuntoolInstall {
  readonly bin: string;
  /** e.g. `tajchert/suuntool@v0.10.0`, for the startup log. */
  readonly source: string;
  /** False when the build has no `guides` command — publishing to the watch will not work. */
  readonly guides: boolean;
}

const ARCH_ALIASES: Record<string, readonly string[]> = {
  x64: ["amd64", "x86_64", "x64"],
  arm64: ["arm64", "aarch64"],
};

const NOT_A_BINARY = /(checksums?|sha256|\.sig$|\.pem$|\.sbom|\.json$|\.txt$|\.zip$|\.deb$|\.rpm$|\.apk$)/i;

/** Chooses the release asset for this platform, preferring a bare binary over an archive. */
export function pickAsset(
  assets: readonly ReleaseAsset[],
  platform: string,
  arch: string,
): ReleaseAsset | undefined {
  const arches = ARCH_ALIASES[arch] ?? [arch];
  const matches = assets.filter((a) => {
    const n = a.name.toLowerCase();
    if (NOT_A_BINARY.test(n)) return false;
    if (!n.includes(platform.toLowerCase())) return false;
    // Token match, so `arm64` does not satisfy a search for `amd64`'s `x64`
    // alias inside some longer word.
    return arches.some((alias) => new RegExp(`(^|[^a-z0-9])${alias}([^a-z0-9]|$)`).test(n));
  });
  const isArchive = (n: string): boolean => /\.(tar\.gz|tgz)$/i.test(n);
  return matches.find((a) => !isArchive(a.name)) ?? matches[0];
}

/** Reads a `checksums.txt` body (`<sha256>  <filename>` per line). */
export function checksumFor(checksums: string, filename: string): string | undefined {
  for (const line of checksums.split("\n")) {
    const m = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(line.trim());
    if (m && m[2] === filename) return m[1]!.toLowerCase();
  }
  return undefined;
}

async function runnable(bin: string): Promise<boolean> {
  try {
    await access(bin, constants.X_OK);
    await exec(bin, ["version"], { timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

async function hasGuides(bin: string): Promise<boolean> {
  try {
    await exec(bin, ["guides", "--help"], { timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

interface Release {
  readonly tag: string;
  readonly assets: readonly ReleaseAsset[];
}

async function resolveRelease(cfg: CoreConfig): Promise<Release> {
  const path =
    cfg.SUUNTOOL_VERSION === "latest" ? "releases/latest" : `releases/tags/${encodeURIComponent(cfg.SUUNTOOL_VERSION)}`;
  const res = await fetch(`https://api.github.com/repos/${cfg.SUUNTOOL_REPO}/${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "fitcordllm",
      ...(cfg.SUUNTOOL_GITHUB_TOKEN ? { authorization: `Bearer ${cfg.SUUNTOOL_GITHUB_TOKEN}` } : {}),
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    throw new Error(`GitHub returned ${res.status} for ${cfg.SUUNTOOL_REPO} ${cfg.SUUNTOOL_VERSION}`);
  }
  const body = (await res.json()) as {
    tag_name: string;
    assets: { name: string; browser_download_url: string }[];
  };
  return {
    tag: body.tag_name,
    assets: body.assets.map((a) => ({ name: a.name, url: a.browser_download_url })),
  };
}

async function download(url: string, token: string | undefined): Promise<Buffer> {
  const res = await fetch(url, {
    headers: {
      "user-agent": "fitcordllm",
      accept: "application/octet-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    redirect: "follow",
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`download of ${url} failed with ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Finds the executable inside an extracted archive. */
async function findBinary(dir: string): Promise<string | undefined> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  const files = entries.filter((e) => e.isFile());
  const exact = files.find((e) => e.name === "suuntool");
  const loose = files.find((e) => e.name.startsWith("suuntool") && !e.name.includes("."));
  const hit = exact ?? loose;
  return hit ? join(hit.parentPath, hit.name) : undefined;
}

async function install(cfg: CoreConfig, release: Release, dir: string, bin: string): Promise<void> {
  const asset = pickAsset(release.assets, process.platform, process.arch);
  if (!asset) {
    throw new Error(
      `release ${release.tag} of ${cfg.SUUNTOOL_REPO} has no asset for ${process.platform}/${process.arch} ` +
        `(found: ${release.assets.map((a) => a.name).join(", ") || "none"})`,
    );
  }

  const bytes = await download(asset.url, cfg.SUUNTOOL_GITHUB_TOKEN);

  // Verify when the release publishes checksums. A mismatch is fatal to the
  // install: this binary is about to be handed the Suunto session key.
  const sums = release.assets.find((a) => /^checksums?\.txt$/i.test(a.name));
  if (sums) {
    const expected = checksumFor((await download(sums.url, cfg.SUUNTOOL_GITHUB_TOKEN)).toString("utf8"), asset.name);
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (expected && expected !== actual) {
      throw new Error(`checksum mismatch for ${asset.name}: expected ${expected}, got ${actual}`);
    }
  }

  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });

  if (/\.(tar\.gz|tgz)$/i.test(asset.name)) {
    const archive = join(dir, asset.name);
    const unpacked = join(dir, "unpacked");
    await writeFile(archive, bytes);
    await mkdir(unpacked);
    await exec("tar", ["-xzf", archive, "-C", unpacked], { timeout: 60_000 });
    const found = await findBinary(unpacked);
    if (!found) throw new Error(`${asset.name} does not contain a suuntool binary`);
    await copyFile(found, bin);
    await rm(archive, { force: true });
    await rm(unpacked, { recursive: true, force: true });
  } else {
    await writeFile(bin, bytes);
  }
  await chmod(bin, 0o755);
}

/**
 * Returns a usable suuntool, or undefined when there is none — in which case
 * the bot still starts and simply has no Suunto tools. A fitness bot that
 * cannot reach the watch is degraded; one that refuses to boot cannot even say
 * so in Discord.
 */
export async function ensureSuuntool(cfg: CoreConfig, log: Logger): Promise<SuuntoolInstall | undefined> {
  if (cfg.SUUNTOOL_BIN) {
    if (!(await runnable(cfg.SUUNTOOL_BIN))) {
      log.error({ bin: cfg.SUUNTOOL_BIN }, "SUUNTOOL_BIN is set but does not run — Suunto tools disabled");
      return undefined;
    }
    return { bin: cfg.SUUNTOOL_BIN, source: cfg.SUUNTOOL_BIN, guides: await hasGuides(cfg.SUUNTOOL_BIN) };
  }

  const repoDir = join(cfg.DATA_DIR, "bin", cfg.SUUNTOOL_REPO.replace(/[^A-Za-z0-9._-]+/g, "_"));
  // Remembers what `latest` last resolved to, so a GitHub outage at startup
  // falls back to the binary already on disk instead of to no binary.
  const lastTagFile = join(repoDir, "last-tag");

  let tag: string;
  let release: Release | undefined;
  try {
    release = await resolveRelease(cfg);
    tag = release.tag;
  } catch (e) {
    const cached =
      cfg.SUUNTOOL_VERSION === "latest"
        ? await readFile(lastTagFile, "utf8").then((s) => s.trim()).catch(() => undefined)
        : cfg.SUUNTOOL_VERSION;
    if (!cached) {
      log.error({ err: e, repo: cfg.SUUNTOOL_REPO }, "could not resolve a suuntool release — Suunto tools disabled");
      return undefined;
    }
    log.warn({ err: e, tag: cached }, "could not reach GitHub for suuntool — trying the cached build");
    tag = cached;
  }

  const dir = join(repoDir, tag.replace(/[^A-Za-z0-9._-]+/g, "_"));
  const bin = join(dir, "suuntool");
  const source = `${cfg.SUUNTOOL_REPO}@${tag}`;

  if (!(await runnable(bin))) {
    if (!release) {
      log.error({ source }, "no cached suuntool for this version and GitHub is unreachable — Suunto tools disabled");
      return undefined;
    }
    try {
      await install(cfg, release, dir, bin);
    } catch (e) {
      log.error({ err: e, source }, "suuntool install failed — Suunto tools disabled");
      return undefined;
    }
    if (!(await runnable(bin))) {
      log.error({ source, bin }, "the downloaded suuntool does not run — Suunto tools disabled");
      return undefined;
    }
    log.info({ source, bin }, "suuntool installed");
  }

  await mkdir(repoDir, { recursive: true });
  await writeFile(lastTagFile, `${tag}\n`).catch(() => undefined);

  const guides = await hasGuides(bin);
  if (!guides) {
    log.warn({ source }, "this suuntool build has no `guides` command — publishing guides to the watch will fail");
  }
  return { bin, source, guides };
}
