"""Broadcast resilience tests: slow/zombie peers must not block the bus."""

from __future__ import annotations

import asyncio

from src.bridge import ws_bridge


class SlowSocket:
    def __init__(self, delay: float) -> None:
        self.delay = delay
        self.sent: list[str] = []
        self.closed = False

    async def send(self, message: str) -> None:
        await asyncio.sleep(self.delay)
        self.sent.append(message)

    async def close(self, *args: object) -> None:
        self.closed = True


class FailingSocket:
    def __init__(self) -> None:
        self.sent: list[str] = []

    async def send(self, message: str) -> None:
        from websockets.exceptions import ConnectionClosed

        raise ConnectionClosed(rcvd=None, sent=None)

    async def close(self, *args: object) -> None:
        pass


def test_broadcast_skips_dead_connections_without_blocking(monkeypatch) -> None:
    monkeypatch.setattr(ws_bridge, "_connections", set())

    dead = FailingSocket()
    slow = SlowSocket(delay=0.01)
    ws_bridge._connections.add(dead)
    ws_bridge._connections.add(slow)

    asyncio.run(ws_bridge.broadcast("chat:state", {"state": "online"}))

    assert dead not in ws_bridge._connections, "dead peer must be pruned"
    assert slow in ws_bridge._connections, "healthy peer must survive"
    assert slow.sent, "healthy peer must receive the broadcast"


def test_broadcast_waits_for_all_peers_in_parallel(monkeypatch) -> None:
    monkeypatch.setattr(ws_bridge, "_connections", set())

    import time

    slow_a = SlowSocket(delay=0.05)
    slow_b = SlowSocket(delay=0.05)
    ws_bridge._connections.add(slow_a)
    ws_bridge._connections.add(slow_b)

    started = time.monotonic()
    asyncio.run(ws_bridge.broadcast("chat:state", {"state": "online"}))
    elapsed = time.monotonic() - started

    assert elapsed < 0.09, f"parallel fan-out expected, took {elapsed:.3f}s"
    assert len(slow_a.sent) == 1 and len(slow_b.sent) == 1
