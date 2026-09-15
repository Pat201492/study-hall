import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Protector,
  demandByTierRole,
  warmTargets,
  DEFAULT_PROTECTOR_CONFIG,
  RECYCLE_AFTER_MISSES,
  type Task,
  type ProtectorConfig,
} from '../src/protector.js';

let taskSeq = 0;
function task(tier: Task['tier'], role: Task['role']): Task {
  taskSeq += 1;
  return { id: `t${taskSeq}`, tier, role };
}

function proto(cfg: Partial<ProtectorConfig> = {}) {
  return new Protector({ perTierMax: 3, totalCap: 6, maxConcurrent: 4, worktreeRoot: '.students', ...cfg });
}

// ---- assignment ladder ordering ------------------------------------------

test('ladder step 3: no worker of the model -> spawn a fresh (M,R)', () => {
  const p = proto();
  const a = p.assignOne(task('sonnet', 'implement'));
  assert.equal(a.kind, 'spawn');
  assert.equal(a.worker?.tier, 'sonnet');
  assert.equal(a.worker?.role, 'implement');
  assert.equal(a.worker?.state, 'busy');
});

test('ladder step 1: idle-warm (M,R) worker -> exact match, cache hit', () => {
  const p = proto();
  const first = p.assignOne(task('sonnet', 'implement')).worker!;
  p.finish(first.id); // now idle-warm, still role=implement (sticky)
  const a = p.assignOne(task('sonnet', 'implement'));
  assert.equal(a.kind, 'exact');
  assert.equal(a.worker?.id, first.id, 'reuses the same warm worker');
});

test('ladder step 2: no idle (M,R) but idle (M,other) -> re-role same model', () => {
  const p = proto();
  const w = p.assignOne(task('sonnet', 'implement')).worker!;
  p.finish(w.id); // idle-warm, role=implement
  const a = p.assignOne(task('sonnet', 'review'));
  assert.equal(a.kind, 'rerole');
  assert.equal(a.worker?.id, w.id);
  assert.equal(a.worker?.role, 'review', 'role block re-cached to the new role');
});

test('ladder step 4: at cap and all of the model busy -> wait', () => {
  const p = proto({ perTierMax: 1, totalCap: 1 });
  p.assignOne(task('sonnet', 'implement')); // fills the one slot, busy
  const a = p.assignOne(task('sonnet', 'review'));
  assert.equal(a.kind, 'wait');
  assert.equal(a.worker, null);
});

test('ladder prefers exact over re-role when both are available', () => {
  const p = proto();
  const impl = p.assignOne(task('sonnet', 'implement')).worker!;
  const rev = p.assignOne(task('sonnet', 'review')).worker!;
  p.finish(impl.id);
  p.finish(rev.id);
  const a = p.assignOne(task('sonnet', 'review'));
  assert.equal(a.kind, 'exact');
  assert.equal(a.worker?.id, rev.id);
});

// ---- mixed task list: correct model+role, caps never exceeded -------------

test('mixed queue assigns the correct model+role to each worker', () => {
  const p = proto({ perTierMax: 3, totalCap: 9 });
  const queue = [
    task('haiku', 'fix'),
    task('sonnet', 'implement'),
    task('opus', 'resolve'),
  ];
  const res = p.assign(queue);
  for (let i = 0; i < queue.length; i++) {
    assert.equal(res[i].worker?.tier, queue[i].tier);
    assert.equal(res[i].worker?.role, queue[i].role);
  }
});

test('caps never exceeded: per-tier max and total cap both enforced', () => {
  const p = proto({ perTierMax: 2, totalCap: 3 });
  // 4 sonnet tasks, but perTierMax=2 -> only 2 spawn, rest wait.
  const res = p.assign([
    task('sonnet', 'implement'),
    task('sonnet', 'implement'),
    task('sonnet', 'implement'),
    task('sonnet', 'review'),
  ]);
  assert.equal(p.pool.filter((w) => w.tier === 'sonnet').length, 2);
  assert.equal(res.filter((a) => a.kind === 'wait').length, 2);
});

test('total cap bounds spawns across all tiers', () => {
  const p = proto({ perTierMax: 3, totalCap: 2 });
  const res = p.assign([
    task('haiku', 'fix'),
    task('sonnet', 'implement'),
    task('opus', 'resolve'),
  ]);
  assert.equal(p.pool.length, 2);
  assert.equal(res[2].kind, 'wait');
});

// ---- warm-count = demand (not flat N per model) ---------------------------

test('warmTargets tracks demand per tier, capped at perTierMax & maxConcurrent', () => {
  const cfg = { ...DEFAULT_PROTECTOR_CONFIG, perTierMax: 3, maxConcurrent: 4 };
  const t = warmTargets(
    [
      task('sonnet', 'implement'),
      task('sonnet', 'implement'),
      task('sonnet', 'review'),
      task('sonnet', 'review'), // 4 sonnet demand -> capped at perTierMax 3
      task('haiku', 'fix'),
    ],
    cfg,
  );
  assert.equal(t.sonnet, 3);
  assert.equal(t.haiku, 1);
  assert.equal(t.opus, 0, 'idle tier wants 0 warm — not kept hot');
});

test('reconcileWarm spawns exactly the needed warm students, none beyond', () => {
  const p = proto({ perTierMax: 3, totalCap: 9 });
  const queue = [task('sonnet', 'implement'), task('sonnet', 'implement'), task('sonnet', 'review')];
  p.reconcileWarm(queue);
  const sonnet = p.pool.filter((w) => w.tier === 'sonnet');
  assert.equal(sonnet.length, 3, 'exactly demand (2 impl + 1 review)');
  assert.equal(p.pool.filter((w) => w.tier === 'opus').length, 0, 'idle tier not spawned');
});

test('reconcileWarm reuses free workers instead of spawning redundant ones', () => {
  const p = proto();
  // Pre-warm 2 sonnet workers via a first reconcile.
  p.reconcileWarm([task('sonnet', 'implement'), task('sonnet', 'implement')]);
  assert.equal(p.pool.length, 2);
  // Same demand again -> no new spawns (free workers reused).
  p.reconcileWarm([task('sonnet', 'implement'), task('sonnet', 'implement')]);
  assert.equal(p.pool.length, 2, 'spawns only when demand exceeds the live pool');
});

test('reconcileWarm parks surplus idle workers asleep when demand drops', () => {
  const p = proto();
  p.reconcileWarm([task('sonnet', 'implement'), task('sonnet', 'implement'), task('sonnet', 'review')]);
  assert.equal(p.pool.filter((w) => w.tier === 'sonnet').length, 3);
  // Demand drops to 1 -> 2 surplus parked asleep (not hot), none killed.
  p.reconcileWarm([task('sonnet', 'implement')]);
  const sonnet = p.pool.filter((w) => w.tier === 'sonnet');
  assert.equal(sonnet.length, 3, 'warm students are parked, not destroyed');
  assert.equal(sonnet.filter((w) => w.state === 'asleep').length, 2);
});

// ---- re-role victim selection --------------------------------------------

test('re-role victim = the current role with least remaining queue demand', () => {
  const p = proto();
  const impl = p.assignOne(task('sonnet', 'implement')).worker!;
  const merge = p.assignOne(task('sonnet', 'merge')).worker!;
  p.finish(impl.id);
  p.finish(merge.id);
  // A new review task arrives; queue still has more implement demand, none for merge.
  const remaining = [task('sonnet', 'implement'), task('sonnet', 'implement')];
  const a = p.assignOne(task('sonnet', 'review'), remaining);
  assert.equal(a.kind, 'rerole');
  assert.equal(a.worker?.id, merge.id, 'cannibalizes merge (0 demand), not still-needed implement');
});

test('re-role victim tie-break: most-recently-finished (warmest)', () => {
  const p = proto();
  const a1 = p.assignOne(task('sonnet', 'merge')).worker!;
  const a2 = p.assignOne(task('sonnet', 'resolve')).worker!;
  p.finish(a1.id); // finished first (colder)
  p.finish(a2.id); // finished last (warmest)
  // Neither merge nor resolve has remaining demand -> pure warmth tie-break.
  const a = p.assignOne(task('sonnet', 'review'), []);
  assert.equal(a.worker?.id, a2.id, 'picks the warmest free worker');
});

// ---- rebalance shifts the warm mix toward queue demand -------------------

test('rebalance re-roles idle workers toward the pending role mix', () => {
  const p = proto();
  // 3 warm implementers.
  p.reconcileWarm([task('sonnet', 'implement'), task('sonnet', 'implement'), task('sonnet', 'implement')]);
  // Board tilts to reviews: 1 impl + 2 review pending.
  const changes = p.rebalance([task('sonnet', 'implement'), task('sonnet', 'review'), task('sonnet', 'review')]);
  const roles = p.pool.filter((w) => w.tier === 'sonnet').map((w) => w.role).sort();
  assert.deepEqual(roles, ['implement', 'review', 'review'], 'mix now matches demand');
  assert.equal(changes.length, 2, 'two implementers re-roled to reviewers');
});

test('rebalance leaves an already-matching pool untouched', () => {
  const p = proto();
  p.reconcileWarm([task('sonnet', 'implement'), task('sonnet', 'implement'), task('sonnet', 'review')]);
  const changes = p.rebalance([task('sonnet', 'implement'), task('sonnet', 'implement'), task('sonnet', 'review')]);
  assert.equal(changes.length, 0);
});

test('rebalance never touches busy workers', () => {
  const p = proto();
  const busy = p.assignOne(task('sonnet', 'implement')).worker!; // stays busy
  p.reconcileWarm([task('sonnet', 'implement'), task('sonnet', 'review')]); // adds free workers
  p.rebalance([task('sonnet', 'review'), task('sonnet', 'review'), task('sonnet', 'review')]);
  assert.equal(p.pool.find((w) => w.id === busy.id)?.role, 'implement', 'busy worker keeps its role');
});

// ---- health-check + recycle ----------------------------------------------

test('healthCheck flags a worker for recycling after repeated misses', () => {
  const p = proto();
  const w = p.assignOne(task('sonnet', 'implement')).worker!;
  const wedged = new Set([w.id]);
  const health = (x: { id: string }) => !wedged.has(x.id);
  // First miss: not yet over threshold.
  assert.deepEqual(p.healthCheck(health), []);
  assert.equal(RECYCLE_AFTER_MISSES, 2);
  // Second miss: flagged.
  assert.deepEqual(p.healthCheck(health), [w.id]);
  assert.equal(p.pool.find((x) => x.id === w.id)?.state, 'recycling');
});

test('a healthy check clears accumulated misses', () => {
  const p = proto();
  const w = p.assignOne(task('sonnet', 'implement')).worker!;
  let ok = false;
  p.healthCheck((x) => (x.id === w.id ? ok : true)); // 1 miss
  ok = true;
  p.healthCheck((x) => (x.id === w.id ? ok : true)); // recovers -> misses reset
  ok = false;
  assert.deepEqual(p.healthCheck((x) => (x.id === w.id ? ok : true)), [], 'counter restarted, not flagged');
});

test('recycle replaces a wedged worker without exceeding caps or blocking others', () => {
  const p = proto({ perTierMax: 3, totalCap: 3 });
  const a = p.assignOne(task('sonnet', 'implement')).worker!;
  const b = p.assignOne(task('sonnet', 'review')).worker!;
  const before = p.pool.length;
  const fresh = p.recycle(a.id)!;
  assert.equal(p.pool.length, before, 'remove-then-spawn keeps the slot budget flat');
  assert.equal(p.pool.some((w) => w.id === a.id), false, 'wedged worker gone');
  assert.equal(fresh.tier, 'sonnet');
  assert.equal(fresh.role, 'implement', 'fresh worker takes the same (tier, role)');
  assert.equal(p.pool.find((w) => w.id === b.id)?.state, 'busy', 'other worker keeps serving');
});

test('recycle gives every student its own dedicated worktree', () => {
  const p = proto();
  const a = p.assignOne(task('sonnet', 'implement')).worker!;
  const fresh = p.recycle(a.id)!;
  assert.notEqual(fresh.worktree, a.worktree);
  const paths = p.pool.map((w) => w.worktree);
  assert.equal(new Set(paths).size, paths.length, 'worktrees are unique per worker');
});

test('recycle of an unknown id is a no-op returning null', () => {
  const p = proto();
  assert.equal(p.recycle('nope'), null);
});

// ---- demandByTierRole helper ---------------------------------------------

test('demandByTierRole counts every (tier, role) pair, zero-filled', () => {
  const d = demandByTierRole([task('haiku', 'fix'), task('haiku', 'fix'), task('opus', 'merge')]);
  assert.equal(d.haiku.fix, 2);
  assert.equal(d.opus.merge, 1);
  assert.equal(d.sonnet.implement, 0);
});

// -- repo affinity: a PREFERENCE, never a gate (#121) -------------------------
// The Protector's premise is ROLE agility. Repo has never been part of worker
// identity: task worktrees are per-task and the role prefix is repo-agnostic.
// So a cross-repo placement is a PARTIAL cache miss (spec re-read, role prefix
// still hot), which beats a cold spawn -- and must therefore never be refused.

test('same-repo warmth is preferred: an exact match wins', () => {
  const p = new Protector({ perTierMax: 4, totalCap: 8 });
  p.assignOne({ id: 'a', tier: 'sonnet', role: 'review', repo: 'o/a' });
  p.finish(p.pool[0].id);
  const asg = p.assignOne({ id: 'b', tier: 'sonnet', role: 'review', repo: 'o/a' });
  assert.equal(asg.kind, 'exact');
});

test('a free slot on ANOTHER repo is used BEFORE spawning cold', () => {
  const p = new Protector({ perTierMax: 4, totalCap: 8 });
  p.assignOne({ id: 'a', tier: 'sonnet', role: 'review', repo: 'o/a' });
  p.finish(p.pool[0].id);
  // repo B has no warm slot of its own, but repo A's is free and in-role.
  const asg = p.assignOne({ id: 'b', tier: 'sonnet', role: 'review', repo: 'o/b' });
  assert.equal(asg.kind, 'cross-repo', 'must reuse, not spawn');
  assert.equal(p.pool.length, 1, 'no cold spawn was paid');
});

test('no slot sits idle-warm for repo A while repo B waits on a spawn', () => {
  // The hard rule from the handoff: idle affinity is worse than a cross-repo hit.
  const p = new Protector({ perTierMax: 4, totalCap: 8 });
  p.assignOne({ id: 'a', tier: 'sonnet', role: 'implement', repo: 'o/a' });
  p.finish(p.pool[0].id);
  const before = p.pool.length;
  p.assignOne({ id: 'b', tier: 'sonnet', role: 'implement', repo: 'o/b' });
  assert.equal(p.pool.length, before, 'reused the idle slot instead of spawning');
  assert.equal(p.pool[0].state, 'busy');
});

test('the cross-repo trade is RECORDED, so its cost is measurable not assumed', () => {
  const p = new Protector({ perTierMax: 4, totalCap: 8 });
  p.assignOne({ id: 'a', tier: 'sonnet', role: 'fix', repo: 'o/a' });
  p.finish(p.pool[0].id);
  const asg = p.assignOne({ id: 'b', tier: 'sonnet', role: 'fix', repo: 'o/b' });
  // The ladder step is what #126's tallies count and #127's screen shows.
  assert.equal(asg.kind, 'cross-repo');
  assert.notEqual(asg.kind, 'exact', 'must not masquerade as a same-repo hit');
});

test('a worker carries its LAST repo, so affinity follows the work', () => {
  const p = new Protector({ perTierMax: 4, totalCap: 8 });
  p.assignOne({ id: 'a', tier: 'sonnet', role: 'review', repo: 'o/a' });
  const id = p.pool[0].id;
  assert.equal(p.pool[0].repo, 'o/a');
  p.finish(id);
  p.assignOne({ id: 'b', tier: 'sonnet', role: 'review', repo: 'o/b' });
  assert.equal(p.pool[0].repo, 'o/b', 'repo is sticky like role');
  // ...and now o/b is the exact-match repo.
  p.finish(id);
  assert.equal(p.assignOne({ id: 'c', tier: 'sonnet', role: 'review', repo: 'o/b' }).kind, 'exact');
});

test('single-repo behaviour is unchanged when tasks carry no repo', () => {
  const p = new Protector({ perTierMax: 4, totalCap: 8 });
  assert.equal(p.assignOne({ id: 'a', tier: 'sonnet', role: 'implement' }).kind, 'spawn');
  p.finish(p.pool[0].id);
  assert.equal(p.assignOne({ id: 'b', tier: 'sonnet', role: 'implement' }).kind, 'exact');
  p.finish(p.pool[0].id);
  // A different role on the same tier is still a plain re-role -- never
  // 'cross-repo', because no repo was ever in play.
  assert.equal(p.assignOne({ id: 'c', tier: 'sonnet', role: 'review' }).kind, 'rerole');
});

test('same-repo re-role is preferred over a cross-repo exact-role match', () => {
  // Rung 2 (rerole, same repo) sits above rung 3 (cross-repo): keeping the spec
  // block cached beats keeping the role block cached.
  const p = new Protector({ perTierMax: 4, totalCap: 8 });
  p.assignOne({ id: 'a', tier: 'sonnet', role: 'implement', repo: 'o/a' });
  p.assignOne({ id: 'b', tier: 'sonnet', role: 'review', repo: 'o/b' });
  p.finish(p.pool[0].id); // o/a worker, role implement, free
  p.finish(p.pool[1].id); // o/b worker, role review, free
  const asg = p.assignOne({ id: 'c', tier: 'sonnet', role: 'review', repo: 'o/a' });
  assert.equal(asg.kind, 'rerole');
  assert.equal(asg.worker?.repo, 'o/a');
});
