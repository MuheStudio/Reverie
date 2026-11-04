from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from src.config.settings import _Settings
from src.config.usage_policy import UsagePolicy
from src.conversation_summary.engine import SourceBatch, SourceMessage, SourceSelection, StoredSummary
from src.conversation_summary.runtime import ConversationSummaryRuntime, SummaryCleanupError
from src.persona.identity import PersonaEpochRegistry
from src.persona.persona_card import Persona, default_persona


class FakeStore:
    def __init__(self, token):
        self.source = SourceBatch(
            token.persona_id, "conversation_a",
            (SourceMessage("real_u", "request_one", "user", "旧对话" * 800, 1),
             SourceMessage("real_a", "request_one", "assistant", "明确回答" * 800, 2)),
            "digest", 1, 2,
        )
        self.attempt = None
        self.summaries = []
        self.failures = []
        self.status_override = {}

    def select_source(self, conversation_id):
        assert conversation_id == "conversation_a"
        return SourceSelection(self.source)

    def claim_attempt(self, source, *, now, provenance=None):
        if self.attempt is not None:
            return None
        self.attempt = SimpleNamespace(source=source, started=now, provenance=provenance)
        return self.attempt

    def complete_attempt(self, attempt, text, *, now):
        assert attempt is self.attempt
        self.summaries.append(StoredSummary(
            "summary_one", text, ("real_u", "real_a"), 1, 2, "generated", True
        ))

    def fail_attempt(self, attempt, code, *, now):
        assert attempt is self.attempt
        self.failures.append(code)

    def active_summaries(self, _conversation_id):
        return tuple(self.summaries)

    def status(self, _conversation_id, *, now=None):
        return {
            "status": "failed" if self.failures else "ready" if self.summaries else "not_ready",
            "errorCode": self.failures[-1] if self.failures else None,
            "activeCount": len(self.summaries), "attempt_count": int(self.attempt is not None),
            "pendingBudget": 0, "cooldownRemainingSeconds": 0,
            **self.status_override,
        }


class ControlledAdapter:
    def __init__(self, policy, *, content="旧对话中的明确背景。", suppress_cancel=False):
        self.usage_policy = policy
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        self.content = content
        self.suppress_cancel = suppress_cancel
        self.calls = []

    async def chat(self, messages, **kwargs):
        self.calls.append((messages, kwargs))
        self.started.set()
        while True:
            try:
                await self.release.wait()
                break
            except asyncio.CancelledError:
                if not self.suppress_cancel:
                    raise
        return SimpleNamespace(content=self.content)


def harness(*, grant=True, content="旧对话中的明确背景。", suppress_cancel=False, deadline=20):
    settings = _Settings()
    settings.llm.model = "summary-test-model"
    settings.features.hypa_compression_enabled = True
    policy = UsagePolicy(lambda: settings, save_callback=lambda _settings: None)
    if grant:
        policy.grant("conversation_summary")
    registry = PersonaEpochRegistry()
    persona = default_persona()
    token = registry.activate_initial(persona)
    store = FakeStore(token)
    adapter = ControlledAdapter(policy, content=content, suppress_cancel=suppress_cancel)
    adapter.settings = settings.llm
    runtime = ConversationSummaryRuntime(
        store, adapter, registry=registry, token=token,
        enabled=lambda: settings.features.hypa_compression_enabled,
        llm_settings_provider=lambda: settings.llm,
        deadline_seconds=deadline,
    )
    return runtime, store, adapter, policy, registry, persona, settings


async def finish(runtime):
    if runtime._task is not None:
        await asyncio.gather(runtime._task, return_exceptions=True)


@pytest.mark.asyncio
async def test_new_grant_is_required_before_claim_or_provider_call():
    runtime, store, adapter, *_ = harness(grant=False)
    runtime.on_chat_committed("conversation_a", "request_one")
    await asyncio.sleep(0)
    assert store.attempt is None
    assert adapter.calls == []
    assert runtime.capture_context("conversation_a", "query") == ""
    await runtime.aclose()


@pytest.mark.asyncio
async def test_one_background_call_and_only_later_prompt_can_read_result():
    runtime, store, adapter, *_ = harness()
    runtime.on_chat_committed("conversation_a", "request_one")
    await adapter.started.wait()
    for _ in range(5):
        runtime.on_chat_committed("conversation_a", "request_two")
    assert len(adapter.calls) == 1
    assert runtime.capture_context("conversation_a", "背景") == ""
    adapter.release.set()
    await finish(runtime)
    assert len(store.summaries) == 1
    assert "明确背景" in runtime.capture_context("conversation_a", "背景")
    _, arguments = adapter.calls[0]
    assert arguments["purpose"] == "memory_summary"
    assert arguments["background"] is True
    assert arguments["max_tokens"] == 600
    assert runtime.status("conversation_a")["authorized"] is True
    await runtime.aclose()


@pytest.mark.asyncio
async def test_revocation_discards_even_a_provider_that_suppresses_cancel():
    runtime, store, adapter, policy, *_ = harness(suppress_cancel=True)
    runtime.on_chat_committed("conversation_a", "request_one")
    await adapter.started.wait()
    assert policy.revoke("conversation_summary") == 1
    await finish(runtime)
    policy.grant("conversation_summary")
    adapter.release.set()
    await asyncio.gather(runtime._provider_task, return_exceptions=True)
    assert store.summaries == []
    assert store.failures
    runtime.on_chat_committed("conversation_a", "request_two")
    await finish(runtime)
    assert len(adapter.calls) == 1
    await runtime.aclose()


@pytest.mark.asyncio
async def test_persona_switch_rejects_inflight_output():
    runtime, store, adapter, _policy, registry, persona, _settings = harness()
    runtime.on_chat_committed("conversation_a", "request_one")
    await adapter.started.wait()
    replacement_data = persona.to_dict()
    replacement_data["name"] = "Replacement"
    replacement_data["identity"]["persona_id"] = "replacement_persona"
    replacement_data["identity"]["identity_version"] = 1
    authorization = registry.authorize_update(
        actor="owner", reason="test persona switch", user_confirmed=True
    )
    registry.activate_update(Persona(**replacement_data), authorization)
    adapter.release.set()
    await finish(runtime)
    assert store.summaries == []
    assert runtime.capture_context("conversation_a", "背景") == ""
    await runtime.aclose()


@pytest.mark.asyncio
async def test_timeout_is_bounded_and_never_retries_same_attempt():
    runtime, store, adapter, *_ = harness(suppress_cancel=True, deadline=0.01)
    runtime.on_chat_committed("conversation_a", "request_one")
    await adapter.started.wait()
    await asyncio.wait_for(finish(runtime), timeout=1)
    assert store.failures == ["timeout_unknown"]
    assert runtime.running  # A cancellation-resistant provider keeps the slot.
    runtime.on_chat_committed("conversation_a", "request_two")
    assert len(adapter.calls) == 1
    adapter.release.set()
    await asyncio.gather(runtime._provider_task, return_exceptions=True)
    runtime.on_chat_committed("conversation_a", "request_three")
    await finish(runtime)
    assert len(adapter.calls) == 1
    assert store.summaries == []
    await runtime.aclose()


@pytest.mark.asyncio
@pytest.mark.parametrize("content,code", [(" ", "empty_output"), ("长" * 1001, "oversized_output")])
async def test_invalid_output_is_never_silently_truncated_or_persisted(content, code):
    runtime, store, adapter, *_ = harness(content=content)
    adapter.release.set()
    runtime.on_chat_committed("conversation_a", "request_one")
    await finish(runtime)
    assert store.summaries == []
    assert store.failures == [code]
    await runtime.aclose()


@pytest.mark.asyncio
async def test_cancel_pending_keeps_runtime_available_for_reenable():
    runtime, store, adapter, _policy, _registry, _persona, settings = harness()
    runtime.on_chat_committed("conversation_a", "request_one")
    await adapter.started.wait()
    settings.features.hypa_compression_enabled = False
    await runtime.cancel_pending()
    assert store.summaries == []
    assert not runtime._closed
    settings.features.hypa_compression_enabled = True
    runtime.require_current()
    await runtime.aclose()


@pytest.mark.asyncio
@pytest.mark.parametrize("field,value", [("model", "different-model"), ("temperature", 0.3)])
async def test_model_or_settings_change_rejects_result_and_preserves_provenance(field, value):
    runtime, store, adapter, _policy, _registry, _persona, settings = harness()
    runtime.on_chat_committed("conversation_a", "request_one")
    await adapter.started.wait()
    setattr(settings.llm, field, value)
    adapter.release.set()
    await finish(runtime)
    assert store.summaries == []
    assert store.failures == ["provider_binding_changed"]
    assert store.attempt.provenance["model"] == "summary-test-model"
    assert len(store.attempt.provenance["settings_digest"]) == 64
    assert "api_key" not in store.attempt.provenance
    await runtime.aclose()


@pytest.mark.asyncio
async def test_close_reports_unreaped_provider_and_does_not_claim_success():
    runtime, store, adapter, *_ = harness(suppress_cancel=True)
    runtime.on_chat_committed("conversation_a", "request_one")
    await adapter.started.wait()
    with pytest.raises(SummaryCleanupError, match="cleanup_unconfirmed"):
        await runtime.aclose()
    assert runtime.running
    assert not runtime.cleanup_confirmed
    assert runtime.status("conversation_a")["cleanup_error"] == "provider_cleanup_unconfirmed"
    adapter.release.set()
    await asyncio.gather(runtime._provider_task, return_exceptions=True)
    await finish(runtime)
    await runtime.aclose()
    assert runtime.cleanup_confirmed
    assert store.summaries == []


@pytest.mark.asyncio
async def test_authoritative_model_replacement_blocks_commit_before_adapter_is_updated():
    runtime, store, adapter, _policy, _registry, _persona, settings = harness()
    runtime.on_chat_committed("conversation_a", "request_one")
    await adapter.started.wait()
    previous_adapter_settings = adapter.settings
    settings.llm = settings.llm.model_copy(update={"model": "new-authoritative-model"})
    assert adapter.settings is previous_adapter_settings
    assert adapter.settings.model == "summary-test-model"
    adapter.release.set()
    await finish(runtime)
    assert store.summaries == []
    assert store.failures == ["provider_binding_changed"]
    await runtime.aclose()


@pytest.mark.asyncio
async def test_whole_bridge_settings_replacement_updates_both_enabled_and_model(monkeypatch):
    from src.bridge.ws_bridge import bridge_state
    from src.conversation_summary.runtime import current_runtime_settings

    runtime, store, adapter, _policy, _registry, _persona, original = harness()
    monkeypatch.setattr(bridge_state, "settings", None)
    authority = lambda: current_runtime_settings(original)
    runtime.enabled = lambda: authority().features.hypa_compression_enabled
    runtime.llm_settings_provider = lambda: authority().llm
    runtime.policy = UsagePolicy(authority, save_callback=lambda _settings: None)
    adapter.usage_policy = runtime.policy
    assert current_runtime_settings(original) is original
    runtime.on_chat_committed("conversation_a", "request_one")
    await adapter.started.wait()

    replacement = original.model_copy(deep=True)
    replacement.features.hypa_compression_enabled = False
    replacement.llm.model = "replacement-settings-model"
    monkeypatch.setattr(bridge_state, "settings", replacement)
    assert runtime.status("conversation_a")["status"] == "disabled"
    assert not runtime.enabled()
    assert runtime._provider_snapshot()["model"] == "replacement-settings-model"
    assert adapter.settings.model == "summary-test-model"

    replacement.features.hypa_compression_enabled = True
    assert runtime.enabled()
    adapter.release.set()
    await finish(runtime)
    assert store.summaries == []
    assert store.failures == ["provider_binding_changed"]
    await runtime.aclose()


@pytest.mark.asyncio
@pytest.mark.parametrize("kind,code", [("budget", "budget_denied"), ("local", "local_mode_blocked")])
async def test_runtime_preserves_budget_and_local_mode_error_codes(kind, code, caplog):
    from src.api.budget import ApiBudgetExceeded
    from src.local_mode import LocalModeBlocked

    runtime, store, adapter, *_ = harness()

    async def fail_before_dispatch(*_args, **_kwargs):
        exception = ApiBudgetExceeded if kind == "budget" else LocalModeBlocked
        raise exception("private-provider-error-do-not-log")

    adapter.chat = fail_before_dispatch
    runtime.on_chat_committed("conversation_a", "request_one")
    await finish(runtime)
    assert store.failures == [code]
    status = runtime.status("conversation_a")
    assert status["status"] == "failed"
    assert status["errorCode"] == code
    assert "private-provider-error-do-not-log" not in caplog.text
    await runtime.aclose()


@pytest.mark.parametrize("stored,expected", [
    ({}, "below_threshold"),
    ({"pendingBudget": 2500}, "idle"),
    ({"pendingBudget": 2500, "sourceDiagnostics": ["source_exchange_too_large"]}, "no_source"),
    ({"activeCount": 1}, "ready"),
    ({"activeCount": 1, "cooldownRemainingSeconds": 100}, "cooldown"),
    ({"status": "failed", "errorCode": "budget_denied", "cooldownRemainingSeconds": 100}, "failed"),
    ({"status": "outcome_unknown", "cooldownRemainingSeconds": 100}, "outcome_unknown"),
])
def test_status_explains_actionable_state_without_hiding_failed_attempts(stored, expected):
    runtime, store, *_ = harness()
    store.status_override = stored
    status = runtime.status("conversation_a")
    assert status["status"] == expected
    assert status["errorCode"] == stored.get("errorCode")


@pytest.mark.asyncio
async def test_status_reports_unauthorized_disabled_and_current_background_work():
    runtime, _store, adapter, policy, _registry, _persona, settings = harness(grant=False)
    assert runtime.status("conversation_a")["status"] == "unauthorized"
    settings.features.hypa_compression_enabled = False
    assert runtime.status("conversation_a")["status"] == "disabled"
    settings.features.hypa_compression_enabled = True
    policy.grant("conversation_summary")
    runtime.on_chat_committed("conversation_a", "request_one")
    await adapter.started.wait()
    assert runtime.status("conversation_a")["status"] == "running"
    adapter.release.set()
    await finish(runtime)
    assert runtime.status("conversation_a")["status"] == "ready"
    await runtime.aclose()


def test_context_fails_closed_when_optional_settings_provider_raises():
    runtime, *_ = harness()

    def unavailable_settings():
        raise RuntimeError("private-settings-error-do-not-log")

    runtime.enabled = unavailable_settings
    assert runtime.capture_context("conversation_a", "背景") == ""


@pytest.mark.asyncio
async def test_real_store_runtime_restart_keeps_cooldown_and_source_provenance(tmp_path):
    from src.conversation_summary.store import SummaryStore
    from src.kernel.contracts import CommandEnvelopeV4, PersonaScopeV4
    from src.kernel.storage import KernelStore

    runtime, _fake_store, adapter, _policy, registry, _persona, settings = harness()
    kernel = KernelStore(tmp_path / "kernel.sqlite3")
    store = SummaryStore(kernel, runtime.token)
    runtime.store = store
    now = [1000.0]
    runtime.clock = lambda: now[0]
    scope = PersonaScopeV4(**runtime.token.__dict__)

    def exchange(index):
        request_id = f"runtime_store_request_{index:04}"
        command = CommandEnvelopeV4(
            request_id=request_id, idempotency_key=request_id, command="chat:send",
            persona=scope, payload={"text": "用户" * 350, "conversation_id": "conversation_a"},
        )
        kernel.begin_command(command)
        kernel.commit_chat_exchange(
            command, conversation_id="conversation_a", user_text="用户" * 350,
            assistant_bubbles=["回答" * 350],
        )

    for index in range(14):
        exchange(index)
    adapter.release.set()
    runtime.on_chat_committed("conversation_a", "runtime_store_request_0013")
    await finish(runtime)
    assert len(store.active_summaries("conversation_a")) == 1
    await runtime.aclose()
    restarted = ConversationSummaryRuntime(
        SummaryStore(kernel, runtime.token), adapter, registry=registry, token=runtime.token,
        enabled=lambda: settings.features.hypa_compression_enabled, clock=lambda: now[0],
        llm_settings_provider=lambda: settings.llm,
    )
    for index in range(14, 18):
        exchange(index)
    restarted.on_chat_committed("conversation_a", "runtime_store_request_0017")
    await finish(restarted)
    assert len(adapter.calls) == 1
    now[0] += 301
    restarted.on_chat_committed("conversation_a", "runtime_store_request_0017")
    await finish(restarted)
    assert len(adapter.calls) == 2
    assert len(store.active_summaries("conversation_a")) == 2
    with kernel.transaction() as connection:
        provenance = connection.execute(
            "SELECT metadata_json FROM conversation_summary_items WHERE origin='generated'"
        ).fetchone()[0]
    assert "summary-test-model" in provenance
    assert "reverie.conversation-summary.v1" in provenance
    await restarted.aclose()
    kernel.close()


@pytest.mark.asyncio
async def test_session_closes_summary_before_shared_adapter():
    from src.chat.session import ChatSession

    closed = []

    async def close_summary():
        closed.append("summary")

    async def close_adapter():
        closed.append("adapter")

    session = ChatSession(
        persona=MagicMock(), adapter=SimpleNamespace(close=close_adapter),
        memory=MagicMock(), emotion=MagicMock(), relationship=MagicMock(),
        conversation_summary=SimpleNamespace(aclose=close_summary),
    )
    await session.close()
    assert closed == ["summary", "adapter"]


def test_delivery_hook_observes_canonical_commit_and_real_message_ids(tmp_path):
    from src.chat.delivery import ChatDeliveryCoordinator
    from src.chat.pending import PendingChatStore
    from src.kernel.storage import KernelStore
    from src.local_mode import LocalModeGate

    kernel = KernelStore(tmp_path / "kernel.sqlite3")
    seen = []

    def committed(conversation_id, request_id):
        assert kernel.command(request_id).state == "committed"
        messages = kernel.messages(conversation_id)
        assert [row["role"] for row in messages] == ["user", "assistant", "assistant"]
        assert all(row["message_id"] for row in messages)
        seen.append(request_id)

    session = SimpleNamespace(conversation_summary=SimpleNamespace(on_chat_committed=committed))
    coordinator = ChatDeliveryCoordinator(
        store=PendingChatStore(tmp_path / "pending.json"),
        get_session=lambda: session, emit=MagicMock(), kernel_store=kernel,
        local_mode_gate=LocalModeGate(),
    )
    item = {"request_id": "summary_hook_request", "persona_id": "persona_a",
            "persona_epoch": 1, "persona_fingerprint": "a" * 64,
            "conversation_id": "conversation_a", "text": "真实用户消息"}
    command = coordinator._kernel_command(item)
    kernel.begin_command(command)
    assert seen == []
    coordinator._commit_kernel_exchange(item, {"clean_messages": ["回答一", "回答二"]})
    assert seen == ["summary_hook_request"]
    kernel.close()
