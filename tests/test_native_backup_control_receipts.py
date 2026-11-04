"""Native backup receipts preserve the transport envelope across real inspection."""

from __future__ import annotations

import hashlib
import io
import json
import os
from pathlib import Path
from types import SimpleNamespace

import pytest

from src.backup_inspection import BACKUP_SCHEMA, BackupRestoreError
from src.bridge import stdio_bridge, ws_bridge
from src.bridge.stdio_transport import encode_frame, read_frame


FIXTURE = Path(__file__).parent / "fixtures/p1_restore_same_identity_v3.json"
INSPECTION_REQUEST_ID = "receipt_inspect_001"


@pytest.fixture
def bridge(monkeypatch: pytest.MonkeyPatch) -> ws_bridge.BridgeState:
    state = ws_bridge.BridgeState()
    monkeypatch.setattr(ws_bridge, "bridge_state", state)
    monkeypatch.setenv("REVERIE_BRIDGE_MODE", "1")
    return state


def _request(control_type: str, **payload: object) -> dict:
    return {
        "kind": "control",
        "schema": stdio_bridge.CONTROL_SCHEMA,
        "type": control_type,
        "requestId": INSPECTION_REQUEST_ID,
        **payload,
    }


def _serialized(receipt: dict) -> tuple[bytes, dict]:
    wire = encode_frame(receipt)
    stream = io.BytesIO(wire)
    decoded = read_frame(stream)
    assert decoded == receipt
    assert read_frame(stream) is None
    return wire, decoded


def _assert_envelope(receipt: dict, request: dict, *, ok: bool) -> None:
    assert receipt["kind"] == "control_result"
    assert receipt["schema"] == stdio_bridge.CONTROL_SCHEMA
    assert receipt["requestId"] == request["requestId"]
    assert receipt["type"] == request["type"]
    assert receipt["ok"] is ok


def _capture_receipt(wire: bytes, source: bytes, receipt: dict) -> None:
    destination = os.environ.get("REVERIE_P1_CONTROL_RECEIPT_DIR")
    if not destination:
        return
    capture = Path(destination)
    assert capture.is_absolute(), "receipt capture must use the registered absolute scratch directory"
    capture.mkdir(exist_ok=False)
    # The formal unit batch passes these exact Python-produced bytes to Qt.
    for filename, contents in (("receipt.bin", wire), ("source.json", source)):
        with (capture / filename).open("xb") as output:
            output.write(contents)
    manifest = {
        "source_fixture": str(FIXTURE.relative_to(Path(__file__).parent.parent)),
        "source_sha256": hashlib.sha256(source).hexdigest(),
        "source_file_bytes": len(source),
        "receipt_sha256": hashlib.sha256(wire).hexdigest(),
        "receipt_file_bytes": len(wire),
        "requestId": receipt["requestId"],
        "schema": receipt["schema"],
        "backup_schema": receipt["backup_schema"],
    }
    with (capture / "manifest.json").open("x", encoding="utf-8") as output:
        json.dump(manifest, output, ensure_ascii=False, sort_keys=True, indent=2)
        output.write("\n")


@pytest.mark.asyncio
async def test_stdio_inspection_serializes_real_v3_fixture_without_effects(
    bridge: ws_bridge.BridgeState, monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    source_bytes = FIXTURE.read_bytes()
    source = (tmp_path / "private-selected-backup-canary.json").resolve()
    source.write_bytes(source_bytes)
    before = set(tmp_path.iterdir())
    payload = json.loads(source_bytes)

    class ForbiddenOwner:
        def __getattr__(self, _name: str) -> object:
            pytest.fail("readonly inspection entered the ledger or restore coordinator")

    bridge.kernel_store = ForbiddenOwner()
    bridge.restore_coordinator = ForbiddenOwner()
    monkeypatch.setattr(ws_bridge, "_local_backup_manager", lambda: pytest.fail("inspection opened a manager"))
    request = _request("backup:file:inspect", path=str(source))

    wire, receipt = _serialized(await stdio_bridge._handle_control(request))

    _assert_envelope(receipt, request, ok=True)
    assert receipt["operation"] == "inspect"
    assert receipt["backup_schema"] == payload["schema"] == BACKUP_SCHEMA
    assert receipt["schema_version"] == 3
    assert receipt["persona_identity"] == payload["persona_identity"]
    assert receipt["memory_count"] == len(payload["memory"]) == 2
    assert receipt["sha256"] == hashlib.sha256(source_bytes).hexdigest()
    assert receipt["file_bytes"] == len(source_bytes)
    assert receipt["recovery_state"] == "clean"
    assert receipt["runtime_writable"] is True and receipt["writes_blocked"] is False
    assert source.read_bytes() == source_bytes and set(tmp_path.iterdir()) == before
    serialized = wire[4:].decode("utf-8")
    assert str(source) not in serialized and source.name not in serialized
    for memory in payload["memory"]:
        assert memory["text"] not in serialized
    assert payload["diary"]["entries"][0]["content"] not in serialized
    _capture_receipt(wire, source_bytes, receipt)


@pytest.mark.asyncio
@pytest.mark.parametrize("operation", ["inspect", "export", "import"])
async def test_stdio_backup_payload_cannot_replace_reserved_control_fields(
    bridge: ws_bridge.BridgeState, monkeypatch: pytest.MonkeyPatch, operation: str,
) -> None:
    async def backup_result(_operation: str, _path: object, **_options: object) -> dict:
        return {
            "operation": operation, "backup_schema": BACKUP_SCHEMA,
            "kind": "event", "schema": BACKUP_SCHEMA,
            "type": "backup:file:wrong", "requestId": "unrelated_receipt_001",
            "outcome": "committed",
        }

    monkeypatch.setattr(ws_bridge, "_run_native_backup", backup_result)
    request = _request(f"backup:file:{operation}", path="/private/selected.json")
    _wire, receipt = _serialized(await stdio_bridge._handle_control(request))
    _assert_envelope(receipt, request, ok=True)
    assert receipt["operation"] == operation and receipt["backup_schema"] == BACKUP_SCHEMA
    assert receipt["outcome"] == "committed"


@pytest.mark.asyncio
@pytest.mark.parametrize("locked", [False, True])
async def test_stdio_export_receipt_preserves_write_and_consistency_semantics(
    bridge: ws_bridge.BridgeState, monkeypatch: pytest.MonkeyPatch, tmp_path: Path, locked: bool,
) -> None:
    destination = (tmp_path / "private-export-canary.json").resolve()
    fixture_bytes = FIXTURE.read_bytes()
    calls: list[Path] = []

    def export(target: Path) -> None:
        calls.append(target)
        target.write_bytes(fixture_bytes)

    monkeypatch.setattr(ws_bridge, "_local_backup_manager", lambda: (SimpleNamespace(backup_to_file=export), None))
    bridge.recovery_state = "recovery_required" if locked else "clean"
    request = _request("backup:file:export", path=str(destination))
    wire, receipt = _serialized(await stdio_bridge._handle_control(request))
    _assert_envelope(receipt, request, ok=True)
    assert calls == [destination] and destination.read_bytes() == fixture_bytes
    assert receipt["operation"] == "export"
    assert receipt["export_consistency"] == ("unconfirmed" if locked else "confirmed")
    assert receipt["writes_blocked"] is locked and receipt["runtime_writable"] is not locked
    assert str(destination) not in wire[4:].decode("utf-8")


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["normal", "rescue"])
async def test_stdio_import_receipt_preserves_coordinator_options_and_result(
    bridge: ws_bridge.BridgeState, tmp_path: Path, mode: str,
) -> None:
    source = (tmp_path / "selected.json").resolve()
    source_bytes = FIXTURE.read_bytes()
    source.write_bytes(source_bytes)
    calls: list[tuple[Path, dict]] = []
    committed = {"outcome": "committed", "restore_generation": 7}

    class Coordinator:
        async def restore_file(self, path: Path, **options: object) -> dict:
            calls.append((path, options))
            return committed

    bridge.restore_coordinator = Coordinator()
    digest = hashlib.sha256(source_bytes).hexdigest()
    request = _request("backup:file:import", path=str(source), mode=mode,
                       sha256=digest, file_bytes=len(source_bytes), known_good_confirmed=mode == "rescue")
    wire, receipt = _serialized(await stdio_bridge._handle_control(request))
    _assert_envelope(receipt, request, ok=True)
    assert calls == [(source, {"rescue": mode == "rescue", "expected_sha256": digest,
                              "expected_file_bytes": len(source_bytes)})]
    assert receipt["operation"] == "import" and receipt["mode"] == mode
    assert receipt["result"] == committed and receipt["outcome"] == "committed"
    assert receipt["restore_generation"] == 7 and receipt["writes_blocked"] is False
    assert source.read_bytes() == source_bytes and str(source) not in wire[4:].decode("utf-8")


@pytest.mark.asyncio
@pytest.mark.parametrize("contents,code", [
    (b'{"schema":', "BACKUP_INVALID_FORMAT"),
    (b'{"export_state":{"consistency":"unconfirmed","reason":"private-reason-canary"}}',
     "BACKUP_UNCONFIRMED_EXPORT"),
])
async def test_stdio_inspection_error_receipts_keep_public_codes_and_envelope(
    bridge: ws_bridge.BridgeState, tmp_path: Path, contents: bytes, code: str,
) -> None:
    source = (tmp_path / "private-invalid-backup-canary.json").resolve()
    source.write_bytes(contents)
    request = _request("backup:file:inspect", path=str(source))
    with pytest.raises(BackupRestoreError) as error:
        await stdio_bridge._handle_control(request)
    wire, receipt = _serialized(stdio_bridge._control_failure(request["requestId"], request["type"], error.value))
    _assert_envelope(receipt, request, ok=False)
    assert receipt["code"] == code
    assert "canary" not in wire[4:].decode("utf-8")
    assert source.read_bytes() == contents


@pytest.mark.asyncio
@pytest.mark.parametrize("locked,code,outcome", [
    (False, "BACKUP_ROLLED_BACK", "rolled_back"),
    (True, "BACKUP_RECOVERY_REQUIRED", "unconfirmed"),
])
async def test_stdio_import_error_receipts_preserve_rollback_and_readlock_outcomes(
    bridge: ws_bridge.BridgeState, tmp_path: Path, locked: bool, code: str, outcome: str,
) -> None:
    source = (tmp_path / "selected.json").resolve()
    source.write_bytes(FIXTURE.read_bytes())

    class Coordinator:
        async def restore_file(self, _path: Path, **_options: object) -> dict:
            bridge.recovery_state = "recovery_required" if locked else "clean"
            raise BackupRestoreError("private-restore-exception-canary", code=code)

    bridge.restore_coordinator = Coordinator()
    request = _request("backup:file:import", path=str(source))
    with pytest.raises(BackupRestoreError) as error:
        await stdio_bridge._handle_control(request)
    wire, receipt = _serialized(stdio_bridge._control_failure(request["requestId"], request["type"], error.value))
    _assert_envelope(receipt, request, ok=False)
    assert receipt["code"] == code and receipt["outcome"] == outcome
    assert receipt["writes_blocked"] is locked and receipt["runtime_writable"] is not locked
    assert "canary" not in wire[4:].decode("utf-8")


@pytest.mark.asyncio
async def test_private_v1_inspection_ack_preserves_schema_for_real_v3_fixture(
    bridge: ws_bridge.BridgeState, monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    source = (tmp_path / "selected.json").resolve()
    source_bytes = FIXTURE.read_bytes()
    source.write_bytes(source_bytes)
    request = {"schema": "reverie.bridge.control.v1", "type": "backup:file:inspect",
               "requestId": INSPECTION_REQUEST_ID, "path": str(source)}
    monkeypatch.setattr(ws_bridge.sys, "stdin", io.StringIO(json.dumps(request) + "\n"))
    await ws_bridge._bridge_control_loop()
    lines = capsys.readouterr().out.splitlines()
    assert len(lines) == 1 and lines[0].startswith("REVERIE_BRIDGE_CONTROL ")
    receipt = json.loads(lines[0].removeprefix("REVERIE_BRIDGE_CONTROL "))
    assert receipt["schema"] == "reverie.bridge.control.ack.v1"
    assert receipt["type"] == request["type"] and receipt["requestId"] == request["requestId"]
    assert receipt["ok"] is True and receipt["backup_schema"] == BACKUP_SCHEMA
    assert receipt["memory_count"] == 2 and receipt["sha256"] == hashlib.sha256(source_bytes).hexdigest()
    assert str(source) not in lines[0] and source.read_bytes() == source_bytes


@pytest.mark.asyncio
async def test_private_v1_backup_payload_cannot_replace_ack_envelope(
    bridge: ws_bridge.BridgeState, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    async def backup_result(_operation: str, _path: object, **_options: object) -> dict:
        return {"schema": BACKUP_SCHEMA, "type": "wrong", "requestId": "wrong_receipt_001",
                "operation": "inspect", "backup_schema": BACKUP_SCHEMA}

    monkeypatch.setattr(ws_bridge, "_run_native_backup", backup_result)
    request = {"schema": "reverie.bridge.control.v1", "type": "backup:file:inspect",
               "requestId": INSPECTION_REQUEST_ID, "path": "/private/selected.json"}
    monkeypatch.setattr(ws_bridge.sys, "stdin", io.StringIO(json.dumps(request) + "\n"))
    await ws_bridge._bridge_control_loop()
    lines = capsys.readouterr().out.splitlines()
    assert len(lines) == 1
    receipt = json.loads(lines[0].removeprefix("REVERIE_BRIDGE_CONTROL "))
    assert receipt["schema"] == "reverie.bridge.control.ack.v1"
    assert receipt["type"] == request["type"] and receipt["requestId"] == request["requestId"]
    assert receipt["ok"] is True and receipt["backup_schema"] == BACKUP_SCHEMA
