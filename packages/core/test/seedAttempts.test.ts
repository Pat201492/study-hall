import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Watchdog } from '../src/watchdog.js';
import { rejectedReviewCount } from '../src/github.js';

// Attempt counts lived only in memory, so every restart handed a churning PR a
// fresh budget of fixes — on an engine that restarts often the rewrite
// escalation could never fire, and #112's give-up cap was equally blind.
// Quarantine was made durable in #111; the counts that lead to it were not.

test('seeding sets the count so the escalation fires on the NEXT dispatch', () => {
  const w = new Watchdog();
  const item = 'owner/r:pr-126';
  assert.equal(w.needsRewrite(item), false, 'unseen PR starts clean');
  // Trader-Screener#126 really had 10 prior rejections. Seeding that verbatim
  // would push it past the give-up cap and quarantine it instantly — without
  // ever attempting the rewrite, which is the whole point of the escalation and
  // the one strategy those 10 fixes never tried.
  w.seedAttempts(item, 10);
  assert.equal(w.attemptsFor(item), 5, 'clamped into the rewrite band');
  assert.equal(w.needsRewrite(item), true, 'a long-failing PR rewrites, it does not vanish');

  const fresh = new Watchdog();
  fresh.seedAttempts('owner/r:pr-200', 5);
  assert.equal(fresh.needsRewrite('owner/r:pr-200'), true, 'seeded straight into rewrite');
});

test('seeding never LOWERS a count this engine has watched', () => {
  const w = new Watchdog();
  for (let i = 0; i < 6; i++) w.attempt('owner/r:pr-1');
  w.seedAttempts('owner/r:pr-1', 2);   // stale/persisted value from earlier
  assert.equal(w.attemptsFor('owner/r:pr-1'), 6, 'observed history wins over a seed');
});

test('the snapshot round-trips every counted item', () => {
  const w = new Watchdog();
  w.attempt('owner/r:pr-1');
  w.attempt('owner/r:pr-1');
  w.attempt('owner/r:pr-2');
  const snap = w.attemptSnapshot();
  assert.deepEqual(snap, { 'owner/r:pr-1': 2, 'owner/r:pr-2': 1 });

  const revived = new Watchdog();
  for (const [k, n] of Object.entries(snap)) revived.seedAttempts(k, n);
  assert.equal(revived.attemptsFor('owner/r:pr-1'), 2, 'survives a restart');
});

test('rejectedReviewCount reads verdicts from comments AND reviews', async () => {
  const fake = async () => JSON.stringify({
    reviews: [
      { state: 'CHANGES_REQUESTED', body: 'nope' },
      { state: 'COMMENTED', body: 'looks fine' },
    ],
    comments: [
      { body: '**Review verdict: REQUEST_CHANGES**\n\nfix the thing' },
      { body: 'Review verdict: APPROVE' },
      { body: 'unrelated chatter' },
    ],
  });
  // Study Room's reviewers post verdicts as COMMENTS, not GitHub reviews, so
  // counting only `reviews` would read every one of them as zero.
  assert.equal(await rejectedReviewCount('o/r', 1, fake), 2);
});

test('a PR with no rejections seeds nothing', async () => {
  const fake = async () => JSON.stringify({ reviews: [], comments: [{ body: 'Review verdict: APPROVE' }] });
  assert.equal(await rejectedReviewCount('o/r', 1, fake), 0);
});
