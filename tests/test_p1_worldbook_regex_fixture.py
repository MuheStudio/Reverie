"""The worldbook regex bootstrap fixes only the registered reply starts
and records fixture-book writes and registered chats as metadata."""

from __future__ import annotations

import asyncio
import importlib.util
import json
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("p1_worldbook_regex_fixture",
                                              ROOT / "native-ui/tests/p1_worldbook_regex_backend_bootstrap.py")
fixture = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(fixture)


def events(root: Path) -> list[dict]:
    return [json.loads(line) for line in (root / "p1-worldbook-regex-metadata.jsonl").read_text().splitlines()]


def test_registered_turns_match_the_gui_check_and_the_host():
    texts = fixture.REGEX_REQUESTS
    assert len(set(texts)) == 3 and fixture.REGISTERED == {"regexChats": 3}
    check = (ROOT / "native-ui/tests/WorldbookRegexCheck.cpp").read_text(encoding="utf-8")
    verdicts = (ROOT / "native-ui/worldbook-regex-verdicts.cjs").read_text(encoding="utf-8")
    assert all(f'"{text}"' in check and (f"'{text}'" in verdicts or json.dumps(text, ensure_ascii=False) in verdicts) for text in texts)
    assert f'"{fixture.REGEX_BOOK_ID}"' in check and f"'{fixture.REGEX_BOOK_ID}'" in verdicts
    # Distinct registered prefixes keep scheduler dispatch identities unique;
    # each still supplies the same regex subject and no fixture content marker.
    assert texts == ("正则记录一：ID-12", "正则记录二：ID-12", "正则记录三：ID-12")
    assert all(text.endswith("ID-12") and "REGEX_" not in text for text in texts)
    assert [fixture.registered_stage(text, 1) for text in texts] == [1, 2, 3]
    assert [fixture.registered_stage(text, 2) for text in texts] == [0, 0, 0]
    assert fixture.registered_stage(texts[0] + " ", 1) == fixture.registered_stage(None, 1) == 0
    persona = importlib.util.spec_from_file_location("p1_persona_fixture_texts",
                                                     ROOT / "native-ui/tests/p1_persona_backend_bootstrap.py")
    module = importlib.util.module_from_spec(persona)
    assert persona.loader is not None
    persona.loader.exec_module(module)
    others = (module.WORLD_BOOK_REQUESTS + module.LITERAL_RULE_REQUESTS + module.PRIORITY_REQUESTS
              + module.BOOK_SETTINGS_REQUESTS)
    assert not set(texts) & set(others)


@pytest.mark.parametrize("cycle", [1, 2], ids=["first-cycle", "restart-cycle"])
def test_timing_overrides_only_registered_first_cycle_turns_once(tmp_path, monkeypatch, cycle):
    from src.chat.scheduler import MessageScheduler, ReplyStartPlan
    root = tmp_path.resolve()
    evidence = root / "p1-worldbook-regex-metadata.jsonl"
    monkeypatch.setattr(MessageScheduler, "plan_reply_start", lambda self, text, **kwargs: ReplyStartPlan(17, .5, "away", "ordinary"))
    monkeypatch.setattr(MessageScheduler, "calculate_delay", lambda self, length, intensity=0, **kwargs: 23.0)
    previous_start, previous_delay = MessageScheduler.plan_reply_start, MessageScheduler.calculate_delay
    undo = fixture.install_regex_request_timing(evidence, cycle)
    scheduler = MessageScheduler()
    try:
        for text in fixture.REGEX_REQUESTS:
            assert scheduler.plan_reply_start(text).start_delay == (0 if cycle == 1 else 17)
            assert scheduler.calculate_delay(12, user_message=text) == (.1 if cycle == 1 else 23)
        for text in ("书级记录一：远灯亮起", "你好，我喜欢和你一起看星空。", "条目记录"):
            assert scheduler.plan_reply_start(text).start_delay == 17
            assert scheduler.calculate_delay(12, user_message=text) == 23
        if cycle == 1:
            with pytest.raises(ValueError, match="repeated"):
                scheduler.plan_reply_start(fixture.REGEX_REQUESTS[0])
    finally:
        undo()
    assert MessageScheduler.plan_reply_start is previous_start and MessageScheduler.calculate_delay is previous_delay
    rows = events(root) if evidence.exists() else []
    assert [(row["event"], row["stage"], row["start_delay_ms"], row["delivery_delay_ms"]) for row in rows] == (
        [("regex_timing", stage, 0, 100) for stage in (1, 2, 3)] if cycle == 1 else [])
    if rows:
        assert evidence.stat().st_mode & 0o077 == 0
        assert not any(text in evidence.read_text() for text in fixture.REGEX_REQUESTS)


@pytest.mark.parametrize("cycle", [1, 2], ids=["first-cycle", "restart-cycle"])
def test_observer_records_fixture_book_writes_and_registered_chats_only(tmp_path, monkeypatch, cycle):
    from src.bridge import ws_bridge
    root = tmp_path.resolve()
    evidence = root / "p1-worldbook-regex-metadata.jsonl"
    scope = {"persona_id": "default", "persona_epoch": 3, "persona_fingerprint": "fixture-fingerprint"}
    monkeypatch.setattr(ws_bridge, "_active_persona_scope", lambda: dict(scope))
    dispatched = []

    async def original_dispatch(message, endpoint, **kwargs):
        dispatched.append(message)
        return {"ok": True}

    monkeypatch.setattr(ws_bridge, "dispatch_authenticated_message", original_dispatch)
    undo = fixture.install_regex_observer(evidence, cycle)
    book = {"id": fixture.REGEX_BOOK_ID, "name": "private book name", "entries": [{"content": "must not be collected"}]}
    fixture_write = {"type": "archive:put", "request_id": "regex_write",
                     "payload": {"archive": {"worldBooks": [{"id": "other"}, book]}, "expected_revision": 21}}
    other_write = {"type": "archive:put", "request_id": "ordinary_write",
                   "payload": {"archive": {"worldBooks": [{"id": "other"}]}, "expected_revision": 20}}
    try:
        assert asyncio.run(ws_bridge.dispatch_authenticated_message(other_write, None)) == {"ok": True}
        assert asyncio.run(ws_bridge.dispatch_authenticated_message(fixture_write, None)) == {"ok": True}
        for stage, text in enumerate(fixture.REGEX_REQUESTS, 1):
            message = {"type": "chat:send", "request_id": f"regex_request_{stage}", "payload": {"text": text}}
            assert asyncio.run(ws_bridge.dispatch_authenticated_message(message, None)) == {"ok": True}
        ordinary = {"type": "chat:send", "request_id": "ordinary_request", "payload": {"text": "普通消息"}}
        assert asyncio.run(ws_bridge.dispatch_authenticated_message(ordinary, None)) == {"ok": True}
        with pytest.raises(ValueError, match="identity"):
            asyncio.run(ws_bridge.dispatch_authenticated_message({**fixture_write, "request_id": "bad id"}, None))
    finally:
        undo()
    assert ws_bridge.dispatch_authenticated_message is original_dispatch and len(dispatched) == 6
    actual = [{k: v for k, v in row.items() if k not in {"schema", "monotonic_ns"}} for row in events(root)]
    expected = [{"event": "regex_archive_put_dispatch", "cycle": cycle, "request_id": "regex_write",
                 "expected_revision": 21, **scope}]
    if cycle == 1:
        expected += [{"event": "regex_dispatch", "cycle": 1, "stage": stage,
                      "request_id": f"regex_request_{stage}", **scope} for stage in (1, 2, 3)]
    assert actual == expected
    trace = evidence.read_text(encoding="utf-8")
    assert all(secret not in trace for secret in ("must not be collected", "private book name", str(root),
                                                  *fixture.REGEX_REQUESTS))


def test_only_the_host_registration_is_accepted(tmp_path, monkeypatch):
    root = tmp_path.resolve()
    data = root / "data-root"
    data.mkdir(mode=0o700)
    context = root / "qt-context.json"
    endpoint = "http://127.0.0.1:43123/v1"

    def snapshot(path: Path) -> dict:
        info = path.lstat()
        return {"path": str(path), "uid": info.st_uid, "device": str(info.st_dev), "inode": str(info.st_ino)}

    def write(**extra) -> None:
        value = {"schema": "reverie.qt.isolation.v1", "root": snapshot(root), "data": snapshot(data), **extra}
        context.write_text(json.dumps(value))
        context.chmod(0o600)

    def rejected() -> bool:
        try:
            fixture.validate_context(context, data, endpoint, data / "p1-worldbook-regex-metadata.jsonl", 1)
        except ValueError:
            return True
        return False

    for extra in ({}, {"p1_worldbook_regex": {"endpoint": endpoint}},
                  {"p1_worldbook_regex": {"endpoint": endpoint, "regexChats": 2}},
                  {"p1_worldbook_regex": {"endpoint": "http://127.0.0.1:43124/v1", "regexChats": 3}},
                  {"p1_worldbook_regex": {"endpoint": endpoint, "regexChats": 3}, "p1_persona": {}}):
        write(**extra)
        assert rejected(), extra
    write(p1_worldbook_regex={"endpoint": endpoint, "regexChats": 3})
    # The registered context alone is not enough outside the private desktop bootstrap.
    monkeypatch.delenv("REVERIE_BRIDGE_MODE", raising=False)
    assert rejected()


def test_worker_observer_records_actual_exit_state_once_and_restores_methods(tmp_path, monkeypatch):
    from src.worldbook.regex_supervisor import RegexSession
    root = tmp_path.resolve()
    evidence = root / "p1-worldbook-regex-metadata.jsonl"
    class Process:
        pid = 43210
        returncode = None
    process = Process()
    def attach(self, value):
        self._process = value
    async def cleanup(self):
        self._process.returncode = -15
        self._process = None
    monkeypatch.setattr(RegexSession, "_attach", attach)
    monkeypatch.setattr(RegexSession, "_cleanup", cleanup)
    monkeypatch.setattr(fixture.os, "getpgid", lambda pid: 12345)
    undo = fixture.install_regex_worker_observer(evidence, 1)
    session = RegexSession()
    try:
        session._attach(process)
        session._attach(process)  # Same attached process is not a second spawn.
        asyncio.run(session._cleanup())
    finally:
        undo()
    assert RegexSession._attach is attach and RegexSession._cleanup is cleanup
    rows = events(root)
    assert [x["event"] for x in rows] == ["regex_worker_spawn", "regex_worker_exit"]
    assert rows[0]["pid"] == rows[1]["pid"] == process.pid
    assert rows[0]["worker_id"] == rows[1]["worker_id"] == 1
    assert rows[0]["process_group"] == 12345 and rows[1]["returncode"] == -15
    assert all(x["bootstrap_pid"] == fixture.os.getpid() for x in rows)


def test_worker_observer_does_not_convert_unconfirmed_cleanup_to_exit(tmp_path, monkeypatch):
    from src.worldbook.regex_supervisor import RegexSession
    root = tmp_path.resolve()
    evidence = root / "p1-worldbook-regex-metadata.jsonl"
    class Process:
        pid = 43211
        returncode = None
    process = Process()
    def attach(self, value):
        self._process = value
    async def cleanup(self):
        raise RuntimeError("controlled-cleanup-failure")
    monkeypatch.setattr(RegexSession, "_attach", attach)
    monkeypatch.setattr(RegexSession, "_cleanup", cleanup)
    monkeypatch.setattr(fixture.os, "getpgid", lambda pid: 12345)
    undo = fixture.install_regex_worker_observer(evidence, 1)
    try:
        session = RegexSession()
        session._attach(process)
        with pytest.raises(RuntimeError, match="^controlled-cleanup-failure$"):
            asyncio.run(session._cleanup())
    finally:
        undo()
    assert [x["event"] for x in events(root)] == ["regex_worker_spawn", "regex_worker_cleanup_unconfirmed"]
    assert "returncode" not in events(root)[1]
