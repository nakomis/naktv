#!/usr/bin/env python3
"""Rebuild a printable STL from a print's layer images (NAKTV-21).

How much of a design do the layer images give away? This stacks them back
into a solid and writes an STL you can slice and print again.

    rebuild.py tv    CAPTURE_PREFIX -o tv.stl       # the saved PNGs: what the TV shows
    rebuild.py video VIDEO.mp4      -o video.stl    # the panel in a rendered video

`tv` reads PREFIX-layers/NNNN.png (852x432 across the whole build plate).
`video` reads the layer panel out of a video that render.py made, using the
VIDEO.layers.json it wrote alongside (where the panel is, and when each
layer is on it), one frame from the middle of each layer's time on screen.

Scale: across the plate, the image width spans the platform (153.36 x 77.76 mm
on the Mars 5 Ultra); vertically, one layer is --layer-height (read from
PREFIX.goo when the capture has it). The images match the slicer's view (cthulhu
does not mirror them), so columns run along +X and rows down -Y.

Supports are part of each layer, so they come back too. Needs numpy and
scikit-image (tools/print-video/venv on phi).
"""
from __future__ import annotations

import argparse
import json
import struct
import subprocess
import sys
from pathlib import Path
from typing import List, Optional, Sequence, Tuple

import numpy as np

PLATE_MM = (153.36, 77.76)  # Mars 5 Ultra: 8520 x 4320 px at 18 um
GOO_SETTINGS = 194 + 116 * 116 * 2 + 2 + 290 * 290 * 2 + 2


def goo_geometry(path: Path) -> Optional[Tuple[float, float, float]]:
    """(plate X mm, plate Y mm, layer height mm) from a .goo header, if there is one."""
    if not path.exists():
        return None
    with open(path, "rb") as f:
        d = f.read(GOO_SETTINGS + 30)
    if d[:4] != b"V3.0":
        return None
    px, py, _pz, lh = struct.unpack(">4f", d[GOO_SETTINGS + 10:GOO_SETTINGS + 26])
    return px, py, lh


# ── Reading layers ────────────────────────────────────────────────────────


def tv_layers(prefix: Path, z_step: int) -> Tuple[List[np.ndarray], int]:
    from PIL import Image

    files = sorted(Path(str(prefix) + "-layers").glob("*.png"))
    if not files:
        raise SystemExit(f"no layer images in {prefix}-layers")
    last = int(files[-1].stem)
    images, width = [], 0
    for n in range(0, last + 1, z_step):
        f = Path(str(prefix) + "-layers") / f"{n:04d}.png"
        if not f.exists():  # a layer that failed to save: repeat the one before
            images.append(images[-1] if images else None)
            continue
        a = np.asarray(Image.open(f).convert("L"))
        width = a.shape[1]
        images.append(a)
    blank = np.zeros_like(next(i for i in images if i is not None))
    return [blank if i is None else i for i in images], width


def video_layers(video: Path, z_step: int, ffmpeg: str) -> Tuple[List[np.ndarray], int]:
    side = json.loads(video.with_suffix(".layers.json").read_text())
    p, changes, length = side["panel"], side["changes"], side["length"]
    b = p.get("border", 1)
    w, h = p["w"] - 2 * b, p["h"] - 2 * b
    # One sample time per layer: the middle of its time on screen.
    samples: List[Tuple[int, float]] = []
    for i, (t, layer) in enumerate(changes):
        end = changes[i + 1][0] if i + 1 < len(changes) else length
        samples.append((layer, (t + end) / 2))
    wanted = {}
    for layer, t in samples:
        if layer % z_step == 0:
            wanted[layer] = t
    # Decode the panel region at 4 fps in one pass (seeking thousands of
    # times is far slower), then pick the frame nearest each sample time.
    fps = 4
    cmd = [ffmpeg, "-v", "error", "-i", str(video), "-an",
           "-vf", f"fps={fps},crop={w}:{h}:{p['x'] + b}:{p['y'] + b},format=gray",
           "-f", "rawvideo", "-"]
    frames = {}
    targets = sorted((round(t * fps), layer) for layer, t in wanted.items())
    ti = 0
    with subprocess.Popen(cmd, stdout=subprocess.PIPE) as proc:
        n = 0
        while ti < len(targets):
            buf = proc.stdout.read(w * h)
            if len(buf) < w * h:
                break
            while ti < len(targets) and targets[ti][0] == n:
                frames[targets[ti][1]] = np.frombuffer(buf, np.uint8).reshape(h, w).copy()
                ti += 1
            n += 1
        proc.kill()
    if not frames:
        raise SystemExit("no panel frames decoded")
    first, last = min(frames), max(frames)
    images, prev = [], np.zeros((h, w), np.uint8)
    for layer in range(first - first % z_step, last + 1, z_step):
        prev = frames.get(layer, prev)
        images.append(prev)
    print(f"decoded {len(frames)} layer frames from the video ({w}x{h} panel)", file=sys.stderr)
    return images, w


# ── Solid and surface ─────────────────────────────────────────────────────


def to_volume(images: Sequence[np.ndarray], threshold: int = 128) -> Tuple[np.ndarray, Tuple[int, int]]:
    """Stack thresholded layers into a boolean volume (z, row, col), cropped to
    the area anything was printed in, with a one-voxel empty margin all round so
    the surface closes. Returns the volume and the crop's (row, col) origin."""
    footprint = np.zeros(images[0].shape, bool)
    for im in images:
        footprint |= im >= threshold
    rows, cols = np.nonzero(footprint)
    if rows.size == 0:
        raise SystemExit("every layer is empty")
    r0, r1, c0, c1 = rows.min(), rows.max() + 1, cols.min(), cols.max() + 1
    vol = np.zeros((len(images) + 2, r1 - r0 + 2, c1 - c0 + 2), bool)
    for z, im in enumerate(images):
        vol[z + 1, 1:-1, 1:-1] = im[r0:r1, c0:c1] >= threshold
    return vol, (int(r0), int(c0))


def preview(vol: np.ndarray, spacing: Tuple[float, float, float], path: Path, mm_per_px: float = 0.1) -> None:
    """A picture of the rebuilt solid: the front view (as it printed, hanging
    from the plate at the top) above the view from above, each depth-shaded so
    nearer surfaces are lighter. Straight from the voxels; no 3D viewer needed."""
    from PIL import Image

    dz, dr, dc = spacing

    def shade(solid: np.ndarray) -> np.ndarray:
        """solid: (depth, h, w) bool, nearest first -> (h, w) greyscale."""
        hit = solid.any(axis=0)
        depth = np.argmax(solid, axis=0).astype(np.float32)
        near = 1.0 - depth / max(solid.shape[0] - 1, 1)
        # A touch of relief from the depth gradient, so edges read.
        gy, gx = np.gradient(depth)
        light = np.clip(0.75 * near + 0.25 - 0.15 * (gx + gy) / 4, 0, 1)
        return np.where(hit, 40 + 215 * light, 18).astype(np.uint8)

    def resize(img: np.ndarray, h_mm: float, w_mm: float) -> Image.Image:
        return Image.fromarray(img).resize(
            (max(1, round(w_mm / mm_per_px)), max(1, round(h_mm / mm_per_px))), Image.LANCZOS)

    # Front: look along rows (from the -Y side, nearest row last); z runs down
    # from the plate, as printed.
    front = shade(np.flip(vol, axis=1).transpose(1, 0, 2))
    top = shade(vol[::-1])  # from above the plate's far side: the last layer is nearest
    nz, nr, nc = vol.shape
    f_img = resize(front, nz * dz, nc * dc)
    t_img = resize(top, nr * dr, nc * dc)
    canvas = Image.new("L", (max(f_img.width, t_img.width), f_img.height + t_img.height + 10), 0)
    canvas.paste(f_img, (0, 0))
    canvas.paste(t_img, (0, f_img.height + 10))
    canvas.save(path)


def surface(vol: np.ndarray, spacing: Tuple[float, float, float]):
    from skimage.measure import marching_cubes

    verts, faces, _n, _v = marching_cubes(vol.astype(np.uint8), level=0.5, spacing=spacing)
    return verts, faces


def to_model_coords(verts: np.ndarray, origin: Tuple[int, int], mm_px: float) -> np.ndarray:
    """(z, row, col) in mm -> (x, y, z) with columns along +X and rows down -Y,
    positioned where they sat on the plate."""
    z, r, c = verts[:, 0], verts[:, 1], verts[:, 2]
    x = c + (origin[1] - 1) * mm_px
    y = -(r + (origin[0] - 1) * mm_px)
    return np.column_stack([x, y, z]).astype(np.float32)


def simplify(xyz: np.ndarray, faces: np.ndarray, target: int) -> Tuple[np.ndarray, np.ndarray]:
    """Merge the many tiny triangles into fewer, larger ones, keeping the shape.

    At 10 um layers every slice's outline becomes its own ring of triangles:
    tens of millions of them, which no slicer will load. Quadric decimation
    collapses the flat stretches first, so the edges and fine features that
    the layer images carry survive."""
    if target <= 0 or len(faces) <= target:
        return xyz, faces
    import pyfqmr

    s = pyfqmr.Simplify()
    s.setMesh(xyz.astype(np.float64), faces.astype(np.int32))
    s.simplify_mesh(target_count=target, aggressiveness=7, preserve_border=True, verbose=False)
    v, f, _ = s.getMesh()
    return v.astype(np.float32), f


def write_stl(path: Path, xyz: np.ndarray, faces: np.ndarray, name: str = "rebuild") -> None:
    tri = xyz[faces]  # (n, 3, 3)
    normals = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    lengths = np.linalg.norm(normals, axis=1, keepdims=True)
    normals = np.divide(normals, lengths, out=np.zeros_like(normals), where=lengths > 0)
    rec = np.zeros(len(faces), dtype=[("n", "<f4", 3), ("v", "<f4", (3, 3)), ("a", "<u2")])
    rec["n"], rec["v"] = normals, tri
    with open(path, "wb") as f:
        f.write(name.encode()[:80].ljust(80, b"\0"))
        f.write(struct.pack("<I", len(faces)))
        f.write(rec.tobytes())


# ── Main ──────────────────────────────────────────────────────────────────


def main(argv: Optional[Sequence[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("source", choices=["tv", "video"])
    ap.add_argument("path", type=Path, help="capture prefix (tv) or rendered video (video)")
    ap.add_argument("-o", "--out", type=Path, required=True)
    ap.add_argument("--layer-height", type=float, help="mm; default from PREFIX.goo, else 0.01")
    ap.add_argument("--plate", type=float, nargs=2, metavar=("X_MM", "Y_MM"), help="default from .goo, else Mars 5 Ultra")
    ap.add_argument("--z-step", type=int, default=1, help="use every Nth layer (faster, coarser)")
    ap.add_argument("--threshold", type=int, default=128)
    ap.add_argument("--triangles", type=int, default=3_000_000,
                    help="simplify to about this many triangles (0: don't); slicers choke on tens of millions")
    ap.add_argument("--ffmpeg", default="/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg")
    ap.add_argument("--preview", type=Path, help="also write a PNG of the rebuild (front view, then from above)")
    args = ap.parse_args(argv)

    path = args.path.expanduser().resolve()
    goo = None
    if args.source == "tv":
        goo = goo_geometry(Path(str(path) + ".goo"))
    plate = tuple(args.plate) if args.plate else (goo[:2] if goo else PLATE_MM)
    layer_h = args.layer_height or (goo[2] if goo else 0.01)

    if args.source == "tv":
        images, width = tv_layers(path, args.z_step)
    else:
        images, width = video_layers(path, args.z_step, args.ffmpeg)
    mm_px = plate[0] / width
    print(f"{len(images)} layers, {width} px across {plate[0]} mm = {mm_px:.3f} mm/px, "
          f"{layer_h * args.z_step * 1000:.0f} um per slice", file=sys.stderr)

    vol, origin = to_volume(images, args.threshold)
    print(f"volume {vol.shape} ({vol.sum() / 1e6:.1f} M solid voxels)", file=sys.stderr)
    if args.preview:
        preview(vol, (layer_h * args.z_step, mm_px, mm_px), args.preview.expanduser())
        print(f"preview -> {args.preview}", file=sys.stderr)
    verts, faces = surface(vol, (layer_h * args.z_step, mm_px, mm_px))
    xyz = to_model_coords(verts, origin, mm_px)
    before = len(faces)
    xyz, faces = simplify(xyz, faces, args.triangles)
    if len(faces) < before:
        print(f"simplified {before:,} -> {len(faces):,} triangles", file=sys.stderr)
    write_stl(args.out.expanduser(), xyz, faces, f"NAKTV-21 {args.source} rebuild")
    ext = xyz.max(0) - xyz.min(0)
    print(f"{len(faces):,} triangles, {ext[0]:.1f} x {ext[1]:.1f} x {ext[2]:.1f} mm -> {args.out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
