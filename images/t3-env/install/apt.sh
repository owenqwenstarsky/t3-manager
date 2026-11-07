#!/bin/bash
# System packages, locale and the dev user (uid/gid 1000, passwordless sudo).
. "$(dirname "$0")/common.sh"

# shellcheck disable=SC2046 # one package per line
apt_install $(list "$T3M_BUILD/apt-packages.txt")

# Debian names some tools differently.
ln -sf /usr/bin/fdfind /usr/local/bin/fd
ln -sf /usr/bin/batcat /usr/local/bin/bat

sed -i 's/^# *en_US.UTF-8/en_US.UTF-8/' /etc/locale.gen
locale-gen

groupadd -g "$DEV_GID" dev
useradd -m -u "$DEV_UID" -g dev -s /bin/bash dev
mkdir -p /home/dev/workspace
chown -R dev:dev /home/dev

# Interactive and login shells, and sudo, see the same tools as T3 and its agents.
cat > /etc/sudoers.d/dev <<SUDO
dev ALL=(ALL) NOPASSWD:ALL
Defaults secure_path="/usr/local/share/mise/shims:/opt/rust/cargo/bin:/opt/t3m/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
Defaults env_keep += "RUSTUP_HOME PLAYWRIGHT_BROWSERS_PATH"
SUDO
chmod 440 /etc/sudoers.d/dev
