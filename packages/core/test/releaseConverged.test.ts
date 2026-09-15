import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Watchdog } from '../src/watchdog.js';
import { qualifyItemKey, qualifyActionKey } from '../src/keys.js';

// Observed live on Trader-Screener pr-129: the rewrite worked. The PR passed
// review and became reviewed-ok + MERGEABLE at almost the same moment its
// attempt count reached the give-up cap of 9. classify emits nothing for a
// quarantined item, so an APPROVED, MERGEABLE, CLEAN pull request sat untouched
// and the board reported "0 ready to start" with work plainly available.
//
// The quarantine outlived the reason for it: it means "this cannot converge",
// and the thing had converged.

// (v1 pinned two live.ts facts here by source regex: that releaseConverged runs
// BEFORE reconcileWatchdog reads the quarantine set, and that a release clears
// both the item key and the FIX action key plus the attempt counts. Those are
// Governance-unit behaviours in v2 and are tested there against a real board
// snapshot, not a source string.)

test('a released item can reach the cap again if it genuinely re-breaks', () => {
  const w = new Watchdog({ maxItemAttempts: 3 });
  const item = qualifyItemKey('o/r', 'pr', 129);
  for (let i = 0; i < 3; i++) w.attempt(item);
  assert.deepEqual(w.newlyExhausted(), [item]);

  // Release, as reconcile does on reviewed-ok.
  w.forgetItem(item);
  assert.equal(w.attemptsFor(item), 0, 'a converged item starts clean');

  // It is not immune afterwards — releasing must not disable the guard.
  for (let i = 0; i < 3; i++) w.attempt(item);
  assert.deepEqual(w.newlyExhausted(), [item], 'the cap still works after a release');
});

test('the action key shape the release clears is the one quarantine writes', () => {
  assert.equal(qualifyActionKey('FIX', 'o/r', 'pr', 129), 'FIX:o/r:pr-129');
  assert.equal(qualifyItemKey('o/r', 'pr', 129), 'o/r:pr-129');
});
