#!/usr/bin/env bash
# Save the current print's file (PREFIX.goo) and every layer image
# (PREFIX-layers/NNNN.png).
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
# cthulhu fetches the whole print file from the printer before it can decode
# any layer, over the printer's WiFi: 45 s for a small file, a quarter of an
# hour for a 500 MB one. Wait for that once, up to an hour, rather than per
# layer.
for wait in $(seq 1 720); do
  code="$(curl -s -m 10 -o /dev/null -w '%{http_code}' "$CTHULHU/api/print/layer?layer=0")"
  [ "$code" = 202 ] || break
  sleep 5
done

# Keep the print file itself as well: the complete original, at full
# resolution and with every layer's exposure time, which can be decoded again
# any time. cthulhu keeps only the current print's copy (it deletes the others
# when a new print starts), so take it now, straight out of its volume.
task="$(curl -s -m 5 "$CTHULHU/api/status" | python3 -c 'import json,sys; print(json.load(sys.stdin)["print"].get("taskId") or "")')"
if [ -n "$task" ] && [ ! -s "$PREFIX.goo" ]; then
  if docker exec "${CTHULHU_CONTAINER:-cthulhu}" cat "/data/print-files/$task.goo" > "$PREFIX.goo.part" 2>/dev/null \
     && [ -s "$PREFIX.goo.part" ]; then
    mv "$PREFIX.goo.part" "$PREFIX.goo"
  else
    rm -f "$PREFIX.goo.part"
    echo "couldn't copy the print file for task $task" >&2
  fi
fi

# Only a 200 is an image. While cthulhu is still fetching the print file from
# the printer (about 45 s after a print starts) it answers 202 with a JSON
# progress body, which must not be saved as a layer: wait and ask again.
for n in $(seq 0 $((total - 1))); do
  f="$DIR/$(printf %04d "$n").png"
  [ -s "$f" ] && continue
  for attempt in $(seq 1 120); do
    code="$(curl -s -m 10 -o "$f.part" -w '%{http_code}' "$CTHULHU/api/print/layer?layer=$n")"
    if [ "$code" = 200 ]; then mv "$f.part" "$f"; break; fi
    rm -f "$f.part"
    [ "$code" = 202 ] && { sleep 5; continue; }
    break  # 404 or an error: give up on this layer; render.py falls back to the one before
  done
  sleep 0.05
done
missing=$(( total - $(find "$DIR" -name '*.png' | wc -l) ))
echo "$total layers, $missing missing" > "$DIR/.complete"
