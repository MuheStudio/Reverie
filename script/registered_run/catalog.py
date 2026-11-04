"""Shared host-verification catalog for local and registered execution."""

from __future__ import annotations

from copy import deepcopy
import json
from pathlib import Path
import re

from .modes.context import RunContext
from .preview import MODE as PREVIEW_MODE, effective_modes, verify_saved as verify_preview_saved


GUI_MODES = ("injection", "regex", "entry", "persona", "candidate", "ordinary", "settings")
GUI_FIELDS = {"injection": "injectionGui", "regex": "regexGui", "entry": "entryGui",
              "persona": "personaGui", "candidate": "candidateGui", "ordinary": "gui",
              "settings": "settingsGui"}
NATIVE_PROOFS = {
    "nativePairedEvidence": "verify_native_pair",
    "nativeFocusPairedEvidence": "verify_native_focus_pair",
    "nativeRegexPairedEvidence": "verify_native_regex_pair",
    "nativeInjectionDepthPairedEvidence": "verify_native_injection_depth_pair",
    "nativeInjectionNavigationPairedEvidence": "verify_native_injection_navigation_pair",
    "nativeInjectionHitPairedEvidence": "verify_native_injection_hit_pair",
}

NATIVE_GROUPS = (
    ("nativeEvidenceContract", "native-evidence", "REVERIE_P1_NATIVE_EVIDENCE_DIR", "NATIVE"),
    ("nativeFocusEvidenceContract", "native-focus-evidence", "REVERIE_P1_ARCHIVE_FOCUS_EVIDENCE_DIR", "FOCUS"),
    ("nativeRegexEvidenceContract", "native-regex-evidence", "REVERIE_P1_REGEX_EVIDENCE_DIR", "REGEX"),
    ("nativeInjectionDepthEvidenceContract", "native-injection-depth-evidence", "REVERIE_P1_INJECTION_DEPTH_EVIDENCE_DIR", "INJECTION_DEPTH"),
    ("nativeInjectionNavigationEvidenceContract", "native-injection-navigation-evidence", "REVERIE_P1_INJECTION_NAVIGATION_EVIDENCE_DIR", "INJECTION_NAVIGATION"),
    ("nativeInjectionHitEvidenceContract", "native-injection-hit-evidence", "REVERIE_P1_INJECTION_HIT_EVIDENCE_DIR", "INJECTION_HIT"),
)


def native_stage_plan(context: RunContext):
    """Data plan for the original serial CTest and one joint consumer.

    The engine owns the one process group and the overall 300 second deadline.
    Only the wrapper executes these commands, and only after checking fresh
    output paths and the exact environment bindings listed here.
    """
    reg, root, report = context.config, context.root, context.report_dir
    groups = [{"contractKey": key, "directory": str(report / name),
               "verdict": str(report / (name + "-verdict.json")),
               "environmentKey": env, "errorPrefix": prefix}
              for key, name, env, prefix in NATIVE_GROUPS]
    ctest = [reg["ctest"], "--test-dir", str(root / reg["cmakeDirectory"]),
             "--output-on-failure", "--stop-on-failure", "--parallel", "1",
             "-R", reg["nativeSelector"], "--output-junit", str(report / "native-unit.xml")]
    consumer = [str(root / reg["node"]),
                str(root / reg["nativeInjectionHitEvidenceContract"]["pairedConsumer"]["path"])]
    for group in groups:
        consumer.extend([group["directory"], str(root / reg[group["contractKey"]]["path"]), group["verdict"]])
    return {"ctest": ctest, "consumer": consumer, "cwd": str(root),
            "groups": groups, "createDirectories": [group["directory"] for group in reversed(groups)],
            "environment": {group["environmentKey"]: group["directory"] for group in groups},
            "timeoutSeconds": reg["timeoutsSeconds"]["native-unit"],
            "nativeTargets": deepcopy(reg["nativeExecutionOrder"])}


def capture_report_roots(context: RunContext, stage: str):
    return context.invoke("save_report_roots", stage)


def locate_summary(context: RunContext, stage: str, snapshot):
    roots = context.invoke("load_report_roots", snapshot)
    return context.invoke("locate_summary", context.config, roots, stage + ".log")


def verify_native_evidence(context: RunContext):
    return {field: context.invoke(check, context.config) for field, check in NATIVE_PROOFS.items()}


def verify_stage(context: RunContext, stage_id: str):
    """Consume completed stage output; never launch a test, build or GUI stage."""
    reg = context.config
    call = context.invoke
    if stage_id == "sdk-build":
        return {"buildEvidence": call("verify_build", reg, context.root / reg["candidateDirectory"],
                                      context.root / reg["cmakeDirectory"])}
    if stage_id == "python-unit":
        return {"pythonEvidence": call("verify_python", reg),
                "capturedControlReceipt": call("verify_control_receipt", context.report_dir / "control-receipt", reg)}
    if stage_id == "node-unit":
        transcript = (context.report_dir / "node-unit.log").read_text()
        for key, value in [("tests", reg["expectedUnitCounts"]["node"]),
                           ("pass", reg["expectedUnitCounts"]["node"]),
                           ("fail", 0), ("cancelled", 0), ("skipped", 0), ("todo", 0)]:
            call("need", re.findall(r"^# " + key + r" (\d+)\s*$", transcript, re.M) == [str(value)],
                 "NODE_COUNTS_CHANGED:" + key)
        return {"nodeEvidence": call("verify_node", reg, transcript)}
    if stage_id == "frontend-unit":
        return {"frontendEvidence": call("verify_frontend", reg)}
    if stage_id == "native-unit":
        result = {"nativeEvidence": call("verify_native", reg)}
        result.update(verify_native_evidence(context))
        result["capturedControlReceipt"] = call("verify_control_receipt", context.report_dir / "control-receipt", reg)
        return result
    raise ValueError("UNKNOWN_VERIFICATION_STAGE:" + stage_id)


def _saved_ownership(context, result, run, saved):
    """Recheck raw historical events against the saved observation, without ps.

    Querying today's PIDs cannot reproduce the past observation. The saved
    ledger observation is therefore consumed explicitly; no successful ps
    output or process trace is generated for replay.
    """
    call = context.invoke
    call("need", isinstance(saved, dict), "REGEX_SAVED_OWNERSHIP_MISSING")
    events = result.get("worldbookRegexFixture", {}).get("events", [])
    spawns = [e for e in events if e.get("event") == "regex_worker_spawn"]
    exits = [e for e in events if e.get("event") == "regex_worker_exit"]
    call("need", len(spawns) == len(exits) == 3 and
         not any(e.get("event") == "regex_worker_cleanup_unconfirmed" for e in events),
         "REGEX_WORKER_LIFECYCLE_COUNTS")
    group = run.get("ownedProcessGroup")
    call("need", type(group) is int and group > 0 and run.get("processGroupGone") is True,
         "REGEX_STAGE_GROUP_NOT_GONE")
    seen = set()
    for spawn in spawns:
        key = tuple(spawn.get(k) for k in ("cycle", "bootstrap_pid", "worker_id", "pid"))
        call("need", all(type(x) is int and x > 0 for x in key) and key[0] == 1 and key not in seen and
             spawn.get("process_group") == group, "REGEX_WORKER_SPAWN_IDENTITY")
        seen.add(key)
        matched = [e for e in exits if tuple(e.get(k) for k in
                   ("cycle", "bootstrap_pid", "worker_id", "pid")) == key]
        call("need", len(matched) == 1 and type(matched[0].get("returncode")) is int and
             type(spawn.get("monotonic_ns")) is int and type(matched[0].get("monotonic_ns")) is int and
             matched[0]["monotonic_ns"] >= spawn["monotonic_ns"], "REGEX_WORKER_EXIT_IDENTITY")
    expected = {"spawned": 3, "exited": 3, "cycleCounts": [3, 0], "ownedProcessGroup": group,
                "actualExitCodes": [e["returncode"] for e in exits],
                "registeredPids": sorted({e["pid"] for e in spawns}),
                "ownedWorkerPidsRemaining": [], "commandMarker": "regex_worker.py", "signalsSent": 0}
    call("need", set(saved) == set(expected) | {"unrelatedPidReuses"} and
         all(saved.get(key) == value for key, value in expected.items()), "REGEX_SAVED_OWNERSHIP_CHANGED")
    reuses = saved.get("unrelatedPidReuses")
    call("need", isinstance(reuses, list) and all(isinstance(row, dict) and
         set(row) == {"pid", "identityChanged", "regexWorkerCommandMarker"} and
         type(row["pid"]) is int and row["pid"] in expected["registeredPids"] and
         row["identityChanged"] is True and type(row["regexWorkerCommandMarker"]) is bool
         for row in reuses), "REGEX_SAVED_PID_OBSERVATION_CHANGED")
    return deepcopy(saved)


def verify_mode(context: RunContext, mode: str, summary, *, snapshot=None,
                run_record=None, saved_record=None, replay=False):
    """Verify one actual GUI summary using the same checks in either engine."""
    mode = mode.removesuffix("-check")
    if mode not in effective_modes(context.config, GUI_MODES):
        raise ValueError("UNKNOWN_GUI_MODE:" + mode)
    summary = Path(summary)
    if mode == PREVIEW_MODE:
        return verify_preview_saved(context, summary, run_record, saved_record)
    reg, call = context.config, context.invoke
    result = call("load_json", summary)
    if snapshot is None:
        call("need", isinstance(saved_record, dict), "GUI_ROOTS_SNAPSHOT_REQUIRED")
        snapshot = saved_record["reportRootsBeforeManifest"]
    roots_before = call("load_report_roots", snapshot)
    view = {**reg, "gui": reg[GUI_FIELDS[mode]]}
    record = {
        "rawReportBinding": call("verify_gui_report_binding", result, reg, summary, roots_before),
        "archiveControlReadinessEvidence": call("verify_archive_control_inputs", result, reg, summary),
        "forcedCleanupEvidence": call("verify_forced_cleanup", result, reg),
    }
    # Every GUI mode runs the shared archive path. Keep old saved verdicts
    # byte-for-byte while requiring the new path in explicitly versioned runs.
    version = reg.get("memoryActionContract", "v1")
    call("need", version in ("v1", "v2"), "REGISTERED_MEMORY_ACTION_CONTRACT_CHANGED")
    if version == "v2":
        record["memoryActionAcquisition"] = call("verify_memory_action_result_v2", result)
    if mode == "injection":
        record["worldbookInjectionEvidence"] = call("verify_injection", result, reg, summary)
    elif mode == "regex":
        record["worldbookRegexEvidence"] = call("verify_regex", result, reg, summary)
        call("need", isinstance(run_record, dict), "REGEX_STAGE_RECORD_REQUIRED")
        record["regexWorkerOwnership"] = (_saved_ownership(context, result, run_record,
            saved_record.get("regexWorkerOwnership") if saved_record else None) if replay else
            call("verify_regex_worker_ownership", result, run_record))
    elif mode == "entry":
        record["worldbookEntrySettingsEvidence"] = call("verify_entry_settings", result, reg, summary)
    elif mode == "persona":
        record["worldbookPriorityEvidence"] = call("verify_persona_priority", result, reg, summary)
        proofs = call("verify_persona_row_inputs", result, reg, summary)
        record["personaRowInputEvidence"] = proofs["row"]
        record["authorControlInputEvidence"] = proofs["author"]
        if reg.get("cardExportContract") is not None:
            record["cardExportEvidence"] = call("verify_card_export", result, reg, summary)
        if reg.get("cardEditContract") is not None:
            record["cardEditEvidence"] = call("verify_card_edit", result, reg, summary)
    elif mode == "candidate":
        record.update(call("verify_candidate_paging_gui", result, view))
        record["memoryCandidateBatchEvidence"] = call("verify_candidate_batch", result, view, summary, roots_before)
    elif mode == "settings":
        record["settingsOrdinaryEvidence"] = call("verify_settings_ordinary", result, reg)
        record["settingsEvidence"] = call("verify_settings", result, reg,
            context.root / reg["candidateDirectory"], context.root / reg["cmakeDirectory"])
    else:
        record.update(call("verify_gui", result, view))
        record["memoryBatchDeleteEvidence"] = call("verify_memory_batch_delete", result, view, summary)
        record["summaryAcquisitionEvidence"] = call("verify_summary_acquisition", result, view)
        record["summaryViewEvidence"] = call("verify_summary_view", result, view, summary, roots_before,
            call("load_json", context.root / reg["candidateDirectory"] / "build.json"))
        record["replyStartEvidence"] = call("verify_reply_start", result, view)
        record["memoryBatchPinEvidence"] = call("verify_pin", result, view, summary, roots_before)
    return record


def replay_saved(context: RunContext, selections=None):
    """Replay real saved output and require equality with the actual ledger.

    It creates no stage record, input fixture, process trace or successful
    result. Historical process cleanup is a saved observation, clearly listed
    in the returned provenance rather than re-observed at replay time.
    """
    call = context.invoke
    ledger_path = context.report_dir / "run-ledger.json"
    baseline = context.config.get("baselineSource", {})
    if baseline.get("ledgerSha256"):
        call("need", call("sha", ledger_path) == baseline["ledgerSha256"], "REPLAY_LEDGER_CHANGED")
    ledger = call("load_json", ledger_path)
    call("need", ledger.get("passed") is True, "REPLAY_BASELINE_NOT_PASSED")
    stages = list(selections) if selections is not None else list(context.config["sequence"])
    results = {}
    for stage in stages:
        runs = [row for row in ledger["runs"] if row["id"] == stage]
        call("need", len(runs) == 1 and runs[0].get("exitCode") == 0 and
             runs[0].get("state") == "completed", "REPLAY_STAGE_NOT_PASSED:" + stage)
        if stage.endswith("-check"):
            saved = ledger["guiResults"][stage]
            summary = Path(saved["reportRoot"]) / "summary.json"
            call("need", call("sha", summary) == saved["summarySha256"], "REPLAY_SUMMARY_CHANGED:" + stage)
            observed = verify_mode(context, stage, summary, saved_record=saved, run_record=runs[0], replay=True)
            call("need", all(saved.get(key) == value for key, value in observed.items()),
                 "REPLAY_GUI_VERDICT_CHANGED:" + stage)
        else:
            observed = verify_stage(context, stage)
            call("need", all(ledger.get(key) == value for key, value in observed.items()),
                 "REPLAY_STAGE_VERDICT_CHANGED:" + stage)
        results[stage] = observed
    return {"schema": "reverie.registered-run.saved-replay.v1", "stages": results,
            "verdictsMatchOriginal": True, "sourceLedger": str(ledger_path),
            "observations": {"regexWorkerOwnership": "original saved ledger observation; no current PID query"}}
