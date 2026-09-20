#!/usr/bin/env bash
# go2rtc audio producer: librespot (Spotify Connect) -> paced PCM -> AAC -> RTSP.
#
# go2rtc invokes this with the RTSP output URL as $1, and the resulting audio
# track is muxed with the printer video into a single stream. That muxing is
# the whole point: webOS allows an app exactly ONE media element, so a <video>
# and a separate <audio> force-pause each other. One stream carrying both
# tracks sidesteps the limit and keeps hardware video decode. See ../README.md.
#
# librespot does NOT exit when its output pipe breaks. It logs "Audio Sink
# Error On Write: Broken pipe" and carries on, still advertising over mDNS. So
# every restart of this producer would otherwise leak an orphan still claiming
# the device name, and selecting that orphan in Spotify does nothing at all —
# silently, because it looks like a perfectly good device. Hence `set -m` to
# put the pipeline in its own process group, a trap that kills the group on the
# way out, and a startup sweep for orphans left by anything that died harder.
set -uo pipefail

OUT="${1:?usage: spotify-audio.sh <rtsp-output-url>}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

: "${LIBRESPOT_BIN:=librespot}"
: "${FFMPEG_BIN:=ffmpeg}"
: "${PYTHON_BIN:=python3}"
: "${PACER:=$HERE/pcm-pacer.py}"
: "${DEVICE_NAME:=NakTV}"
: "${BITRATE:=320}"
: "${INITIAL_VOLUME:=50}"
: "${AUDIO_BITRATE:=160k}"
: "${LOG_DIR:=/tmp}"

LOG="$LOG_DIR/naktv-spotify-audio.log"
LIBRESPOT_LOG="$LOG_DIR/naktv-librespot.log"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >>"$LOG"; }

log "=== producer starting, output=$OUT ==="

# Sweep up orphans from a previous run before advertising a new device, so two
# instances never claim the same name.
for pid in $(pgrep -f "librespot --name $DEVICE_NAME" 2>/dev/null); do
  log "  killing orphaned librespot $pid"
  kill "$pid" 2>/dev/null
done
sleep 1

set -m
"$LIBRESPOT_BIN" \
    --name "$DEVICE_NAME" \
    --backend pipe \
    --bitrate "$BITRATE" \
    --initial-volume "$INITIAL_VOLUME" \
    2>>"$LIBRESPOT_LOG" \
  | "$PYTHON_BIN" "$PACER" 2>>"$LOG" \
  | "$FFMPEG_BIN" -hide_banner -loglevel warning \
      -f s16le -ar 44100 -ac 2 -i pipe:0 \
      -c:a aac -b:a "$AUDIO_BITRATE" -ar 48000 -ac 2 \
      -rtsp_transport tcp -f rtsp "$OUT" 2>>"$LOG" &

PGID=$!
# shellcheck disable=SC2064  # $PGID and $LOG are deliberately expanded now.
trap "log '  trap fired: killing process group $PGID'; kill -- -$PGID 2>/dev/null" EXIT INT TERM
wait "$PGID"
log "=== producer exited rc=$? ==="
