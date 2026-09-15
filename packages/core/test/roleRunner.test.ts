import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Harness, HarnessCapabilities, HarnessRunOptions, HarnessRunResult, Usage } from '@study-hall/harness/contract';
import { WarmSlot } from '@study-hall/harness/warmSlot';
import { runRole, RoleRunError, type DispatchDecision, type GitPort, type GitHubPort, type RepoContext } from '../src/engine/roleRunner.js';
import type { Task } from '../src/taskmap.js';
import type { OpenPull } from '../src/github.js';
import type { Role } from '../src/types.js';

// ---- fakes ------------------------------------------------------------------

const CLAUDE_LIKE: HarnessCapabilities = {
  warmSessions: true, seedableSessions: true, forkSessions: true, cacheUsageSplit: true, usageIsCumulative: false,
  reportsCost: true, toolAllowlist: true, mcpToolAllowlist: true, effortControl: true, sandboxModes: ['none'],
  promptTransport: 'stdin', streamsUsage: true, cancellable: true, transcripts: true, budgetStop: true, chat: 'stream-json',
};
const CODEX_LIKE: HarnessCapabilities = {
  ...CLAUDE_LIKE, seedableSessions: false, usageIsCumulative: true, reportsCost: false, toolAllowlist: false,
  sandboxModes: ['workspace-write'], streamsUsage: false, budgetStop: false, chat: 'resume-loop',
};

function fakeHarness(id: string, capabilities: HarnessCapabilities, provider = 'anthropic'): Harness {
  return {
    id, provider, capabilities,
    run: async () => { throw new Error('use the slot runFn'); },
    killAll: () => {},
    classifyFailure: (m) => {
      if (/session limit|usage limit/i.test(m)) return { kind: 'capacity', resetAt: 1_700_000_100_000 };
      if (/token could not be refreshed/i.test(m)) return { kind: 'auth', detail: 'expired' };
      if (/no JSON result/i.test(m)) return { kind: 'infra' };
      return { kind: 'task' };
    },
    preflight: async () => ({ ok: true }),
  };
}

const usage = (n = 1000): Usage => ({ inputTokens: n, outputTokens: n / 10, cacheReadInputTokens: n * 4, cacheCreationInputTokens: 0, reasoningTokens: 0 });

interface Script { text?: string; stoppedBy?: 'budget' | 'cancelled'; sessionId?: string; throw?: string; transcript?: string[] }

/** A slot whose runs are scripted; every (prompt, opts) is recorded. */
function slotFor(harness: Harness, scripts: Script[]): { slot: WarmSlot; calls: { prompt: string; opts: HarnessRunOptions }[] } {
  const calls: { prompt: string; opts: HarnessRunOptions }[] = [];
  const slot = new WarmSlot({
    harness, id: 'slot-1', log: () => {},
    runFn: async (prompt, opts) => {
      calls.push({ prompt, opts });
      const s = scripts.shift() ?? {};
      for (const line of s.transcript ?? []) opts.transcriptSink?.(line);
      if (s.throw) throw new Error(s.throw);
      const r: HarnessRunResult = {
        text: s.text ?? 'done', usage: usage(), sessionId: s.sessionId ?? opts.session?.seed ?? opts.session?.base ?? '',
        turns: 3, meter: 'subscription', durationMs: 1234, exitCode: 0, costUsd: 0.5, stoppedBy: s.stoppedBy,
      };
      return r;
    },
  });
  return { slot, calls };
}

function fakeGit(over: Partial<GitPort> & { changes?: boolean; shas?: string[]; conflicts?: string[]; regenOk?: boolean } = {}) {
  const calls: string[] = [];
  const shas = over.shas ?? ['aaa', 'aaa'];
  let removed: string[] = [];
  const git: GitPort = {
    addWorktree: async (_c, branch) => { calls.push(`addWorktree ${branch}`); return `/wt/${branch}`; },
    addWorktreeForBranch: async (_c, branch) => { calls.push(`addWorktreeForBranch ${branch}`); return `/wt/${branch}`; },
    removeWorktree: async (_c, dir) => { calls.push(`removeWorktree ${dir}`); removed.push(dir); },
    commitAndPush: async (_d, branch, msg) => { calls.push(`commitAndPush ${branch}: ${msg.split('\n')[0]}`); return over.changes ?? true; },
    headSha: async () => shas.shift() ?? 'zzz',
    pushBranch: async (_d, branch) => { calls.push(`pushBranch ${branch}`); },
    startBaseMerge: async () => { calls.push('startBaseMerge'); return { conflicts: (over.conflicts ?? []).length > 0 }; },
    conflictedFiles: async () => over.conflicts ?? [],
    regenerateLockfiles: async (_d, generated) => { calls.push(`regenerate ${generated.map((g) => g.path).join(',')}`); return generated.map((g) => ({ path: g.path, ok: over.regenOk ?? true, error: over.regenOk === false ? 'npm install failed' : undefined })); },
    finishMergePush: async (_d, branch) => { calls.push(`finishMergePush ${branch}`); },
    ...over,
  };
  return { git, calls, removed: () => removed };
}

function fakeGh(over: Partial<GitHubPort> & { state?: 'OPEN' | 'MERGED' | 'CLOSED'; labelFails?: string } = {}) {
  const calls: string[] = [];
  let nextIssue = 200;
  const hub: GitHubPort = {
    issueBody: async () => 'Build the thing.\n\n- [ ] one\n- [ ] two',
    openPr: async (_r, branch) => { calls.push(`openPr ${branch}`); return 'https://github.com/o/r/pull/77'; },
    prState: async () => over.state ?? 'OPEN',
    approvePr: async (_r, n) => { calls.push(`approvePr ${n}`); },
    requestChangesPr: async (_r, n) => { calls.push(`requestChangesPr ${n}`); },
    commentPr: async (_r, n) => { calls.push(`commentPr ${n}`); },
    commentIssue: async (_r, n, body) => { calls.push(`commentIssue ${n}: ${body.split('\n')[0].slice(0, 40)}`); },
    addLabel: async (_r, n, label, kind) => {
      if (over.labelFails === label) throw new Error(`label ${label} does not exist`);
      calls.push(`addLabel ${kind} ${n} ${label}`);
    },
    removeLabel: async (_r, n, label, kind) => { calls.push(`removeLabel ${kind} ${n} ${label}`); },
    prReviewFeedback: async () => 'Please rename foo.',
    failingCiLog: async () => 'FAIL tests/x.test.ts\n  expected 1 to be 2',
    openIssue: async (_r, title) => { calls.push(`openIssue ${title}`); nextIssue += 1; return `https://github.com/o/r/issues/${nextIssue}`; },
    addIssueDeps: async (_r, n, deps) => { calls.push(`addIssueDeps ${n} ${deps.join(',')}`); },
    ...over,
  };
  return { hub, calls };
}

function task(n: number, over: Partial<Task> = {}): Task {
  return { id: `#${n}`, title: `Issue ${n}`, model: 'opus', role: 'implement', priority: 1000 - n, deps: [], pinned: false, assignedStudent: null, stage: 'ready', owns: [], ...over };
}
function pull(n: number, over: Partial<OpenPull> = {}): OpenPull {
  return { number: n, title: `PR ${n}`, headRefName: `study/issue-${n - 10}`, labels: [], mergeable: 'MERGEABLE', statusCheckRollup: 'SUCCESS', reviewDecision: '', files: [], ...over };
}
function repo(over: Partial<RepoContext> = {}): RepoContext {
  return {
    slug: 'o/r', configured: 'o/r', clone: { url: 'https://github.com/o/r', dir: '/clone', worktreesRoot: '/wt', base: 'main' },
    spec: '', tasks: [task(1), task(2, { owns: ['src/b.ts'] })], pulls: [pull(11), pull(12, { labels: ['changes-requested'] }), pull(13, { mergeable: 'CONFLICTING' })],
    ...over,
  };
}
function decision(role: Role, number: number, over: Partial<DispatchDecision> = {}): DispatchDecision {
  const target = role === 'implement' || role === 'triage' ? 'issue' : 'pr';
  const kind = ({ implement: 'IMPLEMENT', triage: 'TRIAGE', review: 'REVIEW', fix: 'FIX', rewrite: 'FIX', resolve: 'RESOLVE', merge: 'MERGE' } as const)[role];
  return {
    kind: 'dispatch', action: { repo: 'o/r', kind, target, number, role, reason: 'test' },
    key: `${kind}:o/r:${target}-${number}`, item: `o/r:${target}-${number}`, role, tier: 'opus',
    provider: 'anthropic', harness: 'fake-claude', model: 'claude-opus-4-8', effort: 'medium', files: [], redispatch: false, reason: 'test',
    ...over,
  };
}
const POOL = { approval: 'never' as const, sandbox: 'none' as const, tools: ['Bash', 'Read', 'Edit'] };
const NOW = 1_700_000_000_000;

function run(role: Role, number: number, slot: WarmSlot, git: GitPort, hub: GitHubPort, extra: Partial<Parameters<typeof runRole>[0]> = {}, deps: Parameters<typeof runRole>[1] = {}) {
  return runRole({ decision: decision(role, number), runId: `run-${role}-${number}`, worker: { id: 'w1', slot }, repo: repo(), pool: POOL, ...extra }, { git, gh: hub, now: () => NOW, ...deps });
}

// ---- warm slots ---------------------------------------------------------------

test('the second task on a worker forks off the first task base — seedable harness', async () => {
  const { slot, calls } = slotFor(fakeHarness('fake-claude', CLAUDE_LIKE), [{}, {}]);
  const { git } = fakeGit();
  const { hub } = fakeGh();
  const first = await run('implement', 1, slot, git, hub);
  const second = await run('implement', 2, slot, git, hub);
  assert.deepEqual(calls[0].opts.session, { mode: 'new', seed: 'slot-1' });
  assert.deepEqual(calls[1].opts.session, { mode: 'fork', base: 'slot-1' });
  assert.equal(first.run?.warmMechanism, 'seed');
  assert.equal(first.run?.seedSessionId, 'slot-1');
  assert.equal(second.run?.warmMechanism, 'fork');
  assert.equal(second.run?.seedSessionId, 'slot-1');
});

test('the second task on a worker forks off the ADOPTED id — adopt-only harness with cumulative usage', async () => {
  const { slot, calls } = slotFor(fakeHarness('fake-codex', CODEX_LIKE, 'openai'), [{ sessionId: 'thr_abc' }, { sessionId: 'thr_abc' }]);
  const { git } = fakeGit();
  const { hub } = fakeGh();
  const first = await run('implement', 1, slot, git, hub);
  const second = await run('implement', 2, slot, git, hub);
  assert.deepEqual(calls[0].opts.session, { mode: 'new' });
  assert.deepEqual(calls[1].opts.session, { mode: 'fork', base: 'thr_abc' });
  assert.deepEqual(calls[1].opts.extra?.usageBaseline, usage(), 'cumulative usage diffed against the seed baseline');
  assert.equal(first.run?.warmMechanism, 'adopted');
  assert.equal(second.run?.warmMechanism, 'fork');
  assert.equal(second.run?.seedSessionId, 'thr_abc');
});

// ---- ledger row -----------------------------------------------------------------

test('the ledger row carries every field the arena needs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sh-transcripts-'));
  const { slot } = slotFor(fakeHarness('fake-claude', CLAUDE_LIKE), [{ transcript: ['{"type":"system"}', '{"type":"result"}'] }]);
  const { git } = fakeGit({ shas: ['base123', 'base123'] });
  const { hub } = fakeGh();
  const out = await run('implement', 1, slot, git, hub, {}, { transcriptDir: dir });
  const r = out.run!;
  assert.equal(r.runId, 'run-implement-1');
  assert.equal(r.startedAt, new Date(NOW).toISOString());
  assert.equal(r.endedAt, new Date(NOW).toISOString());
  assert.equal(r.provider, 'anthropic');
  assert.equal(r.harness, 'fake-claude');
  assert.equal(r.model, 'claude-opus-4-8');
  assert.equal(r.effort, 'medium');
  assert.equal(r.tier, 'opus');
  assert.equal(r.role, 'implement');
  assert.equal(r.repo, 'o/r');
  assert.equal(r.item, 1);
  assert.equal(r.warmMechanism, 'seed');
  assert.equal(r.worktree, '/wt/study/issue-1');
  assert.equal(r.branch, 'study/issue-1');
  assert.equal(r.baseSha, 'base123');
  assert.match(r.promptSha256 ?? '', /^[0-9a-f]{64}$/);
  assert.equal(r.promptTemplateId, 'implement');
  assert.deepEqual(r.toolAllowlist, ['Bash', 'Read', 'Edit']);
  assert.equal(r.toolAllowlistEnforced, true);
  assert.equal(r.sandbox, 'none');
  assert.equal(r.approval, 'never');
  assert.equal(r.transcriptPath, join(dir, 'run-implement-1.jsonl'));
  assert.equal(r.reportedCostUsd, 0.5);
  assert.equal(typeof r.estimatedCostUsd, 'number');
  assert.equal(r.pricingTableVersion.length > 0, true);
  assert.equal(r.fidelity, 'exact');
  assert.equal(r.inputTokens, 1000);
  assert.equal(r.cacheReadInputTokens, 4000);
  assert.equal(r.turns, 3);
  assert.equal(r.durationMs, 1234);
  assert.equal(r.meter, 'subscription');
  assert.equal(r.stoppedBy, null);
  assert.equal(readFileSync(r.transcriptPath!, 'utf8'), '{"type":"system"}\n{"type":"result"}\n');
});

// ---- implement effect ----------------------------------------------------------

test('implement with a diff commits, pushes, opens a PR and records pr-opened', async () => {
  const { slot, calls } = slotFor(fakeHarness('fake-claude', CLAUDE_LIKE), [{ text: 'Implemented it.' }]);
  const { git, calls: g } = fakeGit();
  const { hub, calls: h } = fakeGh();
  const out = await run('implement', 1, slot, git, hub);
  assert.deepEqual(out.effect, { kind: 'pr-opened', number: 77, url: 'https://github.com/o/r/pull/77', branch: 'study/issue-1' });
  assert.equal(out.outcome?.outcome, 'pr-opened');
  assert.equal(out.outcome?.prNumber, 77);
  assert.equal(out.outcome?.runId, 'run-implement-1');
  assert.deepEqual(g, ['addWorktree study/issue-1', 'commitAndPush study/issue-1: Issue 1', 'removeWorktree /wt/study/issue-1']);
  assert.deepEqual(h, ['openPr study/issue-1']);
  // The prompt is role-first, carries the issue body, and names the other task's owned files.
  assert.match(calls[0].prompt, /^You are an implementer/i);
  assert.match(calls[0].prompt, /Build the thing/);
  assert.match(calls[0].prompt, /src\/b\.ts.*owned by #2/);
  assert.deepEqual(calls[0].opts.tools, ['Bash', 'Read', 'Edit']);
  assert.equal(calls[0].opts.cwd, '/wt/study/issue-1');
  assert.equal(calls[0].opts.model, 'claude-opus-4-8');
});

test('implement with an empty diff whose text marks every criterion DONE parks the issue as already-satisfied', async () => {
  const { slot } = slotFor(fakeHarness('fake-claude', CLAUDE_LIKE), [{ text: 'Checked:\n- criterion one: DONE\n- criterion two: DONE\nNothing to change.' }]);
  const { git } = fakeGit({ changes: false });
  const { hub, calls: h } = fakeGh();
  const out = await run('implement', 1, slot, git, hub);
  assert.deepEqual(out.effect, { kind: 'already-satisfied', criteria: 2 });
  assert.equal(out.outcome?.outcome, 'empty-diff');
  assert.ok(h.includes('addLabel issue 1 already-satisfied'));
  assert.ok(h.some((c) => c.startsWith('commentIssue 1')));
});

test('implement with an empty diff and no verdict records empty-diff and nothing else', async () => {
  const { slot } = slotFor(fakeHarness('fake-claude', CLAUDE_LIKE), [{ text: 'I could not find the module.' }]);
  const { git } = fakeGit({ changes: false });
  const { hub, calls: h } = fakeGh();
  const out = await run('implement', 1, slot, git, hub);
  assert.deepEqual(out.effect, { kind: 'empty', verdict: 'unknown' });
  assert.deepEqual(h, []);
});

test('a budget stop and a cancel still commit and push the partial work', async () => {
  for (const stoppedBy of ['budget', 'cancelled'] as const) {
    const { slot } = slotFor(fakeHarness('fake-claude', CLAUDE_LIKE), [{ text: 'partial', stoppedBy }]);
    const { git, calls: g } = fakeGit();
    const { hub } = fakeGh();
    const out = await run('implement', 1, slot, git, hub);
    assert.equal(out.run?.stoppedBy, stoppedBy);
    assert.equal(out.effect.kind, 'pr-opened');
    assert.ok(g.some((c) => c.startsWith('commitAndPush')), stoppedBy);
  }
});

// ---- cleanup and failure ---------------------------------------------------------

test('the worktree is removed on success, on failure and on cancel; a harness failure becomes a RoleRunError with a ledger row', async () => {
  // success
  {
    const { slot } = slotFor(fakeHarness('fake-claude', CLAUDE_LIKE), [{}]);
    const { git, removed } = fakeGit();
    await run('implement', 1, slot, git, fakeGh().hub);
    assert.deepEqual(removed(), ['/wt/study/issue-1']);
  }
  // capacity failure
  {
    const { slot } = slotFor(fakeHarness('fake-claude', CLAUDE_LIKE), [{ throw: "You've hit your session limit · resets 4:40am" }]);
    const { git, removed } = fakeGit();
    const err = await run('implement', 1, slot, git, fakeGh().hub).catch((e) => e as RoleRunError);
    assert.ok(err instanceof RoleRunError);
    assert.equal(err.phase, 'run');
    assert.deepEqual(err.verdict, { kind: 'capacity', resetAt: 1_700_000_100_000 });
    assert.equal(err.run?.errorClass, 'capacity');
    assert.equal(err.run?.fidelity, 'missing');
    assert.equal(err.run?.runId, 'run-implement-1');
    assert.deepEqual(removed(), ['/wt/study/issue-1']);
    assert.equal(slot.state, 'idle-warm', 'the slot is freed');
  }
  // cancel (resolves with stoppedBy) — see the budget/cancel test; cleanup covered there via the success path.
  // worktree preparation failure
  {
    const { slot } = slotFor(fakeHarness('fake-claude', CLAUDE_LIKE), [{}]);
    const { git } = fakeGit({ addWorktree: async () => { throw new Error('fatal: could not lock config file'); } });
    const err = await run('implement', 1, slot, git, fakeGh().hub).catch((e) => e as RoleRunError);
    assert.ok(err instanceof RoleRunError);
    assert.equal(err.phase, 'prepare');
    assert.equal(err.verdict.kind, 'infra');
    assert.equal(err.run, null);
  }
});

// ---- review ----------------------------------------------------------------------

test('review: VERDICT: APPROVE labels reviewed-ok and records review-approve; ambiguous text is changes', async () => {
  const { slot } = slotFor(fakeHarness('fake-claude', CLAUDE_LIKE), [{ text: 'Looks fine.\n\nVERDICT: APPROVE' }, { text: 'Hmm, some concerns.' }]);
  const { git, calls: g } = fakeGit();
  const { hub, calls: h } = fakeGh();
  const ok = await run('review', 11, slot, git, hub);
  assert.deepEqual(ok.effect, { kind: 'review', verdict: 'APPROVE', label: 'reviewed-ok' });
  assert.equal(ok.outcome?.outcome, 'review-approve');
  assert.equal(ok.outcome?.reviewVerdict, 'approved');
  assert.equal(ok.outcome?.prNumber, 11);
  assert.ok(h.includes('approvePr 11'));
  assert.ok(h.includes('addLabel pr 11 reviewed-ok'));
  assert.equal(g[0], 'addWorktree study/review-issue-1');

  const changes = await run('review', 11, slot, git, hub);
  assert.equal(changes.effect.kind === 'review' && changes.effect.verdict, 'REQUEST_CHANGES');
  assert.equal(changes.outcome?.outcome, 'review-changes');
  assert.ok(h.includes('requestChangesPr 11'));
  assert.ok(h.includes('addLabel pr 11 changes-requested'));
});

test('review: a label write failure throws (the label is the durable verdict) with the run row attached', async () => {
  const { slot } = slotFor(fakeHarness('fake-claude', CLAUDE_LIKE), [{ text: 'VERDICT: APPROVE' }]);
  const { git, removed } = fakeGit();
  const { hub } = fakeGh({ labelFails: 'reviewed-ok' });
  const err = await run('review', 11, slot, git, hub).catch((e) => e as RoleRunError);
  assert.ok(err instanceof RoleRunError);
  assert.equal(err.phase, 'effect');
  assert.equal(err.verdict.kind, 'task');
  assert.match(err.message, /labelling 'reviewed-ok' failed/);
  assert.equal(err.run?.errorClass, 'task');
  assert.equal(err.run?.inputTokens, 1000, 'the student did run and its usage is kept');
  assert.deepEqual(removed(), ['/wt/study/review-issue-1']);
});

test('review of a PR that merged while the review ran posts nothing', async () => {
  const { slot } = slotFor(fakeHarness('fake-claude', CLAUDE_LIKE), [{ text: 'VERDICT: APPROVE' }]);
  const { hub, calls: h } = fakeGh({ state: 'MERGED' });
  const out = await run('review', 11, slot, fakeGit().git, hub);
  assert.deepEqual(out.effect, { kind: 'settled', state: 'MERGED' });
  assert.deepEqual(h, []);
});

// ---- fix / rewrite ------------------------------------------------------------------

test('fix that pushed a commit records the new head sha on the outcome and clears changes-requested', async () => {
  const { slot, calls } = slotFor(fakeHarness('fake-claude', CLAUDE_LIKE), [{ text: 'renamed' }]);
  const { git, calls: g } = fakeGit({ shas: ['sha-before', 'sha-after'] });
  const { hub, calls: h } = fakeGh();
  const out = await run('fix', 12, slot, git, hub);
  assert.deepEqual(out.effect, { kind: 'fix', changed: true, sha: 'sha-after' });
  assert.equal(out.outcome?.outcome, 'fix-pushed');
  assert.equal(out.outcome?.detail, 'sha-after');
  assert.ok(g.includes('addWorktreeForBranch study/issue-2'));
  assert.ok(g.includes('pushBranch study/issue-2'));
  assert.ok(h.includes('removeLabel pr 12 changes-requested'));
  assert.match(calls[0].prompt, /Please rename foo/);
  assert.equal(out.run?.promptTemplateId, 'fix');
});

test('fix with red CI folds the classified CI log into the prompt; no commit means no outcome', async () => {
  const { slot, calls } = slotFor(fakeHarness('fake-claude', CLAUDE_LIKE), [{ text: 'nothing to do' }]);
  const { git } = fakeGit({ shas: ['same', 'same'] });
  const { hub } = fakeGh();
  const out = await runRole({
    decision: decision('fix', 12), runId: 'r', worker: { id: 'w1', slot },
    repo: repo({ pulls: [pull(12, { statusCheckRollup: 'FAILURE' })] }), pool: POOL,
  }, { git, gh: hub, now: () => NOW });
  assert.deepEqual(out.effect, { kind: 'fix', changed: false, sha: null });
  assert.equal(out.outcome, null);
  assert.match(calls[0].prompt, /expected 1 to be 2/);
  assert.match(out.run?.promptTemplateId ?? '', /^fix:ci-/);
});

test('rewrite uses the rewrite prompt with the round count and is billed as rewrite', async () => {
  const { slot, calls } = slotFor(fakeHarness('fake-claude', CLAUDE_LIKE), [{ text: 'reimplemented' }]);
  const { git } = fakeGit({ shas: ['a', 'b'] });
  const out = await runRole({
    decision: decision('rewrite', 12), runId: 'r', worker: { id: 'w1', slot }, repo: repo(), pool: POOL, rounds: 5,
  }, { git, gh: fakeGh().hub, now: () => NOW });
  assert.equal(out.run?.role, 'rewrite');
  assert.match(calls[0].prompt, /failed review 5 times/);
  assert.equal(out.run?.promptTemplateId, 'rewrite');
});

// ---- resolve -------------------------------------------------------------------------

test('resolve: a conflicted lockfile is regenerated and no student is spent', async () => {
  const { slot, calls } = slotFor(fakeHarness('fake-claude', CLAUDE_LIKE), [{}]);
  const { git, calls: g } = fakeGit({ conflicts: ['package-lock.json'] });
  const out = await run('resolve', 13, slot, git, fakeGh().hub);
  assert.deepEqual(out.effect, { kind: 'resolve', conflicts: true, studentRan: false, regenerated: ['package-lock.json'], regenFailed: [], pushed: true });
  assert.equal(calls.length, 0, 'no student ran');
  assert.ok(g.includes('regenerate package-lock.json'));
  assert.ok(g.includes('finishMergePush study/issue-3'));
  assert.equal(out.run?.notes, 'no student spent (no source conflicts)');
  assert.equal(out.run?.inputTokens, 0);
  assert.equal(out.outcome?.outcome, 'resolved');
});

test('resolve: a regeneration failure restores the conflict and hands it to a student', async () => {
  const { slot, calls } = slotFor(fakeHarness('fake-claude', CLAUDE_LIKE), [{ text: 'resolved by hand' }]);
  const { git } = fakeGit({ conflicts: ['package-lock.json'], regenOk: false });
  const out = await run('resolve', 13, slot, git, fakeGh().hub);
  assert.equal(calls.length, 1);
  assert.match(calls[0].prompt, /Do NOT resolve these generated files by hand/);
  assert.equal(out.effect.kind === 'resolve' && out.effect.studentRan, true);
  assert.deepEqual(out.effect.kind === 'resolve' && out.effect.regenFailed, ['package-lock.json']);
});

test('resolve: source conflicts run the student first, then generated files are regenerated', async () => {
  const { slot, calls } = slotFor(fakeHarness('fake-claude', CLAUDE_LIKE), [{ text: 'fixed src' }]);
  const { git, calls: g } = fakeGit({ conflicts: ['src/a.ts', 'package-lock.json'] });
  const out = await run('resolve', 13, slot, git, fakeGh().hub);
  assert.equal(calls.length, 1);
  assert.match(calls[0].prompt, /package-lock\.json/);
  assert.ok(g.indexOf('regenerate package-lock.json') < g.indexOf('finishMergePush study/issue-3'));
  assert.deepEqual(out.effect.kind === 'resolve' && out.effect.regenerated, ['package-lock.json']);
});

test('resolve: a clean base merge pushes without a student', async () => {
  const { slot, calls } = slotFor(fakeHarness('fake-claude', CLAUDE_LIKE), [{}]);
  const out = await run('resolve', 13, slot, fakeGit().git, fakeGh().hub);
  assert.equal(calls.length, 0);
  assert.equal(out.effect.kind === 'resolve' && out.effect.conflicts, false);
  assert.equal(out.outcome?.detail, 'clean merge');
});

// ---- triage ---------------------------------------------------------------------------

const SPLIT = (n: number) => '```triage-splits\n' + JSON.stringify(Array.from({ length: n }, (_, i) => ({
  title: `Piece ${i + 1}`, body: `## Goal\nPart ${i + 1}.\n\n## Acceptance\n- [ ] a\n- [ ] b`, covers: `criterion ${i + 1}`,
}))) + '\n```';

test('triage with three pieces files three issues in order, labels each, records deps and marks the parent an epic', async () => {
  const { slot, calls } = slotFor(fakeHarness('fake-claude', CLAUDE_LIKE), [{ text: SPLIT(3) }]);
  const { hub, calls: h } = fakeGh();
  const out = await run('triage', 1, slot, fakeGit().git, hub);
  assert.equal(out.effect.kind, 'triage');
  assert.deepEqual(out.effect.kind === 'triage' && out.effect.filed, [201, 202, 203]);
  assert.deepEqual(h.filter((c) => c.startsWith('openIssue')), ['openIssue Piece 1', 'openIssue Piece 2', 'openIssue Piece 3']);
  assert.ok(h.includes('addLabel issue 201 difficulty:simple'));
  assert.ok(h.includes('addLabel issue 203 difficulty:simple'));
  assert.ok(h.includes('addIssueDeps 1 201,202,203'));
  assert.ok(h.includes('addLabel issue 1 triaged'));
  assert.ok(h.includes('addLabel issue 1 epic'));
  assert.equal(out.outcome?.outcome, 'triaged');
  // The student never runs gh: filing came from the port, and the student got only the pool's tools.
  assert.deepEqual(calls[0].opts.tools, ['Bash', 'Read', 'Edit']);
});

test('triage with one usable piece files nothing and the parent keeps only triaged', async () => {
  const { slot } = slotFor(fakeHarness('fake-claude', CLAUDE_LIKE), [{ text: SPLIT(1) }]);
  const { hub, calls: h } = fakeGh();
  const out = await run('triage', 1, slot, fakeGit().git, hub);
  assert.equal(out.effect.kind === 'triage' && out.effect.singlePr, true);
  assert.deepEqual(h, ['addLabel issue 1 triaged']);
});

test('a decision whose subject is gone is skipped without a run', async () => {
  const { slot, calls } = slotFor(fakeHarness('fake-claude', CLAUDE_LIKE), [{}]);
  const out = await run('review', 99, slot, fakeGit().git, fakeGh().hub);
  assert.deepEqual(out, { run: null, outcome: null, effect: { kind: 'skipped', reason: 'PR #99 is not open' } });
  assert.equal(calls.length, 0);
});

test('no transcript dir means no transcript file and a null path', async () => {
  const { slot } = slotFor(fakeHarness('fake-claude', CLAUDE_LIKE), [{ transcript: ['x'] }]);
  const out = await run('implement', 1, slot, fakeGit().git, fakeGh().hub);
  assert.equal(out.run?.transcriptPath, null);
  assert.ok(!existsSync('run-implement-1.jsonl'));
});
