#!/usr/bin/env bash
# Record every resin print, one after another (NAKTV-30).
#
#   print-recorder.sh [DIR]      (default ~/resin-recordings)
#
# Run as a service (print-recorder.service on Rey). Waits for cthulhu to
# report a print, runs the four capture jobs for it - the recording, the 1 Hz
# status log, the exact phase changes and the layer images - waits for them
# all to finish once the print is over, then goes back to waiting. Nothing to
# re-arm between prints, which is what wait-for-print.sh needed.
#
# Killed mid-print (a deploy restarting the service, a reboot), it resumes
# rather than starting again: each capture keeps its print's cthulhu task ID
# in PREFIX.task, and a print whose task already has a capture carries on
# under the same prefix. record-print.sh then continues the part numbering,
# the status logs append, and save-layers.sh skips what it already saved.
#
# The jobs are children, not detached as start-capture.sh does, so stopping
# the service stops them: SIGTERM here is passed on, and record-print.sh
# closes its MKV cleanly.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
DIR="${1:-$HOME/resin-recordings}"
CTHULHU="${CTHULHU:-http://127.0.0.1:9120}"
POLL="${POLL:-15}"
mkdir -p "$DIR"

log() { echo "$(date '+%F %T') $*"; }

# label<TAB>taskId<TAB>filename, or nothing if cthulhu can't be reached.
status() {
  curl -s -m 5 "$CTHULHU/api/status" | python3 -c '
import json, sys
p = json.load(sys.stdin).get("print") or {}
print("\t".join(str(p.get(k) or "") for k in ("statusLabel", "taskId", "filename")))' 2>/dev/null
}

# The prefix of an existing capture of this task, if there is one.
prefix_for() {
  local f
  for f in "$DIR"/*.task; do
    [ -e "$f" ] || continue
    if [ "$(cat "$f")" = "$1" ]; then
      echo "${f%.task}"
      return
    fi
  done
}

children=()
stop() {
  log "stopping"
  [ "${#children[@]}" -gt 0 ] && kill -TERM "${children[@]}" 2>/dev/null
  wait
  exit 0
}
trap stop INT TERM

log "waiting for prints (cthulhu $CTHULHU, captures in $DIR)"
while true; do
  IFS=$'\t' read -r label task file <<< "$(status)"
  case "$label" in
    ""|Idle|Complete|Stopped|Cancelled)
      sleep "$POLL" &
      wait $!  # interruptible, so a stop isn't held up by the sleep
      continue
      ;;
  esac
  if [ -z "$task" ]; then
    sleep "$POLL" & wait $!
    continue
  fi

  prefix="$(prefix_for "$task")"
  if [ -n "$prefix" ]; then
    log "resuming $prefix ($label)"
  else
    prefix="$DIR/$(date +%F-%H%M)-${file%.goo}"
    echo "$task" > "$prefix.task"
    log "new print: $prefix"
  fi

  children=()
  "$HERE/record-print.sh" "$prefix" & children+=($!)
  "$HERE/log-status.py" "$prefix-status.jsonl" & children+=($!)
  "$HERE/save-layers.sh" "$prefix" >> "$prefix.log" 2>&1 & children+=($!)
  # Exact phase changes, pushed by cthulhu over a websocket.
  bash -c "curl -sN '${CTHULHU/http/ws}/api/ws' | python3 -u '$HERE/log-status-events.py' '$prefix-status-events.jsonl'" &
  children+=($!)

  # Every job ends by itself once the print is over.
  wait "${children[@]}"
  children=()
  log "finished $prefix"
done
