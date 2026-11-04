"""Per-run bindings for mechanically extracted host checks.

The retained checks use their original names for ROOT and REPORT. Each context
gets a private function-global dictionary; no module path is mutated and no
historical runner is loaded. This is a bounded compatibility layer over the
tracked verifier modules, not a dynamically generated per-round runner.
"""

from __future__ import annotations

from collections import Counter
from copy import deepcopy
from dataclasses import dataclass, field
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
from types import FunctionType
from typing import Mapping
import xml.etree.ElementTree as ET

from ..contracts import formal
from . import (
    backup, candidate, card_export, card_edit, common, directory_diagnostics, entry, feedback_probe,
    gui_common, injection, native_evidence, ordinary, persona, regex, settings,
    summary_acquisition, summary_input_probe, summary_view, units,
)


CHECK_MODULES = (
    common, units, backup, feedback_probe, summary_input_probe,
    directory_diagnostics, native_evidence, gui_common, injection, regex,
    entry, persona, candidate, ordinary, summary_acquisition, summary_view,
    settings, card_export, card_edit,
)


@dataclass
class RunContext:
    root: Path
    report_dir: Path
    config: Mapping
    _namespace: dict = field(init=False, repr=False)

    def __post_init__(self):
        self.root = Path(self.root).absolute()
        self.report_dir = Path(self.report_dir).absolute()
        self.config = deepcopy(dict(self.config))
        namespace = {
            "__builtins__": __builtins__, "Counter": Counter,
            "datetime": datetime, "timezone": timezone, "hashlib": hashlib,
            "importlib": importlib, "json": json, "math": math, "os": os,
            "Path": Path, "PurePosixPath": PurePosixPath, "re": re,
            "stat": stat, "subprocess": subprocess, "ET": ET,
            "ROOT": self.root, "REPORT": self.report_dir,
            "NAME": self.config.get("candidateName"),
            "CMAKE_DIRECTORY": self.config.get("cmakeDirectory"),
            "NODE_TEST_FILES": deepcopy(self.config.get("nodeTests", [])),
        }
        namespace.update({name: deepcopy(value) for name, value in vars(formal).items()
                          if name.isupper()})
        functions = {name: value for module in CHECK_MODULES
                     for name, value in vars(module).items()
                     if isinstance(value, FunctionType) and value.__module__ == module.__name__}
        for name, original in functions.items():
            bound = FunctionType(original.__code__, namespace, name,
                                 original.__defaults__, original.__closure__)
            bound.__kwdefaults__ = original.__kwdefaults__
            bound.__doc__ = original.__doc__
            namespace[name] = bound
        self._namespace = namespace

    def invoke(self, check: str, *args, **kwargs):
        function = self._namespace.get(check)
        if not isinstance(function, FunctionType):
            raise ValueError("UNKNOWN_HOST_CHECK:" + check)
        return function(*args, **kwargs)
