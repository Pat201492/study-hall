import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { QuotaSnapshot } from '@study-hall/harness/contract';
import { decide, slotBudget, type BoardSnapshot, type CycleConfig, type CycleState, type Decision } from '../src/engine/boardCycle.js';
import { DEFAULT_POOLS } from '../src/config.js';
import type { RawIssue, OpenPull } from '../src/github.js';

// Fixture builders — each case names only what it cares about.
function issue(o: Partial<RawIssue> & { number: number }): RawIssue {
  return { number: o.number, title: o.title ?? `Issue ${o.number}`, body: o.body ?? 'Do the thing.', labels: o.labels ?? [] };
}
function pull(o: Partial<OpenPull> & { number: number }): OpenPull {
  return {
    number: o.number, title: o.title ?? `PR ${o.number}`, headRefName: o.headRefName ?? `feat/issue-${o.number}`,
    labels: o.labels ?? [], mergeable: o.mergeable ?? 'MERGEABLE', statusCheckRollup: o.statusCheckRollup ?? 'SUCCESS',
    reviewDecision: o.reviewDecision ?? '', files: o.files ?? [],
  };
}
function board(repo: string, o: Partial<BoardSnapshot> = {}): BoardSnapshot {
  return {
    repo, issues: o.issues ?? [], pulls: o.pulls ?? [],
    handled: o.handled ?? new Set(), quarantined: o.quarantined ?? new Set(), promoted: o.promoted ?? new Set(),
    contested: o.contested,
  };
}
function quota(provider: string, state: QuotaSnapshot['state']): QuotaSnapshot {
  return { provider, state };
}
function state(o: Partial<CycleState> = {}): CycleState {
  return {
    now: 1_000_000, inFlight: new Set(), inFlightFiles: [], inFlightPerProvider: {},
    quotas: { anthropic: quota('anthropic', 'available'), openai: quota('openai', 'available') },
    providerChoice: 'auto', failoverOrder: ['anthropic', 'openai'],
    throttleLimit: 4, boundedRemaining: null,
    ...o,
  };
}
const cfg: CycleConfig = {
  optimizationMode: 'token', pools: DEFAULT_POOLS, maxConcurrent: 4, autoMerge: true,
  harnessFor: { anthropic: 'claude-code', openai: 'codex' },
};

const dispatches = (d: Decision[]) => d.filter((x): x is Extract<Decision, { kind: 'dispatch' }> => x.kind === 'dispatch');
const acts = (d: Decision[]) => d.filter((x): x is Extract<Decision, { kind: 'act' }> => x.kind === 'act');
const holds = (d: Decision[]) => d.filter((x): x is Extract<Decision, { kind: 'hold' }> => x.kind === 'hold');

test('three ticks over fixture boards: implement, then review, then merge; a parked issue yields nothing', () => {
  const repo = 'o/r';
  // Tick 1: one open issue, one parked issue.
  const t1 = decide([board(repo, {
    issues: [issue({ number: 1 }), issue({ number: 2, labels: [{ name: 'needs-human' }] })],
  })], state(), cfg);
  const d1 = dispatches(t1.decisions);
  assert.equal(d1.length, 1);
  assert.equal(d1[0].action.kind, 'IMPLEMENT');
  assert.equal(d1[0].action.repo, repo);
  assert.equal(d1[0].role, 'implement');
  assert.equal(d1[0].key, 'IMPLEMENT:o/r:issue-1');
  assert.equal(d1[0].item, 'o/r:issue-1');
  assert.equal(d1[0].provider, 'anthropic');
  assert.equal(d1[0].harness, 'claude-code');
  assert.equal(d1[0].model, DEFAULT_POOLS.anthropic.tiers.opus!.model);
  assert.equal(t1.slots.used, 1);
  assert.ok(!t1.decisions.some((d) => 'action' in d && d.action?.number === 2), 'parked issue yields no decision');

  // Tick 2: the PR appeared; the issue is in the PR pipeline now.
  const t2 = decide([board(repo, {
    issues: [issue({ number: 1 })],
    pulls: [pull({ number: 10, headRefName: 'feat/issue-1-thing' })],
  })], state(), cfg);
  const d2 = dispatches(t2.decisions);
  assert.equal(d2.length, 1);
  assert.equal(d2[0].action.kind, 'REVIEW');
  assert.equal(d2[0].role, 'review');
  assert.equal(d2[0].action.number, 10);

  // Tick 3: approved and green -> MERGE is orchestrator work, not a student.
  const t3 = decide([board(repo, {
    issues: [issue({ number: 1 })],
    pulls: [pull({ number: 10, headRefName: 'feat/issue-1-thing', labels: ['reviewed-ok'] })],
  })], state(), cfg);
  assert.equal(dispatches(t3.decisions).length, 0);
  const a3 = acts(t3.decisions);
  assert.equal(a3.length, 1);
  assert.equal(a3[0].action.kind, 'MERGE');
  assert.equal(t3.slots.used, 0);
});

test('failover: Claude exhausted routes to Codex; available again routes back', () => {
  const boards = [board('o/r', { issues: [issue({ number: 1 })] })];
  const out = decide(boards, state({ quotas: { anthropic: quota('anthropic', 'exhausted'), openai: quota('openai', 'available') } }), cfg);
  const d = dispatches(out.decisions);
  assert.equal(d.length, 1);
  assert.equal(d[0].provider, 'openai');
  assert.equal(d[0].harness, 'codex');
  assert.equal(d[0].model, DEFAULT_POOLS.openai.tiers.opus!.model);

  const back = decide(boards, state(), cfg);
  assert.equal(dispatches(back.decisions)[0].provider, 'anthropic');
});

test('a provider in unknown yields a probe and no dispatch commits to it', () => {
  const boards = [board('o/r', { issues: [issue({ number: 1 }), issue({ number: 2 })] })];
  const out = decide(boards, state({ quotas: { anthropic: quota('anthropic', 'unknown'), openai: quota('openai', 'unknown') } }), cfg);
  assert.equal(dispatches(out.decisions).length, 0);
  const probes = out.decisions.filter((x) => x.kind === 'probe');
  assert.equal(probes.length, 1, 'one probe per tick');
  assert.equal(probes[0].kind === 'probe' && probes[0].provider, 'anthropic');
});

test('a pinned provider that is exhausted holds with the reason, and does not fail over', () => {
  const out = decide([board('o/r', { issues: [issue({ number: 1 })] })],
    state({ providerChoice: 'anthropic', quotas: { anthropic: quota('anthropic', 'exhausted'), openai: quota('openai', 'available') } }), cfg);
  assert.equal(dispatches(out.decisions).length, 0);
  const h = holds(out.decisions);
  assert.equal(h.length, 1);
  assert.equal(h[0].reason, 'provider');
  assert.match(h[0].detail ?? '', /pinned-but-exhausted/);
});

test('per-provider caps and the throttle limit bound dispatches per tick', () => {
  const issues = [1, 2, 3, 4, 5, 6].map((n) => issue({ number: n }));
  const boards = [board('o/r', { issues })];

  // Throttle at 2 -> two dispatches, the rest held for want of slots.
  const throttled = decide(boards, state({ throttleLimit: 2 }), cfg);
  assert.equal(dispatches(throttled.decisions).length, 2);
  assert.equal(holds(throttled.decisions).filter((h) => h.reason === 'no-slots').length, 4);

  // Codex alone (cap 2) with one already running -> exactly one more.
  const capped = decide(boards, state({
    throttleLimit: 10,
    quotas: { anthropic: quota('anthropic', 'exhausted'), openai: quota('openai', 'available') },
    inFlightPerProvider: { openai: 1 },
  }), cfg);
  const d = dispatches(capped.decisions);
  assert.equal(d.length, 1);
  assert.equal(d[0].provider, 'openai');

  // Global ceiling: maxConcurrent 4 with 3 in flight -> one slot.
  assert.equal(slotBudget(cfg, state({ throttleLimit: 10, inFlightPerProvider: { anthropic: 3 } })), 1);

  // Both providers at cap -> nothing, and the hold says so once.
  const full = decide(boards, state({ throttleLimit: 10, inFlightPerProvider: { anthropic: 4, openai: 2 } }), { ...cfg, maxConcurrent: 10 });
  assert.equal(dispatches(full.decisions).length, 0);
});

test('in-flight, handled, promoted and quarantined items are skipped silently', () => {
  const boards = [board('o/r', {
    issues: [issue({ number: 1 }), issue({ number: 2 }), issue({ number: 3 }), issue({ number: 4, labels: [{ name: 'blocked' }] })],
    handled: new Set([2]),
    quarantined: new Set(['o/r:issue-3']),
    promoted: new Set([4]),
  })];
  const out = decide(boards, state({ inFlight: new Set(['IMPLEMENT:o/r:issue-1']) }), cfg);
  assert.equal(out.decisions.length, 0, JSON.stringify(out.decisions));
});

test('file-collision hold: an IMPLEMENT whose Owns overlaps in-flight work waits without consuming a slot', () => {
  const boards = [board('o/r', {
    issues: [
      issue({ number: 1, body: 'Build it.\n\nOwns: package.json, src/a.ts' }),
      issue({ number: 2, body: 'Build it too.\n\nOwns: src/b.ts' }),
    ],
  })];
  const out = decide(boards, state({ inFlightFiles: ['package.json'] }), cfg);
  const d = dispatches(out.decisions);
  assert.deepEqual(d.map((x) => x.action.number), [2]);
  const h = holds(out.decisions).find((x) => x.reason === 'file-collision');
  assert.ok(h);
  assert.equal(h.action?.number, 1);
  assert.match(h.detail ?? '', /package\.json/);
  assert.match(h.detail ?? '', /contended/);
  assert.equal(out.slots.used, 1);

  // Two colliding issues in the same tick: the first goes, the second is held.
  const both = decide([board('o/r', {
    issues: [issue({ number: 1, body: 'Owns: src/x.ts' }), issue({ number: 2, body: 'Owns: src/x.ts' })],
  })], state(), cfg);
  assert.deepEqual(dispatches(both.decisions).map((x) => x.action.number), [1]);
});

test('a FIX becomes a REWRITE once the watchdog says so, and a re-dispatch counts as contention', () => {
  const boards = [board('o/r', {
    issues: [issue({ number: 1 })],
    pulls: [pull({ number: 10, headRefName: 'feat/issue-1', labels: ['changes-requested'] })],
  })];
  const plain = decide(boards, state(), cfg);
  assert.equal(dispatches(plain.decisions)[0].role, 'fix');
  assert.equal(plain.contention, 0);

  const rewrite = decide(boards, state({ rewriteItems: new Set(['o/r:pr-10']), attempts: { 'o/r:pr-10': 5 } }), cfg);
  const d = dispatches(rewrite.decisions)[0];
  assert.equal(d.role, 'rewrite');
  assert.equal(d.action.kind, 'FIX');
  assert.equal(d.redispatch, true);
  assert.equal(rewrite.contention, 1);
});

test('a RESOLVE dispatch is a contention event on its own', () => {
  const out = decide([board('o/r', {
    issues: [issue({ number: 1 })],
    pulls: [pull({ number: 10, headRefName: 'feat/issue-1', mergeable: 'CONFLICTING' })],
  })], state(), cfg);
  assert.equal(dispatches(out.decisions)[0].role, 'resolve');
  assert.equal(out.contention, 1);
});

test('tick-level holds: blackout, drain, capacity pause and a spent bounded run stop everything', () => {
  const boards = [board('o/r', {
    issues: [issue({ number: 1 })],
    pulls: [pull({ number: 10, headRefName: 'feat/issue-2', labels: ['reviewed-ok'] })],
  })];
  for (const [patch, reason] of [
    [{ blackout: true }, 'blackout'],
    [{ drain: true }, 'drain'],
    [{ pausedUntil: 2_000_000, pauseReason: 'GitHub rate limit' }, 'capacity-pause'],
    [{ boundedRemaining: 0 }, 'bounded-run-spent'],
  ] as const) {
    const out = decide(boards, state(patch), cfg);
    assert.equal(out.decisions.length, 1, reason);
    assert.equal(out.decisions[0].kind, 'hold');
    assert.equal((out.decisions[0] as { reason: string }).reason, reason);
  }
  // A pause that has elapsed no longer holds.
  const past = decide(boards, state({ pausedUntil: 500 }), cfg);
  assert.equal(dispatches(past.decisions).length, 1);
  assert.equal(acts(past.decisions).length, 1);
});

test('a contested board is held as a whole while the other board keeps dispatching', () => {
  const out = decide([
    board('o/a', { issues: [issue({ number: 1 })], contested: true }),
    board('o/b', { issues: [issue({ number: 1 })] }),
  ], state(), cfg);
  const h = holds(out.decisions).find((x) => x.reason === 'contested');
  assert.equal(h?.repo, 'o/a');
  const d = dispatches(out.decisions);
  assert.equal(d.length, 1);
  assert.equal(d[0].action.repo, 'o/b');
});

test('fair share across repos: ladder rank dominates, then repos alternate', () => {
  const out = decide([
    board('o/a', { issues: [1, 2, 3].map((n) => issue({ number: n })) }),
    board('o/b', {
      issues: [issue({ number: 7 })],
      pulls: [pull({ number: 20, headRefName: 'feat/issue-8' })],
    }),
  ], state({ throttleLimit: 10 }), { ...cfg, maxConcurrent: 10 });
  const seq = dispatches(out.decisions).map((d) => `${d.action.repo}:${d.action.kind}:${d.action.number}`);
  assert.deepEqual(seq, ['o/b:REVIEW:20', 'o/a:IMPLEMENT:1', 'o/b:IMPLEMENT:7', 'o/a:IMPLEMENT:2', 'o/a:IMPLEMENT:3']);
});

test('the tier comes from the issue difficulty and routes through the provider pool', () => {
  const boards = [board('o/r', {
    issues: [
      issue({ number: 1, labels: [{ name: 'difficulty:simple' }], body: '- [ ] one thing' }),
      issue({ number: 2, labels: [{ name: 'difficulty:hard' }] }),
    ],
    pulls: [pull({ number: 10, headRefName: 'feat/issue-3' })], // no task -> sonnet
  })];
  const out = decide(boards, state({ throttleLimit: 10 }), cfg);
  const byNum = new Map(dispatches(out.decisions).map((d) => [d.action.number, d]));
  assert.equal(byNum.get(1)?.tier, 'haiku');
  assert.equal(byNum.get(1)?.effort, 'low');
  assert.equal(byNum.get(2)?.tier, 'opus');
  assert.equal(byNum.get(2)?.effort, 'medium');
  assert.equal(byNum.get(10)?.tier, 'sonnet');

  // A pool with haiku disabled routes simple work up to sonnet.
  const noHaiku = { ...cfg, pools: { ...DEFAULT_POOLS, anthropic: { ...DEFAULT_POOLS.anthropic, tiers: { ...DEFAULT_POOLS.anthropic.tiers, haiku: { model: 'x', maxWarm: 0 } } } } };
  const routed = decide(boards, state({ throttleLimit: 10 }), noHaiku);
  assert.equal(dispatches(routed.decisions).find((d) => d.action.number === 1)?.tier, 'sonnet');
});

test('a halted provider is skipped in failover and excluded from the slot budget', () => {
  const boards = [board('o/r', { issues: [issue({ number: 1 })] })];
  const out = decide(boards, state({ halted: { anthropic: 'access token could not be refreshed' } }), cfg);
  const d = dispatches(out.decisions);
  assert.equal(d.length, 1);
  assert.equal(d[0].provider, 'openai');
  assert.equal(slotBudget(cfg, state({ halted: { anthropic: 'x' }, throttleLimit: 10 })), 2);
});

test('a bounded run in PR units caps new IMPLEMENT dispatches at the units remaining, counting in-flight implements', () => {
  const boards = [board('o/r', { issues: [1, 2, 3].map((n) => issue({ number: n })), pulls: [pull({ number: 10, headRefName: 'feat/issue-9' })] })];
  const out = decide(boards, state({ boundedRemaining: 2, boundedUnit: 'pr', throttleLimit: 10 }), { ...cfg, maxConcurrent: 10 });
  const d = dispatches(out.decisions);
  assert.deepEqual(d.map((x) => `${x.action.kind}:${x.action.number}`), ['REVIEW:10', 'IMPLEMENT:1', 'IMPLEMENT:2']);
  assert.equal(holds(out.decisions).filter((h) => h.reason === 'bounded-run-spent').length, 1);

  // One implement already in flight leaves room for exactly one more; reviews are never capped.
  const inFlight = decide(boards, state({ boundedRemaining: 2, boundedUnit: 'pr', throttleLimit: 10, inFlight: new Set(['IMPLEMENT:o/r:issue-3']) }), { ...cfg, maxConcurrent: 10 });
  assert.deepEqual(dispatches(inFlight.decisions).map((x) => `${x.action.kind}:${x.action.number}`), ['REVIEW:10', 'IMPLEMENT:1']);

  // Merge units do not cap implements.
  const merges = decide(boards, state({ boundedRemaining: 1, boundedUnit: 'merge', throttleLimit: 10 }), { ...cfg, maxConcurrent: 10 });
  assert.equal(dispatches(merges.decisions).length, 4);
});

test('a provider resting on its burn cap fails over; both resting holds the tick with a rate-capped reason', () => {
  const boards = [board('o/r', { issues: [issue({ number: 1 })] })];
  const resting = { anthropic: { reason: '1.1M tokens in the last 60 min (cap 1M)', resumesAt: 1_000_500 } };
  const over = decide(boards, state({ rateCapped: resting }), cfg);
  const d = dispatches(over.decisions);
  assert.equal(d.length, 1);
  assert.equal(d[0].provider, 'openai', 'the work goes to the other service');

  // Every usable lane resting is ONE tick-level hold naming the soonest to
  // resume — not N per-action "no slots", which would read as a pool problem.
  const both = decide(boards, state({ rateCapped: { ...resting, openai: { reason: 'openai burn', resumesAt: 1_000_900 } } }), cfg);
  assert.equal(dispatches(both.decisions).length, 0);
  assert.equal(both.decisions.length, 1);
  const h = holds(both.decisions)[0];
  assert.equal(h.reason, 'rate-capped');
  assert.equal(h.scope, 'tick');
  assert.match(h.detail ?? '', /1.1M tokens/, 'the lane that comes back first');

  // A resting provider offers no slots: the budget is sized for what can run.
  assert.equal(slotBudget(cfg, state({ throttleLimit: 10, rateCapped: resting })), 2, 'only Codex capacity remains');
  assert.equal(slotBudget(cfg, state({ throttleLimit: 10 })), 4, 'uncapped: the global ceiling binds, not the lanes');
  assert.equal(slotBudget(cfg, state({ throttleLimit: 10, rateCapped: { ...resting, openai: { reason: 'x', resumesAt: null } } })), 0);
});

test('a pinned provider resting alone holds that action, naming the pace rather than the pool', () => {
  const out = decide([board('o/r', { issues: [issue({ number: 1 })] })], state({
    providerChoice: 'anthropic',
    rateCapped: { anthropic: { reason: '1.1M tokens in the last 60 min (cap 1M)', resumesAt: 1_000_500 } },
  }), cfg);
  assert.equal(dispatches(out.decisions).length, 0);
  const h = holds(out.decisions)[0];
  assert.equal(h.reason, 'rate-capped');
  assert.equal(h.scope, 'tick', 'a pinned lane is the only usable lane, so the whole tick rests');
});
