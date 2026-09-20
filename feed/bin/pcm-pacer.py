#!/usr/bin/env python3
"""Emit a continuous real-time S16LE stream, padding with silence when idle.

Sits between librespot's pipe backend and ffmpeg. Two jobs, and the second one
is easy to get wrong:

1. librespot writes nothing whilst paused or stopped. Feeding that straight to
   ffmpeg starves the encoder and stalls the audio track. On the muxed stream
   that matters more than it sounds: the TV plays video and audio from a single
   media element, so a stalled audio track can take the picture down with it.
   Padding with silence keeps the track unbroken whatever Spotify is doing.

2. librespot's pipe backend has NO internal rate limiting. It relies on the
   sink blocking to pace it, the way a real sound card does. So we must never
   consume faster than real time. Draining eagerly — a greedy reader thread,
   say — makes librespot dump an entire track in a moment: it sounds garbled,
   and librespot concludes the track finished and skips to the next one, over
   and over. Reading at most one chunk per tick lets the pipe fill, which
   back-pressures librespot correctly.

Verified pacing: 529200 bytes (3 s of 44.1 kHz stereo S16) took 3.06 s.
"""

import os
import select
import sys
import time

RATE = 44100
CHANNELS = 2
SAMPLE_BYTES = 2
CHUNK_MS = 20
CHUNK = int(RATE * CHUNK_MS / 1000) * CHANNELS * SAMPLE_BYTES

# Never wait longer than this in a single select, so the tick stays responsive
# even when the source has gone quiet mid-chunk.
SELECT_SLICE_S = 0.005


def main() -> None:
    fd = sys.stdin.fileno()
    os.set_blocking(fd, False)
    out = sys.stdout.buffer

    pending = bytearray()
    silence = b"\x00" * CHUNK
    next_at = time.monotonic()
    eof = False

    while True:
        next_at += CHUNK_MS / 1000

        # Top up to at most one chunk. The bound is what provides back-pressure.
        while not eof and len(pending) < CHUNK:
            budget = next_at - time.monotonic()
            if budget <= 0:
                break
            ready, _, _ = select.select([fd], [], [], max(0.0, min(budget, SELECT_SLICE_S)))
            if not ready:
                break
            try:
                data = os.read(fd, CHUNK - len(pending))
            except BlockingIOError:
                break
            if data == b"":
                eof = True
                break
            pending.extend(data)

        frame = bytes(pending[:CHUNK])
        del pending[: len(frame)]
        if len(frame) < CHUNK:
            frame += silence[len(frame) :]

        try:
            out.write(frame)
            out.flush()
        except BrokenPipeError:
            break

        delay = next_at - time.monotonic()
        if delay > 0:
            time.sleep(delay)
        else:
            # Fell behind (scheduling hiccup); resync rather than spiral.
            next_at = time.monotonic()


if __name__ == "__main__":
    main()
