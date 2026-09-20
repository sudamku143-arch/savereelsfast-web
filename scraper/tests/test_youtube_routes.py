"""
YouTube resilience: client settings, the second route, and what is (not) retried.

Run from the scraper/ folder:  python -m unittest discover -s tests -v
"""

import asyncio
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import errors  # noqa: E402
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


def bot_check():
    from yt_dlp.utils import DownloadError

    return DownloadError("ERROR: [youtube] abc: Sign in to confirm you're not a bot")


class Recorder:
    """Stands in for _extract_info: answers per route and remembers which routes were tried."""

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


class OptionTests(Base):
    def test_first_route_uses_the_requested_client_settings(self):
        opts = self.main._ydl_options(0)
        self.assertEqual(
            opts["extractor_args"],
            {"youtube": {"player_client": ["android", "ios", "tv"], "player_skip": ["webpage", "configs"]}},
        )

    def test_second_route_is_yt_dlps_own_client_mix(self):
        self.assertNotIn("extractor_args", self.main._ydl_options(1))
        self.assertNotIn("extractor_args", self.main._ydl_options(99), "out-of-range clamps to the last route")

    def test_routes_do_not_leak_into_each_other(self):
        self.main._ydl_options(1)
        self.assertIn("extractor_args", self.main._ydl_options(0))
        self.assertIn("extractor_args", self.main.YDL_OPTS, "the shared defaults must stay untouched")

    def test_proxy_and_cookies_apply_only_when_configured(self):
        self.assertNotIn("proxy", self.main._ydl_options(0))
        with mock.patch.object(self.main, "YTDLP_PROXY", "http://user:pw@proxy.example:8080"):
            self.assertEqual(self.main._ydl_options(0)["proxy"], "http://user:pw@proxy.example:8080")
        cookies = ROOT / "requirements.txt"  # any existing file will do
        with mock.patch.object(self.main, "YOUTUBE_COOKIES_FILE", str(cookies)):
            self.assertEqual(self.main._ydl_options(0)["cookiefile"], str(cookies))
        with mock.patch.object(self.main, "YOUTUBE_COOKIES_FILE", "/no/such/cookies.txt"):
            self.assertNotIn("cookiefile", self.main._ydl_options(0), "a missing file must not break lookups")

    def test_downloads_through_the_cdn_use_the_same_proxy(self):
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
        self.assertEqual(seen["proxy"], "http://proxy.example:8080", "IP-bound links must be fetched from the same IP")


class RouteFallbackTests(Base):
    def resolve(self, url, recorder, first_route=0):
        with mock.patch.object(self.main, "_extract_info", recorder):
            return self.main._resolve_and_extract(url, first_route)

    def test_a_bot_check_on_the_first_route_is_answered_by_the_second(self):
        recorder = Recorder(bot_check(), WITH_VIDEO)
        _resolved, info = self.resolve(YT, recorder)
        self.assertEqual(recorder.routes, [0, 1])
        self.assertEqual(info["title"], "ok")

    def test_an_empty_result_also_tries_the_second_route(self):
        recorder = Recorder(NO_VIDEO, WITH_VIDEO)
        _resolved, info = self.resolve(YT, recorder)
        self.assertEqual(recorder.routes, [0, 1])
        self.assertTrue(self.main._has_download(info))

    def test_a_working_first_route_is_never_followed_by_a_second_lookup(self):
        recorder = Recorder(WITH_VIDEO)
        self.resolve(YT, recorder)
        self.assertEqual(recorder.routes, [0])

    def test_when_every_route_is_blocked_the_block_is_reported_once(self):
        recorder = Recorder(bot_check(), bot_check())
        with self.assertRaises(ScraperError) as ctx:
            self.resolve(YT, recorder)
        self.assertEqual(ctx.exception.code, errors.STREAM_EXPIRED_OR_BLOCKED)
        self.assertEqual(recorder.routes, [0, 1], "exactly one extra attempt, never a loop")

    def test_when_nothing_downloadable_exists_the_reason_survives(self):
        recorder = Recorder(NO_VIDEO, NO_VIDEO)
        _resolved, info = self.resolve(YT, recorder)
        self.assertEqual(info["title"], "nothing")  # caller turns this into "no video" or the platform's reason

    def test_private_videos_and_timeouts_are_not_retried(self):
        from yt_dlp.utils import DownloadError

        for exc, code in ((DownloadError("ERROR: Private video"), errors.LOGIN_REQUIRED),
                          (DownloadError("ERROR: timed out"), errors.PLATFORM_TIMEOUT)):
            recorder = Recorder(exc)
            with self.assertRaises(ScraperError) as ctx:
                self.resolve(YT, recorder)
            self.assertEqual(ctx.exception.code, code)
            self.assertEqual(recorder.routes, [0], f"{code} says nothing about the route")

    def test_other_platforms_have_a_single_route(self):
        recorder = Recorder(bot_check(), WITH_VIDEO)
        with self.assertRaises(ScraperError):
            self.resolve(TIKTOK, recorder)
        self.assertEqual(recorder.routes, [0])

    def test_starting_on_the_second_route_skips_the_first(self):
        recorder = Recorder(WITH_VIDEO)
        self.resolve(YT, recorder, first_route=1)
        self.assertEqual(recorder.routes, [1])


class DownloadRefreshTests(Base):
    def test_a_stale_youtube_link_is_refreshed_on_the_other_route(self):
        recorder = Recorder(WITH_VIDEO, WITH_VIDEO)
        attempts = []

        def open_from_info(resolved, info, kind, item):
            attempts.append(1)
            if len(attempts) == 1:
                raise ScraperError(errors.STREAM_EXPIRED_OR_BLOCKED)  # the 403 YouTube gives a blocked link
            return "STREAM"

        async def go():
            await self.main._acquire_info(YT)  # fills the cache with route 0's answer
            return await self.main._open_stream(YT)

        with mock.patch.object(self.main, "_extract_info", recorder), \
                mock.patch.object(self.main, "_open_stream_from_info", open_from_info):
            result = asyncio.run(go())
        self.assertEqual(result, "STREAM")
        self.assertEqual(recorder.routes, [0, 1], "the refresh must not repeat the route that just failed")


if __name__ == "__main__":
    unittest.main(verbosity=2)
