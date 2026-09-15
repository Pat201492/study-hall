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
  st.providers = { anthropic: { inFlight: 1, cap: 4, quota: { provider: 'anthropic', state: 'available' }, halted: null } };
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
