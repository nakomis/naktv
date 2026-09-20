#!/usr/bin/env bash
# Long-lived Spotify Connect endpoint: librespot -> paced PCM -> named pipe.
#
# This runs INDEPENDENTLY of go2rtc, and that is the entire point. go2rtc
# starts and stops its producers whenever the last consumer comes or goes — an
# app reload, a tab switch, a sideload, a network blip. When librespot was a
# child of that producer, every one of those events silently minted a new
# Connect device and left Spotify talking to a dead one, so "play" did nothing.
#
# The pacer holds the pipe open read-write, so it never sees EOF or a broken
# pipe however often the ffmpeg on the other end restarts. librespot therefore
# never notices, and the device stays put.
#
# Start it from a GUI terminal on the host, never over ssh: discovery is mDNS,
# and macOS Local Network Privacy denies LAN access to anything launched from
# an ssh session. The symptom is a device that never appears in Spotify.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

: "${LIBRESPOT_BIN:=librespot}"
: "${PYTHON_BIN:=python3}"
: "${PACER:=$HERE/pcm-pacer.py}"
: "${FIFO:=/tmp/naktv-spotify.pcm}"
: "${DEVICE_NAME:=NakTV}"
: "${BITRATE:=320}"
: "${INITIAL_VOLUME:=50}"
: "${LOG_DIR:=/tmp}"

LIBRESPOT_LOG="$LOG_DIR/naktv-librespot.log"

# Only one instance may claim the device name, or Spotify shows two identical
# entries and picking the wrong one does nothing.
for pid in $(pgrep -f "librespot --name $DEVICE_NAME" 2>/dev/null); do
  echo "killing existing librespot $pid"
  kill "$pid" 2>/dev/null
done
sleep 1

echo "Spotify Connect device : $DEVICE_NAME"
echo "PCM pipe               : $FIFO"
echo "librespot log          : $LIBRESPOT_LOG"
echo "Ctrl-C to stop."

set -m
"$LIBRESPOT_BIN" \
    --name "$DEVICE_NAME" \
    --backend pipe \
    --bitrate "$BITRATE" \
    --initial-volume "$INITIAL_VOLUME" \
    2>>"$LIBRESPOT_LOG" \
  | "$PYTHON_BIN" "$PACER" --output "$FIFO" &

PGID=$!
# shellcheck disable=SC2064
trap "kill -- -$PGID 2>/dev/null" EXIT INT TERM
wait "$PGID"
