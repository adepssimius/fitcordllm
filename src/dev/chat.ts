/**
 * Headless chat REPL — the same session manager, workspaces and tools Discord
 * uses, driven from stdin. No Discord token and no bot in a guild.
 *
 *   pnpm build
 *   DATA_DIR="$PWD/.local" GIT_REPO=owner/name GITHUB_TOKEN=… pnpm chat
 *
 * Restarting the process continues the same conversation in the same clone,
 * which is the behaviour a Discord thread has across a pod restart.
 *
 * Commands: /new  /stop  /status  /stats  /quit
 */
import { createInterface } from "node:readline/promises";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { loadCore, credentialSource } from "../config.js";
import { createLogger } from "../logger.js";
import { openStore } from "../store/index.js";
import { SessionManager } from "../session/manager.js";
import { QuotaGuard } from "../quota/budget.js";
import { Workspaces } from "../git/workspaces.js";
import { prepareExternalTools } from "../suunto/mcp.js";

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";

async function main(): Promise<void> {
  const cfg = loadCore();
  const log = createLogger({ level: cfg.LOG_LEVEL, pretty: true });

  if (credentialSource(cfg) === "none") {
    console.error(
      "No Anthropic credentials. Set CLAUDE_CODE_OAUTH_TOKEN (generate with `claude setup-token`),\n" +
        "or AGENT_INHERIT_ENV=true for a locally-brokered credential.",
    );
    process.exit(1);
  }
  if (!cfg.remoteUrl) {
    console.error("Set GIT_REPO (owner/name) or GIT_REMOTE_URL — the session works in a clone of it.");
    process.exit(1);
  }

  mkdirSync(cfg.workspacesDir, { recursive: true });
  mkdirSync(dirname(cfg.sqlitePath), { recursive: true });

  const store = openStore(cfg.sqlitePath);
  const quota = new QuotaGuard(cfg, log, store, {
    onWarning: (_i, msg) => console.log(`${YELLOW}[quota] ${msg}${RESET}`),
    onCooldown: (_c, msg) => console.log(`${RED}[quota] ${msg}${RESET}`),
    onCooldownCleared: () => console.log(`${DIM}[quota] cooldown cleared${RESET}`),
  });
  const workspaces = new Workspaces(cfg, log);
  const external = await prepareExternalTools(cfg, log);
  const manager = new SessionManager({ cfg, log, store, workspaces, external, quota });

  // Boot recovery before accepting input, exactly as the pod will.
  const recovered = manager.recover();
  if (recovered.interrupted.length > 0) {
    console.log(
      `${YELLOW}${recovered.interrupted.length} session(s) had a turn interrupted by a restart; it was not retried.${RESET}`,
    );
  }

  const open = (threadId: string) =>
    manager.openChat({ guildId: "repl", channelId: "repl", threadId, openedBy: "repl-user", title: "repl" });

  const threadId = process.env.CHAT_THREAD_ID ?? "repl-thread";
  let session = open(threadId);

  console.log(`${DIM}session ${session.id.slice(0, 8)} · branch ${session.branch} · db ${cfg.sqlitePath}${RESET}`);
  console.log(
    `${DIM}model ${cfg.AGENT_MODEL ?? "default"} · auth ${credentialSource(cfg)} · ` +
      `suunto ${external.suuntoSource ?? "off"} · /new /stop /status /stats /quit${RESET}\n`,
  );

  // Async-iterator form rather than repeated question(): it terminates cleanly
  // at EOF, so the same REPL works with piped input in a scripted test.
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.setPrompt("› ");

  // With piped input, readline reaches EOF and emits `close` while an agent
  // turn is still awaiting, so prompting unguarded throws ERR_USE_AFTER_CLOSE.
  let closed = false;
  rl.on("close", () => {
    closed = true;
  });
  const prompt = (): void => {
    if (!closed) rl.prompt();
  };

  prompt();

  for await (const raw of rl) {
    const line = raw.trim();
    if (line.length === 0) {
      prompt();
      continue;
    }

    if (line === "/quit" || line === "/exit") break;

    if (line === "/new") {
      session = open(`repl-${randomUUID().slice(0, 8)}`);
      console.log(`${DIM}new session ${session.id.slice(0, 8)} · branch ${session.branch}${RESET}\n`);
      prompt();
      continue;
    }

    if (line === "/stop") {
      manager.abort(session.id);
      console.log(`${DIM}abort flag set — the current run will stop at its next tool call${RESET}\n`);
      prompt();
      continue;
    }

    if (line === "/status") {
      if (!(await workspaces.exists(session.id))) {
        console.log(`${DIM}no clone yet — it is created on the first message${RESET}\n`);
      } else {
        const st = await workspaces.status(session, { fetch: true });
        console.log(
          `${DIM}${st.dir}\nbranch ${st.branch} · base ${st.base} · behind ${st.behind} · ` +
            `unshipped ${st.unshipped.length}${st.unshipped.length > 0 ? `: ${st.unshipped.join(", ")}` : ""}${RESET}\n`,
        );
      }
      prompt();
      continue;
    }

    if (line === "/stats") {
      const s = store.sessions.byId(session.id);
      const q = quota.status();
      console.log(
        `${DIM}messages ${s?.turnCount ?? 0} · agent turns ${s?.agentTurnCount ?? 0} · ` +
          `cost $${(s?.costUsd ?? 0).toFixed(4)}${RESET}`,
      );
      console.log(
        `${DIM}quota ${q.spentLastHour}/${q.hourlyLimit} turns this hour · ` +
          `concurrency ${q.inFlight}/${q.concurrencyLimit}${q.queued > 0 ? ` · ${q.queued} queued` : ""}` +
          `${q.cooldown ? ` · COOLDOWN until ${new Date(q.cooldown.until).toISOString()}` : ""}${RESET}\n`,
      );
      prompt();
      continue;
    }

    // Re-read so counters and agentSessionId reflect the previous turn.
    session = store.sessions.byId(session.id) ?? session;

    const started = Date.now();
    let printedToolHeader = false;

    const result = await manager.runChatTurn(
      {
        session,
        trigger: session.turnCount === 0 ? "mention" : "thread_message",
        actorId: "repl-user",
        message: { authorDisplayName: "repl-user", content: line },
      },
      {
        onToolUse: (name, input) => {
          if (!printedToolHeader) {
            process.stdout.write("\n");
            printedToolHeader = true;
          }
          const short = JSON.stringify(input);
          console.log(`${DIM}  🔧 ${name.replace(/^mcp__/, "")} ${short.slice(0, 120)}${RESET}`);
        },
        onText: (t) => process.stdout.write(t),
        onRateLimit: (i) => {
          if (i.status !== "allowed") {
            console.log(
              `\n${YELLOW}[rate limit ${i.status}${i.rateLimitType ? ` · ${i.rateLimitType}` : ""}` +
                `${i.utilization !== undefined ? ` · ${Math.round(i.utilization * 100)}% used` : ""}]${RESET}`,
            );
          }
        },
      },
    );

    if (result.blocked) {
      console.log(`${RED}${result.message}${RESET}\n`);
      prompt();
      continue;
    }

    manager.markDelivered(result.turnId, "repl");

    const secs = ((Date.now() - started) / 1000).toFixed(1);
    if (result.contextRebuilt) {
      console.log(`\n${YELLOW}[earlier context was lost; answered from a rebuilt recap]${RESET}`);
    }
    if (!result.ok) {
      console.log(`\n${RED}[run failed] ${result.text}${RESET}`);
    }
    console.log(
      `\n${DIM}${secs}s · ${result.numTurns} turns · $${result.costUsd.toFixed(4)}` +
        `${result.deniedTools > 0 ? ` · ${result.deniedTools} denied` : ""}${RESET}\n`,
    );
    prompt();
  }

  if (!closed) rl.close();
  store.close();
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.stack : String(e));
  process.exit(1);
});
