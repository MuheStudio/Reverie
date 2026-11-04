'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { parseNativeCheckOptions, validateTransitionBuildMode } = require('./native-check-options.cjs');
test('transition diagnostics preserve separate recorded and unrecorded original entry paths', () => {
  for (const record of [false, true]) {
    const options = parseNativeCheckOptions(['--transition-diagnostics', '--build-dir', '/tmp/diagnostic',
      ...(record ? ['--record'] : [])], '/tmp/model');
    assert.equal(options.transitionDiagnostics, true);
    assert.equal(options.recordUI, record);
    assert.equal(options.recordDemo, false);
  }
  assert.equal(parseNativeCheckOptions([], '/tmp/model').transitionDiagnostics, false);
});
test('diagnostic parser rejects preview, demo, implicit candidates and malformed flags', () => {
  for (const args of [[], ['--interactive'], ['--record-demo'], ['--record', '--interactive']])
    assert.throws(() => parseNativeCheckOptions(['--transition-diagnostics', ...args], '/tmp/model'));
  for (const flags of [['--interactive'], ['--record-demo'], ['--transition-diagnostics'], ['--record', '--record'],
    ['--build-dir', 'relative'], ['--unknown']])
    assert.throws(() => parseNativeCheckOptions(['--transition-diagnostics', '--build-dir', '/tmp/d', ...flags], '/tmp/model'));
});
test('transition gate accepts only timing probes without a QML profiler', () => {
  validateTransitionBuildMode({ diagnostics: { timingProbesEnabled: true,
    qmlProfilerEnabled: false, ordinaryLauncherAllowed: false } });
  for (const diagnostics of [undefined, {}, { timingProbesEnabled: true },
    { timingProbesEnabled: true, qmlProfilerEnabled: true, ordinaryLauncherAllowed: false },
    { timingProbesEnabled: false, qmlProfilerEnabled: false, ordinaryLauncherAllowed: true }])
    assert.throws(() => validateTransitionBuildMode({ diagnostics }));
});
test('supplementary audit is an explicit automated mode only', () => {
  assert.equal(parseNativeCheckOptions([], '/tmp/model').supplementary, false);
  const options = parseNativeCheckOptions(['--supplementary', '--build-dir', '/tmp/candidate'], '/tmp/model');
  assert.equal(options.supplementary, true);
  assert.equal(options.buildDir, '/tmp/candidate');
  assert.throws(() => parseNativeCheckOptions(['--supplementary'], '/tmp/model'), /explicit --build-dir/);
  for (const flags of [['--interactive'], ['--record'], ['--record-demo'], ['--supplementary'],
    ['--transition-diagnostics', '--build-dir', '/tmp/d']])
    assert.throws(() => parseNativeCheckOptions(['--supplementary', '--build-dir', '/tmp/candidate', ...flags], '/tmp/model'));
});
test('P0 follow-up is explicit and cannot combine with prior suites or capture modes', () => {
  assert.equal(parseNativeCheckOptions([], '/tmp/model').p0Tail, false);
  const options = parseNativeCheckOptions(['--p0-tail', '--build-dir', '/tmp/candidate'], '/tmp/model');
  assert.equal(options.p0Tail, true);
  assert.equal(options.supplementary, false);
  assert.throws(() => parseNativeCheckOptions(['--p0-tail'], '/tmp/model'), /explicit --build-dir/);
  for (const flags of [['--interactive'], ['--record'], ['--record-demo'], ['--supplementary'],
    ['--transition-diagnostics'], ['--p0-tail'], ['--perf-report', '/tmp/perf']])
    assert.throws(() => parseNativeCheckOptions(['--p0-tail', '--build-dir', '/tmp/candidate', ...flags], '/tmp/model'));
});
test('P1 settings check is explicit and extends only the ordinary two-cycle check', () => {
  assert.equal(parseNativeCheckOptions([], '/tmp/model').p1Settings, false);
  const options = parseNativeCheckOptions(['--p1-settings', '--build-dir', '/tmp/candidate'], '/tmp/model');
  assert.equal(options.p1Settings, true);
  assert.equal(options.p1Persona, false);
  assert.throws(() => parseNativeCheckOptions(['--p1-settings'], '/tmp/model'), /explicit --build-dir/);
  for (const flags of [['--interactive'], ['--record'], ['--record-demo'], ['--supplementary'], ['--p0-tail'],
    ['--p1-restore'], ['--p1-persona'], ['--p1-settings'], ['--transition-diagnostics']])
    assert.throws(() => parseNativeCheckOptions(['--p1-settings', '--build-dir', '/tmp/candidate', ...flags], '/tmp/model'));
});

test('P1 provider key check is explicit and extends only the ordinary two-cycle check', () => {
  assert.equal(parseNativeCheckOptions([], '/tmp/model').p1Provider, false);
  const options = parseNativeCheckOptions(['--p1-provider', '--build-dir', '/tmp/candidate'], '/tmp/model');
  assert.equal(options.p1Provider, true);
  assert.equal(options.p1Settings, false);
  assert.throws(() => parseNativeCheckOptions(['--p1-provider'], '/tmp/model'), /explicit --build-dir/);
  for (const flags of [['--interactive'], ['--record'], ['--supplementary'], ['--p0-tail'],
    ['--p1-restore'], ['--p1-persona'], ['--p1-settings'], ['--p1-provider'], ['--transition-diagnostics']])
    assert.throws(() => parseNativeCheckOptions(['--p1-provider', '--build-dir', '/tmp/candidate', ...flags], '/tmp/model'));
});

test('P1 first-run check is explicit and extends only the ordinary two-cycle check', () => {
  assert.equal(parseNativeCheckOptions([], '/tmp/model').p1Onboarding, false);
  const options = parseNativeCheckOptions(['--p1-onboarding', '--build-dir', '/tmp/candidate'], '/tmp/model');
  assert.equal(options.p1Onboarding, true);
  assert.equal(options.p1Provider, false);
  assert.throws(() => parseNativeCheckOptions(['--p1-onboarding'], '/tmp/model'), /explicit --build-dir/);
  for (const flags of [['--interactive'], ['--record'], ['--record-demo'], ['--supplementary'], ['--p0-tail'],
    ['--p1-restore'], ['--p1-persona'], ['--p1-settings'], ['--p1-provider'], ['--p1-onboarding'], ['--transition-diagnostics']])
    assert.throws(() => parseNativeCheckOptions(['--p1-onboarding', '--build-dir', '/tmp/candidate', ...flags], '/tmp/model'));
});

test('P1 memory paging check is explicit and extends only the ordinary two-cycle check', () => {
  assert.equal(parseNativeCheckOptions([], '/tmp/model').p1Memory, false);
  const options = parseNativeCheckOptions(['--p1-memory', '--build-dir', '/tmp/candidate'], '/tmp/model');
  assert.equal(options.p1Memory, true);
  assert.equal(options.p1Onboarding, false);
  assert.throws(() => parseNativeCheckOptions(['--p1-memory'], '/tmp/model'), /explicit --build-dir/);
  for (const flags of [['--interactive'], ['--record'], ['--record-demo'], ['--supplementary'], ['--p0-tail'],
    ['--p1-restore'], ['--p1-persona'], ['--p1-settings'], ['--p1-provider'], ['--p1-onboarding'], ['--p1-memory'],
    ['--transition-diagnostics']])
    assert.throws(() => parseNativeCheckOptions(['--p1-memory', '--build-dir', '/tmp/candidate', ...flags], '/tmp/model'));
});

test('P1 profile clear check is explicit and extends only the ordinary two-cycle check', () => {
  assert.equal(parseNativeCheckOptions([], '/tmp/model').p1Profile, false);
  const options = parseNativeCheckOptions(['--p1-profile', '--build-dir', '/tmp/candidate'], '/tmp/model');
  assert.equal(options.p1Profile, true);
  assert.equal(options.p1Memory, false);
  assert.throws(() => parseNativeCheckOptions(['--p1-profile'], '/tmp/model'), /explicit --build-dir/);
  for (const flag of ['--interactive', '--record', '--record-demo', '--supplementary', '--p0-tail',
    '--p1-restore', '--p1-persona', '--p1-settings', '--p1-provider', '--p1-onboarding', '--p1-memory',
    '--p1-profile', '--transition-diagnostics']) {
    for (const flags of [['--p1-profile', flag], [flag, '--p1-profile']])
      assert.throws(() => parseNativeCheckOptions([...flags, '--build-dir', '/tmp/candidate'], '/tmp/model'));
  }
});

test('candidate paging only extends explicit P1 memory and preserves the ordinary memory defaults', () => {
  const ordinary = parseNativeCheckOptions(['--p1-memory', '--build-dir', '/tmp/candidate'], '/tmp/model');
  assert.equal(ordinary.p1Memory, true);
  assert.equal(ordinary.candidatePaging, false);
  for (const flags of [['--p1-memory', '--candidate-paging'], ['--candidate-paging', '--p1-memory']]) {
    const extended = parseNativeCheckOptions([...flags, '--build-dir', '/tmp/candidate'], '/tmp/model');
    assert.equal(extended.p1Memory, true);
    assert.equal(extended.candidatePaging, true);
  }
  for (const flags of [[], ['--p1-profile'], ['--p1-persona'], ['--p1-settings'], ['--p1-provider'],
    ['--p1-onboarding'], ['--p1-restore'], ['--p0-tail'], ['--supplementary'], ['--transition-diagnostics']])
    assert.throws(() => parseNativeCheckOptions(['--candidate-paging', '--build-dir', '/tmp/candidate', ...flags], '/tmp/model'),
      /requires --p1-memory/);
  assert.throws(() => parseNativeCheckOptions(['--p1-memory', '--candidate-paging'], '/tmp/model'), /explicit --build-dir/);
  for (const flag of ['--candidate-paging', '--interactive', '--record', '--record-demo', '--p1-profile',
    '--p1-persona', '--p1-settings', '--p1-provider', '--p1-onboarding', '--p1-restore', '--p0-tail',
    '--supplementary', '--transition-diagnostics'])
    assert.throws(() => parseNativeCheckOptions(['--p1-memory', '--candidate-paging', '--build-dir', '/tmp/candidate', flag], '/tmp/model'));
});

test('P1 worldbook entry check is explicit and extends only the ordinary two-cycle check', () => {
  assert.equal(parseNativeCheckOptions([], '/tmp/model').p1WorldbookEntry, false);
  const options = parseNativeCheckOptions(['--p1-worldbook-entry', '--build-dir', '/tmp/candidate'], '/tmp/model');
  assert.equal(options.p1WorldbookEntry, true);
  assert.equal(options.p1Persona, false);
  assert.equal(options.p1Profile, false);
  assert.throws(() => parseNativeCheckOptions(['--p1-worldbook-entry'], '/tmp/model'), /explicit --build-dir/);
  for (const flags of [['--interactive'], ['--record'], ['--record-demo'], ['--supplementary'], ['--p0-tail'],
    ['--p1-restore'], ['--p1-persona'], ['--p1-settings'], ['--p1-provider'], ['--p1-onboarding'], ['--p1-memory'],
    ['--p1-profile'], ['--p1-worldbook-entry'], ['--transition-diagnostics']])
    assert.throws(() => parseNativeCheckOptions(['--p1-worldbook-entry', '--build-dir', '/tmp/candidate', ...flags], '/tmp/model'));
});

test('P1 worldbook regex is explicit and preserves all previous mode defaults', () => {
  assert.equal(parseNativeCheckOptions([], '/tmp/model').p1WorldbookRegex, false);
  const options = parseNativeCheckOptions(['--p1-worldbook-regex', '--build-dir', '/tmp/candidate'], '/tmp/model');
  assert.equal(options.p1WorldbookRegex, true);
  for (const key of ['p1WorldbookEntry','p1Persona','p1Memory','p1Settings']) assert.equal(options[key], false);
  assert.throws(() => parseNativeCheckOptions(['--p1-worldbook-regex'], '/tmp/model'), /requires an explicit --build-dir/);
});
test('P1 worldbook regex rejects every other suite and capture mode in either order', () => {
  for (const flag of ['--interactive','--record','--record-demo','--transition-diagnostics','--supplementary','--p0-tail',
    '--p1-restore','--p1-persona','--p1-settings','--p1-provider','--p1-onboarding','--p1-memory','--p1-profile','--p1-worldbook-entry'])
    for (const flags of [['--p1-worldbook-regex',flag],[flag,'--p1-worldbook-regex']])
      assert.throws(() => parseNativeCheckOptions([...flags,'--build-dir','/tmp/candidate'],'/tmp/model'), /--p1-worldbook-regex only extends/);
  assert.throws(() => parseNativeCheckOptions(['--p1-worldbook-regex','--candidate-paging','--build-dir','/tmp/candidate'],'/tmp/model'), /--candidate-paging requires --p1-memory/);
  assert.throws(() => parseNativeCheckOptions(['--p1-worldbook-regex','--p1-worldbook-regex','--build-dir','/tmp/candidate'],'/tmp/model'), /Usage: check-qt-macos.sh/);
});

test('worldbook injection only extends ordinary isolated two-cycle controls with an explicit candidate',()=>{
  assert.equal(parseNativeCheckOptions([], '/tmp/model').p1WorldbookInjection,false);
  assert.equal(parseNativeCheckOptions(['--p1-worldbook-injection','--build-dir','/tmp/candidate'],'/tmp/model').p1WorldbookInjection,true);
  assert.throws(()=>parseNativeCheckOptions(['--p1-worldbook-injection'],'/tmp/model'),/requires an explicit --build-dir/);
  for(const flag of ['--interactive','--record','--record-demo','--transition-diagnostics','--supplementary','--p0-tail','--p1-restore','--p1-persona','--p1-settings','--p1-provider','--p1-onboarding','--p1-memory','--p1-profile','--p1-worldbook-entry','--p1-worldbook-regex'])
    for(const flags of [['--p1-worldbook-injection',flag],[flag,'--p1-worldbook-injection']])
      assert.throws(()=>parseNativeCheckOptions([...flags,'--build-dir','/tmp/candidate'],'/tmp/model'),/--p1-worldbook-injection only extends/);
  assert.throws(()=>parseNativeCheckOptions(['--p1-worldbook-injection','--p1-worldbook-injection','--build-dir','/tmp/candidate'],'/tmp/model'),/Usage: check-qt-macos.sh/);
});
