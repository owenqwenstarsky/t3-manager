#!/bin/bash
# PHP from packages.sury.org (side-by-side versions) and Composer.
. "$(dirname "$0")/common.sh"
# shellcheck source=/dev/null
. "$T3M_BUILD/php.conf"

codename=$(. /etc/os-release && echo "$VERSION_CODENAME")
curl -fsSL -o /tmp/sury.deb https://packages.sury.org/debsuryorg-archive-keyring.deb
dpkg -i /tmp/sury.deb && rm /tmp/sury.deb
echo "deb [signed-by=/usr/share/keyrings/debsuryorg-archive-keyring.gpg] https://packages.sury.org/php/ $codename main" \
  > /etc/apt/sources.list.d/php.list
apt-get update

mapfile -t versions < <(pick_words "$PHP_VERSIONS")
default=${versions[0]}
names=()
for v in "${versions[@]}"; do
  for ext in $PHP_EXTENSIONS; do names+=("php$v-$ext"); done
done
# Some extensions are built in for newer versions (e.g. opcache in 8.5), where
# the package is missing or only virtual: keep real candidates only.
policy=$(apt-cache policy "${names[@]}" 2>/dev/null || true)
mapfile -t pkgs < <(printf '%s\n' "$policy" | apt_candidates)
for v in "${versions[@]}"; do
  if [[ " ${pkgs[*]} " != *" php$v-cli "* ]]; then
    echo "PHP $v isn't available from packages.sury.org for $codename. Edit images/t3-env/toolchains/php.conf." >&2
    exit 1
  fi
done
log "installing ${#pkgs[@]} PHP packages: ${pkgs[*]}"
apt-get install -y --no-install-recommends "${pkgs[@]}"
rm -rf /var/lib/apt/lists/*

if [ ! -x "/usr/bin/php$default" ]; then
  echo "php$default did not install (/usr/bin/php$default is missing)" >&2
  exit 1
fi
update-alternatives --set php "/usr/bin/php$default"

# Composer: the latest stable phar, checked against its published checksum.
curl -fsSL -o /tmp/composer.phar https://getcomposer.org/download/latest-stable/composer.phar
echo "$(curl -fsSL https://getcomposer.org/download/latest-stable/composer.phar.sha256)  /tmp/composer.phar" | sha256sum -c -
install -m 0755 /tmp/composer.phar /usr/local/bin/composer && rm /tmp/composer.phar
php -v | head -n 1
composer --version
