from __future__ import annotations

import asyncio
from contextlib import contextmanager
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import logging
import os
from pathlib import Path
from queue import Empty, Queue
import secrets
import subprocess
import sys
from tempfile import TemporaryFile
from threading import Event, Thread
import time
from types import SimpleNamespace

import pytest

from src import mvp_runtime
from src.backup import BackupRestoreError
from src.bridge import ws_bridge
from src.bridge.stdio_transport import read_frame, write_frame
from src.config import settings as config
from src.config.usage_policy import UsagePolicy
from src.diary import DiaryManager
from src.kernel.storage import KernelStore
from src.persona import identity
from src.persona.persona_card import Persona, default_persona
from src.persona.state_scope import PersonaModuleState
from src.storage import encrypted_sqlite
from tests.p1_restore_support import Graph


TODAY = "2026-11-10"
PRIVATE_MARKER = "合成日记正文中的隐私标记"
DIARY_TEXT = f"合成日记\n\n{PRIVATE_MARKER}，此刻的心情很平静，也想好好留住这份感受。"
VERIFIED = '{"consistent": true, "unsupported_claims": []}'
PURPOSES = ["diary_generation", "diary_consistency"]
ROOT = Path(__file__).resolve().parents[1]


class DiaryProvider:
    def __init__(self, policy):
        self.usage_policy = policy
        self.purposes = []
        self.fail = False
        self.verification = VERIFIED
        self.started = None
        self.release = None

    async def chat(self, _messages, *, purpose, background, **_options):
        assert background
        self.purposes.append(purpose)
        if purpose == "diary_consistency":
            return SimpleNamespace(content=self.verification)
        if self.started is not None:
            self.started.set()
            await self.release.wait()
        if self.fail:
            raise RuntimeError("synthetic provider failure")
        return SimpleNamespace(content=DIARY_TEXT)


@pytest.fixture
def diary_runtime(tmp_path, monkeypatch):
    settings = config._Settings(llm=config.LLMSettings(
        provider="ollama", model="synthetic-diary", base_url="http://127.0.0.1:11434/v1",
    ))
    policy = UsagePolicy(lambda: settings)
    adapter = DiaryProvider(policy)
    diary = DiaryManager(default_persona(), adapter, diary_dir=tmp_path / "diary")
    monkeypatch.setattr(diary, "today", lambda: TODAY)
    bridge = ws_bridge.BridgeState()
    bridge.diary = diary
    bridge.settings = settings
    bridge.adapter = adapter
    monkeypatch.setattr(ws_bridge, "bridge_state", bridge)
    return SimpleNamespace(settings=settings, policy=policy, adapter=adapter, diary=diary, bridge=bridge)


def _enable(runtime):
    runtime.settings.features.diary_enabled = True
    runtime.policy.grant("diary_generation")


def test_preview_read_returns_content_and_fixed_date_errors(diary_runtime):
    diary = diary_runtime.diary
    entry = diary.save_manual_entry(date_str=TODAY, title="合成标题", content=DIARY_TEXT)

    async def exercise():
        async def read(date):
            return await ws_bridge.handle_diary_request({"action": "read", "date": date}, None)

        assert await read(TODAY) == {"ok": True, "entry": entry.to_dict()}
        assert (await read("2026-11-09"))["code"] == "diary_not_found"
        assert (await read("2026-02-30"))["code"] == "diary_invalid_date"
        assert (await read("../outside"))["code"] == "diary_invalid_date"
        result = await ws_bridge.handle_diary_request({}, None)
        assert result["today"] == TODAY and result["writing"] is False
        assert [row["date"] for row in result["entries"]] == [TODAY]
        assert PRIVATE_MARKER not in json.dumps(result, ensure_ascii=False)

    asyncio.run(exercise())


def test_mounted_diary_key_keeps_its_original_read_path(diary_runtime):
    calls = []

    def locked_read(date, **kwargs):
        calls.append((date, kwargs))
        raise PermissionError("这页日记现在仍然锁着")

    diary_runtime.bridge.diary_keys = SimpleNamespace(read=locked_read)
    diary_runtime.bridge.session = SimpleNamespace(scheduler=SimpleNamespace(status="online"))
    diary_runtime.bridge.work_manager = SimpleNamespace(late_night_active=True)
    result = asyncio.run(ws_bridge.handle_diary_request({"action": "read", "date": TODAY}, None))
    assert result == {"ok": False, "error": "这页日记现在仍然锁着"}
    assert calls == [(TODAY, {"status": "online", "late_night_active": True})]


def test_manual_write_is_encrypted_and_refuses_to_overwrite(diary_runtime):
    runtime = diary_runtime
    _enable(runtime)

    async def exercise():
        assert await ws_bridge.handle_diary_request({}, None) == {"entries": [], "today": TODAY, "writing": False}
        assert list(runtime.diary.diary_dir.iterdir()) == []
        first = await ws_bridge.handle_diary_write({}, None)
        assert first["ok"] and first["entry"]["consistency_status"] == "verified"
        saved = runtime.diary.diary_dir / f"{TODAY}.json"
        raw = saved.read_bytes()
        assert PRIVATE_MARKER.encode() not in raw
        assert json.loads(raw)["crypto"]["method"] == "ChaCha20Poly1305"
        assert (runtime.diary.diary_dir / "keys" / "diary_key.json").is_file()
        duplicate = await ws_bridge.handle_diary_write({}, None)
        assert duplicate["code"] == "diary_already_exists"
        assert saved.read_bytes() == raw
        reopened = DiaryManager(default_persona(), diary_dir=runtime.diary.diary_dir)
        assert reopened.load_entry(TODAY).to_dict() == first["entry"]
        assert runtime.adapter.purposes == PURPOSES

    asyncio.run(exercise())


@pytest.mark.parametrize("reason", ["off", "not-granted", "changed-provider", "provider-failure"])
def test_manual_write_rejects_without_persisting(diary_runtime, reason):
    runtime = diary_runtime
    if reason != "not-granted":
        _enable(runtime)
    else:
        runtime.settings.features.diary_enabled = True
    if reason == "off":
        runtime.settings.features.diary_enabled = False
    if reason == "changed-provider":
        runtime.settings.llm.base_url = "http://127.0.0.1:11435/v1"
    runtime.adapter.fail = reason == "provider-failure"
    result = asyncio.run(ws_bridge.handle_diary_write({}, None))
    assert result["ok"] is False
    assert result["code"] == ("diary_write_failed" if runtime.adapter.fail else "diary_not_allowed")
    assert runtime.adapter.purposes == (["diary_generation"] if runtime.adapter.fail else [])
    assert list(runtime.diary.diary_dir.iterdir()) == []
    assert not runtime.diary.is_writing(TODAY)


def test_manual_write_refuses_a_day_claimed_by_the_automatic_writer(diary_runtime):
    runtime = diary_runtime
    _enable(runtime)

    async def exercise():
        runtime.adapter.started = asyncio.Event()
        runtime.adapter.release = asyncio.Event()
        automatic = asyncio.create_task(runtime.diary.write_daily_entry_once(TODAY, trigger="daily_auto"))
        try:
            await asyncio.wait_for(runtime.adapter.started.wait(), timeout=2)
            assert (await ws_bridge.handle_diary_request({}, None))["writing"] is True
            result = await ws_bridge.handle_diary_write({}, None)
            assert result["ok"] is False and result["code"] == "diary_writing"
            assert runtime.adapter.purposes == ["diary_generation"]
            assert list(runtime.diary.diary_dir.iterdir()) == []
        finally:
            runtime.adapter.release.set()
            await automatic
        assert runtime.adapter.purposes == PURPOSES
        assert (await ws_bridge.handle_diary_request({}, None))["writing"] is False
        assert runtime.diary.list_entries() == [TODAY]

    asyncio.run(exercise())


def test_grounded_fallback_never_logs_a_verifier_quote(diary_runtime, caplog):
    _enable(diary_runtime)
    diary_runtime.adapter.verification = json.dumps({"consistent": False, "unsupported_claims": [PRIVATE_MARKER]})
    with caplog.at_level(logging.DEBUG, logger="reverie.diary"):
        result = asyncio.run(ws_bridge.handle_diary_write({}, None))
    assert result["ok"] and result["entry"]["consistency_status"] == "grounded_fallback"
    assert diary_runtime.diary.load_entry(TODAY).consistency_status == "grounded_fallback"
    assert f"{TODAY} (1 unsupported claims)" in caplog.text
    assert PRIVATE_MARKER not in caplog.text
    assert diary_runtime.adapter.purposes == PURPOSES


def test_scoped_write_in_flight_is_discarded_after_identity_changes(diary_runtime, monkeypatch):
    runtime = diary_runtime
    _enable(runtime)
    registry = identity.PersonaEpochRegistry()
    token = registry.activate_initial(runtime.diary.persona)
    monkeypatch.setattr(identity, "GLOBAL_PERSONA_EPOCH", registry)
    runtime.diary._state_scope = PersonaModuleState("diary", runtime.diary.diary_dir, token, registry, "new")

    desktop = mvp_runtime.MvpDesktopRuntime.__new__(mvp_runtime.MvpDesktopRuntime)
    desktop._tasks = []
    monkeypatch.setattr(mvp_runtime, "_ACTIVE_DESKTOP_RUNTIME", desktop)

    class Endpoint:
        def __init__(self):
            self.sent = []

        async def send(self, raw):
            self.sent.append(raw)

    endpoint = Endpoint()
    context = ws_bridge.BridgeClientContext(client_id="diary-test", protocol_version=4, authenticated=True)
    monkeypatch.setattr(ws_bridge, "_client_contexts", {endpoint: context})
    monkeypatch.setattr(ws_bridge, "_persona_effect_lock", asyncio.Lock())

    async def exercise():
        runtime.adapter.started = asyncio.Event()
        runtime.adapter.release = asyncio.Event()
        scope = {f"expected_{name}": value for name, value in ws_bridge._active_persona_scope().items()}
        await ws_bridge.dispatch_authenticated_message({
            "type": "diary:write", "request_id": "diary_scoped_write", "payload": scope,
        }, endpoint)
        writer, = desktop._tasks
        try:
            await asyncio.wait_for(runtime.adapter.started.wait(), timeout=2)
            async with ws_bridge._persona_effect_lock:
                data = runtime.diary.persona.to_dict()
                data["name"] = "合成替换人格"
                data["identity"]["persona_id"] = "synthetic-replacement"
                data["identity"]["identity_version"] = 1
                authorization = registry.authorize_update(actor="owner", reason="synthetic switch", user_confirmed=True)
                registry.activate_update(Persona(**data), authorization)
        finally:
            runtime.adapter.release.set()
            await writer
        assert endpoint.sent == []
        assert runtime.adapter.purposes == ["diary_generation"]
        assert list(runtime.diary.diary_dir.iterdir()) == []

    asyncio.run(exercise())


@pytest.fixture
def east_eight(monkeypatch):
    with monkeypatch.context() as scoped:
        scoped.setenv("TZ", "Asia/Shanghai")
        time.tzset()
        yield
    time.tzset()


def _messages(store, persona_id, *timestamps):
    for stamp in timestamps:
        assert store.append_user_message(
            request_id=f"{persona_id}_{stamp}", conversation_id=f"day_{persona_id}",
            persona_id=persona_id, text="合成用户消息", created_at_utc=stamp,
        )


def _tick(monkeypatch, runtime, store):
    delays = []

    async def one_tick(delay):
        delays.append(delay)
        if len(delays) > 1:
            raise asyncio.CancelledError

    with monkeypatch.context() as scoped:
        scoped.setattr(mvp_runtime, "asyncio", SimpleNamespace(sleep=one_tick, CancelledError=asyncio.CancelledError))
        asyncio.run(mvp_runtime._diary_maintenance_loop(runtime.diary, runtime.settings, store, logging.getLogger("diary.test")))
    assert delays == [1800, 1800]


def test_automatic_writer_counts_only_current_persona_with_local_midnights(diary_runtime, tmp_path, monkeypatch, east_eight):
    runtime = diary_runtime
    persona_id = runtime.diary.persona.seal_identity().persona_id
    store = KernelStore(tmp_path / "kernel.sqlite3")
    try:
        _messages(store, persona_id,
                  "2026-11-09T15:59:59.999999+00:00",  # previous local day
                  "2026-11-09T16:30:00+00:00", "2026-11-09T23:59:00+00:00",  # 00:30 and 07:59 local
                  "2026-11-10T00:30:00+00:00", "2026-11-10T01:30:00+00:00", "2026-11-10T02:30:00+00:00",
                  "2026-11-10T16:00:00.000000+00:00")  # following local day
        _messages(store, "other-persona", *(f"2026-11-10T0{index}:45:00+00:00" for index in range(6)))
        assert store.count_persona_user_messages_on_local_date(persona_id, TODAY) == 5
        assert store.count_persona_user_messages_on_local_date("other-persona", TODAY) == 6
        _enable(runtime)
        _tick(monkeypatch, runtime, store)
        assert runtime.adapter.purposes == []

        _messages(store, persona_id, "2026-11-09T16:00:00Z")  # exactly local midnight counts
        assert store.count_persona_user_messages_on_local_date(persona_id, TODAY) == 6
        runtime.settings.features.diary_enabled = False
        _tick(monkeypatch, runtime, store)
        assert runtime.adapter.purposes == []
        runtime.settings.features.diary_enabled = True
        runtime.policy.revoke("diary_generation")
        _tick(monkeypatch, runtime, store)
        assert runtime.adapter.purposes == []
        assert list(runtime.diary.diary_dir.iterdir()) == []

        runtime.policy.grant("diary_generation")
        _tick(monkeypatch, runtime, store)
        assert runtime.adapter.purposes == PURPOSES
        assert runtime.diary.list_entries() == [TODAY]
        _tick(monkeypatch, runtime, store)
        assert runtime.adapter.purposes == PURPOSES
    finally:
        store.close()


@pytest.mark.parametrize("original", [False, True])
def test_failed_switch_persistence_preserves_live_read_and_billing_gate(
    diary_runtime, tmp_path, monkeypatch, east_eight, original,
):
    runtime = diary_runtime
    runtime.settings.features.diary_enabled = original
    runtime.policy.grant("diary_generation")
    settings_file = tmp_path / "config.json"
    monkeypatch.setattr(config, "CONFIG_FILE", settings_file)
    config.write_settings_file(runtime.settings)
    before = settings_file.read_bytes()

    def fail(_staged):
        raise OSError("synthetic settings write failure")

    monkeypatch.setattr(config, "write_settings_file", fail)
    features = runtime.settings.features
    payload = {"section": "features", "diary_enabled": not original,
               "expected_persona_id": "persona", "expected_persona_epoch": 1,
               "expected_persona_fingerprint": "f" * 64}
    assert asyncio.run(ws_bridge.handle_settings_update(payload, None))["ok"] is False
    assert runtime.settings.features is features and features.diary_enabled is original
    assert asyncio.run(ws_bridge.handle_settings_get({}, None))["features"]["diary_enabled"] is original
    assert runtime.policy.allowed("diary_generation") is original
    assert settings_file.read_bytes() == before

    store = KernelStore(tmp_path / "kernel.sqlite3")
    try:
        persona_id = runtime.diary.persona.seal_identity().persona_id
        _messages(store, persona_id, *(f"2026-11-10T0{index}:00:00+00:00" for index in range(6)))
        _tick(monkeypatch, runtime, store)
        assert runtime.adapter.purposes == (PURPOSES if original else [])
    finally:
        store.close()


def test_successful_switch_persists_before_changing_the_live_flag(diary_runtime, tmp_path, monkeypatch):
    runtime = diary_runtime
    path = tmp_path / "config.json"
    monkeypatch.setattr(config, "CONFIG_FILE", path)
    features = runtime.settings.features
    write = config.write_settings_file

    def observe(staged):
        assert features.diary_enabled is False and staged.features.diary_enabled is True
        write(staged)

    monkeypatch.setattr(config, "write_settings_file", observe)
    result = asyncio.run(ws_bridge.handle_settings_update({"section": "features", "diary_enabled": True}, None))
    assert result["ok"] and result["features"]["diary_enabled"]
    assert runtime.settings.features is features and features.diary_enabled
    assert json.loads(path.read_bytes())["features"]["diary_enabled"] is True


@pytest.fixture
def diary_backup(tmp_path, monkeypatch):
    monkeypatch.setattr(encrypted_sqlite, "_storage_key", bytearray(os.urandom(32)))
    monkeypatch.setattr(encrypted_sqlite, "_encryption_required", True)
    source = Graph(tmp_path / "backup-source", desktop_extras=True)
    try:
        target = Graph(tmp_path / "backup-target", desktop_extras=True)
        try:
            source.seed("after")
            backup = tmp_path / "synthetic-backup.json"
            source.manager.backup_to_file(backup)
            yield source, target, backup
        finally:
            target.close()
    finally:
        source.close()


@pytest.mark.parametrize("suffix", [".json", ".json.bak"], ids=["primary", "backup-only"])
def test_restore_refuses_existing_diary_files_with_a_missing_key(diary_backup, suffix):
    source, target, backup = diary_backup
    directory = target.diary.diary_dir
    diary_date, = source.diary.list_entries()
    encrypted_entry = (source.diary.diary_dir / f"{diary_date}.json").read_bytes()
    (directory / f"{diary_date}{suffix}").write_bytes(encrypted_entry)

    def files():
        return {path.relative_to(directory): path.read_bytes() for path in directory.rglob("*") if path.is_file()}

    before = files()
    # The full restore must reject this before writing an intent. Direct diary
    # replacement independently keeps the same protection for a replay.
    with pytest.raises(ValueError, match="existing encryption key"):
        target.manager.restore_from_file(backup)
    assert files() == before and not (directory / "keys").exists()
    assert target.manager.recovery_state == "clean" and target.journal.pending_restore() is None
    with pytest.raises(ValueError, match="existing encryption key"):
        target.diary.replace_all(source.diary.export_all())
    assert files() == before and not (directory / "keys").exists()


def test_full_restore_preserves_an_existing_diary_key_byte_for_byte(diary_backup):
    _source, target, backup = diary_backup
    target.seed("before")
    key_file = target.diary.diary_dir / "keys" / "diary_key.json"
    before = key_file.read_bytes()
    result = target.manager.restore_from_file(backup)
    assert result["outcome"] == "committed"
    target.assert_fixture("after", target_marker=result["operation_id"])
    key_unchanged = key_file.read_bytes() == before
    assert key_unchanged, "restoring replaced the existing synthetic diary key"


def test_fresh_diary_restore_rolls_back_after_later_participant_failure(diary_backup, monkeypatch):
    source, target, backup = diary_backup
    key_file = target.diary.diary_dir / "keys" / "diary_key.json"
    assert target.diary.list_entries() == [] and not key_file.exists()
    before = target.manager._snapshot()
    before_marker = target.memory.store.catalog.metadata_get("full_restore_marker")
    apply_social = target.social.replace_all
    observed = []

    def fail_once(payload):
        observed.append((target.diary.list_entries(), key_file.is_file()))
        if len(observed) == 1:
            raise OSError("synthetic failure after the diary participant")
        return apply_social(payload)

    monkeypatch.setattr(target.social, "replace_all", fail_once)
    with pytest.raises(BackupRestoreError) as error:
        target.manager.restore_from_file(backup)
    assert error.value.code == "BACKUP_ROLLED_BACK"
    assert len(observed) == 2 and observed[0] == (source.diary.list_entries(), True)
    assert observed[1][0] == []
    assert target.manager.recovery_state == "clean" and target.journal.pending_restore() is None
    assert target.manager._snapshot() == before
    assert target.memory.store.catalog.metadata_get("full_restore_marker") == before_marker
    assert target.diary.list_entries() == []

    settings = config._Settings(features=config.FeatureSettings(diary_enabled=True))
    policy = UsagePolicy(lambda: settings)
    policy.grant("diary_generation")
    adapter = DiaryProvider(policy)
    target.diary.adapter = adapter
    target.diary.usage_policy = policy
    entry = asyncio.run(target.diary.write_daily_entry_once(TODAY, trigger="user_request"))
    assert target.diary.list_entries() == [TODAY]
    assert target.diary.load_entry(TODAY) == entry
    assert adapter.purposes == PURPOSES


@contextmanager
def _local_provider():
    calls = []
    generation_started = Event()
    release_generation = Event()

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            system = request["messages"][0]["content"]
            if "日记事实一致性核验器" in system:
                calls.append("diary_consistency")
                content = json.dumps({"consistent": False, "unsupported_claims": [PRIVATE_MARKER]})
            elif "private diary" in system:
                calls.append("diary_generation")
                generation_started.set()
                if not release_generation.wait(timeout=15):
                    self.send_error(504)
                    return
                content = DIARY_TEXT
            else:
                calls.append("unexpected")
                self.send_error(400)
                return
            response = json.dumps({
                "id": "synthetic-diary-completion", "object": "chat.completion",
                "created": 1, "model": "synthetic-diary",
                "choices": [{"index": 0, "message": {"role": "assistant", "content": content}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 16, "completion_tokens": 8, "total_tokens": 24},
            }).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(response)))
            self.end_headers()
            self.wfile.write(response)

        def log_message(self, _format, *_args):
            pass

    with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            yield SimpleNamespace(
                endpoint=f"http://127.0.0.1:{server.server_port}/v1", calls=calls,
                started=generation_started, release=release_generation,
            )
        finally:
            release_generation.set()
            server.shutdown()
            thread.join(timeout=5)


class DesktopPipe:
    def __init__(self, process):
        self.process = process
        self.frames = Queue()
        self.sequence = 0
        self.reader = Thread(target=self._read, daemon=True)
        self.reader.start()
        ready = self._receive(lambda frame: frame.get("kind") == "ready")
        assert ready["schema"] == "reverie.bridge.stdio.ready.v4" and ready["runtimeWritable"] is True
        self.persona = {"persona_id": ready["personaId"], "epoch": ready["personaEpoch"],
                        "fingerprint": ready["personaFingerprint"]}

    def _read(self):
        try:
            while (frame := read_frame(self.process.stdout)) is not None:
                self.frames.put(frame)
        except (OSError, ValueError) as exc:
            self.frames.put(type(exc).__name__)
        finally:
            self.frames.put(None)

    def _receive(self, matches):
        deadline = time.monotonic() + 30
        try:
            while True:
                frame = self.frames.get(timeout=max(0, deadline - time.monotonic()))
                assert isinstance(frame, dict), f"stdio closed before the expected receipt ({frame})"
                assert frame.get("kind") != "fatal_error", frame.get("code")
                if matches(frame):
                    return frame
        except Empty:
            pytest.fail("timed out waiting for an isolated stdio receipt")

    def _request_id(self):
        self.sequence += 1
        return f"diary_test_{self.sequence:04}"

    def send(self, command, payload=None, *, persona=None):
        request_id = self._request_id()
        write_frame(self.process.stdin, {
            "kind": "renderer_command", "schema": "reverie.command.v4",
            "envelope": {"protocol_version": 4, "request_id": request_id, "idempotency_key": request_id,
                         "command": command, "payload": payload or {}, "persona": persona or self.persona},
        })
        return request_id

    def receipt(self, request_id):
        outer = self._receive(lambda frame: frame.get("kind") == "event"
                              and frame["frame"].get("request_id") == request_id)
        frame = outer["frame"]
        assert frame["type"] != "error", frame["payload"].get("code")
        return frame["payload"]

    def command(self, command, payload=None, **options):
        return self.receipt(self.send(command, payload, **options))

    def control(self, operation, **fields):
        request_id = self._request_id()
        write_frame(self.process.stdin, {
            "kind": "control", "schema": "reverie.bridge.stdio.control.v4",
            "type": operation, "requestId": request_id, **fields,
        })
        return self._receive(lambda frame: frame.get("kind") == "control_result"
                             and frame.get("requestId") == request_id)


@contextmanager
def _desktop(root, key, endpoint):
    data = root / "data"
    scratch = root / "tmp"
    cache = root / "cache"
    for directory in (data, scratch, cache):
        directory.mkdir(parents=True, exist_ok=True)
    settings_path = data / "config.json"
    if not settings_path.exists():
        settings_path.write_text(json.dumps({
            "llm": {"provider": "ollama", "model": "synthetic-diary", "base_url": endpoint},
            "ui": {"mode": "mvp", "experience_mode": "core", "onboarding_completed": True},
        }), encoding="utf-8")
    environment = {name: os.environ[name] for name in ("HOME", "USER", "LOGNAME", "LANG", "PATH") if name in os.environ}
    environment.update({
        "PYTHON_DOTENV_DISABLED": "1", "REVERIE_BRIDGE_MODE": "1",
        "REVERIE_BRIDGE_SECRET": secrets.token_hex(32), "REVERIE_PARENT_PID": str(os.getpid()),
        "REVERIE_DATA_DIR": str(data), "REVERIE_REQUIRE_ENCRYPTED_STORAGE": "1",
        "REVERIE_LOCAL_MODE": "0", "REVERIE_LOCAL_MODE_SESSION_ID": "diary_test",
        "TMPDIR": str(scratch), "TMP": str(scratch), "TEMP": str(scratch),
        "XDG_CACHE_HOME": str(cache), "HF_HOME": str(cache / "hf"),
        "HF_HUB_CACHE": str(cache / "hf" / "hub"), "TRANSFORMERS_CACHE": str(cache / "hf" / "transformers"),
        "TORCH_HOME": str(cache / "torch"), "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1",
    })
    key_read, key_write = os.pipe()
    try:
        os.write(key_write, key)
    finally:
        os.close(key_write)
    with TemporaryFile() as stderr:
        try:
            environment["REVERIE_STORAGE_KEY_FD"] = str(key_read)
            process = subprocess.Popen(
                [sys.executable, "-I", "-B", "-X", "utf8", str(ROOT / "src" / "main.py"), "--stdio-bridge"],
                cwd=ROOT, env=environment, pass_fds=(key_read,),
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=stderr,
            )
        finally:
            os.close(key_read)
        succeeded = False
        try:
            yield DesktopPipe(process)
            succeeded = True
        finally:
            process.stdin.close()
            try:
                process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
                raise
            finally:
                process.stdout.close()
            stderr.seek(0)
            output = stderr.read()
            assert PRIVATE_MARKER.encode() not in output, "diary body appeared in the runtime log"
            if succeeded:
                assert process.returncode == 0, f"isolated runtime exited {process.returncode}"


def test_real_stdio_diary_write_budget_restart_and_full_backup(tmp_path):
    original = tmp_path / "original"
    restored = tmp_path / "restored"
    backup = tmp_path / "synthetic-backup.json"
    key = os.urandom(32)
    with _local_provider() as model:
        with _desktop(original, key, model.endpoint) as pipe:
            assert pipe.command("settings:get")["features"]["diary_enabled"] is False
            assert pipe.command("settings:update", {"section": "features", "diary_enabled": True})["features"]["diary_enabled"] is True
            grant = pipe.command("ai_usage:get")["features"]["diary_generation"]
            assert grant["effective"] is False
            grant = pipe.command("ai_usage:grant", {
                "feature": "diary_generation", "consent_digest": grant["consent_digest"],
                "api_cost_acknowledged": True, "user_confirmed": True,
            })["features"]["diary_generation"]
            assert grant["effective"] is True
            before_chat = pipe.command("chat:history")["items"]
            before_memory = pipe.command("memory:list")["memories"]
            assert pipe.command("diary:write", persona={**pipe.persona, "epoch": pipe.persona["epoch"] + 1})["code"] == "stale_persona"

            write = pipe.send("diary:write")
            try:
                assert model.started.wait(timeout=10)
                during = pipe.command("diary:request")
                assert during["entries"] == [] and during["writing"] is True
                assert pipe.command("diary:write")["code"] == "diary_writing"
                assert model.calls == ["diary_generation"]
            finally:
                model.release.set()
            receipt = pipe.receipt(write)
            assert receipt["ok"] and receipt["entry"]["consistency_status"] == "grounded_fallback"
            entry = receipt["entry"]
            today = entry["date"]
            listing = pipe.command("diary:request")
            assert listing["today"] == today and listing["writing"] is False
            assert [row["date"] for row in listing["entries"]] == [today]
            assert pipe.command("diary:request", {"action": "read", "date": today})["entry"] == entry
            assert pipe.command("diary:write")["code"] == "diary_already_exists"
            assert pipe.command("chat:history")["items"] == before_chat
            assert pipe.command("memory:list")["memories"] == before_memory
            budget = pipe.command("api:budget:get")
            assert budget["requests"] == budget["succeeded"] == budget["background"]["requests"] == 2
            assert {row["purpose"]: row["requests"] for row in budget["by_purpose"]} == dict.fromkeys(PURPOSES, 1)
            assert budget["prompt_tokens"] == 32 and budget["completion_tokens"] == 16
            assert pipe.control("backup:file:export", path=str(backup))["export_consistency"] == "confirmed"
            namespace = hashlib.sha256(pipe.persona["persona_id"].encode()).hexdigest()
            diary_path = original / "data" / "personas" / namespace / "diary"
            assert (diary_path / "keys" / "diary_key.json").is_file()
            encrypted = json.loads((diary_path / f"{today}.json").read_bytes())
            assert encrypted["encrypted"] is True and "content" not in encrypted

        with _desktop(original, key, model.endpoint) as pipe:
            assert pipe.command("settings:get")["features"]["diary_enabled"] is True
            assert pipe.command("diary:request", {"action": "read", "date": today})["entry"] == entry

        restored_key = os.urandom(32)
        with _desktop(restored, restored_key, model.endpoint) as pipe:
            assert pipe.command("diary:request")["entries"] == []
            restored_diary = restored / "data" / "personas" / namespace / "diary"
            assert not (restored_diary / "keys").exists()
            result = pipe.control("backup:file:import", path=str(backup), mode="normal")
            assert result["ok"] and result["outcome"] == "committed", result.get("code")
            assert pipe.command("diary:request")["entries"] == listing["entries"]
            assert pipe.command("diary:request", {"action": "read", "date": today})["entry"] == entry
            assert (restored_diary / "keys" / "diary_key.json").is_file()
            restored_record = json.loads((restored_diary / f"{today}.json").read_bytes())
            assert restored_record["encrypted"] is True and "content" not in restored_record

        with _desktop(restored, restored_key, model.endpoint) as pipe:
            assert pipe.command("diary:request")["entries"] == listing["entries"]
            assert pipe.command("diary:request", {"action": "read", "date": today})["entry"] == entry
        assert model.calls == PURPOSES
