from __future__ import annotations

import asyncio
import importlib.util
import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("p1_card_edit_observer", ROOT / "native-ui/tests/p1_card_edit_observer.py")
observer = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(observer)


def write_private(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False))
    path.chmod(0o600)


def test_observer_reads_real_before_and_after_files_and_delegates_once(tmp_path, monkeypatch):
    from src.bridge import ws_bridge
    from src.config import settings

    data = tmp_path.resolve()
    root = data / "data/persona"
    profile_id = "st_" + "a" * 20
    directory = root / "imported" / profile_id
    profile = {"id": profile_id, "persona_id": profile_id, "name": "测试人格·晴", "source_format": "chara_card_v2",
               "source_sha256": "b" * 64, "identity_version": 1, "identity_fingerprint": "c" * 64,
               "persona_path": f"imported/{profile_id}/persona.json"}
    registry = {"active_id": "default", "profiles": {profile_id: profile}}
    write_private(root / "registry.json", registry)
    write_private(root / "active.json", {"fixture": "active"})
    write_private(directory / "persona.json", {"fixture": "original"})
    write_private(directory / "import-report.json", {"fixture": "source"})
    # Unregistered files, including the old naming scheme, must not be picked
    # as this save's version-two evidence.
    orphan = directory / "persona.v2.json"
    write_private(orphan, {"fixture": "old orphan"})
    orphan_before = orphan.read_bytes()
    # Existing import/switch paths legitimately inherit umask 022.
    for path in (root / "registry.json", root / "active.json", directory / "persona.json", directory / "import-report.json"):
        path.chmod(0o644)
    old_log = data / "p1-persona-metadata.jsonl"
    old_log.write_bytes(b"signed-log-unchanged\n")
    monkeypatch.setattr(settings, "PERSONA_DIR", root)
    scope = {"persona_id": "default", "persona_epoch": 8, "persona_fingerprint": "d" * 64}
    monkeypatch.setattr(ws_bridge, "_active_persona_scope", lambda: scope.copy())
    calls = []

    async def actual(message, endpoint, **kwargs):
        calls.append((message, endpoint, kwargs))
        if message["type"] != "persona:profile:update":
            return {"untouched": True}
        version = profile["identity_version"] + 1
        fingerprint = ("e" if version == 2 else "f") * 64
        profile.update(identity_version=version, identity_fingerprint=fingerprint)
        profile["persona_path"] = f"imported/{profile_id}/persona.v{version}-{fingerprint[:16]}.json"
        write_private(root / profile["persona_path"], {"fixture": f"new version {version}"})
        write_private(root / "registry.json", registry)
        (root / "registry.json").chmod(0o644)
        return {"ok": True, "identity_version": version, "identity_fingerprint": fingerprint,
                "active": False, "fields": {"description": f"合成版本{version}"}}

    monkeypatch.setattr(ws_bridge, "dispatch_authenticated_message", actual)
    before_original = (directory / "persona.json").read_bytes()
    before_cache = (root / "active.json").read_bytes()
    undo = observer.install(data, 1)
    wrapped = ws_bridge.dispatch_authenticated_message
    try:
        assert asyncio.run(wrapped({"type": "persona:list"}, "controller", marker=1)) == {"untouched": True}
        assert not (data / "p1-card-edit-metadata.jsonl").exists()
        message = {"type": "persona:profile:update", "request_id": "edit_fixture_0001", "payload": {"profile_id": profile_id}}
        result = asyncio.run(wrapped(message, "controller", marker=2))
        first_path = profile["persona_path"]
        first_version_bytes = (root / first_path).read_bytes()
        second_message = {**message, "request_id": "edit_fixture_0002"}
        second_result = asyncio.run(wrapped(second_message, "controller", marker=3))
    finally:
        undo()
    assert ws_bridge.dispatch_authenticated_message is actual
    assert len(calls) == 3 and calls[1] == (message, "controller", {"marker": 2})
    assert calls[2] == (second_message, "controller", {"marker": 3})
    event, second_event = [json.loads(line) for line in (data / "p1-card-edit-metadata.jsonl").read_text().splitlines()]
    assert event["before"]["profile"]["identity_version"] == 1
    assert event["after"]["profile"]["identity_version"] == result["identity_version"] == 2
    assert event["before"]["v2"] is None and event["after"]["v2"]["bytes"] > 0
    assert event["after"]["v2"]["path"] == event["after"]["profile"]["persona_path"] == first_path
    assert second_event["before"]["v2"] == second_event["after"]["v2"] == event["after"]["v2"]
    assert second_event["after"]["v3"]["path"] == profile["persona_path"]
    assert second_event["after"]["profile"]["identity_version"] == second_result["identity_version"] == 3
    assert (root / first_path).read_bytes() == first_version_bytes
    assert orphan.read_bytes() == orphan_before
    assert event["before"]["cache"] == event["after"]["cache"]
    assert event["before"]["scope"] == event["after"]["scope"] == scope
    assert event["before"]["otherRegistrySha256"] == event["after"]["otherRegistrySha256"]
    assert (directory / "persona.json").read_bytes() == before_original
    assert (root / "active.json").read_bytes() == before_cache
    assert old_log.read_bytes() == b"signed-log-unchanged\n"
    assert str(data) not in (data / "p1-card-edit-metadata.jsonl").read_text()
    assert (data / "p1-card-edit-metadata.jsonl").stat().st_mode & 0o077 == 0


def test_observer_refuses_a_store_outside_the_owned_isolation(tmp_path, monkeypatch):
    from src.config import settings
    monkeypatch.setattr(settings, "PERSONA_DIR", tmp_path.resolve() / "outside")
    with pytest.raises(ValueError, match="outside owned isolation"):
        observer.install(tmp_path.resolve(), 1)
    assert not (tmp_path / "outside").exists()


def test_observer_refuses_symlink_hardlink_or_public_file(tmp_path):
    target = tmp_path / "private.json"
    write_private(target, {"value": 1})
    linked = tmp_path / "linked.json"
    linked.symlink_to(target)
    with pytest.raises(ValueError, match="private regular file"):
        observer._read(linked)
    linked.unlink()
    linked.hardlink_to(target)
    with pytest.raises(ValueError, match="private regular file"):
        observer._read(target)
    linked.unlink()
    target.chmod(0o644)
    assert observer._read(target) == target.read_bytes()
    with pytest.raises(ValueError, match="private regular file"):
        observer._read(target, private=True)


@pytest.mark.parametrize("version", [2, 3])
def test_observer_new_version_digest_requires_private_mode(tmp_path, version):
    path = tmp_path / f"persona.v{version}-{'a' * 16}.json"
    write_private(path, {"identity": {"identity_version": version}})
    assert observer._digest(path, private=True)["bytes"] > 0
    path.chmod(0o644)
    with pytest.raises(ValueError, match="private regular file"):
        observer._digest(path, private=True)


@pytest.mark.parametrize("bad_path", [
    "imported/{id}/persona.v2.json",
    "imported/{id}/persona.v2-bbbbbbbbbbbbbbbb.json",
    "imported/st_bbbbbbbbbbbbbbbbbbbb/persona.v2-aaaaaaaaaaaaaaaa.json",
    "../persona.v2-aaaaaaaaaaaaaaaa.json",
    "/tmp/persona.v2-aaaaaaaaaaaaaaaa.json",
    "imported/{id}/persona.v3-aaaaaaaaaaaaaaaa.json",
    None,
])
def test_observer_rejects_missing_or_foreign_registered_version_path(tmp_path, bad_path):
    profile_id = "st_" + "a" * 20
    selected = {"identity_version": 2, "identity_fingerprint": "a" * 64,
                "persona_path": bad_path.format(id=profile_id) if isinstance(bad_path, str) else bad_path}
    with pytest.raises(ValueError, match="registry version path invalid"):
        observer._registered_version_path(tmp_path.resolve(), profile_id, selected)
