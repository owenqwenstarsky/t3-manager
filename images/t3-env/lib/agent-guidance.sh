#!/bin/bash
# Gives Claude Code and Codex the list of installed tools: a managed block in
# ~/.claude/CLAUDE.md and ~/.codex/AGENTS.md (user memory, read in every repo).
# Runs as dev on every start, so the block follows image updates. Anything
# outside the markers is the user's and is kept.
set -euo pipefail

tools=/usr/local/share/t3m/TOOLS.md
[ -s "$tools" ] || exit 0
begin='<!-- >>> t3-manager tools (managed: rewritten on every start) -->'
end='<!-- <<< t3-manager tools -->'

for file in "$HOME/.claude/CLAUDE.md" "$HOME/.codex/AGENTS.md"; do
  mkdir -p "$(dirname "$file")"
  touch "$file"
  user_part=$(awk -v b="$begin" -v e="$end" '$0 == b {skip = 1; next} $0 == e {skip = 0; next} !skip' "$file")
  {
    echo "$begin"
    cat "$tools"
    echo "$end"
    if [ -n "$user_part" ]; then
      echo
      printf '%s\n' "$user_part" | sed '/./,$!d'
    fi
  } >"$file.tmp"
  mv "$file.tmp" "$file"
done
