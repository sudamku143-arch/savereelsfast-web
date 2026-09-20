"""
Crash resilience on a small (512 MB) host: memory guard, no truncated downloads, and no RAM buffering.

Run from the scraper/ folder:  python -m unittest discover -s tests -v
"""

import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from memory import rss_mb  # noqa: E402

GOOD = "https://www.youtube.com/watch?v=jNQXAC9IVRw"
INFO = {
    "id": "abc",
    "formats": [{"format_id": "18", "url": "https://x.googlevideo.com/v", "ext": "mp4", "vcodec": "avc1",
                 "acodec": "mp4a", "height": 360, "protocol": "https"}],
}


class MemoryReadingTests(unittest.TestCase):
    def test_reads_resident_memory_from_a_linux_status_file(self):
        with tempfile.NamedTemporaryFile("w", suffix=".status", delete=False) as handle:
            handle.write("Name:\tpython\nVmPeak:\t  900000 kB\nVmRSS:\t  204800 kB\nThreads:\t7\n")
        self.assertAlmostEqual(rss_mb(handle.name), 200.0)

    def test_reports_none_where_it_cannot_be_read(self):
        self.assertIsNone(rss_mb("/definitely/not/here"))
        with tempfile.NamedTemporaryFile("w", delete=False) as handle:
            handle.write("no memory line here\n")
        self.assertIsNone(rss_mb(handle.name))


class MemoryGuardTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            import main
            from fastapi.testclient import TestClient
        except ImportError as exc:  # pragma: no cover
            raise unittest.SkipTest(f"dependencies missing: {exc}")
        cls.main = main
        cls.client = TestClient(main.app)

    def setUp(self):
        self.main.INFO_CACHE.clear()
        self.main.YOUTUBE_BREAKER.reset()
        self.main.NEGATIVE_CACHE.clear()

    def test_default_ceiling_leaves_room_below_the_512mb_limit(self):
        self.assertLess(self.main.MEMORY_SOFT_LIMIT_MB, 480)
        self.assertGreater(self.main.MEMORY_SOFT_LIMIT_MB, 200)

    def test_extraction_is_refused_when_memory_stays_high(self):
        boom = mock.Mock(side_effect=AssertionError("extraction started while out of memory"))
        with mock.patch.object(self.main, "rss_mb", return_value=self.main.MEMORY_SOFT_LIMIT_MB + 50), \
                mock.patch.object(self.main, "_extract_info", boom):
            response = self.client.get("/extract", params={"url": GOOD})
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["detail"]["code"], "SERVER_BUSY")
        boom.assert_not_called()

    def test_caches_are_dropped_first_and_work_continues_if_that_was_enough(self):
        self.main.INFO_CACHE.set("something", {"resolved": "x", "info": {}})
        high, low = self.main.MEMORY_SOFT_LIMIT_MB + 50, 100
        with mock.patch.object(self.main, "rss_mb", side_effect=[high, low, low, low]), \
                mock.patch.object(self.main, "_extract_info", return_value=INFO):
            response = self.client.get("/extract", params={"url": GOOD})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIsNone(self.main.INFO_CACHE.get("something"), "cache should have been emptied to free memory")

    def test_streams_are_refused_too(self):
        boom = mock.Mock(side_effect=AssertionError("opened a stream while out of memory"))
        with mock.patch.object(self.main, "rss_mb", return_value=self.main.MEMORY_SOFT_LIMIT_MB + 50), \
                mock.patch.object(self.main, "_open_cdn_stream", boom):
            response = self.client.get("/stream", params={"url": "https://rr1.googlevideo.com/videoplayback"})
        self.assertEqual(response.status_code, 503)
        boom.assert_not_called()
        self.assertEqual(self.main.STREAM_SLOTS.active, 0, "a refused request must not hold a slot")

    def test_healthy_memory_changes_nothing(self):
        with mock.patch.object(self.main, "rss_mb", return_value=80.0), \
                mock.patch.object(self.main, "_extract_info", return_value=INFO):
            self.assertEqual(self.client.get("/extract", params={"url": GOOD}).status_code, 200)

    def test_stats_shows_memory(self):
        with mock.patch.object(self.main, "rss_mb", return_value=123.4):
            body = self.client.get("/stats").json()
        self.assertEqual(body["memory"]["rssMb"], 123.4)

    def test_health_check_never_depends_on_memory(self):
        with mock.patch.object(self.main, "rss_mb", return_value=10_000):
            self.assertEqual(self.client.get("/health").status_code, 200)


class OversizedStreamTests(unittest.TestCase):
    """A download that outgrows the cap must fail loudly, not end as a silently truncated file."""

    @classmethod
    def setUpClass(cls):
        try:
            import main
        except ImportError as exc:  # pragma: no cover
            raise unittest.SkipTest(f"dependencies missing: {exc}")
        cls.main = main

    class Endless:
        def read(self, n):
            return b"\0" * n

    def test_chunks_raises_instead_of_ending_cleanly(self):
        closed = []
        stream = self.main.OpenStream(self.Endless(), None, [lambda: closed.append(True)])
        with mock.patch.object(self.main, "MAX_STREAM_BYTES", 1024 * 1024):
            received = 0
            with self.assertRaises(self.main.StreamTooLarge):
                for chunk in stream.chunks():
                    received += len(chunk)
        self.assertLessEqual(received, 1024 * 1024, "must not deliver more than the cap")
        self.assertEqual(closed, [True], "the upstream connection and the slot must be released")

    def test_memory_use_is_one_chunk_not_the_file(self):
        # The relay reads one CHUNK_SIZE at a time, so its buffer never scales with video size.
        self.assertLessEqual(self.main.CHUNK_SIZE, 256 * 1024)
        self.assertLessEqual(self.main.MAX_CONCURRENT_STREAMS * self.main.CHUNK_SIZE, 8 * 1024 * 1024)

    def test_cache_ttl_is_an_hour_and_within_the_privacy_policy(self):
        self.assertLessEqual(self.main.CACHE_TTL_SECONDS, 90 * 60)
        self.assertGreaterEqual(self.main.CACHE_TTL_SECONDS, 30 * 60)


class StartCommandTests(unittest.TestCase):
    def test_a_failed_yt_dlp_upgrade_does_not_stop_the_service_from_starting(self):
        procfile = (ROOT / "Procfile").read_text(encoding="utf8")
        self.assertIn("||", procfile, "pip failure must not abort the start command")
        self.assertIn("uvicorn main:app", procfile)
        self.assertNotIn("--workers", procfile, "one process: the caches and limits are per process")


if __name__ == "__main__":
    unittest.main(verbosity=2)
