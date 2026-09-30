#!/usr/bin/env python3
"""Upload a print video to YouTube through the Data API v3 (NAKTV-20).

    upload.py import-client ~/Downloads/client_secret_....json   # once (or - for stdin)
    upload.py auth                                               # once, in a browser
    upload.py whoami
    upload.py upload render.mp4 --title "..." [--thumbnail auto] [--playlist ID]
    upload.py comments VIDEO_ID render.mp4                       # once it's public

The description is render.py's `<video>.description.txt`; the per-track credits
are its `<video>.comment1.txt`, `comment2.txt` ... and go up with `comments`.

Credentials live in the login Keychain, never in a file: the OAuth client
(service `naktv-youtube`, account `client`) and the refresh token (account
`refresh-token`). `auth` runs Google's installed-app flow with PKCE against a
loopback redirect on --port; to sign in from another machine's browser, tunnel
that port first (`ssh -L 8765:127.0.0.1:8765 phi`).

Uploads are resumable. The session URL is kept beside the video in
`<video>.upload-session.json`, so an upload cut off by a dropped connection,
or by Ctrl-C, carries on from where it stopped when run again (Google keeps a
session for about a week). It is deleted once the upload completes.

Until the Cloud project passes YouTube's API compliance audit, anything this
uploads is locked to Private, whatever --privacy says. Comments can't go on a
private video, which is why they are a separate step. Pinning one is manual:
the API can't.

Stdlib only, and 3.9-compatible: phi's /usr/bin/python3 is 3.9.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import http.client
import http.server
import json
import os
import secrets
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from pathlib import Path
from typing import Callable, Dict, List, Optional, Tuple

KEYCHAIN_SERVICE = "naktv-youtube"
SCOPES = [
    "https://www.googleapis.com/auth/youtube.upload",
    # Thumbnails, playlists and comments. force-ssl is the `youtube` scope's
    # superset, and the one commentThreads.insert demands.
    "https://www.googleapis.com/auth/youtube.force-ssl",
]
API = "https://www.googleapis.com/youtube/v3"
UPLOAD_API = "https://www.googleapis.com/upload/youtube/v3"
CHUNK = 32 * 1024 * 1024  # a multiple of 256 KiB, as the protocol requires
MAX_RETRIES = 8
TITLE_LIMIT = 100
DESCRIPTION_LIMIT = 5000


class UploadError(Exception):
    pass


# -- Keychain ------------------------------------------------------------------

def keychain_get(account: str) -> Optional[str]:
    proc = subprocess.run(
        ["security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"],
        capture_output=True, text=True)
    return proc.stdout.strip() if proc.returncode == 0 else None


def keychain_set(account: str, value: str) -> None:
    # -U updates an existing item. The value is briefly visible in `ps` to this
    # user; phi is single-user, and the alternative (a tty prompt) can't be
    # scripted.
    proc = subprocess.run(
        ["security", "add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", account, "-w", value],
        capture_output=True, text=True)
    if proc.returncode:
        # Never re-raise with the command: it carries the secret.
        hint = (" The Keychain is locked to this session (over ssh, run `security unlock-keychain` first)."
                if proc.returncode == 36 else "")
        raise SystemExit(f"Couldn't store {account} in the Keychain (security exit {proc.returncode}).{hint}")


def load_client() -> Dict:
    raw = keychain_get("client")
    if not raw:
        raise SystemExit("No OAuth client in the Keychain: run `upload.py import-client FILE` first.")
    return json.loads(raw)["installed"]


# -- OAuth ---------------------------------------------------------------------

def post_form(url: str, fields: Dict[str, str]) -> Dict:
    data = urllib.parse.urlencode(fields).encode()
    try:
        with urllib.request.urlopen(urllib.request.Request(url, data=data), timeout=30) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        raise UploadError(f"{url}: HTTP {e.code}: {e.read().decode(errors='replace')[:500]}") from None


def pkce_pair() -> Tuple[str, str]:
    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    return verifier, challenge


def auth(port: int, open_browser: bool) -> None:
    client = load_client()
    redirect = f"http://127.0.0.1:{port}"
    verifier, challenge = pkce_pair()
    state = secrets.token_urlsafe(16)
    url = client["auth_uri"] + "?" + urllib.parse.urlencode({
        "client_id": client["client_id"], "redirect_uri": redirect, "response_type": "code",
        "scope": " ".join(SCOPES), "access_type": "offline",
        # consent every time, or a second sign-in returns no refresh token
        "prompt": "consent", "state": state,
        "code_challenge": challenge, "code_challenge_method": "S256",
    })
    got: Dict[str, str] = {}

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            query = dict(urllib.parse.parse_qsl(urllib.parse.urlparse(self.path).query))
            if "code" not in query and "error" not in query:
                self.send_response(404)
                self.end_headers()
                return
            got.update(query)
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.end_headers()
            self.wfile.write(b"Signed in. You can close this tab.\n" if "code" in query
                             else f"Sign-in failed: {query.get('error')}\n".encode())

        def log_message(self, *args):
            pass

    server = http.server.HTTPServer(("127.0.0.1", port), Handler)
    print(f"Open this in a browser that can reach 127.0.0.1:{port}:\n\n{url}\n", file=sys.stderr)
    if open_browser:
        webbrowser.open(url)
    while not got:
        server.handle_request()
    server.server_close()
    if got.get("state") != state:
        raise SystemExit("State mismatch: ignoring that response.")
    if "error" in got:
        raise SystemExit(f"Sign-in failed: {got['error']}")
    tokens = post_form(client["token_uri"], {
        "code": got["code"], "client_id": client["client_id"], "client_secret": client["client_secret"],
        "redirect_uri": redirect, "grant_type": "authorization_code", "code_verifier": verifier,
    })
    if "refresh_token" not in tokens:
        raise SystemExit("Google returned no refresh token; revoke the app's access and try again.")
    keychain_set("refresh-token", tokens["refresh_token"])
    print("Refresh token stored in the Keychain.", file=sys.stderr)


def access_token() -> str:
    client = load_client()
    refresh = keychain_get("refresh-token")
    if not refresh:
        raise SystemExit("Not signed in: run `upload.py auth` first.")
    try:
        tokens = post_form(client["token_uri"], {
            "client_id": client["client_id"], "client_secret": client["client_secret"],
            "refresh_token": refresh, "grant_type": "refresh_token",
        })
    except UploadError as e:
        if "invalid_grant" in str(e):
            raise SystemExit("The sign-in has expired or been revoked: run `upload.py auth` again. "
                             "(An OAuth consent screen left in Testing expires it every 7 days.)") from None
        raise
    return tokens["access_token"]


# -- HTTP ----------------------------------------------------------------------

def request(method: str, url: str, token: str, body: bytes = b"",
            headers: Optional[Dict[str, str]] = None) -> Tuple[int, Dict[str, str], bytes]:
    """One request over http.client: nothing follows redirects, which matters
    because the resumable protocol answers every unfinished chunk with a 308."""
    parts = urllib.parse.urlsplit(url)
    conn_cls = http.client.HTTPSConnection if parts.scheme == "https" else http.client.HTTPConnection
    conn = conn_cls(parts.netloc, timeout=120)
    path = parts.path + (f"?{parts.query}" if parts.query else "")
    try:
        conn.request(method, path, body=body,
                     headers={"Authorization": f"Bearer {token}", **(headers or {})})
        resp = conn.getresponse()
        return resp.status, {k.lower(): v for k, v in resp.getheaders()}, resp.read()
    finally:
        conn.close()


def api_json(method: str, url: str, token: str, payload: Optional[Dict] = None) -> Dict:
    body = json.dumps(payload).encode() if payload is not None else b""
    status, _, data = request(method, url, token, body,
                              {"Content-Type": "application/json"} if payload is not None else None)
    if status >= 300:
        raise UploadError(f"{method} {url}: HTTP {status}: {data.decode(errors='replace')[:500]}")
    return json.loads(data) if data else {}


# -- Resumable upload ----------------------------------------------------------

def next_offset(range_header: Optional[str]) -> int:
    """From a 308's `Range: bytes=0-N`, the first byte still to send."""
    if not range_header:
        return 0
    return int(range_header.split("-")[-1]) + 1


def start_session(token: str, metadata: Dict, size: int, upload_api: str = UPLOAD_API) -> str:
    status, headers, data = request(
        "POST", f"{upload_api}/videos?uploadType=resumable&part=snippet,status", token,
        json.dumps(metadata).encode(),
        {"Content-Type": "application/json; charset=UTF-8",
         "X-Upload-Content-Length": str(size), "X-Upload-Content-Type": "video/*"})
    if status != 200 or "location" not in headers:
        raise UploadError(f"starting the upload: HTTP {status}: {data.decode(errors='replace')[:500]}")
    return headers["location"]


def query_offset(session: str, token: str, size: int) -> Optional[int]:
    """Where the server has got to; None if the upload is already complete."""
    status, headers, _ = request("PUT", session, token, b"", {"Content-Range": f"bytes */{size}"})
    if status in (200, 201):
        return None
    if status == 308:
        return next_offset(headers.get("range"))
    if status == 404:
        raise UploadError("the upload session has expired; delete the .upload-session.json and start again")
    raise UploadError(f"querying the upload: HTTP {status}")


def send(video: Path, session: str, token_fn: Callable[[], str], chunk: int = CHUNK,
         sleep: Callable[[float], None] = time.sleep, progress: bool = True) -> Dict:
    """Send the file from wherever the session has got to; returns the video resource."""
    size = video.stat().st_size
    token = token_fn()
    offset = query_offset(session, token, size)
    failures = 0
    with open(video, "rb") as f:
        while True:
            if offset is None:  # finished by an earlier run: fetch the result
                status, _, data = request("PUT", session, token, b"", {"Content-Range": f"bytes */{size}"})
                return json.loads(data)
            f.seek(offset)
            body = f.read(chunk)
            end = offset + len(body) - 1
            try:
                status, headers, data = request("PUT", session, token, body, {
                    "Content-Length": str(len(body)), "Content-Range": f"bytes {offset}-{end}/{size}"})
            except OSError as e:  # connection reset, timeout, DNS: resume from the server's view
                status, headers, data = 0, {}, str(e).encode()
            if status in (200, 201):
                if progress:
                    print(f"\r  {size / 1e9:.2f} of {size / 1e9:.2f} GB (100%)", file=sys.stderr)
                return json.loads(data)
            if status == 308:
                offset, failures = next_offset(headers.get("range")), 0
                if progress:
                    print(f"\r  {offset / 1e9:.2f} of {size / 1e9:.2f} GB ({offset / size:.0%})",
                          end="", file=sys.stderr)
                continue
            if status == 401:
                token = token_fn()  # the hour-long access token ran out mid-upload
            elif status not in (0, 500, 502, 503, 504):
                raise UploadError(f"uploading: HTTP {status}: {data.decode(errors='replace')[:500]}")
            failures += 1
            if failures > MAX_RETRIES:
                raise UploadError(f"uploading: giving up after {MAX_RETRIES} retries (last: HTTP {status})")
            wait = min(2 ** failures, 64)
            print(f"\n  HTTP {status or 'error'}; resuming in {wait}s", file=sys.stderr)
            sleep(wait)
            offset = query_offset(session, token, size)


# -- Metadata and extras -------------------------------------------------------

def check_text(title: str, description: str) -> None:
    """YouTube rejects these server-side, after the metadata is sent; catch them first."""
    if not title.strip() or len(title) > TITLE_LIMIT:
        raise SystemExit(f"The title must be 1 to {TITLE_LIMIT} characters (it is {len(title)}).")
    if len(description) > DESCRIPTION_LIMIT:
        raise SystemExit(f"The description is {len(description)} characters; the limit is {DESCRIPTION_LIMIT}.")
    for name, text in (("title", title), ("description", description)):
        if "<" in text or ">" in text:
            raise SystemExit(f"The {name} contains < or >, which YouTube refuses.")


def metadata(title: str, description: str, tags: List[str], category: str, privacy: str) -> Dict:
    return {
        "snippet": {"title": title, "description": description, "tags": tags,
                    "categoryId": category, "defaultLanguage": "en-GB"},
        "status": {"privacyStatus": privacy, "selfDeclaredMadeForKids": False,
                   "embeddable": True, "license": "youtube"},
    }


def sidecars(video: Path) -> Tuple[Optional[Path], List[Path]]:
    """render.py's description and comment files for `video`."""
    desc = video.with_suffix(".description.txt")
    comments = sorted(video.parent.glob(video.stem + ".comment*.txt"),
                      key=lambda p: int("".join(c for c in p.suffixes[-2] if c.isdigit()) or 0))
    return (desc if desc.exists() else None), comments


def ffmpeg_tool(name: str) -> str:
    for candidate in (os.environ.get(name.upper() + "_BIN"), f"/opt/homebrew/opt/ffmpeg-full/bin/{name}",
                      shutil.which(name)):
        if candidate and Path(candidate).exists():
            return candidate
    raise SystemExit(f"{name} not found")


def auto_thumbnail(video: Path, at: float = 0.98) -> Path:
    """A frame near the end: by then the parts are built, and the plate is
    still in shot (the very last frames show it lifted out of view)."""
    duration = float(subprocess.run(
        [ffmpeg_tool("ffprobe"), "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(video)],
        check=True, capture_output=True, text=True).stdout.strip())
    out = video.with_suffix(".thumb.jpg")
    subprocess.run([ffmpeg_tool("ffmpeg"), "-v", "error", "-y", "-ss", f"{duration * at:.2f}", "-i", str(video),
                    "-frames:v", "1", "-vf", "scale=1920:1080", "-q:v", "3", str(out)], check=True)
    if out.stat().st_size > 2 * 1024 * 1024:  # YouTube's thumbnail limit
        subprocess.run([ffmpeg_tool("ffmpeg"), "-v", "error", "-y", "-i", str(out), "-q:v", "6", str(out)],
                       check=True)
    return out


def set_thumbnail(video_id: str, image: Path, token: str) -> None:
    ctype = "image/png" if image.suffix.lower() == ".png" else "image/jpeg"
    status, _, data = request("POST", f"{UPLOAD_API}/thumbnails/set?videoId={video_id}&uploadType=media",
                              token, image.read_bytes(), {"Content-Type": ctype})
    if status >= 300:
        raise UploadError(f"thumbnail: HTTP {status}: {data.decode(errors='replace')[:300]}")


def add_to_playlist(video_id: str, playlist: str, token: str) -> None:
    api_json("POST", f"{API}/playlistItems?part=snippet", token, {"snippet": {
        "playlistId": playlist, "resourceId": {"kind": "youtube#video", "videoId": video_id}}})


def post_comments(video_id: str, files: List[Path], token: str) -> None:
    # Posted last-first, so the first (the start of the tracklist) is newest
    # and tops the list until one is pinned.
    for path in reversed(files):
        api_json("POST", f"{API}/commentThreads?part=snippet", token, {"snippet": {
            "videoId": video_id, "topLevelComment": {"snippet": {"textOriginal": path.read_text()}}}})
        print(f"  posted {path.name}", file=sys.stderr)


# -- Commands ------------------------------------------------------------------

def cmd_upload(args: argparse.Namespace) -> None:
    video = args.video.expanduser().resolve()
    desc_file, comments = sidecars(video)
    description = args.description.read_text() if args.description else (desc_file.read_text() if desc_file else "")
    check_text(args.title, description)
    thumb = None
    if args.thumbnail == "auto":
        thumb = auto_thumbnail(video)
    elif args.thumbnail:
        thumb = Path(args.thumbnail).expanduser()
    tags = [t.strip() for t in args.tags.split(",") if t.strip()] if args.tags else []
    meta = metadata(args.title, description, tags, args.category, args.privacy)
    size = video.stat().st_size
    print(f"{video.name}: {size / 1e9:.2f} GB, description {len(description)} characters, "
          f"{len(comments)} comment file(s), thumbnail {thumb or 'none'}", file=sys.stderr)
    if args.dry_run:
        print(json.dumps(meta, indent=2, ensure_ascii=False))
        return

    state = video.with_suffix(".upload-session.json")
    token = access_token()
    if state.exists():
        session = json.loads(state.read_text())["session"]
        print("Resuming the earlier upload.", file=sys.stderr)
    else:
        session = start_session(token, meta, size)
        state.write_text(json.dumps({"session": session, "started": time.time(), "title": args.title}))
    result = send(video, session, access_token)
    state.unlink(missing_ok=True)
    video_id = result["id"]
    video.with_suffix(".youtube.json").write_text(json.dumps(result, indent=2))
    print(f"Uploaded: https://youtu.be/{video_id} ({result.get('status', {}).get('privacyStatus')})",
          file=sys.stderr)

    token = access_token()
    if thumb:
        set_thumbnail(video_id, thumb, token)
        print(f"  thumbnail set from {thumb.name}", file=sys.stderr)
    if args.playlist:
        add_to_playlist(video_id, args.playlist, token)
        print(f"  added to playlist {args.playlist}", file=sys.stderr)
    if comments:
        print(f"Once it's public: upload.py comments {video_id} {args.video}  (then pin the first one)",
              file=sys.stderr)
    print(video_id)


def cmd_comments(args: argparse.Namespace) -> None:
    _, files = sidecars(args.video.expanduser().resolve())
    if not files:
        raise SystemExit("No comment files beside that video.")
    post_comments(args.video_id, files, access_token())


def cmd_whoami(_: argparse.Namespace) -> None:
    data = api_json("GET", f"{API}/channels?part=snippet,status&mine=true", access_token())
    for ch in data.get("items", []):
        print(f"{ch['snippet']['title']}  https://www.youtube.com/channel/{ch['id']}  "
              f"(long uploads: {ch.get('status', {}).get('longUploadsStatus', '?')})")


def cmd_import_client(args: argparse.Namespace) -> None:
    # "-" reads stdin, so the secret can be piped in over ssh without landing on disk.
    raw = sys.stdin.read() if str(args.file) == "-" else args.file.expanduser().read_text()
    data = json.loads(raw)
    if "installed" not in data:
        raise SystemExit("That isn't a Desktop-app OAuth client (no 'installed' section).")
    keychain_set("client", json.dumps(data))
    print(f"Stored client {data['installed']['client_id'][:20]}... in the Keychain. "
          f"The JSON file can be deleted.", file=sys.stderr)


def main(argv: Optional[List[str]] = None) -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("import-client", help="store the OAuth client JSON (a file, or - for stdin) in the Keychain")
    p.add_argument("file", type=Path)
    p.set_defaults(fn=cmd_import_client)

    p = sub.add_parser("auth", help="sign in once and keep the refresh token")
    p.add_argument("--port", type=int, default=8765)
    p.add_argument("--no-browser", action="store_true", help="print the URL rather than opening it")
    p.set_defaults(fn=lambda a: auth(a.port, not a.no_browser))

    p = sub.add_parser("whoami", help="the channel uploads will go to")
    p.set_defaults(fn=cmd_whoami)

    p = sub.add_parser("upload", help="upload a video, with its thumbnail and playlist")
    p.add_argument("video", type=Path)
    p.add_argument("--title", required=True)
    p.add_argument("--description", type=Path, help="default: <video>.description.txt")
    p.add_argument("--thumbnail", help="an image, or 'auto' for a frame 98%% of the way through")
    p.add_argument("--playlist", help="playlist ID to add it to")
    p.add_argument("--tags", help="comma-separated")
    p.add_argument("--category", default="28", help="YouTube category ID (default 28, Science & Technology)")
    p.add_argument("--privacy", default="private", choices=["private", "unlisted", "public"])
    p.add_argument("--dry-run", action="store_true", help="show the metadata and stop")
    p.set_defaults(fn=cmd_upload)

    p = sub.add_parser("comments", help="post render.py's credit comments on a public video")
    p.add_argument("video_id")
    p.add_argument("video", type=Path)
    p.set_defaults(fn=cmd_comments)

    args = ap.parse_args(argv)
    try:
        args.fn(args)
    except UploadError as e:
        raise SystemExit(f"Error: {e}") from None


if __name__ == "__main__":
    main()
