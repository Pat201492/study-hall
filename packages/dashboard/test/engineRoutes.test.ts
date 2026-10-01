import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Persistence } from '@study-hall/core/engine/persistence';
import { emptyStatus } from '@study-hall/core/engine/status';
import type { RawIssue, OpenPull } from '@study-hall/core/github';

// Boards, Pool and engine controls over HTTP with a fake GitHub port, a seeded
// status.json and a sleeper in place of the real engine child.

const dir = mkdtempSync(join(tmpdir(), 'sh-engine-routes-'));
const stateDir = join(dir, 'state');
mkdirSync(stateDir, { recursive: true });
const cfgFile = join(dir, 'config.json');
writeFileSync(cfgFile, JSON.stringify({ stateDir, repos: ['o/a', 'o/b'], boundedRun: { n: 5, unit: 'pr' } }));
process.env.STUDY_HALL_CONFIG = cfgFile;

const boards: Record<string, { issues: RawIssue[]; pulls: OpenPull[] } | null> = {
  'o/a': {
    issues: [
      { number: 1, title: 'Ready one', body: 'Do it.', labels: [] },
      { number: 2, title: 'Blocked one', body: 'Depends on #1', labels: [] },
      { number: 3, title: 'Parked one', body: 'x', labels: [{ name: 'runner-error' }, { name: 'needs-human' }] },
    ],
    pulls: [{ number: 11, title: 'PR for 5', headRefName: 'study/issue-5', labels: ['reviewed-ok', 'runner-error'], mergeable: 'MERGEABLE', statusCheckRollup: 'SUCCESS', reviewDecision: '', files: [] }],
  },
  'o/b': null, // fetch fails
};
const removed: string[] = [];

const { startServer } = await import('../src/server.js');
const s = await startServer({
  startCodexQuota: false, port: 0,
  github: {
    fetchIssues: async (repo) => { const b = boards[repo]; if (!b) throw new Error('rate limit exceeded'); return b.issues; },
    listOpenPulls: async (repo) => boards[repo]?.pulls ?? [],
    removeLabel: async (repo, n, label, kind) => { removed.push(`${repo} ${kind} ${n} ${label}`); },
  },
  engineCommand: { command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] },
});
after(() => s.close());
const get = async (p: string) => (await fetch(s.url + p)).json();
const post = async (p: string, body?: unknown) => (await fetch(s.url + p, { method: 'POST', body: JSON.stringify(body ?? {}), headers: { 'content-type': 'application/json' } })).json();
const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

test('boards: each repo renders its own section; a failed fetch shows its error without blanking the others', async () => {
  const b = await get('/api/boards') as { repos: Array<{ repo: string; error?: string; ready: { number: number; kind: string }[]; blocked: { number: number; reason: string }[]; parked: { number: number; labels: string[]; attempts: number }[]; deadlocked: { number: number; labels: string[] }[]; fromEngine: boolean }>; engine: { running: boolean } };
  assert.deepEqual(b.repos.map((r) => r.repo), ['o/a', 'o/b']);
  const a = b.repos[0];
  assert.equal(a.error, undefined);
  assert.deepEqual(a.ready.map((r) => `${r.kind}:${r.number}`), ['IMPLEMENT:1']);
  assert.deepEqual(a.blocked, [{ number: 2, title: 'Blocked one', target: 'issue', reason: 'open dependencies' }]);
  assert.deepEqual(a.parked.map((p) => [p.number, p.labels]), [[3, ['runner-error', 'needs-human']], [11, ['runner-error']]]);
  assert.deepEqual(a.deadlocked.map((d) => d.number), [11]);
  assert.equal(a.fromEngine, false, 'no live engine snapshot');
  assert.match(b.repos[1].error ?? '', /rate limit/);
  assert.equal(b.engine.running, false);
});

test('boards: the engine view (in-flight, attempts, contested) merges in when the snapshot is fresh', async () => {
  const p = new Persistence({ stateDir, legacyRoot: join(dir, 'none') });
  const st = emptyStatus(1234);
  st.running = true; st.tick = 7; st.updatedAt = new Date().toISOString();
  st.repos['o/a'] = { repo: 'o/a', contested: true, ready: [], blocked: [], parked: [], deadlocked: [], attempts: { 'o/a:issue-3': 4 },
    inFlight: [{ key: 'IMPLEMENT:o/a:issue-1', number: 1, target: 'issue', role: 'implement', provider: 'anthropic', harness: 'claude-code', model: 'claude-opus-4-8', runId: 'run-x', startedAt: st.updatedAt, studentId: 'opus-1' }] };
  st.students = [{ id: 'opus-1', provider: 'anthropic', harness: 'claude-code', model: 'claude-opus-4-8', tier: 'opus', role: 'implement', state: 'busy', warm: true, baseSessionId: 'seed-1', repo: 'o/a', item: 1, runId: 'run-x', startedAt: st.updatedAt, tokens: 12000, cacheHitPct: 80 }];
  st.providers = { anthropic: { inFlight: 1, cap: 4, quota: { provider: 'anthropic', state: 'available' }, halted: null, rate: null, pace: null } };
  p.writeStatus(st);
  // Not running as a child of THIS dashboard -> the snapshot is not trusted as live.
  let b = await get('/api/boards') as { repos: Array<{ fromEngine: boolean; inFlight: unknown[] }> };
  assert.equal(b.repos[0].fromEngine, false);

  // Start the (fake) engine child; now the fresh snapshot counts as live.
  const r = await post('/api/engine/start') as { ok: boolean };
  assert.equal(r.ok, true);
  await settle();
  b = await get('/api/boards') as typeof b;
  assert.equal(b.repos[0].fromEngine, true);
  assert.equal(b.repos[0].inFlight.length, 1);
  const parked = (b.repos[0] as unknown as { parked: { number: number; attempts: number }[] }).parked;
  assert.equal(parked.find((x) => x.number === 3)?.attempts, 4);
  assert.equal((b.repos[0] as unknown as { contested: boolean }).contested, true);

  const pool = await get('/api/pool') as { engine: { running: boolean; live: boolean }; students: { id: string; warm: boolean; baseSessionId: string }[]; providers: Record<string, { inFlight: number; cap: number }>; ladder: { total: number } };
  assert.equal(pool.engine.live, true);
  assert.equal(pool.students[0].warm, true);
  assert.equal(pool.students[0].baseSessionId, 'seed-1');
  assert.equal(pool.providers.anthropic.inFlight, 1);
  assert.equal(pool.providers.anthropic.cap, 4);
});

test('start rearms a spent bounded run to 0/N at once, and status shows it before the engine boots', async () => {
  // The relaunch that looked broken: 10/10 on disk, Start pressed, and the old
  // 10/10 stayed on screen for the ~10s the engine spends cloning before its own
  // rearm, so the operator stopped it again. Runs while the engine is stopped.
  const stop = await post('/api/engine/stop');
  await settle(400);
  void stop;
  writeFileSync(join(stateDir, 'testrun.json'), JSON.stringify({ limit: 5, done: 5, unit: 'pr', since: '2026-01-01T00:00:00.000Z' }));
  const before = await get('/api/status') as { engine: { boundedRun: { done: number; limit: number } | null } };
  assert.equal(before.engine.boundedRun?.done, 5, 'status reads the live budget file, not the snapshot');
  const r = await post('/api/engine/start') as { ok: boolean };
  assert.equal(r.ok, true);
  const armed = JSON.parse(readFileSync(join(stateDir, 'testrun.json'), 'utf8'));
  assert.equal(armed.done, 0);
  assert.equal(armed.limit, 5);
  const st = await get('/api/status') as { engine: { boundedRun: { done: number; limit: number } | null } };
  assert.deepEqual([st.engine.boundedRun?.done, st.engine.boundedRun?.limit], [0, 5]);
});

test('engine controls: start refuses a second child, stop tree-kills it, drain writes the flag', async () => {
  const again = await post('/api/engine/start') as { ok: boolean; msg: string };
  assert.equal(again.ok, false);
  assert.match(again.msg, /already running/);
  const drain = await post('/api/engine/drain') as { ok: boolean };
  assert.equal(drain.ok, true);
  assert.equal((await get('/api/engine') as { drainRequested: boolean }).drainRequested, true);
  const stop = await post('/api/engine/stop') as { ok: boolean };
  assert.equal(stop.ok, true);
  await settle(400);
  const v = await get('/api/engine') as { running: boolean; drainRequested: boolean; logTail: string[] };
  assert.equal(v.running, false);
  assert.equal(v.drainRequested, false, 'stop clears a pending drain');
  assert.ok(v.logTail.some((l) => /exited/.test(l)));
  assert.equal((await post('/api/engine/stop') as { ok: boolean }).ok, false);
  const st = await get('/api/status') as { engine: { running: boolean } };
  assert.equal(st.engine.running, false);
});

test('unpark removes exactly the named parking label and refuses anything else', async () => {
  const ok = await post('/api/board/unpark', { repo: 'o/a', number: 3, target: 'issue', label: 'needs-human' }) as { ok: boolean };
  assert.equal(ok.ok, true);
  assert.deepEqual(removed, ['o/a issue 3 needs-human']);
  const bad = await fetch(s.url + '/api/board/unpark', { method: 'POST', body: JSON.stringify({ repo: 'o/a', number: 3, target: 'issue', label: 'reviewed-ok' }), headers: { 'content-type': 'application/json' } });
  assert.equal(bad.status, 500);
  assert.equal(removed.length, 1);
});

test('ladder tallies come from the ledger and survive a restart', async () => {
  const { openLedger } = await import('@study-hall/harness');
  const ledger = openLedger(join(stateDir, 'ledger'));
  for (const kind of ['spawn', 'exact', 'exact', 'rerole', 'wait'] as const) {
    ledger.recordAssignment({ ts: new Date().toISOString(), repo: 'o/a', kind, tier: 'opus', role: 'implement', provider: 'anthropic', workerId: 'w', item: 1 });
  }
  const pool = await get('/api/pool') as { ladder: { exact: number; rerole: number; spawn: number; wait: number; warmReuseRate: number }; ladderSession: unknown };
  assert.equal(pool.ladder.exact, 2);
  assert.equal(pool.ladder.rerole, 1);
  assert.equal(pool.ladder.spawn, 1);
  assert.equal(pool.ladder.wait, 1);
  assert.equal(pool.ladder.warmReuseRate, 0.75);
  assert.equal(pool.ladderSession, null, 'engine stopped: no process-memory tallies');
});

test('bounded-run setting writes config and refuses an implicit unbounded run', async () => {
  const r = await post('/api/settings/bounded-run', { n: 3, unit: 'merge' }) as { ok: boolean; boundedRun: { n: number; unit: string } };
  assert.equal(r.ok, true);
  assert.deepEqual(r.boundedRun, { n: 3, unit: 'merge' });
  assert.deepEqual(JSON.parse(readFileSync(cfgFile, 'utf8')).boundedRun, { n: 3, unit: 'merge' });
  const bad = await fetch(s.url + '/api/settings/bounded-run', { method: 'POST', body: JSON.stringify({ n: 0 }), headers: { 'content-type': 'application/json' } });
  assert.equal(bad.status, 500);
  const ub = await post('/api/settings/bounded-run', { n: 0, unbounded: true }) as { boundedRun: { n: number; unbounded?: boolean } };
  assert.equal(ub.boundedRun.unbounded, true);
});

test('the burn view reads the ledger (truthful with the engine stopped) and the cap is set and cleared from the UI', async () => {
  const { openLedger } = await import('@study-hall/harness');
  const ledger = openLedger(join(stateDir, 'ledger'));
  const now = Date.now();
  ledger.recordRun({
    schemaVersion: 2, runId: 'burn-1', ts: new Date(now - 5 * 60_000).toISOString(), startedAt: new Date(now - 10 * 60_000).toISOString(),
    endedAt: new Date(now - 5 * 60_000).toISOString(), durationMs: 300_000, repo: 'o/a', item: 1, role: 'implement', provider: 'anthropic',
    harness: 'claude-code', meter: 'subscription', fidelity: 'exact', inputTokens: 100_000, outputTokens: 10_000, cacheReadInputTokens: 400_000,
    cacheCreationInputTokens: 0, reasoningTokens: 0, turns: 3, warmMechanism: 'cold', stoppedBy: null, estimatedCostUsd: 2, costBasis: 'list', pricingTableVersion: 'x',
  });
  ledger.close();

  let b = await get('/api/burn') as { providers: Record<string, { rate: { tokens: { spent: number; cap: number | null }; capped: boolean }; source: string; limit: unknown; suggestedTokensPerHour: number | null; runsInWindow: number }>; windowMinutes: number };
  assert.equal(b.windowMinutes, 60);
  assert.equal(b.providers.anthropic.rate.tokens.spent, 510_000);
  assert.equal(b.providers.anthropic.rate.tokens.cap, null, 'uncapped until the operator says otherwise');
  assert.equal(b.providers.anthropic.rate.capped, false);
  assert.equal(b.providers.anthropic.source, 'ledger', 'the engine is not running, and the view says so');
  assert.equal(b.providers.anthropic.runsInWindow, 1);
  assert.equal(b.providers.anthropic.suggestedTokensPerHour, 510_000, 'suggested from the busiest recent hour');

  // Set a cap below what was just spent: the lane reads as resting at once.
  const set = await post('/api/settings/rate-limit', { provider: 'anthropic', tokensPerHour: 400_000 }) as { ok: boolean; limit: { tokensPerHour: number }; note: string };
  assert.equal(set.ok, true);
  assert.equal(set.limit.tokensPerHour, 400_000);
  assert.match(set.note, /next tick/);
  assert.equal(JSON.parse(readFileSync(cfgFile, 'utf8')).provider.rateLimit.anthropic.tokensPerHour, 400_000);
  b = await get('/api/burn') as typeof b;
  assert.equal(b.providers.anthropic.rate.capped, true);
  assert.equal(b.providers.openai?.rate.capped, false, 'the other lane is untouched');

  // Zero clears it: an uncapped provider is the ABSENCE of a limit, not a limit of zero.
  const cleared = await post('/api/settings/rate-limit', { provider: 'anthropic', tokensPerHour: 0 }) as { ok: boolean; limit: null };
  assert.equal(cleared.limit, null);
  assert.equal(JSON.parse(readFileSync(cfgFile, 'utf8')).provider.rateLimit.anthropic, undefined);
  assert.equal((await get('/api/burn') as typeof b).providers.anthropic.rate.capped, false);

  const bad = await fetch(s.url + '/api/settings/rate-limit', { method: 'POST', body: JSON.stringify({ provider: 'anthropic', tokensPerHour: -5 }), headers: { 'content-type': 'application/json' } });
  assert.equal(bad.status, 500);
  const noProvider = await fetch(s.url + '/api/settings/rate-limit', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
  assert.equal(noProvider.status, 500);
});

test('window pacing is set from the UI, and the burn view shows the projected exhaustion whether or not the engine runs', async () => {
  const { openLedger } = await import('@study-hall/harness');
  const ledger = openLedger(join(stateDir, 'ledger'));
  const now = Date.now();
  // Half the five-hour window used, two hours left, climbing 0.2 in thirty minutes.
  for (let i = 0; i <= 5; i++) {
    ledger.recordQuota({ provider: 'anthropic', observedAt: now - 30 * 60_000 + i * 6 * 60_000, source: 'stream', fiveHour: { utilization: 0.3 + i * 0.04, resetsAt: now + 2 * 60 * 60_000 } });
  }
  ledger.close();

  // Off by default: no verdict at all, and the lane is not rested.
  let b = await get('/api/burn') as { providers: Record<string, { pace: { capped: boolean; limiting: { window: string; projectedExhaustionAt: number; utilization: number } | null; note: string | null } | null; paceEnabled: boolean }> };
  assert.equal(b.providers.anthropic.pace, null);
  assert.equal(b.providers.anthropic.paceEnabled, false);

  const on = await post('/api/settings/pace', { provider: 'anthropic', enabled: true }) as { ok: boolean; enabled: boolean; note: string };
  assert.equal(on.ok, true);
  assert.match(on.note, /next tick/);
  assert.equal(JSON.parse(readFileSync(cfgFile, 'utf8')).provider.pace.anthropic.enabled, true);

  b = await get('/api/burn') as typeof b;
  const p = b.providers.anthropic.pace!;
  assert.equal(b.providers.anthropic.paceEnabled, true);
  assert.equal(p.capped, true, 'burning 1.6x what the remaining window affords');
  assert.equal(p.limiting?.window, 'fiveHour');
  assert.ok(Math.abs(p.limiting!.utilization - 0.5) < 0.001);
  assert.ok(p.limiting!.projectedExhaustionAt < now + 2 * 60 * 60_000, 'it runs out before the window resets');
  assert.equal(b.providers.openai.pace, null, 'the other lane is untouched');

  // A tolerance below 1 is refused; turning it off removes the entry entirely.
  const bad = await fetch(s.url + '/api/settings/pace', { method: 'POST', body: JSON.stringify({ provider: 'anthropic', enabled: true, tolerance: 0.5 }), headers: { 'content-type': 'application/json' } });
  assert.equal(bad.status, 500);
  const off = await post('/api/settings/pace', { provider: 'anthropic', enabled: false }) as { enabled: boolean };
  assert.equal(off.enabled, false);
  assert.equal(JSON.parse(readFileSync(cfgFile, 'utf8')).provider.pace.anthropic, undefined);
  assert.equal((await get('/api/burn') as typeof b).providers.anthropic.pace, null);
});
