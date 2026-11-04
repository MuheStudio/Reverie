'use strict';
const path = require('node:path');
const assert = require('node:assert/strict');

function parseNativeCheckOptions(args, defaultModel) {
  const options = { interactive: false, recordUI: false, recordDemo: false,
    transitionDiagnostics: false, supplementary: false, p0Tail: false, p1Restore: false, p1Persona: false, p1Settings: false, p1Provider: false, p1Onboarding: false, p1Memory: false, candidatePaging: false, p1Profile: false, p1WorldbookEntry: false, p1WorldbookRegex: false, p1WorldbookInjection: false, buildDir: '', model: defaultModel };
  let selectedModel = false;
  for (let index = 0; index < args.length; ++index) {
    const argument = args[index];
    if (argument === '--interactive' && !options.interactive) options.interactive = true;
    else if (argument === '--record' && !options.recordUI) options.recordUI = true;
    else if (argument === '--record-demo' && !options.recordUI) {
      options.recordUI = true; options.recordDemo = true;
    } else if (argument === '--transition-diagnostics' && !options.transitionDiagnostics)
      options.transitionDiagnostics = true;
    else if (argument === '--supplementary' && !options.supplementary) options.supplementary = true;
    else if (argument === '--p0-tail' && !options.p0Tail) options.p0Tail = true;
    else if (argument === '--p1-restore' && !options.p1Restore) options.p1Restore = true;
    else if (argument === '--p1-persona' && !options.p1Persona) options.p1Persona = true;
    else if (argument === '--p1-settings' && !options.p1Settings) options.p1Settings = true;
    else if (argument === '--p1-provider' && !options.p1Provider) options.p1Provider = true;
    else if (argument === '--p1-onboarding' && !options.p1Onboarding) options.p1Onboarding = true;
    else if (argument === '--p1-memory' && !options.p1Memory) options.p1Memory = true;
    else if (argument === '--candidate-paging' && !options.candidatePaging) options.candidatePaging = true;
    else if (argument === '--p1-profile' && !options.p1Profile) options.p1Profile = true;
    else if (argument === '--p1-worldbook-entry' && !options.p1WorldbookEntry) options.p1WorldbookEntry = true;
    else if (argument === '--p1-worldbook-regex' && !options.p1WorldbookRegex) options.p1WorldbookRegex = true;
    else if (argument === '--p1-worldbook-injection' && !options.p1WorldbookInjection) options.p1WorldbookInjection = true;
    else if (argument === '--build-dir' && !options.buildDir && path.isAbsolute(args[index + 1] || ''))
      options.buildDir = args[++index];
    else if (argument === '--model' && !selectedModel && path.isAbsolute(args[index + 1] || '')) {
      selectedModel = true; options.model = args[++index];
    } else throw Error('Usage: check-qt-macos.sh [--build-dir ABS_BUILD_DIRECTORY] [--model ABS_TEST_COPY] [--interactive] [--record|--record-demo] [--transition-diagnostics] [--supplementary|--p0-tail|--p1-restore|--p1-persona|--p1-settings|--p1-provider|--p1-onboarding|--p1-memory [--candidate-paging]|--p1-profile|--p1-worldbook-entry|--p1-worldbook-regex|--p1-worldbook-injection]');
  }
  assert(!options.recordUI || !options.interactive, '--record requires the automated isolated scenario');
  assert(!options.candidatePaging || options.p1Memory, '--candidate-paging requires --p1-memory');
  if (options.transitionDiagnostics) {
    assert(options.buildDir, '--transition-diagnostics requires an explicit --build-dir');
    assert(!options.interactive && !options.recordDemo,
      '--transition-diagnostics requires original automated controls; interactive and record-demo are forbidden');
  }
  if (options.supplementary) {
    assert(options.buildDir, '--supplementary requires an explicit --build-dir');
    assert(!options.interactive && !options.recordUI && !options.transitionDiagnostics && !options.p0Tail,
      '--supplementary runs only the automated isolated function audit');
  }
  if (options.p0Tail) {
    assert(options.buildDir, '--p0-tail requires an explicit --build-dir');
    assert(!options.interactive && !options.recordUI && !options.transitionDiagnostics && !options.supplementary,
      '--p0-tail runs only the new automated isolated follow-up batch');
  }
  if (options.p1Restore) {
    assert(options.buildDir, '--p1-restore requires an explicit --build-dir');
    assert(!options.interactive && !options.recordUI && !options.transitionDiagnostics && !options.supplementary && !options.p0Tail,
      '--p1-restore only extends the ordinary isolated two-cycle control check');
  }
  if (options.p1Persona) {
    assert(options.buildDir, '--p1-persona requires an explicit --build-dir');
    assert(!options.interactive && !options.recordUI && !options.transitionDiagnostics && !options.supplementary && !options.p0Tail && !options.p1Restore,
      '--p1-persona only extends the ordinary isolated two-cycle control check');
  }
  if (options.p1Settings) {
    assert(options.buildDir, '--p1-settings requires an explicit --build-dir');
    assert(!options.interactive && !options.recordUI && !options.transitionDiagnostics && !options.supplementary && !options.p0Tail && !options.p1Restore && !options.p1Persona,
      '--p1-settings only extends the ordinary isolated two-cycle control check');
  }
  if (options.p1Provider) {
    assert(options.buildDir, '--p1-provider requires an explicit --build-dir');
    assert(!options.interactive && !options.recordUI && !options.transitionDiagnostics && !options.supplementary && !options.p0Tail && !options.p1Restore && !options.p1Persona && !options.p1Settings,
      '--p1-provider only extends the ordinary isolated two-cycle control check');
  }
  if (options.p1Onboarding) {
    assert(options.buildDir, '--p1-onboarding requires an explicit --build-dir');
    assert(!options.interactive && !options.recordUI && !options.transitionDiagnostics && !options.supplementary && !options.p0Tail && !options.p1Restore && !options.p1Persona && !options.p1Settings && !options.p1Provider,
      '--p1-onboarding only extends the ordinary isolated two-cycle control check');
  }
  if (options.p1Memory) {
    assert(options.buildDir, '--p1-memory requires an explicit --build-dir');
    assert(!options.interactive && !options.recordUI && !options.transitionDiagnostics && !options.supplementary && !options.p0Tail && !options.p1Restore && !options.p1Persona && !options.p1Settings && !options.p1Provider && !options.p1Onboarding,
      '--p1-memory only extends the ordinary isolated two-cycle control check');
  }
  if (options.p1Profile) {
    assert(options.buildDir, '--p1-profile requires an explicit --build-dir');
    assert(!options.interactive && !options.recordUI && !options.transitionDiagnostics && !options.supplementary && !options.p0Tail && !options.p1Restore && !options.p1Persona && !options.p1Settings && !options.p1Provider && !options.p1Onboarding && !options.p1Memory,
      '--p1-profile only extends the ordinary isolated two-cycle control check');
  }
  if (options.p1WorldbookEntry) {
    assert(options.buildDir, '--p1-worldbook-entry requires an explicit --build-dir');
    assert(!options.interactive && !options.recordUI && !options.transitionDiagnostics && !options.supplementary && !options.p0Tail && !options.p1Restore && !options.p1Persona && !options.p1Settings && !options.p1Provider && !options.p1Onboarding && !options.p1Memory && !options.p1Profile,
      '--p1-worldbook-entry only extends the ordinary isolated two-cycle control check');
  }
  if (options.p1WorldbookRegex) {
    assert(options.buildDir, '--p1-worldbook-regex requires an explicit --build-dir');
    assert(!options.interactive && !options.recordUI && !options.transitionDiagnostics && !options.supplementary && !options.p0Tail && !options.p1Restore && !options.p1Persona && !options.p1Settings && !options.p1Provider && !options.p1Onboarding && !options.p1Memory && !options.p1Profile && !options.p1WorldbookEntry,
      '--p1-worldbook-regex only extends the ordinary isolated two-cycle control check');
  }
  if (options.p1WorldbookInjection) {
    assert(options.buildDir, '--p1-worldbook-injection requires an explicit --build-dir');
    assert(!options.interactive && !options.recordUI && !options.transitionDiagnostics && !options.supplementary && !options.p0Tail && !options.p1Restore && !options.p1Persona && !options.p1Settings && !options.p1Provider && !options.p1Onboarding && !options.p1Memory && !options.p1Profile && !options.p1WorldbookEntry && !options.p1WorldbookRegex,
      '--p1-worldbook-injection only extends the ordinary isolated two-cycle control check');
  }
  return options;
}
function validateTransitionBuildMode(record) {
  assert.equal(record.diagnostics?.timingProbesEnabled, true,
    'Transition diagnostics require a separate timing diagnostic candidate');
  assert.equal(record.diagnostics?.qmlProfilerEnabled, false,
    'Transition diagnostics forbid QML profiler candidates');
  assert.equal(record.diagnostics?.ordinaryLauncherAllowed, false,
    'Transition diagnostics require the ordinary-launcher diagnostic gate');
}
module.exports = { parseNativeCheckOptions, validateTransitionBuildMode };
