#!/bin/bash
# T3 Code, Claude Code and Codex on their own Node (/opt/t3m/node), so
# switching the project Node version (mise, .nvmrc) can't break them.
. "$(dirname "$0")/common.sh"
node_dir=/opt/t3m/node
export PATH="$node_dir/bin:$PATH" npm_config_cache=/tmp/npm-cache
npm install -g --prefix "$node_dir" --no-fund --no-audit \
  "t3@${T3_VERSION:-latest}" \
  "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION:-latest}" \
  "@openai/codex@${CODEX_VERSION:-latest}"
rm -rf /tmp/npm-cache

# /usr/local/bin wrappers that run each CLI with the pinned Node.
for name in t3 claude codex; do
  target=$(readlink -f "$node_dir/bin/$name")
  if head -c 64 "$target" | grep -q '^#!.*node'; then
    printf '#!/bin/sh\nexec %s %s "$@"\n' "$node_dir/bin/node" "$target" > "/usr/local/bin/$name"
    chmod 0755 "/usr/local/bin/$name"
  else
    ln -sf "$target" "/usr/local/bin/$name"
  fi
  "/usr/local/bin/$name" --version
done
