import asyncio
import contextvars
import gc
import hmac
import logging
import os
import re
import socket
import time
import weakref
import urllib.error
import urllib.request
from typing import Iterator
from urllib.parse import urljoin, urlparse

import httpx
import yt_dlp
from fastapi import FastAPI, Header, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from starlette.background import BackgroundTask
from yt_dlp.utils import DownloadError, ExtractorError

import errors
from cache import CircuitBreaker, SlotPool, TTLCache, slim_info
from errors import ScraperError, classify_failure
from extractors import CRAWLER_UA, extract_threads
from memory import rss_mb
from urls import (
    BROWSER_UA,
    expand_redirects,
    UnsupportedUrl,
    cache_key,
    is_allowed_media_url,
    is_threads_host,
    is_youtube_host,
    resolve_url,
    safe_referer,
)

app = FastAPI(title="SaveReelsFast scraper", docs_url=None, redoc_url=None, openapi_url=None)

# Only our own server calls this service, never a browser, so no origin needs CORS access. Without
# CORS headers, scripts on other websites cannot use a visitor's browser to reach it. Set
# SCRAPER_ALLOWED_ORIGINS (comma-separated) only if that ever changes.
_ALLOWED_ORIGINS = [o.strip() for o in os.environ.get("SCRAPER_ALLOWED_ORIGINS", "").split(",") if o.strip()]
if _ALLOWED_ORIGINS:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_ALLOWED_ORIGINS,
        allow_methods=["GET"],
        allow_headers=["X-Scraper-Key", "Range"],
    )

_log = logging.getLogger("uvicorn.error")


@app.on_event("startup")
def _warn_when_open() -> None:
    if not os.environ.get("SCRAPER_SHARED_SECRET"):
        _log.warning(
            "SCRAPER_SHARED_SECRET is not set: /extract, /download, /stream and /stats are OPEN to anyone. "
            "Set it (and the same value on the website) and set SCRAPER_REQUIRE_SECRET=1."
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
    "extract_flat": False,  # a single video is resolved fully; playlists are never expanded (noplaylist)
    "ignore_no_formats_error": True,
    # Fail fast: a wait longer than this on one connection means a blocked or struggling host.
    "socket_timeout": 4,
    "retries": 0,
    "extractor_retries": 0,
    "cachedir": False,
    "getcomments": False,
    "writesubtitles": False,
    "writeautomaticsub": False,
    "check_formats": False,
    # A current browser UA avoids the 403s some CDNs (e.g. TikTok) return to
    # unfamiliar clients.
    "http_headers": {"User-Agent": BROWSER_UA},
    "extractor_args": {},  # YouTube's are filled in below, from YOUTUBE_ROUTES
}

# YouTube: one light route. Measured against yt-dlp 2026.08 on real videos, `android` is the only client that
# returns a ready-made MP4 with sound; `ios` and `tv` need a proof-of-origin token, return no formats, and
# each cost extra requests (the tv client also downloads the player script). Skipping the web page, player
# configs, the "next" call (chapters, heatmap, like counts: unused here) and the player script took a lookup
# from 3.5 s to 0.8 s for the identical download. The only thing lost is the uploader's name.
YOUTUBE_ROUTES: list[dict | None] = [
    {"player_client": ["android"], "player_skip": ["webpage", "configs", "initial_data", "js"]},
]
# A second, heavier route (yt-dlp's default client mix) exists for hosts that have a residential proxy. It is
# off by default: on a blocked datacenter IP it only adds seconds before the same failure.
if os.environ.get("YOUTUBE_SECOND_ROUTE", "").lower() in ("1", "true", "yes"):
    YOUTUBE_ROUTES.append(None)
YDL_OPTS["extractor_args"] = {"youtube": YOUTUBE_ROUTES[0]}

# YouTube's own API answers in well under a second, so a request that has been silent for 3 s is a block or a
# stall: give up inside the 4 s the visitor should wait at most.
YOUTUBE_SOCKET_TIMEOUT = 3

# Hard ceiling for one whole lookup (link expansion + extraction). It is enforced inside the work, not just
# around it, so a stalled lookup stops instead of quietly holding a worker.
def _extraction_timeout(raw: str | None) -> float:
    """The configured limit, forced into 2-6 seconds so no setting can bring the long hangs back."""
    try:
        value = float(raw) if raw else 5.0
    except ValueError:
        value = 5.0
    return min(max(value, 2.0), 6.0)


EXTRACTION_TIMEOUT_SECONDS = _extraction_timeout(os.environ.get("EXTRACTION_TIMEOUT_SECONDS"))
DEADLINE_GRACE_SECONDS = 0.75  # how long the caller waits past the deadline for the work to notice it

# After a few YouTube blocks or stalls in a row, answer instantly for a moment instead of trying again.
YOUTUBE_BREAKER = CircuitBreaker(threshold=3, window=30.0, cooldown=15.0)
_BREAKER_FAILURES = {errors.STREAM_EXPIRED_OR_BLOCKED, errors.PLATFORM_TIMEOUT}
_youtube_last_failure = [errors.STREAM_EXPIRED_OR_BLOCKED]  # what to answer while the breaker is open

_deadline: "contextvars.ContextVar[float | None]" = contextvars.ContextVar("extraction_deadline", default=None)


class _DeadlineYDL(yt_dlp.YoutubeDL):
    """yt-dlp that refuses to start another request once the deadline has passed."""

    def __init__(self, params: dict, deadline: float):
        super().__init__(params)
        self._deadline = deadline

    def urlopen(self, req):
        if time.monotonic() >= self._deadline:
            raise TimeoutError("extraction deadline reached")
        return super().urlopen(req)


def _time_left(default: float) -> float:
    deadline = _deadline.get()
    return default if deadline is None else max(0.5, min(default, deadline - time.monotonic()))

# Optional, set on the host (not here): what actually cures YouTube blocking a datacenter IP.
#   YTDLP_PROXY          e.g. http://user:pass@residential-proxy:port  (used for lookups AND downloads)
#   YOUTUBE_COOKIES_FILE path to a Netscape cookies.txt of a throw-away YouTube account
YTDLP_PROXY = os.environ.get("YTDLP_PROXY", "").strip() or None
YOUTUBE_COOKIES_FILE = os.environ.get("YOUTUBE_COOKIES_FILE", "").strip() or None


def _ydl_options(youtube_route: int = 0) -> dict:
    """yt-dlp options for one lookup or download, with the optional proxy and cookies applied."""
    options = dict(YDL_OPTS)
    route = YOUTUBE_ROUTES[min(youtube_route, len(YOUTUBE_ROUTES) - 1)]
    if route is None:
        options.pop("extractor_args", None)
    else:
        options["extractor_args"] = {"youtube": route}
    if YTDLP_PROXY:
        options["proxy"] = YTDLP_PROXY
    if YOUTUBE_COOKIES_FILE and os.path.isfile(YOUTUBE_COOKIES_FILE):
        options["cookiefile"] = YOUTUBE_COOKIES_FILE
    return options

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


# Audio-only containers we can hand to a browser as-is (no transcoding happens here).
AUDIO_TYPES = {
    "m4a": "audio/mp4",
    "mp4": "audio/mp4",
    "aac": "audio/aac",
    "mp3": "audio/mpeg",
    "webm": "audio/webm",
    "ogg": "audio/ogg",
    "opus": "audio/ogg",
}
MAX_ITEMS = 20  # carousel posts are capped so one request can't fan out unbounded

MAX_STREAM_BYTES = 200 * 1024 * 1024
CHUNK_SIZE = 128 * 1024  # streamed in 128 KB pieces: low memory per download, smooth progress


def _env_number(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except ValueError:
        return float(default)


# ---- performance / anti-crash tunables (override with environment variables) ----
MAX_CONCURRENT_EXTRACTIONS = int(_env_number("MAX_CONCURRENT_EXTRACTIONS", 6))  # simultaneous yt-dlp runs
MAX_QUEUED_EXTRACTIONS = int(_env_number("MAX_QUEUED_EXTRACTIONS", 30))  # requests allowed to wait for a slot
QUEUE_WAIT_SECONDS = _env_number("QUEUE_WAIT_SECONDS", 20)  # longest a queued request waits
MAX_CONCURRENT_STREAMS = int(_env_number("MAX_CONCURRENT_STREAMS", 12))  # simultaneous downloads
CACHE_TTL_SECONDS = _env_number("CACHE_TTL_SECONDS", 3600)  # 1 h: signed CDN links stay valid that long; the privacy policy promises at most 90 min
CACHE_MAX_ENTRIES = int(_env_number("CACHE_MAX_ENTRIES", 500))
# Render's free instance has 512 MB. Above this resident size new work is refused (after dropping the
# caches), so the service answers "busy" instead of being killed by the out-of-memory reaper.
MEMORY_SOFT_LIMIT_MB = _env_number("MEMORY_SOFT_LIMIT_MB", 400)
NEGATIVE_TTL_SECONDS = 60  # remember "private / no video" answers briefly so retries don't hammer the platform

INFO_CACHE = TTLCache(max_entries=CACHE_MAX_ENTRIES, ttl=CACHE_TTL_SECONDS)
NEGATIVE_CACHE = TTLCache(max_entries=200, ttl=NEGATIVE_TTL_SECONDS)
# Failures worth remembering: they won't change in the next minute. Timeouts and
# blocks are transient, so they are never cached.
NEGATIVE_CACHEABLE = {errors.LOGIN_REQUIRED, errors.UNSUPPORTED_POST, errors.EXTRACTION_FAILED}

STREAM_SLOTS = SlotPool(MAX_CONCURRENT_STREAMS, max_age=1800)

# asyncio primitives belong to one event loop, so they are created per loop on first use.
_extraction_slots_by_loop: "weakref.WeakKeyDictionary" = weakref.WeakKeyDictionary()
_inflight: dict[str, "asyncio.Task"] = {}
_waiting = 0  # requests currently queued for an extraction slot
_active = 0  # extractions currently running


def _check_key(key: str | None) -> None:
    """
    Gate for every endpoint except /health and /.

    With SCRAPER_SHARED_SECRET set, a request must carry the same value in X-Scraper-Key; the
    comparison is constant-time so the secret can't be guessed from response timing.

    With SCRAPER_REQUIRE_SECRET=1 the service fails CLOSED: if the secret is missing (a deleted
    variable, a botched deploy) every protected endpoint answers 503 instead of silently opening up.
    """
    secret = os.environ.get("SCRAPER_SHARED_SECRET", "")
    if not secret:
        if os.environ.get("SCRAPER_REQUIRE_SECRET", "").lower() in ("1", "true", "yes"):
            raise HTTPException(
                status_code=503,
                detail={"code": "NOT_CONFIGURED", "message": "The service is locked: no shared secret is configured."},
            )
        return
    if not key or not hmac.compare_digest(key.encode("utf-8"), secret.encode("utf-8")):
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


def _pick_audio(info: dict) -> dict | None:
    """
    The best audio-only stream the platform offers, or None.

    Only real audio-only files qualify (vcodec == none, acodec present, direct
    HTTP(S) file). AAC in an M4A container is preferred, then the highest
    bitrate. Nothing is transcoded, so this is M4A (or WebM/Opus), never MP3.
    """
    candidates = [
        f
        for f in (info.get("formats") or [])
        if f.get("url")
        and f.get("vcodec") == "none"
        and f.get("acodec") not in (None, "none")
        and f.get("protocol") in (None, "http", "https")
        and f.get("ext") in AUDIO_TYPES
    ]
    if not candidates:
        return None
    return max(candidates, key=lambda f: (f.get("ext") in ("m4a", "mp4"), f.get("abr") or 0))


def _describe(info: dict) -> dict | None:
    """One downloadable item (video + optional separate audio) from a single-media info dict."""
    fmt, audio = _pick_format(info)
    if not fmt:
        return None
    audio_fmt = _pick_audio(info)
    height = fmt.get("height")
    return {
        "id": info.get("id"),
        "title": info.get("title") or info.get("description"),
        "author": info.get("uploader") or info.get("channel"),
        "thumbnail": info.get("thumbnail"),
        "duration": info.get("duration"),
        "videoUrl": fmt["url"],
        "quality": f"{height}p" if height else None,
        "audio": audio,  # "yes" | "unknown" | "no"
        "hasAudio": audio == "yes",
        "warning": errors.NO_AUDIO if audio == "no" else None,
        "audioUrl": audio_fmt["url"] if audio_fmt else None,
        "audioExt": audio_fmt["ext"] if audio_fmt else None,
        "audioBitrate": round(audio_fmt["abr"]) if audio_fmt and audio_fmt.get("abr") else None,
    }


def _entries(info: dict) -> list[dict]:
    """Media entries of a post: the entries of a carousel/multi-video post, else the post itself."""
    if info.get("_type") == "playlist":
        return [e for e in (info.get("entries") or []) if isinstance(e, dict)][:MAX_ITEMS]
    return [info]


def _describe_items(info: dict) -> list[dict]:
    items = [d for d in (_describe(entry) for entry in _entries(info)) if d]
    for index, item in enumerate(items, start=1):
        item["index"] = index
    return items


# Keep-alive target for uptime pingers (cron-job.org, UptimeRobot, Render health checks).
# The body is a constant 15 bytes: pingers such as cron-job.org disable a job whose response
# is "too big". No auth header is required (pingers can't send one), and nothing here touches
# the cache, yt-dlp or the network, so it answers instantly even when the service is busy.
_HEALTH_BODY = b'{"status":"ok"}'


@app.api_route("/health", methods=["GET", "HEAD"], include_in_schema=False)
def health_check() -> Response:
    return Response(
        content=_HEALTH_BODY,
        media_type="application/json",
        headers={"Cache-Control": "no-store"},
    )


@app.api_route("/", methods=["GET", "HEAD"], include_in_schema=False)
def root() -> Response:
    """Public and tiny (some platforms use "/" as their health check); reveals nothing."""
    return health_check()


@app.get("/stats", include_in_schema=False)
def stats(x_scraper_key: str | None = Header(default=None)) -> dict:
    """Cache hit rate and queue depth. Protected: it describes the service's internals."""
    _check_key(x_scraper_key)
    return {
        "status": "ok",
        "cache": INFO_CACHE.stats(),
        "extractions": {"active": _active, "waiting": _waiting, "limit": MAX_CONCURRENT_EXTRACTIONS},
        "streams": {"active": STREAM_SLOTS.active, "limit": STREAM_SLOTS.size},
        "memory": {"rssMb": None if rss_mb() is None else round(rss_mb(), 1), "softLimitMb": MEMORY_SOFT_LIMIT_MB},
    }


def _extract_info(url: str, youtube_route: int = 0) -> dict | None:
    """Threads has no yt-dlp extractor, so it uses our own; everything else uses yt-dlp."""
    if is_threads_host(urlparse(url).hostname or ""):
        return extract_threads(url, timeout=_time_left(12.0))
    collector = _MessageCollector()
    options = {**_ydl_options(youtube_route), "logger": collector}
    if is_youtube_host(urlparse(url).hostname or ""):
        options["socket_timeout"] = YOUTUBE_SOCKET_TIMEOUT
    deadline = _deadline.get()
    ydl_class = (lambda params: _DeadlineYDL(params, deadline)) if deadline is not None else yt_dlp.YoutubeDL
    with ydl_class(options) as ydl:
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


# Only blocks are route-specific. A timeout says nothing about the route (retrying would double the load
# on a struggling host), and a private or age-restricted video is private on every route.
_RETRY_ON_OTHER_ROUTE = {errors.STREAM_EXPIRED_OR_BLOCKED}


def _has_download(info: dict) -> bool:
    return bool(_describe_items(slim_info(info)))


def _resolve_and_extract(url: str, first_route: int = 0) -> tuple[str, dict]:
    """
    Validate/expand the link and fetch its metadata. Raises ScraperError.

    YouTube is looked up on each route from `first_route` on until one yields something downloadable, so a
    block on one client fingerprint is not the end. Other platforms have a single route.
    """
    _deadline.set(time.monotonic() + EXTRACTION_TIMEOUT_SECONDS)
    try:
        # Share links may need a few redirects followed; that time comes out of the same budget.
        url = resolve_url(url, expand=lambda u: expand_redirects(u, timeout=_time_left(3.0), max_hops=3))
    except UnsupportedUrl as exc:
        raise ScraperError(errors.INVALID_URL, str(exc))

    youtube = is_youtube_host(urlparse(url).hostname or "")
    if youtube and YOUTUBE_BREAKER.is_open():
        raise ScraperError(_youtube_last_failure[0])  # failed a moment ago: don't ask again yet
    first_route = min(first_route, len(YOUTUBE_ROUTES) - 1)
    routes = range(first_route, len(YOUTUBE_ROUTES)) if youtube else [0]
    info, failure = None, None
    for route in routes:
        try:
            found = _extract_info(url) if route == 0 else _extract_info(url, route)
        except ScraperError as err:
            failure = err
        except Exception as exc:  # noqa: BLE001 - always answer with a coded error
            failure = _failure_from_exception(exc)
        else:
            if found and (_has_download(found) or route == routes[-1]):
                if youtube and _has_download(found):
                    YOUTUBE_BREAKER.record_success()
                return url, found
            info = info or found  # keep it: its messages explain why there is nothing to download
            failure = None
            continue
        if youtube and failure.code in _BREAKER_FAILURES:
            _youtube_last_failure[0] = failure.code
            YOUTUBE_BREAKER.record_failure()
        if failure.code not in _RETRY_ON_OTHER_ROUTE or route == routes[-1]:
            raise failure

    if info:
        return url, info
    if failure:
        raise failure
    raise ScraperError(errors.UNSUPPORTED_POST)


def _http_error(err: ScraperError) -> HTTPException:
    headers = {"Retry-After": "5"} if err.code == errors.SERVER_BUSY else None
    return HTTPException(status_code=err.status, detail=err.detail(), headers=headers)


def _shed_load_if_low_on_memory() -> None:
    """
    Refuse new work while the process is close to the host's memory limit.

    First give back what can be rebuilt (the caches, garbage); only if the process is still over
    the ceiling is the request turned away with SERVER_BUSY, which the site shows as "try again".
    """
    used = rss_mb()
    if used is None or used < MEMORY_SOFT_LIMIT_MB:
        return
    INFO_CACHE.clear()
    NEGATIVE_CACHE.clear()
    gc.collect()
    used = rss_mb()
    if used is not None and used >= MEMORY_SOFT_LIMIT_MB:
        raise ScraperError(errors.SERVER_BUSY)


def _extraction_slots() -> asyncio.Semaphore:
    loop = asyncio.get_running_loop()
    slots = _extraction_slots_by_loop.get(loop)
    if slots is None:
        slots = asyncio.Semaphore(MAX_CONCURRENT_EXTRACTIONS)
        _extraction_slots_by_loop[loop] = slots
    return slots


def _swallow_result(task: "asyncio.Task") -> None:
    """Mark a finished task's exception as retrieved so asyncio doesn't log it as unhandled."""
    if not task.cancelled():
        task.exception()


async def _extract_guarded(url: str, key: str, first_route: int = 0) -> tuple[str, dict]:
    """
    Run one extraction inside the concurrency limit.

    At most MAX_CONCURRENT_EXTRACTIONS yt-dlp runs execute at once. Extra
    requests queue (up to MAX_QUEUED_EXTRACTIONS, for at most QUEUE_WAIT_SECONDS)
    and are then turned away with a 503 instead of piling up until the instance
    runs out of memory.
    """
    global _waiting, _active
    _shed_load_if_low_on_memory()
    slots = _extraction_slots()

    if slots.locked() and _waiting >= MAX_QUEUED_EXTRACTIONS:
        raise ScraperError(errors.SERVER_BUSY)

    _waiting += 1
    try:
        await asyncio.wait_for(slots.acquire(), timeout=QUEUE_WAIT_SECONDS)
    except asyncio.TimeoutError:
        raise ScraperError(errors.SERVER_BUSY)
    finally:
        _waiting -= 1

    _active += 1
    work = asyncio.ensure_future(asyncio.to_thread(_resolve_and_extract, url, first_route))

    def _work_ended(done: "asyncio.Future") -> None:
        # The slot is freed when the thread has really finished, not when the caller stopped waiting:
        # that keeps the number of live yt-dlp threads under the cap even after a timeout.
        global _active
        _active -= 1
        slots.release()
        if not done.cancelled():
            done.exception()  # mark retrieved

    work.add_done_callback(_work_ended)
    try:
        resolved, info = await asyncio.wait_for(
            asyncio.shield(work), timeout=EXTRACTION_TIMEOUT_SECONDS + DEADLINE_GRACE_SECONDS
        )
    except asyncio.TimeoutError:
        raise ScraperError(errors.PLATFORM_TIMEOUT)
    except ScraperError as err:
        if err.code in NEGATIVE_CACHEABLE:
            NEGATIVE_CACHE.set(key, err)
        raise

    entry = {"resolved": resolved, "info": slim_info(info)}
    INFO_CACHE.set(key, entry)
    try:  # a short link and the full link it points to share one entry
        INFO_CACHE.set(cache_key(resolved), entry)
    except UnsupportedUrl:
        pass
    return resolved, entry["info"]


async def _acquire_info(url: str, fresh: bool = False, first_route: int = 0) -> tuple[str, dict, bool]:
    """
    Post metadata for `url`: (resolved URL, info, served_from_cache).

    Order: cache -> negative cache -> join an identical in-flight extraction
    -> start a new one. A viral link requested by 100 people at once therefore
    costs a single yt-dlp run, and everyone after it costs a dict lookup.
    `fresh=True` skips the caches (used when a cached link turned out to be dead).
    """
    try:
        key = cache_key(url)
    except UnsupportedUrl as exc:
        raise ScraperError(errors.INVALID_URL, str(exc))

    if not fresh:
        hit = INFO_CACHE.get(key)
        if hit is not None:
            return hit["resolved"], hit["info"], True
        known_failure = NEGATIVE_CACHE.get(key)
        if known_failure is not None:
            raise known_failure

    task = _inflight.get(key)
    if task is None or fresh:
        task = asyncio.ensure_future(_extract_guarded(url, key, first_route))
        task.add_done_callback(_swallow_result)
        _inflight[key] = task
        task.add_done_callback(lambda done, k=key: _inflight.pop(k, None) if _inflight.get(k) is done else None)

    # shield: if this client disconnects, other requests waiting on the same extraction keep going
    resolved, info = await asyncio.shield(task)
    return resolved, info, False


@app.get("/extract")
async def extract(
    url: str = Query(
        ...,
        description="Public video URL (Instagram, YouTube, Facebook, Threads, X, "
        "Pinterest, TikTok, Reddit or Snapchat)",
    ),
    x_scraper_key: str | None = Header(default=None),
) -> dict:
    _check_key(x_scraper_key)

    try:
        _resolved, info, cached = await _acquire_info(url)
    except ScraperError as err:
        raise _http_error(err)

    items = _describe_items(info)
    if not items:
        raise _http_error(_no_video_error(info))

    first = items[0]
    return {
        **first,
        "success": True,
        # A carousel's id/author/title belong to the post, not to its first slide.
        "id": info.get("id") or first["id"],
        "title": first["title"] or info.get("title"),
        "author": first["author"] or info.get("uploader") or info.get("channel"),
        "formats": [],  # a single best progressive stream is returned in videoUrl
        # Only present for posts with several videos (Instagram carousels, multi-video tweets).
        "items": items if len(items) > 1 else [],
        "cached": cached,
    }


class StreamTooLarge(RuntimeError):
    """Raised mid-stream when a download with no declared length grows past MAX_STREAM_BYTES."""


class OpenStream:
    """An opened upstream response plus everything needed to close it."""

    def __init__(
        self,
        response,
        length: int | None,
        closers: list,
        ext: str | None = None,
        status: int = 200,
        content_range: str | None = None,
        accept_ranges: bool = False,
    ):
        self.response = response
        self.length = length
        self._closers = closers
        self._closed = False
        self.ext = ext
        self.status = status
        self.content_range = content_range
        self.accept_ranges = accept_ranges

    def add_closer(self, closer) -> None:
        self._closers.append(closer)

    def chunks(self) -> Iterator[bytes]:
        sent = 0
        try:
            while True:
                chunk = self.response.read(CHUNK_SIZE)
                if not chunk:
                    break
                sent += len(chunk)
                if sent > MAX_STREAM_BYTES:
                    # Ending the response normally would hand the visitor a silently cut-off video.
                    # Raising aborts the connection, so the browser reports the download as failed.
                    raise StreamTooLarge(f"stream exceeded {MAX_STREAM_BYTES} bytes")
                yield chunk
        finally:
            self.close()

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        for closer in self._closers:
            try:
                closer()
            except Exception:  # noqa: BLE001
                pass

    def __del__(self):  # a stream abandoned before it was iterated must still free its slot
        self.close()


def _open_stream_from_info(resolved: str, info: dict, kind: str, item: int) -> OpenStream:
    """Open the best video (or audio-only) stream of an already-resolved post. Blocking."""
    entries = _entries(info)
    entry = entries[item] if 0 <= item < len(entries) else entries[0]
    if kind == "audio":
        fmt = _pick_audio(entry)
        if not fmt:
            raise ScraperError(errors.UNSUPPORTED_POST, "This video has no separate audio stream.")
    else:
        fmt, _audio = _pick_format(entry)
        if not fmt:
            raise _no_video_error(info)

    media_url = fmt["url"]
    # Defence in depth: whatever an extractor returned, only stream from a platform's own CDN over https.
    if not is_allowed_media_url(media_url):
        raise ScraperError(errors.UNSUPPORTED_POST, "That video is hosted somewhere we don't download from.")
    ext = fmt.get("ext")
    try:
        if is_threads_host(urlparse(resolved).hostname or ""):
            request = urllib.request.Request(
                media_url, headers={"User-Agent": CRAWLER_UA, "Referer": "https://www.threads.net/"}
            )
            response = urllib.request.urlopen(request, timeout=15)
            length = response.headers.get("Content-Length")
            return OpenStream(response, int(length) if length else None, [response.close], ext)

        ydl = yt_dlp.YoutubeDL(_ydl_options())
        headers = dict(fmt.get("http_headers") or {})
        response = ydl.urlopen(yt_dlp.networking.Request(media_url, headers=headers))
        length = response.headers.get("Content-Length")
        return OpenStream(response, int(length) if length else None, [response.close, ydl.close], ext)
    except ScraperError:
        raise
    except urllib.error.HTTPError as exc:
        raise ScraperError(
            errors.STREAM_EXPIRED_OR_BLOCKED if exc.code in (401, 403, 404, 410, 429) else errors.PLATFORM_TIMEOUT
        )
    except Exception as exc:  # noqa: BLE001
        raise _failure_from_exception(exc)


async def _open_stream(page_url: str, kind: str = "video", item: int = 0) -> OpenStream:
    """
    Re-resolve the post from THIS server's IP and open the best video (or
    audio-only) stream. `item` selects a slide of a multi-video post.

    Links resolved elsewhere (e.g. on Vercel) are often bound to the IP that
    requested them (YouTube) or need the extractor's own headers/cookies
    (TikTok, Facebook). Fetching here with yt-dlp's session avoids both.

    Metadata comes from the cache when possible. If a cached link turns out
    to be dead, it is refreshed once and the stream is opened again.
    Raises ScraperError.
    """
    for attempt in (0, 1):
        # The refresh attempt also switches YouTube to its other route: the first one just failed.
        resolved, info, cached = await _acquire_info(page_url, fresh=attempt == 1, first_route=attempt)
        try:
            return await asyncio.to_thread(_open_stream_from_info, resolved, info, kind, item)
        except ScraperError as err:
            if attempt == 0 and cached and err.code in (errors.STREAM_EXPIRED_OR_BLOCKED, errors.PLATFORM_TIMEOUT):
                continue
            raise
    raise ScraperError(errors.STREAM_EXPIRED_OR_BLOCKED)  # unreachable; keeps type checkers happy


def _attachment_response(
    stream: OpenStream, video_id: str, kind: str = "video", ext: str | None = None
) -> StreamingResponse:
    safe_id = "".join(c for c in video_id if c.isalnum() or c in "-_")[:40] or "video"
    if kind == "audio":
        ext = ext if ext in AUDIO_TYPES else "m4a"
        media_type = AUDIO_TYPES[ext]
    else:
        ext, media_type = "mp4", "video/mp4"
    headers = {
        "Content-Disposition": f'attachment; filename="savereelsfast-{safe_id}.{ext}"',
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
    }
    if stream.length and stream.length <= MAX_STREAM_BYTES:
        headers["Content-Length"] = str(stream.length)
    if stream.accept_ranges or stream.status == 206:
        headers["Accept-Ranges"] = "bytes"
    if stream.content_range:
        headers["Content-Range"] = stream.content_range
    return StreamingResponse(
        stream.chunks(),
        status_code=stream.status,
        media_type=media_type,
        headers=headers,
        background=BackgroundTask(stream.close),  # frees the slot even if iteration never started
    )


@app.get("/download")
async def download(
    url: str = Query(..., description="The post URL (not a CDN URL); it is re-resolved here"),
    id: str = Query("video", max_length=60),
    kind: str = Query("video", pattern="^(video|audio)$"),
    item: int = Query(0, ge=0, le=MAX_ITEMS),
    x_scraper_key: str | None = Header(default=None),
) -> StreamingResponse:
    """Re-resolve the post from this server's IP and stream the best video (or its audio-only track)."""
    _check_key(x_scraper_key)
    try:
        _shed_load_if_low_on_memory()
    except ScraperError as err:
        raise _http_error(err)

    lease = STREAM_SLOTS.acquire()
    if lease is None:
        raise _http_error(ScraperError(errors.SERVER_BUSY))
    try:
        stream = await _open_stream(url, kind, item)
    except ScraperError as err:
        lease.release()
        raise _http_error(err)
    except BaseException:
        lease.release()
        raise
    stream.add_closer(lease.release)

    # Audio downloads are named after the container of the stream actually served.
    return _attachment_response(stream, id, kind, stream.ext)


class _HttpxReader:
    """Adapts an httpx streaming response to the .read(n) interface OpenStream expects."""

    def __init__(self, response: httpx.Response):
        self._chunks = response.iter_raw(CHUNK_SIZE)

    def read(self, _amount: int = -1) -> bytes:
        return next(self._chunks, b"")


def _open_cdn_stream(
    media_url: str, referer: str | None, kind: str = "video", range_header: str | None = None
) -> OpenStream:
    """
    Open a CDN video URL from THIS server's IP.

    YouTube (and some TikTok / Facebook) links are bound to the IP that
    resolved them. /extract resolves them here, so they must be downloaded
    from here as well. Only known platform CDNs are allowed, redirects are
    followed by hand and must stay on those CDNs.
    """
    if not is_allowed_media_url(media_url):
        raise ScraperError(errors.INVALID_URL, "That media URL isn't supported.")

    headers = {
        "User-Agent": BROWSER_UA,
        "Referer": safe_referer(referer, media_url),
        "Accept": "audio/*,*/*;q=0.5" if kind == "audio" else "video/mp4,video/*;q=0.9,*/*;q=0.5",
        "Accept-Language": "en-US,en;q=0.9",
    }
    # Forward a single byte range so interrupted downloads can resume and players can seek.
    if range_header and re.fullmatch(r"bytes=\d*-\d*", range_header.strip()):
        headers["Range"] = range_header.strip()
    client = httpx.Client(timeout=httpx.Timeout(5.0, read=20.0), follow_redirects=False, proxy=YTDLP_PROXY)
    try:
        current = media_url
        response = None
        for _ in range(4):
            response = client.send(client.build_request("GET", current, headers=headers), stream=True)
            if not response.is_redirect:
                break
            target = urljoin(current, response.headers.get("location", ""))
            response.close()
            if not is_allowed_media_url(target):
                raise ScraperError(errors.STREAM_EXPIRED_OR_BLOCKED)
            current = target
        else:
            raise ScraperError(errors.PLATFORM_TIMEOUT)

        if response.status_code >= 400:
            status = response.status_code
            response.close()
            raise ScraperError(
                errors.STREAM_EXPIRED_OR_BLOCKED
                if status in (401, 403, 404, 410, 429)
                else errors.PLATFORM_TIMEOUT
            )

        content_type = response.headers.get("content-type", "")
        allowed = ("audio/", "video/mp4", "video/webm", "application/octet-stream") if kind == "audio" else ("video/", "application/octet-stream")
        if not content_type.startswith(allowed):
            response.close()
            raise ScraperError(
                errors.UNSUPPORTED_POST,
                "The requested file is not an audio track." if kind == "audio" else "The requested file is not a video.",
            )

        raw_length = response.headers.get("content-length", "")
        length = int(raw_length) if raw_length.isdigit() else None
        if length and length > MAX_STREAM_BYTES:
            response.close()
            raise ScraperError(errors.EXTRACTION_FAILED, "This video is too large to download.")

        return OpenStream(
            _HttpxReader(response),
            length,
            [response.close, client.close],
            status=206 if response.status_code == 206 else 200,
            content_range=response.headers.get("content-range") if response.status_code == 206 else None,
            accept_ranges=response.headers.get("accept-ranges", "").lower() == "bytes",
        )
    except ScraperError:
        client.close()
        raise
    except httpx.HTTPError:
        client.close()
        raise ScraperError(errors.PLATFORM_TIMEOUT)


@app.get("/stream")
async def stream(
    url: str = Query(..., description="Video URL on a platform CDN, as returned by /extract"),
    referer: str | None = Query(None, description="Page the video came from (optional)"),
    id: str = Query("video", max_length=60),
    kind: str = Query("video", pattern="^(video|audio)$"),
    ext: str = Query("m4a", pattern="^[a-z0-9]{2,4}$"),
    x_scraper_key: str | None = Header(default=None),
    range_header: str | None = Header(default=None, alias="range"),
) -> StreamingResponse:
    """Stream a CDN URL through this server so the CDN sees the scraper's IP."""
    _check_key(x_scraper_key)
    try:
        _shed_load_if_low_on_memory()
    except ScraperError as err:
        raise _http_error(err)

    lease = STREAM_SLOTS.acquire()
    if lease is None:
        raise _http_error(ScraperError(errors.SERVER_BUSY))
    try:
        opened = await asyncio.to_thread(_open_cdn_stream, url, referer, kind, range_header)
    except ScraperError as err:
        lease.release()
        raise _http_error(err)
    except BaseException:
        lease.release()
        raise
    opened.add_closer(lease.release)

    return _attachment_response(opened, id, kind, ext)
