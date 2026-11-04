"""Host checks extracted from the passed formal r1 runner.

Function bodies retain their original comparisons and order. Invoke through an
explicit RunContext: its private namespace supplies paths and frozen contracts.
This module never imports or executes a historical report runner.
"""

def verify_directory_diagnostics(transcript, reg):
    need(reg.get('directoryDiagnosticsContract') == DIRECTORY_DIAGNOSTIC_SPEC and
         reg.get('directoryReadsByCase') == DIRECTORY_READS_BY_CASE,
         'SUMMARY_DIRECTORY_REGISTERED_CONTRACT_CHANGED')
    need('PROFILE_FIXTURE_FAILURE' not in transcript, 'SUMMARY_DIRECTORY_FAILURE_TERMINAL_PRESENT')
    common = {'layer', 'passed', 'requestId', 'requestIdLength', 'previousRequestId', 'latestRequestId',
              'scope', 'scopeLength', 'currentScope', 'currentScopeLength', 'generation', 'currentGeneration',
              'statusCountBefore', 'statusCount'}
    extra = {
        'request': {'requestIdOccurrences', 'currentStatusPendingCount', 'pendingPresent', 'pendingCommandMatches',
                    'pendingGeneration', 'payloadMatches', 'personaMatches'},
        'cpp': {'expectedReady', 'directoryReady', 'expectedOk', 'ok', 'expectedCount', 'rows', 'rowsMatch',
                'directoryGeneration', 'directoryPersonaMatches', 'pendingConsumed'},
        'qml': {'expectedValid', 'summaryDirectoryValid', 'sourceRows', 'rows'},
        'model': {'expectedCount', 'count', 'model'}
    }
    groups = {}

    def pairs(items):
        value = {}
        for key, item in items:
            need(key not in value, 'SUMMARY_DIRECTORY_DUPLICATE_JSON_KEY')
            value[key] = item
        return value

    records = []
    for line in transcript.splitlines():
        if 'SUMMARY_DIRECTORY_FIXTURE' not in line:
            continue
        match = re.fullmatch(r'QINFO\s+:\s+(\S+)\s+SUMMARY_DIRECTORY_FIXTURE\s+(\{.*\})\s*', line)
        need(match is not None, 'SUMMARY_DIRECTORY_RECORD_LINE_INVALID')
        case, encoded = match.groups()
        need(case in DIRECTORY_READS_BY_CASE and len(encoded) <= 8192, 'SUMMARY_DIRECTORY_CASE_OR_RECORD_BOUND_CHANGED')
        row = json.loads(encoded, object_pairs_hook=pairs,
                         parse_constant=lambda value: (_ for _ in ()).throw(ValueError('NONFINITE_DIRECTORY_JSON:' + value)))
        need(isinstance(row, dict) and row.get('layer') in extra and
             set(row) == common | extra[row['layer']], 'SUMMARY_DIRECTORY_RECORD_KEYS_CHANGED')
        need(row.get('passed') is True and string(row.get('requestId')) and
             re.fullmatch(r'[A-Za-z0-9_-]{8,128}', row['requestId']) and
             row.get('requestIdLength') == len(row['requestId']) and row.get('latestRequestId') == row['requestId'] and
             isinstance(row.get('previousRequestId'), str) and row['previousRequestId'] != row['requestId'],
             'SUMMARY_DIRECTORY_CURRENT_REQUEST_IDENTITY_MISSING')
        need(string(row.get('scope')) and row['scope'] == row.get('currentScope') and
             len(row['scope']) == row.get('scopeLength') == row.get('currentScopeLength') <= 160 and
             integer(row.get('generation')) and row['generation'] == row.get('currentGeneration') and
             integer(row.get('statusCountBefore')) and integer(row.get('statusCount')) and row['statusCountBefore'] >= 0 and
             row.get('statusCount') == row['statusCountBefore'] + 1,
             'SUMMARY_DIRECTORY_SCOPE_GENERATION_OR_COMMAND_COUNT_CHANGED')
        key = (case, row['requestId'])
        groups.setdefault(key, []).append(row)
        records.append((case, row))
    need(len(records) == 60 and len(groups) == 15 and len({case for case, _ in groups}) == 13,
         'SUMMARY_DIRECTORY_60_RECORDS_15_GROUPS_13_ROWS_REQUIRED')
    need(len({request for _, request in groups}) == 15, 'SUMMARY_DIRECTORY_REQUEST_ID_REUSED')
    actual_cases = Counter(case for case, _ in groups)
    need(actual_cases == Counter({case: len(reads) for case, reads in DIRECTORY_READS_BY_CASE.items()}),
         'SUMMARY_DIRECTORY_READ_GROUP_IDENTITIES_CHANGED')
    registered_rows = Counter(reg['expectedNativeIdentities']['persona-card-confirmation'])
    need(all(registered_rows[case] == 1 for case in DIRECTORY_READS_BY_CASE),
         'SUMMARY_DIRECTORY_NATIVE_CASE_NOT_REGISTERED_ONCE')

    def shape(value, length, js=False, empty_qml_source=False):
        keys = {'valid', 'typeId', 'typeName', 'null', 'length'}
        if js:
            keys |= {'jsNull', 'jsUndefined', 'jsObject', 'jsArray'}
        # The sourceRows QVariant read through the QML map reports isNull()
        # for its empty list. This is a measured source-specific value; the
        # bridge list, model list and QJSValue array remain explicitly non-null.
        expected_null = empty_qml_source and length == 0
        need(isinstance(value, dict) and set(value) == keys and value.get('valid') is True and
             value.get('null') is expected_null and integer(value.get('typeId')) and value['typeId'] > 0 and
             value.get('typeName') == ('QJSValue' if js else 'QVariantList') and integer(value.get('length')) and value.get('length') == length,
             'SUMMARY_DIRECTORY_TYPED_SEQUENCE_SHAPE_CHANGED')
        if js:
            need(value.get('jsNull') is False and value.get('jsUndefined') is False and
                 value.get('jsObject') is True and value.get('jsArray') is True,
                 'SUMMARY_DIRECTORY_QML_ARRAY_NOT_OBSERVED')
        else:
            need(value['typeId'] == 9, 'SUMMARY_DIRECTORY_CPP_LIST_TYPE_CHANGED')

    seen = Counter()
    previous_by_case = {}
    for (case, request), rows in groups.items():
        need([row['layer'] for row in rows] == ['request', 'cpp', 'qml', 'model'],
             'SUMMARY_DIRECTORY_LAYER_ORDER_OR_MULTIPLICITY_CHANGED')
        ordinal = seen[case]
        seen[case] += 1
        count, ready, ok = DIRECTORY_READS_BY_CASE[case][ordinal]
        reference = rows[0]
        identity_fields = common - {'layer'}
        need(all({key: row[key] for key in identity_fields} == {key: reference[key] for key in identity_fields}
                 for row in rows), 'SUMMARY_DIRECTORY_LAYER_CORRELATION_CHANGED')
        if case in previous_by_case:
            need(reference['previousRequestId'] == previous_by_case[case], 'SUMMARY_DIRECTORY_REFRESH_PREVIOUS_ID_CHANGED')
        previous_by_case[case] = request
        need(reference.get('requestIdOccurrences') == 1 and reference.get('currentStatusPendingCount') == 1 and
             all(reference.get(key) is True for key in ['pendingPresent', 'pendingCommandMatches', 'payloadMatches', 'personaMatches']) and
             reference.get('pendingGeneration') == reference['generation'],
             'SUMMARY_DIRECTORY_REQUEST_LAYER_NOT_CURRENT')
        cpp, qml, model = rows[1:]
        need(cpp.get('expectedReady') is ready and cpp.get('directoryReady') is ready and
             cpp.get('expectedOk') is ok and cpp.get('ok') is ok and cpp.get('expectedCount') == count and
             cpp.get('rowsMatch') is True and cpp.get('pendingConsumed') is True and
             cpp.get('directoryGeneration') == (reference['generation'] if ready else -1) and
             cpp.get('directoryPersonaMatches') is ready, 'SUMMARY_DIRECTORY_CPP_LAYER_CHANGED')
        shape(cpp.get('rows'), count)
        need(qml.get('expectedValid') is ready and qml.get('summaryDirectoryValid') is ready,
             'SUMMARY_DIRECTORY_QML_VALIDITY_CHANGED')
        shape(qml.get('sourceRows'), count, empty_qml_source=True)
        shape(qml.get('rows'), count, js=True)
        need(integer(model.get('expectedCount')) and integer(model.get('count')) and
             model.get('expectedCount') == count and model.get('count') == count,
             'SUMMARY_DIRECTORY_MODEL_COUNT_CHANGED')
        shape(model.get('model'), count)
    return {'records': 60, 'groups': 15, 'dataRows': 13, 'layers': ['request', 'cpp', 'qml', 'model'],
            'readGroupsByCase': dict(actual_cases), 'allLayerOrdersAndCorrelationsMatch': True,
            'typedSequenceValuesMeasured': True, 'failureTerminalPresent': False, 'bodyCollected': False}
