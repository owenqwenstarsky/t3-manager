#!/bin/bash
# Rust CLIs via cargo-binstall (prebuilt where available, else built from
# source). A tool that fails twice is recorded and skipped.
. "$(dirname "$0")/common.sh"
while read -r tool; do
  log "cargo binstall $tool"
  try_install "$tool" cargo binstall --no-confirm --install-path "$CARGO_HOME/bin" "$tool"
done < <(list "$T3M_BUILD/cargo-tools.txt")
rm -rf "$CARGO_HOME/registry" "$CARGO_HOME/git" /root/.cache
give_to_dev /opt/rust/cargo
