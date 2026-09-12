"""Bridge-level tests for the video:download handler gate + chat video attach."""

import asyncio
import json

from src.bridge import ws_bridge

MsgType = ws_bridge.MsgType


class DummyWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict] = []

    async def send(self, message: str) -> None:
        self.sent.append(json.loads(message))


def _authenticate(ws) -> None:
    # Register an authenticated client context the handlers require.
    ctx = ws_bridge.BridgeClientContext(
        client_id="test-client",
        protocol_version=4,
        authenticated=True,
        conversation_id="dream-room",
        persona_id="p",
    )
    ws_bridge._client_contexts[ws] = ctx


def _make_settings(enabled: bool, ack: bool):
    from src.config.settings import _Settings

    settings = _Settings()
    settings.features.video_download_disclaimer_acknowledged = ack
    # video_download_enabled has a fail-closed validator dependency, but the
    # test drives the field directly to exercise the handler's own recheck.
    settings.features.video_download_enabled = enabled and ack
    return settings


def test_video_download_refused_without_consent(monkeypatch):
    ws = DummyWebSocket()
    _authenticate(ws)
    monkeypatch.setattr(ws_bridge.bridge_state, "settings", _make_settings(False, False))

    result = asyncio.run(
        ws_bridge.handle_video_download(
            {"source_url": "https://example.com/v.m3u8", "request_id": "r1"}, ws
        )
    )
    assert result is not None
    assert result["ok"] is False
    assert "未开启" in result["error"] or "免责" in result["error"]


def test_video_download_refused_when_ack_but_disabled(monkeypatch):
    ws = DummyWebSocket()
    _authenticate(ws)
    # Acknowledged but feature toggled off: still refused.
    monkeypatch.setattr(ws_bridge.bridge_state, "settings", _make_settings(False, True))

    result = asyncio.run(
        ws_bridge.handle_video_download(
            {"source_url": "https://example.com/v.m3u8", "request_id": "r2"}, ws
        )
    )
    assert result["ok"] is False


def test_video_download_requires_authentication(monkeypatch):
    ws = DummyWebSocket()  # not authenticated
    monkeypatch.setattr(ws_bridge.bridge_state, "settings", _make_settings(True, True))
    result = asyncio.run(
        ws_bridge.handle_video_download(
            {"source_url": "https://example.com/v.m3u8", "request_id": "r3"}, ws
        )
    )
    assert result is not None
    assert "authentication" in result.get("error", "")


def test_video_download_result_type_registered():
    # Contract wiring: the request maps to its result event.
    assert ws_bridge.RESPONSE_TYPE_BY_REQUEST.get(MsgType.VIDEO_DOWNLOAD) == (
        MsgType.VIDEO_DOWNLOAD_RESULT
    )


def test_chat_send_rejects_bad_video_media_id(monkeypatch):
    """A chat:send with a malformed video id is refused before acceptance."""
    ws = DummyWebSocket()
    _authenticate(ws)
    monkeypatch.setattr(ws_bridge.bridge_state, "settings", _make_settings(True, True))
    monkeypatch.setattr(ws_bridge.bridge_state, "persona_restart_required", False, raising=False)

    # A non-existent (but well-formed) sha256 id: video_info raises -> refused.
    fake_id = "a" * 64
    result = asyncio.run(
        ws_bridge.handle_chat_send(
            {"text": "watch this", "video_media_id": fake_id, "request_id": "c1"}, ws
        )
    )
    assert result is not None
    assert result.get("scope") == "chat"
    assert "视频" in result.get("error", "")
