#!/bin/bash
# Clang/LLVM from apt.llvm.org. The default (first) version gets the full set,
# including libc++ and lldb, and becomes clang, clangd, lld, ... Other
# versions get the compiler and its tools only: libc++-N-dev packages conflict
# across versions, and older branches can have unresolvable lldb/libc++ deps.
. "$(dirname "$0")/common.sh"
# shellcheck source=/dev/null
. "$T3M_BUILD/llvm.conf"

codename=$(. /etc/os-release && echo "$VERSION_CODENAME")
curl -fsSL https://apt.llvm.org/llvm-snapshot.gpg.key | gpg --dearmor -o /usr/share/keyrings/llvm.gpg
mapfile -t versions < <(pick_words "$LLVM_VERSIONS")
for v in "${versions[@]}"; do
  echo "deb [signed-by=/usr/share/keyrings/llvm.gpg] https://apt.llvm.org/$codename/ llvm-toolchain-$codename-$v main" \
    >"/etc/apt/sources.list.d/llvm-$v.list"
done
apt-get update

default=${versions[0]}
apt-get install -y --no-install-recommends \
  "clang-$default" "lld-$default" "lldb-$default" "clangd-$default" "clang-format-$default" \
  "clang-tidy-$default" "libc++-$default-dev" "libc++abi-$default-dev"

for v in "${versions[@]:1}"; do
  try_install "clang-$v" apt-get install -y --no-install-recommends \
    "clang-$v" "lld-$v" "clangd-$v" "clang-format-$v" "clang-tidy-$v"
done
rm -rf /var/lib/apt/lists/*

for tool in clang clang++ clangd clang-format clang-tidy lld ld.lld lldb llvm-symbolizer llvm-ar llvm-objdump; do
  if [ -x "/usr/bin/$tool-$default" ]; then ln -sf "/usr/bin/$tool-$default" "/usr/local/bin/$tool"; fi
done
clang --version | head -n 1
