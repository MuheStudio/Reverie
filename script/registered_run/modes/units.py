"""Host checks extracted from the passed formal r1 runner.

Function bodies retain their original comparisons and order. Invoke through an
explicit RunContext: its private namespace supplies paths and frozen contracts.
This module never imports or executes a historical report runner.
"""

def python_identity(case, targets):
    # A pytest classname is the module, optionally followed by a test class; map
    # it to its registered file so class-based tests keep their real file.
    classname, name = case.get('classname', ''), case.get('name', '')
    for target in targets:
        module = target[:-3].replace('/', '.')
        if classname == module or classname.startswith(module + '.'):
            rest = classname[len(module) + 1:]
            return target + '::' + (rest + '::' if rest else '') + name
    return classname.replace('.', '/') + '.py::' + name

def verify_python(reg):
    tree = ET.parse(REPORT / 'python-unit.xml').getroot()
    suites = [tree] if tree.tag == 'testsuite' else list(tree.iter('testsuite'))
    totals = Counter()
    for suite in suites:
        for key in ('tests', 'failures', 'errors', 'skipped'):
            totals[key] += int(suite.get(key, 0))
    cases = []
    for case in tree.iter('testcase'):
        need(not any(child.tag in ('failure', 'error', 'skipped') for child in case), 'PYTHON_CASE_NOT_PASSED')
        cases.append(python_identity(case, reg['pythonTargets']))
    expected = reg['expectedPythonIdentities']
    by_file = dict(Counter(identity.split('::', 1)[0] for identity in cases))
    need(len(expected) == reg['expectedPythonCount'] and by_file == reg['expectedPythonByFile'] and
         sorted(by_file) == sorted(reg['pythonTargets']), 'PYTHON_FILE_OR_CASE_COUNTS_CHANGED:' + json.dumps(by_file))
    need(dict(totals) == {'tests': len(expected), 'failures': 0, 'errors': 0, 'skipped': 0},
         'PYTHON_TOTALS_MISMATCH:' + json.dumps(dict(totals)))
    need(Counter(cases) == Counter(expected), 'PYTHON_IDENTITIES_MISMATCH:' +
         json.dumps(sorted(set(cases) ^ set(expected)), ensure_ascii=False))
    added = [identity for identity in reg['addedPythonIdentities'] if identity in cases]
    need(added == reg['addedPythonIdentities'], 'PYTHON_ADDED_IDENTITIES_NOT_ALL_PASSED')
    return {'testcases': len(cases), 'byFile': by_file, 'failures': 0, 'errors': 0, 'skipped': 0,
            'identitiesMatch': True, 'addedPassed': len(added)}

def verify_build(reg, candidate, build):
    for name in ['build.json', 'application-inventory.json', 'source-inventory.json']:
        need((candidate / name).is_file(), 'BUILD_RECORD_MISSING:' + name)
    record = load_json(candidate / 'build.json')
    need(record.get('candidate') == reg['candidateName'] and record.get('source', {}).get('head') == reg['sourceHead'] and
         record.get('source', {}).get('postBuildInventoryVerified') is True and
         record.get('compilation', {}).get('cmakeDirectory') == str(build), 'BUILD_SOURCE_OR_CMAKE_BINDING_FAILED')
    return {'buildManifestSha256': sha(candidate / 'build.json'), 'sourceHead': record['source']['head'],
            'cmakeDirectory': record['compilation']['cmakeDirectory']}

def registry_module():
    path = ROOT / 'native-ui/tests/native_registry.py'
    spec = importlib.util.spec_from_file_location('native_registry', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

def verify_native(reg):
    junit(REPORT / 'native-unit.xml', reg['expectedUnitCounts']['ctestTargets'], reg['nativeTargets'])
    transcript = (REPORT / 'native-lasttest.log').read_text()
    need(not re.search(r'Maximum amount of warnings exceeded|Further warnings will be omitted', transcript, re.I), 'NATIVE_MESSAGE_LOG_TRUNCATED')
    # The paired Python batch above produced the control receipt, so the
    # receipt-backed runtime-bridge row runs here: no SKIP is admitted.
    need(not re.search(r'^(?:FAIL!|XPASS|SKIP)\s', transcript, re.M), 'NATIVE_FAILURE_XPASS_OR_SKIP')
    registry = registry_module()
    observed = registry.parse_transcript(transcript)
    need(set(observed) == set(reg['nativeTargets']), 'NATIVE_TARGET_SET_CHANGED:' + ','.join(sorted(observed)))
    expected = {target: Counter(rows) for target, rows in reg['expectedNativeIdentities'].items()}
    differences = registry.compare(expected, observed)
    need(not differences, 'NATIVE_IDENTITIES_CHANGED:' + json.dumps(differences[:5], ensure_ascii=False))
    totals = {target: len(rows) for target, rows in observed.items()}
    need(totals == reg['expectedNativeTotals'] and sum(totals.values()) == reg['expectedUnitCounts']['qtTestTotals'],
         'NATIVE_ROW_COUNTS_CHANGED:' + json.dumps(totals))
    lifecycle = sum(registry.lifecycle_rows(rows) for rows in observed.values())
    need(lifecycle == reg['expectedUnitCounts']['lifecycleRows'], 'NATIVE_LIFECYCLE_ROWS_CHANGED')
    added = {target: sum(Counter(observed[target])[identity] for identity in rows)
             for target, rows in reg['addedNativeIdentities'].items()}
    need(added == {target: len(rows) for target, rows in reg['addedNativeIdentities'].items()},
         'NATIVE_ADDED_ROWS_NOT_ALL_OBSERVED')
    need(Counter(observed[CONTROL_RECEIPT_SPEC['consumerTarget']])[CONTROL_RECEIPT_SPEC['consumerIdentity']] == 1,
         'PAIRED_CONTROL_RECEIPT_CONSUMER_NOT_PASSED')
    functional = sum(totals.values()) - lifecycle
    need(functional == reg['expectedUnitCounts']['functionalRows'], 'NATIVE_FUNCTIONAL_ROWS_CHANGED')
    for target, key in [('runtime-bridge', 'runtimeBridgeTestTotals'),
                        ('persona-card-confirmation', 'personaCardTestTotals')]:
        need(totals[target] == reg['expectedUnitCounts'][key], 'NATIVE_TARGET_TOTAL_CHANGED:' + target)
    return {'qtTestTotals': sum(totals.values()), 'targetPassedRows': totals, 'lifecycleRows': lifecycle,
            'functionalRows': functional, 'addedRowsObserved': added, 'ctestTargets': len(observed),
            'memoryFeedbackProbeDiagnostics': verify_feedback_probe_diagnostics(transcript, reg),
            'summaryInputProbeDiagnostics': verify_summary_input_probe_diagnostics(transcript, reg),
            'summaryDirectoryDiagnostics': verify_directory_diagnostics(transcript, reg)}

def verify_node_transcript(reg, transcript):
    expected = Counter(name for path in reg['nodeTests'] for name in reg['expectedNodeNames'][path])
    subtests = Counter(re.findall(r'^# Subtest: (.+)\r?$', transcript, re.M))
    passed = Counter(re.findall(r'^ok [0-9]+ - (.+)\r?$', transcript, re.M))
    need(subtests == expected and passed == expected, 'NODE_IDENTITY_MULTIPLICITIES_CHANGED')
    need(not re.search(r'^not ok\b', transcript, re.M), 'NODE_IDENTITY_NOT_PASSED')
    return {'tests': sum(expected.values()), 'files': reg['nodeTests'],
            'perFileTests': {path: len(reg['expectedNodeNames'][path]) for path in reg['nodeTests']},
            'identityMultiplicitiesMatch': True, 'sourceIdentityListsMatch': False}

def verify_node(reg, transcript):
    verify_node_selection(reg)
    result = verify_node_transcript(reg, transcript)
    result['sourceIdentityListsMatch'] = True
    return result

def verify_node_selection(reg):
    need(reg.get('nodeTests') == NODE_TEST_FILES and set(reg['expectedNodeNames']) == set(NODE_TEST_FILES),
         'REGISTERED_NODE_FILES_CHANGED')
    for path in NODE_TEST_FILES:
        expected = reg['expectedNodeNames'][path]
        actual = re.findall(r"^test\('([^'\r\n]*)',", root_path(path).read_text(), re.M)
        need(expected and Counter(actual) == Counter(expected), 'NODE_SOURCE_IDENTITIES_CHANGED:' + path)
    need(sum(map(len, reg['expectedNodeNames'].values())) == reg['expectedUnitCounts']['node'], 'NODE_TOTAL_CHANGED')

def verify_frontend(reg):
    need(json.dumps(reg.get('frontendUnit'), sort_keys=True) == json.dumps(FRONTEND_UNIT_SPEC, sort_keys=True),
         'FRONTEND_CONTRACT_CHANGED')
    need(reg.get('frontendTests') == FRONTEND_UNIT_SPEC['files'], 'FRONTEND_FILES_CHANGED')
    path = REPORT / FRONTEND_UNIT_SPEC['reportFile']
    need(path.is_file() and not path.is_symlink(), 'FRONTEND_REPORT_MISSING')
    value = load_json(path)
    expected_total = reg['expectedUnitCounts']['frontend']
    need(value.get('success') is True and integer(expected_total) and expected_total > 0,
         'FRONTEND_NOT_SUCCESSFUL')
    for key, expected in [('numTotalTests', expected_total), ('numPassedTests', expected_total),
                          ('numFailedTests', 0), ('numPendingTests', 0), ('numTodoTests', 0),
                          ('numFailedTestSuites', 0), ('numPendingTestSuites', 0)]:
        need(integer(value.get(key)) and value[key] == expected, 'FRONTEND_COUNTS_CHANGED:' + key)
    need(integer(value.get('numTotalTestSuites')) and value['numTotalTestSuites'] > 0 and
         integer(value.get('numPassedTestSuites')) and
         value['numPassedTestSuites'] == value['numTotalTestSuites'], 'FRONTEND_SUITE_COUNTS_CHANGED')
    rows = value.get('testResults')
    need(isinstance(rows, list) and len(rows) == len(reg['frontendTests']), 'FRONTEND_REPORT_FILE_COUNT')
    seen, counts = set(), {}
    for row in rows:
        need(isinstance(row, dict) and isinstance(row.get('name'), str), 'FRONTEND_REPORT_FILE_SHAPE')
        found = [name for name in reg['frontendTests'] if str((ROOT / name).resolve()) == row['name']]
        need(len(found) == 1 and found[0] not in seen, 'FRONTEND_UNREGISTERED_FILE')
        name = found[0]; seen.add(name)
        need(row.get('status') == 'passed' and row.get('message') == '', 'FRONTEND_FILE_FAILED:' + name)
        cases = row.get('assertionResults')
        need(isinstance(cases, list) and cases and all(isinstance(case, dict) for case in cases),
             'FRONTEND_ASSERTIONS_MISSING:' + name)
        for case in cases:
            need(case.get('status') == 'passed' and case.get('failureMessages') == [] and
                 isinstance(case.get('ancestorTitles'), list) and
                 all(isinstance(part, str) for part in case['ancestorTitles']) and
                 isinstance(case.get('title'), str) and case['title'] and
                 case.get('fullName') == ' '.join([*case['ancestorTitles'], case['title']]),
                 'FRONTEND_ASSERTION_FAILED:' + name)
        need(Counter(case['fullName'] for case in cases) == Counter(reg['expectedFrontendNames'][name]),
             'FRONTEND_IDENTITIES_CHANGED:' + name)
        counts[name] = len(cases)
    need(seen == set(reg['frontendTests']) and sum(counts.values()) == expected_total,
         'FRONTEND_SELECTION_CHANGED')
    return {'tests': expected_total, 'files': len(seen), 'perFileTests': counts,
            'identityMultiplicitiesMatch': True, 'reportSha256': sha(path),
            'failures': 0, 'skipped': 0, 'todo': 0}
