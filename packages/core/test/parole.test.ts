import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sentenceMs, isDue, dueForParole, reoffend, firstOffence, parseParole, serializeParole,
  DEFAULT_PAROLE,
} from '../src/parole.js';

// Quarantine had two exits: a human deleting the label, and a PR passing review.
// So an item condemned by a bad hour stayed condemned. A session limit took ten
// healthy issues on 2026-08-13; a segfaulting CLI took twenty-two on 2026-08-22.
// Both were environments failing, and both times real work sat behind a label
// until someone noticed.

const HOUR = 60 * 60_000;
const T = 1_760_000_000_000;

test('a first offence serves the first sentence, then is due', () => {
  const rec = firstOffence(T);
  assert.equal(sentenceMs(rec), DEFAULT_PAROLE.firstMs);
  assert.equal(isDue(rec, T + DEFAULT_PAROLE.firstMs - 1), false);
  assert.equal(isDue(rec, T + DEFAULT_PAROLE.firstMs), true);
});

test('re-offending lengthens the sentence', () => {
  const first = firstOffence(T);
  const second = reoffend(first, T);
  const third = reoffend(second, T);
  assert.equal(second.paroles, 1);
  assert.equal(sentenceMs(second), DEFAULT_PAROLE.firstMs * 2);
  assert.equal(sentenceMs(third), DEFAULT_PAROLE.firstMs * 4);
});

test('the sentence is capped, so a bad item costs about one dispatch a day', () => {
  let rec = firstOffence(T);
  for (let i = 0; i < 20; i++) rec = reoffend(rec, T);
  assert.equal(sentenceMs(rec), DEFAULT_PAROLE.maxMs);
});

test('nothing is held forever, whatever condemned it', () => {
  // The property that matters: this needs to know nothing about causes, so a
  // novel outage nobody has written a classifier for still cannot hold the board.
  const rec = firstOffence(T);
  assert.equal(isDue(rec, T + DEFAULT_PAROLE.maxMs), true);
});

test('due items come back oldest-first', () => {
  const recs: [string, { at: number; paroles: number }][] = [
    ['owner/name:issue-3', { at: T - 5 * HOUR, paroles: 0 }],
    ['owner/name:issue-1', { at: T - 9 * HOUR, paroles: 0 }],
    ['owner/name:issue-2', { at: T - 1 * HOUR, paroles: 0 }],  // still serving
  ];
  assert.deepEqual(dueForParole(recs, T), ['owner/name:issue-1', 'owner/name:issue-3']);
});

// quarantine.json used to be a bare string[]. Those keys are real quarantines:
// dropping them would un-park everything a previous run condemned, and dating
// them from zero would release the whole backlog on the first tick after upgrade.
test('the legacy bare-string file still loads, dated from now', () => {
  const m = parseParole(['owner/name:pr-12', 'owner/name:issue-4'], T);
  assert.equal(m.size, 2);
  assert.deepEqual(m.get('owner/name:pr-12'), { at: T, paroles: 0 });
  assert.equal(isDue(m.get('owner/name:pr-12')!, T), false, 'a full first sentence, not instant release');
});

test('the current shape round-trips', () => {
  const m = parseParole([{ key: 'owner/name:issue-9', at: T, paroles: 2 }], T);
  assert.deepEqual(m.get('owner/name:issue-9'), { at: T, paroles: 2 });
  assert.deepEqual(serializeParole(m), [{ key: 'owner/name:issue-9', at: T, paroles: 2 }]);
});

test('garbage entries are skipped rather than throwing', () => {
  const m = parseParole([null, 42, {}, { key: '' }, { key: 'ok', at: 'x', paroles: -3 }], T);
  assert.deepEqual([...m.keys()], ['ok']);
  assert.deepEqual(m.get('ok'), { at: T, paroles: 0 });
});

// (v1 pinned the runner's parole sweep by regex over live.ts source. That wiring
// belongs to the v2 Governance unit and is tested there behaviourally, not here.)
