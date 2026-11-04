from __future__ import annotations

import importlib.util
import asyncio
import base64
import json
from pathlib import Path
import struct
import zlib

import pytest

from src.config import settings

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("p1_persona_fixture", ROOT / "native-ui/tests/p1_persona_backend_bootstrap.py")
fixture = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(fixture)


@pytest.fixture
def isolated(tmp_path, monkeypatch):
    root = tmp_path.resolve()
    monkeypatch.setattr(settings, "PERSONA_DIR", root / "data" / "persona")
    return root


def events(root: Path) -> list[dict]:
    return [json.loads(line) for line in (root / "p1-persona-metadata.jsonl").read_text().splitlines()]


def test_first_cycle_seeds_one_inactive_profile_beside_the_default(isolated):
    fixture.seed(isolated / "p1-persona-metadata.jsonl", 1)

    registry = json.loads((isolated / "data/persona/registry.json").read_text(encoding="utf-8"))
    assert registry["active_id"] == "default"
    assert len(registry["profiles"]) == 2
    seeded, bootstrap = events(isolated)
    assert seeded["event"] == "persona_seeded" and seeded["profile_id"] in registry["profiles"]
    assert bootstrap["active_id"] == "default"
    assert sorted(bootstrap["profile_ids"]) == sorted(registry["profiles"])
    # Metadata only: the synthetic card's text never reaches the evidence file.
    trace = (isolated / "p1-persona-metadata.jsonl").read_text(encoding="utf-8")
    assert fixture.SEEDED_NAME not in trace and str(isolated) not in trace
    assert (isolated / "p1-persona-metadata.jsonl").stat().st_mode & 0o077 == 0
    for name in fixture.GUI_CARD_FILES.values():
        assert (isolated / name).stat().st_mode & 0o077 == 0
    assert not any(profile["name"] == fixture.GUI_CARD_NAME for profile in registry["profiles"].values())


def test_second_cycle_only_observes_and_a_used_store_is_refused(isolated):
    fixture.seed(isolated / "p1-persona-metadata.jsonl", 1)
    before = (isolated / "data/persona/registry.json").read_bytes()

    fixture.seed(isolated / "p1-persona-metadata.jsonl", 2)

    assert (isolated / "data/persona/registry.json").read_bytes() == before
    assert [e["event"] for e in events(isolated)] == ["persona_seeded", "bootstrap", "bootstrap"]
    with pytest.raises(ValueError, match="fresh identity store"):
        fixture.seed(isolated / "p1-persona-metadata.jsonl", 1)


def test_persona_store_outside_the_isolated_data_is_refused(tmp_path, monkeypatch):
    root = tmp_path.resolve()
    monkeypatch.setattr(settings, "PERSONA_DIR", root / "elsewhere" / "persona")
    with pytest.raises(ValueError, match="outside isolation"):
        fixture.seed(root / "p1-persona-metadata.jsonl", 1)
    assert not (root / "elsewhere").exists()


def png_chunks(raw: bytes):
    assert raw.startswith(b"\x89PNG\r\n\x1a\n")
    at = 8
    chunks = []
    while at < len(raw):
        length = struct.unpack(">I", raw[at:at + 4])[0]
        kind = raw[at + 4:at + 8]
        content = raw[at + 8:at + 8 + length]
        crc = struct.unpack(">I", raw[at + 8 + length:at + 12 + length])[0]
        assert crc == zlib.crc32(kind + content) & 0xFFFFFFFF
        chunks.append((kind, content))
        at += length + 12
    assert at == len(raw) and chunks[-1] == (b"IEND", b"")
    return chunks


def card_json(raw: bytes) -> bytes:
    encoded = next(value for kind, value in png_chunks(raw) if kind == b"tEXt")
    assert encoded.startswith(b"chara\0")
    return base64.b64decode(encoded.split(b"\0", 1)[1], validate=True)


def test_gui_png_inputs_are_valid_complete_and_keep_two_quarantined_prompts(isolated):
    from src.persona.sillytavern_import import parse_sillytavern_json

    fixture.seed(isolated / "p1-persona-metadata.jsonl", 1)
    plain = png_chunks((isolated / fixture.GUI_CARD_FILES["plain"]).read_bytes())
    card = png_chunks((isolated / fixture.GUI_CARD_FILES["valid"]).read_bytes())
    assert all(kind != b"tEXt" for kind, _ in plain)
    assert zlib.decompress(next(value for kind, value in card if kind == b"IDAT")) == b"\0\x24\x62\x80\xff"
    encoded = next(value for kind, value in card if kind == b"tEXt")
    assert encoded.startswith(b"chara\0")
    raw = base64.b64decode(encoded.split(b"\0", 1)[1], validate=True)
    report = parse_sillytavern_json(raw)
    assert report.persona.name == fixture.GUI_CARD_NAME
    assert len(report.character_book) == 1
    assert report.character_book[0]["content"] == fixture.GUI_CARD_CONTENT
    assert report.ignored_fields == ["system_prompt:stored_untrusted", "post_history_instructions:stored_untrusted"]
    assert report.metadata["imported_system_prompt"] == fixture.GUI_CARD_PROMPT
    assert report.metadata["imported_post_history_instructions"] == fixture.GUI_CARD_POST_HISTORY


def test_flagged_png_input_holds_two_flagged_prompts_and_no_world_book(isolated):
    from src.persona.sillytavern_import import author_prompt_flags, parse_sillytavern_json

    fixture.seed(isolated / "p1-persona-metadata.jsonl", 1)
    report = parse_sillytavern_json(card_json((isolated / fixture.GUI_CARD_FILES["flagged"]).read_bytes()))
    assert report.persona.name == fixture.FLAGGED_CARD_NAME
    assert report.character_book == []
    assert report.ignored_fields == ["system_prompt:untrusted_injection",
                                     "post_history_instructions:untrusted_injection"]
    # Quarantined, not dropped: the review shows the original text.
    assert report.persona.identity["imported_system_prompt"] == fixture.FLAGGED_CARD_PROMPT
    assert report.persona.identity["imported_post_history_instructions"] == fixture.FLAGGED_CARD_POST_HISTORY
    assert author_prompt_flags(fixture.FLAGGED_CARD_PROMPT)
    assert author_prompt_flags(fixture.FLAGGED_CARD_POST_HISTORY)
    assert author_prompt_flags(fixture.GUI_CARD_PROMPT) == []
    assert author_prompt_flags(fixture.GUI_CARD_POST_HISTORY) == []


@pytest.mark.parametrize(("card", "refused"), [("gui_card", None), ("flagged_card", "author_prompt_untrusted")])
def test_fixture_switches_follow_the_backend_rule(card, refused, monkeypatch):
    from types import SimpleNamespace

    from src.bridge import ws_bridge
    from src.persona.sillytavern_import import parse_sillytavern_json

    report = parse_sillytavern_json(getattr(fixture, card)())
    monkeypatch.setattr(ws_bridge.bridge_state, "session", SimpleNamespace(persona=report.persona))
    previous = {"characters": [{"id": "card", "useImportedSystemPrompt": False,
                                "useImportedPostHistoryInstructions": False}]}
    for switch in ("useImportedSystemPrompt", "useImportedPostHistoryInstructions"):
        proposed = {"characters": [{**previous["characters"][0], switch: True}]}
        refusal = ws_bridge._author_prompt_switch_refusal(previous, proposed)
        assert (refusal or {}).get("code") == refused


def test_second_cycle_observes_a_gui_profile_and_refuses_changed_input(isolated):
    from src.persona.sillytavern_import import parse_sillytavern_json, save_imported_persona

    evidence = isolated / "p1-persona-metadata.jsonl"
    fixture.seed(evidence, 1)
    save_imported_persona(parse_sillytavern_json(fixture.gui_card()), settings.PERSONA_DIR)
    before = (isolated / "data/persona/registry.json").read_bytes()
    fixture.seed(evidence, 2)
    assert (isolated / "data/persona/registry.json").read_bytes() == before
    assert events(isolated)[-1]["active_id"] == "default"
    assert len(events(isolated)[-1]["profile_ids"]) == 3
    (isolated / fixture.GUI_CARD_FILES["valid"]).write_bytes(fixture.synthetic_png())
    with pytest.raises(ValueError, match="input changed"):
        fixture.prepare_card_files(isolated, 2)


def test_import_observer_records_receipt_metadata_without_payload_or_paths(isolated, monkeypatch):
    from src.bridge import ws_bridge

    payload = {"ok": True, "saved": True, "activated": True, "runtime_ready": True,
               "partial_write": False, "world_book_imported": True, "world_book_entry_count": 1,
               "warnings": ["private card text"], "ignored_fields": ["system_prompt:stored_untrusted"],
               "persona": {"name": fixture.GUI_CARD_NAME}, "filename": str(isolated),
               "imported_system_prompt": fixture.GUI_CARD_PROMPT}

    async def dispatch(message, endpoint, **kwargs):
        return payload

    async def send(endpoint, msg_type, result, *, request_id=""):
        assert result is payload
        return True

    monkeypatch.setattr(ws_bridge, "dispatch_authenticated_message", dispatch)
    monkeypatch.setattr(ws_bridge, "send_to_frontend", send)
    undo = fixture.install_import_observer(isolated / "p1-persona-metadata.jsonl", 1)

    async def observe():
        # Persona activation uses this same response type, but belongs to the
        # preserved switch scenario rather than the two card import requests.
        await ws_bridge.send_to_frontend(None, "persona:import:result", payload, request_id="earlier_switch_123")
        result = await ws_bridge.dispatch_authenticated_message(
            {"type": "persona:import", "request_id": "fixture_request_123", "payload": {"json": fixture.gui_card()}}, None)
        assert result is payload
        await ws_bridge.send_to_frontend(None, "persona:import:result", result, request_id="fixture_request_123")

    try:
        asyncio.run(observe())
    finally:
        undo()
    recorded = events(isolated)
    assert [item["event"] for item in recorded] == ["import_dispatch", "import_result", "import_receipt"]
    assert all(item["request_id"] == "fixture_request_123" for item in recorded)
    assert recorded[-1]["emitted"] is True and recorded[-1]["quarantined_field_count"] == 1
    # Import results have no schema field; a projection of one could never be valid.
    assert "receipt_schema" not in recorded[-1]
    trace = (isolated / "p1-persona-metadata.jsonl").read_text()
    for private in (fixture.GUI_CARD_NAME, fixture.GUI_CARD_PROMPT, "private card text", str(isolated)):
        assert private not in trace


@pytest.mark.parametrize("cycle", [1, 2])
def test_worldbook_timing_is_limited_to_registered_four_plus_four_and_one_requests(isolated, monkeypatch, cycle):
    from src.chat.scheduler import MessageScheduler, ReplyStartPlan

    delegated = []

    def original_start(self, user_message, **kwargs):
        delegated.append(("start", user_message))
        return ReplyStartPlan(17.0, 0.42, "away", "ordinary")

    def original_delay(self, reply_length, emotion_intensity=0.0, *, user_message="", **kwargs):
        delegated.append(("delay", user_message))
        return 23.0

    monkeypatch.setattr(MessageScheduler, "plan_reply_start", original_start)
    monkeypatch.setattr(MessageScheduler, "calculate_delay", original_delay)
    evidence = isolated / "p1-persona-metadata.jsonl"
    undo = fixture.install_worldbook_request_timing(evidence, cycle)
    scheduler = MessageScheduler()
    try:
        for text in fixture.WORLD_BOOK_REQUESTS:
            plan = scheduler.plan_reply_start(text)
            assert plan.start_delay == (0.0 if cycle == 1 else 17.0)
            assert scheduler.calculate_delay(20, user_message=text) == (0.1 if cycle == 1 else 23.0)
        for stage, text in enumerate(fixture.LITERAL_RULE_REQUESTS, 1):
            controlled = (cycle == 1 and stage <= 4) or (cycle == 2 and stage == 5)
            plan = scheduler.plan_reply_start(text)
            assert plan.start_delay == (0.0 if controlled else 17.0)
            assert scheduler.calculate_delay(20, user_message=text) == (0.1 if controlled else 23.0)
        for text in ("普通消息", "作者提示记录五：重启以后还记得窗边吗", fixture.WORLD_BOOK_REQUESTS[0] + " extra",
                     "独立规则记录四：OrbitKey RedGate"):
            assert scheduler.plan_reply_start(text).reason == "ordinary"
            assert scheduler.calculate_delay(20, user_message=text) == 23.0
    finally:
        undo()
    assert MessageScheduler.plan_reply_start is original_start
    assert MessageScheduler.calculate_delay is original_delay
    assert len(delegated) == (10 if cycle == 1 else 24)
    if cycle == 1:
        recorded = events(isolated)
        assert [(item["event"], item["stage"]) for item in recorded] == [
            ("worldbook_timing", 1), ("worldbook_timing", 2), ("worldbook_timing", 3), ("worldbook_timing", 4),
            ("literal_rule_timing", 1), ("literal_rule_timing", 2), ("literal_rule_timing", 3), ("literal_rule_timing", 4)]
        assert all(item["start_delay_ms"] == 0 and
                   item["delivery_delay_ms"] == 100 for item in recorded)
        trace = evidence.read_text()
        assert not any(text in trace for text in fixture.WORLD_BOOK_REQUESTS + fixture.LITERAL_RULE_REQUESTS)
    else:
        assert [(item["event"], item["stage"], item["start_delay_ms"], item["delivery_delay_ms"])
                for item in events(isolated)] == [("literal_rule_timing", 5, 0, 100)]


def test_literal_rule_registration_is_a_fixed_distinct_five_chat_contract():
    assert fixture.LITERAL_RULE_REQUESTS == (
        "独立规则记录一：OrbitKey RedGate BlueGate", "独立规则记录二：OrbitKey RedGate",
        "独立规则记录三：OrbitKey RedGate", "独立规则记录四：orbitkey RedGate",
        "独立规则记录五：OrbitKey RedGate",
    )
    assert len(set(fixture.LITERAL_RULE_REQUESTS + fixture.WORLD_BOOK_REQUESTS)) == 9
    assert all("世界书字面规则的注入标记" not in text for text in fixture.LITERAL_RULE_REQUESTS)


@pytest.mark.parametrize(("cycle", "stage", "allowed"), [
    (1, 1, True), (1, 2, True), (1, 3, False),
    (2, 1, False), (2, 2, False), (2, 3, True),
])
def test_priority_timing_registration_is_exact_cycle_text_and_seeded_persona(cycle, stage, allowed):
    text = fixture.PRIORITY_REQUESTS[stage - 1]
    assert fixture.priority_registration(text, cycle, "sunny", "sunny") == (stage if allowed else None)
    assert fixture.priority_registration(text + " extra", cycle, "sunny", "sunny") is None
    assert fixture.priority_registration(text, cycle, "moon", "sunny") is None
    assert fixture.priority_registration(text, cycle, "", "") is None
    assert fixture.priority_registration(None, cycle, "sunny", "sunny") is None


@pytest.mark.parametrize("cycle", [1, 2])
def test_priority_wrapper_records_scope_and_request_without_changing_old_timing(isolated, monkeypatch, cycle):
    from src.bridge import ws_bridge
    from src.chat.scheduler import MessageScheduler, ReplyStartPlan
    evidence = isolated / "p1-persona-metadata.jsonl"
    fixture.record(evidence, 1, "persona_seeded", profile_id="sunny")
    scope = {"persona_id": "sunny", "persona_epoch": 7, "persona_fingerprint": "fixture-fingerprint"}
    monkeypatch.setattr(ws_bridge, "_active_persona_scope", lambda: dict(scope))
    monkeypatch.setattr(MessageScheduler, "plan_reply_start", lambda self, text, **kwargs: ReplyStartPlan(17, .5, "away", "ordinary"))
    monkeypatch.setattr(MessageScheduler, "calculate_delay", lambda self, length, intensity=0, **kwargs: 23.0)
    dispatched = []
    async def original_dispatch(message, endpoint, **kwargs):
        dispatched.append(message); return {"ok": True}
    monkeypatch.setattr(ws_bridge, "dispatch_authenticated_message", original_dispatch)
    previous_start, previous_delay = MessageScheduler.plan_reply_start, MessageScheduler.calculate_delay
    undo = fixture.install_priority_request_timing(evidence, cycle)
    scheduler = MessageScheduler()
    try:
        for stage, text in enumerate(fixture.PRIORITY_REQUESTS, 1):
            allowed = (cycle == 1 and stage <= 2) or (cycle == 2 and stage == 3)
            assert scheduler.plan_reply_start(text).start_delay == (0 if allowed else 17)
            assert scheduler.calculate_delay(12, user_message=text) == (.1 if allowed else 23)
            message = {"type": "chat:send", "request_id": f"priority_request_{stage}", "payload": {"text": text}}
            assert asyncio.run(ws_bridge.dispatch_authenticated_message(message, None)) == {"ok": True}
        for text in fixture.WORLD_BOOK_REQUESTS + fixture.LITERAL_RULE_REQUESTS + ("普通消息",):
            assert scheduler.plan_reply_start(text).start_delay == 17
            assert scheduler.calculate_delay(12, user_message=text) == 23
        scope["persona_id"] = "moon"
        for text in fixture.PRIORITY_REQUESTS:
            assert scheduler.plan_reply_start(text).start_delay == 17
            assert scheduler.calculate_delay(12, user_message=text) == 23
    finally:
        undo()
    assert MessageScheduler.plan_reply_start is previous_start and MessageScheduler.calculate_delay is previous_delay
    assert ws_bridge.dispatch_authenticated_message is original_dispatch and len(dispatched) == 3
    actual = events(isolated)[1:]
    stages = [1, 2] if cycle == 1 else [3]
    assert [(e["event"], e["stage"]) for e in actual] == [(kind, stage) for stage in stages for kind in ("priority_timing", "priority_dispatch")]
    assert all(e["persona_id"] == "sunny" and e["persona_epoch"] == 7 for e in actual)
    assert not any(text in evidence.read_text() for text in fixture.PRIORITY_REQUESTS)


def test_priority_wrapper_requires_one_original_seed_record(isolated):
    evidence = isolated / "p1-persona-metadata.jsonl"
    fixture.record(evidence, 2, "bootstrap", active_id="default")
    with pytest.raises(ValueError, match="one registered"):
        fixture.install_priority_request_timing(evidence, 2)


@pytest.mark.parametrize("cycle", [1, 2])
def test_priority_archive_write_observer_records_each_actual_sunny_dispatch(isolated, monkeypatch, cycle):
    from src.bridge import ws_bridge
    evidence = isolated / "p1-persona-metadata.jsonl"
    fixture.record(evidence, 1, "persona_seeded", profile_id="sunny")
    scope = {"persona_id": "sunny", "persona_epoch": 11, "persona_fingerprint": "fixture-fingerprint"}
    monkeypatch.setattr(ws_bridge, "_active_persona_scope", lambda: dict(scope))
    seen = []
    async def dispatch(message, endpoint, **kwargs):
        seen.append(message); return {"ok": True}
    monkeypatch.setattr(ws_bridge, "dispatch_authenticated_message", dispatch)
    undo = fixture.install_priority_request_timing(evidence, cycle)
    message = {"type": "archive:put", "request_id": "priority_write_request", "payload": {
        "archive": {"private": "must not be collected"}, "expected_revision": 3}}
    try:
        assert asyncio.run(ws_bridge.dispatch_authenticated_message(message, None)) == {"ok": True}
        scope["persona_id"] = "moon"
        assert asyncio.run(ws_bridge.dispatch_authenticated_message(message, None)) == {"ok": True}
    finally:
        undo()
    assert seen == [message, message]
    observed = events(isolated)[1:]
    assert len(observed) == 1
    assert {k: v for k, v in observed[0].items() if k not in {"schema", "monotonic_ns"}} == {
        "event": "priority_archive_put_dispatch", "cycle": cycle, "request_id": "priority_write_request",
        "expected_revision": 3, "persona_id": "sunny", "persona_epoch": 11,
        "persona_fingerprint": "fixture-fingerprint"}
    assert "must not be collected" not in evidence.read_text()


def test_book_settings_registration_is_distinct_first_cycle_and_flagged_persona_only():
    assert fixture.BOOK_SETTINGS_REQUESTS == ("书级记录一：远灯亮起", "书级记录二：请继续核对", "书级记录三：远灯再亮")
    others = fixture.WORLD_BOOK_REQUESTS + fixture.LITERAL_RULE_REQUESTS + fixture.PRIORITY_REQUESTS
    assert not set(fixture.BOOK_SETTINGS_REQUESTS) & set(others)
    # The markers and the recursion keyword never appear in a typed request.
    assert all("回声" not in text and "BOOK_" not in text for text in fixture.BOOK_SETTINGS_REQUESTS)
    assert ["远灯" in text for text in fixture.BOOK_SETTINGS_REQUESTS] == [True, False, True]
    for stage, text in enumerate(fixture.BOOK_SETTINGS_REQUESTS, 1):
        assert fixture.book_settings_registration(text, 1, "frost", "frost") == stage
        assert fixture.book_settings_registration(text, 2, "frost", "frost") is None
        assert fixture.book_settings_registration(text, 1, "sunny", "frost") is None
        assert fixture.book_settings_registration(text, 1, "frost", None) is None
        assert fixture.book_settings_registration(text + " extra", 1, "frost", "frost") is None


@pytest.mark.parametrize("cycle", [1, 2])
def test_book_settings_wrapper_records_frost_requests_and_writes_only(isolated, monkeypatch, cycle):
    from src.bridge import ws_bridge
    from src.chat.scheduler import MessageScheduler, ReplyStartPlan
    evidence = isolated / "p1-persona-metadata.jsonl"
    fixture.record(evidence, 1, "persona_seeded", profile_id="sunny")
    scope = {"persona_id": "frost", "persona_epoch": 5, "persona_fingerprint": "fixture-fingerprint"}
    monkeypatch.setattr(ws_bridge, "_active_persona_scope", lambda: dict(scope))
    monkeypatch.setattr(fixture, "flagged_persona_id", lambda: "frost")
    monkeypatch.setattr(MessageScheduler, "plan_reply_start", lambda self, text, **kwargs: ReplyStartPlan(17, .5, "away", "ordinary"))
    monkeypatch.setattr(MessageScheduler, "calculate_delay", lambda self, length, intensity=0, **kwargs: 23.0)
    dispatched = []
    async def original_dispatch(message, endpoint, **kwargs):
        dispatched.append(message); return {"ok": True}
    monkeypatch.setattr(ws_bridge, "dispatch_authenticated_message", original_dispatch)
    previous_start, previous_delay = MessageScheduler.plan_reply_start, MessageScheduler.calculate_delay
    undo = fixture.install_book_settings_request_timing(evidence, cycle)
    scheduler = MessageScheduler()
    write = {"type": "archive:put", "request_id": "book_settings_write", "payload": {
        "archive": {"private": "must not be collected"}, "expected_revision": 4}}
    try:
        for stage, text in enumerate(fixture.BOOK_SETTINGS_REQUESTS, 1):
            assert scheduler.plan_reply_start(text).start_delay == (0 if cycle == 1 else 17)
            assert scheduler.calculate_delay(12, user_message=text) == (.1 if cycle == 1 else 23)
            message = {"type": "chat:send", "request_id": f"book_settings_request_{stage}", "payload": {"text": text}}
            assert asyncio.run(ws_bridge.dispatch_authenticated_message(message, None)) == {"ok": True}
        assert asyncio.run(ws_bridge.dispatch_authenticated_message(write, None)) == {"ok": True}
        for text in fixture.PRIORITY_REQUESTS + fixture.LITERAL_RULE_REQUESTS + ("普通消息",):
            assert scheduler.plan_reply_start(text).start_delay == 17
            assert scheduler.calculate_delay(12, user_message=text) == 23
        scope["persona_id"] = "sunny"
        for text in fixture.BOOK_SETTINGS_REQUESTS:
            assert scheduler.plan_reply_start(text).start_delay == 17
        assert asyncio.run(ws_bridge.dispatch_authenticated_message(write, None)) == {"ok": True}
    finally:
        undo()
    assert MessageScheduler.plan_reply_start is previous_start and MessageScheduler.calculate_delay is previous_delay
    assert ws_bridge.dispatch_authenticated_message is original_dispatch and len(dispatched) == 5
    actual = [{k: v for k, v in e.items() if k not in {"schema", "monotonic_ns"}} for e in events(isolated)[1:]]
    kinds = [e["event"] for e in actual]
    expected = ([kind for _ in range(3) for kind in ("book_settings_timing", "book_settings_dispatch")]
                if cycle == 1 else []) + ["book_settings_archive_put_dispatch"]
    assert kinds == expected
    assert actual[-1] == {"event": "book_settings_archive_put_dispatch", "cycle": cycle,
                          "request_id": "book_settings_write", "expected_revision": 4, "persona_id": "frost",
                          "persona_epoch": 5, "persona_fingerprint": "fixture-fingerprint"}
    assert [e["stage"] for e in actual if e["event"] == "book_settings_dispatch"] == ([1, 2, 3] if cycle == 1 else [])
    text = evidence.read_text()
    assert "must not be collected" not in text and not any(t in text for t in fixture.BOOK_SETTINGS_REQUESTS)


def test_flagged_persona_lookup_requires_exactly_one_profile(isolated, monkeypatch):
    from src.persona import sillytavern_import
    listing = {"active_id": "default", "profiles": [{"id": "frost", "name": fixture.FLAGGED_CARD_NAME},
                                                     {"id": "sunny", "name": fixture.SEEDED_NAME}]}
    monkeypatch.setattr(sillytavern_import, "list_imported_personas", lambda directory: listing)
    assert fixture.flagged_persona_id() == "frost"
    listing["profiles"].append({"id": "copy", "name": fixture.FLAGGED_CARD_NAME})
    assert fixture.flagged_persona_id() is None
    listing["profiles"] = []
    assert fixture.flagged_persona_id() is None
