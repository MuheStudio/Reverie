"""Host checks extracted from the passed formal r1 runner.

Function bodies retain their original comparisons and order. Invoke through an
explicit RunContext: its private namespace supplies paths and frozen contracts.
This module never imports or executes a historical report runner.
"""

def now():
    return datetime.now(timezone.utc).isoformat()

def need(condition, message):
    # Authorization and fail-stop checks also remain active under python -O.
    if not condition:
        raise RuntimeError(message)

def sha(path):
    need(not Path(path).resolve().is_relative_to((ROOT / 'data').resolve()), 'DEFAULT_DATA_CONTENT_READ_FORBIDDEN')
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def load_json(path):
    def unique_pairs(pairs):
        result = {}
        for key, value in pairs:
            need(key not in result, 'DUPLICATE_JSON_KEY:' + str(key))
            result[key] = value
        return result
    return json.loads(Path(path).read_text(), object_pairs_hook=unique_pairs,
                      parse_constant=lambda value: (_ for _ in ()).throw(ValueError('NONFINITE_JSON:' + value)))

def root_path(value):
    need(isinstance(value, str) and value, 'INVALID_REGISTERED_PATH')
    relative = PurePosixPath(value)
    need(not relative.is_absolute() and '..' not in relative.parts, 'REGISTERED_PATH_ESCAPES_ROOT')
    return ROOT / value

def integer(value):
    return type(value) is int

def numeric(value):
    return type(value) in (int, float) and math.isfinite(value)

def string(value):
    return isinstance(value, str) and bool(value)

def junit(path, count, names=None):
    root = ET.parse(path).getroot()
    cases = root.findall('.//testcase')
    need(len(cases) == count, 'JUNIT_CASE_COUNT:' + str(path))
    need(not root.findall('.//failure') and not root.findall('.//error') and
         not root.findall('.//skipped'), 'JUNIT_FAILURE_OR_SKIP:' + str(path))
    suites = [root] if root.tag == 'testsuite' else root.findall('.//testsuite')
    need(suites, 'JUNIT_SUITE_MISSING:' + str(path))
    for suite in suites:
        need(all(int(suite.get(key, '0')) == 0 for key in ('failures', 'errors', 'skipped', 'disabled')),
             'JUNIT_NOT_ALL_PASSED:' + str(path))
    if names is not None:
        observed = [case.get('name') for case in cases]
        need(len(observed) == len(set(observed)) and set(observed) == set(names),
             'CTEST_TARGET_SET_CHANGED')
        need(all(case.get('status') == 'run' for case in cases), 'CTEST_TARGET_NOT_RUN')
    return len(cases)
