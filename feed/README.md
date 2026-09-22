# feed

The printer-cam pipeline that NakTV consumes, plus Spotify audio muxed into it.

Runs on a host with ffmpeg, go2rtc and librespot. Currently phi; not yet
deployed anywhere permanent.

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
   - **Linux/x86 with VAAPI**: `-hwaccel vaapi` + `h264_vaapi`
   - **Raspberry Pi 4**: `h264_v4l2m2m` (hardware, 1080p30), needs
     `/dev/video11` if containerised
   - **Raspberry Pi 5**: no H.264 hardware encoder at all — use `libx264` with
     `-preset ultrafast`. The A76 has ample headroom for 1080p15.

`bin/` takes its paths from the environment, so only `go2rtc.yaml` needs
editing: `LIBRESPOT_BIN`, `FFMPEG_BIN`, `PYTHON_BIN`, `PACER`, `DEVICE_NAME`,
`BITRATE`, `INITIAL_VOLUME`, `AUDIO_BITRATE`, `LOG_DIR`.

Note that Spotify Connect discovery is mDNS, which does not traverse Docker's
bridge network — a container would need `network_mode: host`, and therefore a
Linux host.
