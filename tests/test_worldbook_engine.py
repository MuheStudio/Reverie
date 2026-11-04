"""Synthetic contract tests for the independently implemented worldbook engine."""

from __future__ import annotations

import asyncio
from dataclasses import FrozenInstanceError
import hashlib
import json
import os

import pytest

from src.worldbook import SnapshotValidationError, WorldbookEngine, compile_snapshot
from src.worldbook.engine import MAX_DIAGNOSTICS
from src.worldbook import engine as engine_module
from src.worldbook.regex_supervisor import RegexCleanupError, RegexOutcome


def entry(identifier="entry", **changes):
    value = {"id": identifier, "keywords": ["hello"], "secondaryKeywords": [],
             "selectiveLogic": "and_any", "position": "before_char", "insertionOrder": 100,
             "priority": 0, "caseSensitive": False, "comment": "private comment",
             "content": identifier, "alwaysActive": False, "enabled": True,
             "scanDepth": None, "tokenBudget": None, "useRegex": False, "depth": 0, "role": "system"}
    value.update(changes)
    return value


def book(entries, identifier="book", **changes):
    value = {"id": identifier, "name": identifier, "entries": entries,
             "scanDepth": 50, "tokenBudget": 500, "recursiveScanning": False,
             "createdAt": "synthetic", "updatedAt": "synthetic"}
    value.update(changes)
    return value


def record(books, revision=1):
    archive = {"characters": [], "activeCharacterIds": [], "worldBooks": books}
    checksum = hashlib.sha256(json.dumps(archive, ensure_ascii=False, sort_keys=True,
                                        separators=(",", ":")).encode("utf-8")).hexdigest()
    return {"exists": True, "revision": revision, "archive": archive, "checksum": checksum}


def evaluate(books, contents=("hello",), *, max_tokens=800, revision=1):
    async def run():
        engine = WorldbookEngine()
        try:
            return await engine.evaluate(compile_snapshot("persona-a", record(books, revision)),
                                         [{"role": "user", "content": text} for text in contents],
                                         "request-a", max_tokens)
        finally:
            await engine.aclose()
    return asyncio.run(run())


def test_snapshot_is_deeply_immutable_preserves_metadata_and_does_not_trim():
    original = record([book([entry(content="  preserved\n", role="assistant", depth=7,
                                  position="after_char", keywords=["abc"])])])
    snapshot = compile_snapshot("persona-a", original)
    original["archive"]["worldBooks"][0]["entries"][0]["content"] = "changed"
    original["archive"]["worldBooks"][0]["entries"][0]["keywords"].append("new")
    frozen_entry = snapshot.books[0].entries[0].data
    assert frozen_entry["content"] == "  preserved\n"
    assert frozen_entry["keywords"] == ("abc",)
    assert frozen_entry["role"] == "assistant" and frozen_entry["depth"] == 7
    assert frozen_entry["position"] == "after_char" and frozen_entry["comment"] == "private comment"
    with pytest.raises(TypeError):
        frozen_entry["content"] = "no"
    with pytest.raises(FrozenInstanceError):
        snapshot.revision = 2


def test_absent_archive_produces_an_empty_persona_scoped_snapshot():
    snapshot = compile_snapshot("persona-a", {"exists": False, "revision": 0, "archive": None, "checksum": ""})
    assert snapshot.persona_id == "persona-a" and snapshot.revision == 0
    assert snapshot.archive is None and snapshot.books == () and snapshot.checksum == ""


@pytest.mark.parametrize("mutation", [
    lambda value: value.update(checksum="0" * 64),
    lambda value: value.update(revision=True),
    lambda value: value["archive"]["worldBooks"][0]["entries"][0].update(content="tampered"),
])
def test_snapshot_rejects_checksum_or_revision_errors_without_raw_data(mutation):
    value = record([book([entry(content="PRIVATE BODY")])])
    mutation(value)
    with pytest.raises(SnapshotValidationError, match="^snapshot_unavailable$"):
        compile_snapshot("persona-a", value)


@pytest.mark.parametrize("changes", [
    {"scanDepth": -1}, {"tokenBudget": True}, {"enabled": "false"},
    {"keywords": [1]}, {"selectiveLogic": "invalid"}, {"content": ""},
])
def test_snapshot_shape_validation_does_not_renormalize_invalid_entries(changes):
    with pytest.raises(SnapshotValidationError):
        compile_snapshot("persona-a", record([book([entry(**changes)])]))


def test_constructor_allocates_no_subprocess(monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError("constructor must be inert")
    monkeypatch.setattr(asyncio, "create_subprocess_exec", forbidden)
    assert WorldbookEngine()._sessions == set()


@pytest.mark.parametrize(("logic", "text", "expected"), [
    ("and_any", "hello red", True), ("and_any", "hello", False),
    ("and_all", "hello red blue", True), ("and_all", "hello red", False),
    ("not_any", "hello", True), ("not_any", "hello red", False),
    ("not_all", "hello red", True), ("not_all", "hello red blue", False),
])
def test_primary_any_and_auxiliary_logic(logic, text, expected):
    result = evaluate([book([entry(keywords=["absent", "hello"], secondaryKeywords=["red", "blue"],
                                  selectiveLogic=logic)])], [text])
    assert bool(result.text) is expected


@pytest.mark.parametrize("logic", ["and_any", "and_all", "not_any", "not_all"])
def test_empty_auxiliary_keywords_are_ignored(logic):
    assert evaluate([book([entry(selectiveLogic=logic)])]).text == "entry"


def test_primary_keyword_is_required_unless_always_active():
    assert evaluate([book([entry(keywords=[], secondaryKeywords=["hello"])])]).text == ""
    assert evaluate([book([entry(keywords=[], alwaysActive=True)])], []).text == "entry"


def test_case_sensitive_option_applies_to_primary_and_secondary():
    assert evaluate([book([entry(keywords=["HELLO"], secondaryKeywords=["RED"])])], ["hello red"]).text
    assert not evaluate([book([entry(keywords=["HELLO"], caseSensitive=True)])], ["hello"]).text
    assert not evaluate([book([entry(secondaryKeywords=["RED"], caseSensitive=True)])], ["hello red"]).text


def test_disabled_and_zero_budget_entries_do_not_inject_even_if_always_active():
    assert evaluate([book([entry(enabled=False, alwaysActive=True)])]).text == ""
    assert evaluate([book([entry(tokenBudget=0, alwaysActive=True)])]).text == ""
    assert evaluate([book([entry(tokenBudget=100, alwaysActive=True)], tokenBudget=0)]).text == ""
    assert evaluate([book([entry(alwaysActive=True)])], max_tokens=0).text == ""


def test_always_active_bypasses_regex_auxiliary_and_zero_scan_depth():
    result = evaluate([book([entry(alwaysActive=True, scanDepth=0, keywords=["["],
                                  secondaryKeywords=["(a+)+$"], useRegex=True)])], [])
    assert result.text == "entry" and result.diagnostics == []


def test_scan_depth_inherits_book_and_counts_current_message():
    entries = [entry("inherited", keywords=["older"]), entry("override", keywords=["older"], scanDepth=2),
               entry("current", keywords=["current"], scanDepth=1), entry("zero", keywords=["current"], scanDepth=0)]
    result = evaluate([book(entries, scanDepth=1)], ["older", "current"])
    assert result.text == "override\n\ncurrent"


def test_default_scan_depth_is_fifty_messages_including_current():
    texts = ["older"] + ["filler"] * 49 + ["current"]
    assert evaluate([book([entry(keywords=["older"])])], texts).text == ""
    assert evaluate([book([entry(keywords=["older"], scanDepth=51)])], texts).text == "entry"


def test_scan_depth_zero_does_not_match_an_empty_string_regex_without_sources():
    assert evaluate([book([entry(keywords=["^$"], scanDepth=0, useRegex=True)])], [""]).text == ""


def test_default_book_and_global_budgets_are_enforced():
    assert evaluate([book([entry(content="x" * 1000)])]).text == "x" * 1000
    assert evaluate([book([entry(content="x" * 1001)])]).text == ""
    books = [book([entry(content="x" * 1000)], "a"), book([entry(content="y" * 600)], "b")]
    assert evaluate(books).text == "x" * 1000
    books[1]["entries"][0]["content"] = "y" * 598
    assert len(evaluate(books).text) == 1600


def test_entry_budget_inherits_book_and_whole_oversize_entries_are_skipped():
    entries = [entry("huge", content="x" * 30, priority=10), entry("short", content="1234567")]
    assert evaluate([book(entries, tokenBudget=4)], max_tokens=4).text == "1234567"
    entries[1]["tokenBudget"] = 3
    assert evaluate([book(entries, tokenBudget=4)], max_tokens=4).text == ""


def test_actual_separator_and_unicode_cost_is_rounded_once():
    assert evaluate([book([entry("one", content="abc"), entry("two", content="def")], tokenBudget=4)],
                    max_tokens=4).text == "abc\n\ndef"
    result = evaluate([book([entry("one", content="😀x"), entry("two", content="好")])], max_tokens=3)
    assert result.text == "😀x\n\n好" and len(result.text) == 5
    assert evaluate([book([entry("one", content="😀x"), entry("two", content="好")])], max_tokens=2).text == "😀x"


def test_priority_selects_entries_but_insertion_order_controls_rendering():
    entries = [entry("a", content="aa", priority=30, insertionOrder=30),
               entry("b", content="bb", priority=20, insertionOrder=10),
               entry("c", content="cc", priority=10, insertionOrder=20)]
    result = evaluate([book(entries)], max_tokens=3)
    assert result.text == "bb\n\naa" and result.selected_ordinals == ((0, 1), (0, 0))


@pytest.mark.parametrize("priority,expected", [(0, "PRIORITY_B_ONLY"), (2, "PRIORITY_A_ONLY")],
                         ids=["b-wins", "a-wins"])
def test_native_priority_budget_fixture_selects_exactly_one_whole_entry(priority, expected):
    entries = [entry("a", content="PRIORITY_A_ONLY", alwaysActive=True, insertionOrder=10,
                     priority=priority),
               entry("b", content="PRIORITY_B_ONLY", alwaysActive=True, insertionOrder=20,
                     priority=1)]
    result = evaluate([book(entries, tokenBudget=8)], contents=())
    assert result.text == expected
    assert result.selected_ordinals == ((0, 0 if priority == 2 else 1),)
    assert result.diagnostics == []


@pytest.mark.parametrize("settings,contents,expected,selected", [
    ({"scanDepth": 1, "tokenBudget": 100, "recursiveScanning": False}, ["书级记录一：远灯亮起"],
     "BOOK_DEPTH_ONLY 回声", ((0, 0),)),
    ({"scanDepth": 3, "tokenBudget": 100, "recursiveScanning": True},
     ["书级记录一：远灯亮起", "书级设置效果已核对", "书级记录二：请继续核对"],
     "BOOK_DEPTH_ONLY 回声\n\nBOOK_RECURSION_ONLY", ((0, 0), (0, 1))),
    ({"scanDepth": 3, "tokenBudget": 0, "recursiveScanning": True},
     ["书级记录二：请继续核对", "书级设置效果已核对", "书级记录三：远灯再亮"], "", ()),
], ids=["depth-one-without-recursion", "depth-three-with-recursion", "budget-zero"])
def test_native_book_settings_fixture_uses_book_depth_recursion_and_budget(settings, contents, expected, selected):
    entries = [entry("depth", keywords=["远灯"], content="BOOK_DEPTH_ONLY 回声", insertionOrder=30),
               entry("recursion", keywords=["回声"], content="BOOK_RECURSION_ONLY", insertionOrder=40)]
    result = evaluate([book(entries, **settings)], contents)
    assert result.text == expected
    assert result.selected_ordinals == selected
    assert result.diagnostics == []
    if settings["scanDepth"] == 3 and settings["tokenBudget"]:
        # The second chat holds no keyword: depth one would select nothing.
        assert evaluate([book(entries, **{**settings, "scanDepth": 1})], contents).text == ""
        assert evaluate([book(entries, **{**settings, "recursiveScanning": False})], contents).text \
            == "BOOK_DEPTH_ONLY 回声"


ENTRY_SETTINGS_A = "ENTRY_DEPTH_A_16"
ENTRY_SETTINGS_B = "ENTRY_BUDGET_B_" + "X" * 86
ENTRY_SETTINGS_TEXTS = ("条目记录一：远灯与预算灯", "条目记录二：预算灯", "条目记录三：请再核对")
ENTRY_SETTINGS_REPLY = "条目设置效果已核对"


def entry_settings_books(depth_a, budget_b):
    """The native entry-settings fixture: one book at depth 1, budget 100, no recursion."""
    entries = [entry("a", keywords=["远灯"], content=ENTRY_SETTINGS_A, insertionOrder=30, priority=1000,
                     scanDepth=depth_a),
               entry("b", keywords=["预算灯"], content=ENTRY_SETTINGS_B, insertionOrder=40, priority=1000,
                     tokenBudget=budget_b)]
    return [book(entries, scanDepth=1, tokenBudget=100, recursiveScanning=False)]


@pytest.mark.parametrize("depth_a,budget_b,contents,expected,selected", [
    (None, None, ENTRY_SETTINGS_TEXTS[:1],
     ENTRY_SETTINGS_A + "\n\n" + ENTRY_SETTINGS_B, ((0, 0), (0, 1))),
    (5, 50, (ENTRY_SETTINGS_TEXTS[0], ENTRY_SETTINGS_REPLY, ENTRY_SETTINGS_TEXTS[1]),
     ENTRY_SETTINGS_A, ((0, 0),)),
    (None, 50, (ENTRY_SETTINGS_TEXTS[0], ENTRY_SETTINGS_REPLY, ENTRY_SETTINGS_TEXTS[1],
                ENTRY_SETTINGS_REPLY, ENTRY_SETTINGS_TEXTS[2]), "", ()),
], ids=["both-inherit-both-keywords", "depth-five-budget-fifty", "depth-inherits-again"])
def test_native_entry_settings_fixture_uses_entry_depth_budget_and_inheritance(depth_a, budget_b, contents,
                                                                               expected, selected):
    # Costs 8 and 51; with the separator both together cost 60, under the book's 100.
    assert (len(ENTRY_SETTINGS_A), len(ENTRY_SETTINGS_B)) == (16, 101)
    assert ENTRY_SETTINGS_TEXTS[1].count("远灯") == 0 and "预算灯" not in ENTRY_SETTINGS_TEXTS[2]
    assert all(word not in ENTRY_SETTINGS_REPLY for word in ("远灯", "预算灯"))
    result = evaluate(entry_settings_books(depth_a, budget_b), contents)
    assert result.text == expected
    assert result.selected_ordinals == selected
    assert result.diagnostics == []
    if depth_a == 5:
        # Neither effect can come from another condition: A needs its own depth,
        # B is excluded by its own budget alone (51 would admit it).
        assert evaluate(entry_settings_books(None, 50), contents).text == ""
        assert evaluate(entry_settings_books(5, None), contents).text == ENTRY_SETTINGS_A + "\n\n" + ENTRY_SETTINGS_B
        assert evaluate(entry_settings_books(5, 51), contents).text == ENTRY_SETTINGS_A + "\n\n" + ENTRY_SETTINGS_B
    if contents[-1] == ENTRY_SETTINGS_TEXTS[2]:
        # A stale depth of five would still reach the first chat and inject A.
        assert evaluate(entry_settings_books(5, 50), contents).text == ENTRY_SETTINGS_A


def test_native_entry_settings_priority_keeps_the_fixture_ahead_of_other_books():
    # 1590 characters cost 795: alone it fits the global 800, but not beside either entry.
    other = book([entry("large", content="L" * 1590, alwaysActive=True, insertionOrder=1)], "other",
                 tokenBudget=4000)
    contents = ENTRY_SETTINGS_TEXTS[:1]
    result = evaluate(entry_settings_books(None, None) + [other], contents)
    assert result.text == ENTRY_SETTINGS_A + "\n\n" + ENTRY_SETTINGS_B
    assert result.selected_ordinals == ((0, 0), (0, 1))
    lowered = entry_settings_books(None, None)
    for value in lowered[0]["entries"]:
        value["priority"] = 0
    assert evaluate(lowered + [other], contents).text == "L" * 1590


@pytest.mark.parametrize("changes", [{"enabled": False}, {"keywords": ["absent"]},
                                    {"tokenBudget": 7}],
                         ids=["disabled", "untriggered", "entry-too-large"])
def test_maximum_native_priority_does_not_bypass_eligibility_or_entry_budget(changes):
    high = entry("a", content="PRIORITY_A_ONLY", priority=2147483647, **changes)
    low = entry("b", content="PRIORITY_B_ONLY", priority=0)
    result = evaluate([book([high, low], tokenBudget=8)])
    assert result.text == "PRIORITY_B_ONLY" and result.selected_ordinals == ((0, 1),)


def test_equal_priority_uses_insertion_order_then_stable_book_and_entry_order():
    books = [book([entry("late", content="late", priority=2, insertionOrder=20),
                   entry("first", content="first", priority=2, insertionOrder=10),
                   entry("same", content="same", priority=2, insertionOrder=10)], "first"),
             book([entry("other", content="other", priority=2, insertionOrder=10)], "second")]
    result = evaluate(books, max_tokens=3)
    assert result.text == "first" and result.selected_ordinals == ((0, 1),)


def test_regex_priority_uses_the_same_budget_competition_after_matching():
    result = evaluate([book([entry("literal", content="PRIORITY_A_ONLY", priority=1),
                             entry("regex", content="PRIORITY_B_ONLY", keywords=["^hello$"],
                                   useRegex=True, priority=2)], tokenBudget=8)])
    assert result.text == "PRIORITY_B_ONLY" and result.selected_ordinals == ((0, 1),)


def test_ties_and_duplicate_entry_ids_use_stable_book_and_entry_ordinals():
    result = evaluate([book([entry("duplicate", content="one"), entry("duplicate", content="two")], "a"),
                       book([entry("duplicate", content="three")], "b")], max_tokens=4)
    assert result.text == "one\n\ntwo" and result.selected_ordinals == ((0, 0), (0, 1))


def test_book_budget_aggregates_its_entries_even_when_other_books_interleave():
    result = evaluate([book([entry("a", content="aaa", insertionOrder=1), entry("b", content="bbb", insertionOrder=3)],
                           "limited", tokenBudget=3),
                       book([entry("c", content="ccc", insertionOrder=2)], "other")])
    assert result.text == "aaa\n\nccc"


def test_recursive_closure_is_same_book_and_optional():
    entries = [entry("first", keywords=["start"], content="middle"),
               entry("second", keywords=["middle"], content="finish")]
    assert evaluate([book(entries)], ["start"]).text == "middle"
    assert evaluate([book(entries, recursiveScanning=True)], ["start"]).text == "middle\n\nfinish"
    assert evaluate([book(entries[:1], "a", recursiveScanning=True),
                     book(entries[1:], "b", recursiveScanning=True)], ["start"]).text == "middle"


def test_recursion_visits_ordinals_not_ids_and_stops_cycles():
    entries = [entry("same", keywords=["<start>"], content="<two>"),
               entry("same", keywords=["<two>"], content="<three>"),
               entry("same", keywords=["<three>"], content="<start>")]
    result = evaluate([book(entries, recursiveScanning=True)], ["<start>"])
    assert result.selected_ordinals == ((0, 0), (0, 1), (0, 2)) and result.diagnostics == []


def test_scan_depth_zero_can_match_recursive_content():
    result = evaluate([book([entry("seed", alwaysActive=True, content="recursive"),
                             entry("child", keywords=["recursive"], scanDepth=0)], recursiveScanning=True)], [])
    assert result.text == "recursive\n\nchild"


@pytest.mark.parametrize("seed_changes", [{"enabled": False}, {"tokenBudget": 0}])
def test_disabled_or_zero_budget_entries_do_not_trigger_recursion(seed_changes):
    result = evaluate([book([entry("seed", alwaysActive=True, content="trigger", **seed_changes),
                             entry("child", keywords=["trigger"])], recursiveScanning=True)], [])
    assert result.text == ""


def test_recursion_precedes_budget_without_backtracking():
    result = evaluate([book([entry("seed", keywords=["start"], content="trigger " + "x" * 100),
                             entry("child", keywords=["trigger"], content="ok")], recursiveScanning=True)],
                      ["start"], max_tokens=2)
    assert result.text == "ok" and result.selected_ordinals == ((0, 1),)


def test_eight_recursive_expansions_and_bound_diagnostic():
    entries = [entry(f"entry-{i}", keywords=[f"<{i}>"], content=f"<{i + 1}>") for i in range(10)]
    result = evaluate([book(entries, recursiveScanning=True)], ["<0>"])
    assert result.selected_ordinals == tuple((0, i) for i in range(9))
    assert result.diagnostics == [{"persona_id": "persona-a", "revision": 1, "book_id": "book", "entry_id": "",
                                   "entry_index": -1, "book_index": 0, "request_id": "request-a",
                                   "code": "recursion_depth_limit"}]


def test_recursion_text_cap_keeps_whole_source_prefix_and_counts_separators():
    entries = [entry("first", alwaysActive=True, content="inside" + "x" * (65_535 - 6)),
               entry("overflow", alwaysActive=True, content="outside"),
               entry("later", alwaysActive=True, content="later"),
               entry("inside-child", keywords=["inside"], content="accepted"),
               entry("outside-child", keywords=["outside"], content="BAD"),
               entry("later-child", keywords=["later"], content="BAD2")]
    result = evaluate([book(entries, recursiveScanning=True)], [])
    assert result.text == "outside\n\nlater\n\naccepted"
    assert [(item["code"], item["entry_id"]) for item in result.diagnostics] == [("recursion_text_limit", "overflow")]


def test_oversize_first_recursive_source_is_not_partially_scanned():
    result = evaluate([book([entry("seed", alwaysActive=True, content="trigger" + "x" * 65_536),
                             entry("child", keywords=["trigger"], content="BAD")], recursiveScanning=True)], [])
    assert result.text == "" and result.diagnostics[0]["code"] == "recursion_text_limit"


@pytest.mark.parametrize("logic", ["not_any", "not_all"])
def test_invalid_auxiliary_regex_rejects_entry_without_blocking_healthy_entries(logic):
    result = evaluate([book([entry("broken", secondaryKeywords=["["], selectiveLogic=logic, useRegex=True),
                             entry("healthy", useRegex=True)])])
    assert result.text == "healthy"
    assert result.diagnostics[0]["entry_id"] == "broken" and result.diagnostics[0]["code"] == "invalid_regex"
    assert "private comment" not in repr(result.diagnostics)
    assert "[" not in json.dumps(result.diagnostics[0])


def test_regex_error_in_later_participating_primary_pattern_is_not_hidden_by_first_match():
    result = evaluate([book([entry(keywords=["hello", "["], useRegex=True)])])
    assert result.text == "" and result.diagnostics[0]["code"] == "invalid_regex"


def test_nonparticipating_auxiliary_regex_is_not_evaluated():
    result = evaluate([book([entry(keywords=["absent"], secondaryKeywords=["["], useRegex=True)])])
    assert result.text == "" and result.diagnostics == []


def test_new_snapshot_revision_repairs_regex_without_permanent_disabling():
    async def run():
        engine = WorldbookEngine()
        try:
            broken = compile_snapshot("persona-a", record([book([entry(keywords=["["], useRegex=True)])]))
            repaired = compile_snapshot("persona-a", record([book([entry(useRegex=True)])], revision=2))
            one = await engine.evaluate(broken, [{"content": "hello"}], "one")
            two = await engine.evaluate(repaired, [{"content": "hello"}], "two")
            assert one.text == "" and one.diagnostics[0]["revision"] == 1
            assert two.text == "entry" and two.diagnostics == []
            assert broken.checksum != repaired.checksum
        finally:
            await engine.aclose()
    asyncio.run(run())


def test_diagnostics_are_bounded_and_report_total_without_raw_patterns_messages_or_content():
    entries = [entry(f"entry-{i}", keywords=["[PRIVATE_PATTERN"], useRegex=True, content="PRIVATE_CONTENT")
               for i in range(MAX_DIAGNOSTICS + 5)]
    result = evaluate([book(entries)], ["PRIVATE_MESSAGE"])
    assert len(result.diagnostics) == MAX_DIAGNOSTICS and result.diagnostics_total == MAX_DIAGNOSTICS + 5
    assert "PRIVATE" not in json.dumps(result.diagnostics)


def test_real_regex_timeout_allows_a_healthy_later_regex_entry():
    result = evaluate([book([entry("bomb", keywords=["(a+)+$"], useRegex=True),
                             entry("healthy", keywords=["!$"], useRegex=True)])], ["a" * 10_000 + "!"])
    assert result.text == "healthy" and result.diagnostics[0]["code"] == "regex_timeout"


def test_cancellation_reaps_the_actual_engine_worker():
    async def run():
        engine = WorldbookEngine()
        snapshot = compile_snapshot("persona-a", record([book([entry(keywords=["(a+)+$"], useRegex=True)])]))
        task = asyncio.create_task(engine.evaluate(snapshot, [{"content": "a" * 10_000 + "!"}], "cancel"))
        try:
            for _ in range(500):
                pids = [session.active_pid for session in engine._sessions if session.active_pid]
                if pids:
                    break
                await asyncio.sleep(0.001)
            assert pids
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
            for pid in pids:
                with pytest.raises(ProcessLookupError):
                    os.kill(pid, 0)
            assert engine._sessions == set()
        finally:
            await engine.aclose()
    asyncio.run(run())


def test_failed_ended_cleanup_blocks_new_regex_workers_but_literals_and_always_active_continue(monkeypatch):
    created = []
    class Session:
        def __init__(self):
            self.has_pending_worker = True
            self.recoverable = False
            self.closed_attempts = 0
            created.append(self)
        async def evaluate(self, *args):
            return RegexOutcome("MATCH")
        async def aclose(self):
            self.closed_attempts += 1
            if not self.recoverable:
                raise RegexCleanupError()
            self.has_pending_worker = False
    monkeypatch.setattr(engine_module, "RegexSession", Session)
    async def run():
        engine = WorldbookEngine()
        snapshot = compile_snapshot("persona-a", record([book([
            entry("regex", useRegex=True), entry("literal"),
            entry("always", alwaysActive=True, keywords=["["], useRegex=True),
        ])]))
        with pytest.raises(RegexCleanupError):
            await engine.evaluate(snapshot, [{"content": "hello"}], "first")
        assert len(created) == 1 and len(engine._pending_cleanup) == 1
        next_result = await engine.evaluate(snapshot, [{"content": "hello"}], "second")
        assert next_result.text == "literal\n\nalways"
        assert len(created) == 1, "unreaped previous work must gate new regex session creation"
        assert next_result.diagnostics[0]["code"] == "regex_worker_unavailable"
        assert created[0].closed_attempts == 2
        created[0].recoverable = True
        # A fresh session is allowed only after the retained one is confirmed
        # cleaned; make new sessions cleanly close for the repaired turn.
        original_init = Session.__init__
        def recoverable_init(self):
            original_init(self)
            self.recoverable = True
        monkeypatch.setattr(Session, "__init__", recoverable_init)
        repaired = await engine.evaluate(snapshot, [{"content": "hello"}], "third")
        assert repaired.text == "regex\n\nliteral\n\nalways"
        assert len(created) == 2 and not engine._pending_cleanup
        await engine.aclose()
    asyncio.run(run())


def test_pending_cleanup_is_retried_once_per_turn_and_does_not_delay_literal_only_turn(monkeypatch):
    class PendingSession:
        has_pending_worker = True
        attempts = 0
        async def aclose(self):
            self.attempts += 1
            raise RegexCleanupError()
    pending = PendingSession()
    async def run():
        engine = WorldbookEngine()
        engine._sessions.add(pending)
        engine._pending_cleanup.add(pending)
        literal_snapshot = compile_snapshot("persona-a", record([book([entry("literal")])]))
        result = await engine.evaluate(literal_snapshot, [{"content": "hello"}], "literal")
        assert result.text == "literal" and pending.attempts == 0
        regex_snapshot = compile_snapshot("persona-a", record([book([
            entry("regex-a", useRegex=True), entry("regex-b", useRegex=True), entry("literal"),
        ])]))
        result = await engine.evaluate(regex_snapshot, [{"content": "hello"}], "regex")
        assert result.text == "literal" and pending.attempts == 1
        assert [item["entry_id"] for item in result.diagnostics] == ["regex-a", "regex-b"]
        pending.has_pending_worker = False
        await engine.aclose()
    asyncio.run(run())


def test_live_concurrent_evaluations_do_not_misclassify_each_other_as_failed_cleanup(monkeypatch):
    created = []
    async def run():
        first_started = asyncio.Event()
        release_first = asyncio.Event()
        class Session:
            def __init__(self):
                self.index = len(created)
                self.has_pending_worker = True
                created.append(self)
            async def evaluate(self, *args):
                if self.index == 0:
                    first_started.set()
                    await release_first.wait()
                return RegexOutcome("MATCH")
            async def aclose(self):
                self.has_pending_worker = False
        monkeypatch.setattr(engine_module, "RegexSession", Session)
        engine = WorldbookEngine()
        snapshot = compile_snapshot("persona-a", record([book([entry(useRegex=True)])]))
        first = asyncio.create_task(engine.evaluate(snapshot, [{"content": "hello"}], "first"))
        await first_started.wait()
        second = await engine.evaluate(snapshot, [{"content": "hello"}], "second")
        assert second.text == "entry" and len(created) == 2
        assert not engine._pending_cleanup and not first.done()
        release_first.set()
        assert (await first).text == "entry"
        await engine.aclose()
    asyncio.run(run())


@pytest.mark.parametrize("cancel_mode", ["requested", "propagated"])
def test_engine_cancellation_survives_cleanup_failure_and_cannot_continue_to_provider(monkeypatch, cancel_mode):
    async def run():
        started = asyncio.Event()
        sessions = []
        class Session:
            def __init__(self):
                self.has_pending_worker = True
                self.recoverable = False
                sessions.append(self)
            async def evaluate(self, *args):
                started.set()
                if cancel_mode == "propagated":
                    raise asyncio.CancelledError()
                await asyncio.Future()
            async def aclose(self):
                if not self.recoverable:
                    raise RegexCleanupError()
                self.has_pending_worker = False
        monkeypatch.setattr(engine_module, "RegexSession", Session)
        engine = WorldbookEngine()
        snapshot = compile_snapshot("persona-a", record([book([entry(useRegex=True)])]))
        provider_reached = False
        async def simulated_chat():
            nonlocal provider_reached
            await engine.evaluate(snapshot, [{"content": "hello"}], "cancel")
            provider_reached = True
        turn = asyncio.create_task(simulated_chat())
        await started.wait()
        if cancel_mode == "requested":
            turn.cancel()
        with pytest.raises(asyncio.CancelledError):
            await turn
        assert turn.cancelled() and not provider_reached
        assert len(engine._pending_cleanup) == 1
        assert sessions[0].has_pending_worker
        sessions[0].recoverable = True
        await engine.aclose()
        assert not engine._pending_cleanup
    asyncio.run(run())


# The three native regex chats use distinct fixed prefixes, while the scanned
# subject remains ID-12. One-message depth and disabled recursion exclude old
# chat text and other entries as alternative reasons for a match.
REGEX_GUI_MESSAGES = ("正则记录一：ID-12", "正则记录二：ID-12", "正则记录三：ID-12")


def regex_gui_entries(stage):
    return [
        entry("p1_regex_a", content="REGEX_A_ONLY", keywords=[r"ID-\d\d"], useRegex=stage >= 2,
              priority=1000, insertionOrder=30),
        entry("p1_regex_b", content="REGEX_B_ONLY", keywords=[
            r"ID-(?:\d{4})" if stage == 1 else r"ID-(?:\d{1,3})" if stage == 2 else r"ID-(?:\d{1,3}"
        ], useRegex=True, priority=1000, insertionOrder=40),
    ]


@pytest.mark.parametrize(("stage", "expected"), [(1, ""), (2, "REGEX_A_ONLY\n\nREGEX_B_ONLY"), (3, "REGEX_A_ONLY")],
                         ids=["literal-and-old-regex-miss", "enabled-and-comma-pattern-hit", "invalid-b-isolated"])
def test_native_regex_gui_three_turn_effects_and_exact_diagnostic(stage, expected):
    entries = regex_gui_entries(stage)
    fixture = book(entries, "p1_regex_book", scanDepth=1, tokenBudget=100, recursiveScanning=False)
    result = evaluate([fixture], ("ID-1234", REGEX_GUI_MESSAGES[stage - 1]), revision=20 + stage)
    assert result.text == expected
    if stage == 3:
        assert result.diagnostics == [{"persona_id": "persona-a", "revision": 23,
            "book_id": "p1_regex_book", "entry_id": "p1_regex_b", "book_index": 0, "entry_index": 1,
            "request_id": "request-a", "code": "invalid_regex"}]
    else:
        assert result.diagnostics == []
    assert all(not value["alwaysActive"] and value["secondaryKeywords"] == [] for value in entries)


@pytest.mark.parametrize(("which", "message"), [
    (0, "正则记录一：ID-12"), (0, "正则记录二：ID-12"), (0, "正则记录三：ID-12"),
    (1, "正则记录一：ID-12"), (1, "正则记录二：ID-12"), (1, "正则记录三：ID-12"),
], ids=["a-literal-first", "a-literal-second", "a-literal-third", "b-old-first", "b-old-second", "b-old-third"])
def test_native_regex_gui_original_rules_cannot_explain_any_later_match(which, message):
    result = evaluate([book([regex_gui_entries(1)[which]], scanDepth=1, tokenBudget=100, recursiveScanning=False)], [message])
    assert result.text == "" and result.diagnostics == []


@pytest.mark.parametrize("fragment", [r"ID-(?:\d{1", r"3})"], ids=["split-quantifier-left", "split-quantifier-right"])
def test_native_regex_gui_comma_split_fragments_are_errors(fragment):
    result = evaluate([book([entry(keywords=[fragment], useRegex=True)], scanDepth=1)], [REGEX_GUI_MESSAGES[1]])
    assert result.text == ""
    assert [value["code"] for value in result.diagnostics] == ["invalid_regex"]


def test_native_regex_gui_priority_and_budgets_do_not_mask_the_two_markers():
    unrelated = book([entry("unrelated", content="OTHER_FILL", alwaysActive=True, priority=0, insertionOrder=0)], "other")
    fixture = book(regex_gui_entries(2), "p1_regex_book", scanDepth=1, tokenBudget=100, recursiveScanning=False)
    result = evaluate([unrelated, fixture], [REGEX_GUI_MESSAGES[1]], max_tokens=13)
    assert result.text == "REGEX_A_ONLY\n\nREGEX_B_ONLY" and result.selected_ordinals == ((1, 0), (1, 1))
    assert result.diagnostics == []
    # If the fixture priority is lost, the earlier short unrelated entry really
    # consumes enough budget to exclude B. This counterexample is not masked by
    # an oversized unrelated entry or by its later insertion order.
    wrong_entries = regex_gui_entries(2)
    for value in wrong_entries:
        value["priority"] = 0
    wrong = evaluate([unrelated, book(wrong_entries, "p1_regex_book", scanDepth=1,
                                     tokenBudget=100, recursiveScanning=False)],
                     [REGEX_GUI_MESSAGES[1]], max_tokens=13)
    assert wrong.text == "OTHER_FILL\n\nREGEX_A_ONLY"
    assert wrong.selected_ordinals == ((0, 0), (1, 0)) and wrong.diagnostics == []
