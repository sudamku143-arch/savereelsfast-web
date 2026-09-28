"""
Instagram photos: single-photo posts and photo slides of a carousel, offered only to callers that ask (images=1).

Run from the scraper/ folder:  python -m unittest discover -s tests -v
"""

import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from cache import best_image, slim_info  # noqa: E402
from test_errors import EndpointBase  # noqa: E402
from test_stream import RecordingCdn, allow_local_only  # noqa: E402

CDN = "https://instagram.fxyz1-1.fna.fbcdn.net/v/t51.82787-15/123_n.jpg"


def sizes(original: str = CDN) -> list[dict]:
    """How yt-dlp reports an Instagram photo: its sizes as thumbnails, capped ones first, the original last."""
    capped = [f"{original}?stp=dst-jpg_e35_s{n}x{n}_tt6&_nc_ht=x" for n in (150, 320, 640, 1080)]
    return [{"url": url} for url in capped] + [{"url": f"{original}?stp=dst-jpg_e35_tt6&_nc_ht=x"}]


def video(fid: str) -> dict:
    return {"format_id": fid, "url": f"https://x.cdninstagram.com/{fid}.mp4", "ext": "mp4", "height": 720,
            "width": 405, "vcodec": "avc1", "acodec": "mp4a", "protocol": "https"}


class BestImageTests(unittest.TestCase):
    def test_prefers_the_variant_without_a_size_cap(self):
        self.assertIn("stp=dst-jpg_e35_tt6", best_image(sizes())["url"])

    def test_falls_back_to_the_widest_then_the_last(self):
        widths = [{"url": "https://a/s150x150", "width": 150}, {"url": "https://a/big", "width": 1080}]
        self.assertEqual(best_image([{**t, "url": t["url"] + "?stp=x_s1x1"} for t in widths])["width"], 1080)
        self.assertEqual(best_image([{"url": "u?stp=_s1x1"}, {"url": "v?stp=_p2x2"}])["url"], "v?stp=_p2x2")

    def test_nothing_usable(self):
        self.assertIsNone(best_image(None))
        self.assertIsNone(best_image([{"width": 5}, "junk"]))


class SlimInfoTests(unittest.TestCase):
    def test_a_photo_keeps_only_its_full_size_picture(self):
        slim = slim_info({"id": "p", "thumbnails": sizes()})
        self.assertEqual(len(slim["thumbnails"]), 1)
        self.assertIn("stp=dst-jpg_e35_tt6", slim["thumbnails"][0]["url"])

    def test_a_video_keeps_none(self):
        self.assertNotIn("thumbnails", slim_info({"id": "v", "formats": [video("v")], "thumbnails": sizes()}))

    def test_carousel_slides_are_slimmed_one_by_one(self):
        slim = slim_info({"_type": "playlist", "entries": [{"id": "a", "thumbnails": sizes()}, {"id": "b", "formats": [video("b")]}]})
        self.assertEqual(len(slim["entries"][0]["thumbnails"]), 1)
        self.assertNotIn("thumbnails", slim["entries"][1])


class ExtractPhotoTests(EndpointBase):
    URL = "https://www.instagram.com/p/DdZMsPElzSl/"

    def setUp(self):
        super().setUp()
        patcher = mock.patch.object(self.main, "is_allowed_media_url", lambda url: "fbcdn.net/" in url or "cdninstagram.com/" in url)
        patcher.start()
        self.addCleanup(patcher.stop)

    def extract(self, info, images=True, url=None):
        params = {"url": url or self.URL}
        if images:
            params["images"] = "1"
        with mock.patch.object(self.main, "_extract_info", return_value=info):
            return self.client.get("/extract", params=params)

    def test_single_photo_post_becomes_one_image_item(self):
        data = self.extract({"id": "DdtpcapjOph", "title": "Post by nasa", "uploader": "NASA", "thumbnails": sizes()}).json()
        self.assertEqual(data["kind"], "image")
        self.assertIn("stp=dst-jpg_e35_tt6", data["imageUrl"])
        self.assertEqual(data["imageExt"], "jpg")
        self.assertIsNone(data["videoUrl"])
        self.assertEqual(data["thumbnail"], data["imageUrl"])
        self.assertEqual(data["items"], [])

    def test_photo_carousel_lists_every_slide(self):
        entries = [{"id": f"s{i}", "thumbnails": sizes(CDN.replace("123", str(i)))} for i in range(1, 5)]
        data = self.extract({"_type": "playlist", "id": "DdHyaYAifb6", "uploader": "NASA", "entries": entries}).json()
        self.assertEqual([i["kind"] for i in data["items"]], ["image"] * 4)
        self.assertEqual([i["index"] for i in data["items"]], [1, 2, 3, 4])
        self.assertEqual(data["id"], "DdHyaYAifb6")

    def test_mixed_carousel_keeps_the_slide_order(self):
        entries = [{"id": "photo", "thumbnails": sizes()}, {"id": "clip", "formats": [video("v1")], "thumbnails": sizes()}]
        data = self.extract({"_type": "playlist", "id": "mix", "entries": entries}).json()
        self.assertEqual([i["kind"] for i in data["items"]], ["image", "video"])
        self.assertTrue(data["items"][1]["videoUrl"].endswith("v1.mp4"))

    def test_without_images_1_a_photo_post_is_still_unsupported(self):
        response = self.extract({"id": "p", "thumbnails": sizes()}, images=False)
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json()["detail"]["code"], "UNSUPPORTED_POST")

    def test_without_images_1_a_mixed_carousel_offers_only_its_video(self):
        entries = [{"id": "photo", "thumbnails": sizes()}, {"id": "clip", "formats": [video("v1")]}]
        data = self.extract({"_type": "playlist", "id": "mix", "entries": entries}, images=False).json()
        self.assertEqual(data["kind"], "video")
        self.assertEqual(data["items"], [])

    def test_photos_are_instagram_only(self):
        response = self.extract({"id": "pin", "thumbnails": sizes()}, url="https://www.pinterest.com/pin/123/")
        self.assertEqual(response.status_code, 422)

    def test_a_picture_off_the_platform_cdn_is_not_offered(self):
        response = self.extract({"id": "p", "thumbnails": [{"url": "https://evil.example/x.jpg"}]})
        self.assertEqual(response.status_code, 422)

    def test_videos_are_labelled_too(self):
        self.assertEqual(self.extract({"id": "v", "formats": [video("v")]}).json()["kind"], "video")


class ImageStreamTests(EndpointBase):
    JPEG = b"\xff\xd8\xff\xe0" + b"j" * 30_000

    def setUp(self):
        super().setUp()
        patcher = mock.patch.object(self.main, "is_allowed_media_url", allow_local_only)
        patcher.start()
        self.addCleanup(patcher.stop)

    def cdn(self, routes):
        server = RecordingCdn(routes)
        self.addCleanup(server.close)
        return server

    def test_stream_serves_a_photo_as_a_jpg_attachment(self):
        cdn = self.cdn({"/p.jpg": (200, {"Content-Type": "image/jpeg"}, self.JPEG)})
        response = self.client.get("/stream", params={"url": f"{cdn.base}/p.jpg", "kind": "image", "ext": "jpg", "id": "abc"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.content, self.JPEG)
        self.assertEqual(response.headers["content-type"], "image/jpeg")
        self.assertEqual(response.headers["content-disposition"], 'attachment; filename="savereelsfast-abc.jpg"')
        self.assertTrue(cdn.seen[0]["accept"].startswith("image/"))

    def test_webp_keeps_its_type(self):
        cdn = self.cdn({"/p.webp": (200, {"Content-Type": "image/webp"}, b"RIFF" + b"w" * 9_000)})
        response = self.client.get("/stream", params={"url": f"{cdn.base}/p.webp", "kind": "image", "ext": "webp"})
        self.assertEqual(response.headers["content-type"], "image/webp")
        self.assertIn(".webp", response.headers["content-disposition"])

    def test_an_unknown_extension_is_saved_as_jpg(self):
        cdn = self.cdn({"/p": (200, {"Content-Type": "image/jpeg"}, self.JPEG)})
        response = self.client.get("/stream", params={"url": f"{cdn.base}/p", "kind": "image", "ext": "heic"})
        self.assertIn(".jpg", response.headers["content-disposition"])

    def test_image_kind_rejects_a_video_and_video_kind_rejects_a_picture(self):
        cdn = self.cdn({"/v": (200, {"Content-Type": "video/mp4"}, b"v" * 9_000), "/p": (200, {"Content-Type": "image/jpeg"}, self.JPEG)})
        self.assertEqual(self.client.get("/stream", params={"url": f"{cdn.base}/v", "kind": "image"}).status_code, 422)
        self.assertEqual(self.client.get("/stream", params={"url": f"{cdn.base}/p"}).status_code, 422)

    def test_download_endpoint_serves_a_photo_slide(self):
        cdn = self.cdn({"/s2.jpg": (200, {"Content-Type": "image/jpeg"}, self.JPEG)})
        info = {"_type": "playlist", "id": "post", "entries": [
            {"id": "s1", "formats": [video("v1")]},
            {"id": "s2", "thumbnails": [{"url": f"{cdn.base}/s2.jpg"}]},
        ]}
        with mock.patch.object(self.main, "_extract_info", return_value=info):
            response = self.client.get("/download", params={
                "url": "https://www.instagram.com/p/post/", "kind": "image", "item": 1, "id": "post-2",
            })
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["content-type"], "image/jpeg")
        self.assertIn("savereelsfast-post-2.jpg", response.headers["content-disposition"])

    def test_download_endpoint_has_no_photos_off_instagram(self):
        info = {"id": "pin", "thumbnails": [{"url": "http://127.0.0.1:1/p.jpg"}]}
        with mock.patch.object(self.main, "_extract_info", return_value=info):
            response = self.client.get("/download", params={"url": "https://www.pinterest.com/pin/1/", "kind": "image"})
        self.assertEqual(response.status_code, 422)


if __name__ == "__main__":
    unittest.main()
