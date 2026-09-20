"""
Caching, concurrency limits, download slots and range streaming.

Run from the scraper/ folder:  python -m unittest discover -s tests -v
"""

import asyncio
import statistics
import sys
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from unittest import mock

import httpx

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import errors  # noqa: E402
from cache import SlotPool, TTLCache, slim_info  # noqa: E402
from errors import ScraperError  # noqa: E402


class FakeClock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


class TTLCacheTests(unittest.TestCase):
    def test_entries_expire_after_the_ttl(self):
        clock = FakeClock()
        cache = TTLCache(max_entries=10, ttl=100, clock=clock)
        cache.set("a", 1)
        clock.now += 99
        self.assertEqual(cache.get("a"), 1)
        clock.now += 2
        self.assertIsNone(cache.get("a"))
        self.assertEqual(len(cache), 0)

    def test_least_recently_used_entry_is_evicted(self):
        cache = TTLCache(max_entries=2, ttl=100)
        cache.set("a", 1)
        cache.set("b", 2)
        cache.get("a")  # touch a, so b is now the oldest
        cache.set("c", 3)
        self.assertEqual(cache.get("a"), 1)
        self.assertIsNone(cache.get("b"))
        self.assertEqual(cache.get("c"), 3)

    def test_per_entry_ttl_invalidate_and_stats(self):
        clock = FakeClock()
        cache = TTLCache(ttl=100, clock=clock)
        cache.set("short", 1, ttl=5)
        cache.set("long", 2)
        clock.now += 10
        self.assertIsNone(cache.get("short"))
        self.assertEqual(cache.get("long"), 2)
        cache.invalidate("long")
        self.assertIsNone(cache.get("long"))
        stats = cache.stats()
        self.assertEqual((stats["hits"], stats["misses"]), (1, 2))
        self.assertAlmostEqual(stats["hitRate"], 1 / 3, places=2)

    def test_is_thread_safe_under_contention(self):
        cache = TTLCache(max_entries=50, ttl=100)

        def worker(offset):
            for i in range(500):
                cache.set(f"k{(i + offset) % 80}", i)
                cache.get(f"k{i % 80}")

        threads = [threading.Thread(target=worker, args=(n,)) for n in range(8)]
        [t.start() for t in threads]
        [t.join() for t in threads]
        self.assertLessEqual(len(cache), 50)


class SlotPoolTests(unittest.TestCase):
    def test_limits_concurrent_leases_and_release_is_idempotent(self):
        pool = SlotPool(2)
        first, second = pool.acquire(), pool.acquire()
        self.assertIsNone(pool.acquire())
        first.release()
        first.release()  # must not free a second slot
        self.assertEqual(pool.active, 1)
        self.assertIsNotNone(pool.acquire())
        self.assertIsNone(pool.acquire())
        second.release()

    def test_leaked_leases_are_reclaimed_after_max_age(self):
        clock = FakeClock()
        pool = SlotPool(1, max_age=60, clock=clock)
        pool.acquire()  # never released: e.g. the client vanished mid-download
        self.assertIsNone(pool.acquire())
        clock.now += 61
        self.assertIsNotNone(pool.acquire())


class SlimInfoTests(unittest.TestCase):
    def test_drops_bulky_fields_but_keeps_what_extraction_needs(self):
        info = {
            "id": "abc", "title": "t", "thumbnail": "https://x/t.jpg", "duration": 9,
            "thumbnails": [{"url": "x"}] * 50, "automatic_captions": {"en": [1] * 100},
            "formats": [{"format_id": "18", "url": "https://x/v", "ext": "mp4", "vcodec": "avc1",
                         "acodec": "mp4a", "height": 360, "width": 202, "http_headers": {"A": "b"},
                         "fragments": [1] * 500, "manifest_url": "https://x/m"}],
            "entries": [{"id": "s1", "formats": [{"url": "https://x/s", "ext": "mp4", "junk": 1}], "tags": ["a"]}],
        }
        slim = slim_info(info)
        self.assertNotIn("thumbnails", slim)
        self.assertNotIn("automatic_captions", slim)
        self.assertEqual(set(slim["formats"][0]), {"format_id", "url", "ext", "vcodec", "acodec", "height", "width", "http_headers"})
        self.assertEqual(slim["entries"][0]["formats"][0], {"url": "https://x/s", "ext": "mp4"})
        self.assertEqual(slim["title"], "t")


def make_info(video_id: str, **extra) -> dict:
    return {
        "id": video_id, "title": f"Video {video_id}", "uploader": "u", "thumbnail": "https://x.cdninstagram.com/t.jpg",
        "duration": 10, "thumbnails": [{"url": "big"}] * 20,
        "formats": [{"format_id": "p", "url": f"https://x.cdninstagram.com/{video_id}.mp4", "ext": "mp4",
                     "vcodec": "avc1", "acodec": "mp4a", "height": 720, "width": 405, "protocol": "https"}],
        **extra,
    }


def url_for(video_id: str, suffix: str = "") -> str:
    return f"https://www.youtube.com/watch?v={video_id}{suffix}"


class AsyncApiCase(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        try:
            import main
        except ImportError as exc:  # pragma: no cover
            self.skipTest(f"dependencies missing: {exc}")
        self.main = main
        main.INFO_CACHE.clear()
        main.YOUTUBE_BREAKER.reset()
        main.NEGATIVE_CACHE.clear()
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url="http://scraper", timeout=30)

    async def asyncTearDown(self):
        await self.client.aclose()

    async def extract(self, url):
        return await self.client.get("/extract", params={"url": url})


class ExtractCacheTests(AsyncApiCase):
    async def test_repeat_requests_skip_ytdlp_and_are_served_instantly(self):
        calls = []

        def fake(url):
            calls.append(url)
            return make_info("viral")

        with mock.patch.object(self.main, "_extract_info", fake):
            first = await self.extract(url_for("viral"))
            timings = []
            for _ in range(30):
                started = time.perf_counter()
                response = await self.extract(url_for("viral"))
                timings.append((time.perf_counter() - started) * 1000)
                self.assertEqual(response.status_code, 200)
                self.assertTrue(response.json()["cached"])

        self.assertFalse(first.json()["cached"])
        self.assertEqual(len(calls), 1, "yt-dlp must run once for identical requests")
        self.assertLess(statistics.median(timings), 50, f"cache hits took {statistics.median(timings):.1f} ms")

    async def test_tracking_parameter_variants_share_one_entry(self):
        calls = []
        with mock.patch.object(self.main, "_extract_info", lambda url: calls.append(url) or make_info("v1")):
            await self.extract(url_for("v1"))
            response = await self.extract(url_for("v1", "&si=abc&utm_source=share&feature=share"))
        self.assertTrue(response.json()["cached"])
        self.assertEqual(len(calls), 1)

    async def test_different_videos_are_cached_independently(self):
        calls = []
        with mock.patch.object(self.main, "_extract_info", lambda url: calls.append(url) or make_info(url[-5:])):
            a = await self.extract(url_for("aaaaa"))
            b = await self.extract(url_for("bbbbb"))
        self.assertEqual(len(calls), 2)
        self.assertNotEqual(a.json()["videoUrl"], b.json()["videoUrl"])

    async def test_entries_expire_and_are_refetched(self):
        clock = FakeClock()
        calls = []
        with mock.patch.object(self.main, "INFO_CACHE", TTLCache(ttl=3600, clock=clock)):
            with mock.patch.object(self.main, "_extract_info", lambda url: calls.append(url) or make_info("v1")):
                await self.extract(url_for("v1"))
                clock.now += 3000
                self.assertTrue((await self.extract(url_for("v1"))).json()["cached"])
                clock.now += 700  # past the 1 h TTL
                self.assertFalse((await self.extract(url_for("v1"))).json()["cached"])
        self.assertEqual(len(calls), 2)

    async def test_stable_failures_are_remembered_but_transient_ones_are_not(self):
        from yt_dlp.utils import DownloadError

        stable, transient = [], []

        def private(url):
            stable.append(url)
            raise DownloadError("ERROR: This video is private")

        def flaky(url):
            transient.append(url)
            raise DownloadError("ERROR: <urlopen error timed out>")

        with mock.patch.object(self.main, "_extract_info", private):
            responses = [await self.extract(url_for("priv")) for _ in range(3)]
        self.assertEqual({r.status_code for r in responses}, {403})
        self.assertEqual(len(stable), 1, "a private post shouldn't hit the platform on every retry")

        with mock.patch.object(self.main, "_extract_info", flaky):
            responses = [await self.extract(url_for("slow")) for _ in range(3)]
        self.assertEqual({r.status_code for r in responses}, {504})
        self.assertEqual(len(transient), 3, "timeouts must be retried, not cached")

    async def test_cached_entries_are_trimmed(self):
        with mock.patch.object(self.main, "_extract_info", lambda url: make_info("v1")):
            await self.extract(url_for("v1"))
        entry = self.main.INFO_CACHE.get(self.main.cache_key(url_for("v1")))
        self.assertNotIn("thumbnails", entry["info"])

    async def test_health_reports_cache_statistics(self):
        with mock.patch.object(self.main, "_extract_info", lambda url: make_info("v1")):
            await self.extract(url_for("v1"))
            await self.extract(url_for("v1"))
        health = (await self.client.get("/stats")).json()
        self.assertEqual(health["cache"]["hits"], 1)
        self.assertGreaterEqual(health["cache"]["size"], 1)
        self.assertIn("limit", health["extractions"])


class ConcurrencyTests(AsyncApiCase):
    async def test_identical_simultaneous_requests_run_one_extraction(self):
        calls = []

        def slow(url):
            calls.append(url)
            time.sleep(0.3)
            return make_info("viral")

        with mock.patch.object(self.main, "_extract_info", slow):
            responses = await asyncio.gather(*[self.extract(url_for("viral")) for _ in range(12)])
        self.assertEqual({r.status_code for r in responses}, {200})
        self.assertEqual(len(calls), 1)

    async def test_simultaneous_extractions_never_exceed_the_limit(self):
        lock = threading.Lock()
        running = peak = 0

        def slow(url):
            nonlocal running, peak
            with lock:
                running += 1
                peak = max(peak, running)
            time.sleep(0.15)
            with lock:
                running -= 1
            return make_info(url[-6:])

        with mock.patch.object(self.main, "MAX_CONCURRENT_EXTRACTIONS", 3), \
                mock.patch.object(self.main, "_extract_info", slow):
            responses = await asyncio.gather(*[self.extract(url_for(f"vid{i:03d}")) for i in range(12)])
        self.assertEqual({r.status_code for r in responses}, {200}, "queued requests must still be served")
        self.assertEqual(peak, 3)

    async def test_overflow_is_rejected_with_503_and_retry_after(self):
        def slow(url):
            time.sleep(0.4)
            return make_info(url[-6:])

        with mock.patch.object(self.main, "MAX_CONCURRENT_EXTRACTIONS", 1), \
                mock.patch.object(self.main, "MAX_QUEUED_EXTRACTIONS", 2), \
                mock.patch.object(self.main, "_extract_info", slow):
            responses = await asyncio.gather(*[self.extract(url_for(f"vid{i:03d}")) for i in range(8)])
            ok = [r for r in responses if r.status_code == 200]
            busy = [r for r in responses if r.status_code == 503]
            self.assertGreaterEqual(len(ok), 1)
            self.assertGreaterEqual(len(busy), 1, "excess requests must be turned away, not queued forever")
            self.assertEqual(len(ok) + len(busy), 8)
            for response in busy:
                self.assertEqual(response.json()["detail"]["code"], "SERVER_BUSY")
                self.assertEqual(response.headers["retry-after"], "5")
            # ...and the service recovers once the burst is over.
            self.assertEqual((await self.extract(url_for("after0"))).status_code, 200)

    async def test_requests_that_wait_too_long_get_503(self):
        def slow(url):
            time.sleep(0.5)
            return make_info(url[-6:])

        with mock.patch.object(self.main, "MAX_CONCURRENT_EXTRACTIONS", 1), \
                mock.patch.object(self.main, "QUEUE_WAIT_SECONDS", 0.1), \
                mock.patch.object(self.main, "_extract_info", slow):
            first, second = await asyncio.gather(self.extract(url_for("slow01")), self.extract(url_for("slow02")))
        self.assertEqual(sorted([first.status_code, second.status_code]), [200, 503])

    async def test_only_stable_failures_are_negatively_cached(self):
        # Overload and transient upstream problems must never be remembered as "this link is broken".
        for code in (errors.SERVER_BUSY, errors.PLATFORM_TIMEOUT, errors.STREAM_EXPIRED_OR_BLOCKED, errors.INVALID_URL):
            self.assertNotIn(code, self.main.NEGATIVE_CACHEABLE)
        for code in (errors.LOGIN_REQUIRED, errors.UNSUPPORTED_POST, errors.EXTRACTION_FAILED):
            self.assertIn(code, self.main.NEGATIVE_CACHEABLE)

    async def test_a_cached_dead_link_is_refreshed_once(self):
        infos = iter([make_info("v1"), make_info("v1", title="fresh")])
        calls = []

        def fake(url, route=0):
            calls.append(url)
            return next(infos)

        opened = []

        def open_from_info(resolved, info, kind, item):
            opened.append(info["title"])
            if len(opened) == 1:
                raise ScraperError(errors.STREAM_EXPIRED_OR_BLOCKED)  # the cached link went stale
            return "STREAM"

        with mock.patch.object(self.main, "_extract_info", fake), \
                mock.patch.object(self.main, "_open_stream_from_info", open_from_info):
            await self.extract(url_for("v1"))  # populates the cache
            result = await self.main._open_stream(url_for("v1"))
        self.assertEqual(result, "STREAM")
        self.assertEqual(opened, ["Video v1", "fresh"])
        self.assertEqual(len(calls), 2, "the stale entry must be re-extracted exactly once")


class RangeCdn:
    """CDN stand-in that honours single byte ranges."""

    def __init__(self, body: bytes):
        self.body = body
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802
                header = self.headers.get("Range")
                data, status = outer.body, 200
                extra = {"Accept-Ranges": "bytes", "Content-Type": "video/mp4"}
                if header and header.startswith("bytes="):
                    start, _, end = header[6:].partition("-")
                    start = int(start or 0)
                    end = int(end) if end else len(outer.body) - 1
                    data, status = outer.body[start:end + 1], 206
                    extra["Content-Range"] = f"bytes {start}-{end}/{len(outer.body)}"
                self.send_response(status)
                for key, value in extra.items():
                    self.send_header(key, value)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *args):
                pass

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        self.base = f"http://127.0.0.1:{self.server.server_port}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class StreamingTests(AsyncApiCase):
    BODY = bytes(range(256)) * 2000  # 512,000 bytes

    async def asyncSetUp(self):
        await super().asyncSetUp()
        allow = mock.patch.object(self.main, "is_allowed_media_url", lambda url: url.startswith("http://127.0.0.1"))
        allow.start()
        self.addCleanup(allow.stop)
        self.cdn = RangeCdn(self.BODY)
        self.addCleanup(self.cdn.close)
        self.pool = SlotPool(2)
        pool_patch = mock.patch.object(self.main, "STREAM_SLOTS", self.pool)
        pool_patch.start()
        self.addCleanup(pool_patch.stop)

    async def test_full_download_has_length_and_range_headers(self):
        response = await self.client.get("/stream", params={"url": f"{self.cdn.base}/v.mp4"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.content, self.BODY)
        self.assertEqual(response.headers["content-length"], str(len(self.BODY)))
        self.assertEqual(response.headers["accept-ranges"], "bytes")

    async def test_range_requests_return_206_with_content_range(self):
        response = await self.client.get(
            "/stream", params={"url": f"{self.cdn.base}/v.mp4"}, headers={"Range": "bytes=1000-1999"}
        )
        self.assertEqual(response.status_code, 206)
        self.assertEqual(response.content, self.BODY[1000:2000])
        self.assertEqual(response.headers["content-range"], f"bytes 1000-1999/{len(self.BODY)}")
        self.assertEqual(response.headers["content-length"], "1000")
        self.assertEqual(response.headers["accept-ranges"], "bytes")

    async def test_open_ended_range_resumes_a_download(self):
        response = await self.client.get(
            "/stream", params={"url": f"{self.cdn.base}/v.mp4"}, headers={"Range": "bytes=500000-"}
        )
        self.assertEqual(response.status_code, 206)
        self.assertEqual(response.content, self.BODY[500000:])

    async def test_malformed_ranges_are_ignored(self):
        for bad in ("bytes=0-1,5-9", "items=0-5", "bytes=abc"):
            with self.subTest(range=bad):
                response = await self.client.get(
                    "/stream", params={"url": f"{self.cdn.base}/v.mp4"}, headers={"Range": bad}
                )
                self.assertEqual(response.status_code, 200)
                self.assertEqual(len(response.content), len(self.BODY))

    async def test_chunks_are_between_64_and_256_kb(self):
        self.assertTrue(64 * 1024 <= self.main.CHUNK_SIZE <= 256 * 1024)

    async def test_slot_is_released_after_the_download_finishes(self):
        await self.client.get("/stream", params={"url": f"{self.cdn.base}/v.mp4"})
        await asyncio.sleep(0.05)
        self.assertEqual(self.pool.active, 0)

    async def test_slot_is_released_when_the_upstream_fails(self):
        response = await self.client.get("/stream", params={"url": f"{self.cdn.base}/v.mp4", "kind": "image"})
        self.assertEqual(response.status_code, 422)  # rejected before a slot is even needed
        self.assertEqual(self.pool.active, 0)

    async def test_downloads_beyond_the_slot_limit_get_503(self):
        held = [self.pool.acquire(), self.pool.acquire()]
        response = await self.client.get("/stream", params={"url": f"{self.cdn.base}/v.mp4"})
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["detail"]["code"], "SERVER_BUSY")
        self.assertEqual(response.headers["retry-after"], "5")
        held[0].release()
        self.assertEqual((await self.client.get("/stream", params={"url": f"{self.cdn.base}/v.mp4"})).status_code, 200)

    async def test_failed_upstream_does_not_leak_a_slot(self):
        # Nothing listens on the discard port, so opening the upstream connection fails.
        response = await self.client.get("/stream", params={"url": "http://127.0.0.1:9/x.mp4"})
        self.assertEqual(response.status_code, 504)
        self.assertEqual(self.pool.active, 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
