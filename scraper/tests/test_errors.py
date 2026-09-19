"""
Failure codes, audio warnings and the fallback streaming endpoint.

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
from errors import ScraperError, classify_failure  # noqa: E402

# (yt-dlp / network message, expected machine code)
CLASSIFICATION = [
    # LOGIN_REQUIRED
    ("ERROR: [Instagram] X: Instagram sent an empty media response. Check if this post is accessible in your browser without being logged-in. If it is not, then use --cookies-from-browser", errors.LOGIN_REQUIRED),
    ("ERROR: [youtube] X: Sign in to confirm your age. This video may be inappropriate for some users.", errors.LOGIN_REQUIRED),
    ("ERROR: [twitter] X: NSFW tweet requires authentication", errors.LOGIN_REQUIRED),
    ("ERROR: [twitter] X: Protected tweets are only available to authorized users", errors.LOGIN_REQUIRED),
    ("ERROR: [facebook] X: This video is private", errors.LOGIN_REQUIRED),
    ("ERROR: [TikTok] X: This account is private", errors.LOGIN_REQUIRED),
    ("ERROR: [Reddit] X: This is an NSFW post, log in required", errors.LOGIN_REQUIRED),
    # UNSUPPORTED_POST
    ("ERROR: [Instagram] X: There is no video in this post", errors.UNSUPPORTED_POST),
    ("ERROR: [twitter] X: No video could be found in this tweet", errors.UNSUPPORTED_POST),
    ("ERROR: Unsupported URL: https://www.threads.net/@a/post/b", errors.UNSUPPORTED_POST),
    ("ERROR: [Pinterest] X: This pin does not contain any video", errors.UNSUPPORTED_POST),
    # STREAM_EXPIRED_OR_BLOCKED
    ("ERROR: [youtube] X: Sign in to confirm you’re not a bot. Use --cookies", errors.STREAM_EXPIRED_OR_BLOCKED),
    ("ERROR: unable to download video data: HTTP Error 403: Forbidden", errors.STREAM_EXPIRED_OR_BLOCKED),
    ("ERROR: HTTP Error 429: Too Many Requests", errors.STREAM_EXPIRED_OR_BLOCKED),
    ("ERROR: [TikTok] X: Your IP address is blocked from accessing this post", errors.STREAM_EXPIRED_OR_BLOCKED),
    # PLATFORM_TIMEOUT
    ("ERROR: Unable to download webpage: <urlopen error timed out>", errors.PLATFORM_TIMEOUT),
    ("ERROR: [Reddit] X: Connection reset by peer", errors.PLATFORM_TIMEOUT),
    ("ERROR: Unable to download JSON metadata: HTTP Error 503: Service Unavailable", errors.PLATFORM_TIMEOUT),
    # fallback
    ("ERROR: something entirely unexpected happened", errors.EXTRACTION_FAILED),
    ("", errors.EXTRACTION_FAILED),
]


class ClassificationTests(unittest.TestCase):
    def test_messages_map_to_codes(self):
        for message, expected in CLASSIFICATION:
            with self.subTest(message=message[:70]):
                self.assertEqual(classify_failure(message), expected)

    def test_every_code_has_status_and_message(self):
        for code in (errors.LOGIN_REQUIRED, errors.UNSUPPORTED_POST, errors.STREAM_EXPIRED_OR_BLOCKED,
                     errors.PLATFORM_TIMEOUT, errors.EXTRACTION_FAILED, errors.INVALID_URL):
            err = ScraperError(code)
            self.assertEqual(err.detail()["code"], code)
            self.assertTrue(err.message)
            self.assertGreaterEqual(err.status, 400)


class EndpointBase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            import main
            from fastapi.testclient import TestClient
        except ImportError as exc:  # pragma: no cover
            raise unittest.SkipTest(f"dependencies missing: {exc}")
        cls.main = main
        cls.client = TestClient(main.app)

    URL = "https://www.youtube.com/watch?v=jNQXAC9IVRw"

    def setUp(self):
        self.reset_caches()

    def reset_caches(self):
        # Extraction results are cached per URL; tests mock a different answer for the same URL.
        self.main.INFO_CACHE.clear()
        self.main.NEGATIVE_CACHE.clear()

    def fmt(self, fid, height, acodec, ext="mp4"):
        return {"format_id": fid, "url": f"https://x.googlevideo.com/{fid}", "ext": ext, "height": height,
                "width": height * 9 // 16, "vcodec": "avc1", "acodec": acodec, "protocol": "https"}


class EndpointTests(EndpointBase):
    def test_extract_error_bodies_carry_codes_and_statuses(self):
        from yt_dlp.utils import DownloadError

        expectations = [
            ("ERROR: [Instagram] X: empty media response ... --cookies", "LOGIN_REQUIRED", 403),
            ("ERROR: There is no video in this post", "UNSUPPORTED_POST", 422),
            ("ERROR: HTTP Error 403: Forbidden", "STREAM_EXPIRED_OR_BLOCKED", 502),
            ("ERROR: <urlopen error timed out>", "PLATFORM_TIMEOUT", 504),
        ]
        for message, code, status in expectations:
            with self.subTest(code=code):
                self.reset_caches()
                with mock.patch.object(self.main, "_extract_info", side_effect=DownloadError(message)):
                    response = self.client.get("/extract", params={"url": self.URL})
                self.assertEqual(response.status_code, status)
                self.assertEqual(response.json()["detail"]["code"], code)

    def test_timeout_exception_is_platform_timeout(self):
        with mock.patch.object(self.main, "_extract_info", side_effect=TimeoutError()):
            response = self.client.get("/extract", params={"url": self.URL})
        self.assertEqual(response.status_code, 504)
        self.assertEqual(response.json()["detail"]["code"], "PLATFORM_TIMEOUT")

    def test_post_without_video_is_unsupported(self):
        for info in ({"id": "abc", "formats": []}, None):
            with self.subTest(info=info):
                self.reset_caches()
                with mock.patch.object(self.main, "_extract_info", return_value=info):
                    response = self.client.get("/extract", params={"url": self.URL})
                self.assertEqual(response.status_code, 422)
                self.assertEqual(response.json()["detail"]["code"], "UNSUPPORTED_POST")

    def test_ytdlp_warnings_explain_an_empty_result(self):
        cases = [
            ("[youtube] X: This video is unavailable", 404, "EXTRACTION_FAILED"),
            ("[youtube] X: Sign in to confirm you’re not a bot", 502, "STREAM_EXPIRED_OR_BLOCKED"),
            ("[youtube] X: Sign in to confirm your age", 403, "LOGIN_REQUIRED"),
        ]
        for message, status, code in cases:
            with self.subTest(code=code):
                self.reset_caches()
                # yt-dlp appends generic boilerplate lines after the real reason.
                info = {"id": "abc", "formats": [], "_messages": [message, "No video formats found!", "Requested format is not available"]}
                with mock.patch.object(self.main, "_extract_info", return_value=info):
                    response = self.client.get("/extract", params={"url": self.URL})
                self.assertEqual(response.status_code, status)
                self.assertEqual(response.json()["detail"]["code"], code)

    def test_video_only_result_carries_no_audio_warning(self):
        info = {"id": "abc", "title": "t", "formats": [self.fmt("dash1080", 1080, "none")]}
        with mock.patch.object(self.main, "_extract_info", return_value=info):
            data = self.client.get("/extract", params={"url": self.URL}).json()
        self.assertTrue(data["success"])
        self.assertEqual(data["warning"], "NO_AUDIO")
        self.assertEqual(data["audio"], "no")
        self.assertFalse(data["hasAudio"])

    def test_premuxed_result_has_no_warning(self):
        info = {"id": "abc", "formats": [self.fmt("dash1080", 1080, "none"), self.fmt("p360", 360, "mp4a")]}
        with mock.patch.object(self.main, "_extract_info", return_value=info):
            data = self.client.get("/extract", params={"url": self.URL}).json()
        self.assertIsNone(data["warning"])
        self.assertTrue(data["videoUrl"].endswith("p360"))

    def test_unreported_audio_does_not_warn(self):
        info = {"id": "abc", "formats": [self.fmt("u720", 720, None)]}
        with mock.patch.object(self.main, "_extract_info", return_value=info):
            data = self.client.get("/extract", params={"url": self.URL}).json()
        self.assertIsNone(data["warning"])
        self.assertEqual(data["audio"], "unknown")

    def test_shared_secret_is_enforced_when_configured(self):
        info = {"id": "abc", "formats": [self.fmt("p360", 360, "mp4a")]}
        with mock.patch.dict(os.environ, {"SCRAPER_SHARED_SECRET": "s3cret"}):
            with mock.patch.object(self.main, "_extract_info", return_value=info):
                denied = self.client.get("/extract", params={"url": self.URL})
                allowed = self.client.get("/extract", params={"url": self.URL}, headers={"X-Scraper-Key": "s3cret"})
        self.assertEqual(denied.status_code, 401)
        self.assertEqual(allowed.status_code, 200)


class FakeResponse:
    def __init__(self, payload: bytes):
        self._payload = payload
        self._pos = 0
        self.closed = False
        self.headers = {"Content-Length": str(len(payload))}

    def read(self, amount=-1):
        chunk = self._payload[self._pos:self._pos + amount]
        self._pos += len(chunk)
        return chunk

    def close(self):
        self.closed = True


class DownloadEndpointTests(EndpointBase):
    """The scraper-side streaming fallback used when a direct CDN download fails."""

    def test_streams_the_video_as_an_attachment(self):
        payload = b"\x00\x00\x00\x18ftypmp42" + b"x" * 200_000
        fake = FakeResponse(payload)
        stream = self.main.OpenStream(fake, len(payload), [fake.close])
        with mock.patch.object(self.main, "_open_stream", return_value=stream):
            response = self.client.get("/download", params={"url": self.URL, "id": "jNQXAC9IVRw"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.content, payload)
        self.assertEqual(response.headers["content-type"], "video/mp4")
        self.assertEqual(
            response.headers["content-disposition"], 'attachment; filename="savereelsfast-jNQXAC9IVRw.mp4"'
        )
        self.assertTrue(fake.closed, "upstream connection must be closed after streaming")

    def test_filename_is_sanitised(self):
        fake = FakeResponse(b"abc")
        stream = self.main.OpenStream(fake, 3, [fake.close])
        with mock.patch.object(self.main, "_open_stream", return_value=stream):
            response = self.client.get("/download", params={"url": self.URL, "id": '../"evil'})
        self.assertEqual(
            response.headers["content-disposition"], 'attachment; filename="savereelsfast-evil.mp4"'
        )

    def test_download_errors_are_coded(self):
        with mock.patch.object(self.main, "_open_stream", side_effect=ScraperError(errors.STREAM_EXPIRED_OR_BLOCKED)):
            response = self.client.get("/download", params={"url": self.URL})
        self.assertEqual(response.status_code, 502)
        self.assertEqual(response.json()["detail"]["code"], "STREAM_EXPIRED_OR_BLOCKED")

    def test_rejects_non_supported_hosts_before_fetching(self):
        response = self.client.get("/download", params={"url": "https://evil.com/video.mp4"})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["detail"]["code"], "INVALID_URL")


if __name__ == "__main__":
    unittest.main(verbosity=2)
