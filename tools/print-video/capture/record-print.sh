#!/usr/bin/env bash
# Record the resin printer camera (video only) for the whole current print.
# Audio is added later, offline, from CC0 tracks. Parts roll over if the
# stream drops; recording stops once cthulhu says the print is over.
set -u
DIR="$HOME/resin-recordings"
NAME="$(curl -s -m 5 http://127.0.0.1:9120/api/status | python3 -c 'import json,sys; print((json.load(sys.stdin)["print"].get("filename") or "print").removesuffix(".goo"))')"
STAMP="$(date +%F-%H%M)"
part=1
ffpid=""

print_over() {
  local label
  label="$(curl -s -m 5 http://127.0.0.1:9120/api/status | python3 -c 'import json,sys; print(json.load(sys.stdin)["print"].get("statusLabel",""))' 2>/dev/null)"
  case "$label" in Idle|Complete|Stopped|Cancelled) return 0 ;; *) return 1 ;; esac
}

start_part() {
  out="$DIR/${STAMP}-${NAME}-part$(printf %02d "$part").mkv"
  ffmpeg -nostdin -hide_banner -loglevel warning -rtsp_transport tcp \
    -i rtsp://127.0.0.1:8554/resin_av -map 0:v -c copy -f matroska "$out" \
    >> "$DIR/${STAMP}-${NAME}.log" 2>&1 &
  ffpid=$!
  echo "$(date +%T) part $part -> $out (pid $ffpid)" >> "$DIR/${STAMP}-${NAME}.log"
}

trap '[ -n "$ffpid" ] && kill -INT "$ffpid" 2>/dev/null; exit 0' INT TERM
start_part
over=0
while true; do
  sleep 30
  if print_over; then over=$((over + 1)); else over=0; fi
  if [ "$over" -ge 2 ]; then
    echo "$(date +%T) print over; stopping" >> "$DIR/${STAMP}-${NAME}.log"
    kill -INT "$ffpid" 2>/dev/null; wait "$ffpid"; exit 0
  fi
  if ! kill -0 "$ffpid" 2>/dev/null; then
    part=$((part + 1)); start_part
  fi
done
