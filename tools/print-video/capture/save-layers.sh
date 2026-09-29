#!/usr/bin/env bash
# Save every layer image of the current print into PREFIX-layers/NNNN.png.
#
#   save-layers.sh PREFIX
#
# cthulhu decodes them from the print file on request (/api/print/layer), but
# only while that print is its current job: once the next one starts they are
# gone, so this runs during the print. About 20 KB each, ten a second.
# Re-running skips what is already saved.
set -u
PREFIX="${1:?usage: save-layers.sh PREFIX}"
CTHULHU="${CTHULHU:-http://127.0.0.1:9120}"
DIR="$PREFIX-layers"
mkdir -p "$DIR"
total="$(curl -s -m 5 "$CTHULHU/api/status" |
  python3 -c 'import json,sys; print(json.load(sys.stdin)["print"].get("totalLayer") or 0)')"
if [ "$total" -le 0 ]; then
  echo "nothing printing" >&2
  exit 1
fi
for n in $(seq 0 $((total - 1))); do
  f="$DIR/$(printf %04d "$n").png"
  [ -s "$f" ] && continue
  curl -sf -m 10 -o "$f" "$CTHULHU/api/print/layer?layer=$n" || rm -f "$f"
  sleep 0.05
done
missing=$(( total - $(find "$DIR" -name '*.png' | wc -l) ))
echo "$total layers, $missing missing" > "$DIR/.complete"
