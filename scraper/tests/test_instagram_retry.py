"""
Instagram rate limits: one quiet retry after a pause, through the residential proxy when one is configured and
today's allowance isn't used up. Nothing else is retried, and nothing else uses the proxy.

Run from the scraper/ folder:  python -m unittest discover -s tests -v
"""

import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from test_errors import EndpointBase  # noqa: E402

IG = "https://www.instagram.com/reel/DdHyaYAifb6/"
RATE_LIMIT = "ERROR: [Instagram] DdHyaYAifb6: Requested content is not available, rate-limit reached or login required"


def video(fid: str = "v") -> dict:
    return {"format_id": fid, "url": f"https://x.cdninstagram.com/{fid}.mp4", "ext": "mp4", "height": 720,
            "width": 405, "vcodec": "avc1", "acodec": "mp4a", "protocol": "https"}


class InstagramRetryTests(EndpointBase):
    def setUp(self):
        super().setUp()
        for name, value in (("INSTAGRAM_RETRY_PAUSE_SECONDS", 0.0), ("INSTAGRAM_RETRY_MIN_SECONDS", 0.0)):
            patcher = mock.patch.object(self.main, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.main._instagram_usage.update(day="", proxiedToday=0, proxied=0, retries=0, recovered=0, skippedNoTime=0,
                                          directSkipped=0, stalls=0)
        self.main._instagram_direct_blocked_until[0] = 0.0
        self.calls = []
        self.socket_timeouts = []

    def lookup(self, answers, proxy=None, url=IG):
        """Run /extract with _extract_info answering `answers` in turn (an exception is raised, a dict returned)."""
        from yt_dlp.utils import DownloadError

        def fake(u, youtube_route=0, use_proxy=False, socket_timeout=None):
            self.calls.append(use_proxy)
            self.socket_timeouts.append(socket_timeout)
            answer = answers[len(self.calls) - 1]
            if isinstance(answer, BaseException):
                raise answer
            if isinstance(answer, str):
                raise DownloadError(answer)
            return answer

        with mock.patch.object(self.main, "_extract_info", side_effect=fake), \
             mock.patch.object(self.main, "YTDLP_PROXY", proxy):
            return self.client.get("/extract", params={"url": url})

    def test_a_rate_limited_lookup_is_retried_once_and_succeeds(self):
        response = self.lookup([RATE_LIMIT, {"id": "r", "formats": [video()]}])
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(self.calls), 2)
        self.assertEqual(self.main._instagram_usage["recovered"], 1)

    def test_without_a_proxy_the_retry_goes_direct(self):
        self.lookup([RATE_LIMIT, {"id": "r", "formats": [video()]}], proxy=None)
        self.assertEqual(self.calls, [False, False])

    def test_with_a_proxy_only_the_retry_uses_it(self):
        self.lookup([RATE_LIMIT, {"id": "r", "formats": [video()]}], proxy="http://u:p@proxy.example:8000")
        self.assertEqual(self.calls, [False, True], "first try direct (free), the retry through the proxy")
        self.assertEqual(self.main._instagram_usage["proxiedToday"], 1)

    def test_the_daily_proxy_allowance_is_respected(self):
        with mock.patch.object(self.main, "INSTAGRAM_PROXY_DAILY_LOOKUPS", 1):
            self.lookup([RATE_LIMIT, {"id": "a", "formats": [video("a")]}], proxy="http://u:p@proxy.example:8000")
            first = self.calls
            self.reset_caches()
            self.calls = []
            self.lookup([RATE_LIMIT, {"id": "b", "formats": [video("b")]}], proxy="http://u:p@proxy.example:8000",
                        url="https://www.instagram.com/reel/Other123/")
        self.assertEqual(first, [False, True])
        self.assertEqual(self.calls, [False, False], "the second retry of the day goes direct")

    def test_a_blocked_retry_still_answers_with_the_block(self):
        response = self.lookup([RATE_LIMIT, RATE_LIMIT])
        self.assertEqual(response.status_code, 502)
        self.assertEqual(response.json()["detail"]["code"], "STREAM_EXPIRED_OR_BLOCKED")
        self.assertEqual(len(self.calls), 2, "one retry, never more")

    def test_a_block_reported_without_an_exception_is_retried_too(self):
        blocked = {"id": "r", "formats": [], "_messages": [RATE_LIMIT]}
        response = self.lookup([blocked, {"id": "r", "formats": [video()]}])
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(self.calls), 2)

    def test_private_or_missing_posts_are_not_retried(self):
        for message in ("ERROR: [Instagram] x: Instagram sent an empty media response", "ERROR: There is no video in this post"):
            with self.subTest(message=message):
                self.reset_caches()
                self.calls = []
                self.lookup([message])
                self.assertEqual(len(self.calls), 1)

    def test_a_photo_post_is_not_mistaken_for_a_block(self):
        photo = {"id": "p", "thumbnails": [{"url": "https://x.fbcdn.net/v/p.jpg"}]}
        with mock.patch.object(self.main, "is_allowed_media_url", lambda u: "fbcdn.net/" in u or "cdninstagram.com/" in u):
            self.lookup([photo])
        self.assertEqual(len(self.calls), 1)

    def test_no_retry_when_the_time_budget_is_spent(self):
        with mock.patch.object(self.main, "INSTAGRAM_RETRY_MIN_SECONDS", 999.0):
            response = self.lookup([RATE_LIMIT])
        self.assertEqual(response.status_code, 502)
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.main._instagram_usage["skippedNoTime"], 1)

    def test_other_platforms_are_not_retried_this_way(self):
        self.lookup([RATE_LIMIT], url="https://www.tiktok.com/@a/video/7212345678901234567")
        self.assertEqual(len(self.calls), 1)

    def test_a_stalled_lookup_is_retried_through_the_proxy_without_an_extra_pause(self):
        # What Render's IP gets now: not a refusal, just no answer.
        with mock.patch.object(self.main, "INSTAGRAM_RETRY_PAUSE_SECONDS", 30.0),              mock.patch.object(self.main.time, "sleep") as sleep:
            response = self.lookup([TimeoutError("timed out"), {"id": "r", "formats": [video()]}],
                                   proxy="http://u:p@proxy.example:8000")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.calls, [False, True])
        sleep.assert_called_once_with(0.0)  # the stall was the wait
        self.assertEqual(self.main._instagram_usage["stalls"], 1)

    def test_the_direct_attempt_gives_up_quickly_and_the_retry_gets_the_normal_timeout(self):
        self.lookup([TimeoutError("timed out"), {"id": "r", "formats": [video()]}], proxy="http://u:p@proxy.example:8000")
        self.assertEqual(self.socket_timeouts, [self.main.INSTAGRAM_DIRECT_SOCKET_TIMEOUT, None])
        self.assertLess(self.main.INSTAGRAM_DIRECT_SOCKET_TIMEOUT, self.main.YDL_OPTS["socket_timeout"])

    def test_after_a_block_the_next_lookups_go_straight_to_the_proxy(self):
        proxy = "http://u:p@proxy.example:8000"
        self.lookup([TimeoutError("timed out"), {"id": "a", "formats": [video("a")]}], proxy=proxy)
        self.reset_caches()
        self.calls = []
        response = self.lookup([{"id": "b", "formats": [video("b")]}], proxy=proxy, url="https://www.instagram.com/reel/Other123/")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.calls, [True], "no visitor waits out a direct request that won't be answered")
        self.assertEqual(self.main._instagram_usage["directSkipped"], 1)

    def test_without_a_proxy_every_lookup_still_tries_direct(self):
        self.lookup([TimeoutError("timed out"), TimeoutError("timed out")])
        self.reset_caches()
        self.calls = []
        self.lookup([{"id": "b", "formats": [video("b")]}], url="https://www.instagram.com/reel/Other123/")
        self.assertEqual(self.calls, [False])

    def test_once_the_proxy_allowance_is_used_up_direct_is_tried_again(self):
        proxy = "http://u:p@proxy.example:8000"
        with mock.patch.object(self.main, "INSTAGRAM_PROXY_DAILY_LOOKUPS", 1):
            self.lookup([TimeoutError("timed out"), {"id": "a", "formats": [video("a")]}], proxy=proxy)
            self.reset_caches()
            self.calls = []
            self.lookup([{"id": "b", "formats": [video("b")]}], proxy=proxy, url="https://www.instagram.com/reel/Other123/")
        self.assertEqual(self.calls, [False])

    def test_a_second_lookup_of_the_same_reel_comes_from_the_cache(self):
        self.lookup([{"id": "r", "formats": [video()]}])
        self.lookup([AssertionError("Instagram must not be asked again")])
        self.assertEqual(len(self.calls), 1)

    def test_instagram_has_room_for_the_retry_but_still_answers_before_the_site_gives_up(self):
        budget = self.main._extraction_budget(IG)
        self.assertEqual(budget, self.main.INSTAGRAM_EXTRACTION_TIMEOUT_SECONDS)
        self.assertGreater(budget, self.main.EXTRACTION_TIMEOUT_SECONDS)
        # The website waits 12.5 s for an Instagram lookup (INSTAGRAM_SCRAPER_TIMEOUT_MS): budget + grace must end first.
        self.assertLess(budget + self.main.DEADLINE_GRACE_SECONDS, 12.5)
        # and leaves a stalled direct attempt plus a whole retry room to run
        self.assertGreaterEqual(budget - self.main.INSTAGRAM_DIRECT_SOCKET_TIMEOUT, self.main.INSTAGRAM_RETRY_MIN_SECONDS + 3)

    def test_stats_report_the_retries(self):
        self.lookup([RATE_LIMIT, {"id": "r", "formats": [video()]}])
        instagram = self.main._proxy_stats()["instagram"]
        self.assertEqual(instagram["retries"], 1)
        self.assertEqual(instagram["recovered"], 1)


if __name__ == "__main__":
    unittest.main()
