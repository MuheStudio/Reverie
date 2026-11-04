import importlib.util
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location('reverie_timing_analysis', Path(__file__).with_name('timing-trace-analysis.py'))
analysis = importlib.util.module_from_spec(spec)
spec.loader.exec_module(analysis)
KINDS = ['WorkTick', 'MouseMove', 'WheelEvent', 'NotifyEvent', 'TimeoutArrival', 'TimeoutRejected', 'ClockAnchor']


def edge(span, parent, kind, start, end, thread=1, a=0, b=0):
    row = {'spanId': span, 'parentSpanId': parent, 'threadId': thread, 'kind': KINDS.index(kind),
           'phase': 0, 'input': 0, 'a': a, 'b': b, 'error': False, 'isGui': thread == 1}
    return [{**row, 'elapsedNs': start, 'edge': 1}, {**row, 'elapsedNs': end, 'edge': 2}]


def snapshot(records):
    return {'schema': 'reverie.qt.timing-trace.v1', 'compiled': True, 'startedNs': '1000',
            'stoppedNs': '2000', 'cutoffNs': '1900', 'recordCount': len(records), 'kindNames': KINDS,
            'records': records, 'droppedRecords': 0, 'incompleteSpans': 0, 'essentialFailure': False,
            'eventTypeNames': {'5': 'MouseMove', '31': 'Wheel', '77': 'UpdateRequest'}}


def test_nested_actual_parent_chain_and_child_union(tmp_path):
    records = edge(1, 0, 'WorkTick', 0, 100) + edge(2, 1, 'MouseMove', 10, 30) + edge(3, 1, 'WheelEvent', 30, 70)
    result = analysis.timing_summary(snapshot(records))
    largest = result['longestSpans'][0]
    assert largest['durationNs'] == 100 and largest['exclusiveNs'] == 40
    assert largest['directChildUnionNs'] == 60
    child = next(s for s in result['longestSpans'] if s['spanId'] == 3)
    assert [n['kind'] for n in child['parentChain']['nodes']] == ['WorkTick', 'WheelEvent']


def test_overlapping_children_subtract_union_instead_of_sum():
    records = edge(1, 0, 'WorkTick', 0, 100) + edge(2, 1, 'MouseMove', 10, 50) + edge(3, 1, 'WheelEvent', 30, 70)
    result = analysis.timing_summary(snapshot(records))
    assert result['longestSpans'][0]['exclusiveNs'] == 40


def test_recursive_kind_union_does_not_double_count_and_threads_are_separate():
    records = edge(1, 0, 'WorkTick', 0, 100) + edge(2, 1, 'WorkTick', 10, 30) + edge(3, 0, 'WorkTick', 0, 100, thread=2)
    groups = analysis.timing_summary(snapshot(records))['spanGroups']
    assert len(groups) == 2
    gui = next(g for g in groups if g['threadId'] == 1)
    assert gui['inclusiveNs'] == 120 and gui['unionNs'] == gui['exclusiveNs'] == 100


def test_cutoff_missing_end_remains_unknown_and_parent_exclusive_unknown():
    records = edge(1, 0, 'WorkTick', 0, 100) + edge(2, 1, 'MouseMove', 10, 50)[:1]
    result = analysis.timing_summary(snapshot(records))
    assert result['closedSpanCount'] == 1 and result['unclosedSpanCount'] == 1
    assert result['longestSpans'][0]['exclusiveNs'] is None
    assert result['unclosedSpans'][0]['durationNs'] is None


def test_negative_duration_or_orphan_edge_cannot_be_measured():
    records = edge(1, 0, 'WorkTick', 50, 10) + edge(2, 0, 'MouseMove', 0, 20)[1:]
    result = analysis.timing_summary(snapshot(records))
    assert result['closedSpanCount'] == 0
    assert result['analysisIssues']['negativeSpanDurations'] == 1
    assert result['analysisIssues']['orphanEnds'] == 1


def test_unknown_kind_index_is_reported_without_fabricating_a_kind():
    records = edge(1, 0, 'WorkTick', 0, 100)
    records[0]['kind'] = 999
    result = analysis.timing_summary(snapshot(records))
    assert result['analysisIssues']['invalidRecords'] == 1
    assert not result['longestSpans']


def test_native_window_event_identity_and_input_overlap():
    records = edge(1, 0, 'NotifyEvent', 0, 100, a=77, b=1) + edge(2, 1, 'MouseMove', 10, 50)
    result = analysis.timing_summary(snapshot(records), anomaly_intervals=[{'clock': 'absolute-steady-clock', 'startNs': 1020, 'endNs': 1060}])
    span = result['longestSpans'][0]
    assert span['eventTypeName'] == 'UpdateRequest' and span['observedWindow']
    assert result['anomalyOverlaps'][0]['perThreadUnionNs'] == [{'threadId': 1, 'unionNs': 40}]
    assert result['anomalyOverlaps'][0]['topSpans'][1]['overlapNs'] == 30


def test_timeout_rejection_and_collection_success_do_not_pass_constraint():
    point = {'spanId': 0, 'parentSpanId': 0, 'threadId': 1, 'edge': 0, 'elapsedNs': 1}
    records = [{**point, 'kind': KINDS.index('TimeoutArrival')}, {**point, 'kind': KINDS.index('TimeoutRejected')}]
    document = {'timingTrace': snapshot(records), 'collectionComplete': True, 'selectedConstraintOutcome': {'passed': False}}
    result = analysis.timing_summary(document)
    assert result['timeoutArrivals'] == result['timeoutRejected'] == 1
    assert result['collectionComplete'] is True and result['selectedConstraintOutcome']['passed'] is False


def test_cross_thread_parent_is_not_a_native_calling_chain():
    result = analysis.timing_summary(snapshot(edge(1, 0, 'WorkTick', 0, 100) + edge(2, 1, 'MouseMove', 10, 50, thread=2)))
    child = next(s for s in result['longestSpans'] if s['spanId'] == 2)
    assert not child['parentChain']['known']
    assert result['analysisIssues']['invalidChildContainment'] == 1


def test_legacy_report_explicitly_has_no_new_timing_trace():
    assert analysis.timing_summary({'schema': 'old.scene'})['timingTraceAvailable'] is False
    old = analysis.timing_summary(snapshot(edge(1, 0, 'NotifyEvent', 0, 100, a=43)))
    assert 'metaCallContext' not in old and 'readingRestoreNotifications' not in old
    assert 'metaCallReceiver' not in old['longestSpans'][0]


def test_anomaly_clock_domain_cannot_be_assumed():
    with pytest.raises(ValueError, match='clock domain'):
        analysis.timing_summary(snapshot([]), anomaly_intervals=[{'clock': 'qmlprofiler-nanoseconds', 'startNs': 1, 'endNs': 2}])


def receiver_context(span=1, **changes):
    return {'spanId': span, 'threadId': 1, 'phase': 0, 'input': 0, 'elapsedNs': 10,
            'chain': [{'className': 'ChatPanel_QMLTYPE_18', 'classNameTruncated': False,
                       'role': 'chatPanel', 'roleKnown': True}],
            'parentChainTruncated': False, 'metadataError': False, **changes}


def context_snapshot(records, contexts, capacity=32768, dropped=0):
    trace = snapshot(records)
    trace['eventTypeNames']['43'] = 'MetaCall'
    trace['metaCallContext'] = {'schema': 'reverie.qt.metacall-context.v1', 'requested': True,
        'complete': dropped == 0,
        'capacity': capacity, 'recordCount': len(contexts), 'droppedContexts': dropped,
        'classNameByteLimit': 79, 'parentNodeLimit': 4, 'records': contexts}
    return trace


def test_meta_call_receiver_binds_span_phase_thread_and_common_clock():
    trace = context_snapshot(edge(1, 0, 'NotifyEvent', 0, 100, a=43), [receiver_context()])
    result = analysis.timing_summary(trace, anomaly_intervals=[
        {'clock': 'absolute-steady-clock', 'startNs': 1020, 'endNs': 1060}])
    receiver = result['longestSpans'][0]['metaCallReceiver']
    assert receiver['chain'][0]['role'] == 'chatPanel'
    assert receiver['elapsedNs'] == 10 and receiver['callbackIdentity'] is None and receiver['nativeSourceStack'] is None
    assert result['anomalyOverlaps'][0]['topSpans'][0]['metaCallReceiver'] == receiver
    assert result['metaCallContext']['validContextCount'] == 1 and result['metaCallContext']['missingContextCount'] == 0
    assert 'metaCallReceiver' not in result['spanGroups'][0]  # Aggregate event costs may include different receivers.


def test_meta_call_overflow_and_unclosed_end_remain_unknown():
    trace = context_snapshot(edge(1, 0, 'NotifyEvent', 0, 100, a=43)[:1], [], capacity=0, dropped=1)
    result = analysis.timing_summary(trace)
    assert result['unclosedSpans'][0]['durationNs'] is None
    assert result['unclosedSpans'][0]['metaCallReceiver']['status'] == 'unknown'
    assert result['metaCallContext']['droppedContexts'] == 1 and result['metaCallContext']['missingContextCount'] == 1
    trace['metaCallContext'].update(capacity=1, recordCount=1, records=[receiver_context()])
    result = analysis.timing_summary(trace)
    assert result['unclosedSpans'][0]['metaCallReceiver']['status'] == 'observed'
    assert result['unclosedSpans'][0]['durationNs'] is None


def test_unknown_and_truncated_receiver_metadata_do_not_infer_callback():
    unknown = receiver_context(chain=[{'className': None, 'classNameTruncated': False,
        'role': 'unknown', 'roleKnown': False}], parentChainTruncated=True, metadataError=True)
    result = analysis.timing_summary(context_snapshot(edge(1, 0, 'NotifyEvent', 0, 100, a=43), [unknown]))
    receiver = result['longestSpans'][0]['metaCallReceiver']
    assert receiver['chain'][0]['className'] is None and receiver['chain'][0]['roleKnown'] is False
    assert receiver['parentChainTruncated'] and receiver['metadataError']
    assert receiver['callbackIdentity'] is None


@pytest.mark.parametrize('change', [lambda c: c.update(threadId=2), lambda c: c.update(phase=1),
    lambda c: c.update(input=9), lambda c: c.update(elapsedNs=101),
    lambda c: c.update(chain=[{'className': 'PRIVATE MESSAGE CONTENT', 'classNameTruncated': False,
                             'role': 'unknown', 'roleKnown': False}]),
    lambda c: c.update(chain=[{'className': 'QObject', 'classNameTruncated': False,
                             'role': 'arbitrary object name', 'roleKnown': True}]),
    lambda c: c.update(chain=[0])])
def test_invalid_receiver_metadata_is_discarded_without_exporting_unbounded_text(change):
    context = receiver_context()
    change(context)
    result = analysis.timing_summary(context_snapshot(edge(1, 0, 'NotifyEvent', 0, 100, a=43), [context]))
    assert result['analysisIssues']['invalidMetaCallContexts'] == 1
    assert result['longestSpans'][0]['metaCallReceiver']['status'] == 'unknown'
    assert 'PRIVATE MESSAGE CONTENT' not in str(result) and 'arbitrary object name' not in str(result)


def test_meta_call_reader_rejects_unbounded_context_header():
    trace = context_snapshot([], [], capacity=32769)
    with pytest.raises(ValueError, match='bounded reader'):
        analysis.timing_summary(trace)


def test_counter_notifications_correlate_current_span_without_implying_timing_cause():
    trace = context_snapshot(edge(1, 0, 'NotifyEvent', 0, 100, a=43), [receiver_context()])
    trace['kindNames'] = KINDS + ['ReadingRestoreCounter']
    trace['records'].append({'spanId': 0, 'parentSpanId': 1, 'threadId': 1, 'isGui': True,
        'phase': 0, 'input': 0, 'kind': len(KINDS), 'elapsedNs': 20, 'edge': 0, 'a': 2, 'b': 15})
    trace['recordCount'] += 1
    result = analysis.timing_summary(trace)
    assert result['readingRestoreNotifications'] == [{'absoluteObservedNs': 1020, 'elapsedNs': 20,
        'parentSpanId': 1, 'threadId': 1, 'phase': 0, 'input': 0, 'counter': 'forceLayoutCount', 'value': 15}]
    assert result['longestSpans'][0]['childPointKinds'] == {'ReadingRestoreCounter': 1}
