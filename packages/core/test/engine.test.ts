import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Harness, HarnessCapabilities, QuotaMonitor, QuotaSnapshot, QuotaObservation } from '@study-hall/harness/contract';
import { openLedger, type Ledger } from '@study-hall/harness/ledger/index';
import { Engine, isNetworkError, type EnginePorts, type EngineGitHub } from '../src/engine/engine.js';
import { Governance } from '../src/engine/governance.js';
import { Persistence } from '../src/engine/persistence.js';
import { RoleRunError, type RoleRunInput, type RoleRunOutput } from '../src/engine/roleRunner.js';
import { STATUS_SCHEMA } from '../src/engine/status.js';
import { DEFAULT_ENGINE_CONFIG, DEFAULT_POOLS, type EngineConfig } from '../src/config.js';
import { DEFAULT_BLACKOUT } from '../src/blackout.js';
import type { RawIssue, OpenPull } from '../src/github.js';
import { qualifyItemKey } from '../src/keys.js';

// The engine driven over fixture boards with fake ports: no gh, no git, no CLI.

const CAPS: HarnessCapabilities = {
  warmSessions: true, seedableSessions: true, forkSessions: true, cacheUsageSplit: true, usageIsCumulative: false,
  reportsCost: true, toolAllowlist: true, mcpToolAllowlist: true, effortControl: true, sandboxModes: ['none'],
  promptTransport: 'stdin', streamsUsage: true, cancellable: true, transcripts: true, budgetStop: true, contextCompaction: false, chat: 'stream-json',
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

test('starting again after a finished bounded run rearms it instead of parking on the first tick', async () => {
  // The operator ran 14 merges, then pressed Start for another 14. The spent
  // budget was still on disk with done === limit, the boot reused it because
  // the limit and unit matched, and the very first tick held on
  // bounded-run-spent. The board looked broken and nothing ran (#30).
  const r = rig({ config: { boundedRun: { n: 2, unit: 'pr' } }, boards: { 'o/a': { issues: [issue(1), issue(2)], pulls: [] } } });
  writeFileSync(join(r.stateDir, 'testrun.json'), JSON.stringify({ limit: 2, done: 2, unit: 'pr', since: '2026-01-01T00:00:00.000Z' }));
  await r.engine.boot();
  const armed = JSON.parse(readFileSync(join(r.stateDir, 'testrun.json'), 'utf8'));
  assert.equal(armed.done, 0, 'a finished budget is history, not a standing refusal');
  assert.equal(armed.limit, 2);
  await r.engine.tick();
  await settle();
  assert.ok(r.runs.length > 0, 'work is dispatched rather than held on the first tick');
  assert.equal(r.engine.running, true);
  r.ledger.close();
});

test('an UNSPENT budget from the previous run is reset too: every start is a fresh 0/N', async () => {
  // The dashboard's Stop tree-kills the engine, so a run stopped at 3/5 never
  // reached stop() and left 3/5 on disk. Resuming it meant the next start ran
  // only 2 more: the cap did not reset between runs.
  const r = rig({ config: { boundedRun: { n: 5, unit: 'pr' } }, boards: { 'o/a': { issues: [issue(1)], pulls: [] } } });
  writeFileSync(join(r.stateDir, 'testrun.json'), JSON.stringify({ limit: 5, done: 3, unit: 'pr', since: '2026-01-01T00:00:00.000Z' }));
  await r.engine.boot();
  const armed = JSON.parse(readFileSync(join(r.stateDir, 'testrun.json'), 'utf8'));
  assert.equal(armed.done, 0, 'a partial count from the last run does not carry into this one');
  assert.equal(armed.limit, 5);
  assert.notEqual(armed.since, '2026-01-01T00:00:00.000Z', 'the budget was re-armed, not reused');
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

test('a failover student gets its own provider\'s warm slot and name, never the other vendor\'s', async () => {
  // Both providers number their workers from 1, so the Anthropic and OpenAI top
  // tiers both minted "opus-1". Slots were keyed by that bare id: the Codex run
  // was handed the Claude worker's warm slot and ran on the Claude harness.
  const r = rig({ runner: 'fail-capacity' });
  await r.engine.boot();
  await r.engine.tick();
  await settle();
  await r.engine.tick();
  await settle();
  const [claude, codex] = r.runs;
  assert.equal(claude.decision.provider, 'anthropic');
  assert.equal(codex.decision.provider, 'openai');
  assert.notEqual(codex.worker.slot, claude.worker.slot, 'a separate warm slot per provider');
  assert.equal(codex.worker.slot.harness.id, 'codex');
  assert.equal(claude.worker.slot.harness.id, 'claude-code');
  assert.doesNotMatch(codex.worker.id, /haiku|sonnet|opus/, 'an OpenAI student is not named after a Claude tier');
  const students = r.engine.snapshot().students;
  const openai = students.filter((s) => s.provider === 'openai');
  assert.ok(openai.length > 0);
  for (const s of openai) {
    assert.equal(s.harness, 'codex');
    assert.ok(['luna', 'terra', 'sol'].includes(s.tierLabel ?? ''), `openai tierLabel ${s.tierLabel}`);
  }
  for (const s of students.filter((x) => x.provider === 'anthropic')) assert.equal(s.tierLabel, s.tier);
  r.ledger.close();
});

test('a failover student gets its own provider\'s warm slot and name, never the other vendor\'s', async () => {
  // Both providers number their workers from 1, so the Anthropic and OpenAI top
  // tiers both minted "opus-1". Slots were keyed by that bare id: the Codex run
  // was handed the Claude worker's warm slot and ran on the Claude harness.
  const r = rig({ runner: 'fail-capacity' });
  await r.engine.boot();
  await r.engine.tick();
  await settle();
  await r.engine.tick();
  await settle();
  const [claude, codex] = r.runs;
  assert.equal(claude.decision.provider, 'anthropic');
  assert.equal(codex.decision.provider, 'openai');
  assert.notEqual(codex.worker.slot, claude.worker.slot, 'a separate warm slot per provider');
  assert.equal(codex.worker.slot.harness.id, 'codex');
  assert.equal(claude.worker.slot.harness.id, 'claude-code');
  assert.doesNotMatch(codex.worker.id, /haiku|sonnet|opus/, 'an OpenAI student is not named after a Claude tier');
  const students = r.engine.snapshot().students;
  const openai = students.filter((s) => s.provider === 'openai');
  assert.ok(openai.length > 0);
  for (const s of openai) {
    assert.equal(s.harness, 'codex');
    assert.ok(['luna', 'terra', 'sol'].includes(s.tierLabel ?? ''), `openai tierLabel ${s.tierLabel}`);
  }
  for (const s of students.filter((x) => x.provider === 'anthropic')) assert.equal(s.tierLabel, s.tier);
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

test('GitHub unreachable holds dispatch with backoff and never trips the watchdog kill; a real error still does', async () => {
  // Live 2026-09-29 20:08 and 2026-10-01 01:05: "error connecting to
  // api.github.com" for five heartbeats counted as engine errors, the watchdog
  // killed the engine, and it stayed down until a human restarted it.
  const r = rig();
  await r.engine.boot();
  const gh = r.engine['opts'].ports.github;
  const orig = gh.fetchIssues;
  gh.fetchIssues = async () => { throw new Error('error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com'); };
  for (let i = 0; i < 8; i++) await r.engine.tick();
  assert.equal(r.engine.running, true, 'eight unreachable ticks do not stop the engine');
  assert.match(r.engine.snapshot().capacity?.reason ?? '', /GitHub unreachable/);
  assert.equal(r.runs.length, 0, 'nothing dispatched while GitHub is unreachable');
  const events = r.ledger.reader.events({ limit: 100 });
  const net = events.filter((e) => e.event === 'network.github');
  assert.equal(net.length, 8);
  assert.ok(!events.some((e) => e.event === 'engine.kill'));
  const untils = net.map((e) => (e.data as { until: number }).until).sort((a, b) => a - b);
  assert.ok(untils[1] - untils[0] > 0, 'the hold grows with the outage');
  assert.ok(untils[untils.length - 1] - 1_700_000_000_000 <= 15 * 60_000, 'the hold is capped at 15 minutes');

  // A non-network failure on every board is still an engine error and still kills.
  gh.fetchIssues = async () => { throw new Error('gh: unexpected JSON in response'); };
  for (let i = 0; i < 5; i++) await r.engine.tick();
  assert.equal(r.engine.running, false, 'five real errors in a row still trip the kill');
  gh.fetchIssues = orig;
  r.ledger.close();
});

test('isNetworkError recognises transport failures, not GitHub answers', () => {
  for (const m of ['error connecting to api.github.com', 'getaddrinfo ENOTFOUND api.github.com', 'read ECONNRESET', 'HTTP 502: Bad Gateway', 'socket hang up'])
    assert.equal(isNetworkError(m), true, m);
  for (const m of ['HTTP 404: Not Found', 'gh: unexpected JSON', 'HTTP 422: Validation Failed', 'API rate limit exceeded'])
    assert.equal(isNetworkError(m), false, m);
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

test('window pacing: a lane burning its own five-hour window too fast is rested and the work fails over', async () => {
  const NOW = 1_700_000_000_000;
  const r = rig({
    boards: { 'o/a': { issues: [issue(1)], pulls: [] } },
    config: { provider: { default: 'auto', failoverOrder: ['anthropic', 'openai'], perSurface: {}, pace: { anthropic: { enabled: true } } } },
  });
  await r.engine.boot();
  // Half the window used with two hours left, climbing 0.2 in thirty minutes:
  // 1.6x what the remaining time affords.
  for (let i = 0; i <= 5; i++) {
    r.ledger.recordQuota({
      provider: 'anthropic', observedAt: NOW - 30 * 60_000 + i * 6 * 60_000, source: 'stream',
      fiveHour: { utilization: 0.3 + i * 0.04, resetsAt: NOW + 2 * 60 * 60_000 },
    });
  }
  await r.engine.tick();
  await settle();
  assert.deepEqual(r.calls.filter((c) => c.startsWith('run')), ['run implement o/a#1 on openai'], 'Claude is paced, so the work goes to ChatGPT');
  const st = r.engine.snapshot();
  assert.equal(st.providers.anthropic.pace?.capped, true);
  assert.equal(st.providers.anthropic.pace?.limiting?.window, 'fiveHour');
  assert.ok((st.providers.anthropic.pace?.limiting?.ratio ?? 0) > 1.25);
  assert.equal(st.providers.anthropic.rate, null, 'no fixed cap is set: pacing alone rested it');
  assert.equal(st.providers.openai.pace, null, 'pacing is off for the other lane');
  const capped = r.ledger.reader.events({ limit: 50 }).find((e) => e.event === 'provider.rate-capped');
  assert.match(capped?.reason ?? '', /5-hour window 5\d % used and burning/);
  r.ledger.close();
});

test('window pacing: a lane burning slowly enough to last is never rested, and no observations means no verdict', async () => {
  const NOW = 1_700_000_000_000;
  const r = rig({ config: { provider: { default: 'auto', failoverOrder: ['anthropic', 'openai'], perSurface: {}, pace: { anthropic: { enabled: true } } } } });
  await r.engine.boot();
  // No observations at all: the lane must still dispatch — silence is not a block.
  await r.engine.tick();
  await settle();
  assert.deepEqual(r.calls.filter((c) => c.startsWith('run')), ['run implement o/a#1 on anthropic']);
  assert.equal(r.engine.snapshot().providers.anthropic.pace?.capped, false);
  assert.match(r.engine.snapshot().providers.anthropic.pace?.note ?? '', /no usable window observation/);

  // Now a slow burn: 0.05 in thirty minutes with two hours left is affordable.
  for (let i = 0; i <= 5; i++) {
    r.ledger.recordQuota({
      provider: 'anthropic', observedAt: NOW - 30 * 60_000 + i * 6 * 60_000, source: 'stream',
      fiveHour: { utilization: 0.45 + i * 0.01, resetsAt: NOW + 2 * 60 * 60_000 },
    });
  }
  r.boards['o/a'].issues.push(issue(2));
  await r.engine.tick();
  await settle();
  assert.ok(r.calls.filter((c) => c.startsWith('run')).includes('run implement o/a#2 on anthropic'), 'still dispatching on Claude');
  assert.equal(r.engine.snapshot().providers.anthropic.pace?.capped, false);
  r.ledger.close();
});

// ---- parole must terminate -------------------------------------------------
// Observed live 2026-09-24: issue #216 was closed while quarantined, and the
// engine logged "quarantine served — back on the board with a probe dispatch"
// every 20 seconds for roughly 24 hours, spending the ticks that a 15-merge
// bounded run had left.
//
// The cycle: reconcileWatchdog saw the closed item was off the board, deleted it
// from `quarantined` and called forgetItem — which clears the watchdog's own
// lifetime count, so the key was untracked from then on and that cleanup never
// ran again. It never deleted the parole RECORD. paroleDue asked only paroleOf
// who was due, and isDue() is a pure function of when the sentence started, so a
// record with no hold beside it was due on every tick forever. Worse, releasing
// it called probe(), which put the item back in the watchdog's tracking, so the
// two paths handed it to each other at the tick interval.

const QUARANTINE_START = 0;   // a sentence started at the epoch is long served
const served = () => ({ at: QUARANTINE_START, paroles: 0 });
const paroleCalls = (r: Rig, n: number) => r.calls.filter((c) => c === `removeLabel issue ${n} runner-error`);

test('a parole record with no hold beside it is never released — the 24-hour loop', async () => {
  const r = rig();
  await r.engine.boot();
  const mem = r.engine.repos.get('o/a')!.memory;
  // Exactly the state reconcileWatchdog left behind for #216: the record survived,
  // the hold did not, and the issue is not on the board.
  mem.paroleOf.set(qualifyItemKey('o/a', 'issue', 216), served());
  assert.equal(mem.quarantined.has(qualifyItemKey('o/a', 'issue', 216)), false);

  for (let i = 0; i < 3; i++) { await r.engine.tick(); await settle(); }
  assert.deepEqual(paroleCalls(r, 216), [], 'pre-fix this fired once per tick, forever');
  r.ledger.close();
});

test('an item closed while quarantined is dropped, not paroled onto a board it left', async () => {
  const r = rig();
  await r.engine.boot();
  const mem = r.engine.repos.get('o/a')!.memory;
  const key = qualifyItemKey('o/a', 'issue', 216);
  mem.quarantined.add(key);
  mem.paroleOf.set(key, served());

  await r.engine.tick();
  await settle();
  assert.equal(mem.quarantined.has(key), false, 'the hold is dropped');
  assert.equal(mem.paroleOf.has(key), false, 'and so is the record — leaving it is the bug');
  assert.deepEqual(paroleCalls(r, 216), [], 'a closed issue gets no probe dispatch');

  for (let i = 0; i < 2; i++) { await r.engine.tick(); await settle(); }
  assert.deepEqual(paroleCalls(r, 216), []);
  r.ledger.close();
});

const condemned = (n: number) => issue(n, { labels: [{ name: 'runner-error' }] });

test('an item still on the board is paroled exactly once, not once per tick', async () => {
  const r = rig({ boards: { 'o/a': { issues: [issue(1), condemned(7)], pulls: [] } } });
  await r.engine.boot();
  const mem = r.engine.repos.get('o/a')!.memory;
  const key = qualifyItemKey('o/a', 'issue', 7);
  mem.quarantined.add(key);
  mem.paroleOf.set(key, served());

  for (let i = 0; i < 3; i++) { await r.engine.tick(); await settle(); }
  assert.deepEqual(paroleCalls(r, 7), ['removeLabel issue 7 runner-error'], 'released once');
  assert.equal(mem.quarantined.has(key), false, 'the hold ended the release');
  // The record outlives the release on purpose: the next sentence escalates off it.
  assert.deepEqual(mem.paroleOf.get(key), served());
  r.ledger.close();
});

test('a sentence not yet served is left alone', async () => {
  const r = rig({ boards: { 'o/a': { issues: [issue(1), condemned(7)], pulls: [] } } });
  await r.engine.boot();
  const mem = r.engine.repos.get('o/a')!.memory;
  const key = qualifyItemKey('o/a', 'issue', 7);
  mem.quarantined.add(key);
  mem.paroleOf.set(key, { at: 1_700_000_000_000, paroles: 0 });   // starts now

  await r.engine.tick();
  await settle();
  assert.deepEqual(paroleCalls(r, 7), []);
  assert.equal(mem.quarantined.has(key), true, 'still serving');
  r.ledger.close();
});

test("another repo's key is not purged by this repo's board", async () => {
  const r = rig({ boards: { 'o/a': { issues: [issue(1)], pulls: [] }, 'o/b': { issues: [issue(1)], pulls: [] } } });
  await r.engine.boot();
  const mem = r.engine.repos.get('o/a')!.memory;
  const foreign = qualifyItemKey('o/b', 'issue', 42);
  mem.quarantined.add(foreign);
  mem.paroleOf.set(foreign, served());

  await r.engine.tick();
  await settle();
  // Neither paroled nor purged here: o/a's board cannot answer for o/b#42, and
  // releasing it from this pass would clear the label on the wrong repo.
  assert.equal(mem.quarantined.has(foreign), true);
  assert.deepEqual(r.calls.filter((c) => c.endsWith('42 runner-error')), []);
  r.ledger.close();
});

