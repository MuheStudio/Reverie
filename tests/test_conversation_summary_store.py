from __future__ import annotations

from dataclasses import replace
import hashlib
import json
import os

import pytest

from src.conversation_summary.engine import (
    SourceMessage, StoredSummary, build_summary_prompt, estimate_budget,
    render_context, select_source,
)
from src.conversation_summary.legacy import LegacyImportError, parse_legacy
from src.conversation_summary.store import SummaryStorageError, SummaryStore
from src.kernel.contracts import CommandEnvelopeV4, PersonaScopeV4
from src.kernel.storage import KernelStore
from src.persona.identity import PersonaEpochToken
from src.storage.encrypted_sqlite import (
    EncryptedStorageError, SQLITE_HEADER, clear_storage_key_for_testing, install_storage_key,
)


TOKEN = PersonaEpochToken("persona-synthetic", 1, "a" * 64)


@pytest.fixture
def stores(tmp_path):
    kernel = KernelStore(tmp_path / "synthetic.sqlite3")
    yield kernel, SummaryStore(kernel, TOKEN)
    kernel.close()


def exchange(kernel, index, *, persona=TOKEN.persona_id, conversation="conversation-a",
             text="资料" * 150, bubbles=None, commit=True, epoch=1):
    request_id = f"request-{persona}-{conversation}-{index}"
    scope = PersonaScopeV4(persona_id=persona, epoch=epoch, fingerprint="a" * 64)
    command = CommandEnvelopeV4(request_id=request_id, idempotency_key=request_id,
                                command="chat:send", persona=scope, payload={"text": text})
    kernel.begin_command(command)
    kernel.append_user_message(request_id=request_id, conversation_id=conversation,
                               persona_id=persona, text=text)
    if commit:
        kernel.commit_chat_exchange(command, conversation_id=conversation, user_text=text,
                                    assistant_bubbles=bubbles or ["回应" * 150])
    return request_id


def fill(kernel, count=20, **kwargs):
    return [exchange(kernel, i, **kwargs) for i in range(count)]


def pure_exchanges(count=20, *, chars=300, bubble_count=1):
    result = []
    sequence = 1
    for index in range(count):
        messages = []
        for bubble in range(bubble_count + 1):
            messages.append(SourceMessage(f"m{sequence}", f"r{index}",
                                          "user" if bubble == 0 else "assistant", "字" * chars, sequence))
            sequence += 1
        result.append(tuple(messages))
    return result


def test_source_uses_committed_same_scope_real_ids_and_preserves_recent_window(stores):
    kernel, store = stores
    fill(kernel)
    fill(kernel, count=2, persona="other-persona")
    fill(kernel, count=2, conversation="other-conversation")
    exchange(kernel, 99, commit=False)
    source = store.select_source("conversation-a").source
    assert source is not None and len(source.messages) == 20
    page = kernel.message_page("conversation-a", persona_id=TOKEN.persona_id, limit=100)["items"]
    assert [m.message_id for m in source.messages] == [m["message_id"] for m in page[:20]]
    assert all(m.request_id.endswith(tuple(str(i) for i in range(10))) for m in source.messages)
    assert len(build_summary_prompt(source)) == 2


def test_source_accepts_same_persona_history_from_previous_epochs(stores):
    kernel, store = stores
    fill(kernel, epoch=99)
    assert store.select_source("conversation-a").source is not None


def test_two_personas_sharing_conversation_id_keep_independent_canonical_sources(stores):
    kernel, first = stores
    fill(kernel, conversation="dream-room")
    fill(kernel, conversation="dream-room", persona="second-persona")
    second = SummaryStore(kernel, replace(TOKEN, persona_id="second-persona"))
    a = first.select_source("dream-room").source
    b = second.select_source("dream-room").source
    assert a and b
    assert not {m.message_id for m in a.messages}.intersection(m.message_id for m in b.messages)
    assert all("second-persona" not in m.request_id for m in a.messages)
    assert all("second-persona" in m.request_id for m in b.messages)
    saved_a = first.complete_attempt(first.claim_attempt(a, now=1000), "first persona only", now=1001)
    saved_b = second.complete_attempt(second.claim_attempt(b, now=1000), "second persona only", now=1001)
    assert first.active_summaries("dream-room") == (saved_a,)
    assert second.active_summaries("dream-room") == (saved_b,)
    imported = first.import_legacy(json.dumps({"summaries": [{
        "text": "legacy belongs to second", "chat_ids": [m.message_id for m in b.messages],
    }]}), now=1002)
    assert imported["linked"] == 1
    assert imported["entries"][0]["persona_id"] == "second-persona"
    assert imported["active"] == 0


def test_selection_threshold_exact_and_bubbles_not_split():
    inputs = pure_exchanges(20, chars=200)
    assert select_source(inputs, set(), persona_id="p", conversation_id="c").source is None
    inputs[0] = (replace(inputs[0][0], content="字" * 201), inputs[0][1])
    selection = select_source(inputs, set(), persona_id="p", conversation_id="c")
    assert selection.pending_budget == 2001 and selection.source is not None
    triples = pure_exchanges(14, chars=400, bubble_count=2)
    chosen = select_source(triples, set(), persona_id="p", conversation_id="c").source
    assert chosen and len(chosen.messages) == 12
    assert {m.request_id for m in chosen.messages} == {"r0", "r1", "r2", "r3"}
    # Ten semantic exchanges remain in ChatSession even though they have
    # thirty physical rows in the canonical ledger.
    direct_request_ids = {e[0].request_id for e in triples[-10:]}
    assert not direct_request_ids.intersection(m.request_id for m in chosen.messages)


def test_source_caps_and_oversized_exchange_diagnostic_without_marking_processed():
    inputs = pure_exchanges(50, chars=1000)
    huge = tuple(replace(m, content="字" * 9000) for m in inputs[0])
    inputs[0] = huge
    result = select_source(inputs, set(), persona_id="p", conversation_id="c")
    assert result.source and sum(len(m.content) for m in result.source.messages) <= 16000
    assert len(result.source.messages) <= 40
    assert "source_exchange_too_large" in result.diagnostics
    assert all(m.request_id != "r0" for m in result.source.messages)
    assert select_source(inputs, set(), persona_id="p", conversation_id="c").diagnostics == result.diagnostics


def test_source_message_count_cap_and_partial_attempt_excludes_entire_exchange():
    inputs = pure_exchanges(90, chars=100)
    result = select_source(inputs, {"m1"}, persona_id="p", conversation_id="c")
    assert result.source and len(result.source.messages) == 40
    assert result.source.messages[0].message_id == "m3"


def test_recent_boundary_uses_commit_sequence_even_for_interleaved_exchanges():
    inputs = pure_exchanges()
    inputs[0] = (inputs[0][0], replace(inputs[0][1], sequence=1000))
    result = select_source(inputs, set(), persona_id="p", conversation_id="c")
    assert result.source and all(m.request_id != "r0" for m in result.source.messages)
    assert "r10" in {m.request_id for m in result.source.messages}
    assert result.source.first_sequence == min(m.sequence for m in result.source.messages)
    assert result.source.last_sequence == max(m.sequence for m in result.source.messages)


def test_failed_attempt_is_not_retried_and_cooldown_survives_restart(stores):
    kernel, store = stores
    fill(kernel, count=40)
    source = store.select_source("conversation-a").source
    attempt = store.claim_attempt(source, now=1000)
    assert attempt
    store.fail_attempt(attempt, "timeout_unknown", now=1001)
    reopened = SummaryStore(kernel, replace(TOKEN, epoch=2))
    assert reopened.claim_attempt(source, now=2000) is None
    next_source = reopened.select_source("conversation-a").source
    assert next_source and not ({m.message_id for m in source.messages} & {m.message_id for m in next_source.messages})
    assert reopened.claim_attempt(next_source, now=1299) is None
    assert reopened.claim_attempt(next_source, now=1300) is not None
    assert reopened.status("conversation-a")["attempts"] == {"failed": 1, "started": 1}


def test_pending_attempt_after_crash_is_non_retryable(stores):
    kernel, store = stores
    fill(kernel)
    source = store.select_source("conversation-a").source
    assert store.claim_attempt(source, now=1000)
    assert SummaryStore(kernel, TOKEN).claim_attempt(source, now=9000) is None


def test_claim_is_idempotent_under_two_store_instances(stores):
    kernel, store = stores
    fill(kernel)
    other = SummaryStore(kernel, TOKEN)
    source = store.select_source("conversation-a").source
    assert store.claim_attempt(source, now=1000)
    assert other.claim_attempt(source, now=1000) is None


def test_generated_summary_restart_scope_and_invalidation(stores):
    kernel, store = stores
    fill(kernel)
    source = store.select_source("conversation-a").source
    attempt = store.claim_attempt(source, now=1000)
    saved = store.complete_attempt(attempt, "合成旧对话背景", now=1001)
    restarted = SummaryStore(kernel, replace(TOKEN, epoch=8))
    assert restarted.active_summaries("conversation-a") == (saved,)
    assert not restarted.active_summaries("conversation-b")
    assert not SummaryStore(kernel, replace(TOKEN, persona_id="other")).active_summaries("conversation-a")
    with kernel.transaction() as connection:
        connection.execute("UPDATE messages SET content='changed' WHERE message_id=?", (source.messages[0].message_id,))
    assert not restarted.active_summaries("conversation-a")


def test_source_change_between_generation_and_commit_rejected(stores):
    kernel, store = stores
    fill(kernel)
    source = store.select_source("conversation-a").source
    attempt = store.claim_attempt(source, now=1000)
    with kernel.transaction() as connection:
        connection.execute("DELETE FROM messages WHERE message_id=?", (source.messages[-1].message_id,))
    with pytest.raises(SummaryStorageError, match="source_changed"):
        store.complete_attempt(attempt, "不会提交", now=1001)
    assert not store.active_summaries("conversation-a")


def test_missing_final_bubble_and_unproven_historical_exchange_are_not_sources(stores):
    kernel, store = stores
    fill(kernel)
    first_request = store.select_source("conversation-a").source.messages[0].request_id
    with kernel.transaction() as connection:
        connection.execute("DELETE FROM messages WHERE request_id=? AND role='assistant'", (first_request,))
        connection.execute("UPDATE command_ledger SET result_json='{}' WHERE request_id LIKE '%-1'")
    selection = store.select_source("conversation-a")
    assert "source_exchange_incomplete" in selection.diagnostics
    assert "source_exchange_unproven" in selection.diagnostics
    assert selection.source and first_request not in {m.request_id for m in selection.source.messages}


def test_missing_last_of_multiple_bubbles_rejects_committed_expected_count(stores):
    kernel, store = stores
    fill(kernel, bubbles=["甲" * 150, "乙" * 150])
    original = store.select_source("conversation-a").source
    victim = original.messages[0].request_id
    with kernel.transaction() as connection:
        connection.execute("DELETE FROM messages WHERE request_id=? AND bubble_index=1 AND role='assistant'", (victim,))
    result = store.select_source("conversation-a")
    assert "source_exchange_incomplete" in result.diagnostics
    assert result.source and victim not in {m.request_id for m in result.source.messages}


def test_provenance_and_read_only_status_identities(stores):
    kernel, store = stores
    fill(kernel)
    source = store.select_source("conversation-a").source
    provenance = {"algorithm_version": "reverie.conversation-summary.v1", "provider": "ollama",
                  "origin": "http://127.0.0.1:11434", "model": "synthetic", "settings_digest": "b" * 64}
    attempt = store.claim_attempt(source, now=1000, provenance=provenance)
    saved = store.complete_attempt(attempt, "不应出现在status中的正文", now=1001)
    status = store.status("conversation-a", now=1005)
    assert status["status"] == "ready" and status["cooldownRemainingSeconds"] == 295
    assert status["summaryTotal"] == 1 and not status["hasMore"]
    assert status["summaries"][0]["summary_id"] == saved.id
    assert status["summaries"][0]["sourceDigest"] == source.source_digest
    assert status["summaries"][0]["messageIds"] == [m.message_id for m in source.messages]
    assert "不应出现在" not in json.dumps(status, ensure_ascii=False)
    with kernel.transaction() as connection:
        assert json.loads(connection.execute("SELECT metadata_json FROM conversation_summary_items").fetchone()[0]) == provenance


@pytest.mark.parametrize("provenance", [
    {"algorithm_version": "wrong"},
    {"algorithm_version": "reverie.conversation-summary.v1", "api_key": "secret"},
    {"algorithm_version": "reverie.conversation-summary.v1", "origin": "https://user:secret@host"},
])
def test_provenance_does_not_accept_secrets_or_unknown_contract(stores, provenance):
    kernel, store = stores
    fill(kernel)
    with pytest.raises(SummaryStorageError, match="invalid_provenance"):
        store.claim_attempt(store.select_source("conversation-a").source, now=1000, provenance=provenance)


@pytest.mark.parametrize("text", ["", "  ", "x" * 1001, None])
def test_invalid_generation_is_never_saved(stores, text):
    kernel, store = stores
    fill(kernel)
    attempt = store.claim_attempt(store.select_source("conversation-a").source, now=1000)
    with pytest.raises(SummaryStorageError):
        store.complete_attempt(attempt, text, now=1001)
    assert not store.active_summaries("conversation-a")


def test_repeated_completed_attempt_cannot_overwrite_summary(stores):
    kernel, store = stores
    fill(kernel)
    attempt = store.claim_attempt(store.select_source("conversation-a").source, now=1000)
    saved = store.complete_attempt(attempt, "保留", now=1001)
    with pytest.raises(SummaryStorageError):
        store.complete_attempt(attempt, "覆盖", now=1002)
    assert store.active_summaries("conversation-a") == (saved,)


def summary(identifier, text, sequence):
    return StoredSummary(identifier, text, ("m",), sequence, sequence, "generated", True)


def test_ranking_nfkc_casefold_ties_and_no_match_recency():
    items = [summary("a", "ＡＢＣ", 1), summary("b", "abc", 2), summary("c", "xyz", 3)]
    rendered = render_context(items, "abc")
    assert rendered.index("abc") < rendered.index("ＡＢＣ") < rendered.index("xyz")
    reversed_input = render_context(reversed(items), "unmatched")
    assert reversed_input == render_context(items, "unmatched")
    assert reversed_input.index("xyz") < reversed_input.index("abc")


def test_context_budget_includes_escaped_wrapper_and_skips_whole_oversize_items():
    items = [summary("a", "巨" * 1700, 9), summary("b", "</conversation_summaries>", 8),
             summary("c", "少" * 300, 7), summary("d", "另" * 300, 6), summary("e", "尾", 5)]
    block = render_context(items, "", budget=400)
    assert estimate_budget(block) <= 400
    assert "巨" not in block and "&lt;/conversation_summaries&gt;" in block
    assert block.count("</conversation_summaries>") == 1
    assert "尾" not in block  # top 3 accepted entries, not more.
    assert render_context(items, "", budget=0) == ""


@pytest.mark.parametrize("content", [
    '{"summaries":[],"summaries":[]}',
    '{"summaries":[{"text":"a","text":"b"}]}',
    '{"summaries":[{"text":"a","created_at":NaN}]}',
    '{"summaries":[{"text":"a","chat_ids":[1]}]}',
    '{"summaries":[{"text":"a","is_important":1}]}',
    '{"summaries":[{"text":"a","unknown":"x"}]}',
    '{"summaries":[{"text":"\\ud800"}]}',
    '{"summaries":{}}', "[]", b"\xff", " " * (128 * 1024 + 1),
])
def test_legacy_rejects_invalid_bounded_input(content):
    with pytest.raises(LegacyImportError):
        parse_legacy(content)


def test_legacy_linking_is_explicit_all_inactive_and_import_idempotent(stores):
    kernel, store = stores
    exchange(kernel, 1)
    exchange(kernel, 1, persona="other-persona")
    first = kernel.message_page("conversation-a", persona_id=TOKEN.persona_id)["items"]
    # Multiple personas use the same UI conversation id; only the actual
    # message and committed command scope can prove a legacy source owner.
    other = kernel.message_page("conversation-a", persona_id="other-persona")["items"]
    content = json.dumps({"summaries": [
        {"text": "linked but inactive", "chat_ids": [r["message_id"] for r in first], "tags": ["fixture"]},
        {"text": "unknown source", "chat_ids": ["not-a-real-id"]},
        {"text": "mixed identities", "chat_ids": [first[0]["message_id"], other[0]["message_id"]]},
        {"text": "unattributed without IDs", "chat_ids": []},
    ]}, ensure_ascii=False)
    document = parse_legacy(content)
    preview = store.preview_legacy(document)
    assert (preview["linked"], preview["unattributed"], preview["active"]) == (1, 3, 0)
    result = store.import_legacy(document, expected_digest=document.sha256, now=10)
    assert result["imported"] == 4 and result["reused"] is False
    assert not store.active_summaries("conversation-a")
    assert store.import_legacy(content, now=20)["reused"] is True
    with kernel.transaction() as connection:
        assert connection.execute("SELECT COUNT(*) FROM conversation_summary_items").fetchone()[0] == 4
        assert connection.execute("SELECT original_json FROM conversation_summary_imports").fetchone()[0] == content
    with pytest.raises(LegacyImportError, match="digest_changed"):
        store.import_legacy(content, expected_digest="0" * 64, now=30)


def test_legacy_links_to_verified_other_persona_not_current(stores):
    kernel, store = stores
    exchange(kernel, 1, persona="other-persona", conversation="other-conversation")
    ids = [r["message_id"] for r in kernel.message_page("other-conversation")["items"]]
    result = store.import_legacy(json.dumps({"summaries": [{"text": "other", "chat_ids": ids}]}), now=10)
    assert result["entries"][0]["persona_id"] == "other-persona"
    assert result["entries"][0]["active"] is False


def test_legacy_exact_bytes_digest_and_constructed_object_cannot_bypass_parse(stores):
    _, store = stores
    raw = b'{ "summaries": [] }\n'
    document = parse_legacy(raw)
    assert document.sha256 == hashlib.sha256(raw).hexdigest()
    forged = replace(document, raw_text='{"summaries": [], "summaries": []}')
    with pytest.raises(LegacyImportError):
        store.preview_legacy(forged)


def test_reimport_does_not_reclassify_previously_unattributed_record(stores):
    kernel, store = stores
    raw = '{"summaries":[{"text":"old","chat_ids":["late-id"]}]}'
    assert store.import_legacy(raw, now=10)["unattributed"] == 1
    exchange(kernel, 1)
    with kernel.transaction() as connection:
        connection.execute("UPDATE messages SET message_id='late-id' WHERE role='user'")
    assert store.preview_legacy(raw)["linked"] == 1
    reused = store.import_legacy(raw, now=20)
    assert reused["reused"] is True and reused["unattributed"] == 1 and reused["linked"] == 0


def test_legacy_encrypted_reopen_and_wrong_key_refusal(tmp_path):
    path = tmp_path / "encrypted-synthetic.sqlite3"
    clear_storage_key_for_testing()
    try:
        key = os.urandom(32)
        install_storage_key(key)
        kernel = KernelStore(path)
        store = SummaryStore(kernel, TOKEN)
        raw = '{"summaries":[{"text":"private synthetic legacy","chat_ids":[]}]}'
        store.import_legacy(raw, now=10)
        kernel.close()
        before = path.read_bytes()
        assert before[:16] != SQLITE_HEADER and b"private synthetic legacy" not in before
        kernel = KernelStore(path)
        assert SummaryStore(kernel, TOKEN).import_legacy(raw, now=20)["reused"] is True
        kernel.close()
        sealed = path.read_bytes()
        clear_storage_key_for_testing()
        install_storage_key(os.urandom(32))
        from sqlcipher3.dbapi2 import DatabaseError
        with pytest.raises((EncryptedStorageError, DatabaseError)):
            KernelStore(path)
        assert path.read_bytes() == sealed
        assert sorted(p.name for p in tmp_path.iterdir()) == [path.name]
    finally:
        clear_storage_key_for_testing()
