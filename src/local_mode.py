"""Fail-closed runtime gate for desktop network and model activity.

The desktop process starts in UNKNOWN until its authenticated controller declares
the current local-mode value.  Command-line use keeps the historical permissive
default so maintenance scripts are not silently broken.
"""

from __future__ import annotations

import os
import ipaddress
import socket
import threading
from dataclasses import dataclass
from typing import Any, Callable


class LocalModeBlocked(RuntimeError):
    """Raised before an operation that local mode forbids can start."""


@dataclass(frozen=True)
class LocalModeSnapshot:
    state: str
    enabled: bool
    declared: bool
    epoch: int
    session_id: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "state": self.state,
            "enabled": self.enabled,
            "declared": self.declared,
            "epoch": self.epoch,
            "session_id": self.session_id,
        }


class LocalModeGate:
    """One central, synchronous decision point for all remote work."""

    def __init__(self, *, desktop: bool | None = None) -> None:
        if desktop is None:
            desktop = os.getenv("REVERIE_BRIDGE_MODE", "").strip() == "1"
        self._desktop = bool(desktop)
        self._declared = not self._desktop
        self._enabled = False
        self._epoch = 0
        self._session_id = ""
        self._lock = threading.RLock()

    def set(
        self,
        enabled: bool,
        *,
        session_id: str = "",
        epoch: int | None = None,
    ) -> LocalModeSnapshot:
        """Declare a value with stale-update rejection and idempotent replay.

        Electron owns the persisted focus epoch.  Reconnects may repeat the
        same declaration, while an older renderer must never reopen the gate.
        """
        with self._lock:
            requested_epoch = self._epoch + 1 if epoch is None else int(epoch)
            if requested_epoch < 0:
                raise ValueError("local mode epoch must be non-negative")
            requested_session = str(session_id or "")
            requested_enabled = bool(enabled)
            if requested_epoch < self._epoch:
                raise ValueError("stale local mode epoch")
            if requested_epoch == self._epoch and self._declared:
                if (
                    requested_enabled == self._enabled
                    and requested_session == self._session_id
                ):
                    return self._snapshot_unlocked()
                raise ValueError("conflicting local mode declaration for current epoch")
            self._declared = True
            self._enabled = requested_enabled
            self._session_id = requested_session
            self._epoch = requested_epoch
            return self._snapshot_unlocked()

    def configure_desktop(self, enabled: bool) -> LocalModeSnapshot:
        """Select runtime trust semantics before background modules start."""
        with self._lock:
            enabled = bool(enabled)
            self._desktop = enabled
            if enabled:
                # Every desktop process and reconnect starts closed until its
                # authenticated Electron controller re-declares persisted state.
                self._declared = False
                self._enabled = False
                self._session_id = ""
                self._epoch = 0
            else:
                self._declared = True
                self._enabled = False
                self._session_id = ""
                self._epoch = 0
            return self._snapshot_unlocked()

    def snapshot(self) -> LocalModeSnapshot:
        with self._lock:
            return self._snapshot_unlocked()

    def _snapshot_unlocked(self) -> LocalModeSnapshot:
        if self._desktop and not self._declared:
            state = "unknown"
        else:
            state = "enabled" if self._enabled else "disabled"
        return LocalModeSnapshot(
            state=state,
            enabled=self._enabled,
            declared=self._declared,
            epoch=self._epoch,
            session_id=self._session_id,
        )

    def blocks_remote(self) -> bool:
        with self._lock:
            return self._enabled or (self._desktop and not self._declared)

    def require_remote(self, operation: str = "remote operation") -> None:
        if self.blocks_remote():
            raise LocalModeBlocked(f"{operation} is disabled by local mode")


def _is_loopback_host(host: object) -> bool:
    """Return True only when no external DNS lookup is required."""

    if isinstance(host, bytes):
        try:
            host = host.decode("ascii", errors="strict")
        except UnicodeDecodeError:
            return False
    value = str(host or "").strip().rstrip(".").lower()
    if value == "localhost":
        return True
    if not value:
        return False
    # IPv6 scope identifiers aren't part of the address parsed by ipaddress.
    if "%" in value:
        value = value.split("%", 1)[0]
    try:
        return ipaddress.ip_address(value).is_loopback
    except ValueError:
        return False


class PythonSocketEgressGuard:
    """Process-wide last line of defence for desktop local mode.

    Feature-level gates remain the primary policy boundary because they can
    provide useful errors and cancel work.  This guard prevents an optional
    module that forgot that boundary from performing external DNS resolution
    or opening a new external socket.  Loopback remains available for the
    authenticated Electron bridge itself.
    """

    def __init__(self, gate: LocalModeGate) -> None:
        self.gate = gate
        self._lock = threading.RLock()
        self._installed = False
        self._original_getaddrinfo: Callable[..., Any] | None = None
        self._original_connect: Callable[..., Any] | None = None
        self._original_connect_ex: Callable[..., Any] | None = None

    def _require_host(self, host: object, operation: str) -> None:
        if self.gate.blocks_remote() and not _is_loopback_host(host):
            raise LocalModeBlocked(f"{operation} is disabled by local mode")

    def install(self) -> None:
        with self._lock:
            if self._installed:
                return
            original_getaddrinfo = socket.getaddrinfo
            original_connect = socket.socket.connect
            original_connect_ex = socket.socket.connect_ex
            guard = self

            def guarded_getaddrinfo(host, *args, **kwargs):
                guard._require_host(host, "external DNS lookup")
                return original_getaddrinfo(host, *args, **kwargs)

            def guarded_connect(sock, address):
                # AF_UNIX uses a filesystem string, not a host/port pair.
                if sock.family != getattr(socket, "AF_UNIX", object()):
                    host = address[0] if isinstance(address, tuple) and address else address
                    guard._require_host(host, "external socket connection")
                return original_connect(sock, address)

            def guarded_connect_ex(sock, address):
                if sock.family != getattr(socket, "AF_UNIX", object()):
                    host = address[0] if isinstance(address, tuple) and address else address
                    guard._require_host(host, "external socket connection")
                return original_connect_ex(sock, address)

            self._original_getaddrinfo = original_getaddrinfo
            self._original_connect = original_connect
            self._original_connect_ex = original_connect_ex
            socket.getaddrinfo = guarded_getaddrinfo
            socket.socket.connect = guarded_connect
            socket.socket.connect_ex = guarded_connect_ex
            self._installed = True

    def uninstall(self) -> None:
        """Restore the exact socket functions; intended for tests/shutdown."""

        with self._lock:
            if not self._installed:
                return
            assert self._original_getaddrinfo is not None
            assert self._original_connect is not None
            assert self._original_connect_ex is not None
            socket.getaddrinfo = self._original_getaddrinfo
            socket.socket.connect = self._original_connect
            socket.socket.connect_ex = self._original_connect_ex
            self._installed = False


_LOCAL_MODE_GATE = LocalModeGate()
_SOCKET_EGRESS_GUARD = PythonSocketEgressGuard(_LOCAL_MODE_GATE)


def get_local_mode_gate() -> LocalModeGate:
    return _LOCAL_MODE_GATE


def install_desktop_socket_guard() -> PythonSocketEgressGuard:
    """Install and return the singleton desktop egress guard."""

    _SOCKET_EGRESS_GUARD.install()
    return _SOCKET_EGRESS_GUARD
