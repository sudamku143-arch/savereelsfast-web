"""Process memory reading, so the service can shed load before the host kills it (OOM)."""

import re


def rss_mb(status_path: str = "/proc/self/status") -> float | None:
    """
    Resident memory of this process in MB, or None where it can't be read (anything but Linux,
    which is what Render runs). Reading /proc costs microseconds and needs no extra package.
    """
    try:
        with open(status_path, encoding="ascii", errors="ignore") as handle:
            match = re.search(r"^VmRSS:\s+(\d+)\s+kB", handle.read(), re.M)
    except OSError:
        return None
    return int(match.group(1)) / 1024 if match else None
