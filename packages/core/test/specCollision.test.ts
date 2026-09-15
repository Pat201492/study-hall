import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Watchdog } from '../src/watchdog.js';
import { specFingerprint, fetchIssueSpec, PIPELINE_LABELS, type GhRunner } from '../src/github.js';
import { classify, SPEC_CHANGED_LABEL } from '../src/classify.js';

// The spec-collision guard. Study Room reads a spec, builds against it, then
// reviews the result against the spec — three separate fetches. Another agent
// editing issues mid-run breaks that chain: the implementer builds v1, the
// reviewer judges it against v2, and the PR can never satisfy criteria that keep
// moving. Observed on Trader-Screener, where 11 specs were rewritten in 12s.

// ---- fingerprint -----------------------------------------------------------

test('the fingerprint tracks title and body content', () => {
  const a = specFingerprint('Add widget', 'Do the thing');
  assert.equal(specFingerprint('Add widget', 'Do the thing'), a, 'stable for equal content');
  assert.notEqual(specFingerprint('Add widget', 'Do the OTHER thing'), a, 'body change detected');
  assert.notEqual(specFingerprint('Add gadget', 'Do the thing'), a, 'title change detected');
});

test('a missing body is not conflated with an empty one changing', () => {
  // gh returns null bodies for issues with no description; that must be stable
  // rather than flapping against ''.
  assert.equal(specFingerprint('T', ''), specFingerprint('T', undefined as unknown as string));
});

test('title/body boundary cannot be forged by moving text across it', () => {
  // "ab" + "" must not hash the same as "a" + "b", or an edit that shifts a
  // character from the title into the body would read as unchanged.
  assert.notEqual(specFingerprint('ab', ''), specFingerprint('a', 'b'));
});

test('fetchIssueSpec returns the spec with its fingerprint, null when unreadable', async () => {
  const ok: GhRunner = async () => JSON.stringify({ number: 7, title: 'T', body: 'B' });
  const spec = await fetchIssueSpec('me/repo', 7, ok);
  assert.equal(spec?.fingerprint, specFingerprint('T', 'B'));

  // A closed/deleted/inaccessible issue is meaningful: the thing being built no
  // longer exists in readable form, which is itself a reason to stop.
  const gone: GhRunner = async () => { throw new Error('not found'); };
  assert.equal(await fetchIssueSpec('me/repo', 7, gone), null);
});

// ---- board churn detection -------------------------------------------------

const board = (entries: [number, string][]) => new Map(entries);

test('the first observation is never churn — there is no previous spec to contradict', () => {
  const w = new Watchdog({ boardChurnLimit: 2 });
  assert.deepEqual(w.observeBoard(board([[1, 'a'], [2, 'b']])), []);
  assert.equal(w.boardContested(), false);
});

test('observeBoard reports exactly the issues whose spec was rewritten', () => {
  const w = new Watchdog({ boardChurnLimit: 99 });
  w.observeBoard(board([[1, 'a'], [2, 'b'], [3, 'c']]));
  assert.deepEqual(w.observeBoard(board([[1, 'a'], [2, 'CHANGED'], [3, 'ALSO']])).sort(), [2, 3]);
});

test('new and closed issues are not churn', () => {
  const w = new Watchdog({ boardChurnLimit: 99 });
  w.observeBoard(board([[1, 'a'], [2, 'b']]));
  // #2 disappears (closed), #9 appears (newly filed) — neither is a rewrite.
  assert.deepEqual(w.observeBoard(board([[1, 'a'], [9, 'new']])), []);
});

test('churn past the limit marks the board contested', () => {
  const w = new Watchdog({ boardChurnLimit: 3 });
  w.observeBoard(board([[1, 'a'], [2, 'b'], [3, 'c'], [4, 'd']]));

  // Two edits is ordinary human tidying — keep working.
  w.observeBoard(board([[1, 'X'], [2, 'Y'], [3, 'c'], [4, 'd']]));
  assert.equal(w.boardContested(), false);
  assert.equal(w.churnCount(), 2);

  // Three at once is someone else driving the board.
  w.observeBoard(board([[1, 'P'], [2, 'Q'], [3, 'R'], [4, 'd']]));
  assert.equal(w.boardContested(), true);
  assert.equal(w.churnCount(), 3);
});

// Backing off must be a PAUSE, not a latch: the engine has to resume by itself
// once whoever was editing has stopped.
test('a settled board clears the contested state on its own', () => {
  const w = new Watchdog({ boardChurnLimit: 2 });
  w.observeBoard(board([[1, 'a'], [2, 'b']]));
  w.observeBoard(board([[1, 'X'], [2, 'Y']]));
  assert.equal(w.boardContested(), true);

  w.observeBoard(board([[1, 'X'], [2, 'Y']])); // quiet ingest
  assert.equal(w.boardContested(), false, 'must resume without a restart');
  assert.equal(w.churnCount(), 0);
});

test('the Trader-Screener case: 11 specs rewritten at once is contested', () => {
  const w = new Watchdog(); // defaults
  const before = board(Array.from({ length: 12 }, (_, i) => [i, `v1-${i}`] as [number, string]));
  w.observeBoard(before);
  const after = board(Array.from({ length: 12 }, (_, i) => [i, i < 11 ? `v2-${i}` : 'v1-11'] as [number, string]));
  assert.equal(w.observeBoard(after).length, 11);
  assert.equal(w.boardContested(), true);
});

test('specFor exposes the recorded fingerprint per issue', () => {
  const w = new Watchdog();
  w.observeBoard(board([[5, 'fp5']]));
  assert.equal(w.specFor(5), 'fp5');
  assert.equal(w.specFor(6), undefined);
});

// ---- churn is per BOARD, not per engine -------------------------------------
// Issue numbers are per-repo. One flat number->fingerprint map meant each repo's
// ingest replaced the whole map, so the next repo diffed ITS #7 against the
// previous repo's #7 and called the collision a rewrite. Live on 2026-08-11:
// three boards sharing a number range reported 4 / 17 / 23 "rewrites" on every
// 20s tick, tripped boardChurnLimit forever, and paused dispatch for ~16h on
// boards nobody had touched.

test('two boards sharing issue numbers do not read as each other\'s churn', () => {
  const w = new Watchdog({ boardChurnLimit: 3 });
  const a = board([[1, 'a1'], [2, 'a2'], [3, 'a3'], [4, 'a4']]);
  const b = board([[1, 'b1'], [2, 'b2'], [3, 'b3'], [4, 'b4']]);

  // First look at each board — neither has a previous spec to contradict.
  assert.deepEqual(w.observeBoard(a, 'owner/a'), []);
  assert.deepEqual(w.observeBoard(b, 'owner/b'), []);

  // Second round, both boards unchanged. The bug reported all four numbers here.
  assert.deepEqual(w.observeBoard(a, 'owner/a'), []);
  assert.deepEqual(w.observeBoard(b, 'owner/b'), []);
  assert.equal(w.boardContested('owner/a'), false);
  assert.equal(w.boardContested('owner/b'), false);
  assert.deepEqual(w.contestedBoards(), []);
});

test('churn on one board is not attributed to another', () => {
  const w = new Watchdog({ boardChurnLimit: 3 });
  w.observeBoard(board([[1, 'a'], [2, 'b'], [3, 'c']]), 'owner/quiet');
  w.observeBoard(board([[1, 'a'], [2, 'b'], [3, 'c']]), 'owner/loud');

  w.observeBoard(board([[1, 'a'], [2, 'b'], [3, 'c']]), 'owner/quiet');
  w.observeBoard(board([[1, 'X'], [2, 'Y'], [3, 'Z']]), 'owner/loud');

  assert.equal(w.churnCount('owner/quiet'), 0);
  assert.equal(w.churnCount('owner/loud'), 3);
  assert.equal(w.boardContested('owner/quiet'), false, 'a quiet board keeps working');
  assert.equal(w.boardContested('owner/loud'), true);
  assert.deepEqual(w.contestedBoards(), ['owner/loud']);
});

test('the contested verdict does not depend on which board ingested last', () => {
  // The dispatch guard read one engine-wide count, so it answered for whichever
  // repo happened to ingest last in the tick rather than for the repo it was
  // about to dispatch on.
  const w = new Watchdog({ boardChurnLimit: 2 });
  w.observeBoard(board([[1, 'a'], [2, 'b']]), 'owner/a');
  w.observeBoard(board([[1, 'a'], [2, 'b']]), 'owner/b');
  w.observeBoard(board([[1, 'X'], [2, 'Y']]), 'owner/a'); // a is rewritten
  w.observeBoard(board([[1, 'a'], [2, 'b']]), 'owner/b'); // b ingests last, quiet

  assert.equal(w.boardContested('owner/a'), true, 'a is contested regardless of ingest order');
  assert.equal(w.boardContested('owner/b'), false);
});

test('an unnamed board still works, so a single-repo caller needs no scope', () => {
  const w = new Watchdog({ boardChurnLimit: 2 });
  w.observeBoard(board([[1, 'a'], [2, 'b']]));
  assert.deepEqual(w.observeBoard(board([[1, 'X'], [2, 'Y']])), [1, 2]);
  assert.equal(w.boardContested(), true);
  // ...and the unnamed board is its own scope, not a wildcard over the named ones.
  assert.equal(w.churnCount('owner/a'), 0);
});

// (v1 pinned the runner's per-board ingest scoping by regex over live.ts here —
// the shared `this.rs` cursor bug of 2026-08-14. v2 deletes that cursor and
// passes the repo explicitly; BoardCycle's tests cover the scoping.)

// ---- the parking label -----------------------------------------------------

test('spec-changed is a pipeline label, so ensureLabels creates it', () => {
  assert.ok(PIPELINE_LABELS.includes(SPEC_CHANGED_LABEL as never));
});

test('a PR labelled spec-changed yields no action', () => {
  const base = {
    number: 7, title: 'T', headRefName: 'study/issue-7',
    mergeable: 'MERGEABLE' as const, statusCheckRollup: 'SUCCESS' as const, reviewDecision: '',
  };
  assert.equal(classify([], [{ ...base, labels: [] }]).length, 1);
  assert.equal(classify([], [{ ...base, labels: ['spec-changed'] }]).length, 0);
  assert.equal(classify([], [{ ...base, labels: ['Spec-Changed'] }]).length, 0);
});

test('an issue labelled spec-changed is not implemented or promoted', () => {
  const issue = (labels: string[]) =>
    ({ number: 5, title: 'T', body: '', labels: labels.map((name) => ({ name })) });
  assert.equal(classify([issue([])], []).length, 1);
  assert.equal(classify([issue(['spec-changed'])], []).length, 0);
  assert.equal(classify([issue(['blocked', 'spec-changed'])], []).length, 0);
});

// The two markers must stay distinguishable — that is the entire reason
// spec-changed exists rather than reusing runner-error.
test('spec-changed and runner-error are separate labels', () => {
  assert.notEqual(SPEC_CHANGED_LABEL, 'runner-error');
  assert.ok(PIPELINE_LABELS.includes('runner-error' as never));
});

// ---- handled-ledger reconciliation -----------------------------------------
// `handled` records issues already PR'd so a re-ingest doesn't rebuild them. It
// was write-only, which orphans work: a PR closed WITHOUT merging leaves its
// issue open, still marked handled, pinned at stage 'review' with no PR to
// review — silently never built again. Trader-Screener #95 hit this when its
// PR #116 was closed by hand.
//
// The runner's own method needs a live repo, so these pin the RULE it applies.

function reconcile(handled: Set<number>, openIssues: number[], prIssueNumbers: number[]): number[] {
  const withOpenPr = new Set(prIssueNumbers);
  return openIssues.filter((n) => handled.has(n) && !withOpenPr.has(n));
}

test('an open issue marked handled with no open PR is returned to the board', () => {
  // #95 is open, believed PR'd, and its PR was closed -> orphaned.
  assert.deepEqual(reconcile(new Set([95, 97]), [95, 97], [97]), [95]);
});

test('an issue whose PR is still open is left alone', () => {
  assert.deepEqual(reconcile(new Set([97]), [97], [97]), []);
});

test('a merged issue is untouched — it has left the open set entirely', () => {
  // Merging closes the issue, so it never appears in openIssues and its stale
  // handled entry is harmless history.
  assert.deepEqual(reconcile(new Set([35, 36, 57]), [95], []), []);
});

test('issues that were never PR-d are not affected', () => {
  assert.deepEqual(reconcile(new Set([95]), [100, 101, 104], []), []);
});

test('the exact Trader-Screener case', () => {
  const handled = new Set([35, 36, 37, 81, 95, 96, 97, 98, 99, 102, 103]);
  const open = [95, 97, 100, 101, 104, 105, 106, 107, 108, 109, 110, 111];
  // #97 has open PR #120; #95's PR #116 was closed unmerged.
  assert.deepEqual(reconcile(handled, open, [97]), [95]);
});

// (v1 closed this file with three isCapacityError cases — the CLI session-limit
// text, rate-limit/quota/429 phrasings, and genuine failures that must NOT read
// as capacity. That classifier is per-harness in @study-hall/harness now and is
// tested there.)
