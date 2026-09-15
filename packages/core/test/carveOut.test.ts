import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parentIssue, carveOuts, candidatesForSweep, parentsToResolve, supersededBy,
  type ParentClosure,
} from '../src/carveOut.js';

// dungeonworks: #45 was split into #110 and #111 on 2026-08-14. The next day PR
// #129 implemented #45 wholesale and closed it. The carve-outs were never
// closed, so the board dispatched them against merged work 9 and 6 times.

const footer = (n: number) => `Goal: ...\n\n---\nCarved out of #${n} by scope triage. Covers: 1, 2`;
const humanFooter = (n: number) => `Goal: ...\n\n---\nCarved out of #${n}, which needs a human for: X`;

test('both writers\' footers are recognised', () => {
  assert.equal(parentIssue(footer(45)), 45);
  assert.equal(parentIssue(humanFooter(45)), 45);
});

test('a passing mention in prose is not a parent', () => {
  // Anchored to line start, so discussion of a carve-out cannot register one.
  const body = 'This is unrelated to the work carved out of #12 last week.';
  assert.equal(parentIssue(body), null);
});

test('a non-carve-out has no parent', () => {
  assert.equal(parentIssue('Ordinary issue body.'), null);
  assert.equal(parentIssue(''), null);
});

test('an issue claiming to be carved out of itself is dropped', () => {
  // Malformed, not a cycle to chase — and letting it through would let the item
  // park itself the moment it closed.
  assert.deepEqual(carveOuts([{ number: 7, body: footer(7) }]), []);
});

test('only carve-outs whose parent is CLOSED cost an API call', () => {
  const issues = [
    { number: 110, body: footer(45) },
    { number: 111, body: footer(45) },
    { number: 120, body: footer(99) },   // #99 still open
    { number: 130, body: 'plain issue' },
  ];
  const open = new Set([110, 111, 120, 130, 99]); // 45 absent => closed
  const cands = candidatesForSweep(carveOuts(issues), open);
  assert.deepEqual(cands.map((c) => c.child), [110, 111]);
  assert.deepEqual(parentsToResolve(cands), [45], 'one parent shared by two pieces is ONE call');
});

test('a completed parent closed by a PR supersedes its carve-outs', () => {
  const cands = [{ child: 110, parent: 45 }, { child: 111, parent: 45 }];
  const closure = new Map<number, ParentClosure>([
    [45, { closed: true, completed: true, byPr: 129 }],
  ]);
  assert.deepEqual(supersededBy(cands, closure), [
    { child: 110, parent: 45, pr: 129 },
    { child: 111, parent: 45, pr: 129 },
  ]);
});

test('NOT_PLANNED never supersedes — the pieces may be why it was closed', () => {
  const cands = [{ child: 110, parent: 45 }];
  const closure = new Map<number, ParentClosure>([
    [45, { closed: true, completed: false, byPr: null }],
  ]);
  assert.deepEqual(supersededBy(cands, closure), [],
    'an umbrella closed as not-planned often means the carve-outs now carry the work');
});

test('completed but with no PR to cite does not park', () => {
  // A park an operator cannot check is a park they have to take on faith.
  const cands = [{ child: 110, parent: 45 }];
  const closure = new Map<number, ParentClosure>([
    [45, { closed: true, completed: true, byPr: null }],
  ]);
  assert.deepEqual(supersededBy(cands, closure), []);
});

test('an unresolved parent does not park', () => {
  // issueClosure failed (rate limit, network). Dispatch normally; the empty-diff
  // verdict still catches it one dispatch later.
  assert.deepEqual(supersededBy([{ child: 110, parent: 45 }], new Map()), []);
});
