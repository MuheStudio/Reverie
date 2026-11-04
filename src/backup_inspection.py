"""Readonly, streaming inspection of local backups before any restore effect."""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import io
import json
from pathlib import Path
from typing import Any

BACKUP_SCHEMA = "reverie.full_local_backup.v3"
LEGACY_BACKUP_SCHEMAS = {"reverie.full_local_backup.v1", "reverie.full_local_backup.v2"}
MAX_BACKUP_FILE_BYTES = 1024 * 1024 * 1024


class BackupRestoreError(ValueError):
    def __init__(self, message: str, *, code: str = "BACKUP_RESTORE_FAILED") -> None:
        super().__init__(message)
        self.code = code


def is_unconfirmed_export(value: Any) -> bool:
    return value == "unconfirmed" or (isinstance(value, dict) and value.get("consistency") == "unconfirmed")


def _invalid_constant(value: str):
    raise ValueError(f"Non-finite JSON value: {value}")


def _unique_pairs(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError(f"Backup JSON contains a duplicate object key: {key}")
        value[key] = item
    return value


def _bounded_string(reader, maximum: int) -> str:
    """Read a short metadata string without decoding an arbitrary JSON blob."""
    reader.expect('"')
    characters = ['"']
    escaped = False
    while True:
        character = reader._character()
        characters.append(character)
        if len(characters) > maximum * 6 + 2:
            raise ValueError("Backup metadata string is oversized")
        if character == '"' and not escaped:
            break
        if escaped:
            escaped = False
        elif character == "\\":
            escaped = True
    value = json.loads("".join(characters))
    if len(value) > maximum:
        raise ValueError("Backup metadata string is oversized")
    return value


def _inspect_identity(reader) -> dict[str, Any]:
    allowed = {"persona_id", "fingerprint", "identity_version"}
    result: dict[str, Any] = {}
    reader.expect("{")
    if reader.peek() != "}":
        while True:
            key = _bounded_string(reader,32)
            if key not in allowed or key in result:
                raise ValueError("Backup persona identity contains unsupported metadata")
            reader.expect(":")
            if key in {"persona_id", "fingerprint"}:
                result[key] = _bounded_string(reader,200 if key == "persona_id" else 64)
            else:
                if reader.peek() not in "123456789":
                    raise ValueError("Backup identity version is invalid")
                result[key] = reader.value()
                if type(result[key]) is not int or not 1 <= result[key] <= 2**31 - 1:
                    raise ValueError("Backup identity version is invalid")
            if reader.peek() != ",":
                break
            reader.expect(",")
    reader.expect("}")
    if set(result) != allowed:
        raise ValueError("Backup persona identity is incomplete")
    persona_id = result["persona_id"]
    if not persona_id or persona_id != persona_id.strip() or any(ord(character) < 32 or ord(character) == 127 for character in persona_id):
        raise ValueError("Backup persona id is invalid")
    fingerprint = result["fingerprint"]
    if len(fingerprint) != 64 or any(character not in "0123456789abcdefABCDEF" for character in fingerprint):
        raise ValueError("Backup persona fingerprint is invalid")
    return result


def _inspect_export_state(reader) -> Any:
    if reader.peek() == '"':
        value = _bounded_string(reader,32)
        if is_unconfirmed_export(value):
            raise BackupRestoreError("This export has an unconfirmed restore state",code="BACKUP_UNCONFIRMED_EXPORT")
        return value
    reader.expect("{")
    result: dict[str, Any] = {}
    seen: set[str] = set()
    if reader.peek() != "}":
        while True:
            key = _bounded_string(reader,64)
            if key in seen:
                raise ValueError("Backup export state contains duplicate metadata")
            seen.add(key)
            reader.expect(":")
            if key == "consistency":
                result[key] = _bounded_string(reader,32)
                if is_unconfirmed_export(result):
                    # Stop at the marker itself, even if a huge unknown value
                    # or malformed tail follows it. No staging has occurred.
                    raise BackupRestoreError("This export has an unconfirmed restore state",code="BACKUP_UNCONFIRMED_EXPORT")
            else:
                reader.skip_value()
            if reader.peek() != ",":
                break
            reader.expect(",")
    reader.expect("}")
    return result


class _IncrementalJSONReader:
    """JSON cursor bounded to one decoded value; inspection can skip huge values."""

    CHUNK_SIZE = 64 * 1024
    MAX_BUFFER_BYTES = 100 * 1024 * 1024

    def __init__(self, stream) -> None:
        self.stream = stream
        self.decoder = json.JSONDecoder(parse_constant=_invalid_constant, object_pairs_hook=_unique_pairs)
        self.buffer = ""
        self.position = 0
        self.eof = False
        self._buffer_bytes = 0

    def _fill(self) -> bool:
        chunk = self.stream.read(self.CHUNK_SIZE)
        if not chunk:
            self.eof = True
            return False
        self.buffer += chunk
        self._buffer_bytes += len(chunk.encode("utf-8"))
        if self._buffer_bytes > self.MAX_BUFFER_BYTES:
            raise ValueError("Backup JSON value exceeds the safe size limit")
        return True

    def _compact(self) -> None:
        if self.position >= self.CHUNK_SIZE:
            dropped = self.buffer[:self.position]
            self.buffer = self.buffer[self.position:]
            self._buffer_bytes -= len(dropped.encode("utf-8"))
            self.position = 0

    def _skip_space(self) -> None:
        while True:
            while self.position < len(self.buffer) and self.buffer[self.position] in " \t\r\n":
                self.position += 1
            self._compact()
            if self.position < len(self.buffer) or self.eof:
                return
            self._fill()

    def peek(self) -> str:
        self._skip_space()
        if self.position >= len(self.buffer):
            raise ValueError("Backup JSON ended unexpectedly")
        return self.buffer[self.position]

    def expect(self, character: str) -> None:
        if self.peek() != character:
            raise ValueError(f"Malformed backup JSON: expected {character!r}")
        self.position += 1
        self._compact()

    def value(self) -> Any:
        self._skip_space()
        while True:
            try:
                value, end = self.decoder.raw_decode(self.buffer, self.position)
            except json.JSONDecodeError as exc:
                if self.eof:
                    raise ValueError("Backup JSON is malformed or truncated") from exc
                self._fill()
                continue
            # A number at a chunk boundary may continue into the next chunk.
            if end == len(self.buffer) and not self.eof:
                self._fill()
                continue
            self.position = end
            self._compact()
            return value

    def _character(self) -> str:
        if self.position >= len(self.buffer):
            self._compact()
            if not self._fill():
                raise ValueError("Backup JSON is malformed or truncated")
        character = self.buffer[self.position]
        self.position += 1
        self._compact()
        return character

    def _skip_string(self) -> None:
        self.expect('"')
        while True:
            # Scan runs in C; only quotes, escapes and controls need Python work.
            if self.position >= len(self.buffer):
                self._compact()
                if not self._fill():
                    raise ValueError("Backup JSON is malformed or truncated")
            start = self.position
            quote = self.buffer.find('"', start)
            escape = self.buffer.find("\\", start)
            stop = min(item for item in (quote, escape, len(self.buffer)) if item >= 0)
            segment = self.buffer[start:stop]
            if any(ord(character) < 32 for character in segment):
                raise ValueError("Backup JSON contains an invalid string")
            self.position = stop
            self._compact()
            character = self._character()
            if character == '"':
                return
            if character != "\\":
                # The run ended at a chunk boundary; consumed character is a
                # normal string character from the next chunk.
                if ord(character) < 32:
                    raise ValueError("Backup JSON contains an invalid string")
                continue
            escaped = self._character()
            if escaped == "u":
                if any(self._character() not in "0123456789abcdefABCDEF" for _ in range(4)):
                    raise ValueError("Backup JSON contains an invalid unicode escape")
            elif escaped not in '\"\\/bfnrt':
                raise ValueError("Backup JSON contains an invalid escape")

    def skip_value(self, *, depth: int = 0) -> None:
        if depth > 128:
            raise ValueError("Backup JSON nesting exceeds the safe limit")
        first = self.peek()
        if first == '"':
            self._skip_string()
        elif first in "{[":
            close = "}" if first == "{" else "]"
            keys: set[str] = set()
            self.expect(first)
            if self.peek() != close:
                while True:
                    if first == "{":
                        if self.peek() != '"':
                            raise ValueError("Backup JSON object key is not a string")
                        key = self.value()
                        if key in keys:
                            raise ValueError("Backup JSON contains a duplicate object key")
                        keys.add(key)
                        self.expect(":")
                    self.skip_value(depth=depth + 1)
                    if self.peek() != ",":
                        break
                    self.expect(",")
            self.expect(close)
        else:
            pieces: list[str] = []
            while True:
                if self.position >= len(self.buffer):
                    self._compact()
                    if not self._fill():
                        break
                character = self.buffer[self.position]
                if character in " \t\r\n,]}":
                    break
                pieces.append(character)
                self.position += 1
                self._compact()
                if len(pieces) > 4096:
                    raise ValueError("Backup JSON primitive exceeds the safe limit")
            try:
                json.loads("".join(pieces), parse_constant=_invalid_constant)
            except (ValueError, json.JSONDecodeError) as exc:
                raise ValueError("Backup JSON is malformed or truncated") from exc

    def ensure_finished(self) -> None:
        self._skip_space()
        if self.position < len(self.buffer):
            raise ValueError("Backup JSON has trailing data")
        if not self.eof:
            self._fill()
            self._skip_space()
            if self.position < len(self.buffer):
                raise ValueError("Backup JSON has trailing data")


class _HashingReader(io.RawIOBase):
    def __init__(self, source) -> None:
        self.source = source
        self.digest = hashlib.sha256()
        self.file_bytes = 0

    def readable(self) -> bool:
        return True

    def readinto(self, target) -> int:
        chunk = self.source.read(len(target))
        target[:len(chunk)] = chunk
        self.digest.update(chunk)
        self.file_bytes += len(chunk)
        if self.file_bytes > MAX_BACKUP_FILE_BYTES:
            raise ValueError("Backup file exceeds the safe size limit")
        return len(chunk)


@dataclass(frozen=True)
class BackupInspection:
    schema: str
    persona_identity: dict[str, Any]
    memory_count: int
    sha256: str
    file_bytes: int
    sections: frozenset[str] = frozenset()

    @property
    def schema_version(self) -> int:
        return int(self.schema.rsplit("v", 1)[1])

    def as_dict(self) -> dict[str, Any]:
        # These fields become a control-result payload; its envelope owns
        # "schema" independently of the schema stored inside the backup file.
        return {"backup_schema": self.schema, "schema_version": self.schema_version,
                "persona_identity": self.persona_identity, "memory_count": self.memory_count,
                "sha256": self.sha256, "file_bytes": self.file_bytes}


def _inspect_backup_file(path: Path) -> BackupInspection:
    """Inspect all bytes without creating staging, journal, or manager state."""
    path = Path(path)
    if path.stat().st_size > MAX_BACKUP_FILE_BYTES:
        raise ValueError("Backup file exceeds the safe size limit")
    seen: set[str] = set()
    metadata: dict[str, Any] = {}
    count = 0
    expected_objects = {"emotion", "relationship", "user", "diary", "timeline",
                        "social_circle", "interests", "affairs", "calendar",
                        "ambient_presence", "thought_of_you", "diary_keys",
                        "phrase_alignment", "social_universe"}
    with path.open("rb") as source:
        hashing = _HashingReader(source)
        with io.TextIOWrapper(io.BufferedReader(hashing), encoding="utf-8-sig", newline="") as text:
            reader = _IncrementalJSONReader(text)
            reader.expect("{")
            if reader.peek() != "}":
                while True:
                    key = reader.value()
                    if not isinstance(key, str) or key in seen:
                        raise ValueError("Backup JSON contains an invalid or duplicate section")
                    seen.add(key)
                    reader.expect(":")
                    if key in {"schema", "persona_identity", "export_state"}:
                        if key == "persona_identity":
                            metadata[key] = _inspect_identity(reader)
                        elif key == "export_state":
                            metadata[key] = _inspect_export_state(reader)
                        else:
                            metadata[key] = _bounded_string(reader,64)
                        if key == "export_state" and is_unconfirmed_export(metadata[key]):
                            raise BackupRestoreError("This export has an unconfirmed restore state",
                                                     code="BACKUP_UNCONFIRMED_EXPORT")
                    elif key == "memory":
                        reader.expect("[")
                        if reader.peek() != "]":
                            while True:
                                if reader.peek() != "{":
                                    raise ValueError("Backup memory contains a non-object record")
                                reader.skip_value()
                                count += 1
                                if reader.peek() != ",":
                                    break
                                reader.expect(",")
                        reader.expect("]")
                    else:
                        if key in expected_objects and reader.peek() != "{":
                            raise ValueError(f"Invalid backup section: {key}")
                        reader.skip_value()
                    if reader.peek() != ",":
                        break
                    reader.expect(",")
            reader.expect("}")
            reader.ensure_finished()
    if metadata.get("schema") not in {BACKUP_SCHEMA, *LEGACY_BACKUP_SCHEMAS}:
        raise ValueError("Unsupported Reverie backup schema")
    if not {"memory", "emotion", "relationship", "user", "diary"}.issubset(seen):
        raise ValueError("Backup is missing a required section")
    if not isinstance(metadata.get("persona_identity"), dict):
        raise ValueError("Backup is missing its persona identity")
    return BackupInspection(str(metadata["schema"]), metadata["persona_identity"], count,
                            hashing.digest.hexdigest(), hashing.file_bytes,
                            frozenset(seen & (expected_objects | {"memory"})))


def inspect_backup_file(path: Path) -> BackupInspection:
    try:
        return _inspect_backup_file(path)
    except BackupRestoreError:
        raise
    except OSError as exc:
        raise BackupRestoreError("Backup file could not be read",code="BACKUP_FILE_UNAVAILABLE") from exc
    except (ValueError,TypeError,RecursionError) as exc:
        raise BackupRestoreError("Backup JSON is malformed, truncated, or has an invalid format",
                                 code="BACKUP_INVALID_FORMAT") from exc
