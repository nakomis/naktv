#!/usr/bin/env bash
# Build, sideload and launch NakTV on the Android TV (the Sony Bravia).
#
#   scripts/install-android.sh                     # device 172.29.0.13:5555
#   TV_DEVICE=192.168.1.50:5555 scripts/install-android.sh
#
# Needs the Android SDK's platform-tools on PATH or at the well-known macOS
# location (~/Library/Android/sdk), and a JDK the Gradle wrapper accepts —
# see android/.tool-versions. adb must already have authorised this Mac
# against the TV (accept the on-screen prompt once); `adb connect` alone
# doesn't re-authorise a revoked pairing.
set -euo pipefail

APP_ID=com.nakomis.naktv
DEVICE=${TV_DEVICE:-172.29.0.13:5555}
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR="$ROOT/app"
ANDROID_DIR="$ROOT/android"

if command -v adb >/dev/null 2>&1; then
  ADB=adb
elif [[ -x "$HOME/Library/Android/sdk/platform-tools/adb" ]]; then
  ADB="$HOME/Library/Android/sdk/platform-tools/adb"
else
  echo "install-android: no adb on PATH and none found under ~/Library/Android/sdk" >&2
  exit 1
fi

"$ADB" connect "$DEVICE" >/dev/null || true

# Build the web app the same way install-tv.sh does, then copy the result
# into the Android module's assets. This directory is git-ignored — it is
# always regenerated, never hand-edited.
(cd "$APP_DIR" && pnpm run build)
WWW_DIR="$ANDROID_DIR/app/src/main/assets/www"
rm -rf "$WWW_DIR"
mkdir -p "$WWW_DIR"
cp -r "$APP_DIR"/dist/. "$WWW_DIR"/

(cd "$ANDROID_DIR" && ./gradlew assembleDebug)

APK="$ANDROID_DIR/app/build/outputs/apk/debug/app-debug.apk"
"$ADB" -s "$DEVICE" install -r "$APK"
"$ADB" -s "$DEVICE" shell am start -n "$APP_ID/$APP_ID.MainActivity"
