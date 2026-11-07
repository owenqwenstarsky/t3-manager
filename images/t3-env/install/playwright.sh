#!/bin/bash
# Chromium for Playwright (and its system libraries), shared at
# $PLAYWRIGHT_BROWSERS_PATH. Projects on the same Playwright version reuse it;
# others download theirs into the same (dev-owned) directory.
. "$(dirname "$0")/common.sh"
: "${PLAYWRIGHT_BROWSERS_PATH:?}"
export PATH="/opt/t3m/node/bin:$PATH" npm_config_cache=/tmp/npm-cache
apt-get update
npx -y playwright@latest install --with-deps chromium
rm -rf /var/lib/apt/lists/* /tmp/npm-cache
chrome=$(find "$PLAYWRIGHT_BROWSERS_PATH" -path '*chrome-linux*/chrome' -type f | sort | tail -n 1)
ln -sf "$chrome" /usr/local/bin/chromium
give_to_dev "$PLAYWRIGHT_BROWSERS_PATH"
chromium --headless=new --no-sandbox --version || true
