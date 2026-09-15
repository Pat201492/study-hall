import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fairShare, RANKED_KINDS } from '../src/classify.js';
import type { BoardAction } from '../src/classify.js';

// The fair-share merge (#124). Ladder rank still dominates — finishing in-flight
// work before starting new work is the point of the ladder, and it holds across
// repos too. Within a rank, repos take turns, so a board with 30 ready issues
// cannot take every slot ahead of a board with 2.
//
const act = (kind: BoardAction['kind'], repo: string, n: number): BoardAction =>
  ({ kind, target: 'issue', number: n, role: null, reason: '', repo } as unknown as BoardAction);
const repoOf = (a: BoardAction) => (a as unknown as { repo: string }).repo;

test('a single repo passes straight through, order untouched', () => {
  const only = [act('IMPLEMENT', 'a', 1), act('IMPLEMENT', 'a', 2)];
  assert.deepEqual(fairShare(new Map([['a', only]])), only);
});

test('a long board cannot monopolise a short one', () => {
  const big = Array.from({ length: 30 }, (_, i) => act('IMPLEMENT', 'big', i));
  const small = [act('IMPLEMENT', 'small', 1), act('IMPLEMENT', 'small', 2)];
  const out = fairShare(new Map([['big', big], ['small', small]]));
  // Both of the small board's items land within the first four slots, rather
  // than behind all thirty.
  const firstFour = out.slice(0, 4).map(repoOf);
  assert.equal(firstFour.filter((r) => r === 'small').length, 2);
});

test('ladder rank still dominates across repos', () => {
  const a = [act('IMPLEMENT', 'a', 1)];
  const b = [act('MERGE', 'b', 2), act('FIX', 'b', 3)];
  const out = fairShare(new Map([['a', a], ['b', b]]));
  // Finishing in-flight work comes before starting new work, whichever repo.
  assert.deepEqual(out.map((x) => x.kind), ['MERGE', 'FIX', 'IMPLEMENT']);
});

test('the starting turn rotates, so one repo is not always first', () => {
  const a = [act('IMPLEMENT', 'a', 1)];
  const b = [act('IMPLEMENT', 'b', 1)];
  const m = new Map([['a', a], ['b', b]]);
  assert.equal(repoOf(fairShare(m, 0)[0]), 'a');
  assert.equal(repoOf(fairShare(m, 1)[0]), 'b');
});

test('every action survives the merge — sharing must not drop work', () => {
  const a = Array.from({ length: 5 }, (_, i) => act('IMPLEMENT', 'a', i));
  const b = Array.from({ length: 3 }, (_, i) => act('REVIEW', 'b', i));
  const out = fairShare(new Map([['a', a], ['b', b]]));
  assert.equal(out.length, 8);
  assert.equal(new Set(out).size, 8);
});

test('empty boards are skipped without disturbing the rotation', () => {
  const out = fairShare(new Map([['a', []], ['b', [act('IMPLEMENT', 'b', 1)]], ['c', []]]));
  assert.deepEqual(out.map(repoOf), ['b']);
});

// The ladder order the merge walks must come from classify's own RANK, not a
// second hand-written copy. Three copies existed before this: RANK, the private
// method's local list, and this test file's. Reordering RANK silently left the
// merge on the old order.
test('the merge walks classify’s own ladder order, not a restated copy', () => {
  // TRIAGE sits directly above IMPLEMENT: assessing whether an issue is one
  // PR's worth of work is only useful BEFORE a student writes code against it.
  assert.deepEqual(RANKED_KINDS, ['MERGE', 'FIX', 'RESOLVE', 'REVIEW', 'PROMOTE', 'NEEDS_DETAIL', 'TRIAGE', 'IMPLEMENT']);
  assert.equal(RANKED_KINDS.indexOf('TRIAGE'), RANKED_KINDS.indexOf('IMPLEMENT') - 1);
  // NEEDS_DETAIL sits directly above TRIAGE for the same reason one step
  // earlier: splitting an issue that states no criteria only yields several
  // issues that state no criteria.
  assert.equal(RANKED_KINDS.indexOf('NEEDS_DETAIL'), RANKED_KINDS.indexOf('TRIAGE') - 1);
  // And the merge actually honours it: a low-rank action from the first repo
  // still loses to a high-rank action from the second.
  const out = fairShare(new Map([
    ['a', [act('IMPLEMENT', 'a', 1)]],
    ['b', [act('MERGE', 'b', 2)]],
  ]));
  assert.equal(out[0].kind, 'MERGE');
});

test('a negative or large cursor still selects a valid repo', () => {
  // LiveRunner passes an ever-incrementing counter; it must never index out of
  // range, and must stay stable if it were ever to go negative.
  const m = new Map([['a', [act('IMPLEMENT', 'a', 1)]], ['b', [act('IMPLEMENT', 'b', 2)]]]);
  for (const cursor of [-3, -1, 0, 1, 999]) {
    const out = fairShare(m, cursor);
    assert.equal(out.length, 2, `cursor ${cursor} dropped work`);
  }
});
