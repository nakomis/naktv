#!/usr/bin/env bash
# Start capturing the current resin print: video, status log and layer images.
#
#   start-capture.sh [DIR]      (default ~/resin-recordings)
#
# Run on the feed host (Rey) once a print is under way. Everything shares a
# prefix, DIR/YYYY-MM-DD-HHMM-<print name>, which is what render.py takes.
# All three run detached and stop by themselves when the print ends.
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
DIR="${1:-$HOME/resin-recordings}"
CTHULHU="${CTHULHU:-http://127.0.0.1:9120}"
mkdir -p "$DIR"

name="$(curl -s -m 5 "$CTHULHU/api/status" |
  python3 -c 'import json,sys; f=json.load(sys.stdin)["print"].get("filename") or ""; print(f[:-4] if f.endswith(".goo") else f)')"
if [ -z "$name" ]; then
  echo "nothing printing" >&2
  exit 1
fi
PREFIX="$DIR/$(date +%F-%H%M)-$name"

detach() { setsid nohup "$@" > /dev/null 2>&1 < /dev/null & }
detach "$HERE/record-print.sh" "$PREFIX"
detach "$HERE/log-status.py" "$PREFIX-status.jsonl"
detach "$HERE/save-layers.sh" "$PREFIX"
echo "$PREFIX"
