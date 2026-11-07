#!/bin/bash
# Installs one language with mise into the system dir (/usr/local/share/mise):
#   lang.sh <tool> [versions-file-name]
# Writes /etc/mise/conf.d/20-<tool>.toml with the default (first) version and
# installs every listed version (only the default when TOOLCHAINS=minimal).
# Python gets all versions active, so python3.X commands exist for tox/nox.
. "$(dirname "$0")/common.sh"
tool=$1
file="$T3M_BUILD/versions/${2:-$tool}.txt"

mapfile -t versions < <(pick "$file")
default=${versions[0]}
if [ "$tool" = python ]; then
  value="[$(printf '"%s", ' "${versions[@]}" | sed 's/, $//')]"
else
  value="\"$default\""
fi
printf '# Written at build time from toolchains/versions/%s.txt\n[tools]\n%s = %s\n' \
  "$(basename "$file" .txt)" "$tool" "$value" > "/etc/mise/conf.d/20-$tool.toml"

cd /
args=()
for v in "${versions[@]}"; do args+=("$tool@$v"); done
log "installing ${args[*]}"
mise install --system "${args[@]}"
rm -rf /root/.cache/mise /tmp/mise-*
give_to_dev "/usr/local/share/mise/installs/$tool"
mise reshim
