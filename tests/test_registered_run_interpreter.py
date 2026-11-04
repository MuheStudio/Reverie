"""Interpreter provenance and gates use only temporary synthetic repositories.

No project build, collector, GUI or real registration directory is executed.
The established orchestration fixtures are imported without modifying them.
"""
from copy import deepcopy
import json
from types import SimpleNamespace

import pytest

from script.registered_run import cli, registration as reg
from tests.test_registered_run_registration import active, dump, fake_runtime, prepared


PACKAGE = "process-tools"
EXPECTED = "a" * 64
FIRST = {"implementation": "cpython", "version": "3.13.7 (fixture build, compiler details)",
         "executable": "/synthetic/python-first"}
SECOND = {"implementation": "cpython", "version": "3.14.0 (fixture build, compiler details)",
          "executable": "/synthetic/python-second"}


def use_interpreter(monkeypatch, identity):
    monkeypatch.setattr(reg, "_interpreter_identity", lambda: deepcopy(identity))


def rehearse(value, name="rehearsal-interpreter"):
    return reg.rehearsal(value.root, PACKAGE, value.config, value.report, value.ledger.parent / name)


def freeze(value, expected=None):
    return reg.freeze(value.root, PACKAGE, value.config, value.report, expected_contract_sha256=expected)


def assert_not_frozen(value):
    assert not value.report.exists()
    assert active(value.root) is None
    assert not (value.root / ".tools/registered-run/active-local.json").exists()


def diagnostic(error, code):
    prefix = code + ":"
    assert str(error.value).startswith(prefix)
    return json.loads(str(error.value)[len(prefix):])


def write_record(root, name="rehearsal-one", **changes):
    output = root / ".tools/local" / PACKAGE / name
    record = {"schema": reg.REHEARSAL_SCHEMA, "package": PACKAGE,
              "registrationId": "synthetic-registration", "contractSha256": EXPECTED,
              "outputDirectory": str(output.relative_to(root)),
              "registrationCreated": False, "activeMarkerCreated": False,
              "interpreter": deepcopy(FIRST), **changes}
    path = output / "rehearsal.json"
    dump(path, record)
    return path


def find_record(root):
    return reg._rehearsal_interpreter_mismatch(root, PACKAGE, EXPECTED, SECOND)


def rewrite_fixture_registration(value, change):
    """Rebind deliberately synthetic immutable input to model an older schema."""
    path = value.report / "registration.json"
    registration = json.loads(path.read_text())
    change(registration)
    digest = dump(path, registration)
    marker_path = value.root / ".tools/registered-run/active-registration.json"
    marker = json.loads(marker_path.read_text())
    marker["metadata"]["registrationSha256"] = digest
    dump(marker_path, marker)


def test_identity_uses_running_implementation_full_version_and_real_executable(tmp_path, monkeypatch):
    executable = tmp_path / "python-real"
    executable.write_bytes(b"synthetic binary identity; never executed")
    alias = tmp_path / "python-venv"
    alias.symlink_to(executable)
    version = "3.14.0rc3+ (fixture build, Oct 28 2026)\n[Fixture Compiler 20.0]"
    running = SimpleNamespace(executable=str(alias), implementation=SimpleNamespace(name="pypy"), version=version)
    monkeypatch.setattr(reg, "sys", running)
    assert reg._interpreter_identity() == {"implementation": "pypy", "version": version,
                                           "executable": str(executable.resolve())}
    running.executable = str(executable)
    assert reg._interpreter_identity()["executable"] == str(executable.resolve())


@pytest.mark.parametrize("executable", ["", "python", None])
def test_identity_rejects_unavailable_or_relative_process_executable(monkeypatch, executable):
    monkeypatch.setattr(reg, "sys", SimpleNamespace(executable=executable))
    with pytest.raises(reg.RegistrationError, match="INTERPRETER_EXECUTABLE_UNAVAILABLE"):
        reg._interpreter_identity()


def test_rehearsal_stdout_and_materials_then_freeze_record_same_interpreter(prepared, monkeypatch, capsys):
    use_interpreter(monkeypatch, FIRST)
    monkeypatch.setattr(cli, "load_config", lambda _: deepcopy(prepared.config))
    output = prepared.ledger.parent / "rehearsal-cli"
    assert cli.main(["--root", str(prepared.root), "rehearse", "--package", PACKAGE,
                     "--config", "synthetic-config.json", "--report", str(prepared.report),
                     "--output", str(output)]) == 0
    result = json.loads(capsys.readouterr().out)
    assert result["interpreter"] == FIRST
    assert json.loads((output / "rehearsal.json").read_text()) == result
    proposed = json.loads((output / "registration.json").read_text())
    assert proposed["interpreter"] == FIRST
    assert_not_frozen(prepared)
    frozen = freeze(prepared, result["contractSha256"])
    assert frozen["interpreter"] == FIRST
    assert json.loads((prepared.report / "registration.json").read_text())["interpreter"] == FIRST


def test_interpreter_metadata_does_not_change_otherwise_identical_contract(prepared, monkeypatch):
    use_interpreter(monkeypatch, FIRST)
    first = rehearse(prepared, "rehearsal-first")
    use_interpreter(monkeypatch, SECOND)
    second = rehearse(prepared, "rehearsal-second")
    assert first["interpreter"] != second["interpreter"]
    assert first["contractSha256"] == second["contractSha256"]
    for name in ("rehearsal-first", "rehearsal-second"):
        contract = json.loads((prepared.ledger.parent / name / "contract.json").read_text())
        assert "interpreter" not in contract and "interpreter" not in contract["runtime"]
    assert freeze(prepared, first["contractSha256"])["interpreter"] == SECOND


def test_freeze_contract_mismatch_reports_both_interpreters_from_matching_rehearsal(prepared, monkeypatch):
    use_interpreter(monkeypatch, FIRST)
    expected = rehearse(prepared)["contractSha256"]
    preserved = {path: path.read_bytes() for path in prepared.baseline_dir.rglob("*") if path.is_file()}
    prepared.config["timeoutsSeconds"]["python-unit"] += 1
    use_interpreter(monkeypatch, SECOND)
    with pytest.raises(reg.RegistrationError) as error:
        freeze(prepared, expected)
    detail = diagnostic(error, "REHEARSAL_INTERPRETER_MISMATCH")
    assert detail["rehearsalInterpreter"] == FIRST and detail["currentInterpreter"] == SECOND
    assert detail["expectedContractSha256"] == expected
    assert detail["currentContractSha256"] != expected
    assert detail["rehearsalRecord"] == str((prepared.ledger.parent / "rehearsal-interpreter/rehearsal.json").relative_to(prepared.root))
    assert_not_frozen(prepared)
    assert all(path.read_bytes() == payload for path, payload in preserved.items())


@pytest.mark.parametrize("record_kind", ["missing", "same-interpreter", "other-contract", "legacy", "other-package"])
def test_freeze_retains_contract_error_without_relevant_different_interpreter(prepared, monkeypatch, record_kind):
    use_interpreter(monkeypatch, FIRST)
    expected = rehearse(prepared)["contractSha256"]
    path = prepared.ledger.parent / "rehearsal-interpreter/rehearsal.json"
    record = json.loads(path.read_text())
    if record_kind == "missing":
        path.unlink()
    else:
        if record_kind == "other-contract":
            record["contractSha256"] = "0" * 64
        elif record_kind == "legacy":
            del record["interpreter"]
        elif record_kind == "other-package":
            record["package"] = "unrelated-package"
        dump(path, record)
    prepared.config["timeoutsSeconds"]["python-unit"] += 1
    use_interpreter(monkeypatch, FIRST if record_kind == "same-interpreter" else SECOND)
    with pytest.raises(reg.RegistrationError, match="^REGISTRATION_CONTRACT_SHA256_MISMATCH$"):
        freeze(prepared, expected)
    assert_not_frozen(prepared)


def test_lookup_requires_same_package_expected_contract_and_direct_child_scope(tmp_path):
    root = tmp_path.resolve()
    path = write_record(root)
    assert find_record(root) == {"rehearsalRecord": str(path.relative_to(root)),
                                 "rehearsalInterpreter": FIRST, "currentInterpreter": SECOND}
    assert reg._rehearsal_interpreter_mismatch(root, "other-package", EXPECTED, SECOND) is None
    assert reg._rehearsal_interpreter_mismatch(root, PACKAGE, "b" * 64, SECOND) is None
    assert reg._rehearsal_interpreter_mismatch(root, PACKAGE, EXPECTED, FIRST) is None
    nested = root / ".tools/local" / PACKAGE / "runs/nested"
    nested.mkdir(parents=True)
    path.rename(nested / "rehearsal.json")
    assert find_record(root) is None


@pytest.mark.parametrize("changes", [
    {"schema": "other-schema"}, {"package": "other-package"}, {"outputDirectory": ".tools/local/other-package/rehearsal-one"},
    {"contractSha256": "b" * 64}, {"registrationCreated": True}, {"activeMarkerCreated": True},
    {"interpreter": None}, {"interpreter": {}}, {"interpreter": {**FIRST, "executable": "relative/python"}},
    {"interpreter": {"implementation": "cpython", "executable": FIRST["executable"]}},
])
def test_lookup_ignores_unrelated_or_malformed_metadata(tmp_path, changes):
    root = tmp_path.resolve()
    write_record(root, **changes)
    assert find_record(root) is None


@pytest.mark.parametrize("payload", [b"{broken", b"[]", b'{"schema":1,"schema":2}', b'{"value":NaN}', b"\xff"])
def test_lookup_ignores_malformed_json_without_changing_bytes(tmp_path, payload):
    root = tmp_path.resolve()
    path = write_record(root)
    path.write_bytes(payload)
    assert find_record(root) is None
    assert path.read_bytes() == payload


def test_lookup_ignores_missing_record_and_absent_package(tmp_path):
    root = tmp_path.resolve()
    assert find_record(root) is None
    path = write_record(root)
    path.unlink()
    assert find_record(root) is None


@pytest.mark.parametrize("alias", ["record", "directory", "package"])
def test_lookup_never_follows_symlink_records_or_parents(tmp_path, alias):
    root = tmp_path.resolve()
    path = write_record(root)
    original = path.read_bytes()
    if alias == "record":
        target = root / "retained-record.json"
        path.rename(target)
        path.symlink_to(target)
    elif alias == "directory":
        target = root / "retained-rehearsal"
        path.parent.rename(target)
        path.parent.symlink_to(target, target_is_directory=True)
    else:
        package = path.parent.parent
        target = root / "retained-package"
        package.rename(target)
        package.symlink_to(target, target_is_directory=True)
    assert find_record(root) is None
    assert path.read_bytes() == original


def test_lookup_bounds_record_bytes_before_opening(tmp_path, monkeypatch):
    root = tmp_path.resolve()
    path = write_record(root)
    payload = path.read_bytes()
    monkeypatch.setattr(reg, "_REHEARSAL_LOOKUP_MAX_BYTES", len(payload) - 1)
    with pytest.raises(reg.RegistrationError, match="REHEARSAL_RECORD_TOO_LARGE"):
        reg._read_rehearsal_record(root, path)
    assert find_record(root) is None
    assert path.read_bytes() == payload


def test_lookup_bounds_direct_entry_inventory(tmp_path, monkeypatch):
    root = tmp_path.resolve()
    write_record(root, "rehearsal-one", contractSha256="b" * 64)
    write_record(root, "rehearsal-two", contractSha256="b" * 64)
    write_record(root, "rehearsal-three")
    directory = root / ".tools/local" / PACKAGE
    with reg.os.scandir(directory) as stream:
        entries = {entry.name: entry for entry in stream}
    ordered = [entries[name] for name in ("rehearsal-one", "rehearsal-two", "rehearsal-three")]
    seen = []

    class BoundedEntries:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def __iter__(self):
            for entry in ordered:
                seen.append(entry.name)
                assert len(seen) <= 2, "diagnostic inventory exceeded its entry bound"
                yield entry

    monkeypatch.setattr(reg, "_REHEARSAL_LOOKUP_MAX_ENTRIES", 2)
    monkeypatch.setattr(reg.os, "scandir", lambda _: BoundedEntries())
    assert find_record(root) is None
    assert seen == ["rehearsal-one", "rehearsal-two"]


@pytest.mark.parametrize("field", ["implementation", "version", "executable"])
def test_authorization_rejects_each_interpreter_difference_without_consuming_attempt(prepared, monkeypatch, field):
    use_interpreter(monkeypatch, FIRST)
    freeze(prepared)
    different = {**FIRST, field: "pypy" if field == "implementation" else SECOND[field]}
    use_interpreter(monkeypatch, different)
    with pytest.raises(reg.RegistrationError) as error:
        reg.authorize_registration(prepared.root, prepared.report, "synthetic explicit approval")
    detail = diagnostic(error, "REGISTRATION_INTERPRETER_MISMATCH")
    assert detail == {"registeredInterpreter": FIRST, "currentInterpreter": different}
    assert not (prepared.report / "authorization.json").exists()
    assert not (prepared.report / "run-claim.json").exists()
    assert active(prepared.root) is not None


@pytest.mark.parametrize("field", ["implementation", "version", "executable"])
def test_run_rejects_interpreter_difference_and_preserves_single_consumed_attempt(prepared, monkeypatch, field):
    use_interpreter(monkeypatch, FIRST)
    freeze(prepared)
    reg.authorize_registration(prepared.root, prepared.report, "synthetic explicit approval")
    calls = fake_runtime(prepared, monkeypatch)
    different = {**FIRST, field: "pypy" if field == "implementation" else SECOND[field]}
    use_interpreter(monkeypatch, different)
    with pytest.raises(reg.RegistrationError) as error:
        reg.run_registered(prepared.root, prepared.report)
    assert diagnostic(error, "REGISTRATION_INTERPRETER_MISMATCH") == {
        "registeredInterpreter": FIRST, "currentInterpreter": different}
    assert calls == []
    assert (prepared.report / "run-claim.json").exists()
    ledger = json.loads((prepared.report / "run-ledger.json").read_text())
    assert ledger["passed"] is False and ledger["runs"] == []
    assert ledger["stopReason"].startswith("REGISTRATION_INTERPRETER_MISMATCH:")
    assert active(prepared.root) is None
    with pytest.raises(reg.RegistrationError, match="REGISTRATION_ACTIVE_REPORT_BINDING_MISMATCH"):
        reg.run_registered(prepared.root, prepared.report)


@pytest.mark.parametrize("metadata", [None, {}, {"implementation": "cpython"}])
def test_present_but_malformed_registration_metadata_cannot_use_legacy_exemption(prepared, monkeypatch, metadata):
    use_interpreter(monkeypatch, FIRST)
    freeze(prepared)
    rewrite_fixture_registration(prepared, lambda record: record.update(interpreter=metadata))
    with pytest.raises(reg.RegistrationError, match="REGISTRATION_INTERPRETER_MISMATCH"):
        reg.authorize_registration(prepared.root, prepared.report, "synthetic explicit approval")
    assert not (prepared.report / "authorization.json").exists()


def test_legacy_registration_without_interpreter_retains_authorization_and_run_behavior(prepared, monkeypatch):
    use_interpreter(monkeypatch, FIRST)
    freeze(prepared)
    rewrite_fixture_registration(prepared, lambda record: record.pop("interpreter"))
    use_interpreter(monkeypatch, SECOND)
    assert reg.authorize_registration(prepared.root, prepared.report, "synthetic explicit approval")["approved"] is True
    calls = fake_runtime(prepared, monkeypatch)
    assert reg.run_registered(prepared.root, prepared.report)["passed"] is True
    assert calls and "adopt" not in calls
    assert active(prepared.root) is None


def test_running_boundaries_keep_interpreter_gate_and_fail_stop(prepared, monkeypatch):
    use_interpreter(monkeypatch, FIRST)
    freeze(prepared)
    reg.authorize_registration(prepared.root, prepared.report, "synthetic explicit approval")
    calls = fake_runtime(prepared, monkeypatch)
    identities = iter([FIRST, SECOND])
    monkeypatch.setattr(reg, "_interpreter_identity", lambda: deepcopy(next(identities)))
    result = reg.run_registered(prepared.root, prepared.report)
    assert result["passed"] is False
    assert result["stopReason"].startswith("REGISTRATION_INTERPRETER_MISMATCH:")
    assert calls == ["plan"] and result["runs"] == []
    assert active(prepared.root) is None
