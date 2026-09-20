"""
Diagnostics for "YouTube does not work from this host": what the cookies file contains (never the values),
and how far a connection to YouTube gets from THIS machine's network (DNS, TCP, TLS, HTTP).

No imports from the app, so it can be tested on its own.
"""

import re
import socket
import ssl
import time
from urllib.parse import urlparse

import httpx

# Names of the cookies that mean "this is a logged-in Google session". Names are not secret; values never leave this file.
AUTH_COOKIE_NAMES = frozenset(
    {"SID", "HSID", "SSID", "APISID", "SAPISID", "__Secure-1PSID", "__Secure-3PSID",
     "__Secure-1PAPISID", "__Secure-3PAPISID", "LOGIN_INFO"}
)


_CREDENTIALS = re.compile(r"([A-Za-z][A-Za-z0-9+.-]*)://[^/@\s:]+:[^/@\s]+@")


def redact_secrets(text, *secrets: str | None) -> str:
    """Remove proxy credentials (and any exact secret strings) from text that may be logged or returned."""
    text = _CREDENTIALS.sub(r"\1://<redacted>@", str(text))
    for secret in secrets:
        if secret:
            text = text.replace(secret, "<redacted>")
    return text


def proxy_host(proxy_url: str | None) -> str | None:
    """host:port of a proxy URL, without its credentials."""
    if not proxy_url:
        return None
    try:
        parsed = urlparse(proxy_url)
        return f"{parsed.hostname}:{parsed.port}" if parsed.port else parsed.hostname
    except ValueError:
        return None


def probe_proxy(proxy_url: str, timeout: float = 8.0) -> dict:
    """One tiny request to YouTube THROUGH the proxy (a few hundred bytes of its bandwidth). Blocking."""
    result: dict = {"host": proxy_host(proxy_url)}
    started = time.monotonic()
    try:
        with httpx.Client(proxy=proxy_url, timeout=timeout) as client:
            response = client.get("https://www.youtube.com/generate_204")
        result["status"] = response.status_code
        result["ok"] = response.status_code in (200, 204)
    except httpx.HTTPError as exc:
        result["ok"] = False
        result["error"] = type(exc).__name__
        result["detail"] = redact_secrets(str(exc), proxy_url)[:120]
    result["ms"] = round((time.monotonic() - started) * 1000)
    return result


def cookie_summary(path: str | None, now: float | None = None) -> dict:
    """What a Netscape cookies.txt holds, without ever including a value."""
    if not path:
        return {"detected": False}
    try:
        with open(path, encoding="utf8", errors="ignore") as handle:
            text = handle.read()
    except OSError as exc:
        return {"detected": True, "readable": False, "error": type(exc).__name__}
    now = time.time() if now is None else now
    names: set[str] = set()
    entries = expired = 0
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("#HttpOnly_"):
            line = line[len("#HttpOnly_"):]
        elif not line or line.startswith("#"):
            continue
        parts = line.split("\t")
        if len(parts) < 7:
            continue
        domain, expiry, name = parts[0], parts[4], parts[5]
        if "youtube" not in domain and "google" not in domain:
            continue
        entries += 1
        names.add(name)
        try:
            if 0 < int(expiry) < now:
                expired += 1
        except ValueError:
            pass
    present = sorted(names & AUTH_COOKIE_NAMES)
    return {
        "detected": True,
        "readable": True,
        "entries": entries,
        "expired": expired,
        "loggedIn": bool(present),
        "authCookiesPresent": present,
    }


def probe_network(host: str = "www.youtube.com", timeout: float = 5.0) -> dict:
    """
    How far a connection to `host` gets: DNS, TCP connect, TLS handshake, one tiny HTTP request.
    Each step reports milliseconds, or the exception's name where it stopped. Blocking.
    """
    result: dict = {"host": host}

    def since(started: float) -> int:
        return round((time.monotonic() - started) * 1000)

    started = time.monotonic()
    try:
        addresses = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
    except OSError as exc:
        result["dnsError"] = type(exc).__name__
        return result
    result["dnsMs"] = since(started)
    result["addresses"] = len(addresses)

    started = time.monotonic()
    try:
        sock = socket.create_connection(addresses[0][4][:2], timeout=timeout)
    except OSError as exc:
        result["tcpError"] = type(exc).__name__
        result["tcpWaitedMs"] = since(started)
        return result
    result["tcpMs"] = since(started)

    try:
        started = time.monotonic()
        context = ssl.create_default_context()
        with context.wrap_socket(sock, server_hostname=host) as tls:
            tls.settimeout(timeout)
            result["tlsMs"] = since(started)
            started = time.monotonic()
            tls.sendall(f"HEAD /generate_204 HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n".encode("ascii"))
            first_line = tls.recv(64).split(b"\r\n", 1)[0].decode("ascii", "replace")
            result["httpMs"] = since(started)
            result["httpStatus"] = first_line.split(" ")[1] if " " in first_line else first_line[:20]
    except (OSError, ssl.SSLError) as exc:
        result["tlsOrHttpError"] = type(exc).__name__
        result["waitedMs"] = since(started)
    finally:
        try:
            sock.close()
        except OSError:
            pass
    return result


def interpret(network: dict, lookup_ok: bool, code: str | None, trace: list[dict], cookies: dict,
              proxy: dict | None = None, proxy_setting: str | None = None) -> str:
    """One plain-language reading of the evidence."""
    if proxy_setting == "rejected":
        rejected = ("YTDLP_PROXY is set but could not be used, so YouTube is being fetched directly (no proxy). "
                    "Write it as http://USERNAME:PASSWORD@HOST:PORT (Webshare's HOST:PORT:USERNAME:PASSWORD is accepted too).")
        if lookup_ok:
            return "YouTube works from this host, but " + rejected[0].lower() + rejected[1:]
        return rejected
    if lookup_ok:
        return "YouTube works from this host." if not proxy else "YouTube works through the proxy."
    if proxy and not proxy.get("ok"):
        status = proxy.get("status")
        if status == 407:
            return "The proxy rejected the login (HTTP 407): check the username and password in YTDLP_PROXY."
        if status in (402, 403):
            return f"The proxy refused the request (HTTP {status}): the plan may be out of bandwidth or the account suspended."
        if proxy.get("error"):
            return (f"The proxy could not be reached or did not answer ({proxy['error']}): check the host and port in "
                    "YTDLP_PROXY and that the plan is active.")
        return f"The proxy answered HTTP {status}, which is not what YouTube's connectivity check returns."
    if "dnsError" in network:
        return "The host cannot resolve www.youtube.com (DNS). Nothing in the app can fix that."
    if "tcpError" in network:
        return ("The host cannot open a connection to YouTube (blocked or no route). No client list or cookies can help: "
                "YouTube must be reached through a proxy (YTDLP_PROXY) or from another host.")
    if "tlsOrHttpError" in network:
        return "YouTube accepts the connection but the secure handshake or first request stalls: typical of network-level blocking."
    requests = [entry for entry in trace if "request" in entry]
    stalled = [entry for entry in requests if entry.get("result") in ("TimeoutError", "ReadTimeout", "TransportError", "timeout")]
    if stalled:
        where = stalled[0]["request"]
        return (f"The network path to YouTube works, but the API request {where} stalls: YouTube is holding this host's "
                "requests back (usually an IP-level bot block). A proxy (YTDLP_PROXY) is the fix; cookies alone do not lift it.")
    if cookies.get("detected") and not cookies.get("loggedIn"):
        return "The cookies file is present but contains no logged-in Google session cookies; export it again while signed in."
    if code in ("STREAM_EXPIRED_OR_BLOCKED", "LOGIN_REQUIRED"):
        return "YouTube answered but refused (bot check or login wall). Fresh cookies from a signed-in throwaway account may help."
    return "The lookup failed for a reason the trace does not explain; see the trace and messages."
