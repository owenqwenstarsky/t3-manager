# One T3 Code environment: T3 server + Claude Code + Codex, joined to the
# tailnet with userspace Tailscale and published over Tailscale Serve HTTPS.
FROM tailscale/tailscale:stable AS tailscale

FROM node:24-bookworm-slim

ARG T3_VERSION=latest
ARG CLAUDE_CODE_VERSION=latest
ARG CODEX_VERSION=latest

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git git-lfs openssh-client sudo tini jq ripgrep fd-find \
      build-essential python3 python3-venv procps less unzip zip nano vim-tiny \
      iproute2 dnsutils locales \
    && ln -s /usr/bin/fdfind /usr/local/bin/fd \
    && sed -i 's/# en_US.UTF-8/en_US.UTF-8/' /etc/locale.gen && locale-gen \
    && rm -rf /var/lib/apt/lists/*

COPY --from=tailscale /usr/local/bin/tailscale /usr/local/bin/tailscale
COPY --from=tailscale /usr/local/bin/tailscaled /usr/local/bin/tailscaled

RUN npm install -g --no-fund --no-audit \
      "t3@${T3_VERSION}" \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
      "@openai/codex@${CODEX_VERSION}" \
    && npm cache clean --force

# The base image's "node" user (uid 1000) becomes "dev", the user T3 and
# its agents run as. dev has passwordless sudo inside its own container.
RUN usermod -l dev -d /home/dev -m node && groupmod -n dev node \
    && echo 'dev ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/dev && chmod 440 /etc/sudoers.d/dev \
    && mkdir -p /home/dev/workspace /etc/t3m /var/lib/tailscale /var/run/tailscale \
    && chown -R dev:dev /home/dev && chmod 700 /etc/t3m

COPY entrypoint.sh /usr/local/bin/t3-env-entrypoint
COPY lib/ /usr/local/lib/t3m/
RUN chmod +x /usr/local/bin/t3-env-entrypoint /usr/local/lib/t3m/*.sh

ENV LANG=en_US.UTF-8 \
    T3CODE_HOME=/home/dev/.t3 \
    T3CODE_NO_BROWSER=1 \
    T3_PORT=3773

VOLUME ["/home/dev", "/var/lib/tailscale"]
WORKDIR /home/dev/workspace
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
  CMD curl -fsS "http://127.0.0.1:${T3_PORT}/.well-known/t3/environment" >/dev/null || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/t3-env-entrypoint"]
