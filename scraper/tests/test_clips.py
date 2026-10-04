"""
Clips: a part of a video as MP4 or M4A (cut without re-encoding) or as a small GIF.

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
from test_audio_extract import make_mp4, streams_in  # noqa: E402


def duration_of(data: bytes) -> float:
    """Length found by decoding the whole file: a fragmented MP4's header carries no duration to read."""
    import re
    import subprocess

    import main

    run = subprocess.run([main._ffmpeg(), "-hide_banner", "-i", "pipe:0", "-f", "null", "-"], input=data, capture_output=True)
    times = re.findall(rb"time=(\d+):(\d+):([\d.]+)", run.stderr)
    if not times:
        return -1.0
    h, m, sec = times[-1]
    return int(h) * 3600 + int(m) * 60 + float(sec)


class ClipTests(EndpointBase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        if not cls.main._ffmpeg():
            raise unittest.SkipTest("ffmpeg (imageio-ffmpeg) is not installed")
        cls.video = make_mp4(with_sound=True, seconds=6)

    def opened(self):
        closed = []
        return self.main.OpenStream(io.BytesIO(self.video), len(self.video), [lambda: closed.append(True)]), closed

    def test_a_video_clip_is_an_mp4_of_about_the_asked_length(self):
        source, closed = self.opened()
        clip = self.main._clip_from_stream(source, "video", 1.0, 4.0)
        data = b"".join(clip.chunks())
        self.assertEqual(clip.ext, "mp4")
        self.assertIn("Video:", streams_in(data))
        self.assertAlmostEqual(duration_of(data), 3.0, delta=1.1)  # keyframe cut: may start up to a keyframe early
        self.assertEqual(closed, [True])

    def test_an_audio_clip_is_m4a_without_the_picture(self):
        source, _ = self.opened()
        clip = self.main._clip_from_stream(source, "audio", 2.0, 5.0)
        data = b"".join(clip.chunks())
        described = streams_in(data)
        self.assertIn("Audio: aac", described)
        self.assertNotIn("Video:", described)
        self.assertAlmostEqual(duration_of(data), 3.0, delta=0.15)  # audio cuts are exact

    def test_a_gif_is_small_and_never_longer_than_the_cap(self):
        source, _ = self.opened()
        with mock.patch.object(self.main, "GIF_MAX_SECONDS", 2.0):
            clip = self.main._clip_from_stream(source, "gif", 0, 6.0)
            data = b"".join(clip.chunks())
        self.assertTrue(data.startswith(b"GIF89a"))
        self.assertLessEqual(duration_of(data), 2.3)

    def test_a_clip_ending_before_the_video_does_not_count_as_a_broken_source(self):
        # ffmpeg stops reading once it has the clip; the rest of the video must not look like a failure.
        source, _ = self.opened()
        clip = self.main._clip_from_stream(source, "video", 0, 1.0)
        b"".join(clip.chunks())  # would raise StreamTooLarge("...broke off...") if it were treated as one

    def test_nonsense_windows_are_refused(self):
        with self.assertRaises(self.main.ScraperError):
            self.main._clip_window("video", 5.0, 4.0)
        self.assertEqual(self.main._clip_window("gif", 3.0, None), (3.0, self.main.GIF_MAX_SECONDS))
        self.assertEqual(self.main._clip_window("video", None, None), (0.0, None))

    def test_stream_endpoint_makes_a_gif_from_the_video(self):
        asked = []

        def fake_open(url, referer, id_, kind, range_header):
            asked.append((kind, range_header))
            return self.main.OpenStream(io.BytesIO(self.video), len(self.video), [])

        with mock.patch.object(self.main, "_open_stream_preferring_cobalt", side_effect=fake_open):
            response = self.client.get("/stream", params={"url": "https://x.cdninstagram.com/v.mp4", "id": "abc-gif",
                                                          "kind": "gif", "start": "1", "end": "3"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(asked, [("video", None)])
        self.assertEqual(response.headers["content-type"], "image/gif")
        self.assertIn('filename="savereelsfast-abc-gif.gif"', response.headers["content-disposition"])
        self.assertTrue(response.content.startswith(b"GIF89a"))

    def test_only_one_gif_at_a_time(self):
        with mock.patch.object(self.main, "GIF_SLOTS", self.main.SlotPool(0, max_age=120)):
            response = self.client.get("/stream", params={"url": "https://x.cdninstagram.com/v.mp4", "kind": "gif"})
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["detail"]["code"], "SERVER_BUSY")

    def test_a_backwards_window_is_refused_before_any_download(self):
        with mock.patch.object(self.main, "_open_stream_preferring_cobalt") as opener:
            response = self.client.get("/stream", params={"url": "https://x.cdninstagram.com/v.mp4", "start": "9", "end": "3"})
        self.assertGreaterEqual(response.status_code, 400)
        opener.assert_not_called()


if __name__ == "__main__":
    unittest.main()
