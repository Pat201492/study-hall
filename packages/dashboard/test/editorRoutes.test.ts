import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RawIssue } from '@study-hall/core/github';
import type { EditorOptions, EditorResult } from '@study-hall/core/editor';
import type { AdmissionsPort } from '@study-hall/core/admissions';
import { GOOD_BODY } from '../../planner/test/fixtures.js';

// Editor and Admissions over HTTP with a fake student, a fake GitHub and the
// planner's real filing path (its gh seams faked): one filing implementation.

const dir = mkdtempSync(join(tmpdir(), 'sh-editor-routes-'));
const stateDir = join(dir, 'state');
mkdirSync(stateDir, { recursive: true });
const cfgFile = join(dir, 'config.json');
writeFileSync(cfgFile, JSON.stringify({ stateDir, repos: ['o/a'], provider: { default: 'anthropic', perSurface: { editor: 'openai' } } }));
process.env.STUDY_HALL_CONFIG = cfgFile;

const ghCalls: string[] = [];
let nextIssue = 40;
const editorRuns: EditorOptions[] = [];
const issues: RawIssue[] = [
  { number: 1, title: 'Fine', body: GOOD_BODY, labels: [] },
  { number: 2, title: 'Thin', body: 'make it better', labels: [] },
  { number: 3, title: 'Needs a human', body: GOOD_BODY, labels: [{ name: 'needs-gpu' }, { name: 'type:research' }] },
];
const admissionsPort: AdmissionsPort = {
  fetchIssues: async () => issues,
  ensureLabels: async () => { ghCalls.push('ensureLabels'); },
  issueComments: async () => [],
  addLabel: async (_r, n, label) => { ghCalls.push(`addLabel #${n} ${label}`); },
  commentIssue: async (_r, n) => { ghCalls.push(`comment #${n}`); },
  openIssue: async (_r, title) => { ghCalls.push(`openIssue ${title}`); nextIssue += 1; return `https://github.com/o/a/issues/${nextIssue}`; },
};

const { startServer } = await import('../src/server.js');
const s = await startServer({
  startCodexQuota: false, port: 0,
  editor: {
    checkout: async () => dir,
    admissionsPort,
    splitStudent: async () => ({ text: '```admissions-split\n{"reason":"loader is separable","remainder":"the GPU run","pieces":[{"title":"Loader","body":"## Goal\\nLoad.\\n\\n## Acceptance\\n- [ ] a\\n- [ ] b","covers":"loader"}]}\n```' }),
    fileDeps: {
      openIssue: async (_repo, title) => { ghCalls.push(`plannerOpen ${title}`); nextIssue += 1; return `https://github.com/o/a/issues/${nextIssue}`; },
      addLabel: async (_repo, n, label) => { ghCalls.push(`plannerLabel #${n} ${label}`); },
      ensure: async () => {},
    },
    runEditorFn: async (opts: EditorOptions): Promise<EditorResult> => {
      editorRuns.push(opts);
      // Simulate one pass that proposes two changes; the filer is the planner path.
      const filed = await opts.file!(opts.repo!, [
        { key: 'extract-router', title: 'Extract the router', body: GOOD_BODY },
        { key: 'drop-dead-module', title: 'Drop the dead module', body: GOOD_BODY.replace(/^Owns:.*$/m, 'Owns: packages/dashboard/src/dead.ts') },
      ], ['editor-proposed', ...(opts.extraLabels ?? [])]);
      // A second pass re-proposing the first change: the ledger dedupes it, nothing is re-filed.
      const again = await opts.file!(opts.repo!, [{ key: 'extract-router', title: 'Extract the router', body: GOOD_BODY }], ['editor-proposed']);
      const state = { goal: opts.goal, repo: opts.repo!, sessionId: opts.slot.id, startedAt: 't', updatedAt: 't', status: 'DONE' as const, stoppedBy: '' as const, instances: 2, passes: [], filed: filed.map((f) => ({ key: f.key, title: f.key, url: f.url, instance: 1 })), guardrailHits: 0, totalInputTokens: 10, totalOutputTokens: 5, handoff: 'Status: DONE' };
      return { status: 'DONE', instances: 2, handoff: { status: 'DONE', chunk: 2, issuesFiled: [], raw: '' }, reachedGuard: false, stoppedBy: '', guardrailHits: 0, filed: [...filed.map((f) => f.url), ...again.map((f) => f.url)], deduped: again.length ? 0 : 1, tokensSpent: 15, state };
    },
  },
});
after(() => s.close());
const get = async (p: string) => (await fetch(s.url + p)).json();
const post = async (p: string, body?: unknown) => (await fetch(s.url + p, { method: 'POST', body: JSON.stringify(body ?? {}), headers: { 'content-type': 'application/json' } })).json();
const settle = (ms = 100) => new Promise((r) => setTimeout(r, ms));

test('an Editor run files through the planner path on the surface provider, parks when asked, and never re-files a key', async () => {
  const r = await post('/api/editor/start', { repo: 'o/a', goal: 'streamline', park: true }) as { ok: boolean; provider: string; harness: string };
  assert.equal(r.ok, true);
  assert.equal(r.provider, 'openai', 'the editor surface override says ChatGPT');
  assert.equal(r.harness, 'codex');
  await settle(300);
  assert.equal(editorRuns.length, 1);
  assert.deepEqual(editorRuns[0].extraLabels, ['needs-human']);
  assert.equal(editorRuns[0].slot.harness.id, 'codex');
  assert.deepEqual(ghCalls.filter((c) => c.startsWith('plannerOpen')), ['plannerOpen Extract the router', 'plannerOpen Drop the dead module'], 'filed once through fileBatch; the re-proposal was deduped by the ledger');
  assert.ok(ghCalls.includes('plannerLabel #41 editor-proposed'));
  assert.ok(ghCalls.includes('plannerLabel #41 needs-human'));
  assert.ok(ghCalls.includes('plannerLabel #41 triaged'), 'the planner path labels at birth like any planner draft');
  const st = await get('/api/editor/status') as { active: unknown[]; repos: { repo: string; running: boolean }[] };
  assert.equal(st.active.length, 0);
  assert.equal(st.repos[0].repo, 'o/a');
});

test('admissions: scan changes nothing; apply needs confirm and adds only the two flags with a comment', async () => {
  const before = ghCalls.length;
  const scan = await post('/api/admissions/scan') as { report: { applied: boolean; findings: { number: number; wouldLabel: string[] }[]; repos: { blocked: number; underspecified: number }[] } };
  assert.equal(scan.report.applied, false);
  assert.equal(ghCalls.length, before, 'report mode touched nothing');
  assert.deepEqual(scan.report.findings.map((f) => [f.number, f.wouldLabel]), [[1, []], [2, ['needs-detail']], [3, ['needs-human']]]);
  const noConfirm = await fetch(s.url + '/api/admissions/apply', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
  assert.equal(noConfirm.status, 500);
  const apply = await post('/api/admissions/apply', { confirm: true }) as { report: { applied: boolean; actions: string[] } };
  assert.equal(apply.report.applied, true);
  const writes = ghCalls.slice(before);
  assert.deepEqual(writes.filter((c) => c.startsWith('addLabel')), ['addLabel #2 needs-detail', 'addLabel #3 needs-human']);
  assert.deepEqual(writes.filter((c) => c.startsWith('comment')), ['comment #2', 'comment #3']);
  const view = await get('/api/admissions') as { report: { applied: boolean } };
  assert.equal(view.report.applied, true);
});

test('admissions split: the student runs on the admissions surface provider; a dry run files nothing, a real run files triaged children', async () => {
  let before = ghCalls.length;
  const dry = await post('/api/admissions/split', { dry: true, limit: 3 }) as { ok: boolean; provider: string; dry: boolean };
  assert.equal(dry.ok, true);
  assert.equal(dry.provider, 'anthropic', 'the admissions surface follows the global default');
  await settle(300);
  let view = await get('/api/admissions') as { split: { done: boolean; dry: boolean; events: { number: number; note: string }[]; summary: { considered: number; filed: number } } };
  assert.equal(view.split.done, true);
  assert.equal(view.split.summary.filed, 0);
  assert.match(view.split.events[0].note, /dry run: 1 piece/);
  assert.equal(ghCalls.length, before);

  before = ghCalls.length;
  const real = await post('/api/admissions/split', { dry: false, limit: 3 }) as { ok: boolean };
  assert.equal(real.ok, true);
  await settle(300);
  view = await get('/api/admissions') as typeof view;
  assert.equal(view.split.summary.filed, 1);
  const writes = ghCalls.slice(before);
  assert.ok(writes.includes('openIssue Loader'));
  assert.ok(writes.some((c) => /addLabel #\d+ triaged/.test(c)));
  assert.ok(writes.includes('addLabel #3 split-considered'));
  assert.ok(writes.includes('comment #3'));
  assert.ok(!writes.some((c) => /close/i.test(c)));
});
