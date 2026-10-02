# fitcordllm

Claude, in Discord, working in your training repository — self-hosted, so it
does not need a cloud container.

You mention the bot in a channel and it opens a thread. Each thread gets its
own clone of your repository on its own branch, plus your Suunto and Liftosaur
accounts over MCP. It edits files and runs the repository's scripts there.
Nothing reaches the base branch until you say "push it".

Built on the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk).

## What a thread is

| | |
| --- | --- |
| **A conversation** | The SDK's transcript, kept on the volume. A thread picks up where it left off after a restart, a redeploy, or a week of silence. |
| **A clone** | `DATA_DIR/threads/<session id>/`, on branch `fitcord/<date>-<slug>-<id>`, made fresh from the base branch when the thread starts. |
| **Private until shipped** | Edits in one thread are invisible to every other thread and to the base branch. |

Inside a thread it opened, every message is a prompt — no mention needed.
`stop` aborts the running turn.

### Pushing

Ask in the thread: *"push it"*, *"ship this"*, *"get this into master"*. The
agent calls the `ship` tool with a commit message, and the bot:

1. commits whatever the thread changed,
2. merges the base branch in if it has moved,
3. lands the result on the base branch as **one commit**, and
4. reports the commit id and the files.

It is a squash on purpose. The thread branch collects work-in-progress commits
and merges — bookkeeping nobody wants to read — so the base branch gets a single
commit per push and stays linear.

If the merge conflicts, the agent is given the files, resolves them by editing,
and ships again. It never runs `git commit` or `git push` itself: those are
refused, and its clone holds no credential anyway.

### Updating a thread

Ask: *"update this thread"*, *"pull in what I pushed from the other thread"*.
The `sync` tool merges the base branch's latest commits into the thread. Every
turn also tells the agent how far behind the thread is, so it can mention it
when it matters.

### Seeing what is where

Mention the bot with just `threads`. It lists each thread with its branch, how
many files it has not shipped, and how far behind it is — answered from the
database and the clones, with no model turn.

## Scheduled briefs

Ask in any thread: *"send me the morning brief every day at 6"*, *"every Sunday
at 7pm summarise the week"*. The agent stores a schedule (a cron line and a
prompt). When it fires, the prompt runs in a fresh conversation and the answer
is **posted to the channel as an ordinary message**.

To continue one, either **start a thread from the message** or **reply to it**.
Both carry on the same conversation, with the same clone the brief ran in — so
"log that as RPE 6 and push it" works straight from the morning brief.

A scheduled run cannot publish: the `ship` and schedule tools are not registered
for it at all. Files it writes stay in the brief's clone until you continue it
and ask.

Mention the bot with `schedules` to list them. A brief that came due while the
bot was down is skipped if it is more than `SCHEDULE_MAX_LATE_MS` late.

## Serving more than one person

One bot can serve several people. Each is a **profile**: a Discord channel
(and who may talk there), a repository and its token, a Suunto session, and
optionally Liftosaur. The bot identity, the Claude subscription and its quota
guard, the database and the volume are shared.

```bash
FITCORD_PROFILES=ben,amy
PROFILE_BEN_GIT_REPO=ben/training        PROFILE_AMY_GIT_REPO=amy/training
PROFILE_BEN_GITHUB_TOKEN=…               PROFILE_AMY_GITHUB_TOKEN=…
PROFILE_BEN_DISCORD_CHAT_CHANNEL_IDS=…   PROFILE_AMY_DISCORD_CHAT_CHANNEL_IDS=…
PROFILE_BEN_SUUNTOOL_SESSION_KEY=…       PROFILE_AMY_SUUNTOOL_SESSION_KEY=…
PROFILE_BEN_LIFTOSAUR_API_KEY=…          # Amy has none; hers is simply unset
```

A plain variable (`BOT_TIMEZONE`, `GIT_AUTHOR_NAME`, …) is the default for
every profile; `PROFILE_<NAME>_<VARIABLE>` overrides it for one. Mind that
with secrets: a plain `GITHUB_TOKEN` would be every profile's token.

The channel a message arrives in decides whose it is, so with several
profiles each needs a channel list. Threads, schedules and polls remember
their profile. Without `FITCORD_PROFILES` there is one profile, `default`,
read from the plain variables — which is how a single-person deployment is
configured. Naming profiles later keeps every existing thread: they are
handed to the first profile named.

## Polls

When the answer is one of a few known things, the agent asks with a native
Discord poll instead of making you type:

- **A rating** — how hard a session felt (1–10), how sore you are.
- **Which of several** — which muscles are sore (multi-select), which days are
  free.
- **A decision** — "run it as written", "drop a tier", "swap with tomorrow".
- **A yes/no** — including "Ship this to master?". A yes vote is the request.

The poll appears under the agent's reply. A few seconds after your last tap the
bot closes it and hands the answer to the agent as your next message, so
"RPE 7" goes into the log without a keystroke. The pause is deliberate: it is
what lets you fix a mis-tap, or pick three options on a multi-select.

A scheduled brief can end with a poll, and tapping it continues the brief in a
thread. A poll nobody answers is not an answer: the agent is told to leave the
field blank rather than guess.

Only votes from people on the allowlist count. The bot needs the **Create
Polls** permission.

## Tables

Discord does not render markdown tables. The agent writes an ordinary one and
the bot redraws it as a card with one entry per row: the first column is the
row's label, the other columns its value, and a column of GREEN / AMBER / RED
becomes a coloured dot and the card's accent colour.

## Suunto

The Suunto CLI ([`suuntool`](https://github.com/tajchert/suuntool)) is not baked
into the image. It is downloaded at startup from a GitHub release and cached on
the volume:

```bash
SUUNTOOL_REPO=tajchert/suuntool   # the default: upstream
SUUNTOOL_VERSION=v0.10.0          # a release tag, or `latest`
```

Point `SUUNTOOL_REPO` at a fork to run a build with something upstream lacks.
The release needs a binary for the platform; both a GoReleaser archive
(`suuntool_0.10.0_linux_amd64.tar.gz`) and a bare binary
(`anything_linux_amd64`) install, and `checksums.txt` is verified when present.
Changing either setting is a config change and a restart, not an image rebuild.

The session file is written at startup from `SUUNTOOL_SESSION_KEY` and friends.
When the key expires, replace it and restart.

## What the agent can and cannot do

It has Bash and file tools, because editing a repository and running its scripts
is the job. What contains it:

- **Edits stay in the thread's clone.** A `PreToolUse` gate refuses writes
  outside it.
- **It cannot publish by itself.** The GitHub token exists only in the bot
  process; the clone's remote is plain https with no credential. `ship` is the
  only path to the base branch.
- **Its environment is a short allowlist.** No Discord token, no GitHub token.
- **Only the MCP servers the bot defines exist.** `strictMcpConfig` is on, so a
  `.mcp.json` in the repository cannot add one.
- **No subagents and no `WebFetch`.** `WebSearch` is available.

What it *can* reach, and you should know it: the Anthropic credential (the
subprocess is the thing using it), the Suunto session file, and anything on the
internet via Bash. This is a single-person bot working on that person's own
repository and accounts. Do not share it.

Writes to Suunto and Liftosaur are real and immediate; `ship` does not hold them
back. The system prompt tells the agent to treat them like shipping — on
request, not as a side effect — but that is an instruction, not a gate.

## Running it

### Discord

1. Create an application and bot in the developer portal; the token is
   `DISCORD_BOT_TOKEN`.
2. **Enable the Message Content privileged intent.** Without it, messages inside
   a thread arrive empty.
3. Invite it with `View Channel`, `Send Messages`, `Create Public Threads`,
   `Send Messages in Threads`, `Add Reactions`, `Read Message History`, and
   `Create Polls`.
4. Give it a channel: `DISCORD_CHAT_CHANNEL_IDS`. Make the channel private, and
   Discord's permissions decide who may talk to the bot. `DISCORD_CHAT_USER_IDS`
   or `DISCORD_CHAT_ROLE_IDS` narrow that further, and are required only if
   the bot answers in any channel. **Startup refuses a profile with neither** —
   turns spend your own subscription.

### Configuration

Everything is environment variables; [`.env.example`](.env.example) lists them
with what each is for. The ones without which nothing works:

| Variable | |
| --- | --- |
| `CLAUDE_CODE_OAUTH_TOKEN` | from `claude setup-token` |
| `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`, `DISCORD_CHAT_CHANNEL_IDS` | |
| `GIT_REPO` | `owner/name` |
| `GITHUB_TOKEN` | fine-grained, Contents read/write on that one repository |
| `DATA_DIR`, `HOME` | both on persistent storage |

`GIT_BASE_BRANCH` defaults to whatever the remote's `HEAD` points at, so a
repository whose default is `master` needs no setting.

### Storage

One persistent volume, one replica. It holds the database, every thread's
clone, the SDK transcripts (under `HOME`) and the cached Suunto CLI. Unshipped
work lives **only** there, so put it on storage you trust.

A clone with nothing unshipped is deleted after `WORKSPACE_IDLE_DAYS` without a
turn; the thread stays resumable and gets a fresh clone when you next write in
it. A clone holding unshipped work is never deleted automatically.

### Deploying

[`deploy/README.md`](deploy/README.md) describes the Kubernetes shape.

## Local development

```bash
pnpm install
pnpm build
pnpm test        # includes real-git tests of ship / sync / conflicts
pnpm typecheck
```

`pnpm chat` is the same session manager, workspaces and tools, driven from
stdin — no Discord needed:

```bash
DATA_DIR="$PWD/.local" HOME="$PWD/.local/home" \
GIT_REPO=you/your-repo GITHUB_TOKEN=… CLAUDE_CODE_OAUTH_TOKEN=… \
  pnpm chat
```

Quit and start it again: it continues the same conversation in the same clone,
which is exactly what a thread does across a pod restart. `/status` shows the
clone's branch and unshipped files; `/new` starts another thread.

To try it without touching a real repository, point `GIT_REMOTE_URL` at a bare
repository on disk.

## Quota

Turns bill against the Claude subscription, so exhausting the limit locks you
out of your own editor. Three guards: an hourly SDK-turn budget
(`AGENT_TURNS_PER_HOUR`), a concurrency cap that drops to 1 under pressure, and a
cooldown driven by the SDK's own rate-limit events, persisted so a restart does
not immediately re-probe an exhausted limit. A refusal happens before anything
is sent to the model.

Scheduled briefs draw on the same budget. `SCHEDULE_MIN_INTERVAL_MIN` refuses a
schedule that would fire more often than every 30 minutes.
