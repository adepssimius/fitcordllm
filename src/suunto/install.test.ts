import { describe, expect, it } from "vitest";
import { loadCore } from "../config.js";
import { checksumFor, pickAsset, type ReleaseAsset } from "./install.js";
import { sessionJson } from "./mcp.js";

const asset = (name: string): ReleaseAsset => ({ name, url: `https://example.invalid/${name}` });

/** What upstream's GoReleaser config publishes. */
const upstream = [
  "checksums.txt",
  "suuntool_0.10.0_darwin_amd64.tar.gz",
  "suuntool_0.10.0_darwin_arm64.tar.gz",
  "suuntool_0.10.0_linux_amd64.tar.gz",
  "suuntool_0.10.0_linux_arm64.tar.gz",
].map(asset);

/** A hand-cut fork release: bare binaries under a different name. */
const fork = [
  "checksums.txt",
  "suuntool-guides-preview_darwin_arm64",
  "suuntool-guides-preview_linux_amd64",
  "suuntool-guides-preview_linux_arm64",
].map(asset);

describe("pickAsset", () => {
  it("finds upstream's archive for the cluster's platform", () => {
    expect(pickAsset(upstream, "linux", "x64")?.name).toBe("suuntool_0.10.0_linux_amd64.tar.gz");
  });

  it("finds a fork's bare binary, whatever it is called", () => {
    expect(pickAsset(fork, "linux", "x64")?.name).toBe("suuntool-guides-preview_linux_amd64");
  });

  it("does not confuse arm64 with amd64", () => {
    expect(pickAsset(upstream, "linux", "arm64")?.name).toBe("suuntool_0.10.0_linux_arm64.tar.gz");
    expect(pickAsset(fork, "darwin", "arm64")?.name).toBe("suuntool-guides-preview_darwin_arm64");
  });

  it("accepts x86_64 and aarch64 spellings", () => {
    expect(pickAsset([asset("suuntool_Linux_x86_64.tar.gz")], "linux", "x64")?.name).toBe(
      "suuntool_Linux_x86_64.tar.gz",
    );
    expect(pickAsset([asset("suuntool-linux-aarch64")], "linux", "arm64")?.name).toBe("suuntool-linux-aarch64");
  });

  it("never picks the checksum file, a signature or a package", () => {
    const noisy = ["checksums.txt", "suuntool_linux_amd64.sig", "suuntool_linux_amd64.deb", "suuntool_linux_amd64.sbom.json"];
    expect(pickAsset(noisy.map(asset), "linux", "x64")).toBeUndefined();
  });

  it("prefers a bare binary when a release has both", () => {
    const both = [asset("suuntool_linux_amd64.tar.gz"), asset("suuntool_linux_amd64")];
    expect(pickAsset(both, "linux", "x64")?.name).toBe("suuntool_linux_amd64");
  });

  it("returns nothing when the platform is not published", () => {
    expect(pickAsset(fork, "darwin", "x64")).toBeUndefined();
  });
});

describe("checksumFor", () => {
  const a = "a".repeat(64);
  const b = "b".repeat(64);
  const body = `${a}  suuntool_0.10.0_linux_amd64.tar.gz\n${b}  suuntool_0.10.0_linux_arm64.tar.gz\n`;

  it("returns the sum for the exact filename", () => {
    expect(checksumFor(body, "suuntool_0.10.0_linux_arm64.tar.gz")).toBe(b);
  });

  it("returns undefined for a file the list does not cover", () => {
    expect(checksumFor(body, "suuntool_0.10.0_linux_riscv.tar.gz")).toBeUndefined();
  });

  it("reads the binary-mode marker sha256sum writes", () => {
    expect(checksumFor(`${a} *suuntool`, "suuntool")).toBe(a);
  });
});

describe("sessionJson", () => {
  it("writes the field names suuntool reads", () => {
    const cfg = loadCore({
      DATA_DIR: "/tmp/fitcord-test",
      SUUNTOOL_SESSION_KEY: "k",
      SUUNTOOL_USERNAME: "runner",
      SUUNTOOL_COUNTRY: "US",
    } as NodeJS.ProcessEnv);
    const parsed = JSON.parse(sessionJson(cfg, new Date("2026-10-02T10:00:00.123Z"))) as Record<string, unknown>;
    expect(parsed).toEqual({
      sessionkey: "k",
      username: "runner",
      email: "",
      userKey: "",
      country: "US",
      server_time_offset_ms: 0,
      saved_at: "2026-10-02T10:00:00Z",
    });
  });

  it("survives a quote in a value, which the shell version had to escape by hand", () => {
    const cfg = loadCore({ DATA_DIR: "/tmp/fitcord-test", SUUNTOOL_SESSION_KEY: 'a"b\\c' } as NodeJS.ProcessEnv);
    expect((JSON.parse(sessionJson(cfg)) as { sessionkey: string }).sessionkey).toBe('a"b\\c');
  });
});
