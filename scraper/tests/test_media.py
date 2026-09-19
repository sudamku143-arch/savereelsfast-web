"""
Audio-only streams and multi-video (carousel) posts.

Run from the scraper/ folder:  python -m unittest discover -s tests -v
"""

import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from test_errors import EndpointBase  # noqa: E402  (shared client + fmt helper)
from test_stream import RecordingCdn, allow_local_only  # noqa: E402


def video(fid, height, acodec="mp4a", ext="mp4"):
    return {"format_id": fid, "url": f"https://x.cdninstagram.com/{fid}.mp4", "ext": ext, "height": height,
            "width": height * 9 // 16, "vcodec": "avc1", "acodec": acodec, "protocol": "https"}


def audio(fid, ext="m4a", abr=128.0, protocol="https", vcodec="none", acodec="mp4a.40.2"):
    return {"format_id": fid, "url": f"https://v.redd.it/{fid}.{ext}", "ext": ext, "vcodec": vcodec,
            "acodec": acodec, "abr": abr, "protocol": protocol}


class PickAudioTests(EndpointBase):
    def test_prefers_m4a_over_webm_even_at_lower_bitrate(self):
        info = {"formats": [audio("opus", "webm", 160), audio("aac", "m4a", 128)]}
        self.assertEqual(self.main._pick_audio(info)["format_id"], "aac")

    def test_picks_highest_bitrate_within_a_container(self):
        info = {"formats": [audio("low", "m4a", 48), audio("high", "m4a", 192)]}
        self.assertEqual(self.main._pick_audio(info)["format_id"], "high")

    def test_ignores_things_that_are_not_direct_audio_files(self):
        info = {"formats": [
            video("muxed", 720),                                  # has video
            audio("hls", protocol="m3u8_native"),                 # manifest, not a file
            audio("silent", acodec="none"),                       # no audio codec
            audio("weird", ext="mhtml"),                          # storyboard-style junk
        ]}
        self.assertIsNone(self.main._pick_audio(info))

    def test_no_formats_means_no_audio(self):
        self.assertIsNone(self.main._pick_audio({}))
        self.assertIsNone(self.main._pick_audio({"formats": []}))


class ExtractMediaTests(EndpointBase):
    URL = "https://www.reddit.com/r/videos/comments/6rrwyj/x/"

    def extract(self, info):
        with mock.patch.object(self.main, "_extract_info", return_value=info):
            return self.client.get("/extract", params={"url": self.URL})

    def test_video_only_post_with_separate_audio_offers_both(self):
        info = {"id": "6rrwyj", "title": "t", "uploader": "u", "thumbnail": "https://preview.redd.it/t.jpg",
                "duration": 12, "formats": [video("dash720", 720, acodec="none"), audio("aud")]}
        data = self.extract(info).json()
        self.assertEqual(data["quality"], "720p")
        self.assertEqual(data["warning"], "NO_AUDIO")  # the MP4 itself is silent...
        self.assertTrue(data["audioUrl"].endswith("aud.m4a"))  # ...but the audio track is available
        self.assertEqual(data["audioExt"], "m4a")
        self.assertEqual(data["audioBitrate"], 128)
        self.assertEqual(data["items"], [])

    def test_muxed_video_without_separate_audio_has_no_audio_url(self):
        data = self.extract({"id": "a", "formats": [video("p360", 360)]}).json()
        self.assertIsNone(data["audioUrl"])
        self.assertIsNone(data["audioExt"])

    def test_carousel_returns_every_video_as_an_item(self):
        entries = [
            {"id": f"slide{i}", "title": f"Slide {i}", "thumbnail": f"https://x.cdninstagram.com/t{i}.jpg",
             "duration": 5 + i, "formats": [video(f"v{i}", 640, acodec="none")]}
            for i in range(1, 4)
        ]
        info = {"_type": "playlist", "id": "BQ0eAlwhDrw", "title": "Post title", "uploader": "jane", "entries": entries}
        data = self.extract(info).json()
        self.assertEqual(data["id"], "BQ0eAlwhDrw")            # the post's id, not the first slide's
        self.assertEqual(data["author"], "jane")                # slides don't carry the uploader
        self.assertEqual([i["index"] for i in data["items"]], [1, 2, 3])
        self.assertEqual([i["id"] for i in data["items"]], ["slide1", "slide2", "slide3"])
        self.assertTrue(data["videoUrl"].endswith("v1.mp4"))    # top level mirrors the first item
        self.assertEqual(data["items"][2]["duration"], 8)

    def test_photo_slides_are_skipped_and_a_single_video_is_not_a_carousel(self):
        entries = [
            {"id": "photo", "formats": []},
            {"id": "clip", "formats": [video("v1", 720)]},
            None,
        ]
        data = self.extract({"_type": "playlist", "id": "post", "entries": entries}).json()
        self.assertEqual(data["items"], [])          # only one video: plain single-result shape
        self.assertTrue(data["videoUrl"].endswith("v1.mp4"))

    def test_post_with_only_photos_is_unsupported(self):
        response = self.extract({"_type": "playlist", "id": "p", "entries": [{"id": "a", "formats": []}]})
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json()["detail"]["code"], "UNSUPPORTED_POST")

    def test_carousels_are_capped(self):
        entries = [{"id": f"s{i}", "formats": [video(f"v{i}", 480)]} for i in range(self.main.MAX_ITEMS + 15)]
        data = self.extract({"_type": "playlist", "id": "big", "entries": entries}).json()
        self.assertEqual(len(data["items"]), self.main.MAX_ITEMS)


class AudioStreamTests(EndpointBase):
    AUDIO = b"\x00\x00\x00\x1cftypM4A " + b"a" * 60_000

    def setUp(self):
        patcher = mock.patch.object(self.main, "is_allowed_media_url", allow_local_only)
        patcher.start()
        self.addCleanup(patcher.stop)

    def cdn(self, routes):
        server = RecordingCdn(routes)
        self.addCleanup(server.close)
        return server

    def test_stream_serves_audio_as_an_m4a_attachment(self):
        cdn = self.cdn({"/a.m4a": (200, {"Content-Type": "audio/mp4"}, self.AUDIO)})
        response = self.client.get("/stream", params={"url": f"{cdn.base}/a.m4a", "kind": "audio", "id": "abc"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.content, self.AUDIO)
        self.assertEqual(response.headers["content-type"], "audio/mp4")
        self.assertEqual(response.headers["content-disposition"], 'attachment; filename="savereelsfast-abc.m4a"')

    def test_stream_names_webm_audio_correctly(self):
        cdn = self.cdn({"/a.webm": (200, {"Content-Type": "audio/webm"}, b"x" * 20_000)})
        response = self.client.get("/stream", params={"url": f"{cdn.base}/a.webm", "kind": "audio", "ext": "webm"})
        self.assertEqual(response.headers["content-type"], "audio/webm")
        self.assertIn(".webm", response.headers["content-disposition"])

    def test_audio_stream_accepts_audio_only_mp4_labelled_as_video(self):
        cdn = self.cdn({"/a": (200, {"Content-Type": "video/mp4"}, self.AUDIO)})  # some CDNs label m4a this way
        response = self.client.get("/stream", params={"url": f"{cdn.base}/a", "kind": "audio"})
        self.assertEqual(response.status_code, 200)

    def test_audio_stream_rejects_html(self):
        cdn = self.cdn({"/a": (200, {"Content-Type": "text/html"}, b"<html>")})
        response = self.client.get("/stream", params={"url": f"{cdn.base}/a", "kind": "audio"})
        self.assertEqual(response.status_code, 422)

    def test_video_kind_still_rejects_audio_content(self):
        cdn = self.cdn({"/a": (200, {"Content-Type": "audio/mp4"}, self.AUDIO)})
        response = self.client.get("/stream", params={"url": f"{cdn.base}/a"})
        self.assertEqual(response.status_code, 422)

    def test_unknown_kind_or_extension_is_rejected(self):
        for params in ({"kind": "image"}, {"kind": "audio", "ext": "../x"}):
            with self.subTest(params=params):
                response = self.client.get("/stream", params={"url": "https://v.redd.it/x", **params})
                self.assertEqual(response.status_code, 422)

    def test_download_endpoint_passes_kind_and_item_through(self):
        class Fake:
            closed = False

            def read(self, n=-1):
                return b""

            def close(self):
                self.closed = True

        fake = Fake()
        stream = self.main.OpenStream(fake, 0, [fake.close], "m4a")
        with mock.patch.object(self.main, "_open_stream", return_value=stream) as opened:
            response = self.client.get(
                "/download",
                params={"url": "https://www.youtube.com/watch?v=jNQXAC9IVRw", "kind": "audio", "item": 2, "id": "abc"},
            )
        opened.assert_called_once_with("https://www.youtube.com/watch?v=jNQXAC9IVRw", "audio", 2)
        self.assertEqual(response.headers["content-type"], "audio/mp4")
        self.assertIn("savereelsfast-abc.m4a", response.headers["content-disposition"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
