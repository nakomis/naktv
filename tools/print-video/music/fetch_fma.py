#!/usr/bin/env python3
"""Collect CC0 and CC BY music from Free Music Archive, licence checked per track.

    fetch_fma.py albums OUT_DIR ALBUM_URL [...] [--hours 4] [--seed N]
    fetch_fma.py crawl  OUT_DIR [--genre Ambient ...] [--search trance ...] [--max-gb 500] [--cc0-only]

`albums` picks tracks at random from the given album pages until about
--hours of music (as used for the first print video). `crawl` walks FMA's
genre listings and keeps every track it may use, for a large library.

A track is used only if its own page's `rel="license"` link is CC0 1.0 or
CC BY (any version). NonCommercial, NoDerivatives and ShareAlike licences are
refused, as is a page stating more than one licence. An album or an uploader
saying "CC0" is not taken on trust. `tracks.json` in OUT_DIR records each
track's licence, licence link and source; render.py reads it for the
on-screen ARTIST/TRACK and the YouTube credits. Every track checked is logged
to OUT_DIR/checked.jsonl, so a crawl can be stopped and resumed.

Polite by design: one request at a time, at least --interval seconds apart
(default 1), backing off on 429 and 5xx. Tags are written with ffmpeg when
it's on PATH, otherwise with mutagen (pure Python). Python 3.9+.
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
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Dict, Iterator, List, Optional, Tuple

UA = "Mozilla/5.0 (naktv fetch_fma.py; personal CC0/CC-BY library, ~1 req/s)"
FMA = "https://freemusicarchive.org"
DEFAULT_GENRES = ["Ambient", "Ambient_Electronic", "Chill-out", "Downtempo", "Drone",
                  "Lo-fi-Experimental", "Electronic"]


# ── Licences ──────────────────────────────────────────────────────────────

LICENCE_LINK = re.compile(r"<a\b[^>]*\brel=[\"']license[\"'][^>]*>", re.I)
HREF = re.compile(r"\bhref=[\"']([^\"']+)[\"']", re.I)


def licence_of(page: str, cc0_only: bool = False) -> Optional[Tuple[str, str]]:
    """(name, canonical URL) for a usable licence, or None.

    Reads only `rel="license"` links, which is how FMA (and CC's own markup)
    states a work's licence, not any Creative Commons link on the page."""
    urls = set()
    for tag in LICENCE_LINK.findall(page):
        m = HREF.search(tag)
        if m:
            urls.add(m.group(1).split("?")[0].rstrip("/").replace("http://", "https://"))
    if len(urls) != 1:
        return None  # none stated, or conflicting statements
    url = urls.pop()
    if re.search(r"creativecommons\.org/publicdomain/zero/1\.0$", url):
        return "CC0 1.0", "https://creativecommons.org/publicdomain/zero/1.0/"
    m = re.search(r"creativecommons\.org/licenses/by/(\d\.\d)$", url)
    if m and not cc0_only:
        v = m.group(1)
        return f"CC BY {v}", f"https://creativecommons.org/licenses/by/{v}/"
    return None


# ── HTTP ──────────────────────────────────────────────────────────────────


class Polite:
    """One request at a time, at least `interval` seconds apart, with backoff."""

    def __init__(self, interval: float = 1.0):
        self.interval, self.last = interval, 0.0

    def _wait(self):
        gap = self.interval - (time.monotonic() - self.last)
        if gap > 0:
            time.sleep(gap)
        self.last = time.monotonic()

    def open(self, url: str, timeout: float = 60):
        delay = 5.0
        for attempt in range(6):
            self._wait()
            try:
                return urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=timeout)
            except urllib.error.HTTPError as e:
                if e.code == 429 or e.code >= 500:
                    wait = float(e.headers.get("Retry-After") or delay)
                    print(f"  {e.code} from FMA; waiting {wait:.0f} s", file=sys.stderr)
                    time.sleep(wait)
                    delay = min(delay * 2, 300)
                    continue
                raise
            except (urllib.error.URLError, TimeoutError) as e:
                print(f"  network error ({e}); retrying in {delay:.0f} s", file=sys.stderr)
                time.sleep(delay)
                delay = min(delay * 2, 300)
        raise RuntimeError(f"giving up on {url}")

    def text(self, url: str) -> str:
        with self.open(url) as r:
            return r.read().decode("utf-8", "replace")


# ── Pages ─────────────────────────────────────────────────────────────────


def track_blobs(page: str) -> List[Dict]:
    """Track JSON embedded in a page, as FMA writes it (album and track pages
    carry the file URL; genre listings only the page URL)."""
    out, seen = [], set()
    raw = [a or b for a, b in re.findall(r"data-track-info='([^']+)'|data-track-info=\"([^\"]+)\"", page)]
    raw += re.findall(r'\{[^{}]*"fileUrl"[^{}]*\}', html.unescape(page))
    for r in raw:
        try:
            t = json.loads(html.unescape(r))
        except ValueError:
            continue
        key = t.get("id") or t.get("url")
        if key and key not in seen:
            seen.add(key)
            out.append(t)
    return out


def listing_tracks(http: Polite, url: str) -> Iterator[Dict]:
    """Every track in an FMA listing (a genre, or search results), page by
    page. Both use the same track entries and the same `page` parameter."""
    page = 1
    sep = "&" if "?" in url else "?"
    while True:
        blobs = track_blobs(http.text(f"{url}{sep}page={page}"))
        if not blobs:
            return
        yield from blobs
        page += 1


def genre_tracks(http: Polite, genre: str) -> Iterator[Dict]:
    """Every track listed under an FMA genre."""
    return listing_tracks(http, f"{FMA}/genre/{genre}/")


def search_tracks(http: Polite, term: str) -> Iterator[Dict]:
    """Every track FMA's search finds for a term. For styles FMA has no genre
    for, such as trance. It matches titles and albums too, so "Tetris Trance"
    comes along with the real thing."""
    return listing_tracks(http, f"{FMA}/search/?quicksearch={urllib.parse.quote_plus(term)}")


def clean_title(title: str) -> str:
    """FMA titles carry junk: a trailing ".mp3", or a bracketed tag list such as
    "Wetlands ( Lofi , Calm , Relaxed )". Keep the name itself."""
    title = re.sub(r"(\.mp3)+$", "", title.strip(), flags=re.I)
    title = re.sub(r"\s*\(\s*[^()]*,[^()]*\)\s*$", "", title)  # "( a , b , c )"
    title = re.sub(r"\s*\(\s*(lo-?fi|chill|calm|relax\w*|peaceful)\s*\)\s*$", "", title, flags=re.I)
    return re.sub(r"(\.mp3)+$", "", title.strip(), flags=re.I).strip()


def safe(name: str) -> str:
    return re.sub(r'[\\/:*?"<>|]+', "-", name).strip()[:120]


# ── Files and tags ────────────────────────────────────────────────────────


def tag_and_measure(path: Path, meta: Dict, ffmpeg: Optional[str]) -> float:
    """Write artist/title/album and the licence into the file; return its length."""
    comment = f"{meta['licence']} {meta['licence_url']} Source: {meta['source_url']}"
    if ffmpeg:
        tmp = path.with_suffix(".tag.mp3")
        subprocess.run([ffmpeg, "-v", "error", "-y", "-i", str(path), "-map", "0:a", "-c", "copy",
                        "-map_metadata", "0", "-id3v2_version", "3",
                        "-metadata", f"artist={meta['artist']}", "-metadata", f"title={meta['title']}",
                        "-metadata", f"album={meta['album']}", "-metadata", f"comment={comment}",
                        "-metadata", f"copyright={meta['licence']}", str(tmp)], check=True)
        tmp.replace(path)
        out = subprocess.run([str(Path(ffmpeg).with_name("ffprobe")) if "/" in ffmpeg else "ffprobe",
                              "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
                             capture_output=True, text=True, check=True).stdout
        return float(out.strip())
    from mutagen.id3 import COMM, ID3, TALB, TCOP, TIT2, TPE1, WCOP, WOAS, ID3NoHeaderError
    from mutagen.mp3 import MP3

    try:
        tags = ID3(path)
    except ID3NoHeaderError:
        tags = ID3()
    tags.setall("TPE1", [TPE1(encoding=3, text=meta["artist"])])
    tags.setall("TIT2", [TIT2(encoding=3, text=meta["title"])])
    tags.setall("TALB", [TALB(encoding=3, text=meta["album"])])
    tags.setall("TCOP", [TCOP(encoding=3, text=meta["licence"])])
    tags.setall("COMM", [COMM(encoding=3, lang="eng", desc="", text=comment)])
    tags.setall("WCOP", [WCOP(url=meta["licence_url"])])
    tags.setall("WOAS", [WOAS(url=meta["source_url"])])
    tags.save(path, v2_version=3)
    return float(MP3(path).info.length)


class Library:
    """OUT_DIR: the tracks, tracks.json, and the resumable record of checks."""

    def __init__(self, out: Path, ffmpeg: Optional[str]):
        self.out, self.ffmpeg = out, ffmpeg
        out.mkdir(parents=True, exist_ok=True)
        self.manifest_path = out / "tracks.json"
        try:
            self.manifest = json.loads(self.manifest_path.read_text()) if self.manifest_path.exists() else []
        except ValueError:
            print("tracks.json is unreadable; run 'repair' to rebuild it from the tags", file=sys.stderr)
            self.manifest = []
        self.have = {m["source_url"] for m in self.manifest}
        self.checked_path = out / "checked.jsonl"
        self.checked = set()
        if self.checked_path.exists():
            for line in self.checked_path.read_text().splitlines():
                if line.strip():
                    self.checked.add(json.loads(line)["url"])

    def save(self) -> None:
        """Write tracks.json atomically: a new file, then a rename over the old
        one. Rewriting it in place once left it empty when the crawl was
        stopped mid-write; a rename is all or nothing."""
        tmp = self.manifest_path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(self.manifest, indent=1, ensure_ascii=False) + "\n")
        tmp.replace(self.manifest_path)

    @property
    def hours(self) -> float:
        return sum(m.get("duration", 0) for m in self.manifest) / 3600

    @property
    def bytes(self) -> int:
        return sum((self.out / m["file"]).stat().st_size for m in self.manifest if (self.out / m["file"]).exists())

    def note(self, url: str, verdict: str) -> None:
        self.checked.add(url)
        with open(self.checked_path, "a") as f:
            f.write(json.dumps({"url": url, "verdict": verdict, "t": round(time.time())}) + "\n")

    def consider(self, http: Polite, listing: Dict, cc0_only: bool) -> bool:
        """Check one track's own page; download it if its licence allows."""
        url = listing["url"]
        if url in self.checked or url in self.have:
            return False
        try:
            return self._consider(http, url, cc0_only)
        except urllib.error.HTTPError as e:
            # FMA lists tracks whose page or file has gone: note it, move on.
            self.note(url, f"http {e.code}")
            return False

    def _consider(self, http: Polite, url: str, cc0_only: bool) -> bool:
        page = http.text(url)
        lic = licence_of(page, cc0_only)
        if not lic:
            self.note(url, "licence")
            return False
        blob = next((b for b in track_blobs(page) if b.get("url") == url and b.get("fileUrl")), None)
        if not blob:
            self.note(url, "no-file")
            return False
        artist, title = blob.get("artistName", "").strip(), clean_title(blob.get("title", ""))
        dest = self.out / safe(artist) / f"{safe(artist)} - {safe(title)}.mp3"
        if dest.exists():
            dest = dest.with_name(f"{dest.stem} ({blob.get('id')}).mp3")
        dest.parent.mkdir(parents=True, exist_ok=True)
        part = dest.with_suffix(".part")
        with http.open(blob["fileUrl"], timeout=300) as r, open(part, "wb") as f:
            shutil.copyfileobj(r, f)
        part.replace(dest)
        meta = {"file": str(dest.relative_to(self.out)), "artist": artist, "title": title,
                "album": blob.get("albumTitle", ""), "licence": lic[0], "licence_url": lic[1],
                "source_url": url, "download_url": blob["fileUrl"]}
        try:
            meta["duration"] = round(tag_and_measure(dest, meta, self.ffmpeg), 1)
        except Exception as e:  # a broken or non-MP3 file: keep the record, skip it
            dest.unlink(missing_ok=True)
            self.note(url, f"bad-file: {e}")
            return False
        self.manifest.append(meta)
        self.have.add(url)
        self.save()
        self.note(url, lic[0])
        return True


# ── Commands ──────────────────────────────────────────────────────────────


def cmd_albums(args, lib: Library, http: Polite) -> None:
    seed = args.seed if args.seed is not None else random.randrange(1_000_000)
    print(f"seed {seed}", file=sys.stderr)
    pool = []
    for a in args.albums:
        ts = track_blobs(http.text(a))
        print(f"{len(ts):4d} tracks  {a}", file=sys.stderr)
        pool += ts
    random.Random(seed).shuffle(pool)
    for t in pool:
        if lib.hours >= args.hours:
            break
        if lib.consider(http, t, args.cc0_only):
            print(f"  {lib.manifest[-1]['duration'] / 60:5.1f} min  {lib.manifest[-1]['file']}  "
                  f"({lib.manifest[-1]['licence']}; {lib.hours:.2f} h)", file=sys.stderr)


def read_tags(path: Path) -> Optional[Dict]:
    """A manifest entry rebuilt from a file's own tags, if they're complete."""
    from mutagen.id3 import ID3, ID3NoHeaderError
    from mutagen.mp3 import MP3

    try:
        t = ID3(path)
    except (ID3NoHeaderError, Exception):
        return None
    def text(k):
        return str(t[k].text[0]) if k in t and t[k].text else ""
    def url(k):
        return t[k].url if k in t else ""
    lic, lic_url, src = text("TCOP"), url("WCOP"), url("WOAS")
    if not (lic and lic_url and src):
        return None
    return {"artist": text("TPE1"), "title": text("TIT2"), "album": text("TALB"), "licence": lic,
            "licence_url": lic_url, "source_url": src, "download_url": "",
            "duration": round(float(MP3(path).info.length), 1)}


def cmd_repair(args, lib: Library, http: Polite) -> None:
    """Rebuild tracks.json from the files' tags, keeping any existing entries."""
    known = {m["file"] for m in lib.manifest}
    added = 0
    for f in sorted(lib.out.rglob("*.mp3")):
        rel = str(f.relative_to(lib.out))
        if rel in known:
            continue
        meta = read_tags(f)
        if meta is None:
            print(f"  no complete tags, skipped: {rel}", file=sys.stderr)
            continue
        lib.manifest.append({"file": rel, **meta})
        lib.have.add(meta["source_url"])
        added += 1
    lib.save()
    print(f"added {added} entries from tags", file=sys.stderr)


def cmd_crawl(args, lib: Library, http: Polite) -> None:
    limit = args.max_gb * 1e9
    size = lib.bytes
    # The default genres only when neither --genre nor --search was given.
    genres = args.genre if args.genre is not None else ([] if args.search else DEFAULT_GENRES)
    listings = [(g, genre_tracks(http, g)) for g in genres]
    listings += [(f'search "{s}"', search_tracks(http, s)) for s in args.search]
    for genre, tracks in listings:
        print(f"== {genre}", file=sys.stderr)
        n = kept = 0
        for t in tracks:
            n += 1
            if lib.consider(http, t, args.cc0_only):
                kept += 1
                size += (lib.out / lib.manifest[-1]["file"]).stat().st_size
                if kept % 25 == 0:
                    print(f"  {genre}: {kept} kept of {n} seen; library {len(lib.manifest)} tracks, "
                          f"{lib.hours:.1f} h, {size / 1e9:.1f} GB", file=sys.stderr)
                if size >= limit:
                    print(f"reached --max-gb {args.max_gb}", file=sys.stderr)
                    return
        print(f"  {genre}: done, {kept} kept of {n} seen", file=sys.stderr)


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("albums", help="random picks from given album pages")
    a.add_argument("out", type=Path)
    a.add_argument("albums", nargs="+")
    a.add_argument("--hours", type=float, default=4.0)
    a.add_argument("--seed", type=int)
    c = sub.add_parser("crawl", help="every usable track in the given genres")
    c.add_argument("out", type=Path)
    c.add_argument("--genre", nargs="+", help=f"default: {' '.join(DEFAULT_GENRES)}, unless --search is given")
    c.add_argument("--search", nargs="+", default=[], help="FMA search terms, for styles without a genre (e.g. trance)")
    c.add_argument("--max-gb", type=float, default=500)
    r = sub.add_parser("repair", help="rebuild tracks.json from the files' tags")
    r.add_argument("out", type=Path)
    for p in (a, c, r):
        p.add_argument("--cc0-only", action="store_true", help="refuse CC BY as well")
        p.add_argument("--interval", type=float, default=1.0, help="seconds between requests")
        p.add_argument("--ffmpeg", default=shutil.which("ffmpeg"), help="default: ffmpeg on PATH, else mutagen")
    args = ap.parse_args(argv)
    lib = Library(args.out.expanduser(), args.ffmpeg)
    http = Polite(args.interval)
    {"albums": cmd_albums, "crawl": cmd_crawl, "repair": cmd_repair}[args.cmd](args, lib, http)
    print(f"{len(lib.manifest)} tracks, {lib.hours:.2f} h in {lib.out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
