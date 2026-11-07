#!/bin/bash
# Smoke test for the t3-env image. Runs as dev, without starting T3:
#   docker run --rm --user dev --entrypoint /usr/local/lib/t3m/smoke.sh t3-env:latest
# SMOKE_NETWORK=1 also checks on-demand installs (needs internet access).
set -uo pipefail

fails=0
pass() { printf '  ok    %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; fails=$((fails + 1)); }
# check "label" command...: passes when the command exits 0.
check() {
  local label=$1 out
  shift
  if out=$("$@" 2>&1); then pass "$label: $(printf '%s' "$out" | head -n 1)"; else fail "$label: $(printf '%s' "$out" | tail -n 3 | tr '\n' ' ')"; fi
}
# expect "label" "substring" command...: passes when the output contains the substring.
expect() {
  local label=$1 want=$2 out
  shift 2
  out=$("$@" 2>&1)
  if [[ $out == *"$want"* ]]; then pass "$label"; else fail "$label: wanted '$want', got '$(printf '%s' "$out" | tail -n 2 | tr '\n' ' ')'"; fi
}

work=$(mktemp -d)
cd "$work" || exit 1
json=/usr/local/share/t3m/toolchains.json

echo "== T3 and agents"
for c in t3 claude codex; do check "$c" "$c" --version; done

echo "== CLIs"
for c in git git-lfs gh glab tea lazygit delta jq yq rg fd fzf bat eza tree http tmux direnv \
  watchexec entr hyperfine just task protoc buf shellcheck shfmt hadolint actionlint taplo \
  yamllint prettier eslint tsc tsx sqlite3 psql mariadb redis-cli mongosh nvim cmake ninja \
  meson ccache mold gdb lldb valgrind clang clangd clang-format clang-tidy gcc make composer \
  uv pipx poetry pdm hatch ruff black pre-commit ipython pnpm yarn bun deno mvn gradle kotlinc \
  gopls goimports dlv golangci-lint staticcheck air cargo-nextest cargo-binstall sccache chromium; do
  if command -v "$c" >/dev/null; then pass "$c"; else fail "$c not found"; fi
done
check "docker is absent" bash -c '! command -v docker'

echo "== Every preinstalled version is selectable"
while read -r v; do
  expect "node $v" "v$v" mise exec "node@$v" -- node --version
done < <(jq -r '.languages[] | select(.name == "Node.js") | .versions[]' "$json")
while read -r v; do
  minor=$(echo "$v" | cut -d. -f1-2)
  expect "python$minor" "Python $v" "python$minor" --version
done < <(jq -r '.languages[] | select(.name == "Python") | .versions[]' "$json")
while read -r v; do
  check "java $v" mise exec "java@$v" -- java -version
done < <(jq -r '.languages[] | select(.name | startswith("Java")) | .versions[]' "$json")
while read -r v; do
  expect "go $v" "go$v" mise exec "go@$v" -- go version
done < <(jq -r '.languages[] | select(.name == "Go") | .versions[]' "$json")
while read -r v; do
  expect "ruby $v" "ruby $v" mise exec "ruby@$v" -- ruby --version
done < <(jq -r '.languages[] | select(.name == "Ruby") | .versions[]' "$json")
while read -r t _; do
  check "rust $t" rustup run "$t" rustc --version
done < <(jq -r '.languages[] | select(.name == "Rust") | .versions[]' "$json")
while read -r v; do
  expect "php$v" "PHP $v" "php$v" --version
done < <(jq -r '.languages[] | select(.name == "PHP") | .versions[]' "$json")

echo "== Version files switch versions"
node_alt=$(jq -r '.languages[] | select(.name == "Node.js") | .versions[1] // .versions[0]' "$json")
mkdir nvmrc && echo "$node_alt" >nvmrc/.nvmrc
expect ".nvmrc -> node $node_alt" "v$node_alt" bash -c 'cd nvmrc && node --version'
py_alt=$(jq -r '.languages[] | select(.name == "Python") | .versions[1] // .versions[0]' "$json")
mkdir pyver && echo "$py_alt" | cut -d. -f1-2 >pyver/.python-version
expect ".python-version -> python $py_alt" "Python $py_alt" bash -c 'cd pyver && python --version'
check "switched node keeps t3 working" bash -c 'cd nvmrc && t3 --version'
check "switched node keeps claude working" bash -c 'cd nvmrc && claude --version'

echo "== Hello world builds"
cat >hello.c <<'C'
#include <stdio.h>
int main(void) { puts("hello"); return 0; }
C
expect "gcc" hello bash -c 'gcc hello.c -o hello-gcc && ./hello-gcc'
expect "clang" hello bash -c 'clang hello.c -o hello-clang && ./hello-clang'
expect "node" hello node -e 'console.log("hello")'
expect "typescript" hello bash -c 'echo "const s: string = \"hello\"; console.log(s)" > h.ts && tsx h.ts'
expect "python venv + pip" hello bash -c 'python -m venv venv && venv/bin/python -c "print(\"hello\")"'
expect "uv" hello bash -c 'uv run --no-project python -c "print(\"hello\")"'
mkdir -p java && cat >java/Hello.java <<'J'
public class Hello { public static void main(String[] a) { System.out.println("hello"); } }
J
expect "javac" hello bash -c 'cd java && javac Hello.java && java Hello'
mkdir -p gohello && cat >gohello/main.go <<'G'
package main

import "fmt"

func main() { fmt.Println("hello") }
G
expect "go build" hello bash -c 'cd gohello && go mod init example.com/hello >/dev/null 2>&1 && go build -o h . && ./h'
expect "cargo build" "Hello, world!" bash -c 'cargo new --quiet rusthello && cd rusthello && cargo run --quiet --offline'
if rustup toolchain list | grep -q '^nightly'; then
  expect "cargo +nightly" "nightly" bash -c 'cd rusthello && cargo +nightly --version'
fi
expect "ruby" hello ruby -e 'puts "hello"'
expect "php" hello php -r 'echo "hello\n";'
expect "bun" hello bun -e 'console.log("hello")'
expect "deno" hello deno eval 'console.log("hello")'
# shellcheck disable=SC2016 # expanded by the inner shell
check "global npm install works (dev owns the toolchain)" bash -c 'touch "$(npm root -g)/.t3m-write-test" && rm "$(npm root -g)/.t3m-write-test"'

if [ "${SMOKE_NETWORK:-0}" = 1 ]; then
  echo "== On-demand installs (network)"
  expect "mise use node@20 installs into ~/" "v20." bash -c 'mkdir od && cd od && mise use node@20 >/dev/null 2>&1 && node --version'
  check "it lives in the home volume" test -d "$HOME/.local/share/mise/installs/node"
  expect "npm install" "added" bash -c 'mkdir npmp && cd npmp && npm init -y >/dev/null && npm install --no-fund --no-audit left-pad'
  expect "pip install" "Successfully installed" bash -c 'venv/bin/pip install six'
fi

rm -rf "$work"
echo
if [ "$fails" -gt 0 ]; then
  echo "$fails check(s) failed"
  exit 1
fi
echo "all checks passed"
