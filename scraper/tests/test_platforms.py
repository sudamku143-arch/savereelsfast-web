"""
Self-check for the platform support in the scraper service and the web app.

Run from the scraper/ folder:

    python -m unittest discover -s tests -v

Everything here is offline and deterministic: URL parsing, short-link
expansion (against a local mock HTTP server), yt-dlp extractor coverage,
the Threads extractor, format selection, and parity with the TypeScript
parser in ../reels-extractor/lib/platforms.ts.

Optional live smoke test (real network, may fail for reasons outside our
control such as datacenter blocks or deleted posts):

    LIVE_TESTS=1 TEST_URL_YOUTUBE=https://youtu.be/jNQXAC9IVRw python -m unittest discover -s tests -v
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import urls  # noqa: E402
from urls import UnsupportedUrl, expand_redirects, needs_expansion, resolve_url  # noqa: E402

PLATFORMS = [
    "instagram", "youtube", "facebook", "threads", "x",
    "tiktok", "pinterest", "reddit", "snapchat", "linkedin",
]

# (platform, pasted link, expected final link, link the short/share URL expands to or None)
CASES = [
    # Instagram
    ("instagram", "https://www.instagram.com/reel/AbC_123/?igsh=xyz&utm_source=ig#f", "https://www.instagram.com/reel/AbC_123/", None),
    ("instagram", "https://instagram.com/jane.doe/reel/AbC_123/", "https://www.instagram.com/reel/AbC_123/", None),
    ("instagram", "https://www.instagram.com/p/AbC_123/?img_index=1", "https://www.instagram.com/p/AbC_123/", None),
    ("instagram", "https://www.instagram.com/share/reel/BAbCdEf/", "https://www.instagram.com/reel/AbC_123/", "https://www.instagram.com/reel/AbC_123/?igsh=1"),
    # YouTube
    ("youtube", "https://www.youtube.com/watch?v=jNQXAC9IVRw&si=trk&utm_source=x#t=5", "https://www.youtube.com/watch?v=jNQXAC9IVRw", None),
    ("youtube", "https://youtube.com/shorts/abcDEF12345?feature=share", "https://youtube.com/shorts/abcDEF12345", None),
    ("youtube", "https://youtu.be/jNQXAC9IVRw?si=zz", "https://youtu.be/jNQXAC9IVRw", None),
    ("youtube", "https://m.youtube.com/watch?v=jNQXAC9IVRw", "https://m.youtube.com/watch?v=jNQXAC9IVRw", None),
    # Facebook
    ("facebook", "https://www.facebook.com/reel/1234567890123456?mibextid=x", "https://www.facebook.com/reel/1234567890123456", None),
    ("facebook", "https://www.facebook.com/watch/?v=1234567890123456&fbclid=zz", "https://www.facebook.com/watch/?v=1234567890123456", None),
    ("facebook", "https://fb.watch/abc123XYZ/", "https://www.facebook.com/watch/?v=1234567890123456", "https://www.facebook.com/watch/?v=1234567890123456&mibextid=q"),
    ("facebook", "https://www.facebook.com/share/v/1AbCdEfGhI/", "https://www.facebook.com/reel/1234567890123456", "https://www.facebook.com/reel/1234567890123456?mibextid=q"),
    # Threads
    ("threads", "https://www.threads.net/@zuck/post/CuXyZ123abc?xmt=1", None, None),
    ("threads", "https://www.threads.com/@zuck/post/CuXyZ123abc", "https://www.threads.com/@zuck/post/CuXyZ123abc", None),
    ("threads", "https://www.threads.net/share/AbCdEf", "https://www.threads.com/@zuck/post/CuXyZ123abc", "https://www.threads.com/@zuck/post/CuXyZ123abc?xmt=1"),
    # X / Twitter
    ("x", "https://x.com/jack/status/20?s=20&t=abc", "https://x.com/jack/status/20", None),
    ("x", "https://twitter.com/jack/status/20?ref_src=twsrc", "https://twitter.com/jack/status/20", None),
    # TikTok
    ("tiktok", "https://www.tiktok.com/@scout2015/video/6718335390845095173?_r=1&_t=8abc", "https://www.tiktok.com/@scout2015/video/6718335390845095173", None),
    ("tiktok", "https://vm.tiktok.com/ZMabc123/", "https://www.tiktok.com/@scout2015/video/6718335390845095173", "https://www.tiktok.com/@scout2015/video/6718335390845095173?_r=1"),
    ("tiktok", "https://vt.tiktok.com/ZSabc123/", "https://www.tiktok.com/@scout2015/video/6718335390845095173", "https://www.tiktok.com/@scout2015/video/6718335390845095173?_t=9"),
    # Pinterest
    ("pinterest", "https://www.pinterest.com/pin/1234567890123/?utm_medium=x", "https://www.pinterest.com/pin/1234567890123/", None),
    ("pinterest", "https://www.pinterest.co.uk/pin/1234567890123/", "https://www.pinterest.co.uk/pin/1234567890123/", None),
    ("pinterest", "https://pin.it/4AbCdE", "https://www.pinterest.com/pin/1234567890123/", "https://www.pinterest.com/pin/1234567890123/?utm_source=pinterest_share"),
    # Reddit
    ("reddit", "https://www.reddit.com/r/videos/comments/abc123/some_title/?utm_name=x", "https://www.reddit.com/r/videos/comments/abc123/some_title/", None),
    ("reddit", "https://www.reddit.com/r/videos/s/AbCdEfGhIj", "https://www.reddit.com/r/videos/comments/abc123/some_title/", "https://www.reddit.com/r/videos/comments/abc123/some_title/?share_id=q"),
    ("reddit", "https://v.redd.it/abc123xyz", "https://www.reddit.com/r/videos/comments/abc123/some_title/", "https://www.reddit.com/r/videos/comments/abc123/some_title/"),
    # Snapchat
    ("snapchat", "https://www.snapchat.com/spotlight/W7_EDlXWTBiXAEEniNoMPwAAYb2dybW1sZWhmAZWU5H8MAZWU5H2yAAAAAA?sender_device=web", "https://www.snapchat.com/spotlight/W7_EDlXWTBiXAEEniNoMPwAAYb2dybW1sZWhmAZWU5H8MAZWU5H2yAAAAAA", None),
    ("snapchat", "https://t.snapchat.com/AbCdEfGh", "https://www.snapchat.com/spotlight/W7_EDlXWTBiXAEEniNoMPwAAYb2dybW1sZWhmAZWU5H8MAZWU5H2yAAAAAA", "https://www.snapchat.com/spotlight/W7_EDlXWTBiXAEEniNoMPwAAYb2dybW1sZWhmAZWU5H8MAZWU5H2yAAAAAA?sender_device=web"),
    # LinkedIn (share links carry utm_ and rcm tracking)
    ("linkedin", "https://www.linkedin.com/posts/the-mathworks_what-is-mathworks-cloud-center-activity-7151241570371948544-4Gu7?utm_source=share&utm_medium=member_desktop&rcm=ACoAAB" , "https://www.linkedin.com/posts/the-mathworks_what-is-mathworks-cloud-center-activity-7151241570371948544-4Gu7", None),
]

REJECTED = [
    "",
    "not a url",
    "ftp://www.youtube.com/watch?v=abc",
    "https://evil.com/watch?v=abc",
    "https://youtube.com.evil.com/watch?v=abc",
    "https://notyoutube.com/watch?v=abc",
    "https://evil.com/?u=https://www.youtube.com/watch?v=abc",
    "http://127.0.0.1/reel/abc/",
    "https://www.instagram.com/jane.doe/",
    "https://linkedin.com.evil.com/posts/x-activity-1-abcd",
]


def fake_expander(mapping):
    def expand(url):
        return mapping[url]
    return expand


class UrlResolutionTests(unittest.TestCase):
    def test_every_platform_is_covered(self):
        self.assertEqual({c[0] for c in CASES}, set(PLATFORMS))

    def test_cases_resolve_to_clean_urls(self):
        for platform, pasted, expected, expanded in CASES:
            with self.subTest(platform=platform, url=pasted):
                expand = fake_expander({pasted: expanded}) if expanded else None
                if expanded:
                    self.assertTrue(needs_expansion(pasted), "short/share link must be expanded")
                    result = resolve_url(pasted, expand=expand)
                else:
                    self.assertFalse(needs_expansion(pasted), "full URL must not trigger a network call")
                    result = resolve_url(pasted)
                if expected is None:  # only the tracking-free property matters
                    self.assertNotIn("xmt=", result)
                    self.assertIn("/post/CuXyZ123abc", result)
                else:
                    self.assertEqual(result, expected)
                for tracking in ("utm_", "igsh", "fbclid", "si=", "mibextid", "_r=", "_t=", "s=20"):
                    self.assertNotIn(tracking, result)

    def test_unsupported_links_are_rejected(self):
        for bad in REJECTED:
            with self.subTest(url=bad):
                with self.assertRaises(UnsupportedUrl):
                    resolve_url(bad)


class YtDlpCompatibilityTests(unittest.TestCase):
    """The resolved URL must be one that a real (non-generic) yt-dlp extractor claims."""

    @classmethod
    def setUpClass(cls):
        try:
            from yt_dlp.extractor import gen_extractors
        except ImportError as exc:  # pragma: no cover
            raise unittest.SkipTest(f"yt-dlp not installed: {exc}")
        cls.extractors = [ie for ie in gen_extractors() if ie.IE_NAME != "generic"]

    def test_resolved_urls_are_claimed_by_an_extractor(self):
        for platform, pasted, expected, expanded in CASES:
            if platform == "threads":
                continue  # handled by our own extractor, see ThreadsExtractorTests
            with self.subTest(platform=platform, url=pasted):
                final = expected or resolve_url(pasted)
                claimed = [ie.IE_NAME for ie in self.extractors if ie.suitable(final)]
                self.assertTrue(claimed, f"no yt-dlp extractor accepts {final}")

    def test_threads_is_routed_to_our_extractor(self):
        for platform, pasted, expected, expanded in CASES:
            if platform == "threads":
                final = resolve_url(pasted, expand=fake_expander({pasted: expanded}) if expanded else None) \
                    if expanded else resolve_url(pasted)
                from urllib.parse import urlparse
                self.assertTrue(urls.is_threads_host(urlparse(final).hostname))


class MockServer:
    """Tiny local HTTP server driven by a {path: (status, headers, body)} table."""

    def __init__(self, routes):
        outer_routes = routes

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802
                status, headers, body = outer_routes.get(self.path, (404, {}, b"not found"))
                self.send_response(status)
                for key, value in headers.items():
                    self.send_header(key, value)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):  # silence
                pass

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        self.base = f"http://127.0.0.1:{self.server.server_port}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *exc):
        self.server.shutdown()
        self.server.server_close()


class RedirectExpansionTests(unittest.TestCase):
    def local_only(self, host):
        return host == "127.0.0.1"

    def test_follows_a_redirect_chain_to_the_final_url(self):
        routes = {
            "/short": (301, {"Location": "/hop"}, b""),
            "/hop": (302, {"Location": "/pin/1234567890123/?utm=x"}, b""),
            "/pin/1234567890123/?utm=x": (200, {}, b"ok"),
        }
        with MockServer(routes) as server:
            final = expand_redirects(f"{server.base}/short", host_ok=self.local_only)
        self.assertEqual(final, f"{server.base}/pin/1234567890123/?utm=x")

    def test_refuses_to_follow_into_a_disallowed_host(self):
        routes = {"/short": (302, {"Location": "http://evil.example/steal"}, b"")}
        with MockServer(routes) as server:
            with self.assertRaises(UnsupportedUrl):
                expand_redirects(f"{server.base}/short", host_ok=self.local_only)

    def test_stops_at_login_walls(self):
        routes = {
            "/short": (302, {"Location": "/login?next=/x"}, b""),
        }
        with MockServer(routes) as server:
            final = expand_redirects(f"{server.base}/short", host_ok=self.local_only)
        self.assertTrue(final.endswith("/short"), final)

    def test_error_responses_return_the_last_good_url(self):
        with MockServer({}) as server:  # everything is a 404
            url = f"{server.base}/missing"
            self.assertEqual(expand_redirects(url, host_ok=self.local_only), url)

    def test_hop_limit(self):
        routes = {"/loop": (302, {"Location": "/loop"}, b"")}
        with MockServer(routes) as server:
            final = expand_redirects(f"{server.base}/loop", host_ok=self.local_only, max_hops=3)
        self.assertTrue(final.endswith("/loop"))

    def test_unreachable_host_falls_back_to_the_original_url(self):
        url = "http://127.0.0.1:9/x"  # nothing listens on the discard port
        self.assertEqual(expand_redirects(url, host_ok=self.local_only, timeout=1), url)


class ThreadsExtractorTests(unittest.TestCase):
    def test_reads_video_versions_json(self):
        html = (
            '<html><head><meta property="og:image" content="https://scontent.cdninstagram.com/t.jpg"/>'
            '<meta property="og:description" content="Hello &amp; welcome"/></head>'
            '<body><script>{"video_versions":[{"type":101,"url":"https:\\/\\/scontent.cdninstagram.com\\/v1.mp4","width":720,"height":1280}]}</script></body></html>'
        ).encode()
        from extractors import extract_threads
        with MockServer({"/@u/post/AbC123": (200, {"Content-Type": "text/html"}, html)}) as server:
            info = extract_threads(f"{server.base}/@u/post/AbC123")
        self.assertIsNotNone(info)
        self.assertEqual(info["id"], "AbC123")
        self.assertEqual(info["title"], "Hello & welcome")
        self.assertEqual(info["thumbnail"], "https://scontent.cdninstagram.com/t.jpg")
        self.assertEqual(info["formats"][0]["url"], "https://scontent.cdninstagram.com/v1.mp4")

    def test_falls_back_to_og_video(self):
        html = b'<meta property="og:video" content="https://scontent.cdninstagram.com/og.mp4">'
        from extractors import extract_threads
        with MockServer({"/@u/post/X1": (200, {}, html)}) as server:
            info = extract_threads(f"{server.base}/@u/post/X1")
        self.assertEqual(info["formats"][0]["url"], "https://scontent.cdninstagram.com/og.mp4")

    def test_returns_none_when_no_video(self):
        from extractors import extract_threads
        with MockServer({"/@u/post/X2": (200, {}, b"<html>text post</html>")}) as server:
            self.assertIsNone(extract_threads(f"{server.base}/@u/post/X2"))


class ScraperConfigTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            import main
        except ImportError as exc:  # pragma: no cover
            raise unittest.SkipTest(f"fastapi/yt-dlp not installed: {exc}")
        cls.main = main

    def test_youtube_player_clients_and_user_agent(self):
        opts = self.main.YDL_OPTS
        self.assertEqual(opts["extractor_args"], {"youtube": {"player_client": ["android"], "player_skip": ["webpage", "configs", "initial_data", "js"]}})
        self.assertIn("Mozilla/5.0", opts["http_headers"]["User-Agent"])
        self.assertTrue(opts["skip_download"])

    def test_picks_premuxed_mp4_over_video_only(self):
        def fmt(fid, h, acodec, ext="mp4", proto="https"):
            return {"format_id": fid, "url": f"https://x.cdninstagram.com/{fid}", "ext": ext,
                    "height": h, "width": h * 9 // 16, "vcodec": "avc1", "acodec": acodec, "protocol": proto}

        info = {"formats": [fmt("dash1080", 1080, "none"), fmt("prog720", 720, "mp4a"),
                            fmt("hls", 1080, "mp4a", proto="m3u8_native")]}
        url, audio = self.main._pick_video(info)
        self.assertTrue(url.endswith("prog720"))
        self.assertEqual(audio, "yes")

        url, audio = self.main._pick_video({"formats": [fmt("dash1080", 1080, "none")]})
        self.assertTrue(url.endswith("dash1080"))
        self.assertEqual(audio, "no")

    def test_equal_sized_formats_go_to_the_higher_bitrate(self):
        # LinkedIn reports no height or codecs, only a bitrate: without the tie-break the lowest quality could win.
        def fmt(fid, tbr):
            return {"format_id": fid, "url": f"https://dms.licdn.com/{fid}.mp4", "ext": "mp4", "protocol": "https", "tbr": tbr}

        info = {"formats": [fmt("low", 300), fmt("high", 2100), fmt("mid", 900)]}
        url, audio = self.main._pick_video(info)
        self.assertTrue(url.endswith("high.mp4"))
        self.assertEqual(audio, "unknown")

    def test_endpoint_rejects_unsupported_links_with_400(self):
        try:
            from fastapi.testclient import TestClient
        except ImportError:  # pragma: no cover
            self.skipTest("httpx not installed for TestClient")
        client = TestClient(self.main.app)
        for bad in ("https://evil.com/watch?v=1", "not a url"):
            with self.subTest(url=bad):
                response = client.get("/extract", params={"url": bad})
                self.assertEqual(response.status_code, 400)
                detail = response.json()["detail"]
                self.assertEqual(detail["code"], "INVALID_URL")
                self.assertIn("supported", detail["message"])


@unittest.skipUnless(
    shutil.which("node"), "node is required for the TypeScript parity check"
)
class TypeScriptParityTests(unittest.TestCase):
    """reels-extractor/lib/platforms.ts must classify every link the same way."""

    def test_typescript_parser_agrees(self):
        lib = ROOT.parent / "reels-extractor" / "lib"
        if not (lib / "platforms.ts").exists():  # pragma: no cover
            self.skipTest("web app not present")

        version = subprocess.run(["node", "--version"], capture_output=True, text=True).stdout.strip()
        major = int(version.lstrip("v").split(".")[0])
        if major < 22:  # pragma: no cover
            self.skipTest("Node >= 22.6 is needed for --experimental-strip-types")

        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            shutil.copy(lib / "instagram.ts", tmp_path / "instagram.ts")
            source = (lib / "platforms.ts").read_text(encoding="utf8")
            (tmp_path / "platforms.ts").write_text(
                source.replace('"@/lib/instagram"', '"./instagram.ts"'), encoding="utf8"
            )
            inputs = [c[1] for c in CASES] + REJECTED
            (tmp_path / "run.ts").write_text(
                'import { parseSupportedUrl } from "./platforms.ts";\n'
                f"const urls: string[] = {json.dumps(inputs)};\n"
                "console.log(JSON.stringify(urls.map((u) => parseSupportedUrl(u))));\n",
                encoding="utf8",
            )
            run = subprocess.run(
                ["node", "--experimental-strip-types", str(tmp_path / "run.ts")],
                capture_output=True, text=True, timeout=60,
            )
            self.assertEqual(run.returncode, 0, run.stderr)
            parsed = json.loads(run.stdout.strip().splitlines()[-1])

        for (platform, pasted, _expected, _expanded), result in zip(CASES, parsed):
            with self.subTest(platform=platform, url=pasted):
                self.assertIsNotNone(result, "web app rejected a link the scraper accepts")
                self.assertEqual(result["platform"], platform)
                for tracking in ("utm_", "igsh", "fbclid", "si=", "mibextid", "_r=", "_t=", "s=20"):
                    self.assertNotIn(tracking, result["url"])

        for bad, result in zip(REJECTED, parsed[len(CASES):]):
            with self.subTest(url=bad):
                self.assertIsNone(result, "web app accepted an unsupported link")


@unittest.skipUnless(os.environ.get("LIVE_TESTS") == "1", "set LIVE_TESTS=1 to hit the real platforms")
class LiveSmokeTests(unittest.TestCase):
    """Opt-in: extract real URLs supplied via TEST_URL_<PLATFORM> environment variables."""

    def test_live_extraction(self):
        import main
        from fastapi import HTTPException

        ran = 0
        for platform in PLATFORMS:
            url = os.environ.get(f"TEST_URL_{platform.upper()}")
            if not url:
                continue
            ran += 1
            with self.subTest(platform=platform):
                try:
                    data = main.extract(url=url)
                except HTTPException as exc:
                    self.fail(f"{platform}: HTTP {exc.status_code}: {exc.detail}")
                self.assertTrue(data["videoUrl"].startswith("http"))
        if not ran:
            self.skipTest("no TEST_URL_<PLATFORM> variables set")


if __name__ == "__main__":
    unittest.main(verbosity=2)
