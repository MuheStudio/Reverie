"""Independent, deterministic worldbook evaluation over canonical snapshots.

Written from the approved behavior contract and the canonical archive schema;
no legacy matching implementation was consulted. Repository Apache-2.0 terms apply.
There is no storage or model dependency here. Rendering is exact entry content
joined with two newlines; budgets count Unicode code points in that rendering.
Regex execution is delegated exclusively to the killable subprocess supervisor.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
import hashlib
import json
from types import MappingProxyType
from typing import Any, Awaitable, Callable, Mapping, Sequence

from .regex_supervisor import RegexOutcome, RegexSession


DEFAULT_GLOBAL_TOKENS = 800
DEFAULT_BOOK_TOKENS = 500
DEFAULT_SCAN_DEPTH = 50
MAX_RECURSION_DEPTH = 8
MAX_RECURSIVE_CHARACTERS = 65_536
MAX_DIAGNOSTICS = 200
MAX_ARCHIVE_BYTES = 5 * 1024 * 1024
_SEPARATOR = "\n\n"
_LOGICS = frozenset({"and_any", "and_all", "not_any", "not_all"})


class SnapshotValidationError(ValueError):
    """A snapshot cannot be trusted; the adapter chooses its safe diagnostic."""

    def __init__(self) -> None:
        super().__init__("snapshot_unavailable")


@dataclass(frozen=True, slots=True)
class WorldbookEntry:
    index: int
    data: Mapping[str, Any]


@dataclass(frozen=True, slots=True)
class WorldbookBook:
    index: int
    data: Mapping[str, Any]
    entries: tuple[WorldbookEntry, ...]


@dataclass(frozen=True, slots=True)
class WorldbookSnapshot:
    persona_id: str
    revision: int
    checksum: str
    archive: Mapping[str, Any] | None
    books: tuple[WorldbookBook, ...]


@dataclass(frozen=True, slots=True)
class DepthEntry:
    """One selected body, in output order, for request-only history placement."""

    content: str
    depth: int
    role: str


@dataclass(frozen=True, slots=True)
class EvaluationResult:
    text: str
    diagnostics: list[dict[str, Any]]
    selected_ordinals: tuple[tuple[int, int], ...]
    diagnostics_total: int = 0
    before_char_text: str = ""
    after_char_text: str = ""
    depth_entries: tuple[DepthEntry, ...] = ()


def _freeze(value: Any) -> Any:
    if isinstance(value, dict):
        return MappingProxyType({key: _freeze(item) for key, item in value.items()})
    if isinstance(value, list):
        return tuple(_freeze(item) for item in value)
    return value


def _integer(value: Any, *, nullable: bool = False) -> bool:
    return (nullable and value is None) or (type(value) is int and value >= 0)


def _identifier(value: Any) -> bool:
    return isinstance(value, str) and 0 < len(value) <= 160 and all(
        character.isascii() and (character.isalnum() or character in "._:-")
        for character in value
    ) and value[0].isalnum()


def _validate_books(books: Any) -> None:
    if not isinstance(books, list) or len(books) > 200:
        raise SnapshotValidationError()
    book_ids: set[str] = set()
    for book in books:
        if not isinstance(book, dict) or not _identifier(book.get("id")):
            raise SnapshotValidationError()
        if book["id"] in book_ids:
            raise SnapshotValidationError()
        book_ids.add(book["id"])
        if not isinstance(book.get("name"), str):
            raise SnapshotValidationError()
        if not _integer(book.get("scanDepth", DEFAULT_SCAN_DEPTH)) or not _integer(
            book.get("tokenBudget", DEFAULT_BOOK_TOKENS)
        ) or type(book.get("recursiveScanning", False)) is not bool:
            raise SnapshotValidationError()
        entries = book.get("entries", [])
        if not isinstance(entries, list) or len(entries) > 10_000:
            raise SnapshotValidationError()
        for entry in entries:
            if not isinstance(entry, dict) or not _identifier(entry.get("id")):
                raise SnapshotValidationError()
            if not isinstance(entry.get("content"), str) or not entry["content"]:
                raise SnapshotValidationError()
            if not isinstance(entry.get("comment", ""), str):
                raise SnapshotValidationError()
            for name in ("keywords", "secondaryKeywords"):
                values = entry.get(name, [])
                if not isinstance(values, list) or len(values) > 200 or any(
                    not isinstance(value, str) or not value for value in values
                ):
                    raise SnapshotValidationError()
            if entry.get("selectiveLogic", "and_any") not in _LOGICS:
                raise SnapshotValidationError()
            for name in ("enabled", "alwaysActive", "caseSensitive", "useRegex"):
                if type(entry.get(name, name == "enabled")) is not bool:
                    raise SnapshotValidationError()
            for name, default in (("priority", 0), ("insertionOrder", 100), ("depth", 0)):
                if not _integer(entry.get(name, default)):
                    raise SnapshotValidationError()
            for name in ("scanDepth", "tokenBudget"):
                if not _integer(entry.get(name), nullable=True):
                    raise SnapshotValidationError()
            if entry.get("position", "before_char") not in {"before_char", "after_char", "at_depth"}:
                raise SnapshotValidationError()
            if entry.get("role", "system") not in {"system", "user", "assistant"}:
                raise SnapshotValidationError()


def compile_snapshot(persona_id: str, archive_record: Mapping[str, Any]) -> WorldbookSnapshot:
    """Validate and freeze a canonical read without normalizing or changing it.

    The checksum covers the entire canonical archive, including character data,
    using exactly the archive store's JSON encoding. Regex patterns remain plain
    immutable strings; compilation never takes place in this process.
    """
    if not _identifier(persona_id) or not isinstance(archive_record, Mapping):
        raise SnapshotValidationError()
    if archive_record.get("exists") is False:
        if type(archive_record.get("revision")) is not int or archive_record.get("revision") != 0 \
                or archive_record.get("archive") is not None \
                or archive_record.get("checksum") != "":
            raise SnapshotValidationError()
        return WorldbookSnapshot(persona_id, 0, "", None, ())
    revision = archive_record.get("revision")
    archive = archive_record.get("archive")
    checksum = archive_record.get("checksum")
    if archive_record.get("exists") is not True or not _integer(revision) or revision == 0 \
            or not isinstance(archive, dict) or not isinstance(checksum, str):
        raise SnapshotValidationError()
    try:
        encoded = json.dumps(archive, ensure_ascii=False, sort_keys=True,
                             separators=(",", ":"), allow_nan=False).encode("utf-8")
    except (TypeError, ValueError, UnicodeError, RecursionError):
        raise SnapshotValidationError() from None
    if len(encoded) > MAX_ARCHIVE_BYTES or hashlib.sha256(encoded).hexdigest() != checksum:
        raise SnapshotValidationError()
    if not isinstance(archive.get("characters", []), list) \
            or not isinstance(archive.get("activeCharacterIds", []), list):
        raise SnapshotValidationError()
    _validate_books(archive.get("worldBooks", []))
    frozen = _freeze(archive)
    books = tuple(WorldbookBook(index, book, tuple(
        WorldbookEntry(entry_index, entry) for entry_index, entry in enumerate(book.get("entries", ()))
    )) for index, book in enumerate(frozen.get("worldBooks", ())))
    return WorldbookSnapshot(persona_id, revision, checksum, frozen, books)


class _Diagnostics:
    def __init__(self, snapshot: WorldbookSnapshot, request_id: str) -> None:
        self.snapshot = snapshot
        self.request_id = request_id
        self.values: list[dict[str, Any]] = []
        self.total = 0
        self.seen: set[tuple[str, int, int]] = set()

    def add(self, code: str, book: WorldbookBook | None = None,
            entry: WorldbookEntry | None = None) -> None:
        key = (code, book.index if book else -1, entry.index if entry else -1)
        if key in self.seen:
            return
        self.seen.add(key)
        self.total += 1
        if len(self.values) < MAX_DIAGNOSTICS:
            self.values.append({
                "persona_id": self.snapshot.persona_id,
                "revision": self.snapshot.revision,
                "book_id": book.data["id"] if book else "",
                "entry_id": entry.data["id"] if entry else "",
                "entry_index": entry.index if entry else -1,
                "book_index": book.index if book else -1,
                "request_id": self.request_id,
                "code": code,
            })


def _literal_match(primary: Sequence[str], secondary: Sequence[str], logic: str,
                   case_sensitive: bool, text: str) -> bool:
    haystack = text if case_sensitive else text.casefold()
    def contains(key: str) -> bool:
        return (key if case_sensitive else key.casefold()) in haystack
    if not any(contains(key) for key in primary):
        return False
    if not secondary:
        return True
    matches = [contains(key) for key in secondary]
    return {"and_any": any(matches), "and_all": all(matches),
            "not_any": not any(matches), "not_all": not all(matches)}[logic]


def _eligible(book: WorldbookBook, entry: WorldbookEntry) -> bool:
    return entry.data.get("enabled", True) and book.data.get("tokenBudget", DEFAULT_BOOK_TOKENS) > 0 \
        and entry.data.get("tokenBudget") != 0


def _cost(characters: int) -> int:
    return (characters + 1) // 2


class WorldbookEngine:
    """Stateless evaluator with no process or file resources until evaluate().

    Per turn: regex startup/restarts share 1s; execution/IPC share 500ms with a
    50ms entry limit. All children are closed at turn completion. Recursion has
    message layer zero plus at most eight same-book expansions and 65,536
    cumulative Unicode code points, including separators. Sources are appended
    once per ordinal, whole; the first over-cap source freezes the input prefix.
    Selection precedes rendering and skips entire entries that do not fit.
    Entry budgets cover content; book/global budgets cover actual joined text.
    """

    def __init__(self) -> None:
        self._sessions: set[RegexSession] = set()
        self._pending_cleanup: set[RegexSession] = set()
        self._pending_recovery: asyncio.Task[None] | None = None
        self._finished: set[asyncio.Future[None]] = set()
        self._closed = False

    def _prune_pending(self) -> None:
        for session in tuple(self._pending_cleanup):
            if not session.has_pending_worker:
                self._pending_cleanup.discard(session)
                self._sessions.discard(session)

    async def _retry_pending(self, sessions: tuple[RegexSession, ...]) -> None:
        # Each supervisor owns a bounded kill/reap operation. Share this pass
        # between concurrent evaluations rather than stacking redundant retries.
        await asyncio.gather(*(session.aclose() for session in sessions), return_exceptions=True)
        self._prune_pending()

    async def _recover_pending(self) -> bool:
        self._prune_pending()
        if not self._pending_cleanup:
            return True
        if self._pending_recovery is None or self._pending_recovery.done():
            self._pending_recovery = asyncio.create_task(self._retry_pending(tuple(self._pending_cleanup)))
        # Cancelling this evaluation must not abandon another evaluation's
        # shared recovery work. aclose() also joins the retained recovery task.
        await asyncio.shield(self._pending_recovery)
        self._prune_pending()
        return not self._pending_cleanup

    async def aclose(self) -> None:
        self._closed = True
        self._prune_pending()
        results = await asyncio.gather(*(session.aclose() for session in tuple(self._sessions)),
                                       return_exceptions=True)
        if self._pending_recovery is not None:
            await asyncio.shield(self._pending_recovery)
        if self._finished:
            await asyncio.gather(*(asyncio.shield(done) for done in tuple(self._finished)))
        self._prune_pending()
        for result in results:
            if isinstance(result, BaseException):
                raise result

    async def evaluate(self, snapshot: WorldbookSnapshot, messages: Sequence[Mapping[str, Any]],
                       request_id: str, max_tokens: int = DEFAULT_GLOBAL_TOKENS) -> EvaluationResult:
        if not isinstance(snapshot, WorldbookSnapshot) or not _integer(max_tokens):
            raise ValueError("invalid_worldbook_input")
        if not isinstance(request_id, str) or not request_id or len(request_id) > 160:
            raise ValueError("invalid_worldbook_input")
        if not isinstance(messages, (list, tuple)) or any(
            not isinstance(message, Mapping) or not isinstance(message.get("content"), str)
            for message in messages
        ):
            raise ValueError("invalid_worldbook_input")
        contents = tuple(message["content"] for message in messages)
        diagnostics = _Diagnostics(snapshot, request_id)
        if self._closed:
            diagnostics.add("regex_worker_unavailable")
            return EvaluationResult("", diagnostics.values, (), diagnostics.total)
        if max_tokens == 0 or not snapshot.books:
            return EvaluationResult("", [], ())
        done = asyncio.get_running_loop().create_future()
        self._finished.add(done)
        session: RegexSession | None = None
        recovery_attempted = False
        cancelled = False

        async def evaluate_regex(primary: Sequence[str], secondary: Sequence[str], logic: str,
                                 case_sensitive: bool, text: str) -> RegexOutcome:
            nonlocal session, recovery_attempted
            if not primary:
                return RegexOutcome("NO_MATCH")
            self._prune_pending()
            if self._pending_cleanup:
                if not recovery_attempted:
                    recovery_attempted = True
                    await self._recover_pending()
                if self._pending_cleanup:
                    return RegexOutcome("ERROR", "regex_worker_unavailable")
            if self._closed:
                return RegexOutcome("ERROR", "regex_worker_unavailable")
            if session is None:
                session = RegexSession()
                self._sessions.add(session)
            return await session.evaluate(primary, secondary, logic, case_sensitive, text)

        try:
            candidates: list[tuple[WorldbookBook, WorldbookEntry]] = []
            for book in snapshot.books:
                if self._closed:
                    break
                candidates.extend((book, entry) for entry in await self._match_book(
                    book, contents, evaluate_regex, diagnostics
                ))
            if self._closed:
                return EvaluationResult("", diagnostics.values, (), diagnostics.total)
            selected: list[tuple[WorldbookBook, WorldbookEntry]] = []
            total_characters = 0
            book_characters: dict[int, int] = {}
            book_counts: dict[int, int] = {}
            for book, entry in sorted(candidates, key=lambda item: (
                -item[1].data.get("priority", 0), item[1].data.get("insertionOrder", 100),
                item[0].index, item[1].index,
            )):
                length = len(entry.data["content"])
                book_budget = book.data.get("tokenBudget", DEFAULT_BOOK_TOKENS)
                entry_budget = entry.data.get("tokenBudget")
                if entry_budget is None:
                    entry_budget = book_budget
                next_book = book_characters.get(book.index, 0) + length + (
                    len(_SEPARATOR) if book_counts.get(book.index, 0) else 0
                )
                next_total = total_characters + length + (len(_SEPARATOR) if selected else 0)
                if _cost(length) > entry_budget or _cost(next_book) > book_budget \
                        or _cost(next_total) > max_tokens:
                    continue
                selected.append((book, entry))
                total_characters = next_total
                book_characters[book.index] = next_book
                book_counts[book.index] = book_counts.get(book.index, 0) + 1
            selected.sort(key=lambda item: (
                item[1].data.get("insertionOrder", 100), item[0].index, item[1].index,
            ))
            return EvaluationResult(
                _SEPARATOR.join(entry.data["content"] for _, entry in selected), diagnostics.values,
                tuple((book.index, entry.index) for book, entry in selected), diagnostics.total,
                before_char_text=_SEPARATOR.join(
                    entry.data["content"] for _, entry in selected
                    if entry.data.get("position", "before_char") == "before_char"
                ),
                after_char_text=_SEPARATOR.join(
                    entry.data["content"] for _, entry in selected
                    if entry.data.get("position", "before_char") == "after_char"
                ),
                depth_entries=tuple(
                    DepthEntry(entry.data["content"], entry.data.get("depth", 0),
                               entry.data.get("role", "system"))
                    for _, entry in selected if entry.data.get("position", "before_char") == "at_depth"
                ),
            )
        except asyncio.CancelledError:
            cancelled = True
            raise
        finally:
            cleanup_error: Exception | None = None
            try:
                if session is not None:
                    await session.aclose()
            except asyncio.CancelledError:
                cancelled = True
            except Exception as error:
                cleanup_error = error
            finally:
                if session is not None:
                    if session.has_pending_worker:
                        self._pending_cleanup.add(session)
                    else:
                        self._sessions.discard(session)
                        self._pending_cleanup.discard(session)
                self._finished.discard(done)
                if not done.done():
                    done.set_result(None)
            task = asyncio.current_task()
            if cancelled or (task is not None and task.cancelling()):
                # Failed cleanup is retained above, but it must never turn a
                # cancelled chat into an ordinary optional-context failure.
                raise asyncio.CancelledError() from None
            if cleanup_error is not None:
                raise cleanup_error

    async def _match_book(self, book: WorldbookBook, messages: tuple[str, ...],
                          evaluate_regex: Callable[..., Awaitable[RegexOutcome]],
                          diagnostics: _Diagnostics) -> list[WorldbookEntry]:
        eligible = tuple(entry for entry in book.entries if _eligible(book, entry))
        matched: dict[int, WorldbookEntry] = {}
        failed: set[int] = set()
        history: dict[int, tuple[str, bool]] = {}

        async def matches(entry: WorldbookEntry, recursive_text: str, has_recursive: bool) -> bool:
            if entry.data.get("alwaysActive", False):
                return True
            depth = entry.data.get("scanDepth")
            if depth is None:
                depth = book.data.get("scanDepth", DEFAULT_SCAN_DEPTH)
            if depth not in history:
                tail = messages[-depth:] if depth else ()
                history[depth] = (_SEPARATOR.join(tail), bool(tail))
            base, has_base = history[depth]
            if not has_base and not has_recursive:
                return False
            text = _SEPARATOR.join((base, recursive_text)) if has_base and has_recursive \
                else base if has_base else recursive_text
            primary = entry.data.get("keywords", ())
            secondary = entry.data.get("secondaryKeywords", ())
            logic = entry.data.get("selectiveLogic", "and_any")
            sensitive = entry.data.get("caseSensitive", False)
            if not entry.data.get("useRegex", False):
                return _literal_match(primary, secondary, logic, sensitive, text)
            result = await evaluate_regex(primary, secondary, logic, sensitive, text)
            if result.state == "ERROR":
                failed.add(entry.index)
                diagnostics.add(result.code, book, entry)
                return False
            return result.state == "MATCH"

        for index, entry in enumerate(eligible):
            if index % 16 == 0:
                await asyncio.sleep(0)
            if self._closed:
                return []
            if await matches(entry, "", False):
                matched[entry.index] = entry
        if not book.data.get("recursiveScanning", False):
            return list(matched.values())
        pending = list(matched.values())
        recursive_sources: list[str] = []
        recursive_characters = 0
        capped = False
        for level in range(1, MAX_RECURSION_DEPTH + 1):
            if not pending or self._closed:
                break
            for source in sorted(pending, key=lambda entry: entry.index):
                content = source.data["content"]
                added = len(content) + (len(_SEPARATOR) if recursive_sources else 0)
                if recursive_characters + added > MAX_RECURSIVE_CHARACTERS:
                    diagnostics.add("recursion_text_limit", book, source)
                    capped = True
                    break
                recursive_sources.append(content)
                recursive_characters += added
            if not recursive_sources:
                break
            recursive_text = _SEPARATOR.join(recursive_sources)
            pending = []
            for index, entry in enumerate(eligible):
                if index % 16 == 0:
                    await asyncio.sleep(0)
                if self._closed:
                    return []
                if entry.index in matched or entry.index in failed:
                    continue
                if await matches(entry, recursive_text, True):
                    matched[entry.index] = entry
                    pending.append(entry)
            if capped:
                break
            if level == MAX_RECURSION_DEPTH and pending and any(
                entry.index not in matched and entry.index not in failed for entry in eligible
            ):
                diagnostics.add("recursion_depth_limit", book)
        return list(matched.values())
