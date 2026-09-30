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
"""
from __future__ import annotations  # phi's /usr/bin/python3 is 3.9

import errno
import os
import select
import time

SOURCES = ("spotify", "library")
DEFAULT = "spotify"


def read_source(path: str) -> str:
    try:
        with open(path) as f:
            s = f.read().strip()
    except OSError:
        return DEFAULT
    return s if s in SOURCES else DEFAULT


def open_fifo(path: str) -> int:
    if not os.path.exists(path):
        os.mkfifo(path, 0o660)
    return os.open(path, os.O_RDWR | os.O_NONBLOCK)


def write_nonblocking(fd: int, data: bytes) -> None:
    try:
        os.write(fd, data)
    except OSError as exc:
        if exc.errno not in (errno.EAGAIN, errno.EWOULDBLOCK):
            raise


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
            if data and names[fd] == source:
                write_nonblocking(out, data)


if __name__ == "__main__":
    main()
