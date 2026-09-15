import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, pullIssueNumber, isParked, parkedReasons, isDeadlocked, deadlockedPulls, parkedItems, PARKED_LABELS, type BoardAction } from '../src/classify.js';
import type { RawIssue, OpenPull } from '../src/github.js';

// Builders so each case names only the fields it cares about.
function issue(o: Partial<RawIssue> & { number: number }): RawIssue {
  return { number: o.number, title: o.title ?? `#${o.number}`, body: o.body ?? '', labels: o.labels ?? [] };
}
function pull(o: Partial<OpenPull> & { number: number }): OpenPull {
  return {
    number: o.number,
    title: o.title ?? `PR ${o.number}`,
    headRefName: o.headRefName ?? `feat/thing-${o.number}`,
    labels: o.labels ?? [],
    mergeable: o.mergeable ?? 'MERGEABLE',
    statusCheckRollup: o.statusCheckRollup ?? 'SUCCESS',
    reviewDecision: o.reviewDecision ?? '',
  };
}

function only(actions: BoardAction[]) {
  assert.equal(actions.length, 1, `expected exactly one action, got ${JSON.stringify(actions)}`);
  return actions[0];
}

test('ready issue with all deps closed -> IMPLEMENT', () => {
  const a = only(classify([issue({ number: 5, body: 'Depends on #2' })], []));
  assert.equal(a.kind, 'IMPLEMENT');
  assert.equal(a.role, 'implement');
  assert.equal(a.number, 5);
});

test('issue still blocked by an open dependency -> no action', () => {
  const issues = [issue({ number: 2 }), issue({ number: 5, body: 'Depends on #2' })];
  const actions = classify(issues, []);
  // #2 is buildable, #5 is blocked by open #2.
  assert.deepEqual(actions.map((x) => x.number), [2]);
});

test('PR with no verdict labels -> REVIEW', () => {
  const a = only(classify([], [pull({ number: 7 })]));
  assert.equal(a.kind, 'REVIEW');
  assert.equal(a.role, 'review');
});

test('PR with changes-requested label -> FIX', () => {
  const a = only(classify([], [pull({ number: 7, labels: ['changes-requested'] })]));
  assert.equal(a.kind, 'FIX');
});

test('PR with red CI -> FIX', () => {
  const a = only(classify([], [pull({ number: 7, statusCheckRollup: 'FAILURE' })]));
  assert.equal(a.kind, 'FIX');
  assert.equal(a.reason, 'CI is red.');
});

test('PR CONFLICTING with base -> RESOLVE', () => {
  const a = only(classify([], [pull({ number: 7, mergeable: 'CONFLICTING' })]));
  assert.equal(a.kind, 'RESOLVE');
  assert.equal(a.role, 'resolve');
});

test('reviewed-ok + green + mergeable -> MERGE only when autoMerge', () => {
  const pr = pull({ number: 7, labels: ['reviewed-ok'], mergeable: 'MERGEABLE', statusCheckRollup: 'SUCCESS' });
  // PR-only default: no MERGE action, human merges.
  assert.deepEqual(classify([], [pr]), []);
  const a = only(classify([], [pr], { autoMerge: true }));
  assert.equal(a.kind, 'MERGE');
  assert.equal(a.role, 'merge');
});

test('reviewDecision APPROVED counts as reviewed-ok (no label)', () => {
  const pr = pull({ number: 7, reviewDecision: 'APPROVED', mergeable: 'MERGEABLE', statusCheckRollup: 'SUCCESS' });
  const a = only(classify([], [pr], { autoMerge: true }));
  assert.equal(a.kind, 'MERGE');
});

test('reviewed-ok but CI pending -> no action (wait)', () => {
  const pr = pull({ number: 7, labels: ['reviewed-ok'], statusCheckRollup: 'PENDING' });
  assert.deepEqual(classify([], [pr], { autoMerge: true }), []);
});

test('changes-requested overrides an approving mergeable state -> FIX', () => {
  const pr = pull({ number: 7, labels: ['reviewed-ok', 'changes-requested'], mergeable: 'MERGEABLE' });
  const a = only(classify([], [pr], { autoMerge: true }));
  assert.equal(a.kind, 'FIX');
});

test('blocked issue whose deps are now all closed -> PROMOTE', () => {
  // #9 depends on #4, but #4 is not in the open set (merged) -> promote.
  const a = only(classify([issue({ number: 9, body: 'Depends on #4', labels: [{ name: 'blocked' }] })], []));
  assert.equal(a.kind, 'PROMOTE');
  assert.equal(a.role, null);
  assert.equal(a.target, 'issue');
});

test('issue already in the PR pipeline is not re-implemented', () => {
  const issues = [issue({ number: 43 })];
  const pulls = [pull({ number: 7, headRefName: 'feat/issue-43-board-classifier' })];
  const actions = classify(issues, pulls);
  // Only the PR's REVIEW action; issue #43 is driven by its PR.
  assert.deepEqual(actions.map((x) => x.kind), ['REVIEW']);
});

test('pullIssueNumber parses issue-<n> from the head branch', () => {
  assert.equal(pullIssueNumber(pull({ number: 1, headRefName: 'feat/issue-43-thing' })), 43);
  assert.equal(pullIssueNumber(pull({ number: 1, headRefName: 'fix/issue/12' })), 12);
  assert.equal(pullIssueNumber(pull({ number: 1, headRefName: 'feat/no-number' })), null);
});

test('priority order: merge before review before implement', () => {
  const issues = [issue({ number: 20 })]; // -> IMPLEMENT
  const pulls = [
    pull({ number: 8 }),                                                                 // -> REVIEW
    pull({ number: 9, labels: ['reviewed-ok'], mergeable: 'MERGEABLE', statusCheckRollup: 'SUCCESS' }), // -> MERGE
  ];
  const actions = classify(issues, pulls, { autoMerge: true });
  assert.deepEqual(actions.map((x) => x.kind), ['MERGE', 'REVIEW', 'IMPLEMENT']);
});

test('same-kind actions tie-break by ascending number', () => {
  const pulls = [pull({ number: 30 }), pull({ number: 8 }), pull({ number: 15 })]; // all REVIEW
  const actions = classify([], pulls);
  assert.deepEqual(actions.map((x) => x.number), [8, 15, 30]);
});

// ---- give-up label ---------------------------------------------------------
// The durable half of quarantine. Without it, the runner's in-memory set died
// with the process and a restart re-dispatched the same unfixable items.

// ---- a PR cannot outrun its issue's blocker --------------------------------
// Parking is recorded on the ISSUE, but once a PR exists classify drives the PR
// and never looks at the issue again. dungeonworks #18 is the case: flagged
// `needs-human` because its deliverable is a GPU measurement, yet its PR #108
// sat on `changes-requested` and was dispatched FIX again on the next boot.
// Three of the four changes review demanded (run the 324-call matrix, record
// the decision, commit the report) cannot be produced from a worktree, so every
// fix round was guaranteed to fail on the same three items.

test('a PR whose issue is parked yields no action', () => {
  const parked = issue({ number: 18, labels: [{ name: 'needs-human' }] });
  const pr = pull({ number: 108, headRefName: 'study/issue-18', labels: ['changes-requested'] });
  // On its own that PR is a FIX.
  assert.equal(only(classify([], [pr])).kind, 'FIX');
  // With its parked issue on the board, nothing is dispatched at either.
  assert.deepEqual(classify([parked], [pr]), []);
});

test('every parking label holds a PR back, not just needs-human', () => {
  for (const label of PARKED_LABELS) {
    const parked = issue({ number: 18, labels: [{ name: label }] });
    const pr = pull({ number: 108, headRefName: 'study/issue-18', labels: ['changes-requested'] });
    assert.deepEqual(classify([parked], [pr]), [], `${label} must also hold its PR`);
  }
});

test('an unparked issue still drives its PR normally', () => {
  // The guard must not swallow ordinary in-flight work.
  const open = issue({ number: 18 });
  const pr = pull({ number: 108, headRefName: 'study/issue-18', labels: ['changes-requested'] });
  assert.equal(only(classify([open], [pr])).kind, 'FIX');
});

test('a PR with no linked issue is unaffected', () => {
  // Branch names that carry no issue-<n> cannot be matched to a park, and must
  // not be parked by accident.
  const parked = issue({ number: 18, labels: [{ name: 'needs-human' }] });
  const pr = pull({ number: 108, headRefName: 'feat/no-number' });
  assert.equal(only(classify([parked], [pr])).kind, 'REVIEW');
});

test('a PR whose issue was CLOSED is unaffected — the park died with it', () => {
  // `issues` is the OPEN set. A merged/closed issue is simply not in it, so its
  // PR keeps being driven to done rather than stalling forever.
  const pr = pull({ number: 108, headRefName: 'study/issue-18', labels: ['changes-requested'] });
  assert.equal(only(classify([], [pr])).kind, 'FIX');
});

test('a PR labelled runner-error yields no action at all', () => {
  const base = { number: 7, title: 'T', headRefName: 'study/issue-7', mergeable: 'CONFLICTING' as const,
    statusCheckRollup: 'FAILURE' as const, reviewDecision: '' };
  // Every one of these would normally produce an action (FIX, then RESOLVE…).
  assert.equal(classify([], [{ ...base, labels: [] }]).length, 1);
  assert.equal(classify([], [{ ...base, labels: ['runner-error'] }]).length, 0);
  // Case-insensitive, like every other label check here.
  assert.equal(classify([], [{ ...base, labels: ['Runner-Error'] }]).length, 0);
});

test('an issue labelled runner-error is not implemented or promoted', () => {
  const issue = (labels: string[]) => ({ number: 5, title: 'T', body: '', labels: labels.map((name) => ({ name })) });
  assert.equal(classify([issue([])], []).length, 1);
  assert.equal(classify([issue(['runner-error'])], []).length, 0);
  // …even when it would otherwise be PROMOTEd.
  assert.equal(classify([issue(['blocked', 'runner-error'])], []).length, 0);
});

// ---- #173: reviewed-ok + runner-error deadlock -----------------------------
// Approved AND given up on at once. It can never merge, and (because the parking
// label short-circuits classify) it yields no action — so it must be surfaced
// separately or it sits invisible.

test('a PR with both reviewed-ok and runner-error is a deadlock', () => {
  assert.equal(isDeadlocked(pull({ number: 56, labels: ['reviewed-ok', 'runner-error'] })), true);
  // reviewDecision APPROVED counts as approval even without the label.
  assert.equal(isDeadlocked(pull({ number: 56, labels: ['runner-error'], reviewDecision: 'APPROVED' })), true);
});

test('neither label alone is a deadlock', () => {
  assert.equal(isDeadlocked(pull({ number: 1, labels: ['reviewed-ok'] })), false);
  assert.equal(isDeadlocked(pull({ number: 2, labels: ['runner-error'] })), false);
  assert.equal(isDeadlocked(pull({ number: 3, labels: [] })), false);
  // spec-changed is a parking label but not the approval half — not this deadlock.
  assert.equal(isDeadlocked(pull({ number: 4, labels: ['reviewed-ok', 'spec-changed'] })), false);
});

test('the deadlocked PR still yields no classify action (why it goes silent)', () => {
  assert.equal(classify([], [pull({ number: 56, labels: ['reviewed-ok', 'runner-error'] })]).length, 0);
});

test('deadlockedPulls returns only the contradicted PRs, in board order', () => {
  const pulls = [
    pull({ number: 10, labels: ['reviewed-ok'] }),
    pull({ number: 56, labels: ['reviewed-ok', 'runner-error'] }),
    pull({ number: 60, labels: ['runner-error'], reviewDecision: 'APPROVED' }),
  ];
  assert.deepEqual(deadlockedPulls(pulls).map((p) => p.number), [56, 60]);
});

// -- the shared parked-label predicate (#129) ---------------------------------
// The ingest headline and the dispatcher must agree on what "parked" means. They
// did not: readyQueue is label-agnostic, so a fully parked board logged "N ready
// to start" and dispatched nothing, which reads as a hang. isParked is now the
// one definition both sides call.

test('isParked covers every parking label, case-insensitively', () => {
  assert.equal(isParked([]), false);
  assert.equal(isParked(['blocked', 'enhancement']), false);
  for (const label of PARKED_LABELS) {
    assert.equal(isParked([label]), true, `${label} should park`);
    assert.equal(isParked([label.toUpperCase()]), true, `${label} should park case-insensitively`);
  }
});

test('parkedReasons names which labels parked an item, and only those', () => {
  assert.deepEqual(parkedReasons(['enhancement']), []);
  assert.deepEqual(parkedReasons(['runner-error']), ['runner-error']);
  assert.deepEqual(parkedReasons(['spec-changed']), ['spec-changed']);
  assert.deepEqual(parkedReasons(['needs-human']), ['needs-human']);
  // All at once, reported in PARKED_LABELS order regardless of input order.
  assert.deepEqual(parkedReasons([...PARKED_LABELS].reverse()), [...PARKED_LABELS]);
  // Unrelated labels never leak into the reasons.
  assert.deepEqual(parkedReasons(['blocked', 'Runner-Error', 'ready']), ['runner-error']);
});

test('isParked agrees with classify: a parked item yields no action', () => {
  const issue = (labels: string[]) => ({ number: 9, title: 'T', body: '', labels: labels.map((name) => ({ name })) });
  for (const label of PARKED_LABELS) {
    const labels = [label];
    assert.equal(isParked(labels), true);
    // The contract #129 rests on: isParked() true <=> classify() emits nothing.
    assert.equal(classify([issue(labels)], []).length, 0, `${label} should dispatch nothing`);
  }
  // And the converse — an unparked issue does produce work.
  assert.equal(isParked([]), false);
  assert.equal(classify([issue([])], []).length, 1);
});

// ---- #174: parked-items list -----------------------------------------------
test('parkedItems lists every label-parked issue and PR with its reasons', () => {
  const issues = [
    issue({ number: 5, labels: [{ name: 'runner-error' }] }),
    issue({ number: 6, labels: [{ name: 'enhancement' }] }),      // not parked
    issue({ number: 7, labels: [{ name: 'spec-changed' }] }),
  ];
  const pulls = [
    pull({ number: 56, labels: ['runner-error'] }),
    pull({ number: 60, labels: ['reviewed-ok'] }),                // not parked
  ];
  const parked = parkedItems(issues, pulls);
  assert.deepEqual(parked.map((p) => [p.target, p.number, p.labels]), [
    ['issue', 5, ['runner-error']],
    ['issue', 7, ['spec-changed']],
    ['pr', 56, ['runner-error']],
  ]);
});

test('parkedItems is empty on a clean board', () => {
  assert.deepEqual(parkedItems([issue({ number: 1 })], [pull({ number: 2 })]), []);
});

// --- Epics are trackers, not work -------------------------------------------
// One afternoon on dungeonworks, dispatching a student at an epic failed in
// both directions: #81's student found every criterion already owned by a child
// and changed nothing four times, while #76/#78/#82's students built the whole
// parent and merged it, orphaning all eight pieces. `epic` suppressed re-TRIAGE
// and the size audit; nothing suppressed IMPLEMENT.

test('an epic whose pieces are still open -> no action (blocked by them)', () => {
  const issues = [
    issue({ number: 234 }),
    issue({ number: 81, body: 'Depends on #234', labels: [{ name: 'epic' }] }),
  ];
  const actions = classify(issues, []);
  assert.deepEqual(actions.map((x) => x.number), [234]);
});

test('an epic whose pieces have ALL closed is still never IMPLEMENT', () => {
  // The deps-closed path is the one that actually bit: openDeps hits zero and
  // every later guard waves an epic through as ready.
  const actions = classify([issue({ number: 81, body: 'Depends on #234', labels: [{ name: 'epic' }] })], []);
  assert.deepEqual(actions, [], 'an epic never becomes implementable, it just stops having open children');
});

test('an epic with no dependency lines at all is still never IMPLEMENT', () => {
  // Exactly dungeonworks#81's state: the split named its children only in a
  // comment, so the body listed the parent's ORIGINAL deps, all long closed.
  const a = classify([issue({ number: 81, labels: [{ name: 'epic' }] })], []);
  assert.deepEqual(a, []);
});

test('a stale `blocked` label on an epic is still promoted off it', () => {
  // The guard sits after PROMOTE so label hygiene still runs; the next pass
  // then yields nothing for the epic itself.
  const a = only(classify([issue({ number: 81, labels: [{ name: 'epic' }, { name: 'blocked' }] })], []));
  assert.equal(a.kind, 'PROMOTE');
});

test('`epic` does not suppress a non-epic sibling on the same board', () => {
  const actions = classify([
    issue({ number: 81, labels: [{ name: 'epic' }] }),
    issue({ number: 235 }),
  ], []);
  assert.deepEqual(actions.map((x) => [x.number, x.kind]), [[235, 'IMPLEMENT']]);
});
