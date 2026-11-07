#!/bin/bash
# Installs the global tools in /etc/mise/conf.d/50-tools.toml one by one.
# A tool that fails (twice) is recorded and commented out of the config, so
# shells don't warn about it, and the build carries on.
. "$(dirname "$0")/common.sh"
conf=/etc/mise/conf.d/50-tools.toml
install -m 0644 "$T3M_BUILD/mise-tools.toml" "$conf"
cd /

# Tool names: keys of the [tools] table, with or without quotes.
mapfile -t tools < <(sed -n -E 's/^[[:space:]]*"?([^"=[:space:]]+)"?[[:space:]]*=.*/\1/p' "$conf")
for tool in "${tools[@]}"; do
  log "mise install $tool"
  try_install "$tool" mise install --system "$tool"
  if [ -f "$MISSING_FILE" ] && grep -qxF "$tool" "$MISSING_FILE"; then
    # Comment the line out: '"npm:tsx" = "latest"' -> '# failed at build time: ...'
    awk -v t="$tool" '{ k = $0; sub(/^[[:space:]]*"?/, "", k); sub(/"?[[:space:]]*=.*/, "", k) }
      k == t && $0 !~ /^#/ { print "# failed at build time: " $0; next } { print }' "$conf" >"$conf.tmp"
    mv "$conf.tmp" "$conf"
  fi
done
rm -rf /root/.cache/mise /root/.npm /tmp/mise-*
give_to_dev /usr/local/share/mise/installs
mise reshim
