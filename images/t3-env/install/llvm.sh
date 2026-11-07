#!/bin/bash
# Clang/LLVM from apt.llvm.org; the first version becomes clang, clangd, lld, ...
. "$(dirname "$0")/common.sh"
# shellcheck source=/dev/null
. "$T3M_BUILD/llvm.conf"

codename=$(. /etc/os-release && echo "$VERSION_CODENAME")
curl -fsSL https://apt.llvm.org/llvm-snapshot.gpg.key | gpg --dearmor -o /usr/share/keyrings/llvm.gpg
pkgs=()
for v in $(pick_words "$LLVM_VERSIONS"); do
  echo "deb [signed-by=/usr/share/keyrings/llvm.gpg] https://apt.llvm.org/$codename/ llvm-toolchain-$codename-$v main" \
    > "/etc/apt/sources.list.d/llvm-$v.list"
  pkgs+=("clang-$v" "lld-$v" "lldb-$v" "clangd-$v" "clang-format-$v" "clang-tidy-$v" "libc++-$v-dev" "libc++abi-$v-dev")
done
apt_install "${pkgs[@]}"

default=$(pick_words "$LLVM_VERSIONS" | head -n 1)
for tool in clang clang++ clangd clang-format clang-tidy lld ld.lld lldb llvm-symbolizer llvm-ar llvm-objdump; do
  [ -x "/usr/bin/$tool-$default" ] && ln -sf "/usr/bin/$tool-$default" "/usr/local/bin/$tool"
done
clang --version | head -n 1
