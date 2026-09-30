#!/usr/bin/env python3
"""Forward either Spotify's or the library's paced PCM into one pipe (NAKTV-26).

    music-switch.py   # reads SPOTIFY_FIFO and LIBRARY_FIFO, writes MUSIC_FIFO

go2rtc's audio producer (spotify-audio.sh) reads MUSIC_FIFO and muxes it into
every camera stream. Switching the source here, rather than giving the TV a
second set of streams, keeps one video encode per camera and means a recorded
print gets whatever the TV was hearing.

Both inputs arrive already paced to real time by pcm-pacer.py (padded with
silence when idle), so this just drains both continuously - an undrained
FIFO would back up and drop audio - and passes the selected one through.
The selection is a file, SOURCE_FILE, containing "spotify" or "library",
written by the now-playing server's /music-source API; it's re-read every
half second, so a switch lands almost at once.

Every FIFO is opened read-write and non-blocking, as pcm-pacer.py does, so
nothing ever sees EOF or a broken pipe when the other side restarts, and a
missing reader means audio is dropped rather than stalling the sources.

Output goes in whole 4-byte frames, at most PIPE_BUF at a time. POSIX makes a
non-blocking pipe write of up to PIPE_BUF all-or-nothing; a bigger one can
land partly, and dropping the rest could split a frame, after which every
sample comes out half a sample late - static that never recovers. Anything
that won't fit is dropped whole, which is a brief gap, not corruption.

The output pipe is shrunk to OUT_PIPE_SIZE, so with no reader (go2rtc stops
its producer when nobody is watching) a reconnecting viewer gets at most a
fraction of a second of stale audio rather than the default 64 KiB.
"""
from __future__ import annotations  # phi's /usr/bin/python3 is 3.9

import errno
import fcntl
import os
import select
import time

SOURCES = ("spotify", "library")
DEFAULT = "spotify"
FRAME = 4  # S16LE stereo
PIPE_BUF = 4096  # Linux's atomic write limit; a whole number of frames
OUT_PIPE_SIZE = 16384  # ~93 ms at 44.1 kHz; the kernel rounds up to a page


def read_source(path: str) -> str:
    try:
        with open(path) as f:
            s = f.read().strip()
    except OSError:
        return DEFAULT
    return s if s in SOURCES else DEFAULT


def open_fifo(path: str) -> int:
    if not os.path.exists(path):
        os.mkfifo(path, 0o600)
    return os.open(path, os.O_RDWR | os.O_NONBLOCK)


def shrink_pipe(fd: int, size: int) -> None:
    """Linux only (and Python 3.10+); elsewhere the default size stands."""
    setsz = getattr(fcntl, "F_SETPIPE_SZ", None)
    if setsz is None:
        return
    try:
        fcntl.fcntl(fd, setsz, size)
    except OSError:
        pass


def forward(fd: int, data: bytes) -> int:
    """Write whole frames in atomic chunks; drop whole chunks that won't fit.

    `data` must be a whole number of frames. Returns the bytes written.
    """
    written = 0
    for start in range(0, len(data), PIPE_BUF):
        try:
            written += os.write(fd, data[start:start + PIPE_BUF])
        except OSError as exc:
            if exc.errno not in (errno.EAGAIN, errno.EWOULDBLOCK):
                raise
    return written


def main() -> None:
    inputs = {
        "spotify": os.environ.get("SPOTIFY_FIFO", "/run/naktv/spotify.pcm"),
        "library": os.environ.get("LIBRARY_FIFO", "/run/naktv/library.pcm"),
    }
    out_path = os.environ.get("MUSIC_FIFO", "/run/naktv/music.pcm")
    source_file = os.environ.get("SOURCE_FILE", "/run/naktv/www/music-source")

    fds = {name: open_fifo(path) for name, path in inputs.items()}
    names = {fd: name for name, fd in fds.items()}
    out = open_fifo(out_path)
    shrink_pipe(out, OUT_PIPE_SIZE)
    # Carries a read's trailing part-frame to the next, per input, so what is
    # forwarded always starts on a frame boundary. pcm-pacer writes whole
    # frames atomically, so in practice this stays empty.
    partial = {fd: b"" for fd in fds.values()}
    source, checked = read_source(source_file), 0.0

    while True:
        if time.monotonic() - checked > 0.5:
            source, checked = read_source(source_file), time.monotonic()
        ready, _, _ = select.select(list(fds.values()), [], [], 0.5)
        for fd in ready:
            try:
                data = os.read(fd, 65536)
            except BlockingIOError:
                continue
            data = partial[fd] + data
            whole = len(data) - len(data) % FRAME
            partial[fd] = data[whole:]
            if whole and names[fd] == source:
                forward(out, data[:whole])


if __name__ == "__main__":
    main()
