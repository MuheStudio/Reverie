"""W4 boundary/ownership tests; Node calls use pure functions and fake children."""
from __future__ import annotations

import hashlib
import json
import struct
import base64
from pathlib import Path
import subprocess
from types import SimpleNamespace

import pytest

from script.registered_run import cli, engine, local_header_frame as diagnostic


ROOT = Path(__file__).resolve().parents[1]
DRIVER = ROOT / 'native-ui/check-header-frame-local.cjs'
OUTPUT = '/repo/.tools/local/preview-header-frame-20261102/runs/000001-' + 'a' * 32
DRIVER_USAGE = ('Local diagnostic only: --package preview-header-frame-20261102 --variant '
                'baseline|reduced-transparency|half-resolution|drawer-background-off|blur-half-resolution|gpu-positive-control '
                '--size wide --screenshot none|memory-open --output-dir ABS_CURRENT_LOCAL_RUN')


def request(variant='baseline'):
    return SimpleNamespace(package=diagnostic.PACKAGE, category='gui', diagnostic=True,
                           qml_cache=None, header_frame_screenshot='none',
                           select=['drawer-frame::' + variant + '::wide'], config=Path('config.json'))


def local_config():
    directory = '.tools/qt-builds/local-' + diagnostic.PACKAGE
    return {'package': diagnostic.PACKAGE, 'runKind': 'local', 'adoptCandidate': False,
            'candidateName': None, 'cmakeDirectory': directory, 'candidateDirectory': directory,
            'node': '.tools/node/bin/node'}


def metadata():
    options = {'package': diagnostic.PACKAGE, 'variant': 'baseline', 'windowSize': 'wide',
               'screenshot': 'none', 'outputDirectory': OUTPUT}
    marker = {'schema': 'reverie.active-local-run.v1', 'runId': 'b' * 32, 'ownerPid': 4321,
              'metadata': {'package': diagnostic.PACKAGE, 'outputDirectory': OUTPUT}}
    build = {'schema': 'reverie.qt.local-build.v2', 'candidate': None,
             'localIteration': {'package': diagnostic.PACKAGE, 'acceptanceEligible': False},
             'diagnostics': {'ordinaryLauncherAllowed': True, 'qmlProfilerEnabled': False, 'timingProbesEnabled': False},
             'compilation': {'cmakeDirectory': '/repo/.tools/qt-builds/local-' + diagnostic.PACKAGE}}
    return {'root': '/repo', 'options': options, 'marker': marker, 'build': build}


def node_call(source, value):
    program = ('const api=require(' + json.dumps(str(DRIVER)) + ');'
               'const input=JSON.parse(require("node:fs").readFileSync(0,"utf8"));'
               '(async()=>{' + source + '})().then(value=>process.stdout.write(JSON.stringify({ok:true,value})))'
               '.catch(error=>process.stdout.write(JSON.stringify({ok:false,error:String(error.message)})));')
    completed = subprocess.run([str(ROOT / '.tools/node/bin/node'), '-e', program],
                               input=json.dumps(value), capture_output=True, text=True, timeout=10, cwd=ROOT)
    assert completed.returncode == 0, completed.stderr
    return json.loads(completed.stdout)


def saved_summary(tmp_path):
    scene_path = tmp_path / 'header-frame.scene.json'
    scene_payload = (json.dumps({'schema': diagnostic.SCENE_SCHEMA}) + '\n').encode()
    scene_path.write_bytes(scene_payload)
    summary = {'schema': diagnostic.SUMMARY_SCHEMA, 'package': diagnostic.PACKAGE,
        'variant': 'baseline', 'windowSize': 'wide', 'acceptanceEligible': False, 'performanceComparable': False,
        'scenario': 'drawer-cycles', 'screenshotRequested': 'none',
        'diagnostic': True, 'executionComplete': True, 'passed': True, 'noResidualProcesses': True,
        'testDataRemoved': True, 'keyCleanupCompleted': True, 'applicationUnchanged': True,
        'modelInputUnchanged': True, 'allOwnedExitedNormally': True, 'forcedCleanup': False, 'interrupted': False,
        'outputDirectory': str(tmp_path), 'windowCount': 40,
        'scene': {'path': str(scene_path), 'schema': diagnostic.SCENE_SCHEMA, 'bytes': len(scene_payload),
                  'sha256': hashlib.sha256(scene_payload).hexdigest()}}
    (tmp_path / diagnostic.SUMMARY_NAME).write_text(json.dumps(summary))
    return summary


@pytest.mark.parametrize('selection,expected', [([], False), (['ordinary'], False),
    (['drawer-frame::baseline::wide'], True), (['drawer-frame-invalid'], True)])
def test_only_explicit_header_frame_selectors_use_the_local_extension(selection, expected):
    assert diagnostic.requested(['drawer-frame::baseline::wide']) is True
    assert diagnostic.requested(selection) is expected


@pytest.mark.parametrize('variant', diagnostic.VARIANTS)
def test_w4_request_accepts_each_implemented_wide_variant(variant):
    assert diagnostic.validate_request(request(variant), local_config()) == variant


@pytest.mark.parametrize('field,value,reason', [
    ('package', 'another-package', 'HEADER_FRAME_REQUIRES_EXPLICIT_LOCAL_DIAGNOSTIC'),
    ('category', 'full', 'HEADER_FRAME_REQUIRES_EXPLICIT_LOCAL_DIAGNOSTIC'),
    ('diagnostic', False, 'HEADER_FRAME_REQUIRES_EXPLICIT_LOCAL_DIAGNOSTIC'),
    ('qml_cache', 'on', 'HEADER_FRAME_CACHE_OVERRIDE_FORBIDDEN'),
    ('select', [], 'HEADER_FRAME_ONE_VARIANT_REQUIRED'),
    ('select', ['drawer-frame::baseline::wide', 'ordinary'], 'HEADER_FRAME_ONE_VARIANT_REQUIRED'),
    ('select', ['drawer-frame::live2d-off::wide'], 'HEADER_FRAME_VARIANT_NOT_AUTHORIZED'),
    ('select', ['drawer-frame::baseline::narrow'], 'HEADER_FRAME_VARIANT_NOT_AUTHORIZED')])
def test_w4_request_rejects_scope_changes_before_execution(field, value, reason):
    args = request()
    assert diagnostic.validate_request(args, local_config()) == 'baseline'
    setattr(args, field, value)
    with pytest.raises(ValueError, match='^' + reason + '$'):
        diagnostic.validate_request(args, local_config())


@pytest.mark.parametrize('field,value', [('runKind', 'formal'), ('adoptCandidate', True),
    ('candidateName', 'registered-candidate'), ('cmakeDirectory', '.tools/qt-builds/registered'),
    ('candidateDirectory', '.tools/qt-candidates/formal')])
def test_w4_rejects_registered_configuration(field, value):
    config = local_config()
    assert diagnostic.validate_request(request(), config) == 'baseline'
    config[field] = value
    with pytest.raises(ValueError, match='^HEADER_FRAME_LOCAL_CONFIGURATION_REQUIRED$'):
        diagnostic.validate_request(request(), config)


def test_cli_local_extension_dispatches_only_the_explicit_selector(tmp_path, monkeypatch):
    called = []
    monkeypatch.setattr(cli, 'load_config', lambda _path: local_config())
    monkeypatch.setattr(diagnostic, 'run_command', lambda args, root, config, **kw:
                        called.append((args.select, root, config['package'], kw['verify_build'])) or 7)
    assert cli.run_local_command(request(), tmp_path) == 7
    assert called == [(['drawer-frame::baseline::wide'], tmp_path, diagnostic.PACKAGE, cli.verify_local_build_source)]


@pytest.mark.parametrize('category,selection', [('python', 'tests/test_example.py'), ('gui', 'persona')])
def test_existing_local_selection_keeps_the_original_runner(tmp_path, monkeypatch, category, selection):
    config = local_config()
    args = request()
    args.category, args.select, args.diagnostic = category, [selection], False
    observed = []
    monkeypatch.setattr(cli, 'load_config', lambda _path: config)
    monkeypatch.setattr(diagnostic, 'run_command', lambda *args, **kw: pytest.fail('Unexpected W4 dispatch'))

    def run(root, package, category, selection, **kwargs):
        observed.append((category, selection, kwargs['diagnostic']))
        return {'passed': True, 'outputDirectory': str(tmp_path), 'localRun': {'sequence': 1, 'counts': {}}}

    monkeypatch.setattr(engine, 'run_local', run)
    assert cli.run_local_command(args, tmp_path) == 0
    assert observed == [(category, [selection], False)]


def test_w4_factory_uses_guarded_local_engine_and_current_build(tmp_path, monkeypatch):
    build_checks = []

    def run(root, package, category, selection, **kwargs):
        assert package == diagnostic.PACKAGE and category == 'gui'
        assert selection == ['drawer-frame::baseline::wide'] and kwargs['diagnostic'] is True
        stages = kwargs['stage_factory'](root, tmp_path, {'TMPDIR': '/owned/tmp/'})
        assert len(stages) == 1
        stage = stages[0]
        assert stage.capture_pointer is False and stage.check_category == 'gui'
        assert stage.selection == selection and stage.env == {'TMPDIR': '/owned/tmp/'}
        assert stage.command[1] == str(root / 'native-ui/check-header-frame-local.cjs')
        assert stage.command[-2:] == ['--output-dir', str(tmp_path)]
        assert '--diagnostic' in kwargs['command']
        return {'passed': True, 'outputDirectory': str(tmp_path), 'localRun': {'sequence': 1, 'counts': {}}}

    monkeypatch.setattr(diagnostic, 'run_local', run)
    assert diagnostic.run_command(request(), tmp_path, local_config(),
        verify_build=lambda root, package: build_checks.append((root, package))) == 0
    assert build_checks == [(tmp_path, diagnostic.PACKAGE)]


@pytest.mark.parametrize('field,value', [('diagnostic', False), ('forcedCleanup', True),
    ('testDataRemoved', False), ('noResidualProcesses', False), ('keyCleanupCompleted', False),
    ('acceptanceEligible', 0), ('performanceComparable', True), ('windowCount', 39), ('allOwnedExitedNormally', False)])
def test_local_summary_cannot_promote_incomplete_or_malformed_evidence(tmp_path, field, value):
    summary = saved_summary(tmp_path)
    assert diagnostic.read_summary(tmp_path, 'baseline')[0] == summary
    summary[field] = value
    (tmp_path / diagnostic.SUMMARY_NAME).write_text(json.dumps(summary))
    reason = 'HEADER_FRAME_OUTPUT_OR_COUNT_CHANGED' if field == 'windowCount' else 'HEADER_FRAME_LOCAL_DIAGNOSTIC_INCOMPLETE'
    with pytest.raises(ValueError, match='^' + reason + '$'):
        diagnostic.read_summary(tmp_path, 'baseline')


def test_local_summary_retains_and_rechecks_the_exact_saved_scene(tmp_path):
    summary = saved_summary(tmp_path)
    scene_path = tmp_path / 'header-frame.scene.json'
    scene_payload = scene_path.read_bytes()
    assert diagnostic.read_summary(tmp_path, 'baseline')[0] == summary
    scene_path.write_bytes(scene_payload + b' ')
    with pytest.raises(ValueError, match='^HEADER_FRAME_SCENE_BYTES_CHANGED$'):
        diagnostic.read_summary(tmp_path, 'baseline')


def test_driver_accepts_only_the_closed_local_arguments():
    args = ['--package', diagnostic.PACKAGE, '--variant', 'baseline', '--size', 'wide',
            '--screenshot', 'none', '--output-dir', OUTPUT]
    observed = node_call('return api.parseArguments(input);', args)
    assert observed['ok'] is True and observed['value']['variant'] == 'baseline'


@pytest.mark.parametrize('suffix', [['--record'], ['--workspace', '/private/workspace'],
    ['--variant', 'baseline'], ['--build-dir', '/registered'], ['--mode', 'diagnostic']])
def test_driver_rejects_unknown_duplicate_or_product_arguments(suffix):
    args = ['--package', diagnostic.PACKAGE, '--variant', 'baseline', '--size', 'wide',
            '--screenshot', 'none', '--output-dir', OUTPUT]
    baseline = node_call('return api.parseArguments(input);', args)
    assert baseline['ok'] is True and baseline['value']['outputDirectory'] == OUTPUT
    assert node_call('return api.parseArguments(input);', args + suffix) == {'ok': False, 'error': DRIVER_USAGE}


@pytest.mark.parametrize('mutation', ['marker-kind', 'parent', 'package', 'output', 'candidate', 'build-package', 'profiler'])
def test_driver_metadata_refuses_nonlocal_or_different_run(mutation):
    value = metadata()
    baseline = node_call('return api.validateLocalMetadata(input.root,input.options,input.marker,input.build,4321);', value)
    assert baseline['ok'] is True and baseline['value']['kind'] == 'local'
    if mutation == 'marker-kind':
        value['marker']['schema'] = 'reverie.active-registration.v1'
    elif mutation == 'parent':
        value['marker']['ownerPid'] = 9999
    elif mutation == 'package':
        value['marker']['metadata']['package'] = 'another-package'
    elif mutation == 'output':
        value['marker']['metadata']['outputDirectory'] = '/another/run'
    elif mutation == 'candidate':
        value['build']['candidate'] = 'registered-candidate'
    elif mutation == 'build-package':
        value['build']['localIteration']['package'] = 'another-package'
    else:
        value['build']['diagnostics']['qmlProfilerEnabled'] = True
    reason = ('W4 requires the current parent-owned local run' if mutation in ('marker-kind', 'parent', 'package', 'output')
              else 'W4 requires this package local build')
    assert node_call('return api.validateLocalMetadata(input.root,input.options,input.marker,input.build,4321);', value) == {
        'ok': False, 'error': reason}


def test_driver_local_context_and_app_environment_are_created_from_owned_metadata():
    result = node_call('const w4=api.validateLocalMetadata(input.root,input.options,input.marker,input.build,4321);'
        'const env=api.appEnvironment(input.options,w4,{HF_HUB_OFFLINE:"1"});'
        'return {w4,env};', metadata())
    assert result['ok'] is True
    assert result['value']['w4']['kind'] == 'local' and result['value']['w4']['diagnostic'] is True
    assert result['value']['env']['REVERIE_HEADER_FRAME_LOCAL'] == '1'
    assert 'QT_QPA_PLATFORM' not in result['value']['env']


@pytest.mark.parametrize('key', ['REVERIE_HEADER_FRAME_LOCAL', 'REVERIE_HEADER_FRAME_VARIANT', 'REVERIE_HEADER_FRAME_UNKNOWN'])
def test_driver_rejects_inherited_w4_environment_instead_of_reusing_it(key):
    value = metadata()
    baseline = node_call('const w4=api.validateLocalMetadata(input.root,input.options,input.marker,input.build,4321);'
        'return api.appEnvironment(input.options,w4,{});', value)
    assert baseline['ok'] is True and baseline['value']['REVERIE_HEADER_FRAME_LOCAL'] == '1'
    value['ambient'] = {key: 'untrusted'}
    assert node_call('const w4=api.validateLocalMetadata(input.root,input.options,input.marker,input.build,4321);'
        'return api.appEnvironment(input.options,w4,input.ambient);', value) == {
            'ok': False, 'error': 'Ambient W4 variables are forbidden'}


@pytest.mark.parametrize('endpoint', ['https://127.0.0.1:1234/v1', 'http://example.com:1234/v1',
    'http://127.0.0.1:1234/v1?workspace=private'])
def test_driver_refuses_nonowned_model_endpoints(endpoint):
    source = ('return api.nativeArguments("/repo","/owned/data","/owned/context",'
              '"/owned/scene",input,"/owned/model");')
    baseline = node_call(source, 'http://127.0.0.1:1234/v1')
    assert baseline['ok'] is True and '--perf-report' in baseline['value']
    assert node_call(source, endpoint) == {'ok': False, 'error': 'Owned loopback endpoint required'}


def test_native_performance_mode_does_not_enable_old_gpu_collector_or_recording():
    value = node_call('return api.nativeArguments("/repo","/owned/data","/owned/context",'
        '"/owned/scene","http://127.0.0.1:1234/v1","/owned/model");', None)['value']
    assert value[value.index('--perf-mode') + 1] == 'perf'
    assert value[value.index('--perf-rows') + 1] == '9'
    assert not any(flag in value for flag in ('--diagnostic-case', '--record-ui', '--workspace', '--test-report'))


def test_driver_checks_all_forty_individual_windows_without_stress_thresholds():
    value = metadata()
    value['scene'] = {'schema': diagnostic.SCENE_SCHEMA, 'package': diagnostic.PACKAGE, 'variant': 'baseline',
        'scenario': 'drawer-cycles',
        'windowSize': 'wide', 'windowWidth': 1380, 'windowHeight': 900,
        'completed': True, 'acceptanceEligible': False, 'performanceComparable': False,
        'windows': [{'feature': feature, 'cycle': cycle, 'openClickNs': 0, 'openCompleteNs': 10,
                     'closeClickNs': 20, 'closeCompleteNs': 30}
                    for feature in ('memory', 'settings') for cycle in range(1, 21)]}
    baseline = node_call('return api.validateScene(input.scene,input.options);', value)
    assert baseline == {'ok': True, 'value': 40}
    value['scene']['windows'][39]['cycle'] = 19
    assert node_call('return api.validateScene(input.scene,input.options);', value) == {
        'ok': False, 'error': 'W4 cycles duplicated or missing'}


def test_inventory_digest_ignores_object_key_order_and_rejects_changed_digest():
    result = node_call('const entries=[];const expected=require("./native-ui/build-record.cjs").digest(entries);'
        'if(!api.inventoryUnchanged(entries,expected))throw Error("Fresh inventory baseline failed");'
        'const reordered={count:expected.count,sha256:expected.sha256,digestKind:expected.digestKind};'
        'const reorderedAccepted=api.inventoryUnchanged(entries,reordered);'
        'reordered.sha256="0".repeat(64);return {reorderedAccepted,changedAccepted:api.inventoryUnchanged(entries,reordered)};', None)
    assert result == {'ok': True, 'value': {'reorderedAccepted': True, 'changedAccepted': False}}


def normal_cleanup_result():
    return node_call('const events=[];let live=[{pid:7}];const running={rootIdentity:{pid:7},cycle:"owned-app",'
        'child:{exitCode:null,signalCode:null}};const result=await api.settleOwned(running,{remaining:()=>live,'
        'requestExit:async()=>{events.push("normal");running.child.exitCode=0;live=[]},'
        'waitExit:async()=>events.push("wait"),signal:()=>{throw Error("Unexpected signal")}});return {result,events};', None)


def test_cleanup_requests_normal_exit_once_for_its_owned_child():
    assert normal_cleanup_result() == {'ok': True, 'value': {
        'result': {'forcedCleanup': False, 'errors': []}, 'events': ['normal', 'wait']}}


def test_cleanup_failure_signals_only_the_registered_identity_and_marks_failure():
    assert normal_cleanup_result() == {'ok': True, 'value': {
        'result': {'forcedCleanup': False, 'errors': []}, 'events': ['normal', 'wait']}}
    result = node_call('const events=[];const expected={pid:7,birth:42};let live=[expected];'
        'const running={rootIdentity:expected,cycle:"owned-app",child:{exitCode:null,signalCode:null}};'
        'const result=await api.settleOwned(running,{remaining:()=>live,requestExit:async()=>{events.push("normal");throw Error("normal exit failed")},'
        'waitExit:async()=>events.push("wait"),signal:(_running,identity)=>{if(identity!==expected)throw Error("Foreign identity");'
        'events.push(identity.pid);live=[];running.child.signalCode="SIGKILL";return true}});return {result,events};', None)
    assert result['value']['events'] == ['normal', 7]
    assert result['value']['result']['forcedCleanup'] is True
    assert result['value']['result']['errors'] == ['Error: normal exit failed']


def test_cleanup_never_adopts_or_signals_an_unregistered_process():
    assert normal_cleanup_result() == {'ok': True, 'value': {
        'result': {'forcedCleanup': False, 'errors': []}, 'events': ['normal', 'wait']}}
    result = node_call('return api.settleOwned({child:{exitCode:null,signalCode:null}},'
        '{remaining:()=>{throw Error("Unknown process probe")},signal:()=>{throw Error("Unknown process signal")}});', None)
    assert result['value']['forcedCleanup'] is False
    assert result['value']['errors'] == ['Unconfirmed owned process remains']


def positive_control_fixture():
    options = metadata()['options']
    options['variant'] = 'gpu-positive-control'
    functions = {'queryBegin': 'glBeginQueryARB', 'queryEnd': 'glEndQueryARB',
                 'queryAvailable': 'glGetQueryObjectuivARB', 'queryDuration': 'glGetQueryObjectui64vEXT'}
    timing = {'capabilityResolved': True, 'queriesAvailable': True, 'droppedFrames': 0, 'glCallOverflow': 0,
        'context': {'counterBits': 32},
        'functions': functions, 'frames': [], 'glCalls': [],
        'load': {'enabled': True, 'initialized': True, 'fragmentIterations': 64,
                 'targetWidth': 2760, 'targetHeight': 1800, 'allowedDraws': [0, 64, 128, 256],
                 'initialization': {'vertexCompileStatus': 1, 'fragmentCompileStatus': 1,
                     'programLinkStatus': 1, 'logCapacityBytesEach': 1024,
                     **{key: {'reportedLength': 0, 'writtenLength': 0, 'text': '', 'truncated': False,
                              'outputWritten': True} for key in ('vertexLog', 'fragmentLog', 'programLog')}}},
        'auxiliaryRhi': {'samples': [{'observedAtFrameId': 1, 'sourceFrameId': None, 'seconds': 0.0}]}}
    scene = {'schema': diagnostic.CONTROL_SCHEMA, 'scenario': 'gpu-positive-control', 'completed': True,
        'passed': True, 'measurementValid': True, 'acceptanceEligible': False, 'performanceComparable': False,
        'package': diagnostic.PACKAGE, 'variant': 'gpu-positive-control', 'windowSize': 'wide',
        'windowWidth': 1380, 'windowHeight': 900, 'levels': [], 'headerFrameTiming': timing}
    for level_index, draws in enumerate((0, 64, 128, 256)):
        frames = []
        for ordinal in range(32):
            frame_id = len(timing['frames']) + 1
            begin = frame_id * 10_000_000
            duration = (level_index + 1) * 1_000_000
            frame = {'frameId': frame_id, 'frameBeginNs': begin, 'frameEndNs': begin + 1_000_000,
                'resultAvailableNs': begin + 2_000_000, 'gpuDurationNs': duration, 'durationRawValue': str(duration),
                'status': 'ready', 'valid': True, 'queryStarted': True, 'queryEnded': True, 'sameContext': True,
                'startContextGeneration': 1, 'endContextGeneration': 1, 'queryObject': frame_id,
                'queryStartStage': 'beforeFrameBegin', 'queryEndStage': 'afterFrameEnd',
                'availableSentinel': '4294967295', 'durationSentinel': '18446744073709551615',
                'availableOutputWritten': True, 'durationOutputWritten': True, 'availableValue': 1,
                'durationWithinCounterBits': True,
                'loadDraws': draws, 'actualLoadDraws': draws, 'loadInitializedAtFrameStart': True}
            frames.append(frame)
            timing['frames'].append(frame)
            for phase, key in [('begin', 'queryBegin'), ('end', 'queryEnd'),
                               ('availability', 'queryAvailable'), ('duration', 'queryDuration')]:
                timing['glCalls'].append({'callId': len(timing['glCalls']) + 1, 'frameId': frame_id,
                    'queryObject': frame_id, 'function': functions[key], 'phase': phase, 'atNs': begin,
                    'preexisting': False, 'errors': [], 'errorsOverflow': False})
            for _ in range(draws):
                timing['glCalls'].append({'callId': len(timing['glCalls']) + 1, 'frameId': frame_id,
                    'queryObject': frame_id, 'function': 'glDrawArrays', 'phase': 'load', 'atNs': begin,
                    'preexisting': False, 'errors': [], 'errorsOverflow': False})
        scene['levels'].append({'draws': draws, 'requestNs': frames[0]['frameBeginNs'] - 1,
            'endNs': frames[-1]['frameBeginNs'] + 2_000_000,
            'warmupFrameIds': [frame['frameId'] for frame in frames[:8]],
            'measuredFrameIds': [frame['frameId'] for frame in frames[8:]],
            'warmupActualDrawCalls': draws * 8, 'measuredActualDrawCalls': draws * 24,
            'actualDrawCalls': draws * 32, 'executedFrameCount': 32,
            'samples': [{key: frame[key] for key in ('frameId', 'gpuDurationNs', 'actualLoadDraws',
                        'frameBeginNs', 'frameEndNs', 'valid', 'status')} for frame in frames[8:]],
            'p50Ns': -1, 'p90Ns': -1})
    return {'scene': scene, 'options': options}


def update_control_durations(value, level_index, durations):
    level = value['scene']['levels'][level_index]
    frames = {frame['frameId']: frame for frame in value['scene']['headerFrameTiming']['frames']}
    for sample, frame_id, duration in zip(level['samples'], level['measuredFrameIds'], durations):
        frames[frame_id]['gpuDurationNs'] = duration
        frames[frame_id]['durationRawValue'] = str(duration)
        sample['gpuDurationNs'] = duration


def test_positive_control_uses_original_frames_instead_of_producer_percentiles():
    value = positive_control_fixture()
    result = node_call('return api.validatePositiveControl(input.scene,input.options);', value)
    assert result['ok'] is True and result['value']['measurementValid'] is True
    assert [row['p50Ns'] for row in result['value']['statistics']] == [1_000_000, 2_000_000, 3_000_000, 4_000_000]
    assert [row['p90Ns'] for row in result['value']['statistics']] == [1_000_000, 2_000_000, 3_000_000, 4_000_000]


@pytest.mark.parametrize('mutation,reason', [
    ('unavailable', 'W4 positive-control capability or bounded collection failed'),
    ('gl-error', 'W4 positive-control GL call error or missing evidence'),
    ('forced-sync', 'W4 positive-control forced GPU synchronization forbidden'),
    ('counter-width', 'W4 positive-control native counter width invalid'),
    ('counter-range', 'W4 positive-control duration exceeds native counter width'),
    ('counter-proof', 'W4 positive-control duration exceeds native counter width'),
    ('shader-status', 'W4 positive-control shader initialization evidence invalid'),
    ('shader-log', 'W4 positive-control shader initialization evidence invalid'),
    ('sentinel', 'W4 positive-control GPU output missing or sentinel retained'),
    ('duration-function', 'W4 positive-control GL function mapping invalid'),
    ('missing-call', 'W4 positive-control required GL call evidence missing'),
    ('draws', 'W4 positive-control raw load draws or frame allocation changed'),
    ('draw-record', 'W4 positive-control draw calls differ from raw GL records'),
    ('draw-sum', 'W4 positive-control executed draw total differs from raw frames'),
    ('sample-copy', 'W4 positive-control sample differs from original frame'),
    ('not-above-baseline', 'W4 positive-control load is not clearly above baseline'),
    ('p90-not-monotonic', 'W4 positive-control GPU time is not monotonically separated'),
    ('aux-source', 'W4 Qt GPU observation must not claim a source frame'),
    ('context', 'W4 positive-control query scope or context invalid'),
    ('warmup', 'W4 positive-control needs eight warmup and twenty-four measured frames')])
def test_positive_control_rejects_invalid_raw_evidence_even_when_producer_passed(mutation, reason):
    value = positive_control_fixture()
    baseline = node_call('return api.validatePositiveControl(input.scene,input.options);', value)
    assert baseline['ok'] is True and baseline['value']['measurementValid'] is True
    timing = value['scene']['headerFrameTiming']
    level = value['scene']['levels'][1]
    frame = next(frame for frame in timing['frames'] if frame['frameId'] == level['measuredFrameIds'][0])
    if mutation == 'unavailable': timing['queriesAvailable'] = False
    elif mutation == 'gl-error': timing['glCalls'][0]['errors'] = [1282]
    elif mutation == 'forced-sync': timing['glCalls'][0]['function'] = 'glFinish'
    elif mutation == 'counter-width': timing['context']['counterBits'] = 0
    elif mutation == 'counter-range':
        frame['gpuDurationNs'] = 4_294_967_297
        frame['durationRawValue'] = '4294967297'
    elif mutation == 'counter-proof': frame['durationWithinCounterBits'] = False
    elif mutation == 'shader-status': timing['load']['initialization']['programLinkStatus'] = 0
    elif mutation == 'shader-log': timing['load']['initialization']['vertexLog']['outputWritten'] = False
    elif mutation == 'sentinel': frame['durationOutputWritten'] = False
    elif mutation == 'duration-function': timing['functions']['queryDuration'] = 'glGetQueryObjectui64v'
    elif mutation == 'missing-call':
        timing['glCalls'] = [call for call in timing['glCalls'] if not
            (call['frameId'] == frame['frameId'] and call['phase'] == 'duration')]
    elif mutation == 'draws': frame['actualLoadDraws'] -= 1
    elif mutation == 'draw-record':
        next(call for call in timing['glCalls'] if call['frameId'] == frame['frameId']
             and call['phase'] == 'load')['function'] = 'glDrawElements'
    elif mutation == 'draw-sum': level['actualDrawCalls'] += 1
    elif mutation == 'sample-copy': level['samples'][0]['gpuDurationNs'] += 1
    elif mutation == 'not-above-baseline': update_control_durations(value, 1, [1_050_000] * 24)
    elif mutation == 'p90-not-monotonic': update_control_durations(value, 1, [2_000_000] * 20 + [9_000_000] * 4)
    elif mutation == 'aux-source': timing['auxiliaryRhi']['samples'][0]['sourceFrameId'] = 1
    elif mutation == 'context': frame['sameContext'] = False
    else: level['warmupFrameIds'].pop()
    assert value['scene']['passed'] is True
    assert node_call('return api.validatePositiveControl(input.scene,input.options);', value) == {'ok': False, 'error': reason}


def screenshot_fixture():
    value = metadata()
    value['options']['screenshot'] = 'memory-open'
    image = b'\x89PNG\r\n\x1a\n' + struct.pack('!I', 13) + b'IHDR' + struct.pack('!II', 2760, 1800)
    value['png'] = list(image)
    value['scene'] = {'screenshot': {'requested': 'memory-open', 'performed': True, 'timingStopped': True,
        'measurementStoppedNs': 100, 'stableOpenObservedNs': 100, 'grabBeginNs': 101, 'grabEndNs': 102,
        'naturalFramesAfterStable': 2, 'naturalAnimations': True, 'appearanceOrPoseOverrides': False,
        'pixelIdentityGuaranteed': False,
        'path': OUTPUT + '/header-frame.memory-open.png', 'pixelWidth': 2760, 'pixelHeight': 1800,
        'logicalWidth': 1380, 'logicalHeight': 900, 'devicePixelRatio': 2,
        'bytes': len(image), 'sha256': hashlib.sha256(image).hexdigest()}}
    return value


@pytest.mark.parametrize('mutation,reason', [
    ('variant', 'W4 screenshot path, dimensions or measurement boundary invalid'),
    ('path', 'W4 screenshot path, dimensions or measurement boundary invalid'),
    ('before-stop', 'W4 screenshot path, dimensions or measurement boundary invalid'),
    ('pixel-size', 'W4 screenshot PNG dimensions differ'),
    ('hash', 'W4 screenshot bytes changed'), ('png', 'W4 screenshot is not a PNG'),
    ('request', 'W4 screenshot request or stopped measurement evidence missing')])
def test_screenshot_requires_fixed_owned_path_stopped_timing_and_matching_bytes(mutation, reason):
    value = screenshot_fixture()
    source = 'return api.validateScreenshot(input.scene,input.options,()=>Buffer.from(input.png));'
    baseline = node_call(source, value)
    assert baseline['ok'] is True and baseline['value']['performed'] is True
    if mutation == 'variant': value['options']['variant'] = 'reduced-transparency'
    elif mutation == 'path': value['scene']['screenshot']['path'] = '/private/unowned.png'
    elif mutation == 'before-stop': value['scene']['screenshot']['grabBeginNs'] = 99
    elif mutation == 'pixel-size': value['scene']['screenshot']['pixelWidth'] = 1380
    elif mutation == 'hash': value['scene']['screenshot']['sha256'] = '0' * 64
    elif mutation == 'png': value['png'][0] = 0
    else: value['scene']['screenshot']['requested'] = 'none'
    assert node_call(source, value) == {'ok': False, 'error': reason}


@pytest.mark.parametrize('variant', ['reduced-transparency', 'drawer-background-off', 'gpu-positive-control'])
def test_python_entry_refuses_screenshot_for_unapproved_variants(variant):
    args = request(variant)
    assert diagnostic.validate_request(args, local_config()) == variant
    args.header_frame_screenshot = 'memory-open'
    with pytest.raises(ValueError, match='^HEADER_FRAME_SCREENSHOT_VARIANT_FORBIDDEN$'):
        diagnostic.validate_request(args, local_config())


def test_local_app_is_the_only_environment_that_enables_qt_gpu_profile():
    value = metadata()
    result = node_call('const w4=api.validateLocalMetadata(input.root,input.options,input.marker,input.build,4321);'
        'return api.appEnvironment(input.options,w4,{});', value)
    assert result['ok'] is True and result['value']['QSG_RHI_PROFILE'] == '1'
    assert result['value']['REVERIE_HEADER_FRAME_SCREENSHOT'] == 'none'


@pytest.mark.parametrize('mutation', ['failed-row', 'wrong-build', 'no-cleanup'])
def test_ordinary_run_requires_a_completed_clean_positive_control_for_the_same_build(mutation):
    row = {'category': 'gui', 'diagnostic': True, 'passed': True, 'exitCode': 0,
           'selection': ['drawer-frame::gpu-positive-control::wide'], 'outputDirectory': OUTPUT}
    summary = {'schema': diagnostic.SUMMARY_SCHEMA, 'scenario': 'gpu-positive-control',
        'variant': 'gpu-positive-control', 'package': diagnostic.PACKAGE, 'passed': True,
        'executionComplete': True, 'acceptanceEligible': False, 'performanceComparable': False,
        'noResidualProcesses': True, 'testDataRemoved': True, 'keyCleanupCompleted': True,
        'allOwnedExitedNormally': True, 'forcedCleanup': False, 'applicationUnchanged': True,
        'modelInputUnchanged': True, 'outputDirectory': OUTPUT, 'buildManifestSha256': 'a' * 64}
    value = {'row': row, 'summary': summary, 'build': 'a' * 64}
    source = 'api.validateControlAnchor(input.row,input.summary,input.build);return true;'
    assert node_call(source, value) == {'ok': True, 'value': True}
    if mutation == 'failed-row': row['passed'] = False
    elif mutation == 'wrong-build': value['build'] = 'b' * 64
    else: summary['noResidualProcesses'] = False
    assert node_call(source, value) == {'ok': False,
        'error': 'W4 ordinary run requires a completed positive control for this build'}


def control_evidence_files(value):
    scene_path = OUTPUT + '/header-frame.scene.json'
    summary_path = OUTPUT + '/header-frame.summary.json'
    raw_scene = json.dumps(value['scene']).encode()
    summary = {'schema': diagnostic.SUMMARY_SCHEMA, 'scenario': 'gpu-positive-control',
        'variant': 'gpu-positive-control', 'package': diagnostic.PACKAGE, 'passed': True,
        'executionComplete': True, 'acceptanceEligible': False, 'performanceComparable': False,
        'noResidualProcesses': True, 'testDataRemoved': True, 'keyCleanupCompleted': True,
        'allOwnedExitedNormally': True, 'forcedCleanup': False, 'applicationUnchanged': True,
        'modelInputUnchanged': True, 'outputDirectory': OUTPUT, 'buildManifestSha256': 'a' * 64,
        'scene': {'path': scene_path, 'bytes': len(raw_scene), 'sha256': hashlib.sha256(raw_scene).hexdigest()}}
    raw_summary = json.dumps(summary).encode()
    row = {'category': 'gui', 'diagnostic': True, 'passed': True, 'exitCode': 0, 'sequence': 10,
           'selection': ['drawer-frame::gpu-positive-control::wide'], 'outputDirectory': OUTPUT,
           'measurements': {'path': summary_path, 'bytes': len(raw_summary), 'sha256': hashlib.sha256(raw_summary).hexdigest()}}
    return {scene_path: raw_scene, summary_path: raw_summary,
            '/repo/.tools/local/' + diagnostic.PACKAGE + '/ledger.jsonl': (json.dumps(row) + '\n').encode()}


@pytest.mark.parametrize('mutation,reason', [
    ('missing-scene', 'Missing owned evidence file'),
    ('changed-scene', 'W4 positive-control scene bytes changed'),
    ('changed-summary', 'W4 positive-control summary bytes changed'),
    ('different-build', 'W4 ordinary run requires a completed positive control for this build'),
    ('false-positive', 'W4 positive-control load is not clearly above baseline')])
def test_ordinary_gate_rebinds_and_recomputes_raw_control_evidence(mutation, reason):
    fixture = positive_control_fixture()
    files = control_evidence_files(fixture)
    value = {'options': {**metadata()['options'], 'outputDirectory': OUTPUT.replace('000001-', '000011-'),
                         'currentSequence': 11}, 'build': 'a' * 64}
    source = ('const files=Object.fromEntries(Object.entries(input.files).map(([name,value])=>[name,Buffer.from(value,"base64")]));'
              'return api.loadPositiveControlEvidence(input.options,input.build,{root:"/repo",'
              'snapshotDirectory:()=>{},readBytes:name=>{if(!Object.hasOwn(files,name))throw Error("Missing owned evidence file");return files[name]}});')
    value['files'] = {name: base64.b64encode(data).decode() for name, data in files.items()}
    baseline = node_call(source, value)
    assert baseline['ok'] is True and baseline['value']['independentRawValidation'] is True
    if mutation == 'missing-scene': del files[OUTPUT + '/header-frame.scene.json']
    elif mutation == 'changed-scene': files[OUTPUT + '/header-frame.scene.json'] += b' '
    elif mutation == 'changed-summary': files[OUTPUT + '/header-frame.summary.json'] += b' '
    elif mutation == 'different-build': value['build'] = 'b' * 64
    else:
        update_control_durations(fixture, 1, [1_050_000] * 24)
        files = control_evidence_files(fixture)
    value['files'] = {name: base64.b64encode(data).decode() for name, data in files.items()}
    assert node_call(source, value) == {'ok': False, 'error': reason}


def test_ordinary_gpu_samples_use_the_calibrated_ext_method_and_keep_qt_unpaired():
    value = positive_control_fixture()
    source = ('const calibration=api.validatePositiveControl(input.scene,input.options);'
              'api.validateOrdinaryMethod(input.scene,calibration.method);'
              'input.scene.headerFrameTiming.functions.queryDuration="glGetQueryObjectui64v";'
              'try{api.validateOrdinaryMethod(input.scene,calibration.method);throw Error("Mutation accepted")}'
              'catch(error){if(error.message!=="W4 ordinary GPU method differs from calibrated positive control")throw error;return error.message;}')
    assert node_call(source, value) == {'ok': True,
        'value': 'W4 ordinary GPU method differs from calibrated positive control'}


def test_old_v1_summary_cannot_be_used_as_new_supplement_evidence(tmp_path):
    summary = saved_summary(tmp_path)
    assert diagnostic.read_summary(tmp_path, 'baseline')[0] == summary
    summary['schema'] = 'reverie.qt.header-frame-local-run.v1'
    (tmp_path / diagnostic.SUMMARY_NAME).write_text(json.dumps(summary))
    with pytest.raises(ValueError, match='^HEADER_FRAME_LOCAL_DIAGNOSTIC_INCOMPLETE$'):
        diagnostic.read_summary(tmp_path, 'baseline')


def test_positive_control_summary_does_not_use_the_forty_drawer_window_success_rule(tmp_path):
    summary = saved_summary(tmp_path)
    scene_path = tmp_path / 'header-frame.scene.json'
    scene_bytes = (json.dumps({'schema': diagnostic.CONTROL_SCHEMA}) + '\n').encode()
    scene_path.write_bytes(scene_bytes)
    summary.update(variant='gpu-positive-control', scenario='gpu-positive-control', windowCount=0,
                   positiveControlVerification={'measurementValid': True})
    summary['scene'] = {'path': str(scene_path), 'schema': diagnostic.CONTROL_SCHEMA,
                        'bytes': len(scene_bytes), 'sha256': hashlib.sha256(scene_bytes).hexdigest()}
    (tmp_path / diagnostic.SUMMARY_NAME).write_text(json.dumps(summary))
    assert diagnostic.read_summary(tmp_path, 'gpu-positive-control')[0] == summary
    summary['positiveControlVerification']['measurementValid'] = False
    (tmp_path / diagnostic.SUMMARY_NAME).write_text(json.dumps(summary))
    with pytest.raises(ValueError, match='^HEADER_FRAME_POSITIVE_CONTROL_INVALID$'):
        diagnostic.read_summary(tmp_path, 'gpu-positive-control')


def test_screenshot_none_cannot_hide_an_unrequested_output():
    value = metadata()
    value['scene'] = {'screenshot': {'requested': 'none', 'performed': False, 'timingStopped': True}}
    source = 'return api.validateScreenshot(input.scene,input.options,()=>{throw Error("Unexpected PNG read")});'
    assert node_call(source, value) == {'ok': True,
        'value': {'requested': 'none', 'performed': False, 'timingStopped': True}}
    value['scene']['screenshot'].update(performed=True, path=OUTPUT + '/header-frame.memory-open.png')
    assert node_call(source, value) == {'ok': False, 'error': 'W4 unrequested screenshot was produced'}


def test_screenshot_option_is_available_only_to_the_local_cli(capsys):
    baseline = cli.parser().parse_args(['run', '--report', '/owned/report'])
    assert baseline.operation == 'run' and str(baseline.report) == '/owned/report'
    with pytest.raises(SystemExit, match='^2$'):
        cli.parser().parse_args(['run', '--report', '/owned/report', '--header-frame-screenshot', 'memory-open'])
    assert 'unrecognized arguments' in capsys.readouterr().err


def test_screenshot_option_cannot_change_an_existing_local_gui_mode(tmp_path, monkeypatch):
    args = request()
    args.select = ['persona']
    monkeypatch.setattr(cli, 'load_config', lambda _path: local_config())
    monkeypatch.setattr(engine, 'run_local', lambda *args, **kwargs: {
        'passed': True, 'outputDirectory': str(tmp_path), 'localRun': {'sequence': 1, 'counts': {}}})
    assert cli.run_local_command(args, tmp_path) == 0
    args.header_frame_screenshot = 'memory-open'
    with pytest.raises(ValueError, match='^HEADER_FRAME_SCREENSHOT_REQUIRES_LOCAL_DIAGNOSTIC$'):
        cli.run_local_command(args, tmp_path)
