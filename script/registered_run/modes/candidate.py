"""Host checks extracted from the passed formal r1 runner.

Function bodies retain their original comparisons and order. Invoke through an
explicit RunContext: its private namespace supplies paths and frozen contracts.
This module never imports or executes a historical report runner.
"""

def verify_candidate_paging_gui(result, reg):
    gui = reg['gui']
    need(gui == CANDIDATE_GUI_SPEC, 'REGISTERED_GUI_CONTRACT_CHANGED')
    need(result.get('passed') is True, 'ORDINARY_NOT_PASSED')
    need(result.get('sourceHead') == reg['sourceHead'], 'ORDINARY_SOURCE_CHANGED')
    need(result.get('noResidualProcesses') is True and result.get('testDataRemoved') is True and
         result.get('applicationUnchanged') is True and result.get('modelInputUnchanged') is True,
         'ORDINARY_CLEANUP_OR_INPUT_INTEGRITY_FAILED')
    need(result.get('automaticRetry') is False and
         [result.get(key) for key in ['applicationDeadlineMs', 'memoryPageDeadlineMs', 'memoryRestartDeadlineMs',
          'memoryRecallDeadlineMs', 'memoryReadDeadlineMs', 'inputReadinessDeadlineMs']] == gui['deadlines'],
         'ORDINARY_DEADLINES_OR_RETRY_CHANGED')
    reports = result.get('reports')
    need(isinstance(reports, list) and len(reports) == 2, 'ORDINARY_TWO_CYCLES_MISSING')
    counts = []
    for cycle, report in enumerate(reports, 1):
        need(isinstance(report, dict) and report.get('passed') is True and report.get('error') in (None, ''),
             'CYCLE_FAILED:' + str(cycle))
        need(not any(group in report for group in gui['absentGroups']), 'UNREGISTERED_GUI_GROUP:' + str(cycle))
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
    need('memoryCandidateBatch' not in reports[0], 'FIRST_CYCLE_DECIDED_CANDIDATES')
    calls = result.get('modelCalls')
    need(integer(result.get('requests')) and result['requests'] == gui['expectedTotalModelRequests'] == 7 and
         isinstance(calls, list) and len(calls) == 7, 'ORDINARY_MODEL_REQUEST_COUNTS_CHANGED')
    kinds = dict(Counter(call.get('kind') for call in calls))
    need(kinds == gui['modelCallKinds'], 'ORDINARY_MODEL_CALL_KIND_COUNTS_CHANGED')
    need(all(call.get('rejectedCandidatePresent') is False and call.get('pagingCandidatePresent') is False
             for call in calls), 'CANDIDATE_REACHED_MODEL')
    exits = result.get('processExits')
    need(isinstance(exits, list) and [row.get('cycle') for row in exits if row.get('cycle') in (1, 2)] == [1, 2] and
         all(row.get('exitCode') == 0 and row.get('signal') is None and row.get('remaining') == [] for row in exits),
         'ORDINARY_PROCESS_EXIT_EVIDENCE_MISSING')
    memory, fixture = result.get('memoryFixture'), result.get('memoryCandidateFixture')
    need(isinstance(memory, dict) and memory.get('passed') is True and memory.get('contentCollected') is False and
         memory.get('batchDelete') is None, 'MEMORY_FIXTURE_NOT_PASSED')
    need(isinstance(fixture, dict) and fixture.get('passed') is True and fixture.get('contentCollected') is False and
         fixture.get('restartEndBatch', {}).get('schema') == CANDIDATE_BATCH_CONTRACT['schema'],
         'CANDIDATE_FIXTURE_NOT_PASSED')
    message_ids = [[row.get('id') for row in report.get('messages', [])] for report in reports]
    need([len(ids) for ids in message_ids] == [39, 39] and message_ids[0] == message_ids[1] and
         all(string(value) for value in message_ids[0]) and len(set(message_ids[0])) == 39,
         'RESTART_CHANGED_MESSAGE_IDENTITIES')
    return {'checkCountsByCycle': counts, 'requests': result['requests'], 'modelCallKinds': kinds,
            'messageIdsAcrossRestartEqual': True, 'messageCount': len(message_ids[0])}

def verify_candidate_batch(result, reg, summary, roots_before):
    need(reg['candidateBatchContract'] == CANDIDATE_BATCH_CONTRACT, 'REGISTERED_CANDIDATE_BATCH_CONTRACT_CHANGED')
    code = ("const fs=require('node:fs'),assert=require('node:assert/strict');"
            "const m=require(process.argv[1]),s=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));"
            "assert.deepEqual(m.MEMORY_CANDIDATE_BATCH_CONTRACT,JSON.parse(process.argv[3]));"
            "const p=m.verifyMemoryCandidateBatch(s);assert.deepEqual(s.memoryCandidateBatchEvidence,p);"
            "process.stdout.write(JSON.stringify(p));")
    completed = subprocess.run([str(ROOT / reg['node']), '-e', code,
        str(ROOT / 'native-ui/memory-candidate-batch-verdicts.cjs'), str(summary), json.dumps(CANDIDATE_BATCH_CONTRACT)],
        cwd=ROOT, capture_output=True, text=True, timeout=30, check=True)
    proof = json.loads(completed.stdout)
    need(proof.get('passed') is True and result.get('memoryCandidateBatchEvidence') == proof, 'CANDIDATE_BATCH_PROOF_CHANGED')
    report_root = summary.parent
    need(report_root.parent == ROOT / '.tools/reports' and report_root.name.startswith('qt-') and
         str(report_root) not in roots_before and report_root.is_dir() and not report_root.is_symlink(),
         'CANDIDATE_BATCH_REPORT_ROOT_NOT_NEW')
    need(reg['gui']['candidateBatchScreenshots'] == CANDIDATE_SCREENSHOTS and
         sorted(path.name for path in report_root.glob('cycle-*.json.memory-candidate-batch-*.png')) ==
         sorted(CANDIDATE_SCREENSHOTS), 'CANDIDATE_BATCH_SCREENSHOT_SET_CHANGED')
    screenshots = []
    for name in CANDIDATE_SCREENSHOTS:
        capture = report_root / name
        need(capture.is_file() and not capture.is_symlink() and capture.resolve().parent == report_root.resolve(),
             'CANDIDATE_BATCH_SCREENSHOT_MISSING_OR_OUTSIDE_REPORT')
        png = capture.read_bytes()
        width, height = int.from_bytes(png[16:20], 'big'), int.from_bytes(png[20:24], 'big')
        need(png.startswith(b'\x89PNG\r\n\x1a\n') and len(png) > 24 and png[12:16] == b'IHDR' and width > 0 and height > 0,
             'CANDIDATE_BATCH_SCREENSHOT_INVALID')
        screenshots.append({'path': str(capture.relative_to(ROOT)), 'sha256': sha(capture),
                            'bytes': len(png), 'width': width, 'height': height})
    return {**proof, 'screenshots': screenshots}
