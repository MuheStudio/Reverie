"""Host checks extracted from the passed formal r1 runner.

Function bodies retain their original comparisons and order. Invoke through an
explicit RunContext: its private namespace supplies paths and frozen contracts.
This module never imports or executes a historical report runner.
"""

def verify_native_pair(reg):
    # Consume only the proof from the single in-stage Node invocation. Never
    # execute the consumer twice or rewrite its actual Qt-produced input.
    spec = reg['nativeEvidenceContract']
    need(sha(ROOT / spec['path']) == spec['sha256'], 'NATIVE_PAIR_CONTRACT_CHANGED')
    proof = load_json(REPORT / 'native-evidence-verdict.json')
    need(proof.get('schema') == 'reverie.native-input-evidence.verdict.v1' and proof.get('passed') is True and
         proof.get('contractSha256') == spec['sha256'] and proof.get('caseIds') == spec['caseIds'],
         'NATIVE_PAIR_VERDICT_NOT_BOUND')
    evidence = REPORT / 'native-evidence'
    need(not evidence.is_symlink() and sha(evidence / 'manifest.json') == proof.get('manifestSha256'),
         'NATIVE_PAIR_MANIFEST_CHANGED')
    hashes = proof.get('recordsSha256')
    need(isinstance(hashes, dict) and len(hashes) == len(spec['caseIds']), 'NATIVE_PAIR_RECORD_COUNT')
    for filename, expected in hashes.items():
        need(isinstance(filename, str) and PurePosixPath(filename).name == filename and filename.endswith('.json') and
             not (evidence / filename).is_symlink() and sha(evidence / filename) == expected, 'NATIVE_PAIR_RECORD_CHANGED')
    return proof

def verify_native_focus_pair(reg):
    spec = reg['nativeFocusEvidenceContract']
    need(sha(ROOT / spec['path']) == spec['sha256'] and
         sha(ROOT / spec['pairedConsumer']['path']) == spec['pairedConsumer']['sha256'], 'FOCUS_PAIR_CONTRACT_CHANGED')
    proof = load_json(REPORT / 'native-focus-evidence-verdict.json')
    definition = load_json(ROOT / spec['path'])['nativeFocusEvidence']
    need(proof.get('schema') == definition['proofSchema'] and proof.get('passed') is True and
         proof.get('contractSha256') == spec['sha256'] and proof.get('caseIds') == spec['caseIds'], 'FOCUS_PAIR_VERDICT_NOT_BOUND')
    directory = REPORT / 'native-focus-evidence'
    need(not directory.is_symlink() and sha(directory / 'manifest.json') == proof.get('manifestSha256'), 'FOCUS_PAIR_MANIFEST_CHANGED')
    hashes = proof.get('recordsSha256')
    expected = [case['filename'] for case in definition['cases']]
    need(isinstance(hashes, dict) and sorted(hashes) == sorted(expected) and
         sorted(path.name for path in directory.iterdir()) == sorted(['manifest.json', *expected]), 'FOCUS_PAIR_RECORD_SET')
    for filename, digest in hashes.items():
        path = directory / filename
        need(not path.is_symlink() and path.is_file() and 0 < path.stat().st_size <= spec['maximumRecordBytes'] and
             sha(path) == digest, 'FOCUS_PAIR_RECORD_CHANGED')
    return proof

def verify_native_regex_pair(reg):
    spec = reg['nativeRegexEvidenceContract']
    need(sha(root_path(spec['path'])) == spec['sha256'] and
         load_json(root_path(spec['path'])) == spec['definition'] and
         sha(root_path(spec['consumer']['path'])) == spec['consumer']['sha256'] and
         sha(root_path(spec['pairedConsumer']['path'])) == spec['pairedConsumer']['sha256'] and
         sha(root_path(spec['nativeStageWrapper']['path'])) == spec['nativeStageWrapper']['sha256'],
         'REGEX_NATIVE_PAIR_SOURCE_CHANGED')
    directory, verdict = root_path(spec['outputDirectory']), root_path(spec['verdictPath'])
    need(directory == REPORT/'native-regex-evidence' and verdict == REPORT/'native-regex-evidence-verdict.json',
         'REGEX_NATIVE_PAIR_PATH_CHANGED')
    need(directory.is_dir() and not directory.is_symlink() and verdict.is_file() and not verdict.is_symlink() and
         (directory/'manifest.json').is_file() and not (directory/'manifest.json').is_symlink(),
         'REGEX_NATIVE_PAIR_FILE_KIND')
    proof = load_json(verdict)
    definition = spec['definition'];cases = definition['cases']
    need(proof.get('schema') == 'reverie.regex-native-evidence-verdict.v1' and proof.get('passed') is True and
         proof.get('contentCollected') is False and proof.get('contractSha256') == spec['sha256'] and
         proof.get('manifestSha256') == sha(directory/'manifest.json') and
         proof.get('caseIds') == [c['caseId'] for c in cases], 'REGEX_NATIVE_PAIR_RESULT')
    hashes = proof.get('recordsSha256')
    need(isinstance(hashes,dict) and set(hashes) == {c['filename'] for c in cases} and
         {f.name for f in directory.iterdir()} == set(hashes)|{'manifest.json'},'REGEX_NATIVE_PAIR_RECORD_SET')
    observed_cases = proof.get('cases')
    need(isinstance(observed_cases,list) and len(observed_cases)==len(cases), 'REGEX_NATIVE_PAIR_CASE_PROOF')
    for observed, expected in zip(observed_cases,cases):
        need(isinstance(observed,dict) and set(observed)=={'caseId','proof'} and observed['caseId']==expected['caseId'],
             'REGEX_NATIVE_PAIR_CASE_PROOF')
        value=observed['proof']
        need(isinstance(value,dict) and set(value)=={'passed','control','textFormat','selectionRequired'} and
             value['passed'] is True and value['control']==expected['control'] and
             type(value['textFormat']) is int and value['textFormat']==0 and
             value['selectionRequired'] is expected['selectionRequired'], 'REGEX_NATIVE_PAIR_CASE_PROOF')
    need(proof.get('cases') == [{'caseId':c['caseId'],'proof':{'passed':True,'control':c['control'],
         'textFormat':0,'selectionRequired':c['selectionRequired']}} for c in cases], 'REGEX_NATIVE_PAIR_CASE_PROOF')
    for filename,digest in hashes.items():
        path=directory/filename
        need(not path.is_symlink() and path.is_file() and 0<path.stat().st_size<=spec['maximumRecordBytes'] and
             sha(path)==digest,'REGEX_NATIVE_PAIR_RECORD_CHANGED')
    return proof

def verify_native_injection_depth_pair(reg):
    spec = reg['nativeInjectionDepthEvidenceContract']
    need(sha(root_path(spec['path'])) == spec['sha256'] and load_json(root_path(spec['path'])) == spec['definition'] and
         sha(root_path(spec['consumer']['path'])) == spec['consumer']['sha256'] and
         sha(root_path(spec['pairedConsumer']['path'])) == spec['pairedConsumer']['sha256'] and
         sha(root_path(spec['nativeStageWrapper']['path'])) == spec['nativeStageWrapper']['sha256'],
         'INJECTION_DEPTH_NATIVE_SOURCE_CHANGED')
    directory, verdict = root_path(spec['outputDirectory']), root_path(spec['verdictPath'])
    need(directory == REPORT / 'native-injection-depth-evidence' and
         verdict == REPORT / 'native-injection-depth-evidence-verdict.json', 'INJECTION_DEPTH_NATIVE_PATH_CHANGED')
    need(directory.is_dir() and not directory.is_symlink() and verdict.is_file() and not verdict.is_symlink() and
         (directory / 'manifest.json').is_file() and not (directory / 'manifest.json').is_symlink(),
         'INJECTION_DEPTH_NATIVE_FILE_KIND')
    proof = load_json(verdict); manifest = load_json(directory / 'manifest.json'); cases = spec['definition']['cases']
    need(proof.get('schema') == 'reverie.qt.worldbook-injection-depth-native-verdict.v1' and
         proof.get('passed') is True and proof.get('contentCollected') is False and
         proof.get('contractSha256') == spec['sha256'] and proof.get('manifestSha256') == sha(directory / 'manifest.json') and
         proof.get('caseIds') == [c['caseId'] for c in cases], 'INJECTION_DEPTH_NATIVE_PROOF_BINDING')
    need(manifest.get('schema') == spec['definition']['manifestSchema'] and manifest.get('contractSha256') == spec['sha256'] and
         isinstance(manifest.get('cases'), list) and len(manifest['cases']) == len(cases), 'INJECTION_DEPTH_NATIVE_MANIFEST')
    hashes = proof.get('recordsSha256'); observed = proof.get('cases')
    need(isinstance(hashes, dict) and set(hashes) == {c['filename'] for c in cases} and
         {p.name for p in directory.iterdir()} == set(hashes) | {'manifest.json'} and
         isinstance(observed, list) and len(observed) == len(cases), 'INJECTION_DEPTH_NATIVE_RECORD_SET')
    for expected, row, reference in zip(cases, observed, manifest['cases']):
        need(isinstance(row, dict) and set(row) == {'caseId', 'proof'} and row['caseId'] == expected['caseId'],
             'INJECTION_DEPTH_NATIVE_CASE')
        value = row['proof']; wanted = {'passed': True, 'step': expected['step'], 'beforeValue': expected['beforeValue'],
            'expectedValue': expected['expectedValue'], 'mouseDispatchCount': 1, 'keyDispatchCount': 3, 'valueModifiedSignals': 1}
        need(isinstance(value, dict) and set(value) == set(wanted) and value.get('passed') is True and
             all(integer(value[k]) and value[k] == wanted[k] for k in wanted if k != 'passed'),
             'INJECTION_DEPTH_NATIVE_CASE_PROOF')
        path = directory / expected['filename']
        need(isinstance(reference, dict) and set(reference) == {'caseId', 'filename', 'sha256', 'bytes'} and
             reference['caseId'] == expected['caseId'] and reference['filename'] == expected['filename'] and
             integer(reference['bytes']) and not path.is_symlink() and path.is_file() and
             0 < path.stat().st_size == reference['bytes'] <= spec['maximumRecordBytes'] and
             sha(path) == hashes[expected['filename']] == reference['sha256'], 'INJECTION_DEPTH_NATIVE_RECORD_CHANGED')
    return proof

def verify_native_injection_navigation_pair(reg):
    spec = reg['nativeInjectionNavigationEvidenceContract']
    need(sha(root_path(spec['path'])) == spec['sha256'] and load_json(root_path(spec['path'])) == spec['definition'] and
         sha(root_path(spec['consumer']['path'])) == spec['consumer']['sha256'] and
         sha(root_path(spec['pairedConsumer']['path'])) == spec['pairedConsumer']['sha256'] and
         sha(root_path(spec['nativeStageWrapper']['path'])) == spec['nativeStageWrapper']['sha256'],
         'INJECTION_NAVIGATION_NATIVE_SOURCE_CHANGED')
    directory, verdict = root_path(spec['outputDirectory']), root_path(spec['verdictPath'])
    need(directory == REPORT / 'native-injection-navigation-evidence' and
         verdict == REPORT / 'native-injection-navigation-evidence-verdict.json', 'INJECTION_NAVIGATION_NATIVE_PATH_CHANGED')
    need(directory.is_dir() and not directory.is_symlink() and verdict.is_file() and not verdict.is_symlink() and
         (directory / 'manifest.json').is_file() and not (directory / 'manifest.json').is_symlink(),
         'INJECTION_NAVIGATION_NATIVE_FILE_KIND')
    proof = load_json(verdict); manifest = load_json(directory / 'manifest.json'); cases = spec['definition']['cases']
    need(proof.get('schema') == 'reverie.qt.worldbook-injection-navigation-native-verdict.v1' and
         proof.get('passed') is True and proof.get('contentCollected') is False and
         proof.get('contractSha256') == spec['sha256'] and proof.get('manifestSha256') == sha(directory / 'manifest.json') and
         proof.get('caseIds') == [c['caseId'] for c in cases], 'INJECTION_NAVIGATION_NATIVE_PROOF_BINDING')
    need(manifest.get('schema') == spec['definition']['manifestSchema'] and manifest.get('contractSha256') == spec['sha256'] and
         isinstance(manifest.get('cases'), list) and len(manifest['cases']) == len(cases), 'INJECTION_NAVIGATION_NATIVE_MANIFEST')
    hashes = proof.get('recordsSha256'); observed = proof.get('cases')
    need(isinstance(hashes, dict) and set(hashes) == {c['filename'] for c in cases} and
         {p.name for p in directory.iterdir()} == set(hashes) | {'manifest.json'} and
         isinstance(observed, list) and len(observed) == len(cases), 'INJECTION_NAVIGATION_NATIVE_RECORD_SET')
    for expected, row, reference in zip(cases, observed, manifest['cases']):
        need(isinstance(row, dict) and set(row) == {'caseId', 'proof'} and row['caseId'] == expected['caseId'],
             'INJECTION_NAVIGATION_NATIVE_CASE')
        value = row['proof']; wanted = {'passed': True, 'step': expected['step'], 'depthStep': expected['depthStep'],
            'tabFocusBehavior': expected['tabFocusBehavior'], 'beforeValue': expected['beforeValue'],
            'expectedValue': expected['expectedValue'], 'mouseDispatchCount': 1, 'keyDispatchCount': 9, 'snapshotCount': 20}
        need(isinstance(value, dict) and set(value) == set(wanted) and value.get('passed') is True and
             all(integer(value[k]) and value[k] == wanted[k] for k in wanted if k != 'passed'),
             'INJECTION_NAVIGATION_NATIVE_CASE_PROOF')
        path = directory / expected['filename']
        need(isinstance(reference, dict) and set(reference) == {'caseId', 'filename', 'sha256', 'bytes'} and
             reference['caseId'] == expected['caseId'] and reference['filename'] == expected['filename'] and
             integer(reference['bytes']) and not path.is_symlink() and path.is_file() and
             0 < path.stat().st_size == reference['bytes'] <= spec['maximumRecordBytes'] and
             sha(path) == hashes[expected['filename']] == reference['sha256'], 'INJECTION_NAVIGATION_NATIVE_RECORD_CHANGED')
    return proof

def verify_native_injection_hit_pair(reg):
    spec = reg['nativeInjectionHitEvidenceContract']
    need(sha(root_path(spec['path'])) == spec['sha256'] and load_json(root_path(spec['path'])) == spec['definition'] and
         sha(root_path(spec['consumer']['path'])) == spec['consumer']['sha256'] and
         sha(root_path(spec['pairedConsumer']['path'])) == spec['pairedConsumer']['sha256'] and
         sha(root_path(spec['nativeStageWrapper']['path'])) == spec['nativeStageWrapper']['sha256'],
         'INJECTION_HIT_NATIVE_SOURCE_CHANGED')
    directory, verdict = root_path(spec['outputDirectory']), root_path(spec['verdictPath'])
    need(directory == REPORT / 'native-injection-hit-evidence' and
         verdict == REPORT / 'native-injection-hit-evidence-verdict.json', 'INJECTION_HIT_NATIVE_PATH_CHANGED')
    need(directory.is_dir() and not directory.is_symlink() and verdict.is_file() and not verdict.is_symlink() and
         (directory / 'manifest.json').is_file() and not (directory / 'manifest.json').is_symlink(),
         'INJECTION_HIT_NATIVE_FILE_KIND')
    proof = load_json(verdict); manifest = load_json(directory / 'manifest.json'); cases = spec['definition']['cases']
    need(proof.get('schema') == 'reverie.qt.worldbook-injection-hit-native-verdict.v1' and
         proof.get('passed') is True and proof.get('contentCollected') is False and
         proof.get('contractSha256') == spec['sha256'] and proof.get('manifestSha256') == sha(directory / 'manifest.json') and
         proof.get('caseIds') == [c['caseId'] for c in cases], 'INJECTION_HIT_NATIVE_PROOF_BINDING')
    need(manifest.get('schema') == spec['definition']['manifestSchema'] and manifest.get('contractSha256') == spec['sha256'] and
         isinstance(manifest.get('cases'), list) and len(manifest['cases']) == len(cases), 'INJECTION_HIT_NATIVE_MANIFEST')
    hashes = proof.get('recordsSha256'); observed = proof.get('cases')
    need(isinstance(hashes, dict) and set(hashes) == {c['filename'] for c in cases} and
         {p.name for p in directory.iterdir()} == set(hashes) | {'manifest.json'} and
         isinstance(observed, list) and len(observed) == len(cases), 'INJECTION_HIT_NATIVE_RECORD_SET')
    for expected, row, reference in zip(cases, observed, manifest['cases']):
        need(isinstance(row, dict) and set(row) == {'caseId', 'proof'} and row['caseId'] == expected['caseId'],
             'INJECTION_HIT_NATIVE_CASE')
        value = row['proof']
        if expected['expectedPassed'] is True:
            need(isinstance(value, dict) and set(value) == {'passed', 'kind', 'mouseDispatchCount', 'eventCount'} and
                 value.get('passed') is True and value.get('kind') == expected['kind'] and
                 integer(value.get('mouseDispatchCount')) and value['mouseDispatchCount'] == 1 and
                 integer(value.get('eventCount')) and value['eventCount'] == 2, 'INJECTION_HIT_NATIVE_CASE_PROOF')
        else:
            reason = {'dispatch-coordinate-mismatch': 'INJECTION_INPUT_HIT_COORDINATES',
                      'legacy-input-without-envelope': 'INJECTION_INPUT_HIT_EVIDENCE'}[expected['fault']]
            need(expected['expectedPassed'] is False and isinstance(value, dict) and
                 set(value) == {'passed', 'kind', 'expectedPassed', 'rejectedReason'} and
                 value.get('passed') is True and value.get('kind') == expected['kind'] and
                 value.get('expectedPassed') is False and value.get('rejectedReason') == reason,
                 'INJECTION_HIT_NATIVE_CASE_PROOF')
        path = directory / expected['filename']
        need(isinstance(reference, dict) and set(reference) == {'caseId', 'filename', 'sha256', 'bytes'} and
             reference['caseId'] == expected['caseId'] and reference['filename'] == expected['filename'] and
             integer(reference['bytes']) and not path.is_symlink() and path.is_file() and
             0 < path.stat().st_size == reference['bytes'] <= spec['maximumRecordBytes'] and
             sha(path) == hashes[expected['filename']] == reference['sha256'], 'INJECTION_HIT_NATIVE_RECORD_CHANGED')
    return proof
