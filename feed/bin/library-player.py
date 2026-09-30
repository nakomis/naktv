#!/usr/bin/env python3
"""Play random tracks from the CC0/CC BY library as raw PCM on stdout (NAKTV-26).

    library-player.py | pcm-pacer.py --output /run/naktv/library.pcm

The library is fetch_fma.py's output (NAKTV-25): a folder with tracks.json
listing each track's file, artist, title, licence and source. Tracks are
chosen at random, avoiding the last few played, and decoded one after
another by ffmpeg to the same S16LE 44.1 kHz stereo that librespot's pipe
backend writes, so the pacer and the audio producer treat both alike.

The pacer reads at most real time, so ffmpeg blocks on the full pipe and the
library plays at real speed. Nothing here needs to pace itself.

For each track it writes:
  - NOW_PLAYING_DIR/now-playing-library.json, the same shape as Spotify's
    now-playing.json (track, album, artists, uri, playing, updatedAt) plus the
    licence, which the now-playing server serves when the library is selected;
  - a line in PLAY_LOG (JSONL: start, end, file, artist, title, licence,
    licence URL, source), so a recorded print can credit what it played.

The manifest is re-read before every track, so tracks a running crawl adds
join the rotation. If the library isn't there (say the mount is down), it
waits and tries again rather than exit: the pacer pads with silence.
"""
from __future__ import annotations  # phi's /usr/bin/python3 is 3.9

import datetime as dt
import json
import os
import random
import subprocess
import sys
import time
from collections import deque
from pathlib import Path
from typing import Deque, Dict, List, Optional

FILENAME = "now-playing-library.json"


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def write_atomically(path: Path, data: dict) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False))
    tmp.replace(path)


def load_tracks(library: Path) -> List[Dict]:
    """The manifest's tracks whose files are present; [] if unreadable."""
    try:
        manifest = json.loads((library / "tracks.json").read_text())
    except (OSError, ValueError):
        return []
    return [t for t in manifest if t.get("file") and (library / t["file"]).exists()]


def pick(tracks: List[Dict], recent: Deque[str], rng: random.Random) -> Dict:
    """A random track, avoiding the recently played while there's a choice."""
    fresh = [t for t in tracks if t["file"] not in recent]
    return rng.choice(fresh or tracks)


def now_playing_doc(track: Dict, playing: bool = True) -> Dict:
    return {
        "track": track.get("title", ""),
        "album": track.get("album", ""),
        "artists": [track["artist"]] if track.get("artist") else [],
        "uri": track.get("source_url", ""),
        "licence": track.get("licence", ""),
        "licenceUrl": track.get("licence_url", ""),
        "playing": playing,
        "updatedAt": now_iso(),
    }


def decode(ffmpeg: str, path: Path, out) -> int:
    """Decode one file to S16LE 44.1 kHz stereo on `out`; ffmpeg's exit code."""
    proc = subprocess.run(
        [ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-i", str(path),
         "-vn", "-f", "s16le", "-ar", "44100", "-ac", "2", "-"],
        stdout=out, stderr=subprocess.PIPE,
    )
    if proc.returncode:
        sys.stderr.write(f"ffmpeg failed on {path}: {proc.stderr.decode(errors='replace')[-300:]}\n")
    return proc.returncode


def main() -> None:
    library = Path(os.environ.get("LIBRARY_DIR", "/mnt/plex/music/cc-ambient"))
    www = Path(os.environ.get("NOW_PLAYING_DIR", "/tmp/naktv-www"))
    play_log = Path(os.environ.get("PLAY_LOG", "/var/log/naktv/library-plays.jsonl"))
    ffmpeg = os.environ.get("FFMPEG_BIN", "ffmpeg")
    avoid = int(os.environ.get("AVOID_RECENT", "50"))
    www.mkdir(parents=True, exist_ok=True)
    rng = random.Random()
    recent: Deque[str] = deque(maxlen=avoid)
    out = sys.stdout.buffer

    while True:
        tracks = load_tracks(library)
        if not tracks:
            write_atomically(www / FILENAME, {**now_playing_doc({}, playing=False)})
            time.sleep(30)
            continue
        track = pick(tracks, recent, rng)
        recent.append(track["file"])
        started = now_iso()
        write_atomically(www / FILENAME, now_playing_doc(track))
        code = decode(ffmpeg, library / track["file"], out)
        entry = {"start": started, "end": now_iso(), "file": track["file"], "artist": track.get("artist", ""),
                 "title": track.get("title", ""), "licence": track.get("licence", ""),
                 "licence_url": track.get("licence_url", ""), "source_url": track.get("source_url", ""),
                 "ok": code == 0}
        try:
            with open(play_log, "a") as f:
                f.write(json.dumps(entry, ensure_ascii=False) + "\n")
        except OSError:
            pass  # the log is a nicety; the music isn't
        if code:
            time.sleep(1)  # a broken file: don't spin


if __name__ == "__main__":
    try:
        main()
    except BrokenPipeError:
        pass  # the pacer went away; systemd restarts the pair
