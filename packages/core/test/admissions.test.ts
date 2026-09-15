import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assess, runAdmissions, runAdmissionsSplit, type AdmissionsPort } from '../src/admissions.js';
import { NEEDS_HUMAN_LABEL } from '../src/buildability.js';
import { NEEDS_DETAIL_LABEL } from '../src/issueAudit.js';
import { ADMISSIONS_SPLIT_FENCE, SPLIT_CONSIDERED_LABEL } from '../src/admissionsSplit.js';
import type { RawIssue } from '../src/github.js';

function issue(over: Omit<Partial<RawIssue>, 'labels'> & { labels?: string[] } = {}): RawIssue {
  const { labels = [], ...rest } = over;
  return {
    number: 1, title: 'a task',
    body: ['## Goal', 'Add a health endpoint.', '## Acceptance', '- [ ] `GET /health` returns 200', '- [ ] a test covers it'].join('\n'),
    labels: labels.map((name) => ({ name })), ...rest,
  } as unknown as RawIssue;
}

// ---- assess (pure) ---------------------------------------------------------------------

test('a well-formed buildable issue gains nothing', () => {
  const f = assess('o/r', issue());
  assert.equal(f.verdict, 'buildable');
  assert.deepEqual(f.wouldLabel, []);
  assert.equal(f.alreadyFlagged, false);
});

test('an unbuildable issue is flagged needs-human; a feature that merely RUNS on a GPU is not', () => {
  assert.deepEqual(assess('o/r', issue({ labels: ['needs-gpu', 'type:research'] })).wouldLabel, [NEEDS_HUMAN_LABEL]);
  assert.deepEqual(assess('o/r', issue({ labels: ['needs-gpu', 'type:feature'] })).wouldLabel, []);
});

test('an empty issue is flagged needs-detail; the two gates are independent', () => {
  assert.deepEqual(assess('o/r', issue({ body: 'make it better' })).wouldLabel, [NEEDS_DETAIL_LABEL]);
  assert.deepEqual(assess('o/r', issue({ body: 'source the art', labels: ['needs-gpu', 'type:research'] })).wouldLabel, [NEEDS_HUMAN_LABEL, NEEDS_DETAIL_LABEL]);
});

test('an already-labelled issue is reported but not re-flagged; unsure never labels; oversized is left to triage', () => {
  const f = assess('o/r', issue({ labels: ['needs-gpu', 'type:research', NEEDS_HUMAN_LABEL] }));
  assert.equal(f.verdict, 'blocked');
  assert.deepEqual(f.wouldLabel, []);
  assert.equal(f.alreadyFlagged, true);
  const unsure = assess('o/r', issue({ body: ['## Goal', 'The pack is CC0. Refactor the loader.', '## Acceptance', '- [ ] loader handles a missing file', '- [ ] a test covers it'].join('\n') }));
  assert.equal(unsure.verdict, 'unsure');
  assert.deepEqual(unsure.wouldLabel, []);
  const big = assess('o/r', issue({ body: '## Acceptance\n' + Array.from({ length: 40 }, (_, i) => `- [ ] criterion ${i} in src/mod${i}.ts`).join('\n') }));
  assert.equal(big.audit.verdict, 'oversized');
  assert.deepEqual(big.wouldLabel, []);
  assert.equal(assess('Pat201492/dungeonworks', issue({ number: 47 })).url, 'https://github.com/Pat201492/dungeonworks/issues/47');
});

// ---- runAdmissions (report vs apply) --------------------------------------------------------

function fakePort(issues: Record<string, RawIssue[]>, comments: Record<string, string[]> = {}) {
  const calls: string[] = [];
  let next = 100;
  const port: AdmissionsPort = {
    fetchIssues: async (repo) => { const l = issues[repo]; if (!l) throw new Error('rate limit'); return l; },
    ensureLabels: async (repo) => { calls.push(`ensureLabels ${repo}`); },
    issueComments: async (repo, n) => comments[`${repo}#${n}`] ?? [],
    addLabel: async (repo, n, label) => { calls.push(`addLabel ${repo}#${n} ${label}`); },
    commentIssue: async (repo, n, body) => { calls.push(`comment ${repo}#${n}: ${body.split('\n')[0].slice(0, 50)}`); },
    openIssue: async (repo, title) => { calls.push(`openIssue ${repo} ${title}`); next += 1; return `https://github.com/${repo}/issues/${next}`; },
  };
  return { port, calls };
}

const BOARD = {
  'o/a': [
    issue({ number: 1 }),
    issue({ number: 2, body: 'make it better' }),
    issue({ number: 3, labels: ['needs-gpu', 'type:research'] }),
    issue({ number: 4, labels: ['needs-gpu', 'type:research', NEEDS_HUMAN_LABEL] }),
  ],
};

test('report mode changes nothing on GitHub and counts every verdict', async () => {
  const { port, calls } = fakePort(BOARD);
  const r = await runAdmissions(['o/a', 'o/missing'], { apply: false }, port);
  assert.equal(r.applied, false);
  assert.deepEqual(calls, []);
  assert.equal(r.repos[0].open, 4);
  assert.equal(r.repos[0].blocked, 2);
  assert.equal(r.repos[0].underspecified, 1);
  assert.match(r.repos[1].error ?? '', /rate limit/);
  assert.equal(r.findings.filter((f) => f.wouldLabel.length).length, 2);
});

test('apply mode adds only needs-human/needs-detail with the marker-guarded comment', async () => {
  const { port, calls } = fakePort(BOARD, { 'o/a#3': ['**Study Room cannot build this issue as written.** (from last time)'] });
  const r = await runAdmissions(['o/a'], { apply: true }, port);
  assert.equal(r.applied, true);
  assert.ok(calls.includes('ensureLabels o/a'));
  assert.ok(calls.includes('addLabel o/a#2 needs-detail'));
  assert.ok(calls.some((c) => c.startsWith('comment o/a#2')));
  assert.ok(calls.includes('addLabel o/a#3 needs-human'));
  assert.ok(!calls.some((c) => c.startsWith('comment o/a#3')), 'already explained: label only, no second wall of text');
  assert.ok(!calls.some((c) => c.includes('#1 ') || c.includes('#4 ')), 'buildable and already-flagged issues are untouched');
  assert.ok(!calls.some((c) => /addLabel .* (reviewed-ok|runner-error|triaged)/.test(c)));
  assert.ok(r.actions.some((a) => a.includes('#3: labelled `needs-human` (already explained)')));
});

// ---- the split follow-up -----------------------------------------------------------------------

const SPLIT = (n: number) => '```' + ADMISSIONS_SPLIT_FENCE + '\n' + JSON.stringify({
  reason: 'the loader does not need the art', remainder: 'sourcing the licensed images',
  pieces: Array.from({ length: n }, (_, i) => ({ title: `Piece ${i + 1}`, body: '## Goal\nLoad it.\n\n## Acceptance\n- [ ] a\n- [ ] b', covers: `part ${i + 1}` })),
}) + '\n```';

test('split: each parked parent is asked once, pieces are filed triaged+difficulty, the parent stays open and flagged', async () => {
  const { port, calls } = fakePort({ 'o/a': [
    issue({ number: 3, labels: ['needs-gpu', 'type:research', NEEDS_HUMAN_LABEL] }),
    issue({ number: 5, labels: [NEEDS_HUMAN_LABEL, SPLIT_CONSIDERED_LABEL] }),
    issue({ number: 1 }),
  ] });
  const asked: string[] = [];
  const s = await runAdmissionsSplit({ repos: ['o/a'], run: async (prompt) => { asked.push(prompt); return { text: SPLIT(2) }; } }, port);
  assert.equal(asked.length, 1, 'only the un-considered parked issue is asked');
  assert.match(asked[0], /o\/a #3/);
  assert.equal(s.considered, 1);
  assert.equal(s.filed, 2);
  assert.deepEqual(s.events[0].filed, [101, 102]);
  assert.ok(calls.includes('openIssue o/a Piece 1') && calls.includes('openIssue o/a Piece 2'));
  assert.ok(calls.includes('addLabel o/a#101 triaged'));
  assert.ok(calls.some((c) => /addLabel o\/a#101 difficulty:/.test(c)));
  assert.ok(calls.includes('addLabel o/a#3 split-considered'));
  assert.ok(calls.some((c) => c.startsWith('comment o/a#3: **Carved the buildable part')));
  assert.ok(!calls.some((c) => /close/i.test(c)), 'nothing is ever closed');
});

test('split: nothing separable marks the parent considered with the explanation; a dry run files nothing', async () => {
  const { port, calls } = fakePort({ 'o/a': [issue({ number: 3, labels: [NEEDS_HUMAN_LABEL] })] });
  const none = await runAdmissionsSplit({ repos: ['o/a'], run: async () => ({ text: SPLIT(0) }) }, port);
  assert.equal(none.filed, 0);
  assert.ok(calls.includes('addLabel o/a#3 split-considered'));
  assert.ok(calls.some((c) => c.startsWith('comment o/a#3: **Checked whether any part')));

  const { port: p2, calls: c2 } = fakePort({ 'o/a': [issue({ number: 3, labels: [NEEDS_HUMAN_LABEL] })] });
  const dry = await runAdmissionsSplit({ repos: ['o/a'], dryRun: true, run: async () => ({ text: SPLIT(2) }) }, p2);
  assert.equal(dry.filed, 0);
  assert.deepEqual(c2, []);
  assert.match(dry.events[0].note, /dry run: 2 piece/);
});

test('split: the limit bounds the run and a failing student is reported, not fatal', async () => {
  const { port } = fakePort({ 'o/a': [1, 2, 3].map((n) => issue({ number: n, labels: [NEEDS_HUMAN_LABEL] })) });
  let n = 0;
  const s = await runAdmissionsSplit({ repos: ['o/a'], limit: 2, run: async () => { n += 1; if (n === 1) throw new Error('boom'); return { text: SPLIT(0) }; } }, port);
  assert.equal(s.considered, 2);
  assert.match(s.events[0].note, /student failed: boom/);
});
