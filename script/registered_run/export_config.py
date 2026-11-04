"""Export the passed formal registration as reusable, data-only run config.

This exporter reads JSON evidence. It never imports a report's Python runner.
The unmodified registration and actual commands remain available for an exact
equivalence audit; executable stage commands point to tracked tools.
"""

from __future__ import annotations

from copy import deepcopy
import hashlib
import json
from pathlib import Path

from .baseline import LEGACY_SCHEMA, REGISTRATION_SCHEMA, load_signed_baseline
from .preview import stage_budget


CONFIG_SCHEMA = "reverie.registered-run.config.v1"
BASELINE_REPORT = ".tools/reports/p1-worldbook-injection-r1-20261026"
STAGE_BUDGETS = {
    "sdk-build": "sdkBuild", "python-unit": "pythonBatch",
    "node-unit": "nodeBatch", "frontend-unit": "frontendBatch",
    "native-unit": "nativeBatch", "injection-check": "injectionCheck",
    "regex-check": "regexCheck", "entry-check": "entryCheck",
    "persona-check": "personaCheck", "candidate-check": "candidateCheck",
    "ordinary-check": "ordinaryCheck", "settings-check": "settingsCheck",
}


def _load(path):
    def pairs(items):
        result = {}
        for name, value in items:
            if name in result:
                raise ValueError("DUPLICATE_JSON_KEY:" + name)
            result[name] = value
        return result
    return json.loads(Path(path).read_text(), object_pairs_hook=pairs,
                      parse_constant=lambda value: (_ for _ in ()).throw(
                          ValueError("NONFINITE_JSON:" + value)))


def export_baseline(report_dir, root=None):
    """Return config from actual passed evidence, without executing any source."""
    report_dir = Path(report_dir).absolute()
    root = Path(root).absolute() if root is not None else report_dir.parents[2]
    effective, metadata = load_signed_baseline(root, report_dir)
    ledger = _load(report_dir / "run-ledger.json")
    verification = metadata["_verification"]
    if hashlib.sha256((report_dir / "run-ledger.json").read_bytes()).hexdigest() != verification["ledgerSha256"]:
        raise ValueError("BASELINE_LEDGER_CHANGED_DURING_EXPORT")
    if ledger.get("passed") is not True:
        raise ValueError("BASELINE_NOT_PASSED")
    runs = ledger.get("runs", [])
    if [row["id"] for row in runs] != effective["sequence"]:
        raise ValueError("BASELINE_STAGE_ORDER_CHANGED")
    if any(row.get("exitCode") != 0 or row.get("state") != "completed" for row in runs):
        raise ValueError("BASELINE_STAGE_NOT_PASSED")
    # Preserve an explicit memoryActionContract when the adopted run has one.
    # Do not upgrade an older run while exporting its acceptance data.
    config = deepcopy(effective)
    config.update({"configSchema": CONFIG_SCHEMA, "runKind": "formal",
                   "adoptCandidate": True})
    config["baselineSource"] = {
        "report": str(report_dir.relative_to(root)),
        "registrationSha256": verification["registrationSha256"],
        "ledgerSha256": verification["ledgerSha256"],
        "sourceHead": ledger["sourceHead"],
        "metadataSchema": metadata["schema"],
        "verification": deepcopy(metadata["_verification"]),
        "publicResult": metadata["_verification"]["publicResult"]["path"],
        "publicResultSha256": metadata["_verification"]["publicResult"]["sha256"],
    }
    config["stages"] = []
    for row in runs:
        stage = row["id"]
        command = deepcopy(row["command"])
        if stage == "native-unit" and metadata["schema"] == LEGACY_SCHEMA:
            # Report wrappers are evidence only. Future execution uses tracked code.
            command[-1] = str(root / "script/registered_run/native_stage.py")
        config["stages"].append({
            "id": stage, "budget": stage_budget(stage, STAGE_BUDGETS),
            "timeoutSeconds": effective["timeoutsSeconds"][stage],
            "command": command, "baselineCommand": deepcopy(row["command"]),
            "cwd": str(root / "frontend" if stage == "frontend-unit" else root),
        })
    return config


def equivalence(config, registration, ledger):
    """List every baseline difference; empty means the retained data is equal."""
    retained = registration
    if registration.get("schema") == REGISTRATION_SCHEMA:
        retained = {key: registration[key] for key in
                    ("registrationId", "sourceHead", "runKind", "adoptCandidate", "sequence", "budgets",
                     "timeoutsSeconds", "candidateName", "candidateDirectory", "cmakeDirectory")}
        if "previewWorkspaceContract" in registration:
            retained["previewWorkspaceContract"] = registration["previewWorkspaceContract"]
        if registration.get("previewWorkspaceContract") in ("v3", "v4"):
            retained["previewWorkspaceChecks"] = registration.get("previewWorkspaceChecks")
        if registration.get("previewWorkspaceContract") == "v4":
            retained["previewUpgradeBaseline"] = registration.get("previewUpgradeBaseline")
    differences = ["registration." + key for key, value in retained.items()
                   if config.get(key) != value]
    if [stage["id"] for stage in config.get("stages", [])] != registration["sequence"]:
        differences.append("stages.order")
    for stage, run in zip(config.get("stages", []), ledger["runs"]):
        if stage.get("baselineCommand") != run["command"]:
            differences.append(stage["id"] + ".baselineCommand")
        if stage.get("timeoutSeconds") != run["timeoutSeconds"]:
            differences.append(stage["id"] + ".timeoutSeconds")
        if stage.get("budget") != stage_budget(run["id"], STAGE_BUDGETS):
            differences.append(stage["id"] + ".budget")
    return differences


def write_baseline(report_dir, output, root=None):
    config = export_baseline(report_dir, root)
    with Path(output).open("x", encoding="utf-8") as stream:
        stream.write(json.dumps(config, ensure_ascii=False, indent=2) + "\n")
    return config
