"""
Audio out of a video that has no separate audio track (YouTube, and posts whose sound only lives inside the MP4):
the video is piped through ffmpeg, which copies the AAC track into an M4A without re-encoding.

Run from the scraper/ folder:  python -m unittest discover -s tests -v
"""

import io
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from test_errors import EndpointBase  # noqa: E402


def make_mp4(with_sound: bool, seconds: int = 2) -> bytes:
    """A short H.264 MP4 (a keyframe every second, like a real reel), with or without an AAC track, made by the same ffmpeg the scraper uses."""
    import main

    exe = main._ffmpeg()
    inputs = ["-f", "lavfi", "-i", f"color=c=black:s=64x64:d={seconds}"]
    if with_sound:
        inputs += ["-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}", "-c:a", "aac"]
    with tempfile.TemporaryDirectory() as folder:
        out = Path(folder) / "v.mp4"  # a real file: +faststart (moov first, like YouTube's files) needs to seek
        args = [exe, "-hide_banner", "-loglevel", "error", *inputs, "-c:v", "libx264", "-g", "25", "-pix_fmt", "yuv420p",
                "-shortest", "-movflags", "+faststart", str(out)]
        subprocess.run(args, capture_output=True, check=True)
        return out.read_bytes()


def streams_in(data: bytes) -> str:
    """ffmpeg's own description of a file (its stderr when asked to read it)."""
    import main

    probe = subprocess.run([main._ffmpeg(), "-hide_banner", "-i", "pipe:0"], input=data, capture_output=True)
    return probe.stderr.decode("utf-8", "replace")


class AudioFromVideoTests(EndpointBase):
    def setUp(self):
        super().setUp()
        if not self.main._ffmpeg():
            self.skipTest("ffmpeg (imageio-ffmpeg) is not installed")

    def opened(self, data: bytes):
        closed = []
        stream = self.main.OpenStream(io.BytesIO(data), len(data), [lambda: closed.append(True)])
        return stream, closed

    def test_the_sound_is_copied_out_as_m4a_without_the_picture(self):
        source, closed = self.opened(make_mp4(with_sound=True))
        audio = self.main._audio_from_video(source)
        data = b"".join(audio.chunks())
        self.assertEqual(audio.ext, "m4a")
        self.assertIsNone(audio.length, "the size isn't known until ffmpeg is done")
        self.assertIn(b"ftyp", data[:16])
        described = streams_in(data)
        self.assertIn("Audio: aac", described)
        self.assertNotIn("Video:", described)
        self.assertEqual(closed, [True], "the video stream is closed afterwards")

    def test_a_video_without_sound_is_reported_not_sent_empty(self):
        source, closed = self.opened(make_mp4(with_sound=False))
        with self.assertRaises(self.main.ScraperError) as caught:
            self.main._audio_from_video(source)
        self.assertEqual(caught.exception.code, "UNSUPPORTED_POST")
        self.assertEqual(closed, [True])

    def test_no_ffmpeg_means_a_clear_answer(self):
        source, closed = self.opened(b"whatever")
        with mock.patch.object(self.main, "_ffmpeg", return_value=None):
            with self.assertRaises(self.main.ScraperError):
                self.main._audio_from_video(source)
        self.assertEqual(closed, [True])

    def test_stream_extract_opens_the_video_and_sends_its_audio(self):
        video = make_mp4(with_sound=True)
        asked = []

        def fake_open(url, referer, id_, kind, range_header):
            asked.append((kind, range_header))
            return self.main.OpenStream(io.BytesIO(video), len(video), [])

        with mock.patch.object(self.main, "_open_stream_preferring_cobalt", side_effect=fake_open):
            response = self.client.get("/stream", params={
                "url": "https://rr1---sn-x.googlevideo.com/videoplayback?id=1", "id": "abc", "kind": "audio",
                "ext": "mp3", "extract": "1"}, headers={"range": "bytes=0-"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(asked, [("video", None)], "the whole video is read, never a byte range of it")
        self.assertEqual(response.headers["content-type"], "audio/mp4")
        self.assertIn('filename="savereelsfast-abc.m4a"', response.headers["content-disposition"])
        self.assertIn("Audio: aac", streams_in(response.content))

    def test_without_extract_audio_is_streamed_as_before(self):
        asked = []

        def fake_open(url, referer, id_, kind, range_header):
            asked.append(kind)
            return self.main.OpenStream(io.BytesIO(b"abc"), 3, [])

        with mock.patch.object(self.main, "_open_stream_preferring_cobalt", side_effect=fake_open):
            response = self.client.get("/stream", params={
                "url": "https://x.cdninstagram.com/a.m4a", "id": "abc", "kind": "audio"})
        self.assertEqual(asked, ["audio"])
        self.assertEqual(response.content, b"abc")

    def test_requirements_bundle_ffmpeg_for_render(self):
        self.assertIn("imageio-ffmpeg", (ROOT / "requirements.txt").read_text())


if __name__ == "__main__":
    unittest.main()
