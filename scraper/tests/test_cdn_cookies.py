"""
CDNs that only hand over a file with the cookies the lookup got (TikTok's tt_chain_token): the cache keeps
them and the download sends them.

Run from the scraper/ folder:  python -m unittest discover -s tests -v
"""

import io
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from test_errors import EndpointBase  # noqa: E402

TIKTOK_COOKIES = "tt_chain_token=abc123; Domain=.tiktok.com; Path=/; Secure; Expires=1893456000; HttpOnly; ttwid=xyz; Domain=.tiktok.com; Path=/"


class CookieTests(EndpointBase):
    def test_only_name_value_pairs_make_the_header(self):
        self.assertEqual(self.main._cookie_header(TIKTOK_COOKIES), "tt_chain_token=abc123; ttwid=xyz")
        self.assertIsNone(self.main._cookie_header(None))
        self.assertIsNone(self.main._cookie_header("Domain=.x.com; Path=/"))

    def test_the_cache_keeps_a_formats_cookies(self):
        from cache import slim_info

        slim = slim_info({"id": "t", "formats": [{"url": "https://v16-webapp-prime.tiktok.com/v", "cookies": TIKTOK_COOKIES, "junk": 1}]})
        self.assertEqual(slim["formats"][0]["cookies"], TIKTOK_COOKIES)
        self.assertNotIn("junk", slim["formats"][0])

    def test_the_download_sends_them_to_the_cdn(self):
        info = {"id": "t", "formats": [{"format_id": "h264", "url": "https://v16-webapp-prime.tiktok.com/video/x", "ext": "mp4",
                                        "height": 1024, "width": 576, "vcodec": "h264", "acodec": "aac", "protocol": "https",
                                        "http_headers": {"Referer": "https://www.tiktok.com/"}, "cookies": TIKTOK_COOKIES}]}
        sent = {}

        class FakeResponse(io.BytesIO):
            headers = {"Content-Length": "3"}

        def fake_urlopen(self_ydl, request):
            sent.update(request.headers)
            return FakeResponse(b"abc")

        with mock.patch.object(self.main.yt_dlp.YoutubeDL, "urlopen", fake_urlopen):
            stream = self.main._open_stream_from_info("https://www.tiktok.com/@u/video/1", info, "video", 0)
        self.assertEqual(b"".join(stream.chunks()), b"abc")
        self.assertEqual(sent.get("Cookie"), "tt_chain_token=abc123; ttwid=xyz")
        self.assertEqual(sent.get("Referer"), "https://www.tiktok.com/")


class SameSessionTests(EndpointBase):
    """TikTok: the file is opened by the very session that looked the post up (its cookie jar, its client)."""

    def test_tiktok_downloads_use_the_lookup_session(self):
        info = {"id": "t", "formats": [{"format_id": "h264", "url": "https://v16-webapp-prime.tiktok.com/video/x", "ext": "mp4",
                                        "height": 1024, "width": 576, "vcodec": "h264", "acodec": "aac", "protocol": "https",
                                        "http_headers": {"Referer": "https://www.tiktok.com/"}}]}
        instances = {"extract": [], "open": []}

        class FakeResponse(io.BytesIO):
            headers = {"Content-Length": "3"}

        def fake_extract(self_ydl, url, download=False):
            instances["extract"].append(id(self_ydl))
            return info

        def fake_urlopen(self_ydl, request):
            instances["open"].append(id(self_ydl))
            return FakeResponse(b"abc")

        with mock.patch.object(self.main.yt_dlp.YoutubeDL, "extract_info", fake_extract),              mock.patch.object(self.main.yt_dlp.YoutubeDL, "urlopen", fake_urlopen):
            response = self.client.get("/download", params={"url": "https://www.tiktok.com/@u/video/7206382937372134662", "id": "tt"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.content, b"abc")
        self.assertEqual(len(set(instances["extract"])), 1)
        self.assertEqual(set(instances["open"]), set(instances["extract"]), "the file must come from the lookup's own session")

    def test_other_platforms_keep_the_cached_route(self):
        with mock.patch.object(self.main, "_open_with_lookup_session") as same_session,              mock.patch.object(self.main, "_acquire_info", side_effect=self.main.ScraperError("UNSUPPORTED_POST")):
            self.client.get("/download", params={"url": "https://x.com/u/status/719944021058060289", "id": "x"})
        same_session.assert_not_called()


if __name__ == "__main__":
    unittest.main()
