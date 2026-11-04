"""Unit tests for local hints only; no checker, application or build executes."""

import copy
import json
from pathlib import Path

import pytest

from script.registered_run.coverage import MODE_OPTIONS, load_coverage, suggest_modes, validate_coverage


ROOT = Path(__file__).resolve().parents[1]


def test_gui_coverage_records_all_seven_mode_options_and_real_references():
    coverage = load_coverage(ROOT)
    assert [(mode["id"], tuple(mode["options"])) for mode in coverage["modes"]] == list(MODE_OPTIONS)
    assert coverage["advisoryOnly"] is True
    assert coverage["formalRegressionUnchanged"] is True
    for key in ("sharedProductSources", "sharedFixtures", "sharedCheckSources"):
        for pattern in coverage[key]:
            assert list(ROOT.glob(pattern)), pattern
    for mode in coverage["modes"]:
        for key in ("directions", "productSources", "fixtures", "checkSources"):
            for pattern in mode[key]:
                assert list(ROOT.glob(pattern)), (mode["id"], key, pattern)


@pytest.mark.parametrize(("changed", "expected"), [
    ("native-ui/tests/p1_worldbook_injection_backend_bootstrap.py", ["injection"]),
    ("native-ui/tests/WorldbookRegexProbe.h", ["regex"]),
    ("native-ui/worldbook-entry-settings-verdicts.cjs", ["entry"]),
    ("native-ui/tests/p1_persona_backend_bootstrap.py", ["persona"]),
    ("native-ui/tests/MemoryCandidateBatchCheck.cpp", ["candidate"]),
    ("native-ui/tests/p1_summary_view_fixture.py", ["ordinary"]),
    ("native-ui/tests/SettingsSectionsCheck.cpp", ["settings"]),
    ("src/worldbook/regex_worker.py", ["injection", "regex", "entry", "persona"]),
    ("src/conversation_summary/store.py", ["ordinary"]),
    ("src/emotion/system.py", ["settings"]),
    ("docs/PROCESS-RULES.md", []),
    ("unrelated/deleted-file.py", []),
])
def test_gui_coverage_suggests_local_modes_from_source_fixture_and_check_changes(changed, expected):
    hints = suggest_modes([changed], root=ROOT)
    assert [mode["id"] for mode in hints["modes"]] == expected
    assert hints["advisoryOnly"] is True
    assert hints["formalRegressionUnchanged"] is True
    for mode in hints["modes"]:
        assert mode["matchedPaths"] == [changed]
        assert all(reason["path"] == changed for reason in mode["reasons"])


@pytest.mark.parametrize("changed", ["native-ui/check-native.cjs", "native-ui/native-check-options.cjs",
                                     "native-ui/qml/ChatPanel.qml", "native-ui/tests/CheckContract.h",
                                     "native-ui/tests/gui-mode-coverage.json"])
def test_gui_coverage_shared_changes_suggest_every_mode_without_reducing_formal_selection(changed):
    hints = suggest_modes([changed], root=ROOT)
    assert [mode["id"] for mode in hints["modes"]] == [identity for identity, _ in MODE_OPTIONS]


def test_gui_coverage_hints_are_deterministic_independent_copies_and_preserve_full_metadata():
    coverage = load_coverage(ROOT)
    original = copy.deepcopy(coverage)
    paths = ["native-ui/tests/SettingsSectionsCheck.cpp", "native-ui/tests/WorldbookRegexProbe.h"]
    hints = suggest_modes(paths + paths[::-1], coverage)
    assert hints == suggest_modes(paths[::-1], coverage)
    assert [mode["id"] for mode in hints["modes"]] == ["regex", "settings"]
    hints["modes"][0]["options"].append("--not-real")
    assert coverage == original
    assert len(coverage["modes"]) == 7
    assert suggest_modes([], coverage)["modes"] == []
    copied = validate_coverage(coverage)
    copied["modes"].clear()
    assert coverage == original


@pytest.mark.parametrize("path", ["../data/private", "/absolute", "src/../data/private", "src//chat/a.py",
                                 "src\\chat\\a.py", "C:/data/private", "", "src/chat/*.py", "x\x00y"])
def test_gui_coverage_rejects_nonliteral_or_nonrepository_changed_paths(path):
    with pytest.raises(ValueError):
        suggest_modes([path], root=ROOT)


@pytest.mark.parametrize("mutation", [
    lambda data: data.update(advisoryOnly=False),
    lambda data: data.update(formalRegressionUnchanged=False),
    lambda data: data.update(command="other-checker"),
    lambda data: data.update(requiredOptions=[]),
    lambda data: data["modes"].pop(),
    lambda data: data["modes"].reverse(),
    lambda data: data["modes"][4].update(options=["--p1-memory"]),
    lambda data: data["modes"][0].update(stage="other-check"),
    lambda data: data["modes"][0].update(productSources=["../outside/**"]),
    lambda data: data["modes"][0].update(fixtures=[]),
    lambda data: data["modes"][0].update(directions=["native-ui/other.md"]),
    lambda data: data.update(sharedCheckSources=[]),
])
def test_gui_coverage_rejects_metadata_that_could_hide_modes_or_escape_repository(mutation):
    coverage = load_coverage(ROOT)
    mutation(coverage)
    with pytest.raises(ValueError):
        validate_coverage(coverage)


def test_gui_coverage_loads_explicit_metadata_and_reports_invalid_schema(tmp_path):
    source = tmp_path / "coverage.json"
    source.write_text(json.dumps(load_coverage(ROOT)), encoding="utf-8")
    assert load_coverage(metadata_path=source) == load_coverage(ROOT)
    source.write_text('{"schema":"other"}', encoding="utf-8")
    with pytest.raises(ValueError, match="schema"):
        load_coverage(metadata_path=source)
