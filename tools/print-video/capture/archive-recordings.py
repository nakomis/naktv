#!/usr/bin/env python3
"""Archive finished print recordings to Luke, then delete them from Rey (NAKTV-33).

    archive-recordings.py [--dry-run]

Run by print-archive.timer on Rey. For each finished capture in RECORDINGS
(default ~/resin-recordings):

  1. copy it with rsync into ARCHIVE/<capture name>/ (default
     /mnt/print-recordings/resin, Luke's print-recordings share);
  2. verify the copy: a SHA-256 of every file, read back in full on both
     sides (in Python, not via rsync, whose dry-run output differs between
     rsync and macOS's openrsync);
  3. only if that finds no difference, delete it from Rey.

A capture is everything sharing its prefix, YYYY-MM-DD-HHMM-<print name>:
PREFIX.log, .goo, .task, -parts.jsonl, -status*.jsonl, -partNN.mkv and the
-layers/ folder. Prefixes come from the .log files, and each file goes to the
longest prefix it matches, so "...-bird-2holes" and "...-bird-2holes-2.4s"
stay apart.

It never touches:
  - the capture of the print in progress (its .task matches cthulhu's current
    task, or, for a capture made before .task files, it is the newest one);
  - any capture with a file changed in the last QUIET_MINUTES (default 30).

It refuses to run at all unless ARCHIVE/../.print-recordings exists, a
marker that lives on the share. If the CIFS mount had failed, ARCHIVE would
be an empty folder on Rey's own disk, and "archiving" there and deleting
the originals would lose them.

Stdlib only. Logs to stdout, which systemd puts in the journal.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.request
from pathlib import Path
from typing import Dict, List, Optional

PREFIX_RE = re.compile(r"^\d{4}-\d{2}-\d{2}-\d{4}-.+$")
MARKER = ".print-recordings"
IDLE = ("", "Idle", "Complete", "Stopped", "Cancelled")


def log(msg: str) -> None:
    print(msg, flush=True)


def captures(recordings: Path) -> Dict[str, List[Path]]:
    """Each capture's prefix name and the paths that belong to it."""
    prefixes = sorted((p.stem for p in recordings.glob("*.log") if PREFIX_RE.match(p.stem)),
                      key=len, reverse=True)
    groups: Dict[str, List[Path]] = {name: [] for name in prefixes}
    for path in recordings.iterdir():
        for name in prefixes:  # longest first
            rest = path.name[len(name):]
            if path.name.startswith(name) and (rest == "" or rest[0] in ".-"):
                groups[name].append(path)
                break
    return groups


def current_task(cthulhu: str) -> Optional[str]:
    """The task ID of the print in progress, None if idle, or 'unknown'."""
    try:
        with urllib.request.urlopen(f"{cthulhu}/api/status", timeout=5) as r:
            p = json.load(r).get("print") or {}
    except Exception:
        return "unknown"
    return None if (p.get("statusLabel") or "") in IDLE else (p.get("taskId") or "unknown")


def newest_mtime(paths: List[Path]) -> float:
    newest = 0.0
    for p in paths:
        if p.is_dir():
            for f in p.rglob("*"):
                newest = max(newest, f.stat().st_mtime)
        newest = max(newest, p.stat().st_mtime)
    return newest


def in_progress(name: str, paths: List[Path], task: Optional[str], newest_name: str) -> bool:
    if task is None:
        return False
    if task == "unknown":
        return True  # can't tell which capture is live, so leave them all
    task_file = next((p for p in paths if p.name == f"{name}.task"), None)
    if task_file is not None:
        return task_file.read_text().strip() == task
    return name == newest_name


def rsync(args: List[str]) -> subprocess.CompletedProcess:
    return subprocess.run(["rsync", *args], capture_output=True, text=True)


def archive_one(name: str, paths: List[Path], archive: Path, dry_run: bool) -> bool:
    """Copy, verify, delete. True if the capture was archived and removed."""
    dest = archive / name
    srcs = [str(p) + ("/" if p.is_dir() else "") for p in sorted(paths)]
    # -rt, not -a: a CIFS share can't take Rey's owners and modes, and
    # trying makes every run report changes.
    copy_args = ["-rt", "--partial", "--no-perms", "--no-owner", "--no-group"]
    if dry_run:
        log(f"  would copy {len(paths)} items to {dest}")
        return False
    dest.mkdir(parents=True, exist_ok=True)
    for p in sorted(paths):
        target = dest / p.name
        r = rsync([*copy_args, str(p) + ("/" if p.is_dir() else ""), str(target) + ("/" if p.is_dir() else "")])
        if r.returncode:
            log(f"  copy failed for {p.name}: {r.stderr.strip()[-300:]}")
            return False
    # Verify every file, both sides read in full. Any difference, or any
    # file missing from the copy, and nothing is deleted.
    for src, copy in _pairs(paths, dest):
        if not copy.is_file() or sha256(src) != sha256(copy):
            log(f"  verify FAILED for {copy.relative_to(dest)}; keeping the original")
            return False
    (dest / ".archived").write_text(json.dumps({"archived_at": time.time(), "items": [p.name for p in paths],
                                                "bytes": sum(_size(p) for p in paths)}) + "\n")
    for p in paths:
        if p.is_dir():
            shutil.rmtree(p)
        else:
            p.unlink()
    return True


def _pairs(paths: List[Path], dest: Path):
    """(original, copy) for every file in the capture, folders included."""
    for p in sorted(paths):
        if p.is_dir():
            for f in sorted(p.rglob("*")):
                if f.is_file():
                    yield f, dest / p.name / f.relative_to(p)
        else:
            yield p, dest / p.name


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def _size(p: Path) -> int:
    return sum(f.stat().st_size for f in p.rglob("*") if f.is_file()) if p.is_dir() else p.stat().st_size


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--dry-run", action="store_true", help="say what would happen, change nothing")
    args = ap.parse_args(argv)

    recordings = Path(os.environ.get("RECORDINGS", "~/resin-recordings")).expanduser()
    archive = Path(os.environ.get("ARCHIVE", "/mnt/print-recordings/resin"))
    cthulhu = os.environ.get("CTHULHU", "http://127.0.0.1:9120")
    quiet = float(os.environ.get("QUIET_MINUTES", "30")) * 60

    if not (archive.parent / MARKER).is_file():
        log(f"refusing: {archive.parent / MARKER} not found, so {archive.parent} isn't Luke's share")
        return 2
    archive.mkdir(exist_ok=True)

    groups = captures(recordings)
    task = current_task(cthulhu)
    newest_name = max(groups, default="")
    now = time.time()
    done = kept = failed = 0
    for name in sorted(groups):
        paths = groups[name]
        if in_progress(name, paths, task, newest_name):
            log(f"{name}: in progress, skipped")
            kept += 1
            continue
        if now - newest_mtime(paths) < quiet:
            log(f"{name}: changed in the last {quiet / 60:.0f} min, skipped")
            kept += 1
            continue
        log(f"{name}: archiving {sum(_size(p) for p in paths) / 1e9:.1f} GB")
        if archive_one(name, paths, archive, args.dry_run):
            log(f"{name}: archived and verified; removed from Rey")
            done += 1
        elif not args.dry_run:
            failed += 1
    log(f"done: {done} archived, {kept} skipped, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
