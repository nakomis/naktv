#!/usr/bin/env bash
# Build NakTV for macOS or iOS and install it directly — no App Store.
#
#   scripts/install-apple.sh mac               # build, copy to /Applications, launch
#   scripts/install-apple.sh ios               # the one connected iPhone/iPad
#   scripts/install-apple.sh ios "Martin's iPad"   # a named device (or its UDID)
#   scripts/install-apple.sh sim               # iOS Simulator (iPhone 17 Pro)
#   scripts/install-apple.sh sim "iPad Air 11-inch (M4)"
#
# Environment:
#   NAKTV_MAC_INSTALL_DIR   where the Mac app goes (default /Applications)
#   NAKTV_NOTARY_PROFILE    notarytool keychain profile: notarise the Mac app,
#                           so it can be copied to other Macs
#   NAKTV_PROBE=1           launch with -NakTVProbe: log the player's state
#                           every 5 s (see NakTVWebController.swift)
#
# Signing comes from apple/Config/NakTV.xcconfig (team 62YFUFBSFX; Developer
# ID for the Mac). The iOS build uses automatic signing, so Xcode must be
# signed in to that team's Apple ID; -allowProvisioningUpdates lets it make
# the development certificate and profile, and register the device, as
# needed. Override either in apple/Config/Local.xcconfig.
#
# Needs xcodegen (brew install xcodegen). Logs go to /tmp/naktv-apple-build.log.
set -euo pipefail

TARGET=${1:-}
DEVICE=${2:-}
APP_ID=com.nakomis.naktv
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR="$ROOT/app"
APPLE_DIR="$ROOT/apple"
DERIVED="$APPLE_DIR/build"
LOG=/tmp/naktv-apple-build.log

case "$TARGET" in
  mac | ios | sim) ;;
  *)
    sed -n '2,9p' "$0" >&2
    exit 64
    ;;
esac

command -v xcodegen >/dev/null || {
  echo "install-apple: xcodegen not found (brew install xcodegen)" >&2
  exit 1
}

LAUNCH_ARGS=()
[[ "${NAKTV_PROBE:-}" == 1 ]] && LAUNCH_ARGS+=(-NakTVProbe)

# Build the web app the same way install-tv.sh does, then copy it into the
# bundle's www/. Git-ignored, always regenerated, never hand-edited.
(cd "$APP_DIR" && pnpm run build)
rm -rf "$APPLE_DIR/www"
cp -r "$APP_DIR/dist" "$APPLE_DIR/www"

(cd "$APPLE_DIR" && xcodegen generate --quiet)

# Full xcodebuild output to the log (less +F it to follow along); only
# failures reach the terminal.
build() {
  echo "install-apple: building ($*) — full log in $LOG"
  if ! xcodebuild -project "$APPLE_DIR/NakTV.xcodeproj" -derivedDataPath "$DERIVED" "$@" build >"$LOG" 2>&1; then
    grep -E "error:|BUILD FAILED" "$LOG" >&2 || tail -30 "$LOG" >&2
    exit 1
  fi
}

case "$TARGET" in
  mac)
    build -scheme NakTV-macOS -configuration Release -destination 'generic/platform=macOS'
    BUILT="$DERIVED/Build/Products/Release/NakTV.app"
    # Built here, the app carries no quarantine flag, so this Mac runs it
    # unnotarised. Another Mac's Gatekeeper won't, once it has been copied
    # across: notarise and staple it first. Store the credentials once with
    # `xcrun notarytool store-credentials <profile>`.
    if [[ -n "${NAKTV_NOTARY_PROFILE:-}" ]]; then
      ZIP=$(mktemp -d)/NakTV.zip
      ditto -c -k --keepParent "$BUILT" "$ZIP"
      xcrun notarytool submit "$ZIP" --keychain-profile "$NAKTV_NOTARY_PROFILE" --wait
      xcrun stapler staple "$BUILT"
    fi
    DEST="${NAKTV_MAC_INSTALL_DIR:-/Applications}/NakTV.app"
    osascript -e "tell application id \"$APP_ID\" to quit" >/dev/null 2>&1 || true
    rm -rf "$DEST"
    cp -R "$BUILT" "$DEST"
    echo "install-apple: installed $DEST"
    open "$DEST" --args ${LAUNCH_ARGS[@]+"${LAUNCH_ARGS[@]}"}
    ;;

  sim)
    NAME=${DEVICE:-iPhone 17 Pro}
    # By UDID, on the newest runtime that has a device of that name: names
    # repeat across runtimes, and xcodebuild only looks at the latest.
    SIM=$(xcrun simctl list devices available --json | python3 -c '
import json, sys
name = sys.argv[1]
runtimes = json.load(sys.stdin)["devices"]
def version(runtime):
    return [int(p) for p in runtime.rsplit("iOS-", 1)[-1].split("-")] if "iOS-" in runtime else []
for runtime in sorted(runtimes, key=version, reverse=True):
    for device in runtimes[runtime]:
        if version(runtime) and device["name"] == name:
            print(device["udid"]); sys.exit()
sys.exit(f"install-apple: no available simulator named {name!r}")
' "$NAME")
    xcrun simctl boot "$SIM" 2>/dev/null || true
    open -a Simulator
    build -scheme NakTV-iOS -configuration Debug -destination "id=$SIM"
    xcrun simctl install "$SIM" "$DERIVED/Build/Products/Debug-iphonesimulator/NakTV.app"
    xcrun simctl terminate "$SIM" "$APP_ID" 2>/dev/null || true
    xcrun simctl launch "$SIM" "$APP_ID" ${LAUNCH_ARGS[@]+"${LAUNCH_ARGS[@]}"}
    ;;

  ios)
    # A device that has never trusted this Mac is listed but unpaired, and
    # can't be installed to. Asking to pair puts "Trust This Computer?" on it.
    PAIRING_JSON=$(mktemp)
    xcrun devicectl list devices --json-output "$PAIRING_JSON" >/dev/null
    python3 -c '
import json, sys
for d in json.load(open(sys.argv[1]))["result"]["devices"]:
    if d.get("hardwareProperties", {}).get("platform") == "iOS" \
            and d.get("connectionProperties", {}).get("pairingState") == "unpaired" \
            and d.get("connectionProperties", {}).get("transportType") == "wired":
        print(d["identifier"])
' "$PAIRING_JSON" | while read -r unpaired; do
      echo "install-apple: pairing $unpaired — tap Trust on the device and enter its passcode"
      xcrun devicectl manage pair --device "$unpaired" >/dev/null
    done
    rm -f "$PAIRING_JSON"

    # devicectl knows the device by name or UDID; xcodebuild wants the UDID.
    DEVICES_JSON=$(mktemp)
    xcrun devicectl list devices --json-output "$DEVICES_JSON" >/dev/null
    UDID=$(python3 - "$DEVICES_JSON" "$DEVICE" <<'EOF'
import json, sys
devices = json.load(open(sys.argv[1]))["result"]["devices"]
wanted = sys.argv[2]
def usable(d):
    return d.get("hardwareProperties", {}).get("platform") == "iOS" \
        and d.get("connectionProperties", {}).get("pairingState") == "paired"
matches = [d for d in devices if usable(d) and (not wanted or wanted in (
    d["deviceProperties"].get("name"), d["hardwareProperties"].get("udid"), d.get("identifier")))]
if len(matches) != 1:
    names = [d["deviceProperties"].get("name") for d in devices if usable(d)]
    sys.exit(f"install-apple: need exactly one matching paired iOS device, found {len(matches)} (paired: {names})")
print(matches[0]["hardwareProperties"]["udid"])
EOF
    )
    rm -f "$DEVICES_JSON"
    build -scheme NakTV-iOS -configuration Release -destination "id=$UDID" \
      -allowProvisioningUpdates -allowProvisioningDeviceRegistration
    xcrun devicectl device install app --device "$UDID" "$DERIVED/Build/Products/Release-iphoneos/NakTV.app"
    xcrun devicectl device process launch --terminate-existing --device "$UDID" "$APP_ID" ${LAUNCH_ARGS[@]+"${LAUNCH_ARGS[@]}"}
    ;;
esac
