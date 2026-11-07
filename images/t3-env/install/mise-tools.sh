#!/bin/bash
# Installs the global tools in /etc/mise/conf.d/50-tools.toml.
. "$(dirname "$0")/common.sh"
install -m 0644 "$T3M_BUILD/mise-tools.toml" /etc/mise/conf.d/50-tools.toml
cd /
mise install --system
rm -rf /root/.cache/mise /root/.npm /tmp/mise-*
give_to_dev /usr/local/share/mise/installs
mise reshim
