"""
Telegram bot for SaveReelsFast (@savereelsfast_bot): long polling, running inside the scraper process.

Set TELEGRAM_BOT_TOKEN on the host (never in code). Without it nothing here starts.

  * Plain httpx, no extra dependency: a polling loop needs only getUpdates / sendMessage / sendVideo, and
    this keeps the memory cost of the bot to a few MB.
  * It never imports the FastAPI app. The app hands it a `fetch` function (link -> Media), so a bug or an
    outage on the Telegram side can only ever fail Telegram jobs, never the website's API.
  * Videos are streamed to a temporary file in small chunks and uploaded from disk, so RAM stays flat however
    large the video is. Telegram accepts uploads of up to 50 MB from bots; a bigger video is answered with a
    direct link instead.
  * Only ONE instance may poll a token. A second one (a local test, an overlapping deploy) gets HTTP 409 from
    Telegram; the bot notices, waits and retries instead of crashing.
"""

import asyncio
import logging
import os
import re
import tempfile
import time
from collections import OrderedDict
from dataclasses import dataclass
from typing import Awaitable, Callable
from urllib.parse import urlparse

import httpx

from urls import host_allowed

log = logging.getLogger("uvicorn.error")

WELCOME = (
    "Welcome to SaveReelsFast! Paste any video link (Instagram, YouTube, TikTok, Facebook, Reddit, etc.) "
    "to download."
)
FOOTER = "⚡ Downloaded via https://savereelsfast.com"

API_BASE = "https://api.telegram.org"
MAX_UPLOAD_BYTES = 50 * 1024 * 1024  # Telegram's limit for a file a bot uploads
POLL_TIMEOUT_SECONDS = 25  # long poll: Telegram holds the request open until a message arrives
JOB_TIMEOUT_SECONDS = 90  # a whole download + upload
MAX_CONCURRENT_JOBS = 2
TEMP_PREFIX = "srf-tg-"

HINT = (
    "Send me a link to a video and I'll download it for you. Supported: Instagram, YouTube, TikTok, Facebook, "
    "X (Twitter), Reddit, Pinterest, Threads and Snapchat."
)
UNSUPPORTED = (
    "That doesn't look like a supported video link. I can download from Instagram, YouTube, TikTok, Facebook, "
    "X (Twitter), Reddit, Pinterest, Threads and Snapchat."
)
BUSY = "I'm a bit busy right now. Please try again in a few seconds."
STILL_WORKING = "I'm still working on your previous link. One moment!"
SLOW_DOWN = "You're sending links very quickly. Please wait a minute and try again."
TOO_SLOW = "That took too long. Please try again."
GENERIC_FAILURE = "Sorry, something went wrong with that link. Please try again in a moment."
TOO_LARGE = "This video is too large to send here (Telegram's limit is 50 MB), but you can download it with this link:"
LINK_ONLY = "Here is your video link:"


class BotUserError(Exception):
    """A failure whose message is fit to show the person who sent the link."""

    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


@dataclass
class Media:
    """What the app found for a link."""

    title: str | None = None
    media_url: str | None = None  # direct link on the platform's CDN
    path: str | None = None  # temporary file holding the video, when it fitted within the upload limit
    size: int = 0
    audio: str = "unknown"  # "yes" | "no" | "unknown"


Fetch = Callable[[str], Awaitable[Media]]


class TelegramError(Exception):
    def __init__(self, code: int, description: str):
        super().__init__(f"Telegram error {code}: {description}")
        self.code = code
        self.description = description


class ConflictError(TelegramError):
    """Another process is polling this token (HTTP 409)."""


class UnauthorizedError(TelegramError):
    """The token is wrong or was revoked (HTTP 401)."""


# --------------------------------------------------------------------------------------- pure helpers

_TOKEN_IN_TEXT = re.compile(r"bot\d{5,}:[\w-]{20,}")
_TRAILING = ".,;:!?)]}>»\"'”’"
_LEADING = "([{<«\"'“‘"


def redact(text: str, token: str | None = None) -> str:
    """Remove the bot token from any text before it is logged: Telegram puts it in every request address."""
    text = _TOKEN_IN_TEXT.sub("bot<token>", str(text))
    return text.replace(token, "<token>") if token else text


def valid_token(token: str) -> bool:
    return bool(re.fullmatch(r"\d{5,}:[\w-]{20,}", token or ""))


def find_link(text: str) -> tuple[str | None, bool]:
    """
    (supported link, saw_a_link_we_do_not_support) for a message.

    Accepts links with or without "https://". Only platforms the site supports count; the link is not
    fetched here, so nothing about it is trusted yet.
    """
    saw_other = False
    for word in (text or "").split():
        word = word.strip().lstrip(_LEADING).rstrip(_TRAILING)
        if not word:
            continue
        if not re.match(r"https?://", word, re.I):
            if "." not in word or "/" not in word:
                continue
            word = "https://" + word
        try:
            host = urlparse(word).hostname or ""
        except ValueError:
            continue
        if not host or "." not in host:
            continue
        if host_allowed(host):
            return word, False
        saw_other = True
    return None, saw_other


def command_of(text: str) -> str | None:
    """"/start@savereelsfast_bot now" -> "/start"; None if the message is not a command."""
    if not text or not text.startswith("/"):
        return None
    return text.split()[0].split("@")[0].lower()


class ChatLimiter:
    """One job at a time per chat, and a cap per minute, so one person cannot fill the queue."""

    def __init__(self, per_minute: int = 6, max_chats: int = 2000, clock: Callable[[], float] = time.monotonic):
        self.per_minute = per_minute
        self.max_chats = max_chats
        self._clock = clock
        self._recent: "OrderedDict[int, list[float]]" = OrderedDict()
        self._running: set[int] = set()

    def begin(self, chat_id: int) -> str:
        """"ok" (and the job is now counted), "busy" (already running one) or "slow" (too many this minute)."""
        if chat_id in self._running:
            return "busy"
        now = self._clock()
        recent = [t for t in self._recent.get(chat_id, []) if now - t < 60]
        if len(recent) >= self.per_minute:
            self._recent[chat_id] = recent
            return "slow"
        recent.append(now)
        self._recent[chat_id] = recent
        self._recent.move_to_end(chat_id)
        while len(self._recent) > self.max_chats:  # bounded memory however many people write
            self._recent.popitem(last=False)
        self._running.add(chat_id)
        return "ok"

    def end(self, chat_id: int) -> None:
        self._running.discard(chat_id)


def remove_stale_files(max_age_seconds: float = 3600) -> int:
    """Delete leftovers of jobs that were cut off (a restart mid-upload). Returns how many were removed."""
    removed = 0
    directory = tempfile.gettempdir()
    try:
        names = os.listdir(directory)
    except OSError:
        return 0
    for name in names:
        if not name.startswith(TEMP_PREFIX):
            continue
        path = os.path.join(directory, name)
        try:
            if time.time() - os.path.getmtime(path) > max_age_seconds:
                os.unlink(path)
                removed += 1
        except OSError:
            pass
    return removed


def delete_quietly(path: str | None) -> None:
    if not path:
        return
    try:
        os.unlink(path)
    except OSError:
        pass


# --------------------------------------------------------------------------------------------- the bot


class TelegramBot:
    def __init__(
        self,
        token: str,
        fetch: Fetch,
        *,
        client: httpx.AsyncClient | None = None,
        max_jobs: int = MAX_CONCURRENT_JOBS,
        limiter: ChatLimiter | None = None,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ):
        self._token = token
        self._fetch = fetch
        self._client = client
        self._owns_client = client is None
        self._jobs = asyncio.Semaphore(max_jobs)
        self._limiter = limiter or ChatLimiter()
        self._sleep = sleep
        self._tasks: set[asyncio.Task] = set()
        self._last_conflict_log = 0.0
        self.stats = {"polls": 0, "messages": 0, "sent": 0, "failed": 0}

    # ------------------------------------------------------------------ Telegram API

    def _http(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=httpx.Timeout(15.0, read=POLL_TIMEOUT_SECONDS + 10))
        return self._client

    async def _call(self, method: str, data: dict | None = None, files: dict | None = None, timeout=None):
        """One Bot API call. Returns the "result"; raises TelegramError (or a subclass) on an API error."""
        kwargs = {"data": {k: v for k, v in (data or {}).items() if v is not None}}
        if files:
            kwargs["files"] = files
        if timeout is not None:
            kwargs["timeout"] = timeout
        response = await self._http().post(f"{API_BASE}/bot{self._token}/{method}", **kwargs)
        try:
            body = response.json()
        except ValueError:
            raise TelegramError(response.status_code, "unreadable response")
        if body.get("ok"):
            return body.get("result")
        code = int(body.get("error_code") or response.status_code)
        description = str(body.get("description") or "")
        if code == 409:
            raise ConflictError(code, description)
        if code == 401:
            raise UnauthorizedError(code, description)
        raise TelegramError(code, description)

    async def send_text(self, chat_id: int, text: str, reply_to: int | None = None) -> None:
        try:
            await self._call(
                "sendMessage",
                {
                    "chat_id": chat_id,
                    "text": text[:4000],
                    "reply_to_message_id": reply_to,
                    "allow_sending_without_reply": "true",
                    "disable_web_page_preview": "true",  # a raw CDN address is not worth a preview
                },
            )
        except (TelegramError, httpx.HTTPError) as exc:
            log.warning("Telegram: could not send a message: %s", redact(exc, self._token))

    async def _typing(self, chat_id: int, action: str) -> None:
        try:
            await self._call("sendChatAction", {"chat_id": chat_id, "action": action})
        except (TelegramError, httpx.HTTPError):
            pass  # cosmetic

    # ------------------------------------------------------------------ handling one message

    async def handle_update(self, update: dict) -> None:
        message = update.get("message") or {}
        chat_id = (message.get("chat") or {}).get("id")
        if chat_id is None:
            return
        self.stats["messages"] += 1
        message_id = message.get("message_id")
        text = message.get("text") or message.get("caption") or ""

        command = command_of(text)
        if command in ("/start", "/help"):
            await self.send_text(chat_id, WELCOME)
            return
        if command:
            await self.send_text(chat_id, HINT)
            return

        link, saw_other = find_link(text)
        if not link:
            await self.send_text(chat_id, UNSUPPORTED if saw_other else HINT, message_id)
            return
        await self._process(chat_id, link, message_id)

    async def _process(self, chat_id: int, link: str, reply_to: int | None) -> None:
        verdict = self._limiter.begin(chat_id)
        if verdict == "busy":
            await self.send_text(chat_id, STILL_WORKING, reply_to)
            return
        if verdict == "slow":
            await self.send_text(chat_id, SLOW_DOWN, reply_to)
            return

        media: Media | None = None
        try:
            try:
                await asyncio.wait_for(self._jobs.acquire(), timeout=15)
            except asyncio.TimeoutError:
                await self.send_text(chat_id, BUSY, reply_to)
                return
            try:
                await self._typing(chat_id, "upload_video")
                media = await asyncio.wait_for(self._fetch(link), timeout=JOB_TIMEOUT_SECONDS)
                await self._deliver(chat_id, media, reply_to)
                self.stats["sent"] += 1
            except BotUserError as err:
                self.stats["failed"] += 1
                await self.send_text(chat_id, err.message, reply_to)
            except asyncio.TimeoutError:
                self.stats["failed"] += 1
                await self.send_text(chat_id, TOO_SLOW, reply_to)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - one bad job must never stop the bot
                self.stats["failed"] += 1
                log.warning("Telegram: job failed: %s: %s", type(exc).__name__, redact(exc, self._token))
                await self.send_text(chat_id, GENERIC_FAILURE, reply_to)
            finally:
                self._jobs.release()
        finally:
            delete_quietly(media.path if media else None)
            self._limiter.end(chat_id)

    async def _deliver(self, chat_id: int, media: Media, reply_to: int | None) -> None:
        title = (media.title or "").strip().replace("\n", " ")
        note = "\n(This clip has no audio track.)" if media.audio == "no" else ""
        caption = (f"{title[:300]}\n\n" if title else "") + FOOTER + note

        if media.path:
            for method, field in (("sendVideo", "video"), ("sendDocument", "document")):
                try:
                    with open(media.path, "rb") as handle:  # streamed from disk in chunks, not read into RAM
                        await self._call(
                            method,
                            {
                                "chat_id": chat_id,
                                "caption": caption,
                                "reply_to_message_id": reply_to,
                                "allow_sending_without_reply": "true",
                                "supports_streaming": "true" if method == "sendVideo" else None,
                            },
                            files={field: ("savereelsfast.mp4", handle, "video/mp4")},
                            timeout=httpx.Timeout(20.0, read=180.0, write=180.0),
                        )
                    return
                except TelegramError as exc:
                    # sendVideo refuses some encodings; as a plain file it always works.
                    log.info("Telegram: %s refused (%s)", method, redact(exc.description, self._token))
            # both refused: fall through to the link

        if media.media_url:
            lead = TOO_LARGE if not media.path and media.size > MAX_UPLOAD_BYTES else LINK_ONLY
            await self.send_text(chat_id, f"{lead}\n{media.media_url}\n\n{FOOTER}{note}", reply_to)
            return
        raise BotUserError(GENERIC_FAILURE)

    # ------------------------------------------------------------------ polling

    def _spawn(self, coroutine) -> None:
        task = asyncio.ensure_future(coroutine)
        self._tasks.add(task)

        def done(finished: asyncio.Task) -> None:
            self._tasks.discard(finished)
            if not finished.cancelled() and finished.exception():
                log.warning("Telegram: handler error: %s", redact(finished.exception(), self._token))

        task.add_done_callback(done)

    async def _prepare(self) -> None:
        """A webhook would block getUpdates, so make sure none is set; register the command list."""
        for method, data in (
            ("deleteWebhook", {"drop_pending_updates": "false"}),
            ("setMyCommands", {"commands": '[{"command":"start","description":"How to use the bot"},'
                                           '{"command":"help","description":"How to use the bot"}]'}),
        ):
            try:
                await self._call(method, data)
            except UnauthorizedError:
                raise
            except (TelegramError, httpx.HTTPError) as exc:
                log.info("Telegram: %s skipped: %s", method, redact(exc, self._token))

    async def _poll_once(self, offset: int | None) -> tuple[list[dict], int | None]:
        updates = await self._call(
            "getUpdates",
            {"timeout": POLL_TIMEOUT_SECONDS, "offset": offset, "allowed_updates": '["message"]'},
            timeout=httpx.Timeout(15.0, read=POLL_TIMEOUT_SECONDS + 10),
        )
        self.stats["polls"] += 1
        for update in updates or []:
            offset = int(update["update_id"]) + 1
        return updates or [], offset

    async def _poll_loop(self) -> None:
        await self._prepare()
        offset: int | None = None
        backoff = 1.0
        while True:
            began = time.monotonic()
            try:
                updates, offset = await self._poll_once(offset)
            except ConflictError:
                now = time.monotonic()
                if now - self._last_conflict_log > 300:
                    self._last_conflict_log = now
                    log.warning("Telegram: another process is polling this bot token; waiting. Run only one instance.")
                await self._sleep(15)
                continue
            except UnauthorizedError:
                raise
            except (TelegramError, httpx.HTTPError) as exc:
                log.warning("Telegram: polling problem (%s); retrying in %ds", redact(exc, self._token), backoff)
                await self._sleep(backoff)
                backoff = min(backoff * 2, 30.0)
                continue
            backoff = 1.0
            for update in updates:
                self._spawn(self.handle_update(update))
            if not updates and time.monotonic() - began < 1.0:
                # A long poll should hold for ~25 s. An instant empty answer means something upstream is
                # misbehaving; pausing (and yielding to the rest of the app) stops a hot loop.
                await self._sleep(1.0)

    async def run_forever(self) -> None:
        """Poll until cancelled. Anything unexpected is logged and retried; nothing here can take the app down."""
        remove_stale_files()
        delay = 2.0
        try:
            while True:
                try:
                    await self._poll_loop()
                except UnauthorizedError:
                    log.error("Telegram: the bot token was rejected (revoked or wrong). The bot is switched off.")
                    return
                except asyncio.CancelledError:
                    raise
                except Exception as exc:  # noqa: BLE001
                    log.warning("Telegram: poller restarting after %s: %s", type(exc).__name__, redact(exc, self._token))
                    await self._sleep(delay)
                    delay = min(delay * 2, 60.0)
        finally:
            await self.close()

    async def close(self) -> None:
        for task in list(self._tasks):
            task.cancel()
        if self._tasks:
            await asyncio.gather(*self._tasks, return_exceptions=True)
        if self._owns_client and self._client is not None:
            await self._client.aclose()
            self._client = None
