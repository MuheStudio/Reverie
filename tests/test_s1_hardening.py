"""S1 hardening tests: idempotency short-circuit, epoch lock, overflow
validation, asset whitelist, image fetch limits and world-clock timezone
consistency.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import MagicMock

import httpx
import pytest

from src.archive.store import ArchiveStore
from src.games.state_store import _validate_json
from src.image_service.wrapper import MAX_IMAGE_BYTES, FoxgirlImageService
from src.kernel.command_bus import CommandBus
from src.kernel.contracts import CommandEnvelopeV4, ErrorCode, PersonaScopeV4
from src.kernel.storage import IdempotencyConflict, KernelStore


@pytest.fixture
def store(tmp_path: Path) -> KernelStore:
    kernel = KernelStore(path=tmp_path / "kernel.db")
    yield kernel
    kernel.close()


@pytest.fixture
def persona() -> PersonaScopeV4:
    return PersonaScopeV4(
        persona_id="persona_test",
        epoch=1,
        fingerprint="a" * 64,
    )


def _command(persona: PersonaScopeV4, request_id: str) -> CommandEnvelopeV4:
    return CommandEnvelopeV4(
        request_id=request_id,
        idempotency_key=request_id,
        command="memory:store",
        persona=persona,
        payload={"text": "hello", "layer": "long_term"},
    )


# ── S1-1: failed idempotency short-circuit ────────────────────


def test_failed_idempotency_short_circuits_without_replaying_handler(
    store: KernelStore, persona: PersonaScopeV4
) -> None:
    bus = CommandBus(store)
    request = _command(persona, "req-failed-replay")
    store.begin_command(request)
    store.fail_command(request.request_id, error_code="INVALID_REQUEST")
    calls: list[str] = []

    async def handler(_request):
        calls.append("handler-ran")
        return {"ok": True}

    bus.register("memory:store", handler)
    result = asyncio.run(bus.dispatch(request))

    assert result.ok is False
    assert result.error.code == ErrorCode.CONFLICT
    assert calls == [], "handler must not run again for a terminal failed record"


def test_committed_idempotency_returns_cached_result_without_replay(
    store: KernelStore, persona: PersonaScopeV4
) -> None:
    bus = CommandBus(store)
    request = _command(persona, "req-committed-cache")
    store.begin_command(request)
    store.commit_command_result(request, {"cached": True})
    calls: list[str] = []

    async def handler(_request):
        calls.append("handler-ran")
        return {"fresh": True}

    bus.register("memory:store", handler)
    result = asyncio.run(bus.dispatch(request))

    assert result.ok is True
    assert result.data == {"cached": True}
    assert calls == []


# ── S1-2: epoch regression lock (adversarial audit result) ────


def _scope(persona_id: str, epoch: int, fingerprint: str) -> PersonaScopeV4:
    return PersonaScopeV4(persona_id=persona_id, epoch=epoch, fingerprint=fingerprint)


def test_epoch_regression_with_identity_change_is_rejected(
    store: KernelStore,
) -> None:
    active = _scope("p1", 6, "a" * 64)
    store.activate_persona(
        active,
        identity={"name": "one"},
        identity_version=1,
        actor="owner",
        reason="initial",
    )
    stale_identity = _scope("p1", 4, "b" * 64)
    with pytest.raises(IdempotencyConflict):
        store.activate_persona(
            stale_identity,
            identity={"name": "two"},
            identity_version=2,
            actor="owner",
            reason="stale rollback attempt",
        )
    current = store.active_persona()
    assert current is not None
    assert current.epoch == 6
    assert current.fingerprint == "a" * 64


def test_same_identity_replay_remains_allowed(
    store: KernelStore,
) -> None:
    active = _scope("p1", 6, "a" * 64)
    store.activate_persona(
        active,
        identity={"name": "one"},
        identity_version=1,
        actor="owner",
        reason="initial",
    )
    replay = _scope("p1", 4, "a" * 64)
    store.activate_persona(
        replay,
        identity={"name": "one"},
        identity_version=1,
        actor="owner",
        reason="idempotent replay of the same identity",
    )
    current = store.active_persona()
    assert current is not None
    assert current.fingerprint == "a" * 64


# ── S1-3: overflow in numeric validation ──────────────────────


def test_overflow_in_validate_is_caught_as_value_error() -> None:
    with pytest.raises(ValueError):
        _validate_json(10**400)
    with pytest.raises(ValueError):
        _validate_json(-(10**400))
    _validate_json(1e308)
    _validate_json(42)


# ── S1-4: asset reference whitelist ───────────────────────────


def _sample_archive() -> dict:
    from tests.test_archive_store import sample_archive

    return sample_archive()


def test_asset_reference_rejects_javascript_protocol(tmp_path: Path) -> None:
    store = ArchiveStore(tmp_path / "archive.sqlite3")
    try:
        archive = _sample_archive()
        archive["characters"][0]["portraitUrl"] = "javascript:alert(1)"
        with pytest.raises(ValueError):
            store.put("persona-a", archive, expected_revision=0)
    finally:
        store.close()


def test_asset_reference_rejects_encoded_traversal(tmp_path: Path) -> None:
    store = ArchiveStore(tmp_path / "archive.sqlite3")
    try:
        archive = _sample_archive()
        archive["characters"][0]["portraitUrl"] = "/characters/%2e%2e/secret.jpg"
        with pytest.raises(ValueError):
            store.put("persona-a", archive, expected_revision=0)
    finally:
        store.close()


def test_asset_reference_rejects_unrooted_path(tmp_path: Path) -> None:
    store = ArchiveStore(tmp_path / "archive.sqlite3")
    try:
        archive = _sample_archive()
        archive["characters"][0]["portraitUrl"] = "characters/friend-one.jpg"
        with pytest.raises(ValueError):
            store.put("persona-a", archive, expected_revision=0)
    finally:
        store.close()


def test_asset_reference_allows_rooted_local_path(tmp_path: Path) -> None:
    store = ArchiveStore(tmp_path / "archive.sqlite3")
    try:
        archive = _sample_archive()
        result = store.put("persona-a", archive, expected_revision=0)
        assert result["exists"] is True
    finally:
        store.close()


# ── S1-5: image fetch size limit + no redirects ───────────────


class _FakeResponse:
    status_code = 200

    def raise_for_status(self):
        return None

    @property
    def headers(self):
        return {"content-type": "image/png"}


class _BigBodyResponse(_FakeResponse):
    @property
    def content(self):
        return b"x" * (MAX_IMAGE_BYTES + 1)


class _SmallBodyResponse(_FakeResponse):
    @property
    def content(self):
        return b"abc"


def _make_service(tmp_path: Path, response) -> FoxgirlImageService:
    db = tmp_path / "db.json"
    db.write_text('{"sfw": {"abc": {"url": "https://example.com/a.jpg"}}}', encoding="utf-8")
    service = FoxgirlImageService(db)
    return service


def _patch_httpx_client(monkeypatch, response, seen: dict) -> None:
    class FakeClient:
        def __init__(self, *args, **kwargs):
            seen["follow_redirects"] = kwargs.get("follow_redirects")

        def get(self, *args, **kwargs):
            return response

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    monkeypatch.setattr(httpx, "Client", FakeClient)


def test_image_fetch_enforces_size_limit(monkeypatch, tmp_path: Path) -> None:
    service = _make_service(tmp_path, _BigBodyResponse())
    _patch_httpx_client(monkeypatch, _BigBodyResponse(), {})
    result = asyncio.run(service.get_random("sfw"))
    assert result["url"] is None
    assert "安全大小" in result["error"]


def test_image_fetch_disables_redirects(monkeypatch, tmp_path: Path) -> None:
    seen: dict = {}
    service = _make_service(tmp_path, _SmallBodyResponse())
    _patch_httpx_client(monkeypatch, _SmallBodyResponse(), seen)
    result = asyncio.run(service.get_random("sfw"))
    assert result["url"] is not None
    assert result["url"].startswith("data:image/png;base64,")
    assert seen["follow_redirects"] is False


# ── S1-6: world-clock timezone consistency ────────────────────


class FixedWorldClock:
    """A world clock pinned to a fixed hour, independent of the process TZ."""

    def __init__(self, hour: int):
        self.hour = hour

    def now(self):
        base = datetime(2026, 1, 1, self.hour, 0, 0, tzinfo=timezone.utc)
        return base.astimezone(timezone.utc)

    def coerce(self, value=None):
        return (value or datetime.now()).replace(tzinfo=None)


def test_proactive_clock_is_injected() -> None:
    from src.chat.proactive import ProactiveChat
    from src.emotion.system import EmotionSystem
    from src.persona.persona_card import default_persona

    proactive = ProactiveChat(
        default_persona(),
        adapter=None,
        emotion=EmotionSystem(),
        state_path=None,
    )
    assert proactive.world_clock is not None
    # The naive wall time comes from the world clock, not the process TZ.
    naive = proactive.world_clock.now().replace(tzinfo=None)
    assert naive.tzinfo is None


def test_scheduler_sleep_window_uses_world_clock() -> None:
    from src.chat.scheduler import MessageScheduler

    scheduler = MessageScheduler()
    assert scheduler.world_clock is None  # default: process-local fallback
    scheduler.world_clock = FixedWorldClock(hour=2)
    assert scheduler._now_local().hour == 2
    assert scheduler._now_local().tzinfo is None


def test_diary_date_boundary_uses_world_clock(tmp_path: Path) -> None:
    from src.diary import DiaryManager
    from src.persona.persona_card import default_persona

    diary = DiaryManager(
        default_persona(),
        diary_dir=tmp_path / "diary",
        world_clock=FixedWorldClock(hour=23),
    )
    assert diary._now_local().hour == 23
    assert diary._now_local().tzinfo is None


def test_interest_and_affairs_accept_world_clock(tmp_path: Path) -> None:
    from src.affairs.manager import PersonalAffairManager
    from src.interest.tracker import InterestTracker

    interest = InterestTracker(data_dir=tmp_path / "interest", world_clock=FixedWorldClock(hour=2))
    assert interest._now_local().hour == 2

    affairs = PersonalAffairManager(
        data_dir=tmp_path / "affairs",
        interest_tracker=interest,
        world_clock=FixedWorldClock(hour=2),
    )
    assert affairs._now_local().hour == 2
