'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { validateOrdinaryBuildMode } = require('./build-record.cjs');
test('ordinary dev and native-check gate refuses timing-only and combined diagnostic candidates', () => {
  validateOrdinaryBuildMode({});
  validateOrdinaryBuildMode({ diagnostics: { qmlProfilerEnabled: false, timingProbesEnabled: false, ordinaryLauncherAllowed: true } });
  for (const diagnostics of [{ qmlProfilerEnabled: true }, { timingProbesEnabled: true },
    { timingProbesEnabled: true, qmlProfilerEnabled: true }, { ordinaryLauncherAllowed: false }])
    assert.throws(() => validateOrdinaryBuildMode({ diagnostics }), /diagnostic performance entry/);
});
