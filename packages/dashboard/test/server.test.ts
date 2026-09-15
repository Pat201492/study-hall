import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Boots the real server in-process against a temp state dir and a temp config,
// imports the 7 real v1 usage rows, and drives every route over HTTP.

const dir = mkdtempSync(join(tmpdir(), 'sh-server-'));
const cfgFile = join(dir, 'config.json');
const v1 = join(dir, 'usage-v1.jsonl');
copyFileSync(resolve('packages/harness/test/fixtures/usage-v1.jsonl'), v1);
writeFileSync(cfgFile, JSON.stringify({ stateDir: join(dir, 'state'), v1UsagePath: v1, repos: ['Pat201492/dungeonworks'] }));
process.env.STUDY_HALL_CONFIG = cfgFile;

const { startServer } = await import('../src/server.js');
const s = await startServer({ startCodexQuota: false, port: 0 });
after(() => s.close());
const get = async (p: string) => (await fetch(s.url + p)).json();
const post = async (p: string, body?: unknown) => (await fetch(s.url + p, { method: 'POST', body: JSON.stringify(body ?? {}), headers: { 'content-type': 'application/json' } })).json();

test('health and status describe three providers with UNKNOWN quota before any observation', async () => {
  const h = await get('/api/health') as { ok: boolean; version: string };
  assert.equal(h.ok, true);
  const st = await get('/api/status') as { providers: Array<{ id: string; quota: { state: string } | null }>; harnesses: unknown[]; provider: { effective: Record<string, string> } };
  assert.deepEqual(st.providers.map((p) => p.id), ['anthropic', 'openai', 'local']);
  assert.equal(st.providers[0].quota?.state, 'unknown');
  assert.equal(st.harnesses.length, 3);
  assert.equal(st.provider.effective.board, 'anthropic');
});

test('the provider toggle writes a per-surface override, and inherit clears it', async () => {
  let r = await post('/api/settings/provider', { surface: 'planner', choice: 'openai' }) as { provider: { effective: Record<string, string> } };
  assert.equal(r.provider.effective.planner, 'openai');
  assert.equal(r.provider.effective.board, 'anthropic', 'other surfaces follow the global default');
  r = await post('/api/settings/provider', { surface: 'global', choice: 'auto' }) as typeof r;
  assert.equal(r.provider.effective.board, 'auto');
  assert.equal(r.provider.effective.planner, 'openai', 'the override survives a global change');
  r = await post('/api/settings/provider', { surface: 'planner', choice: null }) as typeof r;
  assert.equal(r.provider.effective.planner, 'auto', 'inherit follows the global default again');
  const bad = await fetch(s.url + '/api/settings/provider', { method: 'POST', body: JSON.stringify({ surface: 'nope', choice: 'auto' }), headers: { 'content-type': 'application/json' } });
  assert.equal(bad.status, 500);
});

test('v1 usage imports into the ledger and shows up in the Runs API with detail', async () => {
  const imp = await post('/api/ledger/import-v1') as { ok: boolean; imported?: number };
  assert.equal(imp.ok, true);
  assert.equal(imp.imported, 7);
  const page = await get('/api/runs?repo=Pat201492/dungeonworks&limit=5') as { rows: Array<{ runId: string; provider: string; role: string; item: number }>; nextCursor: string | null };
  assert.equal(page.rows.length, 5);
  assert.ok(page.nextCursor);
  const rest = await get(`/api/runs?repo=Pat201492/dungeonworks&limit=5&cursor=${page.nextCursor}`) as typeof page;
  assert.equal(rest.rows.length, 2);
  assert.equal(rest.nextCursor, null);
  assert.ok(page.rows.every((r) => r.provider === 'anthropic'));
  const d = await get(`/api/runs/${page.rows[0].runId}`) as { run: { runId: string; fidelity: string }; outcomes: unknown[]; events: unknown[]; transcript: unknown };
  assert.equal(d.run.runId, page.rows[0].runId);
  assert.equal(d.run.fidelity, 'exact');
  assert.equal((await fetch(s.url + '/api/runs/nope')).status, 404);
  assert.equal((await fetch(s.url + `/api/runs/${page.rows[0].runId}/transcript`)).status, 404, 'v1 rows carry no transcript path');
  const attr = await get('/api/attribution') as Array<{ role: string }>;
  assert.ok(attr.some((a) => a.role === 'implement'));
});

test('the quota SSE stream sends the provider snapshot immediately', async () => {
  const ac = new AbortController();
  const r = await fetch(s.url + '/api/quota/stream', { signal: ac.signal });
  const reader = r.body!.getReader();
  let text = '';
  while (!text.includes('event: quota')) text += new TextDecoder().decode((await reader.read()).value);
  ac.abort();
  assert.match(text, /"id":"anthropic"/);
});

test('the web UI shell is served', async () => {
  const html = await (await fetch(s.url + '/')).text();
  assert.match(html, /provider-toggle/);
  assert.equal((await fetch(s.url + '/js/app.js')).headers.get('content-type'), 'text/javascript; charset=utf-8');
});
