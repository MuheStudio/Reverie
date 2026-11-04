"""QtTest registration rules shared by native batch runners.

A row identity is ``Class::case(tag)`` from a CTest LastTest log, grouped by
CTest target. Two rules come from batches that stopped on registration rather
than on tests:

* QtTest always reports ``initTestCase()`` and ``cleanupTestCase()``, so both
  rows count toward every target's total (memory paging r5 registered 430
  where the binaries reported 432).
* Inherited rows are history and are compared by multiplicity. An existing
  duplicate data tag is never required to be unique (candidate paging r8
  failed its own preflight on ``len(baseline) == len(set(baseline))``). Only
  newly added identities must be unique and must not collide with history.

``plan`` can be run offline against the previous batch's real log before a
runner is frozen. It reads files only and runs no test.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path

PASS_ROW = re.compile(r"^PASS\s+:\s+([^\s]+)::([^\r\n]+)$", re.M)
TARGET_BLOCK = re.compile(r"^\d+/\d+ Testing: ([^\r\n]+)\r?\n", re.M)
LIFECYCLE = ("initTestCase()", "cleanupTestCase()")


class RegistrationError(ValueError):
    """A registration rule failed; ``details`` carries the observed values."""

    def __init__(self, code: str, **details: object) -> None:
        self.code = code
        self.details = details
        super().__init__(code + " " + json.dumps(details, ensure_ascii=False, sort_keys=True))


def parse_transcript(text: str) -> dict[str, list[str]]:
    """Return PASS identities per CTest target, in log order."""
    parts = TARGET_BLOCK.split(text)
    targets: dict[str, list[str]] = {}
    for target, body in zip(parts[1::2], parts[2::2]):
        if target in targets:
            raise RegistrationError("TARGET_REPEATED", target=target)
        targets[target] = [cls + "::" + case for cls, case in PASS_ROW.findall(body)]
    return targets


def lifecycle_rows(identities: list[str]) -> int:
    return sum(1 for identity in identities if identity.split("::", 1)[-1] in LIFECYCLE)


def duplicates(identities: list[str]) -> dict[str, int]:
    return {identity: count for identity, count in Counter(identities).items() if count > 1}


def summarize(targets: dict[str, list[str]]) -> dict[str, dict]:
    return {
        target: {
            "rows": len(rows),
            "lifecycleRows": lifecycle_rows(rows),
            "functionalRows": len(rows) - lifecycle_rows(rows),
            "uniqueIdentities": len(set(rows)),
            "duplicates": duplicates(rows),
        }
        for target, rows in targets.items()
    }


def plan(
    baseline: dict[str, list[str]],
    added: dict[str, list[str]] | None = None,
    removed: dict[str, list[str]] | None = None,
) -> dict[str, Counter]:
    """Expected identity multisets: baseline + added - removed, per target."""
    added = added or {}
    removed = removed or {}
    for target in list(added) + list(removed):
        if target not in baseline:
            raise RegistrationError("TARGET_NOT_IN_BASELINE", target=target)
    expected = {target: Counter(rows) for target, rows in baseline.items()}
    for target, rows in added.items():
        repeated = duplicates(rows)
        if repeated:
            raise RegistrationError("ADDED_IDENTITY_REPEATED", target=target, identities=repeated)
        collisions = sorted(identity for identity in rows if expected[target][identity])
        if collisions:
            raise RegistrationError(
                "ADDED_IDENTITY_ALREADY_REGISTERED", target=target, identities=collisions
            )
        expected[target].update(rows)
    for target, rows in removed.items():
        wanted = Counter(rows)
        short = {
            identity: {"remove": count, "registered": expected[target][identity]}
            for identity, count in wanted.items()
            if expected[target][identity] < count
        }
        if short:
            raise RegistrationError("REMOVED_IDENTITY_NOT_REGISTERED", target=target, identities=short)
        expected[target].subtract(wanted)
        expected[target] = +expected[target]
    return expected


def compare(expected: dict[str, Counter], observed: dict[str, list[str]]) -> list[dict]:
    """Every difference, with both counts; an empty list means a match."""
    differences: list[dict] = []
    for target in sorted(set(expected) | set(observed)):
        if target not in observed:
            differences.append({"target": target, "kind": "target-missing"})
            continue
        if target not in expected:
            differences.append({"target": target, "kind": "target-unexpected"})
            continue
        actual = Counter(observed[target])
        for identity in sorted(set(expected[target]) | set(actual)):
            if expected[target][identity] != actual[identity]:
                differences.append({
                    "target": target,
                    "kind": "count",
                    "identity": identity,
                    "expected": expected[target][identity],
                    "observed": actual[identity],
                })
    return differences


def totals(expected: dict[str, Counter]) -> dict[str, int]:
    return {target: sum(rows.values()) for target, rows in expected.items()}


def _load_targets(path: str) -> dict[str, list[str]]:
    value = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(value, dict) or not all(
        isinstance(rows, list) and all(isinstance(row, str) for row in rows) for rows in value.values()
    ):
        raise RegistrationError("TARGET_FILE_SHAPE", path=path)
    return value


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    commands = parser.add_subparsers(dest="command", required=True)
    summary = commands.add_parser("summarize", help="per-target rows, lifecycle rows and duplicates")
    summary.add_argument("log")
    planned = commands.add_parser("plan", help="expected totals from a real log plus added/removed rows")
    planned.add_argument("--baseline-log", required=True)
    planned.add_argument("--added")
    planned.add_argument("--removed")
    args = parser.parse_args(argv)
    try:
        if args.command == "summarize":
            result: dict = summarize(parse_transcript(Path(args.log).read_text(encoding="utf-8")))
        else:
            baseline = parse_transcript(Path(args.baseline_log).read_text(encoding="utf-8"))
            expected = plan(
                baseline,
                _load_targets(args.added) if args.added else None,
                _load_targets(args.removed) if args.removed else None,
            )
            per_target = totals(expected)
            result = {"targets": per_target, "qtTestTotals": sum(per_target.values()),
                      "lifecycleRows": {t: lifecycle_rows(list(c.elements())) for t, c in expected.items()}}
    except RegistrationError as error:
        print(json.dumps({"ok": False, "code": error.code, "details": error.details},
                         ensure_ascii=False, sort_keys=True))
        return 1
    print(json.dumps({"ok": True, **result}, ensure_ascii=False, sort_keys=True, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
