import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Watchdog, orphanWorktrees, DEFAULT_WATCHDOG_CONFIG } from '../src/watchdog.js';

test('an item wedges only after wedgeTicks consecutive no-progress bumps', () => {
  const wd = new Watchdog({ wedgeTicks: 3 });
  wd.bump('RESOLVE:pr-112');
  wd.bump('RESOLVE:pr-112');
  assert.deepEqual(wd.wedged(), [], 'not yet wedged below threshold');
  wd.bump('RESOLVE:pr-112');
  assert.deepEqual(wd.wedged(), ['RESOLVE:pr-112'], 'wedged at threshold');
  assert.equal(wd.countFor('RESOLVE:pr-112'), 3);
});

test('clear() resets an item — progress un-wedges it', () => {
  const wd = new Watchdog({ wedgeTicks: 2 });
  wd.bump('FIX:pr-9');
  wd.bump('FIX:pr-9');
  assert.deepEqual(wd.wedged(), ['FIX:pr-9']);
  wd.clear('FIX:pr-9');
  assert.equal(wd.countFor('FIX:pr-9'), 0);
  assert.deepEqual(wd.wedged(), []);
});

test('newlyWedged() surfaces each stuck item exactly once', () => {
  const wd = new Watchdog({ wedgeTicks: 1 });
  wd.bump('RESOLVE:pr-112');
  assert.deepEqual(wd.newlyWedged(), ['RESOLVE:pr-112'], 'first crossing reported');
  assert.deepEqual(wd.newlyWedged(), [], 'not reported again');
  wd.bump('RESOLVE:pr-112'); // still wedged, but already reported
  assert.deepEqual(wd.newlyWedged(), []);
});

test('a cleared-then-re-wedged item reports again', () => {
  const wd = new Watchdog({ wedgeTicks: 1 });
  wd.bump('MERGE:pr-5');
  assert.deepEqual(wd.newlyWedged(), ['MERGE:pr-5']);
  wd.clear('MERGE:pr-5');
  wd.bump('MERGE:pr-5');
  assert.deepEqual(wd.newlyWedged(), ['MERGE:pr-5'], 'reporting resets with the item');
});

test('assess: ok -> quarantine -> kill by wedged count', () => {
  const wd = new Watchdog({ wedgeTicks: 1, fatalWedgeCount: 3, fatalErrorStreak: 99 });
  assert.equal(wd.assess().level, 'ok');
  wd.bump('a'); wd.bump('b');
  const q = wd.assess();
  assert.equal(q.level, 'quarantine');
  assert.deepEqual(q.level === 'quarantine' ? q.keys.sort() : [], ['a', 'b']);
  wd.bump('c'); // third distinct wedged item -> systemic
  const k = wd.assess();
  assert.equal(k.level, 'kill');
  assert.match(k.level === 'kill' ? k.reason : '', /3 board items wedged/);
});

test('assess: a long-enough engine error streak kills, and tickOk resets it', () => {
  const wd = new Watchdog({ fatalErrorStreak: 3 });
  wd.tickError(); wd.tickError();
  assert.equal(wd.assess().level, 'ok', 'below the streak threshold');
  wd.tickError();
  assert.equal(wd.assess().level, 'kill');
  wd.tickOk();
  assert.equal(wd.assess().level, 'ok', 'a clean tick resets the streak');
});

test('default config is conservative (no accidental kills on a single stuck item)', () => {
  assert.ok(DEFAULT_WATCHDOG_CONFIG.fatalWedgeCount > 1, 'one wedged item must not kill the program');
  assert.ok(DEFAULT_WATCHDOG_CONFIG.wedgeTicks >= 2, 'a single failed attempt must not wedge');
});

test('orphanWorktrees returns on-disk dirs not registered and not in use', () => {
  const onDisk = [
    '/root/worktrees/study__issue-2',
    '/root/worktrees/study__issue-74',
    '/root/worktrees/_verify-113',
    '/root/worktrees/pr125-check',
  ];
  const registered = ['/root/repo', '/root/worktrees/study__issue-74', '/root/worktrees/pr125-check'];
  const inUse = ['/root/worktrees/_verify-113'];
  assert.deepEqual(
    orphanWorktrees(onDisk, registered, inUse),
    ['/root/worktrees/study__issue-2'],
    'only the untracked, unused leftover is an orphan',
  );
});

test('orphanWorktrees matches by basename across separators', () => {
  const onDisk = ['C:\\root\\worktrees\\study__issue-9'];
  const registered = ['/root/worktrees/study__issue-9/']; // posix + trailing slash
  assert.deepEqual(orphanWorktrees(onDisk, registered), [], 'same basename => not an orphan');
});

test('orphanWorktrees with nothing registered flags every dir', () => {
  const onDisk = ['/w/a', '/w/b'];
  assert.deepEqual(orphanWorktrees(onDisk, []), ['/w/a', '/w/b']);
});

// ---- Isolation vs the kill threshold ---------------------------------------
// The bug that made Study Room "keep producing wedged items": a quarantined item
// is never dispatched again, so it is never bumped and never cleared. Leaving it
// in the wedge count meant the total only ever climbed — the Nth quarantine
// killed an engine whose N stuck items were already isolated and costing nothing.
// Every restart then re-walked the same path to the same kill.

test('isolated items stop counting toward the systemic kill', () => {
  const w = new Watchdog({ wedgeTicks: 2, fatalWedgeCount: 3 });
  const wedge = (k: string) => { w.bump(k); w.bump(k); };

  wedge('a'); wedge('b');
  assert.equal(w.assess().level, 'quarantine');
  w.isolate('a'); w.isolate('b');
  assert.equal(w.assess().level, 'ok', 'isolated items must not keep the alarm up');

  // A third distinct wedge would have hit fatalWedgeCount with the old counting.
  wedge('c');
  const esc = w.assess();
  assert.equal(esc.level, 'quarantine');
  assert.deepEqual(esc.level === 'quarantine' ? esc.keys : [], ['c']);
});

test('the kill still fires when items wedge faster than they are isolated', () => {
  const w = new Watchdog({ wedgeTicks: 1, fatalWedgeCount: 3 });
  for (const k of ['a', 'b', 'c']) w.bump(k);
  const esc = w.assess();
  assert.equal(esc.level, 'kill', 'a genuinely systemic failure must still stop the engine');
  assert.equal(esc.wedged.length, 3);
});

test('isolate() is idempotent and keeps the item out of newlyWedged', () => {
  const w = new Watchdog({ wedgeTicks: 1 });
  w.bump('x');
  assert.deepEqual(w.newlyWedged(), ['x']);
  w.isolate('x');
  w.isolate('x');
  assert.deepEqual(w.isolatedKeys(), ['x']);
  assert.equal(w.isIsolated('x'), true);
  assert.deepEqual(w.wedged(), []);
  assert.deepEqual(w.newlyWedged(), []);
});

// Restoring a persisted quarantine at boot is the whole point: the restored keys
// must be inert, not seeds for a fresh climb to the kill.
test('a restored quarantine does not re-arm the kill', () => {
  const w = new Watchdog({ wedgeTicks: 4, fatalWedgeCount: 4 });
  for (const k of ['REVIEW:pr-112', 'REVIEW:pr-113', 'REVIEW:pr-114', 'REVIEW:pr-115']) w.isolate(k);
  assert.equal(w.assess().level, 'ok');
  assert.equal(w.isolatedKeys().length, 4);
});

// A human who fixes the underlying PR should get the item worked again without
// restarting the engine, so progress has to undo isolation too.
test('clear() un-isolates, handing a fixed item back to the board', () => {
  const w = new Watchdog({ wedgeTicks: 1 });
  w.bump('a');
  w.isolate('a');
  assert.equal(w.isIsolated('a'), true);

  w.clear('a');
  assert.equal(w.isIsolated('a'), false);
  assert.equal(w.countFor('a'), 0);
  // …and it can wedge again later if it stays broken.
  w.bump('a');
  assert.deepEqual(w.newlyWedged(), ['a']);
});

// ---- Oscillation cap -------------------------------------------------------
// The failure the stasis detector structurally cannot see. On Trader-Screener
// #114 a fix<->review ping-pong ran 8 reviews and 7 fixes in 15 minutes: each
// review re-added `changes-requested` and each fix cleared it, so the item's
// signature changed every tick, which reads as PROGRESS and resets the
// no-progress counter forever.

test('attempts accumulate per ITEM, across differing action kinds', () => {
  const w = new Watchdog({ maxItemAttempts: 4 });
  // This is the whole point: REVIEW:pr-114 and FIX:pr-114 are different action
  // keys, so per-action counters would each sit at 2 and never trip.
  w.attempt('pr-114'); w.attempt('pr-114'); w.attempt('pr-114');
  assert.equal(w.attemptsFor('pr-114'), 3);
  assert.deepEqual(w.newlyExhausted(), [], 'under the cap — still allowed to converge');

  w.attempt('pr-114');
  assert.deepEqual(w.newlyExhausted(), ['pr-114']);
});

test('an exhausted item is surfaced once, then stays isolated', () => {
  const w = new Watchdog({ maxItemAttempts: 2 });
  w.attempt('pr-1'); w.attempt('pr-1');
  assert.deepEqual(w.newlyExhausted(), ['pr-1']);
  assert.equal(w.isIsolated('pr-1'), true);

  // Further attempts must not re-report it, or every tick files a fresh issue.
  w.attempt('pr-1');
  assert.deepEqual(w.newlyExhausted(), []);
});

// Oscillation and stasis are independent: an oscillating item never trips the
// no-progress counter, so exhaustion must not depend on wedged() at all.
test('an item that oscillates is caught even though it never wedges', () => {
  const w = new Watchdog({ wedgeTicks: 3, maxItemAttempts: 4 });
  for (let i = 0; i < 4; i++) {
    w.attempt('pr-114');
    w.bump('REVIEW:pr-114');
    w.clear('REVIEW:pr-114'); // the fix moved the signature -> counter resets
  }
  assert.deepEqual(w.wedged(), [], 'stasis detector sees nothing, by design');
  assert.deepEqual(w.newlyExhausted(), ['pr-114'], 'oscillation cap catches it');
});

test('an exhausted item does not count toward the systemic kill', () => {
  const w = new Watchdog({ maxItemAttempts: 2, fatalWedgeCount: 2 });
  for (const item of ['pr-1', 'pr-2', 'pr-3']) { w.attempt(item); w.attempt(item); }
  assert.equal(w.newlyExhausted().length, 3);
  assert.equal(w.assess().level, 'ok', 'quarantining slow items must not kill the engine');
});

test('forgetItem drops history so a merged PR does not carry a stale count', () => {
  const w = new Watchdog({ maxItemAttempts: 2 });
  w.attempt('pr-9'); w.attempt('pr-9');
  assert.deepEqual(w.newlyExhausted(), ['pr-9']);

  w.forgetItem('pr-9');
  assert.equal(w.attemptsFor('pr-9'), 0);
  assert.equal(w.isIsolated('pr-9'), false);
  assert.deepEqual(w.trackedItems(), []);
});

test('trackedItems lists exactly what the runner should reconcile', () => {
  const w = new Watchdog();
  w.attempt('pr-1'); w.attempt('issue-2'); w.attempt('pr-1');
  assert.deepEqual(w.trackedItems().sort(), ['issue-2', 'pr-1']);
});

test('the ladder: fix, then rewrite, then give up', () => {
  const w = new Watchdog();
  // Rewrite comes BEFORE the give-up cap, so a reimplementation gets its own
  // rounds of review before the item is abandoned.
  assert.ok(w.cfg.rewriteAfterAttempts < w.cfg.maxItemAttempts,
    'a rewrite that cannot be reviewed afterwards is useless');
  assert.equal(w.cfg.rewriteAfterAttempts, 5);
  assert.equal(w.cfg.maxItemAttempts, 9);

  // Rounds 1-4: honest fix->review, patch it again.
  for (let i = 0; i < 4; i++) w.attempt('pr-1');
  assert.equal(w.needsRewrite('pr-1'), false, 'still worth patching');
  assert.deepEqual(w.newlyExhausted(), []);

  // Round 5: patching is not working -- reimplement instead.
  w.attempt('pr-1');
  assert.equal(w.needsRewrite('pr-1'), true, 'stop patching, rewrite');
  assert.deepEqual(w.newlyExhausted(), [], 'a rewrite is not a give-up');

  // The rewrite gets reviewed too; still rewriting, not abandoned.
  for (let i = 0; i < 3; i++) w.attempt('pr-1');
  assert.equal(w.needsRewrite('pr-1'), true);
  assert.deepEqual(w.newlyExhausted(), []);

  // Round 9: the rewrite failed as well. Now give up.
  w.attempt('pr-1');
  assert.equal(w.needsRewrite('pr-1'), false, 'past the cap it is not a rewrite, it is over');
  assert.deepEqual(w.newlyExhausted(), ['pr-1']);
});

// -- the wedge report must survive isolation (found live) ---------------------
// quarantine() calls isolate(), which deletes the key's count. The runner read
// countFor() AFTER quarantining, so every watchdog report -- the log line and
// the GitHub issue it files -- claimed "0 attempts, no progress", destroying the
// one number that says whether the engine tried hard or gave up instantly.

test('isolate() clears the count, so it must be read before quarantining', () => {
  const w = new Watchdog({ wedgeTicks: 2 });
  w.bump('FIX:owner/repo:pr-1');
  w.bump('FIX:owner/repo:pr-1');
  assert.equal(w.countFor('FIX:owner/repo:pr-1'), 2, 'count accrues while wedging');

  const wedged = w.newlyWedged();
  assert.deepEqual(wedged, ['FIX:owner/repo:pr-1']);
  // Capture BEFORE isolating — this is the ordering live.ts now relies on.
  const captured = new Map(wedged.map((k) => [k, w.countFor(k)]));

  w.isolate('FIX:owner/repo:pr-1');
  assert.equal(w.countFor('FIX:owner/repo:pr-1'), 0, 'isolate wipes the counter');
  assert.equal(captured.get('FIX:owner/repo:pr-1'), 2, 'the captured value survives');
});
