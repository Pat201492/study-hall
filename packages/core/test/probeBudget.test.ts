import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Watchdog, DEFAULT_WATCHDOG_CONFIG } from '../src/watchdog.js';

// Releasing a parked item used to call forgetItem, which handed it a FULL fresh
// budget of maxItemAttempts. If the condition that wedged it had not actually
// cleared, it spent all nine dispatches re-proving that before re-parking.
//
// Observed on dungeonworks #110/#111: both were implemented by PR #129 and never
// closed, so every dispatch found the work already on main and correctly produced
// no diff. The label was cleared by hand on 2026-08-23; the items burned their way
// back to `runner-error` by 2026-09-01 at ~$4.23 an implement dispatch.

const ITEM = 'owner/repo:issue-110';

test('a probe release gives ONE dispatch, not a full fresh budget', () => {
  const w = new Watchdog();
  for (let i = 0; i < DEFAULT_WATCHDOG_CONFIG.maxItemAttempts; i++) w.attempt(ITEM);
  assert.deepEqual(w.newlyExhausted(), [ITEM], 'it should be exhausted at the cap');

  w.probe(ITEM);
  assert.equal(w.attemptsFor(ITEM), 0, 'the per-life budget resets, or it re-parks on tick 1');
  assert.deepEqual(w.newlyExhausted(), [], 'and it is back on the board');

  // The single probe dispatch, which fails exactly as before.
  w.attempt(ITEM);
  assert.deepEqual(w.newlyExhausted(), [ITEM], 'one failed probe re-parks it immediately');
});

test('a probe that WORKS is not punished for the item having been parked', () => {
  const w = new Watchdog();
  for (let i = 0; i < DEFAULT_WATCHDOG_CONFIG.maxItemAttempts; i++) w.attempt(ITEM);
  w.newlyExhausted();
  w.probe(ITEM);

  // The item settles: the runner clears it the way it does for any item that
  // moved. It must not be sitting on a spent probe budget afterwards.
  w.attempt(ITEM);
  w.forgetItem(ITEM);
  assert.deepEqual(w.newlyExhausted(), [], 'a settled item is not re-parked by a stale probe');
});

test('a probe is a plain retry, never a rewrite escalation', () => {
  const w = new Watchdog();
  for (let i = 0; i < DEFAULT_WATCHDOG_CONFIG.rewriteAfterAttempts; i++) w.attempt(ITEM);
  assert.equal(w.needsRewrite(ITEM), true, 'the ladder still escalates within a life');

  w.probe(ITEM);
  assert.equal(
    w.needsRewrite(ITEM), false,
    'a released item has usually been rewritten already; spending its one probe on the '
    + 'strategy that demonstrably did not work wastes the release',
  );
});

test('the lifetime ceiling survives releases, which is the point', () => {
  const w = new Watchdog();
  const cap = DEFAULT_WATCHDOG_CONFIG.lifetimeDispatchCap;

  // Burn a full life, then get released, over and over. Each release resets the
  // per-life budget; none of them may reset the ceiling.
  let dispatched = 0;
  while (dispatched < cap) {
    w.attempt(ITEM);
    dispatched++;
    if (w.newlyExhausted().length) w.probe(ITEM);
  }

  assert.equal(w.lifetimeFor(ITEM), cap, 'every dispatch counts, across every release');
  assert.equal(w.lifetimeExhausted(ITEM), true, 'and past the cap the item stops being auto-released');
});

test('a dispatch that never RAN costs neither a probe nor the ceiling', () => {
  // isCapacityError / isInfraFailure already refund the attempt ledger. The
  // lifetime ceiling has to be refunded on the same terms or an outage walks a
  // healthy item to a permanent cap without a student ever reading it -- which is
  // exactly what the 2026-08-13 session limit and 2026-08-22 segfault did to the
  // counters that existed at the time.
  const w = new Watchdog();
  w.probe(ITEM);
  w.attempt(ITEM);
  assert.equal(w.lifetimeFor(ITEM), 1);

  w.forgiveAttempt(ITEM);
  assert.equal(w.lifetimeFor(ITEM), 0, 'a dispatch that never ran cost nothing');
  assert.deepEqual(w.newlyExhausted(), [], 'and it did not burn the probe either');
});

test('forgetItem still means forget: an item that left the board keeps no ceiling', () => {
  const w = new Watchdog();
  for (let i = 0; i < 4; i++) w.attempt(ITEM);
  w.forgetItem(ITEM);
  assert.equal(w.lifetimeFor(ITEM), 0, 'a reopened issue starts a fresh life');
  assert.equal(w.attemptsFor(ITEM), 0);
});

test('a probing item is tracked, so leaving the board still forgets it', () => {
  const w = new Watchdog();
  w.probe(ITEM);
  assert.ok(
    w.trackedItems().includes(ITEM),
    'attempts is empty during probation; reconcile would never forget a probing item',
  );
});

test('seeding a lifetime count never lowers it', () => {
  const w = new Watchdog();
  w.seedLifetime(ITEM, 12);
  w.seedLifetime(ITEM, 3);
  assert.equal(w.lifetimeFor(ITEM), 12, 'a ceiling a restart could lower is not a ceiling');
});
