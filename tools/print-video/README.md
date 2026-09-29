# print-video

Turn a resin print into a long, calm video: the Elegoo camera, the NakTV
overlay burned in (status, layer, progress, times, and the music's artist and
track, styled like the TV), the layer being exposed top right, and a CC0
soundtrack. Made for YouTube (NAKTV-19).

## 1. Capture, on Rey, during the print

```bash
tools/print-video/capture/start-capture.sh      # prints the capture prefix
```

That starts four detached jobs, all stopping by themselves when the print
ends:

| Job | Writes |
|---|---|
| `record-print.sh` | `PREFIX-partNN.mkv`: go2rtc's `resin_av`, video only, copied (no re-encode, no extra CPU while the TV watches too). `PREFIX-parts.jsonl`: each part's start time. |
| `log-status.py` | `PREFIX-status.jsonl`: cthulhu's `/api/status` once a second |
| `log-status-events.py` | `PREFIX-status-events.jsonl`: every phase and layer change, to the millisecond, as cthulhu pushes it over `/api/ws`. |
| `save-layers.sh` | `PREFIX-layers/NNNN.png`: every layer image. **These are only available while the print is cthulhu's current job**, so this runs during the print. |

About 1.6 GB an hour, measured. Rey is only the buffer: copy the capture to
phi to render, and archive it to Luke/Leia at leisure.

## 2. Copy to phi

```bash
rsync -a --partial rey:resin-recordings/PREFIX{.log,-parts.jsonl,-status.jsonl,-part*.mkv,-layers} captures/
```

## 3. Render, on phi

```bash
python3 render.py captures/PREFIX --music ~/Music/CC0\ Ambient \
  --from-layer 900 -o renders/PREFIX.mp4
```

- **Trimming:** `--from-layer` / `--until-layer` (the first few hours of a long
  print are usually just supports), or `--from-time` / `--until-time`
  (wall-clock `HH:MM[:SS]`). `--max-seconds` for a quick test render.
- **`--offset`** (default −4 s): the printer reports each phase about 4 s after
  the camera shows it, so status and layer changes are moved 4 s earlier.
  Calibrated by eye against the millisecond event log
  (`PREFIX-status-events.jsonl`); with only the 1 Hz log, boundaries are
  smeared by up to a second.
- **Music:** every audio file in the folder, in name order, looped. Artist
  and title come from `tracks.json` in that folder if present, then the file
  tags, then an `Artist - Title` file name. `tracks.json` also carries each
  track's licence and source URL.
- Alongside the video it writes **`NAME.description.txt`**, ready to paste
  into YouTube: credits for every track used, and a timestamped tracklist that
  YouTube turns into chapters.

Output is 1920x1080 (the 720p camera is scaled up; the overlay is drawn at
full resolution), H.264 via VideoToolbox at about 7 Mbit/s. On phi's M5 Pro it
renders at about 10x real time.

Needs **ffmpeg with libass**, which is Homebrew's `ffmpeg-full` (keg-only, so it
sits alongside the plain `ffmpeg`; `render.py` finds it). The plain formula has
no text rendering. Python 3.9+, standard library only.

## Tests

```bash
cd tools/print-video && python3 -m unittest -v
```
