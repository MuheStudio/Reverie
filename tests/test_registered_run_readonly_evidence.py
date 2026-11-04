"""Synthetic Fix2 evidence inputs; never read or alter historical app bundles."""
from __future__ import annotations

import ast
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
from types import SimpleNamespace

import pytest

from script.registered_run import registration as reg
from script.registered_run.engine import Engine
from script.registered_run.isolation import IsolationContext, IsolationError, canonical_directory
from script.registered_run.readonly import ReadOnlyFileError, readonly_regular_file
from script.registered_run.state import ensure_directory, exclusive_json, regular_file
from tests.test_registered_run_registration import dump, prepared


PRE_FIX_REVISION = "ed2d73363586c5147f71dae5ed7bc60cbf2b0989"
APP_REJECTION = "ISOLATION_APPLICATION_BUNDLE_FORBIDDEN"


def assert_reason(error, expected):
    assert str(error.value) == expected


def changed_stat(info, **changes):
    values = {name: getattr(info, name) for name in dir(info) if name.startswith("st_")}
    return SimpleNamespace(**{**values, **changes})


@pytest.fixture
def evidence(tmp_path):
    root = tmp_path.resolve() / "repository"
    bundle = root / ".tools/qt-candidates/archived/X.app"
    path = bundle / "Contents/Resources/historical.txt"
    path.parent.mkdir(parents=True)
    payload = b"synthetic immutable historical evidence\n"
    path.write_bytes(payload)
    digest = hashlib.sha256(payload).hexdigest()
    relative = str(path.relative_to(root))
    # Each negative starts with the same real, passing app-shaped input.
    assert reg._file_sha(root, path) == digest
    assert reg._historical_unchanged(root, {relative: digest}) == 1
    return SimpleNamespace(root=root, bundle=bundle, path=path, payload=payload,
                           digest=digest, relative=relative)


@pytest.fixture
def original_file_sha():
    """Load only the exact old functions into a separate test namespace.

    Git objects are read without checking out files or changing live modules.
    The original hash function keeps its original writable-check dependencies.
    """
    repository = Path(__file__).resolve().parents[1]
    namespace = {"Path": Path, "os": os, "stat": stat, "hashlib": hashlib}
    definitions = (
        ("script/registered_run/isolation.py", {"IsolationError", "canonical_directory"}),
        ("script/registered_run/state.py", {"StateError", "regular_file"}),
        ("script/registered_run/registration.py", {"RegistrationError", "_need", "_file_sha"}),
    )
    for filename, names in definitions:
        source = subprocess.run(
            ["git", "show", PRE_FIX_REVISION + ":" + filename], cwd=repository,
            check=True, capture_output=True, text=True, timeout=30,
        ).stdout
        nodes = [node for node in ast.parse(source, filename=filename).body
                 if isinstance(node, (ast.ClassDef, ast.FunctionDef)) and node.name in names]
        assert {node.name for node in nodes} == names
        isolated = ast.Module(body=nodes, type_ignores=[])
        exec(compile(isolated, PRE_FIX_REVISION + ":" + filename, "exec"), namespace)
    return SimpleNamespace(hash=namespace["_file_sha"], isolation_error=namespace["IsolationError"])


def test_app_history_is_hashed_and_included_in_frozen_registration_materials(prepared):
    value = prepared
    path = value.root / ".tools/qt-candidates/archived/X.app/Contents/Info.plist"
    path.parent.mkdir(parents=True)
    payload = b"synthetic historical application metadata\n"
    path.write_bytes(payload)
    relative = str(path.relative_to(value.root))
    digest = hashlib.sha256(payload).hexdigest()
    value.baseline["historicalEvidence"][relative] = digest
    dump(value.baseline_dir / "registration.json", value.baseline)
    value.refresh_baseline_binding()

    assert reg._historical_unchanged(value.root, {relative: digest}) == 1
    result = reg.freeze(value.root, "process-tools", value.config, value.report)

    manifest_path = value.report / "historical-evidence.json"
    manifest = json.loads(manifest_path.read_text())
    frozen_config = json.loads((value.report / "config.json").read_text())
    manifest_digest = hashlib.sha256(manifest_path.read_bytes()).hexdigest()
    assert manifest[relative] == digest
    assert manifest["historical.txt"] == value.baseline["historicalEvidence"]["historical.txt"]
    assert frozen_config["historicalEvidence"] == manifest
    assert frozen_config["historicalEvidenceManifest"] == {
        "path": str(manifest_path.relative_to(value.root)),
        "sha256": manifest_digest, "bytes": manifest_path.stat().st_size,
    }
    assert result["artifacts"]["historical-evidence.json"] == manifest_digest


def test_historical_snapshot_discovers_real_app_directories_in_the_baseline_report(prepared):
    value = prepared
    before = reg._historical_snapshot(value.root, value.baseline_dir, value.baseline, value.config)
    path = value.baseline_dir / "raw/X.app/Contents/Info.plist"
    path.parent.mkdir(parents=True)
    payload = b"synthetic report-contained application metadata\n"
    path.write_bytes(payload)
    relative = str(path.relative_to(value.root))
    assert relative not in value.baseline["historicalEvidence"]
    after = reg._historical_snapshot(value.root, value.baseline_dir, value.baseline, value.config)
    assert after == {**before, relative: hashlib.sha256(payload).hexdigest()}


def test_exact_pre_fix_hash_rejects_the_same_app_shape(evidence, original_file_sha):
    ordinary = evidence.root / "ordinary-history.txt"
    ordinary.write_bytes(evidence.payload)
    assert original_file_sha.hash(ordinary) == evidence.digest
    with pytest.raises(original_file_sha.isolation_error) as error:
        original_file_sha.hash(evidence.path)
    assert_reason(error, APP_REJECTION)
    assert reg._file_sha(evidence.root, evidence.path) == evidence.digest


def test_app_reference_and_checked_reference_share_the_readonly_hash(evidence):
    expected = {"path": evidence.relative, "sha256": evidence.digest, "bytes": len(evidence.payload)}
    assert reg._reference(evidence.root, evidence.path) == expected
    assert reg._checked_reference(evidence.root, expected, parent=evidence.path.parent) == (evidence.path, expected)


def test_app_history_hash_mismatch_keeps_the_historical_rejection(evidence):
    evidence.path.write_bytes(evidence.payload + b"changed\n")
    with pytest.raises(reg.RegistrationError) as error:
        reg._historical_unchanged(evidence.root, {evidence.relative: evidence.digest})
    assert_reason(error, "HISTORICAL_EVIDENCE_CHANGED:" + evidence.relative)


def test_readonly_rejects_a_symlink_app_directory(evidence):
    target = evidence.bundle.with_name("real-bundle")
    evidence.bundle.rename(target)
    evidence.bundle.symlink_to(target.name, target_is_directory=True)
    with pytest.raises(ReadOnlyFileError) as error:
        reg._file_sha(evidence.root, evidence.path)
    assert_reason(error, "READ_ONLY_PARENT_SYMLINK_FORBIDDEN")


def test_readonly_rejects_a_symlink_file(evidence):
    target = evidence.path.with_name("real-history.txt")
    evidence.path.rename(target)
    evidence.path.symlink_to(target.name)
    with pytest.raises(ReadOnlyFileError) as error:
        reg._file_sha(evidence.root, evidence.path)
    assert_reason(error, "READ_ONLY_FILE_SYMLINK_FORBIDDEN")


def test_readonly_rejects_a_hardlinked_file(evidence):
    os.link(evidence.path, evidence.path.with_name("history-alias.txt"))
    with pytest.raises(ReadOnlyFileError) as error:
        reg._file_sha(evidence.root, evidence.path)
    assert_reason(error, "READ_ONLY_HARDLINK_FORBIDDEN")


def test_readonly_rejects_a_file_outside_the_repository(evidence):
    outside = evidence.root.parent / "outside.app/Contents/historical.txt"
    outside.parent.mkdir(parents=True)
    evidence.path.rename(outside)
    with pytest.raises(ReadOnlyFileError) as error:
        reg._file_sha(evidence.root, outside)
    assert_reason(error, "READ_ONLY_PATH_ESCAPES_ROOT")


def test_readonly_rejects_a_default_data_file(evidence):
    protected = evidence.root / "data/X.app/Contents/historical.txt"
    protected.parent.mkdir(parents=True)
    evidence.path.rename(protected)
    with pytest.raises(IsolationError) as error:
        reg._file_sha(evidence.root, protected)
    assert_reason(error, "ISOLATION_OVERLAPS_DEFAULT_DATA")


def test_readonly_rejects_a_relative_file_path(evidence):
    with pytest.raises(ReadOnlyFileError) as error:
        reg._file_sha(evidence.root, Path(evidence.relative))
    assert_reason(error, "READ_ONLY_PATH_NOT_ABSOLUTE")


def test_readonly_rejects_a_noncanonical_file_path(evidence):
    alias = evidence.root / ".." / evidence.root.name / evidence.relative
    with pytest.raises(ReadOnlyFileError) as error:
        reg._file_sha(evidence.root, alias)
    assert_reason(error, "READ_ONLY_PATH_NOT_CANONICAL")


@pytest.mark.parametrize("scope,reason", [
    ("file", "READ_ONLY_FILE_OWNER_MISMATCH"),
    ("parent", "READ_ONLY_PARENT_OWNER_MISMATCH"),
])
def test_readonly_rejects_changed_ownership_without_chown(evidence, monkeypatch, scope, reason):
    target = evidence.path if scope == "file" else evidence.path.parent
    original = Path.lstat

    def different_owner(path, *args, **kwargs):
        info = original(path, *args, **kwargs)
        return changed_stat(info, st_uid=info.st_uid + 1) if path == target else info

    monkeypatch.setattr(Path, "lstat", different_owner)
    with pytest.raises(ReadOnlyFileError) as error:
        reg._file_sha(evidence.root, evidence.path)
    assert_reason(error, reason)


def test_readonly_rejects_a_directory_in_place_of_the_file(evidence):
    evidence.path.unlink()
    evidence.path.mkdir()
    with pytest.raises(ReadOnlyFileError) as error:
        reg._file_sha(evidence.root, evidence.path)
    assert_reason(error, "READ_ONLY_NOT_REGULAR_FILE")


def test_readonly_rejects_a_parent_with_non_directory_metadata(evidence, monkeypatch):
    original = Path.lstat

    def changed_parent(path, *args, **kwargs):
        info = original(path, *args, **kwargs)
        if path == evidence.path.parent:
            return changed_stat(info, st_mode=stat.S_IFREG | stat.S_IMODE(info.st_mode))
        return info

    monkeypatch.setattr(Path, "lstat", changed_parent)
    with pytest.raises(ReadOnlyFileError) as error:
        reg._file_sha(evidence.root, evidence.path)
    assert_reason(error, "READ_ONLY_PARENT_NOT_DIRECTORY")


def test_readonly_hash_opens_with_no_follow(evidence, monkeypatch):
    original = os.open
    observed = []

    def opened(path, flags, *args, **kwargs):
        if path == evidence.path:
            observed.append(flags)
        return original(path, flags, *args, **kwargs)

    monkeypatch.setattr(reg.os, "open", opened)
    assert reg._file_sha(evidence.root, evidence.path) == evidence.digest
    assert len(observed) == 1
    assert observed[0] & os.O_NOFOLLOW
    assert observed[0] & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND) == 0


def test_readonly_hash_rejects_replacement_between_validation_and_open(evidence, monkeypatch):
    original = os.open
    replaced = []

    def opened(path, flags, *args, **kwargs):
        if path == evidence.path and not replaced:
            replacement = path.with_name("replacement.txt")
            replacement.write_bytes(evidence.payload)
            os.replace(replacement, path)
            replaced.append(True)
        return original(path, flags, *args, **kwargs)

    monkeypatch.setattr(reg.os, "open", opened)
    with pytest.raises(reg.RegistrationError) as error:
        reg._file_sha(evidence.root, evidence.path)
    assert_reason(error, "HISTORICAL_FILE_IDENTITY_CHANGED")
    assert replaced == [True]


def test_readonly_hash_rejects_a_change_after_read_before_descriptor_recheck(evidence, monkeypatch):
    original = os.fstat
    observations = []

    def inspected(descriptor):
        observations.append(descriptor)
        if len(observations) == 2:
            evidence.path.write_bytes(evidence.payload + b"changed during read\n")
        return original(descriptor)

    monkeypatch.setattr(reg.os, "fstat", inspected)
    with pytest.raises(reg.RegistrationError) as error:
        reg._file_sha(evidence.root, evidence.path)
    assert_reason(error, "HISTORICAL_FILE_CHANGED_DURING_HASH")
    assert len(observations) == 2


def test_readonly_hash_rejects_path_replacement_after_descriptor_recheck(evidence, monkeypatch):
    original = readonly_regular_file
    observations = []

    def checked(root, path):
        observations.append(path)
        if len(observations) == 2:
            replacement = path.with_name("replacement.txt")
            replacement.write_bytes(evidence.payload)
            os.replace(replacement, path)
        return original(root, path)

    monkeypatch.setattr(reg, "readonly_regular_file", checked)
    with pytest.raises(reg.RegistrationError) as error:
        reg._file_sha(evidence.root, evidence.path)
    assert_reason(error, "HISTORICAL_FILE_CHANGED_DURING_HASH")
    assert observations == [evidence.path, evidence.path]


@pytest.mark.parametrize("operation", ["canonical_directory", "ensure_directory", "exclusive_json", "regular_file"])
def test_writable_helpers_keep_the_app_guard(tmp_path, operation):
    base = tmp_path.resolve() / "ordinary-bundle"
    parent = base / "Contents"
    parent.mkdir(parents=True)
    existing = parent / "existing.json"
    existing.write_text("{}\n")

    def invoke(directory):
        if operation == "canonical_directory":
            return canonical_directory(directory)
        if operation == "ensure_directory":
            return ensure_directory(directory / "new-output")
        if operation == "exclusive_json":
            return exclusive_json(directory / "new.json", {"synthetic": True})
        return regular_file(directory / existing.name)

    invoke(parent)
    if operation == "exclusive_json":
        (parent / "new.json").unlink()
    bundle = base.with_name("X.app")
    base.rename(bundle)
    with pytest.raises(IsolationError) as error:
        invoke(bundle / "Contents")
    assert_reason(error, APP_REJECTION)


def test_isolation_creation_keeps_the_app_guard(tmp_path):
    root = tmp_path.resolve() / "repository"
    root.mkdir()
    parent = root / "ordinary-scratch"
    parent.mkdir()
    context = IsolationContext.create(root, parent)
    context.verify()
    assert context.cleanup() is True
    bundle = parent.with_name("X.app")
    parent.rename(bundle)
    with pytest.raises(IsolationError) as error:
        IsolationContext.create(root, bundle)
    assert_reason(error, APP_REJECTION)
    assert list(bundle.iterdir()) == []


def test_engine_output_keeps_the_app_guard_without_launching_a_stage(tmp_path):
    root = tmp_path.resolve() / "repository"
    root.mkdir()
    parent = root / "ordinary-output"
    parent.mkdir()
    baseline = Engine(root, parent / "baseline").run([])
    assert baseline["passed"] is True
    assert baseline["runs"] == []
    assert baseline["unitScratchRemoved"] is True
    bundle = parent.with_name("X.app")
    parent.rename(bundle)
    destination = bundle / "refused-output"
    with pytest.raises(IsolationError) as error:
        Engine(root, destination).run([])
    assert_reason(error, APP_REJECTION)
    assert not destination.exists()
    assert not (root / ".tools/registered-run/active-local.json").exists()


def test_rehearsal_and_freeze_shared_publication_output_keeps_the_app_guard(tmp_path):
    parent = tmp_path.resolve() / "ordinary-publication"
    parent.mkdir()
    materials = {"documents": {"historical-evidence.json": {}},
                 "registration": {"syntheticUnitFixture": True}, "pointerBytes": None}
    baseline = parent / "baseline"
    reg._publish_prepared(baseline, materials)
    assert json.loads((baseline / "historical-evidence.json").read_text()) == {}
    assert json.loads((baseline / "registration.json").read_text()) == materials["registration"]
    bundle = parent.with_name("X.app")
    parent.rename(bundle)
    destination = bundle / "refused-output"
    with pytest.raises(IsolationError) as error:
        reg._publish_prepared(destination, materials)
    assert_reason(error, APP_REJECTION)
    assert not destination.exists()


def test_public_rehearsal_refuses_app_repository_at_its_writable_lock_boundary(prepared):
    value = prepared
    output = value.ledger.parent / "ordinary-rehearsal"
    baseline = reg.rehearsal(value.root, "process-tools", value.config, value.report, output)
    assert baseline["registrationCreated"] is False
    assert baseline["activeMarkerCreated"] is False
    assert (output / "historical-evidence.json").is_file()
    report_relative = value.report.relative_to(value.root)
    output_relative = output.with_name("refused-rehearsal").relative_to(value.root)
    bundle = value.root.with_name(value.root.name + ".app")
    value.root.rename(bundle)
    # Only the repository basename changes. The public entry point refuses its
    # writable execution lock before preparation reads any saved-output binding.
    with pytest.raises(IsolationError) as error:
        reg.rehearsal(bundle, "process-tools", value.config, report_relative, output_relative)
    assert_reason(error, APP_REJECTION)
    assert not (bundle / output_relative).exists()
    assert not (bundle / report_relative).exists()
    assert not (bundle / ".tools/registered-run/active-registration.json").exists()
