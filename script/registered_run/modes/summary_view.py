"""Host checks extracted from the passed formal r1 runner.

Function bodies retain their original comparisons and order. Invoke through an
explicit RunContext: its private namespace supplies paths and frozen contracts.
This module never imports or executes a historical report runner.
"""

def summary_hash(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode('utf-8')).hexdigest()

def summary_keys(value, expected, code):
    need(isinstance(value, dict) and set(value) == set(expected), code)

def summary_table_map(value):
    need(isinstance(value, dict) and value, 'SUMMARY_VIEW_TABLE_SNAPSHOT_MISSING')
    for table, entry in value.items():
        need(isinstance(table, str) and re.fullmatch(r'[a-z][a-z0-9_]*', table), 'SUMMARY_VIEW_TABLE_NAME_INVALID')
        summary_keys(entry, ['count', 'sha256'], 'SUMMARY_VIEW_TABLE_DIGEST_SHAPE_CHANGED')
        need(integer(entry['count']) and entry['count'] >= 0 and isinstance(entry['sha256'], str) and
             re.fullmatch(r'[a-f0-9]{64}', entry['sha256']), 'SUMMARY_VIEW_TABLE_DIGEST_INVALID')

def summary_metadata_only(value, path='summaryView', depth=0):
    need(depth <= 16, 'SUMMARY_VIEW_METADATA_DEPTH_CHANGED')
    table_paths = {'summary_view_seeded.snapshots.' + phase + '.' + kind
                   for phase in ['before', 'after'] for kind in ['kernelTables', 'memoryTables']}
    if path in table_paths:
        summary_table_map(value)
        return
    if isinstance(value, dict):
        need(not set(value) & {'text', 'body', 'content', 'messages', 'prompt', 'rawResponse', 'rawReply'},
             'SUMMARY_VIEW_RAW_BODY_OR_PROMPT_COLLECTED')
        for key, item in value.items():
            summary_metadata_only(item, path + '.' + key, depth + 1)
    elif isinstance(value, list):
        need(len(value) <= 256, 'SUMMARY_VIEW_METADATA_LIST_UNBOUNDED')
        for item in value:
            summary_metadata_only(item, path, depth + 1)
    elif isinstance(value, str):
        need(len(value) <= 1024 and SUMMARY_VIEW_SPEC['marker'] not in value,
             'SUMMARY_VIEW_BODY_MARKER_OR_UNBOUNDED_TEXT_COLLECTED')
    elif value is not None:
        need(isinstance(value, bool) or numeric(value), 'SUMMARY_VIEW_METADATA_VALUE_INVALID')

def verify_summary_view(result, reg, summary, old_report_roots, build_record):
    spec = SUMMARY_VIEW_SPEC
    need(reg.get('summaryViewContract') == spec and reg.get('summaryViewDiagnostics') == SUMMARY_VIEW_DIAGNOSTIC_SPEC,
         'SUMMARY_VIEW_REGISTERED_CONTRACT_CHANGED')
    report_root = summary.parent
    need(report_root.parent == ROOT / '.tools/reports' and report_root.name.startswith('qt-') and
         str(report_root) not in old_report_roots and report_root.is_dir() and not report_root.is_symlink(),
         'SUMMARY_VIEW_REPORT_ROOT_NOT_NEW')
    candidate = root_path(reg['candidateDirectory'])
    need(result.get('buildManifestSha256') == sha(candidate / 'build.json') and result.get('build') == build_record and
         build_record == load_json(candidate / 'build.json') and build_record.get('candidate') == NAME and
         build_record.get('source', {}).get('head') == reg['sourceHead'] == result.get('sourceHead') and
         build_record.get('source', {}).get('postBuildInventoryVerified') is True and
         build_record.get('compilation', {}).get('cmakeDirectory') == str(ROOT / CMAKE_DIRECTORY),
         'SUMMARY_VIEW_BUILD_OR_SOURCE_BINDING_CHANGED')
    reports = result['reports']
    cycle_files = []
    for index, report in enumerate(reports, 1):
        raw = report_root / ('cycle-' + str(index) + '.json')
        need(raw.is_file() and not raw.is_symlink() and load_json(raw) == report,
             'SUMMARY_VIEW_RAW_CYCLE_DIFFERS_FROM_EMBEDDED_REPORT:' + str(index))
        cycle_files.append({'file': raw.name, 'sha256': sha(raw)})
    fixture = result.get('summaryViewFixture')
    need(isinstance(fixture, dict) and fixture.get('schema') == SUMMARY_VIEW_DIAGNOSTIC_SPEC['hostFixtureSchema'] and
         fixture.get('contract') == spec and fixture.get('passed') is True and fixture.get('contentCollected') is False and
         fixture.get('syntheticFixture') is True and fixture.get('naturalGeneration') is False and
         [fixture.get(key) for key in ['originalModelRequests', 'originalRecallQueries', 'originalMessageCount',
                                      'survivingMemoryCount']] == [7, 2, 39, 127],
         'SUMMARY_VIEW_HOST_FIXTURE_CONTRACT_CHANGED')
    calls = result['modelCalls']
    need(len(calls) == result['requests'] == 7 and all(call.get('summaryMessageContentsKnown') is True and
         call.get('summaryMarkerPresent') is False and call.get('conversationSummariesSectionPresent') is False
         for call in calls), 'SUMMARY_VIEW_ACTUAL_MODEL_MESSAGES_CONTAIN_SUMMARY_OR_NOT_OBSERVED')
    source_fields = ['summaryId', 'sourceDigest', 'sourceIdsSha256', 'sourceMessageCount', 'firstSequence', 'lastSequence']
    consent_fields = ['enabled', 'grantEnabled', 'grantAcknowledged', 'policyAllowed', 'statusDisabled', 'scopeMatches']
    identity_fields = source_fields + ['bodySha256', 'bodyCharacters']
    common = {'schema', 'event', 'cycle', 'monotonic_ns'}
    fields = {
        'summary_view_seeded': identity_fields + consent_fields + ['syntheticFixture', 'naturalGeneration', 'causeRequestId',
            'requestedCount', 'deletedCount', 'messageCount', 'memoryCount', 'summaryAttemptCount', 'summaryItemCount',
            'messageIdsUnchanged', 'memoryIdsUnchanged', 'kernelNonSummaryUnchanged', 'memoryTablesUnchanged',
            'otherSummaryTablesUnchanged', 'beforeAfterMatches', 'snapshots'],
        'summary_view_restart_validated': identity_fields + consent_fields + ['syntheticFixture', 'naturalGeneration', 'seeded',
            'messageCount', 'memoryCount', 'summaryAttemptCount', 'summaryItemCount', 'messageIdsSha256', 'memoryIdsSha256'],
        'summary_view_dispatched': ['requestId', 'readCount', 'summaryId', 'idMatches'] + consent_fields,
        'summary_view_result': ['requestId', 'readCount'] + identity_fields + consent_fields +
            ['ok', 'idMatches', 'operationMatches', 'fixtureMatches', 'sourceMatches', 'statusMatches'],
        'summary_view_status_dispatched': ['requestId'] + consent_fields,
        'summary_view_status_result': ['requestId'] + consent_fields + ['ok', 'operationMatches', 'status', 'resultEnabled',
            'resultAuthorized', 'resultStatusDisabled', 'activeCount', 'summaryTotal', 'fixturePresent'] + source_fields
    }
    all_events = result['memoryFixture']['events']
    events = [row for row in all_events if isinstance(row.get('event'), str) and row['event'].startswith('summary_view_')]
    for row in events:
        need(row['event'] in fields, 'SUMMARY_VIEW_UNREGISTERED_OBSERVER_EVENT')
        summary_keys(row, common | set(fields[row['event']]), 'SUMMARY_VIEW_OBSERVER_EVENT_FIELDS_CHANGED')
        need(row['schema'] == 'reverie.qt.p1-memory-metadata.v1' and integer(row['cycle']) and row['cycle'] in [1, 2] and
             numeric(row['monotonic_ns']), 'SUMMARY_VIEW_OBSERVER_SCHEMA_OR_TIME_CHANGED')
        summary_metadata_only(row, row['event'])

    def selected(name):
        return [row for row in events if row['event'] == name]

    seeds, restarts = selected('summary_view_seeded'), selected('summary_view_restart_validated')
    need([row['cycle'] for row in seeds] == [1] and [row['cycle'] for row in restarts] == [2],
         'SUMMARY_VIEW_SEED_ONCE_RESTART_WITHOUT_SEED_CHANGED')
    seed, restart = seeds[0], restarts[0]

    def disabled(row):
        need(all(row.get(key) is False for key in consent_fields[:4]) and
             row.get('statusDisabled') is True and row.get('scopeMatches') is True,
             'SUMMARY_VIEW_GENERATION_OR_FEE_CONSENT_NOT_DISABLED')

    def same_source(row):
        need(all(integer(row.get(key)) for key in ['sourceMessageCount', 'firstSequence', 'lastSequence']) and
             [row.get(key) for key in source_fields] == [seed.get(key) for key in source_fields],
             'SUMMARY_VIEW_SOURCE_DIFFERS_FROM_AUTHENTICATED_FIXTURE')

    for row in [seed, restart]:
        disabled(row)
        need(row.get('syntheticFixture') is True and row.get('naturalGeneration') is False and
             [row.get(key) for key in ['messageCount', 'memoryCount', 'summaryAttemptCount', 'summaryItemCount']] == [39, 127, 1, 1] and
             row.get('summaryId') == spec['summaryId'] and row.get('bodySha256') == spec['bodySha256'] and
             row.get('bodyCharacters') == 54, 'SUMMARY_VIEW_FIXTURE_BODY_OR_COUNTS_CHANGED')
        same_source(row)
    need(restart.get('seeded') is False and seed.get('causeRequestId') == reports[0]['memoryBatchDelete']['observed']['requestId'] and
         [seed.get(key) for key in ['requestedCount', 'deletedCount']] == [3, 3] and
         all(seed.get(key) is True for key in ['messageIdsUnchanged', 'memoryIdsUnchanged', 'kernelNonSummaryUnchanged',
             'memoryTablesUnchanged', 'otherSummaryTablesUnchanged', 'beforeAfterMatches']),
         'SUMMARY_VIEW_LATE_BATCH_CAUSE_OR_STORAGE_PRESERVATION_CHANGED')
    for key in ['sourceDigest', 'sourceIdsSha256']:
        need(isinstance(seed.get(key), str) and re.fullmatch(r'[a-f0-9]{64}', seed[key]), 'SUMMARY_VIEW_SOURCE_HASH_UNKNOWN')
    need(integer(seed.get('sourceMessageCount')) and 1 <= seed['sourceMessageCount'] <= 40 and
         integer(seed.get('firstSequence')) and integer(seed.get('lastSequence')) and
         1 <= seed['firstSequence'] <= seed['lastSequence'] and
         seed['lastSequence'] - seed['firstSequence'] + 1 >= seed['sourceMessageCount'], 'SUMMARY_VIEW_SOURCE_RANGE_UNKNOWN')
    snapshots = seed['snapshots']
    summary_keys(snapshots, ['before', 'after'], 'SUMMARY_VIEW_SEED_SNAPSHOT_PHASES_CHANGED')
    for snapshot in snapshots.values():
        summary_keys(snapshot, ['kernelTables', 'memoryTables', 'messageIdsSha256', 'memoryIdsSha256', 'messageCount', 'memoryCount'],
                     'SUMMARY_VIEW_SEED_SNAPSHOT_FIELDS_CHANGED')
        summary_table_map(snapshot['kernelTables'])
        summary_table_map(snapshot['memoryTables'])
        need([snapshot['messageCount'], snapshot['memoryCount']] == [39, 127] and
             snapshot['kernelTables'].get('messages', {}).get('count') == 39 and
             integer(snapshot['memoryTables'].get('memory_records', {}).get('count')) and
             snapshot['memoryTables']['memory_records']['count'] >= 127, 'SUMMARY_VIEW_ACTIVE_AND_PHYSICAL_COUNTS_CHANGED')
    before, after = snapshots['before'], snapshots['after']
    mutable_tables = {'conversation_summary_attempts', 'conversation_summary_items'}
    need(set(before['kernelTables']) == set(after['kernelTables']) and mutable_tables <= set(before['kernelTables']) and
         before['memoryTables'] == after['memoryTables'], 'SUMMARY_VIEW_TABLE_SET_OR_MEMORY_ROWS_CHANGED')
    for table, old in before['kernelTables'].items():
        current = after['kernelTables'][table]
        if table in mutable_tables:
            need([old['count'], current['count']] == [0, 1] and old['sha256'] != current['sha256'],
                 'SUMMARY_VIEW_SUMMARY_TABLE_DID_NOT_ADD_ONE_ROW')
        else:
            need(current == old, 'SUMMARY_VIEW_NON_SUMMARY_KERNEL_TABLE_CHANGED:' + table)
    for key in ['messageIdsSha256', 'memoryIdsSha256']:
        need(isinstance(after.get(key), str) and re.fullmatch(r'[a-f0-9]{64}', after[key]) and
             before.get(key) == after[key] == restart.get(key), 'SUMMARY_VIEW_ORIGINAL_ID_DIGEST_CHANGED')
    dispatches, responses = selected('summary_view_dispatched'), selected('summary_view_result')
    need([row['cycle'] for row in dispatches] == [1, 2] == [row['cycle'] for row in responses],
         'SUMMARY_VIEW_TWO_BODY_RPCS_REQUIRED')
    status_dispatches, status_results = selected('summary_view_status_dispatched'), selected('summary_view_status_result')
    raw_common = {'requestId', 'command', 'generation', 'scope', 'ok', 'operation', 'conversationId', 'personaId',
                  'personaEpoch', 'personaFingerprint', 'contractVersion'} | set(source_fields)
    raw_directory_keys = raw_common | {'status', 'enabled', 'authorized', 'summaryTotal', 'hasMore', 'bodyFieldPresent'}
    raw_detail_keys = raw_common | {'bodySha256', 'bodyCharacters', 'bodyUtf16Length', 'bodyMatchesFixture'}
    request_ids, read_identities = [], []
    recall_ids = [report['memoryRecall']['observed']['requestId'] for report in reports]
    for index, report in enumerate(reports):
        cycle = index + 1
        view = report['summaryView']
        need(view.get('schema') == spec['schema'] and view.get('passed') is True and view.get('error') in ['', None] and
             integer(view.get('cycle')) and view.get('cycle') == cycle and view.get('contentCollected') is False and numeric(view.get('elapsedMs')) and
             0 <= view['elapsedMs'] < 20000 and [view.get(key) for key in ['deadlineMs', 'inputDeadlineMs', 'readDeadlineMs',
                                                                        'closeDeadlineMs']] == [20000, 4000, 10000, 4000] and
             [check.get('name') for check in view.get('checks', [])] == spec['checks'][index] and
             all(check.get('passed') is True for check in view['checks']), 'SUMMARY_VIEW_GUI_CHECKS_OR_DEADLINES_CHANGED')
        summary_metadata_only(view)
        observed = view['observed']
        count_keys = ['generation', 'initialBodyCharacters', 'directoryCount', 'directoryTotal', 'directoryCommandDelta',
                      'detailCommandDelta', 'segmentCommandDelta', 'directoryResponseCount', 'detailResponseCount', 'clearCommandDelta',
                      'otherResponseCount', 'finalPendingCount', 'finalTabIndex', 'finalWindowWidth', 'finalWindowHeight']
        need(all(integer(observed.get(key)) for key in count_keys) and observed.get('directoryHasMore') is False and
             type(observed.get('initialArchiveDirty')) is bool and type(observed.get('initialProfileDirty')) is bool and
             integer(observed.get('initialArchiveRevision')), 'SUMMARY_VIEW_UNKNOWN_COUNTER_OR_DRAFT_BASELINE')
        flags = ['initialDetailIdle', 'initialDetailEmpty', 'afterOpeningDetailIdle', 'afterOpeningDetailEmpty', 'readAllowed',
                 'directoryValidated', 'bodyMatchesFixture', 'bodyReadOnly', 'bodyPlainText', 'bodyVisible', 'bodyWidthFits',
                 'clearIdle', 'clearEmpty', 'noAiOrSettingsWrites', 'surfaceClosed', 'finalDetailIdle', 'finalDetailEmpty',
                 'managementStateMatches', 'managementFeedbackMatches', 'managementCandidatesMatch', 'managementPagingMatches']
        need(all(observed.get(key) is True for key in flags) and observed.get('enabled') is False and
             observed.get('authorized') is False and observed.get('initialBodyCharacters') == 0 and
             observed.get('fixtureSummaryId') == spec['summaryId'] and
             [observed.get(key) for key in ['directoryCount', 'directoryTotal', 'directoryHasMore', 'directoryCommandDelta',
                 'detailCommandDelta', 'segmentCommandDelta', 'directoryResponseCount', 'detailResponseCount', 'clearCommandDelta',
                 'otherResponseCount', 'finalPendingCount', 'finalTabIndex', 'finalWindowWidth', 'finalWindowHeight']] ==
             [1, 1, False, 1, 1, 2, 1, 1, 0, 0, 0, 0, 1380, 900], 'SUMMARY_VIEW_GUI_READ_CLEAR_OR_FINAL_STATE_CHANGED')
        directory_id, detail_id, opening_id = [observed.get(key) for key in ['directoryRequestId', 'detailRequestId', 'directoryBeforeRequestId']]
        need(all(isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9_-]{8,128}', value)
                 for value in [directory_id, detail_id, opening_id]) and len({directory_id, detail_id, opening_id}) == 3,
             'SUMMARY_VIEW_REQUEST_IDENTITIES_NOT_FRESH')
        request_ids.extend([directory_id, detail_id])
        raw_directory, raw_detail = observed['rawDirectory'], observed['rawDetail']
        summary_keys(raw_directory, raw_directory_keys, 'SUMMARY_VIEW_RAW_DIRECTORY_FIELDS_CHANGED')
        summary_keys(raw_detail, raw_detail_keys, 'SUMMARY_VIEW_RAW_DETAIL_FIELDS_CHANGED')
        for command, operation, request, raw in [('summary:status', 'status', directory_id, raw_directory),
                                                  ('summary:get', 'detail', detail_id, raw_detail)]:
            need(raw.get('requestId') == request and raw.get('command') == command and raw.get('operation') == operation and
                 raw.get('ok') is True and raw.get('generation') == observed.get('generation') and
                 integer(raw.get('generation')) and raw.get('scope') == observed.get('scope') and string(raw.get('scope')) and
                 string(raw.get('personaId')) and string(raw.get('personaFingerprint')) and
                 integer(raw.get('personaEpoch')) and raw['personaEpoch'] >= 1 and
                 raw['personaId'] + ':' + str(raw['personaEpoch']) + ':' + raw['personaFingerprint'] == raw['scope'] and
                 raw.get('contractVersion') == 'reverie.conversation-summary.v1', 'SUMMARY_VIEW_RAW_REPLY_CORRELATION_CHANGED')
            same_source(raw)
        need(raw_directory.get('conversationId') is None and raw_detail.get('conversationId') == 'dream-room' and
             all(raw_directory.get(key) is False for key in ['enabled', 'authorized', 'hasMore', 'bodyFieldPresent']) and
             integer(raw_directory.get('summaryTotal')) and raw_detail.get('bodyMatchesFixture') is True and
             [raw_directory.get(key) for key in ['status', 'enabled', 'authorized', 'summaryTotal', 'hasMore', 'bodyFieldPresent']] ==
             ['disabled', False, False, 1, False, False] and
             [raw_detail.get(key) for key in ['bodySha256', 'bodyCharacters', 'bodyUtf16Length', 'bodyMatchesFixture']] ==
             [spec['bodySha256'], 54, 54, True], 'SUMMARY_VIEW_RAW_REPLY_BODY_OR_CONSENT_CHANGED')
        messages = [row['id'] for row in report['messages']]
        memories = (report['memoryBatchDelete']['observed']['remainingIds'] if index == 0 else report['memoryPage']['observed']['restartIds'])
        need(len(messages) == len(set(messages)) == 39 and summary_hash(messages) == after['messageIdsSha256'] and
             len(memories) == len(set(memories)) == 127 and summary_hash(memories) == after['memoryIdsSha256'] and
             observed.get('sourceMemoryIds') == memories and
             observed.get('beforeOpeningMemoryIds') == (memories if index == 0 else memories[:100]) and
             observed.get('afterOpeningMemoryIds') == memories[:100] == observed.get('finalMemoryIds') and
             all(observed.get(key) == messages for key in ['beforeOpeningMessageIds', 'afterOpeningMessageIds', 'finalMessageIds']),
             'SUMMARY_VIEW_ORIGINAL_MESSAGE_OR_MEMORY_ORDER_CHANGED')
        for directory in [observed['directoryBefore'], observed['directoryAfter']]:
            summary_keys(directory, ['ok', 'directoryReady', 'conversationId', 'enabled', 'authorized', 'status', 'summaryTotal', 'hasMore', 'summaries'],
                         'SUMMARY_VIEW_DIRECTORY_SNAPSHOT_FIELDS_CHANGED')
            need(directory.get('ok') is True and directory.get('directoryReady') is True and
                 [directory.get(key) for key in ['conversationId', 'enabled', 'authorized', 'status', 'summaryTotal', 'hasMore']] ==
                 ['dream-room', False, False, 'disabled', 1, False] and isinstance(directory.get('summaries'), list) and
                 len(directory['summaries']) == 1, 'SUMMARY_VIEW_DIRECTORY_SNAPSHOT_INVALID')
            row = directory['summaries'][0]
            summary_keys(row, ['summary_id', 'sourceDigest', 'messageIds', 'firstSequence', 'lastSequence', 'contractVersion'],
                         'SUMMARY_VIEW_DIRECTORY_ENTRY_NOT_METADATA_ONLY')
            need(row['summary_id'] == spec['summaryId'] and row['sourceDigest'] == seed['sourceDigest'] and
                 row['contractVersion'] == 'reverie.conversation-summary.v1' and
                 row['messageIds'] == messages[:seed['sourceMessageCount']] and
                 summary_hash(row['messageIds']) == seed['sourceIdsSha256'] and
                 [row['firstSequence'], row['lastSequence']] == [seed['firstSequence'], seed['lastSequence']],
                 'SUMMARY_VIEW_DIRECTORY_SOURCE_IDS_CHANGED')
        need(observed['directoryBefore'] == observed['directoryAfter'], 'SUMMARY_VIEW_EXPLICIT_REFRESH_CHANGED_METADATA')
        for phase in ['afterOpeningPreservation', 'finalPreservation']:
            preserved = observed[phase]
            need(preserved.get('messageCount') == 39 and all(preserved.get(key) is True for key in ['messageIdsMatch',
                 'chatDraftMatches', 'archiveDraftMatches', 'profileAndFormDraftsMatch', 'recallMatches', 'settingsAndPermissionsMatch']) and
                 [preserved.get(key) for key in ['archiveDirty', 'archiveRevision', 'profileDirty']] ==
                 [observed.get(key) for key in ['initialArchiveDirty', 'initialArchiveRevision', 'initialProfileDirty']],
                 'SUMMARY_VIEW_ARCHIVE_PROFILE_CHAT_OR_RECALL_DRAFT_CHANGED')
        inputs = view.get('inputs')
        need(isinstance(inputs, list) and [row.get('control') for row in inputs] == spec['inputs'] and
             [row.get('step') for row in inputs] == SUMMARY_VIEW_DIAGNOSTIC_SPEC['inputSteps'], 'SUMMARY_VIEW_INPUT_SEQUENCE_CHANGED')
        for item in inputs:
            measured = item.get('signals')
            summary_keys(measured, ['controlKind', 'observerValid', 'clickedObserverValid', 'mouseDispatchCount', 'clickedSignals',
                                    'toggledSignals', 'contractReason'], 'SUMMARY_VIEW_SIGNAL_FIELDS_UNKNOWN')
            need(item.get('source') == 'QSignalSpy' and measured.get('observerValid') is True and
                 measured.get('clickedObserverValid') is True and integer(measured.get('mouseDispatchCount')) and
                 integer(measured.get('clickedSignals')) and measured.get('mouseDispatchCount') == 1 and
                 measured.get('clickedSignals') == 1 and measured.get('contractReason') == '' and
                 measured.get('controlKind') == ('tab' if item['control'].startswith('memoryTab-') else 'button') and
                 (measured['toggledSignals'] is None or (integer(measured['toggledSignals']) and measured['toggledSignals'] >= 0)) and
                 item.get('summaryId') == (spec['summaryId'] if item['control'].startswith('summaryDirectoryEntry-') else ''),
                 'SUMMARY_VIEW_INPUT_SIGNAL_UNKNOWN_MISSING_OR_REPEATED')
            need(item.get('reveal', {}).get('expired') is False and item['reveal'].get('geometryValid') is True and
                 item.get('layout', {}).get('ready') is True and item['layout'].get('minimumStableMs') == 40 and
                 item['layout'].get('last', {}).get('layoutStable') is True and
                 item.get('hit', {}).get('hitResult') in ['target', 'descendant'] and item['hit'].get('acceptorFound') is True,
                 'SUMMARY_VIEW_INPUT_LAYOUT_REVEAL_OR_HIT_NOT_OBSERVED')
        presentation_sizes = [('body', [1380, 900])]
        if index == 0:
            presentation_sizes.append(('narrowBody', [760, 650]))
        for prefix, size in presentation_sizes:
            need(all(observed.get(prefix + suffix) is True for suffix in ['Visible', 'WidthFits', 'PlainText', 'ReadOnly', 'MatchesFixture']) and
                 numeric(observed.get(prefix + 'Width')) and numeric(observed.get(prefix + 'WrapperWidth')) and
                 1 < observed[prefix + 'Width'] <= observed[prefix + 'WrapperWidth'] + 1 and
                 [observed.get(prefix + 'WindowWidth'), observed.get(prefix + 'WindowHeight')] == size,
                 'SUMMARY_VIEW_PLAIN_READONLY_BODY_NOT_VISIBLE_OR_FITTING')
        opening_reads = observed.get('openingReads')
        need(integer(observed.get('openingCommandDelta')) and observed['openingCommandDelta'] >= 0 and
             isinstance(opening_reads, list) and all(set(row) == {'requestId', 'command', 'generation'} and
                 row.get('generation') == observed['generation'] and row.get('command') in
                 ['archive:get', 'memory:list', 'memory:candidates:list', 'summary:status', 'user:profile:get'] for row in opening_reads) and
             sum(row.get('requestId') == opening_id and row.get('command') == 'summary:status' for row in opening_reads) == 1,
             'SUMMARY_VIEW_OPENING_CONTAINS_NON_READ_OR_MISSING_DIRECTORY')
        for request in [opening_id, directory_id]:
            status = [row for row in status_results if row['cycle'] == cycle and row['requestId'] == request]
            sent = [row for row in status_dispatches if row['cycle'] == cycle and row['requestId'] == request]
            need(len(status) == len(sent) == 1, 'SUMMARY_VIEW_DIRECTORY_AUTHENTICATED_RECEIPT_MISSING_OR_REPEATED')
            disabled(status[0])
            disabled(sent[0])
            same_source(status[0])
            need(all(status[0].get(key) is True for key in ['ok', 'operationMatches', 'fixturePresent', 'resultStatusDisabled']) and
                 status[0].get('resultEnabled') is False and status[0].get('resultAuthorized') is False and
                 integer(status[0].get('activeCount')) and integer(status[0].get('summaryTotal')) and
                 [status[0].get(key) for key in ['status', 'resultEnabled', 'resultAuthorized', 'activeCount', 'summaryTotal']] ==
                 ['disabled', False, False, 1, 1], 'SUMMARY_VIEW_ACTUAL_DIRECTORY_RESULT_CHANGED')
        for row in [dispatches[index], responses[index]]:
            disabled(row)
            need(row.get('requestId') == detail_id and integer(row.get('readCount')) and row.get('readCount') == 1 and row.get('summaryId') == spec['summaryId'],
                 'SUMMARY_VIEW_ACTUAL_BODY_REQUEST_CHANGED')
        response = responses[index]
        need(dispatches[index].get('idMatches') is True and all(response.get(key) is True for key in
             ['ok', 'idMatches', 'operationMatches', 'fixtureMatches', 'sourceMatches', 'statusMatches']) and
             [response.get(key) for key in ['bodySha256', 'bodyCharacters']] == [spec['bodySha256'], 54],
             'SUMMARY_VIEW_ACTUAL_BODY_RESULT_CHANGED')
        same_source(response)
        own_status = next(row for row in status_results if row['cycle'] == cycle and row['requestId'] == directory_id)
        own_sent = next(row for row in status_dispatches if row['cycle'] == cycle and row['requestId'] == directory_id)
        need(own_sent['monotonic_ns'] <= own_status['monotonic_ns'] <= dispatches[index]['monotonic_ns'] <= response['monotonic_ns'] and
             (seed if index == 0 else restart)['monotonic_ns'] <= dispatches[index]['monotonic_ns'],
             'SUMMARY_VIEW_AUTHENTICATED_EVENT_ORDER_CHANGED')
        read_identities.append({'cycle': cycle, 'scope': observed['scope'], 'generation': observed['generation'],
                               'directoryRequestId': directory_id, 'detailRequestId': detail_id})
    need(len(set(request_ids + recall_ids)) == 6 and len(selected('summary_view_dispatched')) == 2,
         'SUMMARY_VIEW_RECALL_AND_BODY_REQUESTS_NOT_DISTINCT')
    proof = {'schema': SUMMARY_VIEW_DIAGNOSTIC_SPEC['hostVerdictSchema'], 'passed': True, 'contentCollected': False,
             'checkCounts': [9, 8], 'summaryId': spec['summaryId'], 'bodySha256': spec['bodySha256'], 'bodyCharacters': 54,
             'sourceDigest': seed['sourceDigest'], 'sourceIdsSha256': seed['sourceIdsSha256'],
             'sourceMessageCount': seed['sourceMessageCount'], 'firstSequence': seed['firstSequence'], 'lastSequence': seed['lastSequence'],
             'originalMessageIdsSha256': after['messageIdsSha256'], 'survivingMemoryIdsSha256': after['memoryIdsSha256'],
             'readIdentities': read_identities, 'seedsPerCycle': [1, 0], 'bodyReadsPerCycle': [1, 1],
             'explicitDirectoryRefreshesPerCycle': [1, 1], 'addedHttpRequests': 0, 'addedRecallQueries': 0,
             'originalMessageCount': 39, 'survivingMemoryCount': 127, 'actualModelMessagesExcludeSummary': True}
    need(fixture.get('verdict') == proof, 'SUMMARY_VIEW_HOST_COMPACT_PROOF_DIFFERS_FROM_INDEPENDENT_VERIFIER')
    screenshots = []
    for name in SUMMARY_VIEW_DIAGNOSTIC_SPEC['summaryScreenshots']:
        path = report_root / name
        need(path.is_file() and not path.is_symlink() and path.stat().st_size > 8 and
             path.read_bytes()[:8] == b'\x89PNG\r\n\x1a\n', 'SUMMARY_VIEW_SCREENSHOT_MISSING:' + name)
        screenshots.append({'file': name, 'sha256': sha(path), 'bytes': path.stat().st_size})
    return {'independentlyVerified': True, 'checkCounts': [9, 8], 'bodyReadsPerCycle': [1, 1], 'explicitRefreshesPerCycle': [1, 1],
            'seedCounts': [1, 0], 'bodySha256': spec['bodySha256'], 'bodyCharacters': 54,
            'sourceDigest': seed['sourceDigest'], 'sourceIdsSha256': seed['sourceIdsSha256'],
            'sourceMessageCount': seed['sourceMessageCount'], 'originalMessageCount': 39, 'activeMemoryCount': 127,
            'physicalMemoryRowsPreserved': after['memoryTables']['memory_records']['count'],
            'modelMarkerAbsentFromActualMessages': True, 'modelSummarySectionAbsentFromActualMessages': True,
            'freshReportRoot': True, 'rawCyclesEqualEmbeddedReports': True, 'currentBuildBound': True,
            'cycleFiles': cycle_files, 'screenshots': screenshots, 'contentCollected': False}
