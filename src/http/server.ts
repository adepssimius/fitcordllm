import { createServer as createHttpServer, type Server } from "node:http";
import type { QuotaGuard } from "../quota/budget.js";

/**
 * Probes and metrics. Nothing here accepts input — the bot's only ingress is
 * the Discord gateway — so plain `node:http` is enough.
 */

export interface HttpDeps {
  readonly quota: QuotaGuard;
  /** Reports whether the Discord gateway is connected. */
  readonly isReady: () => boolean;
}

export function createServer(deps: HttpDeps): Server {
  return createHttpServer((req, res) => {
    const send = (code: number, type: string, body: string): void => {
      res.writeHead(code, { "content-type": type });
      res.end(body);
    };
    const path = (req.url ?? "/").split("?")[0];

    if (req.method !== "GET") return send(405, "text/plain", "method not allowed\n");

    // Liveness: the process is up. Deliberately does not depend on Discord —
    // a gateway blip should not trigger a restart loop.
    if (path === "/healthz") return send(200, "application/json", '{"status":"ok"}\n');

    // Readiness: we can actually do the job.
    if (path === "/readyz") {
      return deps.isReady()
        ? send(200, "application/json", '{"status":"ready"}\n')
        : send(503, "application/json", '{"status":"not-ready","reason":"discord not connected"}\n');
    }

    if (path === "/metrics") {
      const q = deps.quota.status();
      const lines = [
        "# HELP fitcordllm_turns_last_hour SDK turns consumed in the last hour.",
        "# TYPE fitcordllm_turns_last_hour gauge",
        `fitcordllm_turns_last_hour ${q.spentLastHour}`,
        "# HELP fitcordllm_turns_hourly_limit Configured hourly turn budget.",
        "# TYPE fitcordllm_turns_hourly_limit gauge",
        `fitcordllm_turns_hourly_limit ${q.hourlyLimit}`,
        "# HELP fitcordllm_runs_in_flight Agent runs currently executing.",
        "# TYPE fitcordllm_runs_in_flight gauge",
        `fitcordllm_runs_in_flight ${q.inFlight}`,
        "# HELP fitcordllm_quota_cooldown 1 when the subscription quota is exhausted.",
        "# TYPE fitcordllm_quota_cooldown gauge",
        `fitcordllm_quota_cooldown ${q.cooldown ? 1 : 0}`,
      ];
      return send(200, "text/plain; version=0.0.4", `${lines.join("\n")}\n`);
    }

    return send(404, "text/plain", "not found\n");
  });
}
