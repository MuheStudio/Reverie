"""Correction 1 CLI wiring: no real registration or execution is created."""
import json
from pathlib import Path

import pytest

from script.registered_run import cli, registration


def test_rehearsal_cli_only_calls_read_only_rehearsal(tmp_path, monkeypatch, capsys):
    config = {'fixture': 'data-only'}
    seen = []
    monkeypatch.setattr(cli, 'load_config', lambda path: config)

    def rehearsal(root, package, value, report, output):
        seen.append((root, package, value, report, output))
        return {'contractSha256': 'a' * 64, 'registrationCreated': False, 'activeMarkerCreated': False}

    monkeypatch.setattr(registration, 'rehearsal', rehearsal)
    monkeypatch.setattr(registration, 'freeze', lambda *a, **k: pytest.fail('rehearsal must not freeze'))
    monkeypatch.setattr(registration, 'run_registered', lambda *a, **k: pytest.fail('rehearsal must not run'))
    assert cli.main(['--root', str(tmp_path), 'rehearse', '--package', 'example-package',
                     '--config', 'config.json', '--report', '.tools/reports/proposed',
                     '--output', '.tools/local/example-package/rehearsal-one']) == 0
    assert seen == [(tmp_path.resolve(), 'example-package', config, Path('.tools/reports/proposed'),
                     Path('.tools/local/example-package/rehearsal-one'))]
    assert json.loads(capsys.readouterr().out)['registrationCreated'] is False
    assert not (tmp_path / '.tools').exists()


@pytest.mark.parametrize('expected', [None, 'b' * 64])
def test_freeze_cli_forwards_optional_expected_contract_without_execution(tmp_path, monkeypatch, expected):
    seen = []
    monkeypatch.setattr(cli, 'load_config', lambda path: {'fixture': True})
    monkeypatch.setattr(registration, 'freeze', lambda *a, **k: seen.append((a, k)) or {'frozen': True})
    monkeypatch.setattr(registration, 'run_registered', lambda *a, **k: pytest.fail('freeze must not run'))
    argv = ['--root', str(tmp_path), 'freeze', '--package', 'example-package', '--config', 'config.json',
            '--report', '.tools/reports/proposed']
    if expected is not None:
        argv += ['--contract-sha256', expected]
    assert cli.main(argv) == 0
    assert seen[0][1] == {'expected_contract_sha256': expected}
