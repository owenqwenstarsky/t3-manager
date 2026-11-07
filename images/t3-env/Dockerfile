# syntax=docker/dockerfile:1.10
# One T3 Code environment: T3 server + Claude Code + Codex, joined to the
# tailnet with userspace Tailscale and published over Tailscale Serve HTTPS,
# with full toolchains for Node, Python, Java, Go, Rust, Ruby, PHP and C/C++.
#
# What gets installed is data in toolchains/ (see docs/toolchains.md).
# Build args:
#   TOOLCHAINS=full|minimal  minimal = only the default version of each language
#                            (CI uses it; the full image is ~10-13 GB)
#   MISE_VERSION, AGENT_NODE, T3_VERSION, CLAUDE_CODE_VERSION, CODEX_VERSION
# Optional build secret github_token: used by mise and cargo-binstall to avoid
# GitHub's anonymous API rate limit (CI passes its token).

ARG BASE_IMAGE=buildpack-deps:trixie
ARG AGENT_NODE=24

FROM tailscale/tailscale:stable AS tailscale
FROM node:${AGENT_NODE}-trixie-slim AS agentnode

FROM ${BASE_IMAGE}
ARG TOOLCHAINS=full
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
ENV DEBIAN_FRONTEND=noninteractive \
    LANG=en_US.UTF-8 \
    TOOLCHAINS=${TOOLCHAINS} \
    RUSTUP_HOME=/opt/rust/rustup \
    CARGO_HOME=/opt/rust/cargo \
    PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright \
    MISE_YES=1 \
    PATH=/usr/local/share/mise/shims:/opt/rust/cargo/bin:/opt/t3m/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

ARG B=/usr/local/lib/t3m/build
COPY install/common.sh install/apt.sh toolchains/apt-packages.txt $B/
RUN $B/apt.sh

COPY --from=tailscale /usr/local/bin/tailscale /usr/local/bin/tailscaled /usr/local/bin/

# The Node T3 and the agents run on (also runs the Playwright installer).
COPY --from=agentnode /usr/local/bin/node /opt/t3m/node/bin/node
COPY --from=agentnode /usr/local/lib/node_modules/npm /opt/t3m/node/lib/node_modules/npm
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /opt/t3m/node/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /opt/t3m/node/bin/npx

COPY install/playwright.sh $B/
RUN $B/playwright.sh

COPY install/llvm.sh toolchains/llvm.conf $B/
RUN $B/llvm.sh

COPY install/php.sh toolchains/php.conf $B/
RUN $B/php.sh

COPY install/rust.sh toolchains/rust.conf $B/
RUN $B/rust.sh

ARG MISE_VERSION=2026.11.4
COPY install/mise.sh $B/
COPY toolchains/mise/config.toml $B/mise-config.toml
RUN $B/mise.sh

# One layer per language: editing one versions file rebuilds only that layer
# and the ones after it.
COPY install/lang.sh $B/
COPY toolchains/versions/node.txt $B/versions/
RUN --mount=type=secret,id=github_token,env=GITHUB_TOKEN,required=false $B/lang.sh node
COPY toolchains/versions/python.txt $B/versions/
RUN --mount=type=secret,id=github_token,env=GITHUB_TOKEN,required=false $B/lang.sh python
COPY toolchains/versions/java.txt $B/versions/
RUN --mount=type=secret,id=github_token,env=GITHUB_TOKEN,required=false $B/lang.sh java
COPY toolchains/versions/gradle.txt $B/versions/
RUN --mount=type=secret,id=github_token,env=GITHUB_TOKEN,required=false $B/lang.sh gradle
COPY toolchains/versions/go.txt $B/versions/
RUN --mount=type=secret,id=github_token,env=GITHUB_TOKEN,required=false $B/lang.sh go
COPY toolchains/versions/ruby.txt $B/versions/
RUN --mount=type=secret,id=github_token,env=GITHUB_TOKEN,required=false $B/lang.sh ruby

COPY install/mise-tools.sh $B/
COPY toolchains/mise/tools.toml $B/mise-tools.toml
RUN --mount=type=secret,id=github_token,env=GITHUB_TOKEN,required=false $B/mise-tools.sh

COPY install/cargo-tools.sh toolchains/cargo-tools.txt $B/
RUN --mount=type=secret,id=github_token,env=GITHUB_TOKEN,required=false $B/cargo-tools.sh
COPY install/go-tools.sh toolchains/go-tools.txt $B/
RUN $B/go-tools.sh
COPY install/uv-tools.sh toolchains/uv-tools.txt $B/
RUN $B/uv-tools.sh

COPY profile/bashrc.sh $B/
RUN cat $B/bashrc.sh >> /etc/bash.bashrc

# T3 and the agents change most often, so they come last.
ARG T3_VERSION=latest
ARG CLAUDE_CODE_VERSION=latest
ARG CODEX_VERSION=latest
COPY install/agents.sh $B/
RUN $B/agents.sh

COPY install/tools-md.sh $B/
RUN $B/tools-md.sh

RUN mkdir -p /etc/t3m /var/lib/tailscale /var/run/tailscale && chmod 700 /etc/t3m
COPY entrypoint.sh /usr/local/bin/t3-env-entrypoint
COPY lib/ /usr/local/lib/t3m/
COPY test/smoke.sh /usr/local/lib/t3m/smoke.sh
RUN chmod +x /usr/local/bin/t3-env-entrypoint /usr/local/lib/t3m/*.sh

# Runtime: dev's own installs (cargo install, pip --user, npm prefix,
# on-demand mise versions) live in the home volume and come first.
ENV CARGO_HOME=/home/dev/.cargo \
    GOPATH=/home/dev/go \
    PATH=/home/dev/.local/bin:/home/dev/.cargo/bin:/home/dev/go/bin:/home/dev/.local/share/mise/shims:/usr/local/share/mise/shims:/opt/rust/cargo/bin:/opt/t3m/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    CHROME_PATH=/usr/local/bin/chromium \
    T3CODE_HOME=/home/dev/.t3 \
    T3CODE_NO_BROWSER=1 \
    T3_PORT=3773
LABEL org.opencontainers.image.title="t3-env" \
      t3m.toolchains=${TOOLCHAINS}

VOLUME ["/home/dev", "/var/lib/tailscale"]
WORKDIR /home/dev/workspace
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
  CMD curl -fsS "http://127.0.0.1:${T3_PORT}/.well-known/t3/environment" >/dev/null || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/t3-env-entrypoint"]
