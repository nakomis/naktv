#!/usr/bin/env bash
# Build, package, sideload and (re)launch NakTV on the TV.
#
#   scripts/install-tv.sh            # device "b3"
#   TV_DEVICE=emulator scripts/install-tv.sh
#   scripts/install-tv.sh --latest   # the newest GitHub Release
#   scripts/install-tv.sh path/to/com.nakomis.naktv_1.2.3_all.ipk
#
# Needs webOS Developer Mode on the TV and the device registered with
# `ares-setup-device` (see README). The webOS CLI comes from app/'s
# devDependencies, so nothing needs installing globally.
set -euo pipefail

APP_ID=com.nakomis.naktv
DEVICE=${TV_DEVICE:-b3}
APP_DIR="$(cd "$(dirname "$0")/../app" && pwd)"
cd "$APP_DIR"

if [[ ${1:-} == --latest ]]; then
  rm -rf build/release && mkdir -p build/release
  gh release download --repo nakomis/naktv --pattern '*.ipk' --dir build/release
  IPK=$(ls build/release/${APP_ID}_*_all.ipk)
elif [[ $# -gt 0 ]]; then
  IPK=$(cd "$OLDPWD" && realpath "$1")
else
  pnpm run build
  rm -rf build && mkdir -p build
  pnpm exec ares-package dist -o build
  IPK=$(ls build/${APP_ID}_*_all.ipk)
fi

pnpm exec ares-install --device "$DEVICE" "$IPK"

# ares-launch re-focuses a running instance instead of loading the new build,
# so close it first. Closing an app that isn't running is an error; ignore it.
pnpm exec ares-launch --device "$DEVICE" --close "$APP_ID" >/dev/null 2>&1 || true
pnpm exec ares-launch --device "$DEVICE" "$APP_ID"
