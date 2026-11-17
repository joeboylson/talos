# talos-server, ready for AWS (ECS on Fargate, or anything that runs a container).
# Build from the repo root, since it needs talos-shared and talos-web too:
#   docker build -f talos-server/Dockerfile -t talos-server .
#
# Settings come from the environment, never the image:
#   TALOS_MACHINE_KEY (required; on AWS, from Secrets Manager)
#   TALOS_SERVER_PORT (optional; 7070)

FROM oven/bun:1.4.4-slim
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

COPY talos-shared/src talos-shared/src
COPY talos-web/src talos-web/src
COPY talos-server/src talos-server/src

USER bun
EXPOSE 7070
# AWS's load balancer checks GET /health; Docker's own HEALTHCHECK isn't needed.
CMD ["bun", "talos-server/src/index.ts"]
