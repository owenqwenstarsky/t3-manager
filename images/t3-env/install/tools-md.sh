#!/bin/bash
# Writes /usr/local/share/t3m/TOOLS.md (given to Claude Code and Codex) and
# toolchains.json (read by the dashboard) from what is actually installed.
. "$(dirname "$0")/common.sh"
out=/usr/local/share/t3m
mkdir -p "$out"
cd /
mise_dir=/usr/local/share/mise/installs

# Installed versions of a mise tool: the default first, then newest first.
mise_versions() {
  local tool=$1 def
  [ -d "$mise_dir/$tool" ] || return 0
  def=$(mise current "$tool" 2>/dev/null | awk '{print $1}')
  {
    echo "$def"
    find "$mise_dir/$tool" -mindepth 1 -maxdepth 1 -type d ! -name '.*' -printf '%f\n' | sort -rV
  } | awk 'NF && !seen[$0]++'
}

langs=$(mktemp)
add_lang() { # name, tools note, versions (default first)...; skipped when none
  local name=$1 note=$2
  shift 2
  [ $# -gt 0 ] || return 0
  jq -nc --arg name "$name" --arg note "$note" \
    '{name: $name, tools: $note, default: $ARGS.positional[0], versions: $ARGS.positional}' \
    --args "$@" >>"$langs"
}

mise_lang() { # name, tool, note
  local v
  mapfile -t v < <(mise_versions "$2")
  add_lang "$1" "$3" "${v[@]}"
}
mise_lang "Node.js" node "npm, pnpm, yarn 1, bun, deno, tsx, typescript"
mise_lang "Python" python "python3.X for every version, pip, uv, pipx, poetry, pdm, hatch, ruff, black"
mise_lang "Java (Temurin)" java "maven, gradle, kotlin"
mise_lang "Gradle" gradle "projects usually use ./gradlew"
mise_lang "Go" go "gopls, golangci-lint, staticcheck, dlv, air"
mise_lang "Ruby" ruby "gem, bundler"

short_toolchain() { sed -E 's/-(x86_64|aarch64)-.*//'; }
rust=()
if command -v rustup >/dev/null; then
  def_rust=$(rustup default | awk '{print $1}' | short_toolchain)
  for t in $(rustup toolchain list | awk '{print $1}'); do
    short=$(echo "$t" | short_toolchain)
    label="$short $(rustup run "$t" rustc --version | awk '{print $2}')"
    if [ "$short" = "$def_rust" ]; then rust=("$label" "${rust[@]}"); else rust+=("$label"); fi
  done
fi
add_lang "Rust" "rustup, cargo, clippy, rustfmt, rust-analyzer, cargo-nextest, cargo-watch, sccache" "${rust[@]}"

php=()
if command -v php >/dev/null; then
  php=("$(php -r 'echo PHP_MAJOR_VERSION.".".PHP_MINOR_VERSION;')")
  while read -r p; do php+=("${p#php}"); done < <(find /usr/bin -maxdepth 1 -regex '.*/php[0-9]+\.[0-9]+' -printf '%f\n' | sort -rV)
  mapfile -t php < <(printf '%s\n' "${php[@]}" | awk '!seen[$0]++')
fi
add_lang "PHP" "composer; other versions as php8.X" "${php[@]}"

cc=("gcc $(gcc -dumpfullversion)")
while read -r c; do cc+=("${c/-/ }"); done < <(find /usr/bin -maxdepth 1 -regex '.*/clang-[0-9]+' -printf '%f\n' | sort -rV)
add_lang "C / C++" "cmake, ninja, meson, make, ccache, mold, gdb, lldb, valgrind, clang-format, clang-tidy" "${cc[@]}"

missing=()
if [ -s "$MISSING_FILE" ]; then mapfile -t missing < <(sort -u "$MISSING_FILE"); fi
jq -s --arg built "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg flavor "$TOOLCHAINS" \
  --argjson missing "$(jq -nc '$ARGS.positional' --args "${missing[@]}")" \
  '{built: $built, toolchains: $flavor, languages: ., missing: $missing}' "$langs" >"$out/toolchains.json"
rm "$langs"

{
  cat <<'MD'
# Tools in this environment

This is a T3 Manager environment: Debian 13, user `dev` with passwordless sudo. The toolchains below are preinstalled, so don't install language runtimes or package managers before building or testing.

## Languages (default first)
MD
  jq -r '.languages[] | "- **\(.name)**: \(.versions | join(", ")). \(.tools)"' "$out/toolchains.json"
  cat <<'MD'

## Choosing versions
- Repos pick their versions automatically from `.nvmrc`, `.node-version`, `.python-version`, `.ruby-version`, `.java-version`, `.go-version`, `.tool-versions` or `mise.toml`.
- Pin a version for a repo with `mise use node@22`, which writes `mise.toml`. For a single command, use `mise exec java@17 -- mvn test`.
- Any version that isn't listed installs on first use, e.g. `mise use node@18` or `mise use python@3.9`. It is kept in ~/.
- Rust: `rust-toolchain.toml`, `cargo +nightly ...`, or `rustup toolchain install 1.80`.
- PHP: run `php8.3 ...`, or `sudo update-alternatives --set php /usr/bin/php8.3`.
- Other tools are one command away, e.g. `mise use -g kubectl`, or `helm`, `terraform`, `opentofu`, `aws-cli`, `gcloud`, `dotnet`, `zig` (see `mise registry`).

## Not available
- Docker and other containers: there is no Docker daemon or CLI. Use SQLite, or database servers reachable over the network.

## Other CLIs
git, git-lfs, gh, glab, gt (Gitea CLI), lazygit, delta, jq, yq, rg, fd, fzf, bat, eza, tree, httpie, curl, wget, tmux, direnv, watchexec, entr, hyperfine, just, task, protoc, buf, shellcheck, shfmt, hadolint, actionlint, taplo, yamllint, prettier, eslint, sqlite3, psql, mariadb, redis-cli, mongosh, chromium (Playwright, headless), neovim, vim, nano.

`gt` is Gitea's official CLI (it replaces `tea`). Gitea servers set up in the dashboard (Settings → Gitea CLI) are already logged in: run `gt auth status`, then for example `gt pr list --repo owner/name`.
MD
  if [ ${#missing[@]} -gt 0 ]; then
    printf '\n## Failed to install at build time\n%s. Install them yourself if you need them.\n' "$(printf '%s, ' "${missing[@]}" | sed 's/, $//')"
  fi
} >"$out/TOOLS.md"
cat "$out/TOOLS.md"
