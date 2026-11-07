#!/bin/sh
# Joins the dashboard to the tailnet (userspace mode) and publishes it over
# Tailscale Serve HTTPS, then starts the dashboard. Set DASHBOARD_TAILSCALE=false
# to skip Tailscale and use the published port only.
set -eu

SOCK=/var/run/tailscale/tailscaled.sock
TS_HOSTNAME="${DASHBOARD_HOSTNAME:-t3-manager}"
PORT="${PORT:-8080}"

if [ "${DASHBOARD_TAILSCALE:-true}" != "false" ]; then
  tailscaled --tun=userspace-networking --statedir=/var/lib/tailscale --socket="$SOCK" --port=0 \
    >/var/log/tailscaled.log 2>&1 &
  i=0
  while [ ! -S "$SOCK" ] && [ $i -lt 50 ]; do sleep 0.2; i=$((i + 1)); done
  state="$(tailscale --socket="$SOCK" status --json 2>/dev/null | jq -r '.BackendState // ""' || true)"
  if [ "$state" != "Running" ]; then
    if [ -n "${TS_AUTHKEY:-}" ]; then
      tailscale --socket="$SOCK" up --hostname="$TS_HOSTNAME" --accept-dns=false \
        --auth-key="$TS_AUTHKEY" --timeout=90s \
        || echo "t3m: tailscale up failed; the dashboard is still on port $PORT"
    else
      echo "t3m: TS_AUTHKEY not set; logging in interactively. Open the URL below:"
      tailscale --socket="$SOCK" up --hostname="$TS_HOSTNAME" --accept-dns=false &
    fi
  fi
  (
    i=0
    while [ $i -lt 900 ]; do
      if [ "$(tailscale --socket="$SOCK" status --json 2>/dev/null | jq -r '.BackendState // ""')" = "Running" ]; then
        if tailscale --socket="$SOCK" serve --bg --https=443 "http://127.0.0.1:${PORT}" >/dev/null 2>&1; then
          echo "t3m: dashboard at https://$(tailscale --socket="$SOCK" status --json | jq -r '.Self.DNSName' | sed 's/\.$//')/"
        else
          echo "t3m: tailscale serve failed; enable HTTPS certificates for your tailnet (admin console > DNS)"
        fi
        exit 0
      fi
      sleep 2; i=$((i + 1))
    done
  ) &
fi

exec node dist/server/index.js
