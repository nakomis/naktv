#!/usr/bin/env python3
"""librespot `--onevent` hook: write what Spotify is playing to a JSON file.

librespot runs this once per PlayerEvent, on a dedicated thread that blocks on
this process's exit before it will process the next event — see
`run_program` in librespot's `src/player_event_handler.rs` (it does
`Command::spawn()` then `child.wait()`). So this must return almost
instantly and must NEVER hang or exit non-zero: doing either would delay or
warn on every subsequent Spotify event, including the ones that actually
matter (pause, skip). Every code path here is wrapped so a bug in this script
can only mean a stale or missing now-playing.json — never a disturbed
Spotify session.

Variable names below are exactly what librespot 0.8's event handler sets
(confirmed against `src/player_event_handler.rs` and
`contrib/event_handler_example.py`, tag v0.8.0):

- Every event sets `PLAYER_EVENT`.
- `track_changed` sets `NAME`, `ALBUM`, `ARTISTS` (newline-separated, one
  per artist), `URI`, `DURATION_MS`, among others we don't need.
- `playing`, `paused` set only `TRACK_ID` and `POSITION_MS` — NOT the track
  name or album, which is why those events preserve the fields
  `track_changed` last wrote rather than overwriting them.
- `stopped` sets only `TRACK_ID`.
- `session_disconnected` carries no track fields at all.

The file is written atomically (temp file + `os.rename`, same directory, so
it's the same filesystem) so a reader polling over HTTP never sees a
half-written file.
"""

from __future__ import annotations  # phi's /usr/bin/python3 is 3.9

import json
import os
import sys
import tempfile
from datetime import datetime, timezone

DEFAULT_DIR = '/tmp/naktv-www'
FILENAME = 'now-playing.json'

# Events that mean "something is now playing or paused, and here's what" —
# handled below. Everything else (loading, seeked, volume_changed, session
# housekeeping, ...) is deliberately ignored: not an error, just nothing this
# overlay needs to react to.
TRACK_CHANGED = 'track_changed'
PLAYING = 'playing'
PAUSED = 'paused'
STOPPED = 'stopped'
SESSION_DISCONNECTED = 'session_disconnected'


def target_dir() -> str:
    return os.environ.get('NOW_PLAYING_DIR', DEFAULT_DIR)


def read_current(path: str) -> dict:
    """The doc already on disk, or a safe empty one if there isn't one yet."""
    try:
        with open(path, encoding='utf-8') as f:
            data = json.load(f)
        if isinstance(data, dict):
            return data
    except (OSError, ValueError):
        pass
    return {'track': '', 'album': '', 'artists': [], 'uri': None, 'playing': False}


def write_atomically(path: str, data: dict) -> None:
    directory = os.path.dirname(path) or '.'
    fd, tmp_path = tempfile.mkstemp(dir=directory, prefix='.now-playing-')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            json.dump(data, f)
        os.rename(tmp_path, path)
    except OSError:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def build_update(event: str, current: dict) -> dict | None:
    """The new doc to write for this event, or None to leave the file alone."""
    now = datetime.now(timezone.utc).isoformat()

    if event == TRACK_CHANGED:
        artists = os.environ.get('ARTISTS', '').split('\n') if os.environ.get('ARTISTS') else []
        return {
            'track': os.environ.get('NAME', ''),
            'album': os.environ.get('ALBUM', ''),
            'artists': artists,
            'uri': os.environ.get('URI') or None,
            # A track change is librespot about to play it; a 'paused' event
            # corrects this immediately if that turns out not to be true.
            'playing': True,
            'updatedAt': now,
        }

    if event in (PLAYING, PAUSED, STOPPED, SESSION_DISCONNECTED):
        return {
            **current,
            'playing': event == PLAYING,
            'updatedAt': now,
        }

    return None


def main() -> int:
    event = os.environ.get('PLAYER_EVENT')
    if not event:
        return 0

    directory = target_dir()
    os.makedirs(directory, exist_ok=True)
    path = os.path.join(directory, FILENAME)

    current = read_current(path)
    update = build_update(event, current)
    if update is None:
        return 0

    write_atomically(path, update)
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception:  # noqa: BLE001 - must never fail loudly; see module docstring.
        sys.exit(0)
