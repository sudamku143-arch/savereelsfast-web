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


MAX_URL_LENGTH = 2048


def check_url_shape(url: str) -> None:
    """
    Reject links that are suspicious in form, before anything is fetched.

    No control characters, whitespace or backslashes (parser-confusion tricks such as
    ``https://good.example\\@evil.example``), no embedded credentials
    (``https://youtube.com@evil.example/``), no custom ports, and a sane length.
    """
    if not isinstance(url, str) or not url or len(url) > MAX_URL_LENGTH:
        raise UnsupportedUrl(UNSUPPORTED_MESSAGE)
    if re.search(r"[\x00-\x20\x7f\\]", url):
        raise UnsupportedUrl(UNSUPPORTED_MESSAGE)
    try:
        parsed = urlparse(url)
        port = parsed.port
    except ValueError:  # e.g. a non-numeric port
        raise UnsupportedUrl(UNSUPPORTED_MESSAGE)
    if parsed.username is not None or parsed.password is not None:
        raise UnsupportedUrl(UNSUPPORTED_MESSAGE)
    if port not in (None, 80, 443):
        raise UnsupportedUrl(UNSUPPORTED_MESSAGE)


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
        if host_ok is host_allowed:  # the tests use a local server, which has a port
            check_url_shape(current)

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


def _strip_tracking(parsed) -> str:
    query = [
        (k, v)
        for k, v in parse_qsl(parsed.query, keep_blank_values=True)
        if not k.lower().startswith("utm_") and k.lower() not in TRACKING_PARAMS
    ]
    return urlunparse(parsed._replace(query=urlencode(query), fragment=""))


def cache_key(url: str) -> str:
    """
    Stable cache key for a pasted link, computed WITHOUT any network call.

    Full links use their normalized form, so tracking-parameter variants of the
    same video share one entry. Short/share links are keyed by the link itself
    (stripped of tracking), so repeat requests for a viral short link are hits
    even though resolving it would need a redirect lookup.
    """
    check_url_shape(url.strip())
    parsed = urlparse(url.strip())
    if parsed.scheme not in ("http", "https") or not host_allowed(parsed.hostname or ""):
        raise UnsupportedUrl(UNSUPPORTED_MESSAGE)
    if needs_expansion(url):
        return _strip_tracking(parsed)
    return normalize_url(url)


def normalize_url(url: str) -> str:
    """Validate the host and strip tracking parameters / fragments from the link."""
    check_url_shape(url.strip())
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

    return _strip_tracking(parsed)


def resolve_url(url: str, expand: Callable[[str], str] = expand_redirects) -> str:
    """Validate, expand short/share links, and return the clean canonical URL."""
    check_url_shape(url.strip())
    first = urlparse(url.strip())
    if first.scheme not in ("http", "https") or not host_allowed(first.hostname or ""):
        raise UnsupportedUrl(UNSUPPORTED_MESSAGE)

    if needs_expansion(url):
        url = expand(url)
    return normalize_url(url)


# CDN hosts we are willing to fetch/proxy (kept in sync with MEDIA_HOST_SUFFIXES in
# reels-extractor/lib/instagram.ts; tests/test_stream.py checks the two lists match).
MEDIA_HOST_SUFFIXES = (
    "cdninstagram.com",
    "fbcdn.net",
    "googlevideo.com",
    "ytimg.com",
    "twimg.com",
    "pinimg.com",
    "tiktokcdn.com",
    "tiktokcdn-us.com",
    "tiktokv.com",
    "tiktokv.us",
    "tiktok.com",
    "byteoversea.com",
    "ibytedtos.com",
    "muscdn.com",
    "redd.it",
    "redditmedia.com",
    "sc-cdn.net",
)


def is_allowed_media_url(raw: str) -> bool:
    """https-only, no explicit port, host must be a known platform CDN."""
    try:
        parsed = urlparse(raw)
        port = parsed.port
    except ValueError:
        return False
    if parsed.scheme != "https" or port or not parsed.hostname:
        return False
    host = parsed.hostname.lower()
    return any(_host_matches(host, suffix) for suffix in MEDIA_HOST_SUFFIXES)


def referer_for(media_url: str) -> str:
    """The Referer a platform's CDN expects."""
    host = (urlparse(media_url).hostname or "").lower()
    if re.search(r"tiktok|byteoversea|ibytedtos|muscdn", host):
        return "https://www.tiktok.com/"
    if host.endswith("googlevideo.com") or host.endswith("ytimg.com"):
        return "https://www.youtube.com/"
    if host.endswith("twimg.com"):
        return "https://x.com/"
    if host.endswith("pinimg.com"):
        return "https://www.pinterest.com/"
    if host.endswith("redd.it") or host.endswith("redditmedia.com"):
        return "https://www.reddit.com/"
    if host.endswith("sc-cdn.net"):
        return "https://www.snapchat.com/"
    return "https://www.instagram.com/"


def safe_referer(requested: str | None, media_url: str) -> str:
    """Use the caller's Referer only if it is a supported platform page; else the default."""
    if requested:
        parsed = urlparse(requested)
        if parsed.scheme in ("http", "https") and host_allowed(parsed.hostname or ""):
            return requested
    return referer_for(media_url)
