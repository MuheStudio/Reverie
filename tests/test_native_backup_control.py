from __future__ import annotations

import io
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from src.bridge import ws_bridge


def _control_frame(control_type: str, **payload: object) -> str:
    return json.dumps(
        {
            "schema": "reverie.bridge.control.v1",
            "type": control_type,
            "requestId": "native_control_request_01",
            **payload,
        }
    )


def _single_ack(output: str) -> dict:
    lines = [
        line
        for line in output.splitlines()
        if line.startswith("REVERIE_BRIDGE_CONTROL ")
    ]
    assert len(lines) == 1
    return json.loads(lines[0].removeprefix("REVERIE_BRIDGE_CONTROL "))


@pytest.mark.asyncio
async def test_native_export_uses_private_absolute_path_and_acks_after_write(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    destination = (tmp_path / "reverie.reverie-backup.json").resolve()
    calls: list[Path] = []

    class Manager:
        def backup_to_file(self, target: Path) -> None:
            calls.append(target)
            target.write_text('{"schema":"test"}', encoding="utf-8")

    monkeypatch.setenv("REVERIE_BRIDGE_MODE", "1")
    monkeypatch.setattr(ws_bridge, "_local_backup_manager", lambda: (Manager(), None))
    monkeypatch.setattr(
        ws_bridge.sys,
        "stdin",
        io.StringIO(_control_frame("backup:file:export", path=str(destination)) + "\n"),
    )

    await ws_bridge._bridge_control_loop()

    assert calls == [destination]
    assert destination.exists()
    ack = _single_ack(capsys.readouterr().out)
    assert ack["ok"] is True
    assert ack["operation"] == "export"
    assert "path" not in ack
    assert str(destination) not in json.dumps(ack)


@pytest.mark.asyncio
async def test_native_backup_rejects_renderer_style_relative_paths_before_manager_call(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    called = False

    class Manager:
        def backup_to_file(self, _target: Path) -> None:
            nonlocal called
            called = True

    monkeypatch.setenv("REVERIE_BRIDGE_MODE", "1")
    monkeypatch.setattr(ws_bridge, "_local_backup_manager", lambda: (Manager(), None))
    monkeypatch.setattr(
        ws_bridge.sys,
        "stdin",
        io.StringIO(_control_frame("backup:file:export", path="relative.json") + "\n"),
    )

    await ws_bridge._bridge_control_loop()

    assert called is False
    ack = _single_ack(capsys.readouterr().out)
    assert ack["ok"] is False
    assert ack["type"] == "backup:file:export"


@pytest.mark.asyncio
async def test_private_credential_sync_applies_key_without_persisting_or_echoing_it(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    canary = "sk-private-pipe-canary"
    reset_count = 0
    cancel_reasons: list[str] = []

    class Adapter:
        settings = None

        def reset_client(self) -> None:
            nonlocal reset_count
            reset_count += 1

    class Coordinator:
        async def cancel_all(self, *, reason: str) -> list[object]:
            cancel_reasons.append(reason)
            return []

    llm = SimpleNamespace(api_key="")
    monkeypatch.setenv("REVERIE_BRIDGE_MODE", "1")
    monkeypatch.setattr(ws_bridge.bridge_state, "settings", SimpleNamespace(llm=llm))
    monkeypatch.setattr(ws_bridge.bridge_state, "adapter", Adapter())
    monkeypatch.setattr(ws_bridge.bridge_state, "model_epoch", 0)
    monkeypatch.setattr(ws_bridge, "_get_chat_coordinator", lambda: Coordinator())
    monkeypatch.setattr(
        ws_bridge.sys,
        "stdin",
        io.StringIO(
            _control_frame(
                "credentials:set",
                credentials={
                    "llm": {"apiKey": canary},
                    "imageGen": {},
                },
            )
            + "\n"
        ),
    )

    await ws_bridge._bridge_control_loop()

    output = capsys.readouterr().out
    ack = _single_ack(output)
    assert ack["ok"] is True
    assert ack["applied"] == {"llm": True, "imageGen": False}
    assert canary not in output
    assert llm.api_key == canary
    assert reset_count == 1
    assert cancel_reasons == ["credentials_changed"]
