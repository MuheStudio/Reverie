"""Host checks extracted from the passed formal r1 runner.

Function bodies retain their original comparisons and order. Invoke through an
explicit RunContext: its private namespace supplies paths and frozen contracts.
This module never imports or executes a historical report runner.
"""

def verify_regex(result, reg, summary):
    # The new isolated mode: the unchanged ordinary check plus the regex tail.
    # Its proof is recomputed from the raw summary by the tail's own verifier.
    spec = REGEX_GUI_SPEC
    need(reg.get('regexGui') == spec, 'REGEX_GUI_CONTRACT_CHANGED')
    need(result.get('automaticRetry') is False and
         [result.get(key) for key in spec['deadlineKeys']] == spec['deadlinesMs'], 'REGEX_DEADLINES_OR_RETRY_CHANGED')
    calls = result.get('modelCalls')
    need(result.get('requests') == spec['requests'] == 10 and isinstance(calls, list) and len(calls) == 10,
         'REGEX_HTTP_COUNT_CHANGED')
    need(dict(Counter(call.get('kind') for call in calls)) == spec['modelCallKinds'], 'REGEX_MODEL_CALL_KINDS_CHANGED')
    for cycle in ('1', '2'):
        need(dict(Counter(call.get('kind') for call in calls if str(call.get('cycle')) == cycle)) ==
             spec['requestKindsByCycle'][cycle], 'REGEX_MODEL_CALL_CYCLE_MATRIX_CHANGED:' + cycle)
    reports = result['reports']
    need([report.get('startupRecoveryState') for report in reports] == ['clean', 'clean'], 'REGEX_CYCLE_NOT_WRITABLE')
    counts = []
    for cycle, report in enumerate(reports, 1):
        found = {}
        for group, count in spec['expectedChecks']['cycle' + str(cycle)].items():
            value = report.get(group) if isinstance(report.get(group), dict) else {}
            checks = value.get('checks', [])
            need(value.get('passed') is True and value.get('error') in (None, '') and isinstance(checks, list) and
                 len(checks) == count and all(isinstance(row, dict) and row.get('passed') is True for row in checks),
                 'REGEX_GROUP_CHANGED:' + str(cycle) + ':' + group)
            found[group] = len(checks)
        counts.append(found)
    need(not any(key in result for key in ('personaFixture', 'memoryFixture', 'settingsFixture', 'profileFixture',
         'memoryCandidateFixture')), 'REGEX_UNREGISTERED_GUI_EXTENSION')
    ids = [[row.get('id') for row in report.get('messages', [])] for report in reports]
    need(ids[0] and ids[0] == ids[1] and all(string(value) for value in ids[0]) and len(set(ids[0])) == len(ids[0]),
         'REGEX_RESTART_CHANGED_MESSAGE_IDENTITIES')
    fixture = result.get('worldbookRegexFixture') if isinstance(result.get('worldbookRegexFixture'), dict) else {}
    need(fixture.get('requestKindMatrix') == spec['hostRequestKindMatrix'], 'REGEX_HOST_MATRIX_CHANGED')
    code = ("const fs=require('node:fs'),assert=require('node:assert/strict');"
            "const m=require(process.argv[1]),s=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));"
            "const p=m.verifyWorldbookRegex(s.reports,s.modelCalls,s.worldbookRegexFixture.events);"
            "assert.deepEqual(s.worldbookRegex,p);process.stdout.write(JSON.stringify(p));")
    completed = subprocess.run([str(ROOT / reg['node']), '-e', code,
        str(ROOT / 'native-ui/worldbook-regex-verdicts.cjs'), str(summary)], cwd=ROOT,
        capture_output=True, text=True, timeout=30, check=True)
    proof = json.loads(completed.stdout)
    need(proof == spec['regexProof'] and result.get('worldbookRegex') == proof, 'REGEX_SETTINGS_PROOF_CHANGED')
    return {'checkCountsByCycle': counts, 'requests': result['requests'], 'messageCount': len(ids[0]), 'proof': proof}

def verify_regex_worker_ownership(result, run):
    # The bootstrap observes actual asyncio Process objects; the Node verifier
    # binds spawn/exit pairs. This layer also binds the owning stage group and
    # checks only those recorded PIDs. No global name scan or signal is used.
    events = result.get('worldbookRegexFixture', {}).get('events', [])
    spawns = [e for e in events if e.get('event') == 'regex_worker_spawn']
    exits = [e for e in events if e.get('event') == 'regex_worker_exit']
    need(len(spawns) == len(exits) == 3 and not any(e.get('event') == 'regex_worker_cleanup_unconfirmed' for e in events),
         'REGEX_WORKER_LIFECYCLE_COUNTS')
    group = run.get('ownedProcessGroup')
    need(integer(group) and group > 0 and run.get('processGroupGone') is True, 'REGEX_STAGE_GROUP_NOT_GONE')
    seen = set()
    for spawn in spawns:
        key = (spawn.get('cycle'), spawn.get('bootstrap_pid'), spawn.get('worker_id'), spawn.get('pid'))
        need(all(integer(x) and x > 0 for x in key) and key[0] == 1 and key not in seen and
             spawn.get('process_group') == group, 'REGEX_WORKER_SPAWN_IDENTITY')
        seen.add(key)
        matched = [e for e in exits if (e.get('cycle'),e.get('bootstrap_pid'),e.get('worker_id'),e.get('pid')) == key]
        need(len(matched) == 1 and integer(matched[0].get('returncode')) and
             integer(spawn.get('monotonic_ns')) and integer(matched[0].get('monotonic_ns')) and
             matched[0]['monotonic_ns'] >= spawn['monotonic_ns'], 'REGEX_WORKER_EXIT_IDENTITY')
    pids = sorted({e['pid'] for e in spawns})
    completed = subprocess.run(['/bin/ps', '-p', ','.join(str(x) for x in pids), '-o', 'pid=,pgid=,command='],
                               capture_output=True, text=True, timeout=10)
    need(completed.returncode in (0,1), 'REGEX_WORKER_PID_QUERY_FAILED')
    reused = []
    for line in completed.stdout.splitlines():
        fields = line.strip().split(None,2)
        need(len(fields) >= 2 and fields[0].isdigit() and fields[1].isdigit(), 'REGEX_WORKER_PID_QUERY_INVALID')
        pid, actual_group = int(fields[0]), int(fields[1])
        need(pid in pids and actual_group != group, 'REGEX_WORKER_RESIDUAL_OWNED_PID')
        reused.append({'pid':pid,'identityChanged':True,'regexWorkerCommandMarker':len(fields)==3 and 'regex_worker.py' in fields[2]})
    return {'spawned':3,'exited':3,'cycleCounts':[3,0],'ownedProcessGroup':group,
            'actualExitCodes':[e['returncode'] for e in exits],'registeredPids':pids,
            'ownedWorkerPidsRemaining':[],'unrelatedPidReuses':reused,'commandMarker':'regex_worker.py','signalsSent':0}
