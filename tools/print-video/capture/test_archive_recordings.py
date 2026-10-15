"""Tests for archive-recordings.py (NAKTV-33).

    cd tools/print-video/capture && python3 -m unittest test_archive_recordings -v

Real files and real rsync in temp folders, against a fake cthulhu. What's
tested is the part that can lose data: what counts as one capture, what's
left alone, and that nothing is deleted unless its copy verified.
"""
import http.server
import importlib.util
import json
import os
import shutil
import tempfile
import threading
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("archive_recordings", HERE / "archive-recordings.py")
ar = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ar)

STATUS = {"statusLabel": "Idle", "taskId": ""}


class FakeCthulhu(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):  # noqa: N802
        body = json.dumps({"print": STATUS}).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def make_capture(rec: Path, name: str, task: str = None, age_s: float = 3600):
    files = [f"{name}.log", f"{name}.goo", f"{name}-parts.jsonl", f"{name}-status.jsonl", f"{name}-part01.mkv"]
    for f in files:
        (rec / f).write_bytes(os.urandom(2048))
    layers = rec / f"{name}-layers"
    layers.mkdir()
    for i in range(3):
        (layers / f"{i:04d}.png").write_bytes(os.urandom(512))
    (layers / ".complete").write_text("3 layers, 0 missing\n")
    if task:
        (rec / f"{name}.task").write_text(task + "\n")
    old = time.time() - age_s
    for p in [*rec.glob(name + "*"), *layers.iterdir()]:
        os.utime(p, (old, old))


class Archiver(unittest.TestCase):
    def setUp(self):
        STATUS.update(statusLabel="Idle", taskId="")
        self.httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), FakeCthulhu)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.tmp = Path(tempfile.mkdtemp())
        self.rec = self.tmp / "resin-recordings"
        self.rec.mkdir()
        self.share = self.tmp / "share"
        self.share.mkdir()
        (self.share / ".print-recordings").write_text("marker\n")
        self.archive = self.share / "resin"
        os.environ.update(RECORDINGS=str(self.rec), ARCHIVE=str(self.archive),
                          CTHULHU=f"http://127.0.0.1:{self.httpd.server_port}", QUIET_MINUTES="30")

    def tearDown(self):
        self.httpd.shutdown()
        shutil.rmtree(self.tmp)

    def test_refuses_without_the_share_marker(self):
        (self.share / ".print-recordings").unlink()
        make_capture(self.rec, "2026-10-01-1200-cat")
        self.assertEqual(ar.main([]), 2)
        self.assertTrue((self.rec / "2026-10-01-1200-cat.goo").exists())

    def test_archives_verifies_and_removes_a_finished_capture(self):
        make_capture(self.rec, "2026-10-01-1200-cat")
        originals = {p.name: p.read_bytes() for p in self.rec.glob("*") if p.is_file()}
        self.assertEqual(ar.main([]), 0)
        self.assertEqual(list(self.rec.iterdir()), [])
        dest = self.archive / "2026-10-01-1200-cat"
        for name, data in originals.items():
            self.assertEqual((dest / name).read_bytes(), data)
        self.assertEqual(len(list((dest / "2026-10-01-1200-cat-layers").glob("*.png"))), 3)
        self.assertTrue((dest / ".archived").exists())

    def test_overlapping_names_are_separate_captures(self):
        make_capture(self.rec, "2026-10-14-2015-bird-2holes")
        make_capture(self.rec, "2026-10-14-2015-bird-2holes-2.4s")
        groups = ar.captures(self.rec)
        short = {p.name for p in groups["2026-10-14-2015-bird-2holes"]}
        self.assertNotIn("2026-10-14-2015-bird-2holes-2.4s.goo", short)
        self.assertIn("2026-10-14-2015-bird-2holes.goo", short)

    def test_leaves_the_print_in_progress_alone(self):
        make_capture(self.rec, "2026-10-01-1200-done", task="t-old")
        make_capture(self.rec, "2026-10-02-0900-live", task="t-live")
        STATUS.update(statusLabel="Exposing", taskId="t-live")
        self.assertEqual(ar.main([]), 0)
        self.assertTrue((self.rec / "2026-10-02-0900-live.goo").exists())
        self.assertFalse((self.rec / "2026-10-01-1200-done.goo").exists())

    def test_without_task_files_the_newest_is_assumed_live(self):
        make_capture(self.rec, "2026-09-29-0040-older")
        make_capture(self.rec, "2026-09-30-1510-newest")
        STATUS.update(statusLabel="Exposing", taskId="whatever")
        ar.main([])
        self.assertTrue((self.rec / "2026-09-30-1510-newest.goo").exists())
        self.assertFalse((self.rec / "2026-09-29-0040-older.goo").exists())

    def test_cthulhu_unreachable_means_touch_nothing(self):
        make_capture(self.rec, "2026-10-01-1200-cat")
        os.environ["CTHULHU"] = "http://127.0.0.1:9"
        ar.main([])
        self.assertTrue((self.rec / "2026-10-01-1200-cat.goo").exists())

    def test_skips_a_capture_changed_recently(self):
        make_capture(self.rec, "2026-10-01-1200-cat", age_s=60)
        ar.main([])
        self.assertTrue((self.rec / "2026-10-01-1200-cat.goo").exists())

    def test_a_failed_verify_keeps_the_original(self):
        make_capture(self.rec, "2026-10-01-1200-cat")
        real = ar.rsync

        def corrupting_rsync(args):
            r = real(args)
            # Damage one copied layer, as a bad network write might.
            for f in self.archive.rglob("0001.png"):
                f.write_bytes(b"corrupt")
            return r

        ar.rsync = corrupting_rsync
        try:
            self.assertEqual(ar.main([]), 1)
        finally:
            ar.rsync = real
        self.assertTrue((self.rec / "2026-10-01-1200-cat.goo").exists())
        self.assertTrue((self.rec / "2026-10-01-1200-cat-layers" / "0001.png").exists())
        self.assertFalse((self.archive / "2026-10-01-1200-cat" / ".archived").exists())

    def test_dry_run_changes_nothing(self):
        make_capture(self.rec, "2026-10-01-1200-cat")
        ar.main(["--dry-run"])
        self.assertTrue((self.rec / "2026-10-01-1200-cat.goo").exists())
        self.assertFalse((self.archive / "2026-10-01-1200-cat").exists())


if __name__ == "__main__":
    unittest.main()
