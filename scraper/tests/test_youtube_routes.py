"""
YouTube speed and fast-fail: one light client, a hard deadline, a circuit breaker, and an opt-in second route.

Run from the scraper/ folder:  python -m unittest discover -s tests -v
"""

import asyncio
import sys
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import errors  # noqa: E402
from cache import CircuitBreaker  # noqa: E402
from errors import ScraperError  # noqa: E402

YT = "https://www.youtube.com/watch?v=jNQXAC9IVRw"
TIKTOK = "https://www.tiktok.com/@scout2015/video/6718335390845095173"

WITH_VIDEO = {
    "id": "abc",
    "title": "ok",
    "formats": [{"format_id": "18", "url": "https://x.googlevideo.com/v", "ext": "mp4", "vcodec": "avc1",
                 "acodec": "mp4a", "height": 360, "protocol": "https"}],
}
NO_VIDEO = {"id": "abc", "title": "nothing", "formats": []}
LEAN = {"player_client": ["android"], "player_skip": ["webpage", "configs", "initial_data", "js"]}


def bot_check():
    from yt_dlp.utils import DownloadError

    return DownloadError("ERROR: [youtube] abc: Sign in to confirm you're not a bot")


class Recorder:
    """Stands in for _extract_info: answers per call and remembers which routes were tried."""

    def __init__(self, *answers):
        self.answers = list(answers)
        self.routes = []

    def __call__(self, url, route=0):
        self.routes.append(route)
        answer = self.answers[min(len(self.routes) - 1, len(self.answers) - 1)]
        if isinstance(answer, Exception):
            raise answer
        return answer


class Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            import main
        except ImportError as exc:  # pragma: no cover
            raise unittest.SkipTest(f"dependencies missing: {exc}")
        cls.main = main

    def setUp(self):
        self.main.INFO_CACHE.clear()
        self.main.NEGATIVE_CACHE.clear()
        self.main.YOUTUBE_BREAKER.reset()

    def tearDown(self):
        self.main.YOUTUBE_BREAKER.reset()


class SpeedSettingTests(Base):
    def test_youtube_uses_the_one_client_that_works_and_skips_the_slow_calls(self):
        self.assertEqual(self.main.YOUTUBE_ROUTES[0], LEAN)
        self.assertEqual(self.main._ydl_options(0)["extractor_args"], {"youtube": LEAN})
        self.assertEqual(self.main.YDL_OPTS["extractor_args"], {"youtube": LEAN})

    def test_the_slow_clients_are_not_in_the_default_route(self):
        # Measured: ios and tv return no formats without a proof-of-origin token and cost about 1.4 s.
        self.assertEqual(len(self.main.YOUTUBE_ROUTES), 1, "the heavy second route must be opt-in")
        self.assertNotIn("ios", self.main.YOUTUBE_ROUTES[0]["player_client"])
        self.assertNotIn("tv", self.main.YOUTUBE_ROUTES[0]["player_client"])

    def test_the_requests_that_only_add_metadata_are_skipped(self):
        skipped = self.main.YOUTUBE_ROUTES[0]["player_skip"]
        for step in ("webpage", "configs", "initial_data", "js"):
            self.assertIn(step, skipped)

    def test_no_download_no_retries_short_socket_timeout(self):
        opts = self.main.YDL_OPTS
        self.assertTrue(opts["skip_download"])
        self.assertEqual(opts["retries"], 0)
        self.assertEqual(opts["extractor_retries"], 0)
        self.assertLessEqual(opts["socket_timeout"], 4)
        self.assertFalse(opts["getcomments"])
        self.assertFalse(opts["writesubtitles"])

    def test_the_hard_limit_is_between_four_and_six_seconds(self):
        self.assertGreaterEqual(self.main.EXTRACTION_TIMEOUT_SECONDS, 4)
        self.assertLessEqual(self.main.EXTRACTION_TIMEOUT_SECONDS, 6)

    def test_the_limit_cannot_be_configured_out_of_the_four_to_six_second_band(self):
        clamp = self.main._extraction_timeout
        self.assertEqual(clamp("60"), 6.0)
        self.assertEqual(clamp("0.1"), 2.0)
        self.assertEqual(clamp("4.5"), 4.5)
        self.assertEqual(clamp(None), 5.0)
        self.assertEqual(clamp(""), 5.0)
        self.assertEqual(clamp("not a number"), 5.0)


class ProxyAndCookieTests(Base):
    def test_proxy_and_cookies_apply_only_when_configured(self):
        self.assertNotIn("proxy", self.main._ydl_options(0))
        with mock.patch.object(self.main, "YTDLP_PROXY", "http://user:pw@proxy.example:8080"):
            self.assertEqual(self.main._ydl_options(0)["proxy"], "http://user:pw@proxy.example:8080")
        cookies = ROOT / "requirements.txt"
        with mock.patch.object(self.main, "YOUTUBE_COOKIES_FILE", str(cookies)):
            self.assertEqual(self.main._ydl_options(0)["cookiefile"], str(cookies))
        with mock.patch.object(self.main, "YOUTUBE_COOKIES_FILE", "/no/such/cookies.txt"):
            self.assertNotIn("cookiefile", self.main._ydl_options(0))

    def test_downloads_through_the_cdn_use_the_same_proxy_and_a_short_connect_timeout(self):
        seen = {}

        class Boom(Exception):
            pass

        def fake_client(*args, **kwargs):
            seen.update(kwargs)
            raise Boom

        with mock.patch.object(self.main, "YTDLP_PROXY", "http://proxy.example:8080"), \
                mock.patch.object(self.main.httpx, "Client", fake_client), \
                mock.patch.object(self.main, "is_allowed_media_url", return_value=True):
            with self.assertRaises(Boom):
                self.main._open_cdn_stream("https://rr1.googlevideo.com/v", None)
        self.assertEqual(seen["proxy"], "http://proxy.example:8080")
        self.assertLessEqual(seen["timeout"].connect, 5.0)


class FastFailTests(Base):
    def resolve(self, url, recorder):
        with mock.patch.object(self.main, "_extract_info", recorder):
            return self.main._resolve_and_extract(url)

    def test_a_youtube_block_is_reported_at_once_without_a_second_attempt(self):
        recorder = Recorder(bot_check(), WITH_VIDEO)
        with self.assertRaises(ScraperError) as ctx:
            self.resolve(YT, recorder)
        self.assertEqual(ctx.exception.code, errors.STREAM_EXPIRED_OR_BLOCKED)
        self.assertEqual(recorder.routes, [0], "no heavy retry on a blocked datacenter IP")

    def test_a_working_lookup_is_a_single_call(self):
        recorder = Recorder(WITH_VIDEO)
        _resolved, info = self.resolve(YT, recorder)
        self.assertEqual(recorder.routes, [0])
        self.assertEqual(info["title"], "ok")

    def test_private_videos_and_timeouts_are_not_retried(self):
        from yt_dlp.utils import DownloadError

        for exc, code in ((DownloadError("ERROR: Private video"), errors.LOGIN_REQUIRED),
                          (DownloadError("ERROR: timed out"), errors.PLATFORM_TIMEOUT)):
            recorder = Recorder(exc)
            with self.assertRaises(ScraperError) as ctx:
                self.resolve(YT, recorder)
            self.assertEqual(ctx.exception.code, code)
            self.assertEqual(recorder.routes, [0])

    def test_the_lookup_carries_a_deadline_that_extractors_can_see(self):
        seen = []

        def spy(url, route=0):
            seen.append(self.main._deadline.get())
            return WITH_VIDEO

        with mock.patch.object(self.main, "_extract_info", spy):
            before = time.monotonic()
            self.main._resolve_and_extract(YT)
        self.assertEqual(len(seen), 1)
        self.assertAlmostEqual(seen[0] - before, self.main.EXTRACTION_TIMEOUT_SECONDS, delta=0.5)


class DeadlineTests(Base):
    def test_yt_dlp_refuses_new_requests_once_the_deadline_has_passed(self):
        ydl = self.main._DeadlineYDL({"quiet": True}, deadline=time.monotonic() - 1)
        with mock.patch.object(self.main.yt_dlp.YoutubeDL, "urlopen", side_effect=AssertionError("a request was sent after the deadline")):
            with self.assertRaises(TimeoutError):
                ydl.urlopen("https://www.youtube.com/")

    def test_before_the_deadline_requests_go_through(self):
        ydl = self.main._DeadlineYDL({"quiet": True}, deadline=time.monotonic() + 60)
        with mock.patch.object(self.main.yt_dlp.YoutubeDL, "urlopen", return_value="RESPONSE") as inner:
            self.assertEqual(ydl.urlopen("https://www.youtube.com/"), "RESPONSE")
        inner.assert_called_once()

    def test_a_stalled_lookup_answers_within_the_limit_and_the_slot_is_freed_when_the_work_ends(self):
        async def scenario():
            finish = threading.Event()

            def stuck(url, route=0):
                finish.wait(10)  # a request that never comes back
                return WITH_VIDEO

            with mock.patch.object(self.main, "_extract_info", stuck), \
                    mock.patch.object(self.main, "EXTRACTION_TIMEOUT_SECONDS", 0.4), \
                    mock.patch.object(self.main, "DEADLINE_GRACE_SECONDS", 0.1):
                started = time.monotonic()
                with self.assertRaises(ScraperError) as ctx:
                    await self.main._acquire_info(YT)
                waited = time.monotonic() - started
                self.assertEqual(ctx.exception.code, errors.PLATFORM_TIMEOUT)
                self.assertLess(waited, 1.0, f"the caller waited {waited:.1f}s")
                self.assertEqual(self.main._active, 1, "the stray thread still counts against the cap")
                finish.set()
                for _ in range(50):
                    if self.main._active == 0:
                        break
                    await asyncio.sleep(0.05)
                self.assertEqual(self.main._active, 0, "the slot must come back once the thread ends")

        asyncio.run(scenario())


class CircuitBreakerTests(Base):
    def test_opens_after_three_failures_and_recovers_after_the_cooldown(self):
        now = [100.0]
        breaker = CircuitBreaker(threshold=3, window=30, cooldown=15, clock=lambda: now[0])
        breaker.record_failure()
        breaker.record_failure()
        self.assertFalse(breaker.is_open())
        breaker.record_failure()
        self.assertTrue(breaker.is_open())
        now[0] += 14
        self.assertTrue(breaker.is_open())
        now[0] += 2
        self.assertFalse(breaker.is_open())

    def test_failures_spread_over_a_long_time_do_not_open_it(self):
        now = [0.0]
        breaker = CircuitBreaker(threshold=3, window=30, cooldown=15, clock=lambda: now[0])
        for _ in range(5):
            breaker.record_failure()
            now[0] += 40
        self.assertFalse(breaker.is_open())

    def test_a_success_closes_it(self):
        breaker = CircuitBreaker(threshold=2)
        breaker.record_failure()
        breaker.record_failure()
        self.assertTrue(breaker.is_open())
        breaker.record_success()
        self.assertFalse(breaker.is_open())

    def test_after_three_blocks_youtube_answers_instantly_without_calling_youtube(self):
        recorder = Recorder(bot_check())
        with mock.patch.object(self.main, "_extract_info", recorder):
            for _ in range(3):
                with self.assertRaises(ScraperError):
                    self.main._resolve_and_extract(YT)
            calls_before = len(recorder.routes)
            started = time.monotonic()
            with self.assertRaises(ScraperError) as ctx:
                self.main._resolve_and_extract(YT)
            instant = time.monotonic() - started
        self.assertEqual(ctx.exception.code, errors.STREAM_EXPIRED_OR_BLOCKED)
        self.assertEqual(len(recorder.routes), calls_before, "the open breaker must not send another request")
        self.assertLess(instant, 0.1)

    def test_stalls_count_too_and_are_answered_as_timeouts_not_as_blocks(self):
        from yt_dlp.utils import DownloadError

        stall = DownloadError("ERROR: [youtube] abc: Failed to extract any player response; please report this issue")
        recorder = Recorder(stall)
        with mock.patch.object(self.main, "_extract_info", recorder):
            for _ in range(3):
                with self.assertRaises(ScraperError) as ctx:
                    self.main._resolve_and_extract(YT)
                self.assertEqual(ctx.exception.code, errors.PLATFORM_TIMEOUT)
            with self.assertRaises(ScraperError) as ctx:
                self.main._resolve_and_extract(YT)
        self.assertEqual(ctx.exception.code, errors.PLATFORM_TIMEOUT, "the open breaker repeats the real reason")
        self.assertEqual(len(recorder.routes), 3)

    def test_a_stall_is_never_remembered_as_a_private_video(self):
        from yt_dlp.utils import DownloadError

        stall = DownloadError("ERROR: [youtube] abc: Failed to extract any player response; please report this issue")
        self.assertEqual(errors.classify_failure(str(stall)), errors.PLATFORM_TIMEOUT)
        self.assertNotIn(errors.PLATFORM_TIMEOUT, self.main.NEGATIVE_CACHEABLE)

    def test_the_breaker_only_guards_youtube(self):
        for _ in range(5):
            self.main.YOUTUBE_BREAKER.record_failure()
        recorder = Recorder(WITH_VIDEO)
        with mock.patch.object(self.main, "_extract_info", recorder):
            _resolved, info = self.main._resolve_and_extract(TIKTOK)
        self.assertEqual(info["title"], "ok")

    def test_a_working_lookup_resets_the_breaker(self):
        self.main.YOUTUBE_BREAKER.record_failure()
        self.main.YOUTUBE_BREAKER.record_failure()
        with mock.patch.object(self.main, "_extract_info", Recorder(WITH_VIDEO)):
            self.main._resolve_and_extract(YT)
        self.main.YOUTUBE_BREAKER.record_failure()
        self.assertFalse(self.main.YOUTUBE_BREAKER.is_open(), "the earlier failures were forgotten")


class OptionalSecondRouteTests(Base):
    """Only for hosts that set YOUTUBE_SECOND_ROUTE=1 (for example behind a residential proxy)."""

    def setUp(self):
        super().setUp()
        patcher = mock.patch.object(self.main, "YOUTUBE_ROUTES", [LEAN, None])
        patcher.start()
        self.addCleanup(patcher.stop)

    def resolve(self, url, recorder, first_route=0):
        with mock.patch.object(self.main, "_extract_info", recorder):
            return self.main._resolve_and_extract(url, first_route)

    def test_second_route_is_yt_dlps_own_client_mix(self):
        self.assertNotIn("extractor_args", self.main._ydl_options(1))
        self.assertIn("extractor_args", self.main._ydl_options(0))

    def test_a_block_on_the_first_route_is_answered_by_the_second(self):
        recorder = Recorder(bot_check(), WITH_VIDEO)
        _resolved, info = self.resolve(YT, recorder)
        self.assertEqual(recorder.routes, [0, 1])
        self.assertEqual(info["title"], "ok")

    def test_an_empty_result_also_tries_the_second_route(self):
        recorder = Recorder(NO_VIDEO, WITH_VIDEO)
        self.resolve(YT, recorder)
        self.assertEqual(recorder.routes, [0, 1])

    def test_when_both_are_blocked_it_stops_after_two_attempts(self):
        recorder = Recorder(bot_check(), bot_check())
        with self.assertRaises(ScraperError) as ctx:
            self.resolve(YT, recorder)
        self.assertEqual(ctx.exception.code, errors.STREAM_EXPIRED_OR_BLOCKED)
        self.assertEqual(recorder.routes, [0, 1])

    def test_starting_on_the_second_route_skips_the_first(self):
        recorder = Recorder(WITH_VIDEO)
        self.resolve(YT, recorder, first_route=1)
        self.assertEqual(recorder.routes, [1])

    def test_other_platforms_never_use_it(self):
        recorder = Recorder(bot_check(), WITH_VIDEO)
        with self.assertRaises(ScraperError):
            self.resolve(TIKTOK, recorder)
        self.assertEqual(recorder.routes, [0])


if __name__ == "__main__":
    unittest.main(verbosity=2)
