import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeGate, resolveGate, fixGate, needsReview, parseVerdict, canAutoMerge, normalizeReviewMode, reviewModeIssue } from '../src/gates.js';
import type { OpenPull } from '../src/github.js';

// A green, reviewed-ok, mergeable PR — the happy-path base each case tweaks.
function pull(over: Partial<OpenPull> = {}): OpenPull {
  return {
    number: 7,
    title: 'Add thing',
    headRefName: 'study/issue-7',
    labels: ['reviewed-ok'],
    mergeable: 'MERGEABLE',
    statusCheckRollup: 'SUCCESS',
    reviewDecision: 'APPROVED',
    ...over,
  };
}

test('merges a reviewed-ok, green, mergeable PR when autoMerge is on', () => {
  assert.deepEqual(mergeGate(pull(), true), { action: 'merge' });
  // no checks configured counts as green (nothing failing/pending)
  assert.deepEqual(mergeGate(pull({ statusCheckRollup: '' }), true), { action: 'merge' });
});

test('reviewed-ok but autoMerge off waits for a human (still reviewed)', () => {
  assert.deepEqual(mergeGate(pull(), false), { action: 'wait', reason: 'autoMerge off — human merges' });
});

test('without reviewed-ok it waits, even with autoMerge on', () => {
  assert.deepEqual(mergeGate(pull({ labels: [] }), true), { action: 'wait', reason: 'awaiting reviewed-ok' });
});

test('changes-requested blocks the merge before anything else', () => {
  const pr = pull({ labels: ['reviewed-ok', 'changes-requested'] });
  assert.deepEqual(mergeGate(pr, true), { action: 'wait', reason: 'changes-requested' });
});

test('reviewMode none/off/skip drops the reviewed-ok requirement', () => {
  const unreviewed = pull({ labels: [] });
  for (const mode of ['none', 'off', 'skip', 'NONE']) {
    assert.deepEqual(mergeGate(unreviewed, true, mode), { action: 'merge' });
  }
  // any other value (incl. unset) still requires the review verdict
  assert.equal(mergeGate(unreviewed, true, 'human').action, 'wait');
  assert.equal(mergeGate(unreviewed, true).action, 'wait');
});

test('reviewMode human reviews but never self-merges (a human merges)', () => {
  // reviewed-ok + green + mergeable + autoMerge on: auto would merge, human waits.
  assert.deepEqual(mergeGate(pull(), true, 'human'), { action: 'wait', reason: 'reviewMode human — human merges' });
  assert.deepEqual(mergeGate(pull(), true, 'HUMAN'), { action: 'wait', reason: 'reviewMode human — human merges' });
  // flip to auto (default) and the same PR self-merges — the live gate flip.
  assert.deepEqual(mergeGate(pull(), true, 'auto'), { action: 'merge' });
  assert.deepEqual(mergeGate(pull(), true), { action: 'merge' });
  // human still requires the review verdict first (reviewed-ok before the human gate).
  assert.deepEqual(mergeGate(pull({ labels: [] }), true, 'human'), { action: 'wait', reason: 'awaiting reviewed-ok' });
});

test('red / pending checks and non-mergeable states each wait', () => {
  assert.deepEqual(mergeGate(pull({ statusCheckRollup: 'FAILURE' }), true), { action: 'wait', reason: 'checks red' });
  assert.deepEqual(mergeGate(pull({ statusCheckRollup: 'PENDING' }), true), { action: 'wait', reason: 'checks pending' });
  assert.deepEqual(mergeGate(pull({ mergeable: 'CONFLICTING' }), true), { action: 'wait', reason: 'not mergeable (CONFLICTING)' });
  assert.deepEqual(mergeGate(pull({ mergeable: 'UNKNOWN' }), true), { action: 'wait', reason: 'not mergeable (UNKNOWN)' });
});

test('resolveGate resolves a purely CONFLICTING PR', () => {
  const pr = pull({ mergeable: 'CONFLICTING', labels: [], reviewDecision: '', statusCheckRollup: '' });
  assert.deepEqual(resolveGate(pr), { action: 'resolve' });
  // green CI + no review verdict still resolves — conflict is the only blocker.
  assert.deepEqual(resolveGate(pull({ mergeable: 'CONFLICTING', labels: [], statusCheckRollup: 'SUCCESS' })), { action: 'resolve' });
});

test('resolveGate defers to FIX when changes-requested or CI is red', () => {
  assert.deepEqual(
    resolveGate(pull({ mergeable: 'CONFLICTING', labels: ['changes-requested'] })),
    { action: 'wait', reason: 'changes-requested — fix first' },
  );
  assert.deepEqual(
    resolveGate(pull({ mergeable: 'CONFLICTING', labels: [], reviewDecision: 'CHANGES_REQUESTED' })),
    { action: 'wait', reason: 'changes-requested — fix first' },
  );
  assert.deepEqual(
    resolveGate(pull({ mergeable: 'CONFLICTING', labels: [], reviewDecision: '', statusCheckRollup: 'FAILURE' })),
    { action: 'wait', reason: 'checks red — fix first' },
  );
});

test('resolveGate waits on a non-conflicting PR', () => {
  assert.deepEqual(resolveGate(pull({ mergeable: 'MERGEABLE', labels: [], reviewDecision: '' })), { action: 'wait', reason: 'not conflicting (MERGEABLE)' });
  assert.deepEqual(resolveGate(pull({ mergeable: 'UNKNOWN', labels: [], reviewDecision: '' })), { action: 'wait', reason: 'not conflicting (UNKNOWN)' });
});

test('fixGate fixes a changes-requested PR (label or reviewDecision)', () => {
  assert.deepEqual(fixGate(pull({ labels: ['changes-requested'] })), { action: 'fix' });
  assert.deepEqual(fixGate(pull({ labels: [], reviewDecision: 'CHANGES_REQUESTED' })), { action: 'fix' });
});

test('fixGate fixes a red-CI PR even with no review verdict', () => {
  assert.deepEqual(
    fixGate(pull({ labels: [], reviewDecision: '', statusCheckRollup: 'FAILURE' })),
    { action: 'fix' },
  );
  // changes-requested AND red both point at FIX — one action, not two.
  assert.deepEqual(fixGate(pull({ labels: ['changes-requested'], statusCheckRollup: 'FAILURE' })), { action: 'fix' });
});

test('fixGate waits on a PR that is neither changes-requested nor red', () => {
  assert.deepEqual(
    fixGate(pull({ labels: ['reviewed-ok'], statusCheckRollup: 'SUCCESS' })),
    { action: 'wait', reason: 'no changes-requested / red CI' },
  );
  // pending checks are not red — they don't trigger a fix.
  assert.deepEqual(
    fixGate(pull({ labels: [], reviewDecision: '', statusCheckRollup: 'PENDING' })),
    { action: 'wait', reason: 'no changes-requested / red CI' },
  );
  // conflicting-only belongs to RESOLVE, not FIX.
  assert.deepEqual(
    fixGate(pull({ labels: [], reviewDecision: '', statusCheckRollup: 'SUCCESS', mergeable: 'CONFLICTING' })),
    { action: 'wait', reason: 'no changes-requested / red CI' },
  );
});

// An open PR with no verdict — the reviewer's target. Base is deliberately
// verdict-free so each case flips one field.
function unreviewed(over: Partial<OpenPull> = {}): OpenPull {
  return {
    number: 9, title: 'Add thing', headRefName: 'study/issue-9',
    labels: [], mergeable: 'MERGEABLE', statusCheckRollup: 'SUCCESS', reviewDecision: '',
    ...over,
  };
}

test('needsReview: a PR with no verdict needs a review', () => {
  assert.equal(needsReview(unreviewed()), true);
  // pending / no checks don't stop a review — the diff is reviewable regardless.
  assert.equal(needsReview(unreviewed({ statusCheckRollup: 'PENDING' })), true);
  assert.equal(needsReview(unreviewed({ statusCheckRollup: '' })), true);
  assert.equal(needsReview(unreviewed({ mergeable: 'UNKNOWN' })), true);
});

test('needsReview: an already-verdicted PR is not for the reviewer', () => {
  assert.equal(needsReview(unreviewed({ labels: ['reviewed-ok'] })), false);
  assert.equal(needsReview(unreviewed({ reviewDecision: 'APPROVED' })), false);
  assert.equal(needsReview(unreviewed({ labels: ['changes-requested'] })), false);
  assert.equal(needsReview(unreviewed({ reviewDecision: 'CHANGES_REQUESTED' })), false);
});

test('needsReview: FIX/RESOLVE own a red or conflicting PR, not the reviewer', () => {
  assert.equal(needsReview(unreviewed({ statusCheckRollup: 'FAILURE' })), false);
  assert.equal(needsReview(unreviewed({ mergeable: 'CONFLICTING' })), false);
});

test('parseVerdict: the final VERDICT line is authoritative', () => {
  assert.equal(parseVerdict('looks great\n\nVERDICT: APPROVE'), 'APPROVE');
  assert.equal(parseVerdict('bug in auth\n\nVERDICT: REQUEST_CHANGES'), 'REQUEST_CHANGES');
  // last verdict wins over an earlier mention in the reasoning
  assert.equal(parseVerdict('I nearly approved, but\nVERDICT: REQUEST_CHANGES'), 'REQUEST_CHANGES');
  // tolerant of spacing/hyphen variants
  assert.equal(parseVerdict('verdict: request-changes'), 'REQUEST_CHANGES');
});

test('parseVerdict: falls back to phrasing, defaulting conservatively', () => {
  assert.equal(parseVerdict('This all looks correct, approved.'), 'APPROVE');
  assert.equal(parseVerdict('Please make some changes requested below.'), 'REQUEST_CHANGES');
  // an unparseable review never auto-approves
  assert.equal(parseVerdict('hmm, not sure'), 'REQUEST_CHANGES');
});

test('canAutoMerge: only when autoMerge on AND review is not human-gated', () => {
  // the classify->MERGE feed: self-merge only with autoMerge on and non-human review.
  assert.equal(canAutoMerge({ autoMerge: true, reviewMode: 'auto' }), true);
  assert.equal(canAutoMerge({ autoMerge: true }), true); // reviewMode unset defaults non-human
  // autoMerge off never self-merges, regardless of reviewMode.
  assert.equal(canAutoMerge({ autoMerge: false, reviewMode: 'auto' }), false);
  assert.equal(canAutoMerge({}), false); // autoMerge unset === off
  // reviewMode 'human' reviews + labels but a human merges — never self-merge.
  assert.equal(canAutoMerge({ autoMerge: true, reviewMode: 'human' }), false);
});

// (v1 carried three parseActionKey/parseItemKey cases here. Those were live.ts's
// legacy unqualified-key parsers, superseded by parseQualifiedKey in keys.ts —
// covered by repoState.test.ts and crossRepoKeys.test.ts.)

// -- reviewMode must fail CLOSED (found live on config.json) ------------------
// config.json carried reviewMode: "standard", which is not a valid ReviewMode.
// It silently fell through to full auto-merge purely because it wasn't the
// string 'human'. Worse, the two readers had drifted: mergeGate lowercased its
// input, canAutoMerge did not, so "Human" made canAutoMerge return TRUE while
// mergeGate said wait. The disagreement failed OPEN on the side that grants
// merge permission, and classify is fed canAutoMerge.

test('an unrecognised reviewMode is not treated as auto', () => {
  assert.equal(normalizeReviewMode('standard').mode, 'human');
  assert.equal(normalizeReviewMode('standard').recognised, false);
  // The concrete regression: this config must NOT be allowed to self-merge.
  assert.equal(canAutoMerge({ autoMerge: true, reviewMode: 'standard' as never }), false);
});

test('reviewMode is case-insensitive in BOTH readers, consistently', () => {
  for (const raw of ['human', 'Human', 'HUMAN', ' Human ']) {
    assert.equal(normalizeReviewMode(raw).mode, 'human', `${raw} should normalize to human`);
    // canAutoMerge used a bare !== 'human' and let every one of these through.
    assert.equal(canAutoMerge({ autoMerge: true, reviewMode: raw as never }), false, `${raw} must not self-merge`);
    const d = mergeGate(pull({ labels: ['reviewed-ok'] }), true, raw);
    assert.equal(d.action, 'wait', `${raw} should wait for a human`);
  }
});

test('the two readers never disagree about whether a merge may proceed', () => {
  // The invariant the drift broke: if canAutoMerge says no, mergeGate must not
  // say merge, for the same config.
  for (const raw of ['auto', 'human', 'Human', 'none', 'off', 'skip', 'standard', '', 'nonsense']) {
    const allowed = canAutoMerge({ autoMerge: true, reviewMode: raw as never });
    const d = mergeGate(pull({ labels: ['reviewed-ok'] }), true, raw);
    if (!allowed) assert.notEqual(d.action, 'merge', `${raw}: canAutoMerge said no but mergeGate merged`);
  }
});

test('recognised modes still behave as documented', () => {
  assert.equal(normalizeReviewMode(undefined).mode, 'auto');
  assert.equal(normalizeReviewMode('auto').mode, 'auto');
  assert.equal(normalizeReviewMode('').mode, 'auto');
  for (const raw of ['none', 'off', 'skip']) assert.equal(normalizeReviewMode(raw).mode, 'no-review');
  // no-review drops the reviewed-ok requirement, as before.
  assert.equal(mergeGate(pull({ labels: [] }), true, 'none').action, 'merge');
  // ...but auto still requires it.
  assert.equal(mergeGate(pull({ labels: [] }), true, 'auto').action, 'wait');
});

test('reviewModeIssue speaks up exactly when the value is unrecognised', () => {
  assert.equal(reviewModeIssue('auto'), null);
  assert.equal(reviewModeIssue('human'), null);
  assert.equal(reviewModeIssue(undefined), null);
  const m = reviewModeIssue('standard');
  assert.ok(m && m.includes('standard'), 'must quote the offending value');
  assert.ok(m && m.includes('human'), 'must say what it will do instead');
});
