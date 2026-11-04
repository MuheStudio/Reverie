"""Host checks extracted from the passed formal r1 runner.

Function bodies retain their original comparisons and order. Invoke through an
explicit RunContext: its private namespace supplies paths and frozen contracts.
This module never imports or executes a historical report runner.
"""

def verify_feedback_probe_diagnostics(transcript, reg):
    spec = reg['memoryFeedbackProbeDiagnostics']
    need(spec['expectedOperationsByCase'] == EXPECTED_PROBE_OPERATIONS, 'MEMORY_FEEDBACK_PROBE_REGISTRATION_IDENTITY_CHANGED')
    def whole(value):
        return type(value) in (int, float) and math.isfinite(value) and value == int(value)
    def unique(pairs):
        out = {}
        for key, value in pairs:
            need(key not in out, 'MEMORY_FEEDBACK_PROBE_DUPLICATE_KEY'); out[key] = value
        return out
    def text_value(value, maximum=180):
        return isinstance(value, str) and len(value) <= maximum and '\n' not in value and '\r' not in value and 'mc1.' not in value
    def attached_shape(value):
        need(isinstance(value, dict) and set(value) == PROBE_ATTACHED_KEYS, 'MEMORY_FEEDBACK_PROBE_ATTACHED_SHAPE')
        special = {'rolePath','roleTypeId','roleTypeName','roleValue','nameTypeId','nameTypeName','nameLength'}
        need(all(type(value[key]) is bool for key in PROBE_ATTACHED_KEYS - special), 'MEMORY_FEEDBACK_PROBE_ATTACHED_BOOLEAN')
        need(value['rolePath'] in {'Accessible.role','fixed-missing'} and text_value(value['roleTypeName'],80) and
             text_value(value['nameTypeName'],80) and value['fallbackUsed'] is False, 'MEMORY_FEEDBACK_PROBE_ATTACHED_SOURCE_OR_FALLBACK')
        for flag, key in [('roleValueValid','roleTypeId'),('nameValueValid','nameTypeId'),('roleMeasured','roleValue'),('nameMeasured','nameLength')]:
            need(whole(value[key]) if value[flag] else value[key] is None, 'MEMORY_FEEDBACK_PROBE_UNMEASURED_NOT_NULL:' + key)
        need(not value['nameMeasured'] or value['nameLength'] >= 0, 'MEMORY_FEEDBACK_PROBE_NAME_LENGTH')
    def stable(row, armed):
        need(row['prepareAttempted'] is True and row['leafForceCount'] == 1 and row['armed'] is armed and
             row['stableObservations'] >= 2 and row['stableSinceMs'] >= 0 and row['postedAfterFrame'] is True and
             row['windowFocusMatches'] is True and row['windowActive'] is True and row['owner']['present'] is True and
             row['owner']['matchesLeaf'] is True and row['owner']['region'] == 'sentinel-leaf', 'MEMORY_FEEDBACK_PROBE_BASELINE_NOT_READY')
        measured = row['armedAtMs'] if armed else row['elapsedMs']
        frame = row['armedFrame'] if armed else row['frameSerial']
        need(measured - row['stableSinceMs'] >= 40 and frame > row['stableFrame'], 'MEMORY_FEEDBACK_PROBE_BASELINE_NOT_STABLE_ACROSS_FRAME')
    groups = {}
    scalar = {'schema','case','dataTag','operation','kind','event','stage','reason'}
    booleans = {'windowFocusMatches','windowActive','prepareAttempted','armed','postedAfterFrame','rejected'}
    nested = {'owner','attached','ownerChanged'}
    events = {'activation','focus-item','window-active','focus-window','baseline-forced','baseline-stable','armed','attached','focus-check','terminal'}
    regions = {'none','sentinel-leaf','sentinel-other','sentinel-scope','task-panel','window-content','window-other'}
    for line in transcript.splitlines():
        marker = ' MEMORY_FEEDBACK_PROBE '
        if marker not in line: continue
        prefix, encoded = line.split(marker, 1); need('::' in prefix, 'MEMORY_FEEDBACK_PROBE_CASE_MISSING')
        case = prefix.split('::',1)[1].strip()
        need(case in EXPECTED_PROBE_OPERATIONS, 'MEMORY_FEEDBACK_PROBE_UNREGISTERED_CASE')
        value = json.loads(encoded, object_pairs_hook=unique, parse_constant=lambda x: (_ for _ in ()).throw(ValueError('NONFINITE_PROBE_JSON')))
        need(isinstance(value,dict) and value.get('kind') in {'process','terminal'}, 'MEMORY_FEEDBACK_PROBE_KIND')
        terminal = value['kind'] == 'terminal'
        need(set(value) == PROBE_TOP_KEYS | ({'outcome'} if terminal else set()), 'MEMORY_FEEDBACK_PROBE_TOP_SHAPE')
        need(value['schema'] == 'reverie.qt.memory-feedback-probe.v1' and
             all(text_value(value[key]) for key in scalar) and all(type(value[key]) is bool for key in booleans), 'MEMORY_FEEDBACK_PROBE_SCALAR_SHAPE')
        stem, tag = case.split('(',1)
        need(value['case'] == stem and value['dataTag'] == tag[:-1] and value['operation'] in EXPECTED_PROBE_OPERATIONS[case], 'MEMORY_FEEDBACK_PROBE_CASE_OR_OPERATION_IDENTITY')
        need(value['event'] in events and value['stage'] in {'preparation','armed'} and
             (type(value['ownerChanged']) is bool if value['event']=='focus-item' else value['ownerChanged'] is None), 'MEMORY_FEEDBACK_PROBE_EVENT_SHAPE')
        numeric = PROBE_TOP_KEYS - scalar - booleans - nested
        need(all(whole(value[key]) for key in numeric) and all(value[key] >= 0 for key in numeric - {'stableSinceMs','armedAtMs'}), 'MEMORY_FEEDBACK_PROBE_COUNTER_OR_CLOCK')
        owner = value['owner']
        need(isinstance(owner,dict) and set(owner)==PROBE_OWNER_KEYS and type(owner['present']) is bool and type(owner['matchesLeaf']) is bool and
             text_value(owner['name'],80) and text_value(owner['class'],80) and owner['region'] in regions, 'MEMORY_FEEDBACK_PROBE_OWNER_SHAPE')
        attached_shape(value['attached'])
        need(value['totalFocusEvents'] == value['preparationFocusEvents'] + value['armedFocusEvents'] and
             value['armedOwnerChanges'] <= value['armedFocusEvents'], 'MEMORY_FEEDBACK_PROBE_FOCUS_COUNTERS')
        if terminal: need(value['outcome']=='body-passed', 'MEMORY_FEEDBACK_PROBE_QTEST_BODY_FAILED')
        groups.setdefault((case,value['operation']),[]).append(value)
    expected={(case,operation) for case,operations in EXPECTED_PROBE_OPERATIONS.items() for operation in operations}
    need(set(groups)==expected and len(groups)==22, 'MEMORY_FEEDBACK_PROBE_GROUP_IDENTITIES_CHANGED')
    summary=[]
    for (case, operation), records in groups.items():
        terminal=records[-1]; process=records[:-1]
        need(terminal['kind']=='terminal' and sum(row['kind']=='terminal' for row in records)==1 and
             1 <= len(process) <= 6 and all(row['kind']=='process' for row in process), 'MEMORY_FEEDBACK_PROBE_GROUP_BOUNDS')
        ordinals=[row['eventOrdinal'] for row in process]
        need(ordinals==sorted(set(ordinals)) and ordinals[0]>=1 and terminal['event']=='terminal' and
             terminal['eventOrdinal']==terminal['processObserved']+1 and terminal['eventOrdinal']>ordinals[-1], 'MEMORY_FEEDBACK_PROBE_OBSERVATION_ORDER')
        focus_kept=sum(row['event']=='focus-item' for row in process)
        for row in records:
            need(row['processLimit']==6 and row['processCount']==len(process) and
                 row['processObserved']==terminal['processObserved'] and row['processOverflow']==terminal['processObserved']-len(process) and
                 row['focusRecordOverflow']==terminal['totalFocusEvents']-focus_kept, 'MEMORY_FEEDBACK_PROBE_OVERFLOW_ACCOUNTING')
        baseline=[row for row in process if row['event']=='baseline-stable']; armed=[row for row in process if row['event']=='armed']
        need(len(baseline)==len(armed)==1 and baseline[0]['eventOrdinal']<armed[0]['eventOrdinal'], 'MEMORY_FEEDBACK_PROBE_BASELINE_OR_ARM_MISSING')
        stable(baseline[0],False); stable(armed[0],True)
        need(terminal['armed'] is True and terminal['prepareAttempted'] is True and terminal['leafForceCount']==1 and
             terminal['armedAtMs']-terminal['stableSinceMs']>=40 and terminal['armedFrame']>terminal['stableFrame'] and
             terminal['postedAfterFrame'] is True and terminal['stableObservations']>=2 and
             terminal['elapsedMs']>=terminal['armedAtMs'] and terminal['frameSerial']>=terminal['armedFrame'], 'MEMORY_FEEDBACK_PROBE_TERMINAL_BASELINE_CHANGED')
        retained_changes={row['armedOwnerChanges'] for row in process if row['event']=='focus-item' and row['stage']=='armed' and row['ownerChanged'] is True}
        need(set(range(1,min(3,int(terminal['armedOwnerChanges']))+1)).issubset(retained_changes), 'MEMORY_FEEDBACK_PROBE_FIRST_OWNER_CHANGES_MISSING')
        if operation=='negative-focus':
            need(terminal['rejected'] is True and terminal['armedFocusEvents']>0 and terminal['owner']['present'] is True and
                 terminal['owner']['matchesLeaf'] is False and terminal['owner']['region']=='sentinel-other', 'MEMORY_FEEDBACK_PROBE_NEGATIVE_FOCUS_NOT_REJECTED')
        else:
            stable(terminal,True)
            need(terminal['rejected'] is False and terminal['armedFocusEvents']==0 and terminal['armedWindowEvents']==0,
                 'MEMORY_FEEDBACK_PROBE_ARMED_FOCUS_OR_WINDOW_EVENT')
        attached=terminal['attached']
        if operation.startswith('display-'):
            required={'attempted','contextPresent','contextValid','engineMatches','rolePropertyValid','roleIsProperty','roleValueValid','roleTypeValid',
                      'roleConversionOk','roleMeasured','namePropertyValid','nameIsProperty','nameValueValid','nameIsQString','nameMeasured','nameMatches','valid'}
            need(all(attached[key] is True for key in required) and attached['rolePath']=='Accessible.role' and attached['roleValue']==41 and
                 attached['fallbackUsed'] is False, 'MEMORY_FEEDBACK_PROBE_DISPLAY_ATTACHED_NOT_VALID')
        elif operation=='negative-attached':
            need(all(attached[key] is True for key in ['attempted','contextPresent','contextValid','engineMatches']) and
                 all(attached[key] is False for key in ['rolePropertyValid','roleIsProperty','roleValueValid','roleTypeValid','roleConversionOk','roleMeasured','valid','fallbackUsed']) and
                 attached['rolePath']=='fixed-missing' and attached['roleTypeId'] is None and attached['roleValue'] is None,
                 'MEMORY_FEEDBACK_PROBE_NEGATIVE_ATTACHED_NOT_REJECTED')
        summary.append({'case':case,'operation':operation,'processRecords':len(process),'terminalRecords':1,'outcome':terminal['outcome'],
                        'expectedNegative':operation.startswith('negative-'),'rejected':terminal['rejected'],'armedFocusEvents':terminal['armedFocusEvents'],
                        'armedWindowEvents':terminal['armedWindowEvents'],'attachedValid':attached['valid']})
    return summary
