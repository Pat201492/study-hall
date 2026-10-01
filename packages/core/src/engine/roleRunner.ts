import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type {
  AutoCompact, FailureVerdict, QuotaObservation, StudentBudget, Usage, HarnessRunResult,
} from '@study-hall/harness/contract';
import { ZERO_USAGE } from '@study-hall/harness/contract';
import type { WarmSlot } from '@study-hall/harness/warmSlot';
import { fidelityFor } from '@study-hall/harness/registry';
import { toRunRecord, type RunRecord, type OutcomeRecord, type WarmMechanism } from '@study-hall/harness/ledger/index';
import type { Decision } from './boardCycle.js';
import type { ProviderPoolConfig } from '../config.js';
import type { Task } from '../taskmap.js';
import type { RepoClone } from '../worktree.js';
import * as wt from '../worktree.js';
import * as gh from '../github.js';
import type { OpenPull, PullState } from '../github.js';
import { taskPrompt, reviewPrompt, fixPrompt, rewritePrompt, resolvePrompt, triagePrompt } from '../prompts.js';
import { ownedByOthers } from '../ownership.js';
import { classifyEmptyRun, criteriaCount, type EmptyRunVerdict } from '../emptyRun.js';
import { parseVerdict, type ReviewVerdict } from '../gates.js';
import { parseTriage, TRIAGED_LABEL, EPIC_LABEL } from '../triage.js';
import { classifyCiFailure, type CiFailureClass } from '../ciFailure.js';
import { partitionConflicts, DEFAULT_GENERATED_FILES, type GeneratedFileRule, type GeneratedConflict } from '../generated.js';
import { ALREADY_SATISFIED_LABEL, pullIssueNumber } from '../classify.js';
import { expectedDifficulty } from '../difficultyRubric.js';
import { auditSignals } from '../issueAudit.js';
import { difficultyLabel } from '../difficulty.js';
import { repoSlug } from '../github.js';

// ONE parameterised role runner. v1 had four copy-pasted runners
// (runTask/runReview/runFix/runResolve, plus runTriage) that drifted — a fix
// in one never reached the others. Here every role walks the same six steps:
//
//   prepareWorktree -> buildPrompt -> run on the worker's WarmSlot -> effect
//   -> record (ledger run + outcome) -> cleanup (always)
//
// and only the role-specific parts (branch, prompt, effect) are parameterised.
// Git and GitHub go through injected ports so every effect branch, the failure
// routing and the ledger row are testable with fakes and no binary.

export type DispatchDecision = Extract<Decision, { kind: 'dispatch' }>;

export interface RepoContext {
  /** owner/name */
  slug: string;
  /** As configured (URL or slug) — what `gh -R` gets. */
  configured: string;
  clone: RepoClone;
  /** The repo's CLAUDE.md/docs/SPEC.md block for the cached prefix. */
  spec: string;
  tasks: Task[];
  pulls: OpenPull[];
}

export interface GitPort {
  addWorktree(clone: RepoClone, branch: string): Promise<string>;
  addWorktreeForBranch(clone: RepoClone, branch: string): Promise<string>;
  removeWorktree(clone: RepoClone, dir: string): Promise<void>;
  commitAndPush(dir: string, branch: string, message: string): Promise<boolean>;
  headSha(dir: string): Promise<string>;
  pushBranch(dir: string, branch: string): Promise<void>;
  startBaseMerge(clone: RepoClone, dir: string): Promise<{ conflicts: boolean }>;
  conflictedFiles(dir: string): Promise<string[]>;
  regenerateLockfiles(dir: string, generated: GeneratedConflict[]): Promise<wt.RegenResult[]>;
  finishMergePush(dir: string, branch: string, message: string): Promise<void>;
}

export interface GitHubPort {
  issueBody(repo: string, n: number): Promise<string>;
  openPr(repo: string, branch: string, base: string, title: string, body: string): Promise<string>;
  prState(repo: string, n: number): Promise<PullState>;
  approvePr(repo: string, n: number, body: string): Promise<void>;
  requestChangesPr(repo: string, n: number, body: string): Promise<void>;
  commentPr(repo: string, n: number, body: string): Promise<void>;
  commentIssue(repo: string, n: number, body: string): Promise<void>;
  addLabel(repo: string, n: number, label: string, kind: 'issue' | 'pr'): Promise<void>;
  removeLabel(repo: string, n: number, label: string, kind: 'issue' | 'pr'): Promise<void>;
  prReviewFeedback(repo: string, n: number): Promise<string>;
  failingCiLog(repo: string, n: number): Promise<string>;
  openIssue(repo: string, title: string, body: string): Promise<string>;
  addIssueDeps(repo: string, n: number, deps: number[]): Promise<void>;
}

export const realGit: GitPort = {
  addWorktree: wt.addWorktree, addWorktreeForBranch: wt.addWorktreeForBranch, removeWorktree: wt.removeWorktree,
  commitAndPush: wt.commitAndPush, headSha: wt.headSha, pushBranch: wt.pushBranch,
  startBaseMerge: wt.startBaseMerge, conflictedFiles: wt.conflictedFiles,
  regenerateLockfiles: wt.regenerateLockfiles, finishMergePush: wt.finishMergePush,
};

export const realGitHub: GitHubPort = {
  issueBody: async (repo, n) => (await gh.fetchIssueSpec(repo, n))?.body ?? '',
  openPr: gh.openPr, prState: gh.prState,
  approvePr: (repo, n, body) => gh.approvePr(repo, n, body),
  requestChangesPr: (repo, n, body) => gh.requestChangesPr(repo, n, body),
  commentPr: (repo, n, body) => gh.commentPr(repo, n, body),
  commentIssue: (repo, n, body) => gh.commentIssue(repo, n, body),
  addLabel: (repo, n, label, kind) => gh.addLabel(repo, n, label, kind),
  removeLabel: (repo, n, label, kind) => gh.removeLabel(repo, n, label, kind),
  prReviewFeedback: (repo, n) => gh.prReviewFeedback(repo, n),
  failingCiLog: (repo, n) => gh.failingCiLog(repo, n),
  openIssue: (repo, title, body) => gh.openIssue(repo, title, body),
  addIssueDeps: (repo, n, deps) => gh.addIssueDeps(repo, n, deps),
};

export interface RunnerDeps {
  git?: GitPort;
  gh?: GitHubPort;
  log?: (message: string) => void;
  now?: () => number;
  /** Where per-run transcripts go (`<dir>/<runId>.jsonl`); omit to keep none. */
  transcriptDir?: string;
  generatedFiles?: readonly GeneratedFileRule[];
  /** Serialises git operations per clone (worktree add/remove race otherwise). */
  gitLock?: <T>(fn: () => Promise<T>) => Promise<T>;
}

export interface RoleRunInput {
  decision: DispatchDecision;
  /** Minted at dispatch so events and outcomes can reference it before the run ends. */
  runId: string;
  worker: { id: string; slot: WarmSlot };
  repo: RepoContext;
  pool: Pick<ProviderPoolConfig, 'approval' | 'sandbox' | 'tools'>;
  budget?: StudentBudget;
  /** In-session context compaction window, off unless the engine config set it.
   *  A harness that cannot compact ignores it (capabilities.contextCompaction). */
  autoCompact?: AutoCompact;
  /** Failed review rounds so far — the rewrite prompt states it. */
  rounds?: number;
  signal?: AbortSignal;
  onUsage?: (usage: Usage) => void;
  onQuota?: (observation: QuotaObservation) => void;
}

export type Effect =
  | { kind: 'pr-opened'; number: number | null; url: string; branch: string }
  | { kind: 'pushed-no-pr'; branch: string; error: string }
  | { kind: 'already-satisfied'; criteria: number }
  | { kind: 'empty'; verdict: EmptyRunVerdict }
  | { kind: 'review'; verdict: ReviewVerdict; label: string }
  | { kind: 'fix'; changed: boolean; sha: string | null }
  | { kind: 'resolve'; conflicts: boolean; studentRan: boolean; regenerated: string[]; regenFailed: string[]; pushed: boolean }
  | { kind: 'triage'; singlePr: boolean; filed: number[]; reason: string }
  | { kind: 'settled'; state: PullState }
  | { kind: 'skipped'; reason: string };

export interface RoleRunOutput {
  run: RunRecord | null;
  outcome: OutcomeRecord | null;
  effect: Effect;
}

/** A run that failed. The ledger row (if the student ran at all) is attached so
 *  the engine records it; `verdict` is what governance routes on. */
export class RoleRunError extends Error {
  constructor(message: string, readonly verdict: FailureVerdict, readonly run: RunRecord | null, readonly phase: 'prepare' | 'run' | 'effect') {
    super(message);
    this.name = 'RoleRunError';
  }
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function prNumberFromUrl(url: string): number | null {
  const n = Number(url.trim().split('/').pop());
  return Number.isFinite(n) && n > 0 ? n : null;
}

function mechanismOf(slot: WarmSlot): { mechanism: WarmMechanism; seedSessionId: string | null } {
  const session = slot.nextSession();
  if (!session) return { mechanism: 'cold', seedSessionId: null };
  if (session.mode === 'fork') return { mechanism: 'fork', seedSessionId: session.base ?? null };
  if (session.mode === 'resume') return { mechanism: 'resume', seedSessionId: session.base ?? null };
  return session.seed ? { mechanism: 'seed', seedSessionId: session.seed } : { mechanism: 'adopted', seedSessionId: null };
}

function firstLine(s: string): string {
  return (s.split(/\r?\n/).find((l) => l.trim()) ?? '').trim();
}

// ---- the runner -------------------------------------------------------------

export async function runRole(input: RoleRunInput, deps: RunnerDeps = {}): Promise<RoleRunOutput> {
  const git = deps.git ?? realGit;
  const hub = deps.gh ?? realGitHub;
  const log = deps.log ?? (() => {});
  const now = deps.now ?? Date.now;
  const lock = deps.gitLock ?? (<T>(fn: () => Promise<T>) => fn());
  const { decision, repo, worker } = input;
  const a = decision.action;
  const slot = worker.slot;
  const harness = slot.harness;

  const subject = a.target === 'issue'
    ? { task: repo.tasks.find((t) => t.id === `#${a.number}`) ?? null, pr: null }
    : { task: null, pr: repo.pulls.find((p) => p.number === a.number) ?? null };
  if (a.target === 'issue' && !subject.task) return { run: null, outcome: null, effect: { kind: 'skipped', reason: `#${a.number} is not on the task map` } };
  if (a.target === 'pr' && !subject.pr) return { run: null, outcome: null, effect: { kind: 'skipped', reason: `PR #${a.number} is not open` } };

  const pr = subject.pr;
  const task = subject.task;
  const issueNum = pr ? pullIssueNumber(pr) : a.number;
  const issueBody = issueNum != null ? await hub.issueBody(repo.configured, issueNum).catch(() => '') : '';
  const slug = repoSlug(repo.configured);

  // The run row is seeded up front so a failure anywhere still lands a row.
  const seed = {
    runId: input.runId, repo: repo.slug, item: a.number, role: decision.role,
    provider: decision.provider, harness: harness.id, model: decision.model, effort: decision.effort,
    tier: decision.tierLabel ?? decision.tier, meter: 'unknown' as const,
    approval: input.pool.approval, sandbox: input.pool.sandbox,
    toolAllowlist: input.pool.tools?.length ? [...input.pool.tools] : null,
    toolAllowlistEnforced: input.pool.tools?.length ? harness.capabilities.toolAllowlist : null,
    baseSha: null as string | null, worktree: null as string | null, branch: null as string | null,
    promptSha256: null as string | null, promptTemplateId: null as string | null,
    seedSessionId: mechanismOf(slot).seedSessionId,
    warmMechanism: mechanismOf(slot).mechanism,
  };

  let dir: string | null = null;
  let transcript: WriteStream | null = null;
  let transcriptPath: string | null = null;
  const startedAt = new Date(now()).toISOString();

  const finish = async (): Promise<void> => {
    if (transcript) { const t = transcript; transcript = null; await new Promise<void>((r) => t.end(() => r())); }
    if (dir) {
      const d = dir; dir = null;
      await lock(() => git.removeWorktree(repo.clone, d)).catch((e) => log(`${repo.slug}#${a.number}: worktree cleanup failed: ${(e as Error).message}`));
    }
  };

  const failedRow = (verdict: FailureVerdict, message: string): RunRecord => toRunRecord({
    ...seed, startedAt, endedAt: new Date(now()).toISOString(),
    errorClass: verdict.kind, notes: firstLine(message).slice(0, 300), transcriptPath,
  }, null, { fidelity: 'missing', now: new Date(now()) });

  try {
    // ---- 1. worktree ------------------------------------------------------
    let branch: string;
    let regenNames: string[] = [];
    let resolveState: { conflicts: boolean; generated: GeneratedConflict[]; source: string[] } | null = null;
    try {
      switch (decision.role) {
        case 'implement':
          branch = `study/issue-${a.number}`;
          dir = await lock(() => git.addWorktree(repo.clone, branch));
          break;
        case 'triage':
          branch = `triage-${a.number}`;
          dir = await lock(() => git.addWorktree(repo.clone, branch));
          break;
        case 'review':
          branch = `study/review-issue-${issueNum ?? a.number}`;
          dir = await lock(() => git.addWorktree(repo.clone, branch));
          break;
        case 'fix': case 'rewrite':
          branch = pr!.headRefName;
          dir = await lock(() => git.addWorktreeForBranch(repo.clone, branch));
          break;
        case 'resolve': {
          branch = pr!.headRefName;
          dir = await lock(() => git.addWorktreeForBranch(repo.clone, branch));
          const merge = await lock(() => git.startBaseMerge(repo.clone, dir!));
          if (merge.conflicts) {
            const conflicts = await lock(() => git.conflictedFiles(dir!));
            const { generated, source } = partitionConflicts(conflicts, deps.generatedFiles ?? DEFAULT_GENERATED_FILES);
            resolveState = { conflicts: true, generated, source };
            regenNames = generated.map((g) => g.path);
          } else {
            resolveState = { conflicts: false, generated: [], source: [] };
          }
          break;
        }
        default:
          throw new Error(`role ${decision.role} has no runner`);
      }
    } catch (e) {
      const message = (e as Error).message ?? String(e);
      throw new RoleRunError(`${decision.role} #${a.number}: could not prepare worktree: ${message}`, { kind: 'infra', detail: firstLine(message) }, null, 'prepare');
    }
    seed.worktree = dir;
    seed.branch = branch;
    seed.baseSha = await git.headSha(dir).catch(() => '') || null;

    // ---- 2. prompt ------------------------------------------------------------
    let prompt: string;
    let ci: { class: CiFailureClass; log: string } | undefined;
    switch (decision.role) {
      case 'implement':
        prompt = taskPrompt(task!, issueBody, repo.spec, ownedByOthers(repo.tasks, task!.id));
        seed.promptTemplateId = 'implement';
        break;
      case 'triage':
        prompt = triagePrompt(task!, issueBody, repo.spec);
        seed.promptTemplateId = 'triage';
        break;
      case 'review':
        prompt = reviewPrompt(pr!, issueNum, issueBody, slug, repo.spec);
        seed.promptTemplateId = 'review';
        break;
      case 'fix': {
        const feedback = await hub.prReviewFeedback(repo.configured, pr!.number).catch(() => '');
        if (pr!.statusCheckRollup === 'FAILURE') {
          const ciLog = await hub.failingCiLog(repo.configured, pr!.number).catch(() => '');
          if (ciLog.trim()) ci = { class: classifyCiFailure(ciLog), log: ciLog };
        }
        prompt = fixPrompt(pr!, slug, feedback, issueBody, repo.spec, ci);
        seed.promptTemplateId = ci ? `fix:ci-${ci.class}` : 'fix';
        break;
      }
      case 'rewrite': {
        const feedback = await hub.prReviewFeedback(repo.configured, pr!.number).catch(() => '');
        prompt = rewritePrompt(pr!, slug, issueBody, feedback, input.rounds ?? 0, repo.spec);
        seed.promptTemplateId = 'rewrite';
        break;
      }
      case 'resolve':
        prompt = resolvePrompt(pr!, repo.clone.base, issueBody, repo.spec, regenNames);
        seed.promptTemplateId = 'resolve';
        break;
      default:
        throw new Error('unreachable');
    }
    seed.promptSha256 = sha256(prompt);

    // ---- 3. run on the slot --------------------------------------------------
    // Resolve runs a student only when a SOURCE file conflicts; generated
    // lockfiles are rebuilt from their manifest instead (v1 #regenerate).
    let result: HarnessRunResult | null = null;
    let studentRan = false;
    let regenerated: string[] = [];
    let regenFailed: string[] = [];
    const runStudent = async (): Promise<void> => {
      if (deps.transcriptDir) {
        mkdirSync(deps.transcriptDir, { recursive: true });
        transcriptPath = join(deps.transcriptDir, `${input.runId}.jsonl`);
        transcript = createWriteStream(transcriptPath, { flags: 'a' });
      }
      const t = transcript;
      try {
        result = await slot.run(prompt, {
          cwd: dir!, model: decision.model, effort: decision.effort,
          approval: input.pool.approval, sandbox: input.pool.sandbox,
          tools: input.pool.tools?.length ? [...input.pool.tools] : undefined,
          budget: input.budget, autoCompact: input.autoCompact, signal: input.signal,
          transcriptSink: t ? (line) => { t.write(`${line}\n`); } : undefined,
          onUsage: input.onUsage, onQuota: input.onQuota,
          onBudgetStop: (b) => log(`${repo.slug}#${a.number} stopped at ${b.limit} (${b.turns} turns, ${(b.tokens / 1e6).toFixed(1)}M tokens) — banking partial work`),
          onIdleKill: (i) => log(`${repo.slug}#${a.number} student killed after ${i.ticks} silent tick(s)${i.lastText ? ` — last: ${i.lastText.slice(0, 160)}` : ''}`),
        });
        studentRan = true;
      } catch (e) {
        const message = (e as Error)?.message ?? String(e);
        const verdict = harness.classifyFailure(message, now());
        throw new RoleRunError(`${decision.role} #${a.number} failed: ${firstLine(message)}`, verdict, failedRow(verdict, message), 'run');
      }
    };

    if (decision.role === 'resolve' && resolveState) {
      if (resolveState.conflicts) {
        if (resolveState.source.length) await runStudent();
        const regen = resolveState.generated.length ? await lock(() => git.regenerateLockfiles(dir!, resolveState!.generated)) : [];
        regenerated = regen.filter((r) => r.ok).map((r) => r.path);
        regenFailed = regen.filter((r) => !r.ok).map((r) => r.path);
        // A regeneration that failed is a genuine dependency conflict: the
        // `git checkout -m` path restored its markers, so a resolver can see it.
        if (regenFailed.length && !studentRan) await runStudent();
      }
    } else {
      await runStudent();
    }

    // ---- 4. effect -------------------------------------------------------------
    const text = (result as HarnessRunResult | null)?.text ?? '';
    let effect: Effect;
    let outcome: OutcomeRecord | null = null;
    const outcomeBase = { outcomeId: randomUUID(), runId: input.runId, repo: repo.slug, item: a.number, ts: new Date(now()).toISOString() };
    try {
      switch (decision.role) {
        case 'implement': {
          const pushed = await lock(() => git.commitAndPush(dir!, branch, `${task!.title}\n\nCloses ${task!.id}\n\n${text.slice(0, 400)}`));
          if (pushed) {
            const prBody = `Implements ${task!.id}. Closes ${task!.id}.\n\n${text.slice(0, 1500)}`;
            try {
              const url = await hub.openPr(repo.configured, branch, repo.clone.base, task!.title, prBody);
              const number = prNumberFromUrl(url);
              effect = { kind: 'pr-opened', number, url, branch };
              outcome = { ...outcomeBase, outcome: 'pr-opened', prNumber: number, prUrl: url };
            } catch (e) {
              effect = { kind: 'pushed-no-pr', branch, error: (e as Error).message };
            }
          } else {
            const verdict = classifyEmptyRun(text);
            if (verdict === 'satisfied') {
              const criteria = criteriaCount(text);
              await hub.addLabel(repo.configured, a.number, ALREADY_SATISFIED_LABEL, 'issue').catch((e) => log(`#${a.number} ${ALREADY_SATISFIED_LABEL} label failed: ${(e as Error).message}`));
              await hub.commentIssue(repo.configured, a.number,
                `Study Hall dispatched this and the student produced no diff, reporting all **${criteria}** acceptance criteria already met on \`${repo.clone.base}\`.\n\n`
                + `That usually means the work landed under another issue and this one was never closed. Parked as \`${ALREADY_SATISFIED_LABEL}\` so it stops costing dispatches; close it, or remove the label to hand it back.`,
              ).catch(() => undefined);
              effect = { kind: 'already-satisfied', criteria };
              outcome = { ...outcomeBase, outcome: 'empty-diff', detail: `already-satisfied (${criteria} criteria)` };
            } else {
              effect = { kind: 'empty', verdict };
              outcome = { ...outcomeBase, outcome: 'empty-diff', detail: verdict };
            }
          }
          break;
        }
        case 'review': {
          const verdict = parseVerdict(text);
          const state = await hub.prState(repo.configured, pr!.number).catch(() => 'OPEN' as PullState);
          if (state !== 'OPEN') { effect = { kind: 'settled', state }; break; }
          const comments = text.slice(0, 4000);
          const label = verdict === 'APPROVE' ? 'reviewed-ok' : 'changes-requested';
          try {
            if (verdict === 'APPROVE') await hub.approvePr(repo.configured, pr!.number, comments);
            else await hub.requestChangesPr(repo.configured, pr!.number, comments);
          } catch {
            await hub.commentPr(repo.configured, pr!.number, `**Review verdict: ${verdict}**\n\n${comments}`).catch(() => undefined);
          }
          // The label is the DURABLE verdict — classify reads it. A label that
          // did not stick leaves the PR looking unreviewed, so this throws.
          try {
            await hub.addLabel(repo.configured, pr!.number, label, 'pr');
          } catch (e) {
            throw new Error(`#${pr!.number}: review verdict ${verdict} could not be recorded — labelling '${label}' failed (${(e as Error).message})`);
          }
          effect = { kind: 'review', verdict, label };
          outcome = {
            ...outcomeBase, outcome: verdict === 'APPROVE' ? 'review-approve' : 'review-changes',
            prNumber: pr!.number, reviewVerdict: verdict === 'APPROVE' ? 'approved' : 'changes-requested',
          };
          break;
        }
        case 'fix': case 'rewrite': {
          const state = await hub.prState(repo.configured, pr!.number).catch(() => 'OPEN' as PullState);
          if (state !== 'OPEN') { effect = { kind: 'settled', state }; break; }
          const before = seed.baseSha ?? '';
          await lock(() => git.commitAndPush(dir!, branch, `Fix PR #${pr!.number}: address review feedback`)).catch((e) => log(`#${pr!.number} fix commit failed: ${(e as Error).message}`));
          const after = await git.headSha(dir!).catch(() => '');
          const changed = before !== '' && after !== '' && after !== before;
          if (changed) {
            await lock(() => git.pushBranch(dir!, branch)).catch((e) => log(`#${pr!.number} fix push failed: ${(e as Error).message}`));
            await hub.removeLabel(repo.configured, pr!.number, 'changes-requested', 'pr').catch(() => undefined);
            outcome = { ...outcomeBase, outcome: 'fix-pushed', prNumber: pr!.number, detail: after };
          }
          effect = { kind: 'fix', changed, sha: changed ? after : null };
          break;
        }
        case 'resolve': {
          let pushed = false;
          try {
            await lock(() => git.finishMergePush(dir!, branch, `Merge ${repo.clone.base} into ${branch} (resolve conflicts)`));
            pushed = true;
          } catch (e) {
            log(`#${pr!.number} resolve push failed: ${(e as Error).message}`);
          }
          effect = { kind: 'resolve', conflicts: resolveState?.conflicts ?? false, studentRan, regenerated, regenFailed, pushed };
          if (pushed) outcome = { ...outcomeBase, outcome: 'resolved', prNumber: pr!.number, detail: studentRan ? 'student resolved source conflicts' : (resolveState?.conflicts ? 'generated files regenerated' : 'clean merge') };
          break;
        }
        case 'triage': {
          const verdict = parseTriage(text);
          await hub.addLabel(repo.configured, a.number, TRIAGED_LABEL, 'issue').catch((e) => log(`could not mark #${a.number} as ${TRIAGED_LABEL}: ${(e as Error).message}`));
          if (verdict.singlePr) {
            effect = { kind: 'triage', singlePr: true, filed: [], reason: verdict.reason };
            outcome = { ...outcomeBase, outcome: 'triaged', detail: 'single PR' };
            break;
          }
          // The ORCHESTRATOR files the pieces — the student never runs `gh`.
          const filed: number[] = [];
          for (const piece of verdict.splits) {
            const body = `${piece.body}\n\n---\nCarved out of #${a.number} by scope triage. Covers: ${piece.covers}`;
            const url = await hub.openIssue(repo.configured, piece.title, body).catch((e) => { log(`#${a.number} triage: could not file "${piece.title}": ${(e as Error).message}`); return ''; });
            const num = prNumberFromUrl(url);
            if (num == null) continue;
            filed.push(num);
            const level = expectedDifficulty(auditSignals(`${piece.title}\n${body}`));
            await hub.addLabel(repo.configured, num, difficultyLabel(level), 'issue').catch((e) => log(`#${num} filed but could not be labelled: ${(e as Error).message}`));
          }
          if (filed.length < 2) {
            effect = { kind: 'triage', singlePr: false, filed, reason: `proposed ${verdict.splits.length} pieces but only ${filed.length} filed — issue left intact` };
            outcome = { ...outcomeBase, outcome: 'triaged', detail: effect.reason };
            break;
          }
          const depsList = filed.map((f) => `#${f}`).join(', ');
          await hub.addIssueDeps(repo.configured, a.number, filed).catch((e) => log(`#${a.number} triage: pieces filed (${depsList}) but not recorded as dependencies: ${(e as Error).message}`));
          await hub.commentIssue(repo.configured, a.number, [
            `**Scope triage: this issue needs ${filed.length} pull requests, not one.**`, ``, verdict.reason, ``,
            `Carved into ${depsList}. Every acceptance criterion above is carried by exactly one of them —`,
            `nothing was dropped or weakened. This issue now tracks them as an epic and closes when they do.`, ``,
            `If you disagree with the split, close the pieces and remove the \`${EPIC_LABEL}\` label; the`,
            `board will implement this issue directly again.`,
          ].join('\n')).catch(() => undefined);
          await hub.addLabel(repo.configured, a.number, EPIC_LABEL, 'issue').catch((e) => log(`could not mark #${a.number} as ${EPIC_LABEL}: ${(e as Error).message}`));
          effect = { kind: 'triage', singlePr: false, filed, reason: verdict.reason };
          outcome = { ...outcomeBase, outcome: 'triaged', detail: `split into ${depsList}` };
          break;
        }
        default:
          throw new Error('unreachable');
      }
    } catch (e) {
      const message = (e as Error)?.message ?? String(e);
      const r = result as HarnessRunResult | null;
      const row = toRunRecord({
        ...seed, startedAt, endedAt: new Date(now()).toISOString(), durationMs: r?.durationMs,
        apiDurationMs: r?.apiDurationMs ?? null, turns: r?.turns ?? null, sessionId: r?.sessionId || null,
        stoppedBy: r?.stoppedBy ?? null, exitCode: r?.exitCode ?? null, meter: r?.meter ?? 'unknown',
        reportedCostUsd: r?.costUsd ?? null, transcriptPath, errorClass: 'task', notes: `effect failed: ${firstLine(message).slice(0, 280)}`,
      }, r?.usage ?? null, { fidelity: r ? fidelityFor(harness.capabilities) : 'missing', now: new Date(now()) });
      throw new RoleRunError(`${decision.role} #${a.number}: ${firstLine(message)}`, { kind: 'task', detail: firstLine(message) }, row, 'effect');
    }

    // ---- 5. record ---------------------------------------------------------------
    const r = result as HarnessRunResult | null;
    const run = toRunRecord({
      ...seed, startedAt, endedAt: new Date(now()).toISOString(), durationMs: r?.durationMs,
      apiDurationMs: r?.apiDurationMs ?? null, turns: r?.turns ?? null, sessionId: r?.sessionId || null,
      stoppedBy: r?.stoppedBy ?? null, exitCode: r?.exitCode ?? null, meter: r?.meter ?? 'unknown',
      reportedCostUsd: r?.costUsd ?? null, transcriptPath,
      model: r?.model ?? decision.model,
      notes: studentRan ? null : 'no student spent (no source conflicts)',
    }, r?.usage ?? ZERO_USAGE, { fidelity: studentRan ? fidelityFor(harness.capabilities) : 'exact', now: new Date(now()) });
    return { run, outcome, effect };
  } finally {
    // ---- 6. cleanup — on success, failure and cancel alike ------------------
    await finish();
  }
}
