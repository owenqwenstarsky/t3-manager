#!/bin/sh
# T3 Manager entrypoint for the proxy container.
# Creates /data/config.yaml on first start. The management API is only
# reachable on the internal Docker network and requires MANAGEMENT_PASSWORD.
set -eu

: "${MANAGEMENT_PASSWORD:?MANAGEMENT_PASSWORD must be set}"
CONFIG=/data/config.yaml
mkdir -p /data/auths "${T3EXT_DATA_DIR:-/data/t3ext}"

if [ ! -f "$CONFIG" ]; then
  # The proxy accepts unauthenticated requests when no client key exists, so
  # always seed one reserved key. The dashboard never removes the last key.
  reserved="t3m-reserved-$(openssl rand -hex 24)"
  cat > "$CONFIG" <<YAML
port: ${PROXY_PORT:-8317}
auth-dir: "/data/auths"
api-keys:
  - "${reserved}"
remote-management:
  allow-remote: true
  disable-control-panel: true
logging-to-file: false
YAML
  chmod 600 "$CONFIG"
  echo "t3-proxy: created $CONFIG"
fi

exec /usr/local/bin/cli-proxy-api --config "$CONFIG" "$@"
