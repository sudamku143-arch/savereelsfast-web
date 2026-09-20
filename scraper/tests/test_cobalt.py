"""
The Cobalt fallback for YouTube: only used when yt-dlp is blocked or stalls, only asks about a video id, only
trusts links on the instance itself (or a platform CDN), never uses the paid proxy, and never leaks its key.

Run from the scraper/ folder:  python -m unittest discover -s tests -v
"""

import json
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

import httpx

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import cobalt  # noqa: E402
import errors  # noqa: E402
from errors import ScraperError  # noqa: E402

INSTANCE = "https://cobalt.example.org/"
KEY = "11111111-2222-3333-4444-secret-key"
VIDEO = "jNQXAC9IVRw"
YT = f"https://www.youtube.com/watch?v={VIDEO}"
SHORT = f"https://www.youtube.com/shorts/{VIDEO}"
TUNNEL = "https://cobalt.example.org/tunnel?id=abc&exp=1&sig=x"


def answer(payload, status=200, seen=None):
    def handler(request: httpx.Request) -> httpx.Response:
        if seen is not None:
            seen.append(request)
        return httpx.Response(status, json=payload)

    return httpx.MockTransport(handler)


def make(api_key=None, instances=(INSTANCE,), timeout=4.0):
    return cobalt.Cobalt(list(instances), api_key, timeout)


class InstanceSettingTests(unittest.TestCase):
    def test_only_plain_https_instances_are_accepted(self):
        with self.assertLogs("uvicorn.error", level="WARNING"):
            found = cobalt.parse_instances(
                "https://a.example.org, http://insecure.example.org, ftp://x.org, https://user:pw@evil.org, nonsense, https://b.example.org/api/"
            )
        self.assertEqual(found, ["https://a.example.org/", "https://b.example.org/api/"])

    def test_unset_means_off(self):
        self.assertEqual(cobalt.parse_instances(None), [])
        self.assertFalse(make(instances=()).enabled)


class FetchTests(unittest.TestCase):
    def test_a_tunnel_answer_becomes_an_mp4_info_dict(self):
        info = make().fetch(VIDEO, transport=answer({"status": "tunnel", "url": TUNNEL, "filename": "youtube_jNQXAC9IVRw_1920x1080_h264.mp4"}))
        fmt = info["formats"][0]
        self.assertEqual((fmt["url"], fmt["ext"], fmt["height"], fmt["width"]), (TUNNEL, "mp4", 1080, 1920))
        self.assertEqual(info["_via"], "cobalt")
        self.assertEqual(info["id"], VIDEO)

    def test_only_the_video_id_is_sent_and_no_other_data(self):
        seen: list[httpx.Request] = []
        make().fetch(VIDEO, transport=answer({"status": "tunnel", "url": TUNNEL}, seen=seen))
        request = seen[0]
        self.assertEqual(json.loads(request.content)["url"], YT)
        self.assertEqual(set(request.headers) - {"host", "accept", "content-type", "content-length", "user-agent", "accept-encoding", "connection"}, set())

    def test_the_api_key_is_sent_as_a_header_only_when_configured(self):
        seen: list[httpx.Request] = []
        make(KEY).fetch(VIDEO, transport=answer({"status": "tunnel", "url": TUNNEL}, seen=seen))
        self.assertEqual(seen[0].headers["authorization"], f"Api-Key {KEY}")
        seen.clear()
        make().fetch(VIDEO, transport=answer({"status": "tunnel", "url": TUNNEL}, seen=seen))
        self.assertNotIn("authorization", seen[0].headers)

    def test_a_tunnel_link_on_another_host_is_refused(self):
        for hostile in ("https://evil.example.net/tunnel?x=1", "http://cobalt.example.org/tunnel", "https://cobalt.example.org:8443/tunnel",
                        "https://169.254.169.254/latest/meta-data/", "https://cobalt.example.org.evil.net/tunnel"):
            with self.assertRaises(cobalt.CobaltUnavailable, msg=hostile):
                make().fetch(VIDEO, transport=answer({"status": "tunnel", "url": hostile}))

    def test_a_redirect_link_must_be_on_a_platform_cdn(self):
        info = make().fetch(VIDEO, transport=answer({"status": "redirect", "url": "https://rr1---sn-x.googlevideo.com/videoplayback?a=1"}))
        self.assertEqual(info["_via"], "cobalt")
        with self.assertRaises(cobalt.CobaltUnavailable):
            make().fetch(VIDEO, transport=answer({"status": "redirect", "url": "https://evil.example.net/x.mp4"}))

    def test_errors_pickers_and_junk_are_no_result(self):
        cases = [
            {"status": "error", "error": {"code": "error.api.auth.jwt.missing"}},
            {"status": "picker", "picker": []},
            {"status": "local-processing", "url": TUNNEL},
            {"status": "tunnel"},
            {"status": "tunnel", "url": 5},
            ["not", "a", "dict"],
        ]
        for payload in cases:
            with self.assertRaises(cobalt.CobaltUnavailable, msg=str(payload)):
                make().fetch(VIDEO, transport=answer(payload))

    def test_http_failures_timeouts_and_non_json_are_no_result(self):
        with self.assertRaises(cobalt.CobaltUnavailable):
            make().fetch(VIDEO, transport=answer({"status": "tunnel", "url": TUNNEL}, status=502))
        with self.assertRaises(cobalt.CobaltUnavailable):
            make().fetch(VIDEO, transport=httpx.MockTransport(lambda r: httpx.Response(200, text="<html>hi</html>")))

        def slow(request):
            raise httpx.ReadTimeout("slow", request=request)

        with self.assertRaises(cobalt.CobaltUnavailable) as caught:
            make().fetch(VIDEO, transport=httpx.MockTransport(slow))
        self.assertEqual(str(caught.exception), "timeout")

    def test_an_oversized_answer_is_cut_off(self):
        big = httpx.MockTransport(lambda r: httpx.Response(200, content=b"x" * (cobalt.MAX_RESPONSE_BYTES + 10)))
        with self.assertRaises(cobalt.CobaltUnavailable):
            make().fetch(VIDEO, transport=big)

    def test_the_next_instance_is_tried_when_the_first_fails(self):
        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.host == "one.example.org":
                return httpx.Response(500)
            return httpx.Response(200, json={"status": "tunnel", "url": "https://two.example.org/tunnel?a=1"})

        client = make(instances=("https://one.example.org/", "https://two.example.org/"))
        info = client.fetch(VIDEO, transport=httpx.MockTransport(handler))
        self.assertTrue(info["formats"][0]["url"].startswith("https://two.example.org/"))
        self.assertEqual((client.attempts, client.successes), (2, 1))

    def test_a_bad_video_id_is_never_sent(self):
        seen: list[httpx.Request] = []
        with self.assertRaises(cobalt.CobaltUnavailable):
            make().fetch("x&url=http://evil", transport=answer({"status": "tunnel", "url": TUNNEL}, seen=seen))
        self.assertEqual(seen, [])

    def test_failures_never_carry_the_key(self):
        def boom(request):
            raise httpx.ConnectError(f"cannot reach {request.headers.get('authorization')}", request=request)

        client = make(KEY)
        with self.assertRaises(cobalt.CobaltUnavailable) as caught:
            client.fetch(VIDEO, transport=httpx.MockTransport(boom))
        self.assertNotIn("secret-key", str(caught.exception))
        self.assertNotIn("secret-key", json.dumps(client.stats()))

    def test_media_urls_on_the_instance_are_recognised_exactly(self):
        client = make()
        self.assertTrue(client.is_media_url(TUNNEL))
        for other in ("http://cobalt.example.org/tunnel", "https://evil.org/tunnel", "https://cobalt.example.org.evil.org/x", "https://cobalt.example.org:444/x"):
            self.assertFalse(client.is_media_url(other), other)
        self.assertFalse(make(instances=()).is_media_url(TUNNEL))


# ------------------------------------------------------------------------------------------ in the scraper


class ScraperTests(unittest.TestCase):
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
        self.transport = answer({"status": "tunnel", "url": TUNNEL, "filename": "youtube_x_1280x720_h264.mp4"})
        self.client = make(KEY)
        real_fetch = self.client.fetch
        self.client.fetch = lambda vid, budget=None, transport=None: real_fetch(vid, budget, self.transport)
        for patch in (
            mock.patch.object(m, "COBALT", self.client),
            mock.patch.object(m, "YTDLP_PROXY", "http://u:p@proxy.example.net:80"),
            mock.patch.dict(os.environ, {"SCRAPER_SHARED_SECRET": "", "SCRAPER_REQUIRE_SECRET": ""}),
        ):
            patch.start()
            self.addCleanup(patch.stop)

    def failing_ytdlp(self, error):
        return mock.patch.object(self.main, "_extract_info", side_effect=error)

    def test_a_blocked_youtube_lookup_falls_back_to_cobalt(self):
        for failure in (ScraperError(errors.STREAM_EXPIRED_OR_BLOCKED), ScraperError(errors.PLATFORM_TIMEOUT), ScraperError(errors.LOGIN_REQUIRED)):
            self.main.INFO_CACHE.clear()
            with self.failing_ytdlp(failure):
                resolved, info = self.main._resolve_and_extract(YT)
            self.assertEqual(info["_via"], "cobalt", failure.code)
            self.assertEqual(self.main._pick_video(info)[0], TUNNEL)

    def test_shorts_and_short_links_fall_back_too(self):
        for link in (SHORT, f"https://youtu.be/{VIDEO}"):
            with self.failing_ytdlp(ScraperError(errors.PLATFORM_TIMEOUT)):
                _, info = self.main._resolve_and_extract(link)
            self.assertEqual(info["id"], VIDEO, link)

    def test_it_is_not_asked_when_ytdlp_works(self):
        good = {"id": "abc", "title": "t", "formats": [{"url": "https://rr1.googlevideo.com/videoplayback?a=1", "ext": "mp4",
                "vcodec": "avc1", "acodec": "mp4a", "height": 360, "protocol": "https"}]}
        with mock.patch.object(self.main, "_extract_info", return_value=good):
            _, info = self.main._resolve_and_extract(YT)
        self.assertNotIn("_via", info)
        self.assertEqual(self.client.attempts, 0)

    def test_other_failures_and_other_platforms_do_not_ask_cobalt(self):
        with self.failing_ytdlp(ScraperError(errors.UNSUPPORTED_POST)):
            with self.assertRaises(ScraperError):
                self.main._resolve_and_extract(YT)
        with self.failing_ytdlp(ScraperError(errors.PLATFORM_TIMEOUT)):
            with self.assertRaises(ScraperError):
                self.main._resolve_and_extract("https://www.tiktok.com/@scout2015/video/6718335390845095173")
        self.assertEqual(self.client.attempts, 0)

    def test_when_cobalt_has_nothing_the_original_error_is_kept(self):
        self.transport = answer({"status": "error", "error": {"code": "error.api.youtube.login"}})
        with self.failing_ytdlp(ScraperError(errors.PLATFORM_TIMEOUT)):
            with self.assertRaises(ScraperError) as caught:
                self.main._resolve_and_extract(YT)
        self.assertEqual(caught.exception.code, errors.PLATFORM_TIMEOUT)

    def test_switched_off_by_default(self):
        with mock.patch.object(self.main, "COBALT", make(instances=())):
            with self.failing_ytdlp(ScraperError(errors.PLATFORM_TIMEOUT)):
                with self.assertRaises(ScraperError):
                    self.main._resolve_and_extract(YT)

    def test_the_diagnostic_sees_ytdlps_own_answer(self):
        token = self.main._bypass_breaker.set(True)
        try:
            with self.failing_ytdlp(ScraperError(errors.PLATFORM_TIMEOUT)):
                with self.assertRaises(ScraperError):
                    self.main._resolve_and_extract(YT)
        finally:
            self.main._bypass_breaker.reset(token)
        self.assertEqual(self.client.attempts, 0)

    def test_while_the_breaker_is_open_cobalt_answers_at_once_without_asking_ytdlp(self):
        for _ in range(3):
            self.main.YOUTUBE_BREAKER.record_failure()
        self.main._youtube_last_failure[0] = errors.PLATFORM_TIMEOUT
        with mock.patch.object(self.main, "_extract_info", side_effect=AssertionError("yt-dlp must not run")):
            _, info = self.main._resolve_and_extract(YT)
        self.assertEqual(info["_via"], "cobalt")

    def test_a_cobalt_result_is_cached_only_briefly(self):
        _, info = self.main._cobalt_fallback(YT, ScraperError(errors.PLATFORM_TIMEOUT))
        self.assertEqual(self.main._youtube_cache_ttl(info), 60.0)

    def test_ytdlp_gets_a_shorter_share_of_the_budget_so_the_total_stays_the_same(self):
        import time

        seen = {}

        def fail(*args, **kwargs):
            seen["deadline"] = self.main._deadline.get()
            raise ScraperError(errors.PLATFORM_TIMEOUT)

        started = time.monotonic()
        with mock.patch.object(self.main, "_extract_info", side_effect=fail):
            self.main._resolve_and_extract(YT)
        share = seen["deadline"] - started
        self.assertLessEqual(share, self.main.YOUTUBE_EXTRACTION_TIMEOUT_SECONDS - self.client.timeout + 0.5)
        self.assertGreaterEqual(share, 4.5)  # never squeezed below ~5 s

    # -------------------------------------------------------------------------------------- HTTP routes

    def test_the_extract_route_returns_the_cobalt_link(self):
        from fastapi.testclient import TestClient

        with self.failing_ytdlp(ScraperError(errors.LOGIN_REQUIRED)):
            response = TestClient(self.main.app, raise_server_exceptions=False).get("/extract", params={"url": YT})
        body = response.json()
        self.assertEqual(response.status_code, 200, body)
        self.assertEqual((body["success"], body["videoUrl"], body["quality"]), (True, TUNNEL, "720p"))
        self.assertEqual(body["id"], VIDEO)

    def test_the_extract_route_still_reports_the_error_when_cobalt_has_nothing(self):
        from fastapi.testclient import TestClient

        self.transport = answer({"status": "error", "error": {"code": "error.api.fetch.fail"}})
        with self.failing_ytdlp(ScraperError(errors.PLATFORM_TIMEOUT)):
            response = TestClient(self.main.app, raise_server_exceptions=False).get("/extract", params={"url": YT})
        self.assertEqual(response.json()["detail"]["code"], errors.PLATFORM_TIMEOUT)

    def test_the_download_streams_the_tunnel_directly_and_never_through_the_paid_proxy(self):
        made = []

        class Response:
            headers = {"Content-Length": "5"}

            def read(self, n):
                return b""

            def close(self):
                pass

        class YDL:
            def __init__(self, params, *a, **k):
                made.append(params)

            def urlopen(self, request):
                made.append(request.url)
                return Response()

            def close(self):
                pass

        with self.failing_ytdlp(ScraperError(errors.PLATFORM_TIMEOUT)):
            resolved, info = self.main._resolve_and_extract(YT)
        with mock.patch.object(self.main.yt_dlp, "YoutubeDL", YDL):
            stream = self.main._open_stream_from_info(resolved, info, "video", 0)
        self.assertFalse(stream.via_proxy)
        self.assertNotIn("proxy", made[0])
        self.assertEqual(made[1], TUNNEL)

    def test_a_link_off_the_instance_is_still_refused_for_streaming(self):
        hostile = {"id": "x", "formats": [{"url": "https://evil.example.net/x.mp4", "ext": "mp4", "vcodec": "h264", "acodec": "aac", "protocol": "https"}], "_via": "cobalt"}
        with self.assertRaises(ScraperError):
            self.main._open_stream_from_info(YT, hostile, "video", 0)

    def test_the_startup_log_says_whether_the_fallback_is_on_without_the_key(self):
        with self.assertLogs("uvicorn.error", level="INFO") as logs:
            self.main._report_cobalt_fallback()
        text = chr(10).join(logs.output)
        self.assertIn("ON via cobalt.example.org", text)
        self.assertIn("API key set", text)
        self.assertNotIn("secret-key", text)
        with mock.patch.object(self.main, "COBALT", make(instances=())):
            with self.assertLogs("uvicorn.error", level="INFO") as logs:
                self.main._report_cobalt_fallback()
        self.assertIn("OFF (COBALT_API_URL is not set)", chr(10).join(logs.output))

    def test_stats_show_the_fallback_without_the_key(self):
        from fastapi.testclient import TestClient

        body = TestClient(self.main.app).get("/stats").json()
        self.assertEqual(body["cobalt"]["instances"], ["cobalt.example.org"])
        self.assertIs(body["cobalt"]["apiKeySet"], True)
        self.assertEqual(body["cobalt"]["timeoutSeconds"], 4.0)
        self.assertNotIn("secret-key", json.dumps(body))


if __name__ == "__main__":
    unittest.main()
