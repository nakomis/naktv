#!/usr/bin/env python3
"""Pick CC0 tracks at random from Free Music Archive albums and download them.

    fetch_fma.py OUT_DIR ALBUM_URL [ALBUM_URL ...] [--hours 4] [--seed N]

Each album page embeds its tracks as JSON (title, artist, page URL and a
direct MP3 URL). Every candidate track's own page is then checked for the
CC0 1.0 licence link, and only those that carry it are used: an album
labelled CC0 is not taken on trust. Tracks are chosen at random until about
--hours of music, downloaded as "Artist - Title.mp3" with the licence and
source written into the tags (so they survive a copy to an MP3 player), and
listed in OUT_DIR/tracks.json, which render.py reads for the on-screen
ARTIST/TRACK and the YouTube credits. Existing files are kept.

Needs ffmpeg/ffprobe (for durations and tags). Python 3.9, standard library.
"""
from __future__ import annotations

import argparse
import html
import json
import random
import re
import shutil
import subprocess
import sys
import time
import urllib.request
from pathlib import Path
from typing import Dict, List, Optional

UA = "Mozilla/5.0 (print-video fetch_fma.py; personal use)"
CC0 = "creativecommons.org/publicdomain/zero/1.0"


def get(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8", "replace")


def album_tracks(album_url: str) -> List[Dict]:
    page = html.unescape(get(album_url))
    seen, tracks = set(), []
    for m in re.finditer(r'\{[^{}]*"fileUrl"[^{}]*\}', page):
        try:
            t = json.loads(m.group(0))
        except ValueError:
            continue
        if t.get("id") in seen or not t.get("fileUrl"):
            continue
        seen.add(t["id"])
        tracks.append(t)
    return tracks


def is_cc0(track_page_url: str) -> bool:
    return CC0 in get(track_page_url)


def clean_title(title: str) -> str:
    """FMA titles carry junk: a trailing ".mp3", or a bracketed tag list such as
    "Wetlands ( Lofi , Calm , Relaxed )". Keep the name itself."""
    title = re.sub(r"(\.mp3)+$", "", title.strip(), flags=re.I)
    title = re.sub(r"\s*\(\s*[^()]*,[^()]*\)\s*$", "", title)  # "( a , b , c )"
    title = re.sub(r"\s*\(\s*(lo-?fi|chill|calm|relax\w*|peaceful)\s*\)\s*$", "", title, flags=re.I)
    return re.sub(r"(\.mp3)+$", "", title.strip(), flags=re.I).strip()


def safe(name: str) -> str:
    return re.sub(r'[\\/:*?"<>|]+', "-", name).strip()


def ffprobe_for(ffmpeg: str) -> str:
    return str(Path(ffmpeg).with_name("ffprobe")) if "/" in ffmpeg else "ffprobe"


def duration(path: Path, ffprobe: str) -> float:
    out = subprocess.run([ffprobe, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0",
                          str(path)], capture_output=True, text=True, check=True).stdout
    return float(out.strip())


def download(t: Dict, out_dir: Path, ffmpeg: str) -> Path:
    artist, title = t["artistName"].strip(), clean_title(t["title"])
    dest = out_dir / f"{safe(artist)} - {safe(title)}.mp3"
    if dest.exists():
        return dest
    raw = dest.with_suffix(".download")
    req = urllib.request.Request(t["fileUrl"], headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=120) as r, open(raw, "wb") as f:
        shutil.copyfileobj(r, f)
    # Rewrite the tags (no re-encode) so the licence travels with the file.
    subprocess.run([ffmpeg, "-v", "error", "-y", "-i", str(raw), "-map", "0:a", "-c", "copy",
                    "-map_metadata", "0", "-id3v2_version", "3",
                    "-metadata", f"artist={artist}", "-metadata", f"title={title}",
                    "-metadata", f"album={t.get('albumTitle', '')}",
                    "-metadata", f"comment=CC0 1.0 Universal. {t['url']}",
                    "-metadata", f"copyright=CC0 1.0 Universal (public domain dedication)",
                    str(dest)], check=True)
    raw.unlink()
    return dest


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("out", type=Path)
    ap.add_argument("albums", nargs="+")
    ap.add_argument("--hours", type=float, default=4.0)
    ap.add_argument("--seed", type=int, default=None, help="for a reproducible pick; printed if not given")
    ap.add_argument("--ffmpeg", default="ffmpeg")
    args = ap.parse_args(argv)

    seed = args.seed if args.seed is not None else random.randrange(1_000_000)
    print(f"seed {seed}", file=sys.stderr)
    rng = random.Random(seed)
    out = args.out.expanduser()
    out.mkdir(parents=True, exist_ok=True)
    ffprobe = ffprobe_for(args.ffmpeg)

    pool = []
    for a in args.albums:
        ts = album_tracks(a)
        print(f"{len(ts):3d} tracks  {a}", file=sys.stderr)
        pool += ts
    rng.shuffle(pool)

    manifest_path = out / "tracks.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else []
    have = {m["file"] for m in manifest}
    total = sum(m.get("duration", 0) for m in manifest)
    for t in pool:
        if total >= args.hours * 3600:
            break
        if not is_cc0(t["url"]):
            print(f"  skip (no CC0 on its page): {t['artistName']} - {t['title']}", file=sys.stderr)
            continue
        path = download(t, out, args.ffmpeg)
        if path.name in have:
            continue
        secs = duration(path, ffprobe)
        manifest.append({
            "file": path.name, "artist": t["artistName"].strip(), "title": clean_title(t["title"]),
            "album": t.get("albumTitle", ""), "licence": "CC0 1.0",
            "source_url": t["url"], "download_url": t["fileUrl"], "duration": round(secs, 1),
        })
        have.add(path.name)
        total += secs
        print(f"  {secs / 60:5.1f} min  {path.name}   (total {total / 3600:.2f} h)", file=sys.stderr)
        manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
        time.sleep(1)  # be polite to FMA
    print(f"{len(manifest)} tracks, {total / 3600:.2f} h in {out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
