import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditIssue, auditSignals, countPaths, countVague, DEFAULT_AUDIT_GATE } from '../src/issueAudit.js';
import { classify } from '../src/classify.js';
import type { RawIssue } from '../src/github.js';

// The audit exists because the board had a gate for "too big" and none for "too
// vague". Measured motivation: triage returned SINGLE_PR 40/40 while spending a
// student every time, and an issue with no acceptance criteria still went
// straight to an implementer that had to invent the scope.

function issue(body: string, labels: string[] = [], number = 1): RawIssue {
  return {
    number, title: `issue ${number}`, body,
    labels: labels.map((name) => ({ name })),
  } as unknown as RawIssue;
}

const GOOD = [
  '## Goal', 'Add a health endpoint so the deploy check has something to poll.',
  '## Acceptance',
  '- [ ] `GET /health` returns 200 with `{"status":"ok"}`',
  '- [ ] a failing dependency makes it return 503',
].join('\n') + 'x'.repeat(300);

test('countPaths finds real paths and ignores prose and URLs', () => {
  assert.equal(countPaths('touch `dmserver/llm.py` and dwcore/schemas.py'), 2);
  assert.equal(countPaths('the LLM adapter and the queue module'), 0);
  assert.equal(countPaths('see https://github.com/a/b for context'), 0);
  assert.equal(countPaths('`src/a.ts`, `src/a.ts` again'), 1, 'distinct paths only');
});

test('countVague counts distinct scope-deferring phrases', () => {
  assert.equal(countVague('handle logging, metrics, etc.'), 1);
  assert.equal(countVague('add caching as needed and various helpers'), 2);
  assert.equal(countVague('a precise, fully stated requirement'), 0);
});

test('a well-formed issue is ready', () => {
  const a = auditIssue(issue(GOOD));
  assert.equal(a.verdict, 'ready');
});

test('an issue with no acceptance criteria is underspecified, not oversized', () => {
  const body = 'Refactor the LLM adapter to be cleaner. '.repeat(20);
  const a = auditIssue(issue(body));
  assert.equal(a.verdict, 'underspecified');
  assert.match(a.reasons.join(' '), /no acceptance criteria/);
});

test('a one-line issue is underspecified', () => {
  const a = auditIssue(issue('Fix the bug'));
  assert.equal(a.verdict, 'underspecified');
  assert.match(a.reasons.join(' '), /too short/);
});

test('vague AND long is underspecified — splitting it would just yield vague pieces', () => {
  // Long enough and path-heavy enough to look oversized, but states no criteria.
  const body = 'Improve a/b.py and c/d.py and e/f.py, etc. '.repeat(120);
  const a = auditIssue(issue(body));
  assert.equal(a.verdict, 'underspecified', 'underspecified must be checked before oversized');
});

test('too many criteria is oversized', () => {
  const body = ['## Acceptance', ...Array.from({ length: 7 }, (_, i) => `- [ ] outcome ${i}`)].join('\n');
  const a = auditIssue(issue(body));
  assert.equal(a.verdict, 'oversized');
  assert.match(a.reasons.join(' '), /7 separately-checkable criteria/);
});

// The rubric's `standard` band is 3-6 criteria — "the normal case". v1's gate of
// 4 called every issue in that band oversized and paid an Opus triage session
// to be told SINGLE_PR. The audit and the rubric must agree on the band.
test('a rubric-compliant standard issue (3-6 criteria) is ready, not oversized', () => {
  assert.equal(DEFAULT_AUDIT_GATE.maxCriteria, 7);
  for (const n of [3, 4, 5, 6]) {
    const body = ['## Acceptance', ...Array.from({ length: n }, (_, i) => `- [ ] outcome ${i}`)].join('\n');
    assert.equal(auditIssue(issue(body)).verdict, 'ready', `${n} criteria is the standard band`);
  }
});

test('naming too many distinct paths is oversized', () => {
  const paths = Array.from({ length: 10 }, (_, i) => `pkg/mod${i}.py`).join(', ');
  const body = ['## Acceptance', '- [ ] it works', `Touches ${paths}`].join('\n');
  const a = auditIssue(issue(body));
  assert.equal(a.verdict, 'oversized');
  assert.match(a.reasons.join(' '), /distinct paths/);
});

test('triaged/epic settles SIZE only — an oversized issue stops being flagged', () => {
  const big = ['## Acceptance', ...Array.from({ length: 12 }, (_, i) => `- [ ] o${i}`)].join('\n');
  assert.equal(auditIssue(issue(big)).verdict, 'oversized');
  // Deferring here is what stops a livelock: classify routes `oversized` to
  // TRIAGE, and TRIAGE is what sets `triaged`.
  assert.equal(auditIssue(issue(big, ['triaged'])).verdict, 'ready');
  assert.equal(auditIssue(issue(big, ['epic'])).verdict, 'ready');
});

test('triaged does NOT excuse missing criteria — triage never adds any', () => {
  // Regression: dungeonworks#8 (11 criteria, 12 paths, 53.1M tokens) was waved
  // through as `ready` because triage had stamped it, and triage said SINGLE_PR
  // 40 times out of 40. The label must not blind the criteria check.
  const thin = 'Fix the bug';
  assert.equal(auditIssue(issue(thin, ['triaged'])).verdict, 'underspecified');
  assert.equal(auditIssue(issue(thin, ['epic'])).verdict, 'underspecified');
});

test('a bold/plain "Acceptance criteria carried:" label opens a section', () => {
  // The format scope triage files its own split pieces in. A heading-only rule
  // scored the engine's OWN output as zero criteria, which would have marked
  // every freshly-split issue underspecified.
  const body = [
    'Goal: lay down the core schema layer.',
    '',
    'Acceptance criteria carried:',
    '1. composer/manifest.py defines Sticker and AssetManifest.',
    '2. Sticker carries exactly the CLAUDE.md fields plus path.',
    '3. footprint is a 2-element list of ints.',
    '',
    'Out of scope: loading from disk.',
  ].join('\n');
  const a = auditIssue(issue(body));
  assert.equal(a.signals.checkable, 3, 'the numbered list under the label must count');
  assert.notEqual(a.verdict, 'underspecified');
});

test('prose merely containing a criteria word does not open a section', () => {
  const body = [
    'This changes the scope of the retry logic and nothing else.',
    '- not a criterion, just a bullet in prose',
  ].join('\n');
  assert.equal(auditIssue(issue(body)).signals.checkable, 0);
});

test('an EMPTY acceptance heading is not criteria', () => {
  const body = ['## Goal', 'Make the thing better.', '## Acceptance', ''].join('\n');
  const a = auditIssue(issue(body));
  assert.equal(a.verdict, 'underspecified');
  assert.match(a.reasons.join(' '), /nothing checkable/);
});

// The audit judges PRESENCE of criteria, not their quality. Telling substantive
// prose from vague prose is not something a regex can do, and the costs are
// asymmetric: a false positive blocks real work on a real board, a false
// negative just leaves things as they already are. So prose counts.
test('a bulleted Scope + prose Acceptance is ready — the real test-tracker format', () => {
  const body = [
    'A 50,000-row import cannot run inside a request. Move it to a job.',
    '## Scope',
    '- Threshold in an env var; below it keep the synchronous path',
    '- Job runner: a database-backed queue, documented in an ADR',
    '- `ImportBatch` gains progress fields: rows processed, total, phase',
    '## Acceptance',
    'A 50,000-row file imports as a background job with visible progress;',
    'killing the worker mid-import leaves the batch recoverable.',
  ].join('\n');
  const a = auditIssue(issue(body));
  assert.equal(a.verdict, 'ready', 'reusing triage’s stricter counter flagged all 24 of these');
  assert.equal(a.signals.criteria, 0, 'triage’s counter genuinely sees none here');
  assert.ok(a.signals.checkable >= 3, 'the audit’s own counter sees the Scope bullets');
});

test('signals are reported even for a ready issue, so thresholds can be tuned from real boards', () => {
  const s = auditSignals(GOOD);
  assert.equal(s.criteria, 2);
  assert.equal(s.hasCriteriaSection, true);
  assert.ok(s.bodyChars > DEFAULT_AUDIT_GATE.minChars);
});

// ---- integration with the ladder -------------------------------------------

test('OBSERVATION mode is the default: a thin issue is still implemented', () => {
  const actions = classify([issue('Fix the bug')], []);
  assert.equal(actions[0].kind, 'IMPLEMENT', 'default must not change board behaviour');
});

test('enforcing turns a thin issue into a label-only NEEDS_DETAIL action', () => {
  const actions = classify([issue('Fix the bug')], [], { issueAudit: { enforce: true } });
  assert.equal(actions[0].kind, 'NEEDS_DETAIL');
  assert.equal(actions[0].role, null, 'costs no student');
});

test('an already-flagged issue emits nothing — it waits on a human, silently', () => {
  const actions = classify([issue('Fix the bug', ['needs-detail'])], [], { issueAudit: { enforce: true } });
  assert.equal(actions.length, 0, 'must not re-comment every heartbeat');
});

test('removing the needs-detail label forces the issue through', () => {
  const actions = classify([issue('Fix the bug')], [], { issueAudit: { enforce: false } });
  assert.equal(actions[0].kind, 'IMPLEMENT');
});

test('an oversized issue routes to TRIAGE, and criteria-rich issues still reach it', () => {
  const body = ['## Acceptance', ...Array.from({ length: 7 }, (_, i) => `- [ ] outcome ${i}`)].join('\n');
  const actions = classify([issue(body)], [], { issueAudit: { enforce: true } });
  assert.equal(actions[0].kind, 'TRIAGE');
});

test('a 6-criteria standard issue goes straight to IMPLEMENT — no triage session spent', () => {
  const body = ['## Acceptance', ...Array.from({ length: 6 }, (_, i) => `- [ ] outcome ${i}`)].join('\n');
  const actions = classify([issue(body)], [], { issueAudit: { enforce: true } });
  assert.equal(actions[0].kind, 'IMPLEMENT');
});

test('NEEDS_DETAIL outranks TRIAGE and IMPLEMENT in the ladder', () => {
  const thin = issue('Fix it', [], 1);
  const big = issue(['## Acceptance', ...Array.from({ length: 7 }, (_, i) => `- [ ] o${i}`)].join('\n'), [], 2);
  const actions = classify([big, thin], [], { issueAudit: { enforce: true } });
  assert.equal(actions[0].kind, 'NEEDS_DETAIL', 'the cheapest verdict is decided first');
});

