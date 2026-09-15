import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Watchdog } from '../src/watchdog.js';
import { qualifyItemKey } from '../src/keys.js';

// Observed live: pr-126 was dispatched 21 times against maxItemAttempts: 6, and
// the log filled with "restored N quarantined item(s)".
//
// reconcileWatchdog built its on-board set from BARE numbers ("pr-126") while
// trackedItems() returns REPO-QUALIFIED keys ("owner/name:pr-126"). The two
// never matched, so every tracked item was forgotten on every tick — the
// attempt counter reset before it could ever reach the cap, and a quarantine
// written on one tick was deleted on the next. Both #111 and #112 were silently
// neutralized.

const ITEM = qualifyItemKey('owner/name', 'pr', 126);

test('the item key shape and a bare-number set do not match', () => {
  assert.equal(ITEM, 'owner/name:pr-126');
  const bare = new Set(['pr-126']);           // the old, broken construction
  assert.equal(bare.has(ITEM), false, 'this mismatch is the whole bug');
  const qualified = new Set([qualifyItemKey('owner/name', 'pr', 126)]);
  assert.equal(qualified.has(ITEM), true);
});

test('the oscillation cap fires when the counter is NOT reset each tick', () => {
  const w = new Watchdog({ maxItemAttempts: 6 });
  for (let i = 0; i < 6; i++) w.attempt(ITEM);
  assert.equal(w.attemptsFor(ITEM), 6);
  assert.deepEqual(w.newlyExhausted(), [ITEM], 'must exhaust at the cap');
});

test('forgetting the item every tick lets it run forever — the observed runaway', () => {
  const w = new Watchdog({ maxItemAttempts: 6 });
  // Simulate 20 ticks of dispatch with the old reconcile wiping history each time.
  for (let i = 0; i < 20; i++) {
    w.attempt(ITEM);
    w.forgetItem(ITEM);            // what the bare-number mismatch caused
  }
  assert.deepEqual(w.newlyExhausted(), [], 'cap can never fire — 21 dispatches happened this way');

  // With the item correctly recognised as on-board, it is never forgotten.
  const w2 = new Watchdog({ maxItemAttempts: 6 });
  for (let i = 0; i < 20; i++) w2.attempt(ITEM);
  assert.deepEqual(w2.newlyExhausted(), [ITEM], 'now it stops');
});

test('an item that really left the board is still forgotten', () => {
  const w = new Watchdog({ maxItemAttempts: 6 });
  w.attempt(ITEM);
  assert.equal(w.attemptsFor(ITEM), 1);
  w.forgetItem(ITEM);
  assert.equal(w.attemptsFor(ITEM), 0, 'merged/closed items must still be dropped');
});

// ---- capacity must not spend an item's attempt budget ----------------------
// Observed 2026-08-13: a plan session limit ran for hours, and every dispatch it
// killed was still charged to the item. test-tracker #37 and #47 reached
// "worked 9x without settling" and were quarantined without a single attempt
// having run. The no-progress counter already had clear(); the attempt LEDGER
// had no way back, so the give-up cap condemned healthy work for an outage.

test('an attempt killed by a capacity outage is given back', () => {
  const w = new Watchdog({ maxItemAttempts: 9 });
  w.attempt(ITEM);
  w.forgiveAttempt(ITEM);
  assert.equal(w.attemptsFor(ITEM), 0);
});

test('a capacity outage cannot walk an untouched item to the give-up cap', () => {
  const w = new Watchdog({ maxItemAttempts: 9 });
  // Nine dispatches, every one killed by the same session limit.
  for (let i = 0; i < 9; i++) {
    w.attempt(ITEM);
    w.forgiveAttempt(ITEM);
  }
  assert.equal(w.attemptsFor(ITEM), 0);
  assert.deepEqual(w.newlyExhausted(), [], 'nothing actually ran — nothing may be condemned');
});

test('forgiveness gives back ONE attempt, not the whole budget', () => {
  // An outage in the middle of a genuine fix/review ping-pong must not hand the
  // item a fresh budget — the rounds it really spent stay spent.
  const w = new Watchdog({ maxItemAttempts: 9 });
  for (let i = 0; i < 5; i++) w.attempt(ITEM);   // five real rounds
  w.attempt(ITEM);                                // sixth dies on a session limit
  w.forgiveAttempt(ITEM);
  assert.equal(w.attemptsFor(ITEM), 5);
});

test('forgiving an item with no attempt history is a no-op, not a negative count', () => {
  const w = new Watchdog();
  w.forgiveAttempt(ITEM);
  assert.equal(w.attemptsFor(ITEM), 0);
  w.forgiveAttempt(ITEM);
  assert.equal(w.attemptsFor(ITEM), 0);
});

test('a real no-progress attempt is still charged', () => {
  // The guard only fires on capacity. Ordinary failures must still reach the cap.
  const w = new Watchdog({ maxItemAttempts: 3 });
  for (let i = 0; i < 3; i++) w.attempt(ITEM);
  assert.deepEqual(w.newlyExhausted(), [ITEM]);
});
