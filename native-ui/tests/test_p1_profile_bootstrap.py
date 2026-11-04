"""Narrow isolation/timing/metadata contracts for the explicit profile fixture."""
from __future__ import annotations

import asyncio
import importlib.util
import json
from pathlib import Path
import stat
from types import SimpleNamespace

import pytest

SCRIPT = Path(__file__).with_name("p1_profile_backend_bootstrap.py")
spec = importlib.util.spec_from_file_location("reverie_p1_profile_bootstrap", SCRIPT)
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)


def events(path):
    return [json.loads(line) for line in path.read_text().splitlines()]


def test_only_registered_first_cycle_turns_receive_controlled_timing(tmp_path, monkeypatch):
    from src.chat.scheduler import MessageScheduler
    evidence = tmp_path.resolve() / "p1-profile-metadata.jsonl"
    calls = []

    def original_start(self, message, **kwargs):
        calls.append(("start", message, kwargs))
        return "ordinary-start"

    def original_delay(self, length, intensity=0.0, **kwargs):
        calls.append(("delay", length, intensity, kwargs))
        return 9.5

    monkeypatch.setattr(MessageScheduler, "plan_reply_start", original_start)
    monkeypatch.setattr(MessageScheduler, "calculate_delay", original_delay)
    undo = fixture.install_profile_request_timing(evidence, 1)
    try:
        scheduler = MessageScheduler()
        assert scheduler.plan_reply_start("ordinary", flag=True) == "ordinary-start"
        assert scheduler.calculate_delay(31, 0.4, user_message="ordinary", flag=True) == 9.5
        for message in fixture.PROFILE_REQUESTS:
            plan = scheduler.plan_reply_start(message)
            assert (plan.start_delay, plan.status, plan.reason) == (0.0, "online", "isolated_profile_fixture")
            assert scheduler.calculate_delay(7, user_message=message) == 0.1
        with pytest.raises(ValueError, match="repeated"):
            scheduler.plan_reply_start(fixture.PROFILE_REQUESTS[0])
        assert calls == [("start", "ordinary", {"flag": True}),
                         ("delay", 31, 0.4, {"user_message": "ordinary", "flag": True})]
        assert [(event["cycle"], event["stage"], event["start_delay_ms"], event["delivery_delay_ms"])
                for event in events(evidence)] == [(1, 1, 0, 100), (1, 2, 0, 100)]
    finally:
        undo()
    assert MessageScheduler.plan_reply_start is original_start
    assert MessageScheduler.calculate_delay is original_delay


def test_restart_and_near_match_messages_keep_original_scheduler(tmp_path, monkeypatch):
    from src.chat.scheduler import MessageScheduler
    evidence = tmp_path.resolve() / "p1-profile-metadata.jsonl"
    monkeypatch.setattr(MessageScheduler, "plan_reply_start", lambda self, message, **kwargs: ("ordinary", message))
    monkeypatch.setattr(MessageScheduler, "calculate_delay", lambda self, length, intensity=0.0, **kwargs: 12.5)
    for cycle, messages in [(1, [message + " " for message in fixture.PROFILE_REQUESTS]),
                            (2, list(fixture.PROFILE_REQUESTS))]:
        undo = fixture.install_profile_request_timing(evidence, cycle)
        try:
            scheduler = MessageScheduler()
            for message in messages:
                assert scheduler.plan_reply_start(message) == ("ordinary", message)
                assert scheduler.calculate_delay(7, user_message=message) == 12.5
        finally:
            undo()
    assert not evidence.exists()


def test_context_requires_exact_registration_owned_endpoint_and_directory_identity(tmp_path, monkeypatch):
    root = tmp_path.resolve()
    data = root / "data"
    data.mkdir(mode=0o700)
    (data / "data").mkdir(mode=0o700)
    endpoint = "http://127.0.0.1:14567/v1"
    (data / "data/config.json").write_text(json.dumps({"llm": {"provider": "ollama", "base_url": endpoint}}))

    def snapshot(directory):
        info = directory.stat()
        return {"path": str(directory), "uid": info.st_uid, "device": str(info.st_dev), "inode": str(info.st_ino)}

    original = {"schema": "reverie.qt.isolation.v1", "root": snapshot(root), "data": snapshot(data),
                "p1_profile": {"endpoint": endpoint, **fixture.REGISTERED}}
    context = root / "qt-context.json"
    context.write_text(json.dumps(original))
    context.chmod(0o600)
    evidence = data / "p1-profile-metadata.jsonl"
    for name, value in {"REVERIE_BRIDGE_MODE": "1", "REVERIE_REQUIRE_ENCRYPTED_STORAGE": "1",
                        "REVERIE_STORAGE_KEY_FD": "3", "REVERIE_DATA_DIR": str(data / "data"),
                        "PYTHON_DOTENV_DISABLED": "1"}.items():
        monkeypatch.setenv(name, value)
    monkeypatch.setattr(fixture.os, "fstat", lambda descriptor: SimpleNamespace(st_mode=stat.S_IFIFO))
    fixture.validate_context(context, data, endpoint, evidence, 1)
    fixture.validate_context(context, data, endpoint, evidence, 2)
    mutations = [lambda value: value.pop("p1_profile"),
                 lambda value: value["p1_profile"].update(profileChats=3),
                 lambda value: value["p1_profile"].update(clearFields=["identity"]),
                 lambda value: value["p1_profile"].update(clearFields=["nickname", "interests"]),
                 lambda value: value.update(p1_memory={}),
                 lambda value: value.update(p1_unknown={}),
                 lambda value: value["data"].update(inode="0")]
    for mutate in mutations:
        changed = json.loads(json.dumps(original))
        mutate(changed)
        context.write_text(json.dumps(changed))
        with pytest.raises(ValueError):
            fixture.validate_context(context, data, endpoint, evidence, 1)
    context.write_text(json.dumps(original))
    for wrong_endpoint, wrong_evidence, cycle in [("https://127.0.0.1:14567/v1", evidence, 1),
                                                  (endpoint, root / evidence.name, 1), (endpoint, evidence, 3)]:
        with pytest.raises(ValueError):
            fixture.validate_context(context, data, wrong_endpoint, wrong_evidence, cycle)
    monkeypatch.setenv("REVERIE_STORAGE_KEY_FD", "4")
    with pytest.raises(ValueError, match="private encrypted"):
        fixture.validate_context(context, data, endpoint, evidence, 1)


def test_observer_keeps_values_and_errors_out_of_metadata(tmp_path, monkeypatch):
    from src.bridge import ws_bridge
    evidence = tmp_path.resolve() / "p1-profile-metadata.jsonl"
    private_text = "PRIVATE_PROFILE_VALUE_MUST_NOT_BE_RECORDED"
    response = {"ok": True, "profile": {"nickname": private_text, "interests": [private_text],
                "identity": fixture.RETAINED_IDENTITY}, "profile_snapshot": "a" * 64, "error": private_text}
    calls = []

    async def original(message, endpoint, **kwargs):
        calls.append((message["type"], endpoint, kwargs))
        return response

    monkeypatch.setattr(ws_bridge, "dispatch_authenticated_message", original)
    undo = fixture.install_profile_observer(evidence, 1)
    try:
        async def dispatch_all():
            for number, (command, payload) in enumerate([
                ("user:profile:get", {}),
                ("user:profile:update", {"clear_fields": list(fixture.REGISTERED["clearFields"]), "expected_profile_snapshot": "b" * 64}),
                ("chat:send", {"text": fixture.PROFILE_REQUESTS[0]}),
                ("chat:send", {"text": "ordinary"}),
            ]):
                result = await ws_bridge.dispatch_authenticated_message(
                    {"type": command, "request_id": f"fixture-request-{number}", "payload": payload}, "owner", emit_result=False)
                assert result is response
        asyncio.run(dispatch_all())
    finally:
        undo()
    assert ws_bridge.dispatch_authenticated_message is original
    assert len(calls) == 4
    recorded = events(evidence)
    assert [event["event"] for event in recorded] == ["profile_dispatch", "profile_result", "profile_dispatch", "profile_result", "profile_chat_dispatch"]
    assert [(event["operation"], event["request_id"]) for event in recorded if event["event"] == "profile_dispatch"] == [
        ("read", "fixture-request-0"), ("clear", "fixture-request-1")]
    assert recorded[2]["clear_fields_match"] is True and recorded[2]["expected_snapshot_valid"] is True
    assert private_text not in evidence.read_text()
    assert "a" * 64 not in evidence.read_text() and "b" * 64 not in evidence.read_text()
    assert [event["ok"] for event in recorded if event["event"] == "profile_result"] == [False, False]
    saved = {"profile": {"name": "", "nickname": fixture.NICKNAME, "birthday": "", "identity": fixture.RETAINED_IDENTITY,
                         "schedule": "", "interests": [fixture.INTEREST], "hobbies": [], "favorite_topics": [],
                         "favorite_games": [fixture.FAVORITE_GAME], "favorite_anime": [fixture.FAVORITE_ANIME], "age": fixture.AGE},
             "profile_snapshot": "c" * 64}
    assert fixture.profile_metadata(saved)["ok"] is True  # Established get/save shape has no ok.
    assert fixture.profile_metadata({**saved, "ok": False})["ok"] is False
    assert fixture.profile_metadata({**saved, "error": private_text})["ok"] is False
    assert fixture.profile_metadata({**saved, "profile_snapshot": "c" * 64 + "\n"})["ok"] is False
    assert fixture.profile_metadata(saved, clear_operation=True)["ok"] is False
    assert fixture.profile_metadata({**saved, "ok": True, "operation": "clear"}, clear_operation=True)["ok"] is True
    for code in ("PROFILE_CLEAR_INVALID", "PROFILE_SNAPSHOT_CHANGED", "PROFILE_CLEAR_UNCONFIRMED", "PROFILE_CLEAR_UNAVAILABLE"):
        assert fixture.profile_metadata({"error_code": code})["error_code"] == code
    assert fixture.profile_metadata({"error_code": private_text})["error_code"] == "none"


def test_extended_field_metadata_is_bounded_and_rejects_wrong_shapes():
    private_text = "PRIVATE_EXTENDED_VALUE"
    base = {"name": "", "nickname": "", "birthday": "", "identity": fixture.RETAINED_IDENTITY, "schedule": "",
            "interests": [], "hobbies": [], "favorite_topics": []}
    saved = {"profile": {**base, "favorite_games": [fixture.FAVORITE_GAME], "favorite_anime": [fixture.FAVORITE_ANIME],
                         "age": fixture.AGE}, "profile_snapshot": "d" * 64}
    metadata = fixture.profile_metadata(saved)
    assert metadata["ok"] is True
    assert [metadata[key] for key in ("game_count", "anime_count", "games_fixture_matches", "anime_fixture_matches",
                                      "age_fixture_matches", "games_empty", "anime_empty", "age_empty")] == [
        1, 1, True, True, True, False, False, False]
    cleared = fixture.profile_metadata({"ok": True, "operation": "clear", "profile_snapshot": "e" * 64,
                                        "profile": {**base, "favorite_games": [], "favorite_anime": [], "age": None}},
                                       clear_operation=True)
    assert cleared["ok"] is True and cleared["games_empty"] is True and cleared["anime_empty"] is True
    assert cleared["age_empty"] is True and cleared["age_fixture_matches"] is False
    refilled = fixture.profile_metadata({"profile_snapshot": "f" * 64, "profile": {
        **base, "favorite_games": ["再填游戏"], "favorite_anime": ["再填动漫"], "age": 28}})
    assert [refilled[key] for key in ("ok", "refilled_games_match", "refilled_anime_match", "refilled_age_matches")] == [
        True, True, True, True]
    for wrong in ({"age": True}, {"age": 31.0}, {"age": 17}, {"age": "31"}, {"favorite_games": private_text},
                  {"favorite_anime": [7]}):
        assert fixture.profile_metadata({**saved, "profile": {**saved["profile"], **wrong}})["ok"] is False
    missing_age = {key: value for key, value in saved["profile"].items() if key != "age"}
    assert fixture.profile_metadata({**saved, "profile": missing_age})["ok"] is False
    assert private_text not in json.dumps(fixture.profile_metadata({**saved, "profile": {**saved["profile"],
                                                                                        "favorite_games": [private_text]}}))
