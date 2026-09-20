"""
The /health keep-alive endpoint.

cron-job.org disables jobs whose response is "too big", so this endpoint must stay tiny,
unauthenticated and independent of everything else.

Run from the scraper/ folder:  python -m unittest discover -s tests -v
"""

import os
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


class HealthEndpointTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            import main
            from fastapi.testclient import TestClient
        except ImportError as exc:  # pragma: no cover
            raise unittest.SkipTest(f"dependencies missing: {exc}")
        cls.main = main
        cls.client = TestClient(main.app)

    def test_returns_exactly_status_ok_with_http_200(self):
        response = self.client.get("/health")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"status": "ok"})
        self.assertEqual(response.content, b'{"status":"ok"}')
        self.assertEqual(response.headers["content-type"], "application/json")

    def test_payload_is_tiny(self):
        response = self.client.get("/health")
        self.assertLessEqual(len(response.content), 32)
        # Header block matters too: pingers count the whole response.
        header_bytes = sum(len(k) + len(v) + 4 for k, v in response.headers.items())
        self.assertLess(header_bytes + len(response.content), 512)

    def test_head_requests_work_and_carry_no_body(self):
        response = self.client.head("/health")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.content, b"")

    def test_needs_no_secret_even_when_one_is_configured(self):
        with mock.patch.dict(os.environ, {"SCRAPER_SHARED_SECRET": "s3cret"}):
            self.assertEqual(self.client.get("/health").status_code, 200)
            # ...while the real endpoints stay protected.
            denied = self.client.get("/extract", params={"url": "https://youtu.be/jNQXAC9IVRw"})
            self.assertEqual(denied.status_code, 401)

    def test_is_never_cached_by_intermediaries(self):
        self.assertEqual(self.client.get("/health").headers["cache-control"], "no-store")

    def test_does_not_touch_the_cache_or_the_extractor(self):
        self.main.INFO_CACHE.clear()
        with mock.patch.object(self.main, "_extract_info", side_effect=AssertionError("must not extract")):
            for _ in range(5):
                self.assertEqual(self.client.get("/health").status_code, 200)
        stats = self.main.INFO_CACHE.stats()
        self.assertEqual((stats["hits"], stats["misses"], stats["size"]), (0, 0, 0))

    def test_stays_healthy_while_every_extraction_slot_is_busy(self):
        # Even at capacity the pinger must get an instant 200, or Render/cron would flag the service.
        with mock.patch.object(self.main, "_active", self.main.MAX_CONCURRENT_EXTRACTIONS), \
                mock.patch.object(self.main, "_waiting", self.main.MAX_QUEUED_EXTRACTIONS):
            self.assertEqual(self.client.get("/health").status_code, 200)

    def test_is_not_advertised_in_the_api_docs(self):
        self.assertNotIn("/health", self.client.get("/openapi.json").json()["paths"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
