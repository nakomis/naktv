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
# now-playing.py (the --onevent hook) and now-playing-server.py (the static
# file server the TV polls) — see feed/README.md's "Now playing" section.
: "${NOW_PLAYING_DIR:=/tmp/naktv-www}"
: "${NOW_PLAYING_PORT:=1985}"
: "${NOW_PLAYING_SCRIPT:=$HERE/now-playing.py}"
: "${NOW_PLAYING_SERVER:=$HERE/now-playing-server.py}"
export NOW_PLAYING_DIR NOW_PLAYING_PORT

LIBRESPOT_LOG="$LOG_DIR/naktv-librespot.log"
NOW_PLAYING_LOG="$LOG_DIR/naktv-now-playing.log"

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
echo "now-playing feed       : http://0.0.0.0:$NOW_PLAYING_PORT/now-playing.json"
echo "now-playing log        : $NOW_PLAYING_LOG"
echo "Ctrl-C to stop."

# The static file server for now-playing.json. Independent of the librespot
# pipeline below — it must keep serving the last-known track even whilst
# librespot is mid-restart — so it's started once here and torn down only on
# the script's own exit, not on every pipeline restart.
"$PYTHON_BIN" "$NOW_PLAYING_SERVER" >>"$NOW_PLAYING_LOG" 2>&1 &
NOW_PLAYING_PID=$!

# Supervised, because librespot is not reliable enough to run unattended.
# Observed: it logged "Connection to server closed." and then sat there for
# forty minutes, still running and still advertising over mDNS, but with no
# session. Spotify listed the device, claimed to be playing to it, and produced
# silence — a state in which every process check says everything is fine.
#
# Restarting on exit does not detect that case by itself, but it does make
# recovery a one-liner from anywhere: `pkill -f "librespot --name NakTV"` and
# this loop brings up a clean instance, instead of needing whoever started the
# script to go and press Ctrl-C.
stopping=0
trap 'stopping=1' INT TERM

while true; do
  set -m
  "$LIBRESPOT_BIN" \
      --name "$DEVICE_NAME" \
      --backend pipe \
      --bitrate "$BITRATE" \
      --initial-volume "$INITIAL_VOLUME" \
      --onevent "$NOW_PLAYING_SCRIPT" \
      2>>"$LIBRESPOT_LOG" \
    | "$PYTHON_BIN" "$PACER" --output "$FIFO" &

  PGID=$!
  # Also kills the now-playing server: this is the trap that actually fires,
  # since each iteration's EXIT trap replaces the last, and the loop only
  # exits via `break` below, straight into the script's own exit.
  # shellcheck disable=SC2064
  trap "kill -- -$PGID 2>/dev/null; kill '$NOW_PLAYING_PID' 2>/dev/null" EXIT
  wait "$PGID"
  rc=$?

  [[ $stopping -eq 1 ]] && break
  echo "$(date '+%H:%M:%S') librespot pipeline exited (rc=$rc); restarting in 2s" \
    | tee -a "$LIBRESPOT_LOG"
  sleep 2
done
