#!/bin/bash
# Checks apt_candidates (install/common.sh), which picks the PHP packages to
# install, against canned `apt-cache policy` output. Runs under the same shell
# options as the build (set -euo pipefail).
. "$(dirname "$0")/../install/common.sh"

policy=$(cat <<'OUT'
php8.4-cli:
  Installed: (none)
  Candidate: 8.4.27-1+0~20261101.80+debian13~1.gbp1a2b3c
  Version table:
     8.4.27-1+0~20261101.80+debian13~1.gbp1a2b3c 500
        500 https://packages.sury.org/php trixie/main amd64 Packages
php8.5-opcache:
  Installed: (none)
  Candidate: (none)
  Version table:
php8.5-cli:
  Installed: (none)
  Candidate: 8.5.12-1+0~20261101.12+debian13~1.gbp4d5e6f
  Version table:
     8.5.12-1+0~20261101.12+debian13~1.gbp4d5e6f 500
        500 https://packages.sury.org/php trixie/main amd64 Packages
OUT
)
# php8.3-redis is unknown to apt, so it has no block at all.
mapfile -t got < <(printf '%s\n' "$policy" | apt_candidates)
want=(php8.4-cli php8.5-cli)
if [ "${got[*]}" != "${want[*]}" ]; then
  echo "FAIL: apt_candidates picked '${got[*]}', wanted '${want[*]}'" >&2
  exit 1
fi
echo "ok: apt_candidates picked ${got[*]}"
