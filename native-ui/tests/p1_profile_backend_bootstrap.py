"""Owner-isolated profile-clear fixture with two registered HTTP chat turns.

No profile is seeded or edited here. Only the two fixed first-cycle messages
receive a 0 s start and 100 ms delivery plan. All other messages, including
the unchanged ordinary seven-request check, use the production scheduler.
The evidence file contains IDs, lengths, booleans and fixed operation names.
"""
from __future__ import annotations

import argparse
import functools
import json
import os
from pathlib import Path
import re
import runpy
import stat
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
PROFILE_REQUESTS = (
    "资料清空记录一：请认真核对用户的昵称、兴趣和身份",
    "资料清空记录二：请认真核对用户的昵称、兴趣和身份",
)
NICKNAME = "隔离称呼·霜铃739"
INTEREST = "隔离兴趣·浮岛826"
RETAINED_IDENTITY = "隔离身份·星台保留915"
# Profile fields r1: entered through their own controls, cleared with the two above.
FAVORITE_GAME = "隔离游戏·星轨413"
FAVORITE_ANIME = "隔离动漫·潮汐562"
AGE = 31
REGISTERED = {"profileChats": 2, "clearFields": ["nickname", "interests", "favorite_games", "favorite_anime", "age"]}


def private_regular(path: Path, maximum: int):
    info = path.lstat()
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
            or info.st_nlink != 1 or info.st_mode & 0o077 or info.st_size > maximum
            or path.resolve() != path):
        raise ValueError("invalid isolated profile fixture file")
    return info


def validate_context(context: Path, data: Path, endpoint: str, evidence: Path, cycle: int):
    if cycle not in (1, 2) or not all(path.is_absolute() for path in (context, data, evidence)):
        raise ValueError("explicit absolute profile fixture arguments required")
    private_regular(context, 16384)
    registered = json.loads(context.read_text())
    if (registered.get("schema") != "reverie.qt.isolation.v1"
            or set(registered) != {"schema", "root", "data", "p1_profile"}
            or registered.get("p1_profile") != {"endpoint": endpoint, **REGISTERED}
            or any(key in registered for key in ("p1_restore", "p1_persona", "p1_settings", "p1_provider", "p1_onboarding", "p1_memory", "p0_tail"))
            or evidence != data / "p1-profile-metadata.jsonl"):
        raise ValueError("profile fixture not registered by isolated host")
    for key in ("root", "data"):
        expected = registered[key]
        target = Path(expected["path"])
        info = target.lstat()
        if (not stat.S_ISDIR(info.st_mode) or target.resolve() != target
                or info.st_uid != os.getuid() or int(expected["uid"]) != info.st_uid
                or str(info.st_dev) != expected["device"] or str(info.st_ino) != expected["inode"]):
            raise ValueError("isolated profile directory identity mismatch")
    if data != Path(registered["data"]["path"]) or data.parent != Path(registered["root"]["path"]) or context.parent != data.parent:
        raise ValueError("profile fixture outside isolation")
    match = re.fullmatch(r"http://127\.0\.0\.1:([0-9]{4,5})/v1", endpoint)
    if not match or not 1024 <= int(match[1]) <= 65535:
        raise ValueError("owned profile model endpoint required")
    required = {"REVERIE_BRIDGE_MODE": "1", "REVERIE_REQUIRE_ENCRYPTED_STORAGE": "1",
                "REVERIE_STORAGE_KEY_FD": "3", "REVERIE_DATA_DIR": str(data / "data"),
                "PYTHON_DOTENV_DISABLED": "1"}
    if any(os.environ.get(key) != value for key, value in required.items()) or not stat.S_ISFIFO(os.fstat(3).st_mode):
        raise ValueError("private encrypted desktop profile bootstrap required")
    settings = json.loads((data / "data/config.json").read_text()).get("llm", {})
    if settings.get("provider") != "ollama" or settings.get("base_url", "").rstrip("/") != endpoint:
        raise ValueError("profile fixture provider not the owned endpoint")
    if evidence.exists():
        private_regular(evidence, 65536)


def record(evidence: Path, cycle: int, event: str, **fields):
    descriptor = os.open(evidence, os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        private_regular(evidence, 65536)
        os.write(descriptor, (json.dumps({"schema": "reverie.qt.p1-profile-metadata.v1", "event": event,
                                        "cycle": cycle, "monotonic_ns": time.monotonic_ns(), **fields}) + "\n").encode())
    finally:
        os.close(descriptor)


def registered_stage(user_message, cycle: int) -> int:
    return PROFILE_REQUESTS.index(user_message) + 1 if cycle == 1 and user_message in PROFILE_REQUESTS else 0


def install_profile_request_timing(evidence: Path, cycle: int):
    """Override only the two registered turns, never the production source."""
    from src.chat.scheduler import MessageScheduler, ReplyStartPlan
    original_start = MessageScheduler.plan_reply_start
    original_delay = MessageScheduler.calculate_delay
    started: set[int] = set()

    def start(self, user_message, **kwargs):
        stage = registered_stage(user_message, cycle)
        if not stage:
            return original_start(self, user_message, **kwargs)
        if stage in started:
            raise ValueError("registered profile turn repeated")
        started.add(stage)
        record(evidence, cycle, "profile_timing", stage=stage, start_delay_ms=0, delivery_delay_ms=100)
        return ReplyStartPlan(0.0, 1.0, "online", "isolated_profile_fixture")

    def delay(self, reply_length, emotion_intensity=0.0, *, user_message="", **kwargs):
        if registered_stage(user_message, cycle):
            return 0.1
        return original_delay(self, reply_length, emotion_intensity, user_message=user_message, **kwargs)

    MessageScheduler.plan_reply_start = start
    MessageScheduler.calculate_delay = delay

    def undo():
        MessageScheduler.plan_reply_start = original_start
        MessageScheduler.calculate_delay = original_delay
    return undo


def profile_metadata(result, *, clear_operation: bool = False) -> dict:
    """A fixed projection: no profile values or backend error text escape."""
    result = result if isinstance(result, dict) else {}
    profile = result.get("profile")
    profile = profile if isinstance(profile, dict) else {}
    snapshot = result.get("profile_snapshot")
    nickname = profile.get("nickname")
    identity = profile.get("identity")
    interests = profile.get("interests")
    games = profile.get("favorite_games")
    anime = profile.get("favorite_anime")
    age = profile.get("age")
    code = result.get("error_code")
    snapshot_valid = isinstance(snapshot, str) and re.fullmatch(r"[0-9a-f]{64}", snapshot) is not None
    profile_valid = all(isinstance(profile.get(field), str) for field in ("name", "nickname", "birthday", "identity", "schedule")) and all(
        isinstance(profile.get(field), list) and all(isinstance(value, str) for value in profile[field])
        for field in ("interests", "hobbies", "favorite_topics", "favorite_games", "favorite_anime")) and (
        "age" in profile and (age is None or (type(age) is int and 18 <= age <= 120)))
    # Existing get/save success has no `ok`; an explicit clear must positively
    # acknowledge that operation. Neither path treats an error payload as OK.
    success = profile_valid and snapshot_valid and "error" not in result and ("ok" not in result or result.get("ok") is True)
    if clear_operation:
        success = success and result.get("ok") is True and result.get("operation") == "clear"
    return {"ok": success,
            "snapshot_length": len(snapshot) if isinstance(snapshot, str) else 0,
            "snapshot_valid": snapshot_valid,
            "nickname_characters": len(nickname) if isinstance(nickname, str) else None,
            "interest_count": len(interests) if isinstance(interests, list) else None,
            "identity_characters": len(identity) if isinstance(identity, str) else None,
            "nickname_empty": nickname == "", "interests_empty": interests == [],
            "nickname_fixture_matches": nickname == NICKNAME, "interests_fixture_matches": interests == [INTEREST],
            "retained_identity_matches": identity == RETAINED_IDENTITY,
            "refilled_nickname_matches": nickname == "再填称呼", "refilled_interests_match": interests == ["再填兴趣"],
            "game_count": len(games) if isinstance(games, list) else None,
            "anime_count": len(anime) if isinstance(anime, list) else None,
            "games_empty": games == [], "anime_empty": anime == [], "age_empty": "age" in profile and age is None,
            "games_fixture_matches": games == [FAVORITE_GAME], "anime_fixture_matches": anime == [FAVORITE_ANIME],
            "age_fixture_matches": type(age) is int and age == AGE,
            "refilled_games_match": games == ["再填游戏"], "refilled_anime_match": anime == ["再填动漫"],
            "refilled_age_matches": type(age) is int and age == 28,
            "error_code": code if isinstance(code, str) and code in {"PROFILE_CLEAR_INVALID", "PROFILE_SNAPSHOT_CHANGED", "PROFILE_CLEAR_UNCONFIRMED", "PROFILE_CLEAR_UNAVAILABLE"} else "none"}


def install_profile_observer(evidence: Path, cycle: int):
    from src.bridge import ws_bridge
    original_dispatch = ws_bridge.dispatch_authenticated_message

    @functools.wraps(original_dispatch)
    async def dispatch(message, endpoint, **kwargs):
        command = message.get("type") if isinstance(message, dict) else None
        payload = message.get("payload", {}) if isinstance(message, dict) else {}
        payload = payload if isinstance(payload, dict) else {}
        raw_id = message.get("request_id") if isinstance(message, dict) else None
        request_id = raw_id if isinstance(raw_id, str) and re.fullmatch(r"[A-Za-z0-9_-]{8,128}", raw_id) else "invalid"
        if command == "chat:send":
            stage = registered_stage(payload.get("text"), cycle)
            if stage:
                record(evidence, cycle, "profile_chat_dispatch", stage=stage, request_id=request_id)
        if command not in {"user:profile:get", "user:profile:update"}:
            return await original_dispatch(message, endpoint, **kwargs)
        operation = "read" if command == "user:profile:get" else "clear" if "clear_fields" in payload else "save"
        clear_fields = payload.get("clear_fields")
        record(evidence, cycle, "profile_dispatch", operation=operation, request_id=request_id,
               clear_field_count=len(clear_fields) if isinstance(clear_fields, list) else 0,
               clear_fields_match=clear_fields == REGISTERED["clearFields"],
               expected_snapshot_valid=isinstance(payload.get("expected_profile_snapshot"), str)
               and re.fullmatch(r"[0-9a-f]{64}", payload["expected_profile_snapshot"]) is not None)
        result = await original_dispatch(message, endpoint, **kwargs)
        record(evidence, cycle, "profile_result", operation=operation, request_id=request_id,
               **profile_metadata(result, clear_operation=operation == "clear"))
        return result

    ws_bridge.dispatch_authenticated_message = dispatch

    def undo():
        ws_bridge.dispatch_authenticated_message = original_dispatch
    return undo


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--stdio-bridge", action="store_true", required=True)
    parser.add_argument("--context", type=Path, required=True)
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--endpoint", required=True)
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--cycle", type=int, required=True)
    args = parser.parse_args(argv)
    validate_context(args.context, args.data_dir, args.endpoint, args.evidence, args.cycle)
    sys.path.insert(0, str(ROOT))
    record(args.evidence, args.cycle, "bootstrap_started")
    undo_timing = install_profile_request_timing(args.evidence, args.cycle)
    undo_observer = install_profile_observer(args.evidence, args.cycle)
    sys.argv = [str(ROOT / "src/main.py"), "--stdio-bridge"]
    try:
        runpy.run_module("src.main", run_name="__main__")
    finally:
        undo_observer()
        undo_timing()


if __name__ == "__main__":
    main()
