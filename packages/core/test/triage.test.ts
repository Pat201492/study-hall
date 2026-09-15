import { test } from 'node:test';
import assert from 'node:assert/strict';
import { needsTriage, countCriteria, parseTriage, DEFAULT_TRIAGE_GATE, TRIAGED_LABEL, EPIC_LABEL } from '../src/triage.js';
import { classify } from '../src/classify.js';
import type { RawIssue } from '../src/github.js';

// Trader-Screener #126 took 16 commits across 10 review rounds because the issue
// asked for more than one coherent PR could satisfy — each fix answered the last
// objection and drew a fresh one. Nothing in the engine had ever asked whether
// an issue was one PR's worth of work before a student started writing code.

const issue = (over: Partial<RawIssue> = {}): RawIssue =>
  ({ number: 1, title: 'T', body: '', labels: [], ...over } as RawIssue);

test('the gate fires on oversized issues and spares small ones', () => {
  assert.equal(needsTriage(issue({ body: 'x'.repeat(2400) })), false, 'the size boards that FINISHED ran at');
  assert.equal(needsTriage(issue({ body: 'x'.repeat(5000) })), true, 'the size Trader-Screener churned at');
});

test('many separate acceptance criteria trip the gate regardless of length', () => {
  const body = '## Acceptance criteria\n' + ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((c) => `- [ ] ${c}`).join('\n');
  assert.ok(body.length < DEFAULT_TRIAGE_GATE.maxChars, 'short, but seven separate outcomes');
  assert.equal(countCriteria(body), 7);
  assert.equal(needsTriage(issue({ body })), true);
});

// The gate sits behind the rubric, whose `standard` band is 3-6 criteria and
// whose `hard` band starts at 7. At v1's bar of 4, a compliant standard issue
// paid an Opus triage session to be told SINGLE_PR; the gate now names the
// rubric's own number.
test('the gate agrees with the rubric: 3-6 criteria is standard work, not a triage candidate', () => {
  assert.equal(DEFAULT_TRIAGE_GATE.maxCriteria, 7);
  for (const n of [3, 4, 5, 6]) {
    const body = '## Acceptance criteria\n' + Array.from({ length: n }, (_, i) => `- [ ] c${i}`).join('\n');
    assert.equal(countCriteria(body), n);
    assert.equal(needsTriage(issue({ body })), false, `${n} criteria must not spend a triage student`);
  }
});

test('an issue is triaged at most once, and epics are left alone', () => {
  const big = 'x'.repeat(5000);
  assert.equal(needsTriage(issue({ body: big, labels: [{ name: TRIAGED_LABEL }] })), false);
  assert.equal(needsTriage(issue({ body: big, labels: [{ name: EPIC_LABEL }] })), false);
  // Case-insensitive: GitHub labels are matched loosely everywhere else here.
  assert.equal(needsTriage(issue({ body: big, labels: [{ name: 'Triaged' }] })), false);
});

test('classify emits TRIAGE before IMPLEMENT for an oversized issue', () => {
  const big = issue({ number: 7, body: 'x'.repeat(5000) });
  const [a] = classify([big], []);
  assert.equal(a.kind, 'TRIAGE');
  assert.equal(a.role, 'triage');
  // ...and IMPLEMENT once it has been assessed.
  const done = issue({ number: 7, body: 'x'.repeat(5000), labels: [{ name: TRIAGED_LABEL }] });
  assert.equal(classify([done], [])[0].kind, 'IMPLEMENT');
});

test('triage can be turned off entirely', () => {
  const big = issue({ number: 7, body: 'x'.repeat(5000) });
  assert.equal(classify([big], [], { triage: false })[0].kind, 'IMPLEMENT');
});

// -- parsing: the safe direction is always "leave the issue alone" ------------

test('SINGLE_PR verdict leaves the issue untouched', () => {
  const v = parseTriage('VERDICT: SINGLE_PR\nIt is one coherent change.');
  assert.equal(v.singlePr, true);
  assert.deepEqual(v.splits, []);
});

test('a well-formed split is parsed', () => {
  const v = parseTriage('reasoning\n```triage-splits\n' + JSON.stringify([
    { title: 'Part one', body: 'goal', covers: 'criteria 1-2' },
    { title: 'Part two', body: 'goal', covers: 'criteria 3' },
  ]) + '\n```');
  assert.equal(v.singlePr, false);
  assert.equal(v.splits.length, 2);
  assert.equal(v.splits[0].title, 'Part one');
});

test('a malformed or one-piece answer means LEAVE IT ALONE, never invent a split', () => {
  // Inventing a split from a broken answer would carve up a real board.
  assert.equal(parseTriage('garbage, no fence').singlePr, true);
  assert.equal(parseTriage('```triage-splits\nnot json\n```').singlePr, true);
  assert.equal(parseTriage('```triage-splits\n{"not":"an array"}\n```').singlePr, true);
  // One piece is the original issue wearing a hat.
  assert.equal(parseTriage('```triage-splits\n[{"title":"only","body":"b"}]\n```').singlePr, true);
  // Pieces missing a title or body are dropped, which can take it below two.
  assert.equal(parseTriage('```triage-splits\n[{"title":"a","body":"b"},{"title":""}]\n```').singlePr, true);
});

test('an untagged fenced array is still accepted', () => {
  // Models drop the language tag often enough that being strict loses real work.
  const v = parseTriage('```json\n' + JSON.stringify([
    { title: 'a', body: 'b' }, { title: 'c', body: 'd' },
  ]) + '\n```');
  assert.equal(v.splits.length, 2);
});

test('sections are counted separately, not summed — no double-counting', () => {
  // cardworks#4's real shape: the SAME three requirements stated twice, once as
  // Deliverables and once as Acceptance. Summing scored it 6 and would have
  // triaged a 1,425-character issue for no reason.
  const body = [
    '## Goal', 'Fix the thing.', '',
    '## Deliverables',
    '- do A', '- do B', '- do C', '',
    '## Acceptance',
    '- A works', '- B works', '- C works',
  ].join('\n');
  assert.equal(countCriteria(body), 3, 'largest section wins, sections are not summed');
  assert.equal(needsTriage(issue({ body })), false, 'a small, coherent issue is left alone');
});

test('an explicit checklist wins over section counting', () => {
  const body = [
    '## Acceptance',
    '- [ ] one', '- [ ] two', '- [ ] three', '- [ ] four', '- [ ] five', '- [ ] six', '- [ ] seven',
    '## Deliverables',
    '- restated once',
  ].join('\n');
  assert.equal(countCriteria(body), 7, 'checkboxes are the clearest statement, count them');
  assert.equal(needsTriage(issue({ body })), true);
});
