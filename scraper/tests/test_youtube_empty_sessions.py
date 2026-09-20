"""
YouTube sometimes serves a session a page with no downloadable formats (the SABR-only experiment) while the next
session is fine. That answer must be retried while the budget lasts, and it must never be remembered: a cached dead
end made one unlucky lookup fail every retry for the whole 3-hour cache lifetime.

Run from the scraper/ folder:  python -m unittest discover -s tests -v
"""

import asyncio
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import errors  # noqa: E402
from errors import ScraperError  # noqa: E402

YT = "https://youtube.com/shorts/pa1AUFySVPs"
INSTAGRAM = "https://www.instagram.com/p/AbC_123xyz/"

EMPTY = {"id": "pa1AUFySVPs", "title": "t", "formats": [], "_messages": [
    "[youtube] pa1AUFySVPs: Some android client https formats have been skipped as they are missing a URL. YouTube may have enabled the SABR-only streaming experiment for the current session."]}
GOOD = {"id": "pa1AUFySVPs", "title": "t", "formats": [
    {"format_id": "18", "url": "https://rr1.googlevideo.com/videoplayback?id=abc", "ext": "mp4", "vcodec": "avc1", "acodec": "mp4a", "height": 360, "protocol": "https"}]}


class Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            import main
        except ImportError as exc:  # pragma: no cover
            raise unittest.SkipTest(f"dependencies missing: {exc}")
        cls.main = main

    def setUp(self):
        m = self.main
        m.INFO_CACHE.clear()
        m.NEGATIVE_CACHE.clear()
        m.YOUTUBE_BREAKER.reset()
        for patch in (
            mock.patch.object(m, "YOUTUBE_COOKIES_DEFAULT_PATH", "/no/such/place.txt"),
            mock.patch.dict(os.environ, {"YOUTUBE_COOKIES_FILE": "", "SCRAPER_SHARED_SECRET": "", "SCRAPER_REQUIRE_SECRET": "", "YOUTUBE_SECOND_ROUTE": "1"}),
        ):
            patch.start()
            self.addCleanup(patch.stop)

    def stub(self, *answers):
        calls = []

        def fake(url, route=0):
            calls.append(route)
            answer = answers[min(len(calls), len(answers)) - 1]
            if isinstance(answer, Exception):
                raise answer
            return dict(answer)

        return mock.patch.object(self.main, "_extract_info", fake), calls


class RetryTests(Base):
    def test_an_empty_answer_is_asked_again_and_a_later_session_wins(self):
        patch, calls = self.stub(EMPTY, EMPTY, GOOD)
        with patch:
            _, info = self.main._resolve_and_extract(YT)
        self.assertTrue(self.main._has_download(info))
        self.assertEqual(calls, [0, 1, 0], "both routes, then the first again")

    def test_it_gives_up_after_two_passes_and_keeps_the_explanation(self):
        patch, calls = self.stub(EMPTY)
        with patch:
            _, info = self.main._resolve_and_extract(YT)
        self.assertEqual(calls, [0, 1, 0, 1])
        self.assertFalse(self.main._has_download(info))
        self.assertTrue(info["_messages"])

    def test_an_error_still_tries_each_route_only_once(self):
        patch, calls = self.stub(ScraperError(errors.STREAM_EXPIRED_OR_BLOCKED))
        with patch, self.assertRaises(ScraperError):
            self.main._resolve_and_extract(YT)
        self.assertEqual(calls, [0, 1])

    def test_other_platforms_are_asked_once(self):
        patch, calls = self.stub(EMPTY)
        with patch:
            self.main._resolve_and_extract(INSTAGRAM)
        self.assertEqual(calls, [0])


class NotRememberedTests(Base):
    def acquire(self, url):
        return asyncio.run(self.main._acquire_info(url))

    def test_a_youtube_dead_end_is_not_cached(self):
        patch, calls = self.stub(EMPTY)
        with patch:
            self.acquire(YT)
            first = len(calls)
            _, _, cached = self.acquire(YT)
        self.assertFalse(cached)
        self.assertGreater(len(calls), first, "the second request asked YouTube again")
        self.assertEqual(len(self.main.INFO_CACHE._data) if hasattr(self.main.INFO_CACHE, "_data") else 0, 0)

    def test_after_an_unlucky_session_the_next_request_can_succeed(self):
        patch, calls = self.stub(EMPTY, EMPTY, EMPTY, EMPTY, GOOD)
        with patch:
            _, info, _ = self.acquire(YT)
            self.assertFalse(self.main._has_download(info))
            _, info, _ = self.acquire(YT)
        self.assertTrue(self.main._has_download(info))

    def test_a_good_youtube_result_is_still_cached_for_three_hours(self):
        patch, calls = self.stub(GOOD)
        with patch:
            self.acquire(YT)
            _, _, cached = self.acquire(YT)
        self.assertTrue(cached)
        self.assertEqual(calls, [0])

    def test_other_platforms_keep_caching_what_they_found(self):
        patch, calls = self.stub(EMPTY)
        with patch:
            self.acquire(INSTAGRAM)
            _, _, cached = self.acquire(INSTAGRAM)
        self.assertTrue(cached)


if __name__ == "__main__":
    unittest.main()
