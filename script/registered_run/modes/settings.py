"""Host checks extracted from the passed formal r1 runner.

Function bodies retain their original comparisons and order. Invoke through an
explicit RunContext: its private namespace supplies paths and frozen contracts.
This module never imports or executes a historical report runner.
"""

def verify_settings_ordinary(result, reg):
    # The r2 development verdict for --p1-settings: host verdict, both cycles,
    # per-group check counts, deadlines, request count and explicit cleanup.
    gui = reg['settingsGui']
    need(gui == SETTINGS_GUI_SPEC, 'REGISTERED_SETTINGS_GUI_CONTRACT_CHANGED')
    need(result.get('passed') is True, 'SETTINGS_ORDINARY_NOT_PASSED')
    need(result.get('sourceHead') == reg['sourceHead'], 'SETTINGS_ORDINARY_SOURCE_CHANGED')
    need(result.get('noResidualProcesses') is True and result.get('testDataRemoved') is True and
         result.get('applicationUnchanged') is True and result.get('modelInputUnchanged') is True,
         'SETTINGS_ORDINARY_CLEANUP_OR_INPUT_INTEGRITY_FAILED')
    need(result.get('automaticRetry') is False and
         [result.get(key) for key in gui['deadlineKeys']] == gui['deadlinesMs'], 'SETTINGS_ORDINARY_DEADLINES_OR_RETRY_CHANGED')
    need(result.get('requests') == gui['expectedTotalModelRequests'], 'SETTINGS_ORDINARY_REQUEST_COUNT_CHANGED')
    reports = result.get('reports')
    need(isinstance(reports, list) and len(reports) == 2, 'SETTINGS_ORDINARY_TWO_CYCLES_MISSING')
    counts = []
    for cycle, report in enumerate(reports, 1):
        need(isinstance(report, dict) and report.get('passed') is True and report.get('error') in (None, ''),
             'SETTINGS_CYCLE_FAILED:' + str(cycle))
        found = {}
        for group, expected_count in gui['expectedChecksByCycle'][str(cycle)].items():
            data = report.get(group)
            need(isinstance(data, dict) and data.get('passed') is True and data.get('error') in (None, ''),
                 'SETTINGS_GUI_GROUP_FAILED:' + str(cycle) + ':' + group)
            checks = data.get('checks')
            need(isinstance(checks, list) and len(checks) == expected_count and
                 all(isinstance(row, dict) and row.get('passed') is True for row in checks),
                 'SETTINGS_GUI_CHECKS_MISSING:' + str(cycle) + ':' + group)
            found[group] = len(checks)
        counts.append(found)
    need([report.get('startupRecoveryState') for report in reports] == ['clean', 'clean'],
         'SETTINGS_ORDINARY_CYCLE_NOT_WRITABLE')
    return {'checkCountsByCycle': counts, 'requests': result['requests']}

def verify_settings(result, reg, candidate, build):
    # Pins the settings flow exactly as the passed r2 development run did.
    gui = reg['settingsGui']
    spec = reg['settingsContract']
    reply = reg['settingsReplyStartFixture']
    need(spec == SETTINGS_CONTRACT_SPEC and reply == SETTINGS_REPLY_START_SPEC, 'REGISTERED_SETTINGS_CONTRACT_CHANGED')
    reports = result['reports']
    record = load_json(candidate / 'build.json')
    need(result.get('buildManifestSha256') == sha(candidate / 'build.json') and
         result.get('build') == record and record.get('candidate') == reg['candidateName'] and
         record.get('compilation', {}).get('cmakeDirectory') == str(build),
         'SETTINGS_ORDINARY_CANDIDATE_BUILD_BINDING_CHANGED')
    calls = result.get('modelCalls')
    need(isinstance(calls, list) and len(calls) == gui['expectedTotalModelRequests'] and
         all(isinstance(call, dict) for call in calls), 'SETTINGS_MODEL_CALLS_MISSING')
    kinds = dict(Counter(call.get('kind') for call in calls))
    need(kinds == gui['modelCallKinds'], 'SETTINGS_MODEL_CALL_KINDS_CHANGED:' + json.dumps(kinds))
    fixtures = [[call.get('cycle'), call.get('flawsMarkerPresent'), call.get('environmentRuleForbidden')]
                for call in calls if call.get('kind') == 'settings-fixture']
    need(fixtures == [[1, True, False], [1, False, True]], 'SETTINGS_PROMPT_EFFECTS_CHANGED')
    # The second request follows switching emotion updates off; the kept emotion still reaches it.
    need([call.get('emotionStatePresent') for call in calls if call.get('kind') == 'settings-fixture'] == [True, True],
         'SETTINGS_KEPT_EMOTION_NOT_IN_PROMPT')
    exits = result.get('processExits')
    need(isinstance(exits, list) and [row.get('cycle') for row in exits] == [1, 2, 'cleanup'] and
         all(row.get('exitCode') == 0 and row.get('signal') is None and row.get('remaining') == [] for row in exits),
         'SETTINGS_PROCESS_EXIT_EVIDENCE_MISSING')
    changed_cycle, restarted = (report.get('settingsSections') for report in reports)
    need(changed_cycle.get('mode') == 'change-and-effect' and restarted.get('mode') == 'restart-readback',
         'SETTINGS_MODES_CHANGED')
    need([row.get('name') for row in changed_cycle['checks']] == spec['changeChecks'], 'SETTINGS_CHANGE_CHECKS_CHANGED')
    need([row.get('name') for row in restarted['checks']] == spec['restartChecks'], 'SETTINGS_RESTART_CHECKS_CHANGED')
    observed = changed_cycle.get('observed', {})
    need(observed.get('firstReplyBubbles', 0) >= 2 and observed.get('secondReplyBubbles') == 1,
         'SETTINGS_SPLIT_EFFECT_CHANGED')
    need(observed.get('saved') == spec['savedValues'], 'SETTINGS_SAVED_VALUES_CHANGED:' +
         json.dumps(observed.get('saved'), ensure_ascii=False))
    # Verbatim budget statements from the passed development verifier.
    budget = reg['budgetContract']
    actions = observed.get('budgetActions')
    need(isinstance(actions, list) and len(actions) == 3 and
         all(isinstance(action, dict) and set(action) == set(budget['actionKeys']) for action in actions),
         'BUDGET_ACTION_EVIDENCE_MISSING')
    need(all(type(action.get('enforced')) is bool and integer(action.get('requestBudget')) and
             integer(action.get('tokenBudget')) for action in actions) and
         [{key: action[key] for key in ['enforced', 'requestBudget', 'tokenBudget']} for action in actions] == budget['actions'],
         'BUDGET_ACTION_ORDER_OR_VALUES_CHANGED')
    action_ids = [action[key] for action in actions for key in ['saveRequestId', 'readRequestId']]
    need(all(isinstance(value, str) and bool(value.strip()) for value in action_ids) and
         len(set(action_ids)) == budget['uniqueNonemptyActionRequestIds'], 'BUDGET_ACTION_IDS_NOT_FRESH_UNIQUE')
    restart_runtime = restarted.get('observed', {}).get('budgetRestartRuntime')
    need(isinstance(restart_runtime, dict) and set(restart_runtime) == set(budget['restartRuntime']) and
         type(restart_runtime.get('tracking_enabled')) is bool and
         type(restart_runtime.get('background_enforced')) is bool and
         integer(restart_runtime.get('request_budget')) and integer(restart_runtime.get('token_budget')) and
         restart_runtime == budget['restartRuntime'], 'BUDGET_RESTART_RUNTIME_CHANGED')
    usages = []
    for index, cycle in enumerate([changed_cycle, restarted]):
        usage = cycle.get('observed', {}).get('budgetUsage')
        need(isinstance(usage, dict) and set(usage) == set(budget['usageKeys']), 'BUDGET_USAGE_EVIDENCE_INCOMPLETE')
        need(isinstance(usage.get('requestId'), str) and bool(usage['requestId'].strip()) and
             integer(usage.get('generation')) and 0 <= usage['generation'] <= 9007199254740991 and
             isinstance(usage.get('localDay'), str) and re.fullmatch(r'\d{4}-\d{2}-\d{2}', usage['localDay']) and
             all(integer(usage.get(key)) and 0 <= usage[key] <= 9007199254740991 for key in ['requests', 'tokens']),
             'BUDGET_USAGE_ID_DATE_GENERATION_OR_COUNTS_INVALID')
        need(integer(usage.get('requestBudget')) and usage['requestBudget'] == budget['usageRequestBudget'] and
             integer(usage.get('tokenBudget')) and usage['tokenBudget'] == budget['usageTokenBudget'] and
             usage.get('tracking') is True and usage.get('enforced') is False and usage.get('live') is True and
             usage.get('visible') is True and usage.get('runtimeMatches') is True,
             'BUDGET_USAGE_NOT_CURRENT_VISIBLE_OR_RUNNING_SETTINGS')
        need(integer(usage.get('readDispatchDelta')) and
             usage['readDispatchDelta'] == budget['usageReadDispatchDeltasByCycle'][index],
             'BUDGET_PAGE_LOCAL_READ_QUOTA_CHANGED')
        usages.append(usage)
    need(usages[0]['requestId'] == actions[-1]['readRequestId'], 'BUDGET_DISPLAY_NOT_FROM_FINAL_SAVE_READ')
    budget_evidence = {'actions': actions, 'usageByCycle': usages, 'restartRuntime': restart_runtime,
                       'localReadDispatchDeltas': [row['readDispatchDelta'] for row in usages],
                       'addedModelHttpRequests': 0, 'guiInterceptionTested': False}
    need((result.get('settingsFixture') or {}).get('seededChat') == spec['seededChat'], 'SETTINGS_SEED_CHANGED')
    events = (result.get('settingsFixture') or {}).get('events')
    need(isinstance(events, list) and events and all(isinstance(event, dict) for event in events) and
         all(event.get('schema') == 'reverie.qt.p1-settings-metadata.v1' for event in events),
         'SETTINGS_FIXTURE_EVENTS_MISSING')
    need([event.get('cycle') for event in events if event.get('event') == 'bootstrap_started'] == [1, 2],
         'SETTINGS_BOOTSTRAP_NOT_ONCE_PER_CYCLE')
    overrides = [event for event in events if event.get('event') == 'reply_start_fixture_override']
    planned = [event for event in events if event.get('event') == 'reply_start_planned']
    need(all(set(event) == set(reply['overrideKeys']) for event in overrides), 'SETTINGS_REPLY_START_OVERRIDE_FIELDS_CHANGED')
    need([[event.get(key) for key in ['cycle', 'stage', 'repeated', 'fixtureOverride', 'appliedDelayMs',
                                      'productionPlanned']] for event in overrides] == reply['expectedOverrides'],
         'SETTINGS_REPLY_START_OVERRIDES_CHANGED')
    need([[event.get(key) for key in ['cycle', 'planned', 'startDelayMs', 'immediate', 'reason', 'textCharacters']]
          for event in planned] == reply['expectedPlans'], 'SETTINGS_REPLY_START_APPLIED_PLANS_CHANGED')
    need(set(event.get('event') for event in events) ==
         {'bootstrap_started', 'reply_start_fixture_override', 'reply_start_planned'}, 'SETTINGS_FIXTURE_EVENT_SET_CHANGED')
    production = [{'stage': event['stage'], 'startDelayMs': event['productionStartDelayMs'],
                   'immediate': event['productionImmediate'], 'probability': event['productionProbability'],
                   'status': event['productionStatus'], 'reason': event['productionReason']} for event in overrides]
    return {'modelCallKinds': kinds, 'settingsChangeChecks': len(changed_cycle['checks']),
            'settingsRestartChecks': len(restarted['checks']), 'savedValuesMatch': True,
            'firstReplyBubbles': observed.get('firstReplyBubbles'), 'secondReplyBubbles': observed.get('secondReplyBubbles'),
            'seededChat': spec['seededChat'], 'replyStartOverrides': len(overrides), 'replyStartPlans': len(planned),
            'production': production, 'productionWouldDefer': sum(1 for row in production if row['immediate'] is not True),
            'candidateBuildMatches': True, 'budgetEvidence': budget_evidence}
