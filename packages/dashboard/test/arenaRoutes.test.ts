import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkEnvelope, ARENA_EXPORT_SCHEMA } from '../src/arenaRoutes.js';

// The Arena tab renders the envelope study-arena exports; it is schema-checked
// and a mismatch names both versions instead of rendering garbage.

const dir = mkdtempSync(join(tmpdir(), 'sh-arena-'));
const arenaDir = join(dir, 'arena');
mkdirSync(join(arenaDir, 'src'), { recursive: true });
writeFileSync(join(arenaDir, 'src', 'cli.ts'), '// stand-in');
const cfgFile = join(dir, 'config.json');
writeFileSync(cfgFile, JSON.stringify({ stateDir: join(dir, 'state'), repos: [], arenaDir }));
process.env.STUDY_HALL_CONFIG = cfgFile;

let payload = '';
const { startServer } = await import('../src/server.js');
const s = await startServer({ startCodexQuota: false, port: 0, arenaExport: async () => payload });
after(() => s.close());
const get = async (p: string) => (await fetch(s.url + p)).json();

const ENVELOPE = {
  schema: ARENA_EXPORT_SCHEMA, generatedAt: '2026-09-15T00:00:00.000Z',
  arena: { version: '0.1.0', harnessCommit: 'abc', pricingTableVersion: '2026-09-14' },
  sections: {
    corpus: [{ name: 'dungeonworks', builtAt: 't', validatedAt: null, sha256: 'c', items: 101, valid: null, bands: { '<=2': 2, '3-6': 19, '7+': 80 } }],
    sweeps: [{ id: 'sw1', manifestSha256: 'm', startedAt: 't', finishedAt: null, lanes: ['a', 'b'], trials: { planned: 24, completed: 3, budgetExhausted: 0, usageLimit: 0 }, metrics: {}, verdict: null, verdictDoc: null }],
    comparisons: null,
  },
};

test('the Arena route returns a valid envelope with its matrix inputs', async () => {
  payload = JSON.stringify(ENVELOPE);
  const r = await get('/api/arena') as { ok: boolean; envelope: typeof ENVELOPE; arenaDir: string };
  assert.equal(r.ok, true);
  assert.equal(r.envelope.schema, ARENA_EXPORT_SCHEMA);
  assert.equal(r.envelope.sections.corpus?.[0].items, 101);
  assert.equal(r.envelope.sections.sweeps?.[0].id, 'sw1');
  assert.equal(r.arenaDir, arenaDir);
});

test('a schema mismatch names both versions; a broken export is reported, not rendered', async () => {
  payload = JSON.stringify({ ...ENVELOPE, schema: 'study-arena/export/v2' });
  const r = await get('/api/arena') as { ok: boolean; reason: string; expected: string; found: string };
  assert.equal(r.ok, false);
  assert.equal(r.expected, ARENA_EXPORT_SCHEMA);
  assert.equal(r.found, 'study-arena/export/v2');
  payload = 'not json';
  const b = await get('/api/arena') as { ok: boolean; reason: string };
  assert.equal(b.ok, false);
  assert.match(b.reason, /arena export failed/);
  assert.equal(checkEnvelope(null).ok, false);
});
