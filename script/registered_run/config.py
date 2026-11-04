"""Data-only configuration validation; execution argv is built by stages.py."""
from copy import deepcopy
import json
from pathlib import Path, PurePosixPath
import re

from .export_config import CONFIG_SCHEMA, STAGE_BUDGETS
from .preview import PreviewError, stage_budgets, validate_extension


class ConfigError(ValueError):
    pass


def load_config(path):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ConfigError('DUPLICATE_CONFIG_KEY:' + key)
            result[key] = value
        return result
    value = json.loads(Path(path).read_text(), object_pairs_hook=pairs,
                       parse_constant=lambda value: (_ for _ in ()).throw(ConfigError('NONFINITE_CONFIG')))
    return validate_config(value)


def relative_path(value):
    if not isinstance(value, str) or not value or any(c in value for c in '\0\n\r\\'):
        raise ConfigError('INVALID_CONFIG_PATH')
    path = PurePosixPath(value)
    if path.is_absolute() or '..' in path.parts or path.parts[0] == 'data' or value.startswith('-'):
        raise ConfigError('FORBIDDEN_CONFIG_PATH:' + value)
    return value


def validate_config(config, root=None):
    if not isinstance(config, dict):
        raise ConfigError('CONFIG_OBJECT_REQUIRED')
    try:
        json.dumps(config, allow_nan=False)
    except (TypeError, ValueError) as error:
        raise ConfigError('CONFIG_MUST_BE_FINITE_JSON_DATA') from error
    value = deepcopy(config)
    if value.get('configSchema') != CONFIG_SCHEMA:
        raise ConfigError('CONFIG_SCHEMA')
    if value.get('runKind') not in ('local', 'development', 'tool-validation', 'formal'):
        raise ConfigError('CONFIG_RUN_KIND')
    # Missing belongs to registrations and saved outputs created before v2.
    # Only registration creation supplies a default; export/replay stays exact.
    if 'memoryActionContract' in value and value['memoryActionContract'] not in ('v1', 'v2'):
        raise ConfigError('CONFIG_MEMORY_ACTION_CONTRACT')
    if 'cardExportContract' in value and value['cardExportContract'] != 'v1':
        raise ConfigError('CONFIG_CARD_EXPORT_CONTRACT')
    if 'cardEditContract' in value and value['cardEditContract'] != 'v1':
        raise ConfigError('CONFIG_CARD_EDIT_CONTRACT')
    if type(value.get('adoptCandidate')) is not bool:
        raise ConfigError('CONFIG_ADOPTION_BOOLEAN')
    if value['runKind'] != 'formal' and value['adoptCandidate']:
        raise ConfigError('ONLY_FORMAL_MAY_ADOPT')
    if value.get('stopOnFirstFailure') is not True or type(value.get('retries')) is not int or value['retries'] != 0:
        raise ConfigError('CONFIG_FAIL_STOP_REQUIRED')
    try:
        available_budgets = stage_budgets(value, STAGE_BUDGETS)
    except PreviewError as error:
        raise ConfigError(str(error)) from error
    sequence = value.get('sequence')
    if not isinstance(sequence, list) or not sequence or len(sequence) != len(set(sequence)) or any(x not in available_budgets for x in sequence):
        raise ConfigError('CONFIG_STAGE_SEQUENCE')
    for key in ('budgets', 'timeoutsSeconds'):
        if not isinstance(value.get(key), dict):
            raise ConfigError('CONFIG_STAGE_LIMITS')
    for stage in sequence:
        budget = value['budgets'].get(available_budgets[stage])
        timeout = value['timeoutsSeconds'].get(stage)
        if type(budget) is not int or budget != 1:
            raise ConfigError('CONFIG_STAGE_BUDGET:' + stage)
        if stage not in value['timeoutsSeconds'] or (timeout is not None and (type(timeout) not in (int, float) or timeout <= 0)):
            raise ConfigError('CONFIG_STAGE_TIMEOUT:' + stage)
        if timeout is None and not stage.endswith('-check'):
            raise ConfigError('CONFIG_UNIT_DEADLINE_REQUIRED:' + stage)
    try:
        validate_extension(value, list(STAGE_BUDGETS))
    except PreviewError as error:
        raise ConfigError(str(error)) from error
    for key, suffix in [('pythonTargets', '.py'), ('nodeTests', ('.test.cjs', '.test.js', '.test.mjs')), ('frontendTests', ('.ts', '.tsx', '.js'))]:
        paths = value.get(key)
        if not isinstance(paths, list) or not paths or len(paths) != len(set(paths)):
            raise ConfigError('CONFIG_SELECTION:' + key)
        for path in paths:
            if not relative_path(path).endswith(suffix):
                raise ConfigError('CONFIG_SELECTION_SUFFIX:' + path)
            if root is not None:
                target = Path(root) / path
                if not target.is_file() or target.is_symlink() or not target.resolve().is_relative_to(Path(root).resolve()):
                    raise ConfigError('CONFIG_SELECTION_NOT_REPOSITORY_FILE:' + path)
    targets = value.get('nativeTargets')
    if not isinstance(targets, list) or not targets or len(targets) != len(set(targets)) or any(not isinstance(x, str) or not re.fullmatch('[a-z0-9-]+', x) for x in targets):
        raise ConfigError('CONFIG_NATIVE_TARGETS')
    for key in ('python', 'node', 'localSdk', 'cmakeDirectory', 'candidateDirectory'):
        relative_path(value[key])
    if 'package' in value and not re.fullmatch('[a-z0-9][a-z0-9-]{1,63}', value['package']):
        raise ConfigError('CONFIG_PACKAGE')
    return value


def unit_selection(config):
    return {key: deepcopy(config[key]) for key in ('pythonTargets', 'nodeTests', 'frontendTests', 'nativeTargets')}
