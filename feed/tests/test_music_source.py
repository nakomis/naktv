"""Tests for the music source feature (NAKTV-26). Run from feed/: python3 -m unittest -v"""
import http.client
import importlib.util
import json
import os
import random
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from collections import deque
from pathlib import Path

BIN = Path(__file__).resolve().parent.parent / "bin"


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace("-", "_"), BIN / f"{name}.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


player = load("library-player")
switch = load("music-switch")
server = load("now-playing-server")


class LibraryPlayer(unittest.TestCase):
    def test_only_tracks_whose_files_exist_are_played(self):
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "a.mp3").write_bytes(b"x")
            (Path(d) / "tracks.json").write_text(json.dumps([{"file": "a.mp3"}, {"file": "gone.mp3"}]))
            self.assertEqual([t["file"] for t in player.load_tracks(Path(d))], ["a.mp3"])

    def test_an_unreadable_manifest_means_no_tracks(self):
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "tracks.json").write_text("")
            self.assertEqual(player.load_tracks(Path(d)), [])

    def test_recently_played_tracks_are_avoided_while_there_is_a_choice(self):
        tracks = [{"file": "a"}, {"file": "b"}]
        rng = random.Random(1)
        self.assertTrue(all(player.pick(tracks, deque(["a"]), rng)["file"] == "b" for _ in range(20)))
        self.assertIn(player.pick(tracks, deque(["a", "b"]), rng)["file"], {"a", "b"})

    def test_now_playing_matches_spotifys_shape_plus_the_licence(self):
        doc = player.now_playing_doc({"title": "Clouds", "album": "Lo-fi", "artist": "HoliznaCC0",
                                      "source_url": "https://fma/clouds", "licence": "CC0 1.0"})
        self.assertEqual((doc["track"], doc["artists"], doc["uri"], doc["playing"]),
                         ("Clouds", ["HoliznaCC0"], "https://fma/clouds", True))
        self.assertEqual(doc["licence"], "CC0 1.0")


class Source(unittest.TestCase):
    def test_unknown_or_missing_selection_means_spotify(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(switch.read_source(os.path.join(d, "none")), "spotify")
            Path(d, "s").write_text("jukebox\n")
            self.assertEqual(switch.read_source(os.path.join(d, "s")), "spotify")
            Path(d, "s").write_text("library\n")
            self.assertEqual(switch.read_source(os.path.join(d, "s")), "library")


class Api(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        Path(self.dir.name, "now-playing.json").write_text('{"track": "Spotify tune"}')
        Path(self.dir.name, "now-playing-library.json").write_text('{"track": "Library tune"}')
        handler = lambda *a, **k: server.NowPlayingHandler(*a, directory=self.dir.name, **k)  # noqa: E731
        self.httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.port = self.httpd.server_address[1]

    def tearDown(self):
        self.httpd.shutdown()
        self.dir.cleanup()

    def request(self, method, path, body=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        c.request(method, path, body=json.dumps(body) if body is not None else None,
                  headers={"Content-Type": "application/json"} if body is not None else {})
        r = c.getresponse()
        data = r.read()
        return r.status, dict(r.getheaders()), (json.loads(data) if data else None)

    def test_defaults_to_spotify_and_serves_its_now_playing(self):
        self.assertEqual(self.request("GET", "/music-source")[2], {"source": "spotify"})
        self.assertEqual(self.request("GET", "/now-playing.json")[2], {"track": "Spotify tune"})

    def test_switching_to_the_library_changes_what_now_playing_serves(self):
        status, headers, body = self.request("POST", "/music-source", {"source": "library"})
        self.assertEqual((status, body), (200, {"source": "library"}))
        self.assertEqual(headers.get("Access-Control-Allow-Origin"), "*")
        self.assertEqual(self.request("GET", "/music-source")[2], {"source": "library"})
        self.assertEqual(self.request("GET", "/now-playing.json?t=1")[2], {"track": "Library tune"})
        self.assertEqual(Path(self.dir.name, "music-source").read_text().strip(), "library")

    def test_an_unknown_source_is_refused(self):
        self.assertEqual(self.request("POST", "/music-source", {"source": "radio"})[0], 400)
        self.assertEqual(self.request("GET", "/music-source")[2], {"source": "spotify"})

    def test_answers_the_cors_preflight(self):
        status, headers, _ = self.request("OPTIONS", "/music-source")
        self.assertEqual(status, 204)
        self.assertIn("POST", headers.get("Access-Control-Allow-Methods", ""))


class Switch(unittest.TestCase):
    """The real switch process, with real named pipes."""

    def test_forwards_only_the_selected_source(self):
        with tempfile.TemporaryDirectory() as d:
            fifo = {n: os.path.join(d, f"{n}.pcm") for n in ("spotify", "library", "music")}
            for p in fifo.values():
                os.mkfifo(p)
            source = os.path.join(d, "music-source")
            Path(source).write_text("spotify\n")
            env = {**os.environ, "SPOTIFY_FIFO": fifo["spotify"], "LIBRARY_FIFO": fifo["library"],
                   "MUSIC_FIFO": fifo["music"], "SOURCE_FILE": source}
            proc = subprocess.Popen([sys.executable, str(BIN / "music-switch.py")], env=env)
            try:
                out = os.open(fifo["music"], os.O_RDONLY | os.O_NONBLOCK)
                ins = {n: os.open(fifo[n], os.O_WRONLY) for n in ("spotify", "library")}

                def feed_and_collect():
                    got = b""
                    for _ in range(10):
                        os.write(ins["spotify"], b"S" * 400)
                        os.write(ins["library"], b"L" * 400)
                        time.sleep(0.05)
                        try:
                            got += os.read(out, 65536)
                        except BlockingIOError:
                            pass
                    return got

                first = feed_and_collect()
                self.assertTrue(first and set(first) == {ord("S")}, first[:20])
                Path(source).write_text("library\n")
                time.sleep(0.7)  # the switch re-reads the selection every half second
                feed_and_collect()  # let anything in flight drain
                second = feed_and_collect()
                self.assertTrue(second and set(second) == {ord("L")}, second[:20])
            finally:
                proc.kill()
                proc.wait()


if __name__ == "__main__":
    unittest.main()
