"""Host checks extracted from the passed formal r1 runner.

Function bodies retain their original comparisons and order. Invoke through an
explicit RunContext: its private namespace supplies paths and frozen contracts.
This module never imports or executes a historical report runner.
"""

def locate_summary(reg, roots_before, log_name='ordinary-check.log'):
    roots = []
    for line in (REPORT / log_name).read_text(encoding='utf-8').splitlines():
        stripped = line.strip()
        if not stripped.startswith('{'):
            continue
        value = json.loads(stripped)
        if isinstance(value, dict) and 'reportRoot' in value:
            path = Path(value['reportRoot'])
            need(path.is_absolute() and path.parent == ROOT / '.tools/reports' and path.name.startswith('qt-') and
                 str(path) not in roots_before, 'ORDINARY_REPORT_PATH_INVALID')
            roots.append(path / 'summary.json')
    need(len(roots) == 1 and roots[0].is_file(), 'ORDINARY_SUMMARY_MISSING_OR_REPEATED')
    return roots[0]

def save_report_roots(stage):
    # Persist the actual pre-launch set, not a later reconstruction from a count.
    roots = sorted(str(path.relative_to(ROOT)) for path in (ROOT / '.tools/reports').glob('qt-*')
                   if path.is_dir())
    path = REPORT / (stage + '-report-roots-before.json')
    value = {'schema': 'reverie.gui-report-roots-before.v1', 'stage': stage,
             'capturedUtc': now(), 'roots': roots, 'count': len(roots)}
    with path.open('x', encoding='utf-8') as stream:
        stream.write(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    record = {'path': str(path.relative_to(ROOT)), 'sha256': sha(path),
              'bytes': path.stat().st_size, 'count': len(roots), 'stage': stage}
    return load_report_roots(record), record

def load_report_roots(record):
    path = root_path(record['path'])
    need(path.parent == REPORT and not path.is_symlink() and path.is_file() and
         path.stat().st_size == record['bytes'] and sha(path) == record['sha256'],
         'GUI_ROOTS_SNAPSHOT_CHANGED')
    value = load_json(path)
    roots = value.get('roots')
    need(value.get('schema') == 'reverie.gui-report-roots-before.v1' and
         value.get('stage') == record['stage'] and isinstance(roots, list) and
         all(isinstance(name, str) and re.fullmatch(r'\.tools/reports/qt-[A-Za-z0-9_.-]+', name)
             for name in roots) and roots == sorted(set(roots)) and
         value.get('count') == record['count'] == len(roots), 'GUI_ROOTS_SNAPSHOT_INVALID')
    return [str(root_path(name)) for name in roots]

def verify_forced_cleanup(result, reg):
    # Missing/null values are failure, never inferred from the old host verdict.
    spec = reg.get('forcedCleanupContract')
    need(spec == FORCED_CLEANUP_SPEC and isinstance(result, dict) and
         all(key in result for key in FORCED_CLEANUP_SPEC), 'FORCED_CLEANUP_FIELDS_MISSING_OR_CONTRACT_CHANGED')
    observed = {key: result[key] for key in FORCED_CLEANUP_SPEC}
    need(observed['forcedCleanup'] is False and
         all(type(observed[key]) is int and observed[key] == 0 for key in
             ['forcedCleanupTargets', 'forcedCleanupSignalsSent', 'forcedCleanupIdentityChanged']) and
         isinstance(observed['forcedCleanupErrors'], list) and observed['forcedCleanupErrors'] == [],
         'ORDINARY_FORCED_CLEANUP_NOT_EXPLICIT_NORMAL')
    return observed

def verify_gui_report_binding(result, reg, summary, roots_before):
    need(summary.parent.parent == ROOT / '.tools/reports' and summary.parent.name.startswith('qt-') and
         str(summary.parent) not in roots_before, 'GUI_REPORT_NOT_NEW')
    need(result.get('passed') is True and result.get('sourceHead') == reg['sourceHead'], 'GUI_SOURCE_OR_RESULT')
    need(result.get('automaticRetry') is False and result.get('applicationDeadlineMs') == 240000 and
         all(result.get(key) is True for key in ['noResidualProcesses', 'testDataRemoved',
             'applicationUnchanged', 'modelInputUnchanged']), 'GUI_CLEANUP_OR_LIMIT_CHANGED')
    reports = result.get('reports')
    need(isinstance(reports, list) and len(reports) == 2, 'GUI_TWO_CYCLES_REQUIRED')
    files = []
    for cycle, report in enumerate(reports, 1):
        path = summary.parent / ('cycle-' + str(cycle) + '.json')
        need(path.is_file() and not path.is_symlink() and load_json(path) == report, 'GUI_RAW_CYCLE_DIFFERS')
        need(report.get('passed') is True and report.get('error') in (None, ''), 'GUI_CYCLE_FAILED')
        files.append({'path': str(path.relative_to(ROOT)), 'sha256': sha(path), 'bytes': path.stat().st_size})
    exits = result.get('processExits')
    need(isinstance(exits, list) and [row.get('cycle') for row in exits if row.get('cycle') in (1, 2)] == [1, 2] and
         all(row.get('exitCode') == 0 and row.get('signal') is None and row.get('remaining') == [] for row in exits),
         'GUI_PROCESS_EXIT_EVIDENCE_MISSING')
    return files

def verify_archive_control_inputs(result, reg, summary):
    spec = reg['archiveControlReadinessContract']
    need(sha(root_path(spec['path'])) == spec['sha256'] and
         load_json(root_path(spec['path'])) == spec['definition'], 'ARCHIVE_INPUT_CONTRACT_CHANGED')
    code = ("const fs=require('node:fs'),assert=require('node:assert/strict');"
            "const m=require(process.argv[1]),s=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));"
            "assert.deepEqual(m.ARCHIVE_CONTROL_READINESS_CONTRACT,JSON.parse(process.argv[3]));"
            "const p=m.verifyArchiveControlReadiness(s);assert.deepEqual(s.archiveControlReadinessEvidence,p);"
            "process.stdout.write(JSON.stringify(p));")
    completed = subprocess.run([str(ROOT / reg['node']), '-e', code,
        str(ROOT / 'native-ui/archive-control-readiness-verdicts.cjs'), str(summary),
        json.dumps(spec['definition'], ensure_ascii=False)], cwd=ROOT, capture_output=True,
        text=True, timeout=30, check=True)
    proof = json.loads(completed.stdout)
    need(proof.get('passed') is True and result.get('archiveControlReadinessEvidence') == proof,
         'ARCHIVE_INPUT_PROOF_CHANGED')
    return proof
