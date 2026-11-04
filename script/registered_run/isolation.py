"""Owned scratch directories with the acceptance-isolation.cjs path rules."""

from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path
import shutil
import stat
import tempfile


class IsolationError(RuntimeError):
    pass


def canonical_directory(directory: Path | str) -> dict:
    path = Path(directory)
    if not path.is_absolute() or path != Path(os.path.abspath(path)):
        raise IsolationError("ISOLATION_ABSOLUTE_CANONICAL_REQUIRED")
    if any(part.lower().endswith(".app") for part in path.parts):
        raise IsolationError("ISOLATION_APPLICATION_BUNDLE_FORBIDDEN")
    if path.resolve(strict=True) != path:
        raise IsolationError("ISOLATION_SYMLINK_FORBIDDEN")
    current = path
    while current != current.parent:
        info = current.lstat()
        if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
            raise IsolationError("ISOLATION_DIRECTORY_CHAIN_INVALID")
        current = current.parent
    info = path.lstat()
    if info.st_uid != os.getuid():
        raise IsolationError("ISOLATION_OWNER_CHANGED")
    return {"path": str(path), "device": info.st_dev, "inode": info.st_ino, "uid": info.st_uid}


def verify_directory(expected: dict) -> None:
    if canonical_directory(expected["path"]) != expected:
        raise IsolationError("ISOLATION_DIRECTORY_IDENTITY_CHANGED")


def default_data_paths(root: Path | str) -> tuple[Path, ...]:
    home = Path.home().resolve()
    support = home / "Library/Application Support"
    return (Path(root) / "data", support / "Reverie Local Qt/Reverie Scene",
            support / "com.muhe.reverie.qt.local", support / "Reverie", support / "Reverie Scene")


def assert_not_data_path(path: Path | str, root: Path | str, extra_forbidden=(), *, allow_ancestor=False) -> None:
    candidate = Path(path)
    resolved = candidate.resolve(strict=False)
    for forbidden in (*default_data_paths(root), *map(Path, extra_forbidden)):
        protected = forbidden.resolve(strict=False)
        if resolved == protected or resolved.is_relative_to(protected) or (not allow_ancestor and protected.is_relative_to(resolved)):
            raise IsolationError("ISOLATION_OVERLAPS_DEFAULT_DATA")


@dataclass
class IsolationContext:
    root: Path
    run_root: Path
    identities: dict
    directories: dict
    removed: bool = False

    @classmethod
    def create(cls, root: Path | str, parent: Path | str | None = None, *, extra_forbidden=()):
        project = Path(root).resolve(strict=True)
        parent_path = Path(parent) if parent is not None else Path(tempfile.gettempdir()).resolve(strict=True)
        canonical_directory(parent_path)
        assert_not_data_path(parent_path, project, extra_forbidden, allow_ancestor=True)
        run_root = Path(tempfile.mkdtemp(prefix="reverie-local-", dir=parent_path))
        os.chmod(run_root, 0o700)
        identities = {"root": canonical_directory(run_root)}
        directories = {}
        try:
            assert_not_data_path(run_root, project, extra_forbidden)
            for name in ("data", "tmp", "cache", "hf"):
                directory = run_root / name
                directory.mkdir(mode=0o700)
                assert_not_data_path(directory, project, extra_forbidden)
                directories[name] = directory
                identities[name] = canonical_directory(directory)
            return cls(project, run_root, identities, directories)
        except BaseException:
            # Only the newly created root is eligible, after its inode check.
            verify_directory(identities["root"])
            shutil.rmtree(run_root)
            raise

    def verify(self):
        if self.removed:
            raise IsolationError("ISOLATION_ALREADY_REMOVED")
        for identity in self.identities.values():
            verify_directory(identity)
        for directory in self.directories.values():
            assert_not_data_path(directory, self.root)

    @property
    def env(self) -> dict[str, str]:
        self.verify()
        base = {key: os.environ[key] for key in ("HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "PATH")
                if key in os.environ}
        return {**base, "TMPDIR": str(self.directories["tmp"]) + "/",
                "REVERIE_DATA_DIR": str(self.directories["data"]),
                "XDG_CACHE_HOME": str(self.directories["cache"]), "HF_HOME": str(self.directories["hf"]),
                "QT_QPA_PLATFORM": "offscreen", "QML_DISABLE_DISK_CACHE": "1",
                "PYTHON_DOTENV_DISABLED": "1", "PYTHONNOUSERSITE": "1", "PYTHONDONTWRITEBYTECODE": "1",
                "PYTEST_DISABLE_PLUGIN_AUTOLOAD": "1", "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1"}

    def validate_environment(self, env: dict[str, str]) -> None:
        for key, expected in self.env.items():
            if key in ("TMPDIR", "REVERIE_DATA_DIR", "XDG_CACHE_HOME", "HF_HOME",
                       "PYTHON_DOTENV_DISABLED", "PYTHONNOUSERSITE", "PYTHONDONTWRITEBYTECODE",
                       "PYTEST_DISABLE_PLUGIN_AUTOLOAD", "HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE"):
                if env.get(key) != expected:
                    raise IsolationError("ISOLATION_ENVIRONMENT_OVERRIDE:" + key)

    def cleanup(self) -> bool:
        self.verify()
        # rmtree does not follow internal symlinks. A replaced registered root
        # or child is refused above and is deliberately left for diagnosis.
        shutil.rmtree(self.run_root)
        self.removed = True
        return not self.run_root.exists()
