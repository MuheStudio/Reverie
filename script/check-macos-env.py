"""Check the project macOS Python and disposable encrypted native storage.

Reports contain versions, paths and check results. Storage keys only cross an
inherited pipe into short-lived child processes; they never enter the reports.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import re
import sqlite3
import subprocess
import sys
import tempfile


ROOT = Path(__file__).resolve().parent.parent
TOOLS = ROOT / ".tools"
VENV = ROOT / ".venv"


def within(candidate: str | Path, directory: Path) -> bool:
    return Path(candidate).resolve().is_relative_to(directory.resolve())


def environment_report() -> dict:
    issues: list[str] = []
    manifest = json.loads((ROOT / "config/macos-toolchain.json").read_text(encoding="utf-8"))
    report = {
        "pythonVersion": platform.python_version(),
        "platform": sys.platform,
        "architecture": platform.machine(),
        "executable": sys.executable,
        "realExecutable": str(Path(sys.executable).resolve()),
        "prefix": sys.prefix,
        "basePrefix": sys.base_prefix,
        "packages": [],
        "nativeModules": [],
        "locks": {},
    }
    if platform.python_version() != manifest["python"]["version"]:
        issues.append(f"Expected CPython {manifest['python']['version']}")
    if platform.python_implementation() != "CPython":
        issues.append("Expected CPython")
    if sys.platform != "darwin" or platform.machine() != "arm64":
        issues.append("Expected macOS arm64 Python")
    if Path(sys.prefix).resolve() != VENV.resolve() or sys.prefix == sys.base_prefix:
        issues.append("Python is not running in the project .venv")
    # uv names its macOS installation directory with "macos", while its
    # download-metadata key uses the operating-system identifier "darwin".
    install_key = f"cpython-{manifest['python']['version']}-macos-aarch64-none"
    if Path(sys.base_prefix).resolve() != (TOOLS / "python" / install_key).resolve():
        issues.append("Base Python does not match the pinned independent project interpreter")
    if not within(sys.executable, TOOLS) and not within(sys.executable, VENV):
        issues.append("Python executable is outside the project toolchain")
    configuration = VENV / "pyvenv.cfg"
    if not configuration.is_file() or not re.search(
        r"^include-system-site-packages\s*=\s*false\s*$",
        configuration.read_text(encoding="utf-8") if configuration.is_file() else "",
        re.MULTILINE | re.IGNORECASE,
    ):
        issues.append(".venv must disable system site packages")

    # Validate installed pins without importing the application or .env.
    expected_packages = dict(manifest["development"])
    for line in (ROOT / "requirements-runtime.txt").read_text(encoding="utf-8").splitlines():
        match = re.fullmatch(r"([A-Za-z0-9_.-]+)==([^\s;]+)", line.strip())
        if not match:
            continue
        name, expected = match.groups()
        expected_packages[name] = expected
    for name in ("requirements-macos-arm64.lock", "requirements-macos-arm64-dev.lock"):
        lock_path = ROOT / name
        if not lock_path.is_file():
            issues.append(f"Missing committed lock: {name}")
            continue
        raw = lock_path.read_bytes()
        report["locks"][name] = hashlib.sha256(raw).hexdigest()
        for line in raw.decode("utf-8").splitlines():
            match = re.match(r"^([A-Za-z0-9_.-]+)==([^\s;\\]+)(?:\s|$)", line)
            if match:
                name, expected = match.groups()
                if name in expected_packages and expected_packages[name] != expected:
                    issues.append(f"Conflicting version pins for {name}")
                expected_packages[name] = expected
    for name, expected in sorted(expected_packages.items()):
        try:
            distribution = importlib.metadata.distribution(name)
            package_path = distribution.locate_file("").resolve()
            report["packages"].append({"name": name, "version": distribution.version, "path": str(package_path)})
            if distribution.version != expected:
                issues.append(f"{name} must be {expected}")
            if not within(package_path, VENV):
                issues.append(f"{name} is outside .venv")
        except importlib.metadata.PackageNotFoundError:
            issues.append(f"Missing package: {name}")
    for name in (
        "sqlcipher3._sqlite3", "sqlite_vec", "numpy._core._multiarray_umath",
        "cryptography.hazmat.bindings._rust", "_cffi_backend", "lxml.etree",
        "PIL._imaging", "pydantic_core._pydantic_core", "jiter", "primp",
    ):
        try:
            module = importlib.import_module(name)
            origin = str(Path(module.__file__).resolve())
            report["nativeModules"].append({"name": name, "path": origin})
            if not within(origin, VENV):
                issues.append(f"{name} imports from outside .venv")
        except Exception as error:
            issues.append(f"{name} could not import: {type(error).__name__}")
    report.update(ok=not issues, issues=issues)
    return report


def storage_worker(mode: str, database: Path) -> int:
    # -I deliberately omits the checkout from sys.path. Add only this known
    # project root for the production storage adapter, not arbitrary PYTHONPATH.
    sys.path.insert(0, str(ROOT))
    from src.storage.encrypted_sqlite import (
        EncryptedStorageError,
        connect_database,
        initialize_storage_from_environment,
    )
    from sqlcipher3 import dbapi2 as sqlcipher

    initialize_storage_from_environment()
    try:
        connection = connect_database(database)
    except (EncryptedStorageError, sqlcipher.DatabaseError):
        if mode == "wrong-key":
            print(json.dumps({"ok": True, "wrongKeyRejected": True}))
            return 0
        raise
    if mode == "wrong-key":
        connection.close()
        raise RuntimeError("Wrong key unexpectedly opened the encrypted database")
    try:
        import sqlite_vec

        connection.enable_load_extension(True)
        try:
            sqlite_vec.load(connection)
        finally:
            connection.enable_load_extension(False)
        cipher_version = connection.execute("PRAGMA cipher_version").fetchone()[0]
        if not cipher_version:
            raise RuntimeError("SQLCipher is unavailable")
        if mode == "create":
            connection.execute("CREATE TABLE proof(value TEXT NOT NULL)")
            connection.execute("INSERT INTO proof(value) VALUES (?)", ("Reverie native encrypted storage proof 中文",))
            connection.execute("CREATE VIRTUAL TABLE vectors USING vec0(embedding float[3])")
            connection.executemany("INSERT INTO vectors(rowid, embedding) VALUES (?, ?)", [(1, "[1,0,0]"), (2, "[0,1,0]")])
        value = connection.execute("SELECT value FROM proof").fetchone()[0]
        if value != "Reverie native encrypted storage proof 中文":
            raise RuntimeError("Encrypted data did not survive the process restart")
        rows = connection.execute("SELECT rowid, distance FROM vectors WHERE embedding MATCH ? AND k = 1 ORDER BY distance", ("[1,0,0]",)).fetchall()
        if len(rows) != 1 or rows[0]["rowid"] != 1 or abs(rows[0]["distance"]) > 1e-6:
            raise RuntimeError("sqlite-vec nearest-neighbor query returned an unexpected result")
        if connection.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise RuntimeError("Encrypted database integrity check failed")
        if connection.execute("PRAGMA cipher_integrity_check").fetchall():
            raise RuntimeError("Encrypted page authentication failed")
        print(json.dumps({"ok": True, "mode": mode, "sqlcipherVersion": cipher_version, "sqliteVecVersion": connection.execute("SELECT vec_version()").fetchone()[0], "nearestRowId": 1}))
        return 0
    finally:
        connection.close()


def run_storage_child(mode: str, database: Path, key: bytearray) -> dict:
    read_fd, write_fd = os.pipe()
    child_env = dict(os.environ)
    child_env.update(REVERIE_REQUIRE_ENCRYPTED_STORAGE="1", REVERIE_STORAGE_KEY_FD=str(read_fd))
    try:
        process = subprocess.Popen(
            [sys.executable, "-I", "-B", str(Path(__file__).resolve()), "--storage-worker", mode, "--database", str(database)],
            pass_fds=(read_fd,), env=child_env, stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
    except OSError as error:
        os.close(write_fd)
        return {"mode": mode, "ok": False, "error": type(error).__name__, "errorDetail": str(error)[:400]}
    except BaseException:
        os.close(write_fd)
        raise
    finally:
        os.close(read_fd)
    try:
        with os.fdopen(write_fd, "wb", closefd=True) as stream:
            stream.write(key)
        try:
            stdout, stderr = process.communicate(timeout=40)
        except subprocess.TimeoutExpired:
            process.kill()
            _stdout, stderr = process.communicate()
            return {"mode": mode, "ok": False, "error": "worker_timeout", "stderrSummary": safe_stderr(stderr, key)}
    except BaseException:
        process.kill()
        process.communicate()
        raise
    try:
        result = json.loads(stdout)
    except json.JSONDecodeError:
        return {"mode": mode, "ok": False, "error": "invalid_worker_report", "exitCode": process.returncode, "stderrSummary": safe_stderr(stderr, key)}
    if process.returncode != 0:
        return {"mode": mode, "ok": False, "exitCode": process.returncode, "error": result.get("error", "storage_worker_failed"), "stderrSummary": safe_stderr(stderr, key)}
    return {"mode": mode, **result}


def safe_stderr(value: str, key: bytearray) -> str:
    value = value.replace(key.hex(), "[redacted-key]").replace(key.hex().upper(), "[redacted-key]")
    value = re.sub(r"\b[0-9a-fA-F]{64}\b", "[redacted-hex]", value)
    value = re.sub(r"[\x00-\x08\x0b-\x1f\x7f]", "", value)
    return value[-1600:]


def storage_report(scratch: Path) -> dict:
    if not within(scratch, ROOT / ".tools/reports"):
        raise ValueError("Native checks require scratch space under .tools/reports")
    scratch.mkdir(parents=True, exist_ok=True)
    key = bytearray(os.urandom(32))
    wrong_key = bytearray(os.urandom(32))
    checks: list[dict] = []
    try:
        with tempfile.TemporaryDirectory(prefix="encrypted-check-", dir=scratch) as directory:
            database = Path(directory) / "native.sqlite3"
            for mode, selected_key in (("create", key), ("reopen", key), ("wrong-key", wrong_key)):
                checks.append(run_storage_child(mode, database, selected_key))
                if not checks[-1]["ok"]:
                    return {"ok": False, "checks": checks}
            raw = database.read_bytes()
            plaintext_absent = not raw.startswith(b"SQLite format 3\x00") and b"Reverie native encrypted storage proof" not in raw
            checks.append({"mode": "encrypted-file-content", "ok": plaintext_absent})
            connection = sqlite3.connect(f"{database.as_uri()}?mode=ro", uri=True)
            try:
                try:
                    connection.execute("SELECT value FROM proof").fetchall()
                except sqlite3.DatabaseError:
                    checks.append({"mode": "standard-sqlite-rejected", "ok": True})
                else:
                    checks.append({"mode": "standard-sqlite-rejected", "ok": False})
            finally:
                connection.close()
    finally:
        key[:] = b"\x00" * len(key)
        wrong_key[:] = b"\x00" * len(wrong_key)
    return {"ok": all(check["ok"] for check in checks), "checks": checks}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=("environment", "storage"), default="environment")
    parser.add_argument("--report", type=Path)
    parser.add_argument("--scratch", type=Path)
    parser.add_argument("--storage-worker", choices=("create", "reopen", "wrong-key"))
    parser.add_argument("--database", type=Path)
    options = parser.parse_args()
    if options.storage_worker:
        try:
            return storage_worker(options.storage_worker, options.database)
        except Exception as error:
            # SQL errors can contain SQL text. Report only the exception class.
            print(json.dumps({"ok": False, "error": type(error).__name__}))
            return 1
    try:
        report = environment_report() if options.mode == "environment" else storage_report(options.scratch)
    except Exception as error:
        report = {"ok": False, "error": type(error).__name__}
    serialized = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if options.report:
        options.report.write_text(serialized, encoding="utf-8")
    print(serialized, end="")
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
