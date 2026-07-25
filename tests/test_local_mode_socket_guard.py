import socket

import pytest

from src.local_mode import LocalModeBlocked, LocalModeGate, PythonSocketEgressGuard


def test_socket_guard_blocks_external_dns_and_connect_but_keeps_loopback() -> None:
    gate = LocalModeGate(desktop=False)
    gate.set(True, epoch=1, session_id="focus")
    guard = PythonSocketEgressGuard(gate)
    guard.install()
    try:
        with pytest.raises(LocalModeBlocked, match="DNS"):
            socket.getaddrinfo("example.invalid", 443)

        # Loopback lookup is still needed by the authenticated desktop bridge.
        loopback = socket.getaddrinfo("127.0.0.1", 0)
        assert loopback

        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            with pytest.raises(LocalModeBlocked, match="socket"):
                sock.connect(("203.0.113.1", 443))
        finally:
            sock.close()
    finally:
        guard.uninstall()


def test_socket_guard_reopens_only_after_authoritative_epoch_change(monkeypatch) -> None:
    gate = LocalModeGate(desktop=False)
    gate.set(True, epoch=4, session_id="focus")
    guard = PythonSocketEgressGuard(gate)
    calls: list[object] = []
    original = socket.getaddrinfo

    def fake_getaddrinfo(host, *_args, **_kwargs):
        calls.append(host)
        return [("ok",)]

    monkeypatch.setattr(socket, "getaddrinfo", fake_getaddrinfo)
    guard.install()
    try:
        with pytest.raises(LocalModeBlocked):
            socket.getaddrinfo("api.example.test", 443)
        assert calls == []

        gate.set(False, epoch=5, session_id="focus")
        assert socket.getaddrinfo("api.example.test", 443) == [("ok",)]
        assert calls == ["api.example.test"]
    finally:
        guard.uninstall()
        # Guard restores the function that was current when it was installed;
        # monkeypatch then restores the process original at fixture teardown.
        assert socket.getaddrinfo is fake_getaddrinfo
        assert original is not fake_getaddrinfo
