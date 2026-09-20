"""
Defensive security: who may call the scraper, and which links it will ever touch.

Run from the scraper/ folder:  python -m unittest discover -s tests -v
"""

import os
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import urls  # noqa: E402
from urls import UnsupportedUrl, check_url_shape, resolve_url  # noqa: E402

GOOD = "https://www.youtube.com/watch?v=jNQXAC9IVRw"

# Every one of these must be refused before a single request is made.
HOSTILE_LINKS = [
    # scheme tricks
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    "ftp://www.youtube.com/watch?v=abc",
    "gopher://www.youtube.com/",
    # credentials / userinfo tricks
    "https://youtube.com@evil.example/watch?v=abc",
    "https://user:pass@www.youtube.com/watch?v=abc",
    "https://www.youtube.com:secret@evil.example/",
    # ports
    "https://www.youtube.com:8080/watch?v=abc",
    "http://www.youtube.com:22/watch?v=abc",
    "https://www.youtube.com:notaport/watch?v=abc",
    # parser-confusion tricks
    "https://evil.example\\@www.youtube.com/watch?v=abc",
    "https://evil.example#@www.youtube.com/watch?v=abc",
    "https://evil.example/www.youtube.com/watch?v=abc",
    "https://www.youtube.com.evil.example/watch?v=abc",
    "https://evilyoutube.com/watch?v=abc",
    "https://youtube.com%2eevil.example/watch?v=abc",
    # smuggling via whitespace / control characters
    "https://www.youtube.com/watch?v=abc\r\nHost: evil.example",
    "https://www.youtube.com/watch?v=abc\nX-Injected: 1",
    "https://www.youtube.com/watch?v=abc\x00.evil.example",
    "https://www.youtube.com/wat ch?v=abc",
    "\thttps://evil.example/",
    # internal / metadata addresses
    "http://127.0.0.1/",
    "http://localhost/watch?v=abc",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/",
    "http://0.0.0.0/",
    "http://2130706433/",
    # size / emptiness
    "",
    "   ",
    "https://www.youtube.com/watch?v=" + "a" * 5000,
]


class UrlValidationTests(unittest.TestCase):
    def test_hostile_links_are_rejected_before_any_request(self):
        for link in HOSTILE_LINKS:
            with self.subTest(link=link[:70]):
                # A network call here would be a bug: fail loudly if one is attempted.
                with mock.patch("urllib.request.OpenerDirector.open", side_effect=AssertionError("network!")):
                    with self.assertRaises(UnsupportedUrl):
                        resolve_url(link)
                    with self.assertRaises(UnsupportedUrl):
                        urls.cache_key(link)

    def test_normal_links_still_work(self):
        for link in (GOOD, "https://youtu.be/jNQXAC9IVRw?si=x", "https://www.youtube.com:443/watch?v=abc",
                     "https://www.instagram.com/reel/AbC_123/?igsh=1"):
            with self.subTest(link=link):
                self.assertTrue(resolve_url(link).startswith("https://"))

    def test_shape_check_alone_accepts_a_plain_https_link(self):
        check_url_shape(GOOD)  # must not raise

    def test_redirect_targets_get_the_same_scrutiny(self):
        # A short link that bounces to a link with credentials must be refused, not followed.
        class Boom(Exception):
            pass

        def fake_open(self, request, timeout=None):
            import urllib.error
            import email.message

            headers = email.message.Message()
            headers["Location"] = "https://user:pw@www.youtube.com/watch?v=abc"
            raise urllib.error.HTTPError(request.full_url, 302, "Found", headers, None)

        with mock.patch("urllib.request.OpenerDirector.open", fake_open):
            with self.assertRaises(UnsupportedUrl):
                urls.expand_redirects("https://youtu.be/abc")


class SharedSecretTests(unittest.TestCase):
    """Every protected endpoint must refuse callers without the secret."""

    @classmethod
    def setUpClass(cls):
        try:
            import main
            from fastapi.testclient import TestClient
        except ImportError as exc:  # pragma: no cover
            raise unittest.SkipTest(f"dependencies missing: {exc}")
        cls.main = main
        cls.client = TestClient(main.app)

    PROTECTED = [
        ("/extract", {"url": GOOD}),
        ("/download", {"url": GOOD}),
        ("/stream", {"url": "https://rr1.googlevideo.com/videoplayback"}),
        ("/stats", {}),
    ]

    def setUp(self):
        self.main.INFO_CACHE.clear()
        self.main.NEGATIVE_CACHE.clear()

    def env(self, **values):
        base = {"SCRAPER_SHARED_SECRET": "", "SCRAPER_REQUIRE_SECRET": ""}
        base.update(values)
        return mock.patch.dict(os.environ, base)

    def test_every_protected_endpoint_rejects_a_missing_or_wrong_key(self):
        with self.env(SCRAPER_SHARED_SECRET="correct-horse-battery-staple"):
            for path, params in self.PROTECTED:
                for headers in ({}, {"X-Scraper-Key": "wrong"}, {"X-Scraper-Key": ""},
                                {"X-Scraper-Key": "correct-horse-battery-stapl"},   # one character short
                                {"X-Scraper-Key": "correct-horse-battery-staple "}):  # one character long
                    with self.subTest(path=path, key=headers.get("X-Scraper-Key")):
                        response = self.client.get(path, params=params, headers=headers)
                        self.assertEqual(response.status_code, 401, response.text)
                        self.assertEqual(response.json()["detail"]["code"], "UNAUTHORIZED")

    def test_rejection_happens_before_any_work(self):
        boom = mock.Mock(side_effect=AssertionError("extraction ran for an unauthorised request"))
        with self.env(SCRAPER_SHARED_SECRET="s3cret"), mock.patch.object(self.main, "_extract_info", boom):
            self.assertEqual(self.client.get("/extract", params={"url": GOOD}).status_code, 401)
        boom.assert_not_called()

    def test_the_right_key_is_accepted(self):
        info = {"id": "abc", "formats": [{"format_id": "18", "url": "https://x.googlevideo.com/v", "ext": "mp4",
                                            "vcodec": "avc1", "acodec": "mp4a", "height": 360, "protocol": "https"}]}
        with self.env(SCRAPER_SHARED_SECRET="s3cret"), mock.patch.object(self.main, "_extract_info", return_value=info):
            response = self.client.get("/extract", params={"url": GOOD}, headers={"X-Scraper-Key": "s3cret"})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(self.client.get("/stats", headers={"X-Scraper-Key": "s3cret"}).status_code, 200)

    def test_fail_closed_when_the_secret_is_required_but_missing(self):
        with self.env(SCRAPER_REQUIRE_SECRET="1"):
            for path, params in self.PROTECTED:
                with self.subTest(path=path):
                    response = self.client.get(path, params=params)
                    self.assertEqual(response.status_code, 503)
                    self.assertEqual(response.json()["detail"]["code"], "NOT_CONFIGURED")
            # ...even when the caller presents some key: there is nothing to compare it with.
            self.assertEqual(self.client.get("/stats", headers={"X-Scraper-Key": "anything"}).status_code, 503)

    def test_health_and_root_stay_public_and_reveal_nothing(self):
        with self.env(SCRAPER_SHARED_SECRET="s3cret", SCRAPER_REQUIRE_SECRET="1"):
            for path in ("/health", "/"):
                response = self.client.get(path)
                self.assertEqual(response.status_code, 200, path)
                self.assertEqual(response.content, b'{"status":"ok"}', f"{path} must not leak anything")

    def test_key_comparison_is_constant_time(self):
        source = (ROOT / "main.py").read_text(encoding="utf8")
        check = source[source.index("def _check_key"):source.index("def _is_direct_video")]
        self.assertIn("hmac.compare_digest", check)
        self.assertNotIn("key != secret", check)

    def test_interactive_api_docs_are_not_exposed(self):
        for path in ("/docs", "/redoc", "/openapi.json"):
            self.assertEqual(self.client.get(path).status_code, 404, path)


class CorsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            import main
            from fastapi.testclient import TestClient
        except ImportError as exc:  # pragma: no cover
            raise unittest.SkipTest(f"dependencies missing: {exc}")
        cls.client = TestClient(main.app)

    def test_no_website_may_call_the_scraper_from_a_browser(self):
        for headers in ({"Origin": "https://evil.example"}, {"Origin": "https://www.savereelsfast.com"}):
            response = self.client.get("/health", headers=headers)
            self.assertNotIn("access-control-allow-origin", response.headers)
        preflight = self.client.options(
            "/extract",
            headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "GET"},
        )
        self.assertNotIn("access-control-allow-origin", preflight.headers)


class MediaAllowListTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            import main
        except ImportError as exc:  # pragma: no cover
            raise unittest.SkipTest(f"dependencies missing: {exc}")
        cls.main = main

    def test_streaming_refuses_a_link_that_is_not_on_a_platform_cdn(self):
        from errors import ScraperError

        for bad in ("http://rr1.googlevideo.com/v", "https://evil.example/v.mp4",
                    "https://googlevideo.com.evil.example/v", "https://169.254.169.254/latest/meta-data/"):
            with self.subTest(url=bad):
                info = {"id": "x", "formats": [{"format_id": "1", "url": bad, "ext": "mp4", "vcodec": "avc1",
                                                 "acodec": "mp4a", "height": 360, "protocol": "https"}]}
                with self.assertRaises(ScraperError):
                    self.main._open_stream_from_info("https://www.youtube.com/watch?v=x", info, "video", 0)

    def test_threads_extractor_drops_links_that_are_not_on_the_cdn(self):
        import threading
        from http.server import BaseHTTPRequestHandler, HTTPServer

        import extractors

        page = (
            b'<meta property="og:video" content="https://evil.example/steal.mp4">'
            b'<script>{"video_versions":[{"type":101,"url":"http:\\/\\/169.254.169.254\\/x.mp4"}]}</script>'
        )

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802
                self.send_response(200)
                self.send_header("Content-Length", str(len(page)))
                self.end_headers()
                self.wfile.write(page)

            def log_message(self, *args):
                pass

        server = HTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            self.assertIsNone(extractors.extract_threads(f"http://127.0.0.1:{server.server_port}/@u/post/X"))
        finally:
            server.shutdown()
            server.server_close()

    def test_threads_fetch_will_not_follow_a_redirect_off_the_platform(self):
        import urllib.error

        import extractors

        handler = extractors._SafeRedirects()
        with self.assertRaises(urllib.error.URLError):
            handler.redirect_request(mock.Mock(), None, 302, "Found", {}, "http://169.254.169.254/latest/meta-data/")


if __name__ == "__main__":
    unittest.main(verbosity=2)
