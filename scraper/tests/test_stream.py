"""
The /stream endpoint (IP-bound CDN proxy) and the media-host allow-list.

Run from the scraper/ folder:  python -m unittest discover -s tests -v
"""

import os
import re
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import urls  # noqa: E402

VIDEO = b"\x00\x00\x00\x18ftypmp42" + b"v" * 150_000


class RecordingCdn:
    """Local stand-in for a CDN that records the request headers it receives."""

    def __init__(self, routes):
        self.seen = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802
                outer.seen.append({"path": self.path, **{k.lower(): v for k, v in self.headers.items()}})
                status, headers, body = routes.get(self.path, (404, {}, b"nope"))
                self.send_response(status)
                for key, value in headers.items():
                    self.send_header(key, value)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        self.base = f"http://127.0.0.1:{self.server.server_port}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def allow_local_only(url: str) -> bool:
    return url.startswith("http://127.0.0.1")


class StreamEndpointTests(unittest.TestCase):
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
        # The real allow-list only admits https platform CDNs; tests talk to localhost.
        patcher = mock.patch.object(self.main, "is_allowed_media_url", allow_local_only)
        patcher.start()
        self.addCleanup(patcher.stop)

    def cdn(self, routes):
        server = RecordingCdn(routes)
        self.addCleanup(server.close)
        return server

    def test_streams_from_the_cdn_with_browser_headers_and_referer(self):
        cdn = self.cdn({"/v.mp4": (200, {"Content-Type": "video/mp4"}, VIDEO)})
        response = self.client.get(
            "/stream",
            params={"url": f"{cdn.base}/v.mp4", "referer": "https://www.youtube.com/", "id": "abc123"},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.content, VIDEO)
        self.assertEqual(response.headers["content-type"], "video/mp4")
        self.assertEqual(
            response.headers["content-disposition"], 'attachment; filename="savereelsfast-abc123.mp4"'
        )
        sent = cdn.seen[0]
        self.assertIn("Mozilla/5.0", sent["user-agent"])
        self.assertEqual(sent["referer"], "https://www.youtube.com/")

    def test_untrusted_referer_is_replaced_by_the_default(self):
        cdn = self.cdn({"/v.mp4": (200, {"Content-Type": "video/mp4"}, b"abc")})
        self.client.get("/stream", params={"url": f"{cdn.base}/v.mp4", "referer": "https://evil.com/steal"})
        self.assertNotIn("evil.com", cdn.seen[0]["referer"])
        self.assertTrue(cdn.seen[0]["referer"].startswith("https://www."))

    def test_upstream_403_is_reported_as_blocked(self):
        cdn = self.cdn({"/v.mp4": (403, {}, b"forbidden")})
        response = self.client.get("/stream", params={"url": f"{cdn.base}/v.mp4"})
        self.assertEqual(response.status_code, 502)
        self.assertEqual(response.json()["detail"]["code"], "STREAM_EXPIRED_OR_BLOCKED")

    def test_follows_redirects_that_stay_on_allowed_hosts(self):
        cdn = self.cdn({
            "/a": (302, {"Location": "/b.mp4"}, b""),
            "/b.mp4": (200, {"Content-Type": "video/mp4"}, VIDEO),
        })
        response = self.client.get("/stream", params={"url": f"{cdn.base}/a"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.content, VIDEO)

    def test_refuses_redirects_to_other_hosts(self):
        cdn = self.cdn({"/a": (302, {"Location": "http://evil.example/x.mp4"}, b"")})
        response = self.client.get("/stream", params={"url": f"{cdn.base}/a"})
        self.assertEqual(response.status_code, 502)
        self.assertEqual(response.json()["detail"]["code"], "STREAM_EXPIRED_OR_BLOCKED")

    def test_non_video_responses_are_rejected(self):
        cdn = self.cdn({"/page": (200, {"Content-Type": "text/html"}, b"<html>login</html>")})
        response = self.client.get("/stream", params={"url": f"{cdn.base}/page"})
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json()["detail"]["code"], "UNSUPPORTED_POST")

    def test_shared_secret_is_enforced(self):
        cdn = self.cdn({"/v.mp4": (200, {"Content-Type": "video/mp4"}, b"abc")})
        with mock.patch.dict(os.environ, {"SCRAPER_SHARED_SECRET": "k"}):
            denied = self.client.get("/stream", params={"url": f"{cdn.base}/v.mp4"})
            allowed = self.client.get(
                "/stream", params={"url": f"{cdn.base}/v.mp4"}, headers={"X-Scraper-Key": "k"}
            )
        self.assertEqual(denied.status_code, 401)
        self.assertEqual(allowed.status_code, 200)


class RealAllowListTests(unittest.TestCase):
    """/stream must never become an open proxy (these use the real allow-list)."""

    @classmethod
    def setUpClass(cls):
        try:
            import main
            from fastapi.testclient import TestClient
        except ImportError as exc:  # pragma: no cover
            raise unittest.SkipTest(f"dependencies missing: {exc}")
        cls.client = TestClient(main.app)

    def test_endpoint_rejects_non_cdn_urls(self):
        bad = [
            "https://evil.com/video.mp4",
            "http://rr1---sn-x.googlevideo.com/videoplayback",  # http, not https
            "https://googlevideo.com.evil.com/videoplayback",  # look-alike host
            "https://rr1.googlevideo.com:8443/videoplayback",  # explicit port
            "https://127.0.0.1/video.mp4",
            "https://169.254.169.254/latest/meta-data/",
            "file:///etc/passwd",
        ]
        for url in bad:
            with self.subTest(url=url):
                response = self.client.get("/stream", params={"url": url})
                self.assertEqual(response.status_code, 400)
                self.assertEqual(response.json()["detail"]["code"], "INVALID_URL")

    def test_accepts_platform_cdn_hosts(self):
        good = [
            "https://rr8---sn-ci5gup-ccpd.googlevideo.com/videoplayback?x=1",
            "https://scontent-lhr8-1.cdninstagram.com/v/t50/x.mp4",
            "https://video.fbcdn.net/x.mp4",
            "https://v.redd.it/abc/DASH_720.mp4",
            "https://video.twimg.com/ext_tw_video/1/pu/vid/1280x720/x.mp4",
            "https://v16-webapp-prime.tiktok.com/video/tos/x",
            "https://cf-st.sc-cdn.net/d/x.mp4",
            "https://v1.pinimg.com/videos/x.mp4",
        ]
        for url in good:
            with self.subTest(url=url):
                self.assertTrue(urls.is_allowed_media_url(url))

    def test_referer_matches_the_cdn(self):
        cases = {
            "https://rr1.googlevideo.com/x": "https://www.youtube.com/",
            "https://v16.tiktokcdn.com/x": "https://www.tiktok.com/",
            "https://video.twimg.com/x": "https://x.com/",
            "https://v.redd.it/x": "https://www.reddit.com/",
            "https://scontent.cdninstagram.com/x": "https://www.instagram.com/",
        }
        for media, expected in cases.items():
            with self.subTest(media=media):
                self.assertEqual(urls.referer_for(media), expected)


class ListParityTests(unittest.TestCase):
    def test_python_and_typescript_media_hosts_match(self):
        ts = (ROOT.parent / "reels-extractor" / "lib" / "instagram.ts").read_text(encoding="utf8")
        block = re.search(r"const MEDIA_HOST_SUFFIXES = \[(.*?)\];", ts, re.S)
        self.assertIsNotNone(block, "MEDIA_HOST_SUFFIXES not found in lib/instagram.ts")
        ts_hosts = set(re.findall(r'"([a-z0-9.-]+)"', re.sub(r"//.*", "", block.group(1))))
        self.assertEqual(ts_hosts, set(urls.MEDIA_HOST_SUFFIXES))


if __name__ == "__main__":
    unittest.main(verbosity=2)
