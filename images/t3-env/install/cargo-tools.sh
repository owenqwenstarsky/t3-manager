#!/bin/bash
# Rust CLIs via cargo-binstall (falls back to building from source).
. "$(dirname "$0")/common.sh"
mapfile -t tools < <(list "$T3M_BUILD/cargo-tools.txt")
cargo binstall --no-confirm --install-path "$CARGO_HOME/bin" "${tools[@]}"
rm -rf "$CARGO_HOME/registry" "$CARGO_HOME/git" /root/.cache
give_to_dev /opt/rust/cargo
