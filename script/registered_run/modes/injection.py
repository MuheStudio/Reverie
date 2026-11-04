"""Host checks extracted from the passed formal r1 runner.

Function bodies retain their original comparisons and order. Invoke through an
explicit RunContext: its private namespace supplies paths and frozen contracts.
This module never imports or executes a historical report runner.
"""

def verify_injection(result, reg, summary):
    # The new isolated mode: the unchanged ordinary check plus the injection tail.
    # Its proof is recomputed from the raw summary by the tail's own verifier.
    spec = INJECTION_GUI_SPEC
    need(reg.get('injectionGui') == spec, 'INJECTION_GUI_CONTRACT_CHANGED')
    need(result.get('automaticRetry') is False and
         [result.get(key) for key in spec['deadlineKeys']] == spec['deadlinesMs'], 'INJECTION_DEADLINES_OR_RETRY_CHANGED')
    calls = result.get('modelCalls')
    need(result.get('requests') == spec['requests'] == 10 and isinstance(calls, list) and len(calls) == 10,
         'INJECTION_HTTP_COUNT_CHANGED')
    need(dict(Counter(call.get('kind') for call in calls)) == spec['modelCallKinds'], 'INJECTION_MODEL_CALL_KINDS_CHANGED')
    for cycle in ('1', '2'):
        need(dict(Counter(call.get('kind') for call in calls if str(call.get('cycle')) == cycle)) ==
             spec['requestKindsByCycle'][cycle], 'INJECTION_MODEL_CALL_CYCLE_MATRIX_CHANGED:' + cycle)
    reports = result['reports']
    need([report.get('startupRecoveryState') for report in reports] == ['clean', 'clean'], 'INJECTION_CYCLE_NOT_WRITABLE')
    counts = []
    for cycle, report in enumerate(reports, 1):
        found = {}
        for group, count in spec['expectedChecks']['cycle' + str(cycle)].items():
            value = report.get(group) if isinstance(report.get(group), dict) else {}
            checks = value.get('checks', [])
            need(value.get('passed') is True and value.get('error') in (None, '') and isinstance(checks, list) and
                 len(checks) == count and all(isinstance(row, dict) and row.get('passed') is True for row in checks),
                 'INJECTION_GROUP_CHANGED:' + str(cycle) + ':' + group)
            found[group] = len(checks)
        counts.append(found)
    need(not any(key in result for key in ('personaFixture', 'memoryFixture', 'settingsFixture', 'profileFixture',
         'memoryCandidateFixture', 'worldbookRegexFixture', 'worldbookEntryFixture')), 'INJECTION_UNREGISTERED_GUI_EXTENSION')
    ids = [[row.get('id') for row in report.get('messages', [])] for report in reports]
    need(ids[0] and ids[0] == ids[1] and all(string(value) for value in ids[0]) and len(set(ids[0])) == len(ids[0]),
         'INJECTION_RESTART_CHANGED_MESSAGE_IDENTITIES')
    fixture = result.get('worldbookInjectionFixture') if isinstance(result.get('worldbookInjectionFixture'), dict) else {}
    need(fixture.get('requestKindMatrix') == spec['hostRequestKindMatrix'], 'INJECTION_HOST_MATRIX_CHANGED')
    code = ("const fs=require('node:fs'),assert=require('node:assert/strict');"
            "const m=require(process.argv[1]),s=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));"
            "const p=m.verifyWorldbookInjection(s.reports,s.modelCalls,s.worldbookInjectionFixture.events);"
            "assert.deepEqual(s.worldbookInjection,p);process.stdout.write(JSON.stringify(p));")
    completed = subprocess.run([str(ROOT / reg['node']), '-e', code,
        str(ROOT / 'native-ui/worldbook-injection-verdicts.cjs'), str(summary)], cwd=ROOT,
        capture_output=True, text=True, timeout=30, check=True)
    proof = json.loads(completed.stdout)
    need(proof == spec['injectionProof'] and result.get('worldbookInjection') == proof, 'INJECTION_SETTINGS_PROOF_CHANGED')
    return {'checkCountsByCycle': counts, 'requests': result['requests'], 'messageCount': len(ids[0]), 'proof': proof}
