"""Private, read-only summary bodies: scope, source and transport boundaries."""
from __future__ import annotations

import asyncio
from dataclasses import replace
import json
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from pydantic import ValidationError

from src.bridge import ws_bridge
from src.config.settings import _Settings
from src.config.usage_policy import UsagePolicy
from src.conversation_summary.engine import SourceMessage, source_digest, source_document
from src.conversation_summary.runtime import ConversationSummaryRuntime
from src.conversation_summary.store import SummaryStorageError, SummaryStore
from src.kernel.contracts import COMMAND_NAMES, MUTATING_COMMAND_NAMES, SummaryGetPayload
from src.kernel.storage import KernelStore
from src.local_mode import LocalModeGate
from src.persona.identity import PersonaEpochRegistry, StalePersonaEpoch
from src.persona.persona_card import Persona, default_persona
from tests.test_conversation_summary_store import exchange, fill


BODY = "  合成正文 😀\n<script>plain text only</script>\n尾部  "
ABSENT_ID = "summary_" + "0" * 32


class Controller:
    def __init__(self):
        self.sent = []

    async def send(self, serialized):
        self.sent.append(json.loads(serialized))


@pytest.fixture
def detail_environment(tmp_path, monkeypatch):
    registry = PersonaEpochRegistry()
    persona = default_persona()
    token = registry.activate_initial(persona)
    kernel = KernelStore(tmp_path / "summary-detail-synthetic.sqlite3")
    store = SummaryStore(kernel, token)
    fill(kernel, persona=token.persona_id, conversation="dream-room")
    source = store.select_source("dream-room").source
    saved = store.complete_attempt(store.claim_attempt(source, now=1000), BODY, now=1001)
    settings = _Settings()
    policy = UsagePolicy(lambda: settings, save_callback=lambda _: None)
    adapter = SimpleNamespace(settings=settings.llm, usage_policy=policy,
                              chat=MagicMock(side_effect=AssertionError("unexpected model call")))
    runtime = ConversationSummaryRuntime(
        store, adapter, registry=registry, token=token,
        enabled=lambda: settings.features.hypa_compression_enabled,
    )
    state = ws_bridge.BridgeState()
    state.session = SimpleNamespace(conversation_summary=runtime)
    state.kernel_store = kernel
    controller = Controller()

    def scope():
        current = registry.token()
        return {"persona_id": current.persona_id, "persona_epoch": current.epoch,
                "persona_fingerprint": current.fingerprint}

    monkeypatch.setattr(ws_bridge, "bridge_state", state)
    monkeypatch.setattr(ws_bridge, "_active_persona_scope", scope)
    monkeypatch.setattr(ws_bridge, "_controller_ws", controller)
    monkeypatch.setattr(ws_bridge, "_client_contexts", {
        controller: ws_bridge.BridgeClientContext("summary_detail_controller", 4, True),
    })
    monkeypatch.setattr(ws_bridge, "_persona_effect_lock", asyncio.Lock())
    yield SimpleNamespace(kernel=kernel, store=store, source=source, saved=saved,
                          settings=settings, policy=policy, adapter=adapter, runtime=runtime,
                          registry=registry, token=token, persona=persona,
                          state=state, controller=controller, scope=scope)
    kernel.close()


def detail_message(environment, **changes):
    return {"type": "summary:get", "request_id": "summary_detail_request_01", "payload": {
        "summary_id": environment.saved.id,
        "expected_persona_id": environment.scope()["persona_id"],
        "expected_persona_epoch": environment.scope()["persona_epoch"],
        "expected_persona_fingerprint": environment.scope()["persona_fingerprint"],
        **changes,
    }}


def switch_persona(environment, *, same_persona=False):
    data = environment.persona.to_dict()
    data["name"] = "Replacement synthetic persona"
    data["identity"]["identity_version"] = int(data["identity"].get("identity_version", 1)) + 1
    if not same_persona:
        data["identity"]["persona_id"] = "other_summary_persona"
    replacement = Persona(**data)
    return environment.registry.activate_update(replacement, environment.registry.authorize_update(
        actor="owner", reason="synthetic summary detail boundary", user_confirmed=True,
    ))


def test_summary_get_contract_defaults_and_read_only_registrations():
    assert SummaryGetPayload(summary_id=ABSENT_ID).conversation_id == "dream-room"
    assert "summary:get" in COMMAND_NAMES
    assert "summary:get" not in MUTATING_COMMAND_NAMES
    assert "summary:get" in ws_bridge._PERSONA_SCOPED_COMMANDS
    assert "summary:get" in ws_bridge._RECOVERY_READ_COMMANDS
    assert "summary:get" in ws_bridge._DEGRADED_KERNEL_ALLOWED
    assert "summary:get" in ws_bridge._POST_PERSONA_SWITCH_ALLOWED
    assert ws_bridge.response_type_for_request("summary:get") == "summary:result"
    assert "summary:get" in ws_bridge._handlers


@pytest.mark.parametrize("changes", [
    {"summary_id": "summary_" + "A" * 32}, {"summary_id": "summary_" + "a" * 31},
    {"summary_id": "summary_" + "a" * 33}, {"summary_id": ABSENT_ID + "\n"},
    {"summary_id": 12}, {"summary_id": ABSENT_ID.encode()}, {"summary_id": None},
    {"conversation_id": ""}, {"conversation_id": "x" * 129}, {"conversation_id": 12},
    {"conversation_id": b"dream-room"}, {"path": "/never-read"},
], ids=["uppercase-summary-id", "short-summary-id", "long-summary-id", "trailing-newline",
        "numeric-summary-id", "bytes-summary-id", "missing-summary-id", "empty-conversation",
        "long-conversation", "numeric-conversation", "bytes-conversation", "extra-path"])
def test_summary_get_contract_rejects_malformed_identity_and_extra_input(changes):
    with pytest.raises(ValidationError):
        SummaryGetPayload.model_validate({"summary_id": ABSENT_ID, **changes})


def test_store_detail_uses_targeted_lookup_and_preserves_body(detail_environment, monkeypatch):
    env = detail_environment
    monkeypatch.setattr(env.store, "active_summaries", MagicMock(side_effect=AssertionError("list scan")))
    statements = []
    with env.kernel.transaction() as connection:
        connection.set_trace_callback(statements.append)
    try:
        assert env.store.get_summary("dream-room", env.saved.id) == env.saved
    finally:
        with env.kernel.transaction() as connection:
            connection.set_trace_callback(None)
    queries = [query for query in statements if "SELECT * FROM conversation_summary_items" in query]
    assert len(queries) == 1
    assert "WHERE summary_id=" in queries[0]
    assert "persona_id=" in queries[0] and "conversation_id=" in queries[0]
    assert env.saved.text == BODY


def test_store_detail_isolates_persona_conversation_and_missing_ids(detail_environment):
    env = detail_environment
    other = SummaryStore(env.kernel, replace(env.token, persona_id="other_summary_persona"))
    assert other.get_summary("dream-room", env.saved.id) is None
    assert env.store.get_summary("another-room", env.saved.id) is None
    assert env.store.get_summary("dream-room", ABSENT_ID) is None
    assert env.store.get_summary("dream-room", "summary_invalid") is None
    # Persistent source ownership is persona based; runtime freshness is a
    # separate epoch barrier. Historical rows survive a legitimate remount.
    reopened = SummaryStore(env.kernel, replace(env.token, epoch=99, fingerprint="b" * 64))
    assert reopened.get_summary("dream-room", env.saved.id) == env.saved


@pytest.mark.parametrize("column,value", [
    ("active", 0), ("origin", "legacy"), ("metadata_json", "not-json"),
    ("metadata_json", "null"), ("metadata_json", '{"algorithm_version":"unknown"}'),
    ("metadata_json", '{"algorithm_version":"reverie.conversation-summary.v1","api_key":"secret"}'),
    ("metadata_json", '{"algorithm_version":"reverie.conversation-summary.v1","model":"\\ud800"}'),
    ("source_json", "not-json"), ("source_json", "[]"), ("source_json", "[{}]"),
    ("source_digest", "0" * 64), ("first_sequence", 999), ("last_sequence", 999),
    ("text", "  \n"), ("text", "😀" * 1001), ("text", b"not-unicode-text"),
], ids=["inactive", "legacy", "bad-provenance-json", "null-provenance", "unknown-contract",
        "secret-provenance-field", "invalid-unicode-provenance", "bad-source-json", "empty-source",
        "malformed-source", "digest-mismatch", "first-sequence-mismatch", "last-sequence-mismatch",
        "blank-body", "body-over-1000", "binary-body"])
def test_store_detail_fails_closed_on_inactive_legacy_and_corrupt_records(detail_environment, column, value):
    env = detail_environment
    with env.kernel.transaction() as connection:
        connection.execute(f"UPDATE conversation_summary_items SET {column}=? WHERE summary_id=?", (value, env.saved.id))
    assert env.store.get_summary("dream-room", env.saved.id) is None


@pytest.mark.parametrize("mutation", ["changed", "deleted", "uncommitted", "incomplete"],
                         ids=["changed", "deleted", "uncommitted", "incomplete"])
def test_store_detail_revalidates_canonical_source(detail_environment, mutation):
    env = detail_environment
    with env.kernel.transaction() as connection:
        if mutation == "changed":
            connection.execute("UPDATE messages SET content='changed' WHERE message_id=?", (env.source.messages[0].message_id,))
        elif mutation == "deleted":
            connection.execute("DELETE FROM messages WHERE message_id=?", (env.source.messages[0].message_id,))
        elif mutation == "uncommitted":
            connection.execute("UPDATE command_ledger SET state='failed' WHERE request_id=?", (env.source.messages[0].request_id,))
        else:
            connection.execute("UPDATE command_ledger SET result_json='{}' WHERE request_id=?", (env.source.messages[0].request_id,))
    assert env.store.get_summary("dream-room", env.saved.id) is None


@pytest.mark.parametrize("length,available", [(512, True), (513, False)], ids=["512-codepoints", "513-codepoints"])
def test_store_detail_message_ids_use_unicode_codepoint_bound(detail_environment, length, available):
    env = detail_environment
    first = env.source.messages[0]
    messages = (replace(first, message_id="😀" * length), *env.source.messages[1:])
    digest = source_digest(env.token.persona_id, "dream-room", messages)
    with env.kernel.transaction() as connection:
        connection.execute("UPDATE messages SET message_id=? WHERE message_id=?", (messages[0].message_id, first.message_id))
        connection.execute("UPDATE conversation_summary_items SET source_json=?,source_digest=? WHERE summary_id=?",
                           (json.dumps(source_document(messages)), digest, env.saved.id))
    item = env.store.get_summary("dream-room", env.saved.id)
    assert (item is not None) is available
    if available:
        assert item.source_ids[0] == "😀" * length


def test_store_detail_rejects_oversized_source_without_changing_existing_active_read(detail_environment):
    env = detail_environment
    exchange(env.kernel, 20, persona=env.token.persona_id, conversation="dream-room")
    rows = env.kernel.message_page("dream-room", persona_id=env.token.persona_id, limit=100)["items"]
    messages = tuple(SourceMessage(row["message_id"], row["request_id"], row["role"], row["content"], row["message_sequence"])
                     for row in rows)
    assert len(messages) == 42
    with env.kernel.transaction() as connection:
        connection.execute("""UPDATE conversation_summary_items SET source_json=?,source_digest=?,
                           first_sequence=?,last_sequence=? WHERE summary_id=?""",
                           (json.dumps(source_document(messages)), source_digest(env.token.persona_id, "dream-room", messages),
                            min(m.sequence for m in messages), max(m.sequence for m in messages), env.saved.id))
    assert len(env.store.active_summaries("dream-room")) == 1
    assert env.store.get_summary("dream-room", env.saved.id) is None


def test_store_detail_counts_astral_body_characters_and_preserves_whitespace(detail_environment):
    env = detail_environment
    text = " \n" + "😀" * 996 + "\n "
    assert len(text) == 1000 and len(text.encode("utf-16-le")) // 2 > 1000
    with env.kernel.transaction() as connection:
        connection.execute("UPDATE conversation_summary_items SET text=? WHERE summary_id=?", (text, env.saved.id))
    assert env.store.get_summary("dream-room", env.saved.id).text == text


def test_shared_validation_retains_active_sort_and_source_exception_behavior(detail_environment):
    env = detail_environment
    for index in range(20, 35):
        exchange(env.kernel, index, persona=env.token.persona_id, conversation="dream-room")
    source = env.store.select_source("dream-room").source
    later = env.store.complete_attempt(env.store.claim_attempt(source, now=1301), "later", now=1302)
    assert env.store.active_summaries("dream-room") == (later, env.saved)
    assert env.store.get_summary("dream-room", later.id) == later
    with env.kernel.transaction() as connection:
        connection.execute("UPDATE conversation_summary_items SET source_json='not-json' WHERE summary_id=?", (later.id,))
    assert env.store.get_summary("dream-room", later.id) is None
    with pytest.raises(SummaryStorageError, match="summary_corrupt_source"):
        env.store.active_summaries("dream-room")


@pytest.mark.parametrize("authenticated,same_controller", [(False, True), (False, False), (True, False)],
                         ids=["unauthenticated-controller", "unauthenticated-observer", "authenticated-observer"])
@pytest.mark.asyncio
async def test_detail_requires_controller_before_payload_or_runtime_touch(detail_environment, monkeypatch, authenticated, same_controller):
    env = detail_environment
    endpoint = env.controller if same_controller else Controller()
    ws_bridge._client_contexts[endpoint] = ws_bridge.BridgeClientContext("summary_observer", 4, authenticated)
    lookup = MagicMock(side_effect=AssertionError("runtime resolved before permission"))
    monkeypatch.setattr(ws_bridge, "_summary_runtime", lookup)
    with pytest.raises(PermissionError, match="authenticated controller required"):
        await ws_bridge.handle_summary_get({"summary_id": "invalid"}, endpoint)
    lookup.assert_not_called()


@pytest.mark.asyncio
async def test_detail_revalidates_direct_payload_before_runtime_lookup(detail_environment, monkeypatch):
    lookup = MagicMock(side_effect=AssertionError("invalid payload reached runtime"))
    monkeypatch.setattr(ws_bridge, "_summary_runtime", lookup)
    with pytest.raises(ValidationError):
        await ws_bridge.handle_summary_get({"summary_id": ABSENT_ID, "path": "/never-read"}, detail_environment.controller)
    lookup.assert_not_called()


@pytest.mark.asyncio
async def test_detail_success_returns_exact_body_and_identity_without_status_body_leak(detail_environment):
    env = detail_environment
    result = await ws_bridge.dispatch_authenticated_message(detail_message(env), env.controller)
    assert result == {"ok": True, "operation": "detail", "conversation_id": "dream-room", "summary": {
        "summary_id": env.saved.id, "text": BODY, "sourceDigest": env.saved.source_digest,
        "firstSequence": env.saved.source_first_sequence, "lastSequence": env.saved.source_last_sequence,
        "messageIds": list(env.saved.source_ids), "contractVersion": env.saved.contract_version,
    }, **env.scope()}
    assert env.controller.sent[-1]["type"] == "summary:result"
    assert env.controller.sent[-1]["request_id"] == "summary_detail_request_01"
    status = await ws_bridge.handle_summary_status({}, env.controller)
    assert status["operation"] == "status"
    assert status["summaries"][0]["summary_id"] == env.saved.id
    assert "text" not in status["summaries"][0]
    encoded_status = json.dumps(status, ensure_ascii=False)
    assert "合成正文" not in encoded_status and "plain text only" not in encoded_status
    assert env.saved.text == BODY


@pytest.mark.parametrize("unavailable", ["missing", "conversation", "persona", "inactive", "legacy", "corrupt", "runtime"],
                         ids=["missing", "conversation", "persona", "inactive", "legacy", "corrupt", "runtime"])
@pytest.mark.asyncio
async def test_detail_unavailable_is_generic_and_body_free(detail_environment, unavailable):
    env = detail_environment
    summary_id = ABSENT_ID if unavailable == "missing" else env.saved.id
    if unavailable == "conversation":
        mutation = ("conversation_id", "another-room")
    elif unavailable == "persona":
        mutation = ("persona_id", "another-persona")
    else:
        mutation = {"inactive": ("active", 0), "legacy": ("origin", "legacy"),
                    "corrupt": ("source_json", "not-json")}.get(unavailable)
    if mutation:
        with env.kernel.transaction() as connection:
            connection.execute(f"UPDATE conversation_summary_items SET {mutation[0]}=? WHERE summary_id=?", (mutation[1], env.saved.id))
    if unavailable == "runtime":
        env.state.session = None
    result = await ws_bridge.handle_summary_get({"summary_id": summary_id}, env.controller)
    assert result == {"ok": False, "operation": "detail", "conversation_id": "dream-room",
                      "code": "summary_unavailable", "error": "Conversation summary is unavailable", **env.scope()}
    assert "summary" not in result and "text" not in result
    assert BODY not in json.dumps(result, ensure_ascii=False)


@pytest.mark.parametrize("closed", [False, True], ids=["stale-runtime", "closed-runtime"])
def test_runtime_detail_rejects_stale_or_closed_runtime_before_store_touch(detail_environment, monkeypatch, closed):
    env = detail_environment
    lookup = MagicMock(side_effect=AssertionError("stale runtime touched store"))
    monkeypatch.setattr(env.store, "get_summary", lookup)
    if closed:
        env.runtime._closed = True
    else:
        switch_persona(env)
    with pytest.raises(StalePersonaEpoch):
        env.runtime.detail("dream-room", env.saved.id)
    lookup.assert_not_called()


def test_runtime_detail_rechecks_epoch_at_registry_read_barrier(detail_environment, monkeypatch):
    env = detail_environment
    original = env.runtime.require_current

    def switch_after_check():
        original()
        switch_persona(env)

    monkeypatch.setattr(env.runtime, "require_current", switch_after_check)
    lookup = MagicMock(side_effect=AssertionError("epoch changed before lookup"))
    monkeypatch.setattr(env.store, "get_summary", lookup)
    with pytest.raises(StalePersonaEpoch):
        env.runtime.detail("dream-room", env.saved.id)
    lookup.assert_not_called()


def test_current_runtime_can_read_same_persona_history_from_previous_generation(detail_environment):
    env = detail_environment
    current = switch_persona(env, same_persona=True)
    remounted = ConversationSummaryRuntime(
        SummaryStore(env.kernel, current), env.adapter, registry=env.registry,
        token=current, enabled=lambda: False,
    )
    assert remounted.detail("dream-room", env.saved.id) == env.saved
    with pytest.raises(StalePersonaEpoch):
        env.runtime.detail("dream-room", env.saved.id)


@pytest.mark.parametrize("recovery_state", ["clean", "recovering", "recovery_required"],
                         ids=["clean", "recovering", "recovery_required"])
@pytest.mark.asyncio
async def test_detail_is_local_read_without_consent_or_provider_effects(detail_environment, monkeypatch, recovery_state):
    env = detail_environment
    import src.local_mode as local_mode

    local_gate = LocalModeGate(desktop=True)
    local_gate.set(True, session_id="summary_detail_local_pause", epoch=1)
    monkeypatch.setattr(local_mode, "get_local_mode_gate", lambda: local_gate)
    env.state.recovery_state = recovery_state
    env.state.runtime_unavailable = ["optional-module"]
    env.state.persona_restart_required = True
    assert not env.settings.features.hypa_compression_enabled
    assert not env.policy.allowed("conversation_summary")

    def forbidden(*_args, **_kwargs):
        raise AssertionError("local body read consulted model authorization or generation")

    monkeypatch.setattr(env.runtime, "enabled", forbidden)
    monkeypatch.setattr(env.runtime, "llm_settings_provider", forbidden)
    monkeypatch.setattr(env.policy, "allowed", forbidden)
    monkeypatch.setattr(env.store, "claim_attempt", forbidden)
    monkeypatch.setattr(env.store, "select_source", forbidden)

    def database_snapshot():
        with env.kernel.transaction() as connection:
            return {table: [tuple(row) for row in connection.execute(f"SELECT * FROM {table}")]
                    for table in ("command_ledger", "messages", "conversation_summary_attempts", "conversation_summary_items")}

    before = database_snapshot()
    result = await ws_bridge.dispatch_authenticated_message(detail_message(env), env.controller)
    assert result["ok"] is True and result["summary"]["text"] == BODY
    assert database_snapshot() == before
    env.adapter.chat.assert_not_called()
    assert not env.runtime.running and env.runtime._task is None and env.runtime._provider_task is None
