# shellcheck shell=bash
# Appended to /etc/bash.bashrc by the T3 Manager image (interactive shells only).
# mise switches versions as you cd between repos; direnv loads .envrc files.
if command -v mise >/dev/null 2>&1; then eval "$(mise activate bash)"; fi
if command -v direnv >/dev/null 2>&1; then eval "$(direnv hook bash)"; fi
