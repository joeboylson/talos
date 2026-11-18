# talos-server, ready for AWS (ECS on Fargate, or anything that runs a container).
# Build from the repo root, since it needs talos-shared and talos-web too:
#   docker build -f talos-server/Dockerfile -t talos-server .
#
# Settings come from the environment, never the image. See .env.example for
# the list; on AWS, TALOS_GITHUB_CLIENT_SECRET and TALOS_SESSION_SECRET come
# from Secrets Manager, and the AWS_* emulator settings are left out.

# Pinned to the exact image, so a changed tag can't change what runs.
FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4
# The pinned image is the starting point; Debian's security fixes released
# since then go on top at each build (make security checks the result).
RUN apt-get update && apt-get upgrade -y --no-install-recommends && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production

# Every workspace's package.json is needed for the lockfile to match, even
# the ones this image doesn't run.
COPY package.json bun.lock ./
COPY talos/package.json talos/
COPY talos-desktop/package.json talos-desktop/
COPY talos-server/package.json talos-server/
COPY talos-shared/package.json talos-shared/
COPY talos-web/package.json talos-web/
RUN bun install --frozen-lockfile --production

# bunfig.toml and the tsconfigs: the page's Tailwind plugin and its @/ imports.
COPY bunfig.toml tsconfig.base.json ./
COPY talos-web/tsconfig.json talos-web/
COPY talos-shared/src talos-shared/src
COPY talos-web/src talos-web/src
COPY talos-server/src talos-server/src

USER bun
EXPOSE 7070
# AWS's load balancer checks GET /health; Docker's own HEALTHCHECK isn't needed.
CMD ["bun", "talos-server/src/index.ts"]
