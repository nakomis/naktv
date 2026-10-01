#!/usr/bin/env python3
"""Static file server for now-playing.json, with the headers the TV needs.

`python3 -m http.server --directory` alone is nearly enough, but the naktv app
is a webOS `file://` origin, so a browser build of it would enforce CORS on
the fetch. webOS itself doesn't seem to, but there is no reason to depend on
that staying true, so this adds `Access-Control-Allow-Origin: *`. It also
turns off caching: the whole point of the file is that it changes, and stale
now-playing data reads worse than no data at all.

It also holds the music source (NAKTV-26): `GET /music-source` answers
`{"source": "spotify"}` or `{"source": "library"}`, and `POST /music-source`
with the same JSON switches it (music-switch.py reads the file this writes).
While the library is selected, `/now-playing.json` serves the library
player's `now-playing-library.json`, so the TV's overlay needs no change.
"""

from __future__ import annotations  # phi's /usr/bin/python3 is 3.9

import json
import os
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

DEFAULT_DIR = '/tmp/naktv-www'
DEFAULT_PORT = 1985


SOURCES = ('spotify', 'library')
SOURCE_FILE = 'music-source'


def read_source(directory: str) -> str:
    try:
        with open(os.path.join(directory, SOURCE_FILE)) as f:
            s = f.read().strip()
    except OSError:
        return 'spotify'
    return s if s in SOURCES else 'spotify'


def write_source(directory: str, source: str) -> None:
    path = os.path.join(directory, SOURCE_FILE)
    with open(path + '.tmp', 'w') as f:
        f.write(source + '\n')
    os.replace(path + '.tmp', path)


class NowPlayingHandler(SimpleHTTPRequestHandler):
    def end_headers(self) -> None:
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def _json(self, code: int, body: dict) -> None:
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self) -> None:  # CORS preflight for the POST
        self.send_response(204)
        self.end_headers()

    def do_GET(self) -> None:
        path = self.path.split('?', 1)[0]
        if path == '/music-source':
            self._json(200, {'source': read_source(self.directory)})
            return
        if path == '/now-playing.json' and read_source(self.directory) == 'library':
            self.path = '/now-playing-library.json'
        super().do_GET()

    def do_POST(self) -> None:
        if self.path.split('?', 1)[0] != '/music-source':
            self._json(404, {'error': 'not found'})
            return
        try:
            length = int(self.headers.get('Content-Length') or 0)
            source = json.loads(self.rfile.read(length) or b'{}').get('source')
        except (ValueError, AttributeError):
            source = None
        if source not in SOURCES:
            self._json(400, {'error': 'source must be one of ' + ', '.join(SOURCES)})
            return
        write_source(self.directory, source)
        self._json(200, {'source': source})


def main() -> None:
    directory = os.environ.get('NOW_PLAYING_DIR', DEFAULT_DIR)
    port = int(os.environ.get('NOW_PLAYING_PORT', DEFAULT_PORT))
    os.makedirs(directory, exist_ok=True)

    def handler(*args: object, **kwargs: object) -> NowPlayingHandler:
        return NowPlayingHandler(*args, directory=directory, **kwargs)

    server = ThreadingHTTPServer(('0.0.0.0', port), handler)
    server.serve_forever()


if __name__ == '__main__':
    main()
