"""Outbound destination checks for the supported provider transports."""

from __future__ import annotations

import asyncio
import ipaddress
import socket
from urllib.parse import urlsplit


_OFFICIAL_PROVIDER_HOSTS = {
    "openai": "api.openai.com",
    "anthropic": "api.anthropic.com",
    "gemini": "generativelanguage.googleapis.com",
    "grok": "api.x.ai",
    "deepseek": "api.deepseek.com",
    "kimi": "api.moonshot.cn",
    "glm": "api.z.ai",
}


def _resolve_addresses(host: str, port: int) -> set[ipaddress.IPv4Address | ipaddress.IPv6Address]:
    rows = socket.getaddrinfo(
        host,
        port,
        type=socket.SOCK_STREAM,
        proto=socket.IPPROTO_TCP,
    )
    addresses = {
        ipaddress.ip_address(str(row[4][0]).split("%", 1)[0])
        for row in rows
    }
    if not addresses:
        raise OSError("Provider hostname resolved to no addresses")
    return addresses


async def assert_provider_destination(provider: str, base_url: str) -> None:
    """Fail closed if a remote provider resolves to a private network."""

    parsed = urlsplit(str(base_url))
    host = parsed.hostname or ""
    if provider == "ollama":
        if host not in {"localhost", "127.0.0.1", "::1"}:
            raise PermissionError("Ollama must remain on the local loopback interface")
        return
    expected_host = _OFFICIAL_PROVIDER_HOSTS.get(provider)
    if expected_host:
        if parsed.scheme != "https" or host.rstrip(".").lower() != expected_host:
            raise PermissionError("Named provider endpoint is not its official HTTPS host")
    elif provider != "custom" or parsed.scheme != "https" or not host:
        raise PermissionError("Remote providers require an HTTPS hostname")
    port = parsed.port or 443
    # DNS rebinding protection matters for user-supplied custom endpoints.
    # Official named providers pin the hostname and go through TLS; their
    # addresses may legitimately sit behind a local proxy/VPN resolver (for
    # example 198.18.0.0/15 test ranges used by some network tools), so the
    # public-address check would only produce false denials there.
    if provider == "custom":
        addresses = await asyncio.to_thread(_resolve_addresses, host, port)
        if any(not address.is_global for address in addresses):
            raise PermissionError("Custom provider DNS resolved to a non-public address")
        # NOTE: `is_global` covers private, loopback, link-local, CGNAT
        # (100.64.0.0/10), benchmark (198.18.0.0/15) and IPv4-mapped IPv6
        # (::ffff:x.x.x.x) ranges. A DNS-rebinding TOCTOU remains in theory
        # (a hostile resolver returning a public answer for the check above
        # and a private one for the later connect), but pinning the resolved
        # address would break TLS hostname verification for the official
        # HTTPS transport, so the residual window is accepted and the
        # check is defense-in-depth rather than a boundary guarantee.
