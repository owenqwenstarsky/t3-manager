# T3 Manager dashboard. Build context: repository root.
FROM tailscale/tailscale:stable AS tailscale

FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN npm install -g pnpm@10.28.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/dashboard/package.json apps/dashboard/
RUN pnpm install --frozen-lockfile --filter @t3m/dashboard
COPY apps/dashboard apps/dashboard
RUN pnpm --filter @t3m/dashboard build

FROM node:24-bookworm-slim AS deps
WORKDIR /app
RUN npm install -g pnpm@10.28.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/dashboard/package.json apps/dashboard/
RUN pnpm install --frozen-lockfile --prod --filter @t3m/dashboard

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl jq tini \
    && rm -rf /var/lib/apt/lists/*
COPY --from=tailscale /usr/local/bin/tailscale /usr/local/bin/tailscale
COPY --from=tailscale /usr/local/bin/tailscaled /usr/local/bin/tailscaled
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/dashboard/node_modules ./apps/dashboard/node_modules
COPY --from=build /app/apps/dashboard/dist ./apps/dashboard/dist
COPY apps/dashboard/package.json ./apps/dashboard/
COPY apps/dashboard/docker-entrypoint.sh /usr/local/bin/t3m-dashboard-entrypoint
RUN chmod +x /usr/local/bin/t3m-dashboard-entrypoint && mkdir -p /data /var/lib/tailscale /var/run/tailscale
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data
WORKDIR /app/apps/dashboard
EXPOSE 8080
VOLUME ["/data", "/var/lib/tailscale"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD curl -fsS http://127.0.0.1:8080/api/session >/dev/null || exit 1
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/t3m-dashboard-entrypoint"]
