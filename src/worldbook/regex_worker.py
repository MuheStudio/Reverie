"""Private stdlib-only regex subprocess, independently authored for this engine.

No legacy implementation was consulted. Repository Apache-2.0 terms apply.
This script is launched by the supervisor with the current Python and -I -B.
Only fixed-size framed status records leave stdout. Patterns and messages are
received through private pipes, never argv, files, logs or exception messages.
"""

from __future__ import annotations

import json
import re
import struct
import sys


MAX_REQUEST_BYTES = 8 * 1024 * 1024
MAX_RESPONSE_BYTES = 4 * 1024
MAX_TEXT_CHARACTERS = 1_048_576
MAX_PATTERN_CHARACTERS = 16_384
MAX_PATTERNS = 200
_LOGICS = {"and_any", "and_all", "not_any", "not_all"}


def _write(value: dict) -> None:
    data = json.dumps(value, separators=(",", ":")).encode("utf-8")
    if len(data) > MAX_RESPONSE_BYTES:
        raise ValueError("response_limit")
    sys.stdout.buffer.write(struct.pack("!I", len(data)) + data)
    sys.stdout.buffer.flush()


def _read_exact(length: int) -> bytes:
    chunks = bytearray()
    while len(chunks) < length:
        chunk = sys.stdin.buffer.read(length - len(chunks))
        if not chunk:
            raise EOFError()
        chunks.extend(chunk)
    return bytes(chunks)


def _outcome(state: str, code: str = "") -> dict:
    return {"state": state, "code": code}


def evaluate(value: object) -> dict:
    if not isinstance(value, dict) or set(value) != {
        "primary", "secondary", "selective_logic", "case_sensitive", "text"
    }:
        return _outcome("ERROR", "regex_worker_unavailable")
    primary = value["primary"]
    secondary = value["secondary"]
    text = value["text"]
    logic = value["selective_logic"]
    if not isinstance(text, str) or len(text) > MAX_TEXT_CHARACTERS \
            or type(value["case_sensitive"]) is not bool or logic not in _LOGICS:
        return _outcome("ERROR", "regex_input_limit")
    for patterns in (primary, secondary):
        if not isinstance(patterns, list) or len(patterns) > MAX_PATTERNS or any(
            not isinstance(pattern, str) or len(pattern) > MAX_PATTERN_CHARACTERS
            for pattern in patterns
        ):
            return _outcome("ERROR", "regex_input_limit")
    flags = 0 if value["case_sensitive"] else re.IGNORECASE
    try:
        # Evaluate every participating pattern: a prior match must not conceal
        # an invalid later expression. Auxiliary patterns participate only once
        # the primary-any condition succeeds. Errors never become false values.
        primary_matches = [re.compile(pattern, flags).search(text) is not None for pattern in primary]
        if not any(primary_matches):
            return _outcome("NO_MATCH")
        if not secondary:
            return _outcome("MATCH")
        auxiliary = [re.compile(pattern, flags).search(text) is not None for pattern in secondary]
        matched = {"and_any": any(auxiliary), "and_all": all(auxiliary),
                   "not_any": not any(auxiliary), "not_all": not all(auxiliary)}[logic]
        return _outcome("MATCH" if matched else "NO_MATCH")
    except (re.error, RecursionError, OverflowError):
        return _outcome("ERROR", "invalid_regex")
    except Exception:
        return _outcome("ERROR", "regex_worker_unavailable")


def main() -> None:
    _write({"ready": True, "protocol": 1})
    while True:
        try:
            header = _read_exact(4)
            length = struct.unpack("!I", header)[0]
            if length == 0 or length > MAX_REQUEST_BYTES:
                return
            value = json.loads(_read_exact(length).decode("utf-8"))
            _write(evaluate(value))
        except EOFError:
            return
        except Exception:
            # Do not send exception text or a traceback containing user data.
            return


if __name__ == "__main__":
    main()
