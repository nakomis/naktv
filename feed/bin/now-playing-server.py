#!/usr/bin/env python3
"""Static file server for now-playing.json, with the headers the TV needs.

`python3 -m http.server --directory` alone is nearly enough, but the naktv app
is a webOS `file://` origin, so a browser build of it would enforce CORS on
the fetch. webOS itself doesn't seem to, but there is no reason to depend on
that staying true, so this adds `Access-Control-Allow-Origin: *`. It also
turns off caching: the whole point of the file is that it changes, and stale
now-playing data reads worse than no data at all.
"""

from __future__ import annotations  # phi's /usr/bin/python3 is 3.9

import os
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

DEFAULT_DIR = '/tmp/naktv-www'
DEFAULT_PORT = 1985


class NowPlayingHandler(SimpleHTTPRequestHandler):
    def end_headers(self) -> None:
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


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
