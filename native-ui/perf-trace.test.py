import importlib.util
import json
from pathlib import Path
import xml.etree.ElementTree as ET

import pytest

spec = importlib.util.spec_from_file_location("reverie_perf_trace", Path(__file__).with_name("perf-trace.py"))
trace = importlib.util.module_from_spec(spec)
spec.loader.exec_module(trace)


def fixture(tmp_path, ranges, definitions=None):
    target = tmp_path.resolve() / "trace.qmltrace"
    definitions = definitions or '<event index="0"><type>Binding</type></event><event index="1"><type>Javascript</type></event>'
    target.write_text(f'<trace version="1.02" traceStart="0" traceEnd="100"><eventData>{definitions}</eventData><profilerDataModel>{ranges}</profilerDataModel></trace>')
    return target


def rows(result):
    return {row['eventIndex']: row for row in result['traceTiming']['topSources']}


def test_actual_event_definitions_and_ranges_are_counted(tmp_path):
    target = fixture(tmp_path, '<range startTime="10" duration="5" eventIndex="0"/><range startTime="20" duration="5" eventIndex="1"/><range startTime="30" duration="5" eventIndex="0"/>', '<event index="0"><type>Binding</type></event><event index="1"><type>SceneGraph</type></event>')
    result = trace.trace_summary(target)
    assert result["traceParsed"] and result["traceHasEvents"]
    assert result["traceRangeCount"] == 3 and result["traceEventDefinitions"] == 2
    assert result["traceEventTypeCounts"] == {"Binding": 2, "SceneGraph": 1}
    assert result["traceAttributes"]["version"] == "1.02"


@pytest.mark.parametrize("content", ["<other/>", '<trace><profilerDataModel><range eventIndex="999"/></profilerDataModel></trace>', '<trace><eventData><event index="0"/><event index="0"/></eventData></trace>'])
def test_nontrace_or_inconsistent_ranges_are_rejected(tmp_path, content):
    target = tmp_path.resolve() / "invalid.qmltrace"
    target.write_text(content)
    with pytest.raises(ValueError):
        trace.trace_summary(target)


def test_empty_valid_trace_does_not_claim_captured_events(tmp_path):
    target = tmp_path.resolve() / "empty.qmltrace"
    target.write_text('<trace version="1.02"><eventData/><profilerDataModel/></trace>')
    result = trace.trace_summary(target)
    assert result["traceParsed"] and not result["traceHasEvents"]
    assert result["traceRangeCount"] == 0


def test_malformed_trace_is_rejected(tmp_path):
    target = tmp_path.resolve() / "broken.qmltrace"
    target.write_text("<trace>")
    with pytest.raises(ET.ParseError):
        trace.trace_summary(target)


def test_zero_length_trace_is_rejected(tmp_path):
    target = tmp_path.resolve() / "zero.qmltrace"
    target.write_bytes(b"")
    with pytest.raises(ValueError, match="size"):
        trace.trace_summary(target)


def test_nested_and_adjacent_ranges_use_child_union(tmp_path):
    target = fixture(tmp_path, '<range startTime="0" duration="100" eventIndex="0"/><range startTime="10" duration="30" eventIndex="1"/><range startTime="40" duration="20" eventIndex="1"/>')
    result = trace.trace_summary(target)
    assert result['traceTiming']['durationUnionNs'] == 100
    assert result['traceTiming']['nestingReliable']
    assert rows(result)['0']['inclusiveNs'] == 100
    assert rows(result)['0']['exclusiveNs'] == 50
    assert rows(result)['1']['unionNs'] == rows(result)['1']['exclusiveNs'] == 50
    assert result['traceTiming']['containedRangeEdges'][0]['count'] == 2


def test_overlapping_crossing_ranges_do_not_claim_exclusive(tmp_path):
    result = trace.trace_summary(fixture(tmp_path, '<range startTime="0" duration="20" eventIndex="0"/><range startTime="10" duration="20" eventIndex="1"/>'))
    assert result['traceTiming']['durationUnionNs'] == 30
    assert result['traceTiming']['crossingDurationRanges'] == 1
    assert not result['traceTiming']['nestingReliable']
    assert all(row['exclusiveNs'] is None for row in rows(result).values())
    assert result['traceTiming']['containedRangeEdges'] == []


def test_same_start_is_bounded_sorted_by_outer_end(tmp_path):
    result = trace.trace_summary(fixture(tmp_path, '<range startTime="0" duration="10" eventIndex="1"/><range startTime="0" duration="20" eventIndex="0"/>'))
    assert rows(result)['0']['exclusiveNs'] == rows(result)['1']['exclusiveNs'] == 10


@pytest.mark.parametrize('duration', ['-1', 'NaN', '1.5', str(2**63)])
def test_bad_duration_is_counted_but_not_fabricated(tmp_path, duration):
    result = trace.trace_summary(fixture(tmp_path, f'<range startTime="0" duration="{duration}" eventIndex="0"/>'))
    assert result['traceRangeCount'] == 1
    assert result['traceTiming']['invalidDurationRanges'] == 1
    assert rows(result)['0']['timedRangeCount'] == 0
    assert rows(result)['0']['exclusiveNs'] is None


def test_unknown_event_type_and_missing_duration_remain_explicit(tmp_path):
    result = trace.trace_summary(fixture(tmp_path, '<range startTime="1" eventIndex="0"/>', '<event index="0"><type>FutureType</type></event>'))
    assert result['traceEventTypeCounts'] == {'FutureType': 1}
    assert result['traceTiming']['rangesWithoutDuration'] == 1
    assert rows(result)['0']['timedRangeCount'] == 0


def test_unsorted_ranges_do_not_claim_a_union_or_nested_chain(tmp_path):
    result = trace.trace_summary(fixture(tmp_path, '<range startTime="20" duration="10" eventIndex="0"/><range startTime="0" duration="10" eventIndex="0"/>'))
    assert result['traceTiming']['unsortedDurationStarts'] == 1
    assert result['traceTiming']['durationUnionNs'] is None
    assert rows(result)['0']['exclusiveNs'] is None


def test_source_is_relative_and_source_or_private_text_is_not_exported(tmp_path):
    source = tmp_path / 'native-ui/qml/Test.qml'
    source.parent.mkdir(parents=True)
    source.write_text('private source body')
    definitions = f'<event index="0"><type>Binding</type><filename>{source.as_uri()}</filename><line>1</line><column>2</column><details>SECRET BODY AND KEY</details><displayname>TEST MESSAGE</displayname></event><event index="1"><filename>file:///private/credentials</filename></event>'
    result = trace.trace_summary(fixture(tmp_path, '<range startTime="0" duration="20" eventIndex="0"/><range startTime="21" duration="1" eventIndex="1"/>', definitions), repo_root=tmp_path)
    assert rows(result)['0']['location'] == {'path': 'native-ui/qml/Test.qml', 'line': 1, 'column': 2, 'known': True}
    assert not rows(result)['1']['location']['known']
    serialized = json.dumps(result)
    assert all(text not in serialized for text in ['SECRET BODY', 'TEST MESSAGE', 'credentials', 'private source body', str(tmp_path)])


def test_anomaly_overlap_requires_an_explicit_common_clock_anchor(tmp_path):
    target = fixture(tmp_path, '<range startTime="0" duration="100" eventIndex="0"/><range startTime="10" duration="30" eventIndex="1"/>')
    intervals = [{'clock': 'absolute-steady-clock', 'startNs': 1010, 'endNs': 1045}]
    unknown = trace.trace_summary(target, anomaly_intervals=intervals)
    assert not unknown['traceTiming']['clockCorrelation']['available']
    aligned = trace.trace_summary(target, anomaly_intervals=intervals, clock_alignment={'qmlTraceNs': 0, 'absoluteSteadyNs': 1000, 'uncertaintyNs': 0})
    correlation = aligned['traceTiming']['clockCorrelation']
    assert correlation['precise'] and correlation['intervals'][0]['unionOverlapNs'] == 35
    uncertain = trace.trace_summary(target, anomaly_intervals=intervals, clock_alignment={'qmlTraceNs': 0, 'absoluteSteadyNs': 1000, 'uncertaintyNs': 5})
    assert not uncertain['traceTiming']['clockCorrelation']['precise']


def test_bounded_nesting_overflow_never_presents_exclusive_cost(tmp_path, monkeypatch):
    monkeypatch.setattr(trace, 'MAX_NESTING', 1)
    result = trace.trace_summary(fixture(tmp_path, '<range startTime="0" duration="100" eventIndex="0"/><range startTime="1" duration="30" eventIndex="1"/>'))
    assert result['traceTiming']['boundedNestingOverflow'] == 1
    assert rows(result)['0']['exclusiveNs'] is None

@pytest.mark.parametrize('url', ['qrc:/ui/Test.qml', ':/ui/Test.qml'])
def test_actual_ui_resource_prefix_maps_without_exporting_external_paths(tmp_path, url):
    source = tmp_path / 'native-ui/qml/Test.qml'
    source.parent.mkdir(parents=True)
    source.write_text('not exported')
    assert trace.source_location(url, '8', '5', tmp_path) == {'path': 'native-ui/qml/Test.qml', 'line': 8, 'column': 5, 'known': True}
    assert not trace.source_location('qrc:/ui/../outside.qml', '1', '1', tmp_path)['known']
