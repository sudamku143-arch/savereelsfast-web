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


def _audio_state(fmt: dict) -> str:
    """'yes' / 'no' / 'unknown' - yt-dlp reports acodec="none" for video-only streams."""
    acodec = fmt.get("acodec")
    if acodec is None:
        return "unknown"
    return "no" if acodec == "none" else "yes"


def _has_video(fmt: dict) -> bool:
    return bool(fmt.get("url")) and fmt.get("vcodec") != "none"


def _to_option(fmt: dict) -> dict:
    height = fmt.get("height")
    return {
        "quality": f"{height}p" if height else fmt.get("format_id", "mp4"),
        "url": fmt["url"],
        "width": fmt.get("width"),
        "height": height,
    }


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

    # Only offer progressive MP4s that contain audio. Formats whose audio is
    # merely unreported are used only if nothing is confirmed to have sound.
    candidates = [
        f for f in (info.get("formats") or []) if _has_video(f) and f.get("ext") == "mp4"
    ]
    with_audio = [f for f in candidates if _audio_state(f) == "yes"]
    unknown_audio = [f for f in candidates if _audio_state(f) == "unknown"]
    usable = with_audio or unknown_audio

    formats = [_to_option(f) for f in usable]
    formats.sort(key=lambda f: f["height"] or 0, reverse=True)

    # Primary URL: best confirmed-audio format, else the format yt-dlp selected.
    if formats:
        video_url = formats[0]["url"]
        has_audio = bool(with_audio)
    else:
        video_url = info.get("url")
        has_audio = _audio_state(info) != "no"

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
        "formats": formats,
    }
