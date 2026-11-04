"""One-time synthetic compatibility export from the accepted export-only source.

This is not an original GUI artifact. Run only inside an explicitly registered
development batch, with REVERIE_DATA_DIR pointing at disposable isolation.
"""
from __future__ import annotations

import datetime
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import types

ROOT = Path(__file__).resolve().parents[2]
EXPORTER_COMMIT = "00d557062bac4093bb9c74ea5b6afaa7a9d8c0ea"


def main() -> None:
    assert os.environ.get("REVERIE_DATA_DIR"), "Explicit isolated data required"
    destination = Path(__file__).with_name("p1_restore_same_identity_v3.json")
    metadata_path = destination.with_suffix(".manifest.json")
    if destination.exists() or metadata_path.exists():
        raise RuntimeError("Compatibility artifact already exists; do not overwrite")
    source = subprocess.check_output(["git", "show", f"{EXPORTER_COMMIT}:src/backup.py"], cwd=ROOT)
    sys.path.insert(0, str(ROOT))
    module = types.ModuleType("src._accepted_backup_exporter")
    module.__package__ = "src"
    exec(compile(source, f"git:{EXPORTER_COMMIT}:src/backup.py", "exec"), module.__dict__)

    class Clock(datetime.datetime):
        @classmethod
        def now(cls, tz=None):
            return cls(2026, 10, 13, 0, 0, 0, tzinfo=tz)

    module.datetime = Clock
    from src.persona.persona_card import default_persona

    class Memory:
        persona = default_persona()

        def iter_export_pages(self):
            yield [
                {"id": "compat-v3-memory-001", "text": "合成资料：称呼小星，喜欢月下观测。", "layer": "long_term", "timestamp": 1791849600.0, "importance": 0.7},
                {"id": "compat-v3-memory-002", "text": "合成约定：周五阅读，不是真实个人记录。", "layer": "long_term", "timestamp": 1791849601.0, "importance": 0.6},
            ]

    class State:
        def __init__(self, value):
            self.value = value
        def to_dict(self):
            return self.value
        def export_all(self):
            return self.value

    manager = module.LocalBackupManager(
        memory=Memory(),
        emotion=State({"values": {"joy": 55.0, "calm": 60.0}, "enabled": True, "last_updated": "2026-10-13T00:00:00"}),
        relationship=State({"intimacy": 120, "interaction_count": 2, "positive_interactions": 2, "negative_interactions": 0, "last_interaction_at": "2026-10-13T00:00:00", "recent_fingerprints": ["synthetic-compat"]}),
        user_manager=State({"profile": {"name": "合成用户", "nickname": "小星", "first_seen": "2026-10-13T00:00:00", "last_seen": "2026-10-13T00:00:00", "session_count": 2}, "emotional_memories": []}),
        diary=State({"entries": [{"date": "2026-10-12", "content": "合成日记：在月下观测台阅读。", "mood": "peaceful", "emotions": {}, "created_at": "2026-10-12T21:00:00"}], "missed": ["2026-10-11"], "external_highlights": {"2026-10-13": ["合成事件"]}, "privacy_enabled": True, "peek_enabled": False}),
    )
    manager.backup_to_file(destination)
    raw = destination.read_bytes()
    payload = json.loads(raw)
    assert payload["schema"] == "reverie.full_local_backup.v3"
    assert len(payload["memory"]) == 2 and "export_state" not in payload
    assert payload["user"]["profile"]["nickname"] == "小星"
    metadata = {
        "schema": "reverie.restore-compatibility-fixture.v1",
        "origin": "New synthetic export; not a retained historical GUI export",
        "exporterCommit": EXPORTER_COMMIT,
        "exporterFile": "src/backup.py",
        "exporterSha256": hashlib.sha256(source).hexdigest(),
        "generatorSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "filename": destination.name,
        "bytes": len(raw),
        "sha256": hashlib.sha256(raw).hexdigest(),
        "personaIdentity": payload["persona_identity"],
        "clock": "2026-10-13T00:00:00",
        "sections": list(payload),
        "memoryIds": [record["id"] for record in payload["memory"]],
    }
    metadata_path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"passed": True, "fixture": destination.name, "sha256": metadata["sha256"], "bytes": len(raw)}))


if __name__ == "__main__":
    main()
