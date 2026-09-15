import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lintBatch, type IssueDraft } from '../src/drafts.js';
import { fileBatch, PlannerStore, type FileDeps } from '../src/staging.js';
import { GOOD_BODY } from './fixtures.js';

function fakeGh() {
  let next = 100;
  const opened: Array<{ title: string; body: string }> = [];
  const labels: Array<[number, string]> = [];
  const ensured: string[][] = [];
  const deps: FileDeps = {
    openIssue: async (_repo, title, body) => { opened.push({ title, body }); return `https://github.com/o/r/issues/${next++}`; },
    addLabel: async (_repo, n, label) => { labels.push([n, label]); },
    ensure: async (_repo, names) => { ensured.push(names); },
    now: () => new Date('2026-09-15T00:00:00Z'),
  };
  return { deps, opened, labels, ensured };
}

function draft(key: string, over: Partial<IssueDraft> = {}): IssueDraft {
  return { key, title: `Piece ${key}`, body: GOOD_BODY, ...over };
}

test('the store stages, upserts, removes and remembers what was filed', () => {
  const store = new PlannerStore(mkdtempSync(join(tmpdir(), 'sh-plan-')), 'https://github.com/o/r');
  assert.equal(store.staged(), null);
  const drafts = [draft('a'), draft('b')];
  store.stage(drafts, lintBatch(drafts));
  assert.equal(store.staged()?.drafts.length, 2);
  store.upsert(draft('b', { title: 'B revised' }), lintBatch([draft('b')])[0]);
  assert.equal(store.staged()?.drafts.find((d) => d.key === 'b')?.title, 'B revised');
  store.remove('a');
  assert.deepEqual(store.staged()?.drafts.map((d) => d.key), ['b']);
  store.markFiled({ key: 'b', number: 5, url: 'u', ts: 't', title: 'B' });
  assert.equal(store.filed().b.number, 5);
});

test('fileBatch files in dependency order, substitutes numbers, labels at birth, and is idempotent', async () => {
  const store = new PlannerStore(mkdtempSync(join(tmpdir(), 'sh-plan-')), 'o/r');
  const drafts = [
    draft('child', { dependsOn: ['base', 7] }),
    draft('base', { owns: ['shared.ts'] }),
    draft('bad', { body: '## Goal\ntoo short' }),
  ];
  store.stage(drafts, lintBatch(drafts));
  const gh = fakeGh();
  const results = await fileBatch(store, { rubricSha: 'deadbeefcafe0000' }, gh.deps);

  assert.deepEqual(Object.fromEntries(results.map((r) => [r.key, r.status])), { base: 'filed', child: 'filed', bad: 'skipped-rejected' });
  assert.ok(results.findIndex((r) => r.key === 'base') < results.findIndex((r) => r.key === 'child'), 'dependencies file first');
  assert.equal(gh.opened[0].title, 'Piece base');
  assert.ok(gh.opened[0].body.includes('Owns: shared.ts'));
  assert.ok(gh.opened[1].body.includes('Depends on #100'), 'the child carries the base\'s REAL number');
  assert.ok(gh.opened[1].body.includes('Depends on #7'));
  assert.ok(gh.opened[1].body.includes('<!-- planner-key: child rubric:deadbeefcafe -->'));
  assert.ok(gh.labels.some(([n, l]) => n === 100 && l === 'difficulty:standard'));
  assert.ok(gh.labels.some(([n, l]) => n === 100 && l === 'triaged'));
  assert.ok(gh.ensured[0].includes('triaged'));
  assert.deepEqual(Object.keys(store.filed()).sort(), ['base', 'child']);
  assert.deepEqual(store.staged()?.drafts.map((d) => d.key), ['bad'], 'filed drafts leave the staging area; the rejected one stays');

  // Re-stage the same batch (a resumed session re-proposing): nothing is filed twice.
  store.stage(drafts, lintBatch(drafts));
  const again = await fileBatch(store, {}, gh.deps);
  assert.deepEqual(again.map((r) => r.status).sort(), ['skipped-already-filed', 'skipped-already-filed', 'skipped-rejected']);
  assert.equal(gh.opened.length, 2);
});

test('a dependant of a draft that failed to file is not filed with a dangling dependency', async () => {
  const store = new PlannerStore(mkdtempSync(join(tmpdir(), 'sh-plan-')), 'o/r');
  const drafts = [draft('base'), draft('child', { dependsOn: ['base'] })];
  store.stage(drafts, lintBatch(drafts));
  const gh = fakeGh();
  gh.deps.openIssue = async () => { throw new Error('gh exploded'); };
  const results = await fileBatch(store, {}, gh.deps);
  assert.equal(results[0].status, 'failed');
  assert.match(results[0].error!, /gh exploded/);
  assert.equal(results[1].status, 'failed');
  assert.match(results[1].error!, /dependency "base" was not filed/);
  assert.equal(store.staged()?.drafts.length, 2, 'both stay staged for another attempt');
});

test('keys narrows the batch, and a selected dependant whose dependency is unselected is rejected by lint', async () => {
  const store = new PlannerStore(mkdtempSync(join(tmpdir(), 'sh-plan-')), 'o/r');
  const drafts = [draft('base'), draft('child', { dependsOn: ['base'] }), draft('solo')];
  store.stage(drafts, lintBatch(drafts));
  const gh = fakeGh();
  const results = await fileBatch(store, { keys: ['solo', 'child'] }, gh.deps);
  assert.deepEqual(results.map((r) => [r.key, r.status]), [['child', 'skipped-rejected'], ['solo', 'filed']]);
});
