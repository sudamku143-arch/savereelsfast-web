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

# Prefer a single progressive MP4 (video + audio); fall back to the best stream.
YDL_OPTS = {
    "format": "best[ext=mp4]/best",
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

    video_url = info.get("url")
    if not video_url:
        raise HTTPException(status_code=400, detail="No downloadable video found.")

    formats = [
        {
            "quality": f"{f['height']}p" if f.get("height") else f.get("format_id", "mp4"),
            "url": f["url"],
            "width": f.get("width"),
            "height": f.get("height"),
        }
        for f in (info.get("formats") or [])
        if f.get("url") and f.get("ext") == "mp4" and f.get("vcodec") not in (None, "none")
    ]
    formats.sort(key=lambda f: f["height"] or 0, reverse=True)

    return {
        "success": True,
        "id": info.get("id"),
        "title": info.get("title") or info.get("description"),
        "author": info.get("uploader") or info.get("channel"),
        "thumbnail": info.get("thumbnail"),
        "duration": info.get("duration"),
        "videoUrl": video_url,
        "formats": formats,
    }
