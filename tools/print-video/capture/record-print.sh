#!/usr/bin/env bash
# Record the resin printer camera (video only) for the whole current print.
#
#   record-print.sh PREFIX
#
# Writes PREFIX-partNN.mkv, a copy of go2rtc's resin_av with the audio track
# dropped (the soundtrack is added later, from CC0 music), and appends each
# part's start time to PREFIX-parts.jsonl as epoch seconds, which is what
# render.py lines the status log up against. If the stream drops, recording
# carries on in a new part; it stops once cthulhu says the print is over.
#
# Reading resin_av shares the producer the TV already uses, so it costs Rey
# nothing extra while the TV is on the Elegoo tab. MKV, because a file cut
# off mid-write is still playable.
set -u
PREFIX="${1:?usage: record-print.sh PREFIX}"
CTHULHU="${CTHULHU:-http://127.0.0.1:9120}"
STREAM="${STREAM:-rtsp://127.0.0.1:8554/resin_av}"
LOG="$PREFIX.log"
# Carry on the numbering if this print was being recorded before (the
# recorder restarted mid-print), so part01 is never overwritten.
part=1
[ -s "$PREFIX-parts.jsonl" ] && part=$(( $(wc -l < "$PREFIX-parts.jsonl") + 1 ))
ffpid=""

print_over() {
  local label
  label="$(curl -s -m 5 "$CTHULHU/api/status" |
    python3 -c 'import json,sys; print(json.load(sys.stdin)["print"].get("statusLabel",""))' 2>/dev/null)"
  case "$label" in Idle|Complete|Stopped|Cancelled) return 0 ;; *) return 1 ;; esac
}

start_part() {
  local out
  out="$PREFIX-part$(printf %02d "$part").mkv"
  python3 -c 'import json,sys,time; print(json.dumps({"part": int(sys.argv[1]), "file": sys.argv[2], "t": round(time.time(), 3)}))' \
    "$part" "$(basename "$out")" >> "$PREFIX-parts.jsonl"
  ffmpeg -nostdin -hide_banner -loglevel warning -rtsp_transport tcp \
    -i "$STREAM" -map 0:v -c copy -f matroska "$out" >> "$LOG" 2>&1 &
  ffpid=$!
  echo "$(date +%T) part $part -> $out (pid $ffpid)" >> "$LOG"
}

trap '[ -n "$ffpid" ] && kill -INT "$ffpid" 2>/dev/null; exit 0' INT TERM
start_part
over=0
while true; do
  # In the background and waited on: bash holds a signal until a foreground
  # command finishes, so a plain sleep would delay a stop by up to 30 s.
  sleep 30 &
  wait $!
  if print_over; then over=$((over + 1)); else over=0; fi
  if [ "$over" -ge 2 ]; then
    echo "$(date +%T) print over; stopping" >> "$LOG"
    kill -INT "$ffpid" 2>/dev/null
    wait "$ffpid"
    exit 0
  fi
  if ! kill -0 "$ffpid" 2>/dev/null; then
    part=$((part + 1))
    start_part
  fi
done
