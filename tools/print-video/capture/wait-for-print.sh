#!/usr/bin/env bash
# Wait for the next resin print to start, then capture it.
#
#   wait-for-print.sh [DIR]
#
# Polls cthulhu every 15 s. Once the printer is doing anything other than
# sitting idle (or showing the last print as complete), runs start-capture.sh
# and exits. Arm it with `setsid nohup wait-for-print.sh &` before starting a
# print you want recorded.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
CTHULHU="${CTHULHU:-http://127.0.0.1:9120}"

while true; do
  label="$(curl -s -m 5 "$CTHULHU/api/status" |
    python3 -c 'import json,sys; print(json.load(sys.stdin)["print"].get("statusLabel",""))' 2>/dev/null)"
  case "$label" in
    ""|Idle|Complete|Stopped|Cancelled) sleep 15 ;;
    *) exec "$HERE/start-capture.sh" "$@" ;;
  esac
done
