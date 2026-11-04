"""Contracts for the isolated shared greeting/Moonroom start fixture."""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace

import pytest


DIRECTORY = Path(__file__).resolve().parent
ROOT = DIRECTORY.parents[1]
BASELINE = "6813e333dcdbb5411ed2bb096c0b86221c83c164"
BOOTSTRAPS = (
    ("p1_persona_backend_bootstrap", (
        "install_import_observer", "install_worldbook_request_timing",
        "install_priority_request_timing", "install_book_settings_request_timing")),
    ("p1_worldbook_entry_backend_bootstrap", (
        "install_entry_settings_request_timing", "install_entry_settings_observer")),
    ("p1_worldbook_regex_backend_bootstrap", (
        "install_regex_request_timing", "install_regex_observer", "install_regex_worker_observer")),
    ("p1_worldbook_injection_backend_bootstrap", (
        "install_injection_request_timing", "install_injection_observer")),
)
OWN_REGISTRATIONS = {
    "p1_persona_backend_bootstrap": (
        "WORLD_BOOK_REQUESTS", "LITERAL_RULE_REQUESTS", "PRIORITY_REQUESTS", "BOOK_SETTINGS_REQUESTS"),
    "p1_worldbook_entry_backend_bootstrap": ("ENTRY_SETTINGS_REQUESTS",),
    "p1_worldbook_regex_backend_bootstrap": ("REGEX_REQUESTS",),
    "p1_worldbook_injection_backend_bootstrap": ("INJECTION_REQUESTS",),
}


def load_module(name):
    spec = importlib.util.spec_from_file_location("moonroom_test_" + name, DIRECTORY / (name + ".py"))
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


fixture = load_module("moonroom_reply_start")


def test_five_texts_equal_the_unchanged_memory_registration():
    memory = load_module("p1_memory_backend_bootstrap")
    assert fixture.REGISTERED_CHAT_TURNS == memory.REGISTERED_CHAT_TURNS
    assert len(set(fixture.REGISTERED_CHAT_TURNS)) == 5
    assert fixture.FIXTURE_REPLY_START_REASON == "isolated_moonroom_fixture"


@pytest.mark.parametrize("text", fixture.REGISTERED_CHAT_TURNS)
def test_first_registered_start_calls_production_then_changes_only_wait_and_reason(monkeypatch, text):
    from src.bridge import ws_bridge
    from src.chat.scheduler import MessageScheduler, ReplyStartPlan

    production = ReplyStartPlan(20.0, .375, "away", "online_wobble")
    calls = []

    def original(message):
        calls.append(message)
        return production

    monkeypatch.setattr(ws_bridge, "_reply_start_planner", original)
    delivery = MessageScheduler.calculate_delay
    undo = fixture.install_moonroom_reply_start(1)
    try:
        result = ws_bridge._reply_start_planner(text)
        assert calls == [text]
        assert result == ReplyStartPlan(0.0, .375, "away", "isolated_moonroom_fixture")
        assert production == ReplyStartPlan(20.0, .375, "away", "online_wobble")
        assert MessageScheduler.calculate_delay is delivery
    finally:
        undo()
    assert ws_bridge._reply_start_planner is original


@pytest.mark.parametrize("text", fixture.REGISTERED_CHAT_TURNS)
def test_repeated_registered_text_calls_production_and_returns_its_same_object(monkeypatch, text):
    from src.bridge import ws_bridge
    from src.chat.scheduler import ReplyStartPlan

    plans = [ReplyStartPlan(20.0, .25, "busy", "online_wobble"),
             ReplyStartPlan(31.0, .125, "sleeping", "sleep_until_wake")]
    calls = []

    def original(message):
        calls.append(message)
        return plans[len(calls) - 1]

    monkeypatch.setattr(ws_bridge, "_reply_start_planner", original)
    undo = fixture.install_moonroom_reply_start(1)
    try:
        assert ws_bridge._reply_start_planner(text).start_delay == 0
        assert ws_bridge._reply_start_planner(text) is plans[1]
        assert calls == [text, text]
    finally:
        undo()


@pytest.mark.parametrize("text", fixture.REGISTERED_CHAT_TURNS)
def test_second_cycle_returns_the_same_production_plan(monkeypatch, text):
    from src.bridge import ws_bridge
    from src.chat.scheduler import ReplyStartPlan

    production = ReplyStartPlan(20.0, .25, "busy", "online_wobble")
    calls = []

    def original(message):
        calls.append(message)
        return production

    monkeypatch.setattr(ws_bridge, "_reply_start_planner", original)
    undo = fixture.install_moonroom_reply_start(2)
    try:
        assert ws_bridge._reply_start_planner(text) is production
        assert ws_bridge._reply_start_planner(text) is production
        assert calls == [text, text]
    finally:
        undo()


@pytest.mark.parametrize("text", ["普通消息", "停止记录 ", "停止记录\n", None, {"text": "停止记录"}])
def test_other_and_near_match_texts_return_the_same_production_plan(monkeypatch, text):
    from src.bridge import ws_bridge
    from src.chat.scheduler import ReplyStartPlan

    production = ReplyStartPlan(20.0, .25, "busy", "online_wobble")
    calls = []

    def original(message):
        calls.append(message)
        return production

    monkeypatch.setattr(ws_bridge, "_reply_start_planner", original)
    undo = fixture.install_moonroom_reply_start(1)
    try:
        assert ws_bridge._reply_start_planner(text) is production
        assert calls == [text]
    finally:
        undo()


@pytest.mark.parametrize("status,probability", [("online", .9), ("busy", .3), ("away", .1), ("sleeping", 0.0)])
def test_status_and_probability_are_kept_even_when_the_production_plan_is_immediate(monkeypatch, status, probability):
    from src.bridge import ws_bridge
    from src.chat.scheduler import ReplyStartPlan

    production = ReplyStartPlan(0.0, probability, status, "available_now")
    monkeypatch.setattr(ws_bridge, "_reply_start_planner", lambda text: production)
    undo = fixture.install_moonroom_reply_start(1)
    try:
        result = ws_bridge._reply_start_planner(fixture.REGISTERED_CHAT_TURNS[0])
        assert result == ReplyStartPlan(0.0, probability, status, "isolated_moonroom_fixture")
    finally:
        undo()


def test_twenty_second_online_wobble_control_keeps_an_ordinary_message_delayed(monkeypatch):
    from src.bridge import ws_bridge
    from src.chat.scheduler import ReplyStartPlan

    production = ReplyStartPlan(20.0, .7, "online", "online_wobble")
    calls = []

    def original(text):
        calls.append(text)
        return production

    monkeypatch.setattr(ws_bridge, "_reply_start_planner", original)
    undo = fixture.install_moonroom_reply_start(1)
    try:
        for text in fixture.REGISTERED_CHAT_TURNS:
            assert ws_bridge._reply_start_planner(text).start_delay == 0
        assert ws_bridge._reply_start_planner("普通对照消息") is production
        assert production.start_delay == 20.0 and production.reason == "online_wobble"
        assert calls == [*fixture.REGISTERED_CHAT_TURNS, "普通对照消息"]
    finally:
        undo()


def test_none_is_not_replaced_and_still_consumes_the_first_occurrence(monkeypatch):
    from src.bridge import ws_bridge
    from src.chat.scheduler import ReplyStartPlan

    production = ReplyStartPlan(20.0, .7, "online", "online_wobble")
    plans = iter([None, production])
    monkeypatch.setattr(ws_bridge, "_reply_start_planner", lambda text: next(plans))
    undo = fixture.install_moonroom_reply_start(1)
    try:
        text = fixture.REGISTERED_CHAT_TURNS[0]
        assert ws_bridge._reply_start_planner(text) is None
        assert ws_bridge._reply_start_planner(text) is production
    finally:
        undo()


def test_undo_restores_the_original_planner_once(monkeypatch):
    from src.bridge import ws_bridge

    original = lambda text: None
    monkeypatch.setattr(ws_bridge, "_reply_start_planner", original)
    undo = fixture.install_moonroom_reply_start(1)
    assert ws_bridge._reply_start_planner is not original
    undo()
    assert ws_bridge._reply_start_planner is original
    subsequent = lambda text: "later wrapper"
    monkeypatch.setattr(ws_bridge, "_reply_start_planner", subsequent)
    undo()
    assert ws_bridge._reply_start_planner is subsequent


def test_production_exception_is_not_suppressed(monkeypatch):
    from src.bridge import ws_bridge

    def original(text):
        raise RuntimeError("production planning failed")

    monkeypatch.setattr(ws_bridge, "_reply_start_planner", original)
    undo = fixture.install_moonroom_reply_start(1)
    try:
        with pytest.raises(RuntimeError, match="production planning failed"):
            ws_bridge._reply_start_planner(fixture.REGISTERED_CHAT_TURNS[0])
    finally:
        undo()


@pytest.mark.parametrize("name,_installers", BOOTSTRAPS, ids=[row[0] for row in BOOTSTRAPS])
def test_common_texts_do_not_overlap_the_bootstraps_existing_registrations(name, _installers):
    bootstrap = load_module(name)
    own = {text for variable in OWN_REGISTRATIONS[name] for text in getattr(bootstrap, variable)}
    assert not own.intersection(fixture.REGISTERED_CHAT_TURNS)


@pytest.mark.parametrize("filename", ["p1_memory_backend_bootstrap.py", "p1_settings_backend_bootstrap.py"])
def test_memory_and_settings_are_byte_identical_to_the_confirmed_baseline(filename):
    baseline = subprocess.run(["git", "show", f"{BASELINE}:native-ui/tests/{filename}"],
                              cwd=ROOT, check=True, capture_output=True, timeout=30).stdout
    assert (DIRECTORY / filename).read_bytes() == baseline


@pytest.mark.parametrize("name,installers", BOOTSTRAPS, ids=[row[0] for row in BOOTSTRAPS])
@pytest.mark.parametrize("cycle", [1, 2])
@pytest.mark.parametrize("backend_fails", [False, True])
def test_bootstrap_main_installs_once_and_unwinds_in_reverse_order(
        tmp_path, monkeypatch, name, installers, cycle, backend_fails):
    from src.bridge import ws_bridge
    from src.chat.scheduler import ReplyStartPlan

    bootstrap = load_module(name)
    calls = []
    production = ReplyStartPlan(20.0, .3, "online", "online_wobble")
    original = lambda text: production
    monkeypatch.setattr(ws_bridge, "_reply_start_planner", original)
    monkeypatch.setattr(bootstrap, "validate_context", lambda *args: None)
    monkeypatch.setattr(bootstrap, "record", lambda *args, **kwargs: None)
    monkeypatch.setattr(sys, "path", list(sys.path))
    monkeypatch.setattr(sys, "argv", list(sys.argv))
    context = tmp_path / "context.json"
    context.write_text(json.dumps({"p1_card_edit_contract": "v1"}))

    def installer(label):
        def install(*args):
            calls.append("install:" + label)
            return lambda: calls.append("undo:" + label)
        return install

    expected_installers = list(installers)
    for label in installers:
        monkeypatch.setattr(bootstrap, label, installer(label))
    if name == "p1_persona_backend_bootstrap":
        monkeypatch.setattr(bootstrap, "seed", lambda *args: None)
        monkeypatch.setitem(sys.modules, "p1_card_edit_observer", SimpleNamespace(install=installer("card_edit")))
        expected_installers.append("card_edit")

    def install_common(actual_cycle):
        assert actual_cycle == cycle
        calls.append("install:common")
        undo = fixture.install_moonroom_reply_start(actual_cycle)

        def restore():
            calls.append("undo:common")
            undo()
        return restore

    monkeypatch.setitem(sys.modules, "moonroom_reply_start",
                        SimpleNamespace(install_moonroom_reply_start=install_common))

    def backend(module_name, run_name):
        assert (module_name, run_name) == ("src.main", "__main__")
        assert ws_bridge._reply_start_planner is not original
        result = ws_bridge._reply_start_planner(fixture.REGISTERED_CHAT_TURNS[0])
        assert result.start_delay == (0.0 if cycle == 1 else 20.0)
        calls.append("backend")
        if backend_fails:
            raise RuntimeError("isolated backend exit")

    monkeypatch.setattr(bootstrap.runpy, "run_module", backend)
    argv = ["--stdio-bridge", "--context", str(context), "--data-dir", str(tmp_path),
            "--endpoint", "http://127.0.0.1:14567/v1", "--evidence", str(tmp_path / "metadata.jsonl"),
            "--cycle", str(cycle)]
    if backend_fails:
        with pytest.raises(RuntimeError, match="isolated backend exit"):
            bootstrap.main(argv)
    else:
        bootstrap.main(argv)
    assert calls == (["install:" + label for label in expected_installers] + ["install:common", "backend", "undo:common"]
                     + ["undo:" + label for label in reversed(expected_installers)])
    assert ws_bridge._reply_start_planner is original


@pytest.mark.parametrize("name,_installers", BOOTSTRAPS, ids=[row[0] for row in BOOTSTRAPS])
def test_common_wrapper_preserves_existing_registered_timing_and_adds_no_evidence(
        tmp_path, monkeypatch, name, _installers):
    from src.bridge import ws_bridge
    from src.chat.scheduler import MessageScheduler, ReplyStartPlan

    bootstrap = load_module(name)
    production = ReplyStartPlan(20.0, .3, "online", "online_wobble")
    monkeypatch.setattr(MessageScheduler, "plan_reply_start", lambda self, text, **kwargs: production)
    monkeypatch.setattr(MessageScheduler, "calculate_delay", lambda self, length, intensity=0.0, **kwargs: 23.0)
    scheduler = MessageScheduler()
    monkeypatch.setattr(ws_bridge, "bridge_state", SimpleNamespace(
        session=SimpleNamespace(scheduler=scheduler), emotion=None))
    scope = {"persona_id": "sunny", "persona_epoch": 1, "persona_fingerprint": "isolated-fingerprint"}
    monkeypatch.setattr(ws_bridge, "_active_persona_scope", lambda: dict(scope))
    evidence = tmp_path / "existing-metadata.jsonl"
    evidence.write_text(json.dumps({"event": "persona_seeded", "cycle": 1, "profile_id": "sunny"}) + "\n")
    evidence.chmod(0o600)
    original_start, original_delay = MessageScheduler.plan_reply_start, MessageScheduler.calculate_delay
    undos = []
    if name == "p1_persona_backend_bootstrap":
        monkeypatch.setattr(bootstrap, "flagged_persona_id", lambda: "flagged")
        undos.append(bootstrap.install_worldbook_request_timing(evidence, 1))
        undos.append(bootstrap.install_priority_request_timing(evidence, 1))
        undos.append(bootstrap.install_book_settings_request_timing(evidence, 1))
        own_turns = [(bootstrap.WORLD_BOOK_REQUESTS[0], "sunny", "isolated_worldbook_fixture"),
                     (bootstrap.LITERAL_RULE_REQUESTS[0], "sunny", "isolated_worldbook_fixture"),
                     (bootstrap.PRIORITY_REQUESTS[0], "sunny", "isolated_priority_fixture"),
                     (bootstrap.BOOK_SETTINGS_REQUESTS[0], "flagged", "isolated_book_settings_fixture")]
    else:
        variable, = OWN_REGISTRATIONS[name]
        kind = name.removeprefix("p1_worldbook_").removesuffix("_backend_bootstrap")
        timing_kind = "entry_settings" if kind == "entry" else kind
        undos.append(getattr(bootstrap, "install_" + timing_kind + "_request_timing")(evidence, 1))
        own_turns = [(getattr(bootstrap, variable)[0], "sunny", "isolated_" + timing_kind + "_fixture")]
    own_start, own_delivery = MessageScheduler.plan_reply_start, MessageScheduler.calculate_delay
    original_bridge = ws_bridge._reply_start_planner
    undo_common = fixture.install_moonroom_reply_start(1)
    try:
        for text, persona_id, reason in own_turns:
            scope["persona_id"] = persona_id
            result = ws_bridge._reply_start_planner(text)
            assert result == ReplyStartPlan(0.0, 1.0, "online", reason)
            assert scheduler.calculate_delay(12, user_message=text) == .1
        existing_evidence = evidence.read_bytes()
        for text in fixture.REGISTERED_CHAT_TURNS:
            result = ws_bridge._reply_start_planner(text)
            assert result == ReplyStartPlan(0.0, .3, "online", "isolated_moonroom_fixture")
            assert scheduler.calculate_delay(12, user_message=text) == 23.0
            assert ws_bridge._reply_start_planner(text) is production
        assert ws_bridge._reply_start_planner("普通消息") is production
        assert evidence.read_bytes() == existing_evidence
        assert MessageScheduler.plan_reply_start is own_start
        assert MessageScheduler.calculate_delay is own_delivery
    finally:
        undo_common()
        for undo in reversed(undos):
            undo()
    assert ws_bridge._reply_start_planner is original_bridge
    assert MessageScheduler.plan_reply_start is original_start
    assert MessageScheduler.calculate_delay is original_delay
