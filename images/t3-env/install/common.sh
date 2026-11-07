#!/bin/bash
# Shared helpers for the image build scripts. Sourced, not run.
set -euo pipefail

# shellcheck disable=SC2034 # used by the scripts that source this
T3M_BUILD=/usr/local/lib/t3m/build
TOOLCHAINS="${TOOLCHAINS:-full}"
DEV_UID=1000
DEV_GID=1000

log() { echo "==> $*"; }

full() { [ "$TOOLCHAINS" = full ]; }

# Lines of a list file without comments or blanks.
list() { sed -e 's/#.*//' -e 's/[[:space:]]*$//' -e '/^$/d' "$1"; }

# All entries, or only the first one when TOOLCHAINS=minimal.
pick() { if full; then list "$1"; else list "$1" | head -n 1; fi; }

# Words of a space-separated value, or only the first when minimal.
pick_words() {
  # shellcheck disable=SC2086 # split on purpose
  if full; then printf '%s\n' $1; else printf '%s\n' $1 | head -n 1; fi
}

apt_install() {
  apt-get update
  apt-get install -y --no-install-recommends "$@"
  rm -rf /var/lib/apt/lists/*
}

# Toolchain directories belong to dev so `npm i -g`, `gem install`,
# `pip install`, `rustup component add` work like on a personal machine.
give_to_dev() { chown -R "$DEV_UID:$DEV_GID" "$@"; }
