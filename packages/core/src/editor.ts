import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Usage } from '@study-hall/harness/contract';
import type { WarmSlot, WarmRunOptions } from '@study-hall/harness/warmSlot';
import { EDITOR_ROLE } from './roles.js';
import { openIssue, addLabel, ensureLabels } from './github.js';
import {
  loadState, saveState, emptyState, filedKeys, normalizeKey,
  type EditorState, type EditorStatus, type EditorStoppedBy, type PassRecord,
} from './editorState.js';

// The Editor (ported from v1 editor.ts onto the harness contract): an
// architect-altitude reviewer that reads a repo and PROPOSES issues in bounded
// chunks, handing itself off through HANDOFF.md between passes. The instance
// proposes; the orchestrator files — an instance running its own `gh` cannot
// dedupe against what a wiped predecessor already filed, and a human reviewing
// drafts is the review gate the whole engine is built on.
//
// v2 changes: the passes run on a WarmSlot (seed once, fork per pass, on ANY
// provider), and filing is an injected port so the dashboard routes proposals
// through the planner's fileBatch — one filing implementation, one ledger.

export interface EditorHandoff {
  status: EditorStatus;
  chunk: number;
  issuesFiled: string[];
  raw: string;
}

export interface IssueProposal {
  /** Stable idempotency key for the change — the dedupe unit across passes. */
  key: string;
  title: string;
  body: string;
}

export interface FiledProposal {
  key: string;
  url: string;
  number: number | null;
}

export interface EditorProgress {
  instance: number;
  status: EditorStatus;
  chunk: number;
  usage: Usage;
  text: string;
  filed: string[];
  skipped: number;
  guardrailHit: boolean;
  maxIssuesPerChunk: number;
}

export interface EditorResult {
  status: EditorStatus;
  instances: number;
  handoff: EditorHandoff;
  reachedGuard: boolean;
  stoppedBy: EditorStoppedBy;
  guardrailHits: number;
  filed: string[];
  deduped: number;
  tokensSpent: number;
  state: EditorState;
}

/** Injectable process runner so the tree guardrail is testable without a repo. */
export type GitRunner = (args: string[]) => { stdout: string; status: number };

const realGit: GitRunner = (args) => {
  const r = spawnSync('git', args, { windowsHide: true, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  return { stdout: r.stdout ?? '', status: r.status ?? 1 };
};

/** Files proposals for a pass: the orchestrator's seam. Returns one record per key it FILED;
 *  a key it skipped or failed is simply absent (and is retried by a later pass). */
export type ProposalFiler = (repo: string, proposals: IssueProposal[], labels: string[]) => Promise<FiledProposal[]>;

/** v1 behaviour: file each proposal with gh and label it. */
export const ghProposalFiler: ProposalFiler = async (repo, proposals, labels) => {
  const out: FiledProposal[] = [];
  for (const p of proposals) {
    try {
      const url = await openIssue(repo, p.title, proposalBody(p, normalizeKey(p.key)));
      const number = issueNumberFromUrl(url);
      if (number != null) for (const l of labels) await addLabel(repo, number, l, 'issue').catch(() => undefined);
      out.push({ key: normalizeKey(p.key), url, number });
    } catch { /* skipped this pass; a later pass proposes it again */ }
  }
  return out;
};

export interface EditorOptions {
  /** The revamp objective. Required. */
  goal: string;
  /** Target repo (owner/name) the proposals are filed to. Omit = propose only. */
  repo?: string;
  /** The repo checkout the Editor reads (its CLI cwd). */
  cwd: string;
  /** Absolute path to HANDOFF.md — kept OUTSIDE the repo so the tree stays clean. */
  handoffPath: string;
  /** Durable state (filed-issue ledger). Defaults to editor-status.json beside the handoff. */
  statePath?: string;
  /** The warm slot the passes run on; the caller builds it on the chosen provider's harness. */
  slot: WarmSlot;
  run?: Omit<WarmRunOptions, 'cwd'>;
  maxInstances?: number;
  maxIssuesPerChunk?: number;
  minIssuesPerChunk?: number;
  stallPasses?: number;
  chunkGrowBelowTokens?: number;
  chunkShrinkAboveTokens?: number;
  /** Whole-run token budget; 0 = unbounded. */
  budgetTokens?: number;
  /** Label applied to every filed issue. Default 'editor-proposed'. */
  label?: string;
  /** Extra labels (the automatic path files PARKED: 'needs-human'). */
  extraLabels?: string[];
  git?: GitRunner;
  file?: ProposalFiler;
  ensureLabel?: (repo: string, label: string) => Promise<void>;
  onProgress?: (e: EditorProgress) => void;
  now?: () => string;
  signal?: AbortSignal;
}

const SEED_ACK =
  'Reply with the single word READY. Do NOT review code, file any issue, or write ' +
  'any file yet — wait for the work instructions in the next message.';

const ISSUE_URL_RE = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+/g;

export function defaultHandoff(goal: string, repo?: string): string {
  return [
    '# Editor Handoff', 'Status: CONTINUE', 'Chunk: 0',
    ...(repo ? [`Target repo: ${repo}`] : []),
    '', '## Goal', goal, '',
    '## Covered so far', '(nothing yet)', '',
    '## Issues filed', '(none yet)', '',
    '## Next frontier', '(start with the highest architectural-risk area of the project)', '',
    '## How',
    'Review architecture + whole project scope with the Goal in mind. File a GitHub',
    'issue for every change; split a big change into multiple linked issues. Cover',
    'one bounded chunk, then rewrite this file for the next instance.', '',
  ].join('\n');
}

/** Absent/garbled → CONTINUE, so a malformed handoff keeps the chain alive
 *  (guarded by maxInstances) rather than silently declaring the job done. */
export function parseHandoff(raw: string): EditorHandoff {
  const status: EditorStatus = /^\s*Status:\s*DONE\s*$/im.test(raw) ? 'DONE' : 'CONTINUE';
  const chunkM = raw.match(/^\s*Chunk:\s*(\d+)/im);
  const issuesFiled = [...new Set(raw.match(ISSUE_URL_RE) ?? [])];
  return { status, chunk: chunkM ? Number(chunkM[1]) : 0, issuesFiled, raw };
}

function readHandoff(path: string, goal: string, repo?: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : defaultHandoff(goal, repo);
}

export const PROPOSAL_FENCE = 'editor-proposals';

export function workPrompt(
  handoffPath: string, handoffRaw: string, maxIssues: number, repo?: string, alreadyFiled: string[] = [],
): string {
  return [
    'Continue the Editor run. The ONLY context you carry from prior instances is',
    `this handoff (also on disk at ${handoffPath}):`, '',
    '--- HANDOFF.md ---', handoffRaw, '--- end HANDOFF.md ---', '',
    ...(repo ? [`Repo under review: ${repo}.`, ''] : []),
    ...(alreadyFiled.length
      ? ['These change keys have ALREADY been filed in earlier passes. Do not propose',
        'them again — pick up beyond them:', ...alreadyFiled.map((k) => `  - ${k}`), '']
      : []),
    'Do this pass, in order:',
    `1. Pick up at "Next frontier". Cover ONE bounded chunk — at most ${maxIssues} changes.`,
    '2. Do NOT run `gh`, do NOT create issues yourself, write NO code, and open NO',
    '   pull requests. You PROPOSE; the orchestrator files. Leave the working tree',
    '   exactly as you found it — a dirty tree is reverted and the pass is flagged.',
    `3. Overwrite ${handoffPath}: update "Covered so far", rewrite "Next frontier",`,
    '   and increment Chunk.',
    '4. Set the Status line: `Status: DONE` ONLY if the entire project scope is now',
    '   covered; otherwise `Status: CONTINUE`.', '',
    'Then reply with a one-paragraph summary followed by your proposals as a single',
    `fenced \`\`\`${PROPOSAL_FENCE} block containing a JSON array. Each element:`,
    '  {"key": "<stable-slug>", "title": "<issue title>", "body": "<## Goal / ## Deliverables / ## Acceptance>"}',
    'The key is an idempotency key — a short stable slug for the CHANGE itself',
    '(e.g. "dashboard-extract-page-html"), so a later pass proposing the same change',
    'is recognized as a duplicate. Emit an empty array if you have nothing to propose.',
  ].join('\n');
}

/** Tolerant by design: no fence, a malformed fence or invalid JSON yields []
 *  — a bad reply reads as a no-progress pass, which the stall guard handles. */
export function parseProposals(text: string): IssueProposal[] {
  const fence = new RegExp('```' + PROPOSAL_FENCE + '\\s*([\\s\\S]*?)```', 'i');
  const m = text.match(fence);
  const raw = m ? m[1] : (text.match(/```(?:json)?\s*(\[[\s\S]*?\])\s*```/)?.[1] ?? '');
  if (!raw.trim()) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
    .map((p) => ({ key: String(p.key ?? '').trim(), title: String(p.title ?? '').trim(), body: String(p.body ?? '').trim() }))
    .filter((p) => p.key && p.title);
}

/** The no-code guardrail: the Editor is only safe BECAUSE it writes no code, so
 *  that is enforced rather than requested. True if the pass dirtied the tree
 *  (which has then been reverted). */
export function enforceCleanTree(cwd: string, git: GitRunner = realGit): boolean {
  const status = git(['-C', cwd, 'status', '--porcelain']);
  if (status.status !== 0) return false;
  if (!status.stdout.trim()) return false;
  git(['-C', cwd, 'checkout', '--', '.']);
  git(['-C', cwd, 'clean', '-fd']);
  return true;
}

/** Adaptive scope-chunk sizing: a hot pass gets a smaller next chunk, a cheap
 *  one a bigger one; a zero threshold disables that direction. */
export function adaptChunk(
  current: number, passTokens: number,
  o: { min: number; max: number; growBelow: number; shrinkAbove: number },
): number {
  if (o.shrinkAbove > 0 && passTokens > o.shrinkAbove) return Math.max(o.min, current - 1);
  if (o.growBelow > 0 && passTokens < o.growBelow) return Math.min(o.max, current + 1);
  return current;
}

export function proposalBody(p: IssueProposal, key: string): string {
  return `${p.body}\n\n<!-- editor-key: ${key} -->`;
}

export function issueNumberFromUrl(url: string): number | null {
  const n = Number(url.trim().split('/').pop());
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function editorStatePath(handoffPath: string): string {
  return handoffPath.replace(/HANDOFF\.md$/i, 'editor-status.json');
}

/**
 * Run an Editor chain to completion or the first guard that fires. Seeds the
 * warm base once, then forks a work-pass per chunk until the handoff reads DONE.
 * Stops on: DONE, the chain-length guard, N no-progress passes, a spent token
 * budget, or an abort signal.
 */
export async function runEditor(opts: EditorOptions): Promise<EditorResult> {
  if (!opts.goal.trim()) throw new Error('runEditor: goal is required.');
  const maxInstances = opts.maxInstances ?? 12;
  const minIssues = opts.minIssuesPerChunk ?? 2;
  const startChunkSize = opts.maxIssuesPerChunk ?? 5;
  const stallLimit = opts.stallPasses ?? 2;
  const budget = opts.budgetTokens ?? 0;
  const label = opts.label ?? 'editor-proposed';
  const extraLabels = (opts.extraLabels ?? []).filter((l) => l && l !== label);
  const { cwd, handoffPath, goal, slot } = opts;
  const statePath = opts.statePath ?? editorStatePath(handoffPath);
  const now = opts.now ?? (() => new Date().toISOString());
  const git = opts.git ?? realGit;
  const file = opts.file ?? ghProposalFiler;
  const ensureIssueLabel = opts.ensureLabel ?? (async (repo, l) => { await ensureLabels(repo, undefined, [l]); });

  const prior = loadState(statePath);
  const state: EditorState = prior ?? emptyState(goal, opts.repo ?? '', slot.id, now());
  state.sessionId = slot.id;
  state.provider = slot.harness.provider;
  state.harness = slot.harness.id;
  state.running = true;
  state.stoppedBy = '';
  saveState(statePath, state);

  const runOpts: WarmRunOptions = { ...(opts.run ?? {}), cwd, signal: opts.signal };
  if (!existsSync(handoffPath)) {
    mkdirSync(dirname(handoffPath), { recursive: true });
    writeFileSync(handoffPath, defaultHandoff(goal, opts.repo));
  }
  if (opts.repo) for (const l of [label, ...extraLabels]) await ensureIssueLabel(opts.repo, l).catch(() => undefined);

  let stoppedBy: EditorStoppedBy = '';
  const runFiled: string[] = [];
  let deduped = 0;
  let instance = state.instances;
  let handoff = parseHandoff(readHandoff(handoffPath, goal, opts.repo));
  try {
    // Seed the base (the role prefix is what the later forks re-hit).
    await slot.run(`${EDITOR_ROLE}\n\n${SEED_ACK}`, runOpts);
    let chunkSize = startChunkSize;
    let noProgress = 0;
    const already = filedKeys(state);
    let prevHandoffRaw = handoff.raw;

    while (handoff.status === 'CONTINUE') {
      if (opts.signal?.aborted) { stoppedBy = 'cancelled'; break; }
      if (instance >= maxInstances) { stoppedBy = 'guard'; break; }
      if (budget > 0 && state.totalInputTokens + state.totalOutputTokens >= budget) { stoppedBy = 'budget'; break; }
      instance += 1;
      const result = await slot.run(workPrompt(handoffPath, handoff.raw, chunkSize, opts.repo, [...already]), runOpts);
      if (result.stoppedBy === 'cancelled') stoppedBy = 'cancelled';
      const guardrailHit = enforceCleanTree(cwd, git);
      if (guardrailHit) state.guardrailHits += 1;

      const proposals = parseProposals(result.text);
      const fresh: IssueProposal[] = [];
      let passSkipped = 0;
      for (const p of proposals) {
        const key = normalizeKey(p.key);
        if (already.has(key)) { passSkipped += 1; deduped += 1; continue; }
        fresh.push({ ...p, key });
      }
      const passFiled: string[] = [];
      if (fresh.length && opts.repo) {
        const filed = await file(opts.repo, fresh, [label, ...extraLabels]).catch(() => [] as FiledProposal[]);
        const byKey = new Map(filed.map((f) => [normalizeKey(f.key), f]));
        for (const p of fresh) {
          const f = byKey.get(p.key);
          if (!f) { passSkipped += 1; continue; }
          already.add(p.key);
          state.filed.push({ key: p.key, title: p.title, url: f.url, instance });
          passFiled.push(f.url);
          runFiled.push(f.url);
        }
      } else {
        passSkipped += fresh.length; // nowhere to file: proposals are skipped, not lost — the next pass re-proposes
      }

      handoff = parseHandoff(readHandoff(handoffPath, goal, opts.repo));
      const advanced = handoff.raw !== prevHandoffRaw || passFiled.length > 0;
      noProgress = advanced ? 0 : noProgress + 1;
      prevHandoffRaw = handoff.raw;

      const record: PassRecord = {
        instance, status: handoff.status, chunk: handoff.chunk, maxIssuesPerChunk: chunkSize,
        inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens,
        filed: passFiled.length, skipped: passSkipped, guardrailHit, provider: slot.harness.provider,
      };
      state.passes.push(record);
      state.instances = instance;
      state.totalInputTokens += result.usage.inputTokens;
      state.totalOutputTokens += result.usage.outputTokens;
      state.status = handoff.status;
      state.handoff = handoff.raw;
      state.updatedAt = now();
      saveState(statePath, state);
      opts.onProgress?.({ instance, status: handoff.status, chunk: handoff.chunk, usage: result.usage, text: result.text, filed: passFiled, skipped: passSkipped, guardrailHit, maxIssuesPerChunk: chunkSize });

      if (stoppedBy === 'cancelled') break;
      if (noProgress >= stallLimit) { stoppedBy = 'stalled'; break; }
      chunkSize = adaptChunk(chunkSize, result.usage.inputTokens + result.usage.outputTokens, {
        min: minIssues, max: startChunkSize, growBelow: opts.chunkGrowBelowTokens ?? 0, shrinkAbove: opts.chunkShrinkAboveTokens ?? 0,
      });
    }
  } finally {
    state.status = handoff.status;
    state.stoppedBy = stoppedBy;
    state.running = false;
    state.updatedAt = now();
    saveState(statePath, state);
  }

  return {
    status: handoff.status, instances: instance, handoff, reachedGuard: stoppedBy === 'guard', stoppedBy,
    guardrailHits: state.guardrailHits, filed: runFiled, deduped,
    tokensSpent: state.totalInputTokens + state.totalOutputTokens, state,
  };
}
