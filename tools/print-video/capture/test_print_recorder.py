"""Tests for print-recorder.sh and record-print.sh's resume (NAKTV-30).

    cd tools/print-video/capture && python3 -m unittest test_print_recorder -v

The real scripts run against a fake cthulhu. The capture jobs are stubs that
log how they were called, so what's tested is the recorder's bookkeeping:
which prefix each print gets, and that a restart resumes rather than starts
again.
"""
import http.server
import json
import os
import shutil
import signal
import subprocess
import tempfile
import threading
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
STATUS = {"statusLabel": "Idle", "taskId": "", "filename": ""}


class FakeCthulhu(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):  # noqa: N802
        body = json.dumps({"print": STATUS}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


STUB = """#!/usr/bin/env bash
echo "$(basename "$0") $*" >> "$CALLS"
sleep 0.2
"""


def wait_for(predicate, timeout=10.0):
    end = time.time() + timeout
    while time.time() < end:
        if predicate():
            return True
        time.sleep(0.05)
    return False


class Recorder(unittest.TestCase):
    def setUp(self):
        STATUS.update(statusLabel="Idle", taskId="", filename="")
        self.httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), FakeCthulhu)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.tmp = Path(tempfile.mkdtemp())
        self.bin = self.tmp / "bin"
        self.bin.mkdir()
        shutil.copy(HERE / "print-recorder.sh", self.bin)
        for job in ("record-print.sh", "log-status.py", "save-layers.sh", "log-status-events.py"):
            path = self.bin / job
            path.write_text(STUB)
            path.chmod(0o755)
        self.out = self.tmp / "recordings"
        self.calls = self.tmp / "calls.log"
        self.calls.touch()
        self.proc = None

    def tearDown(self):
        self.stop()
        self.httpd.shutdown()
        shutil.rmtree(self.tmp)

    def start(self):
        env = {**os.environ, "CTHULHU": f"http://127.0.0.1:{self.httpd.server_port}",
               "POLL": "0.1", "CALLS": str(self.calls)}
        self.proc = subprocess.Popen([str(self.bin / "print-recorder.sh"), str(self.out)], env=env,
                                     stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)

    def stop(self):
        if self.proc and self.proc.poll() is None:
            self.proc.send_signal(signal.SIGTERM)
            self.proc.wait(timeout=10)
        self.output = self.proc.stdout.read() if self.proc else ""
        self.proc = None

    def prefixes(self):
        return sorted(p.with_suffix("").name for p in self.out.glob("*.task"))

    def record_calls(self):
        return [line for line in self.calls.read_text().splitlines() if line.startswith("record-print.sh")]

    def test_does_nothing_while_idle(self):
        self.start()
        time.sleep(0.6)
        self.stop()
        self.assertEqual(self.prefixes(), [])
        self.assertEqual(self.calls.read_text(), "")

    def test_a_print_gets_a_prefix_its_task_and_all_four_jobs(self):
        STATUS.update(statusLabel="Exposing", taskId="task-a", filename="3cats.goo")
        self.start()
        self.assertTrue(wait_for(lambda: len(self.calls.read_text().splitlines()) >= 3))
        self.stop()
        [prefix] = self.prefixes()
        self.assertTrue(prefix.endswith("-3cats"), prefix)
        self.assertEqual((self.out / f"{prefix}.task").read_text().strip(), "task-a")
        jobs = {line.split()[0] for line in self.calls.read_text().splitlines()}
        self.assertTrue({"record-print.sh", "log-status.py", "save-layers.sh"} <= jobs, jobs)

    def test_a_restart_mid_print_resumes_the_same_capture(self):
        STATUS.update(statusLabel="Exposing", taskId="task-a", filename="3cats.goo")
        self.start()
        self.assertTrue(wait_for(lambda: self.record_calls()))
        self.stop()
        first = self.prefixes()

        self.start()
        calls_before = len(self.record_calls())
        self.assertTrue(wait_for(lambda: len(self.record_calls()) > calls_before))
        self.stop()
        self.assertEqual(self.prefixes(), first)  # no second capture for the same task
        self.assertIn("resuming", self.output)
        self.assertEqual(len({line.split()[1] for line in self.record_calls()}), 1)

    def test_the_next_print_gets_its_own_capture(self):
        STATUS.update(statusLabel="Exposing", taskId="task-a", filename="first.goo")
        self.start()
        self.assertTrue(wait_for(lambda: self.record_calls()))
        STATUS.update(statusLabel="Complete")
        time.sleep(0.4)
        STATUS.update(statusLabel="Lifting", taskId="task-b", filename="second.goo")
        self.assertTrue(wait_for(lambda: len(self.prefixes()) == 2))
        self.stop()
        names = self.prefixes()
        self.assertTrue(names[0].endswith("-first") and names[1].endswith("-second"), names)


class RecordPrintResume(unittest.TestCase):
    """record-print.sh must carry on the part numbering, never overwrite part01."""

    def test_continues_from_the_parts_already_recorded(self):
        STATUS.update(statusLabel="Exposing", taskId="t", filename="x.goo")
        httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), FakeCthulhu)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        tmp = Path(tempfile.mkdtemp())
        try:
            fake_bin = tmp / "fakebin"
            fake_bin.mkdir()
            (fake_bin / "ffmpeg").write_text("#!/usr/bin/env bash\nexec sleep 30\n")
            (fake_bin / "ffmpeg").chmod(0o755)
            prefix = tmp / "2026-10-02-1200-x"
            Path(f"{prefix}-parts.jsonl").write_text(json.dumps({"part": 1, "file": "x-part01.mkv", "t": 1}) + "\n")
            env = {**os.environ, "PATH": f"{fake_bin}:{os.environ['PATH']}",
                   "CTHULHU": f"http://127.0.0.1:{httpd.server_port}"}
            proc = subprocess.Popen([str(HERE / "record-print.sh"), str(prefix)], env=env)
            try:
                self.assertTrue(wait_for(lambda: len(Path(f"{prefix}-parts.jsonl").read_text().splitlines()) == 2))
            finally:
                proc.send_signal(signal.SIGTERM)
                proc.wait(timeout=10)
            last = json.loads(Path(f"{prefix}-parts.jsonl").read_text().splitlines()[-1])
            self.assertEqual(last["part"], 2)
            self.assertTrue(last["file"].endswith("-part02.mkv"))
        finally:
            httpd.shutdown()
            shutil.rmtree(tmp)


if __name__ == "__main__":
    unittest.main()
