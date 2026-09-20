"""
The lightweight yt-dlp configuration and the YouTube fail-fast timings.

Run from the scraper/ folder:  python -m unittest discover -s tests -v
"""

import sys
import time
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

YT = "https://www.youtube.com/watch?v=jNQXAC9IVRw"
TIKTOK = "https://www.tiktok.com/@scout2015/video/6718335390845095173"


class Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            import main
        except ImportError as exc:  # pragma: no cover
            raise unittest.SkipTest(f"dependencies missing: {exc}")
        cls.main = main


class LightweightFlagTests(Base):
    def test_exactly_the_flags_that_keep_a_lookup_light(self):
        opts = self.main.YDL_OPTS
        self.assertIs(opts["extract_flat"], False)
        self.assertIs(opts["skip_download"], True)
        self.assertIs(opts["noplaylist"], True)
        self.assertIs(opts["getcomments"], False)
        self.assertIs(opts["writesubtitles"], False)
        self.assertIs(opts["writeautomaticsub"], False)
        self.assertIs(opts["check_formats"], False)  # no probing of every format URL
        self.assertEqual(opts["retries"], 0)
        self.assertEqual(opts["extractor_retries"], 0)
        self.assertIs(opts["cachedir"], False)

    def test_no_download_of_anything_but_metadata(self):
        opts = self.main.YDL_OPTS
        for key in ("writethumbnail", "writeinfojson", "writedescription", "download_archive"):
            self.assertFalse(opts.get(key), key)

    def test_the_cache_keeps_60_minutes_and_stays_bounded(self):
        self.assertEqual(self.main.CACHE_TTL_SECONDS, 3600)
        self.assertLessEqual(self.main.CACHE_MAX_ENTRIES, 1000)

    def test_the_memory_ceiling_is_400_mb(self):
        self.assertEqual(self.main.MEMORY_SOFT_LIMIT_MB, 400)


class TimingTests(Base):
    def capture_options(self, url):
        seen = {}

        class Fake:
            def __init__(self, params, deadline=None):
                seen.update(params)

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

            def extract_info(self, url, download=False):
                return {"id": "x", "formats": []}

        with mock.patch.object(self.main, "_DeadlineYDL", Fake), mock.patch.object(self.main.yt_dlp, "YoutubeDL", Fake):
            token = self.main._deadline.set(time.monotonic() + 5)
            try:
                self.main._extract_info(url)
            finally:
                self.main._deadline.reset(token)
        return seen

    def test_youtube_gives_up_on_a_silent_connection_in_under_four_seconds(self):
        self.assertLess(self.main.YOUTUBE_SOCKET_TIMEOUT, 4)
        self.assertEqual(self.capture_options(YT)["socket_timeout"], self.main.YOUTUBE_SOCKET_TIMEOUT)

    def test_other_platforms_keep_the_slightly_longer_socket_timeout(self):
        self.assertEqual(self.capture_options(TIKTOK)["socket_timeout"], self.main.YDL_OPTS["socket_timeout"])

    def test_a_youtube_stall_is_answered_within_the_limit(self):
        # end to end through the guarded runner: the work ignores everything, the caller still gets an answer
        import asyncio
        import threading

        async def scenario():
            release = threading.Event()

            def stuck(url, route=0):
                release.wait(10)

            with mock.patch.object(self.main, "_extract_info", stuck):
                started = time.monotonic()
                with self.assertRaises(self.main.ScraperError) as ctx:
                    await self.main._acquire_info(YT)
                elapsed = time.monotonic() - started
            release.set()
            self.assertEqual(ctx.exception.code, "PLATFORM_TIMEOUT")
            self.assertLessEqual(elapsed, self.main.EXTRACTION_TIMEOUT_SECONDS + self.main.DEADLINE_GRACE_SECONDS + 0.5)

        self.main.YOUTUBE_BREAKER.reset()
        self.main.INFO_CACHE.clear()
        asyncio.run(scenario())
        self.main.YOUTUBE_BREAKER.reset()


if __name__ == "__main__":
    unittest.main(verbosity=2)
