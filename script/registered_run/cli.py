"""Public CLI. Local and registered commands use the same stages and checks."""
from __future__ import annotations

import argparse
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import sys

if __package__ in (None, ''):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    __package__ = 'script.registered_run'

from .config import load_config, unit_selection, validate_config


def _write(path, value):
    with Path(path).open('x', encoding='utf-8') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write('\n')


def _meta(root, path):
    return {'path': str(Path(path).relative_to(root)), 'sha256': hashlib.sha256(Path(path).read_bytes()).hexdigest(),
            'bytes': Path(path).stat().st_size}


def verify_local_build_source(root, package):
    """Reject stale local binaries even when uncommitted HEAD is unchanged."""
    from .source import snapshot_source
    build = root / '.tools/qt-builds' / ('local-' + package)
    record = json.loads((build / 'build.json').read_text())
    if record.get('localIteration', {}).get('package') != package or record.get('candidate') is not None:
        raise ValueError('LOCAL_BUILD_NOT_BOUND_TO_PACKAGE')
    inventory = json.loads((build / 'source-inventory.json').read_text())
    payload = json.dumps(inventory, ensure_ascii=False, separators=(',', ':')).encode()
    if hashlib.sha256(payload).hexdigest() != record['source']['inventory']['sha256']:
        raise ValueError('LOCAL_BUILD_INVENTORY_CHANGED')
    expected = {row['path']: row for row in inventory if row['path'] != '.c2cignore'
                and not row['path'].startswith(('data/', 'outputs/')) and row['path'] not in ('data', 'outputs')}
    actual = snapshot_source(root)
    if set(expected) != {row['path'] for row in actual['files']}:
        raise ValueError('LOCAL_BUILD_SOURCE_SET_CHANGED_REBUILD_REQUIRED')
    for row in actual['files']:
        before = expected[row['path']]
        if row['mode'] == '120000':
            import os
            matched = before.get('type') == 'link' and before.get('target') == os.readlink(root / row['path'])
        else:
            matched = before.get('type') == 'file' and before.get('bytes') == row['bytes'] and before.get('sha256') == row['sha256']
        if not matched:
            raise ValueError('LOCAL_BUILD_SOURCE_CHANGED_REBUILD_REQUIRED:' + row['path'])
    return actual


def run_local_command(args, root):
    from .engine import run_local
    from .stages import plan, load_runtime_config
    from .identities import collect_saved_outputs, require_actual_collection, require_all_passed
    config = load_config(args.config)
    config['package'] = args.package
    if args.qml_cache is not None:
        if args.category != 'native':
            raise ValueError('CACHE_COMPARISON_REQUIRES_FOCUSED_NATIVE')
        config['measurement'] = {'qmlCacheEnabled': args.qml_cache == 'on'}
    selections = args.select or []
    from .local_header_frame import requested as header_frame_requested, run_command as run_header_frame
    if header_frame_requested(selections):
        return run_header_frame(args, root, config, verify_build=verify_local_build_source)
    if getattr(args, 'header_frame_screenshot', 'none') != 'none':
        raise ValueError('HEADER_FRAME_SCREENSHOT_REQUIRES_LOCAL_DIAGNOSTIC')
    if args.category == 'gui':
        from .preview import enabled, effective_modes, require_current, OPTION
        from .state import gui_selection_options
        if enabled(config) and not selections:
            # Bind all eight to authorization/failure tracking before planning.
            selections = list(effective_modes(config))
        if enabled(config) and OPTION in gui_selection_options(selections):
            require_current(config)
    journal_selection = unit_selection(config) if args.category == 'full' else selections
    command = [str(root / '.venv/bin/python'), '-I', '-B', str(root / 'script/registered_run/cli.py'),
               'local', '--package', args.package, '--category', args.category, '--config', str(args.config)]
    for selected in selections:
        command += ['--select', selected]
    if args.diagnostic:
        command.append('--diagnostic')
    if args.qml_cache is not None:
        command += ['--qml-cache', args.qml_cache]

    def factory(project, output, environment):
        if args.category == 'replay':
            return []
        if args.category in ('native', 'gui', 'full'):
            verify_local_build_source(project, args.package)
        return plan(project, output, config, environment, args.category, selections)

    def finalize(project, output, environment):
        if args.category == 'replay':
            from .catalog import replay_saved, RunContext
            baseline = config.get('baselineSource', {}).get('report')
            if not baseline:
                raise ValueError('REPLAY_BASELINE_REQUIRED')
            path = (project / baseline).resolve(strict=True)
            if not path.is_relative_to(project / '.tools/reports'):
                raise ValueError('REPLAY_REPORT_OUTSIDE_REGISTERED_REPORTS')
            result = replay_saved(RunContext(project, path, config), selections or None)
            _write(output / 'replay.json', result)
            return {'replayInputs': config['baselineSource'], 'replay': result,
                    'counts': {'savedStages': len(result['stages'])}, 'acceptanceEligible': False}
        runtime = load_runtime_config(output)
        if args.category == 'full':
            manifest = collect_saved_outputs(output, runtime, project)
            require_all_passed(manifest)
            require_actual_collection(manifest)
            path = output / 'identities.json'
            _write(path, manifest)
            return {'identityManifest': _meta(project, path), 'unitSelection': unit_selection(runtime),
                    'counts': manifest['counts'], 'acceptanceEligible': False}
        if args.category == 'gui':
            return {'guiModes': selections or [row['stage'].removesuffix('-check') for row in config['guiModes']],
                    'acceptanceEligible': False}
        if args.category == 'native' and (output / 'qtest-measurements.json').exists():
            return {'measurements': _meta(project, output / 'qtest-measurements.json'), 'acceptanceEligible': False}
        return {'acceptanceEligible': False}

    result = run_local(root, args.package, args.category, journal_selection,
                       diagnostic=args.diagnostic, stage_factory=factory, action=finalize, command=command)
    row = result['localRun']
    print(json.dumps({'passed': result['passed'], 'acceptance': False, 'sequence': row['sequence'],
                      'outputDirectory': result['outputDirectory'], 'stopReason': result.get('stopReason'),
                      'counts': row['counts']}, ensure_ascii=False))
    return 0 if result['passed'] else 1


def run_audit_command(args, root):
    """Audit the working test source through the same guarded local journal."""
    from .engine import run_local
    from .source import snapshot_source
    from .baseline import load_signed_baseline
    from .registration import _git_paths, _is_test_scope
    from .identities import signed_baseline, safe_relative_path
    from .test_audit import audit_test_changes, read_git_sources, require_confirmed_audit
    from .protected_data import assert_protected_data
    config = load_config(args.config)

    def action(project, output, environment):
        baseline_path = config['baselineSource']['report']
        baseline, _ = load_signed_baseline(project, project / safe_relative_path(baseline_path))
        protected = assert_protected_data(project, baseline['protectedTrackedData'])
        source = snapshot_source(project)
        explicit = {p for key in ('pythonTargets', 'nodeTests', 'frontendTests') for p in baseline[key]}
        explicit.update(config.get('testAuditPaths', []))
        for p in explicit:
            safe_relative_path(p)
        suffixes = ('.py', '.cjs', '.mjs', '.js', '.ts', '.tsx', '.cpp', '.cc', '.cxx', '.h', '.hpp', '.json')
        before_paths = [p for p in _git_paths(project, baseline['sourceHead'])
                        if p.endswith(suffixes) and _is_test_scope(p, explicit)]
        after_paths = [p['path'] for p in source['files']
                       if p['path'].endswith(suffixes) and _is_test_scope(p['path'], explicit)]
        before = read_git_sources(project, baseline['sourceHead'], before_paths)
        after = {p: (project / p).read_text() for p in after_paths}
        direction = config.get('testChangeDirectionDocument')
        if direction is not None:
            document = project / safe_relative_path(direction['path'])
            if hashlib.sha256(document.read_bytes()).hexdigest() != direction['sha256']:
                raise ValueError('TEST_CHANGE_DIRECTION_DOCUMENT_HASH_CHANGED')
        report = audit_test_changes(before, after, signed_baseline(baseline),
            confirmations=config.get('confirmedTestChanges', []), direction_document=direction,
            repository_root=project, node=str(project / config['node']))
        report['sourceHead'] = source['head']
        report['sourceTreeHash'] = source['treeHash']
        report['codeTreeHash'] = source['codeTreeHash']
        report['scopePaths'] = {'before': before_paths, 'after': after_paths}
        report['protectedDataMetadata'] = protected
        report['protectedDataMetadataUnchanged'] = True
        _write(output / 'test-change-audit.json', report)
        require_confirmed_audit(report)
        return {'testChangeAudit': _meta(project, output / 'test-change-audit.json'),
                'acceptanceEligible': False, 'counts': {'signedChanges': len(report['signedChanges']),
                'otherChanges': len(report['otherChanges']), 'changedFiles': len(report['changedFiles'])}}

    command = [str(root / '.venv/bin/python'), '-I', '-B', str(root / 'script/registered_run/cli.py'),
               'audit-tests', '--package', args.package, '--config', str(args.config)]
    result = run_local(root, args.package, 'replay', ['test-change-audit'], action=action, command=command)
    print(json.dumps({'passed': result['passed'], 'acceptance': False, 'sequence': result['localRun']['sequence'],
                      'outputDirectory': result['outputDirectory'], 'stopReason': result.get('stopReason'),
                      'counts': result['localRun']['counts']}, ensure_ascii=False))
    return 0 if result['passed'] else 1


def parser():
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[2])
    sub = result.add_subparsers(dest='operation', required=True)
    export = sub.add_parser('export-config')
    export.add_argument('--baseline', type=Path, required=True)
    export.add_argument('--output', type=Path, required=True)
    export.add_argument('--include-tool-tests', action='store_true')
    local = sub.add_parser('local')
    local.add_argument('--package', required=True)
    local.add_argument('--config', type=Path, required=True)
    local.add_argument('--category', choices=['build', 'python', 'node', 'frontend', 'native', 'gui', 'replay', 'full'], required=True)
    local.add_argument('--select', action='append')
    local.add_argument('--diagnostic', action='store_true')
    local.add_argument('--header-frame-screenshot', choices=['none', 'memory-open'], default='none')
    local.add_argument('--qml-cache', choices=['on', 'off'])
    freeze = sub.add_parser('freeze')
    freeze.add_argument('--package', required=True)
    freeze.add_argument('--config', type=Path, required=True)
    freeze.add_argument('--report', type=Path, required=True)
    freeze.add_argument('--contract-sha256', help='Require the contract hash returned by a prior read-only rehearsal')
    rehearse = sub.add_parser('rehearse')
    rehearse.add_argument('--package', required=True)
    rehearse.add_argument('--config', type=Path, required=True)
    rehearse.add_argument('--report', type=Path, required=True, help='Proposed registration directory; not created')
    rehearse.add_argument('--output', type=Path, required=True, help='New directory under this local package')
    authorize = sub.add_parser('authorize')
    authorize.add_argument('--report', type=Path, required=True)
    authorize.add_argument('--user-approval-text', required=True)
    run = sub.add_parser('run')
    run.add_argument('--report', type=Path, required=True)
    void = sub.add_parser('void')
    void.add_argument('--id', required=True)
    void.add_argument('--reason', required=True)
    suggest = sub.add_parser('suggest-gui')
    suggest.add_argument('paths', nargs='+')
    analyze = sub.add_parser('analyze-local')
    analyze.add_argument('--package', required=True)
    analyze.add_argument('--sequence', action='append', type=int, required=True)
    analyze.add_argument('--note', required=True)
    analyze.add_argument('--reported-to-user', action='store_true')
    audit = sub.add_parser('audit-tests')
    audit.add_argument('--package', required=True)
    audit.add_argument('--config', type=Path, required=True)
    return result


def main(argv=None):
    args = parser().parse_args(argv)
    root = args.root.resolve(strict=True)
    if args.operation == 'local':
        return run_local_command(args, root)
    if args.operation == 'audit-tests':
        return run_audit_command(args, root)
    if args.operation == 'export-config':
        from .export_config import export_baseline
        value = export_baseline(args.baseline, root)
        value['nodeIdentityReport'] = 'node-identities.jsonl'
        value['requiredGuiModes'] = [x['stage'].removesuffix('-check') for x in value['guiModes']]
        if args.include_tool_tests:
            value['pythonTargets'] = list(dict.fromkeys([*value['pythonTargets'], *[str(x.relative_to(root)) for x in sorted((root / 'tests').glob('test_registered_run_*.py'))]]))
            value['nodeTests'] = list(dict.fromkeys([*value['nodeTests'], 'script/build-qt-macos.test.cjs']))
        validate_config(value, root)
        _write(args.output, value)
        print(json.dumps({'config': str(args.output), 'acceptance': False}, ensure_ascii=False))
    elif args.operation == 'suggest-gui':
        from .coverage import suggest_modes
        print(json.dumps(suggest_modes(args.paths, root=root), ensure_ascii=False))
    elif args.operation == 'analyze-local':
        from .state import ExecutionLock, LocalLedger, RegistrationState, package_name
        package_name(args.package)
        with ExecutionLock(root) as lock:
            RegistrationState(root, lock).assert_no_active()
            with LocalLedger(root / '.tools/local' / args.package) as journal:
                journal.append_analysis(args.sequence, args.note, reported_to_user=args.reported_to_user)
        print(json.dumps({'recorded': True, 'failureSequences': args.sequence,
                          'failureRowsPreserved': True, 'acceptance': False}))
    else:
        from . import registration
        if args.operation == 'freeze':
            value = registration.freeze(root, args.package, load_config(args.config), args.report,
                                        expected_contract_sha256=args.contract_sha256)
        elif args.operation == 'rehearse':
            value = registration.rehearsal(root, args.package, load_config(args.config), args.report, args.output)
        elif args.operation == 'authorize':
            value = registration.authorize_registration(root, args.report, args.user_approval_text)
        elif args.operation == 'run':
            value = registration.run_registered(root, args.report)
        else:
            value = registration.void_registration(root, args.id, args.reason)
        print(json.dumps(value, ensure_ascii=False))
        if args.operation == 'run':
            return 0 if value.get('passed') else 1
    return 0


if __name__ == '__main__':
    # Direct -I invocation deliberately adds only the known repository root.
    raise SystemExit(main())
