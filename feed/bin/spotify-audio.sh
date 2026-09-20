#!/usr/bin/env bash
# go2rtc audio producer: paced PCM from the named pipe -> AAC -> RTSP.
#
# go2rtc invokes this with the RTSP output URL as $1, and the resulting audio
# track is muxed with the printer video into a single stream. That muxing is
# the whole point: webOS allows an app exactly ONE media element, so a <video>
# and a separate <audio> force-pause each other. See ../README.md.
#
# librespot deliberately lives elsewhere, in spotify-connect.sh. go2rtc stops
# and restarts this script freely, and none of that should disturb a Spotify
# session — so all that happens here is an encode.
#
# The audio input needs the same wall clock as the video: raw PCM on a pipe
# carries no timestamps, so ffmpeg would number it from zero whilst the camera
# is stamped with wallclock, and the player would render only one of the two.
set -uo pipefail

OUT="${1:?usage: spotify-audio.sh <rtsp-output-url>}"

: "${FFMPEG_BIN:=ffmpeg}"
: "${FIFO:=/tmp/naktv-spotify.pcm}"
: "${AUDIO_BITRATE:=160k}"
: "${LOG_DIR:=/tmp}"

LOG="$LOG_DIR/naktv-spotify-audio.log"
log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >>"$LOG"; }

# Without a writer holding the pipe open, ffmpeg would block on open forever
# and go2rtc would sit waiting on a producer that never publishes. Failing
# fast instead leaves the stream video-only, which still plays.
if [[ ! -p "$FIFO" ]]; then
  log "no PCM pipe at $FIFO — is spotify-connect.sh running? serving video only"
  exit 1
fi

log "=== audio producer starting, output=$OUT ==="
# -af aresample=async=1: the wallclock stamps arrive with the jitter of when
# ffmpeg happened to read the pipe, not when the samples were generated, so
# consecutive packets can land out of order. ffmpeg then logs "Queue input is
# backward in time" and "Non-monotonic DTS" for every packet and rewrites the
# timestamps itself. On a muxed stream that unsettles the video too: the player
# stalls waiting on audio and then jumps to catch up. Resampling to a
# continuous timeline keeps the wallclock base the video is aligned to whilst
# making the output strictly monotonic.
exec "$FFMPEG_BIN" -hide_banner -loglevel warning \
  -use_wallclock_as_timestamps 1 -f s16le -ar 44100 -ac 2 -i "$FIFO" \
  -af aresample=async=1 \
  -c:a aac -b:a "$AUDIO_BITRATE" -ar 48000 -ac 2 \
  -rtsp_transport tcp -f rtsp "$OUT" 2>>"$LOG"
