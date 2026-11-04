"""Host checks extracted from the passed formal r1 runner.

Function bodies retain their original comparisons and order. Invoke through an
explicit RunContext: its private namespace supplies paths and frozen contracts.
This module never imports or executes a historical report runner.
"""

def verify_summary_acquisition(result, reg):
    # Interpret serialized evidence independently, without importing or calling
    # any native production/test observation helper.
    need(reg.get('summaryInputProbeDiagnostics') == SUMMARY_INPUT_PROBE_SPEC, 'R10_NATIVE_INPUT_PROBE_CONTRACT_CHANGED')
    need(reg.get('summaryAcquisitionDiagnostics') == SUMMARY_DIAGNOSTIC_SPEC,
         'SUMMARY_ACQUISITION_REGISTERED_CONTRACT_CHANGED')
    reports = result.get('reports')
    need(isinstance(reports, list) and len(reports) == 2, 'SUMMARY_ACQUISITION_CYCLES_MISSING')
    archive = reports[0].get('archiveInteraction')
    need(isinstance(archive, dict), 'SUMMARY_ACQUISITION_ARCHIVE_MISSING')
    entries = archive.get('summaryAcquisition')
    need(isinstance(entries, list) and len(entries) == 3 and
         [entry.get('name') for entry in entries] == SUMMARY_NAMES,
         'SUMMARY_ACQUISITION_ORDER_OR_COUNT')

    def tag(value, nullable=False):
        if value is None:
            return nullable
        return isinstance(value, str) and value in SUMMARY_ALLOWED_TAGS

    def identity(value, allow_empty=False):
        return isinstance(value, str) and (allow_empty or bool(value)) and len(value) <= 160 and not any(
            part in value for part in ('\n', '\r', 'mc1.'))

    def whole(value):
        return numeric(value) and value == int(value)

    def receipt_shape(value):
        need(isinstance(value, dict) and set(value) == SUMMARY_RECEIPT_KEYS, 'SUMMARY_RECEIPT_SHAPE')
        for key in ['armed', 'expected', 'saveSuccess', 'readSuccess', 'complete', 'failed']:
            need(type(value[key]) is bool, 'SUMMARY_RECEIPT_BOOLEAN:' + key)
        for key in ['scope', 'oldSaveId', 'oldReadId', 'saveId', 'readId']:
            need(identity(value[key], True), 'SUMMARY_RECEIPT_IDENTITY:' + key)
        for key in ['generation', 'newSaveCount', 'newReadCount', 'observations']:
            need(whole(value[key]) and value[key] >= (-1 if key == 'generation' else 0),
                 'SUMMARY_RECEIPT_COUNTER:' + key)
        need(tag(value['status']) and tag(value['failureReason']), 'SUMMARY_RECEIPT_STATUS_OR_REASON')

    def feedback_shape(value):
        need(isinstance(value, dict) and (not value or set(value) == {'textMatches', 'fullyVisible', 'validated'}) and
             all(type(item) is bool for item in value.values()), 'SUMMARY_FEEDBACK_SHAPE')

    observation_flags = set('''bound geometryValid integerPointInsideClip ready found enabled visible inputPointInsideClip surfaceClosed'''.split())
    observation_numbers = SUMMARY_OBSERVATION_KEYS - observation_flags - {'scope', 'reason', 'scrolls'}

    def observation_shape(value, stable=False):
        keys = SUMMARY_STABLE_KEYS if stable else SUMMARY_OBSERVATION_KEYS
        need(isinstance(value, dict) and (set(value) == keys or
             (stable and set(value) == keys - {'stableFrameSerial'})), 'SUMMARY_OBSERVATION_SHAPE')
        need(identity(value['scope']) and tag(value['reason']) and
             all(type(value[key]) is bool for key in observation_flags), 'SUMMARY_OBSERVATION_IDENTITY_OR_BOOLEAN')
        need(all(numeric(value[key]) for key in observation_numbers), 'SUMMARY_OBSERVATION_NUMERIC')
        need(all(whole(value[key]) for key in ['pointX', 'pointY', 'clipCount', 'scrollCount']) and
             value['clipCount'] >= 0 and value['scrollCount'] >= 0, 'SUMMARY_OBSERVATION_POINT_OR_COUNTER')
        scrolls = value['scrolls']
        need(isinstance(scrolls, list) and len(scrolls) <= 6 and len(scrolls) <= value['scrollCount'],
             'SUMMARY_SCROLL_BOUND')
        for scroll in scrolls:
            need(isinstance(scroll, dict) and set(scroll) == {'contentY', 'contentHeight', 'sceneX', 'sceneY', 'sceneWidth', 'sceneHeight'} and
                 all(numeric(item) for item in scroll.values()) and scroll['contentHeight'] >= 0, 'SUMMARY_SCROLL_SHAPE')
        if stable:
            need(type(value['layoutStable']) is bool and
                 all(whole(value[key]) for key in ['elapsedMs', 'frameSerial', 'stableSinceMs']) and
                 value['elapsedMs'] >= 0 and value['frameSerial'] >= 0 and value['stableSinceMs'] >= -1 and
                 (whole(value['stableFrameSerial']) and value['stableFrameSerial'] >= 0
                  if 'stableFrameSerial' in value else value['stableSinceMs'] == -1),
                 'SUMMARY_STABLE_CLOCK_SHAPE')

    def layout_shape(value):
        need(isinstance(value, dict) and set(value) == {'ready', 'polls', 'resets', 'minimumStableMs', 'last'} and
             type(value['ready']) is bool and value['minimumStableMs'] == 40 and
             all(whole(value[key]) and value[key] >= 0 for key in ['polls', 'resets']), 'SUMMARY_LAYOUT_SHAPE')
        need(isinstance(value['last'], dict), 'SUMMARY_LAYOUT_LAST_MISSING')
        if value['last']:
            observation_shape(value['last'], True)

    nullable_booleans = {'checked', 'shownValue', 'stateEnabled', 'feedbackEnabled'}
    snapshot_flags = {'accented', 'selected', 'stateEnabledKnown', 'feedbackEnabledKnown', 'stateOk', 'attempted', 'performed'}

    def snapshot_shape(value, terminal=False):
        need(isinstance(value, dict) and set(value).issubset(SUMMARY_SNAPSHOT_KEYS | ({'validated'} if terminal else set())) and
             (SUMMARY_SNAPSHOT_KEYS - {'currentIndex', 'index'}).issubset(value), 'SUMMARY_SNAPSHOT_SHAPE')
        observation_shape({key: value[key] for key in SUMMARY_OBSERVATION_KEYS})
        need(value['name'] in SUMMARY_NAMES and value['control'] in SUMMARY_CONTROLS and tag(value['phase']) and
             all(type(value[key]) is bool for key in snapshot_flags), 'SUMMARY_SNAPSHOT_SCALAR_SHAPE')
        need(all(value[key] is None or type(value[key]) is bool for key in nullable_booleans) and
             (type(value['stateEnabled']) is bool if value['stateEnabledKnown'] else value['stateEnabled'] is None) and
             (type(value['feedbackEnabled']) is bool if value['feedbackEnabledKnown'] else value['feedbackEnabled'] is None),
             'SUMMARY_UNMEASURED_BOOLEAN_NOT_NULL')
        need(tag(value['stateStatus'], True) and tag(value['feedbackStatus'], True), 'SUMMARY_STATE_STATUS_SHAPE')
        for key in ['generation', 'currentIndex', 'index', 'clickCount', 'elapsedMs', 'frameSerial']:
            if key in value:
                need(whole(value[key]) and value[key] >= 0, 'SUMMARY_SNAPSHOT_COUNTER:' + key)
        for key in ['clickedSignals','toggledSignals']:
            need(value[key] is None or (whole(value[key]) and value[key]>=0), 'SUMMARY_GUI_SNAPSHOT_SIGNAL_MEASUREMENT')
        signal_shape(value['signalProbe'], True)
        request_shape(value['requestObservation'])
        if value['signalProbe']:
            need(all(value[k] == value['signalProbe'][k] for k in ['clickedSignals','toggledSignals']), 'SUMMARY_GUI_PROCESS_SIGNAL_CACHE_CHANGED')
        else:
            need(value['clickedSignals'] is None and value['toggledSignals'] is None, 'SUMMARY_GUI_EMPTY_PROBE_COUNTS_NOT_NULL')
        need(value['requestObservation']['scope'] == value['scope'] and value['requestObservation']['generation'] == value['generation'], 'SUMMARY_GUI_PROCESS_REQUEST_SCOPE_CHANGED')
        layout_shape(value['layout'])
        receipt_shape(value['receipt'])
        feedback_shape(value['feedbackValidation'])
        if terminal:
            need(value.get('validated') is True and value['phase'] == 'terminal', 'SUMMARY_TERMINAL_NOT_VALIDATED')

    def signal_shape(value, empty=False):
        if empty and value == {}:
            return
        need(isinstance(value,dict) and set(value)==set(SUMMARY_INPUT_PROBE_SPEC['signalKeys']), 'SUMMARY_GUI_SIGNAL_SHAPE')
        counters=['clickedSignals','toggledSignals','canceledSignals','pressedSignals','releasedSignals','checkedChangedSignals','enabledChangedSignals']
        nullable={'checkedBefore','enabledBefore','checkedAfter','enabledAfter'}
        flags=set(value)-set(counters)-nullable-{'phase','inputFailure','mouseDispatchCount'}
        need(all(type(value[k]) is bool for k in flags) and value['phase'] in {'','before-input','after-input','save-readback','terminal'} and identity(value['inputFailure'],True), 'SUMMARY_GUI_SIGNAL_SCALARS')
        for key in counters:
            need(whole(value[key]) and value[key]>=0 if value[key[:-7]+'ObserverValid'] else value[key] is None, 'SUMMARY_GUI_SIGNAL_NULL_OR_COUNT:'+key)
        need(whole(value['mouseDispatchCount']) and value['mouseDispatchCount']>=0 if value['armed'] else value['mouseDispatchCount'] is None, 'SUMMARY_GUI_MOUSE_MEASUREMENT')
        need(all(value[k] is None or type(value[k]) is bool for k in nullable), 'SUMMARY_GUI_SIGNAL_VALUE_MEASUREMENT')
        if value['mouseDispatchCount'] == 0:
            need(value['checkedAfter'] is None and value['enabledAfter'] is None, 'SUMMARY_GUI_PRE_MOUSE_AFTER_NOT_NULL')
    def request_shape(value):
        need(isinstance(value,dict) and set(value)==set(SUMMARY_INPUT_PROBE_SPEC['requestKeys']) and
             value['source']=='feedback-and-response-identities' and type(value['observerArmed']) is bool and
             identity(value['scope']) and whole(value['generation']) and value['generation']>=0, 'SUMMARY_GUI_REQUEST_SHAPE')
        need(value['rendererSettingsDelta'] is None and value['rendererReadDelta'] is None and value['payloadMatches'] is None,
             'SUMMARY_GUI_TRANSPORT_OR_PAYLOAD_UNKNOWN_NOT_NULL')
        need(all(identity(value[k],True) for k in ['saveRequestId','readRequestId','sourceSaveId']), 'SUMMARY_GUI_REQUEST_ID_TYPE')
        for key in ['observedSaveRequestCount','observedReadRequestCount','saveResponses','readResponses']:
            need(whole(value[key]) and value[key]>=0 if value['observerArmed'] else value[key] is None, 'SUMMARY_GUI_REQUEST_NULL_OR_COUNT:'+key)
        for key in ['expected','saveIdentityMatches','savePending']:
            need(type(value[key]) is bool if value['observerArmed'] else value[key] is None, 'SUMMARY_GUI_REQUEST_NULL_OR_BOOLEAN:'+key)

    previous_click = -1
    observed = []
    for index, entry in enumerate(entries):
        need(isinstance(entry, dict) and set(entry) == SUMMARY_ENTRY_KEYS, 'SUMMARY_ACQUISITION_ENTRY_SHAPE')
        need(entry['control'] == SUMMARY_CONTROLS[index] and identity(entry['scope']) and
             whole(entry['generation']) and entry['generation'] >= 0 and entry['failure'] == '',
             'SUMMARY_ACQUISITION_ENTRY_IDENTITY')
        need(all(entry[key] is True for key in ['attempted', 'performed', 'sealed', 'passed']) and
             integer(entry['clickCount']) and entry['clickCount'] == 1 and
             all(whole(entry[key]) and entry[key]>=0 for key in ['clickedSignals','toggledSignals']) and entry['signalFailure']=='',
             'SUMMARY_INPUT_NOT_PERFORMED_EXACTLY_ONCE')
        start, click, elapsed = [entry[key] for key in ['inputStartMs', 'clickAtMs', 'inputElapsedMs']]
        need(all(whole(value) for value in [start, click, elapsed]) and start >= 0 and
             0 <= elapsed < 4000 and click == start + elapsed and click >= previous_click,
             'SUMMARY_INPUT_CLOCK_OR_ORIGINAL_DEADLINE')
        previous_click = click
        need(entry['expected'] is None if index == 0 else type(entry['expected']) is bool,
             'SUMMARY_EXPECTED_UNMEASURED_NOT_NULL')
        receipt_shape(entry['receipt'])
        feedback_shape(entry['feedbackValidation'])
        signal_shape(entry['signalProbe']); request_shape(entry['requestObservation'])
        diagnostic = entry['diagnostic']
        need(isinstance(diagnostic, dict) and set(diagnostic) == {'samples', 'terminal', 'terminalCount', 'sampleLimit', 'observations'} and
             diagnostic['sampleLimit'] == 6 and integer(diagnostic['terminalCount']) and diagnostic['terminalCount'] == 1,
             'SUMMARY_DIAGNOSTIC_LIMITS')
        samples, terminal = diagnostic['samples'], diagnostic['terminal']
        need(isinstance(samples, list) and 1 <= len(samples) <= 6 and
             whole(diagnostic['observations']) and diagnostic['observations'] >= len(samples),
             'SUMMARY_PROCESS_BOUND_OR_OBSERVATIONS')
        for sample in samples:
            snapshot_shape(sample)
            need(sample['name'] == entry['name'] and sample['control'] == entry['control'] and
                 sample['scope'] == entry['scope'] and sample['generation'] == entry['generation'],
                 'SUMMARY_PROCESS_IDENTITY_CHANGED')
        snapshot_shape(terminal, True)
        need(terminal['name'] == entry['name'] and terminal['control'] == entry['control'] and
             terminal['scope'] == entry['scope'] and terminal['generation'] == entry['generation'] and
             terminal['selected'] is True and terminal['accented'] is True and terminal.get('currentIndex') == terminal.get('index') == 1 and
             terminal['attempted'] is True and terminal['performed'] is True and
             terminal['clickCount'] == 1 and terminal['clickedSignals'] == entry['clickedSignals'] and
             terminal['toggledSignals'] == entry['toggledSignals'] and terminal['elapsedMs'] >= elapsed,
             'SUMMARY_TERMINAL_IDENTITY_OR_SELECTION')
        layout = terminal['layout']
        accepted = layout['last']
        need(layout['ready'] is True and layout['polls'] >= 2 and accepted and
             all(accepted[key] is True for key in observation_flags | {'layoutStable'}) and
             accepted['scope'] == entry['scope'] and accepted['reason'] == 'ready' and
             accepted['elapsedMs'] - accepted['stableSinceMs'] >= 40 and
             accepted['frameSerial'] > accepted['stableFrameSerial'] and accepted['elapsedMs'] <= elapsed and
             terminal['frameSerial'] >= accepted['frameSerial'], 'SUMMARY_INPUT_STABLE_QUALIFICATION_MISSING')
        for prefix in ['scene', 'clip']:
            need(accepted[prefix + 'Width'] >= 1 and accepted[prefix + 'Height'] >= 1 and
                 accepted[prefix + 'X'] <= accepted['pointX'] <= accepted[prefix + 'X'] + accepted[prefix + 'Width'] and
                 accepted[prefix + 'Y'] <= accepted['pointY'] <= accepted[prefix + 'Y'] + accepted[prefix + 'Height'],
                 'SUMMARY_INPUT_INTEGER_POINT_OUTSIDE_QUALIFIED_GEOMETRY')
        need(entry['receipt'] == terminal['receipt'] and entry['feedbackValidation'] == terminal['feedbackValidation'] and
             entry['signalProbe'] == terminal['signalProbe'] and entry['requestObservation'] == terminal['requestObservation'],
             'SUMMARY_TERMINAL_RECEIPT_OR_FEEDBACK_CHANGED')
        signal = entry['signalProbe']; request = entry['requestObservation']
        valid_flags = set(SUMMARY_INPUT_PROBE_SPEC['signalKeys']) - {'phase','inputFailure','mouseDispatchCount',
            'checkedBefore','enabledBefore','checkedAfter','enabledAfter','clickedSignals','toggledSignals','canceledSignals',
            'pressedSignals','releasedSignals','checkedChangedSignals','enabledChangedSignals','rearmRejected'}
        need(all(signal[k] is True for k in valid_flags) and signal['rearmRejected'] is False and signal['inputFailure']=='' and signal['phase']=='terminal' and
             signal['mouseDispatchCount']==entry['clickCount']==1 and signal['clickedSignals']==entry['clickedSignals'] and
             signal['toggledSignals']==entry['toggledSignals'] and request['scope']==entry['scope'] and
             request['generation']==entry['generation'], 'SUMMARY_GUI_TERMINAL_INPUT_IDENTITY')
        receipt = entry['receipt']
        if index == 0:
            need(entry['clickedSignals']==1 and request['observerArmed'] is False and
                 request['saveRequestId']==request['readRequestId']==request['sourceSaveId']=='', 'SUMMARY_GUI_TAB_CLICK_OR_NO_RECEIPT_IDS')
            need(receipt['armed'] is False and receipt['complete'] is False and receipt['failed'] is False and
                 receipt['saveId'] == receipt['readId'] == '' and receipt['newSaveCount'] == receipt['newReadCount'] == 0 and
                 entry['feedbackValidation'] == {}, 'SUMMARY_TAB_HAS_UNEXPECTED_SAVE_OR_FEEDBACK')
        else:
            need(entry['toggledSignals']==1 and entry['clickedSignals'] in (0,1) and
                 request['observerArmed'] is True and request['expected'] is entry['expected'] and
                 all(request[k]==1 for k in ['observedSaveRequestCount','observedReadRequestCount','saveResponses','readResponses']) and
                 request['saveIdentityMatches'] is True and request['savePending'] is False and
                 request['saveRequestId']==receipt['saveId'] and request['readRequestId']==receipt['readId'] and
                 request['sourceSaveId']==receipt['saveId'], 'SUMMARY_GUI_SWITCH_API_AND_OWN_RESPONSE_PAIR')
            need(all(receipt[key] is True for key in ['armed', 'saveSuccess', 'readSuccess', 'complete']) and
                 receipt['failed'] is False and receipt['failureReason'] == '' and receipt['status'] == 'complete' and
                 receipt['scope'] == entry['scope'] and receipt['generation'] == entry['generation'] and
                 receipt['expected'] is entry['expected'] and receipt['newSaveCount'] == receipt['newReadCount'] == 1 and
                 identity(receipt['saveId']) and identity(receipt['readId']) and receipt['saveId'] != receipt['readId'] and
                 receipt['saveId'] != receipt['oldSaveId'] and receipt['readId'] != receipt['oldReadId'],
                 'SUMMARY_NEW_SAVE_AND_FOLLOWING_READ_NOT_BOUND')
            need(terminal['stateEnabledKnown'] is True and terminal['stateOk'] is True and
                 terminal['feedbackEnabledKnown'] is False and terminal['feedbackEnabled'] is None and
                 terminal['checked'] is entry['expected'] and terminal['shownValue'] is entry['expected'] and
                 terminal['stateEnabled'] is entry['expected'] and terminal['feedbackStatus'] == 'success' and
                 terminal['stateStatus'] not in {None, ''} and
                 terminal['elapsedMs'] - elapsed < 10000 and
                 entry['feedbackValidation'] == {'textMatches': True, 'fullyVisible': True, 'validated': True},
                 'SUMMARY_RUNTIME_CHECKED_READBACK_FEEDBACK_OR_DEADLINE')
        observed.append({'name': entry['name'], 'control': entry['control'], 'clickCount': entry['clickCount'],
                         'clickedSignals': entry['clickedSignals'], 'toggledSignals': entry['toggledSignals'], 'inputElapsedMs': elapsed,
                         'processRecords': len(samples), 'terminalRecords': 1, 'selected': True,
                         'expected': entry['expected'], 'passed': True})
    need(len({entry['scope'] for entry in entries}) == len({entry['generation'] for entry in entries}) == 1 and
         entries[0]['inputStartMs'] == entries[1]['inputStartMs'] and
         entries[2]['inputStartMs'] >= entries[1]['clickAtMs'] and
         entries[1]['expected'] is not entries[2]['expected'], 'SUMMARY_SCOPE_GENERATION_OR_SHARED_INPUT_CLOCK_CHANGED')
    first, restored = entries[1]['receipt'], entries[2]['receipt']
    need(restored['oldSaveId'] == first['saveId'] and restored['oldReadId'] == first['readId'] and
         len({first['saveId'], first['readId'], restored['saveId'], restored['readId']}) == 4,
         'SUMMARY_RESTORE_RECEIPT_CHAIN_CHANGED')
    tab_state = entries[0]['diagnostic']['terminal']
    if tab_state['stateEnabledKnown']:
        need(tab_state['stateEnabled'] is entries[2]['expected'], 'SUMMARY_ORIGINAL_VALUE_NOT_RESTORED')
    return {'records': observed, 'clicks': 3, 'clickedSignals': sum(entry['clickedSignals'] for entry in entries),
            'toggledSignalsByAction': [entry['toggledSignals'] for entry in entries],
            'firstTwoShareOriginalInputStart': True, 'saveAndReadPairs': 2,
            'unknownValuesPreservedAsNull': True, 'oldGuiCompletionChecksAdded': 0}
