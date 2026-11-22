"""Request-only failure metadata; no changes to delivery or storage semantics."""
from __future__ import annotations

import asyncio
import json

import pytest

from src.api.adapter import LLMAdapter, ProviderRequestError
from src.chat.delivery import ChatDeliveryCoordinator
from src.chat.pending import PendingChatStore
from src.chat.session import ProviderCallFailed
from src.config.settings import LLMSettings
from src.local_mode import LocalModeGate
from tests.test_chat_delivery_v2 import CLIENT, EventSink, payload
from tests.test_provider_probe import _openai_server
from tests.test_requirements_81_110 import _session


def provider_failure(code="PROVIDER_UNAUTHORIZED", status=401):
    return ProviderCallFailed(ProviderRequestError(
        code, retryable=False, outcome_unknown=False, status_code=status,
    ))


def test_provider_call_failed_preserves_cause_and_original_contract():
    error = provider_failure()
    assert error.cause_code == "PROVIDER_UNAUTHORIZED"
    assert error.code == "PROVIDER_OUTCOME_UNKNOWN"
    assert error.status_code == 401
    assert error.cause_type == "ProviderRequestError"
    assert str(error) == (
        "错误码 PROVIDER_UNAUTHORIZED，HTTP 401；供应商拒绝了凭据，请检查 API 密钥。"
        "供应商请求未完成；为避免重复计费，Reverie 不会自动重试。"
    )


@pytest.mark.parametrize("cause", [None, RuntimeError("ordinary failure"), TimeoutError("timeout")])
def test_non_provider_causes_have_no_cause_code(cause):
    error = ProviderCallFailed(cause)
    assert error.cause_code is None
    assert error.code == "PROVIDER_OUTCOME_UNKNOWN"
    assert error.status_code is None


def test_non_provider_code_attribute_is_not_promoted():
    class OtherError(RuntimeError):
        code = "PROVIDER_UNAUTHORIZED"
        status_code = 401

    error = ProviderCallFailed(OtherError("ordinary feature marker"))
    assert error.cause_code is None
    assert error.status_code == 401  # Existing status field is intentionally unchanged.
    assert "ordinary feature marker" in str(error)


class FailingSession:
    def __init__(self, error):
        self.error = error
        self.calls = 0

    async def send_message(self, text, *, status_delay_applied=False,
                           defer_side_effects=False, request_id=""):
        assert status_delay_applied and defer_side_effects and request_id
        self.calls += 1
        raise self.error


class KernelSpy:
    def __init__(self):
        self.failures = []
        self.dispatched = []

    def begin_command(self, command):
        pass

    def append_user_message(self, **kwargs):
        return True

    def mark_provider_dispatched(self, request_id):
        self.dispatched.append(request_id)

    def fail_command(self, request_id, *, error_code, provider_outcome_unknown):
        self.failures.append((request_id, error_code, provider_outcome_unknown))


async def drive_failure(tmp_path, error, expected_code, expected_http, *, before_dispatch=False):
    session, sink, kernel = FailingSession(error), EventSink(), KernelSpy()
    store = PendingChatStore(tmp_path / "pending.json")
    coordinator = ChatDeliveryCoordinator(store=store, get_session=lambda: session,
        emit=sink.emit, scope_is_current=lambda _item: True,
        local_mode_gate=LocalModeGate(desktop=False), kernel_store=kernel)
    if before_dispatch:
        async def fail_before_dispatch(_request_id):
            raise error
        coordinator._wait_for_due = fail_before_dispatch
    request_id = "failure_reason_request"
    request = payload(request_id)
    request["persona_fingerprint"] = "a" * 64
    try:
        await coordinator.accept(request, client_id=CLIENT)
        await asyncio.wait_for(coordinator.tasks[request_id], timeout=5)
        state = "failed" if before_dispatch else "failed_uncertain"
        frames = [body for _, kind, body in sink.events if kind == "chat:state" and body["state"] == state]
        assert len(frames) == 1
        terminal = frames[0]
        assert terminal["failure_code"] == expected_code
        assert terminal["http_status"] == expected_http
        assert terminal["request_id"] == request_id
        assert terminal["label"] == ("回复失败" if before_dispatch else "供应商结果未知，未自动重试")
        assert terminal["error"] == str(error)
        assert terminal["provider_may_have_been_called"] is (not before_dispatch)
        assert session.calls == (0 if before_dispatch else 1)
        assert kernel.dispatched == ([] if before_dispatch else [request_id])
        assert kernel.failures == [(request_id, type(error).__name__, not before_dispatch)]
        saved = json.loads(store.path.read_text())
        assert saved["version"] == 2 and saved["storage_policy"] == "local-first"
        persisted = next(item for item in saved["items"] if item["request_id"] == request_id)
        assert persisted["state"] == state and persisted["error"] == str(error)
        assert "failure_code" not in persisted and "http_status" not in persisted
        restored = PendingChatStore(store.path).get_item(request_id)
        expected_restored_error = str(error) if before_dispatch else "provider outcome unknown after restart; request not retried"
        assert restored["state"] == state and restored["error"] == expected_restored_error
        assert "failure_code" not in restored and "http_status" not in restored
        # Reconnect/status projection uses the durable legacy record alone.
        projection = coordinator._state_payload(restored)
        assert "failure_code" not in projection and "http_status" not in projection
    finally:
        await coordinator.shutdown()


@pytest.mark.parametrize(("code", "status", "expected_code", "expected_http"), [
    ("PROVIDER_UNAUTHORIZED", 401, "PROVIDER_UNAUTHORIZED", 401),
    ("PROVIDER_RATE_LIMITED", 429, "PROVIDER_RATE_LIMITED", 429),
    ("PROVIDER_REJECTED", 500, "PROVIDER_REJECTED", 500),
    ("PROVIDER_" + "A" * 48, 100, "PROVIDER_" + "A" * 48, 100),
    ("PROVIDER_TIMEOUT", 599, "PROVIDER_TIMEOUT", 599),
    ("provider_timeout", 401, None, 401),
    ("PROVIDER_" + "A" * 49, 401, None, 401),
    ("PROVIDER_", 401, None, 401),
    ("PROVIDER_TIMEOUT\n", 401, None, 401),
    (123, 401, None, 401),
    (None, None, None, None),
    ("PROVIDER_TIMEOUT", 99, "PROVIDER_TIMEOUT", None),
    ("PROVIDER_TIMEOUT", 600, "PROVIDER_TIMEOUT", None),
    ("PROVIDER_TIMEOUT", True, "PROVIDER_TIMEOUT", None),
    ("PROVIDER_TIMEOUT", "401", "PROVIDER_TIMEOUT", None),
    ("PROVIDER_TIMEOUT", 401.0, "PROVIDER_TIMEOUT", None),
])
@pytest.mark.asyncio
async def test_failure_metadata_is_bounded_request_only_and_never_retries(tmp_path, code, status, expected_code, expected_http):
    error = provider_failure()
    error.cause_code, error.status_code = code, status
    await drive_failure(tmp_path, error, expected_code, expected_http)


@pytest.mark.asyncio
async def test_plain_exception_text_cannot_supply_failure_metadata(tmp_path):
    await drive_failure(tmp_path, RuntimeError("PRIVATE_CANARY PROVIDER_UNAUTHORIZED HTTP 401"), None, None)


@pytest.mark.asyncio
async def test_failure_before_dispatch_keeps_the_existing_definite_state_and_ledger_arguments(tmp_path):
    await drive_failure(tmp_path, provider_failure(), "PROVIDER_UNAUTHORIZED", 401, before_dispatch=True)


@pytest.mark.parametrize(("status", "code", "unknown"), [
    (401, "PROVIDER_UNAUTHORIZED", False),
    (429, "PROVIDER_RATE_LIMITED", False),
    (500, "PROVIDER_REJECTED", True),
])
@pytest.mark.asyncio
async def test_real_http_adapter_preserves_failure_through_chat_session(tmp_path, status, code, unknown):
    server, port, requests = await _openai_server(status)
    adapter = LLMAdapter(LLMSettings(provider="ollama", model="local-probe",
        base_url=f"http://127.0.0.1:{port}/v1", api_key="synthetic-loopback-key"),
        local_mode_gate=LocalModeGate(desktop=False), resolve_settings=False)
    session = _session(tmp_path, adapter)
    try:
        with pytest.raises(ProviderCallFailed) as caught:
            await session.send_message("这是本机失败原因测试", status_delay_applied=True, defer_side_effects=True)
        error = caught.value
        assert error.cause_code == code and error.status_code == status
        assert error.code == "PROVIDER_OUTCOME_UNKNOWN"
        assert isinstance(error.__cause__, ProviderRequestError)
        assert error.__cause__.outcome_unknown is unknown
        assert "private vendor detail" not in str(error)
        assert len(requests) == 1
        assert requests[0][0].startswith("POST /v1/chat/completions ")
        assert json.loads(requests[0][1])["messages"][-1]["role"] == "user"
        assert session._history == []
    finally:
        await adapter.close()
        server.close()
        await server.wait_closed()
