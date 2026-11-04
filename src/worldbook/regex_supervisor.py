"""Bounded, killable per-turn regex sessions using public asyncio subprocess APIs.

Independent implementation from the approved contract and Python documentation:
https://docs.python.org/3/library/asyncio-subprocess.html
No legacy matching code was consulted. Repository GPL-3.0 terms apply.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
import json
import logging
from pathlib import Path
import struct
import sys
import time
from typing import Sequence


STARTUP_BUDGET_SECONDS = 1.0
ENTRY_BUDGET_SECONDS = 0.050
EXECUTION_BUDGET_SECONDS = 0.500
KILL_REAP_TIMEOUT_SECONDS = 1.0
MAX_REQUEST_BYTES = 8 * 1024 * 1024
MAX_RESPONSE_BYTES = 4 * 1024
MAX_TEXT_CHARACTERS = 1_048_576
MAX_PATTERN_CHARACTERS = 16_384
MAX_PATTERNS = 200
_LOGGER = logging.getLogger("reverie.worldbook.regex_supervisor")
_CODES = frozenset({"invalid_regex", "regex_worker_unavailable", "regex_input_limit"})


@dataclass(frozen=True, slots=True)
class RegexOutcome:
    state: str
    code: str = ""


class RegexCleanupError(RuntimeError):
    def __init__(self) -> None:
        super().__init__("regex_worker_unavailable")


class RegexSession:
    """One turn's regex budget and lazily-created private subprocess.

    A timeout destroys the worker, allowing a later healthy entry to start a
    fresh worker using the remaining startup and execution budgets. aclose()
    always kills and awaits exit; cleanup itself has a fixed 1s deadline and
    raises a code-only error rather than silently detaching an unreaped worker.
    The private worker-path seam is used only by synthetic protocol tests.
    """

    def __init__(self, *, _worker_path: Path | None = None) -> None:
        self._worker_path = _worker_path or Path(__file__).with_name("regex_worker.py")
        self._process: asyncio.subprocess.Process | None = None
        self._startup_spent = 0.0
        self._execution_spent = 0.0
        self._closed = False
        self._cleanup_lock = asyncio.Lock()
        self._request_lock = asyncio.Lock()
        self._exchange_task: asyncio.Task | None = None
        self._startup_task: asyncio.Task | None = None
        self._spawn_task: asyncio.Task | None = None
        self._recovery_task: asyncio.Task | None = None
        self._cleanup_failed = False

    @property
    def active_pid(self) -> int | None:
        process = self._process
        return process.pid if process is not None and process.returncode is None else None

    @property
    def has_pending_worker(self) -> bool:
        return self._process is not None or self._spawn_task is not None

    def _attach(self, process: asyncio.subprocess.Process) -> None:
        if self._process is process:
            return
        self._process = process
        _LOGGER.info("worldbook_regex_spawn pid=%d executable=%s", process.pid, sys.executable)

    async def _read_frame(self, process: asyncio.subprocess.Process) -> dict:
        assert process.stdout is not None
        length = struct.unpack("!I", await process.stdout.readexactly(4))[0]
        if length == 0 or length > MAX_RESPONSE_BYTES:
            raise ValueError("invalid_worker_frame")
        payload = await process.stdout.readexactly(length)
        result = json.loads(payload.decode("utf-8"))
        if not isinstance(result, dict):
            raise ValueError("invalid_worker_frame")
        return result

    async def _spawn_ready(self) -> None:
        self._spawn_task = asyncio.create_task(asyncio.create_subprocess_exec(
            sys.executable, "-I", "-B", str(self._worker_path),
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL, limit=MAX_RESPONSE_BYTES, close_fds=True,
        ))
        # Cancellation must not discard the creation future: it may already
        # own a real child before asyncio returns its Process handle.
        process = await asyncio.shield(self._spawn_task)
        self._attach(process)
        self._spawn_task = None
        if self._closed or self._cleanup_failed:
            raise ValueError("worker_closed_during_startup")
        ready = await self._read_frame(self._process)
        if ready != {"ready": True, "protocol": 1}:
            raise ValueError("invalid_worker_ready")

    async def _start(self) -> bool:
        if self._closed or self._cleanup_failed or self._spawn_task is not None:
            return False
        if self._process is not None and self._process.returncode is None:
            return True
        remaining = STARTUP_BUDGET_SECONDS - self._startup_spent
        if remaining <= 0:
            return False
        started = time.monotonic()
        try:
            self._startup_task = asyncio.create_task(self._spawn_ready())
            await asyncio.wait_for(self._startup_task, timeout=remaining)
            return not self._closed
        except asyncio.CancelledError:
            await self._cleanup()
            raise
        except Exception:
            if self._process is not None:
                _LOGGER.warning("worldbook_regex_startup_failed pid=%d executable=%s",
                                self._process.pid, sys.executable)
            await self._cleanup()
            return False
        finally:
            self._startup_task = None
            self._startup_spent += time.monotonic() - started

    def _late_spawn(self, task: asyncio.Task) -> None:
        """Keep a timed-out spawn owned; kill immediately if it later resolves."""
        if self._spawn_task is not task:
            return
        try:
            process = task.result()
        except BaseException:
            self._spawn_task = None
            return
        self._attach(process)
        self._spawn_task = None
        if process.returncode is None:
            try:
                process.kill()
            except ProcessLookupError:
                pass
        # A failed bounded cleanup was already reported to its caller. This
        # retained recovery task owns late reaping and is also joined by aclose.
        if self._recovery_task is None or self._recovery_task.done():
            self._recovery_task = asyncio.create_task(self._cleanup())
            self._recovery_task.add_done_callback(self._recovery_done)

    def _recovery_done(self, task: asyncio.Task) -> None:
        if not task.cancelled():
            task.exception()  # _stop_process already emits a code-only failure log.

    async def _stop_process(self) -> None:
        async with self._cleanup_lock:
            async def reap() -> None:
                # Stop readers even when process creation is not attached yet.
                for reader in (self._exchange_task, self._startup_task):
                    if reader is not None and not reader.done():
                        reader.cancel()
                        await asyncio.gather(reader, return_exceptions=True)
                if self._spawn_task is not None:
                    spawn = self._spawn_task
                    try:
                        process = await asyncio.shield(spawn)
                    except asyncio.CancelledError:
                        raise
                    except Exception:
                        self._spawn_task = None
                    else:
                        self._attach(process)
                        self._spawn_task = None
                process = self._process
                if process is None:
                    return
                if process.returncode is None:
                    try:
                        process.kill()
                    except ProcessLookupError:
                        pass
                if process.stdin is not None:
                    process.stdin.close()
                # Discard output with constant memory so paused pipes cannot
                # deadlock wait() after the producer has been killed.
                if process.stdout is not None:
                    while await process.stdout.read(MAX_RESPONSE_BYTES):
                        pass
                await process.wait()
                self._process = None
                _LOGGER.info("worldbook_regex_reap pid=%d executable=%s", process.pid, sys.executable)

            try:
                await asyncio.wait_for(reap(), timeout=KILL_REAP_TIMEOUT_SECONDS)
                self._cleanup_failed = False
            except Exception:
                self._cleanup_failed = True
                pid = self._process.pid if self._process is not None else 0
                _LOGGER.error("worldbook_regex_reap_failed pid=%d executable=%s", pid, sys.executable)
                if self._spawn_task is not None:
                    self._spawn_task.add_done_callback(self._late_spawn)
                # Keep every process/creation handle: another entry may never
                # start a replacement while this cleanup remains unresolved.
                raise RegexCleanupError() from None

    async def _cleanup(self) -> None:
        task = asyncio.create_task(self._stop_process())
        cancelled = False
        failure: Exception | None = None
        while True:
            try:
                await asyncio.shield(task)
                break
            except asyncio.CancelledError:
                cancelled = True
                if task.done():
                    try:
                        task.result()
                    except asyncio.CancelledError:
                        pass
                    except Exception as error:
                        failure = error
                    break
            except Exception as error:
                failure = error
                break
        caller = asyncio.current_task()
        if cancelled or (caller is not None and caller.cancelling()):
            # A bounded reap error remains recorded on this session. Preserve
            # cancellation so callers cannot downgrade it into continued chat.
            raise asyncio.CancelledError() from None
        if failure is not None:
            raise failure

    async def aclose(self) -> None:
        self._closed = True
        await self._cleanup()
        recovery = self._recovery_task
        if recovery is not None and not recovery.done() and recovery is not asyncio.current_task():
            await asyncio.shield(recovery)

    async def evaluate(self, primary: Sequence[str], secondary: Sequence[str],
                       selective_logic: str, case_sensitive: bool, text: str) -> RegexOutcome:
        async with self._request_lock:
            if self._closed:
                return RegexOutcome("ERROR", "regex_worker_unavailable")
            if self._execution_spent >= EXECUTION_BUDGET_SECONDS:
                return RegexOutcome("ERROR", "regex_budget_exhausted")
            if not isinstance(text, str) or len(text) > MAX_TEXT_CHARACTERS \
                    or type(case_sensitive) is not bool \
                    or selective_logic not in {"and_any", "and_all", "not_any", "not_all"}:
                return RegexOutcome("ERROR", "regex_input_limit")
            for patterns in (primary, secondary):
                if not isinstance(patterns, (tuple, list)) or len(patterns) > MAX_PATTERNS or any(
                    not isinstance(pattern, str) or len(pattern) > MAX_PATTERN_CHARACTERS for pattern in patterns
                ):
                    return RegexOutcome("ERROR", "regex_input_limit")
            if not primary:
                return RegexOutcome("NO_MATCH")
            started = time.monotonic()
            try:
                payload = json.dumps({
                    "primary": list(primary), "secondary": list(secondary),
                    "selective_logic": selective_logic, "case_sensitive": case_sensitive, "text": text,
                }, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            except (TypeError, ValueError, UnicodeError):
                return RegexOutcome("ERROR", "regex_input_limit")
            finally:
                preparation = time.monotonic() - started
                self._execution_spent += preparation
            if len(payload) > MAX_REQUEST_BYTES:
                return RegexOutcome("ERROR", "regex_input_limit")
            if self._execution_spent >= EXECUTION_BUDGET_SECONDS:
                return RegexOutcome("ERROR", "regex_budget_exhausted")
            if preparation >= ENTRY_BUDGET_SECONDS:
                return RegexOutcome("ERROR", "regex_timeout")
            if not await self._start():
                return RegexOutcome("ERROR", "regex_worker_unavailable")
            process = self._process
            if self._closed or process is None:
                return RegexOutcome("ERROR", "regex_worker_unavailable")
            entry_remaining = ENTRY_BUDGET_SECONDS - preparation
            total_remaining = EXECUTION_BUDGET_SECONDS - self._execution_spent
            timeout = min(entry_remaining, total_remaining)

            async def exchange() -> dict:
                assert process.stdin is not None
                process.stdin.write(struct.pack("!I", len(payload)) + payload)
                await process.stdin.drain()
                return await self._read_frame(process)

            started = time.monotonic()
            try:
                self._exchange_task = asyncio.create_task(exchange())
                response = await asyncio.wait_for(self._exchange_task, timeout=timeout)
                if set(response) != {"state", "code"} or response["state"] not in {"MATCH", "NO_MATCH", "ERROR"}:
                    raise ValueError("invalid_worker_result")
                if response["state"] == "ERROR":
                    if response["code"] not in _CODES:
                        raise ValueError("invalid_worker_code")
                elif response["code"] != "":
                    raise ValueError("invalid_worker_code")
                return RegexOutcome(response["state"], response["code"])
            except asyncio.TimeoutError:
                _LOGGER.warning("worldbook_regex_timeout pid=%d executable=%s", process.pid, sys.executable)
                await self._cleanup()
                return RegexOutcome("ERROR", "regex_budget_exhausted" if total_remaining <= entry_remaining
                                    else "regex_timeout")
            except asyncio.CancelledError:
                await self.aclose()
                raise
            except RegexCleanupError:
                raise
            except Exception:
                await self._cleanup()
                return RegexOutcome("ERROR", "regex_worker_unavailable")
            finally:
                self._exchange_task = None
                self._execution_spent += time.monotonic() - started
