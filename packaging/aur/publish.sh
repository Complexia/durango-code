#!/usr/bin/env bash
# Publishes durango-code-bin <version> to the AUR: fills packaging/aur/PKGBUILD
# with the version and the checksum of the .deb it downloads, regenerates
# .SRCINFO and pushes both. Runs as root in an archlinux:base-devel container
# (.github/workflows/release.yml) with AUR_SSH_PRIVATE_KEY set.
set -euo pipefail

version="$1"
here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
chmod 755 "$work"

pacman -Sy --noconfirm --needed git openssh >/dev/null

# Checksum the exact file the package will download.
curl -fsSL -o "$work/durango-code.deb" "https://code.durango.sh/api/download/linux?version=${version}"
sha256="$(sha256sum "$work/durango-code.deb" | cut -d' ' -f1)"

mkdir -p ~/.ssh
printf '%s\n' "$AUR_SSH_PRIVATE_KEY" > ~/.ssh/aur
chmod 600 ~/.ssh/aur
# Host keys as published on https://aur.archlinux.org (pinned, not scanned).
cp "$here/known_hosts" ~/.ssh/known_hosts
export GIT_SSH_COMMAND="ssh -i $HOME/.ssh/aur -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes"

git clone ssh://aur@aur.archlinux.org/durango-code-bin.git "$work/aur"
sed -e "s/^pkgver=.*/pkgver=${version}/" \
    -e "s/^pkgrel=.*/pkgrel=1/" \
    -e "s/^sha256sums=.*/sha256sums=('${sha256}')/" \
    "$here/PKGBUILD" > "$work/aur/PKGBUILD"

# makepkg refuses to run as root.
id builder >/dev/null 2>&1 || useradd -m builder
chown -R builder "$work/aur"
(cd "$work/aur" && sudo -u builder makepkg --printsrcinfo > .SRCINFO)

cd "$work/aur"
git add PKGBUILD .SRCINFO
if git diff --cached --quiet; then
  echo "durango-code-bin is already at ${version}"
  exit 0
fi
git -c user.name=Complexia -c user.email=complexia701@gmail.com commit -q -m "Update to ${version}"
git push origin HEAD:master
echo "Published durango-code-bin ${version} to the AUR"
