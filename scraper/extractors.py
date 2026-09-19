"""Extractors for platforms that yt-dlp has no extractor for (currently Threads)."""

import html
import json
import re
import urllib.error
import urllib.request

# Meta serves server-rendered Open Graph tags to link-preview crawlers, while
# regular browsers get a JavaScript shell.
CRAWLER_UA = "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)"

_META_TAG = re.compile(r"<meta\b[^>]*>", re.I)
_ATTR = re.compile(r'(property|name|content)\s*=\s*(?:"([^"]*)"|\'([^\']*)\')', re.I)
_VIDEO_VERSIONS = re.compile(r'"video_versions"\s*:\s*(\[[^\]]*\])')


def _meta(page: str, key: str) -> str | None:
    for tag in _META_TAG.findall(page):
        attrs = {m.group(1).lower(): (m.group(2) or m.group(3) or "") for m in _ATTR.finditer(tag)}
        if attrs.get("property") == key or attrs.get("name") == key:
            value = attrs.get("content")
            if value:
                return html.unescape(value)
    return None


def extract_threads(url: str, timeout: float = 12.0) -> dict | None:
    """
    Best-effort extraction of a public Threads video post.

    Returns a yt-dlp-shaped info dict ({"id", "title", "thumbnail", "formats"})
    or None when the post has no video or the page exposes nothing usable.
    """
    request = urllib.request.Request(
        url,
        headers={"User-Agent": CRAWLER_UA, "Accept": "text/html,*/*;q=0.8"},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as resp:
            page = resp.read(3_000_000).decode("utf-8", errors="replace")
    except (urllib.error.URLError, OSError, TimeoutError):
        return None

    formats: list[dict] = []

    # 1. Structured JSON embedded in the page.
    match = _VIDEO_VERSIONS.search(page)
    if match:
        try:
            for item in json.loads(match.group(1)):
                if isinstance(item, dict) and item.get("url"):
                    formats.append(
                        {
                            "format_id": str(item.get("type", "mp4")),
                            "url": item["url"],
                            "ext": "mp4",
                            "vcodec": "unknown",
                            "acodec": None,
                            "width": item.get("width"),
                            "height": item.get("height"),
                            "protocol": "https",
                        }
                    )
        except (ValueError, TypeError):
            pass

    # 2. Open Graph fallback.
    if not formats:
        og_video = _meta(page, "og:video:secure_url") or _meta(page, "og:video")
        if og_video:
            formats.append(
                {
                    "format_id": "og",
                    "url": og_video,
                    "ext": "mp4",
                    "vcodec": "unknown",
                    "acodec": None,
                    "protocol": "https",
                }
            )

    if not formats:
        return None

    post_id = re.search(r"/(?:post|t)/([A-Za-z0-9_-]+)", url)
    return {
        "id": post_id.group(1) if post_id else None,
        "title": _meta(page, "og:description") or _meta(page, "og:title"),
        "uploader": None,
        "thumbnail": _meta(page, "og:image"),
        "duration": None,
        "formats": formats,
    }
