"""Explicit W4 local diagnostic dispatch; never part of registered planning."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

from .engine import StageSpec, run_local
from .state import load_json_bytes, regular_file


PACKAGE = 'preview-header-frame-20261102'
VARIANTS = ('baseline', 'reduced-transparency', 'half-resolution', 'drawer-background-off',
            'blur-half-resolution', 'gpu-positive-control')
SCREENSHOT_VARIANTS = ('baseline', 'half-resolution', 'blur-half-resolution')
PREFIX = 'drawer-frame'
SCENE_SCHEMA = 'reverie.qt.header-frame-local.v2'
CONTROL_SCHEMA = 'reverie.qt.header-frame-positive-control.v1'
SUMMARY_SCHEMA = 'reverie.qt.header-frame-local-run.v2'
SUMMARY_NAME = 'header-frame.summary.json'


def requested(selection):
    return any(isinstance(value, str) and value.startswith(PREFIX) for value in selection)


def validate_request(args, config):
    if args.package != PACKAGE or args.category != 'gui' or args.diagnostic is not True:
        raise ValueError('HEADER_FRAME_REQUIRES_EXPLICIT_LOCAL_DIAGNOSTIC')
    if args.qml_cache is not None:
        raise ValueError('HEADER_FRAME_CACHE_OVERRIDE_FORBIDDEN')
    selected = args.select or []
    if len(selected) != 1:
        raise ValueError('HEADER_FRAME_ONE_VARIANT_REQUIRED')
    parts = selected[0].split('::')
    if len(parts) != 3 or parts[0] != PREFIX or parts[1] not in VARIANTS or parts[2] != 'wide':
        raise ValueError('HEADER_FRAME_VARIANT_NOT_AUTHORIZED')
    screenshot = getattr(args, 'header_frame_screenshot', 'none')
    if screenshot not in ('none', 'memory-open'):
        raise ValueError('HEADER_FRAME_SCREENSHOT_INVALID')
    if screenshot != 'none' and parts[1] not in SCREENSHOT_VARIANTS:
        raise ValueError('HEADER_FRAME_SCREENSHOT_VARIANT_FORBIDDEN')
    directory = '.tools/qt-builds/local-' + PACKAGE
    if (config.get('runKind') != 'local' or config.get('adoptCandidate') is not False
            or config.get('candidateName') is not None or config.get('package') != PACKAGE
            or config.get('cmakeDirectory') != directory or config.get('candidateDirectory') != directory):
        raise ValueError('HEADER_FRAME_LOCAL_CONFIGURATION_REQUIRED')
    return parts[1]


def read_summary(output, variant, screenshot='none'):
    path = Path(output) / SUMMARY_NAME
    info = regular_file(path)
    if info.st_size > 4 * 1024 * 1024:
        raise ValueError('HEADER_FRAME_SUMMARY_TOO_LARGE')
    payload = path.read_bytes()
    result = load_json_bytes(payload)
    control = variant == 'gpu-positive-control'
    expected = {'schema': SUMMARY_SCHEMA, 'package': PACKAGE, 'variant': variant, 'windowSize': 'wide',
                'scenario': 'gpu-positive-control' if control else 'drawer-cycles', 'screenshotRequested': screenshot,
                'acceptanceEligible': False, 'performanceComparable': False, 'diagnostic': True,
                'executionComplete': True, 'passed': True, 'noResidualProcesses': True,
                'testDataRemoved': True, 'keyCleanupCompleted': True, 'applicationUnchanged': True,
                'modelInputUnchanged': True, 'allOwnedExitedNormally': True,
                'forcedCleanup': False, 'interrupted': False}
    if not isinstance(result, dict) or any(
            (result.get(key) is not value if type(value) is bool else result.get(key) != value)
            for key, value in expected.items()):
        raise ValueError('HEADER_FRAME_LOCAL_DIAGNOSTIC_INCOMPLETE')
    if result.get('outputDirectory') != str(Path(output)) or result.get('windowCount') != (0 if control else 40):
        raise ValueError('HEADER_FRAME_OUTPUT_OR_COUNT_CHANGED')
    if control and result.get('positiveControlVerification', {}).get('measurementValid') is not True:
        raise ValueError('HEADER_FRAME_POSITIVE_CONTROL_INVALID')
    scene_path = Path(output) / 'header-frame.scene.json'
    scene = result.get('scene', {})
    scene_info = regular_file(scene_path)
    if scene_info.st_size > 32 * 1024 * 1024:
        raise ValueError('HEADER_FRAME_SCENE_TOO_LARGE')
    scene_payload = scene_path.read_bytes()
    if (scene.get('path') != str(scene_path) or scene.get('schema') != (CONTROL_SCHEMA if control else SCENE_SCHEMA)
            or scene.get('bytes') != len(scene_payload)
            or scene.get('sha256') != hashlib.sha256(scene_payload).hexdigest()):
        raise ValueError('HEADER_FRAME_SCENE_BYTES_CHANGED')
    if screenshot == 'memory-open':
        capture = result.get('screenshot', {})
        capture_path = Path(output) / 'header-frame.memory-open.png'
        capture_info = regular_file(capture_path)
        if capture_info.st_size > 32 * 1024 * 1024:
            raise ValueError('HEADER_FRAME_SCREENSHOT_TOO_LARGE')
        capture_bytes = capture_path.read_bytes()
        if (capture.get('requested') != screenshot or capture.get('performed') is not True
                or capture.get('timingStopped') is not True or capture.get('path') != str(capture_path)
                or capture.get('bytes') != len(capture_bytes)
                or capture.get('sha256') != hashlib.sha256(capture_bytes).hexdigest()):
            raise ValueError('HEADER_FRAME_SCREENSHOT_BYTES_CHANGED')
    return result, {'path': str(path), 'sha256': hashlib.sha256(payload).hexdigest(), 'bytes': len(payload)}


def run_command(args, root, config, *, verify_build):
    variant = validate_request(args, config)
    screenshot = getattr(args, 'header_frame_screenshot', 'none')
    counts = ({'positiveControlLevels': 4, 'gpuSamples': 96} if variant == 'gpu-positive-control'
              else {'windows': 40, 'memory': 20, 'settings': 20})
    selected = list(args.select)
    command = [str(root / '.venv/bin/python'), '-I', '-B', str(root / 'script/registered_run/cli.py'),
               'local', '--package', PACKAGE, '--config', str(args.config), '--category', 'gui',
               '--select', selected[0], '--diagnostic', '--header-frame-screenshot', screenshot]

    def factory(project, output, environment):
        verify_build(project, PACKAGE)

        def verify(_engine, _row):
            _summary, metadata = read_summary(output, variant, screenshot)
            return {'headerFrameEvidence': {'summary': metadata, 'acceptanceEligible': False,
                                           'counts': counts}}

        return [StageSpec(id='header-frame-positive-control' if variant == 'gpu-positive-control' else 'header-frame-local', command=[str(project / config['node']),
            str(project / 'native-ui/check-header-frame-local.cjs'), '--package', PACKAGE,
            '--variant', variant, '--size', 'wide', '--screenshot', screenshot, '--output-dir', str(output)],
            cwd=project, env=dict(environment), budget='headerFrameLocal', timeout=720,
            verify=verify, log_name='header-frame-local.log', capture_pointer=False,
            check_category='gui', selection=selected)]

    def finalize(_project, output, _environment):
        _summary, metadata = read_summary(output, variant, screenshot)
        return {'measurements': metadata, 'acceptanceEligible': False,
                'counts': counts}

    result = run_local(root, PACKAGE, 'gui', selected, diagnostic=True,
                       stage_factory=factory, action=finalize, command=command)
    row = result['localRun']
    print(json.dumps({'passed': result['passed'], 'acceptance': False, 'diagnostic': True,
                      'sequence': row['sequence'], 'outputDirectory': result['outputDirectory'],
                      'stopReason': result.get('stopReason'), 'counts': row['counts']}, ensure_ascii=False))
    return 0 if result['passed'] else 1
