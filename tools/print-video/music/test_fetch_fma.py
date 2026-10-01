"""Tests for fetch_fma.py's licence checks and page parsing. python3 -m unittest -v"""
import unittest

import fetch_fma as f


def page(*licences, footer=""):
    links = "".join(f'<a rel="license" class="x" target="_blank" href="{u}">x</a>' for u in licences)
    return f"<html><body>{links}<footer>{footer}</footer></body></html>"


class Licence(unittest.TestCase):
    def test_cc0_is_accepted(self):
        self.assertEqual(f.licence_of(page("http://creativecommons.org/publicdomain/zero/1.0/")),
                         ("CC0 1.0", "https://creativecommons.org/publicdomain/zero/1.0/"))

    def test_cc_by_is_accepted_with_its_version(self):
        self.assertEqual(f.licence_of(page("https://creativecommons.org/licenses/by/4.0")),
                         ("CC BY 4.0", "https://creativecommons.org/licenses/by/4.0/"))
        self.assertEqual(f.licence_of(page("https://creativecommons.org/licenses/by/3.0/"))[0], "CC BY 3.0")

    def test_nc_nd_and_sa_are_refused(self):
        for kind in ("by-nc", "by-nd", "by-sa", "by-nc-sa", "by-nc-nd"):
            with self.subTest(kind):
                self.assertIsNone(f.licence_of(page(f"https://creativecommons.org/licenses/{kind}/4.0/")))

    def test_cc_by_is_refused_when_only_cc0_will_do(self):
        self.assertIsNone(f.licence_of(page("https://creativecommons.org/licenses/by/4.0/"), cc0_only=True))

    def test_a_cc_link_that_is_not_the_licence_is_ignored(self):
        # A footer or sidebar link isn't a statement of the track's licence.
        footer = '<a href="https://creativecommons.org/publicdomain/zero/1.0/">what is CC0?</a>'
        self.assertIsNone(f.licence_of(page(footer=footer)))

    def test_conflicting_licence_statements_are_refused(self):
        self.assertIsNone(f.licence_of(page("https://creativecommons.org/publicdomain/zero/1.0/",
                                            "https://creativecommons.org/licenses/by-nc/4.0/")))

    def test_the_same_licence_stated_twice_is_fine(self):
        # FMA's track page states it twice: the badge and the RDFa sentence.
        u = "https://creativecommons.org/licenses/by/4.0"
        self.assertEqual(f.licence_of(page(u, u + "/"))[0], "CC BY 4.0")


class Gone(unittest.TestCase):
    def test_a_missing_track_is_noted_and_skipped(self):
        import tempfile, urllib.error
        from pathlib import Path

        class NotFound:
            def text(self, url):
                raise urllib.error.HTTPError(url, 404, "Not Found", {}, None)

        with tempfile.TemporaryDirectory() as d:
            lib = f.Library(Path(d), None)
            self.assertFalse(lib.consider(NotFound(), {"url": "https://x/gone/"}, False))
            self.assertIn("https://x/gone/", lib.checked)
            self.assertIn("http 404", (Path(d) / "checked.jsonl").read_text())


class Pages(unittest.TestCase):
    def test_reads_genre_listing_entries(self):
        blob = ('{&quot;id&quot;:&quot;279067&quot;,&quot;handle&quot;:&quot;ok-today&quot;,'
                '&quot;url&quot;:&quot;https:\\/\\/freemusicarchive.org\\/music\\/a\\/b\\/ok-today\\/&quot;,'
                '&quot;title&quot;:&quot;OK Today&quot;,&quot;artistName&quot;:&quot;1000 Handz&quot;}')
        tracks = f.track_blobs(f'<div class="play-item" data-track-info="{blob}"></div>' * 2)
        self.assertEqual(len(tracks), 1)  # the same track twice counts once
        self.assertEqual(tracks[0]["url"], "https://freemusicarchive.org/music/a/b/ok-today/")

    def test_search_results_are_walked_page_by_page(self):
        blob = ('{&quot;url&quot;:&quot;https:\\/\\/freemusicarchive.org\\/music\\/a\\/b\\/tN\\/&quot;,'
                '&quot;title&quot;:&quot;TN&quot;}')

        class Search:
            def __init__(self):
                self.urls = []

            def text(self, url):
                self.urls.append(url)
                n = len(self.urls)
                return f'<div data-track-info="{blob.replace("N", str(n))}"></div>' if n <= 2 else "<html></html>"

        http = Search()
        tracks = list(f.search_tracks(http, "deep trance"))
        self.assertEqual([t["title"] for t in tracks], ["T1", "T2"])
        self.assertEqual(http.urls[0], "https://freemusicarchive.org/search/?quicksearch=deep+trance&page=1")
        self.assertTrue(http.urls[2].endswith("&page=3"))

    def test_titles_are_cleaned(self):
        self.assertEqual(f.clean_title("Break From Reality ( LoFi , Peaceful ).mp3"), "Break From Reality")
        self.assertEqual(f.clean_title("20 Minute Meditation 7"), "20 Minute Meditation 7")


if __name__ == "__main__":
    unittest.main()
