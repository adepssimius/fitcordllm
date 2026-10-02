# Deploying

fitcordllm is one container, one replica, one persistent volume. There is no
ingress: its only way in is the Discord gateway, which it dials out to.

## What it needs

| | |
| --- | --- |
| **Image** | `ghcr.io/<owner>/fitcordllm:main-<run>-<sha>`, published by CI on every push to `main`. |
| **Volume** | Mounted at `/data`, ReadWriteOnce. Holds every thread's clone, the SDK transcripts, the database and the cached Suunto CLI. Unshipped work exists only here — use replicated storage. |
| **`HOME`** | Must be on the volume (the image sets `/data/home`). The SDK keeps transcripts under it; without it, threads forget everything on restart. |
| **`/tmp`** | Writable (an `emptyDir` if the root filesystem is read-only). |
| **Strategy** | `Recreate`. Two replicas would fight over the volume and both answer every message. |
| **Egress** | Discord, `api.anthropic.com`, `github.com` and `api.github.com`, the Suunto and Liftosaur APIs, and whatever the repository's own scripts call. |
| **Probes** | `GET /healthz` (liveness), `GET /readyz` (ready once Discord is connected), `GET /metrics`. Port 8080. |
| **Kubernetes API** | None. Set `automountServiceAccountToken: false` — the agent has a shell. |

## Secrets

| Variable | |
| --- | --- |
| `CLAUDE_CODE_OAUTH_TOKEN` | `claude setup-token` |
| `DISCORD_BOT_TOKEN` | this bot's own application |
| `GITHUB_TOKEN` | fine-grained, Contents read/write on the one repository |
| `SUUNTOOL_SESSION_KEY` | from `~/.config/suuntool/session.json` after `suuntool login` |
| `LIFTOSAUR_API_KEY` | |

Everything else in [`.env.example`](../.env.example) is plain configuration.

## The reference deployment

The manifests for the author's cluster live in a separate GitOps repository
(`apps/fitcordllm/prod/`), not here: the image tag is rewritten in place by
Flux's `ImageUpdateAutomation`, so a copy in this repository would drift from
the one actually applied. A merge to `main` here is the deploy there.

## First start

1. The bot resolves the repository's default branch. A wrong `GIT_REPO` or a
   token without access shows up here, in the log, not in the first thread.
2. It downloads the Suunto CLI release named by `SUUNTOOL_REPO` and
   `SUUNTOOL_VERSION` into `/data/bin` and writes the session file. A failure
   disables the Suunto tools and is logged; the bot still starts.
3. It connects to Discord, then starts the scheduler.

The startup log line `fitcordllm starting` states what it ended up with:
repository, base branch, time zone, and whether Suunto and Liftosaur are on.

## Changing the Suunto CLI

Edit `SUUNTOOL_REPO` and/or `SUUNTOOL_VERSION` and restart. Each
repository-and-tag is cached separately, so switching back is instant.

## Rotating the Suunto session key

Replace `SUUNTOOL_SESSION_KEY` and restart. The session file is rewritten from
the environment on every start, so there is no stale copy to clear.
