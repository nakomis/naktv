# print-video

Turn a resin print into a long, calm video: the Elegoo camera, the NakTV
overlay burned in (status, layer, progress, times, and the music's artist and
track, styled like the TV), the layer being exposed top right, and a CC0
soundtrack. Made for YouTube (NAKTV-19).

## 1. Capture, on Rey, during the print

Automatic. `print-recorder.service` on Rey (NAKTV-30, installed by
home-infra's Rey playbook) runs `capture/print-recorder.sh`, which waits for
cthulhu to report a print, captures it, and goes back to waiting: there is
nothing to arm between prints. Its log is `journalctl -u print-recorder`.

If the service restarts mid-print (a deploy, a reboot), it resumes the same
capture: each one keeps its print's cthulhu task ID in `PREFIX.task`, the
recording carries on as the next part, and nothing is overwritten.

By hand, for a print the service isn't covering:

```bash
tools/print-video/capture/start-capture.sh      # prints the capture prefix
```

Either way, a capture is four jobs, all stopping by themselves when the print
ends:

| Job | Writes |
|---|---|
| `record-print.sh` | `PREFIX-partNN.mkv`: go2rtc's `resin_av`, video only, copied (no re-encode, no extra CPU while the TV watches too). `PREFIX-parts.jsonl`: each part's start time. |
| `log-status.py` | `PREFIX-status.jsonl`: cthulhu's `/api/status` once a second |
| `log-status-events.py` | `PREFIX-status-events.jsonl`: every phase and layer change, to the millisecond, as cthulhu pushes it over `/api/ws`. |
| `save-layers.sh` | `PREFIX.goo`: the print file itself, copied out of cthulhu's volume (full resolution, per-layer exposure times). `PREFIX-layers/NNNN.png`: every layer image, which render.py uses. **These are only available while the print is cthulhu's current job**, so this runs during the print. |

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
- **Music:** every audio file in the folder, in `tracks.json` order (else by
  name), looped if the video is longer. `music/fetch_fma.py albums` fills the
  folder with tracks picked at random from Free Music Archive albums;
  `fetch_fma.py crawl` walks FMA's genre listings for a large library (NAKTV-25).
  Either way, only tracks whose own page states CC0 1.0 or CC BY are kept
  (NC, ND and SA are refused), with the licence and its link in `tracks.json`
  and in the file tags. The description and pinned comment credit every track
  with its licence and link, as CC BY requires, and say when the last track is
  cut short to fit. Artist
  and title come from `tracks.json` in that folder if present, then the file
  tags, then an `Artist - Title` file name. `tracks.json` also carries each
  track's licence and source URL.
- Alongside the video it writes **`NAME.description.txt`**, ready to paste
  into YouTube: credits for every track used, and a timestamped tracklist that
  YouTube turns into chapters.

STATUS is the printer's own label, shown verbatim. "Lifting" and "Dropping"
can look the wrong way round against the picture (a resin printer moves the
head, not the plate), but the video agrees with the printer and the Elegoo
app, and that's deliberate.

The layer panel is the TV's size and place (`--layer-scale 1`), but carries
less detail: drawn at 75% of its box (`--layer-resolution 0.75`) and blurred
by 1 px (`--layer-blur 1`). Rebuilding a model from such a video loses the fine
texture, and the blur breaks up thin support braces, which is what makes a
copy hard to print (NAKTV-21). `--layer-resolution 1 --layer-blur 0` gives
the TV's full detail.

Output is 1920x1080 (the 720p camera is scaled up; the overlay is drawn at
full resolution), H.264 via VideoToolbox at about 7 Mbit/s. On phi's M5 Pro it
renders at about 10x real time.

Needs **ffmpeg with libass**, which is Homebrew's `ffmpeg-full` (keg-only, so it
sits alongside the plain `ffmpeg`; `render.py` finds it). The plain formula has
no text rendering. Python 3.9+, standard library only.

## Round-tripping a .goo through its layer images

`goo/goopng.c` decodes every layer of an Elegoo `.goo` to a full-resolution
1-bit PNG, and builds a `.goo` back from such PNGs. It proves that the layer
images are the whole of the print: the inverted Sad cats (5,231 layers,
8520x4320) came back **byte-identical** (BCON-63).

```bash
cc -O2 -o goopng goo/goopng.c -lz
./goopng goo2png PREFIX.goo png/                # 96 s on phi
./goopng png2goo HEADER.goo png/ rebuilt.goo    # 52 s
```

`png2goo` takes only the header from `HEADER.goo`: thumbnails and print
settings, which are metadata. Each layer's 66-byte definition is generated from
those settings (height, bottom and normal exposure, 5 transition layers), and
its image comes from the PNG. With a header from a *different* print, where
only the layer count has changed, the file hashes differ but everything from
the first layer onwards (`tail -c +195478`) hashes the same.

Black-and-white layers only, which is what Chitubox writes without
anti-aliasing. Standard C and zlib, so it has no other dependencies.

## Tests

```bash
cd tools/print-video && python3 -m unittest -v
```
