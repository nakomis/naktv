# feed

The printer-cam pipeline that NakTV consumes, plus Spotify audio muxed into it.

Runs on **Rey** as two systemd units, installed by
`home-infra/rey/ansible/playbook.yml` (`--tags naktv-feed`) from artefacts in
Nexus. It used to run on phi by hand, which is a development laptop and sleeps
— on 2026-09-20 that took the feed down mid-session (NAKTV-9).

`scripts/publish-feed.sh` publishes what the playbook installs: pinned go2rtc
and librespot binaries, and a versioned tarball of this directory. The Nexus
repo is `ALLOW_ONCE`, so a version is immutable — re-publishing means bumping
it.

### Rey's encoder flags differ from phi's

`-pix_fmt yuv420p` is required and was not on phi. The camera emits
`yuvj422p`, and libx264's `high` profile is 4:2:0 only, so it refuses with
`high profile doesn't support 4:2:2` and the video producer never starts —
leaving a stream that carries audio and no picture. `h264_videotoolbox`
converted internally and hid this.

VAAPI was measured and rejected. The HD 3000 advertises H.264 encode through
the legacy `i965` driver and it works, but it saves 4%: Sandy Bridge has no
JPEG decode entrypoint, so decode stays on the CPU, and the `nv12` conversion
plus `hwupload` consumes the difference. Sustained cost either way is ~1.6
cores, with no thermal throttling over ten minutes.

![The feed pipeline: Leia serves MJPEG to an ffmpeg video producer, librespot and
the PCM pacer feed an ffmpeg audio producer through a named pipe, and go2rtc muxes
both into the printer_av stream the TV plays from a single video element](../docs/architecture/feed.svg)

## Why the audio is muxed into the video

This is the part that looks over-engineered and isn't.

**webOS allows an app exactly one media element.** A `<video>` and a separate
`<audio>` force-pause each other: whichever starts last wins, and the OS pauses
the other. Measured on the B3 (webOS 23, firmware 23.25.55):

| Action | Video | Audio |
|---|---|---|
| Tone playing | `paused=true` (OS paused it) | playing |
| Force `video.play()` | `paused=false` | `paused=true`, frozen |
| Stop tone, resume video | `paused=false` | — |

It is not a DRM or Spotify restriction — the test above used a plain AAC file.
LG document it as "use only one audio element in your app" to avoid hardware
decoder conflicts, and their forums describe a second media element making the
first lose its rendering surface.

So anything that plays audio *alongside* the camera in the app is dead on
arrival. That includes the Spotify Web Playback SDK (which otherwise works
fine on this TV — Widevine instantiates, the SDK accepts the environment) and
any scheme feeding a separate `<audio>` element from the network.

Muxing both tracks into one stream sidesteps the rule entirely: the TV sees a
single element, so the video keeps **hardware** decode at full 1080p and there
is sound as well.

### Routes that were tried and rejected

- **MJPEG `<img>` + `<audio>`** — works (an `<img>` is not a media element and
  uses no pipeline), but the TV software-decodes 1080p JPEGs at ~228 KB/frame
  and it is visibly jerky. This is the original problem go2rtc exists to solve.
  Downscaling fixes the smoothness and loses the quality.
- **WebRTC `<video>` + Spotify SDK** — genuinely coexists, because webOS
  software-decodes WebRTC rather than routing it through the hardware pipeline.
  But that is also why it is unusable: ~73 ms/frame at 1080p, a ~13.7 fps
  ceiling against a 15 fps source, so it slowly falls behind and jumps.
  Switching the encoder to `constrained_baseline` improved it from ~91 ms to
  ~73 ms but did not unlock hardware decode.
- **WebCodecs** — `VideoDecoder` exists, but `prefer-hardware` reports
  `supported: false`. Software only, so same class of problem.

## Components

| File | Role |
|---|---|
| `go2rtc.yaml` | Stream definitions: `printer` (video only) and `printer_av` (video + Spotify) |
| `bin/spotify-connect.sh` | **Long-lived**: librespot → pacer → named pipe. Started by hand, outlives go2rtc |
| `bin/spotify-audio.sh` | go2rtc audio producer: named pipe → AAC → RTSP. Restartable at will |
| `bin/pcm-pacer.py` | Paces to real time, pads silence when idle, and owns the pipe |
| `bin/now-playing.py` | librespot `--onevent` hook: writes `now-playing.json` (see "Now playing" below) |
| `bin/now-playing-server.py` | Serves `now-playing.json` over HTTP for the TV to poll |

### Why librespot is not a go2rtc producer

go2rtc starts and stops producers whenever the last consumer comes or goes — an
app reload, a tab switch, a sideload, a network blip. With librespot as a child
of that producer, every one of those events minted a *new* Connect device and
left Spotify talking to a dead one, so pressing play did nothing, silently.

Splitting them fixes it. The pacer opens the pipe **read-write**, so it never
sees EOF or a broken pipe however often the ffmpeg on the other end restarts,
and writes non-blocking, so with nothing reading the audio is dropped rather
than backing up into librespot and stalling playback. go2rtc can then restart
its side as often as it likes and the Spotify session is undisturbed.

### Why the pacer exists

Two failure modes, both of which look like something else:

1. **librespot has no internal rate limiting.** Its pipe backend relies on the
   sink blocking to pace it, like a real sound card. Consume eagerly and it
   dumps an entire track instantly — which sounds garbled and makes librespot
   conclude the track finished, so it skips to the next one, and the next.
   The pacer reads at most one 20 ms chunk per tick, which back-pressures it.
2. **librespot writes nothing whilst paused.** That starves ffmpeg and stalls
   the audio track, and on a muxed stream a stalled track can take the picture
   with it. The pacer substitutes silence.


### Why the audio input also needs `-use_wallclock_as_timestamps`

The video producer stamps frames with the wall clock, because Leia's MJPEG
carries no timestamps of its own. Raw PCM on a pipe has none either, so ffmpeg
would number the audio from zero — and the two tracks then sit on completely
different timelines. Muxed together, the player locks onto one and the other's
frames look far out of range, so they are never rendered: **sound plays and the
picture never appears**. Both inputs must use the same clock.
### Why the audio input also needs `-af aresample=async=1`

The wallclock stamps record when ffmpeg happened to read the pipe, not when the
samples were generated, so consecutive packets can arrive fractionally out of
order. ffmpeg then logs `Queue input is backward in time` and `Non-monotonic
DTS` for every packet and rewrites the timestamps itself.

On a muxed stream that does not stay contained in the audio track: the player
stalls waiting on audio and jumps to catch up, so the *picture* hangs a second
at a time and the live-edge chase starts firing. Resampling to a continuous
timeline keeps the wallclock base the video is aligned to whilst making the
output strictly monotonic.
### Why `spotify-connect.sh` supervises librespot

librespot logged `Connection to server closed.` and then sat for forty minutes,
still running and still advertising over mDNS, but with no session. Spotify
listed the device, claimed to be playing to it, and produced silence — a state
in which every process check reports health.

The loop restarts the pipeline on exit. That does not detect a live-but-
sessionless librespot by itself, but it makes recovery a one-liner from
anywhere: `pkill -f "librespot --name NakTV"` brings up a clean instance,
instead of needing whoever started the script to press Ctrl-C.

### Why `spotify-connect.sh` kills its own process group

librespot does **not** exit when its output pipe breaks. It logs `Audio Sink
Error On Write: Broken pipe` and carries on, still advertising over mDNS. A
restart that leaves one behind therefore leaks an orphan still claiming the
device name. Two devices called "NakTV" then appear identical in Spotify, and
picking the dead one does nothing at all — silently. Hence `set -m`, the trap,
and the sweep at startup.

Splitting librespot out of the producer makes this far rarer, since only a
deliberate restart of the Connect endpoint can trigger it, but the guard stays:
the failure is invisible from Spotify's side and maddening to diagnose.

## Now playing

The Elegoo overlay in the app shows what Spotify is currently playing,
right-aligned in the same bar as the print status (NAKTV-13). It works
entirely alongside the audio pipeline above, not through it:

- `bin/now-playing.py` is passed to librespot as `--onevent`. librespot runs
  it once per player event, on its own thread, and blocks on it — so it must
  return almost instantly and never fail loudly (it always exits 0). On
  `track_changed` it records the track, album and artists; on `playing`,
  `paused`, `stopped` and `session_disconnected` it updates only the playing
  flag, preserving whatever track fields it already knows, because those
  events carry a track ID but not a name. It writes
  `$NOW_PLAYING_DIR/now-playing.json` (default `/tmp/naktv-www`) atomically —
  temp file plus rename — so a poller never sees a half-written file.
- `bin/now-playing-server.py` serves that directory over plain HTTP on port
  **1985** (chosen because it's free on phi alongside go2rtc's 1984), adding
  `Access-Control-Allow-Origin: *` and `Cache-Control: no-store`. It is
  started by `spotify-connect.sh` as a background child, once, independently
  of the librespot pipeline's own restart loop — so a flaky Spotify session
  never interrupts the last-known "now playing" the TV is showing.
- The app polls `http://<go2rtc host>:1985/now-playing.json` every 5 seconds
  (`useNowPlaying`, mirroring `useCthulhu`) and shows nothing when the feed is
  unreachable, stale, or reports nothing playing.

Both scripts are plain `python3` stdlib, no dependencies, and both take their
directory and port from `NOW_PLAYING_DIR` / `NOW_PLAYING_PORT`, overridable
the same way as everything else in `bin/`.

Restarting `spotify-connect.sh` to pick up a change here must be done from a
**GUI terminal on phi**, never over ssh — see "Operating it" below for why.

## Operating it

go2rtc is started by hand and has no launchd job. Apply config changes with:

```bash
curl -X POST http://127.0.0.1:1984/api/restart
```

Do **not** kill the process — nothing would restart it.

`bin/spotify-connect.sh` is started separately and by hand:

```bash
feed/bin/spotify-connect.sh
```

Both need macOS **Local Network permission**, which an *interactive* terminal
has once it has been granted — including an interactive ssh session — but a
detached, non-interactive `ssh host 'cmd'` does not. Started that way, go2rtc
and everything it spawns cannot reach the LAN: the symptoms are a Connect
device that never appears and `Connection to <camera> failed: No route to
host`, neither of which looks like a permissions problem.

If the pipe is missing, `spotify-audio.sh` exits rather than blocking forever on
open, so go2rtc serves `printer_av` as video-only. That still plays; there is
simply no sound until the Connect endpoint is running.

## Moving to another host

Three things are host-specific:

1. **ffmpeg paths** in `go2rtc.yaml` (two `exec:` lines and `ffmpeg.bin`).
2. **The audio producer path** in the `printer_av` stream.
3. **The encoder flags.** `-hwaccel videotoolbox` and `h264_videotoolbox` are
   Apple Silicon. Elsewhere:
   - **Linux/x86 with VAAPI**: `-hwaccel vaapi` + `h264_vaapi`. On pre-Broadwell
     Intel — Rey's HD 3000 (Sandy Bridge) included — this needs the legacy
     `i965-va-driver`; the current `intel-media-driver` (iHD) only supports
     Broadwell and later, so a box that old will report no VAAPI encoder at all
     until the right driver is installed. Treat it as worth testing, not as a
     given: Sandy Bridge is the oldest generation i965 supports.
   - **Raspberry Pi 4**: `h264_v4l2m2m` (hardware, 1080p30), needs
     `/dev/video11` if containerised
   - **Raspberry Pi 5**: no H.264 hardware encoder at all — use `libx264` with
     `-preset ultrafast`. The A76 has ample headroom for 1080p15.

`bin/` takes its paths from the environment, so only `go2rtc.yaml` needs
editing: `LIBRESPOT_BIN`, `FFMPEG_BIN`, `PYTHON_BIN`, `PACER`, `DEVICE_NAME`,
`BITRATE`, `INITIAL_VOLUME`, `AUDIO_BITRATE`, `LOG_DIR`, `NOW_PLAYING_DIR`,
`NOW_PLAYING_PORT`.

Note that Spotify Connect discovery is mDNS, which does not traverse Docker's
bridge network — a container would need `network_mode: host`, and therefore a
Linux host.
