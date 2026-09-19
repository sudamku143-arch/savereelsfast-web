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

# Prefer a single progressive MP4 that carries BOTH video and audio. Instagram
# also serves video-only DASH streams, which play silently, so they come last.
YDL_OPTS = {
    "format": "best[ext=mp4][vcodec!=none][acodec!=none]/best[ext=mp4]/best",
    "quiet": True,
    "no_warnings": True,
    "noplaylist": True,
    "skip_download": True,
    "socket_timeout": 15,
}

ALLOWED_HOSTS = ("instagram.com", "www.instagram.com", "m.instagram.com")


def _validate_url(url: str) -> None:
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or parsed.hostname not in ALLOWED_HOSTS:
        raise HTTPException(
            status_code=400, detail="Please provide a valid Instagram Reel URL."
        )


def _is_playable(fmt: dict) -> bool:
    """A downloadable MP4 with a video track (yt-dlp reports vcodec="none" for audio-only)."""
    return bool(fmt.get("url")) and fmt.get("ext") == "mp4" and fmt.get("vcodec") != "none"


def _best_progressive(info: dict) -> dict | None:
    """
    Pick the single best progressive MP4 (video + audio in one file).

    Formats confirmed to carry audio (acodec present and not "none") win.
    Formats whose acodec is merely unreported are only used when none is
    confirmed. Video-only streams (acodec == "none") are never chosen.
    Within a group, the tallest (then widest) format wins.
    """
    playable = [f for f in (info.get("formats") or []) if _is_playable(f)]
    confirmed = [f for f in playable if f.get("acodec") not in (None, "none")]
    unreported = [f for f in playable if f.get("acodec") is None]

    for group in (confirmed, unreported):
        if group:
            return max(group, key=lambda f: (f.get("height") or 0, f.get("width") or 0))
    return None


@app.get("/")
def health() -> dict:
    return {"status": "ok"}


# Plain `def` so FastAPI runs the blocking yt-dlp call in its threadpool.
@app.get("/extract")
def extract(url: str = Query(..., description="Public Instagram Reel URL")) -> dict:
    url = url.strip()
    _validate_url(url)

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

    best = _best_progressive(info)
    if best:
        video_url = best["url"]
        has_audio = best.get("acodec") is not None
    else:
        # Nothing progressive found: use whatever yt-dlp selected, unless it is video-only.
        video_url = info.get("url")
        has_audio = info.get("acodec") != "none"

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
