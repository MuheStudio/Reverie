"""Host checks extracted from the passed formal r1 runner.

Function bodies retain their original comparisons and order. Invoke through an
explicit RunContext: its private namespace supplies paths and frozen contracts.
This module never imports or executes a historical report runner.
"""

def verify_control_receipt(capture, reg):
    spec = CONTROL_RECEIPT_SPEC
    need(reg.get('pairedControlReceiptDiagnostics') == spec, 'PAIRED_CONTROL_RECEIPT_CONTRACT_CHANGED')
    need(spec['producer'] in {target.split('::', 1)[0] for target in reg['pythonTargets']} and
         Counter(reg['expectedNativeIdentities'][spec['consumerTarget']])[spec['consumerIdentity']] == 1,
         'PAIRED_CONTROL_RECEIPT_PRODUCER_OR_CONSUMER_NOT_REGISTERED')
    need(capture.is_dir() and not capture.is_symlink() and
         sorted(path.name for path in capture.iterdir()) == spec['files'], 'PAIRED_CONTROL_RECEIPT_FILES_CHANGED')
    for name in spec['files']:
        need((capture / name).is_file() and not (capture / name).is_symlink(),
             'PAIRED_CONTROL_RECEIPT_FILE_INVALID:' + name)
    manifest = load_json(capture / 'manifest.json')
    need(isinstance(manifest, dict) and set(manifest) == set(spec['manifestKeys']) and
         [manifest.get(key) for key in ['source_fixture', 'requestId', 'schema', 'backup_schema']] ==
         [spec['sourceFixture'], spec['requestId'], spec['schema'], spec['backupSchema']],
         'PAIRED_CONTROL_RECEIPT_MANIFEST_IDENTITY')
    source = (capture / 'source.json').read_bytes()
    wire = (capture / 'receipt.bin').read_bytes()
    fixture = root_path(spec['sourceFixture'])
    need(source == fixture.read_bytes() and integer(manifest['source_file_bytes']) and
         manifest['source_file_bytes'] == len(source) > 0 and
         manifest['source_sha256'] == hashlib.sha256(source).hexdigest() == sha(fixture),
         'PAIRED_CONTROL_RECEIPT_SOURCE_HASH_OR_BYTES')
    need(integer(manifest['receipt_file_bytes']) and manifest['receipt_file_bytes'] == len(wire) > 4 and
         manifest['receipt_sha256'] == hashlib.sha256(wire).hexdigest() and
         int.from_bytes(wire[:4], 'big') == len(wire) - 4,
         'PAIRED_CONTROL_RECEIPT_FRAME_HASH_OR_BYTES')
    def unique_pairs(pairs):
        value = {}
        for key, item in pairs:
            need(key not in value, 'PAIRED_CONTROL_RECEIPT_DUPLICATE_KEY')
            value[key] = item
        return value
    receipt = json.loads(wire[4:].decode('utf-8'), object_pairs_hook=unique_pairs,
                         parse_constant=lambda value: (_ for _ in ()).throw(ValueError('NONFINITE_RECEIPT_JSON:' + value)))
    need(isinstance(receipt, dict) and receipt.get('kind') == 'control_result' and
         receipt.get('ok') is True and receipt.get('type') == 'backup:file:inspect' and
         receipt.get('operation') == 'inspect' and receipt.get('schema') == spec['schema'] and
         receipt.get('backup_schema') == spec['backupSchema'] and receipt.get('requestId') == spec['requestId'] and
         receipt.get('sha256') == manifest['source_sha256'] and
         integer(receipt.get('file_bytes')) and receipt['file_bytes'] == len(source) and
         integer(receipt.get('schema_version')) and receipt['schema_version'] == 3 and
         integer(receipt.get('memory_count')) and receipt['memory_count'] == 2 and
         receipt.get('recovery_state') == 'clean' and receipt.get('runtime_writable') is True and
         receipt.get('writes_blocked') is False, 'PAIRED_CONTROL_RECEIPT_REAL_ENVELOPE_CHANGED')
    files = {name: {'path': str((capture / name).relative_to(ROOT)), 'sha256': sha(capture / name),
                    'bytes': (capture / name).stat().st_size} for name in spec['files']}
    return {'manifest': manifest, 'files': files, 'sourceFixtureSha256': sha(fixture),
            'frameHeaderBytes': 4, 'wirePayloadBytes': len(wire) - 4,
            'producer': spec['producer'], 'consumerIdentity': spec['consumerIdentity'],
            'sourceBytesMatchRegisteredFixture': True, 'hashesAndByteCountsMatch': True}
