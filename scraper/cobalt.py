"""
Optional fallback for YouTube: ask a Cobalt instance for the video when yt-dlp is blocked or stalls.

Off unless COBALT_API_URL is set. Several instances may be listed, comma separated, tried in order.
COBALT_API_KEY (optional) is sent as `Authorization: Api-Key <key>` for instances that require one; the main
public instance (api.cobalt.tools) requires authentication and will not work without it.

What leaves this server: only the canonical watch URL rebuilt from the 11-character video id. No cookies, no
proxy login, no visitor address, no other request data. What comes back is checked before it is trusted:
  * a "tunnel" link must be https on the instance's own host (a hostile answer cannot point us elsewhere);
  * a "redirect" link must be on a known platform CDN (same allowlist as everything else);
  * anything else ("picker", "local-processing", errors) is treated as "no result".
The key is never logged, returned or put in an error message.
"""

from __future__ import annotations

import logging
import re
import time
from urllib.parse import urlparse

import httpx

from urls import is_allowed_media_url

_log = logging.getLogger("uvicorn.error")

MAX_RESPONSE_BYTES = 64 * 1024  # a real answer is a few hundred bytes
_CLIENT_ERRORS_TO_SKIP = ("error.api.youtube.login", "error.api.content.video.age")  # video-specific: another instance won't help


class CobaltUnavailable(Exception):
    """No usable answer from any instance. Carries only a short, secret-free reason."""


def parse_instances(raw: str | None) -> list[str]:
    """Valid https instance base URLs from a comma separated setting (anything else is dropped)."""
    found: list[str] = []
    for part in (raw or "").split(","):
        value = part.strip()
        if not value:
            continue
        try:
            parsed = urlparse(value)
            ok = parsed.scheme == "https" and bool(parsed.hostname) and not parsed.username and not parsed.password
            parsed.port  # noqa: B018 - raises ValueError for a bad port
        except ValueError:
            ok = False
        if ok:
            found.append(f"https://{parsed.netloc}{parsed.path.rstrip('/')}/")
        else:
            _log.warning("COBALT_API_URL: ignoring an entry that is not a plain https URL.")
    return found


class Cobalt:
    def __init__(self, instances: list[str], api_key: str | None = None, timeout: float = 4.0):
        self.instances = instances
        self.api_key = (api_key or "").strip() or None
        self.timeout = timeout
        self.attempts = 0
        self.successes = 0
        self.last_error: str | None = None

    @property
    def enabled(self) -> bool:
        return bool(self.instances)

    def hosts(self) -> set[str]:
        return {(urlparse(i).hostname or "").lower() for i in self.instances}

    def is_media_url(self, raw: str) -> bool:
        """A download link on one of the configured instances (https, no explicit port, exact host)."""
        try:
            parsed = urlparse(raw)
            port = parsed.port
        except ValueError:
            return False
        host = (parsed.hostname or "").lower()
        allowed = {(urlparse(i).hostname or "").lower(): urlparse(i).port for i in self.instances}
        return parsed.scheme == "https" and host in allowed and port == allowed[host]

    def stats(self) -> dict:
        return {
            "enabled": self.enabled,
            "instances": sorted(self.hosts()),
            "apiKeySet": bool(self.api_key),  # only whether one is configured, never the key
            "timeoutSeconds": self.timeout,
            "attempts": self.attempts,
            "successes": self.successes,
            "lastError": self.last_error,
        }

    # ------------------------------------------------------------------------------------------ lookup

    def fetch(self, video_id: str, budget: float | None = None, transport: httpx.BaseTransport | None = None) -> dict:
        """
        An info dict (same shape the rest of the scraper uses) for a YouTube video, or CobaltUnavailable.
        `budget` caps the total time across all instances.
        """
        if not re.fullmatch(r"[A-Za-z0-9_-]{11}", video_id or ""):
            raise CobaltUnavailable("no video id")
        started = time.monotonic()
        reason = "no instance answered"
        for instance in self.instances:
            left = self.timeout if budget is None else min(self.timeout, budget - (time.monotonic() - started))
            if left <= 0.3:
                reason = "out of time"
                break
            self.attempts += 1
            try:
                info = self._ask(instance, video_id, left, transport)
            except CobaltUnavailable as exc:
                reason = str(exc)
                if reason.startswith(_CLIENT_ERRORS_TO_SKIP):
                    break
                continue
            self.successes += 1
            self.last_error = None
            return info
        self.last_error = reason
        raise CobaltUnavailable(reason)

    def _ask(self, instance: str, video_id: str, timeout: float, transport: httpx.BaseTransport | None) -> dict:
        headers = {"Accept": "application/json", "Content-Type": "application/json", "User-Agent": "savereelsfast-scraper"}
        if self.api_key:
            headers["Authorization"] = f"Api-Key {self.api_key}"
        body = {
            "url": f"https://www.youtube.com/watch?v={video_id}",
            "videoQuality": "1080",
            "youtubeVideoCodec": "h264",  # plays everywhere; the default (vp9/av1) does not on many phones
            "filenameStyle": "basic",
            "downloadMode": "auto",
        }
        try:
            with httpx.Client(timeout=timeout, follow_redirects=False, transport=transport) as client:
                with client.stream("POST", instance, headers=headers, json=body) as response:
                    raw = b""
                    for chunk in response.iter_bytes():
                        raw += chunk
                        if len(raw) > MAX_RESPONSE_BYTES:
                            raise CobaltUnavailable("response too large")
                    status_code = response.status_code
        except httpx.TimeoutException:
            raise CobaltUnavailable("timeout")
        except httpx.HTTPError as exc:
            raise CobaltUnavailable(f"connection failed ({type(exc).__name__})")
        try:
            data = httpx.Response(status_code, content=raw).json()
        except ValueError:
            raise CobaltUnavailable(f"HTTP {status_code}, not JSON")
        if not isinstance(data, dict):
            raise CobaltUnavailable("unexpected answer")
        status = data.get("status")
        if status == "error":
            code = (data.get("error") or {}).get("code") if isinstance(data.get("error"), dict) else None
            raise CobaltUnavailable(str(code or "error")[:80])
        if status_code != 200:
            raise CobaltUnavailable(f"HTTP {status_code}")
        if status not in ("tunnel", "redirect"):
            raise CobaltUnavailable(f"unsupported answer ({str(status)[:20]})")
        link = data.get("url")
        if not isinstance(link, str) or not self._trusted(link, instance, status):
            raise CobaltUnavailable("untrusted download link")
        return _info(video_id, link, data.get("filename"))

    def _trusted(self, link: str, instance: str, status: str) -> bool:
        if status == "redirect":
            return is_allowed_media_url(link)
        try:
            parsed = urlparse(link)
            same = (parsed.hostname or "").lower() == (urlparse(instance).hostname or "").lower() and parsed.port == urlparse(instance).port
        except ValueError:
            return False
        return parsed.scheme == "https" and same


def _info(video_id: str, link: str, filename) -> dict:
    height = width = None
    match = re.search(r"(\d{3,4})x(\d{3,4})", filename) if isinstance(filename, str) else None
    if match:
        width, height = int(match.group(1)), int(match.group(2))
    return {
        "id": video_id,
        "title": None,  # Cobalt does not report one
        "thumbnail": f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg",
        "formats": [
            {
                "format_id": "cobalt",
                "url": link,
                "ext": "mp4",
                "protocol": "https",
                "vcodec": "h264",
                "acodec": "aac",  # "auto" mode returns audio and video together
                "height": height,
                "width": width,
            }
        ],
        "_via": "cobalt",
    }
