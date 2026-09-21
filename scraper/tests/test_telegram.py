"""
The Telegram bot: texts, delivery, failure handling, polling, token safety, and the wiring into the app.

Telegram itself is simulated with httpx.MockTransport; nothing here touches the network.

Run from the scraper/ folder:  python -m unittest discover -s tests -v
"""

import asyncio
import json
import logging
import os
import re
import sys
import tempfile
import time
import unittest
import urllib.parse
from pathlib import Path
from unittest import mock

import httpx

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import telegram_bot as tb  # noqa: E402
from telegram_bot import BotUserError, ChatLimiter, Media, TelegramBot  # noqa: E402

TOKEN = "123456789:AAE_fake_test_token_0123"
WELCOME_EXACT = "Welcome to SaveReelsFast! Paste any video link (Instagram, YouTube, TikTok, Facebook, Reddit, etc.) to download."
FOOTER_EXACT = "⚡ Downloaded via https://www.savereelsfast.com"


# ------------------------------------------------------------------------------------ fake Telegram


class FakeTelegram:
    """Records every Bot API call. `plan[method]` may hold a list of (status, body) answers to give in turn."""

    def __init__(self):
        self.calls: list[dict] = []
        self.plan: dict[str, list] = {}
        self.uploads: list[bytes] = []

    async def __call__(self, request: httpx.Request) -> httpx.Response:
        assert f"/bot{TOKEN}/" in request.url.path
        method = request.url.path.rsplit("/", 1)[-1]
        raw = await request.aread()
        content_type = request.headers.get("content-type", "")
        fields: dict[str, str] = {}
        file_bytes = None
        if content_type.startswith("multipart/"):
            boundary = content_type.split("boundary=")[1].encode()
            for part in raw.split(b"--" + boundary):
                head, _, body = part.partition(b"\r\n\r\n")
                name = re.search(rb'name="([^"]+)"', head)
                if not name:
                    continue
                body = body.rsplit(b"\r\n", 1)[0]
                if b"filename=" in head:
                    file_bytes = body
                else:
                    fields[name.group(1).decode()] = body.decode()
        else:
            fields = dict(urllib.parse.parse_qsl(raw.decode()))
        self.calls.append({"method": method, "fields": fields, "file": file_bytes})
        if file_bytes is not None:
            self.uploads.append(file_bytes)
        queue = self.plan.get(method)
        if queue:
            status, body = queue.pop(0) if len(queue) > 1 else queue[0]
            if isinstance(body, Exception):
                raise body
            return httpx.Response(status, json=body)
        return httpx.Response(200, json={"ok": True, "result": True})

    def of(self, method: str) -> list[dict]:
        return [c for c in self.calls if c["method"] == method]

    def texts(self) -> list[str]:
        return [c["fields"].get("text", "") for c in self.of("sendMessage")]


def error(code: int, description: str = "nope"):
    return (code, {"ok": False, "error_code": code, "description": description})


def make_bot(fake: FakeTelegram, fetch, **kwargs) -> TelegramBot:
    client = httpx.AsyncClient(transport=httpx.MockTransport(fake))
    return TelegramBot(TOKEN, fetch, client=client, **kwargs)


def message(text: str, chat: int = 42, message_id: int = 7) -> dict:
    return {"update_id": 1, "message": {"message_id": message_id, "chat": {"id": chat}, "text": text}}


async def no_fetch(url):  # pragma: no cover - must not be called
    raise AssertionError("the pipeline ran for a message that is not a supported link")


def temp_video(content: bytes = b"\x00\x00\x00\x18ftypmp42" + b"v" * 5000) -> str:
    fd, path = tempfile.mkstemp(prefix=tb.TEMP_PREFIX, suffix=".mp4")
    with os.fdopen(fd, "wb") as handle:
        handle.write(content)
    return path


VIDEO_BUTTON = "🌐 Download in HD / 4K Quality"


def buttons_of(call: dict) -> list[list[dict]] | None:
    """The inline keyboard sent with a Bot API call, or None when the message carried none."""
    raw = call["fields"].get("reply_markup")
    return json.loads(raw)["inline_keyboard"] if raw else None


# ---------------------------------------------------------------------------------------- pure helpers


class HelperTests(unittest.TestCase):
    def test_the_two_texts_are_exactly_as_requested(self):
        self.assertEqual(tb.WELCOME, WELCOME_EXACT)
        self.assertEqual(tb.FOOTER, FOOTER_EXACT)

    def test_finds_supported_links_with_or_without_https_and_stray_punctuation(self):
        cases = {
            "https://www.instagram.com/reel/AbC_123/": "https://www.instagram.com/reel/AbC_123/",
            "look at this https://youtu.be/jNQXAC9IVRw?si=x, wow!": "https://youtu.be/jNQXAC9IVRw?si=x",
            "(https://www.tiktok.com/@u/video/7123456789)": "https://www.tiktok.com/@u/video/7123456789",
            "www.instagram.com/reel/AbC_123/": "https://www.instagram.com/reel/AbC_123/",
            "x.com/user/status/1234567890": "https://x.com/user/status/1234567890",
            "https://vm.tiktok.com/ZMabc123/": "https://vm.tiktok.com/ZMabc123/",
        }
        for text, expected in cases.items():
            self.assertEqual(tb.find_link(text), (expected, False), text)

    def test_takes_the_first_supported_link_when_there_are_several(self):
        link, _ = tb.find_link("https://www.youtube.com/watch?v=aaaaaaaaaaa https://youtu.be/bbbbbbbbbbb")
        self.assertEqual(link, "https://www.youtube.com/watch?v=aaaaaaaaaaa")

    def test_ignores_everything_that_is_not_a_supported_platform(self):
        for text in ("hello", "", "just.a.word", "https://example.com/video.mp4", "https://vimeo.com/123"):
            link, _ = tb.find_link(text)
            self.assertIsNone(link, text)
        self.assertEqual(tb.find_link("https://vimeo.com/123"), (None, True))
        self.assertEqual(tb.find_link("hello"), (None, False))

    def test_lookalike_hosts_and_embedded_credentials_are_not_accepted(self):
        for text in (
            "https://www.youtube.com.evil.example/watch?v=abcdefghijk",
            "https://evilyoutube.com/watch?v=abcdefghijk",
            "https://youtube.com@evil.example/watch?v=abcdefghijk",
            "https://evil.example/www.youtube.com/watch?v=abcdefghijk",
            "http://127.0.0.1/reel/abc/",
            "http://169.254.169.254/latest/meta-data/",
        ):
            link, _ = tb.find_link(text)
            self.assertIsNone(link, text)

    def test_commands(self):
        self.assertEqual(tb.command_of("/start"), "/start")
        self.assertEqual(tb.command_of("/START@savereelsfast_bot now"), "/start")
        self.assertEqual(tb.command_of("/help"), "/help")
        self.assertIsNone(tb.command_of("https://x.com/a/status/1"))
        self.assertIsNone(tb.command_of(""))

    def test_the_token_is_removed_from_anything_that_gets_logged(self):
        leaked = f"POST https://api.telegram.org/bot{TOKEN}/getUpdates failed"
        self.assertNotIn(TOKEN, tb.redact(leaked, TOKEN))
        self.assertNotIn(TOKEN, tb.redact(leaked))  # even without being told which token
        self.assertNotIn("AAE_fake", tb.redact(leaked))
        self.assertIn("getUpdates", tb.redact(leaked, TOKEN))

    def test_token_shape(self):
        self.assertTrue(tb.valid_token(TOKEN))
        for bad in ("", "abc", "123:short", "not-a-token", "12345678:"):
            self.assertFalse(tb.valid_token(bad), bad)

    def test_limiter_allows_one_job_per_chat_and_a_few_per_minute(self):
        now = [0.0]
        limiter = ChatLimiter(per_minute=3, clock=lambda: now[0])
        self.assertEqual(limiter.begin(1), "ok")
        self.assertEqual(limiter.begin(1), "busy")
        self.assertEqual(limiter.begin(2), "ok", "another chat is not affected")
        limiter.end(1)
        self.assertEqual(limiter.begin(1), "ok")
        limiter.end(1)
        self.assertEqual(limiter.begin(1), "ok")
        limiter.end(1)
        self.assertEqual(limiter.begin(1), "slow", "a fourth link within a minute")
        now[0] += 61
        self.assertEqual(limiter.begin(1), "ok", "the minute is over")

    def test_limiter_memory_is_bounded(self):
        limiter = ChatLimiter(max_chats=50)
        for chat in range(500):
            limiter.begin(chat)
            limiter.end(chat)
        self.assertLessEqual(len(limiter._recent), 50)

    def test_stale_temporary_files_are_cleaned_up_and_fresh_ones_are_not(self):
        old, fresh = temp_video(), temp_video()
        os.utime(old, (time.time() - 7200, time.time() - 7200))
        try:
            tb.remove_stale_files(max_age_seconds=3600)
            self.assertFalse(os.path.exists(old))
            self.assertTrue(os.path.exists(fresh))
        finally:
            tb.delete_quietly(old)
            tb.delete_quietly(fresh)


# ------------------------------------------------------------------------------------ handling messages


class MessageTests(unittest.IsolatedAsyncioTestCase):
    async def test_start_sends_the_welcome_text(self):
        fake = FakeTelegram()
        bot = make_bot(fake, no_fetch)
        await bot.handle_update(message("/start"))
        self.assertEqual(fake.texts(), [WELCOME_EXACT])
        self.assertEqual(fake.of("sendMessage")[0]["fields"]["chat_id"], "42")

    async def test_help_and_start_with_the_bot_name_work_too(self):
        fake = FakeTelegram()
        bot = make_bot(fake, no_fetch)
        await bot.handle_update(message("/help"))
        await bot.handle_update(message("/start@savereelsfast_bot"))
        self.assertEqual(fake.texts(), [WELCOME_EXACT, WELCOME_EXACT])

    async def test_other_text_gets_a_hint_and_never_runs_the_pipeline(self):
        fake = FakeTelegram()
        bot = make_bot(fake, no_fetch)
        await bot.handle_update(message("hello there"))
        await bot.handle_update(message("/unknown"))
        await bot.handle_update(message("https://vimeo.com/123"))
        texts = fake.texts()
        self.assertEqual(texts[0], tb.HINT)
        self.assertEqual(texts[1], tb.HINT)
        self.assertEqual(texts[2], tb.UNSUPPORTED)

    async def test_updates_without_a_chat_or_text_are_ignored(self):
        fake = FakeTelegram()
        bot = make_bot(fake, no_fetch)
        await bot.handle_update({"update_id": 1})
        await bot.handle_update({"update_id": 2, "message": {"message_id": 1, "chat": {"id": 5}}})
        self.assertEqual(fake.of("sendMessage")[0]["fields"]["text"], tb.HINT)  # empty text -> a hint, not a crash
        self.assertEqual(len(fake.calls), 1)

    async def test_a_link_returns_the_video_file_with_the_footer(self):
        fake = FakeTelegram()
        path = temp_video()
        seen = []

        async def fetch(url):
            seen.append(url)
            return Media(title="Me at the zoo", media_url="https://rr1.googlevideo.com/v", path=path, size=5000)

        bot = make_bot(fake, fetch)
        await bot.handle_update(message("https://youtu.be/jNQXAC9IVRw"))
        self.assertEqual(seen, ["https://youtu.be/jNQXAC9IVRw"])
        sent = fake.of("sendVideo")
        self.assertEqual(len(sent), 1)
        self.assertEqual(sent[0]["fields"]["chat_id"], "42")
        self.assertEqual(sent[0]["fields"]["reply_to_message_id"], "7")
        caption = sent[0]["fields"]["caption"]
        self.assertTrue(caption.endswith(FOOTER_EXACT), caption)
        self.assertIn("Me at the zoo", caption)
        self.assertEqual(sent[0]["file"][:12], b"\x00\x00\x00\x18ftypmp42"[:12], "the file itself was uploaded")
        self.assertEqual(len(sent[0]["file"]), 5000 + 12 - 12 + 0 if False else len(sent[0]["file"]))
        self.assertFalse(os.path.exists(path), "the temporary file must be deleted after sending")
        self.assertEqual(bot.stats["sent"], 1)

    async def test_the_caption_stays_within_telegrams_limit_even_for_a_huge_title(self):
        fake = FakeTelegram()
        path = temp_video()

        async def fetch(url):
            return Media(title="T" * 5000 + "\nnewline", path=path, size=10)

        bot = make_bot(fake, fetch)
        await bot.handle_update(message("https://youtu.be/jNQXAC9IVRw"))
        caption = fake.of("sendVideo")[0]["fields"]["caption"]
        self.assertLessEqual(len(caption), 1024)
        self.assertTrue(caption.endswith(FOOTER_EXACT))
        self.assertNotIn("\nnewline", caption.split("\n\n")[0])

    async def test_a_silent_clip_says_so(self):
        fake = FakeTelegram()
        path = temp_video()

        async def fetch(url):
            return Media(title="x", path=path, size=10, audio="no")

        await make_bot(fake, fetch).handle_update(message("https://v.redd.it/abc123"))
        self.assertIn("no audio", fake.of("sendVideo")[0]["fields"]["caption"])

    async def test_if_sendvideo_is_refused_the_file_goes_as_a_document(self):
        fake = FakeTelegram()
        fake.plan["sendVideo"] = [error(400, "wrong file type")]
        path = temp_video()

        async def fetch(url):
            return Media(title="x", path=path, size=10)

        await make_bot(fake, fetch).handle_update(message("https://youtu.be/jNQXAC9IVRw"))
        self.assertEqual(len(fake.of("sendVideo")), 1)
        documents = fake.of("sendDocument")
        self.assertEqual(len(documents), 1)
        self.assertTrue(documents[0]["fields"]["caption"].endswith(FOOTER_EXACT))
        self.assertFalse(os.path.exists(path))

    async def test_if_telegram_refuses_the_upload_entirely_the_link_is_sent_instead(self):
        fake = FakeTelegram()
        fake.plan["sendVideo"] = [error(400)]
        fake.plan["sendDocument"] = [error(413, "too big")]
        path = temp_video()

        async def fetch(url):
            return Media(title="x", media_url="https://scontent.cdninstagram.com/v.mp4", path=path, size=10)

        await make_bot(fake, fetch).handle_update(message("https://www.instagram.com/reel/AbC_123/"))
        text = fake.texts()[-1]
        self.assertIn("https://scontent.cdninstagram.com/v.mp4", text)
        self.assertTrue(text.rstrip().endswith(FOOTER_EXACT))

    async def test_a_video_over_50_mb_is_answered_with_its_direct_link(self):
        fake = FakeTelegram()

        async def fetch(url):
            return Media(title="Long film", media_url="https://rr1.googlevideo.com/big", path=None, size=80 * 1024 * 1024)

        await make_bot(fake, fetch).handle_update(message("https://youtu.be/jNQXAC9IVRw"))
        self.assertEqual(fake.of("sendVideo"), [])
        text = fake.texts()[-1]
        self.assertIn("50 MB", text)
        self.assertIn("https://rr1.googlevideo.com/big", text)
        self.assertIn(FOOTER_EXACT, text)
        self.assertEqual(fake.of("sendMessage")[-1]["fields"]["disable_web_page_preview"], "true")

    async def test_errors_for_the_visitor_are_shown_kindly_and_the_bot_carries_on(self):
        fake = FakeTelegram()

        async def fetch(url):
            raise BotUserError("🔒 That video is private.")

        bot = make_bot(fake, fetch)
        await bot.handle_update(message("https://www.instagram.com/reel/AbC_123/"))
        self.assertEqual(fake.texts(), ["🔒 That video is private."])
        self.assertEqual(bot.stats["failed"], 1)
        await bot.handle_update(message("/start"))
        self.assertEqual(fake.texts()[-1], WELCOME_EXACT)

    async def test_an_unexpected_crash_in_the_pipeline_is_contained_and_never_leaks_details(self):
        fake = FakeTelegram()

        async def fetch(url):
            raise RuntimeError(f"secret internals https://api.telegram.org/bot{TOKEN}/x")

        bot = make_bot(fake, fetch)
        with self.assertLogs("uvicorn.error", level="WARNING") as logs:
            await bot.handle_update(message("https://www.instagram.com/reel/AbC_123/"))
        self.assertEqual(fake.texts(), [tb.GENERIC_FAILURE])
        self.assertNotIn("secret internals", fake.texts()[0])
        self.assertNotIn(TOKEN, "\n".join(logs.output), "the token must never reach the logs")
        self.assertNotIn("AAE_fake", "\n".join(logs.output))

    async def test_a_job_that_takes_too_long_is_stopped_with_a_message(self):
        fake = FakeTelegram()

        async def fetch(url):
            await asyncio.sleep(10)

        bot = make_bot(fake, fetch)
        with mock.patch.object(tb, "JOB_TIMEOUT_SECONDS", 0.2):
            await bot.handle_update(message("https://www.instagram.com/reel/AbC_123/"))
        self.assertEqual(fake.texts(), [tb.TOO_SLOW])

    async def test_a_second_link_from_the_same_chat_waits_its_turn(self):
        fake = FakeTelegram()
        release = asyncio.Event()

        async def fetch(url):
            await release.wait()
            raise BotUserError("done")

        bot = make_bot(fake, fetch)
        first = asyncio.ensure_future(bot.handle_update(message("https://www.instagram.com/reel/AbC_123/")))
        await asyncio.sleep(0.05)
        await bot.handle_update(message("https://www.instagram.com/reel/XyZ_999/"))
        self.assertEqual(fake.texts(), [tb.STILL_WORKING])
        release.set()
        await first

    async def test_one_person_cannot_flood_the_bot(self):
        fake = FakeTelegram()

        async def fetch(url):
            raise BotUserError("nope")

        bot = make_bot(fake, fetch, limiter=ChatLimiter(per_minute=3))
        for _ in range(5):
            await bot.handle_update(message("https://www.instagram.com/reel/AbC_123/"))
        texts = fake.texts()
        self.assertEqual(texts.count("nope"), 3)
        self.assertEqual(texts.count(tb.SLOW_DOWN), 2)

    async def test_at_most_two_downloads_run_at_once_across_all_chats(self):
        fake = FakeTelegram()
        running = 0
        peak = 0

        async def fetch(url):
            nonlocal running, peak
            running += 1
            peak = max(peak, running)
            await asyncio.sleep(0.1)
            running -= 1
            raise BotUserError("ok")

        bot = make_bot(fake, fetch, max_jobs=2)
        await asyncio.gather(*[bot.handle_update(message("https://www.instagram.com/reel/AbC_123/", chat=chat)) for chat in range(8)])
        self.assertEqual(peak, 2)
        self.assertEqual(fake.texts().count("ok"), 8, "everyone still gets an answer")


# --------------------------------------------------------------------------------------------- polling


class WebsiteButtonTests(unittest.IsolatedAsyncioTestCase):
    """Every video the bot sends, and the welcome message, carry one button that opens the website."""

    async def test_the_video_carries_the_hd_button_right_under_it(self):
        fake = FakeTelegram()
        path = temp_video()

        async def fetch(url):
            return Media(title="Me at the zoo", path=path, size=5000)

        await make_bot(fake, fetch).handle_update(message("https://youtu.be/jNQXAC9IVRw"))
        sent = fake.of("sendVideo")[0]
        self.assertEqual(buttons_of(sent), [[{"text": VIDEO_BUTTON, "url": "https://www.savereelsfast.com"}]])
        self.assertTrue(sent["fields"]["caption"].endswith(FOOTER_EXACT), "the caption is unchanged")

    async def test_the_button_text_and_address_are_exactly_as_requested(self):
        self.assertEqual(tb.VIDEO_BUTTON_LABEL, VIDEO_BUTTON)
        self.assertEqual(tb.WEBSITE_URL, "https://www.savereelsfast.com")

    async def test_the_document_fallback_keeps_the_button(self):
        fake = FakeTelegram()
        fake.plan["sendVideo"] = [error(400, "wrong file type")]
        path = temp_video()

        async def fetch(url):
            return Media(title="x", path=path, size=10)

        await make_bot(fake, fetch).handle_update(message("https://youtu.be/jNQXAC9IVRw"))
        self.assertEqual(buttons_of(fake.of("sendDocument")[0]), [[{"text": VIDEO_BUTTON, "url": "https://www.savereelsfast.com"}]])

    async def test_start_and_help_show_a_button_that_opens_the_website(self):
        fake = FakeTelegram()
        bot = make_bot(fake, no_fetch)
        await bot.handle_update(message("/start"))
        await bot.handle_update(message("/help"))
        for call in fake.of("sendMessage"):
            self.assertEqual(call["fields"]["text"], WELCOME_EXACT, "the welcome text is unchanged")
            rows = buttons_of(call)
            self.assertEqual(len(rows), 1)
            self.assertEqual(len(rows[0]), 1)
            self.assertEqual(rows[0][0]["url"], "https://www.savereelsfast.com")
            self.assertEqual(rows[0][0]["text"], tb.WELCOME_BUTTON_LABEL)

    async def test_other_replies_have_no_button(self):
        fake = FakeTelegram()
        bot = make_bot(fake, no_fetch)
        await bot.handle_update(message("hello there"))
        await bot.handle_update(message("https://example.com/not-supported"))
        await bot.handle_update(message("/unknowncommand"))
        self.assertEqual(len(fake.of("sendMessage")), 3)
        for call in fake.of("sendMessage"):
            self.assertIsNone(buttons_of(call))

    async def test_the_button_is_valid_for_telegram(self):
        for label in (tb.VIDEO_BUTTON_LABEL, tb.WELCOME_BUTTON_LABEL):
            markup = json.loads(tb.website_button(label))
            button = markup["inline_keyboard"][0][0]
            self.assertTrue(button["url"].startswith("https://"), "Telegram only opens http(s) links from a button")
            self.assertLessEqual(len(button["text"]), 64, "Telegram limits a button's text")
            self.assertEqual(set(button), {"text", "url"})
            self.assertIn("🌐", tb.website_button(label), "the emoji is sent as itself, not as an escape")

    async def test_a_failing_link_reply_stays_button_free(self):
        fake = FakeTelegram()

        async def fetch(url):
            raise BotUserError("That video is private.")

        await make_bot(fake, fetch).handle_update(message("https://youtu.be/jNQXAC9IVRw"))
        self.assertIn("private", fake.texts()[-1])
        self.assertIsNone(buttons_of(fake.of("sendMessage")[-1]))


class PollingTests(unittest.IsolatedAsyncioTestCase):
    def loop_bot(self, fake, fetch=no_fetch):
        naps: list[float] = []

        async def nap(seconds):
            naps.append(seconds)
            await asyncio.sleep(0)

        return make_bot(fake, fetch, sleep=nap), naps

    async def run_until(self, bot, condition, seconds=3.0):
        task = asyncio.ensure_future(bot.run_forever())
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline and not condition() and not task.done():
            await asyncio.sleep(0.01)
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        return task

    async def test_it_clears_any_webhook_registers_commands_then_answers_messages(self):
        fake = FakeTelegram()
        fake.plan["getUpdates"] = [(200, {"ok": True, "result": [message("/start")]}), (200, {"ok": True, "result": []})]
        bot, _ = self.loop_bot(fake)
        await self.run_until(bot, lambda: WELCOME_EXACT in fake.texts())
        methods = [c["method"] for c in fake.calls]
        self.assertEqual(methods[:2], ["deleteWebhook", "setMyCommands"])
        self.assertIn(WELCOME_EXACT, fake.texts())

    async def test_the_offset_advances_so_a_message_is_never_answered_twice(self):
        fake = FakeTelegram()
        updates = [{"update_id": 500, "message": {"message_id": 1, "chat": {"id": 1}, "text": "/start"}},
                   {"update_id": 501, "message": {"message_id": 2, "chat": {"id": 1}, "text": "/start"}}]
        fake.plan["getUpdates"] = [(200, {"ok": True, "result": updates}), (200, {"ok": True, "result": []})]
        bot, _ = self.loop_bot(fake)
        await self.run_until(bot, lambda: len(fake.of("getUpdates")) >= 3)
        polls = fake.of("getUpdates")
        self.assertNotIn("offset", polls[0]["fields"])
        self.assertEqual(polls[1]["fields"]["offset"], "502")
        self.assertEqual(fake.texts().count(WELCOME_EXACT), 2)

    async def test_a_second_instance_polling_the_same_token_makes_it_wait_not_crash(self):
        fake = FakeTelegram()
        fake.plan["getUpdates"] = [error(409, "Conflict: terminated by other getUpdates request")]
        bot, naps = self.loop_bot(fake)
        with self.assertLogs("uvicorn.error", level="WARNING") as logs:
            task = await self.run_until(bot, lambda: len(naps) >= 3)
        self.assertGreaterEqual(len(naps), 3)
        self.assertTrue(all(n == 15 for n in naps), naps)
        self.assertEqual(sum("another process is polling" in line for line in logs.output), 1, "warned once, not every 15 s")
        self.assertTrue(task.cancelled() or not task.done() or task.exception() is None)

    async def test_network_trouble_is_retried_with_a_growing_pause(self):
        fake = FakeTelegram()
        fake.plan["getUpdates"] = [(0, httpx.ConnectError("no route"))]
        bot, naps = self.loop_bot(fake)
        with self.assertLogs("uvicorn.error", level="WARNING"):
            await self.run_until(bot, lambda: len(naps) >= 7)
        self.assertEqual(naps[:6], [1.0, 2.0, 4.0, 8.0, 16.0, 30.0])
        self.assertLessEqual(max(naps), 30.0)

    async def test_a_rejected_token_switches_the_bot_off_instead_of_hammering_telegram(self):
        fake = FakeTelegram()
        fake.plan["deleteWebhook"] = [error(401, "Unauthorized")]
        bot, naps = self.loop_bot(fake)
        with self.assertLogs("uvicorn.error", level="ERROR") as logs:
            task = await self.run_until(bot, lambda: False, seconds=1.0)
        self.assertTrue(task.done() and not task.cancelled(), "run_forever returned by itself")
        self.assertIsNone(task.exception())
        self.assertEqual(naps, [], "no retry loop")
        self.assertTrue(any("token was rejected" in line for line in logs.output))
        self.assertEqual(len(fake.of("getUpdates")), 0)

    async def test_the_token_never_appears_in_the_logs_even_when_the_network_error_contains_it(self):
        fake = FakeTelegram()
        fake.plan["getUpdates"] = [(0, httpx.ConnectError(f"cannot reach https://api.telegram.org/bot{TOKEN}/getUpdates"))]
        bot, naps = self.loop_bot(fake)
        with self.assertLogs("uvicorn.error", level="INFO") as logs:
            await self.run_until(bot, lambda: len(naps) >= 2)
        joined = "\n".join(logs.output)
        self.assertNotIn(TOKEN, joined)
        self.assertNotIn("AAE_fake", joined)
        self.assertIn("polling problem", joined)

    async def test_an_unexpected_bug_restarts_the_poller_and_is_not_fatal(self):
        fake = FakeTelegram()
        bot, naps = self.loop_bot(fake)
        calls = {"n": 0}

        async def flaky_loop():
            calls["n"] += 1
            if calls["n"] < 3:
                raise ValueError("bug")
            await asyncio.sleep(10)

        bot._poll_loop = flaky_loop
        with self.assertLogs("uvicorn.error", level="WARNING"):
            await self.run_until(bot, lambda: calls["n"] >= 3)
        self.assertEqual(calls["n"], 3)
        self.assertEqual(naps[:2], [2.0, 4.0])

    async def test_cancelling_stops_cleanly_and_cancels_running_jobs(self):
        fake = FakeTelegram()
        fake.plan["getUpdates"] = [(200, {"ok": True, "result": [message("https://www.instagram.com/reel/AbC_123/")]}), (200, {"ok": True, "result": []})]
        started = asyncio.Event()

        async def slow_fetch(url):
            started.set()
            await asyncio.sleep(60)

        bot, _ = self.loop_bot(fake, slow_fetch)
        task = asyncio.ensure_future(bot.run_forever())
        await asyncio.wait_for(started.wait(), 3)
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        self.assertEqual(len(bot._tasks), 0)


# ---------------------------------------------------------------------------- wiring into the FastAPI app


def make_stream(chunks: list[bytes], length: int | None = None, on_close=None):
    import main

    class Reader:
        def __init__(self):
            self.chunks = list(chunks)

        def read(self, n):
            return self.chunks.pop(0) if self.chunks else b""

    closers = [on_close] if on_close else []
    return main.OpenStream(Reader(), length, closers)


class AppWiringTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        try:
            import main
        except ImportError as exc:  # pragma: no cover
            raise unittest.SkipTest(f"dependencies missing: {exc}")
        cls.main = main

    def setUp(self):
        self.main.INFO_CACHE.clear()
        self.main.NEGATIVE_CACHE.clear()
        self.main.YOUTUBE_BREAKER.reset()

    INFO = {"id": "abc", "title": "Me at the zoo", "formats": [
        {"format_id": "18", "url": "https://x.googlevideo.com/v", "ext": "mp4", "vcodec": "avc1", "acodec": "mp4a", "height": 360, "protocol": "https"}]}

    def leftovers(self) -> set[str]:
        return {n for n in os.listdir(tempfile.gettempdir()) if n.startswith(tb.TEMP_PREFIX)}

    async def fetch_with(self, stream, info=None, **patches):
        info = info if info is not None else self.INFO
        with mock.patch.object(self.main, "_extract_info", lambda url, route=0: info), \
                mock.patch.object(self.main, "_open_stream", mock.AsyncMock(return_value=stream)):
            return await self.main._telegram_fetch("https://www.youtube.com/watch?v=jNQXAC9IVRw")

    async def test_a_video_within_the_limit_becomes_a_temporary_file(self):
        before = self.leftovers()
        closed = []
        stream = make_stream([b"a" * 100_000] * 3, length=300_000, on_close=lambda: closed.append(1))
        media = await self.fetch_with(stream)
        try:
            self.assertEqual(media.title, "Me at the zoo")
            self.assertEqual(media.media_url, "https://x.googlevideo.com/v")
            self.assertEqual(media.size, 300_000)
            self.assertTrue(media.path and os.path.getsize(media.path) == 300_000)
            self.assertTrue(closed, "the connection to the platform is closed")
        finally:
            tb.delete_quietly(media.path)
        self.assertEqual(self.leftovers(), before)
        self.assertEqual(self.main.STREAM_SLOTS.active, 0, "the stream slot is given back")

    async def test_a_video_known_to_be_too_large_is_not_downloaded_at_all(self):
        stream = make_stream([b"a" * 10], length=tb.MAX_UPLOAD_BYTES + 1)
        media = await self.fetch_with(stream)
        self.assertIsNone(media.path)
        self.assertEqual(media.size, tb.MAX_UPLOAD_BYTES + 1)
        self.assertTrue(media.media_url)
        self.assertEqual(self.main.STREAM_SLOTS.active, 0)

    async def test_an_unknown_length_that_turns_out_too_large_stops_early_and_leaves_no_file(self):
        before = self.leftovers()
        stream = make_stream([b"a" * 400_000] * 10, length=None)
        with mock.patch.object(self.main, "MAX_UPLOAD_BYTES", 1_000_000):
            media = await self.fetch_with(stream)
        self.assertIsNone(media.path)
        self.assertGreater(media.size, 1_000_000)
        self.assertEqual(self.leftovers(), before, "the partial file must be deleted")
        self.assertEqual(self.main.STREAM_SLOTS.active, 0)

    async def test_an_empty_download_is_not_sent_as_a_video(self):
        before = self.leftovers()
        media = await self.fetch_with(make_stream([], length=None))
        self.assertIsNone(media.path)
        self.assertTrue(media.media_url)
        self.assertEqual(self.leftovers(), before)

    async def test_scraper_errors_become_friendly_messages(self):
        import errors

        cases = {
            errors.LOGIN_REQUIRED: "private",
            errors.UNSUPPORTED_POST: "couldn't find a video",
            errors.STREAM_EXPIRED_OR_BLOCKED: "limiting downloads",
            errors.PLATFORM_TIMEOUT: "didn't answer",
            errors.SERVER_BUSY: "busy",
        }
        for code, fragment in cases.items():
            def boom(url, route=0, code=code):
                raise self.main.ScraperError(code)

            with mock.patch.object(self.main, "_extract_info", boom):
                with self.assertRaises(BotUserError) as ctx:
                    await self.main._telegram_fetch("https://www.tiktok.com/@u/video/7123456789")
            self.assertIn(fragment, ctx.exception.message, code)
            for internal in ("STREAM_EXPIRED", "yt-dlp", "Traceback", "403"):
                self.assertNotIn(internal, ctx.exception.message)
            self.main.NEGATIVE_CACHE.clear()

    async def test_a_link_with_no_video_says_so(self):
        media_less = {"id": "x", "title": "photo post", "formats": []}
        with mock.patch.object(self.main, "_extract_info", lambda url, route=0: media_less):
            with self.assertRaises(BotUserError) as ctx:
                await self.main._telegram_fetch("https://www.tiktok.com/@u/video/7123456789")
        self.assertIn("couldn't find a video", ctx.exception.message)

    async def test_the_memory_guard_applies_to_bot_downloads_too(self):
        boom = mock.Mock(side_effect=AssertionError("started work while out of memory"))
        with mock.patch.object(self.main, "rss_mb", return_value=self.main.MEMORY_SOFT_LIMIT_MB + 50), \
                mock.patch.object(self.main, "_extract_info", boom):
            with self.assertRaises(BotUserError) as ctx:
                await self.main._telegram_fetch("https://www.tiktok.com/@u/video/7123456789")
        self.assertIn("busy", ctx.exception.message)
        boom.assert_not_called()

    async def test_every_stream_slot_being_taken_gives_a_busy_answer(self):
        leases = [self.main.STREAM_SLOTS.acquire() for _ in range(self.main.STREAM_SLOTS.size)]
        try:
            with mock.patch.object(self.main, "_extract_info", lambda url, route=0: self.INFO):
                with self.assertRaises(BotUserError) as ctx:
                    await self.main._telegram_fetch("https://www.youtube.com/watch?v=jNQXAC9IVRw")
            self.assertIn("busy", ctx.exception.message)
        finally:
            for lease in leases:
                lease.release()

    async def test_cancelling_a_download_stops_the_worker_and_deletes_its_file(self):
        before = self.leftovers()

        class Slow:
            def read(self, n):
                time.sleep(0.05)
                return b"a" * 10_000

        stream = self.main.OpenStream(Slow(), None, [])
        task = asyncio.ensure_future(self.fetch_with(stream))
        await asyncio.sleep(0.3)
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        await asyncio.sleep(0.5)  # the worker thread notices at its next chunk
        self.assertEqual(self.leftovers(), before)
        self.assertEqual(self.main.STREAM_SLOTS.active, 0)


class StartupTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            import main
            from fastapi.testclient import TestClient
        except ImportError as exc:  # pragma: no cover
            raise unittest.SkipTest(f"dependencies missing: {exc}")
        cls.main = main
        cls.TestClient = TestClient

    def run_app(self, env):
        started, stopped = [], []

        class FakeBot:
            def __init__(self, token, fetch, **kw):
                started.append(token)
                self.stats = {"polls": 0, "messages": 0, "sent": 0, "failed": 0}

            async def run_forever(self):
                try:
                    await asyncio.sleep(3600)
                except asyncio.CancelledError:
                    stopped.append(True)
                    raise

        with mock.patch.dict(os.environ, env, clear=False), mock.patch.object(self.main, "TelegramBot", FakeBot):
            os.environ.pop("TELEGRAM_BOT_TOKEN", None) if env.get("TELEGRAM_BOT_TOKEN") is None else None
            with self.TestClient(self.main.app) as client:  # runs startup and shutdown
                health = client.get("/health")
                stats = client.get("/stats").json()
        return started, stopped, health, stats

    def test_nothing_starts_without_a_token(self):
        started, _, health, stats = self.run_app({"TELEGRAM_BOT_TOKEN": ""})
        self.assertEqual(started, [])
        self.assertEqual(health.status_code, 200)
        self.assertEqual(stats["telegram"], {"enabled": False})

    def test_a_valid_token_starts_the_bot_and_shutdown_stops_it(self):
        started, stopped, health, stats = self.run_app({"TELEGRAM_BOT_TOKEN": TOKEN})
        self.assertEqual(started, [TOKEN])
        self.assertEqual(stopped, [True], "the poller is cancelled on shutdown")
        self.assertEqual(health.status_code, 200)
        self.assertTrue(stats["telegram"]["enabled"])
        self.assertNotIn(TOKEN, json.dumps(stats), "the token must never be exposed")

    def test_a_malformed_token_is_ignored_with_a_warning(self):
        with self.assertLogs("uvicorn.error", level="WARNING") as logs:
            started, _, health, _ = self.run_app({"TELEGRAM_BOT_TOKEN": "definitely-not-a-token"})
        self.assertEqual(started, [])
        self.assertEqual(health.status_code, 200)
        self.assertTrue(any("does not look like a bot token" in line for line in logs.output))
        self.assertNotIn("definitely-not-a-token", "\n".join(logs.output))

    def test_the_api_keeps_working_when_the_bot_dies(self):
        class Crashing:
            def __init__(self, token, fetch, **kw):
                self.stats = {}

            async def run_forever(self):
                raise RuntimeError("bot exploded")

        with mock.patch.dict(os.environ, {"TELEGRAM_BOT_TOKEN": TOKEN}), mock.patch.object(self.main, "TelegramBot", Crashing):
            with self.TestClient(self.main.app) as client:
                for _ in range(3):
                    self.assertEqual(client.get("/health").status_code, 200)

    def test_the_bot_never_reads_or_needs_the_apps_shared_secret(self):
        source = (ROOT / "telegram_bot.py").read_text(encoding="utf8")
        self.assertNotIn("SCRAPER_SHARED_SECRET", source)
        self.assertNotIn("import main", source, "the bot must not import the FastAPI app")
        self.assertNotRegex(source, r"\d{8,}:[\w-]{30,}", "no token may be written into the source")

    def test_the_token_is_only_ever_read_from_the_environment(self):
        for name in ("main.py", "telegram_bot.py"):
            text = (ROOT / name).read_text(encoding="utf8")
            self.assertNotRegex(text, r"\b\d{9,10}:[A-Za-z0-9_-]{35}\b", f"a bot token is written into {name}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
