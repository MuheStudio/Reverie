"""The settings-section bootstrap fixes only the registered reply starts."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("p1_settings_fixture", ROOT / "native-ui/tests/p1_settings_backend_bootstrap.py")
fixture = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(fixture)


def events(root: Path) -> list[dict]:
    return [json.loads(line) for line in (root / "p1-settings-metadata.jsonl").read_text().splitlines()]


def test_registered_chat_turns_match_the_gui_sources_and_the_host():
    sources = "".join((ROOT / path).read_text(encoding="utf-8") for path in (
        "native-ui/src/main.cpp", "native-ui/tests/MoonroomInteractionCheck.cpp",
        "native-ui/tests/SettingsSectionsCheck.cpp"))
    assert len(set(fixture.REGISTERED_CHAT_TURNS)) == 7
    assert all(f'"{text}"' in sources for text in fixture.REGISTERED_CHAT_TURNS)
    assert [fixture.registered_chat_stage(text, 1) for text in fixture.REGISTERED_CHAT_TURNS] == list(range(1, 8))
    assert [fixture.registered_chat_stage(text, 2) for text in fixture.REGISTERED_CHAT_TURNS] == [0] * 7
    assert fixture.registered_chat_stage("设置记录一", 1) == fixture.registered_chat_stage(None, 1) == 0
    host = (ROOT / "native-ui/check-native.cjs").read_text(encoding="utf-8")
    lengths = ", ".join(str(len(text)) for text in fixture.REGISTERED_CHAT_TURNS)
    assert f"const SETTINGS_TURN_CHARACTERS = [{lengths}];" in host
    assert fixture.REGISTERED == {"registeredChats": 7}


def test_registered_reply_start_zeroes_only_the_wait_of_first_registered_turns(tmp_path, monkeypatch):
    from src.bridge import ws_bridge
    from src.chat.scheduler import ReplyStartPlan

    root = tmp_path.resolve()
    evidence = root / "p1-settings-metadata.jsonl"
    second_settings_chat = fixture.REGISTERED_CHAT_TURNS[6]
    wobble = ReplyStartPlan(41.25, 0.96, "online", "online_wobble")
    plans = iter([wobble, ReplyStartPlan(30.0, 0.96, "online", "online_wobble"), wobble, None, wobble])
    seen = []

    def original(text):
        seen.append(text)
        return next(plans)

    monkeypatch.setattr(ws_bridge, "_reply_start_planner", original)
    undo_override = fixture.install_registered_reply_start(evidence, 1)
    undo_observer = fixture.install_reply_start_observer(evidence, 1)
    wrapped = ws_bridge._reply_start_planner
    try:
        first = wrapped(second_settings_chat)
        unregistered = wrapped("设置记录三：私密正文")
        repeated = wrapped(second_settings_chat)
        unplanned = wrapped(fixture.REGISTERED_CHAT_TURNS[3])
    finally:
        undo_observer()
        undo_override()
    undo_override()
    undo_observer()
    assert ws_bridge._reply_start_planner is original
    assert seen == [second_settings_chat, "设置记录三：私密正文", second_settings_chat, fixture.REGISTERED_CHAT_TURNS[3]]
    assert (first.start_delay, first.immediate_probability, first.status, first.reason) == (
        0.0, 0.96, "online", fixture.FIXTURE_REPLY_START_REASON)
    assert unregistered.start_delay == 30.0 and repeated is wobble and unplanned is None

    undo_second = fixture.install_registered_reply_start(evidence, 2)
    try:
        assert ws_bridge._reply_start_planner(second_settings_chat) is wobble
    finally:
        undo_second()
    assert ws_bridge._reply_start_planner is original

    rows = events(root)
    assert [row["event"] for row in rows] == [
        "reply_start_fixture_override", "reply_start_planned", "reply_start_planned",
        "reply_start_fixture_override", "reply_start_planned",
        "reply_start_fixture_override", "reply_start_planned"]
    overrides = [row for row in rows if row["event"] == "reply_start_fixture_override"]
    assert [(row["stage"], row["repeated"], row["fixtureOverride"], row["appliedDelayMs"],
             row["productionPlanned"], row["productionStartDelayMs"], row["productionImmediate"],
             row["productionReason"]) for row in overrides] == [
        (7, False, True, 0, True, 41250, False, "online_wobble"),
        (7, True, False, 41250, True, 41250, False, "online_wobble"),
        (4, False, False, None, False, None, False, "")]
    assert all(set(row) == {"schema", "event", "cycle", "monotonic_ns", "stage", "repeated", "fixtureOverride",
                            "appliedDelayMs", "productionPlanned", "productionStartDelayMs", "productionImmediate",
                            "productionProbability", "productionStatus", "productionReason"} for row in overrides)
    planned = [row for row in rows if row["event"] == "reply_start_planned"]
    assert [(row["startDelayMs"], row["immediate"], row["reason"], row["textCharacters"]) for row in planned] == [
        (0, True, fixture.FIXTURE_REPLY_START_REASON, 19), (30000, False, "online_wobble", 10),
        (41250, False, "online_wobble", 19), (None, False, "", 4)]
    assert all(set(row) == {"schema", "event", "cycle", "monotonic_ns", "planned", "textCharacters",
                            "startDelayMs", "immediate", "probability", "status", "reason"} for row in planned)
    assert all(row["cycle"] == 1 and row["schema"] == "reverie.qt.p1-settings-metadata.v1" for row in rows)
    trace = evidence.read_text(encoding="utf-8")
    assert all(secret not in trace for secret in ("私密正文", "设置记录", "停止记录", str(root)))
    assert evidence.stat().st_mode & 0o077 == 0


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
            fixture.validate_context(context, data, endpoint, data / "p1-settings-metadata.jsonl", 1)
        except ValueError:
            return True
        return False

    for extra in ({}, {"p1_settings": {"endpoint": endpoint}},
                  {"p1_settings": {"endpoint": endpoint, "registeredChats": 6}},
                  {"p1_settings": {"endpoint": "http://127.0.0.1:43124/v1", "registeredChats": 7}},
                  {"p1_settings": {"endpoint": endpoint, "registeredChats": 7}, "p1_memory": {}}):
        write(**extra)
        assert rejected(), extra
    write(p1_settings={"endpoint": endpoint, "registeredChats": 7})
    # The registered context alone is not enough outside the private desktop bootstrap.
    monkeypatch.delenv("REVERIE_BRIDGE_MODE", raising=False)
    assert rejected()
