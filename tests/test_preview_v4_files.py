"""V4 transport only: unchanged business fixtures, bounded per-step files."""
from copy import deepcopy
import json

import pytest

from script import check_preview_upgrade as producer
from script.registered_run import preview, preview_v4, preview_v4_files as files, stages
from script.registered_run.modes.context import RunContext
from tests.test_registered_run_preview_v4 import value_v4, derive, previous_input, v4_config
from tests.test_preview_memory_seed import product_value
from tests.test_registered_run_preview import workspace


def saved(directory, *, product=True):
    directory.mkdir(mode=0o700)
    value = product_value(directory.resolve()) if product else value_v4(directory.resolve())
    result = files.write_bundle(directory, value, {"seed": "complete", "cleanup": "complete"}, write_json=producer.smoke.write_json)
    assert result["passed"] is True
    summary = json.loads((directory / "summary.json").read_text())
    raw = json.loads((directory / "observations.json").read_text())
    expanded, hydrated, refs = files.read_bundle(directory, summary, raw)
    assert derive(expanded)["checks"] == 9 and expanded["observations"] == value["observations"]
    assert hydrated["observations"] == value["observations"] and len(refs) == 8
    return summary, raw


@pytest.mark.parametrize("product", [False, True])
def test_split_v4_roundtrip_preserves_every_observation_and_business_verdict(tmp_path, product):
    directory = tmp_path / "report"
    summary, raw = saved(directory, product=product)
    note = json.loads((directory / files.RESULT).read_text())
    assert note["passed"] is True and note["firstErrorCode"] is None and note["evidenceStatus"] == "complete"
    assert note["steps"]["cleanup"] == "complete"
    assert all((directory / row["path"]).stat().st_size == row["bytes"] <= 256 * 1024 for key, row in raw["observations"].items() if key in files.PARTS)
    assert (directory / "summary.json").stat().st_size < 16 * 1024
    assert summary["observations"] == raw["observations"]


def test_small_result_exists_before_large_writes_and_preserves_business_first_error(tmp_path):
    value = value_v4(tmp_path.resolve()); value.update(passed=False, error="FIRST_CAUSE: original operation failed", checks=[])
    called = []
    def failed(path, content):
        note = json.loads((tmp_path / files.RESULT).read_text())
        assert note["firstErrorCode"] == "FIRST_CAUSE" and note["cleanup"] == value["cleanup"]
        called.append(path.name)
        raise OSError("synthetic evidence write failure")
    result = files.write_bundle(tmp_path, value, {"seed": "failed", "cleanup": "complete"}, write_json=failed)
    note = json.loads((tmp_path / files.RESULT).read_text())
    assert called and result["passed"] is False and result["error"] == value["error"]
    assert note["firstErrorCode"] == "FIRST_CAUSE" and note["evidenceErrorCode"] == "PREVIEW_V4_EVIDENCE_WRITE_FAILED"
    assert note["passed"] is False and note["evidenceStatus"] == "failed"


@pytest.mark.parametrize("failing_name", ["seed.json", "observations.json", "summary.json"])
def test_small_result_survives_each_large_write_failure(tmp_path, failing_name):
    value = value_v4(tmp_path.resolve())
    def fail(path, content):
        assert (tmp_path / files.RESULT).is_file()
        if path.name == failing_name:
            raise OSError("synthetic write failure")
        return producer.smoke.write_json(path, content)
    result = files.write_bundle(tmp_path, value, {"cleanup": "complete"}, write_json=fail)
    note = json.loads((tmp_path / files.RESULT).read_text())
    assert result["passed"] is False and note["passed"] is False
    assert note["firstErrorCode"] == "PREVIEW_V4_EVIDENCE_WRITE_FAILED"
    assert note["evidenceStatus"] == "failed" and note["evidenceBytes"]["seed"] > 0


def test_small_failed_business_result_is_written_with_no_fabricated_success(tmp_path):
    value = value_v4(tmp_path.resolve()); value.update(passed=False, error="ORIGINAL_BACKEND_ERROR", checks=[])
    result = files.write_bundle(tmp_path, value, {"seed": "failed", "cleanup": "complete"}, write_json=producer.smoke.write_json)
    note = json.loads((tmp_path / files.RESULT).read_text())
    assert result["passed"] is False and note["businessPassed"] is False and note["firstErrorCode"] == "ORIGINAL_BACKEND_ERROR"
    assert note["cleanup"] == value["cleanup"]


def test_individual_oversize_stops_before_any_parts_and_reports_all_component_bytes(tmp_path):
    value = value_v4(tmp_path.resolve()); value["observations"]["seed"]["oversize"] = "x" * (256 * 1024)
    result = files.write_bundle(tmp_path, value, {"cleanup": "complete"}, write_json=producer.smoke.write_json)
    note = json.loads((tmp_path / files.RESULT).read_text())
    assert result["passed"] is False and result["error"] == "PREVIEW_V4_EVIDENCE_PART_TOO_LARGE:seed"
    assert note["firstErrorCode"] == result["error"] and note["evidenceBytes"]["seed"] > 256 * 1024
    assert set(note["evidenceBytes"]) == set(files.PARTS) and not (tmp_path / "evidence").exists()


@pytest.mark.parametrize("change,reason", [
    ("missing", "PREVIEW_V4_PART_FILE_SET"), ("extra", "PREVIEW_V4_PART_FILE_COUNT"),
    ("tamper", "PREVIEW_V4_PART_HASH:seed"), ("bytes", "PREVIEW_V4_PART_BYTES:seed"),
    ("path", "PREVIEW_V4_PART_REFERENCE"), ("note", "PREVIEW_V4_RESULT_CHANGED"),
])
def test_missing_extra_changed_and_unbound_split_files_are_rejected(tmp_path, change, reason):
    directory = tmp_path / "report"; summary, raw = saved(directory)
    if change == "missing": (directory / "evidence/seed.json").unlink()
    if change == "extra": (directory / "evidence/unbound.json").write_text("{}")
    if change == "tamper":
        path = directory / "evidence/seed.json"; payload = path.read_bytes()
        assert b"seed" in payload
        path.write_bytes(payload.replace(b'"seed"', b'"seEd"', 1))
    if change == "bytes":
        raw["observations"]["seed"]["bytes"] += 1
        summary["observations"]["seed"]["bytes"] += 1
    if change == "path":
        raw["observations"]["seed"]["path"] = "../not-opened.json"
        summary["observations"]["seed"]["path"] = "../not-opened.json"
    if change == "note":
        path = directory / files.RESULT; path.write_bytes(path.read_bytes() + b" ")
    with pytest.raises(preview.PreviewError, match=reason): files.read_bundle(directory, summary, raw)


def test_early_failure_record_has_no_invented_cleanup_or_identity(tmp_path):
    files.failure_record(tmp_path, "PREVIEW_V4_LIFECYCLE_FAILED", {"lifecycle": "started"})
    value = json.loads((tmp_path / files.RESULT).read_text())
    assert value["passed"] is False and value["firstErrorCode"] == "PREVIEW_V4_LIFECYCLE_FAILED"
    assert value["cleanup"] is None and value["sourceHead"] is None and value["evidenceBytes"] == {}


def test_v4_saved_consumer_authenticates_all_part_files_with_original_business_proof(workspace):
    env = workspace; env.config = v4_config()
    spec, = stages.plan(env.root, env.report, env.config, env.environment, "gui", ["preview"])
    runtime = stages.load_runtime_config(env.report); directory = env.report / preview.STAGE
    directory.mkdir()
    build = env.root / runtime["candidateDirectory"] / "build.json"
    value = value_v4(env.scratch, candidate=build.parent.name, build_sha=preview_v4.sha(build.read_bytes()))
    assert files.write_bundle(directory, value, {"cleanup": "complete"}, write_json=producer.smoke.write_json)["passed"]
    _, documents = previous_input()
    for role, filename in preview_v4.INPUT_COPIES.items(): (directory / filename).write_bytes(documents[role])
    record = {"previewIsolationRoot": str(env.scratch), "command": list(spec.command), "cwd": str(env.root)}
    proof = preview.verify_saved(RunContext(env.root, env.report, runtime), directory / "summary.json", record)
    assert len(proof["rawReportBinding"]) == 12 and proof["previewWorkspaceEvidence"]["checks"] == 9


def test_early_producer_exception_keeps_a_small_record(tmp_path, monkeypatch):
    args = type("Args", (), {"report_dir": tmp_path})()
    def failed(*_): raise RuntimeError("FIRST_NATIVE_FAILURE")
    monkeypatch.setattr(producer, "_run", failed)
    assert producer.run(args) == 1
    assert json.loads((tmp_path / files.RESULT).read_text())["firstErrorCode"] == "FIRST_NATIVE_FAILURE"


# The existing split-v1 tests above intentionally remain byte-for-byte intact.
def saved_current(directory, *, product=True):
    directory.mkdir(mode=0o700)
    value = product_value(directory.resolve()) if product else value_v4(directory.resolve())
    assert files.write_current_bundle(directory, value, {"cleanup": "complete"}, write_json=producer.smoke.write_json)["passed"]
    summary = json.loads((directory / "summary.json").read_text())
    raw = json.loads((directory / "observations.json").read_text())
    expanded, hydrated, refs = files.read_bundle(directory, summary, raw)
    assert derive(expanded)["checks"] == 9 and expanded["observations"] == value["observations"]
    assert hydrated["observations"] == value["observations"] and len(refs) == 9
    return summary, raw, value


@pytest.mark.parametrize("product", [False, True])
def test_current_eight_file_layout_exactly_restores_both_format_checks(tmp_path, product):
    directory = tmp_path / "report"; summary, raw, value = saved_current(directory, product=product)
    assert summary["storage"] == raw["storage"] == "split-v2"
    assert set(raw["observations"]["formatProtection"]) == {"launcher", "host"}
    assert len(list((directory / "evidence").iterdir())) == 8
    note = json.loads((directory / files.RESULT).read_text())
    assert set(note["evidenceBytes"]) == set(files.CURRENT_PARTS)
    for check in ("launcher", "host"):
        path = directory / ("evidence/formatProtection-" + check + ".json")
        stored = json.loads(path.read_text())
        assert stored == {"role": "formatProtection-" + check, "observation": value["observations"]["formatProtection"][check]}
        assert len(path.read_bytes()) == note["evidenceBytes"]["formatProtection-" + check] <= 256 * 1024


@pytest.mark.parametrize("check", ["launcher", "host"])
def test_current_format_check_missing_part_rejects_after_valid_baseline(tmp_path, check):
    directory = tmp_path / "report"; summary, raw, _ = saved_current(directory)
    (directory / ("evidence/formatProtection-" + check + ".json")).unlink()
    with pytest.raises(preview.PreviewError, match="PREVIEW_V4_PART_FILE_SET"):
        files.read_bundle(directory, summary, raw)


def test_current_format_check_extra_file_rejects_at_eight_file_boundary(tmp_path):
    directory = tmp_path / "report"; summary, raw, _ = saved_current(directory)
    (directory / "evidence/formatProtection-extra.json").write_text("{}")
    with pytest.raises(preview.PreviewError, match="PREVIEW_V4_PART_FILE_COUNT"):
        files.read_bundle(directory, summary, raw)


def test_current_format_check_swapped_references_rejects(tmp_path):
    directory = tmp_path / "report"; summary, raw, _ = saved_current(directory)
    for value in (summary, raw):
        rows = value["observations"]["formatProtection"]
        rows["launcher"], rows["host"] = rows["host"], rows["launcher"]
    with pytest.raises(preview.PreviewError, match="PREVIEW_V4_PART_REFERENCE"):
        files.read_bundle(directory, summary, raw)


def test_current_format_check_swapped_bytes_reject_even_after_rebinding_transport(tmp_path):
    directory = tmp_path / "report"; summary, raw, _ = saved_current(directory)
    launcher = directory / "evidence/formatProtection-launcher.json"
    host = directory / "evidence/formatProtection-host.json"
    left, right = launcher.read_bytes(), host.read_bytes()
    launcher.write_bytes(right); host.write_bytes(left)
    note_path = directory / files.RESULT
    note = json.loads(note_path.read_text())
    for check in ("launcher", "host"):
        payload = (directory / ("evidence/formatProtection-" + check + ".json")).read_bytes()
        for value in (summary, raw):
            value["observations"]["formatProtection"][check].update(bytes=len(payload), sha256=files.sha(payload))
        note["evidenceBytes"]["formatProtection-" + check] = len(payload)
    payload = files.encoded(note); note_path.write_bytes(payload)
    for value in (summary, raw): value["resultBinding"].update(bytes=len(payload), sha256=files.sha(payload))
    with pytest.raises(preview.PreviewError, match="PREVIEW_V4_PART_ROLE"):
        files.read_bundle(directory, summary, raw)


@pytest.mark.parametrize("check", ["launcher", "host"])
def test_current_format_check_tampering_rejects(tmp_path, check):
    directory = tmp_path / "report"; summary, raw, _ = saved_current(directory)
    path = directory / ("evidence/formatProtection-" + check + ".json")
    value = json.loads(path.read_text())
    value["observation"]["stderr"] = value["observation"]["stderr"].lower()
    path.write_bytes(files.encoded(value))
    with pytest.raises(preview.PreviewError, match="PREVIEW_V4_PART_HASH:formatProtection-" + check):
        files.read_bundle(directory, summary, raw)


@pytest.mark.parametrize("check", ["launcher", "host"])
def test_current_format_check_wrong_byte_count_rejects(tmp_path, check):
    directory = tmp_path / "report"; summary, raw, _ = saved_current(directory)
    for value in (summary, raw): value["observations"]["formatProtection"][check]["bytes"] += 1
    with pytest.raises(preview.PreviewError, match="PREVIEW_V4_PART_BYTES:formatProtection-" + check):
        files.read_bundle(directory, summary, raw)


@pytest.mark.parametrize("check", ["launcher", "host"])
def test_current_single_format_check_oversize_stops_without_expanding_limit(tmp_path, check):
    value = product_value(tmp_path.resolve())
    value["observations"]["formatProtection"][check]["stderr"] = "x" * (256 * 1024)
    result = files.write_current_bundle(tmp_path, value, {"cleanup": "complete"}, write_json=producer.smoke.write_json)
    note = json.loads((tmp_path / files.RESULT).read_text())
    assert result["passed"] is False and note["passed"] is False
    assert note["firstErrorCode"] == "PREVIEW_V4_EVIDENCE_PART_TOO_LARGE:formatProtection-" + check
    assert note["evidenceBytes"]["formatProtection-" + check] > 256 * 1024
    assert len(note["evidenceBytes"]) == 8 and not (tmp_path / "evidence").exists()


def test_current_saved_consumer_binds_thirteen_references_and_original_nine_checks(workspace):
    env = workspace; env.config = v4_config()
    spec, = stages.plan(env.root, env.report, env.config, env.environment, "gui", ["preview"])
    runtime = stages.load_runtime_config(env.report); directory = env.report / preview.STAGE
    directory.mkdir()
    build = env.root / runtime["candidateDirectory"] / "build.json"
    value = value_v4(env.scratch, candidate=build.parent.name, build_sha=preview_v4.sha(build.read_bytes()))
    assert files.write_current_bundle(directory, value, {"cleanup": "complete"}, write_json=producer.smoke.write_json)["passed"]
    _, documents = previous_input()
    for role, filename in preview_v4.INPUT_COPIES.items(): (directory / filename).write_bytes(documents[role])
    record = {"previewIsolationRoot": str(env.scratch), "command": list(spec.command), "cwd": str(env.root)}
    result = preview.verify_saved(RunContext(env.root, env.report, runtime), directory / "summary.json", record)
    assert len(result["rawReportBinding"]) == 13 and result["previewWorkspaceEvidence"]["checks"] == 9
