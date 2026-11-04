"""Real subprocess and synthetic protocol tests; no legacy matcher fixtures."""

from __future__ import annotations

import asyncio
import io
import logging
import os
from pathlib import Path
import sys
import time

import pytest

from src.worldbook.regex_supervisor import RegexCleanupError, RegexSession
from src.worldbook import regex_supervisor as supervisor

LOGGER_NAME = "reverie.worldbook.regex_supervisor"


def run_expression(primary, secondary=(), logic="and_any", text="hello", sensitive=False):
    async def run():
        session = RegexSession()
        try:
            return await session.evaluate(primary, secondary, logic, sensitive, text)
        finally:
            await session.aclose()
    return asyncio.run(run())


def assert_dead(pid):
    with pytest.raises(ProcessLookupError):
        os.kill(pid, 0)


async def await_pid(session):
    for _ in range(1000):
        if session.active_pid:
            return session.active_pid
        await asyncio.sleep(0.001)
    raise AssertionError("worker was not started")


def helper(tmp_path, source):
    worker = tmp_path / "fixture_worker.py"
    worker.write_text(source, encoding="utf-8")
    return worker


READY_SOURCE = """import json, struct, sys, time
def write(value):
    data = json.dumps(value).encode()
    sys.stdout.buffer.write(struct.pack('!I',len(data))+data)
    sys.stdout.buffer.flush()
write({'ready':True,'protocol':1})
"""


def test_production_resource_bounds_are_explicit():
    assert supervisor.STARTUP_BUDGET_SECONDS == 1.0
    assert supervisor.ENTRY_BUDGET_SECONDS == 0.050
    assert supervisor.EXECUTION_BUDGET_SECONDS == 0.500
    assert supervisor.KILL_REAP_TIMEOUT_SECONDS == 1.0
    assert supervisor.MAX_REQUEST_BYTES == 8 * 1024 * 1024
    assert supervisor.MAX_RESPONSE_BYTES == 4 * 1024
    assert supervisor.MAX_TEXT_CHARACTERS == 1_048_576
    assert supervisor.MAX_PATTERN_CHARACTERS == 16_384


@pytest.mark.parametrize(("primary", "text", "sensitive", "state"), [
    (["h.llo"], "hello", True, "MATCH"), (["HELLO"], "hello", False, "MATCH"),
    (["HELLO"], "hello", True, "NO_MATCH"), (["^hello$"], "before hello", False, "NO_MATCH"),
    (["^no$", "hello"], "hello", False, "MATCH"), ([], "hello", False, "NO_MATCH"),
])
def test_primary_regex_and_case_sensitivity(primary, text, sensitive, state):
    result = run_expression(primary, text=text, sensitive=sensitive)
    assert result.state == state and result.code == ""


@pytest.mark.parametrize(("logic", "text", "state"), [
    ("and_any", "hello red", "MATCH"), ("and_any", "hello", "NO_MATCH"),
    ("and_all", "hello red blue", "MATCH"), ("and_all", "hello red", "NO_MATCH"),
    ("not_any", "hello", "MATCH"), ("not_any", "hello red", "NO_MATCH"),
    ("not_all", "hello red", "MATCH"), ("not_all", "hello red blue", "NO_MATCH"),
])
def test_auxiliary_regex_logic(logic, text, state):
    assert run_expression(["hello"], ["r.d", "blue"], logic, text).state == state


@pytest.mark.parametrize("logic", ["and_any", "and_all", "not_any", "not_all"])
def test_empty_auxiliary_is_ignored(logic):
    assert run_expression(["hello"], [], logic).state == "MATCH"


@pytest.mark.parametrize(("primary", "secondary", "logic"), [
    (["["], [], "and_any"), (["hello", "["], [], "and_any"),
    (["hello"], ["["], "not_any"), (["hello"], ["["], "not_all"),
    (["hello"], ["hello", "["], "and_any"), (["hello"], ["absent", "["], "not_all"),
])
def test_invalid_participating_regex_is_an_error_not_a_negative_match(primary, secondary, logic):
    result = run_expression(primary, secondary, logic)
    assert result.state == "ERROR" and result.code == "invalid_regex"


def test_auxiliary_regex_not_participating_in_failed_primary_is_not_executed():
    result = run_expression(["absent"], ["["], "not_any")
    assert result.state == "NO_MATCH" and result.code == ""


def test_timeout_kills_actual_pid_and_next_healthy_entry_uses_a_fresh_worker(caplog):
    async def run():
        session = RegexSession()
        try:
            bad = await session.evaluate(["(a+)+$"], [], "and_any", False, "a" * 10_000 + "!")
            assert bad.state == "ERROR" and bad.code == "regex_timeout"
            timeout_record = next(record for record in caplog.records if "worldbook_regex_timeout" in record.msg)
            first_pid = timeout_record.args[0]
            assert_dead(first_pid)
            assert session.active_pid is None
            good = await session.evaluate(["healthy"], [], "and_any", False, "healthy")
            assert good.state == "MATCH" and session.active_pid != first_pid
            second_pid = session.active_pid
            await session.aclose()
            assert session.active_pid is None
            assert_dead(second_pid)
        finally:
            await session.aclose()
    with caplog.at_level(logging.INFO, logger=LOGGER_NAME):
        asyncio.run(run())
    events = [record for record in caplog.records if record.name == LOGGER_NAME]
    assert sum("worldbook_regex_spawn" in record.msg for record in events) == 2
    assert sum("worldbook_regex_reap " in record.msg for record in events) == 2
    assert all(record.args[1] == sys.executable for record in events)
    assert "(a+)+$" not in caplog.text and "aaaa" not in caplog.text


@pytest.mark.parametrize("logic", ["not_any", "not_all"])
def test_catastrophic_negative_auxiliary_is_an_error_and_its_actual_worker_dies(logic, caplog):
    async def run():
        session = RegexSession()
        try:
            result = await session.evaluate(["trigger"], ["(a+)+$"], logic, False,
                                            "trigger " + "a" * 10_000 + "!")
            assert result.state == "ERROR" and result.code == "regex_timeout"
            pid = next(record.args[0] for record in caplog.records if "worldbook_regex_timeout" in record.msg)
            assert_dead(pid)
            assert session.active_pid is None
            assert (await session.evaluate(["healthy"], [], "and_any", False, "healthy")).state == "MATCH"
        finally:
            await session.aclose()
    asyncio.run(run())


@pytest.mark.parametrize("phase", ["startup", "matching"])
def test_cancellation_kills_and_reaps_actual_pid(tmp_path, phase):
    async def run():
        worker = helper(tmp_path, "import time; time.sleep(20)\n") if phase == "startup" else None
        session = RegexSession(_worker_path=worker)
        task = asyncio.create_task(session.evaluate(["(a+)+$"], [], "and_any", False, "a" * 10_000 + "!"))
        try:
            pid = await await_pid(session)
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
            assert session.active_pid is None
            assert_dead(pid)
        finally:
            await session.aclose()
    asyncio.run(run())


@pytest.mark.parametrize("phase", ["startup", "matching"])
def test_aclose_during_pending_work_reaps_before_returning(tmp_path, phase):
    async def run():
        worker = helper(tmp_path, "import time; time.sleep(20)\n") if phase == "startup" else None
        session = RegexSession(_worker_path=worker)
        task = asyncio.create_task(session.evaluate(["(a+)+$"], [], "and_any", False, "a" * 10_000 + "!"))
        pid = await await_pid(session)
        await session.aclose()
        await asyncio.gather(task, return_exceptions=True)
        assert session.active_pid is None
        assert_dead(pid)
        result = await session.evaluate(["hello"], [], "and_any", False, "hello")
        assert result.code == "regex_worker_unavailable"
    asyncio.run(run())


def test_startup_timeout_is_bounded_and_leaves_no_process(tmp_path, monkeypatch, caplog):
    monkeypatch.setattr(supervisor, "STARTUP_BUDGET_SECONDS", 0.050)
    worker = helper(tmp_path, "import time; time.sleep(20)\n")
    async def run():
        session = RegexSession(_worker_path=worker)
        try:
            started = time.monotonic()
            result = await session.evaluate(["hello"], [], "and_any", False, "hello")
            assert result.code == "regex_worker_unavailable"
            assert time.monotonic() - started < 0.75
            assert session.active_pid is None
            pid = next(record.args[0] for record in caplog.records if "worldbook_regex_spawn" in record.msg)
            assert_dead(pid)
        finally:
            await session.aclose()
    with caplog.at_level(logging.INFO, logger=LOGGER_NAME):
        asyncio.run(run())


def test_startup_budget_is_shared_by_restarts(tmp_path, monkeypatch):
    monkeypatch.setattr(supervisor, "STARTUP_BUDGET_SECONDS", 0.130)
    worker = helper(tmp_path, "import time\ntime.sleep(0.075)\n" + READY_SOURCE + "time.sleep(20)\n")
    async def run():
        session = RegexSession(_worker_path=worker)
        try:
            first = await session.evaluate(["hello"], [], "and_any", False, "hello")
            assert first.code == "regex_timeout"
            second = await session.evaluate(["hello"], [], "and_any", False, "hello")
            assert second.code == "regex_worker_unavailable"
            assert session.active_pid is None
            assert session._startup_spent >= supervisor.STARTUP_BUDGET_SECONDS
        finally:
            await session.aclose()
    asyncio.run(run())


def test_total_execution_budget_survives_worker_restarts_and_reports_exhaustion():
    async def run():
        session = RegexSession()
        try:
            results = [await session.evaluate(["(a+)+$"], [], "and_any", False, "a" * 10_000 + "!")
                       for _ in range(12)]
            assert results[0].code == "regex_timeout"
            assert any(result.code == "regex_budget_exhausted" for result in results)
            assert (await session.evaluate(["healthy"], [], "and_any", False, "healthy")).code == "regex_budget_exhausted"
            assert session.active_pid is None
        finally:
            await session.aclose()
    asyncio.run(run())


@pytest.mark.parametrize(("primary", "text"), [
    (["x" * (supervisor.MAX_PATTERN_CHARACTERS + 1)], "hello"),
    (["x"], "a" * (supervisor.MAX_TEXT_CHARACTERS + 1)),
    (["x"] * 201, "hello"),
])
def test_input_limits_fail_without_starting_a_worker(primary, text):
    async def run():
        session = RegexSession()
        result = await session.evaluate(primary, [], "and_any", False, text)
        assert result.code == "regex_input_limit" and session.active_pid is None
        await session.aclose()
    asyncio.run(run())


def test_encoded_request_frame_bound_is_enforced_before_spawning():
    async def run():
        session = RegexSession()
        patterns = ["😀" * 5_000] * 200
        result = await session.evaluate(patterns, patterns, "and_any", False, "x" * 1_000_000)
        assert result.code == "regex_input_limit" and session.active_pid is None
        await session.aclose()
    asyncio.run(run())


@pytest.mark.parametrize("response", [
    "sys.stdout.buffer.write(struct.pack('!I',4097)); sys.stdout.buffer.flush(); time.sleep(20)",
    "write({'state':'ERROR','code':'PRIVATE_UNKNOWN_CODE'}); time.sleep(20)",
    "write({'state':'MATCH','code':'','private':'PRIVATE_PAYLOAD'}); time.sleep(20)",
])
def test_invalid_worker_output_is_bounded_and_machine_sanitized(tmp_path, response, caplog):
    worker = helper(tmp_path, READY_SOURCE + "sys.stdin.buffer.read(4)\n" + response + "\n")
    async def run():
        session = RegexSession(_worker_path=worker)
        try:
            result = await session.evaluate(["hello"], [], "and_any", False, "hello")
            assert result.state == "ERROR" and result.code == "regex_worker_unavailable"
            assert session.active_pid is None
        finally:
            await session.aclose()
    asyncio.run(run())
    assert "PRIVATE" not in caplog.text


def test_missing_worker_is_isolated_without_raw_exception_text(tmp_path):
    async def run():
        session = RegexSession(_worker_path=tmp_path / "absent.py")
        result = await session.evaluate(["hello"], [], "and_any", False, "hello")
        assert result.state == "ERROR" and result.code == "regex_worker_unavailable"
        assert session.active_pid is None
        await session.aclose()
    asyncio.run(run())


def test_cleanup_timeout_is_explicit_and_retains_unreaped_handle(monkeypatch):
    monkeypatch.setattr(supervisor, "KILL_REAP_TIMEOUT_SECONDS", 0.020)
    class StalledReader:
        stalled = True
        async def read(self, length):
            if self.stalled:
                await asyncio.Future()
            return b""
    class SimulatedProcess:
        pid = 123456789
        returncode = None
        stdin = None
        stdout = StalledReader()
        killed = False
        def kill(self):
            self.killed = True
        async def wait(self):
            self.returncode = -9
            return self.returncode
    async def run():
        session = RegexSession()
        simulated = SimulatedProcess()
        session._process = simulated
        with pytest.raises(RegexCleanupError, match="^regex_worker_unavailable$"):
            await session.aclose()
        assert simulated.killed and session.active_pid == simulated.pid
        simulated.stdout.stalled = False
        await session.aclose()
        assert session.active_pid is None
    asyncio.run(run())


@pytest.mark.parametrize("action", ["cancel", "close"])
def test_creation_barrier_is_owned_until_real_child_is_attached_killed_and_reaped(monkeypatch, action):
    original_spawn = asyncio.create_subprocess_exec
    async def run():
        created = asyncio.Event()
        release = asyncio.Event()
        actual_processes = []
        async def delayed_attachment(*args, **kwargs):
            assert args[:3] == (sys.executable, "-I", "-B")
            assert Path(args[3]).name == "regex_worker.py"
            assert kwargs["stdin"] == asyncio.subprocess.PIPE
            assert kwargs["stdout"] == asyncio.subprocess.PIPE
            assert kwargs["stderr"] == asyncio.subprocess.DEVNULL
            assert kwargs["close_fds"] is True
            process = await original_spawn(*args, **kwargs)
            actual_processes.append(process)
            created.set()
            await release.wait()
            return process
        monkeypatch.setattr(asyncio, "create_subprocess_exec", delayed_attachment)
        session = RegexSession()
        evaluation = asyncio.create_task(session.evaluate(["hello"], [], "and_any", False, "hello"))
        await asyncio.wait_for(created.wait(), 1)
        pid = actual_processes[0].pid
        assert session.active_pid is None and session.has_pending_worker
        if action == "cancel":
            evaluation.cancel()
            completion = evaluation
        else:
            completion = asyncio.create_task(session.aclose())
        await asyncio.sleep(0.015)
        assert not completion.done(), "close/cancel must wait for the owned creation handle"
        release.set()
        await asyncio.gather(completion, evaluation, return_exceptions=True)
        assert not session.has_pending_worker
        assert_dead(pid)
        await session.aclose()
    asyncio.run(run())


def test_repeated_cancellation_does_not_detach_cleanup_or_leave_the_real_child(monkeypatch):
    original_spawn = asyncio.create_subprocess_exec
    async def run():
        created = asyncio.Event()
        release = asyncio.Event()
        actual_processes = []
        async def delayed_attachment(*args, **kwargs):
            process = await original_spawn(*args, **kwargs)
            actual_processes.append(process)
            created.set()
            await release.wait()
            return process
        monkeypatch.setattr(asyncio, "create_subprocess_exec", delayed_attachment)
        session = RegexSession()
        evaluation = asyncio.create_task(session.evaluate(["hello"], [], "and_any", False, "hello"))
        await asyncio.wait_for(created.wait(), 1)
        for _ in range(4):
            evaluation.cancel()
            await asyncio.sleep(0.003)
        assert not evaluation.done()
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await evaluation
        assert not session.has_pending_worker
        assert_dead(actual_processes[0].pid)
        await session.aclose()
    asyncio.run(run())


def test_spawn_cleanup_failure_is_explicit_and_late_child_is_retained_and_reaped(monkeypatch):
    monkeypatch.setattr(supervisor, "KILL_REAP_TIMEOUT_SECONDS", 0.035)
    original_spawn = asyncio.create_subprocess_exec
    async def run():
        created = asyncio.Event()
        release = asyncio.Event()
        actual_processes = []
        async def delayed_attachment(*args, **kwargs):
            process = await original_spawn(*args, **kwargs)
            actual_processes.append(process)
            created.set()
            await release.wait()
            return process
        monkeypatch.setattr(asyncio, "create_subprocess_exec", delayed_attachment)
        session = RegexSession()
        evaluation = asyncio.create_task(session.evaluate(["hello"], [], "and_any", False, "hello"))
        await asyncio.wait_for(created.wait(), 1)
        started = time.monotonic()
        with pytest.raises(RegexCleanupError):
            await session.aclose()
        assert time.monotonic() - started < 0.5
        assert session.has_pending_worker and session._cleanup_failed
        assert await session._start() is False
        assert len(actual_processes) == 1
        release.set()
        await asyncio.gather(evaluation, return_exceptions=True)
        await session.aclose()
        assert not session.has_pending_worker
        assert_dead(actual_processes[0].pid)
    asyncio.run(run())


def test_cancellation_remains_authoritative_when_bounded_reap_also_fails(monkeypatch):
    monkeypatch.setattr(supervisor, "KILL_REAP_TIMEOUT_SECONDS", 0.020)
    class UnreapableProcess:
        pid = 123456789
        returncode = None
        stdin = None
        stalled = True
        def __init__(self):
            self.stdout = self
        async def read(self, length):
            if self.stalled:
                await asyncio.Future()
            return b""
        def kill(self):
            pass
        async def wait(self):
            self.returncode = -9
    async def run():
        session = RegexSession()
        process = UnreapableProcess()
        session._process = process
        cleanup = asyncio.create_task(session._cleanup())
        await asyncio.sleep(0.005)
        cleanup.cancel()
        with pytest.raises(asyncio.CancelledError):
            await cleanup
        assert cleanup.cancelled()
        assert session.has_pending_worker and session._cleanup_failed
        process.stalled = False
        await session.aclose()
        assert not session.has_pending_worker
    asyncio.run(run())


def test_real_application_logger_emits_info_spawn_and_reap_to_stderr(monkeypatch):
    from src.utils.logger import setup_logger
    application = logging.getLogger("reverie")
    original_handlers = list(application.handlers)
    original_level = application.level
    child = logging.getLogger(LOGGER_NAME)
    child_level = child.level
    stderr = io.StringIO()
    monkeypatch.setattr(sys, "stderr", stderr)
    try:
        application.handlers.clear()
        child.setLevel(logging.NOTSET)
        setup_logger("reverie", level=logging.INFO)
        assert run_expression(["PRIVATE_PATTERN"], text="PRIVATE_PATTERN").state == "MATCH"
        captured = stderr.getvalue()
        assert "INFO" in captured
        assert f"{LOGGER_NAME}  worldbook_regex_spawn pid=" in captured
        assert f"{LOGGER_NAME}  worldbook_regex_reap pid=" in captured
        assert f"executable={sys.executable}" in captured
        assert "PRIVATE_PATTERN" not in captured
    finally:
        for handler in application.handlers:
            if handler not in original_handlers:
                handler.close()
        application.handlers[:] = original_handlers
        application.setLevel(original_level)
        child.setLevel(child_level)
