"""
YouTube: route plan (with and without cookies), timeouts, cookie handling, the circuit breaker, and
structured error answers.

Run from the scraper/ folder:  python -m unittest discover -s tests -v
"""

import asyncio
import os
import stat
import sys
import tempfile
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
FULL = {"player_client": ["android", "ios", "web_creator"]}


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


def cookie_file(text: str = "# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t2000000000\tSID\tvalue\n") -> str:
    handle, path = tempfile.mkstemp(suffix="-cookies.txt")
    with os.fdopen(handle, "w") as out:
        out.write(text)
    return path


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
        # a machine that happens to have /etc/secrets/youtube_cookies.txt must not change these tests
        patcher = mock.patch.object(self.main, "YOUTUBE_COOKIES_DEFAULT_PATH", "/no/such/place/youtube_cookies.txt")
        patcher.start()
        self.addCleanup(patcher.stop)
        env = mock.patch.dict(os.environ, {"YOUTUBE_COOKIES_FILE": "", "YOUTUBE_SECOND_ROUTE": "1"})
        env.start()
        self.addCleanup(env.stop)

    def tearDown(self):
        self.main.YOUTUBE_BREAKER.reset()

    def leftover_copies(self) -> set[str]:
        return {n for n in os.listdir(tempfile.gettempdir()) if n.startswith("srf-ytc-")}


class ClientSettingTests(Base):
    def test_the_two_routes_are_exactly_the_lean_one_and_the_requested_list(self):
        self.assertEqual(self.main.YOUTUBE_LEAN, LEAN)
        self.assertEqual(self.main.YOUTUBE_FULL, FULL, "android, ios, web_creator, as requested")
        self.assertEqual(self.main.YDL_OPTS["extractor_args"], {"youtube": LEAN})

    def test_without_cookies_the_fast_route_goes_first_and_the_full_list_is_the_fallback(self):
        self.assertEqual(self.main._youtube_route_plan(), [(LEAN, False), (FULL, False)])
        self.assertEqual(self.main._ydl_options(0)["extractor_args"], {"youtube": LEAN})
        self.assertEqual(self.main._ydl_options(1)["extractor_args"], {"youtube": FULL})
        self.assertEqual(self.main._ydl_options(9)["extractor_args"], {"youtube": FULL}, "out of range clamps to the last")

    def test_with_cookies_the_full_list_goes_first_because_android_cannot_use_cookies(self):
        path = cookie_file()
        try:
            with mock.patch.dict(os.environ, {"YOUTUBE_COOKIES_FILE": path}):
                self.assertEqual(self.main._youtube_route_plan(), [(FULL, True), (LEAN, False)])
                self.assertEqual(self.main._ydl_options(0)["extractor_args"], {"youtube": FULL})
        finally:
            os.unlink(path)

    def test_the_second_route_can_be_switched_off(self):
        with mock.patch.dict(os.environ, {"YOUTUBE_SECOND_ROUTE": "0"}):
            self.assertEqual(self.main._youtube_route_plan(), [(LEAN, False)])

    def test_the_slow_clients_are_never_in_the_first_attempt_without_cookies(self):
        first_args, _ = self.main._youtube_route_plan()[0]
        self.assertEqual(first_args["player_client"], ["android"])


class TimeoutSettingTests(Base):
    def capture_options(self, url):
        seen = {}

        class Fake:
            def __init__(self, params, deadline=None, trace=None):
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

    def test_youtube_requests_get_8_seconds_and_one_retry(self):
        seen = self.capture_options(YT)
        self.assertEqual(seen["socket_timeout"], 8)
        self.assertEqual(seen["retries"], 1)
        self.assertEqual(seen["extractor_retries"], 1)

    def test_other_platforms_keep_the_short_no_retry_settings(self):
        seen = self.capture_options(TIKTOK)
        self.assertEqual(seen["socket_timeout"], 4)
        self.assertEqual(seen["retries"], 0)
        self.assertEqual(seen["extractor_retries"], 0)

    def test_the_lightweight_flags_are_still_on(self):
        seen = self.capture_options(YT)
        self.assertIs(seen["skip_download"], True)
        self.assertIs(seen["noplaylist"], True)
        self.assertIs(seen["extract_flat"], False)
        self.assertIs(seen["getcomments"], False)

    def test_a_youtube_lookup_may_take_longer_than_the_8_second_socket_timeout(self):
        # otherwise the socket timeout could never take effect before the whole lookup is cut off
        self.assertGreater(self.main.YOUTUBE_EXTRACTION_TIMEOUT_SECONDS, self.main.YOUTUBE_SOCKET_TIMEOUT)
        self.assertLessEqual(self.main.YOUTUBE_EXTRACTION_TIMEOUT_SECONDS, 15)

    def test_other_platforms_stay_inside_the_four_to_six_second_limit(self):
        self.assertGreaterEqual(self.main.EXTRACTION_TIMEOUT_SECONDS, 4)
        self.assertLessEqual(self.main.EXTRACTION_TIMEOUT_SECONDS, 6)
        self.assertEqual(self.main._extraction_budget(TIKTOK), self.main.EXTRACTION_TIMEOUT_SECONDS)
        self.assertEqual(self.main._extraction_budget(YT), self.main.YOUTUBE_EXTRACTION_TIMEOUT_SECONDS)
        self.assertEqual(self.main._extraction_budget("https://youtu.be/jNQXAC9IVRw"), self.main.YOUTUBE_EXTRACTION_TIMEOUT_SECONDS)

    def test_the_limits_cannot_be_configured_out_of_their_bands(self):
        clamp = self.main._extraction_timeout
        self.assertEqual(clamp("60"), 6.0)
        self.assertEqual(clamp("0.1"), 2.0)
        self.assertEqual(clamp("nonsense"), 5.0)
        self.assertEqual(clamp("60", 10.0, 6.0, 15.0), 15.0)
        self.assertEqual(clamp("1", 10.0, 6.0, 15.0), 6.0)
        self.assertEqual(clamp(None, 10.0, 6.0, 15.0), 10.0)


class CookieTests(Base):
    def test_the_render_secret_path_is_the_default(self):
        source = (ROOT / "main.py").read_text(encoding="utf8")
        self.assertIn('YOUTUBE_COOKIES_DEFAULT_PATH = "/etc/secrets/youtube_cookies.txt"', source)

    def test_a_file_at_the_default_path_is_used_without_any_setting(self):
        path = cookie_file()
        try:
            with mock.patch.object(self.main, "YOUTUBE_COOKIES_DEFAULT_PATH", path):
                self.assertEqual(self.main._youtube_cookie_source(), path)
        finally:
            os.unlink(path)

    def test_no_file_means_no_cookies(self):
        self.assertIsNone(self.main._youtube_cookie_source())

    def test_the_environment_setting_wins_over_the_default_path(self):
        default, chosen = cookie_file(), cookie_file()
        try:
            with mock.patch.object(self.main, "YOUTUBE_COOKIES_DEFAULT_PATH", default), \
                    mock.patch.dict(os.environ, {"YOUTUBE_COOKIES_FILE": chosen}):
                self.assertEqual(self.main._youtube_cookie_source(), chosen)
        finally:
            os.unlink(default)
            os.unlink(chosen)

    def test_a_missing_environment_file_falls_back_to_the_default_path(self):
        default = cookie_file()
        try:
            with mock.patch.object(self.main, "YOUTUBE_COOKIES_DEFAULT_PATH", default), \
                    mock.patch.dict(os.environ, {"YOUTUBE_COOKIES_FILE": "/no/such/file.txt"}):
                self.assertEqual(self.main._youtube_cookie_source(), default)
        finally:
            os.unlink(default)

    def test_yt_dlp_gets_a_private_writable_copy_never_the_read_only_original(self):
        source = cookie_file("# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t2000000000\tSID\tsecret-value\n")
        os.chmod(source, stat.S_IREAD)  # how Render mounts /etc/secrets (yt-dlp fails on a file like this: checked)
        before = self.leftover_copies()
        try:
            with self.main._private_cookie_copy(source) as copy:
                self.assertNotEqual(copy, source)
                self.assertEqual(Path(copy).read_text(), Path(source).read_text())
                with open(copy, "a") as writable:  # yt-dlp saves its cookie jar back on close
                    writable.write("# rotated\n")
                if os.name == "posix":
                    self.assertEqual(stat.S_IMODE(os.stat(copy).st_mode), 0o600, "only this process may read it")
            self.assertFalse(os.path.exists(copy), "the copy is deleted after the lookup")
            self.assertEqual(self.leftover_copies(), before)
            self.assertNotIn("rotated", Path(source).read_text(), "the original is never modified")
        finally:
            os.chmod(source, stat.S_IWRITE | stat.S_IREAD)
            os.unlink(source)

    def test_two_lookups_never_share_a_cookie_file(self):
        source = cookie_file()
        try:
            with self.main._private_cookie_copy(source) as first, self.main._private_cookie_copy(source) as second:
                self.assertNotEqual(first, second)
        finally:
            os.unlink(source)

    def test_an_unreadable_source_means_the_lookup_goes_on_without_cookies(self):
        source = cookie_file()
        try:
            with mock.patch.object(self.main.shutil, "copyfile", side_effect=PermissionError("denied")):
                with self.assertLogs("uvicorn.error", level="WARNING"):
                    with self.main._private_cookie_copy(source) as copy:
                        self.assertIsNone(copy)
            self.assertEqual(self.leftover_copies(), set())
        finally:
            os.unlink(source)

    def test_no_source_yields_nothing(self):
        with self.main._private_cookie_copy(None) as copy:
            self.assertIsNone(copy)

    def test_only_a_youtube_lookup_that_wants_cookies_receives_them(self):
        source = cookie_file()
        seen = []

        class Fake:
            def __init__(self, params, deadline=None, trace=None):
                seen.append(params.get("cookiefile"))

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

            def extract_info(self, url, download=False):
                return {"id": "x", "formats": []}

        try:
            with mock.patch.dict(os.environ, {"YOUTUBE_COOKIES_FILE": source}), \
                    mock.patch.object(self.main, "_DeadlineYDL", Fake), mock.patch.object(self.main.yt_dlp, "YoutubeDL", Fake):
                self.main._extract_info(YT, 0)      # with cookies configured, route 0 is the full list + cookies
                self.main._extract_info(YT, 1)      # the fallback is the anonymous lean route
                self.main._extract_info(TIKTOK, 0)  # never for another platform
        finally:
            os.unlink(source)
        self.assertTrue(seen[0] and seen[0] != source, "route 0 uses a private copy")
        self.assertIsNone(seen[1], "the anonymous fallback sends no cookies")
        self.assertIsNone(seen[2], "other platforms never get YouTube cookies")
        self.assertEqual(self.leftover_copies(), set(), "every copy was cleaned up")

    def test_a_proxy_applies_to_youtube_lookups_and_to_youtube_cdn_downloads(self):
        self.assertNotIn("proxy", self.main._ydl_options(0, use_proxy=True))
        with mock.patch.object(self.main, "YTDLP_PROXY", "http://user:pw@proxy.example:8080"):
            self.assertEqual(self.main._ydl_options(0, use_proxy=True)["proxy"], "http://user:pw@proxy.example:8080")
            self.assertNotIn("proxy", self.main._ydl_options(0), "not unless the caller says the link is YouTube's")
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


class RouteFallbackTests(Base):
    def resolve(self, url, recorder, first_route=0):
        with mock.patch.object(self.main, "_extract_info", recorder):
            return self.main._resolve_and_extract(url, first_route)

    def test_a_block_on_the_fast_route_is_answered_by_the_full_list(self):
        recorder = Recorder(bot_check(), WITH_VIDEO)
        _resolved, info = self.resolve(YT, recorder)
        self.assertEqual(recorder.routes, [0, 1])
        self.assertEqual(info["title"], "ok")

    def test_an_empty_result_also_tries_the_full_list(self):
        recorder = Recorder(NO_VIDEO, WITH_VIDEO)
        self.resolve(YT, recorder)
        self.assertEqual(recorder.routes, [0, 1])

    def test_a_working_fast_route_is_a_single_call(self):
        recorder = Recorder(WITH_VIDEO)
        self.resolve(YT, recorder)
        self.assertEqual(recorder.routes, [0])

    def test_when_both_routes_are_blocked_it_stops_after_two_attempts_with_a_clean_error(self):
        recorder = Recorder(bot_check(), bot_check())
        with self.assertRaises(ScraperError) as ctx:
            self.resolve(YT, recorder)
        self.assertEqual(ctx.exception.code, errors.STREAM_EXPIRED_OR_BLOCKED)
        self.assertEqual(recorder.routes, [0, 1], "exactly one extra attempt, never a loop")

    def test_private_videos_and_timeouts_are_not_retried_on_another_route(self):
        from yt_dlp.utils import DownloadError

        for exc, code in ((DownloadError("ERROR: Private video"), errors.LOGIN_REQUIRED),
                          (DownloadError("ERROR: timed out"), errors.PLATFORM_TIMEOUT)):
            recorder = Recorder(exc)
            with self.assertRaises(ScraperError) as ctx:
                self.resolve(YT, recorder)
            self.assertEqual(ctx.exception.code, code)
            self.assertEqual(recorder.routes, [0], f"{code} says nothing about the route")

    def test_starting_on_the_second_route_skips_the_first(self):
        recorder = Recorder(WITH_VIDEO)
        self.resolve(YT, recorder, first_route=1)
        self.assertEqual(recorder.routes, [1])

    def test_other_platforms_never_use_a_second_route(self):
        recorder = Recorder(bot_check(), WITH_VIDEO)
        with self.assertRaises(ScraperError):
            self.resolve(TIKTOK, recorder)
        self.assertEqual(recorder.routes, [0])

    def test_with_the_second_route_switched_off_a_block_is_final(self):
        recorder = Recorder(bot_check(), WITH_VIDEO)
        with mock.patch.dict(os.environ, {"YOUTUBE_SECOND_ROUTE": "0"}):
            with self.assertRaises(ScraperError):
                self.resolve(YT, recorder)
        self.assertEqual(recorder.routes, [0])

    def test_the_lookup_carries_the_youtube_budget_and_other_platforms_the_short_one(self):
        seen = {}

        def spy(url, route=0):
            seen[url] = self.main._deadline.get()
            return WITH_VIDEO

        with mock.patch.object(self.main, "_extract_info", spy):
            before = time.monotonic()
            self.main._resolve_and_extract(YT)
            self.main._resolve_and_extract(TIKTOK)
        self.assertAlmostEqual(seen[YT] - before, self.main.YOUTUBE_EXTRACTION_TIMEOUT_SECONDS, delta=0.6)
        self.assertAlmostEqual(seen[TIKTOK] - before, self.main.EXTRACTION_TIMEOUT_SECONDS, delta=0.6)


class DeadlineTests(Base):
    def test_a_request_in_flight_may_not_run_past_the_deadline(self):
        seen = []
        ydl = self.main._DeadlineYDL({"quiet": True, "socket_timeout": 8}, deadline=time.monotonic() + 3.0)
        with mock.patch.object(self.main.yt_dlp.YoutubeDL, "urlopen", side_effect=lambda req: seen.append(req.extensions["timeout"])):
            ydl.urlopen("https://www.youtube.com/")           # 8 s socket timeout, but only ~3 s are left
        self.assertLessEqual(seen[0], 3.6)
        self.assertGreater(seen[0], 2.0)

    def test_a_retry_late_in_the_budget_gets_only_the_time_that_is_left(self):
        seen = []
        ydl = self.main._DeadlineYDL({"quiet": True, "socket_timeout": 8}, deadline=time.monotonic() + 1.2)
        with mock.patch.object(self.main.yt_dlp.YoutubeDL, "urlopen", side_effect=lambda req: seen.append(req.extensions["timeout"])):
            ydl.urlopen(self.main.yt_dlp.networking.Request("https://www.youtube.com/"))
        self.assertLessEqual(seen[0], 1.8, "the second 8 s attempt must not run to its full length")

    def test_a_short_request_timeout_is_never_lengthened(self):
        seen = []
        ydl = self.main._DeadlineYDL({"quiet": True, "socket_timeout": 8}, deadline=time.monotonic() + 30)
        request = self.main.yt_dlp.networking.Request("https://www.youtube.com/", extensions={"timeout": 2.0})
        with mock.patch.object(self.main.yt_dlp.YoutubeDL, "urlopen", side_effect=lambda req: seen.append(req.extensions["timeout"])):
            ydl.urlopen(request)
        self.assertEqual(seen[0], 2.0)

    def test_yt_dlp_refuses_new_requests_once_the_deadline_has_passed(self):
        ydl = self.main._DeadlineYDL({"quiet": True}, deadline=time.monotonic() - 1)
        with mock.patch.object(self.main.yt_dlp.YoutubeDL, "urlopen", side_effect=AssertionError("sent after the deadline")):
            with self.assertRaises(TimeoutError):
                ydl.urlopen("https://www.youtube.com/")

    def test_a_stalled_youtube_lookup_answers_within_its_budget_and_the_slot_returns_when_the_work_ends(self):
        async def scenario():
            finish = threading.Event()

            def stuck(url, route=0):
                finish.wait(10)
                return WITH_VIDEO

            with mock.patch.object(self.main, "_extract_info", stuck), \
                    mock.patch.object(self.main, "YOUTUBE_EXTRACTION_TIMEOUT_SECONDS", 0.4), \
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
        for _ in range(2):
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

    def test_a_lookup_that_tried_two_routes_counts_as_one_failure(self):
        recorder = Recorder(bot_check())
        with mock.patch.object(self.main, "_extract_info", recorder):
            for _ in range(2):
                with self.assertRaises(ScraperError):
                    self.main._resolve_and_extract(YT)
        self.assertEqual(len(recorder.routes), 4, "two routes per lookup")
        self.assertFalse(self.main.YOUTUBE_BREAKER.is_open(), "two failed lookups are not yet three")

    def test_after_three_failed_lookups_youtube_answers_instantly_without_calling_youtube(self):
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

    def test_a_caller_that_gives_up_counts_the_failure_once_even_though_the_worker_is_stuck(self):
        async def scenario():
            release = threading.Event()

            def stuck(url, route=0):
                release.wait(10)
                from yt_dlp.utils import DownloadError

                raise DownloadError("ERROR: timed out")  # the worker eventually fails too

            with mock.patch.object(self.main, "_extract_info", stuck), \
                    mock.patch.object(self.main, "YOUTUBE_EXTRACTION_TIMEOUT_SECONDS", 0.3), \
                    mock.patch.object(self.main, "DEADLINE_GRACE_SECONDS", 0.1):
                for expected_open in (False, False, True):
                    self.main.INFO_CACHE.clear()
                    with self.assertRaises(ScraperError) as ctx:
                        await self.main._acquire_info(YT)
                    self.assertEqual(ctx.exception.code, errors.PLATFORM_TIMEOUT)
                    self.assertEqual(self.main.YOUTUBE_BREAKER.is_open(), expected_open)
                release.set()
                for _ in range(60):
                    if self.main._active == 0:
                        break
                    await asyncio.sleep(0.05)
                # the workers finished (and failed) after their callers had gone: not counted a second time
                self.assertEqual(len(self.main.YOUTUBE_BREAKER._failures), 0, "opened once, no double counting")

        asyncio.run(scenario())

    def test_the_fourth_lookup_after_three_caller_timeouts_is_instant(self):
        async def scenario():
            release = threading.Event()
            calls = []

            def stuck(url, route=0):
                calls.append(1)
                release.wait(10)

            with mock.patch.object(self.main, "_extract_info", stuck), \
                    mock.patch.object(self.main, "YOUTUBE_EXTRACTION_TIMEOUT_SECONDS", 0.3), \
                    mock.patch.object(self.main, "DEADLINE_GRACE_SECONDS", 0.1):
                for _ in range(3):
                    self.main.INFO_CACHE.clear()
                    with self.assertRaises(ScraperError):
                        await self.main._acquire_info(YT)
                before = len(calls)
                self.main.INFO_CACHE.clear()
                started = time.monotonic()
                with self.assertRaises(ScraperError) as ctx:
                    await self.main._acquire_info(YT)
                instant = time.monotonic() - started
                calls_during = len(calls)  # before the stuck workers are released and carry on
                release.set()
                await asyncio.sleep(0.3)
            self.assertEqual(ctx.exception.code, errors.PLATFORM_TIMEOUT)
            self.assertEqual(calls_during, before, "no new request while the breaker is open")
            self.assertLess(instant, 0.2)

        asyncio.run(scenario())

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
        self.assertEqual(ctx.exception.code, errors.PLATFORM_TIMEOUT)
        self.assertEqual(len(recorder.routes), 3)

    def test_a_stall_is_never_remembered_as_a_private_video(self):
        stall = "ERROR: [youtube] abc: Failed to extract any player response; please report this issue"
        self.assertEqual(errors.classify_failure(stall), errors.PLATFORM_TIMEOUT)
        self.assertNotIn(errors.PLATFORM_TIMEOUT, self.main.NEGATIVE_CACHEABLE)

    def test_the_breaker_only_guards_youtube(self):
        for _ in range(5):
            self.main.YOUTUBE_BREAKER.record_failure()
        with mock.patch.object(self.main, "_extract_info", Recorder(WITH_VIDEO)):
            _resolved, info = self.main._resolve_and_extract(TIKTOK)
        self.assertEqual(info["title"], "ok")

    def test_a_working_lookup_resets_the_breaker(self):
        self.main.YOUTUBE_BREAKER.record_failure()
        self.main.YOUTUBE_BREAKER.record_failure()
        with mock.patch.object(self.main, "_extract_info", Recorder(WITH_VIDEO)):
            self.main._resolve_and_extract(YT)
        self.main.YOUTUBE_BREAKER.record_failure()
        self.assertFalse(self.main.YOUTUBE_BREAKER.is_open())


class StructuredErrorTests(Base):
    """A failure is always the same JSON shape, never a hang, an HTML page or a leaked internal message."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        from fastapi.testclient import TestClient

        cls.client = TestClient(cls.main.app, raise_server_exceptions=False)

    def get(self, url=YT):
        return self.client.get("/extract", params={"url": url})

    def assert_structured(self, response, status, code):
        self.assertEqual(response.status_code, status, response.text)
        self.assertTrue(response.headers["content-type"].startswith("application/json"))
        detail = response.json()["detail"]
        self.assertEqual(detail["code"], code)
        self.assertTrue(detail["message"])

    def test_yt_dlp_download_errors_become_coded_json(self):
        from yt_dlp.utils import DownloadError

        cases = [
            ("ERROR: [youtube] abc: Sign in to confirm you're not a bot", 502, errors.STREAM_EXPIRED_OR_BLOCKED),
            ("ERROR: [youtube] abc: Video unavailable. This video is private", 403, errors.LOGIN_REQUIRED),
            ("ERROR: Unable to download webpage: timed out", 504, errors.PLATFORM_TIMEOUT),
            ("ERROR: [youtube] abc: Failed to extract any player response", 504, errors.PLATFORM_TIMEOUT),
        ]
        for message, status, code in cases:
            self.main.NEGATIVE_CACHE.clear()
            self.main.YOUTUBE_BREAKER.reset()
            with mock.patch.object(self.main, "_extract_info", side_effect=DownloadError(message)):
                self.assert_structured(self.get(), status, code)

    def test_yt_dlp_extractor_errors_become_coded_json(self):
        from yt_dlp.utils import ExtractorError

        with mock.patch.object(self.main, "_extract_info", side_effect=ExtractorError("Something odd happened", expected=False)):
            response = self.get()
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json()["detail"]["code"], errors.EXTRACTION_FAILED)

    def test_errors_of_any_other_kind_are_contained_in_the_lookup(self):
        for exc in (OSError("disk on fire"), ValueError("bad"), KeyError("x"), RuntimeError("internal /srv/secret/path")):
            self.main.NEGATIVE_CACHE.clear()
            self.main.INFO_CACHE.clear()
            with mock.patch.object(self.main, "_extract_info", side_effect=exc):
                response = self.get()
            self.assertEqual(response.headers["content-type"].split(";")[0], "application/json")
            self.assertIn("code", response.json()["detail"], type(exc).__name__)
            self.assertNotIn("secret", response.text)

    def test_a_bug_after_extraction_still_answers_in_the_same_shape_without_leaking(self):
        with mock.patch.object(self.main, "_extract_info", return_value=WITH_VIDEO), \
                mock.patch.object(self.main, "_describe_items", side_effect=RuntimeError("secret internals at /srv/app.py")):
            with self.assertLogs("uvicorn.error", level="WARNING"):
                response = self.get()
        self.assert_structured(response, 500, errors.EXTRACTION_FAILED)
        self.assertNotIn("secret", response.text)
        self.assertNotIn("/srv", response.text)
        self.assertNotIn("Traceback", response.text)
        self.assertEqual(response.json()["detail"]["message"], "Something went wrong on our side. Please try again.")

    def test_a_stalled_youtube_lookup_returns_a_timeout_json_instead_of_hanging(self):
        import httpx

        # One event loop for the whole exchange, like a real server: the synchronous TestClient would wait for
        # the deliberately stuck worker thread when it shuts its loop down, which is not what production does.
        async def scenario():
            release = threading.Event()

            def stuck(url, route=0):
                release.wait(10)

            transport = httpx.ASGITransport(app=self.main.app, raise_app_exceptions=False)
            with mock.patch.object(self.main, "_extract_info", stuck), \
                    mock.patch.object(self.main, "YOUTUBE_EXTRACTION_TIMEOUT_SECONDS", 0.5), \
                    mock.patch.object(self.main, "DEADLINE_GRACE_SECONDS", 0.1):
                async with httpx.AsyncClient(transport=transport, base_url="http://scraper") as client:
                    started = time.monotonic()
                    response = await client.get("/extract", params={"url": YT})
                    waited = time.monotonic() - started
                release.set()
                await asyncio.sleep(0.3)
            return response, waited

        response, waited = asyncio.run(scenario())
        self.assert_structured(response, 504, errors.PLATFORM_TIMEOUT)
        self.assertLess(waited, 2.0)

    def test_the_health_endpoint_is_untouched_by_any_of_this(self):
        response = self.client.get("/health")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.content, b'{"status":"ok"}')


if __name__ == "__main__":
    unittest.main(verbosity=2)
