"""Host checks extracted from the passed formal r1 runner.

Function bodies retain their original comparisons and order. Invoke through an
explicit RunContext: its private namespace supplies paths and frozen contracts.
This module never imports or executes a historical report runner.
"""

def text_free(value, depth=0):
    need(depth <= 12, 'MEMORY_EVIDENCE_TOO_DEEP')
    if isinstance(value, dict):
        need(set(value).issubset(EVIDENCE_KEYS), 'MEMORY_EVIDENCE_UNKNOWN_OR_BODY_FIELD')
        need(('samples' not in value and 'terminal' not in value) or depth == 1,
             'MEMORY_EVIDENCE_NESTED_PROCESS_OR_TERMINAL_HISTORY')
        for item in value.values():
            text_free(item, depth + 1)
    elif isinstance(value, list):
        need(len(value) <= 8, 'MEMORY_EVIDENCE_UNBOUNDED_LIST')
        for item in value:
            text_free(item, depth + 1)
    elif isinstance(value, str):
        need(len(value) <= 180 and '\n' not in value and '\r' not in value, 'MEMORY_EVIDENCE_UNBOUNDED_STRING')
    elif value is not None:
        need(type(value) is bool or numeric(value), 'MEMORY_EVIDENCE_UNSUPPORTED_VALUE')

def verify_memory_actions(archive):
    entries = archive.get('memoryActionAcquisition')
    need(isinstance(entries, list) and [entry.get('action') for entry in entries] == ACTION_NAMES,
         'MEMORY_ACTION_ORDER_OR_COUNT')
    previous_input = -1
    backend_requests = []
    for index, entry in enumerate(entries):
        text_free(entry)
        need(entry.get('status') == 'success' and entry.get('attempted') is True and
             entry.get('performed') is True, 'MEMORY_ACTION_NOT_SUCCESS:' + ACTION_NAMES[index])
        need(entry.get('control') == ACTION_CONTROLS[index] and entry.get('verb') == ACTION_VERBS[index] and
             entry.get('inputStep') == ACTION_STEPS[index] and entry.get('inputDeadlineMs') == 4000,
             'MEMORY_ACTION_IDENTITY_OR_DEADLINE')
        need(string(entry.get('subjectId')) and string(entry.get('scope')), 'MEMORY_ACTION_SUBJECT_OR_SCOPE_MISSING')
        elapsed, step_at = entry.get('inputElapsedMs'), entry.get('stepAt')
        need(numeric(elapsed) and 0 <= elapsed < 4000 and numeric(step_at) and step_at >= 0,
             'MEMORY_INPUT_OUTSIDE_ORIGINAL_DEADLINE')
        absolute_input = step_at + elapsed
        need(absolute_input >= previous_input, 'MEMORY_INPUT_ORDER_CHANGED')
        previous_input = absolute_input
        terminal_at = entry.get('terminalOverallMs')
        need(numeric(terminal_at) and terminal_at >= absolute_input, 'MEMORY_TERMINAL_CLOCK_INVALID')
        point = entry.get('inputPoint')
        need(isinstance(point, dict) and set(point) == {'x', 'y'} and
             all(integer(point[axis]) for axis in ('x', 'y')), 'MEMORY_INPUT_POINT_NOT_INTEGER')
        expected_counts = (0, 1) if index == 4 else (1, 0)
        need(all(integer(entry.get(key)) for key in ('clickCount', 'commitCount')) and
             (entry['clickCount'], entry['commitCount']) == expected_counts, 'MEMORY_INPUT_REPEATED_OR_MISSING')
        diagnostic = entry.get('diagnostic')
        need(isinstance(diagnostic, dict) and diagnostic.get('sampleLimit') == 6 and
             integer(diagnostic.get('terminalCount')) and diagnostic.get('terminalCount') == 1,
             'MEMORY_DIAGNOSTIC_LIMITS')
        samples, terminal = diagnostic.get('samples'), diagnostic.get('terminal')
        need(isinstance(samples, list) and 2 <= len(samples) <= 6 and isinstance(terminal, dict) and terminal,
             'MEMORY_PROCESS_OR_TERMINAL_EVIDENCE_MISSING')
        need(numeric(diagnostic.get('observations')) and diagnostic['observations'] >= len(samples),
             'MEMORY_OBSERVATION_COUNT_INVALID')
        layout = terminal.get('layout')
        need(isinstance(layout, dict) and layout.get('ready') is True and layout.get('minimumStableMs') == 40,
             'MEMORY_STABLE_LAYOUT_MISSING')
        stable = layout.get('last')
        need(isinstance(stable, dict) and stable.get('ready') is True and stable.get('layoutStable') is True and
             stable.get('rowId') == entry['subjectId'] and stable.get('scope') == entry['scope'] and
             stable.get('control') == entry['control'], 'MEMORY_STABLE_LAYOUT_IDENTITY')
        observed_at, stable_since = stable.get('elapsedMs'), stable.get('stableSinceMs')
        frame, first_frame = stable.get('frameSerial'), stable.get('stableFrameSerial')
        need(numeric(observed_at) and numeric(stable_since) and observed_at - stable_since >= 40 and
             numeric(frame) and numeric(first_frame) and frame > first_frame,
             'MEMORY_LAYOUT_DID_NOT_CROSS_PRESENTED_FRAME')
        need(all(stable.get(key) is True for key in ['found', 'enabled', 'visible', 'inputPointInsideClip',
             'surfaceClosed', 'geometryValid', 'integerCenterInsideClip']), 'MEMORY_INPUT_QUALIFICATION_MISSING')
        need([stable.get('centerX'), stable.get('centerY')] == [point['x'], point['y']],
             'MEMORY_DISPATCH_POINT_DIFFERS_FROM_QUALIFIED_POINT')
        sequence = terminal.get('sequence')
        expected_sequence = ACTION_NAMES[4:6] if index in (4, 5) else [ACTION_NAMES[index]]
        need(isinstance(sequence, dict) and [part.get('name') for part in sequence.get('actions', [])] == expected_sequence,
             'MEMORY_SEQUENCE_EVIDENCE_MISSING')
        need(sequence.get('expired') is False and sequence.get('failed') is False, 'MEMORY_SEQUENCE_FAILED')
        own = sequence['actions'][0 if index != 5 else 1]
        need(own.get('attempted') is True and own.get('performed') is True and own.get('failed') is False and
             numeric(own.get('actionElapsedMs')) and 0 <= own['actionElapsedMs'] < 4000,
             'MEMORY_SEQUENCE_ACTION_NOT_PERFORMED_ONCE')
        if index in BACKEND_ACTIONS:
            receipt = terminal.get('receipt')
            need(isinstance(receipt, dict) and receipt.get('armed') is True and receipt.get('complete') is True and
                 receipt.get('failed') is False and receipt.get('status') == 'success' and
                 receipt.get('actionSuccess') is True and numeric(receipt.get('newActionCount')) and
                 receipt.get('newActionCount') == 1 and
                 receipt.get('scope') == entry['scope'] and receipt.get('verb') == entry['verb'] and
                 receipt.get('subjectId') == entry['subjectId'], 'MEMORY_BACKEND_RECEIPT_NOT_BOUND')
            request, old_request = receipt.get('requestId'), receipt.get('oldActionId')
            need(string(request) and isinstance(old_request, str) and request != old_request,
                 'MEMORY_BACKEND_RECEIPT_NOT_NEW')
            if backend_requests:
                need(old_request == backend_requests[-1], 'MEMORY_BACKEND_ACTION_CHAIN_CHANGED')
            backend_requests.append(request)
            need(receipt.get('listSuccess') is True and receipt.get('candidateSuccess') is True,
                 'MEMORY_NEW_READBACK_NOT_SUCCESSFUL')
            first = samples[0]
            for read_key, armed_key, barrier_key in [('listId', 'armedListId', 'successListId'),
                                                    ('candidateReadId', 'armedCandidateReadId', 'successCandidateReadId')]:
                read_id = receipt.get(read_key)
                need(all(string(value) for value in [read_id, receipt.get(armed_key), receipt.get(barrier_key), first.get(read_key)]) and
                     all(read_id != value for value in [receipt[armed_key], receipt[barrier_key], first[read_key]]),
                     'MEMORY_READBACK_NOT_NEW_AFTER_ACTION_SUCCESS')
        if index in (3, 4, 5):
            need(entry.get('editingIdMatches') is True, 'MEMORY_EDIT_TARGET_ID_MISSING')
        if index in (6, 7):
            need(entry.get('deletingIdMatches') is True, 'MEMORY_DELETE_TARGET_ID_MISSING')
    need(len(set(backend_requests)) == 5, 'MEMORY_BACKEND_REQUEST_REPEATED')
    need(len({entry['scope'] for entry in entries}) == 1, 'MEMORY_ACTION_SCOPE_CHANGED')
    need(len({entries[index]['subjectId'] for index in (1, 2, 3, 4, 5)}) == 1 and
         entries[6]['subjectId'] == entries[7]['subjectId'] and entries[6]['subjectId'] != entries[5]['subjectId'],
         'MEMORY_REVISION_IDENTITY_CHAIN_CHANGED')
    need(entries[4]['stepAt'] == entries[5]['stepAt'], 'MEMORY_INPUT_AND_SAVE_DEADLINE_RESTARTED')
    need(entries[4].get('focusInTarget') is True and entries[4].get('inputMatchesFixture') is True and
         entries[4].get('inputLength') == FIXTURE_UTF16_LENGTH, 'MEMORY_INPUT_FIXTURE_OR_FOCUS_MISMATCH')
    need(sum(entry['clickCount'] for entry in entries) == 7 and
         sum(entry['commitCount'] for entry in entries) == 1, 'MEMORY_INPUT_TOTALS_CHANGED')
    return entries

def verify_memory_feedback(entries):
    # Retain the first feedback's own bounded geometry and identity. A later
    # control reveal may move it; that does not reopen its accepted snapshot.
    expected_keys = set('''phase requestId scope found visible enabled textMatches fullyVisible validated
textLength expectedLength elapsedMs frameSerial sceneX sceneY sceneWidth sceneHeight
clipX clipY clipWidth clipHeight'''.split())
    for index in BACKEND_ACTIONS:
        entry = entries[index]
        terminal = entry['diagnostic']['terminal']
        receipt = terminal['receipt']
        feedback = terminal.get('feedbackValidation')
        need(isinstance(feedback, dict) and set(feedback) == expected_keys,
             'MEMORY_FIRST_FEEDBACK_EVIDENCE_SHAPE:' + ACTION_NAMES[index])
        need(feedback.get('phase') == 'first-validation' and
             all(feedback.get(key) is True for key in ['found', 'visible', 'textMatches', 'fullyVisible', 'validated']) and
             type(feedback.get('enabled')) is bool, 'MEMORY_FIRST_FEEDBACK_NOT_VALIDATED:' + ACTION_NAMES[index])
        request_id = feedback.get('requestId')
        need(string(request_id) and request_id == receipt['requestId'] and request_id != receipt['oldActionId'] and
             feedback.get('scope') == entry['scope'] == receipt['scope'],
             'MEMORY_FIRST_FEEDBACK_NOT_BOUND_TO_NEW_ACTION:' + ACTION_NAMES[index])
        need(all(numeric(feedback.get(key)) for key in ['textLength', 'expectedLength', 'elapsedMs', 'frameSerial',
             'sceneX', 'sceneY', 'sceneWidth', 'sceneHeight', 'clipX', 'clipY', 'clipWidth', 'clipHeight']) and
             feedback['textLength'] == feedback['expectedLength'] and feedback['expectedLength'] > 0 and
             feedback['frameSerial'] >= 0 and
             0 <= entry['inputElapsedMs'] <= feedback['elapsedMs'] <= entry['terminalOverallMs'] - entry['stepAt'],
             'MEMORY_FIRST_FEEDBACK_GEOMETRY_LENGTH_OR_CLOCK_INVALID:' + ACTION_NAMES[index])

def memory_action_spec_v2():
    # The original five writes keep their controls, verbs and step clocks.
    return {
        'names': ['candidate-confirm', 'strengthen', 'weaken', 'reactivate', 'pin', 'unpin',
                  'open-edit', 'edit-input', 'edit-save', 'open-delete', 'delete-confirm'],
        'controls': ['memoryCandidateConfirm', 'memoryStrengthen', 'memoryWeaken', 'memoryReactivate',
                     'memoryPin', 'memoryPin', 'memoryEdit', 'memoryEditField', 'memoryEditSave',
                     'memoryDelete', 'memoryDeleteConfirm'],
        'verbs': ['记住这条', '强化', '弱化', '重温', '固定记忆', '取消固定', '', '', '修改记忆', '', '删除记忆'],
        'steps': [210, 218, 219, 223, 211, 212, 213, 214, 214, 215, 216],
        'backend': [0, 1, 2, 3, 4, 5, 8, 10],
    }

def memory_text_free_v2(value, depth=0):
    need(depth <= 12, 'MEMORY_EVIDENCE_TOO_DEEP')
    if isinstance(value, dict):
        allowed = EVIDENCE_KEYS | set('''generation adjustment op memoryId beforeImportance afterImportance
readbackImportance importanceText importanceBefore importanceAfter changed'''.split())
        need(set(value).issubset(allowed), 'MEMORY_EVIDENCE_UNKNOWN_OR_BODY_FIELD')
        need(('samples' not in value and 'terminal' not in value) or depth == 1,
             'MEMORY_EVIDENCE_NESTED_PROCESS_OR_TERMINAL_HISTORY')
        for item in value.values():
            memory_text_free_v2(item, depth + 1)
    elif isinstance(value, list):
        need(len(value) <= 8, 'MEMORY_EVIDENCE_UNBOUNDED_LIST')
        for item in value:
            memory_text_free_v2(item, depth + 1)
    elif isinstance(value, str):
        need(len(value) <= 180 and '\n' not in value and '\r' not in value, 'MEMORY_EVIDENCE_UNBOUNDED_STRING')
    elif value is not None:
        need(type(value) is bool or numeric(value), 'MEMORY_EVIDENCE_UNSUPPORTED_VALUE')

def memory_importance_text_v2(value):
    # QML uses Math.round for nonnegative finite importance, then trims zeros.
    rounded = math.floor(value * 100 + 0.5) / 100
    return '重要度 ' + format(rounded, '.2f').rstrip('0').rstrip('.')

def verify_memory_adjustment_v2(entry):
    terminal = entry['diagnostic']['terminal']
    receipt, adjustment = terminal['receipt'], terminal.get('adjustment')
    expected_keys = set('''op memoryId scope generation requestId beforeImportance afterImportance
readbackImportance importanceText'''.split())
    need(isinstance(adjustment, dict) and set(adjustment) == expected_keys,
         'MEMORY_ADJUSTMENT_EVIDENCE_SHAPE')
    need(adjustment['op'] == entry['action'] == receipt.get('op') and
         adjustment['memoryId'] == entry['subjectId'] == receipt.get('memoryId') and
         adjustment['scope'] == entry['scope'] == receipt['scope'] and
         integer(receipt.get('generation')) and integer(adjustment['generation']) and
         adjustment['generation'] == entry['generation'] == receipt['generation'] and
         adjustment['requestId'] == receipt['requestId'], 'MEMORY_ADJUSTMENT_NOT_BOUND')
    before, after, readback = (adjustment[key] for key in
                               ('beforeImportance', 'afterImportance', 'readbackImportance'))
    need(all(numeric(value) and 0 <= value <= 1 and round(value, 6) == value
             for value in (before, after, readback)), 'MEMORY_ADJUSTMENT_IMPORTANCE_INVALID')
    need(numeric(receipt.get('importanceBefore')) and numeric(receipt.get('importanceAfter')) and
         before == receipt['importanceBefore'] and after == receipt['importanceAfter'],
         'MEMORY_ADJUSTMENT_BACKEND_VALUES_CHANGED')
    delta = {'strengthen': 0.1, 'weaken': -0.1, 'reactivate': 0.15}[entry['action']]
    expected = round(max(0.0, min(1.0, before + delta)), 6)
    need(after == expected and type(receipt.get('changed')) is bool and
         receipt['changed'] == (after != before or entry['action'] == 'reactivate'),
         'MEMORY_ADJUSTMENT_DEFAULT_OPERATION_CHANGED')
    need(readback == after and adjustment['importanceText'] == memory_importance_text_v2(readback),
         'MEMORY_ADJUSTMENT_READBACK_OR_UI_MISMATCH')

def verify_memory_actions_v2(archive):
    spec = memory_action_spec_v2()
    names, controls, verbs, steps = (spec[key] for key in ('names', 'controls', 'verbs', 'steps'))
    entries = archive.get('memoryActionAcquisition')
    need(isinstance(entries, list) and all(isinstance(entry, dict) for entry in entries) and
         [entry.get('action') for entry in entries] == names, 'MEMORY_ACTION_ORDER_OR_COUNT')
    previous_input = -1
    backend_requests = []
    for index, entry in enumerate(entries):
        memory_text_free_v2(entry)
        need(entry.get('status') == 'success' and entry.get('attempted') is True and
             entry.get('performed') is True, 'MEMORY_ACTION_NOT_SUCCESS:' + names[index])
        need(entry.get('control') == controls[index] and entry.get('verb') == verbs[index] and
             entry.get('inputStep') == steps[index] and entry.get('inputDeadlineMs') == 4000,
             'MEMORY_ACTION_IDENTITY_OR_DEADLINE')
        need(string(entry.get('subjectId')) and string(entry.get('scope')), 'MEMORY_ACTION_SUBJECT_OR_SCOPE_MISSING')
        need(integer(entry.get('generation')) and entry['generation'] >= 0, 'MEMORY_ACTION_GENERATION_MISSING')
        elapsed, step_at = entry.get('inputElapsedMs'), entry.get('stepAt')
        need(numeric(elapsed) and 0 <= elapsed < 4000 and numeric(step_at) and step_at >= 0,
             'MEMORY_INPUT_OUTSIDE_ORIGINAL_DEADLINE')
        absolute_input = step_at + elapsed
        need(absolute_input >= previous_input, 'MEMORY_INPUT_ORDER_CHANGED')
        previous_input = absolute_input
        terminal_at = entry.get('terminalOverallMs')
        need(numeric(terminal_at) and terminal_at >= absolute_input, 'MEMORY_TERMINAL_CLOCK_INVALID')
        point = entry.get('inputPoint')
        need(isinstance(point, dict) and set(point) == {'x', 'y'} and
             all(integer(point[axis]) for axis in ('x', 'y')), 'MEMORY_INPUT_POINT_NOT_INTEGER')
        expected_counts = (0, 1) if index == 7 else (1, 0)
        need(all(integer(entry.get(key)) for key in ('clickCount', 'commitCount')) and
             (entry['clickCount'], entry['commitCount']) == expected_counts, 'MEMORY_INPUT_REPEATED_OR_MISSING')
        diagnostic = entry.get('diagnostic')
        need(isinstance(diagnostic, dict) and diagnostic.get('sampleLimit') == 6 and
             integer(diagnostic.get('terminalCount')) and diagnostic.get('terminalCount') == 1,
             'MEMORY_DIAGNOSTIC_LIMITS')
        samples, terminal = diagnostic.get('samples'), diagnostic.get('terminal')
        need(isinstance(samples, list) and 2 <= len(samples) <= 6 and isinstance(terminal, dict) and terminal and
             all(isinstance(sample, dict) for sample in samples), 'MEMORY_PROCESS_OR_TERMINAL_EVIDENCE_MISSING')
        need(numeric(diagnostic.get('observations')) and diagnostic['observations'] >= len(samples),
             'MEMORY_OBSERVATION_COUNT_INVALID')
        layout = terminal.get('layout')
        need(isinstance(layout, dict) and layout.get('ready') is True and layout.get('minimumStableMs') == 40,
             'MEMORY_STABLE_LAYOUT_MISSING')
        stable = layout.get('last')
        need(isinstance(stable, dict) and stable.get('ready') is True and stable.get('layoutStable') is True and
             stable.get('rowId') == entry['subjectId'] and stable.get('scope') == entry['scope'] and
             stable.get('control') == entry['control'], 'MEMORY_STABLE_LAYOUT_IDENTITY')
        observed_at, stable_since = stable.get('elapsedMs'), stable.get('stableSinceMs')
        frame, first_frame = stable.get('frameSerial'), stable.get('stableFrameSerial')
        need(numeric(observed_at) and numeric(stable_since) and observed_at - stable_since >= 40 and
             numeric(frame) and numeric(first_frame) and frame > first_frame,
             'MEMORY_LAYOUT_DID_NOT_CROSS_PRESENTED_FRAME')
        need(all(stable.get(key) is True for key in ['found', 'enabled', 'visible', 'inputPointInsideClip',
             'surfaceClosed', 'geometryValid', 'integerCenterInsideClip']), 'MEMORY_INPUT_QUALIFICATION_MISSING')
        need([stable.get('centerX'), stable.get('centerY')] == [point['x'], point['y']],
             'MEMORY_DISPATCH_POINT_DIFFERS_FROM_QUALIFIED_POINT')
        sequence = terminal.get('sequence')
        expected_sequence = names[7:9] if index in (7, 8) else [names[index]]
        need(isinstance(sequence, dict) and
             [part.get('name') for part in sequence.get('actions', [])] == expected_sequence,
             'MEMORY_SEQUENCE_EVIDENCE_MISSING')
        need(sequence.get('expired') is False and sequence.get('failed') is False, 'MEMORY_SEQUENCE_FAILED')
        own = sequence['actions'][1 if index == 8 else 0]
        need(own.get('attempted') is True and own.get('performed') is True and own.get('failed') is False and
             numeric(own.get('actionElapsedMs')) and 0 <= own['actionElapsedMs'] < 4000,
             'MEMORY_SEQUENCE_ACTION_NOT_PERFORMED_ONCE')
        if index in spec['backend']:
            receipt = terminal.get('receipt')
            need(isinstance(receipt, dict) and receipt.get('armed') is True and receipt.get('complete') is True and
                 receipt.get('failed') is False and receipt.get('status') == 'success' and
                 receipt.get('actionSuccess') is True and numeric(receipt.get('newActionCount')) and
                 receipt.get('newActionCount') == 1 and receipt.get('scope') == entry['scope'] and
                 receipt.get('verb') == entry['verb'] and receipt.get('subjectId') == entry['subjectId'],
                 'MEMORY_BACKEND_RECEIPT_NOT_BOUND')
            request, old_request = receipt.get('requestId'), receipt.get('oldActionId')
            need(string(request) and isinstance(old_request, str) and request != old_request,
                 'MEMORY_BACKEND_RECEIPT_NOT_NEW')
            if backend_requests:
                need(old_request == backend_requests[-1], 'MEMORY_BACKEND_ACTION_CHAIN_CHANGED')
            backend_requests.append(request)
            need(receipt.get('listSuccess') is True and receipt.get('candidateSuccess') is True,
                 'MEMORY_NEW_READBACK_NOT_SUCCESSFUL')
            first = samples[0]
            for read_key, armed_key, barrier_key in [('listId', 'armedListId', 'successListId'),
                                                    ('candidateReadId', 'armedCandidateReadId', 'successCandidateReadId')]:
                read_id = receipt.get(read_key)
                need(all(string(value) for value in [read_id, receipt.get(armed_key), receipt.get(barrier_key), first.get(read_key)]) and
                     all(read_id != value for value in [receipt[armed_key], receipt[barrier_key], first[read_key]]),
                     'MEMORY_READBACK_NOT_NEW_AFTER_ACTION_SUCCESS')
        if index in (1, 2, 3):
            verify_memory_adjustment_v2(entry)
        else:
            need('adjustment' not in terminal, 'MEMORY_ADJUSTMENT_ON_UNREGISTERED_ACTION')
        if index in (6, 7, 8):
            need(entry.get('editingIdMatches') is True, 'MEMORY_EDIT_TARGET_ID_MISSING')
        if index in (9, 10):
            need(entry.get('deletingIdMatches') is True, 'MEMORY_DELETE_TARGET_ID_MISSING')
    need(len(set(backend_requests)) == 8, 'MEMORY_BACKEND_REQUEST_REPEATED')
    need(len({entry['scope'] for entry in entries}) == 1, 'MEMORY_ACTION_SCOPE_CHANGED')
    need(len({entry['generation'] for entry in entries}) == 1, 'MEMORY_ACTION_GENERATION_CHANGED')
    need(all(entries[index]['diagnostic']['terminal']['adjustment']['beforeImportance'] ==
             entries[index - 1]['diagnostic']['terminal']['adjustment']['afterImportance']
             for index in (2, 3)), 'MEMORY_ADJUSTMENT_IMPORTANCE_CHAIN_CHANGED')
    need(len({entries[index]['subjectId'] for index in range(1, 9)}) == 1 and
         entries[9]['subjectId'] == entries[10]['subjectId'] and entries[9]['subjectId'] != entries[8]['subjectId'],
         'MEMORY_REVISION_IDENTITY_CHAIN_CHANGED')
    need(entries[7]['stepAt'] == entries[8]['stepAt'], 'MEMORY_INPUT_AND_SAVE_DEADLINE_RESTARTED')
    need(entries[7].get('focusInTarget') is True and entries[7].get('inputMatchesFixture') is True and
         entries[7].get('inputLength') == FIXTURE_UTF16_LENGTH, 'MEMORY_INPUT_FIXTURE_OR_FOCUS_MISMATCH')
    need(sum(entry['clickCount'] for entry in entries) == 10 and
         sum(entry['commitCount'] for entry in entries) == 1, 'MEMORY_INPUT_TOTALS_CHANGED')
    return entries

def verify_memory_feedback_v2(entries):
    expected_keys = set('''phase requestId scope found visible enabled textMatches fullyVisible validated
textLength expectedLength elapsedMs frameSerial sceneX sceneY sceneWidth sceneHeight
clipX clipY clipWidth clipHeight'''.split())
    names = memory_action_spec_v2()['names']
    for index in memory_action_spec_v2()['backend']:
        entry = entries[index]
        terminal = entry['diagnostic']['terminal']
        receipt, feedback = terminal['receipt'], terminal.get('feedbackValidation')
        need(isinstance(feedback, dict) and set(feedback) == expected_keys,
             'MEMORY_FIRST_FEEDBACK_EVIDENCE_SHAPE:' + names[index])
        need(feedback.get('phase') == 'first-validation' and
             all(feedback.get(key) is True for key in ['found', 'visible', 'textMatches', 'fullyVisible', 'validated']) and
             type(feedback.get('enabled')) is bool, 'MEMORY_FIRST_FEEDBACK_NOT_VALIDATED:' + names[index])
        request_id = feedback.get('requestId')
        need(string(request_id) and request_id == receipt['requestId'] and request_id != receipt['oldActionId'] and
             feedback.get('scope') == entry['scope'] == receipt['scope'],
             'MEMORY_FIRST_FEEDBACK_NOT_BOUND_TO_NEW_ACTION:' + names[index])
        need(all(numeric(feedback.get(key)) for key in ['textLength', 'expectedLength', 'elapsedMs', 'frameSerial',
             'sceneX', 'sceneY', 'sceneWidth', 'sceneHeight', 'clipX', 'clipY', 'clipWidth', 'clipHeight']) and
             feedback['textLength'] == feedback['expectedLength'] and feedback['expectedLength'] > 0 and
             feedback['frameSerial'] >= 0 and
             0 <= entry['inputElapsedMs'] <= feedback['elapsedMs'] <= entry['terminalOverallMs'] - entry['stepAt'],
             'MEMORY_FIRST_FEEDBACK_GEOMETRY_LENGTH_OR_CLOCK_INVALID:' + names[index])

def verify_memory_action_result_v2(result):
    reports = result.get('reports')
    need(isinstance(reports, list) and len(reports) == 2 and isinstance(reports[0], dict) and
         isinstance(reports[0].get('archiveInteraction'), dict), 'MEMORY_ACTION_ARCHIVE_MISSING')
    entries = verify_memory_actions_v2(reports[0]['archiveInteraction'])
    verify_memory_feedback_v2(entries)
    return entries

def verify_memory_actions_for_contract(archive, reg):
    version = reg.get('memoryActionContract', 'v1')
    need(version in ('v1', 'v2'), 'REGISTERED_MEMORY_ACTION_CONTRACT_CHANGED')
    return verify_memory_actions_v2(archive) if version == 'v2' else verify_memory_actions(archive)

def verify_memory_feedback_for_contract(entries, reg):
    version = reg.get('memoryActionContract', 'v1')
    need(version in ('v1', 'v2'), 'REGISTERED_MEMORY_ACTION_CONTRACT_CHANGED')
    return verify_memory_feedback_v2(entries) if version == 'v2' else verify_memory_feedback(entries)

def verify_gui(result, reg):
    gui = reg['gui']
    need(gui == GUI_SPEC, 'REGISTERED_GUI_CONTRACT_CHANGED')
    need(result.get('passed') is True, 'ORDINARY_NOT_PASSED')
    need(result.get('sourceHead') == reg['sourceHead'], 'ORDINARY_SOURCE_CHANGED')
    need(result.get('noResidualProcesses') is True and result.get('testDataRemoved') is True and
         result.get('applicationUnchanged') is True and result.get('modelInputUnchanged') is True,
         'ORDINARY_CLEANUP_OR_INPUT_INTEGRITY_FAILED')
    need(result.get('automaticRetry') is False and
         [result.get(key) for key in ['applicationDeadlineMs', 'memoryPageDeadlineMs', 'memoryRestartDeadlineMs',
          'memoryRecallDeadlineMs', 'memoryReadDeadlineMs', 'inputReadinessDeadlineMs']]
         == [240000, 60000, 30000, 20000, 10000, 4000], 'ORDINARY_DEADLINES_OR_RETRY_CHANGED')
    reports = result.get('reports')
    need(isinstance(reports, list) and len(reports) == 2, 'ORDINARY_TWO_CYCLES_MISSING')
    need('memoryCandidateFixture' not in result and all('memoryCandidatePage' not in report and
         'profileClear' not in report for report in reports), 'UNREGISTERED_GUI_EXTENSION')
    counts = []
    for cycle, report in enumerate(reports, 1):
        need(isinstance(report, dict) and report.get('passed') is True and report.get('error') in (None, ''),
             'CYCLE_FAILED:' + str(cycle))
        found = {}
        for group, expected_count in gui['expectedChecksByCycle'][str(cycle)].items():
            data = report.get(group)
            need(isinstance(data, dict) and data.get('passed') is True and data.get('error') in (None, ''),
                 'GUI_GROUP_FAILED:' + str(cycle) + ':' + group)
            checks = data.get('checks')
            need(isinstance(checks, list) and len(checks) == expected_count and
                 all(isinstance(row, dict) and row.get('passed') is True for row in checks),
                 'GUI_CHECKS_MISSING:' + group)
            found[group] = len(checks)
        counts.append(found)
        need([row.get('name') for row in report['memoryPage']['checks']] == gui['pageChecksByCycle'][cycle - 1],
             'MEMORY_PAGE_CHECK_NAMES_CHANGED:' + str(cycle))
    calls = result.get('modelCalls')
    need(integer(result.get('requests')) and result['requests'] == gui['expectedTotalModelRequests'] == 7 and
         isinstance(calls, list) and len(calls) == 7, 'ORDINARY_MODEL_REQUEST_COUNTS_CHANGED')
    kinds = dict(Counter(call.get('kind') for call in calls))
    need(kinds == gui['modelCallKinds'], 'ORDINARY_MODEL_CALL_KIND_COUNTS_CHANGED')
    for cycle in ('1', '2'):
        by_cycle = dict(Counter(call.get('kind') for call in calls if str(call.get('cycle')) == cycle))
        need(by_cycle == gui['requestKindsByCycle'][cycle], 'ORDINARY_MODEL_CALL_CYCLE_MATRIX_CHANGED:' + cycle)
    need(all(call.get('rejectedCandidatePresent') is False for call in calls), 'REJECTED_CANDIDATE_REACHED_MODEL')
    exits = result.get('processExits')
    need(isinstance(exits, list) and [row.get('cycle') for row in exits if row.get('cycle') in (1, 2)] == [1, 2] and
         all(row.get('exitCode') == 0 and row.get('signal') is None and row.get('remaining') == [] for row in exits),
         'ORDINARY_PROCESS_EXIT_EVIDENCE_MISSING')
    need(numeric(reports[0]['archiveInteraction'].get('elapsedMs')) and
         reports[0]['archiveInteraction']['elapsedMs'] < 120000, 'ORIGINAL_ARCHIVE_STAGE_DEADLINE_CHANGED')
    memory = result.get('memoryFixture')
    need(isinstance(memory, dict) and memory.get('passed') is True and memory.get('contentCollected') is False and
         [memory.get(key) for key in ['seededMemories', 'markedMemories', 'pendingCandidates', 'pageSize', 'listCap',
          'expectedModelRequests', 'recallQueries', 'addedHttpRequests', 'recallResultLimit', 'recallCharacterLimit']]
         == [130, 12, 1, 100, 500, 7, 2, 0, 20, 5400] and memory.get('recallQueriesPerCycle') == [1, 1] and
         memory.get('batchDelete') == BATCH_DELETE_SPEC, 'MEMORY_FIXTURE_CONTRACT_CHANGED')
    recalls = [report.get('memoryRecall') for report in reports]
    match_keys = ['requestScopeMatches', 'requestGenerationMatches', 'managementIdOrderMatches',
                  'managementStateMatches', 'managementFeedbackMatches', 'filterMatches', 'cursorMatches',
                  'hasMoreMatches', 'draftsMatch', 'messageIdsMatch', 'notPersistedMatches', 'plainReadonlyMatches',
                  'noRecordActions', 'invalidatedReadMatches', 'finalSurfacesClosedMatch']
    for index, recall in enumerate(recalls):
        need(isinstance(recall, dict) and recall.get('passed') is True and recall.get('stage') == index + 1 and
             recall.get('contentCollected') is False and numeric(recall.get('elapsedMs')) and
             0 <= recall['elapsedMs'] < 20000 and
             [row.get('name') for row in recall.get('checks', [])] == gui['recallChecksByCycle'][index],
             'RECALL_STAGE_OR_CHECKS_CHANGED:' + str(index + 1))
        observed = recall.get('observed')
        need(isinstance(observed, dict) and all(observed.get(key) is True for key in match_keys) and
             [observed.get(key) for key in ['queryDispatchCount', 'queryResponseCount', 'switchCommandCount',
              'clearCommandCount', 'finalTabIndex', 'managementCount']] == [1, 1, 0, 0, 0, [130, 100][index]],
             'RECALL_OWN_REQUEST_OR_UNCHANGED_STATE_MISSING')
        need(observed.get('mode') == 'lexical_fallback' and observed.get('reason') in gui['allowedReasons'] and
             observed.get('resultStrings') is True and observed.get('markerMatches') is True and
             integer(observed.get('resultCount')) and 1 <= observed['resultCount'] <= 20 and
             integer(observed.get('resultCharacters')) and 1 <= observed['resultCharacters'] <= 5400 and
             (observed.get('indexPending') is None or
              (integer(observed['indexPending']) and observed['indexPending'] >= 0)), 'RECALL_RESULT_METADATA_INVALID')
    need([recalls[0]['observed'].get(key) for key in ['narrowTabCount', 'narrowTabLabelsMatch', 'narrowResultBoundsMatch']]
         == [5, True, True], 'RECALL_NARROW_LAYOUT_CHANGED')
    recall_ids = [recall['observed'].get('requestId') for recall in recalls]
    need(all(isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9_-]{8,128}', value) for value in recall_ids) and
         len(set(recall_ids)) == 2, 'RECALL_REQUEST_IDENTITIES_NOT_NEW')
    events = memory.get('events')
    need(isinstance(events, list) and all(isinstance(event, dict) for event in events), 'MEMORY_METADATA_EVENTS_MISSING')
    need([event.get('cycle') for event in events if event.get('event') == 'bootstrap_started'] == [1, 2],
         'MEMORY_BOOTSTRAP_CYCLES_CHANGED')
    seeded = [event for event in events if event.get('event') == 'memories_seeded']
    need([[event.get(key) for key in ['cycle', 'confirmed', 'marked', 'pending', 'strictly_increasing']]
          for event in seeded] == [[1, 130, 12, 1, True]], 'MEMORY_SEED_CONTRACT_CHANGED')
    need(not any(event.get('event') == 'candidate_paging_seeded' for event in events), 'CANDIDATE_PAGING_USED')
    dispatches = [event for event in events if event.get('event') == 'recall_query_dispatched']
    responses = [event for event in events if event.get('event') == 'recall_query_result']
    common = {'schema', 'event', 'cycle', 'monotonic_ns', 'stage', 'requestId', 'scopeMatches'}
    need(len(dispatches) == len(responses) == 2 and
         all(set(event) == common | {'queryCharacters', 'markerMatches'} for event in dispatches) and
         all(set(event) == common | {'resultStrings', 'resultCount', 'resultCharacters', 'markerMatches',
                                     'mode', 'reason', 'indexPending'} for event in responses),
         'RECALL_METADATA_SHAPE_OR_COUNTS_CHANGED')
    need([[event.get(key) for key in ['cycle', 'stage', 'queryCharacters', 'markerMatches', 'scopeMatches', 'requestId']]
          for event in dispatches] == [[1, 1, 4, True, True, recall_ids[0]], [2, 2, 4, True, True, recall_ids[1]]],
         'RECALL_LOCAL_DISPATCH_IDENTITY_CHANGED')
    for index, response in enumerate(responses):
        observed = recalls[index]['observed']
        need([response.get(key) for key in ['cycle', 'stage', 'requestId']] == [index + 1, index + 1, recall_ids[index]] and
             [response.get(key) for key in ['resultStrings', 'resultCount', 'resultCharacters', 'markerMatches',
              'mode', 'reason', 'indexPending', 'scopeMatches']] ==
             [True, observed['resultCount'], observed['resultCharacters'], True, observed['mode'], observed['reason'],
              observed['indexPending'], True], 'RECALL_RESPONSE_DIFFERS_FROM_ACTUAL_DISPATCHER_RESULT')
    message_ids = [[row.get('id') for row in report.get('messages', [])] for report in reports]
    need([len(ids) for ids in message_ids] == [39, 39] and message_ids[0] == message_ids[1] and
         all(string(value) for value in message_ids[0]) and len(set(message_ids[0])) == 39,
         'RESTART_CHANGED_MESSAGE_IDENTITIES')
    acquisitions = verify_memory_actions_for_contract(reports[0]['archiveInteraction'], reg)
    verify_memory_feedback_for_contract(acquisitions, reg)
    return {'checkCountsByCycle': counts, 'requests': result['requests'], 'modelCallKinds': kinds,
            'localQueryRequests': len(dispatches), 'memoryActionAcquisition': acquisitions,
            'memoryRecallChecks': recalls, 'messageIdsAcrossRestartEqual': True,
            'messageCount': len(message_ids[0]), 'memoryFixture': memory}

def verify_memory_batch_delete(result, reg, summary):
    need(reg.get('batchDeleteDiagnostics') == BATCH_DELETE_DIAGNOSTIC_SPEC, 'BATCH_REGISTERED_DIAGNOSTICS_CHANGED')
    reports = result['reports']
    batch = reports[0].get('memoryBatchDelete')
    need('memoryBatchDelete' not in reports[1], 'BATCH_REPEATED_AFTER_RESTART')
    need(isinstance(batch, dict) and set(batch) == {'passed', 'error', 'step', 'checks', 'observed', 'inputs',
         'inputCurrent', 'elapsedMs', 'deadlineMs', 'contentCollected'} and batch['passed'] is True and
         batch['error'] == '' and batch['step'] == 19 and batch['contentCollected'] is False and
         batch['deadlineMs'] == 30000 and numeric(batch['elapsedMs']) and 0 <= batch['elapsedMs'] < 30000,
         'BATCH_TERMINAL_SHAPE_OR_DEADLINE')
    need([row.get('name') for row in batch['checks']] == BATCH_DELETE_DIAGNOSTIC_SPEC['checks'] and
         all(isinstance(row, dict) and set(row) == {'name', 'passed'} and row['passed'] is True
             for row in batch['checks']), 'BATCH_CHECK_IDENTITIES_CHANGED')
    observed = batch['observed']
    need(isinstance(observed, dict) and set(observed) == set(BATCH_DELETE_DIAGNOSTIC_SPEC['observedKeys']),
         'BATCH_OBSERVED_SHAPE_CHANGED')
    original = reports[0]['memoryPage'].get('observed', {}).get('finalIds')
    deleted = observed['deletedIds']
    def ids(value, size):
        return isinstance(value, list) and len(value) == size and len(set(value)) == size and all(
            isinstance(item, str) and 0 < len(item) <= 180 and not any(part in item for part in ('\n', '\r', 'mc1.'))
            for item in value)
    need(ids(original, 130) and ids(deleted, 3) and all(value in original for value in deleted) and
         observed['baselineIds'] == original, 'BATCH_ORIGINAL_OR_DELETED_IDENTITIES_CHANGED')
    seed_events = [event for event in result['memoryFixture']['events'] if event.get('event') == 'batch_delete_prepared']
    need(len(seed_events) == 1 and set(seed_events[0]) == {'schema', 'event', 'cycle', 'monotonic_ns',
         'targetNumbers', 'targetIds', 'pinnedNumber', 'modelRequests'} and
         [seed_events[0].get(key) for key in ['cycle', 'targetNumbers', 'pinnedNumber', 'modelRequests', 'targetIds']]
         == [1, [130, 129, 127], 130, 0, deleted], 'BATCH_REGISTERED_SEED_TARGETS_CHANGED')
    remaining = [value for value in original if value not in deleted]
    need(ids(remaining, 127) and observed['expectedRemainingIds'] == observed['remainingIds'] == remaining and
         reports[1]['memoryPage'].get('observed', {}).get('restartIds') == remaining,
         'BATCH_AUTHORITATIVE_OR_RESTART_ORDER_CHANGED')
    need(all(integer(observed[key]) for key in ['pinnedCount', 'cancelCommandDelta', 'dispatchDelta', 'responseCount']) and
         [observed[key] for key in ['pinnedCount', 'cancelCommandDelta', 'dispatchDelta', 'responseCount']] == [1, 0, 1, 1] and
         observed['responseOk'] is True and observed['responseIdsMatch'] is True and observed['terminalStatus'] == 'success',
         'BATCH_CANCEL_OR_ONE_OWN_WRITE_CHANGED')
    request_id, response_id, read_id = [observed[key] for key in ['requestId', 'responseId', 'readRequestId']]
    need(all(isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9_-]{8,128}', value)
             for value in [request_id, response_id, read_id]) and request_id == response_id and read_id != request_id,
         'BATCH_RESPONSE_OR_FOLLOWING_READ_NOT_BOUND')
    inputs = batch['inputs']
    need(isinstance(inputs, list) and len(inputs) == 15 and
         [entry.get('step') for entry in inputs] == BATCH_DELETE_DIAGNOSTIC_SPEC['inputSteps'],
         'BATCH_INPUT_COUNT_OR_STEP_ORDER_CHANGED')
    scopes = set()
    for index, entry in enumerate(inputs):
        need(isinstance(entry, dict) and set(entry) == set(BATCH_DELETE_DIAGNOSTIC_SPEC['inputKeys']), 'BATCH_INPUT_SHAPE')
        step = entry['step']
        selected = step in [7, 8, 9]
        target_id = deleted[step - 7] if selected else ''
        control = 'memorySelect' + str(original.index(target_id)) if selected else BATCH_DELETE_DIAGNOSTIC_SPEC['inputControls'][index]
        need(entry['id'] == target_id and entry['control'] == control, 'BATCH_INPUT_NOT_BOUND_TO_SELECTED_ID')
        signals = entry['signals']
        expected_kind = 'switch' if selected else 'tab' if step == 21 else 'button'
        need(isinstance(signals, dict) and set(signals) == set(BATCH_DELETE_DIAGNOSTIC_SPEC['signalKeys']) and
             signals['controlKind'] == expected_kind and signals['observerValid'] is True and
             integer(signals['mouseDispatchCount']) and signals['mouseDispatchCount'] == 1 and
             signals['contractReason'] == '' and integer(signals['clickedSignals']) and
             (signals['toggledSignals'] is None or (integer(signals['toggledSignals']) and signals['toggledSignals'] >= 0)),
             'BATCH_INPUT_OBSERVER_OR_SIGNAL_MEASUREMENT')
        need((signals['toggledSignals'] == 1 and signals['clickedSignals'] in (0, 1)) if selected else
             signals['clickedSignals'] == 1, 'BATCH_INPUT_SIGNAL_CONTRACT_FAILED')
        layout = entry['layout']
        need(isinstance(layout, dict) and set(layout) == {'ready', 'polls', 'resets', 'minimumStableMs', 'last'} and
             layout['ready'] is True and layout['minimumStableMs'] == 40 and
             all(integer(layout[key]) and layout[key] >= 0 for key in ['polls', 'resets']) and layout['polls'] >= 2,
             'BATCH_LAYOUT_GATE_MISSING')
        stable = layout['last']
        need(isinstance(stable, dict) and set(stable) == SUMMARY_STABLE_KEYS and
             isinstance(stable['scope'], str) and 0 < len(stable['scope']) <= 180 and
             all(stable[key] is True for key in ['bound', 'geometryValid', 'integerPointInsideClip', 'ready', 'found',
                 'enabled', 'visible', 'inputPointInsideClip', 'surfaceClosed', 'layoutStable']) and stable['reason'] == 'ready',
             'BATCH_INPUT_GEOMETRY_OR_STABILITY_QUALIFICATION')
        scopes.add(stable['scope'])
        need(all(numeric(stable[key]) for key in ['pointX', 'pointY', 'clipCount', 'scrollCount', 'visibleWidth',
             'visibleHeight', 'sceneX', 'sceneY', 'sceneWidth', 'sceneHeight', 'clipX', 'clipY', 'clipWidth', 'clipHeight',
             'elapsedMs', 'frameSerial', 'stableSinceMs', 'stableFrameSerial']) and
             all(integer(stable[key]) for key in ['pointX', 'pointY', 'clipCount', 'scrollCount', 'elapsedMs',
                                                  'frameSerial', 'stableSinceMs', 'stableFrameSerial']) and
             0 <= stable['stableSinceMs'] <= stable['elapsedMs'] < 4000 and
             stable['elapsedMs'] - stable['stableSinceMs'] >= 40 and
             0 <= stable['stableFrameSerial'] < stable['frameSerial'] and
             all(stable[key] > 0 for key in ['visibleWidth', 'visibleHeight', 'sceneWidth', 'sceneHeight', 'clipWidth', 'clipHeight']),
             'BATCH_INPUT_FRAME_OR_ORIGINAL_DEADLINE')
        need(stable['sceneX'] <= stable['pointX'] <= stable['sceneX'] + stable['sceneWidth'] and
             stable['sceneY'] <= stable['pointY'] <= stable['sceneY'] + stable['sceneHeight'] and
             stable['clipX'] <= stable['pointX'] <= stable['clipX'] + stable['clipWidth'] and
             stable['clipY'] <= stable['pointY'] <= stable['clipY'] + stable['clipHeight'], 'BATCH_INTEGER_POINT_OUTSIDE_CLIP')
        scrolls = stable['scrolls']
        need(isinstance(scrolls, list) and 0 <= stable['scrollCount'] and 0 <= stable['clipCount'] and
             len(scrolls) <= min(6, stable['scrollCount']), 'BATCH_SCROLL_OBSERVATION_BOUND')
        for scroll in scrolls:
            need(isinstance(scroll, dict) and set(scroll) == {'contentY', 'contentHeight', 'sceneX', 'sceneY', 'sceneWidth', 'sceneHeight'} and
                 all(numeric(value) for value in scroll.values()) and scroll['contentHeight'] >= 0, 'BATCH_SCROLL_SHAPE')
        hit = entry['hit']
        need(isinstance(hit, dict) and set(hit) == {'hitResult', 'acceptorFound', 'acceptorName', 'acceptorClass',
             'containing', 'containingCount', 'passiveObservers', 'passiveObserverCount', 'containingLimit'} and
             hit['hitResult'] in ('target', 'descendant') and hit['acceptorFound'] is True and
             isinstance(hit['acceptorName'], str) and len(hit['acceptorName']) <= 80 and
             string(hit['acceptorClass']) and len(hit['acceptorClass']) <= 80 and hit['containingLimit'] == 6,
             'BATCH_ACTUAL_HIT_NOT_TARGET_OR_DESCENDANT')
        if hit['hitResult'] == 'target':
            need(hit['acceptorName'] == control, 'BATCH_HIT_TARGET_IDENTITY_CHANGED')
        for list_key, count_key in [('containing', 'containingCount'), ('passiveObservers', 'passiveObserverCount')]:
            collection = hit[list_key]
            need(integer(hit[count_key]) and hit[count_key] >= 0 and isinstance(collection, list) and
                 len(collection) == min(6, hit[count_key]), 'BATCH_HIT_OBSERVATION_BOUND')
            for identity in collection:
                need(isinstance(identity, dict) and set(identity) == {'found', 'objectName', 'className'} and
                     identity['found'] is True and all(isinstance(identity[key], str) and len(identity[key]) <= 80
                     for key in ['objectName', 'className']), 'BATCH_HIT_IDENTITY_SHAPE')
    need(len(scopes) == 1, 'BATCH_INPUT_SCOPE_CHANGED')
    current = batch['inputCurrent']
    need(current == {'polls': 0, 'actionIndex': 0, 'performed': False, 'expired': False, 'failed': False, 'busy': False,
         'actions': [], 'sampleLimit': 6, 'scrollLimit': 6, 'actionLimit': 6, 'pollIntervalMs': 100},
         'BATCH_POST_INPUT_GATE_NOT_RESET')
    labels = observed['labelContrast']
    need(isinstance(labels, list) and len(labels) == 2, 'BATCH_TWO_RENDERED_LABELS_MISSING')
    for index, label in enumerate(labels):
        need(isinstance(label, dict) and set(label) == set(BATCH_DELETE_DIAGNOSTIC_SPEC['contrastKeys']), 'BATCH_CONTRAST_SCHEMA')
        identity = label['label']
        need(isinstance(identity, dict) and set(identity) == set(BATCH_DELETE_DIAGNOSTIC_SPEC['labelKeys']) and
             identity['found'] is True and identity['objectName'] == BATCH_DELETE_DIAGNOSTIC_SPEC['labelControls'][index] and
             string(identity['className']), 'BATCH_RENDERED_LABEL_IDENTITY')
        need(all(numeric(label[key]) for key in ['sceneX', 'sceneY', 'sceneWidth', 'sceneHeight']) and
             label['sceneWidth'] > 0 and label['sceneHeight'] > 0 and integer(label['pixelCount']) and label['pixelCount'] > 0 and
             all(isinstance(label[key], str) and re.fullmatch(r'#[0-9a-fA-F]{6}', label[key]) for key in ['background', 'glyph']) and
             numeric(label['contrast']) and 4.5 <= label['contrast'] <= 21, 'BATCH_RENDERED_CONTRAST_LOW_OR_UNMEASURED')
    capture = summary.parent / BATCH_DELETE_DIAGNOSTIC_SPEC['screenshot']
    need(capture.is_file(), 'BATCH_CONFIRMATION_SCREENSHOT_MISSING')
    png = capture.read_bytes()
    need(png.startswith(b'\x89PNG\r\n\x1a\n') and len(png) > 24 and
         int.from_bytes(png[16:20], 'big') > 0 and int.from_bytes(png[20:24], 'big') > 0,
         'BATCH_CONFIRMATION_SCREENSHOT_INVALID')
    return {'checks': batch['checks'], 'deadlineMs': 30000, 'elapsedMs': batch['elapsedMs'],
            'baselineIds': original, 'deletedIds': deleted, 'remainingIds': remaining, 'remainingCount': len(remaining),
            'restartOrderMatches': True, 'inputs': inputs, 'inputCount': len(inputs),
            'mouseDispatchCount': sum(entry['signals']['mouseDispatchCount'] for entry in inputs),
            'requestId': request_id, 'responseId': response_id, 'readRequestId': read_id,
            'dispatchDelta': observed['dispatchDelta'], 'responseCount': observed['responseCount'],
            'cancelCommandDelta': observed['cancelCommandDelta'], 'pinnedCount': observed['pinnedCount'],
            'renderedLabels': labels, 'minimumObservedContrast': min(label['contrast'] for label in labels),
            'screenshot': {'path': str(capture.relative_to(ROOT)), 'sha256': sha(capture), 'bytes': len(png)},
            'contentCollected': False}

def verify_pin(result, reg, summary, roots_before):
    need(reg['pinContract'] == PIN_CONTRACT, 'REGISTERED_PIN_CONTRACT_CHANGED')
    code = ("const fs=require('node:fs'),assert=require('node:assert/strict');"
            "const m=require(process.argv[1]),s=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));"
            "assert.deepEqual(m.MEMORY_BATCH_PIN_CONTRACT,JSON.parse(process.argv[3]));"
            "const p=m.verifyMemoryBatchPin(s);assert.deepEqual(s.memoryBatchPinEvidence,p);"
            "process.stdout.write(JSON.stringify(p));")
    completed = subprocess.run([str(ROOT / reg['node']), '-e', code,
        str(ROOT / 'native-ui/memory-batch-pin-verdicts.cjs'), str(summary), json.dumps(PIN_CONTRACT)],
        cwd=ROOT, capture_output=True, text=True, timeout=30, check=True)
    proof = json.loads(completed.stdout)
    need(proof.get('passed') is True and result.get('memoryBatchPinEvidence') == proof, 'PIN_PROOF_CHANGED')
    report_root = summary.parent
    need(report_root.parent == ROOT / '.tools/reports' and report_root.name.startswith('qt-') and
         str(report_root) not in roots_before and report_root.is_dir() and not report_root.is_symlink(),
         'PIN_SCREENSHOT_REPORT_ROOT_NOT_NEW')
    need(reg.get('pinScreenshots') == PIN_SCREENSHOTS and
         sorted(path.name for path in report_root.glob('cycle-1.json.memory-batch-pin-*.png')) == sorted(PIN_SCREENSHOTS),
         'PIN_SCREENSHOT_SET_CHANGED')
    screenshots = []
    for name in PIN_SCREENSHOTS:
        capture = report_root / name
        need(capture.is_file() and not capture.is_symlink() and capture.resolve().parent == report_root.resolve(),
             'PIN_SCREENSHOT_MISSING_OR_OUTSIDE_REPORT')
        png = capture.read_bytes()
        width, height = int.from_bytes(png[16:20], 'big'), int.from_bytes(png[20:24], 'big')
        need(png.startswith(b'\x89PNG\r\n\x1a\n') and len(png) > 24 and png[12:16] == b'IHDR' and width > 0 and height > 0,
             'PIN_SCREENSHOT_INVALID')
        screenshots.append({'path': str(capture.relative_to(ROOT)), 'sha256': sha(capture),
                            'bytes': len(png), 'width': width, 'height': height})
    return {**proof, 'screenshots': screenshots}

def verify_reply_start(result, reg):
    # The registered first-cycle turns start without a presence wait; the
    # override records the production decision it replaced. Selected by name.
    spec = reg['replyStartFixture']
    need(spec == REPLY_START_SPEC, 'REPLY_START_CONTRACT_CHANGED')
    events = (result.get('memoryFixture') or {}).get('events')
    need(isinstance(events, list) and all(isinstance(event, dict) for event in events), 'MEMORY_METADATA_EVENTS_MISSING')
    overrides = [event for event in events if event.get('event') == 'reply_start_fixture_override']
    planned = [event for event in events if event.get('event') == 'reply_start_planned']
    need(all(set(event) == set(spec['overrideKeys']) for event in overrides), 'REPLY_START_OVERRIDE_FIELDS_CHANGED')
    need([[event.get(key) for key in ['cycle', 'stage', 'repeated', 'fixtureOverride', 'appliedDelayMs',
                                      'productionPlanned']] for event in overrides] == spec['expectedOverrides'],
         'REPLY_START_OVERRIDES_CHANGED')
    need([[event.get(key) for key in ['cycle', 'planned', 'startDelayMs', 'immediate', 'reason', 'textCharacters']]
          for event in planned] == spec['expectedPlans'], 'REPLY_START_APPLIED_PLANS_CHANGED')
    production = [{'stage': event['stage'], 'startDelayMs': event['productionStartDelayMs'],
                   'immediate': event['productionImmediate'], 'probability': event['productionProbability'],
                   'status': event['productionStatus'], 'reason': event['productionReason']} for event in overrides]
    return {'overrides': len(overrides), 'appliedPlans': len(planned), 'appliedReason': spec['reason'],
            'production': production,
            'productionWouldDefer': sum(1 for row in production if row['immediate'] is not True)}
