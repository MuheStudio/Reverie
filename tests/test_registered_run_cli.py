"""New public-tool boundary tests, independent of a current registered run."""
import copy
import hashlib
import json
from pathlib import Path
import subprocess
import sys

import pytest

from script.registered_run import cli
from script.registered_run.config import ConfigError, load_config, validate_config


def config():
    return {'configSchema': 'reverie.registered-run.config.v1', 'runKind': 'local',
            'adoptCandidate': False, 'stopOnFirstFailure': True, 'retries': 0,
            'sequence': ['python-unit'], 'budgets': {'pythonBatch': 1},
            'timeoutsSeconds': {'python-unit': 300}, 'pythonTargets': ['tests/test_x.py'],
            'nodeTests': ['script/x.test.cjs'], 'frontendTests': ['frontend/x.test.ts'],
            'nativeTargets': ['example'], 'python': '.venv/bin/python', 'node': '.tools/node/bin/node',
            'localSdk': '.tools/sdk', 'cmakeDirectory': '.tools/qt-builds/local-package',
            'candidateDirectory': '.tools/qt-builds/local-package', 'package': 'test-package'}


def test_config_remains_data_and_does_not_mutate_input():
    value = config()
    value['stages'] = [{'command': ['this is historical data, never executed']}]
    observed = validate_config(value)
    assert observed == value and observed is not value
    observed['pythonTargets'].append('tests/another.py')
    assert value['pythonTargets'] == ['tests/test_x.py']


@pytest.mark.parametrize('mutation,reason', [
    (lambda c: c.update(adoptCandidate=True), 'ONLY_FORMAL_MAY_ADOPT'),
    (lambda c: c.update(adoptCandidate=0), 'CONFIG_ADOPTION_BOOLEAN'),
    (lambda c: c.update(retries=True), 'CONFIG_FAIL_STOP_REQUIRED'),
    (lambda c: c['timeoutsSeconds'].update({'python-unit': None}), 'CONFIG_UNIT_DEADLINE_REQUIRED'),
    (lambda c: c['timeoutsSeconds'].update({'python-unit': True}), 'CONFIG_STAGE_TIMEOUT'),
    (lambda c: c['budgets'].update(pythonBatch=True), 'CONFIG_STAGE_BUDGET'),
    (lambda c: c.update(pythonTargets=['data/private.py']), 'FORBIDDEN_CONFIG_PATH'),
    (lambda c: c.update(pythonTargets=['../private.py']), 'FORBIDDEN_CONFIG_PATH'),
    (lambda c: c.update(pythonTargets=['/private.py']), 'FORBIDDEN_CONFIG_PATH'),
    (lambda c: c.update(sequence=['shell']), 'CONFIG_STAGE_SEQUENCE'),
    (lambda c: c.update(sequence=['python-unit', 'python-unit']), 'CONFIG_STAGE_SEQUENCE'),
])
def test_config_rejects_invalid_data(mutation, reason):
    fresh = config()
    assert validate_config(fresh) == fresh
    broken = copy.deepcopy(fresh)
    mutation(broken)
    with pytest.raises(ConfigError, match=reason):
        validate_config(broken)


def test_config_duplicate_key_is_rejected(tmp_path):
    path = tmp_path / 'config.json'
    path.write_text('{"runKind":"local","runKind":"formal"}')
    with pytest.raises(ConfigError, match='DUPLICATE_CONFIG_KEY'):
        load_config(path)


def test_direct_isolated_cli_help_does_not_need_repository_pythonpath():
    root = Path(__file__).resolve().parents[1]
    process = subprocess.run([sys.executable, '-I', '-B', str(root / 'script/registered_run/cli.py'), '--help'],
                             capture_output=True, text=True, timeout=10)
    assert process.returncode == 0, process.stderr
    assert 'export-config' in process.stdout and 'local' in process.stdout


def test_cache_option_is_not_available_for_gui():
    args = cli.parser().parse_args(['local', '--package', 'test-package', '--config', 'x.json',
                                   '--category', 'gui', '--qml-cache', 'on'])
    assert args.category == 'gui' and args.qml_cache == 'on'


def test_local_build_guard_detects_dirty_source_change(tmp_path, monkeypatch):
    from script.registered_run import source
    package = 'test-package'
    output = tmp_path / '.tools/qt-builds' / ('local-' + package)
    output.mkdir(parents=True)
    inventory = [{'path': 'native-ui/test.cpp', 'type': 'file', 'bytes': 3,
                  'sha256': hashlib.sha256(b'old').hexdigest()}]
    (output / 'source-inventory.json').write_text(json.dumps(inventory))
    (output / 'build.json').write_text(json.dumps({'candidate': None, 'localIteration': {'package': package},
        'source': {'inventory': {'sha256': hashlib.sha256(json.dumps(inventory, separators=(',', ':')).encode()).hexdigest()}}}))
    snapshot = {'files': [{'path': inventory[0]['path'], 'mode': '100644', 'bytes': 3, 'sha256': inventory[0]['sha256']}]}
    monkeypatch.setattr(source, 'snapshot_source', lambda root: snapshot)
    assert cli.verify_local_build_source(tmp_path, package) is snapshot
    snapshot['files'][0]['sha256'] = hashlib.sha256(b'new').hexdigest()
    with pytest.raises(ValueError, match='LOCAL_BUILD_SOURCE_CHANGED_REBUILD_REQUIRED'):
        cli.verify_local_build_source(tmp_path, package)
