"""Bounded v4 evidence transport. Business proof rules remain in preview_v4."""
from copy import deepcopy
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import uuid

from . import preview as base

STORAGE = "split-v1"
CURRENT_STORAGE = "split-v2"
MAX_BYTES = 256 * 1024
MAX_RESULT_BYTES = 16 * 1024
PARTS = ("seed", "modelRequests", "upgrade", "restore", "rollback", "formatProtection", "diagnostics")
CURRENT_PARTS = ("seed", "modelRequests", "upgrade", "restore", "rollback", "formatProtection-launcher", "formatProtection-host", "diagnostics")
MAX_PART_FILES = 8
RESULT = "run-result.json"


def _parts(storage):
    base.need(storage in (STORAGE, CURRENT_STORAGE), "PREVIEW_V4_STORAGE_VERSION")
    return PARTS if storage == STORAGE else CURRENT_PARTS


def _reference(observations, key):
    if key in ("formatProtection-launcher", "formatProtection-host"):
        return observations["formatProtection"][key.split("-", 1)[1]]
    return observations[key]


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode()


def sha(payload):
    return hashlib.sha256(payload).hexdigest()


def error_code(error):
    if not error:
        return None
    matched = re.match(r"[A-Z][A-Z0-9_]*(?::[A-Z][A-Z0-9_]*)*", str(error))
    return matched.group() if matched else "PREVIEW_V4_OPERATION_ERROR"


def _small(path, value, *, replace=False):
    """Own small record survives failures in the large-evidence writer."""
    payload = encoded(value)
    base.need(len(payload) <= MAX_RESULT_BYTES, "PREVIEW_V4_RESULT_RECORD_TOO_LARGE")
    destination = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp") if replace else path
    if replace:
        info = path.lstat()
        base.need(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == os.getuid(), "PREVIEW_V4_RESULT_RECORD_UNSAFE")
    descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "wb") as stream:
        stream.write(payload); stream.flush(); os.fsync(stream.fileno())
    if replace:
        os.replace(destination, path)
    return payload


def failure_record(directory, error, progress):
    """Early failures have no asserted cleanup outcome or invented identity."""
    value = {"schema": "reverie.preview.upgrade-result.v1", "sourceHead": None, "candidate": None, "buildManifestSha256": None,
             "businessPassed": False, "passed": False, "firstErrorCode": error_code(error), "evidenceErrorCode": None,
             "steps": deepcopy(progress), "cleanup": None, "evidenceBytes": {}, "evidenceStatus": "failed"}
    _small(Path(directory) / RESULT, value)


def write_current_bundle(directory, result, progress, *, write_json):
    return write_bundle(directory, result, progress, write_json=write_json, storage=CURRENT_STORAGE)


def write_bundle(directory, result, progress, *, write_json, storage=STORAGE):
    """Called after cleanup. Never raises a large-write error over the first error."""
    directory = Path(directory)
    result = deepcopy(result)
    observations = result["observations"]
    layout = _parts(storage)
    parts = {}
    for key in layout:
        if key in ("formatProtection-launcher", "formatProtection-host"):
            if "formatProtection" not in observations:
                continue
            section = observations["formatProtection"]
            base.need(isinstance(section, dict) and set(section).issubset({"launcher", "host"}), "PREVIEW_V4_FORMAT_PART_FIELDS")
            name = key.split("-", 1)[1]
            if name not in section:
                continue
            observation = section[name]
        elif key in observations:
            observation = observations[key]
        else:
            continue
        parts[key] = {"role": key, "observation": observation}
    sizes = {key: len(encoded(value)) for key, value in parts.items()}
    oversized = [key for key, size in sizes.items() if size > MAX_BYTES]
    business_error = result.get("error")
    storage_error = "PREVIEW_V4_EVIDENCE_PART_TOO_LARGE:" + oversized[0] if oversized else None
    first = error_code(business_error) or storage_error
    small = {"schema": "reverie.preview.upgrade-result.v1", "sourceHead": result["sourceHead"],
             "candidate": result["candidate"], "buildManifestSha256": result["buildManifestSha256"],
             "businessPassed": result["passed"], "passed": result["passed"] and not storage_error,
             "firstErrorCode": first, "evidenceErrorCode": storage_error,
             "steps": deepcopy(progress), "cleanup": deepcopy(result["cleanup"]),
             "evidenceBytes": sizes, "evidenceStatus": "failed" if oversized else "pending"}
    note = directory / RESULT
    _small(note, small)

    def fail(code):
        small.update(passed=False, evidenceStatus="failed", evidenceErrorCode=code)
        small["firstErrorCode"] = small["firstErrorCode"] or code
        _small(note, small, replace=True)
        result.update(passed=False, error=business_error or code, checks=[])
        print(json.dumps({"resultRecord": str(note), "firstErrorCode": small["firstErrorCode"],
                          "evidenceErrorCode": small["evidenceErrorCode"], "evidenceBytes": small["evidenceBytes"]}))
        return result

    if oversized:
        return fail(storage_error)
    try:
        evidence = directory / "evidence"
        evidence.mkdir(mode=0o700)
        bindings = {}
        for key, value in parts.items():
            payload = write_json(evidence / (key + ".json"), value)
            base.need(payload == encoded(value), "PREVIEW_V4_EVIDENCE_WRITE_BYTES")
            bindings[key] = {"path": "evidence/" + key + ".json", "bytes": len(payload), "sha256": sha(payload)}
        small["evidenceStatus"] = "complete"
        note_bytes = _small(note, small, replace=True)
        note_binding = {"path": RESULT, "bytes": len(note_bytes), "sha256": sha(note_bytes)}
        summary = deepcopy(result)
        indexed = {key: bindings.get(key, value) for key, value in observations.items()}
        if storage == CURRENT_STORAGE and "formatProtection" in observations:
            indexed["formatProtection"] = {name: bindings["formatProtection-" + name] for name in observations["formatProtection"]}
        summary.update(storage=storage, resultBinding=note_binding, observations=indexed)
        raw = {key: value for key, value in summary.items() if key not in ("schema", "contract", "passed", "checks", "error", "observationBinding")}
        raw["schema"] = "reverie.preview-workspace.observations.v4"
        for role, value in [("observations", raw), ("summary", summary)]:
            if len(encoded(value)) > MAX_BYTES:
                small["evidenceBytes"][role] = len(encoded(value))
            base.need(len(encoded(value)) <= MAX_BYTES, "PREVIEW_V4_EVIDENCE_INDEX_TOO_LARGE:" + role)
        payload = write_json(directory / "observations.json", raw)
        summary["observationBinding"] = {"path": "observations.json", "sha256": sha(payload), "bytes": len(payload)}
        if len(encoded(summary)) > MAX_BYTES:
            small["evidenceBytes"]["summary"] = len(encoded(summary))
        base.need(len(encoded(summary)) <= MAX_BYTES, "PREVIEW_V4_EVIDENCE_INDEX_TOO_LARGE:summary")
        write_json(directory / "summary.json", summary)
        return result
    except Exception as caught:
        code = str(caught) if str(caught).startswith("PREVIEW_V4_EVIDENCE_") else "PREVIEW_V4_EVIDENCE_WRITE_FAILED"
        return fail(code)


def read_bundle(directory, summary, raw):
    """Authenticate all saved files before hydrating the unchanged v4 proof."""
    directory = Path(directory)
    base.need(summary.get("storage") == raw.get("storage") and summary.get("contract") == "v4", "PREVIEW_V4_STORAGE_VERSION")
    layout = _parts(raw.get("storage"))
    base.need(summary.get("resultBinding") == raw.get("resultBinding"), "PREVIEW_V4_RESULT_BINDING")
    binding = raw.get("resultBinding")
    base._keys(binding, ("path", "bytes", "sha256"), "PREVIEW_V4_RESULT_BINDING")
    base.need(binding["path"] == RESULT and base._integer(binding["bytes"], 1) and binding["bytes"] <= MAX_RESULT_BYTES and base._sha(binding["sha256"]), "PREVIEW_V4_RESULT_BINDING")
    note, note_bytes = base._read_json(directory / RESULT, MAX_RESULT_BYTES)
    base.need(len(note_bytes) == binding["bytes"] and sha(note_bytes) == binding["sha256"], "PREVIEW_V4_RESULT_CHANGED")
    base._keys(note, ("schema", "sourceHead", "candidate", "buildManifestSha256", "businessPassed", "passed", "firstErrorCode",
                      "evidenceErrorCode", "steps", "cleanup", "evidenceBytes", "evidenceStatus"), "PREVIEW_V4_RESULT_FIELDS")
    base.need(note["schema"] == "reverie.preview.upgrade-result.v1" and note["businessPassed"] is True and note["passed"] is True and
              note["firstErrorCode"] is None and note["evidenceErrorCode"] is None and note["evidenceStatus"] == "complete" and
              note["cleanup"] == raw.get("cleanup") and all(note[k] == raw.get(k) for k in ("sourceHead", "candidate", "buildManifestSha256")), "PREVIEW_V4_RESULT_NOT_COMPLETE")
    base.need(isinstance(note["steps"], dict) and all(isinstance(k, str) and v in ("started", "complete", "failed") for k, v in note["steps"].items()), "PREVIEW_V4_RESULT_STEPS")
    observations = raw.get("observations")
    base.need(isinstance(observations, dict) and observations == summary.get("observations"), "PREVIEW_V4_INDEX_SUMMARY_MISMATCH")
    base.need(set(PARTS).issubset(observations) and len(layout) <= MAX_PART_FILES, "PREVIEW_V4_PART_COUNT")
    if raw["storage"] == CURRENT_STORAGE:
        base._keys(observations["formatProtection"], ("launcher", "host"), "PREVIEW_V4_FORMAT_PART_FIELDS")
    evidence = directory / "evidence"
    try:
        info = evidence.lstat()
    except FileNotFoundError:
        base.need(False, "PREVIEW_V4_PART_FILE_SET")
    base.need(stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode) and info.st_uid == os.getuid(), "PREVIEW_V4_PART_DIRECTORY")
    names = []
    with os.scandir(evidence) as entries:
        for entry in entries:
            names.append(entry.name)
            base.need(len(names) <= min(MAX_PART_FILES, len(layout)), "PREVIEW_V4_PART_FILE_COUNT")
    base.need(set(names) == {key + ".json" for key in layout}, "PREVIEW_V4_PART_FILE_SET")
    base.need(isinstance(note["evidenceBytes"], dict) and set(note["evidenceBytes"]) == set(layout), "PREVIEW_V4_PART_SIZES")
    expanded = deepcopy(observations)
    references = [binding]
    for key in layout:
        ref = _reference(observations, key)
        base._keys(ref, ("path", "bytes", "sha256"), "PREVIEW_V4_PART_REFERENCE")
        base.need(ref["path"] == "evidence/" + key + ".json" and base._integer(ref["bytes"], 1) and ref["bytes"] <= MAX_BYTES and
                  base._sha(ref["sha256"]), "PREVIEW_V4_PART_REFERENCE")
        part, payload = base._read_json(directory / ref["path"], MAX_BYTES)
        base.need(len(payload) == ref["bytes"] == note["evidenceBytes"][key], "PREVIEW_V4_PART_BYTES:" + key)
        base.need(sha(payload) == ref["sha256"], "PREVIEW_V4_PART_HASH:" + key)
        base._keys(part, ("role", "observation"), "PREVIEW_V4_PART_FIELDS")
        base.need(part["role"] == key, "PREVIEW_V4_PART_ROLE")
        if key in ("formatProtection-launcher", "formatProtection-host"):
            expanded["formatProtection"][key.split("-", 1)[1]] = part["observation"]
        else:
            expanded[key] = part["observation"]
        references.append(ref)
    output = []
    for value in (summary, raw):
        value = deepcopy(value); value.pop("storage"); value.pop("resultBinding"); value["observations"] = deepcopy(expanded); output.append(value)
    return (*output, references)
