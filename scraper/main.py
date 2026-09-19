import os
import re
import socket
import urllib.error
import urllib.request
from typing import Iterator
from urllib.parse import urlparse

import yt_dlp
from fastapi import FastAPI, Header, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from yt_dlp.utils import DownloadError, ExtractorError

import errors
from errors import ScraperError, classify_failure
from extractors import CRAWLER_UA, extract_threads
from urls import BROWSER_UA, UnsupportedUrl, is_threads_host, resolve_url

app = FastAPI(title="SaveReelsFast scraper")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Only the metadata is needed (we read URLs from `info["formats"]` ourselves),
# so the selector just has to match *something* - a selector that matches
# nothing makes yt-dlp raise "Requested format is not available".
YDL_OPTS = {
    "format": "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
    "quiet": True,
    "no_warnings": True,
    "noplaylist": True,
    "skip_download": True,
    "ignore_no_formats_error": True,
    "socket_timeout": 15,
    # A current browser UA avoids the 403s some CDNs (e.g. TikTok) return to
    # unfamiliar clients.
    "http_headers": {"User-Agent": BROWSER_UA},
    # Datacenter IPs get bot-checked on the default web client; the mobile
    # clients are usually let through.
    "extractor_args": {"youtube": {"player_client": ["android", "ios", "web"]}},
}

class _MessageCollector:
    """yt-dlp logger that keeps warnings/errors.

    With ignore_no_formats_error, the real reason a video can't be fetched
    ("Video unavailable", "Sign in to confirm you're not a bot", ...) is only
    reported as a warning, so we keep it to classify the failure.
    """

    def __init__(self):
        self.messages: list[str] = []

    def debug(self, msg): ...

    def info(self, msg): ...

    def warning(self, msg):
        self.messages.append(str(msg))

    def error(self, msg):
        self.messages.append(str(msg))


MAX_STREAM_BYTES = 200 * 1024 * 1024
CHUNK_SIZE = 64 * 1024


def _check_key(key: str | None) -> None:
    """Optional shared secret so the service isn't an open proxy (set SCRAPER_SHARED_SECRET)."""
    secret = os.environ.get("SCRAPER_SHARED_SECRET")
    if secret and key != secret:
        raise HTTPException(status_code=401, detail={"code": "UNAUTHORIZED", "message": "Invalid key."})


def _is_direct_video(fmt: dict) -> bool:
    """A directly downloadable file with a video track (not an HLS/DASH manifest)."""
    return (
        bool(fmt.get("url"))
        and fmt.get("vcodec") != "none"
        and fmt.get("protocol") in (None, "http", "https")
    )


def _audio_state(fmt: dict) -> str:
    acodec = fmt.get("acodec")
    if acodec is None:
        return "unknown"
    return "no" if acodec == "none" else "yes"


def _pick_format(info: dict) -> tuple[dict | None, str]:
    """
    Choose the single best direct video format and report its audio state:
    "yes" (confirmed), "unknown" (audio codec not reported) or "no"
    (video-only; the audio is a separate stream we can't merge here).

    Tiers, first non-empty wins (tallest format within a tier):
      1. MP4 pre-muxed with audio     (vcodec != none and acodec != none)
      2. MP4 whose audio is unreported (acodec unknown)
      3. MP4 video-only               (plays silent)
      4. any other direct video file
    """
    direct = [f for f in (info.get("formats") or []) if _is_direct_video(f)]
    mp4 = [f for f in direct if f.get("ext") == "mp4"]

    tiers = [
        [f for f in mp4 if _audio_state(f) == "yes"],
        [f for f in mp4 if _audio_state(f) == "unknown"],
        mp4,
        direct,
    ]
    for group in tiers:
        if group:
            best = max(group, key=lambda f: (f.get("height") or 0, f.get("width") or 0))
            return best, _audio_state(best)

    # No usable entry in `formats`: use what yt-dlp itself selected.
    url = info.get("url")
    if url:
        return {"url": url, "http_headers": info.get("http_headers")}, _audio_state(info)
    for f in info.get("requested_formats") or []:
        if f.get("url") and f.get("vcodec") != "none":
            return f, _audio_state(f)
    return None, "unknown"


def _pick_video(info: dict) -> tuple[str | None, str]:
    fmt, audio = _pick_format(info)
    return (fmt["url"] if fmt else None), audio


@app.get("/")
def health() -> dict:
    return {"status": "ok"}


def _extract_info(url: str) -> dict | None:
    """Threads has no yt-dlp extractor, so it uses our own; everything else uses yt-dlp."""
    if is_threads_host(urlparse(url).hostname or ""):
        return extract_threads(url)
    collector = _MessageCollector()
    with yt_dlp.YoutubeDL({**YDL_OPTS, "logger": collector}) as ydl:
        info = ydl.extract_info(url, download=False)
    if info is not None:
        info["_messages"] = collector.messages
    return info


def _no_video_error(info: dict) -> ScraperError:
    """Why an otherwise successful lookup produced no downloadable video."""
    # yt-dlp always appends generic lines like "No video formats found!"; only
    # the message that explains *why* is useful for classification.
    boilerplate = re.compile(r"no video formats found|requested format is not available", re.I)
    text = " ".join(m for m in (info.get("_messages") or []) if not boilerplate.search(m)).strip()
    if not text:
        return ScraperError(errors.UNSUPPORTED_POST)  # nothing was wrong: it just has no video
    code = classify_failure(text)
    if code == errors.EXTRACTION_FAILED:
        return ScraperError(code, f"{errors.MESSAGES[code]} ({text[:160]})")
    return ScraperError(code)


def _failure_from_exception(exc: Exception) -> ScraperError:
    """Turn any extraction exception into a coded error."""
    if isinstance(exc, ScraperError):
        return exc
    if isinstance(exc, (TimeoutError, socket.timeout)):
        return ScraperError(errors.PLATFORM_TIMEOUT)
    text = str(exc).replace("ERROR: ", "").strip()
    code = classify_failure(text)
    if code == errors.EXTRACTION_FAILED and isinstance(exc, (DownloadError, ExtractorError)):
        return ScraperError(code, f"{errors.MESSAGES[code]} ({text[:160]})")
    return ScraperError(code)


def _resolve_and_extract(url: str) -> tuple[str, dict]:
    """Validate/expand the link and fetch its metadata. Raises ScraperError."""
    try:
        url = resolve_url(url)
    except UnsupportedUrl as exc:
        raise ScraperError(errors.INVALID_URL, str(exc))

    try:
        info = _extract_info(url)
    except ScraperError:
        raise
    except Exception as exc:  # noqa: BLE001 - always answer with a coded error
        raise _failure_from_exception(exc)

    if not info:
        raise ScraperError(errors.UNSUPPORTED_POST)
    return url, info


def _http_error(err: ScraperError) -> HTTPException:
    return HTTPException(status_code=err.status, detail=err.detail())


# Plain `def` so FastAPI runs the blocking network calls in its threadpool.
@app.get("/extract")
def extract(
    url: str = Query(
        ...,
        description="Public video URL (Instagram, YouTube, Facebook, Threads, X, "
        "Pinterest, TikTok, Reddit or Snapchat)",
    ),
    x_scraper_key: str | None = Header(default=None),
) -> dict:
    _check_key(x_scraper_key)

    try:
        _resolved, info = _resolve_and_extract(url)
    except ScraperError as err:
        raise _http_error(err)

    fmt, audio = _pick_format(info)
    if not fmt:
        raise _http_error(_no_video_error(info))

    return {
        "success": True,
        "id": info.get("id"),
        "title": info.get("title") or info.get("description"),
        "author": info.get("uploader") or info.get("channel"),
        "thumbnail": info.get("thumbnail"),
        "duration": info.get("duration"),
        "videoUrl": fmt["url"],
        "audio": audio,  # "yes" | "unknown" | "no"
        "hasAudio": audio == "yes",
        "warning": errors.NO_AUDIO if audio == "no" else None,
        "formats": [],  # a single best progressive stream is returned in videoUrl
    }


class OpenStream:
    """An opened upstream video response plus everything needed to close it."""

    def __init__(self, response, length: int | None, closers: list):
        self.response = response
        self.length = length
        self._closers = closers

    def chunks(self) -> Iterator[bytes]:
        sent = 0
        try:
            while True:
                chunk = self.response.read(CHUNK_SIZE)
                if not chunk:
                    break
                sent += len(chunk)
                if sent > MAX_STREAM_BYTES:
                    break
                yield chunk
        finally:
            self.close()

    def close(self) -> None:
        for closer in self._closers:
            try:
                closer()
            except Exception:  # noqa: BLE001
                pass


def _open_stream(page_url: str) -> OpenStream:
    """
    Re-resolve the post from THIS server's IP and open the best video stream.

    Links resolved elsewhere (e.g. on Vercel) are often bound to the IP that
    requested them (YouTube) or need the extractor's own headers/cookies
    (TikTok, Facebook). Fetching here with yt-dlp's session avoids both.
    Raises ScraperError.
    """
    resolved, info = _resolve_and_extract(page_url)
    fmt, _audio = _pick_format(info)
    if not fmt:
        raise _no_video_error(info)

    media_url = fmt["url"]
    try:
        if is_threads_host(urlparse(resolved).hostname or ""):
            request = urllib.request.Request(
                media_url, headers={"User-Agent": CRAWLER_UA, "Referer": "https://www.threads.net/"}
            )
            response = urllib.request.urlopen(request, timeout=15)
            length = response.headers.get("Content-Length")
            return OpenStream(response, int(length) if length else None, [response.close])

        ydl = yt_dlp.YoutubeDL(YDL_OPTS)
        headers = dict(fmt.get("http_headers") or {})
        response = ydl.urlopen(yt_dlp.networking.Request(media_url, headers=headers))
        length = response.headers.get("Content-Length")
        return OpenStream(response, int(length) if length else None, [response.close, ydl.close])
    except ScraperError:
        raise
    except urllib.error.HTTPError as exc:
        raise ScraperError(
            errors.STREAM_EXPIRED_OR_BLOCKED if exc.code in (401, 403, 404, 410, 429) else errors.PLATFORM_TIMEOUT
        )
    except Exception as exc:  # noqa: BLE001
        raise _failure_from_exception(exc)


@app.get("/download")
def download(
    url: str = Query(..., description="The post URL (not a CDN URL); it is re-resolved here"),
    id: str = Query("video", max_length=60),
    x_scraper_key: str | None = Header(default=None),
) -> StreamingResponse:
    """Stream the video through this server (fallback when the CDN refuses other IPs)."""
    _check_key(x_scraper_key)

    try:
        stream = _open_stream(url)
    except ScraperError as err:
        raise _http_error(err)

    safe_id = "".join(c for c in id if c.isalnum() or c in "-_")[:40] or "video"
    headers = {
        "Content-Disposition": f'attachment; filename="savereelsfast-{safe_id}.mp4"',
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
    }
    if stream.length and stream.length <= MAX_STREAM_BYTES:
        headers["Content-Length"] = str(stream.length)

    return StreamingResponse(stream.chunks(), media_type="video/mp4", headers=headers)
