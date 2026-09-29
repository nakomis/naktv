#!/usr/bin/env python3
"""Render a recorded resin print as a video with the NakTV overlay burned in.

A capture (see capture/) is a set of files sharing one prefix, for example
~/resin-recordings/2026-09-29-0040-calbits2:

    PREFIX-part01.mkv ...   video-only copy of go2rtc's resin_av
    PREFIX-parts.jsonl      when each part started, as epoch seconds
                            (older captures: PREFIX.log, "HH:MM:SS part N")
    PREFIX-status.jsonl     cthulhu /api/status once a second, with epoch "t"
    PREFIX-layers/NNNN.png  every layer image, from /api/print/layer

Everything is lined up by wall-clock time. The camera runs a little behind
the picture: the printer reports each phase about 4 s after the camera shows
it. --offset (default -4 s) moves status and layer changes to where the
picture has them.

The output mimics the TV (app/src/index.css): the strip across the top with
filename, status, layer, progress, total and remaining time on the left and
the music's artist and track on the right, plus the current layer image top
right. It is rendered at 1920x1080 so the text is sharp; the 720p camera
footage is scaled up beneath it.

Needs an ffmpeg with libass (Homebrew's `ffmpeg-full`; the plain `ffmpeg`
formula has no text rendering). Python 3.9, standard library only.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import shlex
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

W, H = 1920, 1080
VH, VW = H / 100, W / 100
FPS = 25

# The TV's layout (app/src/index.css), in 1080p pixels.
PAD_TOP, PAD_SIDE = 2 * VH, 3 * VH
NAME_PX, LABEL_PX, VALUE_PX = round(3 * VH), round(1.7 * VH), round(2.2 * VH)
FIELD_GAP = 2.5 * VH
BASELINE = round(PAD_TOP + NAME_PX)
LAYER_W = round(22 * VW)
LAYER_H = round(LAYER_W * 432 / 852)
LAYER_TOP, LAYER_RIGHT = round(9 * VH), round(3 * VH)

UNKNOWN = "--:--"
LABEL_COLOUR = "&HC8C8C8&"  # ASS is &HBBGGRR&; grey is grey either way
VALUE_COLOUR = "&HFFFFFF&"
FONT = "Helvetica Neue"


# ── Inputs ────────────────────────────────────────────────────────────────


@dataclass
class Part:
    path: Path
    start: float  # epoch seconds the recording of this part began
    duration: Optional[float] = None  # None while a copy is still growing


@dataclass
class Status:
    t: float
    label: str
    filename: str
    layer: Optional[int]
    total_layers: Optional[int]
    percent: Optional[float]
    remaining_ms: Optional[float]
    total_ms: Optional[float]


@dataclass
class Track:
    path: Path
    duration: float
    artist: str
    title: str
    licence: str = ""
    source_url: str = ""
    download_url: str = ""


def read_parts(prefix: Path, day: Optional[dt.date] = None) -> List[Part]:
    """Part files and their start times, from PREFIX-parts.jsonl or PREFIX.log."""
    files = sorted(prefix.parent.glob(prefix.name + "-part*.mkv"))
    starts: Dict[int, float] = {}
    jsonl = Path(str(prefix) + "-parts.jsonl")
    log = Path(str(prefix) + ".log")
    if jsonl.exists():
        for line in jsonl.read_text().splitlines():
            if line.strip():
                d = json.loads(line)
                starts[int(d["part"])] = float(d["t"])
    elif log.exists():
        starts = parse_legacy_log(log.read_text(), day or day_from_prefix(prefix))
    parts = []
    for f in files:
        n = int(re.search(r"-part(\d+)\.mkv$", f.name).group(1))
        if n not in starts:
            raise SystemExit(f"no start time recorded for {f.name}")
        parts.append(Part(f, starts[n]))
    if not parts:
        raise SystemExit(f"no {prefix.name}-partNN.mkv files found")
    return parts


def day_from_prefix(prefix: Path) -> dt.date:
    m = re.match(r"(\d{4})-(\d{2})-(\d{2})", prefix.name)
    if not m:
        raise SystemExit("can't tell the capture's date from its name; use --day")
    return dt.date(int(m.group(1)), int(m.group(2)), int(m.group(3)))


def parse_legacy_log(text: str, day: dt.date) -> Dict[int, float]:
    """`HH:MM:SS part N -> ...` lines, local time, on `day` (rolling past midnight)."""
    starts: Dict[int, float] = {}
    previous = None
    for m in re.finditer(r"^(\d{2}):(\d{2}):(\d{2}) part (\d+) ", text, re.M):
        when = dt.datetime.combine(day, dt.time(int(m.group(1)), int(m.group(2)), int(m.group(3))))
        if previous is not None and when < previous:
            day += dt.timedelta(days=1)
            when += dt.timedelta(days=1)
        previous = when
        starts[int(m.group(4))] = when.timestamp()
    return starts


def read_status(path: Path) -> List[Status]:
    out = []
    for line in path.read_text().splitlines():
        if not line.strip():
            continue
        d = json.loads(line)
        p = d.get("print")
        if not p:
            continue
        out.append(
            Status(
                t=float(d["t"]),
                label=p.get("statusLabel") or "",
                filename=p.get("filename") or "",
                layer=p.get("currentLayer"),
                total_layers=p.get("totalLayer"),
                percent=p.get("progressPercent"),
                remaining_ms=p.get("remainingMs"),
                total_ms=p.get("totalMs"),
            )
        )
    return out


def read_events(path: Path) -> List[Tuple[float, str, Optional[int]]]:
    """PREFIX-status-events.jsonl: every change of status label or layer, as
    cthulhu pushed it (/api/ws), timestamped to the millisecond. Optional."""
    if not path.exists():
        return []
    out = []
    for line in path.read_text().splitlines():
        if line.strip():
            d = json.loads(line)
            out.append((float(d["t"]), d.get("label") or "", d.get("layer")))
    return sorted(out)


def merge_events(statuses: Sequence[Status], events: Sequence[Tuple[float, str, Optional[int]]]) -> List[Status]:
    """Precise label and layer changes from the event log, other fields from the 1 Hz log.

    Where the event log covers, a 1 Hz sample's label and layer are replaced
    by the latest event before it, and every event becomes a point of its own,
    so boundaries land to the millisecond rather than up to a second late.
    """
    if not events:
        return list(statuses)
    import bisect
    times = [e[0] for e in events]
    merged: List[Status] = []
    for s in statuses:
        i = bisect.bisect_right(times, s.t) - 1
        if i >= 0:
            s = Status(**{**s.__dict__, "label": events[i][1], "layer": events[i][2]})
        merged.append(s)
    samples = sorted(statuses, key=lambda s: s.t)
    sample_times = [s.t for s in samples]
    for t, label, layer in events:
        j = bisect.bisect_right(sample_times, t) - 1
        base = samples[max(j, 0)]
        merged.append(Status(**{**base.__dict__, "t": t, "label": label, "layer": layer}))
    return sorted(merged, key=lambda s: s.t)


# ── Timeline ──────────────────────────────────────────────────────────────


@dataclass
class Segment:
    """A stretch of one part that goes into the output."""

    part: Part
    wall_start: float
    wall_end: float
    out_start: float = 0.0

    @property
    def length(self) -> float:
        return self.wall_end - self.wall_start


def plan_segments(parts: Sequence[Part], wall_from: float, wall_to: float) -> List[Segment]:
    """Cut [wall_from, wall_to) out of the parts, laid end to end in the output.

    A part runs until its duration ends, or until the next part starts if its
    duration is not known yet (a copy of a file still being recorded).
    """
    segments: List[Segment] = []
    out = 0.0
    for i, part in enumerate(parts):
        end = part.start + part.duration if part.duration else None
        if end is None:
            end = parts[i + 1].start if i + 1 < len(parts) else wall_to
        a, b = max(part.start, wall_from), min(end, wall_to)
        if b - a <= 0.5:
            continue
        segments.append(Segment(part, a, b, out))
        out += b - a
    if not segments:
        raise SystemExit("nothing recorded in the requested range")
    return segments


def wall_to_out(segments: Sequence[Segment], wall: float) -> Optional[float]:
    for s in segments:
        if s.wall_start <= wall < s.wall_end:
            return s.out_start + (wall - s.wall_start)
    return None


def layer_time(statuses: Sequence[Status], layer: int) -> float:
    """When the print first reached `layer`."""
    for s in statuses:
        if s.layer is not None and s.layer >= layer:
            return s.t
    raise SystemExit(f"layer {layer} never appears in the status log")


# ── Overlay text ──────────────────────────────────────────────────────────


# STATUS is shown exactly as the printer reports it (cthulhu's statusLabel,
# from SDCP). "Lifting" and "Dropping" can read the wrong way round against
# what the camera shows - a resin printer lifts and drops the head, not the
# plate - but they are the printer's words, and the video should agree with the
# printer and the Elegoo app. Keep them verbatim.


def format_duration_ms(ms: Optional[float]) -> str:
    """As printJob.ts's formatDuration: hh:mm, or --:-- when unknown."""
    if ms is None or ms < 0:
        return UNKNOWN
    minutes = int(ms // 60000)
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


def format_layer(s: Status) -> str:
    if not s.total_layers:
        return UNKNOWN
    return f"{s.layer or 0} / {s.total_layers}"


def format_percent(value: Optional[float]) -> str:
    return "--%" if value is None else f"{round(value)}%"


def field_text(label: str, value: str) -> str:
    return (
        f"{{\\fs{LABEL_PX}\\fsp1.5\\c{LABEL_COLOUR}}}{label.upper()}"
        f"{{\\fsp0}}\\h{{\\fs{VALUE_PX}\\c{VALUE_COLOUR}}}{ass_escape(value)}"
    )


def ass_escape(text: str) -> str:
    return text.replace("\\", "\\\\").replace("{", "(").replace("}", ")").replace("\n", " ")


def est_width(text: str, px: float) -> float:
    """Rough rendered width; enough to place fixed columns without measuring fonts."""
    return len(text) * px * 0.56


@dataclass
class Event:
    start: float
    end: float
    text: str


def status_events(
    statuses: Sequence[Status], segments: Sequence[Segment], offset: float, out_end: float
) -> Tuple[List[Event], List[Event]]:
    """The left-hand strip as two groups of events: name and status, then the rest.

    Split so the numbers sit in a fixed column: on the TV the status value is
    a fixed 9ch wide so the fields after it don't shuffle as it cycles
    Lifting, Dropping, Exposing; here the second group is placed after the
    widest status instead.
    """
    name = next((s.filename for s in statuses if s.filename), "")
    x_rest = (
        PAD_SIDE
        + est_width(name, NAME_PX)
        + FIELD_GAP
        + est_width("STATUS ", LABEL_PX * 1.1)
        + est_width("Exposing", VALUE_PX) * 0.85  # the estimate runs wide for lower case
        + FIELD_GAP
    )
    head, rest = [], []
    for s in statuses:
        at = wall_to_out(segments, s.t + offset)
        if at is None:
            continue
        head.append(
            (at, f"{{\\an1\\pos({PAD_SIDE:.0f},{BASELINE})}}"
                 f"{{\\fs{NAME_PX}\\b1}}{ass_escape(name)}{{\\b0}}\\h\\h\\h" + field_text("Status", s.label))
        )
        gap = "\\h\\h\\h\\h"
        rest.append(
            (at, f"{{\\an1\\pos({x_rest:.0f},{BASELINE})}}"
                 + gap.join(
                     [
                         field_text("Layer", format_layer(s)),
                         field_text("Progress", format_percent(s.percent)),
                         field_text("Total", format_duration_ms(s.total_ms)),
                         field_text("Remaining", format_duration_ms(s.remaining_ms)),
                     ]
                 ))
        )
    return merge_runs(head, out_end), merge_runs(rest, out_end)


def merge_runs(points: Iterable[Tuple[float, str]], out_end: float) -> List[Event]:
    """Turn (time, text) samples into events, one per run of identical text."""
    events: List[Event] = []
    for at, text in sorted(points, key=lambda p: p[0]):
        if events and events[-1].text == text:
            continue
        if events:
            events[-1].end = at
        events.append(Event(at, out_end, text))
    return [e for e in events if e.end - e.start > 0.01]


def trim_parenthetical(value: str) -> str:
    """As nowPlaying.ts: everything before the first "(", trimmed."""
    return value.split("(", 1)[0].strip()


def truncate(value: str, px: float, max_width: float = 14 * VW) -> str:
    """As the TV's .print-overlay-value--truncate: cut to 14vw, with an ellipsis."""
    if est_width(value, px) <= max_width:
        return value
    keep = max(int(max_width / (px * 0.56)) - 1, 1)
    return value[:keep].rstrip() + "\u2026"


def music_events(tracks: Sequence[Tuple[float, Track]], out_end: float) -> List[Event]:
    """ARTIST and TRACK, styled exactly as the TV's Spotify fields, from the CC0 playlist."""
    points = []
    for at, t in tracks:
        artist = truncate(t.artist.strip(), VALUE_PX)
        title = truncate(trim_parenthetical(t.title), VALUE_PX)
        fields = [field_text(label, value) for label, value in (("Artist", artist), ("Track", title)) if value]
        if not fields:
            continue
        text = f"{{\\an3\\pos({W - PAD_SIDE:.0f},{BASELINE})}}" + "\\h\\h\\h\\h".join(fields)
        points.append((at, text))
    return merge_runs(points, out_end)


def ass_time(seconds: float) -> str:
    cs = int(round(max(seconds, 0) * 100))
    return f"{cs // 360000}:{cs // 6000 % 60:02d}:{cs // 100 % 60:02d}.{cs % 100:02d}"


def build_ass(events: Iterable[Event]) -> str:
    header = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {W}
PlayResY: {H}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Strip,{FONT},{VALUE_PX},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,1,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    lines = [
        f"Dialogue: 0,{ass_time(e.start)},{ass_time(e.end)},Strip,,0,0,0,,{e.text}"
        for e in sorted(events, key=lambda e: e.start)
    ]
    return header + "\n".join(lines) + "\n"


# ── Layer images and music ────────────────────────────────────────────────


def layer_changes(
    statuses: Sequence[Status], segments: Sequence[Segment], offset: float
) -> List[Tuple[float, int]]:
    """(output time, layer) at each change of layer, starting at time 0."""
    changes: List[Tuple[float, int]] = []
    first: Optional[int] = None
    for s in statuses:
        if s.layer is None:
            continue
        at = wall_to_out(segments, s.t + offset)
        if at is None:
            if s.t + offset < segments[0].wall_start:
                first = s.layer  # the layer on show when the output begins
            continue
        if not changes or changes[-1][1] != s.layer:
            changes.append((at, s.layer))
    if first is not None and (not changes or changes[0][0] > 0):
        changes.insert(0, (0.0, first))
    elif changes and changes[0][0] > 0:
        changes[0] = (0.0, changes[0][1])
    return changes


def layer_concat(changes: Sequence[Tuple[float, int]], layers_dir: Path, out_end: float) -> str:
    """An ffmpeg concat-demuxer script showing each layer image for its time."""
    lines = ["ffconcat version 1.0"]
    last = None
    for i, (at, layer) in enumerate(changes):
        end = changes[i + 1][0] if i + 1 < len(changes) else out_end
        path = layer_path(layers_dir, layer)
        lines.append(f"file {concat_quote(path)}")
        lines.append(f"duration {max(end - at, 0.04):.3f}")
        last = path
    if last is not None:
        lines.append(f"file {concat_quote(last)}")  # the demuxer ignores the last duration
    return "\n".join(lines) + "\n"


def layer_path(layers_dir: Path, layer: int) -> Path:
    path = layers_dir / f"{layer:04d}.png"
    if path.exists():
        return path
    # A layer that failed to save: show the nearest earlier one instead.
    for n in range(layer - 1, -1, -1):
        p = layers_dir / f"{n:04d}.png"
        if p.exists():
            return p
    raise SystemExit(f"no layer image at or before {layer} in {layers_dir}")


def concat_quote(path: Path) -> str:
    return "'" + str(path).replace("'", "'\\''") + "'"


def playlist_timeline(tracks: Sequence[Track], length: float) -> List[Tuple[float, Track]]:
    """The playlist, looped, as (start time, track) until `length` is covered."""
    if not tracks:
        return []
    timeline, at = [], 0.0
    while at < length:
        for t in tracks:
            timeline.append((at, t))
            at += t.duration
            if at >= length:
                break
    return timeline


def audio_concat(timeline: Sequence[Tuple[float, Track]]) -> str:
    return "ffconcat version 1.0\n" + "".join(f"file {concat_quote(t.path)}\n" for _, t in timeline)


AUDIO_SUFFIXES = {".mp3", ".flac", ".ogg", ".oga", ".m4a", ".wav", ".opus", ".aac"}


def read_manifest(music: Path) -> Dict[str, dict]:
    """tracks.json beside the music: [{"file", "artist", "title", "licence",
    "source_url", "download_url"}], keyed by file name. Optional."""
    path = music / "tracks.json"
    if not path.exists():
        return {}
    return {entry["file"]: entry for entry in json.loads(path.read_text())}


def read_tracks(music: Path, ffprobe: str) -> List[Track]:
    manifest = read_manifest(music)
    files = [p for p in sorted(music.iterdir()) if p.suffix.lower() in AUDIO_SUFFIXES]
    # Play in tracks.json's order (fetch_fma.py writes them as it picks them,
    # at random) rather than by name, which would group each artist together.
    order = {name: i for i, name in enumerate(manifest)}
    files.sort(key=lambda p: (order.get(p.name, len(order)), p.name))
    tracks = []
    for f in files:
        probe = json.loads(
            subprocess.run(
                [ffprobe, "-v", "error", "-show_entries", "format=duration:format_tags",
                 "-of", "json", str(f)],
                check=True, capture_output=True, text=True,
            ).stdout
        )
        fmt = probe.get("format", {})
        tags = {k.lower(): v for k, v in (fmt.get("tags") or {}).items()}
        artist, title = tags.get("artist"), tags.get("title")
        if not (artist and title):
            m = re.match(r"(.+?) - (.+)$", f.stem)
            artist = artist or (m.group(1) if m else "")
            title = title or (m.group(2) if m else f.stem)
        info = manifest.get(f.name, {})
        tracks.append(Track(
            f, float(fmt["duration"]),
            info.get("artist") or artist, info.get("title") or title,
            info.get("licence", ""), info.get("source_url", ""), info.get("download_url", ""),
        ))
    return tracks


def clock(seconds: float) -> str:
    s = int(seconds)
    return f"{s // 3600}:{s // 60 % 60:02d}:{s % 60:02d}" if s >= 3600 else f"{s // 60:02d}:{s % 60:02d}"


DESCRIPTION_LIMIT = 5000  # YouTube's description cap, in characters
COMMENT_LIMIT = 10000  # and a comment's


def credit_line(t: Track) -> str:
    return f"{t.artist} \u2013 {t.title}" if t.artist else t.title


def album_url(track_url: str) -> str:
    """FMA track pages sit under their album: .../music/ARTIST/ALBUM/TRACK/."""
    parts = track_url.rstrip("/").split("/")
    return "/".join(parts[:-1]) + "/" if len(parts) > 6 else track_url


def unique_tracks(timeline: Sequence[Tuple[float, Track]]) -> List[Track]:
    seen, out = set(), []
    for _, t in timeline:
        if t.path not in seen:
            seen.add(t.path)
            out.append(t)
    return out


def description(timeline: Sequence[Tuple[float, Track]], intro: str = "") -> str:
    """The YouTube description: a short intro, the music credited by album, then
    a timestamped tracklist (YouTube makes chapters of it: first entry at 0:00,
    at least three, each at least ten seconds). Per-track credits with links
    are too long for the 5,000-character cap and go in comments() instead."""
    tracks = unique_tracks(timeline)
    albums: Dict[str, Tuple[str, str]] = {}
    for t in tracks:
        if t.source_url:
            albums.setdefault(album_url(t.source_url), (t.artist, t.licence))
    licences = sorted({t.licence for t in tracks if t.licence})
    lines = [intro] if intro else []
    lines.append("Music" + (f" (all {licences[0]})" if len(licences) == 1 else "") + ", from Free Music Archive:")
    lines += [f"{artist}: {url}" for url, (artist, _) in albums.items()]
    lines += ["Every track, with its own link, is in the pinned comment.", "", "Tracklist:"]
    lines += [f"{clock(at)} {credit_line(t)}" for at, t in timeline]
    return "\n".join(lines) + "\n"


def comments(timeline: Sequence[Tuple[float, Track]]) -> List[str]:
    """Per-track credits with links, split into comments under YouTube's cap."""
    blocks = []
    for t in unique_tracks(timeline):
        block = credit_line(t) + (f" ({t.licence})" if t.licence else "")
        if t.source_url:
            block += "\n" + t.source_url
        blocks.append(block)
    out, cur = [], "Music credits:"
    for b in blocks:
        if len(cur) + 2 + len(b) > COMMENT_LIMIT:
            out.append(cur)
            cur = "Music credits (continued):"
        cur += "\n\n" + b
    out.append(cur)
    return out


def probe_duration(path: Path, ffprobe: str) -> Optional[float]:
    out = subprocess.run(
        [ffprobe, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
        capture_output=True, text=True,
    ).stdout.strip()
    try:
        return float(out)
    except ValueError:
        return None  # a file still being written has no duration yet


# ── ffmpeg ────────────────────────────────────────────────────────────────


def strip_boxes() -> str:
    """The TV strip's background: solid for 70% of its height, then fading out."""
    solid = round((PAD_TOP + NAME_PX + 3 * VH) * 0.7)
    fade = round((PAD_TOP + NAME_PX + 3 * VH) * 0.3)
    boxes = [f"drawbox=x=0:y=0:w=iw:h={solid}:color=black@0.88:t=fill"]
    steps = 24  # fine enough that the steps don't show as bands
    for i in range(steps):
        alpha = 0.88 * (1 - (i + 0.5) / steps)
        y = solid + round(i * fade / steps)
        h = round((i + 1) * fade / steps) - round(i * fade / steps)
        boxes.append(f"drawbox=x=0:y={y}:w=iw:h={h}:color=black@{alpha:.3f}:t=fill")
    return ",".join(boxes)


def ffmpeg_command(
    ffmpeg: str,
    segments: Sequence[Segment],
    layers_script: Path,
    ass_path: Path,
    audio_script: Optional[Path],
    length: float,
    out: Path,
    encoder: str,
    bitrate: str,
    layer_scale: float = 1.0,
) -> List[str]:
    cmd = [ffmpeg, "-hide_banner", "-y"]
    for s in segments:
        cmd += ["-ss", f"{s.wall_start - s.part.start:.3f}", "-t", f"{s.length:.3f}",
                "-fflags", "+genpts", "-i", str(s.part.path)]
    n = len(segments)
    cmd += ["-f", "concat", "-safe", "0", "-i", str(layers_script)]
    if audio_script:
        cmd += ["-f", "concat", "-safe", "0", "-i", str(audio_script)]

    # Each part is re-timed to a steady frame rate first: the recording has
    # the odd pair of frames sharing a timestamp, which a muxer rejects.
    chains = [f"[{i}:v]setpts=PTS-STARTPTS,fps={FPS},scale={W}:{H}:flags=lanczos,setsar=1[v{i}]"
              for i in range(n)]
    joined = "".join(f"[v{i}]" for i in range(n))
    chains.append(f"{joined}concat=n={n}:v=1:a=0[cam]" if n > 1 else "[v0]null[cam]")
    # Even dimensions: yuv420p can't have odd ones.
    lw, lh = 2 * round(LAYER_W * layer_scale / 2), 2 * round(LAYER_H * layer_scale / 2)
    chains.append(
        f"[{n}:v]fps={FPS},scale={lw}:{lh}:flags=lanczos,format=yuv420p,"
        f"drawbox=x=0:y=0:w=iw:h=ih:color=0xc8c8c8:t=1[layer]"
    )
    chains.append(f"[cam]{strip_boxes()}[bg]")
    chains.append(
        f"[bg][layer]overlay=x=W-w-{LAYER_RIGHT}:y={LAYER_TOP}:eof_action=repeat,"
        f"ass={filter_quote(ass_path)},format=yuv420p[out]"
    )
    cmd += ["-filter_complex", ";".join(chains), "-map", "[out]"]
    if audio_script:
        cmd += ["-map", f"{n + 1}:a", "-c:a", "aac", "-b:a", "192k"]
    cmd += ["-t", f"{length:.3f}", "-c:v", encoder]
    if encoder.endswith("videotoolbox"):
        cmd += ["-b:v", bitrate, "-maxrate", bitrate, "-allow_sw", "0"]
    else:
        cmd += ["-preset", "medium", "-crf", "20"]
    cmd += ["-r", str(FPS), "-movflags", "+faststart", str(out)]
    return cmd


def filter_quote(path: Path) -> str:
    # Inside a filtergraph, ':' and '\' and "'" are special.
    return "'" + str(path).replace("\\", "\\\\").replace("'", "\\'").replace(":", "\\:") + "'"


def default_ffmpeg() -> str:
    for p in ("/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg", "/usr/local/opt/ffmpeg-full/bin/ffmpeg"):
        if os.path.exists(p):
            return p
    return "ffmpeg"


# ── Main ──────────────────────────────────────────────────────────────────


def name_of(statuses: Sequence[Status]) -> str:
    return next((s.filename for s in statuses if s.filename), "print")


def parse_clock(value: str, day: dt.date) -> float:
    h, m, *s = (int(x) for x in value.split(":"))
    return dt.datetime.combine(day, dt.time(h, m, s[0] if s else 0)).timestamp()


def main(argv: Optional[Sequence[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("capture", type=Path, help="capture prefix, e.g. ~/resin-recordings/2026-09-29-0040-calbits2")
    ap.add_argument("-o", "--out", type=Path, required=True)
    ap.add_argument("--music", type=Path, help="folder of tracks, played in name order and looped")
    ap.add_argument("--from-layer", type=int)
    ap.add_argument("--until-layer", type=int)
    ap.add_argument("--from-time", help="wall-clock HH:MM[:SS] to start at (on the capture's day)")
    ap.add_argument("--until-time", help="wall-clock HH:MM[:SS] to stop at")
    ap.add_argument("--max-seconds", type=float, help="stop after this much output (for test renders)")
    # Calibrated by eye on 29 Sep 2026 (calbits2, millisecond event log): the
    # printer reports each phase about 4 s after the camera shows it, so status
    # is shown 4 s *earlier* than cthulhu received it. The 1 Hz log alone
    # can't be calibrated like this; it smears every boundary by up to 1 s.
    ap.add_argument("--offset", type=float, default=-4.0,
                    help="seconds to shift status and layer changes by (negative: earlier)")
    ap.add_argument("--day", type=dt.date.fromisoformat, help="capture date, if the prefix doesn't start with it")
    ap.add_argument("--ffmpeg", default=default_ffmpeg())
    ap.add_argument("--encoder", default="h264_videotoolbox")
    ap.add_argument("--bitrate", default="10M")
    # Smaller than on the TV by default: the panel shows every cross-section
    # of the model, and at 75% (317 px across the 153 mm plate, ~0.48 mm a
    # pixel) there is less of the design in it to rebuild from the frames.
    ap.add_argument("--layer-scale", type=float, default=0.75,
                    help="layer panel size relative to the TV's (22vw); default 0.75")
    ap.add_argument("--dry-run", action="store_true", help="print the ffmpeg command and stop")
    ap.add_argument("--text-only", action="store_true", help="write the description and comments, don't render")
    ap.add_argument("--intro", help="opening paragraph of the YouTube description (default: a generic line)")
    args = ap.parse_args(argv)

    # Absolute: the concat scripts live in a temp folder, and ffmpeg resolves
    # relative paths in them against that folder, not the working directory.
    prefix = args.capture.expanduser().resolve()
    day = args.day or day_from_prefix(prefix)
    ffprobe = str(Path(args.ffmpeg).with_name("ffprobe")) if "/" in args.ffmpeg else "ffprobe"

    parts = read_parts(prefix, day)
    for p in parts:
        p.duration = probe_duration(p.path, ffprobe)
    statuses = read_status(Path(str(prefix) + "-status.jsonl"))
    if not statuses:
        raise SystemExit("the status log is empty")
    events = read_events(Path(str(prefix) + "-status-events.jsonl"))
    statuses = merge_events(statuses, events)
    if events:
        print(f"{len(events)} precise status changes from the event log", file=sys.stderr)

    wall_from = parts[0].start
    wall_to = statuses[-1].t + args.offset
    if parts[-1].duration:
        wall_to = min(wall_to, parts[-1].start + parts[-1].duration)
    if args.from_time:
        wall_from = parse_clock(args.from_time, day)
    if args.until_time:
        wall_to = parse_clock(args.until_time, day)
    if args.from_layer is not None:
        wall_from = layer_time(statuses, args.from_layer) + args.offset
    if args.until_layer is not None:
        wall_to = layer_time(statuses, args.until_layer) + args.offset
    # Never start before there is a status to show.
    wall_from = max(wall_from, statuses[0].t + args.offset)
    if args.max_seconds:
        wall_to = min(wall_to, wall_from + args.max_seconds)

    segments = plan_segments(parts, wall_from, wall_to)
    length = sum(s.length for s in segments)

    tracks = read_tracks(args.music.expanduser().resolve(), ffprobe) if args.music else []
    timeline = playlist_timeline(tracks, length)

    head, rest = status_events(statuses, segments, args.offset, length)
    events = head + rest + music_events(timeline, length)

    work = Path(tempfile.mkdtemp(prefix="print-video-"))
    ass_path = work / "overlay.ass"
    ass_path.write_text(build_ass(events))
    layers_script = work / "layers.ffconcat"
    layers_script.write_text(
        layer_concat(layer_changes(statuses, segments, args.offset), Path(str(prefix) + "-layers"), length)
    )
    audio_script = None
    if timeline:
        audio_script = work / "audio.ffconcat"
        audio_script.write_text(audio_concat(timeline))

    cmd = ffmpeg_command(args.ffmpeg, segments, layers_script, ass_path, audio_script, length,
                         args.out.expanduser(), args.encoder, args.bitrate, args.layer_scale)
    print(f"{len(segments)} segment(s), {length / 3600:.2f} h of output; work files in {work}", file=sys.stderr)
    if timeline:
        intro = args.intro or (f"A resin print ({name_of(statuses)}) on an Elegoo Mars 5 Ultra, "
                               f"in real time, with the layer being exposed shown top right.")
        text = description(timeline, intro)
        notes = args.out.expanduser().with_suffix(".description.txt")
        notes.write_text(text)
        print(f"YouTube description: {notes} ({len(text)} characters)", file=sys.stderr)
        if len(text) > DESCRIPTION_LIMIT:
            print(f"  WARNING: over YouTube's {DESCRIPTION_LIMIT}-character limit", file=sys.stderr)
        for i, c in enumerate(comments(timeline), 1):
            path = args.out.expanduser().with_suffix(f".comment{i}.txt")
            path.write_text(c + "\n")
            print(f"Pinned comment {i}: {path} ({len(c)} characters)", file=sys.stderr)
    if args.text_only:
        return 0
    if args.dry_run:
        print(" ".join(shlex.quote(c) for c in cmd))
        return 0
    return subprocess.run(cmd).returncode


if __name__ == "__main__":
    sys.exit(main())
