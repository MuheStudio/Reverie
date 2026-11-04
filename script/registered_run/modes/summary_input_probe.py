"""Host checks extracted from the passed formal r1 runner.

Function bodies retain their original comparisons and order. Invoke through an
explicit RunContext: its private namespace supplies paths and frozen contracts.
This module never imports or executes a historical report runner.
"""

def verify_summary_input_probe_diagnostics(transcript, reg):
    spec = SUMMARY_INPUT_PROBE_SPEC
    need(reg['summaryInputProbeDiagnostics'] == spec, 'SUMMARY_INPUT_REGISTERED_CONTRACT_CHANGED')
    def whole(value):
        return type(value) in (int,float) and math.isfinite(value) and value == int(value)
    def count(value):
        return whole(value) and value >= 0
    def text(value, empty=True):
        return isinstance(value,str) and (empty or bool(value)) and len(value) <= 180 and not any(s in value for s in ['\n','\r','mc1.'])
    def pairs(values):
        out = {}
        for key,value in values:
            need(key not in out,'SUMMARY_INPUT_DUPLICATE_JSON_KEY');out[key] = value
        return out
    signal_counts = ['clickedSignals','toggledSignals','canceledSignals','pressedSignals','releasedSignals','checkedChangedSignals','enabledChangedSignals']
    signal_flags = set(spec['signalKeys']) - set(signal_counts) - {'phase','inputFailure','mouseDispatchCount','checkedBefore','enabledBefore','checkedAfter','enabledAfter'}
    receipt_keys = set('armed scope generation expected oldSaveId oldReadId saveId readId newSaveCount newReadCount saveSuccess readSuccess complete failed failureReason status observations'.split())
    layout_flags = set('bound geometryValid integerPointInsideClip ready found enabled visible inputPointInsideClip surfaceClosed layoutStable'.split())
    layout_numbers = set('pointX pointY clipCount scrollCount visibleWidth visibleHeight sceneX sceneY sceneWidth sceneHeight clipX clipY clipWidth clipHeight elapsedMs frameSerial stableSinceMs stableFrameSerial'.split())
    def signal_shape(signal):
        need(isinstance(signal,dict) and set(signal)==set(spec['signalKeys']),'SUMMARY_INPUT_SIGNAL_SHAPE')
        need(all(type(signal[k]) is bool for k in signal_flags) and text(signal['inputFailure']) and
             signal['phase'] in {'','before-input','after-input','save-readback','terminal'},'SUMMARY_INPUT_SIGNAL_SCALARS')
        for key in signal_counts:
            valid = key[:-7] + 'ObserverValid'
            need(count(signal[key]) if signal[valid] else signal[key] is None,'SUMMARY_INPUT_SIGNAL_UNMEASURED_NOT_NULL:'+key)
        need(count(signal['mouseDispatchCount']) if signal['armed'] else signal['mouseDispatchCount'] is None,'SUMMARY_INPUT_MOUSE_MEASUREMENT')
        need(all(signal[k] is None or type(signal[k]) is bool for k in ['checkedBefore','enabledBefore','checkedAfter','enabledAfter']),'SUMMARY_INPUT_CHECKED_ENABLED_TYPE')
        if signal['mouseDispatchCount'] == 0:
            need(signal['checkedAfter'] is None and signal['enabledAfter'] is None,'SUMMARY_INPUT_PRE_MOUSE_AFTER_NOT_NULL')
    def request_shape(request):
        need(isinstance(request,dict) and set(request)==set(spec['requestKeys']) and
             request['source']=='renderer-command-delta' and type(request['observerArmed']) is bool and
             text(request['scope'],False) and count(request['generation']),'SUMMARY_INPUT_REQUEST_SHAPE')
        for key in ['rendererSettingsDelta','rendererReadDelta']:
            need(count(request[key]),'SUMMARY_INPUT_RENDERER_DELTA_TYPE')
        for key in ['saveRequestId','readRequestId']:
            need(text(request[key]),'SUMMARY_INPUT_REQUEST_ID_TYPE')
        need(request['sourceSaveId'] is None or text(request['sourceSaveId']),'SUMMARY_INPUT_SOURCE_SAVE_ID_TYPE')
        need(request['expected'] is None or type(request['expected']) is bool,'SUMMARY_INPUT_REQUEST_EXPECTED_TYPE')
        for key in ['observedSaveRequestCount','observedReadRequestCount','saveResponses','readResponses']:
            need(count(request[key]) if request['observerArmed'] else request[key] is None,'SUMMARY_INPUT_REQUEST_UNMEASURED_NOT_NULL:'+key)
        for key in ['saveIdentityMatches','payloadMatches','savePending']:
            need(type(request[key]) is bool if request['observerArmed'] else request[key] is None,'SUMMARY_INPUT_REQUEST_BOOLEAN_MEASUREMENT:'+key)
    def receipt_shape(receipt):
        need(isinstance(receipt,dict) and set(receipt)==receipt_keys,'SUMMARY_INPUT_RECEIPT_SHAPE')
        need(all(type(receipt[k]) is bool for k in ['armed','expected','saveSuccess','readSuccess','complete','failed']) and
             all(text(receipt[k]) for k in ['scope','oldSaveId','oldReadId','saveId','readId','failureReason','status']) and
             whole(receipt['generation']) and receipt['generation']>=-1 and
             all(count(receipt[k]) for k in ['newSaveCount','newReadCount','observations']),'SUMMARY_INPUT_RECEIPT_SCALARS')
    def layout_shape(layout):
        need(isinstance(layout,dict) and set(layout)=={'ready','polls','resets','minimumStableMs','last'} and
             type(layout['ready']) is bool and layout['minimumStableMs']==40 and count(layout['polls']) and count(layout['resets']),'SUMMARY_INPUT_LAYOUT_SHAPE')
        last = layout['last'];need(isinstance(last,dict) and set(last).issubset(layout_flags|layout_numbers|{'scope','reason','scrolls'}),'SUMMARY_INPUT_LAYOUT_LAST_SHAPE')
        for key,value in last.items():
            if key in layout_flags:need(type(value) is bool,'SUMMARY_INPUT_LAYOUT_BOOLEAN')
            elif key in layout_numbers:need((key=='stableFrameSerial' and value is None) or (type(value) in (int,float) and math.isfinite(value)),'SUMMARY_INPUT_LAYOUT_NUMBER')
            elif key in {'scope','reason'}:need(text(value),'SUMMARY_INPUT_LAYOUT_IDENTITY')
            else:
                need(isinstance(value,list) and len(value)<=6,'SUMMARY_INPUT_LAYOUT_SCROLL_BOUND')
                for row in value:
                    need(isinstance(row,dict) and set(row)=={'contentY','contentHeight','sceneX','sceneY','sceneWidth','sceneHeight'} and
                         all(type(v) in (int,float) and math.isfinite(v) for v in row.values()),'SUMMARY_INPUT_LAYOUT_SCROLL_SHAPE')
    def state_shape(state):
        need(isinstance(state,dict) and set(state).issubset(spec['stateKeys']) and 'signalProbe' in state,'SUMMARY_INPUT_STATE_SHAPE')
        signal_shape(state['signalProbe'])
        for key in ['phase','control','scope','failureReason']:
            if key in state:need(text(state[key]),'SUMMARY_INPUT_STATE_TEXT')
        for key in ['generation','requestCountDelta']:
            if key in state:need(count(state[key]),'SUMMARY_INPUT_STATE_COUNT')
        for key in ['elapsedMs','clickAtMs','readbackRemainingMs']:
            if key in state:need(state[key] is None or count(state[key]),'SUMMARY_INPUT_STATE_CLOCK')
        for key in ['selected','inputAccepted','observerHealthy']:
            if key in state:need(type(state[key]) is bool,'SUMMARY_INPUT_STATE_BOOLEAN')
        if 'requestObservation' in state:request_shape(state['requestObservation'])
        if 'receipt' in state:receipt_shape(state['receipt'])
        if 'layout' in state:layout_shape(state['layout'])
    groups = {}
    for line in transcript.splitlines():
        marker = ' SUMMARY_INPUT_PROBE '
        if marker not in line:continue
        prefix,encoded = line.split(marker,1);case = prefix.split('::',1)[1].strip()
        value = json.loads(encoded,object_pairs_hook=pairs,parse_constant=lambda x: (_ for _ in ()).throw(ValueError('NONFINITE_SUMMARY_INPUT_JSON')))
        need(isinstance(value,dict) and set(value)==set(spec['topKeys']) and value['schema']==spec['schemaValue'] and
             case in spec['expectedOperationsByCase'] and value['operation'] in spec['expectedOperationsByCase'][case], 'SUMMARY_INPUT_GROUP_IDENTITY')
        stem,tag = case.split('(',1);operation=value['operation'];control='memoryTab-summary' if operation=='tab' else 'summaryEnabled'
        need(value['case']==stem and value['dataTag']==tag[:-1] and value['control']==control and
             value['kind'] in {'process','terminal'} and value['sampleLimit']==6 and count(value['ordinal']) and count(value['observations']), 'SUMMARY_INPUT_TOP_SCALARS')
        state_shape(value['state']);groups.setdefault((case,operation),[]).append(value)
    expected={(case,operation) for case,operations in spec['expectedOperationsByCase'].items() for operation in operations}
    need(set(groups)==expected and len(groups)==13,'SUMMARY_INPUT_13_GROUP_SET_CHANGED')
    summary=[];terminals={}
    for (case,operation),records in groups.items():
        terminal=records[-1];process=records[:-1];state=terminal['state'];control=terminal['control']
        need(1<=len(process)<=6 and terminal['kind']=='terminal' and sum(v['kind']=='terminal' for v in records)==1 and
             all(v['kind']=='process' for v in process) and [v['ordinal'] for v in records]==list(range(len(records))) and
             all(v['observations']==terminal['observations']>=len(process) for v in records),'SUMMARY_INPUT_6_PLUS_1_OR_ORDINALS')
        required={'phase','control','scope','generation','selected','elapsedMs','clickAtMs','readbackRemainingMs','requestCountDelta','requestObservation','layout','inputAccepted','failureReason','signalProbe'}
        need(required.issubset(state) and state['phase']=='terminal' and state['control']==control and text(state['scope'],False) and
             state['selected'] is True and state['inputAccepted'] is True and state['failureReason']=='' and
             count(state['clickAtMs']) and state['clickAtMs']<4000 and count(state['elapsedMs']) and state['elapsedMs']>=state['clickAtMs'],'SUMMARY_INPUT_TERMINAL_INPUT_OR_CLOCK')
        signal=state['signalProbe'];request=state['requestObservation'];layout=state['layout'];accepted=layout['last']
        need(all(signal[k] is True for k in signal_flags-{'rearmRejected'}) and signal['rearmRejected'] is False and signal['inputFailure']=='' and
             signal['mouseDispatchCount']==1 and signal['enabledBefore'] is True and signal['enabledAfter'] is True,'SUMMARY_INPUT_TERMINAL_OBSERVER_OR_MOUSE')
        need(layout['ready'] is True and accepted.get('ready') is True and accepted.get('layoutStable') is True and accepted.get('scope')==state['scope'] and
             all(accepted.get(k) is True for k in layout_flags) and whole(accepted.get('elapsedMs')) and whole(accepted.get('stableSinceMs')) and
             accepted['elapsedMs']-accepted['stableSinceMs']>=40 and whole(accepted.get('frameSerial')) and whole(accepted.get('stableFrameSerial')) and
             accepted['frameSerial']>accepted['stableFrameSerial'] and accepted['elapsedMs']<=state['clickAtMs'],'SUMMARY_INPUT_ACCEPTED_LAYOUT_NOT_STABLE')
        need(request['scope']==state['scope'] and request['generation']==state['generation'],'SUMMARY_INPUT_REQUEST_SCOPE_GENERATION')
        if operation=='tab':
            need(signal['clickedSignals']==1 and state['requestCountDelta']==0 and state['readbackRemainingMs'] is None and
                 request['observerArmed'] is False and request['rendererSettingsDelta']==request['rendererReadDelta']==0 and
                 request['saveRequestId']==request['readRequestId']=='' and request['sourceSaveId'] is None and request['expected'] is None and
                 'receipt' not in state,'SUMMARY_INPUT_TAB_CLICK_OR_ZERO_WRITER_CONTRACT')
        else:
            receipt=state.get('receipt');receipt_shape(receipt)
            initial=spec['initialEnabledByCase'][case];desired=initial if operation=='restore' else not initial
            negative=case in spec['negativeCases']
            need(signal['toggledSignals']==1 and signal['clickedSignals'] in (0,1) and type(signal['checkedBefore']) is bool and
                 signal['checkedBefore'] is not desired and signal['checkedAfter'] is (initial if negative else desired) and
                 state.get('observerHealthy') is True and count(state['readbackRemainingMs']) and state['readbackRemainingMs']<=10000,'SUMMARY_INPUT_SWITCH_API_OR_READ_WINDOW')
            need(state['requestCountDelta']==2 and request['observerArmed'] is True and request['expected'] is desired and
                 all(request[k]==1 for k in ['observedSaveRequestCount','observedReadRequestCount','rendererSettingsDelta','rendererReadDelta','saveResponses','readResponses']) and
                 request['saveIdentityMatches'] is True and request['payloadMatches'] is True and request['savePending'] is False and
                 text(request['saveRequestId'],False) and text(request['readRequestId'],False) and request['saveRequestId']!=request['readRequestId'] and
                 request['sourceSaveId']==request['saveRequestId'],'SUMMARY_INPUT_ONE_OWN_SAVE_AND_READ')
            need(receipt['armed'] is True and receipt['scope']==state['scope'] and receipt['generation']==state['generation'] and receipt['expected'] is desired and
                 receipt['saveId']==request['saveRequestId'] and receipt['readId']==request['readRequestId'] and receipt['saveId']!=receipt['oldSaveId'] and
                 receipt['readId']!=receipt['oldReadId'] and receipt['newSaveCount']==receipt['newReadCount']==1 and receipt['saveSuccess'] is True,'SUMMARY_INPUT_RECEIPT_IDENTITY')
            need((receipt['failed'] is True and receipt['complete'] is False and receipt['readSuccess'] is False and receipt['failureReason']=='readback-value-mismatch' and receipt['status']=='failed') if negative else
                 (receipt['failed'] is False and receipt['complete'] is True and receipt['readSuccess'] is True and receipt['failureReason']=='' and receipt['status']=='complete'),'SUMMARY_INPUT_READBACK_EXPECTED_OUTCOME')
        terminals[(case,operation)]=state
        summary.append({'case':case,'operation':operation,'processRecords':len(process),'terminalRecords':1,'mouseDispatchCount':signal['mouseDispatchCount'],
            'clickedSignals':signal['clickedSignals'],'toggledSignals':signal['toggledSignals'],'inputAccepted':True,'expectedReadbackRejection':case in spec['negativeCases'] and operation=='change'})
    for case,operations in spec['expectedOperationsByCase'].items():
        tab=terminals[(case,'tab')];change=terminals[(case,'change')]
        need(tab['scope']==change['scope'] and tab['generation']==change['generation'] and tab['clickAtMs']<=change['clickAtMs']<4000,'SUMMARY_INPUT_SHARED_FIRST_CLOCK_OR_IDENTITY')
        if 'restore' in operations:
            restore=terminals[(case,'restore')];before=change['receipt'];after=restore['receipt']
            need(after['oldSaveId']==before['saveId'] and after['oldReadId']==before['readId'] and
                 len({before['saveId'],before['readId'],after['saveId'],after['readId']})==4,'SUMMARY_INPUT_RESTORE_OWN_RECEIPT_CHAIN')
    return {'groups':13,'perOperation':summary,'expectedReadbackRejections':2,'allInputContractsAccepted':True,'unmeasuredValuesPreservedAsNull':True}
