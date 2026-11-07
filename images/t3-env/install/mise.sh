#!/bin/bash
# The mise binary (checked against the release's checksums) and system config.
. "$(dirname "$0")/common.sh"
: "${MISE_VERSION:?}"

arch=$(uname -m); case "$arch" in x86_64) arch=x64 ;; aarch64) arch=arm64 ;; esac
base="https://github.com/jdx/mise/releases/download/v${MISE_VERSION}"
asset="mise-v${MISE_VERSION}-linux-${arch}"
curl -fsSL -o "/tmp/$asset" "$base/$asset"
curl -fsSL "$base/SHASUMS256.txt" | grep -E "  (\./)?${asset}\$" | sed 's#  \./#  #' | (cd /tmp && sha256sum -c -)
install -m 0755 "/tmp/$asset" /usr/local/bin/mise && rm "/tmp/$asset"

mkdir -p /etc/mise/conf.d /usr/local/share/mise
install -m 0644 "$T3M_BUILD/mise-config.toml" /etc/mise/config.toml
mise --version
