import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  comparePrompt, isFresh, matchIssues, mirrorPrompt, parseMirror, renderIssues, runSpecMirror,
  sortFindings, MIRROR_FENCE, type IssueDigest, type MirrorPort,
} from '../src/specMirror.js';

const ISSUES: IssueDigest[] = [
  { number: 1, title: 'planner: MCP tools for linting and filing issues', body: 'Expose lint_issue and file_issues over MCP.', labels: ['triaged'], state: 'closed', merged: true },
  { number: 2, title: 'burn: cap tokens per hour and fail over', body: 'A sliding-window cap that rests a provider.', labels: ['triaged'], state: 'closed', merged: true },
  { number: 3, title: 'arena: paired sweep across harnesses', body: 'Compare lanes on the same tasks.', labels: [], state: 'open' },
];

function port(replies: string[]): { port: MirrorPort; prompts: string[] } {
  const prompts: string[] = [];
  return { prompts, port: { provider: 'anthropic', model: 'm', ask: async (p) => { prompts.push(p); return replies.shift() ?? ''; } } };
}
const verdict = (findings: unknown[]): string => '```' + MIRROR_FENCE + '\n' + JSON.stringify({ findings }) + '\n```';

test('the mirror pass is blinded by construction: the real README never enters its prompt', async () => {
  const README = 'This project also ships a Kubernetes operator and a hosted multi-tenant API.';
  const p = port(['# study-hall\n\nA board of autonomous students.', verdict([])]);
  await runSpecMirror({ repo: 'o/r', issues: ISSUES, readme: README, port: p.port });
  assert.equal(p.prompts.length, 2);
  assert.ok(!p.prompts[0].includes('Kubernetes'), 'the first prompt carries issues only');
  assert.ok(!p.prompts[0].includes(README));
  assert.ok(p.prompts[1].includes('Kubernetes'), 'the second prompt is where the real README appears');
  assert.ok(p.prompts[1].includes('A board of autonomous students.'), 'and it carries the mirror to compare against');
});

test('closed issues are included and marked built, so the mirror describes the repo as built rather than as planned', () => {
  const rendered = renderIssues(ISSUES);
  assert.match(rendered, /#1 — planner: MCP tools[\s\S]*status: BUILT/);
  assert.match(rendered, /#3 — arena[\s\S]*status: planned/);
  const dropped: IssueDigest = { number: 4, title: 'abandoned idea', body: '', labels: [], state: 'closed', merged: false };
  assert.match(renderIssues([dropped]), /closed without a merge/);
  // Numbering is stable regardless of input order, so the prompt is cache-friendly.
  assert.equal(renderIssues([...ISSUES].reverse()), rendered);
});

test('the mirror prompt asks for a README, not a digest of tickets, and forbids invention', () => {
  const p = mirrorPrompt('o/r', ISSUES);
  assert.match(p, /Write the README this project would have/);
  assert.match(p, /no issue numbers/);
  assert.match(p, /write nothing rather than inventing it/);
});

test('the three buckets are parsed, contradictions lead, and both sides are kept verbatim', () => {
  const { findings, parsed } = parseMirror(verdict([
    { kind: 'unannounced-surface', subject: 'burn rate governor', issuesSay: 'rests a provider at a cap', detail: 'the README never mentions it' },
    { kind: 'contradiction', subject: 'issue filing', readmeSays: 'the model files issues', issuesSay: 'the model proposes; the orchestrator files', detail: 'opposite safety models' },
    { kind: 'unbuilt-promise', subject: 'hosted API', readmeSays: 'a hosted multi-tenant API', detail: 'no issue covers it' },
  ]), ISSUES);
  assert.equal(parsed, true);
  assert.deepEqual(findings.map((f) => f.kind), ['contradiction', 'unbuilt-promise', 'unannounced-surface']);
  assert.equal(findings[0].readmeSays, 'the model files issues');
  assert.equal(findings[0].issuesSay, 'the model proposes; the orchestrator files');
  assert.equal(findings[2].readmeSays, null, 'a bucket with nothing to quote on one side reports null, not an empty string');
});

test('a finding points back at the issues it came from, which the compare pass could not have known', () => {
  assert.deepEqual(matchIssues('burn rate governor cap', ISSUES), [2]);
  assert.deepEqual(matchIssues('paired sweep across harnesses', ISSUES), [3]);
  assert.deepEqual(matchIssues('the and of it', ISSUES), [], 'stop words alone match nothing');
  const { findings } = parseMirror(verdict([{ kind: 'unannounced-surface', subject: 'planner MCP tools', detail: 'x' }]), ISSUES);
  assert.deepEqual(findings[0].issues, [1]);
});

test('an unparseable or malformed verdict yields no findings and says so, rather than inventing agreement', async () => {
  assert.deepEqual(parseMirror('I think they broadly agree.', ISSUES), { findings: [], parsed: false });
  assert.deepEqual(parseMirror('```' + MIRROR_FENCE + '\nnot json\n```', ISSUES), { findings: [], parsed: false });
  assert.deepEqual(parseMirror(verdict([{ kind: 'made-up', subject: 'x' }, { kind: 'contradiction' }]), ISSUES).findings, [], 'unknown kinds and subjectless rows are dropped');
  const p = port(['# mirror', 'no fence here']);
  const r = await runSpecMirror({ repo: 'o/r', issues: ISSUES, readme: 'real readme', port: p.port });
  assert.equal(r.parsed, false);
  assert.deepEqual(r.findings, []);
  assert.match(r.note ?? '', /nothing parseable/);
});

test('a repo with no issues, and a repo with no README, each return early with a reason instead of a comparison', async () => {
  const none = port([]);
  const a = await runSpecMirror({ repo: 'o/r', issues: [], readme: 'x', port: none.port });
  assert.equal(none.prompts.length, 0, 'no model call is spent when there is nothing to mirror');
  assert.match(a.note ?? '', /nothing to mirror/);

  const one = port(['# implied readme']);
  const b = await runSpecMirror({ repo: 'o/r', issues: ISSUES, readme: '   ', port: one.port });
  assert.equal(one.prompts.length, 1, 'the mirror is still worth writing; there is just nothing to compare it with');
  assert.equal(b.mirror, '# implied readme');
  assert.match(b.note ?? '', /no README/);
});

test('a report is reusable only while both documents are byte-identical', async () => {
  const p = port(['# mirror', verdict([])]);
  const r = await runSpecMirror({ repo: 'o/r', issues: ISSUES, readme: 'real', port: p.port });
  assert.equal(isFresh(r, ISSUES, 'real'), true);
  assert.equal(isFresh(r, ISSUES, 'real edited'), false, 'the README changed');
  assert.equal(isFresh(r, [...ISSUES, { number: 9, title: 'new', body: '', labels: [], state: 'open' }], 'real'), false, 'an issue was added');
  assert.equal(isFresh(r, ISSUES.map((i) => (i.number === 3 ? { ...i, state: 'closed' as const, merged: true } : i)), 'real'), false, 'an issue was built');
  assert.equal(isFresh(null, ISSUES, 'real'), false);
});

test('the compare prompt refuses wording differences and demands verbatim quotes on a contradiction', () => {
  const p = comparePrompt('o/r', 'A text', 'B text');
  assert.match(p, /Wording, ordering, tone and level of detail are NOT disagreements/);
  assert.match(p, /Quote BOTH sides verbatim/);
  assert.match(p, /An empty findings array is a valid/);
  assert.ok(p.indexOf('A text') < p.indexOf('B text'), 'A is the mirror, B is the repo');
});

test('sortFindings is stable on subject so a re-run does not reshuffle the list', () => {
  const f = (kind: 'contradiction' | 'unbuilt-promise', subject: string) => ({ kind, subject, readmeSays: null, issuesSay: null, issues: [], detail: '' });
  assert.deepEqual(sortFindings([f('unbuilt-promise', 'b'), f('contradiction', 'z'), f('unbuilt-promise', 'a')]).map((x) => x.subject), ['z', 'a', 'b']);
});
