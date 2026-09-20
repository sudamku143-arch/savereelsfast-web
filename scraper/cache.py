"""In-memory TTL/LRU cache, download-slot pool and yt-dlp info trimming.

No FastAPI / yt-dlp imports, so it can be unit-tested on its own.
"""

import threading
import time
from collections import OrderedDict
from typing import Any, Callable


class TTLCache:
    """
    Thread-safe LRU cache whose entries expire after `ttl` seconds.

    The oldest entry is evicted once `max_entries` is exceeded, so memory stays
    bounded however many distinct links are requested.
    """

    def __init__(self, max_entries: int = 500, ttl: float = 5400.0, clock: Callable[[], float] = time.monotonic):
        self.max_entries = max_entries
        self.ttl = ttl
        self._clock = clock
        self._data: "OrderedDict[str, tuple[float, Any]]" = OrderedDict()
        self._lock = threading.Lock()
        self.hits = 0
        self.misses = 0

    def get(self, key: str) -> Any | None:
        with self._lock:
            entry = self._data.get(key)
            if entry is None:
                self.misses += 1
                return None
            expires_at, value = entry
            if expires_at <= self._clock():
                del self._data[key]
                self.misses += 1
                return None
            self._data.move_to_end(key)  # most recently used
            self.hits += 1
            return value

    def set(self, key: str, value: Any, ttl: float | None = None) -> None:
        with self._lock:
            self._data[key] = (self._clock() + (self.ttl if ttl is None else ttl), value)
            self._data.move_to_end(key)
            while len(self._data) > self.max_entries:
                self._data.popitem(last=False)

    def invalidate(self, key: str) -> None:
        with self._lock:
            self._data.pop(key, None)

    def clear(self) -> None:
        with self._lock:
            self._data.clear()
            self.hits = 0
            self.misses = 0

    def __len__(self) -> int:
        with self._lock:
            return len(self._data)

    def stats(self) -> dict:
        with self._lock:
            total = self.hits + self.misses
            return {
                "size": len(self._data),
                "maxEntries": self.max_entries,
                "ttlSeconds": self.ttl,
                "hits": self.hits,
                "misses": self.misses,
                "hitRate": round(self.hits / total, 3) if total else None,
            }


class CircuitBreaker:
    """
    Stops asking a service that keeps refusing us.

    After `threshold` failures within `window` seconds the breaker opens for `cooldown` seconds, during which
    callers are told "no" immediately instead of each spending a request (and seconds) on a certain failure.
    A success closes it again. This is what turns a YouTube block into an instant answer, and it also stops us
    hammering a host that has just blocked our IP.
    """

    def __init__(self, threshold: int = 3, window: float = 30.0, cooldown: float = 15.0,
                 clock: Callable[[], float] = time.monotonic):
        self.threshold, self.window, self.cooldown = threshold, window, cooldown
        self._clock = clock
        self._failures: list[float] = []
        self._open_until = 0.0
        self._lock = threading.Lock()

    def is_open(self) -> bool:
        with self._lock:
            return self._clock() < self._open_until

    def record_failure(self) -> None:
        with self._lock:
            now = self._clock()
            self._failures = [t for t in self._failures if now - t <= self.window] + [now]
            if len(self._failures) >= self.threshold:
                self._open_until = now + self.cooldown
                self._failures = []

    def record_success(self) -> None:
        with self._lock:
            self._failures = []
            self._open_until = 0.0

    def reset(self) -> None:
        self.record_success()


class Lease:
    """One occupied slot. release() is idempotent, so double-closing can't free a second slot."""

    def __init__(self, pool: "SlotPool"):
        self._pool = pool
        self._released = False
        self.started = pool._clock()

    def release(self) -> None:
        with self._pool._lock:
            if self._released:
                return
            self._released = True
            self._pool._leases.discard(self)


class SlotPool:
    """
    Non-blocking pool of concurrent-stream slots.

    A stream whose client vanished mid-download might never run its cleanup, so
    leases older than `max_age` are reclaimed. Without that, leaked slots would
    slowly turn every request into a 503.
    """

    def __init__(self, size: int, max_age: float = 1800.0, clock: Callable[[], float] = time.monotonic):
        self.size = size
        self.max_age = max_age
        self._clock = clock
        self._leases: "set[Lease]" = set()
        self._lock = threading.Lock()

    def acquire(self) -> Lease | None:
        with self._lock:
            now = self._clock()
            for stale in [lease for lease in self._leases if now - lease.started > self.max_age]:
                stale._released = True
                self._leases.discard(stale)
            if len(self._leases) >= self.size:
                return None
            lease = Lease(self)
            self._leases.add(lease)
            return lease

    @property
    def active(self) -> int:
        with self._lock:
            return len(self._leases)


# Only these fields are read after extraction; the rest of a yt-dlp info dict
# (thumbnails lists, subtitles, comments, heatmaps, ...) is large and useless.
_INFO_KEYS = (
    "id", "title", "description", "uploader", "channel", "thumbnail", "duration",
    "url", "ext", "acodec", "vcodec", "protocol", "height", "width", "abr",
    "http_headers", "_type", "_messages",
)
_FORMAT_KEYS = (
    "format_id", "url", "ext", "protocol", "vcodec", "acodec", "height", "width", "abr", "http_headers",
)


def slim_info(info: dict) -> dict:
    """Keep just what extraction needs, so a cache entry stays a few KB instead of hundreds."""
    slim = {key: info[key] for key in _INFO_KEYS if key in info}
    for list_key in ("formats", "requested_formats"):
        if info.get(list_key):
            slim[list_key] = [
                {key: fmt[key] for key in _FORMAT_KEYS if key in fmt}
                for fmt in info[list_key]
                if isinstance(fmt, dict)
            ]
    if info.get("entries") is not None:
        slim["entries"] = [
            slim_info(entry) for entry in info["entries"] if isinstance(entry, dict)
        ]
    return slim
