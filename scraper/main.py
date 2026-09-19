from urllib.parse import urlparse

import yt_dlp
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from yt_dlp.utils import DownloadError, ExtractorError

from extractors import extract_threads
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


def _is_direct_video(fmt: dict) -> bool:
    """A directly downloadable file with a video track (not an HLS/DASH manifest)."""
    return (
        bool(fmt.get("url"))
        and fmt.get("vcodec") != "none"
        and fmt.get("protocol") in (None, "http", "https")
    )


def _pick_video(info: dict) -> tuple[str | None, bool]:
    """
    Choose the single best direct video URL and report whether it is
    confirmed to carry audio.

    Tiers, first non-empty wins (tallest format within a tier):
      1. MP4 pre-muxed with audio     (vcodec != none and acodec != none)
      2. MP4 whose audio is unreported (acodec unknown)
      3. MP4 video-only               (separate audio stream exists; plays silent)
      4. any other direct video file
    """
    direct = [f for f in (info.get("formats") or []) if _is_direct_video(f)]
    mp4 = [f for f in direct if f.get("ext") == "mp4"]

    tiers = [
        [f for f in mp4 if f.get("acodec") not in (None, "none")],
        [f for f in mp4 if f.get("acodec") is None],
        mp4,
        direct,
    ]
    for index, group in enumerate(tiers):
        if group:
            best = max(group, key=lambda f: (f.get("height") or 0, f.get("width") or 0))
            return best["url"], index == 0

    # No usable entry in `formats`: use what yt-dlp itself selected.
    url = info.get("url")
    if not url:
        requested = info.get("requested_formats") or []
        url = next((f["url"] for f in requested if f.get("url") and f.get("vcodec") != "none"), None)
    return url, info.get("acodec") not in (None, "none")


@app.get("/")
def health() -> dict:
    return {"status": "ok"}


def _extract_info(url: str) -> dict | None:
    """Threads has no yt-dlp extractor, so it uses our own; everything else uses yt-dlp."""
    if is_threads_host(urlparse(url).hostname or ""):
        return extract_threads(url)
    with yt_dlp.YoutubeDL(YDL_OPTS) as ydl:
        return ydl.extract_info(url, download=False)


# Plain `def` so FastAPI runs the blocking network calls in its threadpool.
@app.get("/extract")
def extract(
    url: str = Query(
        ...,
        description="Public video URL (Instagram, YouTube, Facebook, Threads, X, "
        "Pinterest, TikTok, Reddit or Snapchat)",
    )
) -> dict:
    try:
        # Validates the host, follows short/share links, strips tracking params.
        url = resolve_url(url)
    except UnsupportedUrl as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    try:
        info = _extract_info(url)
    except (DownloadError, ExtractorError) as exc:
        message = str(exc).replace("ERROR: ", "").strip()
        raise HTTPException(
            status_code=400,
            detail=f"Couldn't extract this video. It may be private, deleted, or "
            f"rate-limited. ({message[:200]})",
        )
    except Exception as exc:  # noqa: BLE001 - never leak a raw 500 to the client
        raise HTTPException(
            status_code=400, detail=f"Extraction failed: {str(exc)[:200]}"
        )

    if not info:
        raise HTTPException(
            status_code=400,
            detail="Couldn't extract this video. It may be private, deleted, or "
            "not a video post.",
        )

    video_url, has_audio = _pick_video(info)

    if not video_url:
        raise HTTPException(status_code=400, detail="No downloadable video found.")

    return {
        "success": True,
        "id": info.get("id"),
        "title": info.get("title") or info.get("description"),
        "author": info.get("uploader") or info.get("channel"),
        "thumbnail": info.get("thumbnail"),
        "duration": info.get("duration"),
        "videoUrl": video_url,
        "hasAudio": has_audio,
        "formats": [],  # a single best progressive stream is returned in videoUrl
    }
