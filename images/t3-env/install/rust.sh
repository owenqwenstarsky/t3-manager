#!/bin/bash
# rustup with toolchains in /opt/rust. Proxies (cargo, rustc, ...) are in
# /opt/rust/cargo/bin; at runtime CARGO_HOME is ~/.cargo so `cargo install`
# and the registry cache persist in the environment's home volume.
. "$(dirname "$0")/common.sh"
# shellcheck source=/dev/null
. "$T3M_BUILD/rust.conf"

: "${RUSTUP_HOME:?}" "${CARGO_HOME:?}"
mapfile -t toolchains < <(pick_words "$RUST_TOOLCHAINS")
default=${toolchains[0]}

curl -fsSL https://static.rust-lang.org/rustup/rustup-init.sh | sh -s -- -y --no-modify-path --profile minimal --default-toolchain none
comps=$(echo "$RUST_COMPONENTS" | tr ' ' ',')
for t in "${toolchains[@]}"; do
  # --allow-downgrade picks the newest nightly that has every component.
  "$CARGO_HOME/bin/rustup" toolchain install "$t" --profile minimal --component "$comps" --allow-downgrade
  if full; then
    # shellcheck disable=SC2086
    "$CARGO_HOME/bin/rustup" target add --toolchain "$t" $RUST_TARGETS
  fi
done
"$CARGO_HOME/bin/rustup" default "$default"
rm -rf "$CARGO_HOME/registry" "$RUSTUP_HOME/downloads" "$RUSTUP_HOME/tmp"
give_to_dev /opt/rust
"$CARGO_HOME/bin/rustc" --version
