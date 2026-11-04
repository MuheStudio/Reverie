"""Feature stores must retain real data across an encrypted process restart.

Plaintext-only tests cannot detect a sqlite3.Row factory attached to a
sqlcipher3 connection: both drivers expose the same SQL interface but their
cursor/Row types are not interchangeable.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys

import pytest


FEATURES = ("social", "diary_keys", "ambient", "thoughts", "reflex", "alignment")


def _exercise_feature(feature: str, write: bool, database: Path) -> dict:
    from datetime import datetime, timedelta

    from src.config.settings import FeatureSettings
    from src.persona.persona_card import default_persona

    settings = FeatureSettings(ambient_book_pages_per_hour=2, ambient_trace_interval_minutes=60)
    now = datetime(2026, 7, 15, 12, 0)

    if feature == "social":
        from src.social.universe import SocialUniverse

        store = SocialUniverse(default_persona(), settings, path=database)
        name = "加密回归角色"
        if write:
            assert store.sync_character_cards([{"name": name, "role": "本地测试角色"}]) == 1
        state = store.list_state()
        characters = [character for character in state["characters"] if character["name"] == name]
        assert len(characters) == 1
        assert characters[0]["source"] == "local_character_card"
        members = sorted(member["name"] for thread in state["threads"] for member in thread["members"])
        assert name in members
        return {"character": characters[0], "members": members}

    if feature == "diary_keys":
        from src.diary.easter_egg import DiaryKeyManager

        # Restore/export is independent of eligibility collaborators. Sentinels
        # ensure this storage regression never generates or reads a real diary.
        store = DiaryKeyManager(settings, ambient=object(), diary=object(), relationship=object(), path=database)
        if write:
            assert store.import_all({
                "schema": "reverie.diary_keys.v1",
                "state": {"host_date": "2026-07-15", "target_date": "2026-05-01", "eligible_at": 1000, "unlocked_at": 1060},
                "unlocks": [{"date": "2026-05-01", "host_date": "2026-07-15", "unlocked_at": 1060, "reason": "encrypted restart proof"}],
            }) == 2
        state = store.export_all()
        assert state["state"]["unlocked"] is True
        assert state["state"]["target_date"] == "2026-05-01"
        assert state["unlocks"][0]["reason"] == "encrypted restart proof"
        return state

    if feature == "ambient":
        from src.ambient import AmbientPresence

        store = AmbientPresence(settings, path=database)
        if write:
            store.advance(now)
            store.advance(now + timedelta(hours=2))
        state = store.export_all()
        assert len(state["runtime"]) == 1
        assert state["runtime"][0]["book_page"] == 16
        assert len(state["traces"]) == 2
        return state

    if feature == "thoughts":
        from src.ambient import ThoughtOfYouEngine
        from src.web import WebItem
        from src.web.sanitizer import CLASSIFIER_VERSION

        store = ThoughtOfYouEngine(settings, path=database)
        if write:
            item = WebItem(
                id="encrypted-thought", title="加密保存的本地资讯", summary="合成资讯用于本地持久化测试。",
                source="local", topic="游戏更新", fetched_at=now.isoformat(),
                source_url="https://example.com/fixture", source_name="synthetic-fixture",
                trust_level="untrusted_web", source_hash="a" * 64,
                sanitizer_status="approved", sanitizer_version=CLASSIFIER_VERSION,
            )
            assert store.ingest([item], now=now) == 1
        state = store.export_all()
        assert len(state["items"]) == 1
        assert state["items"][0]["title"] == "加密保存的本地资讯"
        assert state["items"][0]["source_hash"] == "a" * 64
        assert store.pending_count(now=now) == 1
        return state

    if feature == "reflex":
        from src.chat.reflex import ReflexSystem

        store = ReflexSystem(database, persona=default_persona())
        try:
            count = store.count()
            assert count > 0
            response = store.choose("care", context="encrypted restart proof") if write else None
            # The public API has no usage-history reader. Inspect the actual
            # persisted receipt through the module's connection, without mocks.
            rows = store._connection.execute(
                "SELECT phrases.text, usage.context FROM reflex_usage AS usage "
                "JOIN reflex_phrases AS phrases ON phrases.id=usage.phrase_id ORDER BY usage.sequence"
            ).fetchall()
            assert len(rows) == 1
            assert rows[0]["context"] == "encrypted restart proof"
            if write:
                assert rows[0]["text"] == response
            return {"count": count, "receipt": dict(rows[0])}
        finally:
            store.close()

    if feature == "alignment":
        from src.persona.alignment import UserPhraseAlignment

        store = UserPhraseAlignment(path=database)
        if write:
            for _ in range(3):
                assert store.observe("好耶") == ["好耶"]
        rows = store.top_phrases(minimum_count=3)
        assert len(rows) == 1
        assert rows[0]["phrase"] == "好耶"
        assert rows[0]["mention_count"] == 3
        return {"phrases": rows}

    raise ValueError(f"Unknown feature: {feature}")


@pytest.mark.parametrize("feature", FEATURES)
def test_feature_state_survives_real_encrypted_process_restart(tmp_path: Path, feature: str) -> None:
    database = tmp_path / f"{feature}.sqlite3"
    key = os.urandom(32)
    environment = {
        **os.environ,
        "PYTHON_DOTENV_DISABLED": "1",
        "PYTHONDONTWRITEBYTECODE": "1",
        "REVERIE_DATA_DIR": str(tmp_path / "data"),
        "HF_HUB_OFFLINE": "1",
    }
    environment.pop("PYTHONHOME", None)
    environment.pop("PYTHONPATH", None)
    states = []
    for mode in ("write", "reopen"):
        # Reflex seeds 184 phrases through the real FULL-synchronous,
        # autocommit connection. Windows hosted disks need a separate bounded
        # budget for those durable writes; encryption/transactions stay intact.
        timeout = 120 if sys.platform == "win32" and feature == "reflex" and mode == "write" else 40
        try:
            process = subprocess.run(
                [sys.executable, "-I", "-B", "-X", "utf8", str(Path(__file__).resolve()), feature, mode, str(database)],
                input=key, capture_output=True, env=environment, timeout=timeout, check=False,
            )
        except subprocess.TimeoutExpired as exc:
            diagnostics = (exc.stderr or b"").decode("utf-8", errors="replace")
            pytest.fail(f"Encrypted feature worker {feature}/{mode} exceeded {timeout}s:\n{diagnostics}", pytrace=False)
        assert process.returncode == 0, process.stderr.decode("utf-8", errors="replace")
        states.append(json.loads(process.stdout))
    assert states[0] == states[1]
    assert database.read_bytes()[:16] != b"SQLite format 3\x00"
    connection = sqlite3.connect(f"{database.as_uri()}?mode=ro", uri=True)
    try:
        with pytest.raises(sqlite3.DatabaseError):
            connection.execute("SELECT count(*) FROM sqlite_master").fetchone()
    finally:
        connection.close()


if __name__ == "__main__":
    import faulthandler
    import time

    # Diagnose a slow or stuck worker without putting ordinary text into its
    # JSON stdout or exposing the test key. This never changes app timeouts.
    faulthandler.dump_traceback_later(30, repeat=True)
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from src.storage.encrypted_sqlite import install_storage_key

    # This is a dedicated ephemeral test key, delivered through a pipe, never
    # a command-line argument, environment value, or plaintext disk artifact.
    install_storage_key(sys.stdin.buffer.read(), require_encryption=True)
    feature, mode, filename = sys.argv[1:]
    started = time.monotonic()
    print(f"[encrypted-feature] {feature}/{mode}: start", file=sys.stderr, flush=True)
    try:
        state = _exercise_feature(feature, mode == "write", Path(filename))
        print(f"[encrypted-feature] {feature}/{mode}: completed in {time.monotonic() - started:.3f}s", file=sys.stderr, flush=True)
        print(json.dumps(state, ensure_ascii=False))
    finally:
        faulthandler.cancel_dump_traceback_later()
