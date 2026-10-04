import asyncio
import contextlib
import contextvars
import gc
import hmac
import logging
import os
import re
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import weakref
import urllib.error
import urllib.request
from typing import Iterator
from urllib.parse import quote, urljoin, urlparse

import httpx
import yt_dlp
from fastapi import FastAPI, Header, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response, StreamingResponse
from starlette.background import BackgroundTask
from yt_dlp.utils import DownloadError, ExtractorError

import errors
from cobalt import Cobalt, CobaltUnavailable, parse_instances
from cache import CircuitBreaker, SlotPool, TTLCache, best_image, slim_info
from errors import ScraperError, classify_failure
from extractors import CRAWLER_UA, extract_threads
from diagnose import cookie_summary, interpret, probe_network, probe_proxy, proxy_host, redact_secrets
from memory import rss_mb
from telegram_bot import MAX_UPLOAD_BYTES, TEMP_PREFIX, BotUserError, Media, TelegramBot, delete_quietly, valid_token
from urls import (
    BROWSER_UA,
    expand_redirects,
    UnsupportedUrl,
    cache_key,
    is_allowed_media_url,
    is_instagram_host,
    is_threads_host,
    is_youtube_host,
    is_youtube_media_host,
    resolve_url,
    referer_for,
    safe_referer,
    youtube_video_id,
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


@app.exception_handler(Exception)
async def _structured_error(request, exc: Exception) -> JSONResponse:
    """
    Any error nobody planned for still answers with the same JSON shape as every other failure
    ({"detail": {"code", "message"}}), never an HTML page or a hung request. The message is fixed: nothing from
    the exception (paths, tokens, yt-dlp internals) reaches the caller.
    """
    _log.warning("Unhandled error on %s: %s", request.url.path, type(exc).__name__)
    return JSONResponse(
        status_code=500,
        content={"detail": {"code": errors.EXTRACTION_FAILED, "message": "Something went wrong on our side. Please try again."}},
    )


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

# YouTube is tried on up to two routes. Measured against yt-dlp 2026.08 on real videos (no cookies):
#   LEAN  android only, skipping the page, player configs, the "next" call and the player script:
#         0.8 s for a 360p MP4 with sound.
#   FULL  android + ios + web_creator: the very same download in 2.8-3.5 s. ios and web_creator need a
#         proof-of-origin token or a login to offer more, so without cookies they only cost time.
# With a cookies file, yt-dlp SKIPS the android client ("does not support cookies"), so LEAN alone would fail at
# once. The order therefore depends on whether cookies are configured: see _youtube_route_plan().
YOUTUBE_LEAN = {"player_client": ["android"], "player_skip": ["webpage", "configs", "initial_data", "js"]}
YOUTUBE_FULL = {"player_client": ["android", "ios", "web_creator"]}
YOUTUBE_ROUTES: list[dict] = [YOUTUBE_LEAN, YOUTUBE_FULL]  # the order without cookies
YDL_OPTS["extractor_args"] = {"youtube": YOUTUBE_LEAN}

# YouTube's requests get a longer leash than other platforms': 8 s per request and one retry, because a small
# host (Render's free tier has a fraction of a CPU) can be slow to complete a TLS handshake without being blocked.
YOUTUBE_SOCKET_TIMEOUT = 8
YOUTUBE_RETRIES = 1
# Through a rotating proxy every new connection leaves from a different address, and some are slow or dead. A
# shorter wait per attempt plus more attempts abandons a bad one quickly and tries another within the same budget.
# Some YouTube sessions are served a page with no downloadable formats (their "SABR-only" experiment) while the very
# next session is fine. When a pass over the routes finds nothing to download, ask again (a fresh session, and through
# a rotating proxy a fresh address) while the budget lasts, instead of giving up on the first unlucky answer.
YOUTUBE_LOOKUP_PASSES = 2
YOUTUBE_PROXY_SOCKET_TIMEOUT = 5
YOUTUBE_PROXY_RETRIES = 2

# Hard ceiling for one whole lookup (link expansion + extraction). It is enforced inside the work, not just
# around it, so a stalled lookup stops instead of quietly holding a worker.
def _extraction_timeout(raw: str | None, default: float = 5.0, low: float = 2.0, high: float = 6.0) -> float:
    """The configured limit, forced into a fixed band so no setting can bring the long hangs back."""
    try:
        value = float(raw) if raw else default
    except ValueError:
        value = default
    return min(max(value, low), high)


EXTRACTION_TIMEOUT_SECONDS = _extraction_timeout(os.environ.get("EXTRACTION_TIMEOUT_SECONDS"))
# YouTube needs room for a slow first connection (a residential proxy takes several seconds to reach it) and a
# second route, so its ceiling is higher (band 6-25 s).
#
# Raised from 20.0: live traffic showed real (successful) proxy connections regularly taking 15-21 s, some
# close enough to the old default that the site's own outer budget (see YOUTUBE_LOOKUP_BUDGET_MS in
# app/api/extract/route.ts) - not even this one - was cutting them off first as "YouTube isn't responding",
# despite the lookup being seconds from finishing. 22 s keeps every hop of the chain still outlasting the one
# behind it (see tests/time-budget.test.ts) without moving the page's own ceiling past 25 s.
YOUTUBE_EXTRACTION_TIMEOUT_SECONDS = _extraction_timeout(
    os.environ.get("YOUTUBE_EXTRACTION_TIMEOUT_SECONDS"), default=22.0, low=6.0, high=25.0
)


# Instagram gets room for two attempts: a short direct one, then one through the residential proxy (see
# _instagram_lookup). From Render's IP, Instagram often doesn't refuse a lookup, it just never answers, so the
# whole budget went on one stalled request. A proxied lookup measured 6.5-8.5 s, with a tail past 9 s, hence
# 11 s. Plus the grace below it still ends before the website stops waiting for the scraper
# (INSTAGRAM_SCRAPER_TIMEOUT_MS, 12.5 s, in app/api/extract/route.ts).
INSTAGRAM_EXTRACTION_TIMEOUT_SECONDS = _extraction_timeout(
    os.environ.get("INSTAGRAM_EXTRACTION_TIMEOUT_SECONDS"), default=11.0, low=4.0, high=12.0
)


def _extraction_budget(url: str) -> float:
    """Seconds one lookup of this link may take in total."""
    host = urlparse(url.strip()).hostname or ""
    if is_youtube_host(host):
        return YOUTUBE_EXTRACTION_TIMEOUT_SECONDS
    return INSTAGRAM_EXTRACTION_TIMEOUT_SECONDS if is_instagram_host(host) else EXTRACTION_TIMEOUT_SECONDS
DEADLINE_GRACE_SECONDS = 0.75  # how long the caller waits past the deadline for the work to notice it

# After a few YouTube blocks or stalls in a row, answer instantly for a moment instead of trying again.
YOUTUBE_BREAKER = CircuitBreaker(threshold=3, window=30.0, cooldown=15.0)
_BREAKER_FAILURES = {errors.STREAM_EXPIRED_OR_BLOCKED, errors.PLATFORM_TIMEOUT}
_youtube_last_failure = [errors.STREAM_EXPIRED_OR_BLOCKED]  # what to answer while the breaker is open

_deadline: "contextvars.ContextVar[float | None]" = contextvars.ContextVar("extraction_deadline", default=None)
# Set by the caller when it stops waiting for a lookup, so the worker does not count the same failure twice.
_gave_up: "contextvars.ContextVar[threading.Event | None]" = contextvars.ContextVar("lookup_gave_up", default=None)
# Only the diagnostic (/diagnose/youtube) turns these on: a list that collects one entry per request, and a
# switch that lets its lookup ignore (and not feed) the circuit breaker.
_trace: "contextvars.ContextVar[list | None]" = contextvars.ContextVar("lookup_trace", default=None)
_bypass_breaker: "contextvars.ContextVar[bool]" = contextvars.ContextVar("bypass_breaker", default=False)


class _DeadlineYDL(yt_dlp.YoutubeDL):
    """yt-dlp that refuses to start another request once the deadline has passed."""

    def __init__(self, params: dict, deadline: float, trace: list | None = None):
        super().__init__(params)
        self._deadline = deadline
        self._trace = trace

    def _note(self, req, started: float, result) -> None:
        if self._trace is not None and len(self._trace) < 60:
            parsed = urlparse(req.url)  # host and path only: no query string, so no ids, tokens or signatures
            self._trace.append({"request": f"{parsed.netloc}{parsed.path}", "ms": round((time.monotonic() - started) * 1000), "result": result})

    def urlopen(self, req):
        remaining = self._deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("extraction deadline reached")
        # Not just "no new request after the deadline": a request that starts now may not run past it either.
        # Without this, 8 s of socket timeout plus a retry keeps a worker busy for 16 s after the visitor was answered.
        if not isinstance(req, yt_dlp.networking.Request):
            req = yt_dlp.networking.Request(req)
        limit = req.extensions.get("timeout") or self.params.get("socket_timeout") or 20
        req.extensions["timeout"] = min(float(limit), remaining + 0.5)
        started = time.monotonic()
        try:
            response = super().urlopen(req)
        except BaseException as exc:
            self._note(req, started, type(exc).__name__)
            raise
        self._note(req, started, getattr(response, "status", "ok"))
        return response


def _time_left(default: float) -> float:
    deadline = _deadline.get()
    return default if deadline is None else max(0.5, min(default, deadline - time.monotonic()))

# Optional, set on the host (not here): what actually cures YouTube blocking a datacenter IP.
#   YTDLP_PROXY   e.g. http://user:pass@residential-proxy:port  (used for lookups AND downloads)
#   cookies       a Netscape cookies.txt of a throw-away YouTube account, picked up automatically from
#                 /etc/secrets/youtube_cookies.txt (Render "Secret Files"), or from YOUTUBE_COOKIES_FILE
_HOST = r"[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?"


def _parse_proxy(raw: str | None) -> tuple[str | None, str]:
    """
    (proxy URL, status) for the YTDLP_PROXY setting. Status: "unset", "ok", "converted" or "rejected".

    Accepts a proper URL (http://user:pass@host:port, also https/socks). Also accepts the forms proxy providers
    actually show on their dashboards and converts them, because pasting one of those is the commonest mistake:
        host:port:user:pass     (Webshare's list format)      ->  http://user:pass@host:port
        user:pass@host:port                                    ->  http://user:pass@host:port
        host:port                                              ->  http://host:port
    User names and passwords are percent-encoded, so characters like @ : / in a password cannot break the URL.
    """
    value = (raw or "").strip()
    if not value:
        return None, "unset"
    if "://" in value:
        try:
            parsed = urlparse(value)
            valid = parsed.scheme in ("http", "https", "socks4", "socks5", "socks5h") and bool(parsed.hostname)
            parsed.port  # noqa: B018 - raises ValueError for a non-numeric port
        except ValueError:
            valid = False
        return (value, "ok") if valid else (None, "rejected")
    four = re.fullmatch(rf"({_HOST}):(\d{{1,5}}):([^:\s]+):(\S+)", value)  # the password may itself contain ":"
    if four and 0 < int(four.group(2)) < 65536:
        host, port, user, password = four.groups()
        return f"http://{quote(user, safe='')}:{quote(password, safe='')}@{host}:{port}", "converted"
    at = re.fullmatch(rf"([^:@\s]+):([^@\s]+)@({_HOST}):(\d{{1,5}})", value)
    if at and 0 < int(at.group(4)) < 65536:
        user, password, host, port = at.groups()
        return f"http://{quote(user, safe='%')}:{quote(password, safe='%')}@{host}:{port}", "converted"
    two = re.fullmatch(rf"({_HOST}):(\d{{1,5}})", value)
    if two and 0 < int(two.group(2)) < 65536:
        return f"http://{value}", "converted"
    return None, "rejected"


def _clean_proxy(raw: str | None) -> str | None:
    """The proxy URL to use, or None when unset or unusable (a bad value must not break every lookup)."""
    url, status = _parse_proxy(raw)
    if status == "rejected":
        _log.warning(
            "YTDLP_PROXY is set but is not usable: expected http://user:pass@host:port "
            "(host:port:user:pass is accepted too). The proxy is OFF and YouTube is fetched directly."
        )
    elif status == "converted":
        _log.info("YTDLP_PROXY was given as host:port[:user:pass]; using it as an http:// proxy URL.")
    return url


# The proxy is used for YouTube ONLY (its lookups, and the download of YouTube's own video files, which are tied
# to the IP that asked for them). Every other platform goes direct, so the proxy's metered bandwidth is not spent
# on them.
YTDLP_PROXY = _clean_proxy(os.environ.get("YTDLP_PROXY"))
PROXY_SETTING_STATUS = _parse_proxy(os.environ.get("YTDLP_PROXY"))[1]  # "unset" | "ok" | "converted" | "rejected"
YOUTUBE_COOKIES_DEFAULT_PATH = "/etc/secrets/youtube_cookies.txt"


def _youtube_cookie_source() -> str | None:
    """The cookies file to use, if there is one. Checked on every lookup, so adding the file needs no code change."""
    for candidate in (os.environ.get("YOUTUBE_COOKIES_FILE", "").strip(), YOUTUBE_COOKIES_DEFAULT_PATH):
        if candidate and os.path.isfile(candidate):
            return candidate
    return None


@contextlib.contextmanager
def _private_cookie_copy(source: str | None):
    """
    A private, writable copy of the cookies file for one lookup (yields None when there is none).

    yt-dlp writes its cookie jar back to the file when it finishes, and Render mounts /etc/secrets read-only:
    pointing yt-dlp at that path directly fails every lookup with PermissionError (checked). A copy per
    lookup also keeps two simultaneous lookups from overwriting each other's file.
    """
    if not source:
        yield None
        return
    handle, path = tempfile.mkstemp(prefix="srf-ytc-", suffix=".txt")
    os.close(handle)
    try:
        shutil.copyfile(source, path)
        os.chmod(path, 0o600)
    except OSError as exc:
        _log.warning("YouTube cookies could not be copied (%s): continuing without them.", type(exc).__name__)
        delete_quietly(path)
        yield None
        return
    try:
        yield path
    finally:
        delete_quietly(path)


def _youtube_route_plan() -> list[tuple[dict, bool]]:
    """(extractor_args, send_cookies) for each YouTube attempt, in order."""
    if _youtube_cookie_source():
        # android cannot use cookies, so with a session the full client list goes first and the anonymous
        # lean route is the fallback (for when the cookies have gone stale).
        plan = [(YOUTUBE_FULL, True), (YOUTUBE_LEAN, False)]
    else:
        plan = [(YOUTUBE_LEAN, False), (YOUTUBE_FULL, False)]
    if os.environ.get("YOUTUBE_SECOND_ROUTE", "1").strip().lower() in ("0", "false", "no"):
        plan = plan[:1]
    return plan


def _ydl_options(youtube_route: int = 0, cookiefile: str | None = None, use_proxy: bool = False) -> dict:
    """yt-dlp options for one lookup or download. The proxy is only added when `use_proxy` (YouTube) says so."""
    options = dict(YDL_OPTS)
    plan = _youtube_route_plan()
    args, _send_cookies = plan[min(youtube_route, len(plan) - 1)]
    options["extractor_args"] = {"youtube": args}
    if use_proxy and YTDLP_PROXY:
        options["proxy"] = YTDLP_PROXY
    if cookiefile:
        options["cookiefile"] = cookiefile
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
# Picture files an Instagram photo (or a photo slide of a carousel) is saved as, again untouched.
IMAGE_TYPES = {
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "webp": "image/webp",
    "png": "image/png",
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
# A YouTube lookup goes through the paid proxy, so its result is kept longer: a repeat costs no proxy bandwidth.
# Never longer than the link itself stays valid (see _youtube_cache_ttl). The privacy policy states this limit.
YOUTUBE_CACHE_TTL_SECONDS = _env_number("YOUTUBE_CACHE_TTL_SECONDS", 10800)  # 3 hours

# Optional YouTube fallback through a Cobalt instance (see cobalt.py). Off unless COBALT_API_URL is set.
COBALT = Cobalt(
    parse_instances(os.environ.get("COBALT_API_URL")),
    os.environ.get("COBALT_API_KEY"),
    timeout=min(max(_env_number("COBALT_TIMEOUT_SECONDS", 4.0), 1.0), 8.0),
)
COBALT_LINK_TTL_SECONDS = 60.0  # a Cobalt download link is short-lived; never cache it like a yt-dlp lookup
# Failures worth a second opinion: a block, a stall, or "sign in to confirm you're not a bot" (a datacenter block).
_COBALT_ON = {errors.PLATFORM_TIMEOUT, errors.STREAM_EXPIRED_OR_BLOCKED, errors.LOGIN_REQUIRED}


def _media_url_allowed(raw: str) -> bool:
    """A platform CDN, or a download link on a configured Cobalt instance."""
    return is_allowed_media_url(raw) or COBALT.is_media_url(raw)
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
      (ties on size go to the higher bitrate: LinkedIn reports no height, only tbr)
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
            best = max(group, key=lambda f: (f.get("height") or 0, f.get("width") or 0, f.get("tbr") or 0))
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


def _pick_image(info: dict) -> dict | None:
    """
    The full-size picture of a photo (or a photo slide), or None: {"url", "ext", "width", "height"}.

    yt-dlp reports an Instagram photo's sizes as `thumbnails` and no formats at all. Only a picture on a
    platform CDN over https qualifies, the same rule as every video.
    """
    image = best_image(info.get("thumbnails"))
    if not image or not _media_url_allowed(image["url"]):
        return None
    suffix = urlparse(image["url"]).path.rsplit(".", 1)[-1].lower()
    return {
        "url": image["url"],
        "ext": "jpg" if suffix == "jpeg" else suffix if suffix in IMAGE_TYPES else "jpg",
        "width": image.get("width"),
        "height": image.get("height"),
    }


def _describe_image(info: dict) -> dict | None:
    """A photo item, shaped like a video item (the video/audio fields empty) plus kind="image"."""
    image = _pick_image(info)
    if not image:
        return None
    width, height = image["width"], image["height"]
    return {
        "id": info.get("id"),
        "kind": "image",
        "title": info.get("title") or info.get("description"),
        "author": info.get("uploader") or info.get("channel"),
        "thumbnail": image["url"],
        "duration": None,
        "videoUrl": None,
        "imageUrl": image["url"],
        "imageExt": image["ext"],
        "quality": f"{width}x{height}" if width and height else None,
        "audio": "no",
        "hasAudio": False,
        "warning": None,
        "audioUrl": None,
        "audioExt": None,
        "audioBitrate": None,
    }


# yt-dlp names an Instagram post with no title "Video by <user>" / "Post by <user>": a placeholder, not a caption.
_PLACEHOLDER_TITLE = re.compile(r"^(Video|Post) by [\w.]+$")
CAPTION_MAX_CHARS = 2200  # Instagram's own caption limit; nothing longer is a real caption


def _caption(info: dict) -> str | None:
    """The post's full caption (hashtags included), for the site's copy buttons. None when there is none."""
    for text in (info.get("description"), info.get("title")):
        if isinstance(text, str) and text.strip() and not _PLACEHOLDER_TITLE.match(text.strip()):
            return text.strip()[:CAPTION_MAX_CHARS]
    return None


def _describe(info: dict, images: bool = False) -> dict | None:
    """
    One downloadable item from a single-media info dict: a video (plus optional separate audio), or, when
    `images` is on (Instagram, and only for callers that asked for photos), a photo.
    """
    fmt, audio = _pick_format(info)
    if not fmt:
        return _describe_image(info) if images else None
    audio_fmt = _pick_audio(info)
    height = fmt.get("height")
    return {
        "id": info.get("id"),
        "kind": "video",
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


def _describe_items(info: dict, images: bool = False) -> list[dict]:
    items = [d for d in (_describe(entry, images) for entry in _entries(info)) if d]
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
        "telegram": {"enabled": True, **_telegram_bot.stats} if _telegram_bot else {"enabled": False},
        "youtube": {
            "cookies": cookie_summary(_youtube_cookie_source()),
            "routes": [{"clients": args["player_client"], "sendsCookies": cookies} for args, cookies in _youtube_route_plan()],
            "breakerOpen": YOUTUBE_BREAKER.is_open(),
            "cacheHours": round(YOUTUBE_CACHE_TTL_SECONDS / 3600, 1),
        },
        "proxy": _proxy_stats(),
        "cobalt": COBALT.stats(),
    }


def _extract_info(
    url: str, youtube_route: int = 0, use_proxy: bool = False, socket_timeout: float | None = None
) -> dict | None:
    """
    Threads has no yt-dlp extractor, so it uses our own; everything else uses yt-dlp.

    YouTube always goes through YTDLP_PROXY when one is set; any other lookup only when `use_proxy` asks
    (Instagram's one retry after a rate limit, see _instagram_lookup).
    """
    if is_threads_host(urlparse(url).hostname or ""):
        return extract_threads(url, timeout=_time_left(12.0))
    collector = _MessageCollector()
    youtube = is_youtube_host(urlparse(url).hostname or "")
    plan = _youtube_route_plan() if youtube else []
    wants_cookies = youtube and plan[min(youtube_route, len(plan) - 1)][1]
    deadline = _deadline.get()
    trace = _trace.get()
    ydl_class = (lambda params: _DeadlineYDL(params, deadline, trace)) if deadline is not None else yt_dlp.YoutubeDL
    with _private_cookie_copy(_youtube_cookie_source() if wants_cookies else None) as cookiefile:
        options = {**_ydl_options(youtube_route, cookiefile, use_proxy=youtube or use_proxy), "logger": collector}
        if youtube:
            if YTDLP_PROXY:
                _proxy_note_lookup()
            socket_timeout, retries = (
                (YOUTUBE_PROXY_SOCKET_TIMEOUT, YOUTUBE_PROXY_RETRIES) if YTDLP_PROXY else (YOUTUBE_SOCKET_TIMEOUT, YOUTUBE_RETRIES)
            )
            options.update(socket_timeout=socket_timeout, retries=retries, extractor_retries=retries)
        elif socket_timeout is not None:
            options["socket_timeout"] = socket_timeout
        if trace is not None:
            trace.append({"route": youtube_route, "clients": (options.get("extractor_args") or {}).get("youtube", {}).get("player_client"), "cookies": bool(cookiefile)})
        try:
            with ydl_class(options) as ydl:
                info = ydl.extract_info(url, download=False)
        finally:
            if trace is not None:
                # yt-dlp's own warnings (cookies rotated, PO token needed, client skipped ...): text only, no values
                trace.append({"messages": [redact_secrets(m, YTDLP_PROXY)[:160] for m in collector.messages[:8]]})
    if info is not None:
        info["_messages"] = collector.messages
    return info


def _no_video_error(info: dict) -> ScraperError:
    """Why an otherwise successful lookup produced no downloadable video."""
    # yt-dlp always appends generic lines like "No video formats found!"; only
    # the message that explains *why* is useful for classification.
    boilerplate = re.compile(r"no video formats found|requested format is not available", re.I)
    text = redact_secrets(" ".join(m for m in (info.get("_messages") or []) if not boilerplate.search(m)).strip(), YTDLP_PROXY)
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
    text = redact_secrets(str(exc).replace("ERROR: ", "").strip(), YTDLP_PROXY)
    code = classify_failure(text)
    if code == errors.EXTRACTION_FAILED and isinstance(exc, (DownloadError, ExtractorError)):
        return ScraperError(code, f"{errors.MESSAGES[code]} ({text[:160]})")
    return ScraperError(code)


# Only blocks are route-specific. A timeout says nothing about the route (retrying would double the load
# on a struggling host), and a private or age-restricted video is private on every route.
_RETRY_ON_OTHER_ROUTE = {errors.STREAM_EXPIRED_OR_BLOCKED}


def _has_download(info: dict) -> bool:
    return bool(_describe_items(slim_info(info)))


# Instagram answers a burst of lookups from one IP with a short rate limit ("Please wait a few minutes",
# "rate-limit reached"). One quiet retry after a pause gets most of them through; when a residential proxy is
# configured (YTDLP_PROXY, the one YouTube uses), that retry goes through it, from a different IP. Only the
# retry: a lookup moves ~1.4 MB (Instagram's page plus two API answers), so sending every Instagram lookup
# through a paid proxy would cost far more than the occasional blocked one. Media files never use it: an
# Instagram CDN link isn't tied to the IP that resolved it, so the download still goes straight to the CDN.
INSTAGRAM_RETRY_PAUSE_SECONDS = _env_number("INSTAGRAM_RETRY_PAUSE_SECONDS", 2.0)
# The direct attempt gives up on a silent connection after this long instead of the usual 4 s: a stall from
# Instagram means the IP is being throttled, and the proxied retry needs the rest of the budget.
INSTAGRAM_DIRECT_SOCKET_TIMEOUT = _env_number("INSTAGRAM_DIRECT_SOCKET_TIMEOUT", 2.5)
# After Instagram blocks or stalls a direct lookup, the next ones skip the direct attempt and go straight
# through the proxy for this long, instead of each visitor first waiting out a request that won't be answered.
INSTAGRAM_DIRECT_COOLDOWN_SECONDS = _env_number("INSTAGRAM_DIRECT_COOLDOWN_SECONDS", 600.0)
_instagram_direct_blocked_until = [0.0]  # monotonic time
INSTAGRAM_RETRY_MIN_SECONDS = 2.5  # the retry only starts if at least this much of the lookup budget is left after the pause
# Proxied Instagram retries per UTC day (0 = never use the proxy for Instagram). 100 x ~1.4 MB ~= 140 MB a day at most.
INSTAGRAM_PROXY_DAILY_LOOKUPS = int(_env_number("INSTAGRAM_PROXY_DAILY_LOOKUPS", 100))
_instagram_usage = {"day": "", "proxiedToday": 0, "proxied": 0, "retries": 0, "recovered": 0, "skippedNoTime": 0,
                    "directSkipped": 0, "stalls": 0}
_INSTAGRAM_RETRY_ON = {errors.STREAM_EXPIRED_OR_BLOCKED, errors.PLATFORM_TIMEOUT}


def _instagram_blocked(info: dict) -> bool:
    """A lookup that came back with nothing to download because Instagram rate-limited or blocked it."""
    if _describe_items(slim_info(info), images=True):
        return False
    return _no_video_error(info).code == errors.STREAM_EXPIRED_OR_BLOCKED


def _instagram_proxy_available() -> bool:
    """Whether a proxied lookup could be made right now (a proxy is set and today's allowance isn't used up)."""
    if not YTDLP_PROXY or INSTAGRAM_PROXY_DAILY_LOOKUPS <= 0:
        return False
    with _proxy_lock:
        used = _instagram_usage["proxiedToday"] if _instagram_usage["day"] == _utc_day() else 0
    return used < INSTAGRAM_PROXY_DAILY_LOOKUPS


def _instagram_proxy_allowed() -> bool:
    """Whether this retry may use the proxy (one is set, and today's allowance isn't used up). Counts it."""
    if not YTDLP_PROXY or INSTAGRAM_PROXY_DAILY_LOOKUPS <= 0:
        return False
    with _proxy_lock:
        today = _utc_day()
        if _instagram_usage["day"] != today:
            _instagram_usage["day"] = today
            _instagram_usage["proxiedToday"] = 0
        if _instagram_usage["proxiedToday"] >= INSTAGRAM_PROXY_DAILY_LOOKUPS:
            return False
        _instagram_usage["proxiedToday"] += 1
        _instagram_usage["proxied"] += 1
    _proxy_note_lookup()
    return True


def _instagram_lookup(url: str) -> dict | None:
    """
    An Instagram lookup that survives Instagram throttling Render's IP, which shows up two ways: a quick
    "rate-limit reached" answer, or (more often lately) no answer at all.

    1. Direct, with a short socket timeout, unless a direct lookup was blocked or stalled in the last
       INSTAGRAM_DIRECT_COOLDOWN_SECONDS and the proxy can be used instead.
    2. On a block or a stall: once more, through the residential proxy when allowed (else direct again).
       After a quick block it first pauses INSTAGRAM_RETRY_PAUSE_SECONDS; after a stall the wait already
       happened, so it goes straight on. The retry only starts if INSTAGRAM_RETRY_MIN_SECONDS are left.
    Anything else (private, deleted, no media) is answered at once. Raises like _extract_info.
    """
    skip_direct = time.monotonic() < _instagram_direct_blocked_until[0] and _instagram_proxy_available()
    if skip_direct:
        with _proxy_lock:
            _instagram_usage["directSkipped"] += 1
    else:
        started = time.monotonic()
        try:
            found = _extract_info(url, socket_timeout=INSTAGRAM_DIRECT_SOCKET_TIMEOUT)
        except ScraperError as err:
            failure = err
        except Exception as exc:  # noqa: BLE001 - classified like every other lookup failure
            failure = _failure_from_exception(exc)
        else:
            if not found or not _instagram_blocked(found):
                return found
            failure = _no_video_error(found)
        if failure.code not in _INSTAGRAM_RETRY_ON:
            raise failure
        _instagram_direct_blocked_until[0] = time.monotonic() + INSTAGRAM_DIRECT_COOLDOWN_SECONDS
        stalled = failure.code == errors.PLATFORM_TIMEOUT
        with _proxy_lock:
            _instagram_usage["stalls"] += int(stalled)
        how = "via proxy" if _instagram_proxy_available() else "direct"
        print(f"[instagram] direct lookup {'stalled' if stalled else 'blocked'} after "
              f"{time.monotonic() - started:.1f}s; retrying {how}", flush=True)

        deadline = _deadline.get()
        left = (deadline - time.monotonic()) if deadline is not None else INSTAGRAM_RETRY_PAUSE_SECONDS + INSTAGRAM_RETRY_MIN_SECONDS
        pause = 0.0 if stalled else min(INSTAGRAM_RETRY_PAUSE_SECONDS, left - INSTAGRAM_RETRY_MIN_SECONDS)
        if pause < 0 or left - pause < INSTAGRAM_RETRY_MIN_SECONDS:
            with _proxy_lock:
                _instagram_usage["skippedNoTime"] += 1
            raise failure
        time.sleep(pause)

    use_proxy = _instagram_proxy_allowed()
    with _proxy_lock:
        _instagram_usage["retries"] += int(not skip_direct)
    how = "proxied" if use_proxy else "direct"
    started = time.monotonic()
    try:
        found = _extract_info(url, use_proxy=use_proxy)
    except Exception:
        print(f"[instagram] {how} lookup failed after {time.monotonic() - started:.1f}s", flush=True)
        raise
    if found and not _instagram_blocked(found):
        with _proxy_lock:
            _instagram_usage["recovered"] += 1
        print(f"[instagram] {how} lookup ok in {time.monotonic() - started:.1f}s", flush=True)
    return found


def _resolve_and_extract(url: str, first_route: int = 0) -> tuple[str, dict]:
    """yt-dlp first; for YouTube, a Cobalt instance as the fallback when yt-dlp is blocked or stalls. Raises ScraperError."""
    try:
        return _resolve_and_extract_ytdlp(url, first_route)
    except ScraperError as err:
        fallback = _cobalt_fallback(url, err)
        if fallback is None:
            raise
        return fallback


def _cobalt_fallback(url: str, failure: ScraperError) -> tuple[str, dict] | None:
    if not COBALT.usable() or failure.code not in _COBALT_ON or _bypass_breaker.get():
        return None  # (the diagnostic wants yt-dlp's own answer)
    video_id = youtube_video_id(url)
    if not video_id:
        return None
    try:
        info = COBALT.fetch(video_id, COBALT.timeout)
    except CobaltUnavailable as exc:
        _log.info("YouTube fallback (Cobalt) had no answer: %s (yt-dlp failed with %s)", exc, failure.code)
        return None
    _log.info("YouTube served by the Cobalt fallback after yt-dlp failed with %s.", failure.code)
    return url, info



# COBALT_TIMEOUT_SECONDS is tuned for _cobalt_fallback above: yt-dlp has already failed there, so waiting
# longer for Cobalt is the only option left and cheap either way. _cobalt_video_url below is different: it
# runs on the *happy path* of every single video download, where yt-dlp already has a proven, working,
# already-resolved link ready to go. Reusing the same generous budget there means a slow Cobalt response (a
# free-tier instance under load, not just a cold start - a plain health check can be fast while the actual
# extraction call is not) adds that same delay to every download instead of only the rare failure case, and
# can push the whole request past Vercel's own timeout. So this path gets its own short, separate budget:
# Cobalt gets a fast, fair shot, but never enough rope to make a download slower than the plain proxy route
# would have been on its own.
COBALT_FIRST_BUDGET_SECONDS = 3.0


def _cobalt_video_url(video_id: str | None) -> str | None:
    """
    A ready-to-fetch YouTube video URL that costs no paid-proxy bandwidth (Cobalt fetches and re-serves it
    from its own infrastructure), or None when Cobalt is off, paused, has nothing for this video, is too
    slow to answer within COBALT_FIRST_BUDGET_SECONDS, or the id is missing/malformed - in every one of
    those cases the caller falls back to the usual paid-proxy route, at essentially no extra cost.

    Video only: Cobalt's "auto" mode always returns one muxed video+audio format, never a separate
    audio-only track, so the audio downloader (which needs that separate track) never calls this.
    """
    if not video_id or not COBALT.usable():
        return None
    try:
        info = COBALT.fetch(video_id, min(COBALT.timeout, COBALT_FIRST_BUDGET_SECONDS))
    except CobaltUnavailable as exc:
        _log.info("Cobalt-first (video download) had no answer: %s", exc)
        return None
    formats = info.get("formats") or []
    url = formats[0].get("url") if formats else None
    return url if isinstance(url, str) and _media_url_allowed(url) else None


def _resolve_and_extract_ytdlp(url: str, first_route: int = 0) -> tuple[str, dict]:
    """
    Validate/expand the link and fetch its metadata. Raises ScraperError.

    YouTube is looked up on each route from `first_route` on until one yields something downloadable, so a
    block on one client fingerprint is not the end. Other platforms have a single route.
    """
    budget = _extraction_budget(url)
    if COBALT.usable() and is_youtube_host(urlparse(url.strip()).hostname or ""):
        budget -= min(COBALT.timeout, max(0.0, budget - 5.0))  # leave the fallback its share of the same overall budget
    _deadline.set(time.monotonic() + budget)
    try:
        # Share links may need a few redirects followed; that time comes out of the same budget.
        url = resolve_url(url, expand=lambda u: expand_redirects(u, timeout=_time_left(3.0), max_hops=3))
    except UnsupportedUrl as exc:
        raise ScraperError(errors.INVALID_URL, str(exc))

    youtube = is_youtube_host(urlparse(url).hostname or "")
    if youtube and YOUTUBE_BREAKER.is_open() and not _bypass_breaker.get():
        raise ScraperError(_youtube_last_failure[0])  # failed a moment ago: don't ask again yet
    route_count = len(_youtube_route_plan())
    first_route = min(first_route, route_count - 1)
    routes = list(range(first_route, route_count)) * YOUTUBE_LOOKUP_PASSES if youtube else [0]
    info, failure = None, None
    for position, route in enumerate(routes):
        last = position == len(routes) - 1
        try:
            if is_instagram_host(urlparse(url).hostname or ""):
                found = _instagram_lookup(url)
            else:
                found = _extract_info(url) if route == 0 else _extract_info(url, route)
        except ScraperError as err:
            failure = err
        except Exception as exc:  # noqa: BLE001 - always answer with a coded error
            failure = _failure_from_exception(exc)
        else:
            if found and (_has_download(found) or last):
                if youtube and _has_download(found):
                    YOUTUBE_BREAKER.record_success()
                return url, found
            info = info or found  # keep it: its messages explain why there is nothing to download
            failure = None
            continue
        # An error (a block, a stall) tries each route once; only an empty answer earns the extra pass.
        if failure.code not in _RETRY_ON_OTHER_ROUTE or last or position >= route_count - first_route - 1:
            gave_up = _gave_up.get()
            if youtube and failure.code in _BREAKER_FAILURES and not (gave_up and gave_up.is_set()) and not _bypass_breaker.get():
                # one failed LOOKUP counts once, however many routes it tried (and not again if the caller
                # already counted it when it stopped waiting)
                _youtube_last_failure[0] = failure.code
                YOUTUBE_BREAKER.record_failure()
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
    gave_up = threading.Event()
    context_token = _gave_up.set(gave_up)
    work = asyncio.ensure_future(asyncio.to_thread(_resolve_and_extract, url, first_route))
    _gave_up.reset(context_token)

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
            asyncio.shield(work), timeout=_extraction_budget(url) + DEADLINE_GRACE_SECONDS
        )
    except asyncio.TimeoutError:
        gave_up.set()  # the worker is still stuck: count this failure here, once
        if is_youtube_host(urlparse(url.strip()).hostname or ""):
            _youtube_last_failure[0] = errors.PLATFORM_TIMEOUT
            YOUTUBE_BREAKER.record_failure()
        raise ScraperError(errors.PLATFORM_TIMEOUT)
    except ScraperError as err:
        if err.code in NEGATIVE_CACHEABLE:
            NEGATIVE_CACHE.set(key, err)
        raise

    entry = {"resolved": resolved, "info": slim_info(info)}
    youtube_result = is_youtube_host(urlparse(resolved).hostname or "")
    if youtube_result and not _has_download(entry["info"]):
        # a session-specific dead end, not a fact about the video: remembering it would fail every retry for hours
        return resolved, entry["info"]
    ttl = _youtube_cache_ttl(entry["info"]) if youtube_result else None
    INFO_CACHE.set(key, entry, ttl=ttl)
    try:  # a short link and the full link it points to share one entry
        INFO_CACHE.set(cache_key(resolved), entry, ttl=ttl)
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
        "Pinterest, TikTok, Reddit, Snapchat or LinkedIn)",
    ),
    images: bool = Query(
        False,
        description="Also return Instagram photos (single or carousel slides) as kind=image items. Off by "
        "default, so a caller that only knows videos never receives an item without a videoUrl.",
    ),
    x_scraper_key: str | None = Header(default=None),
) -> dict:
    _check_key(x_scraper_key)

    try:
        _resolved, info, cached = await _acquire_info(url)
    except ScraperError as err:
        raise _http_error(err)

    items = _describe_items(info, images=images and is_instagram_host(urlparse(_resolved).hostname or ""))
    if not items:
        raise _http_error(_no_video_error(info))
    if YTDLP_PROXY and is_youtube_host(urlparse(_resolved).hostname or "") and info.get("_via") != "cobalt":
        try:  # refuse now, before the visitor is offered a download that would cost more than we allow
            _refuse_if_too_large_for_proxy(_proxy_size_of(info))
        except ScraperError as err:
            raise _http_error(err)

    first = items[0]
    return {
        **first,
        "success": True,
        # A carousel's id/author/title belong to the post, not to its first slide.
        "id": info.get("id") or first["id"],
        "title": first["title"] or info.get("title"),
        # The whole caption with its hashtags; `title` stays the short form the card shows.
        "caption": _caption(info) or (_caption(info["entries"][0]) if info.get("entries") else None),
        "author": first["author"] or info.get("uploader") or info.get("channel"),
        "formats": [],  # a single best progressive stream is returned in videoUrl
        # Only present for posts with several videos (or, with images=1, photos): carousels, multi-video tweets.
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
        via_proxy: bool = False,
    ):
        self.via_proxy = via_proxy
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
        limit = MAX_STREAM_BYTES
        if self.via_proxy and _proxy_file_limit_bytes():
            limit = min(limit, _proxy_file_limit_bytes())  # a paid-proxy download that outgrows its allowance is cut off
        try:
            while True:
                chunk = self.response.read(CHUNK_SIZE)
                if not chunk:
                    break
                sent += len(chunk)
                if self.via_proxy:
                    _proxy_note_bytes(len(chunk))
                if sent > limit:
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


# Audio from a video that has no separate audio track (every YouTube video today, and posts whose sound is only
# inside the MP4). The video is streamed into ffmpeg, which copies the existing AAC track out unchanged (no
# re-encoding) and writes it as a fragmented M4A that can be sent while it is still being produced. The source is
# opened exactly like a video download, so the proxy, Cobalt-first and every size and daily cap still apply to it.
_FFMPEG_ARGS = ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-vn", "-c:a", "copy",
                "-f", "mp4", "-movflags", "frag_keyframe+empty_moov+default_base_moof", "pipe:1"]
_ffmpeg_exe: list = []  # memo: [path or None]


def _ffmpeg() -> str | None:
    """The ffmpeg binary: the one bundled by imageio-ffmpeg (a pip install, so it works on Render), else PATH."""
    if not _ffmpeg_exe:
        path = None
        try:
            import imageio_ffmpeg

            path = imageio_ffmpeg.get_ffmpeg_exe()
        except Exception:  # noqa: BLE001 - not installed: try the system one
            path = shutil.which("ffmpeg")
        _ffmpeg_exe.append(path)
    return _ffmpeg_exe[0]


class _AudioReader:
    """Reads ffmpeg's output; fails loudly (not with a silently short file) if the source broke off."""

    def __init__(self, proc: subprocess.Popen, first: bytes, failed: threading.Event):
        self._proc, self._pending, self._failed = proc, first, failed

    def read(self, size: int) -> bytes:
        if self._pending:
            chunk, self._pending = self._pending, b""
            return chunk
        chunk = self._proc.stdout.read1(size)
        if not chunk and self._failed.is_set():
            raise StreamTooLarge("the video stream broke off while its audio was being extracted")
        return chunk


def _audio_from_video(source: OpenStream) -> OpenStream:
    """Wrap an opened video stream so it yields that video's own audio track as M4A. Blocking until the first audio bytes."""
    exe = _ffmpeg()
    if not exe:
        source.close()
        raise ScraperError(errors.UNSUPPORTED_POST, "This video has no separate audio stream.")
    proc = subprocess.Popen([exe, *_FFMPEG_ARGS], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    failed = threading.Event()

    def pump() -> None:
        try:
            for chunk in source.chunks():  # counts proxy bytes and enforces the size caps, like a video download
                proc.stdin.write(chunk)
        except Exception:  # noqa: BLE001 - a cut-off source must not end as a short, "successful" file
            failed.set()
            proc.kill()
        finally:
            try:
                proc.stdin.close()
            except Exception:  # noqa: BLE001
                pass

    def stop() -> None:
        if proc.poll() is None:
            proc.kill()
        proc.stdout.close()
        proc.wait()
        source.close()

    threading.Thread(target=pump, daemon=True).start()
    first = proc.stdout.read1(CHUNK_SIZE)
    if not first:
        stop()
        if failed.is_set():
            raise ScraperError(errors.STREAM_EXPIRED_OR_BLOCKED)
        raise ScraperError(errors.UNSUPPORTED_POST, "This video has no sound to extract.")
    return OpenStream(_AudioReader(proc, first, failed), None, [stop], "m4a")


def _open_stream_from_info(resolved: str, info: dict, kind: str, item: int) -> OpenStream:
    """Open the best video (or audio-only) stream of an already-resolved post. Blocking."""
    entries = _entries(info)
    entry = entries[item] if 0 <= item < len(entries) else entries[0]
    if kind == "image":
        image = _pick_image(entry) if is_instagram_host(urlparse(resolved).hostname or "") else None
        if not image:
            raise ScraperError(errors.UNSUPPORTED_POST, "This post has no photo to download.")
        return _open_cdn_stream(image["url"], referer_for(image["url"]), "image", None, ext=image["ext"])
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
    if not _media_url_allowed(media_url):
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

        # A Cobalt link is fetched directly: it is not tied to our IP, and it would only spend paid proxy traffic.
        via_proxy = bool(YTDLP_PROXY) and not COBALT.is_media_url(media_url) and (
            is_youtube_host(urlparse(resolved).hostname or "") or is_youtube_media_host(urlparse(media_url).hostname or "")
        )

        # Cobalt-first: for a plain video download that would otherwise cost paid-proxy bandwidth, try a fresh
        # Cobalt link before falling back to it. Checked (and so billed against the daily budget) only once
        # Cobalt has nothing, so a Cobalt success never touches the budget at all.
        if kind == "video" and via_proxy:
            cobalt_url = _cobalt_video_url(info.get("id") if isinstance(info.get("id"), str) else None)
            if cobalt_url:
                try:
                    return _open_cdn_stream(cobalt_url, None, "video", None)
                except ScraperError:
                    pass  # Cobalt's own link didn't pan out either: fall through to the paid-proxy route below

        if via_proxy:
            _proxy_check_budget()
        ydl = yt_dlp.YoutubeDL(_ydl_options(use_proxy=via_proxy))
        headers = dict(fmt.get("http_headers") or {})
        if via_proxy:
            _refuse_if_too_large_for_proxy(fmt.get("filesize") or fmt.get("filesize_approx"))
        response = ydl.urlopen(yt_dlp.networking.Request(media_url, headers=headers))
        length = response.headers.get("Content-Length")
        if via_proxy:
            try:
                _refuse_if_too_large_for_proxy(int(length) if length else None)
            except ScraperError:
                response.close()
                ydl.close()
                raise
        return OpenStream(response, int(length) if length else None, [response.close, ydl.close], ext, via_proxy=via_proxy)
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
    elif kind == "image":
        ext = ext if ext in IMAGE_TYPES else "jpg"
        media_type = IMAGE_TYPES[ext]
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
    kind: str = Query("video", pattern="^(video|audio|image)$"),
    item: int = Query(0, ge=0, le=MAX_ITEMS),
    extract: bool = Query(False, description="kind=audio only: take the sound out of the video itself (for videos with no separate audio track)"),
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
        if kind == "audio" and extract:
            video = await _open_stream(url, "video", item)
            stream = await asyncio.to_thread(_audio_from_video, video)
        else:
            stream = await _open_stream(url, kind, item)
    except ScraperError as err:
        lease.release()
        raise _http_error(err)
    except BaseException:
        lease.release()
        raise
    stream.add_closer(lease.release)

    # Audio (and photo) downloads are named after the container of the stream actually served.
    return _attachment_response(stream, id, kind, stream.ext)


class _HttpxReader:
    """Adapts an httpx streaming response to the .read(n) interface OpenStream expects."""

    def __init__(self, response: httpx.Response):
        self._chunks = response.iter_raw(CHUNK_SIZE)

    def read(self, _amount: int = -1) -> bytes:
        return next(self._chunks, b"")


def _open_cdn_stream(
    media_url: str, referer: str | None, kind: str = "video", range_header: str | None = None, ext: str | None = None
) -> OpenStream:
    """
    Open a CDN video URL from THIS server's IP.

    YouTube (and some TikTok / Facebook) links are bound to the IP that
    resolved them. /extract resolves them here, so they must be downloaded
    from here as well. Only known platform CDNs are allowed, redirects are
    followed by hand and must stay on those CDNs.
    """
    if not _media_url_allowed(media_url):
        raise ScraperError(errors.INVALID_URL, "That media URL isn't supported.")

    headers = {
        "User-Agent": BROWSER_UA,
        "Referer": safe_referer(referer, media_url),
        "Accept": {
            "audio": "audio/*,*/*;q=0.5",
            "image": "image/jpeg,image/webp,image/png;q=0.9,*/*;q=0.5",
        }.get(kind, "video/mp4,video/*;q=0.9,*/*;q=0.5"),
        "Accept-Language": "en-US,en;q=0.9",
    }
    # Forward a single byte range so interrupted downloads can resume and players can seek.
    if range_header and re.fullmatch(r"bytes=\d*-\d*", range_header.strip()):
        headers["Range"] = range_header.strip()
    via_proxy = bool(YTDLP_PROXY) and is_youtube_media_host(urlparse(media_url).hostname or "")
    if via_proxy:
        _proxy_check_budget()
    client = httpx.Client(
        timeout=httpx.Timeout(5.0, read=20.0), follow_redirects=False, proxy=YTDLP_PROXY if via_proxy else None
    )
    try:
        current = media_url
        response = None
        for _ in range(4):
            response = client.send(client.build_request("GET", current, headers=headers), stream=True)
            if not response.is_redirect:
                break
            target = urljoin(current, response.headers.get("location", ""))
            response.close()
            if not _media_url_allowed(target):
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
        allowed = {
            "audio": ("audio/", "video/mp4", "video/webm", "application/octet-stream"),
            "image": tuple(dict.fromkeys(IMAGE_TYPES.values())) + ("application/octet-stream",),
        }.get(kind, ("video/", "application/octet-stream"))
        if not content_type.startswith(allowed):
            response.close()
            raise ScraperError(
                errors.UNSUPPORTED_POST,
                {"audio": "The requested file is not an audio track.", "image": "The requested file is not a picture."}.get(
                    kind, "The requested file is not a video."
                ),
            )

        raw_length = response.headers.get("content-length", "")
        length = int(raw_length) if raw_length.isdigit() else None
        if length and length > MAX_STREAM_BYTES:
            response.close()
            raise ScraperError(errors.EXTRACTION_FAILED, "This video is too large to download.")
        if via_proxy:
            total = length
            span = re.fullmatch(r"bytes \d+-\d+/(\d+)", response.headers.get("content-range", "").strip())
            if span:  # a resumed download: judge the whole file, not the part
                total = int(span.group(1))
            try:
                _refuse_if_too_large_for_proxy(total)
            except ScraperError:
                response.close()
                raise

        return OpenStream(
            _HttpxReader(response),
            length,
            [response.close, client.close],
            ext,
            status=206 if response.status_code == 206 else 200,
            content_range=response.headers.get("content-range") if response.status_code == 206 else None,
            accept_ranges=response.headers.get("accept-ranges", "").lower() == "bytes",
            via_proxy=via_proxy,
        )
    except ScraperError:
        client.close()
        raise
    except httpx.HTTPError:
        client.close()
        raise ScraperError(errors.PLATFORM_TIMEOUT)


def _open_stream_preferring_cobalt(
    url: str, referer: str | None, id_: str, kind: str, range_header: str | None
) -> OpenStream:
    """
    `_open_cdn_stream`, but for a plain YouTube video download it tries a fresh Cobalt link first, so the
    common case (this server's own `/extract` already resolved `url` through the paid proxy) doesn't have to
    spend proxy bandwidth on the bytes too. Falls straight through to `url` itself - the existing, already
    proxy-bound link - whenever Cobalt is off, paused, has nothing, or its own link doesn't pan out either.
    """
    if kind == "video" and YTDLP_PROXY and is_youtube_media_host(urlparse(url).hostname or ""):
        cobalt_url = _cobalt_video_url(id_)
        if cobalt_url:
            try:
                return _open_cdn_stream(cobalt_url, None, "video", range_header)
            except ScraperError:
                pass  # Cobalt's own link didn't pan out either: fall through to the paid-proxy route below
    return _open_cdn_stream(url, referer, kind, range_header)


@app.get("/stream")
async def stream(
    url: str = Query(..., description="Video URL on a platform CDN, as returned by /extract"),
    referer: str | None = Query(None, description="Page the video came from (optional)"),
    id: str = Query("video", max_length=60),
    kind: str = Query("video", pattern="^(video|audio|image)$"),
    ext: str = Query("m4a", pattern="^[a-z0-9]{2,4}$"),
    extract: bool = Query(False, description="kind=audio only: `url` is a video; send the audio track out of it"),
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
        if kind == "audio" and extract:
            video = await asyncio.to_thread(_open_stream_preferring_cobalt, url, referer, id, "video", None)
            opened = await asyncio.to_thread(_audio_from_video, video)
            ext = "m4a"
        else:
            opened = await asyncio.to_thread(_open_stream_preferring_cobalt, url, referer, id, kind, range_header)
    except ScraperError as err:
        lease.release()
        raise _http_error(err)
    except BaseException:
        lease.release()
        raise
    opened.add_closer(lease.release)

    return _attachment_response(opened, id, kind, ext)


# ---------------------------------------------------------------------------------- YouTube cache and proxy budget


def _youtube_cache_ttl(info: dict) -> float:
    """
    How long to keep a YouTube lookup: YOUTUBE_CACHE_TTL_SECONDS, but never longer than its own video links
    stay valid (they carry an `expire=` timestamp; a cached link that died would only cost a second lookup).
    """
    if info.get("_via") == "cobalt":
        return min(COBALT_LINK_TTL_SECONDS, YOUTUBE_CACHE_TTL_SECONDS)
    expiries = []
    for fmt in (info.get("formats") or []) + (info.get("requested_formats") or []):
        match = re.search(r"[?&]expire=(\d+)", str(fmt.get("url") or ""))
        if match:
            expiries.append(int(match.group(1)))
    if not expiries:
        return YOUTUBE_CACHE_TTL_SECONDS
    return max(60.0, min(YOUTUBE_CACHE_TTL_SECONDS, min(expiries) - time.time() - 300))


# The proxy is billed by traffic. These counters show where it goes (see /stats); the optional daily limit
# stops YouTube downloads (never lookups from the cache) once a day's allowance is used.
#
# Both defaults lowered after real DataImpulse spend on media bytes (Cobalt-first, see _cobalt_video_url,
# already tries to avoid the proxy for video entirely - these two caps are what bound the cost on whatever
# still falls back to it: a Cobalt failure, or any audio request, which Cobalt can never serve). A Render env
# var of the same name overrides this default either way - check what's actually set there before assuming
# this change alone moves the number.
PROXY_DAILY_LIMIT_MB = _env_number("YOUTUBE_PROXY_DAILY_LIMIT_MB", 200)  # 0 = no limit
# The biggest YouTube file we will pull through the paid proxy (0 = no limit). One long video can cost as much
# as a thousand lookups, so it is refused up front (from its reported size) and, failing that, cut off mid-stream.
PROXY_MAX_FILE_MB = _env_number("YOUTUBE_PROXY_MAX_FILE_MB", 25)
_proxy_lock = threading.Lock()
_proxy_usage = {"lookups": 0, "streams": 0, "streamBytes": 0, "day": "", "todayBytes": 0}


def _utc_day() -> str:
    return time.strftime("%Y-%m-%d", time.gmtime())


def _proxy_roll_day() -> None:
    today = _utc_day()
    if _proxy_usage["day"] != today:
        _proxy_usage["day"] = today
        _proxy_usage["todayBytes"] = 0


def _proxy_note_lookup() -> None:
    with _proxy_lock:
        _proxy_usage["lookups"] += 1


def _proxy_note_bytes(count: int) -> None:
    with _proxy_lock:
        _proxy_roll_day()
        _proxy_usage["streamBytes"] += count
        _proxy_usage["todayBytes"] += count


def _proxy_file_limit_bytes() -> int:
    return int(PROXY_MAX_FILE_MB * 1024 * 1024) if PROXY_MAX_FILE_MB > 0 else 0


def _refuse_if_too_large_for_proxy(size: int | None) -> None:
    limit = _proxy_file_limit_bytes()
    if limit and size and size > limit:
        _proxy_usage["refused"] = _proxy_usage.get("refused", 0) + 1
        raise ScraperError(errors.FILE_TOO_LARGE)


def _proxy_size_of(info: dict) -> int | None:
    """The reported size of the video we would download, when the platform says (None when it does not)."""
    fmt, _audio = _pick_format((_entries(info) or [info])[0])
    return (fmt.get("filesize") or fmt.get("filesize_approx")) if fmt else None


def _proxy_check_budget() -> None:
    """Refuse a new YouTube download once today's proxy allowance is used up (only when a limit is set)."""
    with _proxy_lock:
        _proxy_roll_day()
        _proxy_usage["streams"] += 1
        used_mb = _proxy_usage["todayBytes"] / 1024 / 1024
    if PROXY_DAILY_LIMIT_MB and used_mb >= PROXY_DAILY_LIMIT_MB:
        raise ScraperError(errors.SERVER_BUSY)


def _proxy_setting() -> str:
    """"off", "ok", "converted" (host:port:user:pass form) or "rejected" (set, but unusable: the proxy is not in use)."""
    if PROXY_SETTING_STATUS == "rejected" and not YTDLP_PROXY:
        return "rejected"
    if not YTDLP_PROXY:
        return "off"
    return "converted" if PROXY_SETTING_STATUS == "converted" else "ok"


def _proxy_stats() -> dict:
    """Proxy use for /stats: the host (never the credentials) and how much traffic went through it."""
    with _proxy_lock:
        _proxy_roll_day()
        return {
            "configured": bool(YTDLP_PROXY),
            "setting": _proxy_setting(),
            "host": proxy_host(YTDLP_PROXY),
            "lookups": _proxy_usage["lookups"],
            "downloads": _proxy_usage["streams"],
            "downloadedMb": round(_proxy_usage["streamBytes"] / 1024 / 1024, 1),
            "todayMb": round(_proxy_usage["todayBytes"] / 1024 / 1024, 1),
            "maxFileMb": PROXY_MAX_FILE_MB or None,
            "refusedTooLarge": _proxy_usage.get("refused", 0),
            "dailyLimitMb": PROXY_DAILY_LIMIT_MB or None,
            # Instagram's rate-limit retries: how many happened, how many got through, how many used the proxy.
            "instagram": {
                "retries": _instagram_usage["retries"],
                "recovered": _instagram_usage["recovered"],
                "proxied": _instagram_usage["proxied"],
                "proxiedToday": _instagram_usage["proxiedToday"] if _instagram_usage["day"] == _utc_day() else 0,
                "dailyProxyLookups": INSTAGRAM_PROXY_DAILY_LOOKUPS or None,
                "skippedNoTime": _instagram_usage["skippedNoTime"],
                "stalls": _instagram_usage["stalls"],
                "directSkipped": _instagram_usage["directSkipped"],
                "directBlockedForSeconds": max(0, round(_instagram_direct_blocked_until[0] - time.monotonic())),
            },
        }


# ------------------------------------------------------------------------------------- Telegram bot
# @savereelsfast_bot: paste a link in Telegram, get the video back. It only runs when TELEGRAM_BOT_TOKEN is
# set on the host. It goes through the same pipeline as the website (cache, concurrency limits, the memory
# guard, stream slots); the bot itself lives in telegram_bot.py and never touches the API's request handling.

_BOT_MESSAGES = {
    errors.LOGIN_REQUIRED: "🔒 That video is private, age-restricted or needs a login, so I can't download it. Try a public link.",
    errors.UNSUPPORTED_POST: "🎞️ I couldn't find a video in that link. Only video posts are supported.",
    errors.STREAM_EXPIRED_OR_BLOCKED: "⏳ The platform is limiting downloads right now. Please try again in a minute.",
    errors.PLATFORM_TIMEOUT: "⏳ The platform didn't answer in time. Please try again shortly.",
    errors.EXTRACTION_FAILED: "😕 I couldn't get that video. It may be private, deleted or region-restricted.",
    errors.INVALID_URL: "That doesn't look like a supported video link. Try Instagram, YouTube, TikTok, Facebook, X, Reddit, Pinterest, Threads, Snapchat or LinkedIn.",
    errors.SERVER_BUSY: "I'm a bit busy right now. Please try again in a few seconds.",
}


def _bot_message(err: ScraperError) -> str:
    return _BOT_MESSAGES.get(err.code, _BOT_MESSAGES[errors.EXTRACTION_FAILED])


def _save_stream_to_file(stream: "OpenStream", cap: int, cancelled: threading.Event) -> tuple[str | None, int]:
    """
    Write a video to a temporary file in small chunks (RAM stays flat whatever the size). Returns
    (path, size), or (None, size) when the video is over `cap` or the job was cancelled. Blocking.
    """
    fd, path = tempfile.mkstemp(prefix=TEMP_PREFIX, suffix=".mp4")
    size = 0
    keep = False
    try:
        with os.fdopen(fd, "wb") as out:
            for chunk in stream.chunks():
                if cancelled.is_set():
                    return None, size
                size += len(chunk)
                if size > cap:
                    return None, size
                out.write(chunk)
        keep = size > 0 and not cancelled.is_set()
        return (path if keep else None), size
    finally:
        stream.close()
        if not keep:
            delete_quietly(path)


async def _telegram_fetch(url: str) -> Media:
    """Link -> the video (as a temporary file when it fits Telegram's 50 MB, else a direct link)."""
    cancelled = threading.Event()
    try:
        _shed_load_if_low_on_memory()
        _resolved, info, _cached = await _acquire_info(url)
        items = _describe_items(info)
        if not items:
            raise _no_video_error(info)
        first = items[0]
        media = Media(title=first.get("title"), media_url=first["videoUrl"], audio=first.get("audio") or "unknown")

        lease = STREAM_SLOTS.acquire()
        if lease is None:
            raise ScraperError(errors.SERVER_BUSY)
        try:
            stream = await _open_stream(url, "video", 0)
        except BaseException:
            lease.release()
            raise
        stream.add_closer(lease.release)

        if stream.length and stream.length > MAX_UPLOAD_BYTES:
            stream.close()  # too big to upload: the caller answers with the direct link
            media.size = stream.length
            return media
        media.path, media.size = await asyncio.to_thread(_save_stream_to_file, stream, MAX_UPLOAD_BYTES, cancelled)
        return media
    except asyncio.CancelledError:
        cancelled.set()  # the worker thread stops and deletes its file at the next chunk
        raise
    except ScraperError as err:
        raise BotUserError(_bot_message(err))


_telegram_bot: TelegramBot | None = None
_telegram_task: "asyncio.Task | None" = None


@app.on_event("startup")
async def _start_telegram_bot() -> None:
    global _telegram_bot, _telegram_task
    token = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
    if not token:
        return
    if not valid_token(token):
        _log.warning("TELEGRAM_BOT_TOKEN is set but does not look like a bot token: the Telegram bot is off.")
        return
    # httpx logs every request address at INFO level, and Telegram's contain the token.
    logging.getLogger("httpx").setLevel(logging.WARNING)
    _telegram_bot = TelegramBot(token, _telegram_fetch)
    _telegram_task = asyncio.ensure_future(_telegram_bot.run_forever())
    _log.info("Telegram bot enabled (long polling).")


@app.on_event("shutdown")
async def _stop_telegram_bot() -> None:
    global _telegram_bot, _telegram_task
    if _telegram_task is not None:
        _telegram_task.cancel()
        await asyncio.gather(_telegram_task, return_exceptions=True)
    _telegram_bot, _telegram_task = None, None


# ------------------------------------------------------------------------------------ Cobalt keep-alive
# A self-hosted Cobalt instance on Render's free tier sleeps after ~15 minutes idle, and the first request
# after that takes 30+ seconds to wake it - far longer than _cobalt_video_url's short, deliberately-capped
# budget (COBALT_FIRST_BUDGET_SECONDS), which always gives up on a cold instance and falls back to the paid
# proxy long before it wakes up. The fix is not to wait longer (that would just make every cold download
# slower without helping - Vercel's own edge function gives up on this server after 12 s regardless of how
# long it waits here), but to stop the instance falling asleep in the first place.
COBALT_KEEPALIVE_INTERVAL_SECONDS = 600.0  # 10 min: comfortably under a typical free-tier ~15 min sleep window
_cobalt_keepalive_task: "asyncio.Task | None" = None


async def _cobalt_keepalive_loop() -> None:
    """
    Pings every configured Cobalt instance on a timer so it stays warm. A plain GET is enough - it only needs
    to see *some* traffic, so this never sends a real lookup (no video id or API key involved) and never
    touches the paid proxy. Runs forever in the background; a failed ping is silently retried next cycle,
    since it must never be allowed to crash the app or hold up a real request.
    """
    async with httpx.AsyncClient(timeout=10.0) as client:
        while True:
            for instance in COBALT.instances:
                try:
                    await client.get(instance)
                except Exception:  # noqa: BLE001 - best-effort only; a failed ping just means it stays cold a bit longer
                    pass
            await asyncio.sleep(COBALT_KEEPALIVE_INTERVAL_SECONDS)


@app.on_event("startup")
async def _start_cobalt_keepalive() -> None:
    global _cobalt_keepalive_task
    if COBALT.instances:
        _cobalt_keepalive_task = asyncio.ensure_future(_cobalt_keepalive_loop())
        _log.info("Cobalt keep-alive: pinging every %.0f min so it doesn't fall asleep between downloads.", COBALT_KEEPALIVE_INTERVAL_SECONDS / 60)


@app.on_event("shutdown")
async def _stop_cobalt_keepalive() -> None:
    global _cobalt_keepalive_task
    if _cobalt_keepalive_task is not None:
        _cobalt_keepalive_task.cancel()
        await asyncio.gather(_cobalt_keepalive_task, return_exceptions=True)
    _cobalt_keepalive_task = None


# ------------------------------------------------------------------------------------ YouTube diagnostics
# GET /diagnose/youtube (needs the shared secret, like /stats): where does a YouTube lookup stall on THIS host?
# Reports the cookies file (names and counts only, never a value), DNS/TCP/TLS/HTTP timings to YouTube from
# this machine's network, and one real lookup with a request-by-request trace. One run at a time.

_diagnose_lock = threading.Lock()
_DIAGNOSE_DEFAULT = "https://www.youtube.com/watch?v=jNQXAC9IVRw"


@app.get("/diagnose/youtube", include_in_schema=False)
async def diagnose_youtube(
    url: str = Query(_DIAGNOSE_DEFAULT, max_length=200),
    x_scraper_key: str | None = Header(default=None),
) -> dict:
    _check_key(x_scraper_key)
    if not is_youtube_host(urlparse(url.strip()).hostname or ""):
        raise _http_error(ScraperError(errors.INVALID_URL, "Give a YouTube link."))
    if not _diagnose_lock.acquire(blocking=False):
        raise _http_error(ScraperError(errors.SERVER_BUSY))
    try:
        try:
            _shed_load_if_low_on_memory()
        except ScraperError as err:
            raise _http_error(err)
        trace: list = []
        tokens = (_trace.set(trace), _bypass_breaker.set(True))
        try:
            network = await asyncio.to_thread(probe_network)
            proxy = await asyncio.to_thread(probe_proxy, YTDLP_PROXY) if YTDLP_PROXY else None
            started = time.monotonic()
            ok, code = True, None
            try:
                await asyncio.wait_for(
                    asyncio.to_thread(_resolve_and_extract, url), timeout=YOUTUBE_EXTRACTION_TIMEOUT_SECONDS + 3
                )
            except ScraperError as err:
                ok, code = False, err.code
            except asyncio.TimeoutError:
                ok, code = False, errors.PLATFORM_TIMEOUT
            except Exception as exc:  # noqa: BLE001 - a diagnostic reports, it never fails
                ok, code = False, type(exc).__name__
            seconds = round(time.monotonic() - started, 1)
        finally:
            _trace.reset(tokens[0])
            _bypass_breaker.reset(tokens[1])
        cookies = cookie_summary(_youtube_cookie_source())
        return {
            "ytDlp": yt_dlp.version.__version__,
            "cookies": cookies,
            "proxyConfigured": bool(YTDLP_PROXY),
            "proxySetting": _proxy_setting(),
            "proxy": proxy,
            "cobalt": COBALT.stats(),
            "routes": [{"clients": args["player_client"], "sendsCookies": sends} for args, sends in _youtube_route_plan()],
            "budgetSeconds": YOUTUBE_EXTRACTION_TIMEOUT_SECONDS,
            "socketTimeoutSeconds": YOUTUBE_SOCKET_TIMEOUT,
            "network": network,
            "lookup": {"ok": ok, "code": code, "seconds": seconds},
            "trace": trace,
            "reading": interpret(network, ok, code, trace, cookies, proxy, _proxy_setting()),
        }
    finally:
        _diagnose_lock.release()


@app.on_event("startup")
def _report_cobalt_fallback() -> None:
    if COBALT.enabled:
        _log.info(
            "YouTube via Cobalt: ON via %s%s. Tried first for a plain video download (saves paid-proxy "
            "bandwidth), and still the fallback when yt-dlp itself is blocked or stalls.",
            ", ".join(sorted(COBALT.hosts())),
            " (API key set)" if COBALT.api_key else " (no API key)",
        )
    else:
        _log.info("YouTube via Cobalt: OFF (COBALT_API_URL is not set); every video download uses yt-dlp (plus the paid proxy, if configured).")


@app.on_event("startup")
def _report_youtube_proxy() -> None:
    if _proxy_setting() == "rejected":
        _log.warning("YouTube proxy: the YTDLP_PROXY setting was REJECTED (see the earlier warning): YouTube is fetched directly.")
    elif YTDLP_PROXY:
        _log.info(
            "YouTube proxy: configured (%s); used for YouTube only. Cache %.0f h. Daily limit: %s.",
            proxy_host(YTDLP_PROXY),
            YOUTUBE_CACHE_TTL_SECONDS / 3600,
            f"{PROXY_DAILY_LIMIT_MB:.0f} MB" if PROXY_DAILY_LIMIT_MB else "none",
        )
    else:
        _log.info("YouTube proxy: not configured (YouTube is fetched directly from this host).")


@app.on_event("startup")
def _report_youtube_cookies() -> None:
    summary = cookie_summary(_youtube_cookie_source())
    if not summary["detected"]:
        _log.info("YouTube cookies: none found (looked for %s).", YOUTUBE_COOKIES_DEFAULT_PATH)
    elif not summary.get("readable"):
        _log.warning("YouTube cookies: a file exists but cannot be read (%s).", summary.get("error"))
    else:
        _log.info(
            "YouTube cookies: found, %d entries, %s.",
            summary["entries"],
            "signed-in session present" if summary["loggedIn"] else "NO signed-in session cookies (export again while signed in)",
        )
