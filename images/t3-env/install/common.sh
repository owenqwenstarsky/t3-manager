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

# Tools that failed to install are recorded here (and listed for the agents and
# the dashboard) instead of failing a long build. Languages don't use this.
MISSING_FILE=/usr/local/share/t3m/missing-tools.txt

record_missing() {
  mkdir -p "$(dirname "$MISSING_FILE")"
  echo "$1" >>"$MISSING_FILE"
  echo "!!! could not install $1; continuing (recorded in $MISSING_FILE)" >&2
}

# try_install <label> <command...>: runs the command, retries once, and on a
# second failure records the label. Never fails the build.
try_install() {
  local label=$1
  shift
  "$@" && return 0
  log "retrying $label in 10s"
  sleep 10
  "$@" && return 0
  record_missing "$label"
  return 0
}

# Reads `apt-cache policy pkg...` output on stdin and prints the packages that
# have a real install candidate (virtual or unknown packages are left out).
# awk reads all of its input, so this is safe under pipefail.
apt_candidates() {
  awk '/^[^[:space:]].*:$/ { pkg = substr($0, 1, length($0) - 1); next }
       /^[[:space:]]+Candidate:/ { if (pkg != "" && $2 != "(none)") print pkg; pkg = "" }'
}
