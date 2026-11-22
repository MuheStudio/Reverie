from __future__ import annotations

import asyncio
import base64
from contextlib import asynccontextmanager, closing
import hashlib
import io
import json
import logging
import os
from pathlib import Path
import random
import sqlite3
from types import SimpleNamespace
from weakref import WeakKeyDictionary, WeakSet

from PIL import Image
import pytest

from src import local_mode, mvp_runtime, notifications, user
from src.api import budget
from src.api.adapter import ChatResponse, LLMAdapter
from src.bridge import ws_bridge
from src.bridge.stdio_bridge import StdioController
from src.bridge.stdio_transport import MAX_FRAME_BYTES, encode_frame
from src.chat.media import MAX_RAW_BYTES, jpeg_data_url
from src.chat.pending import PendingChatStore
from src.config import settings, usage_policy
from src.kernel.contracts import CommandEnvelopeV4, PersonaScopeV4
from src.kernel.modules import ModuleRegistry
from src.kernel.storage import KernelStore
from src.persona import identity, speech_habits
from src.persona.persona_card import default_persona
from src.persona.state_scope import PersonaStateScope
from src.storage import encrypted_sqlite
from src.world import clock


THUMBNAIL_FIXTURE = Path(__file__).resolve().parents[1] / "native-ui/tests/fixtures/chat-image-thumbnail.json"


@pytest.fixture
def desktop(monkeypatch, tmp_path):
    inputs = tmp_path / "inputs"
    inputs.mkdir()
    tmp_path = tmp_path / "workspace"
    for key, value in {
        "DATA_DIR": tmp_path, "CONFIG_FILE": tmp_path / "config.json",
        "WORLD_STATE_DB": tmp_path / "world_state.sqlite3", "PERSONA_DIR": tmp_path / "persona",
        "EMOTION_DIR": tmp_path / "emotion", "MEMORY_DIR": tmp_path / "memory", "RELATIONSHIP_DIR": tmp_path / "relationship",
    }.items():
        monkeypatch.setattr(settings, key, value)
    monkeypatch.setattr(budget, "WORLD_STATE_DB", settings.WORLD_STATE_DB)
    monkeypatch.setattr(user, "USER_DIR", tmp_path / "user")
    monkeypatch.setattr(clock, "WORLD_DIR", tmp_path / "world")
    monkeypatch.setattr(speech_habits, "PERSONA_DIR", settings.PERSONA_DIR)
    monkeypatch.setattr(encrypted_sqlite, "_storage_key", bytearray(os.urandom(32)))
    monkeypatch.setattr(encrypted_sqlite, "_encryption_required", True)
    monkeypatch.setattr(ws_bridge, "bridge_state", ws_bridge.BridgeState())
    monkeypatch.setattr(ws_bridge, "_chat_coordinator", None)
    monkeypatch.setattr(ws_bridge, "_connections", WeakSet())
    monkeypatch.setattr(ws_bridge, "_client_contexts", WeakKeyDictionary())
    monkeypatch.setattr(ws_bridge, "_controller_ws", None)
    monkeypatch.setattr(ws_bridge, "_persona_effect_lock", asyncio.Lock())
    _forbid_plaintext_pending_in_mvp(monkeypatch)
    monkeypatch.setattr(local_mode, "_LOCAL_MODE_GATE", local_mode.LocalModeGate(desktop=False))
    config = settings._Settings(llm=settings.LLMSettings(provider="ollama", model="isolated-preview",
                                                          base_url="http://127.0.0.1:11434/v1"))
    config.chat.reply_delay_min = config.chat.reply_delay_max = 1
    config.features.emotion_system_enabled = False
    monkeypatch.setattr(usage_policy, "_GLOBAL_POLICY", usage_policy.UsagePolicy(lambda: config))
    persona = default_persona()
    epochs = identity.PersonaEpochRegistry()
    token = epochs.activate_initial(persona)
    monkeypatch.setattr(identity, "GLOBAL_PERSONA_EPOCH", epochs)
    state = PersonaStateScope(persona, registry=epochs, base_dir=tmp_path / "personas")
    model_calls = []

    async def provider(_adapter, messages, *_args, **_kwargs):
        model_calls.append(messages)
        return ChatResponse("我看到了。", model="isolated-preview")

    monkeypatch.setattr(LLMAdapter, "_ollama_chat", provider)
    with closing(KernelStore(tmp_path / "runtime/kernel.sqlite3")) as kernel:
        kernel.activate_persona(PersonaScopeV4(persona_id=token.persona_id, epoch=token.epoch, fingerprint=token.fingerprint),
                               identity=persona.identity_envelope.core_identity, identity_version=persona.identity_envelope.version,
                               actor="bootstrap", reason="isolated chat fixture")
        yield SimpleNamespace(root=tmp_path, inputs=inputs, config=config, persona=persona, token=token,
                              state=state, epochs=epochs, kernel=kernel, model_calls=model_calls)


def mount(env):
    return mvp_runtime.MvpDesktopRuntime(
        persona=env.persona, settings=env.config, memory_state=env.state.module("memory"),
        emotion_state=env.state.module("emotion"), relationship_state=env.state.module("relationship"),
        persona_state=env.state, kernel_store=env.kernel, module_registry=ModuleRegistry(env.kernel),
        logger=logging.getLogger(__name__),
    )


@pytest.mark.asyncio
async def test_proactive_creation_failure_leaves_preview_chat_writable(desktop, monkeypatch, caplog):
    def fail(*_args, **_kwargs):
        raise OSError("private proactive payload canary")

    monkeypatch.setattr(mvp_runtime, "ProactiveChat", fail)
    runtime = mount(desktop)
    try:
        runtime.require_writable()
        assert ws_bridge.bridge_state.proactive is None
        assert not ws_bridge.degraded_runtime_blocks(ws_bridge.MsgType.CHAT_SEND)
        assert (await ws_bridge.handle_settings_get({}, object()))["proactive_available"] is False
        result = await runtime._session.send_message("合成测试消息")
        assert "我看到了" in result["reply"]
        assert len(desktop.model_calls) == 1
        assert "Preview proactive capability could not be initialized" in caplog.text
        assert "private proactive payload canary" not in caplog.text
    finally:
        await runtime.close()


@asynccontextmanager
async def mounted(env):
    runtime = mount(env)
    try:
        yield runtime
    finally:
        if ws_bridge._chat_coordinator is not None:
            await ws_bridge._chat_coordinator.shutdown()
        await runtime.close()


class PreviewClient:
    """Exercise strict V4 validation, shared dispatch, and the framed stdio event projection."""

    def __init__(self, monkeypatch, epochs):
        self.epochs = epochs
        self.controller = StdioController()
        self.frames = []
        self.max_frame_bytes = 0

        async def capture(frame):
            self.max_frame_bytes = max(self.max_frame_bytes, len(encode_frame(frame)))
            self.frames.append(frame["frame"])

        monkeypatch.setattr(self.controller, "write", capture)
        ws_bridge._connections.add(self.controller)
        ws_bridge._client_contexts[self.controller] = ws_bridge.BridgeClientContext(
            client_id="preview_image_test", protocol_version=4, authenticated=True, conversation_id="dream-room",
            persona_id=epochs.token().persona_id,
        )
        monkeypatch.setattr(ws_bridge, "_controller_ws", self.controller)

    async def command(self, command, request_id, **payload):
        token = self.epochs.token()
        if command == "chat:send":
            payload["request_id"] = request_id
        envelope = CommandEnvelopeV4(
            request_id=request_id, idempotency_key=request_id, command=command,
            persona=PersonaScopeV4(persona_id=token.persona_id, epoch=token.epoch, fingerprint=token.fingerprint),
            payload=payload,
        )
        frame = {"kind": "renderer_command", "schema": "reverie.command.v4", "envelope": envelope.model_dump()}
        self.max_frame_bytes = max(self.max_frame_bytes, len(encode_frame(frame)))
        await ws_bridge.dispatch_authenticated_message(
            {"type": command, "request_id": request_id, "payload": {
                **envelope.payload, "expected_persona_id": token.persona_id,
                "expected_persona_epoch": token.epoch, "expected_persona_fingerprint": token.fingerprint,
            }},
            self.controller,
        )

    async def send(self, request_id, **attachment):
        coordinator = ws_bridge._get_chat_coordinator()
        coordinator.reply_start_planner = None

        async def skip_presentation_delay(_seconds):
            return None

        coordinator.sleep = skip_presentation_delay
        await self.command("chat:send", request_id, text="[图片]", **attachment)
        await asyncio.wait_for(coordinator.tasks[request_id], timeout=8)
        assert coordinator.store.get_item(request_id)["state"] == "done"

    def result(self, request_id, event_type):
        matches = [frame["payload"] for frame in self.frames
                   if frame.get("request_id") == request_id and frame["type"] == event_type]
        assert len(matches) == 1
        return matches[0]

    async def history(self, request_id):
        await self.command("chat:history", request_id, conversation_id="dream-room")
        return self.result(request_id, "chat:history:result")["items"]

    async def thumbnail(self, request_id, media_id):
        await self.command("chat:media", request_id, media_id=media_id, thumbnail=True)
        return self.result(request_id, "chat:media:result")


def selected_image(env, name, *, color=(21, 94, 173), image_format="PNG"):
    target = env.inputs / name
    Image.new("RGB", (8, 8), color).save(target, format=image_format)
    return target


def image_links(kernel):
    with kernel.transaction() as connection:
        return [dict(row) for row in connection.execute(
            """SELECT image.media_id, image.jpeg, message.request_id, message.persona_id
               FROM preview_chat_images image JOIN preview_chat_image_links link USING(media_id)
               JOIN messages message ON message.message_id = link.message_id
               ORDER BY message.request_id""",
        ).fetchall()]


def message_media(history):
    return {item["request_id"]: item["media"] for item in history if item["role"] == "user"}


def assert_no_plaintext_images(root):
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        assert path.suffix.lower() not in {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"}
        with path.open("rb") as file:
            header = file.read(12)
        assert not header.startswith((b"\xff\xd8\xff", b"\x89PNG\r\n\x1a\n", b"GIF87a", b"GIF89a"))
        assert header[:4] != b"RIFF" or header[8:] != b"WEBP"
    assert not (root / "chat-media").exists()


@pytest.mark.asyncio
async def test_preview_image_is_encrypted_deduplicated_and_survives_restart(desktop, monkeypatch, caplog):
    caplog.set_level(logging.INFO)
    original = selected_image(desktop, "private-picked-image-canary.png")
    original_bytes = original.read_bytes()
    pasted = "data:image/png;base64," + base64.b64encode(original_bytes).decode("ascii")
    async with mounted(desktop):
        client = PreviewClient(monkeypatch, desktop.epochs)
        await client.send("preview_image_first", image_path=str(original))
        await client.send("preview_image_second", image_data_url=pasted)
        links = image_links(desktop.kernel)
        with desktop.kernel.transaction() as connection:
            assert connection.execute("SELECT COUNT(*) FROM preview_chat_images").fetchone()[0] == 1
            assert connection.execute("SELECT COUNT(*) FROM chat_media").fetchone()[0] == 0
        assert len(links) == 2
        jpeg = links[0]["jpeg"]
        media_id = hashlib.sha256(jpeg).hexdigest()
        assert [link["media_id"] for link in links] == [media_id, media_id]
        assert len(desktop.model_calls) == 2
        for messages in desktop.model_calls:
            assert messages[-1]["content"][-1] == {"type": "image_url", "image_url": {"url": jpeg_data_url(jpeg)}}

    images, persisted = _encrypted_pending_images(desktop.kernel)
    assert len(images) == 2
    for entry in images:
        assert {key: value for key, value in entry.items() if key.startswith("image_")} == {"image_media_id": media_id}
    assert str(original) not in persisted and pasted not in persisted and jpeg_data_url(jpeg) not in persisted
    assert original.read_bytes() == original_bytes
    assert_no_plaintext_images(desktop.root)

    with closing(sqlite3.connect(f"{desktop.kernel.path.as_uri()}?mode=ro", uri=True)) as unkeyed:
        with pytest.raises(sqlite3.DatabaseError, match="file is not a database"):
            unkeyed.execute("SELECT jpeg FROM preview_chat_images").fetchone()
    assert jpeg not in desktop.kernel.path.read_bytes()

    with closing(KernelStore(desktop.kernel.path)) as reopened:
        restarted = SimpleNamespace(**{**vars(desktop), "kernel": reopened})
        async with mounted(restarted):
            client = PreviewClient(monkeypatch, desktop.epochs)
            history = message_media(await client.history("preview_image_history"))
            assert set(history) == {"preview_image_first", "preview_image_second"}
            assert all(records == [{"media_id": media_id, "request_id": request_id,
                                    "mime": "image/jpeg", "bytes": len(jpeg)}] for request_id, records in history.items())
            payload = await client.thumbnail("preview_image_thumbnail", media_id)
            assert payload == json.loads(THUMBNAIL_FIXTURE.read_text())["frame"]["payload"]

    for secret in (str(original), original.name, pasted, jpeg_data_url(jpeg)):
        assert secret not in caplog.text


@pytest.mark.asyncio
async def test_preview_thumbnail_frame_is_bounded_for_a_large_photo(desktop, monkeypatch, record_property):
    path = desktop.inputs / "large-photo.jpg"
    Image.frombytes("RGB", (1800, 1700), random.Random(2806).randbytes(1800 * 1700 * 3)).save(path, quality=96)
    assert 2 * 1024 * 1024 < path.stat().st_size <= MAX_RAW_BYTES
    async with mounted(desktop):
        client = PreviewClient(monkeypatch, desktop.epochs)
        await client.send("preview_image_large", image_path=str(path))
        link, = image_links(desktop.kernel)
        with Image.open(io.BytesIO(link["jpeg"])) as model_image:
            assert max(model_image.size) == 1600
        payload = await client.thumbnail("preview_image_large_thumbnail", link["media_id"])
        with Image.open(io.BytesIO(base64.b64decode(payload["data_url"].split(",", 1)[1]))) as thumbnail:
            assert thumbnail.format == "JPEG"
            assert max(thumbnail.size) == 640
        assert client.max_frame_bytes < MAX_FRAME_BYTES
        record_property("preview_chat_image_max_frame_bytes", client.max_frame_bytes)
        print(f"preview_chat_image_max_frame_bytes={client.max_frame_bytes}")
    assert_no_plaintext_images(desktop.root)


@pytest.mark.asyncio
async def test_preview_image_refusals_have_safe_codes_and_no_model_or_storage_side_effects(desktop, monkeypatch, caplog):
    caplog.set_level(logging.INFO)
    unsupported = selected_image(desktop, "private-unsupported.bmp", image_format="BMP")
    oversized = desktop.inputs / "private-too-large.png"
    oversized.write_bytes(b"0" * (MAX_RAW_BYTES + 1))
    unreadable = desktop.inputs / "private-unreadable.png"
    unreadable.write_text("not an image")
    async with mounted(desktop):
        client = PreviewClient(monkeypatch, desktop.epochs)
        for number, (path, code) in enumerate((
            (unsupported, "image_format_unsupported"),
            (oversized, "image_too_large"),
            (unreadable, "image_unreadable"),
        )):
            request_id = f"preview_image_refused_{number}"
            await client.command("chat:send", request_id, text="这段文字保留", image_path=str(path))
            assert client.result(request_id, "error") == {
                "message": "图片没有发出", "code": code, "request_id": request_id, "scope": "chat",
            }
            assert desktop.kernel.command(request_id) is None
            assert str(path) not in caplog.text
            assert path.name not in caplog.text
        assert await client.history("preview_image_empty") == []
        assert image_links(desktop.kernel) == []
        assert not (desktop.root / "runtime/pending_chat.json").exists()
        assert desktop.model_calls == []
    assert_no_plaintext_images(desktop.root)


@pytest.mark.asyncio
async def test_preview_image_model_rejection_retries_once_with_text(desktop, monkeypatch, caplog):
    caplog.set_level(logging.INFO)
    path = selected_image(desktop, "private-vision-fallback.png")

    class RejectImage(RuntimeError):
        status_code = 400

    async def reject_once(_adapter, messages, *_args, **_kwargs):
        desktop.model_calls.append(messages)
        if len(desktop.model_calls) == 1:
            image = messages[-1]["content"][-1]["image_url"]["url"]
            raise RejectImage(f"{path} {image}")
        return ChatResponse("我看到了。", model="isolated-preview")

    monkeypatch.setattr(LLMAdapter, "_ollama_chat", reject_once)
    async with mounted(desktop):
        client = PreviewClient(monkeypatch, desktop.epochs)
        await client.send("preview_image_fallback", image_path=str(path))
        assert len(desktop.model_calls) == 2
        image_turn, text_turn = [messages[-1]["content"] for messages in desktop.model_calls]
        assert image_turn[-1]["type"] == "image_url"
        assert "用户发来了一张图片，但当前模型不支持识图" in text_turn
        assert str(path) not in caplog.text and path.name not in caplog.text
        assert image_turn[-1]["image_url"]["url"] not in caplog.text
        history = await client.history("preview_image_fallback_history")
        assert any(item["role"] == "assistant" and "我看到了" in item["content"] for item in history)
        assert message_media(history)["preview_image_fallback"][0]["media_id"] == image_links(desktop.kernel)[0]["media_id"]


@pytest.mark.asyncio
async def test_preview_image_history_and_thumbnail_stay_with_the_active_persona(desktop, monkeypatch):
    first = selected_image(desktop, "first.png")
    second = selected_image(desktop, "second.png", color=(207, 113, 44))
    async with mounted(desktop) as runtime:
        client = PreviewClient(monkeypatch, desktop.epochs)
        await client.send("preview_image_persona_a", image_path=str(first))
        first_media_id = image_links(desktop.kernel)[0]["media_id"]
        other = default_persona()
        other.identity = {**other.identity, "persona_id": "preview_image_other"}
        authorization = desktop.epochs.authorize_update(actor="owner", reason="isolated image history switch", user_confirmed=True)
        desktop.epochs.activate_update(other, authorization)
        await runtime.remount_persona(other)
        assert await client.history("preview_image_other_empty") == []
        assert (await client.thumbnail("preview_image_other_cannot_read", first_media_id))["error"] == "图片读不到"
        await client.send("preview_image_persona_b", image_path=str(second))
        links = image_links(desktop.kernel)
        assert [link["persona_id"] for link in links] == [desktop.token.persona_id, "preview_image_other"]
        second_media_id = links[1]["media_id"]
        assert second_media_id != first_media_id
        other_history = message_media(await client.history("preview_image_other_history"))
        assert set(other_history) == {"preview_image_persona_b"}
        assert other_history["preview_image_persona_b"][0]["media_id"] == second_media_id
        assert (await client.thumbnail("preview_image_other_reads_own", second_media_id))["mime"] == "image/jpeg"
        switch_back = desktop.epochs.authorize_update(actor="owner", reason="restore isolated image history scope", user_confirmed=True)
        desktop.epochs.activate_update(desktop.persona, switch_back)
        await runtime.remount_persona(desktop.persona)
        history = message_media(await client.history("preview_image_first_history"))
        assert set(history) == {"preview_image_persona_a"}
        assert history["preview_image_persona_a"][0]["media_id"] == first_media_id
        assert (await client.thumbnail("preview_image_first_reads_own", first_media_id))["mime"] == "image/jpeg"


@pytest.fixture
def unavailable_proactive(monkeypatch):
    def fail(*_args, **_kwargs):
        raise OSError("synthetic proactive construction failure")

    monkeypatch.setattr(mvp_runtime, "ProactiveChat", fail)


def seed_pending_proactive(desktop):
    persona = desktop.kernel.active_persona()
    text = "早上好，今天很开心。"
    payload = {
        "proactive_id": "proactive_" + "a3" * 16,
        "created_at_utc": "2026-11-14T08:00:00Z",
        "conversation_id": "dream-room",
        "persona_id": persona.persona_id,
        "persona_epoch": persona.epoch,
        "persona_fingerprint": persona.fingerprint,
        "messages": [text],
        "text": text,
        "trigger": "morning_greeting",
        "emotion_changes": {"joy": 8.0},
        "metadata": {},
        "notify": True,
        "native_notification": True,
        "notification_title": "Reverie",
    }
    assert desktop.kernel.append_proactive_messages(
        proactive_id=payload["proactive_id"], conversation_id=payload["conversation_id"],
        persona=persona, messages=payload["messages"], created_at_utc=payload["created_at_utc"],
        publication_payload=payload,
    )
    assert stored_proactive_publication(desktop)[:3] == (0, 0, 0)
    return payload


def stored_proactive_publication(desktop):
    with desktop.kernel.transaction() as connection:
        row = connection.execute(
            """SELECT effects_claimed, notification_published, broadcast_published, CAST(payload_json AS BLOB)
               FROM proactive_publications""",
        ).fetchone()
    return tuple(row)


async def replay_pending_proactive(desktop, monkeypatch):
    client = PreviewClient(monkeypatch, desktop.epochs)
    stored_payload = stored_proactive_publication(desktop)[3]
    wakes = 0

    async def wake(_seconds):
        nonlocal wakes
        if wakes == 2:
            raise asyncio.CancelledError
        wakes += 1

    await ws_bridge._proactive_broadcast_loop(sleep=wake)
    assert wakes == 2
    publications = [frame for frame in client.frames if frame["type"] == "proactive:message"]
    frame, = publications
    assert stored_proactive_publication(desktop) == (1, 1, 1, stored_payload)
    return frame["payload"]


@pytest.mark.asyncio
async def test_preview_proactive_outbox_replays_safely_when_module_creation_fails(
    desktop, monkeypatch, unavailable_proactive,
):
    expected = seed_pending_proactive(desktop)
    monkeypatch.setattr(notifications, "DATA_DIR", desktop.root)
    async with mounted(desktop):
        assert ws_bridge.bridge_state.preview_proactive is True
        assert ws_bridge.bridge_state.proactive is None
        relationship = ws_bridge.bridge_state.relationship
        before = relationship.to_dict()
        before_persisted = desktop.kernel.read_persona_state_document(
            desktop.token.persona_id, "persona_relationship_state",
        )
        assert await replay_pending_proactive(desktop, monkeypatch) == {
            **expected, "notify": False, "native_notification": False,
        }
        assert relationship.to_dict() == before
        assert desktop.kernel.read_persona_state_document(
            desktop.token.persona_id, "persona_relationship_state",
        ) == before_persisted
        assert not (desktop.root / "notifications").exists()


@pytest.mark.asyncio
async def test_proactive_outbox_without_preview_marker_keeps_default_relationship_effects(
    desktop, monkeypatch, unavailable_proactive,
):
    expected = seed_pending_proactive(desktop)
    monkeypatch.setattr(notifications, "DATA_DIR", desktop.root)
    async with mounted(desktop):
        monkeypatch.setattr(ws_bridge.bridge_state, "preview_proactive", ws_bridge.BridgeState().preview_proactive)
        assert ws_bridge.bridge_state.proactive is None
        relationship = ws_bridge.bridge_state.relationship
        before = relationship.to_dict()
        assert await replay_pending_proactive(desktop, monkeypatch) == expected
        assert relationship.intimacy == before["intimacy"] + 3
        assert relationship.positive_interactions == before["positive_interactions"] + 1
        assert desktop.kernel.read_persona_state_document(
            desktop.token.persona_id, "persona_relationship_state",
        ) == relationship.to_dict()
        notification, = (desktop.root / "notifications" / "outbox").glob("*.json")
        assert json.loads(notification.read_text(encoding="utf-8"))["id"] == expected["proactive_id"]


@pytest.mark.asyncio
async def test_preview_proactive_feature_settings_stay_staged_when_module_is_unavailable(
    desktop, monkeypatch, unavailable_proactive,
):
    update = {"section": "features", "proactive_chat_enabled": True}

    def fail(_candidate):
        raise OSError("synthetic settings write failure")

    async with mounted(desktop):
        before = desktop.config.features.model_dump()
        with monkeypatch.context() as patch:
            patch.setattr(settings, "write_settings_file", fail)
            rejected = await ws_bridge.handle_settings_update(update, None)
            assert rejected["ok"] is False
            assert desktop.config.features.model_dump() == before
        saved = await ws_bridge.handle_settings_update(update, None)
        assert saved["ok"] is True and saved["features"]["proactive_chat_enabled"] is True
        config = json.loads((desktop.root / "config.json").read_text(encoding="utf-8"))
        assert config["features"]["proactive_chat_enabled"] is True
        snapshot = await ws_bridge.handle_settings_get({}, None)
        assert snapshot["features"]["proactive_chat_enabled"] is True
        assert snapshot["proactive_available"] is False


@pytest.mark.asyncio
async def test_preview_personality_settings_apply_when_proactive_module_is_unavailable(
    desktop, unavailable_proactive,
):
    async with mounted(desktop):
        update = {"section": "personality", "proactive_daily_limit": 4, "emotion_carryover_days": 5}
        saved = await ws_bridge.handle_settings_update(update, None)
        assert saved["ok"] is True
        assert saved["features"]["proactive_daily_limit"] == 4
        assert saved["emotionRuntime"]["carryover_days"] == 5
        assert ws_bridge.bridge_state.emotion.carryover_days == 5
        config = json.loads((desktop.root / "config.json").read_text(encoding="utf-8"))
        assert config["features"]["proactive_daily_limit"] == 4
        assert config["features"]["emotion_carryover_days"] == 5
        assert ws_bridge.bridge_state.proactive is None


def _encrypted_pending_images(kernel):
    with kernel.transaction() as connection:
        rows = [row[0] for row in connection.execute("SELECT payload_json FROM preview_pending_chat ORDER BY rowid")]
    return [json.loads(row) for row in rows], "\n".join(rows)


def _forbid_plaintext_pending_in_mvp(monkeypatch):
    def reject(_store):
        pytest.fail("MVP attempted to construct the file-backed pending chat ledger")

    monkeypatch.setattr(ws_bridge, "_pending_chat_store", None)
    monkeypatch.setattr(PendingChatStore, "_load", reject)
