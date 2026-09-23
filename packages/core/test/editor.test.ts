import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Harness, HarnessCapabilities, HarnessRunOptions, HarnessRunResult } from '@study-hall/harness/contract';
import { WarmSlot } from '@study-hall/harness/warmSlot';
import {
  runEditor, parseHandoff, defaultHandoff, workPrompt, parseProposals, enforceCleanTree, adaptChunk,
  PROPOSAL_FENCE, type EditorOptions, type IssueProposal,
} from '../src/editor.js';
import { loadState } from '../src/editorState.js';

const CAPS: HarnessCapabilities = {
  warmSessions: true, seedableSessions: true, forkSessions: true, cacheUsageSplit: true, usageIsCumulative: false,
  reportsCost: true, toolAllowlist: true, mcpToolAllowlist: true, effortControl: true, sandboxModes: ['none'],
  promptTransport: 'stdin', streamsUsage: true, cancellable: true, transcripts: true, budgetStop: true, contextCompaction: false, chat: 'stream-json',
};
const harness: Harness = {
  id: 'fake', provider: 'anthropic', capabilities: CAPS,
  run: async () => { throw new Error('unused'); }, killAll: () => {}, classifyFailure: () => ({ kind: 'task' }), preflight: async () => ({ ok: true }),
};
const USAGE = { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 200, cacheCreationInputTokens: 10, reasoningTokens: 0 };
const tmpHandoff = (): string => join(mkdtempSync(join(tmpdir(), 'editor-')), 'HANDOFF.md');
const handoff = (status: 'CONTINUE' | 'DONE', chunk: number, url?: string): string =>
  ['# Editor Handoff', `Status: ${status}`, `Chunk: ${chunk}`, '', '## Issues filed', url ?? '(none)', ''].join('\n');
const fence = (proposals: IssueProposal[]) => '```' + PROPOSAL_FENCE + '\n' + JSON.stringify(proposals) + '\n```';

/** A slot whose passes rewrite the handoff per script and reply with scripted text. */
function fakeSlot(handoffPath: string, scripts: Array<{ handoff?: string; text?: string; usage?: typeof USAGE }>) {
  const calls: { prompt: string; opts: HarnessRunOptions }[] = [];
  let pass = 0;
  const slot = new WarmSlot({
    harness, id: 'editor-session-1', log: () => {},
    runFn: async (prompt, opts): Promise<HarnessRunResult> => {
      calls.push({ prompt, opts });
      const isSeed = prompt.includes('single word READY');
      let text = 'READY';
      let usage = USAGE;
      if (!isSeed) {
        const s = scripts[pass] ?? scripts[scripts.length - 1];
        if (s.handoff) writeFileSync(handoffPath, s.handoff);
        text = s.text ?? `pass ${pass + 1} summary`;
        usage = s.usage ?? USAGE;
        pass += 1;
      }
      return { text, usage, sessionId: 'editor-session-1', turns: 1, meter: 'subscription', durationMs: 1, exitCode: 0 };
    },
  });
  return { slot, calls };
}
const cleanGit = () => ({ stdout: '', status: 0 });
const base = (handoffPath: string, slot: WarmSlot, over: Partial<EditorOptions> = {}): EditorOptions =>
  ({ goal: 'streamline', cwd: '/repo', handoffPath, slot, git: cleanGit, ...over });

// ---- pure ------------------------------------------------------------------------------------

test('parseHandoff reads status, chunk and issue URLs; defaults to CONTINUE; defaultHandoff embeds the goal and repo', () => {
  assert.equal(parseHandoff('Status: DONE\nChunk: 4\n').status, 'DONE');
  const cont = parseHandoff('Status: CONTINUE\nChunk: 2\nhttps://github.com/o/r/issues/7\n');
  assert.deepEqual(cont.issuesFiled, ['https://github.com/o/r/issues/7']);
  assert.equal(parseHandoff('nonsense').status, 'CONTINUE');
  const h = parseHandoff(defaultHandoff('streamline the app', 'owner/name'));
  assert.equal(h.chunk, 0);
  assert.ok(h.raw.includes('streamline the app') && h.raw.includes('Target repo: owner/name'));
});

test('workPrompt carries the handoff, the chunk bound, the no-filing rule, and the already-filed keys', () => {
  const p = workPrompt('/state/HANDOFF.md', 'RAW-HANDOFF-BODY', 3, 'owner/name', ['extract-page']);
  assert.ok(p.includes('RAW-HANDOFF-BODY') && p.includes('at most 3 changes') && p.includes('Repo under review: owner/name'));
  assert.match(p, /do NOT create issues yourself/i);
  assert.ok(p.includes(PROPOSAL_FENCE) && p.includes('- extract-page'));
  assert.doesNotMatch(workPrompt('/s/H.md', 'B', 2, 'o/n'), /ALREADY been filed/);
});

test('parseProposals reads the fenced block (or a bare JSON fence), tolerates junk, drops keyless entries', () => {
  assert.deepEqual(parseProposals(fence([{ key: 'k', title: 't', body: 'b' }])), [{ key: 'k', title: 't', body: 'b' }]);
  assert.equal(parseProposals('```json\n[{"key":"a","title":"A","body":""}]\n```').length, 1);
  assert.deepEqual(parseProposals('nothing here'), []);
  assert.deepEqual(parseProposals('```editor-proposals\n{oops\n```'), []);
  assert.deepEqual(parseProposals(fence([{ key: '', title: 't', body: 'b' }, { key: 'k', title: '', body: 'b' } as never])), []);
});

test('enforceCleanTree reverts a dirty tree and reports the hit; clean and non-repo trees are no-ops', () => {
  const calls: string[][] = [];
  const dirty = (args: string[]) => { calls.push(args); return { stdout: args[2] === 'status' ? ' M src/a.ts\n' : '', status: 0 }; };
  assert.equal(enforceCleanTree('/wt', dirty), true);
  assert.deepEqual(calls.map((c) => c[2]), ['status', 'checkout', 'clean']);
  assert.equal(enforceCleanTree('/wt', cleanGit), false);
  assert.equal(enforceCleanTree('/wt', () => ({ stdout: '', status: 128 })), false);
});

test('adaptChunk shrinks on a hot pass, grows on a cheap one, within bounds; zero thresholds disable', () => {
  const o = { min: 2, max: 5, growBelow: 1000, shrinkAbove: 5000 };
  assert.equal(adaptChunk(4, 6000, o), 3);
  assert.equal(adaptChunk(2, 6000, o), 2);
  assert.equal(adaptChunk(4, 500, o), 5);
  assert.equal(adaptChunk(5, 500, o), 5);
  assert.equal(adaptChunk(4, 3000, o), 4);
  assert.equal(adaptChunk(4, 6000, { ...o, shrinkAbove: 0 }), 4);
});

// ---- the chain on a WarmSlot ------------------------------------------------------------------

test('runEditor chains passes until DONE; the seed seeds the base and every pass forks off it', async () => {
  const handoffPath = tmpHandoff();
  const { slot, calls } = fakeSlot(handoffPath, [{ handoff: handoff('CONTINUE', 1) }, { handoff: handoff('DONE', 2) }]);
  const seen: number[] = [];
  const r = await runEditor(base(handoffPath, slot, { onProgress: (e) => seen.push(e.instance) }));
  assert.equal(r.status, 'DONE');
  assert.equal(r.instances, 2);
  assert.deepEqual(seen, [1, 2]);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0].opts.session, { mode: 'new', seed: 'editor-session-1' });
  assert.ok(calls[0].prompt.includes('You are the EDITOR'));
  assert.deepEqual(calls[1].opts.session, { mode: 'fork', base: 'editor-session-1' });
  assert.ok(calls[1].prompt.includes('--- HANDOFF.md ---'));
  assert.equal(r.state.sessionId, 'editor-session-1');
  assert.equal(r.state.running, false);
});

test('the chain-length guard, the stall guard and the token budget each stop a run that never reads DONE', async () => {
  let h = tmpHandoff();
  let s = fakeSlot(h, [{ handoff: handoff('CONTINUE', 1) }]);
  let r = await runEditor(base(h, s.slot, { maxInstances: 3, stallPasses: 99 }));
  assert.equal(r.reachedGuard, true);
  assert.equal(r.stoppedBy, 'guard');
  assert.equal(s.calls.length, 4);

  h = tmpHandoff();
  s = fakeSlot(h, [{ handoff: handoff('CONTINUE', 1) }]); // identical handoff every pass = no progress
  r = await runEditor(base(h, s.slot, { maxInstances: 10, stallPasses: 2 }));
  assert.equal(r.stoppedBy, 'stalled');
  assert.equal(r.instances, 3, 'pass 1 advances from the default handoff; passes 2 and 3 do not');

  h = tmpHandoff();
  s = fakeSlot(h, [{ handoff: handoff('CONTINUE', 1) }, { handoff: handoff('CONTINUE', 2) }, { handoff: handoff('CONTINUE', 3) }]);
  r = await runEditor(base(h, s.slot, { maxInstances: 10, stallPasses: 99, budgetTokens: 250 }));
  assert.equal(r.stoppedBy, 'budget');
  assert.equal(r.instances, 2, '150 tokens per pass: the third would exceed 250');
  const h4 = tmpHandoff();
  r = await runEditor(base(h4, fakeSlot(h4, [{ handoff: handoff('DONE', 1) }]).slot, { budgetTokens: 0 }));
  assert.equal(r.status, 'DONE', 'a zero budget means unbounded');
});

test('the orchestrator files proposals through the port with labels, dedupes across passes, and skips when there is no repo', async () => {
  const h = tmpHandoff();
  const s = fakeSlot(h, [
    { handoff: handoff('CONTINUE', 1), text: fence([{ key: 'Extract Page', title: 'Extract the page', body: 'why' }, { key: 'dup', title: 'Dup', body: 'b' }]) },
    { handoff: handoff('DONE', 2), text: fence([{ key: 'extract-page', title: 'Extract the page again', body: 'why' }, { key: 'new-one', title: 'New', body: 'b' }]) },
  ]);
  const filed: string[][] = [];
  const ensured: string[] = [];
  const r = await runEditor(base(h, s.slot, {
    repo: 'o/r', label: 'editor-proposed', extraLabels: ['needs-human', 'editor-proposed'],
    ensureLabel: async (_r, l) => { ensured.push(l); },
    file: async (_repo, proposals, labels) => { filed.push([labels.join('+'), ...proposals.map((p) => p.key)]); return proposals.filter((p) => p.key !== 'dup').map((p, i) => ({ key: p.key, url: `https://github.com/o/r/issues/${10 + i}`, number: 10 + i })); },
  }));
  assert.deepEqual(ensured, ['editor-proposed', 'needs-human'], 'labels ensured once, the marker not duplicated');
  assert.deepEqual(filed, [['editor-proposed+needs-human', 'extract-page', 'dup'], ['editor-proposed+needs-human', 'new-one']], 'pass 2 re-proposed extract-page and it was deduped before filing');
  assert.equal(r.deduped, 1);
  assert.deepEqual(r.state.filed.map((f) => f.key), ['extract-page', 'new-one']);
  assert.equal(r.state.passes[0].skipped, 1, 'a proposal the port did not file is skipped, not lost');

  const noRepo = fakeSlot(h, [{ handoff: handoff('DONE', 1), text: fence([{ key: 'k', title: 't', body: 'b' }]) }]);
  const r2 = await runEditor(base(tmpHandoff(), noRepo.slot));
  assert.equal(r2.filed.length, 0);
  assert.equal(r2.state.passes[0].skipped, 1);
});

test('a dirty tree is reverted and counted; the next chunk reflects the previous pass usage', async () => {
  const h = tmpHandoff();
  const s = fakeSlot(h, [
    { handoff: handoff('CONTINUE', 1), usage: { ...USAGE, inputTokens: 9000 } },
    { handoff: handoff('DONE', 2) },
  ]);
  let dirtyOnce = true;
  const git = (args: string[]) => { if (args[2] === 'status' && dirtyOnce) { dirtyOnce = false; return { stdout: ' M a\n', status: 0 }; } return { stdout: '', status: 0 }; };
  const chunks: number[] = [];
  const r = await runEditor(base(h, s.slot, { git, maxIssuesPerChunk: 5, minIssuesPerChunk: 2, chunkShrinkAboveTokens: 5000, onProgress: (e) => chunks.push(e.maxIssuesPerChunk) }));
  assert.equal(r.guardrailHits, 1);
  assert.equal(r.state.passes[0].guardrailHit, true);
  assert.deepEqual(chunks, [5, 4], 'the hot first pass shrank the second chunk');
});

test('state persists per pass, a resumed run keeps the ledger and the warm id, and a corrupt file degrades to fresh', async () => {
  const h = tmpHandoff();
  const statePath = h.replace(/HANDOFF\.md$/, 'editor-status.json');
  const s = fakeSlot(h, [{ handoff: handoff('CONTINUE', 1), text: fence([{ key: 'k1', title: 'One', body: 'b' }]) }]);
  await runEditor(base(h, s.slot, { repo: 'o/r', maxInstances: 1, file: async (_r, ps) => ps.map((p) => ({ key: p.key, url: 'https://github.com/o/r/issues/1', number: 1 })), ensureLabel: async () => {} }));
  const st = loadState(statePath)!;
  assert.equal(st.instances, 1);
  assert.deepEqual(st.filed.map((f) => f.key), ['k1']);
  assert.equal(st.stoppedBy, 'guard');

  // Resume: the same slot id, the ledger carried, k1 never re-filed.
  const again = fakeSlot(h, [{ handoff: handoff('DONE', 2), text: fence([{ key: 'k1', title: 'One', body: 'b' }, { key: 'k2', title: 'Two', body: 'b' }]) }]);
  const filedKeys: string[] = [];
  const r = await runEditor(base(h, again.slot, { repo: 'o/r', maxInstances: 5, file: async (_r, ps) => { filedKeys.push(...ps.map((p) => p.key)); return ps.map((p) => ({ key: p.key, url: 'u', number: 2 })); }, ensureLabel: async () => {} }));
  assert.deepEqual(filedKeys, ['k2']);
  assert.equal(r.state.instances, 2);
  assert.equal(r.deduped, 1);
  assert.ok(again.calls[0].prompt.includes('single word READY'), 'a resumed run still seeds its (restored) warm base');

  writeFileSync(statePath, '{ not json');
  writeFileSync(h, handoff('CONTINUE', 0)); // the previous run left it DONE
  const fresh = await runEditor(base(h, fakeSlot(h, [{ handoff: handoff('DONE', 1) }]).slot));
  assert.equal(fresh.state.instances, 1);
  assert.equal(readFileSync(statePath, 'utf8').includes('"instances": 1'), true);
});
