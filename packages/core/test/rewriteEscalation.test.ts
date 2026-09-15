import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Watchdog } from '../src/watchdog.js';
import { fixPrompt, rewritePrompt } from '../src/prompts.js';
import { REWRITE_ROLE, REVIEW_ROLE } from '../src/roles.js';
import type { OpenPull } from '../src/github.js';
import { ROLES } from '../src/types.js';
import { ROLE_PROMPTS } from '../src/roles.js';

const pr = { number: 126, title: 'Rule induction', headRefName: 'study/issue-107', labels: [], mergeable: 'MERGEABLE', statusCheckRollup: '', reviewDecision: '' } as unknown as OpenPull;

// Trader-Screener #126: 10 commits across 9 review rounds, never landed. Each
// fix satisfied the last objection and drew a fresh one, so the diff grew while
// converging on nothing. After enough rounds the answer is to reimplement, not
// to patch again.

test('the escalation fires at 5 rounds and stops before the give-up cap', () => {
  const w = new Watchdog();
  for (let i = 0; i < 4; i++) w.attempt('owner/r:pr-126');
  assert.equal(w.needsRewrite('owner/r:pr-126'), false);
  w.attempt('owner/r:pr-126');
  assert.equal(w.needsRewrite('owner/r:pr-126'), true, 'round 5 escalates');
});

test('the rewrite prompt leads with the ISSUE, the fix prompt with the feedback', () => {
  const issue = 'ACCEPTANCE: the thing must do X.';
  const feedback = 'Reviewer said the thing does Y.';
  const rw = rewritePrompt(pr, 'o/r', issue, feedback, 5);
  const fx = fixPrompt(pr, 'o/r', feedback, issue);

  assert.ok(rw.startsWith(REWRITE_ROLE), 'rewrite carries its own role prefix');
  assert.ok(!fx.startsWith(REWRITE_ROLE), 'fix does not');
  // The rewriter builds to the acceptance criteria; the issue must come first.
  assert.ok(rw.indexOf(issue) < rw.indexOf(feedback), 'issue precedes feedback in a rewrite');
  assert.ok(fx.indexOf(feedback) < fx.indexOf(issue), 'feedback precedes issue in a fix');
});

test('the rewrite prompt says how many rounds failed, and frames history as evidence', () => {
  const rw = rewritePrompt(pr, 'o/r', 'goal', 'rejected because Z', 5);
  assert.match(rw, /failed review 5 times/);
  assert.match(rw, /do not simply patch each point/);
});

test('the reviewer only blocks on required changes', () => {
  // The bug: a review that listed only non-blocking observations still voted
  // REQUEST_CHANGES, so the fix loop could never converge (cardworks#5).
  assert.match(REVIEW_ROLE, /REQUEST_CHANGES ONLY if "Required changes" is non-empty/);
  assert.match(REVIEW_ROLE, /Non-blocking/);
  assert.match(REVIEW_ROLE, /never a reason to block/);
  assert.match(REVIEW_ROLE, /moving bar/);
});

// -- rewrite is a first-class Protector role ----------------------------------
// Not just a different prompt behind the 'fix' role: the ladder, the warm map
// and attribution all key off Role, so a rewrite billed as a fix is invisible in
// exactly the telemetry meant to show whether the escalation is working.

test('rewrite is in the Role union and the ROLES list', () => {
  assert.ok(ROLES.includes('rewrite'), 'the Protector must be able to assign it');
  // Ordered between fix and resolve — it is an escalation of a fix.
  assert.equal(ROLES.indexOf('rewrite'), ROLES.indexOf('fix') + 1);
});

test('every role-keyed structure covers rewrite', () => {
  // Record<Role, …> makes these exhaustive at compile time; assert at runtime
  // too, since a missing entry renders as `undefined` rather than failing.
  assert.equal(typeof ROLE_PROMPTS.rewrite, 'string');
  assert.ok(ROLE_PROMPTS.rewrite.length > 0);
  // (ROLE_SINGULAR is a dashboard presentation map — roleView.ts — not core.)
  // The rewrite role must carry the REWRITE prompt, not the fix one.
  assert.equal(ROLE_PROMPTS.rewrite, REWRITE_ROLE);
  assert.notEqual(ROLE_PROMPTS.rewrite, ROLE_PROMPTS.fix);
});

// (v1 pinned "Role has ONE definition" by regex over pool.ts source. In core
// the union is declared once in taskmap.ts and re-exported by types.ts; a
// second declaration would surface as a type error in typecheck, not here.)
