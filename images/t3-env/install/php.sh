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

pkgs=()
for v in $(pick_words "$PHP_VERSIONS"); do
  for ext in $PHP_EXTENSIONS; do
    # Some extensions are built in for newer versions (e.g. opcache in 8.5).
    if apt-cache show "php$v-$ext" >/dev/null 2>&1; then pkgs+=("php$v-$ext"); fi
  done
done
apt-get install -y --no-install-recommends "${pkgs[@]}"
rm -rf /var/lib/apt/lists/*

default=$(pick_words "$PHP_VERSIONS" | head -n 1)
update-alternatives --set php "/usr/bin/php$default"

# Composer: the latest stable phar, checked against its published checksum.
curl -fsSL -o /tmp/composer.phar https://getcomposer.org/download/latest-stable/composer.phar
echo "$(curl -fsSL https://getcomposer.org/download/latest-stable/composer.phar.sha256)  /tmp/composer.phar" | sha256sum -c -
install -m 0755 /tmp/composer.phar /usr/local/bin/composer && rm /tmp/composer.phar
php -v | head -n 1
composer --version
