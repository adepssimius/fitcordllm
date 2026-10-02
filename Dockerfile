# syntax=docker/dockerfile:1

ARG NODE_IMAGE=node:24-bookworm-slim

# ---- build -------------------------------------------------------------------
FROM ${NODE_IMAGE} AS build
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@11.17.0 --activate

COPY package.json pnpm-lock.yaml ./
# NOTE: do not pass --no-optional / --ignore-optional here. The Agent SDK ships
# its Claude Code binary as an npm optional dependency; skipping optionals
# produces an image that fails at runtime with a missing-executable error.
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

# ---- runtime -----------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app

# git:     every thread works in a clone, and the bot ships from it.
# python3: the agent runs the repository's own scripts. Standard library only —
#          a repository whose scripts need packages needs them added here.
# The Suunto CLI is deliberately NOT installed here. It is downloaded at
# startup from the repository named by SUUNTOOL_REPO and cached on the volume,
# so pointing at a fork is a config change rather than an image rebuild — see
# src/suunto/install.ts.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git python3 tini \
 && rm -rf /var/lib/apt/lists/*

# Runtime deps only, optionals included so the bundled Claude Code binary is present.
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && corepack prepare pnpm@11.17.0 --activate \
 && pnpm install --frozen-lockfile --prod \
 && pnpm store prune

COPY --from=build /app/dist ./dist

# HOME must be writable and persistent: the SDK keeps session transcripts
# beneath it, and resuming a thread after a restart depends on them still being
# there. /data is the volume mount.
ENV NODE_ENV=production \
    HOME=/data/home \
    DATA_DIR=/data \
    HTTP_PORT=8080

RUN groupadd -g 10001 app && useradd -u 10001 -g app -d /data -s /usr/sbin/nologin app
USER 10001:10001

EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--enable-source-maps", "dist/main.js"]
