"""
The YouTube diagnostic: what it reports, what it never reveals, and that it stays out of the way.

Run from the scraper/ folder:  python -m unittest discover -s tests -v
"""

import asyncio
import json
import os
import socket
import ssl
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import diagnose  # noqa: E402

YT = "https://www.youtube.com/watch?v=jNQXAC9IVRw"
SECRET = "super-secret-cookie-value-12345"
INFO = {"id": "abc", "title": "ok", "formats": [
    {"format_id": "18", "url": "https://x.googlevideo.com/v", "ext": "mp4", "vcodec": "avc1", "acodec": "mp4a", "height": 360, "protocol": "https"}]}


def cookies(lines: list[str]) -> str:
    handle, path = tempfile.mkstemp(suffix="-cookies.txt")
    with os.fdopen(handle, "w") as out:
        out.write("# Netscape HTTP Cookie File\n" + "\n".join(lines) + "\n")
    return path


def row(name, domain=".youtube.com", expiry=2_000_000_000, http_only=False):
    return f"{'#HttpOnly_' if http_only else ''}{domain}\tTRUE\t/\tTRUE\t{expiry}\t{name}\t{SECRET}-{name}"


class CookieSummaryTests(unittest.TestCase):
    def test_a_logged_in_file_is_recognised_by_cookie_names_alone(self):
        path = cookies([row("SID"), row("SAPISID"), row("__Secure-3PSID", http_only=True), row("CONSENT"), row("PREF")])
        try:
            summary = diagnose.cookie_summary(path)
        finally:
            os.unlink(path)
        self.assertTrue(summary["detected"] and summary["readable"] and summary["loggedIn"])
        self.assertEqual(summary["entries"], 5)
        self.assertEqual(summary["authCookiesPresent"], ["SAPISID", "SID", "__Secure-3PSID"])

    def test_no_cookie_value_ever_appears_in_the_summary(self):
        path = cookies([row("SID"), row("SAPISID"), row("LOGIN_INFO")])
        try:
            text = json.dumps(diagnose.cookie_summary(path))
        finally:
            os.unlink(path)
        self.assertNotIn(SECRET, text)
        self.assertNotIn("secret", text.lower())

    def test_a_file_without_a_session_is_reported_as_not_logged_in(self):
        path = cookies([row("CONSENT"), row("PREF"), row("VISITOR_INFO1_LIVE")])
        try:
            summary = diagnose.cookie_summary(path)
        finally:
            os.unlink(path)
        self.assertFalse(summary["loggedIn"])
        self.assertEqual(summary["authCookiesPresent"], [])

    def test_expired_entries_are_counted(self):
        path = cookies([row("SID", expiry=1_000), row("SAPISID", expiry=2_000_000_000), row("HSID", expiry=0)])
        try:
            summary = diagnose.cookie_summary(path, now=1_700_000_000)
        finally:
            os.unlink(path)
        self.assertEqual(summary["expired"], 1, "expiry 0 means a session cookie, not an expired one")

    def test_other_sites_and_junk_lines_are_ignored(self):
        path = cookies([row("SID", domain=".example.com"), "not a cookie line", "", "# a comment", row("SAPISID")])
        try:
            summary = diagnose.cookie_summary(path)
        finally:
            os.unlink(path)
        self.assertEqual(summary["entries"], 1)

    def test_no_file_and_an_unreadable_file(self):
        self.assertEqual(diagnose.cookie_summary(None), {"detected": False})
        with mock.patch("builtins.open", side_effect=PermissionError("denied")):
            summary = diagnose.cookie_summary("/etc/secrets/youtube_cookies.txt")
        self.assertEqual(summary, {"detected": True, "readable": False, "error": "PermissionError"})


class NetworkProbeTests(unittest.TestCase):
    def test_a_dns_failure_is_reported_as_such(self):
        with mock.patch.object(socket, "getaddrinfo", side_effect=socket.gaierror("no such host")):
            result = diagnose.probe_network()
        self.assertEqual(result["dnsError"], "gaierror")
        self.assertNotIn("tcpMs", result)

    def test_a_connection_that_times_out_is_reported_with_how_long_it_waited(self):
        with mock.patch.object(socket, "getaddrinfo", return_value=[(2, 1, 6, "", ("142.250.0.1", 443))]), \
                mock.patch.object(socket, "create_connection", side_effect=socket.timeout("timed out")):
            result = diagnose.probe_network(timeout=0.1)
        self.assertIn(result["tcpError"], ("timeout", "TimeoutError"))
        self.assertIn("tcpWaitedMs", result)
        self.assertIn("dnsMs", result)

    def test_a_full_success_reports_every_step(self):
        fake_tls = mock.MagicMock()
        fake_tls.__enter__.return_value = fake_tls
        fake_tls.recv.return_value = b"HTTP/1.1 204 No Content\r\nX: y\r\n\r\n"
        context = mock.MagicMock()
        context.wrap_socket.return_value = fake_tls
        with mock.patch.object(socket, "getaddrinfo", return_value=[(2, 1, 6, "", ("142.250.0.1", 443))]), \
                mock.patch.object(socket, "create_connection", return_value=mock.MagicMock()), \
                mock.patch.object(ssl, "create_default_context", return_value=context):
            result = diagnose.probe_network()
        self.assertEqual(result["httpStatus"], "204")
        for key in ("dnsMs", "tcpMs", "tlsMs", "httpMs"):
            self.assertIn(key, result)
        self.assertNotIn("dnsError", result)

    def test_a_stall_after_connecting_is_reported_separately(self):
        fake_tls = mock.MagicMock()
        fake_tls.__enter__.return_value = fake_tls
        fake_tls.recv.side_effect = socket.timeout("timed out")
        context = mock.MagicMock()
        context.wrap_socket.return_value = fake_tls
        with mock.patch.object(socket, "getaddrinfo", return_value=[(2, 1, 6, "", ("142.250.0.1", 443))]), \
                mock.patch.object(socket, "create_connection", return_value=mock.MagicMock()), \
                mock.patch.object(ssl, "create_default_context", return_value=context):
            result = diagnose.probe_network()
        self.assertIn("tlsOrHttpError", result)
        self.assertIn("tcpMs", result)


class ReadingTests(unittest.TestCase):
    def read(self, network=None, ok=False, code=None, trace=None, cookies=None):
        return diagnose.interpret(network or {"httpStatus": "204"}, ok, code, trace or [], cookies or {"detected": True, "loggedIn": True})

    def test_success(self):
        self.assertIn("works", self.read(ok=True))

    def test_each_network_layer_gets_its_own_explanation(self):
        self.assertIn("DNS", self.read({"dnsError": "gaierror"}))
        self.assertIn("cannot open a connection", self.read({"tcpError": "timeout"}))
        self.assertIn("handshake", self.read({"tlsOrHttpError": "timeout"}))

    def test_a_stalled_api_request_points_at_ip_blocking_and_names_the_request(self):
        trace = [{"route": 0}, {"request": "www.youtube.com/youtubei/v1/player", "ms": 8000, "result": "TimeoutError"}]
        text = self.read(trace=trace, code="PLATFORM_TIMEOUT")
        self.assertIn("youtubei/v1/player", text)
        self.assertIn("proxy", text.lower())

    def test_cookies_without_a_session_are_called_out(self):
        self.assertIn("no logged-in", self.read(cookies={"detected": True, "loggedIn": False}).lower())

    def test_a_refusal_suggests_fresh_cookies(self):
        self.assertIn("cookies", self.read(code="STREAM_EXPIRED_OR_BLOCKED").lower())


class EndpointTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            import main
            from fastapi.testclient import TestClient
        except ImportError as exc:  # pragma: no cover
            raise unittest.SkipTest(f"dependencies missing: {exc}")
        cls.main = main
        cls.client = TestClient(main.app, raise_server_exceptions=False)

    def setUp(self):
        self.main.INFO_CACHE.clear()
        self.main.YOUTUBE_BREAKER.reset()
        env = mock.patch.dict(os.environ, {"SCRAPER_SHARED_SECRET": "", "SCRAPER_REQUIRE_SECRET": ""})
        env.start()
        self.addCleanup(env.stop)
        default = mock.patch.object(self.main, "YOUTUBE_COOKIES_DEFAULT_PATH", "/no/such/place.txt")
        default.start()
        self.addCleanup(default.stop)
        net = mock.patch.object(self.main, "probe_network", return_value={"host": "www.youtube.com", "dnsMs": 3, "tcpMs": 20, "tlsMs": 40, "httpMs": 30, "httpStatus": "204"})
        net.start()
        self.addCleanup(net.stop)

    def get(self, url=YT, **headers):
        return self.client.get("/diagnose/youtube", params={"url": url}, headers=headers)

    def test_it_needs_the_shared_secret_like_stats_does(self):
        with mock.patch.dict(os.environ, {"SCRAPER_SHARED_SECRET": "s3cret"}):
            self.assertEqual(self.get().status_code, 401)
            self.assertEqual(self.get(**{"X-Scraper-Key": "wrong"}).status_code, 401)
            with mock.patch.object(self.main, "_extract_info", return_value=INFO):
                self.assertEqual(self.get(**{"X-Scraper-Key": "s3cret"}).status_code, 200)

    def test_it_refuses_anything_that_is_not_a_youtube_link(self):
        for url in ("https://www.tiktok.com/@a/video/1", "https://evil.example/", "http://169.254.169.254/"):
            response = self.get(url)
            self.assertEqual(response.status_code, 400, url)
            self.assertEqual(response.json()["detail"]["code"], "INVALID_URL")

    def test_a_working_lookup_reports_everything(self):
        with mock.patch.object(self.main, "_extract_info", return_value=INFO):
            body = self.get().json()
        self.assertTrue(body["lookup"]["ok"])
        self.assertEqual(body["network"]["httpStatus"], "204")
        self.assertEqual(body["cookies"], {"detected": False})
        self.assertEqual(body["routes"][0]["clients"], ["android"])
        self.assertEqual(body["socketTimeoutSeconds"], 8)
        self.assertIn("works", body["reading"])
        self.assertIsInstance(body["trace"], list)

    def test_a_failing_lookup_reports_the_code_and_a_reading(self):
        from yt_dlp.utils import DownloadError

        with mock.patch.object(self.main, "_extract_info", side_effect=DownloadError("ERROR: Sign in to confirm you're not a bot")):
            body = self.get().json()
        self.assertFalse(body["lookup"]["ok"])
        self.assertEqual(body["lookup"]["code"], "STREAM_EXPIRED_OR_BLOCKED")
        self.assertTrue(body["reading"])

    def test_the_cookie_values_never_leave_the_server(self):
        path = cookies([row("SID"), row("SAPISID"), row("LOGIN_INFO")])
        try:
            with mock.patch.dict(os.environ, {"YOUTUBE_COOKIES_FILE": path}), \
                    mock.patch.object(self.main, "_extract_info", return_value=INFO):
                response = self.get()
                stats = self.client.get("/stats").json()
        finally:
            os.unlink(path)
        self.assertNotIn(SECRET, response.text)
        self.assertNotIn(SECRET, json.dumps(stats))
        self.assertTrue(response.json()["cookies"]["loggedIn"])
        self.assertTrue(stats["youtube"]["cookies"]["detected"])

    def test_it_ignores_an_open_breaker_and_does_not_feed_it(self):
        from yt_dlp.utils import DownloadError

        for _ in range(3):
            self.main.YOUTUBE_BREAKER.record_failure()
        self.assertTrue(self.main.YOUTUBE_BREAKER.is_open())
        calls = []

        def boom(url, route=0):
            calls.append(route)
            raise DownloadError("ERROR: Sign in to confirm you're not a bot")

        with mock.patch.object(self.main, "_extract_info", boom):
            body = self.get().json()
        self.assertTrue(calls, "a diagnostic must really try, even while the breaker is open")
        self.assertEqual(body["lookup"]["code"], "STREAM_EXPIRED_OR_BLOCKED")
        self.main.YOUTUBE_BREAKER.reset()
        with mock.patch.object(self.main, "_extract_info", boom):
            self.get()
            self.get()
            self.get()
        self.assertFalse(self.main.YOUTUBE_BREAKER.is_open(), "diagnostic runs must not trip the breaker for visitors")

    def test_only_one_run_at_a_time(self):
        self.assertTrue(self.main._diagnose_lock.acquire(blocking=False))
        try:
            response = self.get()
        finally:
            self.main._diagnose_lock.release()
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["detail"]["code"], "SERVER_BUSY")

    def test_the_memory_guard_applies(self):
        with mock.patch.object(self.main, "rss_mb", return_value=self.main.MEMORY_SOFT_LIMIT_MB + 50):
            self.assertEqual(self.get().status_code, 503)
        self.assertTrue(self.main._diagnose_lock.acquire(blocking=False), "the lock must be released on every path")
        self.main._diagnose_lock.release()

    def test_a_stalled_lookup_still_returns_a_report_in_time(self):
        release = threading.Event()

        def stuck(url, route=0):
            release.wait(10)

        started = time.monotonic()
        with mock.patch.object(self.main, "_extract_info", stuck), \
                mock.patch.object(self.main, "YOUTUBE_EXTRACTION_TIMEOUT_SECONDS", 0.3), \
                mock.patch.object(self.main, "DEADLINE_GRACE_SECONDS", 0.1):
            import httpx

            async def go():
                transport = httpx.ASGITransport(app=self.main.app, raise_app_exceptions=False)
                async with httpx.AsyncClient(transport=transport, base_url="http://scraper") as client:
                    response = await client.get("/diagnose/youtube", params={"url": YT})
                release.set()
                await asyncio.sleep(0.2)
                return response

            response = asyncio.run(go())
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["lookup"]["code"], "PLATFORM_TIMEOUT")
        self.assertLess(time.monotonic() - started, 6.0)

    def test_the_trace_lists_each_request_by_host_and_path_only(self):
        trace = []
        ydl = self.main._DeadlineYDL({"quiet": True}, deadline=time.monotonic() + 30, trace=trace)
        response = mock.Mock(status=200)
        with mock.patch.object(self.main.yt_dlp.YoutubeDL, "urlopen", return_value=response):
            ydl.urlopen("https://www.youtube.com/youtubei/v1/player?prettyPrint=false&key=SECRETKEY")
        with mock.patch.object(self.main.yt_dlp.YoutubeDL, "urlopen", side_effect=TimeoutError("slow")):
            with self.assertRaises(TimeoutError):
                ydl.urlopen("https://www.youtube.com/youtubei/v1/next?x=SECRETKEY")
        self.assertEqual([e["request"] for e in trace], ["www.youtube.com/youtubei/v1/player", "www.youtube.com/youtubei/v1/next"])
        self.assertEqual([e["result"] for e in trace], [200, "TimeoutError"])
        self.assertNotIn("SECRETKEY", json.dumps(trace), "query strings (keys, ids, signatures) are never recorded")

    def test_tracing_is_off_for_normal_lookups(self):
        ydl = self.main._DeadlineYDL({"quiet": True}, deadline=time.monotonic() + 30)
        with mock.patch.object(self.main.yt_dlp.YoutubeDL, "urlopen", return_value=mock.Mock(status=200)):
            ydl.urlopen("https://www.youtube.com/")
        self.assertIsNone(ydl._trace)


class ProxyProbeTests(unittest.TestCase):
    PROXY = "http://webshare-user:hunter2-secret@p.webshare.io:80"

    def probe(self, status=None, error=None):
        import httpx

        class Client:
            def __init__(self, **kwargs):
                self.kwargs = kwargs

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

            def get(self, url):
                if error:
                    raise error
                return mock.Mock(status_code=status)

        with mock.patch.object(diagnose.httpx, "Client", Client):
            return diagnose.probe_proxy(self.PROXY)

    def test_a_working_proxy_is_reported_with_its_host_and_no_login(self):
        result = self.probe(status=204)
        self.assertTrue(result["ok"])
        self.assertEqual(result["host"], "p.webshare.io:80")
        self.assertNotIn("hunter2", json.dumps(result))

    def test_a_rejected_login_is_407(self):
        result = self.probe(status=407)
        self.assertFalse(result["ok"])
        self.assertIn("login", diagnose.interpret({}, False, None, [], {}, result))

    def test_an_exhausted_or_suspended_plan_is_402_or_403(self):
        for status in (402, 403):
            reading = diagnose.interpret({}, False, None, [], {}, self.probe(status=status))
            self.assertIn("bandwidth", reading)

    def test_an_unreachable_proxy_is_reported_without_leaking_its_login(self):
        import httpx

        result = self.probe(error=httpx.ConnectError(f"all connection attempts failed for {self.PROXY}"))
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "ConnectError")
        self.assertNotIn("hunter2", json.dumps(result))
        self.assertIn("could not be reached", diagnose.interpret({}, False, None, [], {}, result))

    def test_a_rejected_proxy_setting_is_named_in_the_reading(self):
        for lookup_ok in (False, True):
            reading = diagnose.interpret({}, lookup_ok, None, [], {}, None, "rejected")
            self.assertIn("YTDLP_PROXY is set but could not be used", reading.replace("YouTube works from this host, but y", "Y"))
            self.assertIn("HOST:PORT:USERNAME:PASSWORD", reading)

    def test_a_usable_setting_does_not_trigger_the_rejected_reading(self):
        for setting in (None, "off", "ok", "converted"):
            self.assertNotIn("could not be used", diagnose.interpret({}, True, None, [], {}, {"ok": True}, setting))

    def test_success_through_the_proxy_says_so(self):
        reading = diagnose.interpret({}, True, None, [], {}, {"ok": True})
        self.assertIn("through the proxy", reading)

    def test_a_healthy_proxy_but_a_failing_lookup_falls_through_to_the_normal_reading(self):
        reading = diagnose.interpret({"httpStatus": "204"}, False, "STREAM_EXPIRED_OR_BLOCKED", [], {"detected": False}, {"ok": True})
        self.assertIn("refused", reading)


if __name__ == "__main__":
    unittest.main(verbosity=2)
