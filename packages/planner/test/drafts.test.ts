import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  lintBatch, lintDraft, orderForFiling, parseProposals, plannerKeyOf, renderBody, type IssueDraft,
} from '../src/drafts.js';
import { GOOD_BODY } from './fixtures.js';

function draft(over: Partial<IssueDraft> = {}): IssueDraft {
  return { key: 'runs-csv-export', title: 'Export the runs ledger as CSV', body: GOOD_BODY, ...over };
}

test('a rubric-compliant draft lints ok with computed labels', () => {
  const l = lintDraft(draft());
  assert.equal(l.verdict, 'ok', l.reasons.join('; '));
  assert.equal(l.computed.criteria, 3);
  assert.equal(l.computed.difficulty, 'standard');
  assert.ok(l.computed.labels.includes('difficulty:standard'));
  assert.ok(l.computed.labels.includes('triaged'), 'the planner did the sizing, so the engine must not re-triage');
  assert.equal(l.computed.wouldTriage, false);
});

test('no acceptance criteria is a reject, not a warning', () => {
  const l = lintDraft(draft({ body: '## Goal\nMake things better.' }));
  assert.equal(l.verdict, 'reject');
  assert.ok(l.reasons.some((r) => /underspecified/.test(r)));
});

test('8 criteria is oversized: reject with a split instruction', () => {
  const body = GOOD_BODY + '\n' + Array.from({ length: 5 }, (_, i) => `- [ ] Extra criterion ${i + 1} that is separately checkable.`).join('\n');
  const l = lintDraft(draft({ body }));
  assert.equal(l.verdict, 'reject');
  assert.ok(l.reasons.some((r) => /oversized — split it/.test(r)));
});

test('scope-deferring phrases warn; a sloppy key is normalised, an empty one rejects', () => {
  const l = lintDraft(draft({ key: 'Bad Key!!', body: GOOD_BODY.replace('no new query semantics', 'handle the usual filters etc') }));
  assert.equal(l.verdict, 'warn');
  assert.equal(l.key, 'bad-key');
  assert.ok(l.reasons.some((r) => /scope-deferring/.test(r)));
  const empty = lintDraft(draft({ key: '   ' }));
  assert.equal(empty.verdict, 'reject');
  assert.ok(empty.reasons.some((r) => /stable slug/.test(r)));
});

test('a draft a worktree-bound student cannot finish is rejected unless marked needsHuman', () => {
  const blocked = lintDraft(draft({ labels: ['needs-credentials'] }));
  assert.equal(blocked.verdict, 'reject');
  assert.ok(blocked.reasons.some((r) => /not buildable/.test(r)));
  const parked = lintDraft(draft({ labels: ['needs-credentials'], needsHuman: true }));
  assert.notEqual(parked.verdict, 'reject');
  assert.ok(parked.computed.labels.includes('needs-human'));
});

test('difficulty may be raised by the planner, never lowered', () => {
  assert.equal(lintDraft(draft({ difficulty: 'hard' })).computed.difficulty, 'hard');
  const lowered = lintDraft(draft({ difficulty: 'simple' }));
  assert.equal(lowered.computed.difficulty, 'standard');
  assert.equal(lowered.verdict, 'warn');
});

test('dependencies must name a batch key or an open issue; Owns: has exactly one owner', () => {
  const a = draft({ key: 'a', owns: ['packages/dashboard/src/csv.ts'] });
  const b = draft({ key: 'b', title: 'Second piece', dependsOn: ['a', '#7', 'ghost'], owns: ['packages/dashboard/src/csv.ts'] });
  const lints = lintBatch([a, b], { openIssues: [{ number: 7, title: 'x', body: '' }] });
  const lb = lints.find((l) => l.key === 'b')!;
  assert.equal(lb.verdict, 'reject');
  assert.ok(lb.reasons.some((r) => /"ghost" is not a draft key/.test(r)));
  assert.ok(lb.reasons.some((r) => /owned by draft "a" too/.test(r)));
  const closedDep = lintDraft(draft({ dependsOn: [99] }), { openIssues: [] });
  assert.equal(closedDep.verdict, 'warn');
});

test('a duplicate key in a batch rejects both, and a look-alike open title warns', () => {
  const lints = lintBatch([draft(), draft({ title: 'Export the runs ledger as CSV file' })], {
    openIssues: [{ number: 3, title: 'Export the runs ledger as CSV', body: '' }],
  });
  assert.ok(lints.every((l) => l.verdict === 'reject'));
  const dup = lintDraft(draft(), { openIssues: [{ number: 3, title: 'Export the runs ledger as a CSV', body: '' }] });
  assert.equal(dup.duplicateOf?.number, 3);
});

test('orderForFiling puts dependencies first and refuses a cycle', () => {
  const a = draft({ key: 'a', dependsOn: ['b'] });
  const b = draft({ key: 'b' });
  const c = draft({ key: 'c', dependsOn: ['a', 12] });
  assert.deepEqual(orderForFiling([c, a, b]).map((d) => d.key), ['b', 'a', 'c']);
  assert.throws(() => orderForFiling([draft({ key: 'x', dependsOn: ['y'] }), draft({ key: 'y', dependsOn: ['x'] })]), /dependency cycle/);
});

test('renderBody substitutes real numbers, appends Owns and the key footer', () => {
  const body = renderBody(draft({ dependsOn: ['base-piece', '#4'], owns: ['a.ts', 'b.ts', 'a.ts'] }), new Map([['base-piece', 41]]), 'abcdef0123456789');
  assert.ok(body.endsWith('<!-- planner-key: runs-csv-export rubric:abcdef012345 -->'));
  assert.ok(body.includes('\nDepends on #41\nDepends on #4\nOwns: a.ts, b.ts\n'));
  assert.equal(plannerKeyOf(body), 'runs-csv-export');
  assert.throws(() => renderBody(draft({ dependsOn: ['nope'] }), new Map()), /no issue number yet/);
});

test('parseProposals reads the fenced fallback block and drops malformed entries', () => {
  const text = 'Here you go:\n```planner-proposals\n[{"key":"a","title":"A","body":"b"},{"title":"no key"}]\n```';
  assert.deepEqual(parseProposals(text).map((d) => d.key), ['a']);
  assert.deepEqual(parseProposals('nothing here'), []);
});
