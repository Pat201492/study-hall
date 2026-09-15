import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyCiFailure, ciFixDirective } from '../src/ciFailure.js';

// #172: classify a red CI log so the fixer is told what it is looking at — and
// so a HARNESS failure (the suite never ran) is never answered by rewriting
// tests. The classifier is pure over the log text.

// The exact log from the incident: a Node/undici skew meant the vitest env could
// not construct, so ZERO tests ran. The acceptance says this returns `harness`.
const HARNESS_LOG = `
TypeError: webidl.util.markAsUncloneable is not a function
  ❯ node_modules/undici/lib/web/cache/cachestorage.js:20
  ❯ node_modules/jsdom/lib/api.js:12

 Test Files  no tests
      Tests  no tests
     Errors  13 errors
`;

test('the incident log classifies as harness (acceptance)', () => {
  assert.equal(classifyCiFailure(HARNESS_LOG), 'harness');
});

test('the harness directive forbids editing test files (acceptance)', () => {
  const dir = ciFixDirective('harness').join('\n');
  assert.match(dir, /HARNESS/);
  assert.match(dir, /NEVER RAN|never ran/i);
  assert.match(dir, /do NOT edit.*test/i);
});

test('a collection/import error with no tests run is harness', () => {
  const log = `Error: Cannot find module './helpers'\n at Object.<anonymous>\nNo test files found.`;
  assert.equal(classifyCiFailure(log), 'harness');
});

test('named assertion failures classify as assertion (acceptance)', () => {
  const log = `
 FAIL  src/math.test.ts > adds numbers
AssertionError: expected 4 to be 5
 ❯ src/math.test.ts:8:20

 Test Files  1 failed (1)
      Tests  1 failed | 2 passed (3)
`;
  assert.equal(classifyCiFailure(log), 'assertion');
});

test('a passing count keeps a stray import string from demoting to harness', () => {
  // "cannot find module" appears, but 5 tests passed -> the harness booted.
  const log = `some log mentioning cannot find module in a stack\nTests  1 failed | 5 passed (6)\nAssertionError: nope`;
  assert.equal(classifyCiFailure(log), 'assertion');
});

test('OOM / killed runner is infra', () => {
  assert.equal(classifyCiFailure('FATAL ERROR: JavaScript heap out of memory'), 'infra');
  assert.equal(classifyCiFailure('The runner has received a shutdown signal'), 'infra');
  assert.equal(classifyCiFailure('##[error]The operation was canceled.'), 'infra');
});

test('a per-test timeout is a real failure (assertion), not infra', () => {
  assert.equal(classifyCiFailure('Test timed out in 5000ms\n 1 failed'), 'assertion');
});

test('a typecheck-only failure is static', () => {
  const log = `src/index.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.`;
  assert.equal(classifyCiFailure(log), 'static');
});

test('an eslint-only failure is static', () => {
  const log = `/repo/src/a.js\n  10:1  error  'x' is assigned a value but never used  no-unused-vars\n\n✖ 1 problem (1 error, 0 warnings)`;
  assert.equal(classifyCiFailure(log), 'static');
});

test('an empty or unrecognised log is unknown, and yields no directive', () => {
  assert.equal(classifyCiFailure(''), 'unknown');
  assert.equal(classifyCiFailure('   '), 'unknown');
  assert.deepEqual(ciFixDirective('unknown'), []);
});

test('each actionable class produces a non-empty directive', () => {
  for (const c of ['harness', 'assertion', 'infra', 'static'] as const) {
    assert.ok(ciFixDirective(c).length > 0, `${c} should have a directive`);
  }
});
