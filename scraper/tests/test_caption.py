"""
The full caption (hashtags included) for the website's copy buttons.

Run from the scraper/ folder:  python -m unittest discover -s tests -v
"""

import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from test_errors import EndpointBase  # noqa: E402


class CaptionTests(EndpointBase):
    def test_the_description_is_the_caption(self):
        self.assertEqual(self.main._caption({"title": "Video by nasa", "description": "Look up #space"}), "Look up #space")

    def test_yt_dlps_placeholder_title_is_not_a_caption(self):
        self.assertIsNone(self.main._caption({"title": "Video by nasa", "description": ""}))
        self.assertIsNone(self.main._caption({"title": "Post by some.user"}))

    def test_a_real_title_is_used_when_there_is_no_description(self):
        self.assertEqual(self.main._caption({"title": "Best of 2026 #recap"}), "Best of 2026 #recap")

    def test_capped_at_instagrams_limit(self):
        self.assertEqual(len(self.main._caption({"description": "x" * 5000})), self.main.CAPTION_MAX_CHARS)

    def test_extract_returns_it(self):
        info = {"id": "abc", "title": "Video by nasa", "description": "Hello #moon", "thumbnail": "https://x.cdninstagram.com/t.jpg",
                "formats": [{"format_id": "v", "url": "https://x.cdninstagram.com/v.mp4", "ext": "mp4", "height": 720,
                             "width": 405, "vcodec": "avc1", "acodec": "mp4a", "protocol": "https"}]}
        with mock.patch.object(self.main, "_extract_info", return_value=info):
            response = self.client.get("/extract", params={"url": "https://www.instagram.com/reel/Abc123/"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["caption"], "Hello #moon")


if __name__ == "__main__":
    unittest.main()
