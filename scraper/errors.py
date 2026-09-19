"""Machine-readable failure codes shared by /extract and /download."""

import re

LOGIN_REQUIRED = "LOGIN_REQUIRED"
UNSUPPORTED_POST = "UNSUPPORTED_POST"
STREAM_EXPIRED_OR_BLOCKED = "STREAM_EXPIRED_OR_BLOCKED"
PLATFORM_TIMEOUT = "PLATFORM_TIMEOUT"
EXTRACTION_FAILED = "EXTRACTION_FAILED"
INVALID_URL = "INVALID_URL"

# NO_AUDIO is not a failure: it is a warning attached to a successful result
# when only a video-only stream could be offered.
NO_AUDIO = "NO_AUDIO"

STATUS = {
    LOGIN_REQUIRED: 403,
    UNSUPPORTED_POST: 422,
    STREAM_EXPIRED_OR_BLOCKED: 502,
    PLATFORM_TIMEOUT: 504,
    EXTRACTION_FAILED: 404,
    INVALID_URL: 400,
}

MESSAGES = {
    LOGIN_REQUIRED: "This post is private, age-restricted, or requires login. Try a public link.",
    UNSUPPORTED_POST: "This post has no video. Only video posts are supported.",
    STREAM_EXPIRED_OR_BLOCKED: "The platform blocked or expired this video's download link.",
    PLATFORM_TIMEOUT: "The platform didn't respond in time. Please try again shortly.",
    EXTRACTION_FAILED: "Couldn't extract this video. It may be private, deleted, or region-restricted.",
    INVALID_URL: "Please provide a supported video URL.",
}

# Order matters: the first matching group wins.
_PATTERNS: list[tuple[str, re.Pattern]] = [
    # Datacenter / bot checks look like login walls but are really IP blocks.
    (
        STREAM_EXPIRED_OR_BLOCKED,
        re.compile(
            r"not a bot|confirm you.?re not a bot|http error (403|429)|\b403\b.*forbidden|"
            r"too many requests|rate.?limit|captcha|access denied|\bip\b.{0,30}blocked|blocked.{0,30}\bip\b|"
            r"expired|signature",
            re.I,
        ),
    ),
    (
        PLATFORM_TIMEOUT,
        re.compile(
            r"timed? ?out|timeout|connection (reset|refused|aborted)|temporary failure|"
            r"name or service not known|network is unreachable|http error 5\d\d|"
            r"remote end closed|read error|getaddrinfo|unable to connect|"
            r"transporterror|urlopen error",
            re.I,
        ),
    ),
    (
        LOGIN_REQUIRED,
        re.compile(
            r"log ?in|sign ?in|private|authenticat|cookies|age.?restrict|confirm your age|"
            r"inappropriate for some|members.only|protected (tweets?|account)|nsfw|"
            r"empty media response|requires? (an )?account|only available for registered",
            re.I,
        ),
    ),
    (
        UNSUPPORTED_POST,
        re.compile(
            r"no video|does not contain any video|isn.t a video|not a video|"
            r"no media|there is no video|no formats? (found|available)|"
            r"unsupported url|only.*(photo|image)|text post",
            re.I,
        ),
    ),
]


def classify_failure(text: str) -> str:
    """Map a yt-dlp / network error message to one of the machine codes."""
    for code, pattern in _PATTERNS:
        if pattern.search(text or ""):
            return code
    return EXTRACTION_FAILED


class ScraperError(Exception):
    """An error with a machine code, user-facing message and HTTP status."""

    def __init__(self, code: str, message: str | None = None):
        self.code = code
        self.message = message or MESSAGES.get(code, MESSAGES[EXTRACTION_FAILED])
        self.status = STATUS.get(code, 400)
        super().__init__(self.message)

    def detail(self) -> dict:
        return {"code": self.code, "message": self.message}
