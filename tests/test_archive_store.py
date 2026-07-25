from __future__ import annotations

import json

import pytest

from src.archive import ArchiveConflict, ArchiveStore


def sample_archive() -> dict:
    return {
        "characters": [
            {
                "id": "friend-one",
                "name": "Friend One",
                "alternateName": "",
                "age": "",
                "birthday": "",
                "role": "friend",
                "identity": "A social character, not the sealed active persona.",
                "schedule": "",
                "likesDiary": False,
                "values": "",
                "catchphrases": [],
                "neverSay": [],
                "portraitUrl": "/characters/friend-one.png",
                "description": "A bounded local character-card projection.",
                "personality": "calm",
                "speakingStyle": "brief",
                "firstMessage": "",
                "tags": ["local"],
                "createdAt": "2026-07-25T00:00:00+00:00",
                "updatedAt": "2026-07-25T00:00:00+00:00",
            }
        ],
        "activeCharacterIds": ["friend-one"],
        "worldBooks": [
            {
                "id": "world-one",
                "name": "World One",
                "entries": [
                    {
                        "id": "entry-one",
                        "key": "room",
                        "comment": "",
                        "content": "A shared local room.",
                        "alwaysActive": True,
                        "enabled": True,
                    }
                ],
                "createdAt": "2026-07-25T00:00:00+00:00",
                "updatedAt": "2026-07-25T00:00:00+00:00",
            }
        ],
    }


def test_archive_store_is_persona_scoped_and_revision_guarded(tmp_path) -> None:
    store = ArchiveStore(tmp_path / "archive.sqlite3")
    try:
        assert store.get("persona-a")["exists"] is False
        first = store.put("persona-a", sample_archive(), expected_revision=0)
        assert first["revision"] == 1
        assert first["archive"]["characters"][0]["id"] == "friend-one"
        assert store.get("persona-b")["exists"] is False

        changed = sample_archive()
        changed["worldBooks"][0]["entries"][0]["content"] = "Changed once."
        with pytest.raises(ArchiveConflict):
            store.put("persona-a", changed, expected_revision=0)
        assert store.get("persona-a")["archive"]["worldBooks"][0]["entries"][0][
            "content"
        ] == "A shared local room."
    finally:
        store.close()


def test_archive_migration_is_insert_only_and_idempotent(tmp_path) -> None:
    store = ArchiveStore(tmp_path / "archive.sqlite3")
    try:
        first = store.put(
            "persona-a",
            sample_archive(),
            expected_revision=0,
            migrate_only=True,
        )
        replacement = sample_archive()
        replacement["characters"][0]["name"] = "Must Not Overwrite"
        repeated = store.put(
            "persona-a",
            replacement,
            expected_revision=0,
            migrate_only=True,
        )
        assert repeated["revision"] == first["revision"]
        assert repeated["archive"]["characters"][0]["name"] == "Friend One"
    finally:
        store.close()


@pytest.mark.parametrize(
    "mutate",
    [
        lambda value: value["characters"][0].__setitem__(
            "portraitUrl", "https://tracker.example/avatar.png"
        ),
        lambda value: value["characters"][0].__setitem__(
            "portraitUrl", "data:image/png;base64,AAAA"
        ),
        lambda value: value["worldBooks"][0]["entries"][0].__setitem__(
            "constructor", "pollute"
        ),
        lambda value: value.__setitem__("activeCharacterIds", ["unknown"]),
        lambda value: value["characters"].append(value["characters"][0].copy()),
    ],
)
def test_archive_rejects_unsafe_or_ambiguous_content(tmp_path, mutate) -> None:
    store = ArchiveStore(tmp_path / "archive.sqlite3")
    try:
        archive = sample_archive()
        mutate(archive)
        with pytest.raises(ValueError):
            store.put("persona-a", archive, expected_revision=0)
        assert store.get("persona-a")["exists"] is False
    finally:
        store.close()


def test_archive_checksum_detects_disk_tampering(tmp_path) -> None:
    path = tmp_path / "archive.sqlite3"
    store = ArchiveStore(path)
    store.put("persona-a", sample_archive(), expected_revision=0)
    with store._lock:  # Adversarial corruption fixture at the storage boundary.
        store._connection.execute(
            "UPDATE archive_state SET archive_json = ? WHERE persona_id = ?",
            (json.dumps({"characters": []}), "persona-a"),
        )
    with pytest.raises(RuntimeError, match="checksum"):
        store.get("persona-a")
    store.close()
