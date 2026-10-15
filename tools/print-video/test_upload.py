"""Tests for upload.py (NAKTV-20). Run: python3 -m unittest test_upload -v

The resumable upload is tested against a local fake of Google's protocol,
including a server failure mid-upload, so the byte bookkeeping is checked for
real rather than against mocks.
"""
import http.server
import json
import tempfile
import threading
import unittest
from pathlib import Path

import upload

CHUNK = 256 * 1024


class FakeYouTube(http.server.BaseHTTPRequestHandler):
    """Just enough of the resumable protocol: a session, 308s, status queries."""

    received = bytearray()
    size = 0
    fail_once_at = None  # chunk offset to answer 503 for, once
    requests = []

    def log_message(self, *args):
        pass

    def _reply(self, status, headers=None, body=b""):
        self.send_response(status)
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):  # noqa: N802 - start a session
        length = int(self.headers.get("Content-Length", 0))
        meta = json.loads(self.rfile.read(length))
        cls = type(self)
        cls.size = int(self.headers["X-Upload-Content-Length"])
        cls.meta = meta
        cls.requests.append(("POST", self.path))
        self._reply(200, {"Location": f"http://127.0.0.1:{self.server.server_port}/session/1"})

    def do_PUT(self):  # noqa: N802
        cls = type(self)
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)
        rng = self.headers["Content-Range"]
        cls.requests.append(("PUT", rng))
        done = {"id": "abc123", "status": {"privacyStatus": "private"}}
        if rng.startswith("bytes */"):  # status query
            if len(cls.received) == cls.size:
                return self._reply(200, body=json.dumps(done).encode())
            headers = {"Range": f"bytes=0-{len(cls.received) - 1}"} if cls.received else {}
            return self._reply(308, headers)
        start = int(rng.split(" ")[1].split("-")[0])
        if cls.fail_once_at == start:
            cls.fail_once_at = None
            # Keep half the chunk, as a real server might, then fail.
            cls.received += body[: len(body) // 2]
            return self._reply(503)
        if start != len(cls.received):
            return self._reply(400, body=b"offset mismatch")
        cls.received += body
        if len(cls.received) == cls.size:
            return self._reply(200, body=json.dumps(done).encode())
        return self._reply(308, {"Range": f"bytes=0-{len(cls.received) - 1}"})


class ResumableUpload(unittest.TestCase):
    def setUp(self):
        FakeYouTube.received = bytearray()
        FakeYouTube.fail_once_at = None
        FakeYouTube.requests = []
        self.httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), FakeYouTube)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.httpd.server_port}"
        self.dir = tempfile.TemporaryDirectory()
        self.video = Path(self.dir.name, "v.mp4")
        # Not a multiple of the chunk, so the last chunk is short.
        self.data = bytes((i * 7) % 256 for i in range(CHUNK * 3 + 12345))
        self.video.write_bytes(self.data)

    def tearDown(self):
        self.httpd.shutdown()
        self.dir.cleanup()

    def run_upload(self):
        session = upload.start_session("t", {"snippet": {"title": "x"}}, len(self.data), upload_api=self.base)
        return upload.send(self.video, session, lambda: "t", chunk=CHUNK, sleep=lambda s: None, progress=False)

    def test_sends_every_byte_in_order(self):
        result = self.run_upload()
        self.assertEqual(result["id"], "abc123")
        self.assertEqual(bytes(FakeYouTube.received), self.data)

    def test_resumes_from_where_the_server_got_to_after_a_failure(self):
        FakeYouTube.fail_once_at = CHUNK  # the second chunk half-lands, then 503
        result = self.run_upload()
        self.assertEqual(result["id"], "abc123")
        self.assertEqual(bytes(FakeYouTube.received), self.data)
        # It asked where to carry on from rather than assuming.
        self.assertIn(("PUT", f"bytes */{len(self.data)}"), FakeYouTube.requests)

    def test_a_session_already_complete_just_returns_the_result(self):
        self.run_upload()
        session = f"{self.base}/session/1"
        result = upload.send(self.video, session, lambda: "t", chunk=CHUNK, sleep=lambda s: None, progress=False)
        self.assertEqual(result["id"], "abc123")


class Helpers(unittest.TestCase):
    def test_next_offset(self):
        self.assertEqual(upload.next_offset("bytes=0-262143"), 262144)
        self.assertEqual(upload.next_offset(None), 0)

    def test_angle_brackets_and_long_titles_are_refused(self):
        with self.assertRaises(SystemExit):
            upload.check_text("a <b>", "")
        with self.assertRaises(SystemExit):
            upload.check_text("x" * 101, "")
        with self.assertRaises(SystemExit):
            upload.check_text("ok", "d" * 5001)
        upload.check_text("7½ Hours of a Resin Printer | Ambient", "fine")

    def test_sidecars_finds_render_outputs_in_order(self):
        with tempfile.TemporaryDirectory() as d:
            v = Path(d, "render.mp4")
            for name in ("render.description.txt", "render.comment10.txt", "render.comment2.txt",
                         "render.comment1.txt", "other.comment1.txt"):
                Path(d, name).write_text(name)
            desc, comments = upload.sidecars(v)
            self.assertEqual(desc.name, "render.description.txt")
            self.assertEqual([c.name for c in comments],
                             ["render.comment1.txt", "render.comment2.txt", "render.comment10.txt"])

    def test_metadata_is_not_made_for_kids(self):
        meta = upload.metadata("t", "d", ["resin"], "28", "private")
        self.assertIs(meta["status"]["selfDeclaredMadeForKids"], False)
        self.assertEqual(meta["snippet"]["categoryId"], "28")


if __name__ == "__main__":
    unittest.main()
