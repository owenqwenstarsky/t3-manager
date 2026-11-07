#!/bin/bash
# Python CLIs, each in its own venv on the default Python, linked into /opt/t3m/bin.
. "$(dirname "$0")/common.sh"
mkdir -p /opt/t3m/bin
export UV_TOOL_DIR=/opt/t3m/uv-tools UV_TOOL_BIN_DIR=/opt/t3m/bin UV_CACHE_DIR=/tmp/uv-cache
python=$(mise which python)
while read -r pkg; do
  log "uv tool install $pkg"
  uv tool install --python "$python" "$pkg"
done < <(list "$T3M_BUILD/uv-tools.txt")
rm -rf /tmp/uv-cache
