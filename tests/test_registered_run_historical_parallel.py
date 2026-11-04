"""B1 equivalence and bounded concurrency use temporary synthetic evidence only."""
from __future__ import annotations

import hashlib
import os
from pathlib import Path
import re
from threading import Barrier, Event, Lock, Thread, current_thread
from types import SimpleNamespace

import pytest

from script.registered_run import registration as reg


NAMES = ("z-first.txt", "a-second.txt", "m-third.txt", "b-fourth.txt", "fifth.txt",
         "sixth.txt", "seventh.txt", "eighth.txt", "ninth.txt")
WAIT_SECONDS = 10


def make_history(root: Path, count: int = 6) -> dict[str, str]:
    root.mkdir(parents=True)
    historical = {}
    for index, filename in enumerate(NAMES[:count]):
        payload = (f"synthetic historical evidence {index}\n" * (index + 1)).encode()
        (root / filename).write_bytes(payload)
        historical[filename] = hashlib.sha256(payload).hexdigest()
    return historical


def serial_unchanged(root: Path, historical: dict[str, str]) -> int:
    """The pre-B1 loop is an independent serial oracle for error precedence."""
    for filename, expected in historical.items():
        reg._need(isinstance(expected, str) and re.fullmatch(r"[0-9a-f]{64}", expected), "HISTORICAL_SHA256_INVALID")
        path = reg._project_path(root, reg.safe_relative_path(filename))
        reg._need(reg._file_sha(root, path) == expected, "HISTORICAL_EVIDENCE_CHANGED:" + filename)
    return len(historical)


def outcome(function, root, historical):
    try:
        return "returned", function(root, historical)
    except Exception as error:
        return "raised", type(error), str(error)


def damage_file(root, filename, fault, monkeypatch):
    path = root / filename
    if fault == "content":
        path.write_bytes(b"changed evidence\n")
    elif fault == "symlink":
        target = path.with_name("actual-evidence.txt")
        path.rename(target)
        path.symlink_to(target.name)
    elif fault == "hardlink":
        os.link(path, path.with_name("hardlink-alias.txt"))
    elif fault == "owner":
        original = Path.lstat

        def different_owner(candidate, *args, **kwargs):
            info = original(candidate, *args, **kwargs)
            if candidate == path:
                fields = {name: getattr(info, name) for name in dir(info) if name.startswith("st_")}
                return SimpleNamespace(**{**fields, "st_uid": info.st_uid + 1})
            return info

        monkeypatch.setattr(Path, "lstat", different_owner)
    elif fault == "during-read":
        original = os.fstat
        before = path.stat()
        descriptor_checks = 0
        guard = Lock()

        def mutate_before_completed_check(descriptor):
            nonlocal descriptor_checks
            info = original(descriptor)
            if (info.st_dev, info.st_ino) == (before.st_dev, before.st_ino):
                with guard:
                    descriptor_checks += 1
                    if descriptor_checks == 2:
                        path.write_bytes(b"changed after content read, before descriptor recheck\n")
                return original(descriptor)
            return info

        monkeypatch.setattr(reg.os, "fstat", mutate_before_completed_check)
    else:
        raise AssertionError("unknown synthetic fault: " + fault)


class ObservedManifest(dict):
    def __init__(self, historical):
        super().__init__(historical)
        self.yielded = []

    def items(self):
        for item in super().items():
            self.yielded.append(item[0])
            yield item


def start_check(root, historical):
    result, completed = {}, Event()

    def run():
        try:
            result["count"] = reg._historical_unchanged(root, historical)
        except BaseException as error:
            result["error"] = error
        finally:
            completed.set()

    caller = Thread(target=run, name="synthetic-historical-caller")
    caller.start()
    return caller, completed, result


@pytest.mark.parametrize("count", [0, 1, 9])
def test_historical_parallel_matches_serial_return_and_preserves_evidence(tmp_path, count):
    root = tmp_path.resolve() / "repository"
    historical = make_history(root, count)
    before = {filename: (root / filename).read_bytes() for filename in historical}
    assert serial_unchanged(root, historical) == count
    assert reg._historical_unchanged(root, historical) == count
    assert {filename: (root / filename).read_bytes() for filename in historical} == before


@pytest.mark.parametrize("fault,error_type,message", [
    ("content", reg.RegistrationError, "HISTORICAL_EVIDENCE_CHANGED:a-second.txt"),
    ("symlink", reg.ReadOnlyFileError, "READ_ONLY_FILE_SYMLINK_FORBIDDEN"),
    ("hardlink", reg.ReadOnlyFileError, "READ_ONLY_HARDLINK_FORBIDDEN"),
    ("owner", reg.ReadOnlyFileError, "READ_ONLY_FILE_OWNER_MISMATCH"),
    ("during-read", reg.RegistrationError, "HISTORICAL_FILE_CHANGED_DURING_HASH"),
])
def test_historical_parallel_file_rejections_match_serial(tmp_path, monkeypatch, fault, error_type, message):
    observed = []
    for name, function in (("serial", serial_unchanged), ("parallel", reg._historical_unchanged)):
        root = tmp_path.resolve() / name
        historical = make_history(root)
        # A later content mismatch must not replace the earlier file rejection.
        (root / NAMES[2]).write_bytes(b"another bad historical file\n")
        with monkeypatch.context() as local:
            damage_file(root, NAMES[1], fault, local)
            observed.append(outcome(function, root, historical))
    assert observed == [("raised", error_type, message)] * 2


@pytest.mark.parametrize("expected", [None, "", "F" * 64, "0" * 63])
def test_historical_parallel_checks_sha_format_before_the_same_items_path(tmp_path, expected):
    root = tmp_path.resolve() / "repository"
    root.mkdir()
    historical = {"../forbidden.txt": expected}
    parallel = outcome(reg._historical_unchanged, root, historical)
    assert outcome(serial_unchanged, root, historical) == parallel == (
        "raised", reg.RegistrationError, "HISTORICAL_SHA256_INVALID")


@pytest.mark.parametrize("first_fault", ["content", "missing"])
@pytest.mark.parametrize("later_fault", ["sha", "invalid-path", "forbidden-path"])
def test_historical_parallel_later_validation_cannot_outrank_earlier_file_error(
        tmp_path, monkeypatch, first_fault, later_fault):
    root = tmp_path.resolve() / "repository"
    historical = make_history(root)
    rows = list(historical.items())
    if later_fault == "sha":
        rows[1] = rows[1][0], "invalid sha"
    else:
        rows[1] = ("invalid\\path" if later_fault == "invalid-path" else "../forbidden.txt"), rows[1][1]
    historical = dict(rows)
    if first_fault == "missing":
        (root / NAMES[0]).unlink()
    else:
        (root / NAMES[0]).write_bytes(b"first file was changed\n")
    expected = outcome(serial_unchanged, root, historical)
    later_rejected = Event()
    original_need, original_path, original_hash = reg._need, reg.safe_relative_path, reg._file_sha

    def need(condition, message):
        try:
            return original_need(condition, message)
        except reg.RegistrationError:
            if message == "HISTORICAL_SHA256_INVALID":
                later_rejected.set()
            raise

    def safe_path(filename):
        try:
            return original_path(filename)
        except Exception:
            if filename == rows[1][0]:
                later_rejected.set()
            raise

    def hashed(project, path):
        if path == root / NAMES[0]:
            assert later_rejected.wait(WAIT_SECONDS), "later validation never ran concurrently"
        return original_hash(project, path)

    monkeypatch.setattr(reg, "_need", need)
    monkeypatch.setattr(reg, "safe_relative_path", safe_path)
    monkeypatch.setattr(reg, "_file_sha", hashed)
    assert outcome(reg._historical_unchanged, root, historical) == expected
    assert later_rejected.is_set()


@pytest.mark.parametrize("first_fault", ["sha", "path"])
def test_historical_parallel_earlier_validation_outranks_later_worker_error(tmp_path, monkeypatch, first_fault):
    root = tmp_path.resolve() / "repository"
    historical = make_history(root)
    rows = list(historical.items())
    rows[0] = (rows[0][0], "bad sha") if first_fault == "sha" else ("../forbidden.txt", rows[0][1])
    historical = dict(rows)
    expected = outcome(serial_unchanged, root, historical)
    later_failed = Event()
    original_need, original_path, original_hash = reg._need, reg.safe_relative_path, reg._file_sha

    def need(condition, message):
        if not condition and message == "HISTORICAL_SHA256_INVALID":
            assert later_failed.wait(WAIT_SECONDS), "later file error never ran concurrently"
        return original_need(condition, message)

    def safe_path(filename):
        if filename == rows[0][0] and first_fault == "path":
            assert later_failed.wait(WAIT_SECONDS), "later file error never ran concurrently"
        return original_path(filename)

    def hashed(project, path):
        if path == root / NAMES[1]:
            later_failed.set()
            raise OSError("later worker error must not win")
        return original_hash(project, path)

    monkeypatch.setattr(reg, "_need", need)
    monkeypatch.setattr(reg, "safe_relative_path", safe_path)
    monkeypatch.setattr(reg, "_file_sha", hashed)
    assert outcome(reg._historical_unchanged, root, historical) == expected
    assert later_failed.is_set()


def test_historical_parallel_first_failure_uses_manifest_order_and_original_filename(tmp_path, monkeypatch):
    root = tmp_path.resolve() / "repository"
    historical = make_history(root)
    for filename in NAMES[:2]:
        (root / filename).write_bytes(b"bad content in both files\n")
    # Preserve the source key in the diagnostic even when its path normalizes.
    rows = list(historical.items())
    rows[0] = "./" + rows[0][0], rows[0][1]
    historical = dict(rows)
    expected = outcome(serial_unchanged, root, historical)
    second_hashed = Event()
    original = reg._file_sha

    def hashed(project, path):
        if path == root / NAMES[0]:
            assert second_hashed.wait(WAIT_SECONDS), "later hash never finished first"
        digest = original(project, path)
        if path == root / NAMES[1]:
            second_hashed.set()
        return digest

    monkeypatch.setattr(reg, "_file_sha", hashed)
    assert outcome(reg._historical_unchanged, root, historical) == expected == (
        "raised", reg.RegistrationError, "HISTORICAL_EVIDENCE_CHANGED:./z-first.txt")


def test_historical_parallel_bounds_outstanding_work_to_four_and_joins_success(tmp_path, monkeypatch):
    root = tmp_path.resolve() / "repository"
    historical = ObservedManifest(make_history(root, 9))
    original = reg._file_sha
    first_four = Barrier(4)
    release_first, later_three_finished = Event(), Event()
    guard = Lock()
    workers, started = set(), []
    active = peak = finished_later = 0

    def hashed(project, path):
        nonlocal active, peak, finished_later
        with guard:
            workers.add(current_thread())
            started.append(path.name)
            active += 1
            peak = max(peak, active)
        try:
            if path.name in NAMES[:4]:
                first_four.wait(WAIT_SECONDS)
            if path.name == NAMES[0]:
                assert release_first.wait(WAIT_SECONDS), "first hash was never released"
            return original(project, path)
        finally:
            with guard:
                active -= 1
                if path.name in NAMES[1:4]:
                    finished_later += 1
                    if finished_later == 3:
                        later_three_finished.set()

    monkeypatch.setattr(reg, "_file_sha", hashed)
    caller, completed, result = start_check(root, historical)
    try:
        assert later_three_finished.wait(WAIT_SECONDS), "the initial four hashes did not run concurrently"
        assert not completed.is_set()
        # Three later results are ready, but the earliest result is blocked.
        # An eager submit-all or completion-order refill violates this bound.
        assert historical.yielded == list(NAMES[:4])
        assert set(started) == set(NAMES[:4])
        assert len(workers) == peak == 4
    finally:
        release_first.set()
        caller.join(WAIT_SECONDS)
    assert not caller.is_alive()
    assert result == {"count": 9}
    assert historical.yielded == list(NAMES)
    assert active == 0 and all(not worker.is_alive() for worker in workers)


class WorkerAbort(BaseException):
    pass


@pytest.mark.parametrize("error_type", [OSError, RuntimeError, WorkerAbort])
def test_historical_parallel_propagates_original_error_after_join_and_stops_submitting(
        tmp_path, monkeypatch, error_type):
    root = tmp_path.resolve() / "repository"
    historical = ObservedManifest(make_history(root, 9))
    original = reg._file_sha
    sentinel = error_type("original worker failure: z-first.txt / 原样")
    first_four = Barrier(4)
    first_failed, release_later = Event(), Event()
    guard = Lock()
    workers, started, finished = set(), set(), set()

    def hashed(project, path):
        with guard:
            workers.add(current_thread())
            started.add(path.name)
        try:
            first_four.wait(WAIT_SECONDS)
            if path.name == NAMES[0]:
                first_failed.set()
                raise sentinel
            assert release_later.wait(WAIT_SECONDS), "later workers were never released"
            if path.name == NAMES[1]:
                raise RuntimeError("later failure must not replace the first exception")
            return original(project, path)
        finally:
            with guard:
                finished.add(path.name)

    monkeypatch.setattr(reg, "_file_sha", hashed)
    caller, completed, result = start_check(root, historical)
    try:
        assert first_failed.wait(WAIT_SECONDS), "the first worker never failed"
        assert not completed.wait(0.05), "the caller returned while started workers were still blocked"
        assert historical.yielded == list(NAMES[:4])
        assert started == set(NAMES[:4])
    finally:
        release_later.set()
        caller.join(WAIT_SECONDS)
    assert not caller.is_alive()
    assert result["error"] is sentinel
    assert str(result["error"]) == "original worker failure: z-first.txt / 原样"
    assert historical.yielded == list(NAMES[:4])
    assert started == finished == set(NAMES[:4])
    assert len(workers) == 4 and all(not worker.is_alive() for worker in workers)
