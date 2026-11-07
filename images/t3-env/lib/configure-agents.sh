#!/bin/bash
# Points Claude Code and Codex at the T3 Manager model proxy.
# Runs as the dev user. Inputs: PROXY_URL, PROXY_KEY.
# Only the keys this script owns are touched; other user settings are kept.
set -euo pipefail

: "${PROXY_URL:?}" "${PROXY_KEY:?}"
PROXY_URL="${PROXY_URL%/}"

mkdir -p "$HOME/.claude" "$HOME/.codex" "$HOME/.config/t3m"

# Claude Code: settings.json "env" is read by Claude Code and by T3 Code's
# provider check, which then reports a custom endpoint instead of "log in".
settings="$HOME/.claude/settings.json"
[ -s "$settings" ] || echo '{}' > "$settings"
tmp="$(mktemp)"
jq --arg url "$PROXY_URL" --arg key "$PROXY_KEY" '
  .env = ((.env // {}) + {
    ANTHROPIC_BASE_URL: $url,
    ANTHROPIC_AUTH_TOKEN: $key,
    DISABLE_AUTOUPDATER: "1"
  }) | del(.env.ANTHROPIC_API_KEY)
' "$settings" > "$tmp" && mv "$tmp" "$settings"

# Skip the interactive first-run screens when someone runs `claude` by hand.
state="$HOME/.claude.json"
[ -s "$state" ] || echo '{}' > "$state"
tmp="$(mktemp)"
jq '.hasCompletedOnboarding = true' "$state" > "$tmp" && mv "$tmp" "$state"

# Codex: a custom model provider without OpenAI auth, so T3 Code treats Codex
# as ready. TOML puts every key after a [table] header into that table, so the
# top-level key goes first and the provider table goes last.
config="$HOME/.codex/config.toml"
touch "$config"
user_part="$(sed -e '/^# >>> t3-manager/,/^# <<< t3-manager/d' -e '/^model_provider[[:space:]]*=/d' "$config")"
{
  echo '# >>> t3-manager head (managed)'
  echo 'model_provider = "t3proxy"'
  echo '# <<< t3-manager head'
  [ -n "$user_part" ] && printf '%s\n' "$user_part"
  echo '# >>> t3-manager provider (managed)'
  echo '[model_providers.t3proxy]'
  echo 'name = "T3 Manager proxy"'
  echo "base_url = \"${PROXY_URL}/v1\""
  echo 'wire_api = "responses"'
  echo 'env_key = "T3PROXY_API_KEY"'
  echo 'requires_openai_auth = false'
  echo '# <<< t3-manager provider'
} > "$config.tmp"
mv "$config.tmp" "$config"

# Interactive shells (T3 terminals) get the key for Codex too.
envfile="$HOME/.config/t3m/env"
printf 'export T3PROXY_API_KEY=%q\n' "$PROXY_KEY" > "$envfile"
chmod 600 "$envfile" "$settings"
if ! grep -q '.config/t3m/env' "$HOME/.bashrc" 2>/dev/null; then
  # shellcheck disable=SC2016 # $HOME must stay literal in .bashrc
  printf '\n[ -f "$HOME/.config/t3m/env" ] && . "$HOME/.config/t3m/env"\n' >> "$HOME/.bashrc"
fi
echo "t3-env: agents configured for ${PROXY_URL}"
