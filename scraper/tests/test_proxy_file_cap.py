"""
The per-file limit on YouTube downloads that go through the paid proxy: refused up front from the reported size,
refused again from Content-Length, cut off mid-stream when the size was never reported, and never applied to
platforms (or links) that do not cost proxy traffic.

Run from the scraper/ folder:  python -m unittest discover -s tests -v
"""

import os
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import errors  # noqa: E402
from errors import ScraperError  # noqa: E402

MB = 1024 * 1024
YT = "https://www.youtube.com/watch?v=jNQXAC9IVRw"
TIKTOK = "https://www.tiktok.com/@scout2015/video/6718335390845095173"
PROXY = "http://user:secret@proxy.example.net:80"


def info_of(size, url="https://rr1.googlevideo.com/videoplayback?id=abc"):
    fmt = {"format_id": "18", "url": url, "ext": "mp4", "vcodec": "avc1", "acodec": "mp4a", "height": 360, "protocol": "https"}
    if size is not None:
        fmt["filesize"] = size
    return {"id": "abc", "title": "t", "formats": [fmt]}


class Response:
    def __init__(self, length=None):
        self.headers = {"Content-Length": str(length)} if length is not None else {}
        self.closed = False
        self.sent = 0

    def read(self, n):
        self.sent += n
        return b"x" * n

    def close(self):
        self.closed = True


class YDL:
    response = Response()
    made = 0

    def __init__(self, params, *a, **k):
        pass

    def urlopen(self, request):
        YDL.made += 1
        return YDL.response

    def close(self):
        pass


class Base(unittest.TestCase):
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
        YDL.made = 0
        for patch in (
            mock.patch.object(m, "YTDLP_PROXY", PROXY),
            mock.patch.object(m, "PROXY_MAX_FILE_MB", 60),
            mock.patch.object(m, "PROXY_DAILY_LIMIT_MB", 0),
            mock.patch.object(m, "COBALT", m.Cobalt([])),
            mock.patch.dict(os.environ, {"SCRAPER_SHARED_SECRET": "", "SCRAPER_REQUIRE_SECRET": ""}),
            mock.patch.object(m.yt_dlp, "YoutubeDL", YDL),
        ):
            patch.start()
            self.addCleanup(patch.stop)


class LimitSettingTests(Base):
    def test_default_is_60_mb_and_zero_switches_it_off(self):
        self.assertEqual(self.main._env_number("NO_SUCH_SETTING_XYZ", 60), 60)
        self.assertEqual(self.main._proxy_file_limit_bytes(), 60 * MB)
        with mock.patch.object(self.main, "PROXY_MAX_FILE_MB", 0):
            self.assertEqual(self.main._proxy_file_limit_bytes(), 0)
            self.main._refuse_if_too_large_for_proxy(10_000 * MB)  # no limit: nothing raised


class RefusalTests(Base):
    def open(self, info, resolved=YT, response=None):
        YDL.response = response or Response(None)
        return self.main._open_stream_from_info(resolved, info, "video", 0)

    def test_a_file_over_the_limit_is_refused_from_its_reported_size_without_touching_the_proxy(self):
        with self.assertRaises(ScraperError) as caught:
            self.open(info_of(61 * MB))
        self.assertEqual(caught.exception.code, errors.FILE_TOO_LARGE)
        self.assertEqual(caught.exception.status, 413)
        self.assertEqual(YDL.made, 0, "no connection (so no proxy traffic) was opened")

    def test_a_file_at_or_under_the_limit_is_allowed(self):
        for size in (60 * MB, 28 * MB, None):
            stream = self.open(info_of(size))
            self.assertTrue(stream.via_proxy)

    def test_an_unreported_size_is_refused_from_content_length_and_the_connection_is_closed(self):
        response = Response(75 * MB)
        with self.assertRaises(ScraperError) as caught:
            self.open(info_of(None), response=response)
        self.assertEqual(caught.exception.code, errors.FILE_TOO_LARGE)
        self.assertTrue(response.closed)

    def test_a_download_with_no_size_at_all_is_cut_off_at_the_limit(self):
        stream = self.open(info_of(None), response=Response(None))
        with mock.patch.object(self.main, "CHUNK_SIZE", 8 * MB):
            with self.assertRaises(self.main.StreamTooLarge):
                for _ in stream.chunks():
                    pass
        self.assertLessEqual(YDL.response.sent, 68 * MB)

    def test_other_platforms_and_direct_downloads_are_never_limited(self):
        tiktok = info_of(500 * MB, url="https://v16-webapp.tiktokcdn.com/video/tos/abc.mp4")
        self.assertFalse(self.open(tiktok, resolved=TIKTOK).via_proxy)
        with mock.patch.object(self.main, "YTDLP_PROXY", None):  # no proxy configured: YouTube is direct, so free
            self.assertFalse(self.open(info_of(500 * MB)).via_proxy)


class FakeHttpxResponse:
    is_redirect = False

    def __init__(self, status, headers):
        self.status_code = status
        self.headers = {k.lower(): v for k, v in headers.items()}
        self.closed = False

    def iter_raw(self, *a, **k):
        return iter(())

    def close(self):
        self.closed = True


class FakeHttpxClient:
    response: FakeHttpxResponse

    def __init__(self, *a, **k):
        pass

    def build_request(self, method, url, headers=None):
        return (method, url)

    def send(self, request, stream=False):
        return FakeHttpxClient.response

    def close(self):
        pass


class RelayTests(Base):
    """/stream: the path the website uses first for YouTube's IP-bound links."""

    URL = "https://rr1---sn-x.googlevideo.com/videoplayback?id=abc"

    def relay(self, status, headers, range_header=None):
        FakeHttpxClient.response = FakeHttpxResponse(status, {"Content-Type": "video/mp4", **headers})
        with mock.patch.object(self.main.httpx, "Client", FakeHttpxClient):
            return self.main._open_cdn_stream(self.URL, None, "video", range_header), FakeHttpxClient.response

    def test_a_relay_over_the_limit_is_refused_and_closed(self):
        with self.assertRaises(ScraperError) as caught:
            self.relay(200, {"Content-Length": str(90 * MB)})
        self.assertEqual(caught.exception.code, errors.FILE_TOO_LARGE)
        self.assertTrue(FakeHttpxClient.response.closed)

    def test_a_relay_under_the_limit_is_served(self):
        stream, _ = self.relay(200, {"Content-Length": str(20 * MB)})
        self.assertTrue(stream.via_proxy)

    def test_a_resumed_download_is_judged_by_the_whole_file_not_the_part(self):
        with self.assertRaises(ScraperError) as caught:
            self.relay(206, {"Content-Length": str(1 * MB), "Content-Range": f"bytes 0-{MB - 1}/{200 * MB}"}, "bytes=0-")
        self.assertEqual(caught.exception.code, errors.FILE_TOO_LARGE)
        stream, _ = self.relay(206, {"Content-Length": str(1 * MB), "Content-Range": f"bytes 0-{MB - 1}/{20 * MB}"}, "bytes=0-")
        self.assertEqual(stream.status, 206)

    def test_without_a_proxy_the_relay_is_not_limited(self):
        with mock.patch.object(self.main, "YTDLP_PROXY", None):
            stream, _ = self.relay(200, {"Content-Length": str(90 * MB)})
        self.assertFalse(stream.via_proxy)


class ExtractRouteTests(Base):
    def get(self, info):
        from fastapi.testclient import TestClient

        with mock.patch.object(self.main, "_extract_info", return_value=info):
            return TestClient(self.main.app, raise_server_exceptions=False).get("/extract", params={"url": YT})

    def test_a_too_large_video_is_refused_before_a_download_is_offered(self):
        response = self.get(info_of(120 * MB))
        self.assertEqual(response.status_code, 413)
        self.assertEqual(response.json()["detail"]["code"], "FILE_TOO_LARGE")

    def test_a_normal_video_is_offered_as_before(self):
        response = self.get(info_of(28 * MB))
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["success"])

    def test_a_video_whose_size_is_unknown_is_still_offered(self):
        self.assertEqual(self.get(info_of(None)).status_code, 200)

    def test_the_limit_is_ignored_when_no_proxy_is_in_use(self):
        with mock.patch.object(self.main, "YTDLP_PROXY", None):
            self.assertEqual(self.get(info_of(500 * MB)).status_code, 200)

    def test_stats_report_the_limit_and_how_many_were_refused(self):
        from fastapi.testclient import TestClient

        before = self.main._proxy_usage.get("refused", 0)
        self.get(info_of(120 * MB))
        body = TestClient(self.main.app).get("/stats").json()["proxy"]
        self.assertEqual(body["maxFileMb"], 60)
        self.assertEqual(body["refusedTooLarge"], before + 1)
        self.assertNotIn("secret", str(body))


if __name__ == "__main__":
    unittest.main()
