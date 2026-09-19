"""URL validation, cleaning and short-link expansion for the supported platforms.

Kept free of FastAPI/yt-dlp imports so it can be unit-tested on its own.
"""

import re
import urllib.error
import urllib.request
from typing import Callable
from urllib.parse import parse_qsl, urlencode, urljoin, urlparse, urlunparse

BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

# yt-dlp (and our own fetches) are only ever pointed at these platforms.
ALLOWED_DOMAINS = (
    "instagram.com",
    "youtube.com",
    "youtu.be",
    "facebook.com",
    "fb.watch",
    "threads.net",
    "threads.com",
    "twitter.com",
    "x.com",
    "pinterest.com",
    "pin.it",
    "tiktok.com",
    "reddit.com",
    "redd.it",
    "snapchat.com",
)
PINTEREST_COUNTRY_HOST = re.compile(r"(^|\.)pinterest\.[a-z]{2,3}(\.[a-z]{2})?$")

# Hosts whose links are redirects to the real post and must be followed first.
SHORTLINK_HOSTS = (
    "pin.it",
    "vm.tiktok.com",
    "vt.tiktok.com",
    "fb.watch",
    "redd.it",  # also covers v.redd.it
    "t.snapchat.com",
)
# Paths that are share redirects: /share/…, and Reddit's /r/<sub>/s/<id>.
SHARE_PATH_REGEX = re.compile(r"(^|/)share(/|$)|/s/[A-Za-z0-9]+/?$", re.I)

POST_PATH_REGEX = re.compile(r"(?:^|/)(reel|reels|p|tv)/([A-Za-z0-9_-]+)", re.I)

TRACKING_PARAMS = {
    "igsh", "igshid", "si", "feature", "fbclid", "gclid", "s", "t", "ref",
    "ref_src", "ref_url", "mibextid", "share_id", "is_from_webapp",
    "sender_device", "_r", "_t", "u_code", "xmt",
}

UNSUPPORTED_MESSAGE = (
    "Please provide a supported video URL (Instagram, YouTube, Facebook, "
    "Threads, X, Pinterest, TikTok, Reddit or Snapchat)."
)


class UnsupportedUrl(ValueError):
    """The link is malformed or not from a supported platform."""


def _host_matches(host: str, domain: str) -> bool:
    return host == domain or host.endswith("." + domain)


def host_allowed(host: str) -> bool:
    host = (host or "").lower()
    return any(_host_matches(host, d) for d in ALLOWED_DOMAINS) or bool(
        PINTEREST_COUNTRY_HOST.search(host)
    )


def is_threads_host(host: str) -> bool:
    host = (host or "").lower()
    return _host_matches(host, "threads.net") or _host_matches(host, "threads.com")


def needs_expansion(url: str) -> bool:
    """True for short links and share links that redirect to the real post."""
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    if any(_host_matches(host, h) for h in SHORTLINK_HOSTS):
        return True
    return bool(SHARE_PATH_REGEX.search(parsed.path))


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Surface 3xx responses as HTTPError so each hop can be checked by hand."""

    def redirect_request(self, *args, **kwargs):  # noqa: D401
        return None


def expand_redirects(
    url: str,
    host_ok: Callable[[str], bool] = host_allowed,
    max_hops: int = 5,
    timeout: float = 8.0,
) -> str:
    """
    Follow HTTP redirects manually and return the final URL.

    Every hop must stay on an allowed host (``host_ok``), so a short link can
    never be used to make the server fetch an arbitrary address. If anything
    goes wrong (timeout, 4xx/5xx, bot wall) the last good URL is returned and
    yt-dlp gets a chance to resolve it on its own.
    """
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect)
    current = url

    for _ in range(max_hops):
        host = urlparse(current).hostname or ""
        if not host_ok(host):
            raise UnsupportedUrl("That link redirects to an unsupported site.")

        request = urllib.request.Request(
            current,
            headers={"User-Agent": BROWSER_UA, "Accept": "text/html,*/*;q=0.8"},
        )
        try:
            with opener.open(request, timeout=timeout):
                return current  # 2xx: this is the final page
        except urllib.error.HTTPError as err:
            if err.code not in (301, 302, 303, 307, 308):
                return current
            location = err.headers.get("Location")
            if not location:
                return current
            target = urljoin(current, location)
            # Don't follow into login / consent walls; keep the last real URL.
            if re.search(r"/(login|consent|accounts/login)", urlparse(target).path, re.I):
                return current
            current = target
        except (urllib.error.URLError, OSError, TimeoutError):
            return current

    return current


def normalize_url(url: str) -> str:
    """Validate the host and strip tracking parameters / fragments from the link."""
    parsed = urlparse(url.strip())
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise UnsupportedUrl(UNSUPPORTED_MESSAGE)
    if not host_allowed(parsed.hostname):
        raise UnsupportedUrl(UNSUPPORTED_MESSAGE)

    host = parsed.hostname.lower()
    if _host_matches(host, "instagram.com"):
        if re.search(r"(^|/)share(/|$)", parsed.path, re.I):
            raise UnsupportedUrl("Couldn't resolve this Instagram share link.")
        match = POST_PATH_REGEX.search(parsed.path)
        if not match:
            raise UnsupportedUrl(UNSUPPORTED_MESSAGE)
        kind = "reel" if match.group(1).lower() == "reels" else match.group(1).lower()
        return f"https://www.instagram.com/{kind}/{match.group(2)}/"

    query = [
        (k, v)
        for k, v in parse_qsl(parsed.query, keep_blank_values=True)
        if not k.lower().startswith("utm_") and k.lower() not in TRACKING_PARAMS
    ]
    return urlunparse(parsed._replace(query=urlencode(query), fragment=""))


def resolve_url(url: str, expand: Callable[[str], str] = expand_redirects) -> str:
    """Validate, expand short/share links, and return the clean canonical URL."""
    first = urlparse(url.strip())
    if first.scheme not in ("http", "https") or not host_allowed(first.hostname or ""):
        raise UnsupportedUrl(UNSUPPORTED_MESSAGE)

    if needs_expansion(url):
        url = expand(url)
    return normalize_url(url)
