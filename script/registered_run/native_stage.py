"""One serial CTest selection followed by one six-group evidence consumer.

The parent engine owns the process group and outer deadline. Children remain
in that group; this wrapper adds no retry or second Node test batch.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from script.registered_run.catalog import native_stage_plan
from script.registered_run.isolation import assert_not_data_path, canonical_directory
from script.registered_run.modes.context import RunContext


def run_native(context, environment=None):
    canonical_directory(context.report_dir)
    assert_not_data_path(context.report_dir, context.root)
    assert_not_data_path(context.root / context.config["cmakeDirectory"], context.root)
    plan = native_stage_plan(context)
    environment = dict(os.environ if environment is None else environment)
    for group in plan["groups"]:
        prefix = group["errorPrefix"]
        if environment.get(group["environmentKey"]) != group["directory"]:
            raise RuntimeError(prefix + "_EVIDENCE_ENVIRONMENT_NOT_BOUND")
        if os.path.lexists(group["directory"]) or os.path.lexists(group["verdict"]):
            raise RuntimeError(prefix + "_EVIDENCE_NOT_FRESH")
    for name in plan["createDirectories"]:
        Path(name).mkdir(mode=0o700)
    completed = subprocess.run(plan["ctest"], cwd=context.root, env=environment)
    if completed.returncode:
        return completed.returncode
    return subprocess.run(plan["consumer"], cwd=context.root, env=environment).returncode


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--config", type=Path, required=True)
    args = parser.parse_args(argv)
    config = json.loads(args.config.read_text())
    return run_native(RunContext(args.root, args.report, config))


if __name__ == "__main__":
    raise SystemExit(main())
