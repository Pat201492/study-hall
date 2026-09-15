import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AssignmentLog, warmMap, MAX_RECENT, type AssignmentRecord } from '../src/assignments.js';
import { Protector, type Worker } from '../src/protector.js';

// #126: the Protector's decisions used to be console-only and vanish. These
// assert the tallies against a scripted sequence, which is the point — the
// warm-reuse rate is the KPI that says whether the pool is working or is a
// cold-start machine wearing a warm-pool costume.

function rec(over: Partial<AssignmentRecord> = {}): AssignmentRecord {
  return {
    at: 1000, repo: 'o/r', taskId: '#1', kind: 'exact',
    tier: 'sonnet', role: 'implement', workerId: 'sonnet-1',
    ...over,
  } as AssignmentRecord;
}

test('tallies count every ladder step', () => {
  const log = new AssignmentLog();
  log.record(rec({ kind: 'exact' }));
  log.record(rec({ kind: 'exact' }));
  log.record(rec({ kind: 'rerole', fromRole: 'review' }));
  log.record(rec({ kind: 'spawn' }));
  log.record(rec({ kind: 'wait', workerId: null, waitReason: 'pool-at-cap' }));

  const t = log.tallies();
  assert.equal(t.exact, 2);
  assert.equal(t.rerole, 1);
  assert.equal(t.spawn, 1);
  assert.equal(t.wait, 1);
  assert.equal(t.total, 5);
});

test('warm-reuse rate measures PLACEMENTS, not waits', () => {
  const log = new AssignmentLog();
  // 3 placed (2 warm, 1 cold) + 2 waits. A wait is not a failure to reuse
  // warmth -- nothing was placed at all -- so it must not drag the rate down.
  log.record(rec({ kind: 'exact' }));
  log.record(rec({ kind: 'rerole' }));
  log.record(rec({ kind: 'spawn' }));
  log.record(rec({ kind: 'wait', workerId: null, waitReason: 'tier-at-cap' }));
  log.record(rec({ kind: 'wait', workerId: null, waitReason: 'tier-at-cap' }));

  assert.equal(log.tallies().warmReuseRate, 2 / 3);
});

test('an empty log reports a zero rate rather than NaN', () => {
  const t = new AssignmentLog().tallies();
  assert.equal(t.total, 0);
  assert.equal(t.warmReuseRate, 0);
});

test('a cold start followed by steady state moves the rate up', () => {
  const log = new AssignmentLog();
  for (let i = 0; i < 4; i++) log.record(rec({ kind: 'spawn' }));
  const cold = log.tallies().warmReuseRate;
  for (let i = 0; i < 16; i++) log.record(rec({ kind: 'exact' }));
  assert.equal(cold, 0, 'a pure cold start reuses nothing');
  assert.ok(log.tallies().warmReuseRate > 0.75, 'steady state is mostly warm');
});

test('waits are broken down by reason, so "capped" reads apart from "idle"', () => {
  const log = new AssignmentLog();
  log.record(rec({ kind: 'wait', workerId: null, waitReason: 'tier-at-cap' }));
  log.record(rec({ kind: 'wait', workerId: null, waitReason: 'tier-at-cap' }));
  log.record(rec({ kind: 'wait', workerId: null, waitReason: 'pool-at-cap' }));
  const snap = log.snapshot([]);
  assert.deepEqual(snap.waitsByReason, { 'tier-at-cap': 2, 'pool-at-cap': 1 });
});

test('the feed is newest-first and a re-role shows from->to', () => {
  const log = new AssignmentLog();
  log.record(rec({ taskId: '#1' }));
  log.record(rec({ taskId: '#2', kind: 'rerole', fromRole: 'review', role: 'fix' }));
  const recent = log.recent();
  assert.equal(recent[0].taskId, '#2', 'newest first');
  assert.equal(recent[0].fromRole, 'review');
  assert.equal(recent[0].role, 'fix');
});

test('the ring is capped so status.json stays bounded over a long run', () => {
  const log = new AssignmentLog(10);
  for (let i = 0; i < 500; i++) log.record(rec({ taskId: `#${i}` }));
  const recent = log.recent();
  assert.equal(recent.length, 10, 'ring is capped');
  assert.equal(recent[0].taskId, '#499', 'and keeps the NEWEST, not the oldest');
  // Tallies are cumulative even though the ring is not.
  assert.equal(log.tallies().total, 500);
});

test('rebalance events are recorded with from/to', () => {
  const log = new AssignmentLog();
  log.recordRebalance({ at: 1, repo: 'o/r', workerId: 'sonnet-2', tier: 'sonnet', from: 'implement', to: 'review' });
  const [r] = log.rebalances();
  assert.equal(r.workerId, 'sonnet-2');
  assert.equal(r.from, 'implement');
  assert.equal(r.to, 'review');
});

// -- warm map ----------------------------------------------------------------

function worker(over: Partial<Worker> = {}): Worker {
  return {
    id: 'sonnet-1', tier: 'sonnet', role: 'implement', state: 'idle-warm',
    task: null, worktree: '.students/sonnet-1', lastFinishedSeq: 0, healthMisses: 0,
    ...over,
  } as Worker;
}

test('warmMap reports supply against demand per (tier, role)', () => {
  const cells = warmMap('o/r', [
    worker({ id: 'a', role: 'implement', state: 'idle-warm' }),
    worker({ id: 'b', role: 'implement', state: 'busy' }),
    worker({ id: 'c', role: 'review', state: 'asleep' }),
  ], [
    { tier: 'sonnet', role: 'implement' },
    { tier: 'sonnet', role: 'implement' },
    { tier: 'sonnet', role: 'fix' },
  ]);

  const impl = cells.find((c) => c.role === 'implement' && c.tier === 'sonnet')!;
  assert.equal(impl.free, 1);
  assert.equal(impl.busy, 1);
  assert.equal(impl.demand, 2);

  // asleep counts as free -- it is still warm and still reusable.
  const review = cells.find((c) => c.role === 'review' && c.tier === 'sonnet')!;
  assert.equal(review.free, 1);
  assert.equal(review.demand, 0);

  // Demand with no supply is the mismatch rebalance() exists to fix; it must
  // appear, not be dropped for having no workers.
  const fix = cells.find((c) => c.role === 'fix' && c.tier === 'sonnet')!;
  assert.equal(fix.free + fix.busy, 0);
  assert.equal(fix.demand, 1);
});

test('warmMap drops cells with neither supply nor demand', () => {
  const cells = warmMap('o/r', [worker()], [{ tier: 'sonnet', role: 'implement' }]);
  assert.equal(cells.length, 1, 'only the one live cell, not 3 tiers x 5 roles');
  assert.ok(cells.every((c) => c.free + c.busy + c.demand > 0));
});

// -- the wait reason comes from the real Protector ----------------------------

test('the Protector names WHICH cap made a task wait', () => {
  // perTierMax 1: the tier fills, then its own ceiling is what blocks.
  const p = new Protector({ perTierMax: 1, totalCap: 4, maxConcurrent: 4 });
  const first = p.assignOne({ id: '#1', tier: 'sonnet', role: 'implement' });
  assert.equal(first.kind, 'spawn');
  assert.equal(first.waitReason, undefined, 'a placed task has no wait reason');

  const second = p.assignOne({ id: '#2', tier: 'sonnet', role: 'implement' });
  assert.equal(second.kind, 'wait');
  assert.equal(second.waitReason, 'tier-at-cap');
});

test('a full pool reports pool-at-cap, not tier-at-cap', () => {
  // Tier ceiling is high; the TOTAL cap is what actually binds.
  const p = new Protector({ perTierMax: 5, totalCap: 1, maxConcurrent: 4 });
  assert.equal(p.assignOne({ id: '#1', tier: 'sonnet', role: 'implement' }).kind, 'spawn');
  const blocked = p.assignOne({ id: '#2', tier: 'haiku', role: 'implement' });
  assert.equal(blocked.kind, 'wait');
  assert.equal(blocked.waitReason, 'pool-at-cap');
});

test('MAX_RECENT is a sane default bound', () => {
  assert.ok(MAX_RECENT > 0 && MAX_RECENT <= 1000);
});

test('cross-repo counts as reuse, but is tallied separately (#121)', () => {
  const log = new AssignmentLog();
  log.record(rec({ kind: 'exact' }));
  log.record(rec({ kind: 'cross-repo' }));
  log.record(rec({ kind: 'spawn' }));
  const t = log.tallies();
  // Visible on its own -- this is the number that makes the affinity trade
  // measurable rather than assumed.
  assert.equal(t.crossRepo, 1);
  // ...and counted as reuse, because it is: the role prefix still hits and only
  // the spec block re-reads. It is not a cold start.
  assert.equal(t.warmReuseRate, 2 / 3);
  assert.equal(t.total, 3);
});
