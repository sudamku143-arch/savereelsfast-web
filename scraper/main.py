import re
from urllib.parse import urlparse

import yt_dlp
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from yt_dlp.utils import DownloadError, ExtractorError

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
}

POST_PATH_REGEX = re.compile(r"(?:^|/)(reel|reels|p|tv)/([A-Za-z0-9_-]+)", re.I)

ALLOWED_HOSTS = ("instagram.com", "www.instagram.com", "m.instagram.com")


def _normalize_url(url: str) -> str:
    """Validate the host and reduce the link to https://www.instagram.com/<kind>/<code>/."""
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or parsed.hostname not in ALLOWED_HOSTS:
        raise HTTPException(
            status_code=400, detail="Please provide a valid Instagram Reel URL."
        )
    match = POST_PATH_REGEX.search(parsed.path)
    if not match:
        raise HTTPException(
            status_code=400, detail="Please provide a valid Instagram Reel URL."
        )
    kind = "reel" if match.group(1).lower() == "reels" else match.group(1).lower()
    return f"https://www.instagram.com/{kind}/{match.group(2)}/"


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


# Plain `def` so FastAPI runs the blocking yt-dlp call in its threadpool.
@app.get("/extract")
def extract(url: str = Query(..., description="Public Instagram Reel URL")) -> dict:
    url = url.strip()
    url = _normalize_url(url)

    try:
        with yt_dlp.YoutubeDL(YDL_OPTS) as ydl:
            info = ydl.extract_info(url, download=False)
    except (DownloadError, ExtractorError) as exc:
        message = str(exc).replace("ERROR: ", "").strip()
        raise HTTPException(
            status_code=400,
            detail=f"Couldn't extract this Reel. It may be private, deleted, or "
            f"rate-limited. ({message[:200]})",
        )
    except Exception as exc:  # noqa: BLE001 - never leak a raw 500 to the client
        raise HTTPException(
            status_code=400, detail=f"Extraction failed: {str(exc)[:200]}"
        )

    if not info:
        raise HTTPException(status_code=400, detail="No data returned for this URL.")

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
