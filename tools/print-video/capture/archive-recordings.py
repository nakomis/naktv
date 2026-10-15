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

The layer images (PREFIX-layers/, thousands of small files, which Luke and
Leia handle badly) are not archived when PREFIX.goo holds them all: the .goo
is checked layer by layer (structure, each layer's checksum, the end marker,
and a layer count matching the images), and if it passes the folder is
deleted with the rest instead of copied. render.py rebuilds the images from
the .goo when it needs them. A capture without a sound .goo keeps its folder.

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
# Where the layer table's offset and count sit in a .goo header: after the
# fixed settings and two RGB565 thumbnails (116x116 and 290x290).
GOO_SETTINGS = 194 + 116 * 116 * 2 + 2 + 290 * 290 * 2 + 2
GOO_LAYER_DEF = 66
GOO_END = bytes([0, 0, 0, 7, 0, 0, 0, 0x44, 0x4C, 0x50, 0])
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


def goo_layers(path: Path) -> Optional[int]:
    """The number of layers in a .goo if every one is intact, else None.

    Walks the layer table as goo/goopng.c does: each layer's encoded image
    must start with 0x55 and end with its checksum (the inverted low byte of
    the sum of the bytes between), and the end marker must follow the last
    layer and finish the file.
    """
    try:
        size = path.stat().st_size
        with open(path, "rb") as f:
            f.seek(GOO_SETTINGS)
            head = f.read(164)
            if len(head) < 164:
                return None
            count = int.from_bytes(head[0:4], "big")
            off = int.from_bytes(head[160:164], "big")
            for _ in range(count):
                f.seek(off + GOO_LAYER_DEF)
                n = int.from_bytes(f.read(4), "big")
                data = f.read(n)
                if n < 2 or len(data) != n or data[0] != 0x55 or (~sum(data[1:-1])) & 0xFF != data[-1]:
                    return None
                off += GOO_LAYER_DEF + 4 + n + 2
            f.seek(off)
            if f.read(len(GOO_END)) != GOO_END or off + len(GOO_END) != size:
                return None
    except OSError:
        return None
    return count


def droppable_layers(name: str, paths: List[Path]) -> Optional[Path]:
    """The capture's layer-image folder, if its .goo holds every image in it."""
    folder = next((p for p in paths if p.name == f"{name}-layers" and p.is_dir()), None)
    goo = next((p for p in paths if p.name == f"{name}.goo"), None)
    if folder is None or goo is None:
        return None
    images = len(list(folder.glob("*.png")))
    layers = goo_layers(goo)
    return folder if layers and images <= layers else None


def rsync(args: List[str]) -> subprocess.CompletedProcess:
    return subprocess.run(["rsync", *args], capture_output=True, text=True)


def archive_one(name: str, paths: List[Path], archive: Path, dry_run: bool) -> bool:
    """Copy, verify, delete. True if the capture was archived and removed."""
    dest = archive / name
    drop = droppable_layers(name, paths)
    keep = [p for p in paths if p != drop]
    # -rt, not -a: a CIFS share can't take Rey's owners and modes, and
    # trying makes every run report changes.
    copy_args = ["-rt", "--partial", "--no-perms", "--no-owner", "--no-group"]
    if drop is not None:
        log(f"  layer images left out: {name}.goo holds all {goo_layers(paths[0].parent / (name + '.goo'))} layers")
    if dry_run:
        log(f"  would copy {len(keep)} items to {dest}")
        return False
    dest.mkdir(parents=True, exist_ok=True)
    for p in sorted(keep):
        target = dest / p.name
        r = rsync([*copy_args, str(p) + ("/" if p.is_dir() else ""), str(target) + ("/" if p.is_dir() else "")])
        if r.returncode:
            log(f"  copy failed for {p.name}: {r.stderr.strip()[-300:]}")
            return False
    # Verify every file, both sides read in full. Any difference, or any
    # file missing from the copy, and nothing is deleted.
    for src, copy in _pairs(keep, dest):
        if not copy.is_file() or sha256(src) != sha256(copy):
            log(f"  verify FAILED for {copy.relative_to(dest)}; keeping the original")
            return False
    (dest / ".archived").write_text(json.dumps({
        "archived_at": time.time(), "items": [p.name for p in keep], "bytes": sum(_size(p) for p in keep),
        # Rebuild with render.py, or goo/goopng.c goo2png.
        "layer_images_from_goo": drop.name if drop is not None else None}) + "\n")
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
