"""Commit-independent projection of a reviewed registration contract.

Source snapshots and evidence bindings remain in the immutable registration.
This narrower document lets a rehearsal survive a docs-only preparation commit.
There is deliberately no recursive removal of hash/time fields: fixture hashes,
deadlines and exact user confirmations are part of the real test contract.
"""
from __future__ import annotations

from copy import deepcopy
import hashlib
import json
from typing import Any, Mapping


SCHEMA = "reverie.registered-run.contract.v1"

# Explicit runtime/acceptance data only. Source/provenance metadata, derived
# artifact references, registration IDs, raw-output bindings and timestamps do
# not describe what the registered engine must run and check.
CONFIG_FIELDS = (
    "runKind", "sequence", "budgets", "timeoutsSeconds", "stopOnFirstFailure", "retries",
    "pythonTargets", "nodeTests", "frontendTests", "nativeTargets", "nativeExecutionOrder",
    "guiModes", "requiredGuiModes", "candidateName", "candidateDirectory", "cmakeDirectory", "adoptCandidate",
    "python", "node", "ctest", "localSdk", "nodeIdentityReport", "nativeSelector", "nativeMessageCap",
    "expectedPythonIdentities", "expectedPythonCount", "expectedPythonByFile", "expectedNodeNames",
    "expectedFrontendNames", "expectedNativeIdentities", "expectedNativeTotals", "expectedUnitCounts",
    "addedPythonIdentities", "addedNodeNames", "addedFrontendNames", "addedNativeIdentities", "modifiedNativeIdentities",
    "frontendUnit", "gui", "injectionGui", "regexGui", "entryGui", "personaGui", "candidateGui", "settingsGui",
    "archiveControlReadinessContract", "budgetContract", "budgetContractSha256",
    "candidateBatchContract", "candidateBatchContractSha256", "defaultPointerPolicy", "developmentGate",
    "directoryDiagnosticsContract", "directoryReadsByCase", "entryRestartStartContract", "entrySettingsContract",
    "forcedCleanupContract", "nativeEvidenceContract", "nativeFocusEvidenceContract",
    "nativeInjectionDepthEvidenceContract", "nativeInjectionHitEvidenceContract", "nativeInjectionNavigationEvidenceContract",
    "nativeRegexEvidenceContract", "personaRowInputContract", "pinContract", "pinContractSha256", "pinScreenshots",
    "regexWorkerCleanupContract", "reportRootSnapshotContract", "settingsContract", "summaryViewContract",
    "batchDeleteFixture", "replyStartFixture", "settingsReplyStartFixture", "pairedControlReceipt",
    "batchDeleteDiagnostics", "controlPointerCleanupDiagnostic", "memoryFeedbackProbeDiagnostics",
    "pairedControlReceiptDiagnostics", "summaryAcquisitionDiagnostics", "summaryInputProbeDiagnostics", "summaryViewDiagnostics",
    "testAuditPaths", "protectedTrackedData", "memoryActionContract", "cardExportContract", "cardEditContract",
    "previewWorkspaceContract", "previewWorkspaceChecks", "previewUpgradeBaseline",
)

AUDIT_FIELDS = (
    "schema", "signedChanges", "otherChanges", "changedFiles", "confirmationsAccepted", "rejectedChangeIds",
    "registrationAllowed", "signedRuntimeCases", "staticOnly", "testsExecuted", "semantics",
)


def registration_contract(config: Mapping[str, Any], manifest: Mapping[str, Any], identity_diff: Mapping[str, Any],
                          audit: Mapping[str, Any], local_summary: Mapping[str, Any],
                          historical: Mapping[str, str], *, code_tree_hash: str | None) -> dict:
    runtime = {key: deepcopy(config[key]) for key in CONFIG_FIELDS if key in config}
    conclusions = {key: deepcopy(audit[key]) for key in AUDIT_FIELDS if key in audit}
    # A whole-document direction hash is meaningful when it authorized a real
    # signed-test change. Merely supplying an unused direction document must
    # not bind the registration to an incidental documentation commit.
    if audit.get("signedChanges") or audit.get("confirmationsAccepted") or config.get("confirmedTestChanges"):
        conclusions["directionDocument"] = deepcopy(audit.get("directionDocument"))
        runtime["testChangeDirectionDocument"] = deepcopy(config.get("testChangeDirectionDocument"))
        runtime["confirmedTestChanges"] = deepcopy(config.get("confirmedTestChanges", []))
    gui = local_summary["requiredGuiRuns"]
    return {
        "schema": SCHEMA,
        "runtime": runtime,
        "expectedIdentities": {key: deepcopy(manifest[key]) for key in
                               ("schema", "framework", "cases", "counts", "allPassed") if key in manifest},
        "identityDiff": deepcopy(dict(identity_diff)),
        "testChangeAuditConclusions": conclusions,
        "localRunSequences": {"unit": local_summary["unitRun"]["sequence"],
                              "requiredGui": {mode: record["sequence"] for mode, record in gui.items()}},
        "codeTreeHash": code_tree_hash,
        "historicalEvidence": deepcopy(dict(historical)),
    }


def contract_sha256(contract: Mapping[str, Any]) -> str:
    payload = (json.dumps(contract, sort_keys=True, ensure_ascii=False, allow_nan=False) + "\n").encode()
    return hashlib.sha256(payload).hexdigest()
