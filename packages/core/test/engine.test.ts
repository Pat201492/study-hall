import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Harness, HarnessCapabilities, QuotaMonitor, QuotaSnapshot, QuotaObservation } from '@study-hall/harness/contract';
import { openLedger, type Ledger } from '@study-hall/harness/ledger/index';
import { Engine, type EnginePorts, type EngineGitHub } from '../src/engine/engine.js';
import { Governance } from '../src/engine/governance.js';
import { Persistence } from '../src/engine/persistence.js';
import { RoleRunError, type RoleRunInput, type RoleRunOutput } from '../src/engine/roleRunner.js';
import { STATUS_SCHEMA } from '../src/engine/status.js';
import { DEFAULT_ENGINE_CONFIG, DEFAULT_POOLS, type EngineConfig } from '../src/config.js';
import { DEFAULT_BLACKOUT } from '../src/blackout.js';
import type { RawIssue, OpenPull } from '../src/github.js';

// The engine driven over fixture boards with fake ports: no gh, no git, no CLI.

const CAPS: HarnessCapabilities = {
  warmSessions: true, seedableSessions: true, forkSessions: true, cacheUsageSplit: true, usageIsCumulative: false,
  reportsCost: true, toolAllowlist: true, mcpToolAllowlist: true, effortControl: true, sandboxModes: ['none'],
  promptTransport: 'stdin', streamsUsage: true, cancellable: true, transcripts: true, budgetStop: true, chat: 'stream-json',
};

function fakeHarness(id: string, provider: string, preflightOk = true): Harness {
  return {
    id, provider, capabilities: CAPS,
    run: async () => { throw new Error('not used'); }, killAll: () => {},
    classifyFailure: (m) => (/session limit/i.test(m) ? { kind: 'capacity', resetAt: 2_000_000_000_000 } : /refreshed/.test(m) ? { kind: 'auth', detail: m } : { kind: 'task' }),
    preflight: async () => (preflightOk ? { ok: true, bin: id, version: '9.9', authOk: true } : { ok: false, authOk: false, detail: 'access token could not be refreshed' }),
  };
}

class FakeQuota implements QuotaMonitor {
  state: QuotaSnapshot['state'] = 'available';
  exhaustedUntil?: number;
  observations: QuotaObservation[] = [];
  constructor(readonly provider: string) {}
  snapshot(): QuotaSnapshot { return { provider: this.provider, state: this.state, exhaustedUntil: this.exhaustedUntil }; }
  observe(o: QuotaObservation): void { this.observations.push(o); if (o.allowed) this.state = 'available'; }
  markExhausted(resetAt?: number): void { this.state = 'exhausted'; this.exhaustedUntil = resetAt; }
  subscribe(): () => void { return () => {}; }
}

function issue(n: number, o: Partial<RawIssue> = {}): RawIssue { return { number: n, title: `Issue ${n}`, body: 'Do it.', labels: [], ...o }; }
function pull(n: number, o: Partial<OpenPull> = {}): OpenPull {
  return { number: n, title: `PR ${n}`, headRefName: `study/issue-${n - 10}`, labels: [], mergeable: 'MERGEABLE', statusCheckRollup: 'SUCCESS', reviewDecision: '', files: [], ...o };
}

interface Board { issues: RawIssue[]; pulls: OpenPull[] }

interface Rig {
  engine: Engine; ledger: Ledger; boards: Record<string, Board>; calls: string[]; quotas: Record<string, FakeQuota>;
  runs: RoleRunInput[]; stateDir: string; config: EngineConfig; resolveRun: (out: RoleRunOutput | Error) => void;
}

function rig(over: { config?: Partial<EngineConfig>; boards?: Record<string, Board>; preflightOk?: Record<string, boolean>; runner?: 'auto' | 'manual' | 'fail-capacity' } = {}): Rig {
  const root = mkdtempSync(join(tmpdir(), 'sh-engine-'));
  const stateDir = join(root, 'state');
  const boards: Record<string, Board> = over.boards ?? { 'o/a': { issues: [issue(1)], pulls: [] } };
  const calls: string[] = [];
  const config: EngineConfig = {
    ...DEFAULT_ENGINE_CONFIG, stateDir, repos: Object.keys(boards).map((repo) => ({ repo })), pools: DEFAULT_POOLS,
    blackout: { ...DEFAULT_BLACKOUT, enabled: false }, reportRepo: 'o/reports', boundedRun: { n: 5, unit: 'pr' },
    provider: { default: 'auto', failoverOrder: ['anthropic', 'openai'], perSurface: {} },
    ...over.config,
  };
  const quotas = { anthropic: new FakeQuota('anthropic'), openai: new FakeQuota('openai') };
  const harnesses: Record<string, Harness> = {
    'claude-code': fakeHarness('claude-code', 'anthropic', over.preflightOk?.anthropic ?? true),
    codex: fakeHarness('codex', 'openai', over.preflightOk?.openai ?? true),
  };
  const github: EngineGitHub = {
    fetchIssues: async (repo) => { const b = boards[repo.replace('https://github.com/', '')]; if (!b) throw new Error('rate limit'); return structuredClone(b.issues); },
    listOpenPulls: async (repo) => structuredClone(boards[repo.replace('https://github.com/', '')]?.pulls ?? []),
    mergePr: async (repo, branch) => { calls.push(`mergePr ${branch}`); },
    addLabel: async (_r, n, label, kind) => { calls.push(`addLabel ${kind} ${n} ${label}`); },
    removeLabel: async (_r, n, label, kind) => { calls.push(`removeLabel ${kind} ${n} ${label}`); },
    commentIssue: async (_r, n) => { calls.push(`commentIssue ${n}`); },
    rejectedReviewCount: async () => 0,
    ensureLabels: async () => [],
    githubRateLimitReset: async () => null,
  };
  const ledger = openLedger(join(stateDir, 'ledger'));
  const runs: RoleRunInput[] = [];
  let pending: ((out: RoleRunOutput | Error) => void) | null = null;
  const runner = over.runner ?? 'auto';
  const ports: EnginePorts = {
    github, ledger,
    git: { ensureClone: async (url, dir, base) => ({ url, dir, worktreesRoot: join(dir, '..', 'worktrees'), base }), reapOrphanWorktrees: async () => [] },
    reports: { openIssueOnce: async (_r, title) => { calls.push(`report ${title}`); return { url: 'u', created: true }; }, openWatchdogReports: async () => [], closeIssue: async () => {} },
    harnesses: { get: (id) => { const h = harnesses[id]; if (!h) throw new Error(`unknown harness ${id}`); return h; }, quotaFor: (id) => quotas[id as keyof typeof quotas], killAll: () => { calls.push('killAll'); } },
    readSpec: () => '',
    now: () => 1_700_000_000_000,
    runRole: async (input) => {
      runs.push(input);
      calls.push(`run ${input.decision.role} ${input.decision.action.repo}#${input.decision.action.number} on ${input.decision.provider}`);
      const a = input.decision.action;
      const base = { runId: input.runId, repo: input.repo.slug, item: a.number, role: input.decision.role, provider: input.decision.provider, harness: input.decision.harness, model: input.decision.model, meter: 'subscription' as const };
      const row = (extra: Record<string, unknown> = {}) => ({
        schemaVersion: 2 as const, ts: 't', startedAt: 't', endedAt: 't', durationMs: 1, fidelity: 'exact' as const,
        inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 400, cacheCreationInputTokens: 0, reasoningTokens: 0, turns: 2,
        warmMechanism: 'seed' as const, stoppedBy: null, estimatedCostUsd: 0.01, costBasis: 'list' as const, pricingTableVersion: 'x', ...base, ...extra,
      });
      if (runner === 'fail-capacity') throw new RoleRunError("You've hit your session limit", { kind: 'capacity', resetAt: 2_000_000_000_000 }, row({ errorClass: 'capacity', fidelity: 'missing' }), 'run');
      const outcome = (): RoleRunOutput => {
        if (input.decision.role === 'implement') {
          // The PR appears on the board for the next fetch.
          const prNumber = a.number + 10;
          boards[input.repo.slug].pulls.push(pull(prNumber, { headRefName: `study/issue-${a.number}` }));
          return { run: row(), outcome: { outcomeId: `o-${input.runId}`, runId: input.runId, repo: input.repo.slug, item: a.number, ts: 't', outcome: 'pr-opened', prNumber }, effect: { kind: 'pr-opened', number: prNumber, url: `https://github.com/${input.repo.slug}/pull/${prNumber}`, branch: `study/issue-${a.number}` } };
        }
        if (input.decision.role === 'review') {
          const pr = boards[input.repo.slug].pulls.find((p) => p.number === a.number);
          if (pr) pr.labels = [...pr.labels, 'reviewed-ok'];
          return { run: row(), outcome: { outcomeId: `o-${input.runId}`, runId: input.runId, repo: input.repo.slug, item: a.number, ts: 't', outcome: 'review-approve', prNumber: a.number }, effect: { kind: 'review', verdict: 'APPROVE', label: 'reviewed-ok' } };
        }
        return { run: row(), outcome: null, effect: { kind: 'skipped', reason: 'fake' } };
      };
      if (runner === 'manual') {
        return new Promise<RoleRunOutput>((resolve, reject) => { pending = (out) => (out instanceof Error ? reject(out) : resolve(out)); });
      }
      return outcome();
    },
  };
  const governance = new Governance({ blackout: config.blackout, maxParallel: config.maxConcurrent, crashBurst: config.crashBurst });
  const engine = new Engine({ config: () => config, persistence: new Persistence({ stateDir, legacyRoot: join(root, 'nolegacy') }), governance, ports, harnessFor: { anthropic: 'claude-code', openai: 'codex' } });
  return { engine, ledger, boards, calls, quotas, runs, stateDir, config, resolveRun: (out) => { pending?.(out); pending = null; } };
}

const settle = () => new Promise((r) => setTimeout(r, 5));

test('two ticks over fixture boards: tick 1 dispatches an implement, tick 2 observes its PR and dispatches a review, tick 3 merges', async () => {
  const r = rig();
  await r.engine.boot();
  assert.equal(r.engine.running, true);
  assert.equal(await r.engine.tick(), 'ran');
  await settle();
  assert.deepEqual(r.calls.filter((c) => c.startsWith('run')), ['run implement o/a#1 on anthropic']);
  assert.deepEqual([...r.engine.repos.get('o/a')!.memory.handled], [1]);

  await r.engine.tick();
  await settle();
  assert.deepEqual(r.calls.filter((c) => c.startsWith('run')), ['run implement o/a#1 on anthropic', 'run review o/a#11 on anthropic']);
  // The reviewer forked off the implementer's warm base (same worker, same tier/role ladder counted).
  assert.equal(r.runs[1].worker.id, r.runs[0].worker.id);
  assert.equal(r.runs[1].worker.slot, r.runs[0].worker.slot, 'same warm slot handed to the second run');

  await r.engine.tick();
  await settle();
  assert.ok(r.calls.includes('mergePr study/issue-1'));
  const runsInLedger = r.ledger.reader.listRuns({ limit: 10 });
  assert.equal(runsInLedger.rows.length, 2);
  assert.equal(r.ledger.reader.outcomesFor('o/a', 1).some((o) => o.outcome === 'merged'), true);
  assert.equal(r.engine.assignments.tallies().spawn, 1);
  assert.equal(r.engine.assignments.tallies().rerole, 1);
  r.ledger.close();
});

test('an overlapping tick is skipped and logged, never queued', async () => {
  const r = rig({ runner: 'manual' });
  await r.engine.boot();
  // Make the fetch slow so a second tick arrives while the first is inside its body.
  let release: () => void = () => {};
  const gate = new Promise<void>((res) => { release = res; });
  const orig = r.engine['opts'].ports.github.fetchIssues;
  r.engine['opts'].ports.github.fetchIssues = async (repo) => { await gate; return orig(repo); };
  const first = r.engine.tick();
  const second = await r.engine.tick();
  assert.equal(second, 'skipped-overlap');
  release();
  assert.equal(await first, 'ran');
  const events = r.ledger.reader.events({ limit: 50 }).map((e) => e.event);
  assert.ok(events.includes('tick.overlap'));
  r.resolveRun(new Error('done'));
  await settle();
  r.ledger.close();
});

test('the default config parks the engine after boundedRun.n PRs; unbounded needs the explicit flag', async () => {
  const r = rig({ config: { boundedRun: { n: 1, unit: 'pr' } }, boards: { 'o/a': { issues: [issue(1), issue(2)], pulls: [] } } });
  await r.engine.boot();
  await r.engine.tick();
  await settle();
  // One PR opened -> budget spent; the second issue never dispatches, and with nothing in flight the engine parks.
  assert.equal(r.runs.length, 1);
  await r.engine.tick();
  await settle();
  assert.equal(r.runs.length, 1);
  assert.equal(r.engine.running, false);
  assert.equal(r.engine.stoppedReason, 'bounded run complete');
  const status = JSON.parse(readFileSync(join(r.stateDir, 'status.json'), 'utf8'));
  assert.equal(status.boundedRun.done, 1);
  r.ledger.close();

  const u = rig({ config: { boundedRun: { n: 0, unit: 'pr' } } });
  await assert.rejects(u.engine.boot(), /unbounded: true/);
  u.ledger.close();
  const ok = rig({ config: { boundedRun: { n: 0, unit: 'pr', unbounded: true } } });
  await ok.engine.boot();
  assert.equal(ok.engine.running, true);
  ok.ledger.close();
});

test('a soft stop lets in-flight students finish, banks their work, then stops', async () => {
  const r = rig({ runner: 'manual' });
  await r.engine.boot();
  await r.engine.tick();
  assert.equal(r.engine.busy, 1);
  const drained = r.engine.drain();
  assert.equal(r.engine.draining, true);
  // While draining nothing new starts, even with work available.
  r.boards['o/a'].issues.push(issue(2));
  await r.engine.tick();
  assert.equal(r.engine.busy, 1);
  r.resolveRun({ run: null, outcome: null, effect: { kind: 'pr-opened', number: 11, url: 'u', branch: 'b' } });
  await drained;
  assert.equal(r.engine.busy, 0);
  assert.equal(r.engine.running, false);
  assert.equal(r.engine.stoppedReason, 'drained');
  assert.deepEqual([...r.engine.repos.get('o/a')!.memory.handled], [1], 'the partial work was banked');
  r.ledger.close();
});

test('status.json matches the documented shape', async () => {
  const r = rig({ runner: 'manual' });
  await r.engine.boot();
  await r.engine.tick();
  const p = join(r.stateDir, 'status.json');
  assert.ok(existsSync(p));
  const s = JSON.parse(readFileSync(p, 'utf8'));
  assert.equal(s.schema, STATUS_SCHEMA);
  assert.deepEqual(Object.keys(s.repos), ['o/a']);
  assert.equal(s.repos['o/a'].inFlight.length, 1);
  assert.equal(s.repos['o/a'].inFlight[0].role, 'implement');
  assert.equal(s.repos['o/a'].inFlight[0].provider, 'anthropic');
  assert.equal(s.students.length, 1);
  assert.equal(s.students[0].state, 'busy');
  assert.equal(s.students[0].provider, 'anthropic');
  assert.equal(s.providers.anthropic.inFlight, 1);
  assert.equal(s.providers.anthropic.cap, DEFAULT_POOLS.anthropic.maxConcurrent);
  assert.equal(s.providers.anthropic.quota.state, 'available');
  assert.equal(s.providers.openai.halted, null);
  assert.deepEqual(s.parallelism, { effective: 2, configured: 2 }, 'token mode halves the configured 4');
  assert.equal(s.boundedRun.limit, 5);
  assert.equal(typeof s.ladder.warmReuseRate, 'number');
  assert.equal(s.lastTick.dispatched, 1);
  r.resolveRun(new Error('x'));
  await settle();
  r.ledger.close();
});

test('failure routing: a capacity failure pauses the anthropic lane and the next tick fails over to Codex, charging no attempt', async () => {
  const r = rig({ runner: 'fail-capacity' });
  await r.engine.boot();
  await r.engine.tick();
  await settle();
  assert.equal(r.quotas.anthropic.state, 'exhausted');
  assert.equal(r.quotas.anthropic.exhaustedUntil, 2_000_000_000_000 + 60_000);
  assert.equal(r.engine['opts'].governance.watchdog.attemptsFor('o/a:issue-1'), 0, 'attempt forgiven');
  const outcomes = r.ledger.reader.outcomesFor('o/a', 1);
  assert.ok(outcomes.some((o) => o.outcome === 'capacity-blocked'));
  await r.engine.tick();
  await settle();
  assert.deepEqual(r.calls.filter((c) => c.startsWith('run')), ['run implement o/a#1 on anthropic', 'run implement o/a#1 on openai']);
  r.ledger.close();
});

test('an auth failure at preflight halts that lane; the other provider keeps dispatching', async () => {
  const r = rig({ preflightOk: { anthropic: false } });
  await r.engine.boot();
  const s = r.engine.snapshot();
  assert.match(s.providers.anthropic.halted ?? '', /refreshed/);
  await r.engine.tick();
  await settle();
  assert.deepEqual(r.calls.filter((c) => c.startsWith('run')), ['run implement o/a#1 on openai']);
  r.ledger.close();
});

test('a board whose fetch fails keeps the other board dispatching; every board failing on rate limits pauses dispatch', async () => {
  const r = rig({ boards: { 'o/a': { issues: [issue(1)], pulls: [] }, 'o/b': { issues: [issue(1)], pulls: [] } } });
  await r.engine.boot();
  delete r.boards['o/b'];
  await r.engine.tick();
  await settle();
  assert.deepEqual(r.calls.filter((c) => c.startsWith('run')), ['run implement o/a#1 on anthropic']);
  assert.match(r.engine.snapshot().repos['o/b'].error ?? '', /rate limit/);

  delete r.boards['o/a'];
  await r.engine.tick();
  assert.match(r.engine.snapshot().capacity?.reason ?? '', /GitHub rate limit/);
  r.ledger.close();
});

test('stop aborts in-flight students and kills every harness', async () => {
  const r = rig({ runner: 'manual' });
  await r.engine.boot();
  await r.engine.tick();
  const signal = r.runs[0].signal!;
  assert.equal(signal.aborted, false);
  r.engine.stop('test');
  assert.equal(signal.aborted, true);
  assert.ok(r.calls.includes('killAll'));
  assert.equal(await r.engine.tick(), 'skipped-stopped');
  r.resolveRun(new Error('aborted'));
  await settle();
  r.ledger.close();
});

test('burn-rate governor: crossing the hourly cap rests the lane, the next tick fails over, and both are recorded', async () => {
  const r = rig({
    boards: { 'o/a': { issues: [issue(1), issue(2)], pulls: [] } },
    // Each fake run bills 100 + 10 + 400 = 510 tokens, so two runs cross 1000.
    config: { provider: { default: 'auto', failoverOrder: ['anthropic', 'openai'], perSurface: {}, rateLimit: { anthropic: { tokensPerHour: 1000, headroom: 1 } } } },
  });
  await r.engine.boot();
  await r.engine.tick();
  await settle();
  assert.deepEqual(r.calls.filter((c) => c.startsWith('run')), ['run implement o/a#1 on anthropic', 'run implement o/a#2 on anthropic']);
  const capped = r.engine.snapshot().providers.anthropic.rate;
  assert.equal(capped?.capped, true);
  assert.equal(capped?.tokens.spent, 1020);
  assert.equal(capped?.tokens.cap, 1000);
  assert.equal(r.engine.snapshot().providers.openai.rate, null, 'an uncapped lane has no governor');

  // Tick 2: the PRs are on the board and want reviewing — on the other service.
  await r.engine.tick();
  await settle();
  assert.deepEqual(r.calls.filter((c) => c.startsWith('run')).slice(2), ['run review o/a#11 on openai', 'run review o/a#12 on openai']);

  const events = r.ledger.reader.events({ limit: 50 }).map((e) => e.event);
  assert.ok(events.includes('provider.rate-capped'), 'the rest is a ledger event, not just a log line');

  // Raising the cap lifts the rest immediately — no waiting on a vendor reset.
  r.config.provider.rateLimit = { anthropic: { tokensPerHour: 10_000, headroom: 1 } };
  r.boards['o/a'].issues.push(issue(3));
  await r.engine.tick();
  await settle();
  assert.ok(r.calls.filter((c) => c.startsWith('run')).some((c) => c === 'run implement o/a#3 on anthropic'));
  assert.ok(r.ledger.reader.events({ limit: 50 }).map((e) => e.event).includes('provider.rate-resumed'));
  r.ledger.close();
});

test('burn-rate governor: with every lane capped the tick holds and nothing is dispatched', async () => {
  const r = rig({
    config: { provider: { default: 'auto', failoverOrder: ['anthropic', 'openai'], perSurface: {}, rateLimit: { anthropic: { tokensPerHour: 1, headroom: 1 }, openai: { tokensPerHour: 1, headroom: 1 } } } },
  });
  await r.engine.boot();
  // Seed both windows over their caps through the ledger, as a restart would.
  for (const provider of ['anthropic', 'openai']) {
    r.ledger.recordRun({
      schemaVersion: 2, runId: `seed-${provider}`, ts: new Date(1_700_000_000_000 - 60_000).toISOString(), startedAt: new Date(1_700_000_000_000 - 120_000).toISOString(),
      endedAt: new Date(1_700_000_000_000 - 60_000).toISOString(), durationMs: 60_000, repo: 'o/a', item: 9, role: 'implement', provider, harness: 'h',
      meter: 'subscription', fidelity: 'exact', inputTokens: 5000, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, reasoningTokens: 0,
      turns: 1, warmMechanism: 'cold', stoppedBy: null, estimatedCostUsd: 0, costBasis: 'list', pricingTableVersion: 'x',
    });
  }
  // Booting again re-seeds both windows from the ledger — the hour just spent
  // survives a restart, which is the whole point of seeding.
  await r.engine.boot();
  await r.engine.tick();
  await settle();
  assert.deepEqual(r.calls.filter((c) => c.startsWith('run')), [], 'nothing dispatched while every lane rests');
  const st = r.engine.snapshot();
  assert.equal(st.providers.anthropic.rate?.capped, true);
  assert.equal(st.providers.openai.rate?.capped, true);
  assert.equal(st.lastTick?.dispatched, 0);
  r.ledger.close();
});
