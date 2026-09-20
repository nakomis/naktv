# feed

The printer-cam pipeline that NakTV consumes, plus Spotify audio muxed into it.

Runs on a host with ffmpeg, go2rtc and librespot. Currently phi; not yet
deployed anywhere permanent.

```
Leia (mjpg-streamer, 1080p15 MJPEG)
        |
        v
    ffmpeg  -- H.264 ------.
                            >--  go2rtc  "printer_av"  --> TV: one <video>
    librespot -> pacer -----'                                (video + audio)
              -> ffmpeg -- AAC
```

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
| `bin/spotify-audio.sh` | go2rtc audio producer: librespot → pacer → AAC → RTSP |
| `bin/pcm-pacer.py` | Paces librespot's output to real time and pads silence when idle |

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

### Why `spotify-audio.sh` kills its own process group

librespot does **not** exit when its output pipe breaks. It logs `Audio Sink
Error On Write: Broken pipe` and carries on, still advertising over mDNS. Every
restart of the producer therefore leaks an orphan still claiming the device
name. Two devices called "NakTV" then appear identical in Spotify, and picking
the dead one does nothing at all — silently. Hence `set -m`, the trap, and the
startup sweep.

## Operating it

go2rtc is started by hand and has no launchd job. Apply config changes with:

```bash
curl -X POST http://127.0.0.1:1984/api/restart
```

Do **not** kill the process — nothing would restart it.

Note that go2rtc starts producers lazily and stops them when the last consumer
disconnects, so librespot only advertises whilst something is watching
`printer_av`. Reconnecting the stream restarts librespot and invalidates the
Connect device. A persistent librespot, decoupled from go2rtc's consumer
lifecycle, is the obvious next improvement.

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
