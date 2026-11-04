"""Explicitly registered synthetic summary-view evidence, for isolated tests.

Importing this module has no project imports, hooks, storage or model effects.
The observer is installed only by the ordinary P1 memory test bootstrap. Its
one late fixture is synthetic output; it does not claim natural generation or
change the production source selector, prompt, thresholds or consent policy.
"""
from __future__ import annotations

import functools
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import time


SUMMARY_ID = "summary_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
ATTEMPT_ID = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
BODY = "SUMMARY_VIEW_R3_MARKER：窗边的合成回忆。<b>这是纯文本</b>\n本段仅用于隔离查看。"
MARKER = "SUMMARY_VIEW_R3_MARKER"
CONVERSATION = "dream-room"
EXPECTED_MESSAGES = 39
# Current confirmed facts shown by the product page. Superseded revisions
# remain in the full memory_records table and its independent row-count/hash.
EXPECTED_MEMORIES = 127
SUMMARY_TABLES = frozenset({"conversation_summary_attempts", "conversation_summary_items"})
_REQUEST = re.compile(r"[A-Za-z0-9_-]{8,128}")
_DIGEST = re.compile(r"[0-9a-f]{64}")
_STATUSES = frozenset({"disabled", "unauthorized", "running", "failed", "outcome_unknown", "cooldown",
                       "ready", "below_threshold", "no_source", "idle", "not_ready"})


def _snapshot_value(item):
    if isinstance(item, (bytes, bytearray, memoryview)):
        return {"bytes": bytes(item).hex()}
    raise TypeError("unsupported fixture snapshot value")


def _json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=_snapshot_value)


def _sha(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _ordered_ids_digest(ids):
    return _sha(_json(list(ids)))


def _request_id(message):
    value = message.get("request_id")
    return value if isinstance(value, str) and _REQUEST.fullmatch(value) else ""


def _boolean(value):
    return value if type(value) is bool else None


def _scope_matches(value, active, *, expected=False):
    names = (("expected_persona_id", "persona_id"), ("expected_persona_epoch", "persona_epoch"),
             ("expected_persona_fingerprint", "persona_fingerprint")) if expected else (
                 ("persona_id", "persona_id"), ("persona_epoch", "persona_epoch"),
                 ("persona_fingerprint", "persona_fingerprint"))
    return (isinstance(active.get("persona_id"), str) and bool(active["persona_id"])
            and type(active.get("persona_epoch")) is int and active["persona_epoch"] > 0
            and isinstance(active.get("persona_fingerprint"), str) and bool(active["persona_fingerprint"])
            and all(value.get(a) == active.get(b) for a, b in names))


def _runtime(bridge):
    runtime = bridge._summary_runtime()
    token = runtime.registry.token()
    if token != runtime.token or runtime.store.token != token or runtime.store.persona_id != token.persona_id:
        raise ValueError("summary fixture stale scope")
    active = bridge._active_persona_scope()
    token_scope = {"persona_id": token.persona_id, "persona_epoch": token.epoch,
                   "persona_fingerprint": token.fingerprint}
    if not _scope_matches(active, token_scope):
        raise ValueError("summary fixture active scope mismatch")
    return runtime, active


def _consent(runtime):
    status = runtime.status(CONVERSATION)
    grant = runtime.policy.snapshot()["conversation_summary"]
    fields = {"enabled": runtime.enabled(), "grantEnabled": grant["enabled"],
              "grantAcknowledged": grant["api_cost_acknowledged"],
              "policyAllowed": runtime.policy.allowed("conversation_summary"),
              "statusDisabled": status.get("status") == "disabled"}
    if (any(type(fields[name]) is not bool or fields[name] is not False for name in (
            "enabled", "grantEnabled", "grantAcknowledged", "policyAllowed"))
            or status.get("enabled") is not False or status.get("authorized") is not False
            or status.get("consent_effective") is not False or fields["statusDisabled"] is not True):
        raise ValueError("summary fixture requires disabled ungranted generation")
    return fields


def _owned_stores(bridge, runtime, data):
    kernel = bridge.bridge_state.kernel_store
    memory = bridge.bridge_state.memory
    if kernel is None or memory is None or runtime.store.kernel_store is not kernel:
        raise ValueError("summary fixture requires the existing kernel and memory stores")
    memory._require_current()
    memory_scope = getattr(memory, "state_scope", None)
    if memory_scope is not None and (memory_scope.token != runtime.token or memory_scope.registry is not runtime.registry):
        raise ValueError("summary fixture memory store belongs to another scope")
    catalog = memory.store.catalog
    for store in (kernel, catalog):
        path = Path(store.path)
        info = path.lstat()
        if (not path.is_absolute() or path.resolve() != path or not path.is_relative_to(data / "data")
                or not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1):
            raise ValueError("summary fixture store outside owned isolation")
        # This is the already-open connection. No key, copied database or new
        # plaintext store is created by this extension.
        cipher = store._connection.execute("PRAGMA cipher_version").fetchone()
        with path.open("rb") as source:
            header = source.read(16)
        if not cipher or not str(cipher[0]).strip() or header == b"SQLite format 3\x00":
            raise ValueError("summary fixture requires existing encrypted stores")
    return kernel, catalog


def _table_snapshot(connection):
    result = {}
    tables = connection.execute(
        "SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").fetchall()
    for name, definition in tables:
        # Both existing stores declare ordinary rowid tables. Fail closed if
        # their schema ever grows a virtual or WITHOUT ROWID table rather
        # than silently taking an incomplete or differently ordered snapshot.
        if (not isinstance(definition, str)
                or re.search(r"\bWITHOUT\s+ROWID\b|\bCREATE\s+VIRTUAL\s+TABLE\b", definition, re.IGNORECASE)):
            raise ValueError("summary fixture snapshots require ordinary rowid tables")
        quoted = '"' + name.replace('"', '""') + '"'
        rows = [list(row) for row in connection.execute(f"SELECT rowid,* FROM {quoted} ORDER BY rowid")]
        result[name] = {"count": len(rows), "sha256": _sha(_json(rows))}
    return result


def _snapshot(kernel_connection, memory_connection):
    message_ids = [row[0] for row in kernel_connection.execute("SELECT message_id FROM messages ORDER BY rowid")]
    memory_ids = [row[0] for row in memory_connection.execute("""SELECT id FROM memory_records
        WHERE confirmation_state='confirmed' AND lifecycle_state='active'
        ORDER BY COALESCE(confirmed_at,created_at) DESC,id DESC""")]
    return {"kernelTables": _table_snapshot(kernel_connection), "memoryTables": _table_snapshot(memory_connection),
            "messageIdsSha256": _ordered_ids_digest(message_ids), "memoryIdsSha256": _ordered_ids_digest(memory_ids),
            "messageCount": len(message_ids), "memoryCount": len(memory_ids)}


def _unchanged(before, after):
    ordinary = lambda snapshot: {key: value for key, value in snapshot["kernelTables"].items() if key not in SUMMARY_TABLES}
    fields = {"messageIdsUnchanged": before["messageIdsSha256"] == after["messageIdsSha256"],
              "memoryIdsUnchanged": before["memoryIdsSha256"] == after["memoryIdsSha256"],
              "kernelNonSummaryUnchanged": ordinary(before) == ordinary(after),
              "memoryTablesUnchanged": before["memoryTables"] == after["memoryTables"],
              "otherSummaryTablesUnchanged": all(before["kernelTables"].get(name) == after["kernelTables"].get(name)
                  for name in set(before["kernelTables"]) | set(after["kernelTables"])
                  if name.startswith("conversation_summary_") and name not in SUMMARY_TABLES)}
    fields["beforeAfterMatches"] = all(fields.values())
    if not fields["beforeAfterMatches"]:
        raise ValueError("summary fixture modified unrelated storage")
    return fields


def _source(store, connection):
    from src.conversation_summary.engine import CONTRACT_VERSION, SourceBatch, source_digest, source_document

    exchanges = store._exchanges(connection, CONVERSATION)
    if not exchanges:
        raise ValueError("summary fixture requires a complete committed first exchange")
    messages = exchanges[0]
    # A complete later exchange must never stand in for an incomplete first.
    first = connection.execute("""SELECT rowid,message_id,request_id FROM messages
        WHERE persona_id=? AND conversation_id=? AND source='chat' ORDER BY rowid LIMIT 1""",
        (store.persona_id, CONVERSATION)).fetchone()
    if first is None or messages[0].message_id != first["message_id"] or messages[0].sequence != first["rowid"]:
        raise ValueError("summary fixture first exchange is incomplete")
    source = SourceBatch(store.persona_id, CONVERSATION, messages,
                         source_digest(store.persona_id, CONVERSATION, messages),
                         min(m.sequence for m in messages), max(m.sequence for m in messages))
    if not store._source_current(connection, source):
        raise ValueError("summary fixture canonical source mismatch")
    return source, _json(source_document(messages)), {"algorithm_version": CONTRACT_VERSION}


def _identity(item):
    return {"summaryId": item.id, "bodySha256": _sha(item.text), "bodyCharacters": len(item.text),
            "sourceDigest": item.source_digest, "sourceIdsSha256": _ordered_ids_digest(item.source_ids),
            "sourceMessageCount": len(item.source_ids), "firstSequence": item.source_first_sequence,
            "lastSequence": item.source_last_sequence}


def _existing(runtime, connection):
    store = runtime.store
    source, source_json, provenance = _source(store, connection)
    attempts = connection.execute("SELECT * FROM conversation_summary_attempts ORDER BY rowid").fetchall()
    items = connection.execute("SELECT * FROM conversation_summary_items ORDER BY rowid").fetchall()
    if len(attempts) != 1 or len(items) != 1:
        raise ValueError("summary fixture requires exactly one attempt and item")
    attempt, row = attempts[0], items[0]
    if (attempt["attempt_id"] != ATTEMPT_ID or attempt["status"] != "completed"
            or attempt["persona_id"] != store.persona_id or attempt["conversation_id"] != CONVERSATION
            or attempt["source_digest"] != source.source_digest or attempt["source_json"] != source_json
            or attempt["provenance_json"] != _json(provenance)
            or row["summary_id"] != SUMMARY_ID or row["attempt_id"] != ATTEMPT_ID
            or row["source_json"] != source_json or row["metadata_json"] != _json(provenance)
            or row["linkage"] != "linked" or row["legacy_sha256"] is not None
            or row["legacy_position"] is not None or row["text"] != BODY):
        raise ValueError("summary fixture existing row does not match registration")
    item = store._validated_summary(connection, row, CONVERSATION, for_detail=True)
    if (item is None or item.origin != "generated" or item.active is not True
            or item.source_ids != tuple(message.message_id for message in source.messages)):
        raise ValueError("summary fixture existing source is not valid")
    return item


def _registered_targets(evidence):
    rows = [json.loads(line) for line in evidence.read_text(encoding="utf-8").splitlines()]
    prepared = [row for row in rows if row.get("event") == "batch_delete_prepared" and row.get("cycle") == 1]
    if (len(prepared) != 1 or prepared[0].get("targetNumbers") != [130, 129, 127]
            or prepared[0].get("pinnedNumber") != 130):
        raise ValueError("summary fixture requires the registered ordinary batch")
    ids = prepared[0].get("targetIds")
    if not isinstance(ids, list) or len(ids) != 3 or any(not isinstance(i, str) or not i for i in ids) or len(set(ids)) != 3:
        raise ValueError("summary fixture invalid registered batch identities")
    return ids


def seed_after_batch(bridge, data, evidence, cycle, message, result, record):
    """Insert one synthetic record only after the registered real batch result.

    The synthetic body deliberately bypasses generation. Production source
    validation still runs unchanged, inside the existing epoch commit barrier.
    Any insertion/invariant failure rolls back both new summary rows together.
    """
    if cycle != 1 or message.get("type") != "memory:delete_many" or result.get("ok") is not True:
        raise ValueError("summary fixture requires a successful first-cycle batch")
    payload = message.get("payload")
    targets = _registered_targets(evidence)
    ids = payload.get("memory_ids") if isinstance(payload, dict) else None
    if (not isinstance(ids, list) or len(ids) != 3 or set(ids) != set(targets)
            or result.get("deleted_ids") != ids or type(result.get("purged_revisions")) is not int
            or result["purged_revisions"] < 3 or not _request_id(message)):
        raise ValueError("summary fixture batch does not match registration")
    runtime, active = _runtime(bridge)
    if not _scope_matches(payload, active, expected=True):
        raise ValueError("summary fixture batch scope mismatch")
    consent = _consent(runtime)
    kernel, catalog = _owned_stores(bridge, runtime, data)
    if runtime.detail(CONVERSATION, SUMMARY_ID) is not None:
        raise ValueError("summary fixture refuses duplicate or foreign summaries")

    def commit():
        with catalog.transaction() as memory_connection, kernel.transaction() as connection:
            before = _snapshot(connection, memory_connection)
            if before["messageCount"] != EXPECTED_MESSAGES or before["memoryCount"] != EXPECTED_MEMORIES:
                raise ValueError("summary fixture must follow the original chat archive backup and batch flow")
            if (before["kernelTables"]["conversation_summary_attempts"]["count"] != 0
                    or before["kernelTables"]["conversation_summary_items"]["count"] != 0):
                raise ValueError("summary fixture refuses duplicate or foreign summaries")
            if any(memory_connection.execute("SELECT 1 FROM memory_records WHERE id=?", (ident,)).fetchone()
                   for ident in targets):
                raise ValueError("summary fixture batch targets still present")
            source, source_json, provenance = _source(runtime.store, connection)
            now = time.time()
            connection.execute("""INSERT INTO conversation_summary_attempts
                (attempt_id,persona_id,conversation_id,source_digest,source_json,started_at,finished_at,
                 status,error_code,provenance_json) VALUES (?,?,?,?,?,?,?,'completed',NULL,?)""",
                (ATTEMPT_ID, runtime.token.persona_id, CONVERSATION, source.source_digest, source_json,
                 now, now, _json(provenance)))
            connection.execute("""INSERT INTO conversation_summary_items
                (summary_id,persona_id,conversation_id,text,source_json,source_digest,first_sequence,last_sequence,
                 origin,active,linkage,attempt_id,metadata_json,created_at)
                VALUES (?,?,?,?,?,?,?,?,'generated',1,'linked',?,?,?)""",
                (SUMMARY_ID, runtime.token.persona_id, CONVERSATION, BODY, source_json, source.source_digest,
                 source.first_sequence, source.last_sequence, ATTEMPT_ID, _json(provenance), now))
            item = _existing(runtime, connection)
            after = _snapshot(connection, memory_connection)
            unchanged = _unchanged(before, after)
            return {**_identity(item), **unchanged, "snapshots": {"before": before, "after": after}}

    fields = runtime.registry.commit_if_current(runtime.token, commit)
    saved = runtime.detail(CONVERSATION, SUMMARY_ID)
    if saved is None or any(fields[key] != value for key, value in _identity(saved).items()):
        raise ValueError("summary fixture targeted getter did not validate the new row")
    if _consent(runtime) != consent:
        raise ValueError("summary fixture generation settings changed")
    record(evidence, cycle, "summary_view_seeded", **fields, **consent,
           scopeMatches=True, syntheticFixture=True, naturalGeneration=False,
           causeRequestId=_request_id(message), requestedCount=3, deletedCount=3,
           messageCount=EXPECTED_MESSAGES, memoryCount=EXPECTED_MEMORIES, summaryAttemptCount=1, summaryItemCount=1)


def _validate_read(bridge, data):
    runtime, active = _runtime(bridge)
    consent = _consent(runtime)
    kernel, catalog = _owned_stores(bridge, runtime, data)

    def read():
        with catalog.transaction() as memory_connection, kernel.transaction() as connection:
            before = _snapshot(connection, memory_connection)
            if before["messageCount"] != EXPECTED_MESSAGES or before["memoryCount"] != EXPECTED_MEMORIES:
                raise ValueError("summary fixture read changed original message or memory counts")
            item = _existing(runtime, connection)
            after = _snapshot(connection, memory_connection)
            if before != after:
                raise ValueError("summary fixture validation mutated storage")
            return item, before

    item, snapshot = runtime.registry.commit_if_current(runtime.token, read)
    return item, active, consent, snapshot


def _source_metadata(value):
    ids = value.get("messageIds")
    digest = value.get("sourceDigest")
    first, last = value.get("firstSequence"), value.get("lastSequence")
    valid = (isinstance(ids, list) and bool(ids) and all(isinstance(i, str) and bool(i) for i in ids)
             and len(set(ids)) == len(ids) and isinstance(digest, str) and bool(_DIGEST.fullmatch(digest))
             and type(first) is int and type(last) is int and 1 <= first <= last)
    return {"sourceDigest": digest if valid else "", "sourceIdsSha256": _ordered_ids_digest(ids) if valid else "",
            "sourceMessageCount": len(ids) if valid else 0, "firstSequence": first if valid else None,
            "lastSequence": last if valid else None}


def install_summary_view_observer(data: Path, evidence: Path, cycle: int, record):
    """Observe the real authenticated dispatch; never issue a synthetic RPC."""
    if cycle not in (1, 2):
        raise ValueError("summary fixture requires an ordinary registered cycle")
    from src.bridge import ws_bridge

    original_dispatch = ws_bridge.dispatch_authenticated_message
    state = {"seeded": False, "reads": 0, "restart": False}

    @functools.wraps(original_dispatch)
    async def dispatch(message, endpoint, *, emit_result=True):
        kind = message.get("type") if isinstance(message, dict) else None
        if kind not in {"memory:delete_many", "summary:get", "summary:status"}:
            return await original_dispatch(message, endpoint, emit_result=emit_result)
        if kind == "summary:status" and cycle == 1 and not state["seeded"]:
            # The original archive check temporarily enables and disables
            # summaries. Its earlier status reads precede this fixture and
            # keep their original behavior and evidence contract.
            return await original_dispatch(message, endpoint, emit_result=emit_result)
        if kind == "memory:delete_many":
            result = await original_dispatch(message, endpoint, emit_result=emit_result)
            if cycle == 1 and isinstance(result, dict) and result.get("ok") is True:
                if state["seeded"]:
                    raise ValueError("summary fixture refuses a second successful seed trigger")
                seed_after_batch(ws_bridge, data, evidence, cycle, message, result, record)
                state["seeded"] = True
            return result
        payload = message.get("payload")
        payload = payload if isinstance(payload, dict) else {}
        request_id = _request_id(message)
        if kind == "summary:status":
            runtime, active = _runtime(ws_bridge)
            consent = _consent(runtime)
            request_scope = _scope_matches(payload, active, expected=True)
            record(evidence, cycle, "summary_view_status_dispatched", requestId=request_id,
                   scopeMatches=request_scope, **consent)
            result = await original_dispatch(message, endpoint, emit_result=emit_result)
            returned = result if isinstance(result, dict) else {}
            rows = returned.get("summaries")
            fixture = [row for row in rows if isinstance(row, dict) and row.get("summary_id") == SUMMARY_ID] if isinstance(rows, list) else []
            entry = fixture[0] if len(fixture) == 1 else {}
            status = returned.get("status")
            active_count, total = returned.get("activeCount"), returned.get("summaryTotal")
            record(evidence, cycle, "summary_view_status_result", requestId=request_id,
                   ok=returned.get("ok") is True, operationMatches=returned.get("operation") == "status",
                   status=status if isinstance(status, str) and status in _STATUSES else "",
                   resultEnabled=_boolean(returned.get("enabled")),
                   resultAuthorized=_boolean(returned.get("authorized")), resultStatusDisabled=status == "disabled",
                   activeCount=active_count if type(active_count) is int and active_count >= 0 else None,
                   summaryTotal=total if type(total) is int and total >= 0 else None,
                   fixturePresent=len(fixture) == 1, summaryId=SUMMARY_ID if entry else "",
                   **_source_metadata(entry), scopeMatches=request_scope and _scope_matches(returned, active), **_consent(runtime))
            return result
        if cycle == 1 and not state["seeded"]:
            raise ValueError("summary fixture cannot be read before the late registered batch seed")
        if state["reads"]:
            raise ValueError("summary fixture expects exactly one summary body dispatch per cycle")
        item, active, consent, snapshot = _validate_read(ws_bridge, data)
        if cycle == 2 and not state["restart"]:
            record(evidence, cycle, "summary_view_restart_validated", **_identity(item), **consent,
                   scopeMatches=True, syntheticFixture=True, naturalGeneration=False, seeded=False,
                   messageIdsSha256=snapshot["messageIdsSha256"], memoryIdsSha256=snapshot["memoryIdsSha256"],
                   messageCount=EXPECTED_MESSAGES, memoryCount=EXPECTED_MEMORIES, summaryAttemptCount=1, summaryItemCount=1)
            state["restart"] = True
        state["reads"] += 1
        request_scope = _scope_matches(payload, active, expected=True)
        record(evidence, cycle, "summary_view_dispatched", requestId=request_id, readCount=state["reads"],
               summaryId=SUMMARY_ID if payload.get("summary_id") == SUMMARY_ID else "",
               idMatches=payload.get("summary_id") == SUMMARY_ID,
               scopeMatches=request_scope, **consent)
        result = await original_dispatch(message, endpoint, emit_result=emit_result)
        returned = result if isinstance(result, dict) else {}
        summary = returned.get("summary")
        summary = summary if isinstance(summary, dict) else {}
        body = summary.get("text")
        source = _source_metadata(summary)
        expected_source = {key: _identity(item)[key] for key in source}
        id_matches = summary.get("summary_id") == SUMMARY_ID
        operation_matches = returned.get("operation") == "detail" and returned.get("conversation_id") == CONVERSATION
        source_matches = source == expected_source and summary.get("contractVersion") == item.contract_version
        current_runtime, current_scope = _runtime(ws_bridge)
        fields = _consent(current_runtime)
        record(evidence, cycle, "summary_view_result", requestId=request_id, readCount=state["reads"],
               ok=returned.get("ok") is True, operationMatches=operation_matches,
               summaryId=SUMMARY_ID if id_matches else "", idMatches=id_matches,
               bodySha256=_sha(body) if isinstance(body, str) else "", bodyCharacters=len(body) if isinstance(body, str) else 0,
               fixtureMatches=id_matches and body == BODY, sourceMatches=source_matches,
               statusMatches=fields == consent,
               scopeMatches=request_scope and _scope_matches(returned, active) and _scope_matches(current_scope, active),
               **source, **fields)
        return result

    ws_bridge.dispatch_authenticated_message = dispatch
    restored = False

    def undo():
        nonlocal restored
        if not restored:
            ws_bridge.dispatch_authenticated_message = original_dispatch
            restored = True
    return undo
