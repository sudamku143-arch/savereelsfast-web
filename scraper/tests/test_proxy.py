"""
The paid proxy and the YouTube cache: the proxy is used for YouTube only, its credentials never leak, its bandwidth
is counted (and can be capped), and repeat lookups of a video cost no proxy traffic.

Run from the scraper/ folder:  python -m unittest discover -s tests -v
"""

import asyncio
import json
import os
import sys
import time
from urllib.parse import unquote, urlparse
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import diagnose  # noqa: E402
import errors  # noqa: E402
import urls  # noqa: E402
from cache import TTLCache  # noqa: E402
from errors import ScraperError  # noqa: E402

PROXY = "http://webshare-user:hunter2-secret@p.webshare.io:80"
YT = "https://www.youtube.com/watch?v=jNQXAC9IVRw"
TIKTOK = "https://www.tiktok.com/@scout2015/video/6718335390845095173"


def info_with(url: str) -> dict:
    return {"id": "abc", "title": "ok", "formats": [
        {"format_id": "18", "url": url, "ext": "mp4", "vcodec": "avc1", "acodec": "mp4a", "height": 360, "protocol": "https"}]}


YT_INFO = info_with("https://rr1.googlevideo.com/videoplayback?id=abc")
TT_INFO = info_with("https://v16-webapp.tiktokcdn.com/video/tos/abc.mp4")


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
        self.usage_before = dict(self.main._proxy_usage)
        for key in ("lookups", "streams", "streamBytes", "todayBytes"):
            self.main._proxy_usage[key] = 0
        self.main._proxy_usage["day"] = ""
        patches = [
            mock.patch.object(self.main, "YOUTUBE_COOKIES_DEFAULT_PATH", "/no/such/place.txt"),
            mock.patch.dict(os.environ, {"YOUTUBE_COOKIES_FILE": "", "SCRAPER_SHARED_SECRET": "", "SCRAPER_REQUIRE_SECRET": ""}),
            mock.patch.object(self.main, "YTDLP_PROXY", PROXY),
            mock.patch.object(self.main, "PROXY_DAILY_LIMIT_MB", 0),
        ]
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)


class FakeResponse:
    headers = {"Content-Length": "100"}

    def close(self):
        pass


class FakeYDL:
    made: list[dict] = []

    def __init__(self, params, *args, **kwargs):
        FakeYDL.made.append(params)

    def urlopen(self, request):
        return FakeResponse()

    def close(self):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def extract_info(self, url, download=False):
        logger = FakeYDL.made[-1].get("logger")
        if logger:
            logger.warning(f"[youtube] tunnel via {PROXY} failed once")
        return YT_INFO


# ------------------------------------------------------------------------------------------ validation


class ProxySettingTests(Base):
    def test_valid_proxy_urls_are_accepted(self):
        for value in ("http://user:pw@p.webshare.io:80", "https://p.webshare.io:443", "socks5://u:p@10.0.0.1:1080", "  http://a.b:8080  "):
            self.assertEqual(self.main._clean_proxy(value), value.strip(), value)

    def test_unset_or_broken_values_switch_the_proxy_off_instead_of_breaking_every_lookup(self):
        self.assertIsNone(self.main._clean_proxy(None))
        self.assertIsNone(self.main._clean_proxy(""))
        for bad in ("not a url", "ftp://host:21", "http://:80", "http://host:abc", "p.webshare.io:99999:u:p", "javascript:alert(1)", "two words:80"):
            with self.assertLogs("uvicorn.error", level="WARNING") as logs:
                self.assertIsNone(self.main._clean_proxy(bad), bad)
            self.assertNotIn(bad, "\n".join(logs.output), "the bad value is never echoed into the log")

    def test_webshares_host_port_user_pass_format_is_converted_to_a_proxy_url(self):
        with self.assertLogs("uvicorn.error", level="INFO") as logs:
            self.assertEqual(self.main._clean_proxy("p.webshare.io:80:webuser:hunter2"), "http://webuser:hunter2@p.webshare.io:80")
        self.assertNotIn("hunter2", chr(10).join(logs.output), "the login is never logged")
        self.assertEqual(self.main._parse_proxy("p.webshare.io:80:webuser:hunter2")[1], "converted")

    def test_other_dashboard_forms_are_converted_too(self):
        cases = {
            "user:pw@p.webshare.io:80": "http://user:pw@p.webshare.io:80",
            "185.199.229.156:7492:abcd:efgh": "http://abcd:efgh@185.199.229.156:7492",
            "p.webshare.io:80": "http://p.webshare.io:80",
        }
        for raw, expected in cases.items():
            self.assertEqual(self.main._parse_proxy(raw), (expected, "converted"), raw)

    def test_special_characters_in_the_password_are_encoded_so_they_cannot_break_the_url(self):
        url, status = self.main._parse_proxy("p.webshare.io:80:webuser:pa:ss@w/rd#1")
        self.assertEqual(status, "converted")
        parsed = urlparse(url)
        self.assertEqual((parsed.hostname, parsed.port, parsed.username), ("p.webshare.io", 80, "webuser"))
        self.assertEqual(unquote(parsed.password), "pa:ss@w/rd#1")

    def test_a_rejected_setting_is_reported_not_silently_ignored(self):
        self.assertEqual(self.main._parse_proxy("garbage value"), (None, "rejected"))
        self.assertEqual(self.main._parse_proxy(""), (None, "unset"))
        with mock.patch.object(self.main, "PROXY_SETTING_STATUS", "rejected"), mock.patch.object(self.main, "YTDLP_PROXY", None):
            self.assertEqual(self.main._proxy_setting(), "rejected")
            self.assertEqual(self.main._proxy_stats()["setting"], "rejected")
        with mock.patch.object(self.main, "PROXY_SETTING_STATUS", "unset"), mock.patch.object(self.main, "YTDLP_PROXY", None):
            self.assertEqual(self.main._proxy_setting(), "off")

    def test_host_is_shown_without_credentials(self):
        self.assertEqual(diagnose.proxy_host(PROXY), "p.webshare.io:80")
        self.assertNotIn("hunter2", diagnose.proxy_host(PROXY))
        self.assertIsNone(diagnose.proxy_host(None))


# ------------------------------------------------------------------------------------------ YouTube only


class ScopeTests(Base):
    def capture_lookup_options(self, url):
        FakeYDL.made = []
        with mock.patch.object(self.main, "_DeadlineYDL", FakeYDL), mock.patch.object(self.main.yt_dlp, "YoutubeDL", FakeYDL):
            token = self.main._deadline.set(time.monotonic() + 5)
            try:
                self.main._extract_info(url)
            finally:
                self.main._deadline.reset(token)
        return FakeYDL.made[-1]

    def test_youtube_lookups_go_through_the_proxy(self):
        self.assertEqual(self.capture_lookup_options(YT)["proxy"], PROXY)

    def test_through_the_proxy_each_attempt_is_short_and_there_are_more_of_them(self):
        options = self.capture_lookup_options(YT)
        self.assertEqual((options["socket_timeout"], options["retries"], options["extractor_retries"]), (5, 2, 2))

    def test_without_the_proxy_the_original_patience_is_kept(self):
        with mock.patch.object(self.main, "YTDLP_PROXY", None):
            options = self.capture_lookup_options(YT)
        self.assertEqual((options["socket_timeout"], options["retries"]), (8, 1))
        self.assertNotIn("proxy", options)

    def test_the_whole_lookup_budget_covers_all_the_attempts(self):
        worst_case = self.main.YOUTUBE_PROXY_SOCKET_TIMEOUT * (1 + self.main.YOUTUBE_PROXY_RETRIES)
        self.assertGreaterEqual(self.main.YOUTUBE_EXTRACTION_TIMEOUT_SECONDS, worst_case)
        self.assertEqual(self.main.YOUTUBE_EXTRACTION_TIMEOUT_SECONDS, 20.0)

    def test_other_platforms_never_touch_the_proxy(self):
        for url in (TIKTOK, "https://www.instagram.com/reel/AbC_123/", "https://www.reddit.com/r/videos/comments/6rrwyj/x/",
                    "https://x.com/user/status/1234567890", "https://www.facebook.com/watch/?v=1234567890123456"):
            self.assertNotIn("proxy", self.capture_lookup_options(url), url)

    def open_stream(self, resolved, info):
        FakeYDL.made = []
        with mock.patch.object(self.main.yt_dlp, "YoutubeDL", FakeYDL):
            stream = self.main._open_stream_from_info(resolved, info, "video", 0)
        return stream, FakeYDL.made[-1]

    def test_youtube_video_downloads_use_the_proxy_because_the_link_is_tied_to_the_ip_that_asked(self):
        stream, options = self.open_stream(YT, YT_INFO)
        self.assertTrue(stream.via_proxy)
        self.assertEqual(options["proxy"], PROXY)

    def test_other_platforms_download_directly_and_spend_no_proxy_traffic(self):
        stream, options = self.open_stream(TIKTOK, TT_INFO)
        self.assertFalse(stream.via_proxy)
        self.assertNotIn("proxy", options)

    def test_the_cdn_relay_uses_the_proxy_only_for_youtubes_own_servers(self):
        seen = []

        class Boom(Exception):
            pass

        def fake_client(*args, **kwargs):
            seen.append(kwargs.get("proxy"))
            raise Boom

        with mock.patch.object(self.main.httpx, "Client", fake_client):
            for media, expected in (("https://rr1---sn-abc.googlevideo.com/videoplayback", PROXY),
                                    ("https://v16-webapp.tiktokcdn.com/video/a.mp4", None),
                                    ("https://scontent.cdninstagram.com/v/a.mp4", None),
                                    ("https://v.redd.it/abc/DASH_360.mp4", None)):
                seen.clear()
                with self.assertRaises(Boom):
                    self.main._open_cdn_stream(media, None)
                self.assertEqual(seen, [expected], media)

    def test_the_media_host_helpers(self):
        self.assertTrue(urls.is_youtube_media_host("rr1---sn-x.googlevideo.com"))
        self.assertTrue(urls.is_youtube_media_host("GOOGLEVIDEO.com"))
        for host in ("evilgooglevideo.com", "googlevideo.com.evil.example", "www.youtube.com", "", "tiktokcdn.com"):
            self.assertFalse(urls.is_youtube_media_host(host), host)


# ---------------------------------------------------------------------------------------- credentials


class RedactionTests(Base):
    def test_credentials_are_removed_from_text(self):
        for text in (f"cannot reach {PROXY} now", "tunnel via http://u:p%40ss@10.0.0.1:8080/ failed", "socks5://a:b@host:1080 died"):
            clean = diagnose.redact_secrets(text, PROXY)
            self.assertNotIn("hunter2", clean)
            self.assertNotIn("p%40ss", clean)
            self.assertNotRegex(clean, r"://[^/@\s]+:[^/@\s]+@")

    def test_plain_text_and_credential_free_urls_are_left_alone(self):
        for text in ("Video unavailable", "https://www.youtube.com/watch?v=abc", "http://p.webshare.io:80"):
            self.assertEqual(diagnose.redact_secrets(text, PROXY), text)

    def test_yt_dlp_errors_returned_to_callers_never_carry_the_proxy_login(self):
        from yt_dlp.utils import DownloadError

        exc = DownloadError(f"ERROR: [youtube] abc: Unable to connect to proxy {PROXY}: 407 Proxy Authentication Required")
        err = self.main._failure_from_exception(exc)
        self.assertNotIn("hunter2", err.message)
        self.assertNotIn("webshare-user", err.message)

    def test_the_extract_endpoint_never_returns_the_proxy_login(self):
        from fastapi.testclient import TestClient
        from yt_dlp.utils import DownloadError

        client = TestClient(self.main.app, raise_server_exceptions=False)
        with mock.patch.object(self.main, "_extract_info", side_effect=DownloadError(f"ERROR: weird failure via {PROXY}")):
            response = client.get("/extract", params={"url": YT})
        self.assertNotIn("hunter2", response.text)
        self.assertNotIn("webshare-user", response.text)

    def test_diagnostic_trace_messages_are_redacted(self):
        FakeYDL.made = []
        trace: list = []
        with mock.patch.object(self.main, "_DeadlineYDL", FakeYDL), mock.patch.object(self.main.yt_dlp, "YoutubeDL", FakeYDL):
            token = self.main._deadline.set(time.monotonic() + 5)
            trace_token = self.main._trace.set(trace)
            try:
                self.main._extract_info(YT)
            finally:
                self.main._trace.reset(trace_token)
                self.main._deadline.reset(token)
        messages = [m for entry in trace for m in entry.get("messages", [])]
        self.assertTrue(messages)
        self.assertNotIn("hunter2", json.dumps(trace))

    def test_stats_and_diagnose_show_the_host_but_never_the_login(self):
        from fastapi.testclient import TestClient

        client = TestClient(self.main.app, raise_server_exceptions=False)
        with mock.patch.object(self.main, "probe_network", return_value={"host": "www.youtube.com"}), \
                mock.patch.object(self.main, "probe_proxy", return_value={"host": "p.webshare.io:80", "ok": True, "status": 204, "ms": 300}), \
                mock.patch.object(self.main, "_extract_info", return_value=YT_INFO):
            diagnosis = client.get("/diagnose/youtube")
            stats = client.get("/stats")
        for response in (diagnosis, stats):
            self.assertEqual(response.status_code, 200)
            self.assertNotIn("hunter2", response.text)
            self.assertNotIn("webshare-user", response.text)
        self.assertEqual(stats.json()["proxy"]["host"], "p.webshare.io:80")
        self.assertTrue(stats.json()["proxy"]["configured"])
        self.assertEqual(diagnosis.json()["proxy"]["ok"], True)
        self.assertIn("proxy", diagnosis.json()["reading"])


# ----------------------------------------------------------------------------------------- bandwidth


class BandwidthTests(Base):
    def stream(self, via_proxy, chunks=(b"a" * 100_000,) * 5):
        class Reader:
            def __init__(self):
                self.left = list(chunks)

            def read(self, n):
                return self.left.pop(0) if self.left else b""

        return self.main.OpenStream(Reader(), None, [], via_proxy=via_proxy)

    def test_bytes_through_the_proxy_are_counted(self):
        for _ in self.stream(True).chunks():
            pass
        stats = self.main._proxy_stats()
        self.assertEqual(self.main._proxy_usage["streamBytes"], 500_000)
        self.assertEqual(stats["downloadedMb"], round(500_000 / 1024 / 1024, 1))

    def test_direct_downloads_are_not_counted(self):
        for _ in self.stream(False).chunks():
            pass
        self.assertEqual(self.main._proxy_usage["streamBytes"], 0)

    def test_lookups_are_counted_and_a_repeat_from_the_cache_costs_nothing(self):
        FakeYDL.made = []
        with mock.patch.object(self.main, "_DeadlineYDL", FakeYDL), mock.patch.object(self.main.yt_dlp, "YoutubeDL", FakeYDL):
            async def go():
                first = await self.main._acquire_info(YT)
                after_first = self.main._proxy_usage["lookups"]
                for form in ("https://youtu.be/jNQXAC9IVRw", "https://youtu.be/jNQXAC9IVRw?si=abc&t=9",
                             "https://www.youtube.com/shorts/jNQXAC9IVRw", "https://m.youtube.com/watch?v=jNQXAC9IVRw&list=PL1&index=3", YT):
                    _resolved, _info, cached = await self.main._acquire_info(form)
                    self.assertTrue(cached, form)
                return first, after_first

            _first, after_first = asyncio.run(go())
        self.assertEqual(after_first, 1)
        self.assertEqual(self.main._proxy_usage["lookups"], 1, "five repeats, in five spellings, used no proxy traffic")
        self.assertEqual(len(FakeYDL.made), 1)

    def test_the_daily_limit_stops_new_youtube_downloads_only(self):
        with mock.patch.object(self.main, "PROXY_DAILY_LIMIT_MB", 1):
            self.main._proxy_note_bytes(2 * 1024 * 1024)
            with self.assertRaises(ScraperError) as ctx:
                self.main._proxy_check_budget()
            self.assertEqual(ctx.exception.code, errors.SERVER_BUSY)
            # the stream is refused before any connection is made
            FakeYDL.made = []
            with mock.patch.object(self.main.yt_dlp, "YoutubeDL", FakeYDL):
                with self.assertRaises(ScraperError):
                    self.main._open_stream_from_info(YT, YT_INFO, "video", 0)
                self.assertEqual(FakeYDL.made, [], "no connection was opened for the refused download")
                stream = self.main._open_stream_from_info(TIKTOK, TT_INFO, "video", 0)  # other platforms are unaffected
                self.assertFalse(stream.via_proxy)

    def test_without_a_limit_nothing_is_ever_refused(self):
        self.main._proxy_note_bytes(50 * 1024 * 1024 * 1024)
        self.main._proxy_check_budget()

    def test_the_allowance_resets_each_utc_day(self):
        with mock.patch.object(self.main, "PROXY_DAILY_LIMIT_MB", 1):
            with mock.patch.object(self.main, "_utc_day", return_value="2026-09-20"):
                self.main._proxy_note_bytes(5 * 1024 * 1024)
                with self.assertRaises(ScraperError):
                    self.main._proxy_check_budget()
            with mock.patch.object(self.main, "_utc_day", return_value="2026-09-21"):
                self.main._proxy_check_budget()
                self.assertEqual(self.main._proxy_stats()["todayMb"], 0)
        self.assertGreater(self.main._proxy_usage["streamBytes"], 0, "the running total is kept")

    def test_stats_report_the_limit_and_today(self):
        with mock.patch.object(self.main, "PROXY_DAILY_LIMIT_MB", 500):
            self.main._proxy_note_bytes(3 * 1024 * 1024)
            stats = self.main._proxy_stats()
        self.assertEqual(stats["dailyLimitMb"], 500)
        self.assertEqual(stats["todayMb"], 3.0)


# -------------------------------------------------------------------------------------------- the cache


class CacheKeyTests(unittest.TestCase):
    def test_every_youtube_link_form_is_one_video(self):
        forms = [
            "https://www.youtube.com/watch?v=jNQXAC9IVRw",
            "http://youtube.com/watch?v=jNQXAC9IVRw&feature=share",
            "https://m.youtube.com/watch?v=jNQXAC9IVRw&list=PLabc&index=2&t=30s",
            "https://youtu.be/jNQXAC9IVRw",
            "https://youtu.be/jNQXAC9IVRw?si=tracking&t=9",
            "https://www.youtube.com/shorts/jNQXAC9IVRw",
            "https://www.youtube.com/shorts/jNQXAC9IVRw?feature=share",
            "https://www.youtube.com/embed/jNQXAC9IVRw",
            "https://www.youtube.com/live/jNQXAC9IVRw?si=x",
            "https://music.youtube.com/watch?v=jNQXAC9IVRw",
        ]
        keys = {urls.cache_key(form) for form in forms}
        self.assertEqual(keys, {"https://www.youtube.com/watch?v=jNQXAC9IVRw"})

    def test_different_videos_stay_different(self):
        self.assertNotEqual(urls.cache_key("https://youtu.be/jNQXAC9IVRw"), urls.cache_key("https://youtu.be/dQw4w9WgXcQ"))

    def test_links_without_a_valid_id_are_not_mistaken_for_a_video(self):
        for link in ("https://www.youtube.com/watch?v=short", "https://www.youtube.com/watch", "https://www.youtube.com/",
                     "https://www.youtube.com/playlist?list=PLabc", "https://www.youtube.com/@channel"):
            self.assertIsNone(urls.youtube_video_id(link), link)

    def test_other_platforms_keep_their_own_keys(self):
        self.assertEqual(urls.cache_key("https://www.tiktok.com/@u/video/7123456789?_r=1&_t=x"), "https://www.tiktok.com/@u/video/7123456789")
        self.assertEqual(urls.cache_key("https://www.instagram.com/reel/AbC_123/?igsh=1"), "https://www.instagram.com/reel/AbC_123/")

    def test_lookalike_hosts_are_never_treated_as_youtube(self):
        for link in ("https://youtube.com.evil.example/watch?v=jNQXAC9IVRw", "https://evilyoutube.com/watch?v=jNQXAC9IVRw"):
            self.assertIsNone(urls.youtube_video_id(link), link)


class CacheLifetimeTests(Base):
    def test_a_youtube_lookup_is_kept_for_three_hours_and_the_policy_says_so(self):
        self.assertEqual(self.main.YOUTUBE_CACHE_TTL_SECONDS, 3 * 3600)
        self.assertEqual(self.main.CACHE_TTL_SECONDS, 3600, "other platforms keep the hour")

    def test_stored_with_the_right_lifetime_per_platform(self):
        clock = [1000.0]
        cache = TTLCache(max_entries=10, ttl=3600, clock=lambda: clock[0])
        with mock.patch.object(self.main, "INFO_CACHE", cache), \
                mock.patch.object(self.main, "_extract_info", lambda url, route=0: TT_INFO if "tiktok" in url else YT_INFO):
            async def go():
                await self.main._acquire_info(YT)
                await self.main._acquire_info(TIKTOK)

            asyncio.run(go())
            self.assertIsNotNone(cache.get("https://www.youtube.com/watch?v=jNQXAC9IVRw"))
            clock[0] += 3700  # an hour later: TikTok is gone, YouTube is still cached
            self.assertIsNone(cache.get(urls.cache_key(TIKTOK)))
            self.assertIsNotNone(cache.get("https://www.youtube.com/watch?v=jNQXAC9IVRw"))
            clock[0] += 7200  # past three hours
            self.assertIsNone(cache.get("https://www.youtube.com/watch?v=jNQXAC9IVRw"))

    def test_never_longer_than_the_links_own_validity(self):
        now = time.time()
        far = info_with(f"https://rr1.googlevideo.com/videoplayback?expire={int(now) + 6 * 3600}&id=abc")
        soon = info_with(f"https://rr1.googlevideo.com/videoplayback?expire={int(now) + 1000}&id=abc")
        gone = info_with(f"https://rr1.googlevideo.com/videoplayback?expire={int(now) - 50}&id=abc")
        none = info_with("https://rr1.googlevideo.com/videoplayback?id=abc")
        self.assertEqual(self.main._youtube_cache_ttl(far), 3 * 3600)
        self.assertAlmostEqual(self.main._youtube_cache_ttl(soon), 700, delta=5)
        self.assertEqual(self.main._youtube_cache_ttl(gone), 60, "an already-dead link is kept for a minute at most")
        self.assertEqual(self.main._youtube_cache_ttl(none), 3 * 3600)

    def test_the_earliest_expiry_of_several_formats_wins(self):
        now = int(time.time())
        info = {"formats": [
            {"url": f"https://a.googlevideo.com/v?expire={now + 20000}"},
            {"url": f"https://b.googlevideo.com/v?expire={now + 2000}"},
        ]}
        self.assertAlmostEqual(self.main._youtube_cache_ttl(info), 1700, delta=5)

    def test_the_setting_can_be_changed_without_code(self):
        with mock.patch.object(self.main, "YOUTUBE_CACHE_TTL_SECONDS", 1800):
            self.assertEqual(self.main._youtube_cache_ttl(YT_INFO), 1800)


if __name__ == "__main__":
    unittest.main(verbosity=2)
