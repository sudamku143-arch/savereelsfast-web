#!/usr/bin/env python
"""
Live end-to-end check of the scraper against real public videos.

For every platform it:
  1. calls  GET /extract?url=...         -> expects HTTP 200 and a videoUrl
  2. calls  GET /stream?url=<videoUrl>   -> expects HTTP 200, a video content
     type, and the first bytes of a real container (MP4 `ftyp` / WebM / MPEG-TS)

/stream is the IP-bound-CDN proxy: the download runs from the scraper's own IP,
which is the one the CDN issued the link to.

Usage (from the scraper/ folder):

    python test_live_extraction.py                     # starts a local scraper itself
    SCRAPER_URL=https://my-scraper.onrender.com python test_live_extraction.py
    TEST_URL_THREADS=https://www.threads.net/@user/post/ID python test_live_extraction.py
    python test_live_extraction.py youtube reddit      # only some platforms

Override any default with TEST_URL_<PLATFORM> (INSTAGRAM, YOUTUBE, THREADS, REDDIT,
TIKTOK, FACEBOOK, X, PINTEREST, SNAPCHAT). Set SCRAPER_SHARED_SECRET if the service
requires it. Exit code is 1 if any platform FAILS; SKIPPED (no URL) does not fail.
"""

import os
import socket
import subprocess
import sys
import time
from dataclasses import dataclass, field

import httpx

# Public videos that were extractable when this script was written. Posts get
# deleted, so override them with TEST_URL_<PLATFORM> when one goes stale.
DEFAULT_URLS: dict[str, str | None] = {
    "youtube": "https://youtube.com/shorts/aqz-KE-bpKQ",
    "instagram": "https://instagram.com/p/aye83DjauH/",  # from yt-dlp's own test suite
    "threads": None,  # no stable public post to hard-code: set TEST_URL_THREADS
    "reddit": "https://www.reddit.com/r/videos/comments/6rrwyj/that_small_heart_attack/",
    "tiktok": "https://www.tiktok.com/@moxypatch/video/7206382937372134662",
    "facebook": "https://www.facebook.com/video.php?v=274175099429670",
    "x": "https://twitter.com/captainamerica/status/719944021058060289",
    "pinterest": "https://www.pinterest.com/pin/664281013778109217/",
    "snapchat": "https://www.snapchat.com/spotlight/W7_EDlXWTBiXAEEniNoMPwAAYYWtidGhudGZpAX1TKn0JAX1TKnXJAAAAAA",
}

EXTRACT_TIMEOUT = 20.0  # the service itself gives up after 5 s; anything slower is a hang
STREAM_TIMEOUT = 60.0
SNIFF_BYTES = 64 * 1024


@dataclass
class Result:
    platform: str
    url: str | None
    status: str = "SKIP"  # PASS | FAIL | SKIP
    extract_http: int | None = None
    stream_http: int | None = None
    audio: str = "-"
    size: str = "-"
    seconds: float = 0.0
    note: str = ""
    checks: list[str] = field(default_factory=list)


def container_kind(head: bytes) -> str | None:
    """Recognise the start of a playable video file."""
    if len(head) >= 12 and head[4:8] == b"ftyp":
        return "MP4"
    if head[:4] == b"\x1a\x45\xdf\xa3":
        return "WebM"
    if head[:1] == b"\x47" and len(head) > 188 and head[188:189] == b"\x47":
        return "MPEG-TS"
    return None


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def start_local_scraper() -> tuple[subprocess.Popen, str]:
    port = free_port()
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "main:app", "--port", str(port), "--log-level", "warning"],
        cwd=os.path.dirname(os.path.abspath(__file__)),
    )
    base = f"http://127.0.0.1:{port}"
    for _ in range(60):
        try:
            if httpx.get(base + "/", timeout=1).status_code == 200:
                return proc, base
        except httpx.HTTPError:
            time.sleep(0.5)
    proc.terminate()
    raise SystemExit("Could not start the local scraper (is uvicorn installed?)")


def check_platform(client: httpx.Client, base: str, platform: str, url: str | None, headers: dict) -> Result:
    result = Result(platform, url)
    if not url:
        result.note = f"no URL - set TEST_URL_{platform.upper()}"
        return result

    started = time.time()
    try:
        # 1. extract
        response = client.get(f"{base}/extract", params={"url": url}, headers=headers, timeout=EXTRACT_TIMEOUT)
        result.extract_http = response.status_code
        body = response.json()
        if response.status_code != 200:
            detail = body.get("detail", body)
            code = detail.get("code") if isinstance(detail, dict) else None
            result.status = "FAIL"
            result.note = f"extract {response.status_code} {code or ''}".strip()
            return result
        result.audio = body.get("audio", "-")
        video_url = body.get("videoUrl")
        if not video_url:
            result.status, result.note = "FAIL", "extract returned no videoUrl"
            return result

        # 2. stream it through the scraper and sniff the first bytes
        with client.stream(
            "GET",
            f"{base}/stream",
            params={"url": video_url, "id": platform},
            headers=headers,
            timeout=STREAM_TIMEOUT,
        ) as stream:
            result.stream_http = stream.status_code
            if stream.status_code != 200:
                stream.read()
                detail = stream.json().get("detail", {}) if stream.headers.get("content-type", "").startswith("application/json") else {}
                result.status = "FAIL"
                result.note = f"stream {stream.status_code} {detail.get('code', '') if isinstance(detail, dict) else ''}".strip()
                return result

            content_type = stream.headers.get("content-type", "")
            disposition = stream.headers.get("content-disposition", "")
            head = b""
            for chunk in stream.iter_bytes():
                head += chunk
                if len(head) >= SNIFF_BYTES:
                    break
            length = stream.headers.get("content-length")
            result.size = f"{int(length) / 1e6:.1f} MB" if length and length.isdigit() else f"{len(head) // 1024}+ KB"

        kind = container_kind(head)
        problems = []
        if not content_type.startswith("video/"):
            problems.append(f"content-type {content_type!r}")
        if "attachment" not in disposition:
            problems.append("no attachment header")
        if kind is None:
            problems.append("bytes are not a video container")
        if len(head) < 10_000:
            problems.append(f"only {len(head)} bytes")
        if problems:
            result.status, result.note = "FAIL", "; ".join(problems)
        else:
            result.status = "PASS"
            result.note = f"{kind}" + ("  (no audio track)" if result.audio == "no" else "")
    except httpx.TimeoutException:
        result.status, result.note = "FAIL", "timed out"
    except httpx.HTTPError as exc:
        result.status, result.note = "FAIL", f"network error: {exc.__class__.__name__}"
    finally:
        result.seconds = time.time() - started
    return result


def main() -> int:
    selected = [a.lower() for a in sys.argv[1:]] or list(DEFAULT_URLS)
    unknown = [p for p in selected if p not in DEFAULT_URLS]
    if unknown:
        print(f"Unknown platform(s): {', '.join(unknown)}. Choose from: {', '.join(DEFAULT_URLS)}")
        return 2

    headers = {}
    if os.environ.get("SCRAPER_SHARED_SECRET"):
        headers["X-Scraper-Key"] = os.environ["SCRAPER_SHARED_SECRET"]

    proc = None
    base = os.environ.get("SCRAPER_URL", "").rstrip("/")
    if base:
        print(f"Testing deployed scraper: {base}")
    else:
        proc, base = start_local_scraper()
        print(f"Testing local scraper at {base}")

    results: list[Result] = []
    try:
        with httpx.Client(follow_redirects=False) as client:
            for platform in selected:
                url = os.environ.get(f"TEST_URL_{platform.upper()}") or DEFAULT_URLS[platform]
                print(f"  -> {platform:<9} ", end="", flush=True)
                result = check_platform(client, base, platform, url, headers)
                print(result.status)
                results.append(result)
    finally:
        if proc:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()

    print()
    print(f"{'PLATFORM':<10} {'RESULT':<6} {'EXTRACT':>7} {'STREAM':>6} {'AUDIO':<8} {'SIZE':>9} {'TIME':>6}  NOTE")
    print("-" * 92)
    for r in results:
        print(
            f"{r.platform:<10} {r.status:<6} {str(r.extract_http or '-'):>7} {str(r.stream_http or '-'):>6} "
            f"{r.audio:<8} {r.size:>9} {r.seconds:>5.1f}s  {r.note}"
        )
    print("-" * 92)
    passed = sum(r.status == "PASS" for r in results)
    failed = sum(r.status == "FAIL" for r in results)
    skipped = sum(r.status == "SKIP" for r in results)
    print(f"{passed} passed, {failed} failed, {skipped} skipped  (of {len(results)})")
    silent = [r.platform for r in results if r.status == "PASS" and r.audio == "no"]
    if silent:
        print(f"Note: these streamed fine but only offer a video-only file (silent): {', '.join(silent)}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
