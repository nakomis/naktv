#!/usr/bin/env bash
# Build, package, sideload and (re)launch NakTV on the TV.
#
#   scripts/install-tv.sh            # device "b3"
#   TV_DEVICE=emulator scripts/install-tv.sh
#   scripts/install-tv.sh --latest   # withdrawn; see below
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
  # CI stopped publishing releases when the app began carrying an OctoPrint
  # API key baked in at build time: this is a public repository, and a
  # released .ipk would put that key in a public artefact. The old releases
  # are still there, so this would quietly install a stale build rather than
  # failing — which is worse than saying so.
  echo "install-tv: --latest is withdrawn. Releases are no longer published," >&2
  echo "            and the newest is older than every build since. Run without" >&2
  echo "            arguments to build and install from this working tree." >&2
  exit 1
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
