'use strict';
// Node 24 test reporter interface: this consumes events, never imports tests.
// Use alongside TAP in the SAME node --test process, with paired destinations:
// --test-reporter=tap --test-reporter=./script/registered_run/node_identity_reporter.cjs
// --test-reporter-destination=<tap.log> --test-reporter-destination=<identities.jsonl>
// API: https://nodejs.org/docs/latest-v24.x/api/test.html#custom-reporters
// Event locations/status/summary are copied from actual node:test events.
const SCHEMA = 'reverie.registered-run.node-events.v1';
module.exports = async function* identityReporter(source) {
  let sequence = 0;
  let cases = 0;
  let summaries = 0;
  yield JSON.stringify({schema: SCHEMA, type: 'stream:start', nodeVersion: process.version}) + '\n';
  for await (const event of source) {
    if (event.type === 'test:pass' || event.type === 'test:fail') {
      const data = event.data || {};
      const details = data.details || {};
      yield JSON.stringify({schema: SCHEMA, sequence: ++sequence, type: event.type,
        data: {file: data.file ?? null, name: data.name ?? null,
          line: data.line ?? null, column: data.column ?? null,
          nesting: data.nesting ?? null, testNumber: data.testNumber ?? null,
          skip: data.skip ?? null, todo: data.todo ?? null,
          reportedType: details.type ?? null,
          failureType: details.error?.failureType ?? null}}) + '\n';
      cases++;
    } else if (event.type === 'test:summary') {
      const data = event.data || {};
      yield JSON.stringify({schema: SCHEMA, sequence: ++sequence, type: event.type,
        data: {file: data.file ?? null, counts: data.counts ?? null,
          success: data.success ?? null}}) + '\n';
      summaries++;
    }
  }
  yield JSON.stringify({schema: SCHEMA, type: 'stream:end', events: sequence, cases, summaries}) + '\n';
};
