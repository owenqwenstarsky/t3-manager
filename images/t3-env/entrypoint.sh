#!/bin/bash
# T3 environment entrypoint (runs as root under tini).
#
# 1. Starts tailscaled in userspace mode (no /dev/net/tun or NET_ADMIN needed).
# 2. Joins the tailnet with /etc/t3m/ts_authkey if present (deleted afterwards),
#    otherwise waits for an interactive login whose URL the dashboard shows.
# 3. Publishes T3 over Tailscale Serve HTTPS once logged in.
# 4. Points Claude Code and Codex at the model proxy.
# 5. Runs `t3 serve` as the dev user on loopback.
set -euo pipefail

log() { echo "t3-env: $*"; }

TS_SOCKET=/var/run/tailscale/tailscaled.sock
TS_HOSTNAME="${TS_HOSTNAME:-$(hostname)}"
T3_PORT="${T3_PORT:-3773}"
DEV_HOME=/home/dev

mkdir -p /var/lib/tailscale /var/run/tailscale
chown dev:dev "$DEV_HOME" "$DEV_HOME/workspace" 2>/dev/null || true

# --- Tailscale -------------------------------------------------------------
tailscaled --tun=userspace-networking --statedir=/var/lib/tailscale \
  --socket="$TS_SOCKET" --port=0 >/var/log/tailscaled.log 2>&1 &

for _ in $(seq 1 50); do
  tailscale --socket="$TS_SOCKET" status --json >/dev/null 2>&1 && break
  # status exits non-zero while logged out but still answers; check the socket
  [ -S "$TS_SOCKET" ] && tailscale --socket="$TS_SOCKET" version >/dev/null 2>&1 && break
  sleep 0.2
done

backend_state() {
  tailscale --socket="$TS_SOCKET" status --json 2>/dev/null | jq -r '.BackendState // "Unknown"'
}

up_args=(--socket="$TS_SOCKET" up --hostname="$TS_HOSTNAME" --accept-dns=false)
[ -n "${TS_EXTRA_ARGS:-}" ] && read -r -a extra <<<"$TS_EXTRA_ARGS" && up_args+=("${extra[@]}")

state="$(backend_state)"
if [ "$state" != "Running" ]; then
  if [ -s /etc/t3m/ts_authkey ]; then
    log "joining tailnet as ${TS_HOSTNAME}"
    if tailscale "${up_args[@]}" --auth-key="file:/etc/t3m/ts_authkey" --timeout=90s; then
      log "joined tailnet"
    else
      log "tailscale up with the auth key failed; falling back to interactive login"
      tailscale "${up_args[@]}" >/var/log/tailscale-up.log 2>&1 &
    fi
  else
    log "no auth key; waiting for interactive tailnet login (see the dashboard)"
    tailscale "${up_args[@]}" >/var/log/tailscale-up.log 2>&1 &
  fi
fi
# The key is only needed once; node state persists in /var/lib/tailscale.
rm -f /etc/t3m/ts_authkey

# Publish T3 over HTTPS as soon as the node is running.
(
  for _ in $(seq 1 1800); do
    if [ "$(backend_state)" = "Running" ]; then
      if tailscale --socket="$TS_SOCKET" serve --bg --https=443 "http://127.0.0.1:${T3_PORT}" >/var/log/tailscale-serve.log 2>&1; then
        log "serving https://$(tailscale --socket="$TS_SOCKET" status --json | jq -r '.Self.DNSName' | sed 's/\.$//')/"
      else
        log "tailscale serve failed (is HTTPS enabled for the tailnet?): $(tail -n 3 /var/log/tailscale-serve.log)"
      fi
      exit 0
    fi
    sleep 2
  done
) &

# --- Agents ------------------------------------------------------------------
PROXY_KEY=""
[ -s /etc/t3m/proxy_key ] && PROXY_KEY="$(cat /etc/t3m/proxy_key)"
if [ -n "${PROXY_URL:-}" ] && [ -n "$PROXY_KEY" ]; then
  setpriv --reuid=dev --regid=dev --init-groups env HOME="$DEV_HOME" \
    PROXY_URL="$PROXY_URL" PROXY_KEY="$PROXY_KEY" /usr/local/lib/t3m/configure-agents.sh
else
  log "no proxy configured; Claude Code and Codex need their own login"
fi

# --- T3 Code -----------------------------------------------------------------
log "starting T3 Code on 127.0.0.1:${T3_PORT}"
cd "$DEV_HOME/workspace"
exec setpriv --reuid=dev --regid=dev --init-groups env \
  HOME="$DEV_HOME" USER=dev LOGNAME=dev SHELL=/bin/bash \
  PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
  T3CODE_HOME="$T3CODE_HOME" T3CODE_NO_BROWSER=1 \
  T3PROXY_API_KEY="$PROXY_KEY" \
  t3 serve --host 127.0.0.1 --port "$T3_PORT" --no-browser
