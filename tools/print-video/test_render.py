"""Tests for render.py's pure logic. Run: python3 -m unittest -v (from this folder)."""
import datetime as dt
import tempfile
import unittest
from pathlib import Path

import render
from render import Part, Segment, Status, Track


def status(t, layer, label="Exposing", total=100):
    return Status(t=t, label=label, filename="calbits2.goo", layer=layer, total_layers=total,
                  percent=layer, remaining_ms=3_600_000 - t * 1000, total_ms=7_200_000)


class LegacyLog(unittest.TestCase):
    def test_reads_part_start_times_on_the_capture_day(self):
        starts = render.parse_legacy_log(
            "00:40:44 part 1 -> /x/a-part01.mkv (pid 1)\n", dt.date(2026, 9, 29))
        self.assertEqual(starts[1], dt.datetime(2026, 9, 29, 0, 40, 44).timestamp())

    def test_rolls_over_midnight(self):
        starts = render.parse_legacy_log(
            "23:59:50 part 1 -> a\n00:00:10 part 2 -> b\n", dt.date(2026, 9, 28))
        self.assertEqual(starts[2] - starts[1], 20)


class Segments(unittest.TestCase):
    def test_cuts_the_range_out_of_one_part(self):
        [s] = render.plan_segments([Part(Path("a"), 100.0, 1000.0)], 150.0, 250.0)
        self.assertEqual((s.wall_start, s.wall_end, s.out_start), (150.0, 250.0, 0.0))

    def test_lays_parts_end_to_end_and_skips_the_gap(self):
        parts = [Part(Path("a"), 0.0, 100.0), Part(Path("b"), 130.0, 100.0)]
        segs = render.plan_segments(parts, 50.0, 180.0)
        self.assertEqual([(s.wall_start, s.wall_end, s.out_start) for s in segs],
                         [(50.0, 100.0, 0.0), (130.0, 180.0, 50.0)])
        self.assertEqual(render.wall_to_out(segs, 140.0), 60.0)
        self.assertIsNone(render.wall_to_out(segs, 110.0))  # the gap

    def test_a_growing_part_runs_to_the_next_start(self):
        parts = [Part(Path("a"), 0.0, None), Part(Path("b"), 60.0, None)]
        segs = render.plan_segments(parts, 0.0, 90.0)
        self.assertEqual([s.length for s in segs], [60.0, 30.0])


class Formatting(unittest.TestCase):
    def test_durations_as_the_tv_shows_them(self):
        self.assertEqual(render.format_duration_ms(30_294_737), "08:24")
        self.assertEqual(render.format_duration_ms(None), render.UNKNOWN)

    def test_titles_lose_their_parenthetical_like_the_tv(self):
        self.assertEqual(render.trim_parenthetical("Butterflies (Extended Mix)"), "Butterflies")

    def test_long_values_are_cut_with_an_ellipsis(self):
        out = render.truncate("x" * 200, render.VALUE_PX)
        self.assertTrue(out.endswith("…"))
        self.assertLess(len(out), 200)
        self.assertEqual(render.truncate("Clouds", render.VALUE_PX), "Clouds")

    def test_ass_times(self):
        self.assertEqual(render.ass_time(3725.456), "1:02:05.46")


class Events(unittest.TestCase):
    def test_merges_identical_samples_into_one_event(self):
        events = render.merge_runs([(0, "a"), (1, "a"), (2, "b"), (3, "b")], 10)
        self.assertEqual([(e.start, e.end, e.text) for e in events], [(0, 2, "a"), (2, 10, "b")])

    def test_status_is_delayed_by_the_offset(self):
        segs = [Segment(Part(Path("a"), 0.0, 100.0), 0.0, 100.0, 0.0)]
        head, _ = render.status_events([status(10, 5, "Lifting"), status(12, 5, "Dropping")], segs, 2.0, 100)
        self.assertEqual([round(e.start) for e in head], [12, 14])
        self.assertIn("Dropping", head[1].text)

    def test_music_fields_follow_the_playlist(self):
        a = Track(Path("a.mp3"), 60, "HoliznaCC0", "Clouds")
        b = Track(Path("b.mp3"), 60, "John Bartmann", "sanza-waves (master)")
        events = render.music_events(render.playlist_timeline([a, b], 100), 100)
        self.assertEqual([(e.start, e.end) for e in events], [(0, 60), (60, 100)])
        self.assertIn("HoliznaCC0", events[0].text)
        self.assertIn("sanza-waves", events[1].text)
        self.assertNotIn("(master)", events[1].text)


class Description(unittest.TestCase):
    def tracks(self):
        a = Track(Path("a.mp3"), 70, "HoliznaCC0", "Clouds", "CC0 1.0",
                  "https://freemusicarchive.org/music/holiznacc0/lo-fi-and-chill/clouds/")
        b = Track(Path("b.mp3"), 70, "John Bartmann", "sanza-waves", "CC0 1.0",
                  "https://freemusicarchive.org/music/John_Bartmann/straylight/sanza-waves/")
        return a, b

    def test_credits_by_album_then_a_chapter_tracklist(self):
        a, b = self.tracks()
        text = render.description(render.playlist_timeline([a, b], 200), "Intro.")
        self.assertTrue(text.startswith("Intro.\n"))
        self.assertIn("Music (all CC0 1.0)", text)
        self.assertIn("HoliznaCC0: https://freemusicarchive.org/music/holiznacc0/lo-fi-and-chill/", text)
        self.assertNotIn("/clouds/", text)  # per-track links go in the comment
        self.assertIn("00:00 HoliznaCC0 \u2013 Clouds", text)
        self.assertIn("01:10 John Bartmann \u2013 sanza-waves", text)
        self.assertIn("02:20 HoliznaCC0 \u2013 Clouds", text)

    def test_comments_carry_every_track_link_once_and_split_under_the_cap(self):
        a, b = self.tracks()
        [c] = render.comments(render.playlist_timeline([a, b], 200))
        self.assertEqual(c.count("/clouds/"), 1)
        many = [Track(Path(f"{i}.mp3"), 60, "A", f"T{i}", "CC0 1.0", "https://x/" + "y" * 200) for i in range(100)]
        chunks = render.comments(render.playlist_timeline(many, 6000))
        self.assertGreater(len(chunks), 1)
        self.assertTrue(all(len(c) <= render.COMMENT_LIMIT for c in chunks))

    def test_hour_long_videos_get_hours_in_their_timestamps(self):
        self.assertEqual(render.clock(3725), "1:02:05")


class EventLog(unittest.TestCase):
    def test_events_give_exact_boundaries_and_override_the_samples(self):
        samples = [status(10, 5, "Lifting"), status(11, 5, "Lifting"), status(12, 5, "Lifting")]
        events = [(10.4, "Dropping", 6), (11.7, "Exposing", 6)]
        merged = render.merge_events(samples, events)
        self.assertEqual([(s.t, s.label, s.layer) for s in merged],
                         [(10, "Lifting", 5), (10.4, "Dropping", 6), (11, "Dropping", 6),
                          (11.7, "Exposing", 6), (12, "Exposing", 6)])
        self.assertEqual(merged[1].remaining_ms, samples[0].remaining_ms)

    def test_no_event_log_leaves_the_samples_alone(self):
        samples = [status(10, 5)]
        self.assertEqual(render.merge_events(samples, []), samples)


class MusicOrder(unittest.TestCase):
    def test_plays_in_manifest_order_not_by_name(self):
        import json, shutil
        if not shutil.which("ffprobe"):
            self.skipTest("needs ffprobe")
        with tempfile.TemporaryDirectory() as d:
            for name in ("a.mp3", "b.mp3"):
                import subprocess
                subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "anullsrc", "-t", "1",
                                str(Path(d) / name)], check=True)
            (Path(d) / "tracks.json").write_text(json.dumps([
                {"file": "b.mp3", "artist": "B", "title": "Bee"},
                {"file": "a.mp3", "artist": "A", "title": "Ay"}]))
            tracks = render.read_tracks(Path(d), "ffprobe")
        self.assertEqual([t.title for t in tracks], ["Bee", "Ay"])


class Playlist(unittest.TestCase):
    def test_loops_until_the_video_is_covered(self):
        tracks = [Track(Path("a"), 40, "", "a"), Track(Path("b"), 40, "", "b")]
        timeline = render.playlist_timeline(tracks, 100)
        self.assertEqual([(at, t.title) for at, t in timeline], [(0, "a"), (40, "b"), (80, "a")])


class Layers(unittest.TestCase):
    def test_changes_start_at_zero_with_the_layer_already_showing(self):
        segs = [Segment(Part(Path("a"), 0.0, 100.0), 20.0, 100.0, 0.0)]
        statuses = [status(10, 3), status(25, 4), status(30, 4), status(40, 5)]
        self.assertEqual(render.layer_changes(statuses, segs, 0.0), [(0.0, 3), (5.0, 4), (20.0, 5)])

    def test_concat_script_holds_each_layer_for_its_time(self):
        with tempfile.TemporaryDirectory() as d:
            for n in (3, 4):
                (Path(d) / f"{n:04d}.png").write_bytes(b"x")
            script = render.layer_concat([(0.0, 3), (5.0, 4)], Path(d), 12.0)
        lines = script.splitlines()
        self.assertEqual(lines[0], "ffconcat version 1.0")
        self.assertIn("duration 5.000", lines)
        self.assertIn("duration 7.000", lines)
        self.assertTrue(lines[-1].endswith("0004.png'"))

    def test_a_missing_layer_falls_back_to_the_one_before(self):
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "0003.png").write_bytes(b"x")
            self.assertEqual(render.layer_path(Path(d), 5).name, "0003.png")

    def test_trimming_by_layer_finds_when_it_began(self):
        self.assertEqual(render.layer_time([status(1, 3), status(2, 4), status(3, 5)], 4), 2)


if __name__ == "__main__":
    unittest.main()
