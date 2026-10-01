"""Tests for rebuild.py. Need numpy and scikit-image: run with the venv on phi.

    venv/bin/python -m unittest test_rebuild -v
"""
import struct
import tempfile
import unittest
from pathlib import Path

try:
    import numpy as np
    import skimage  # noqa: F401

    import rebuild
except ImportError:  # pragma: no cover - the stdlib-only machines
    rebuild = None


@unittest.skipIf(rebuild is None, "needs numpy and scikit-image")
class Rebuild(unittest.TestCase):
    def block_layers(self):
        """A 10 x 5 mm block, 2 mm tall (200 layers at 10 um), at 1 mm/px."""
        img = np.zeros((20, 40), np.uint8)
        img[5:10, 10:20] = 255  # rows 5-9, cols 10-19
        return [img] * 200

    def test_a_block_comes_back_the_right_size_and_place(self):
        vol, origin = rebuild.to_volume(self.block_layers())
        self.assertEqual(origin, (5, 10))
        verts, faces = rebuild.surface(vol, (0.01, 1.0, 1.0))
        xyz = rebuild.to_model_coords(verts, origin, 1.0)
        size = xyz.max(0) - xyz.min(0)
        # Marching cubes puts the surface half a voxel inside the outer voxels.
        np.testing.assert_allclose(size, [10.0, 5.0, 2.0], atol=1.01)
        self.assertAlmostEqual(float(xyz[:, 0].min()), 9.5, delta=0.6)  # column 10, 1 mm/px
        self.assertLess(float(xyz[:, 1].max()), 0)  # rows run down -Y

    def test_writes_a_valid_binary_stl(self):
        vol, origin = rebuild.to_volume(self.block_layers())
        verts, faces = rebuild.surface(vol, (0.01, 1.0, 1.0))
        xyz = rebuild.to_model_coords(verts, origin, 1.0)
        with tempfile.TemporaryDirectory() as d:
            out = Path(d) / "b.stl"
            rebuild.write_stl(out, xyz, faces)
            data = out.read_bytes()
        n = struct.unpack("<I", data[80:84])[0]
        self.assertEqual(n, len(faces))
        self.assertEqual(len(data), 84 + 50 * n)

    def test_triangles_face_outwards(self):
        # Inside-out triangles slice to nothing: Chitubox showed an empty plate.
        # Outward-facing triangles give the mesh a positive signed volume.
        vol, origin = rebuild.to_volume(self.block_layers())
        verts, faces = rebuild.surface(vol, (0.01, 1.0, 1.0))
        xyz = rebuild.to_model_coords(verts, origin, 1.0)
        faces = rebuild.face_outwards(xyz, faces)
        tri = xyz[faces].astype(np.float64)
        volume = np.einsum("ij,ij->i", tri[:, 0], np.cross(tri[:, 1], tri[:, 2])).sum() / 6
        self.assertGreater(volume, 0)

    def test_empty_layers_are_refused(self):
        with self.assertRaises(SystemExit):
            rebuild.to_volume([np.zeros((4, 4), np.uint8)] * 3)


if __name__ == "__main__":
    unittest.main()
