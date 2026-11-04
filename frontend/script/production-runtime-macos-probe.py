"""Build-time probe for a relocated production Python; never shipped as a dependency."""
from __future__ import annotations

import argparse
import importlib
import importlib.metadata
import importlib.util
import json
import os
from pathlib import Path
import platform
import re
import socket
import sqlite3
import subprocess
import sys


def canonical(name):
    return re.sub(r"[-_.]+", "-", name).lower()


def deny_network(*_args, **_kwargs):
    raise RuntimeError("Production runtime probe forbids network access")


def inventory(root, expected):
    assert platform.python_version() == "3.12.14"
    assert platform.machine() == "arm64" and sys.platform == "darwin"
    assert Path(sys.prefix).resolve() == root
    assert Path(sys.base_prefix).resolve() == root
    assert Path(sys.executable).resolve() == root / "bin/python3.12"
    assert not (root / "pyvenv.cfg").exists()
    for entry in sys.path:
        assert entry and Path(entry).resolve().is_relative_to(root), f"External sys.path entry: {entry}"
    packages = []
    observed = {}
    for distribution in importlib.metadata.distributions():
        name = canonical(distribution.metadata["Name"])
        assert name not in observed, f"Duplicate distribution: {name}"
        observed[name] = distribution.version
        location = Path(distribution.locate_file("")).resolve()
        assert location.is_relative_to(root), f"External distribution: {name}"
        licenses = []
        for relative in distribution.files or ():
            filename = Path(str(relative))
            if re.match(r"^(licen[cs]e|copying|notice)([._-].*)?$", filename.name, re.I):
                source = Path(distribution.locate_file(relative)).resolve()
                if source.is_file():
                    assert source.is_relative_to(root)
                    licenses.append(source.relative_to(root).as_posix())
        packages.append({"name": name, "version": distribution.version,
                         "location": location.relative_to(root).as_posix(),
                         "licenseExpression": distribution.metadata.get("License-Expression"),
                         "licenseMetadata": distribution.metadata.get("License"),
                         "licenseFiles": sorted(licenses)})
    assert observed == expected, f"Installed distribution set differs from runtime lock: {observed}"
    for module in ("pip", "ensurepip", "setuptools", "wheel", "uv", "pytest", "hypothesis", "playwright", "textual", "yaml", "torch", "sentence_transformers", "lancedb"):
        assert importlib.util.find_spec(module) is None, f"Unexpected developer/optional package: {module}"
    return {"pythonVersion": platform.python_version(), "architecture": platform.machine(),
            "prefixMatchesRuntime": True, "basePrefixMatchesRuntime": True,
            "venv": False, "packages": sorted(packages, key=lambda item: item["name"])}


def storage_worker(database, mode):
    from sqlcipher3 import dbapi2 as cipher
    import sqlite_vec

    key = bytearray(sys.stdin.buffer.read())
    assert len(key) == 32
    connection = cipher.connect(str(database), isolation_level=None)
    try:
        connection.execute(f"PRAGMA key = \"x'{key.hex()}'\"")
        try:
            connection.execute("SELECT count(*) FROM sqlite_master").fetchone()
        except cipher.DatabaseError:
            if mode == "wrong-key":
                return {"wrongKeyRejected": True}
            raise
        assert mode != "wrong-key", "Wrong key was accepted"
        connection.enable_load_extension(True)
        try:
            sqlite_vec.load(connection)
        finally:
            connection.enable_load_extension(False)
        if mode == "create":
            connection.execute("CREATE TABLE proof(value TEXT NOT NULL)")
            connection.execute("INSERT INTO proof VALUES ('Reverie relocated runtime 中文')")
            connection.execute("CREATE VIRTUAL TABLE vectors USING vec0(embedding float[3])")
            connection.executemany("INSERT INTO vectors(rowid, embedding) VALUES (?, ?)", [(1, "[1,0,0]"), (2, "[0,1,0]")])
        assert connection.execute("SELECT value FROM proof").fetchone()[0] == "Reverie relocated runtime 中文"
        row = connection.execute("SELECT rowid, distance FROM vectors WHERE embedding MATCH ? AND k=1 ORDER BY distance", ("[1,0,0]",)).fetchone()
        assert row[0] == 1 and abs(row[1]) < 1e-6
        assert connection.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        assert not connection.execute("PRAGMA cipher_integrity_check").fetchall()
        return {"sqlcipherVersion": connection.execute("PRAGMA cipher_version").fetchone()[0],
                "sqliteVecVersion": connection.execute("SELECT vec_version()").fetchone()[0],
                "nearestRowId": 1, "mode": mode}
    finally:
        connection.close()
        key[:] = b"\x00" * len(key)


def probe(root, expected, scratch):
    info = inventory(root, expected)
    # No project imports, ambient environment, model cache or network are used.
    socket.socket.connect = deny_network
    socket.socket.connect_ex = deny_network
    socket.create_connection = deny_network
    socket.getaddrinfo = deny_network
    modules = (
        "ssl", "sqlite3", "ctypes", "multiprocessing", "zoneinfo", "asyncio",
        "annotated_types", "anyio", "babel", "certifi", "cffi", "charset_normalizer",
        "click", "colorama", "courlan", "cryptography.hazmat.bindings._rust",
        "dateparser", "ddgs", "distro", "h11", "htmldate", "httpcore", "httpx",
        "idna", "jiter", "justext", "lxml.etree", "lxml_html_clean", "numpy",
        "ollama", "openai", "PIL.Image", "primp", "pycparser", "pydantic",
        "pydantic_core", "dateutil", "dotenv", "pytz", "regex", "six", "sniffio",
        "sqlcipher3", "sqlite_vec", "tld", "tqdm", "trafilatura", "typing_extensions",
        "typing_inspection", "tzdata", "tzlocal", "urllib3", "websockets",
    )
    imported = []
    for name in modules:
        module = importlib.import_module(name)
        origin = getattr(module, "__file__", None)
        if origin:
            assert Path(origin).resolve().is_relative_to(root), f"External import: {name}"
        imported.append(name)
    key = bytearray(os.urandom(32))
    wrong_key = bytearray(os.urandom(32))
    database = scratch / "encrypted.sqlite3"
    storage = []
    try:
        for mode, selected in (("create", key), ("reopen", key), ("wrong-key", wrong_key)):
            child = subprocess.run(
                [sys.executable, "-I", "-B", str(Path(__file__).resolve()), "--storage-worker", mode, "--database", str(database)],
                input=selected, capture_output=True, timeout=45, check=False,
            )
            assert child.returncode == 0, f"Storage worker {mode} failed: {child.stderr.decode('utf-8', 'replace')[-1600:]}"
            storage.append(json.loads(child.stdout))
        raw = database.read_bytes()
        assert not raw.startswith(b"SQLite format 3\x00")
        assert b"Reverie relocated runtime" not in raw
        plain = sqlite3.connect(f"{database.as_uri()}?mode=ro", uri=True)
        try:
            try:
                plain.execute("SELECT count(*) FROM sqlite_master").fetchone()
            except sqlite3.DatabaseError:
                pass
            else:
                raise AssertionError("Standard SQLite read encrypted data")
        finally:
            plain.close()
    finally:
        key[:] = b"\x00" * len(key)
        wrong_key[:] = b"\x00" * len(wrong_key)
    return {**info, "imports": imported, "storage": storage,
            "networkGuard": "python-socket-denied", "plaintextReadRejected": True}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--runtime-root", type=Path)
    parser.add_argument("--expected-packages", type=Path)
    parser.add_argument("--scratch", type=Path)
    parser.add_argument("--storage-worker", choices=("create", "reopen", "wrong-key"))
    parser.add_argument("--database", type=Path)
    parser.add_argument("--inventory-only", action="store_true")
    args = parser.parse_args()
    if args.storage_worker:
        result = storage_worker(args.database, args.storage_worker)
    else:
        root = args.runtime_root.resolve()
        expected = json.loads(args.expected_packages.read_text())
        result = inventory(root, expected) if args.inventory_only else probe(root, expected, args.scratch)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
