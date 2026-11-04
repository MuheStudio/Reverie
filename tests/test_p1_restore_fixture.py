from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("p1_restore_fixture", ROOT / "native-ui/tests/p1_restore_backend_bootstrap.py")
fixture = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(fixture)


def test_restore_fault_schedule_is_private_and_bounded_to_two_cycles(tmp_path, monkeypatch):
    import src.backup as backup
    class Manager:
        def __init__(self, *, fault_hook=None): self.hook = fault_hook
    monkeypatch.setattr(backup, "LocalBackupManager", Manager)
    trace = tmp_path / "p1-restore-metadata.jsonl"
    schedule = tmp_path / "p1-restore-fault.json"
    undo = fixture.install_fault(tmp_path, trace, 1)
    manager = Manager()
    manager.hook("before_finalize")  # No schedule, no injection.
    schedule.write_text(json.dumps({"schema":fixture.FAULT_SCHEMA,"phase":"before_finalize","remaining":2}))
    schedule.chmod(0o600)
    manager.hook("before_memory_commit")
    assert json.loads(schedule.read_text())["remaining"] == 2
    with pytest.raises(OSError, match="isolated finalization fault"):
        manager.hook("before_finalize")
    assert json.loads(schedule.read_text())["remaining"] == 1
    with pytest.raises(ValueError, match="outside registered cycle"):
        manager.hook("before_finalize")
    undo()
    undo = fixture.install_fault(tmp_path, trace, 2)
    manager = Manager()
    with pytest.raises(OSError): manager.hook("before_finalize")
    assert json.loads(schedule.read_text())["remaining"] == 0
    manager.hook("before_finalize")
    events = [json.loads(line) for line in trace.read_text().splitlines()]
    assert [(e["cycle"], e["remaining"]) for e in events if e["event"] == "finalization_fault"] == [(1,1),(2,0)]
    assert not list(tmp_path.glob("*.tmp"))
    undo()


def test_restore_fault_schedule_refuses_symlink_or_public_file(tmp_path, monkeypatch):
    import src.backup as backup
    class Manager:
        def __init__(self, *, fault_hook=None): self.hook = fault_hook
    monkeypatch.setattr(backup, "LocalBackupManager", Manager)
    undo = fixture.install_fault(tmp_path, tmp_path / "p1-restore-metadata.jsonl", 1)
    schedule = tmp_path / "p1-restore-fault.json"
    schedule.write_text('{}'); schedule.chmod(0o644)
    with pytest.raises(ValueError, match="invalid isolated fixture file"):
        Manager().hook("before_finalize")
    schedule.unlink()
    target = tmp_path / "original.json"; target.write_text('{}'); target.chmod(0o600)
    schedule.symlink_to(target)
    with pytest.raises(ValueError, match="invalid isolated fixture file"):
        Manager().hook("before_finalize")
    assert target.read_text() == '{}'
    undo()


@pytest.mark.asyncio
async def test_backup_control_observation_preserves_receipt_and_excludes_private_fields(tmp_path, monkeypatch):
    from src.bridge import stdio_bridge
    original_result = {"kind":"control_result", "schema":"reverie.bridge.stdio.control.v4",
                       "backup_schema":"reverie.full_local_backup.v3", "ok":True,
                       "recovery_state":"clean", "private_test_field":"private-body-canary"}
    async def handler(message):
        assert message["path"] == "private-path-canary"
        return original_result
    monkeypatch.setattr(stdio_bridge, "_handle_control", handler)
    trace=tmp_path/'p1-restore-metadata.jsonl'
    undo=fixture.install_fault(tmp_path,trace,1)
    try:
        result=await stdio_bridge._handle_control({"type":"backup:file:inspect","requestId":"inspect_request_001","path":"private-path-canary"})
        assert result is original_result
        events=[json.loads(line) for line in trace.read_text().splitlines()]
        assert [e['event'] for e in events]==['bootstrap','control_begin','control_result']
        assert events[-1]['envelope_schema']=='reverie.bridge.stdio.control.v4'
        assert events[-1]['backup_schema']=='reverie.full_local_backup.v3'
        assert 'canary' not in trace.read_text()
    finally:
        undo()
    assert stdio_bridge._handle_control is handler


@pytest.mark.asyncio
async def test_backup_control_observation_preserves_error_without_body_leak(tmp_path, monkeypatch):
    from src.bridge import stdio_bridge
    from src.backup_inspection import BackupRestoreError
    failure=BackupRestoreError('private-error-canary',code='BACKUP_UNCONFIRMED_EXPORT')
    async def handler(_message):raise failure
    monkeypatch.setattr(stdio_bridge,'_handle_control',handler)
    trace=tmp_path/'p1-restore-metadata.jsonl'
    undo=fixture.install_fault(tmp_path,trace,1)
    try:
        with pytest.raises(BackupRestoreError) as error:
            await stdio_bridge._handle_control({'type':'backup:file:inspect','requestId':'inspect_error_001','path':'private-path-canary'})
        assert error.value is failure
        events=[json.loads(line) for line in trace.read_text().splitlines()]
        assert events[-1]['event']=='control_handler_error'
        assert events[-1]['code']=='BACKUP_UNCONFIRMED_EXPORT'
        assert 'canary' not in trace.read_text()
    finally:
        undo()
