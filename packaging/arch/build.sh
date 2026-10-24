#!/usr/bin/env bash
# Builds the Arch Linux package from a release's .deb:
#   packaging/arch/build.sh <path/to.deb> <version> <output dir>
# makepkg runs in an archlinux:base-devel container (Docker), so this works
# on the Ubuntu release runner. The package is written as
# <output dir>/durango-code-<version>-x86_64.pacman, the extension
# electron-updater looks for in latest-linux.yml.
set -euo pipefail

deb="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
version="$2"
out="$3"
here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

cp "$deb" "$work/durango-code.deb"
# pacman versions cannot contain '-': 1.2.3-rc.1 becomes 1.2.3rc.1, which
# pacman still orders before 1.2.3.
sed "s/^pkgver=.*/pkgver=${version//-/}/" "$here/PKGBUILD" > "$work/PKGBUILD"
chmod -R a+rwX "$work"

docker run --rm --platform linux/amd64 -v "$work:/build" archlinux:base-devel bash -euc '
  useradd -m builder
  cd /build
  # --nodeps: the dependencies matter on install, not for repackaging.
  su builder -c "makepkg --nodeps --noconfirm"
  # Hand the files back: the runner user cannot delete the container'"'"'s.
  chmod -R a+rwX /build
'

mkdir -p "$out"
package=("$work"/durango-code-*-x86_64.pkg.tar.zst)
cp "${package[0]}" "$out/durango-code-${version}-x86_64.pacman"
echo "Built $out/durango-code-${version}-x86_64.pacman"
