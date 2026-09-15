import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyEmptyRun, criteriaCount } from '../src/emptyRun.js';

// A run that writes no diff is charged as a no-progress heartbeat, and nine of
// those give up on the item. Right when the student failed; wrong when the work
// was already on the base branch and an empty diff was the correct answer.
// dungeonworks #110/#111 burned 9 and 6 dispatches on exactly that.

test('every criterion DONE reads as already satisfied', () => {
  const text = [
    'I found composer/manifest.py already present and complete; no changes needed.',
    '',
    '1. Sticker and AssetManifest subclass DWModel - DONE',
    '2. interaction_kind enum with the five values - DONE',
    '3. footprint is 2 ints, 1..32 - DONE',
  ].join('\n');
  assert.equal(classifyEmptyRun(text), 'satisfied');
  assert.equal(criteriaCount(text), 3);
});

test('a single NOT DONE is blocked, never satisfied', () => {
  const text = [
    '1. models defined - DONE',
    '2. loader with lru_cache - NOT DONE',
    '3. fingerprint stable - DONE',
  ].join('\n');
  assert.equal(classifyEmptyRun(text), 'blocked');
});

test('NOT DONE is never read as DONE', () => {
  // The one error this module must not make: "NOT DONE" contains "DONE", so a
  // naive DONE-first match reads every failure as a success and would close
  // items whose work was never written.
  for (const v of ['NOT DONE', 'not done', 'NOT_DONE', 'Not-Done', 'NOT  DONE']) {
    assert.equal(classifyEmptyRun(`1. the criterion - ${v}`), 'blocked', v);
  }
});

test('no readable verdict abstains, keeping the old behaviour', () => {
  for (const t of [
    '',
    '   ',
    'I could not run the tests because the database was unreachable.',
    'Summary: made no changes.',
  ]) {
    assert.equal(classifyEmptyRun(t), 'unknown', JSON.stringify(t));
  }
});

test('common student formats are all recognised', () => {
  const formats = [
    '- [x] criterion one DONE\n- [x] criterion two DONE',
    '1) first thing DONE\n2) second thing DONE',
    '* schema layer - DONE\n* query surface - DONE',
    'criterion 1 — DONE\ncriterion 2 — DONE',
  ];
  for (const f of formats) assert.equal(classifyEmptyRun(f), 'satisfied', f);
});

test('prose mentioning the word done does not fabricate a criterion', () => {
  // "when I am done" must not become a satisfied verdict on its own; a verdict
  // has to sit at the end of its line.
  const text = 'I will report back when I am done investigating the failure.\nNothing changed.';
  assert.equal(classifyEmptyRun(text), 'unknown');
});

test('a mixed report with a trailing summary still blocks', () => {
  const text = [
    'Summary: extended the loader.',
    '1. load_manifest resolves via env - DONE',
    '2. clear_manifest_cache companion - NOT DONE',
    '',
    'I could not finish criterion 2 without the schema PR landing first.',
  ].join('\n');
  assert.equal(classifyEmptyRun(text), 'blocked');
});
