from __future__ import annotations

import json
import copy

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


@pytest.mark.parametrize("priority", [0, 2147483647, 2147483648],
                         ids=["zero", "native-maximum", "legacy-above-native"])
def test_priority_roundtrip_preserves_unedited_archive_and_persona(tmp_path, priority):
    path = tmp_path / "priority.sqlite3"
    store = ArchiveStore(path)
    try:
        source = sample_archive()
        source["worldBooks"][0]["entries"][0].update(
            priority=priority, useRegex=True, keywords=["room.*"], position="after_char", depth=7,
            role="assistant", insertionOrder=10)
        first = store.put("sunny", source, expected_revision=0)
        moon = store.put("moon", sample_archive(), expected_revision=0)
        edited = copy.deepcopy(first["archive"])
        edited["worldBooks"][0]["entries"][0]["comment"] = "Only the comment changes"
        second = store.put("sunny", edited, expected_revision=first["revision"])
        assert second["archive"] == edited
        assert second["archive"]["worldBooks"][0]["entries"][0]["priority"] == priority
        assert store.get("moon") == moon
        with pytest.raises(ArchiveConflict):
            store.put("sunny", first["archive"], expected_revision=first["revision"])
        assert store.get("sunny") == second
    finally:
        store.close()
    reopened = ArchiveStore(path)
    try:
        assert reopened.get("sunny") == second
        assert reopened.get("moon") == moon
    finally:
        reopened.close()


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


@pytest.mark.parametrize("pattern", [r"\d{1,3}", "你好，世界", "  padded  ", "pre\tpost", "😀{1,3}", "line1\nline2"],
                         ids=["ascii-comma", "fullwidth-comma", "edge-spaces", "literal-tab", "non-bmp", "embedded-newline"])
def test_rule_lists_preserve_each_item_and_order_across_save_and_restart(tmp_path, pattern):
    path = tmp_path / "rule-list-roundtrip.sqlite3"
    store = ArchiveStore(path)
    try:
        source = sample_archive()
        source["worldBooks"][0]["entries"][0].update(
            keywords=[pattern, "second", pattern], secondaryKeywords=["aux", pattern], useRegex=True)
        first = store.put("persona-a", source, expected_revision=0)
        other = store.put("persona-b", sample_archive(), expected_revision=0)
        changed = copy.deepcopy(first["archive"])
        changed["worldBooks"][0]["entries"][0]["comment"] = "Only comment changed"
        saved = store.put("persona-a", changed, expected_revision=first["revision"])
        assert saved["archive"] == changed
        item = saved["archive"]["worldBooks"][0]["entries"][0]
        assert item["keywords"] == [pattern, "second", pattern]
        assert item["secondaryKeywords"] == ["aux", pattern]
        assert store.get("persona-b") == other
    finally:
        store.close()
    reopened = ArchiveStore(path)
    try:
        assert reopened.get("persona-a") == saved
        assert reopened.get("persona-b") == other
    finally:
        reopened.close()


def test_rule_lists_drop_only_whitespace_items_without_trimming_other_items(tmp_path):
    store = ArchiveStore(tmp_path / "rule-list-blank.sqlite3")
    try:
        source = sample_archive()
        source["worldBooks"][0]["entries"][0].update(
            keywords=["", " ", "\t", "\n", "  a,b  ", "😀"],
            secondaryKeywords=[" \t ", " aux，value ", "tail"], useRegex=True)
        saved = store.put("persona-a", source, expected_revision=0)
        item = saved["archive"]["worldBooks"][0]["entries"][0]
        assert item["keywords"] == ["  a,b  ", "😀"]
        assert item["secondaryKeywords"] == [" aux，value ", "tail"]
    finally:
        store.close()


def test_new_book_missing_settings_use_common_defaults(tmp_path):
    store = ArchiveStore(tmp_path / "new-book-defaults.sqlite3")
    try:
        source = sample_archive()
        book = source["worldBooks"][0]
        assert not {"scanDepth", "tokenBudget", "recursiveScanning"}.intersection(book)
        saved = store.put("new-defaults", source, expected_revision=0)
        created = saved["archive"]["worldBooks"][0]
        assert created["scanDepth"] == 50
        assert created["tokenBudget"] == 500
        assert created["recursiveScanning"] is False
        assert store.get("new-defaults") == saved
    finally:
        store.close()


def test_new_entry_missing_fields_keep_common_defaults(tmp_path):
    store = ArchiveStore(tmp_path / "new-entry-defaults.sqlite3")
    try:
        source = sample_archive()
        source["worldBooks"][0]["entries"] = [
            {"id": "new-default-entry", "content": "Only the entry body is supplied."}
        ]
        saved = store.put("new-defaults", source, expected_revision=0)
        entry = saved["archive"]["worldBooks"][0]["entries"][0]
        expected = {
            "keywords": [], "secondaryKeywords": [], "selectiveLogic": "and_any",
            "caseSensitive": False, "enabled": True, "alwaysActive": False,
            "useRegex": False, "position": "before_char", "insertionOrder": 100,
            "priority": 0, "scanDepth": None, "tokenBudget": None, "depth": 0,
            "role": "system",
        }
        assert {key: entry[key] for key in expected} == expected
        for key in ("caseSensitive", "alwaysActive", "useRegex"):
            assert entry[key] is False
        assert entry["enabled"] is True
        assert entry["scanDepth"] is None and entry["tokenBudget"] is None
        assert entry["content"] == "Only the entry body is supplied."
        assert store.get("new-defaults") == saved
    finally:
        store.close()
