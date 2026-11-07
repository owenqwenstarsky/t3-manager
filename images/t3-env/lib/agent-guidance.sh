#!/bin/bash
# Writes managed blocks into ~/.claude/CLAUDE.md and ~/.codex/AGENTS.md (user
# memory, read by Claude Code and Codex in every repo):
#   1. the list of installed tools (from the image), and
#   2. the global agent instructions set in the dashboard (Settings → Agent
#      instructions), which the dashboard writes to /etc/t3m-agent/instructions.md.
# Runs as dev on every start, and again when the dashboard saves new
# instructions. Anything outside the markers is the user's and is kept.
set -euo pipefail

tools="${T3M_TOOLS_FILE:-/usr/local/share/t3m/TOOLS.md}"
instructions="${T3M_INSTRUCTIONS_FILE:-/etc/t3m-agent/instructions.md}"
tools_begin='<!-- >>> t3-manager tools (managed: rewritten on every start) -->'
tools_end='<!-- <<< t3-manager tools -->'
instr_begin='<!-- >>> t3-manager instructions (managed: edit in the dashboard, Settings → Agent instructions) -->'
instr_end='<!-- <<< t3-manager instructions -->'

for file in "$HOME/.claude/CLAUDE.md" "$HOME/.codex/AGENTS.md"; do
  mkdir -p "$(dirname "$file")"
  touch "$file"
  user_part=$(awk -v b1="$tools_begin" -v e1="$tools_end" -v b2="$instr_begin" -v e2="$instr_end" '
    $0 == b1 || $0 == b2 {skip = 1; next}
    $0 == e1 || $0 == e2 {skip = 0; next}
    !skip' "$file")
  {
    wrote=
    if [ -s "$tools" ]; then
      echo "$tools_begin"
      cat "$tools"
      echo "$tools_end"
      wrote=1
    fi
    if [ -r "$instructions" ] && grep -q '[^[:space:]]' "$instructions"; then
      [ -n "$wrote" ] && echo
      echo "$instr_begin"
      cat "$instructions"
      # Keep the end marker on its own line even without a trailing newline.
      [ -z "$(tail -c 1 "$instructions")" ] || echo
      echo "$instr_end"
      wrote=1
    fi
    if [ -n "$user_part" ]; then
      [ -n "$wrote" ] && echo
      printf '%s\n' "$user_part" | sed '/./,$!d'
    fi
  } >"$file.tmp"
  mv "$file.tmp" "$file"
done
