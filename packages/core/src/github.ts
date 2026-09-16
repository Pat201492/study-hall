import type { ParentClosure } from './carveOut.js';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { normalizeRepo } from './repo.js';
import type { OptimizationMode } from './optimizer.js';
import { type Difficulty, tierForDifficulty } from './difficulty.js';
import { effectiveDifficulty, type AcTieringConfig } from './difficultyRubric.js';
import { auditSignals } from './issueAudit.js';
import type { Task, TaskMap } from './taskmap.js';

// GitHub-as-queue ingestion: turn a repo's open issues into the Task Map the
// live Protector executes, and open a PR per finished task. Shells out to the
// authenticated `gh` CLI — no octokit dependency, same tool the
// claude-queue-runner uses. Every call is scoped to one repo slug (owner/name).
//
// PR-ONLY by design: this module NEVER merges. A finished task opens a PR and
// stops; a human reviews and merges. Merging a dependency's PR closes its issue
// (via "Closes #N"), which drops it from the open set on the next ingest and so
// unblocks its dependents. No autonomous, review-bypassing self-merge.

const execFileAsync = promisify(execFile);

// An injectable `gh` runner: takes an argv array, resolves to raw stdout. The
// real one is `gh` below; tests pass a fake so the JSON parsing is exercised
// with no `gh` binary. Every helper takes this as its last (defaulted) arg.
export type GhRunner = (args: string[]) => Promise<string>;

export interface RawIssue {
  number: number;
  title: string;
  body: string;
  labels: { name: string }[];
}

// No shell:true — gh is a real gh.exe on PATH, so args pass through as an
// argv array with NO shell parsing. That matters: openPr() forwards
// model-generated PR title/body here, and shell:true would let a '&', '|', '%'
// or quote in that text break the command (or inject). Array args are literal.
const gh: GhRunner = async (args) => {
  const { stdout } = await execFileAsync('gh', args, {
    maxBuffer: 20 * 1024 * 1024,
  });
  return stdout;
};

export function repoSlug(repo: string): string {
  return normalizeRepo(repo);
}

// Open a new issue on `repo` (owner/name or a github.com URL). The watchdog uses
// this to file an auto error-report when it isolates a stuck board item or kills
// the engine. Returns the new issue's URL (gh prints it to stdout).
export async function openIssue(repo: string, title: string, body: string, run: GhRunner = gh): Promise<string> {
  const out = await run(['issue', 'create', '-R', repoSlug(repo), '--title', title, '--body', body]);
  return out.trim();
}

// URL of an OPEN issue whose title matches exactly, or null. Exact match (not
// gh's fuzzy --search) so a report for `stuck item REVIEW:pr-112` never collides
// with the one for `pr-113`.
export async function findOpenIssueByTitle(
  repo: string, title: string, run: GhRunner = gh,
): Promise<string | null> {
  const out = await run([
    'issue', 'list', '-R', repoSlug(repo), '--state', 'open',
    '--limit', '200', '--json', 'title,url',
  ]);
  const raw = JSON.parse(out) as { title?: string; url?: string }[];
  const want = title.trim();
  return raw.find((i) => (i.title ?? '').trim() === want)?.url ?? null;
}

// openIssue, deduped by exact title. The watchdog re-derives its state from
// scratch on every process start (its `reported` set is in-memory), so a run
// that keeps wedging on the same board files the SAME report every restart —
// three restarts left three identical `[watchdog] engine killed: ...` issues.
// Reuse the open one instead. `created` lets the caller log "filed" vs "already
// open" rather than claiming a new report each time.
export async function openIssueOnce(
  repo: string, title: string, body: string, run: GhRunner = gh,
): Promise<{ url: string; created: boolean }> {
  // A failed lookup must not swallow the report — fall through and file it.
  const existing = await findOpenIssueByTitle(repo, title, run).catch(() => null);
  if (existing) return { url: existing, created: false };
  return { url: await openIssue(repo, title, body, run), created: true };
}

// Close an issue the engine itself filed.
//
// Used only for watchdog reports, whose subject has demonstrably resolved.
// `completed` rather than `not planned`: the report did its job and the thing
// it reported is fixed.
export async function closeIssue(
  repo: string, n: number, comment: string, run: GhRunner = gh,
): Promise<void> {
  // Comment BEFORE closing, so the reason is on the issue even if the close
  // fails -- a silently closed report teaches an operator nothing.
  await run(['issue', 'comment', String(n), '-R', repoSlug(repo), '--body', comment]);
  await run(['issue', 'close', String(n), '-R', repoSlug(repo), '--reason', 'completed']);
}

// The engine's own open watchdog reports in the report repo, title only.
export async function openWatchdogReports(
  repo: string, run: GhRunner = gh,
): Promise<{ number: number; title: string }[]> {
  const out = await run([
    'issue', 'list', '-R', repoSlug(repo), '--state', 'open',
    '--limit', '300', '--json', 'number,title',
  ]);
  const rows = JSON.parse(out) as { number: number; title: string }[];
  return rows.filter((r) => typeof r.title === 'string' && r.title.startsWith('[watchdog]'));
}

// All OPEN issues for the repo (pull requests are excluded by `gh issue list`).
/**
 * Every issue, open and closed, with whether a merged PR closed it.
 *
 * The planner's other reader wants open issues only (duplicates, live `Owns:`
 * claims). The spec mirror wants the whole history, because a mirror built from
 * open issues alone describes a project nobody has built yet.
 */
export async function fetchAllIssues(repo: string, limit = 500): Promise<(RawIssue & { state: 'open' | 'closed'; merged: boolean })[]> {
  const slug = repoSlug(repo);
  const out = await gh([
    'issue', 'list', '-R', slug, '--state', 'all',
    '--limit', String(limit), '--json', 'number,title,body,labels,state,stateReason,closedByPullRequestsReferences',
  ]);
  const raw = JSON.parse(out) as (RawIssue & { state?: string; stateReason?: string | null; closedByPullRequestsReferences?: { number?: number; state?: string }[] })[];
  return raw.map((i) => ({
    ...i,
    body: i.body ?? '',
    labels: i.labels ?? [],
    state: (i.state ?? '').toUpperCase() === 'CLOSED' ? 'closed' as const : 'open' as const,
    // A PR reference alone is not a merge; `gh` reports the PR's own state.
    merged: (i.closedByPullRequestsReferences ?? []).some((p) => (p.state ?? '').toUpperCase() === 'MERGED'),
  }));
}

export async function fetchIssues(repo: string): Promise<RawIssue[]> {
  const slug = repoSlug(repo);
  const out = await gh([
    'issue', 'list', '-R', slug, '--state', 'open',
    '--limit', '200', '--json', 'number,title,body,labels',
  ]);
  const raw = JSON.parse(out) as RawIssue[];
  return raw.map((i) => ({ ...i, body: i.body ?? '', labels: i.labels ?? [] }));
}

// "Depends on #N" lines in the body -> dependency task ids (as "#N").
//
// Reads BOTH the bare form the engine writes (`Depends on #12`, addIssueDeps
// below) and the colon form the rubric, EDITOR_ROLE and the planner prescribe
// (`Depends on: #12`), and takes EVERY number on the line (`#12, #13` and
// `#12 #13`), not just the first. v1's regex (`/depends on #(\d+)/gi`) accepted
// neither, so only engine-authored deps ever gated dispatch: a human- or
// Editor-filed `Depends on: #5` parsed to nothing and the dependent was built
// before its dependency landed. Same-line only (a `#N` on the next line is not
// a dependency), order-preserving and de-duplicated.
export function parseDeps(body: string): string[] {
  const deps = new Set<string>();
  const re = /depends on:?[ \t]*((?:#\d+(?:[ \t]*,?[ \t]*(?:and[ \t]+)?))+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    for (const n of m[1].matchAll(/#(\d+)/g)) deps.add(`#${n[1]}`);
  }
  return [...deps];
}

// "Owns: a, b, tests/**" footer lines -> the file globs this issue owns (#176).
//
// Parsed like `Depends on #N`: any line whose first token is `Owns:` (optionally
// bulleted), comma-separated globs after it. An issue may carry several. Declaring
// ownership lets the scheduler tell every OTHER in-flight task "these files belong
// to someone else, do not create or edit them" — so two tasks never both invent
// the same config file (PR #57 built the test harness #56 owned, then #56 spent
// the night re-conflicting on it). Order-preserving and de-duplicated.
export function parseOwns(body: string): string[] {
  const out: string[] = [];
  const re = /^\s*(?:[-*]\s*)?owns:\s*(.+)$/gim;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    for (const part of m[1].split(',')) {
      const f = part.trim().replace(/^`+|`+$/g, '').trim();
      if (f) out.push(f);
    }
  }
  return [...new Set(out)];
}

// Difficulty for tiering: an explicit `difficulty:simple|standard|hard` (or a
// bare `simple|standard|hard`) label wins; otherwise infer from title+body.
export function difficultyFromLabels(labels: { name: string }[]): Difficulty | undefined {
  for (const { name } of labels) {
    const n = name.toLowerCase().replace(/^difficulty:/, '');
    if (n === 'simple' || n === 'standard' || n === 'hard') return n;
  }
  return undefined;
}

// A `model:opus|sonnet|haiku` label pins the tier (mirrors the runner's pin
// convention) — the Protector's retiering leaves pinned tasks alone.
function pinFromLabels(labels: { name: string }[]): 'haiku' | 'sonnet' | 'opus' | undefined {
  for (const { name } of labels) {
    const m = name.toLowerCase().match(/^model:(haiku|sonnet|opus)$/);
    if (m) return m[1] as 'haiku' | 'sonnet' | 'opus';
  }
  return undefined;
}

// Map one issue to a Task. Difficulty drives the tier via the current toggle
// (unless a model: label pins it). Every task starts as an `implement` at the
// `ready` stage; dependency gating (isBlocked) — not the GitHub `blocked`
// label — decides what the Protector may actually pick up.
export function issueToTask(
  issue: RawIssue,
  mode: OptimizationMode,
  inferDifficulty: (text: string) => Difficulty,
  acTiering?: Partial<AcTieringConfig>,
): Task {
  const pin = pinFromLabels(issue.labels);
  // The issue's own stated criteria decide the difficulty, with the label able
  // to raise it but never lower it (#302). A `model:` pin still bypasses all of
  // this — an operator who names a tier has said something no signal outranks.
  const { difficulty } = effectiveDifficulty(
    difficultyFromLabels(issue.labels),
    auditSignals(issue.body ?? ''),
    inferDifficulty(`${issue.title}\n${issue.body}`),
    acTiering,
  );
  const model = pin ?? tierForDifficulty(difficulty, mode);
  return {
    id: `#${issue.number}`,
    title: issue.title,
    model,
    role: 'implement',
    priority: 1000 - issue.number, // lower issue number = higher priority
    deps: parseDeps(issue.body),
    pinned: Boolean(pin),
    assignedStudent: null,
    stage: 'ready',
    difficulty,
    owns: parseOwns(issue.body),
  };
}

export function issuesToTaskMap(
  issues: RawIssue[],
  mode: OptimizationMode,
  inferDifficulty: (text: string) => Difficulty,
  acTiering?: Partial<AcTieringConfig>,
): TaskMap {
  const known = new Set(issues.map((i) => `#${i.number}`));
  const tasks = issues.map((i) => issueToTask(i, mode, inferDifficulty, acTiering));
  // Drop deps that point at issues not in the open set (already closed/merged),
  // so a satisfied dependency doesn't block its dependents forever.
  for (const t of tasks) t.deps = t.deps.filter((d) => known.has(d));
  return { tasks };
}

// The issue number behind a Task id ("#7" -> 7).
export function issueNumber(taskId: string): number {
  return Number(taskId.replace(/^#/, ''));
}

// Open a PR from `branch` into base for the given issue; returns the PR URL.
export async function openPr(
  repo: string, branch: string, base: string, title: string, body: string,
): Promise<string> {
  const out = await gh([
    'pr', 'create', '-R', repoSlug(repo),
    '--head', branch, '--base', base,
    '--title', title, '--body', body,
  ]);
  return out.trim().split(/\s+/).pop() ?? out.trim();
}

// Squash-merge the PR for `branch` (and delete the branch). Called by live mode
// ONLY when config.autoMerge is on; otherwise Study Room stays PR-only (a human
// merges). Throws if the PR isn't mergeable yet — the caller logs and moves on.
export async function mergePr(repo: string, branch: string): Promise<void> {
  await gh(['pr', 'merge', branch, '-R', repoSlug(repo), '--squash', '--delete-branch']);
}

// --- Pipeline substrate: PR state + review + labels --------------------------
// The Protector's review/merge loop needs to see a PR's live state (checks,
// mergeability, review decision), stamp labels on issues/PRs to move them
// through stages, and post approvals / change requests. All of it shells the
// same argv-array `gh` (no shell:true) and returns typed, normalized results.

// A rollup verdict over a PR's status checks. '' means "no checks configured".
export type CheckRollup = 'SUCCESS' | 'FAILURE' | 'PENDING' | '';
// GitHub's mergeable states, narrowed to the three `gh` reports.
export type MergeableState = 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';

// One entry of `gh`'s statusCheckRollup: either a CheckRun (status+conclusion)
// or a legacy StatusContext (state). We read whichever fields are present.
export interface RawStatusCheck {
  status?: string; // CheckRun: QUEUED | IN_PROGRESS | COMPLETED | PENDING ...
  conclusion?: string; // CheckRun: SUCCESS | FAILURE | NEUTRAL | SKIPPED ...
  state?: string; // StatusContext: SUCCESS | FAILURE | PENDING | ERROR
}

export interface OpenPull {
  number: number;
  title: string;
  headRefName: string;
  labels: string[];
  mergeable: MergeableState;
  statusCheckRollup: CheckRollup;
  reviewDecision: string; // APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | ''
  /** Paths this PR changes, for the file-collision hold (#177). Optional so the
   *  many OpenPull test/literals that predate it still type-check; listOpenPulls
   *  always populates it (to [] for a PR that changed nothing readable). */
  files?: string[];
}

interface RawPull {
  number: number;
  title: string;
  headRefName: string;
  labels?: { name: string }[];
  mergeable?: string;
  statusCheckRollup?: RawStatusCheck[];
  reviewDecision?: string;
  files?: { path?: string }[];
}

// The labels the pipeline moves work through. `ready`/`blocked` gate issues;
// `reviewed-ok`/`changes-requested` mark a PR's review verdict; `runner-error`
// flags a task the Protector failed on.
// Every label the engine WRITES. Anything the engine adds has to be listed here
// or it cannot be added at all: `gh {issue,pr} edit --add-label <missing>` fails
// outright rather than creating the label. See ensureLabels() for what that
// costs -- a label the engine writes but never created is a silent re-dispatch
// loop that ends in the watchdog quarantining the item.
//
// `triaged` and `epic` are exactly that story: triage (#163) shipped both and
// registered neither, so every triaged issue was re-triaged each heartbeat.
// Keep this list in step with the engine's addLabel() call sites.
export const PIPELINE_LABELS = [
  'ready', 'blocked', 'reviewed-ok', 'changes-requested', 'runner-error', 'spec-changed',
  'already-satisfied',
  'triaged', 'epic',
  // Admissions (buildability.ts): the issue is fine, but no student can finish
  // it from a worktree. Registered here for the reason stated above — an
  // unregistered label makes addLabel fail, and a park that fails to stick is a
  // re-dispatch loop that ends in the watchdog quarantining the item.
  'needs-human',
  // issueAudit's enforcing mode labels an issue with nothing checkable in it.
  // Off by default today, but the label must exist before it can ever be used.
  'needs-detail',
  // The splitter has already asked what could be carved out of this parked
  // issue. Re-asking costs a session and files a second copy of a child that
  // already exists, so this label is the only thing preventing duplicates.
  'split-considered',
  // Difficulty (difficultyRubric.ts) — the label that alone decides which model
  // builds an issue. The engine WRITES it: scope triage and the admissions
  // splitter label every child they file, and relabel-issues.ts raises
  // under-labelled ones. It was absent from this list, so on any repo that had
  // never had these labels created by hand every one of those adds failed. The
  // failure is caught and logged rather than looping, so it did not wedge a
  // board -- it did something quieter and worse: the child fell back to keyword
  // inference, which is precisely what the rubric exists to replace. Worst on a
  // BRAND-NEW repo, where nothing defines them yet.
  //
  // Keep in step with difficultyLabel() in difficulty.ts (asserted in tests).
  'difficulty:simple', 'difficulty:standard', 'difficulty:hard',
  // The Editor stamps every issue it files (v1 editor.ts:435), and the context
  // card the board deposits on an issue carries CARD_LABEL (v1 contextCard.ts:
  // 222). Both were written by the engine yet absent from this list — the list
  // whose stated purpose is "every label the engine WRITES" — so editor.ts had
  // to call ensureLabels with an explicit name list to work around it. Listed
  // here so one ensureLabels() call registers everything.
  'editor-proposed', 'context-card',
] as const;

const LABEL_COLORS: Record<string, string> = {
  ready: '2ea44f',
  blocked: 'b60205',
  'reviewed-ok': '0e8a16',
  'changes-requested': 'd93f0b',
  'runner-error': 'e11d21',
  'spec-changed': 'fbca04',
  // Green, and the only green in the palette: this is the one parking label that
  // means the work is FINE. Red would send an operator looking for a fault.
  'already-satisfied': '0e8a16',
  triaged: '5319e7',
  epic: '1d76db',
  // Magenta, and deliberately not amber. It started as `fbca04` to match
  // `spec-changed` on the theory that both mean "parked" — but on a real board
  // that made the one label a human must ACT on indistinguishable from routine
  // parking at a glance, which is the whole job of the colour. Magenta is unused
  // anywhere else in this palette, so `needs-human` is now the only thing on the
  // board that looks like this.
  'needs-human': 'd400d4',
  'needs-detail': 'fef2c0',
  'split-considered': 'c5def5',
  // One family, three shades: the difficulty ladder reads as a ladder on the board.
  'difficulty:simple': 'bfd4f2',
  'difficulty:standard': '5b9bd5',
  'difficulty:hard': '1f4e79',
  'editor-proposed': '0052cc',
  'context-card': 'c2e0c6',
};

// A content fingerprint for an issue's SPEC — the title + body a student builds
// against and a reviewer judges against.
//
// Content-hashed rather than keyed on `updatedAt` on purpose: Study Room edits
// issue LABELS itself (PROMOTE drops `blocked`, quarantine adds `runner-error`),
// and every one of those bumps updatedAt. Keying on the timestamp would make the
// engine trip its own collision guard on its own bookkeeping.
export function specFingerprint(title: string, body: string): string {
  return createHash('sha256').update(`${title}\n\n${body ?? ''}`).digest('hex').slice(0, 16);
}

export interface IssueSpec {
  number: number;
  title: string;
  body: string;
  fingerprint: string;
}

// One issue's spec + fingerprint, or null if it can't be read (closed, deleted,
// no access). Null is meaningful to callers: the thing being built no longer
// exists in a readable form, which is itself a reason to stop.
export async function fetchIssueSpec(repo: string, n: number, run: GhRunner = gh): Promise<IssueSpec | null> {
  try {
    const out = await run(['issue', 'view', String(n), '-R', repoSlug(repo), '--json', 'number,title,body']);
    const raw = JSON.parse(out) as { number?: number; title?: string; body?: string };
    const title = raw.title ?? '';
    const body = raw.body ?? '';
    return { number: raw.number ?? n, title, body, fingerprint: specFingerprint(title, body) };
  } catch {
    return null;
  }
}

// Reduce a PR's checks to one verdict: any failing check -> FAILURE; else any
// still-running/pending check -> PENDING; all done & non-failing -> SUCCESS;
// no checks at all -> ''.
export function rollupState(checks: RawStatusCheck[]): CheckRollup {
  if (checks.length === 0) return '';
  let pending = false;
  for (const c of checks) {
    const conclusion = (c.conclusion ?? '').toUpperCase();
    const state = (c.state ?? '').toUpperCase();
    const status = (c.status ?? '').toUpperCase();
    const failed = ['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE']
      .includes(conclusion) || state === 'FAILURE' || state === 'ERROR';
    if (failed) return 'FAILURE';
    if ((status !== '' && status !== 'COMPLETED') || state === 'PENDING') pending = true;
  }
  return pending ? 'PENDING' : 'SUCCESS';
}

function normalizeMergeable(v: string | undefined): MergeableState {
  return v === 'MERGEABLE' || v === 'CONFLICTING' ? v : 'UNKNOWN';
}

function normalizePull(p: RawPull): OpenPull {
  return {
    number: p.number,
    title: p.title,
    headRefName: p.headRefName,
    labels: (p.labels ?? []).map((l) => l.name),
    mergeable: normalizeMergeable(p.mergeable),
    statusCheckRollup: rollupState(p.statusCheckRollup ?? []),
    reviewDecision: p.reviewDecision ?? '',
    files: (p.files ?? []).map((f) => f.path ?? '').filter(Boolean),
  };
}

// All OPEN pull requests with the state the Protector's review loop needs.
// `files` rides the SAME `gh pr list` (no extra round trip) so the file-collision
// hold (#177) has every open PR's changed-path set for free.
export async function listOpenPulls(repo: string, run: GhRunner = gh): Promise<OpenPull[]> {
  const out = await run([
    'pr', 'list', '-R', repoSlug(repo), '--state', 'open', '--limit', '200',
    '--json', 'number,title,headRefName,labels,mergeable,statusCheckRollup,reviewDecision,files',
  ]);
  return (JSON.parse(out) as RawPull[]).map(normalizePull);
}

// Check rollup for a single PR (SUCCESS | FAILURE | PENDING | '').
export async function prChecks(repo: string, n: number, run: GhRunner = gh): Promise<CheckRollup> {
  const out = await run(['pr', 'view', String(n), '-R', repoSlug(repo), '--json', 'statusCheckRollup']);
  const raw = JSON.parse(out) as { statusCheckRollup?: RawStatusCheck[] };
  return rollupState(raw.statusCheckRollup ?? []);
}

// Mergeability for a single PR (MERGEABLE | CONFLICTING | UNKNOWN).
export async function prMergeable(repo: string, n: number, run: GhRunner = gh): Promise<MergeableState> {
  const out = await run(['pr', 'view', String(n), '-R', repoSlug(repo), '--json', 'mergeable']);
  const raw = JSON.parse(out) as { mergeable?: string };
  return normalizeMergeable(raw.mergeable);
}

export type PullState = 'OPEN' | 'MERGED' | 'CLOSED';

/**
 * A PR's state RIGHT NOW, for re-checking one a role has been working for a
 * while.
 *
 * Every role is handed an `OpenPull` snapshot taken when the board was
 * classified, and a student run is minutes long -- ample time for the PR to be
 * merged or closed underneath it, by a human, by another student, or by the
 * engine's own auto-merge. Landing a result against that stale snapshot pushes
 * commits onto a merged branch and edits labels on a closed PR.
 *
 * Anything other than OPEN is treated as "stop": a closed PR is as finished as
 * a merged one as far as a role's output is concerned.
 */
export async function prState(repo: string, n: number, run: GhRunner = gh): Promise<PullState> {
  const out = await run(['pr', 'view', String(n), '-R', repoSlug(repo), '--json', 'state']);
  const raw = JSON.parse(out) as { state?: string };
  const state = (raw.state ?? '').toUpperCase();
  return state === 'MERGED' || state === 'CLOSED' ? state : 'OPEN';
}

// How an issue was closed, for the carve-out sweep (carveOut.ts).
//
// `stateReason` is what separates "the scope landed" from "we dropped it":
// COMPLETED means done, NOT_PLANNED means abandoned, and a carve-out survives
// its parent in the second case but not the first.
//
// `closedByPullRequestsReferences` gives the PR that did it, so the park can
// point an operator at reviewable evidence instead of asking for faith.
export async function issueClosure(
  repo: string, n: number, run: GhRunner = gh,
): Promise<ParentClosure> {
  const out = await run([
    'issue', 'view', String(n), '-R', repoSlug(repo),
    '--json', 'state,stateReason,closedByPullRequestsReferences',
  ]);
  const raw = JSON.parse(out) as {
    state?: string; stateReason?: string;
    closedByPullRequestsReferences?: { number?: number }[];
  };
  const closed = (raw.state ?? '').toUpperCase() === 'CLOSED';
  const completed = (raw.stateReason ?? '').toUpperCase() === 'COMPLETED';
  // Several PRs can reference one issue; the first with a real number is enough
  // to cite, and citing one is the entire purpose of carrying it.
  const byPr = raw.closedByPullRequestsReferences?.find((r) => typeof r.number === 'number')?.number ?? null;
  return { closed, completed, byPr };
}

// Add / remove a label on an issue (default) or a PR. Issue and PR share a
// number space in GitHub but are edited via different subcommands, so `kind`
// selects `gh issue edit` vs `gh pr edit`.
export async function addLabel(
  repo: string, n: number, label: string, kind: 'issue' | 'pr' = 'issue', run: GhRunner = gh,
): Promise<void> {
  await run([kind, 'edit', String(n), '-R', repoSlug(repo), '--add-label', label]);
}

export async function removeLabel(
  repo: string, n: number, label: string, kind: 'issue' | 'pr' = 'issue', run: GhRunner = gh,
): Promise<void> {
  await run([kind, 'edit', String(n), '-R', repoSlug(repo), '--remove-label', label]);
}

// Approve a PR (optionally with a body comment).
export async function approvePr(repo: string, n: number, body = '', run: GhRunner = gh): Promise<void> {
  const args = ['pr', 'review', String(n), '-R', repoSlug(repo), '--approve'];
  if (body) args.push('--body', body);
  await run(args);
}

// Request changes on a PR. `gh` requires a body for --request-changes.
export async function requestChangesPr(repo: string, n: number, body: string, run: GhRunner = gh): Promise<void> {
  await run(['pr', 'review', String(n), '-R', repoSlug(repo), '--request-changes', '--body', body]);
}

// Post a plain comment on a PR. Fallback for the reviewer's verdict text when a
// formal review submission is rejected — GitHub forbids approving / requesting
// changes on your OWN PR, and Study Room's students open the PRs they review, so
// the durable verdict is the label + this comment, not the review event.
export async function commentPr(repo: string, n: number, body: string, run: GhRunner = gh): Promise<void> {
  await run(['pr', 'comment', String(n), '-R', repoSlug(repo), '--body', body]);
}

// Comment on an ISSUE. commentPr runs `gh pr comment`, which cannot address an
// issue -- scope triage explains its split on the parent issue, not on a PR.
// Record `Depends on #N` for each of an issue's pieces IN ITS BODY.
//
// The body is the only place that counts: parseDeps() reads it and nothing
// else, so scope triage announcing its children in a COMMENT left the parent
// reading deps-closed. dungeonworks#81 is the case — carved into
// #234/#235/#236, then dispatched IMPLEMENT four times against an epic whose
// work its children already owned, ending in `runner-error`.
//
// Appended as its own section rather than merged into the issue's existing
// "Depends on" block: the original deps are what had to close before the work
// could START, these are the pieces the work became, and flattening the two
// loses that distinction for whoever reads the issue next.
//
// Idempotent — deps already parsed out of the body are skipped, so a re-run
// after a partial failure cannot stack duplicate lines.
export async function addIssueDeps(
  repo: string, n: number, deps: number[], run: GhRunner = gh,
): Promise<void> {
  const slug = repoSlug(repo);
  const raw = await run(['issue', 'view', String(n), '-R', slug, '--json', 'body']);
  let body = '';
  try {
    body = (JSON.parse(raw) as { body?: string }).body ?? '';
  } catch {
    throw new Error(`#${n}: could not read the issue body to record its pieces (${raw.slice(0, 120)})`);
  }
  const have = new Set(parseDeps(body));
  const fresh = deps.filter((d) => !have.has(`#${d}`));
  if (!fresh.length) return;
  const section = ['## Depends on its pieces', '', ...fresh.map((d) => `Depends on #${d}`)].join('\n');
  await run(['issue', 'edit', String(n), '-R', slug, '--body', `${body.trimEnd()}\n\n${section}\n`]);
}

export async function commentIssue(repo: string, n: number, body: string, run: GhRunner = gh): Promise<void> {
  await run(['issue', 'comment', String(n), '-R', repoSlug(repo), '--body', body]);
}

// An issue's comment bodies, oldest first. Used to find a context card the board
// deposited on a previous run: the card is stored ON the issue rather than in
// local state so it survives a wipe of ~/.claude-study-room, is visible to a
// human deciding whether to trust it, and needs no new persistence format.
export async function issueComments(repo: string, n: number, run: GhRunner = gh): Promise<string[]> {
  const raw = await run(['issue', 'view', String(n), '-R', repoSlug(repo), '--json', 'comments']);
  try {
    const parsed = JSON.parse(raw) as { comments?: Array<{ body?: string }> };
    return (parsed.comments ?? []).map((c) => c.body ?? '');
  } catch {
    return [];
  }
}

// A PR's written review feedback for a fixer to address: the bodies of its
// submitted reviews (newest state first) plus issue-comments — the latter
// catches Study Room's own verdict, which is posted as a plain comment when the
// self-review event is refused (see postVerdict's fallback). Empty string when
// the PR has none (a red-CI-only fix reads the failing checks instead).
// How many times this PR has already been rejected, read off the PR itself.
//
// The watchdog counts attempts it OBSERVES, in memory. That misses everything
// that happened before this engine booted -- a PR rejected nine times yesterday
// looks brand new today and gets a full budget of fixes again before the rewrite
// escalation can fire. The evidence is on the PR, so read it instead of waiting
// to re-derive it.
//
// Study Room's reviewers post their verdict as a COMMENT ("Review verdict:
// REQUEST_CHANGES"), not as a GitHub review, so both surfaces are counted.
export async function rejectedReviewCount(repo: string, n: number, run: GhRunner = gh): Promise<number> {
  const out = await run(['pr', 'view', String(n), '-R', repoSlug(repo), '--json', 'reviews,comments']);
  const raw = JSON.parse(out) as {
    reviews?: { state?: string; body?: string }[];
    comments?: { body?: string }[];
  };
  let count = 0;
  for (const r of raw.reviews ?? []) {
    if ((r.state ?? '').toUpperCase() === 'CHANGES_REQUESTED') count += 1;
    else if (/REQUEST_CHANGES/i.test(r.body ?? '')) count += 1;
  }
  for (const c of raw.comments ?? []) {
    if (/verdict:\s*REQUEST_CHANGES/i.test(c.body ?? '')) count += 1;
  }
  return count;
}

export async function prReviewFeedback(repo: string, n: number, run: GhRunner = gh): Promise<string> {
  const out = await run(['pr', 'view', String(n), '-R', repoSlug(repo), '--json', 'reviews,comments']);
  const raw = JSON.parse(out) as {
    reviews?: { state?: string; body?: string }[];
    comments?: { body?: string }[];
  };
  const parts: string[] = [];
  for (const r of raw.reviews ?? []) {
    if (r.body?.trim()) parts.push(`[review ${r.state ?? ''}]\n${r.body.trim()}`);
  }
  for (const c of raw.comments ?? []) {
    if (c.body?.trim()) parts.push(`[comment]\n${c.body.trim()}`);
  }
  return parts.join('\n\n');
}

// GitHub's own rate-limit reset epoch (SECONDS), for sizing a backoff (#170).
//
// When a board fetch dies on a rate limit, GitHub already knows exactly when the
// window reopens — so pause until then instead of a flat guess that either
// thrashes against a limit with 40 minutes left or idles long after it cleared.
// Returns the SOONEST reset among the EXHAUSTED buckets (remaining 0), or null
// when nothing is exhausted / the call itself fails.
//
// The `/rate_limit` endpoint does NOT count against the REST limit, so this is
// safe to call from inside the rate-limited path. Injectable runner for tests.
export async function githubRateLimitReset(run: GhRunner = gh): Promise<number | null> {
  try {
    const out = await run(['api', 'rate_limit']);
    const raw = JSON.parse(out) as { resources?: Record<string, { remaining?: number; reset?: number }> };
    let soonest: number | null = null;
    for (const bucket of Object.values(raw.resources ?? {})) {
      if ((bucket.remaining ?? 1) <= 0 && typeof bucket.reset === 'number') {
        soonest = soonest == null ? bucket.reset : Math.min(soonest, bucket.reset);
      }
    }
    return soonest;
  } catch {
    return null;
  }
}

// The log text of a PR's FAILING checks, best-effort, for classification (#172).
//
// Two hops: `gh pr checks` names the failed checks and links each to its Actions
// run; `gh run view --log-failed` prints the failing steps of that run. Both are
// wrapped so a miss returns '' rather than throwing — the caller degrades to the
// old generic "inspect the checks yourself" prompt when there is no log to read.
//
// `gh pr checks` EXITS NON-ZERO when any check is failing, which the argv `gh`
// wrapper would reject on. So this reads stdout directly through execFile and
// keeps whatever was printed even on a non-zero exit.
export async function failingCiLog(repo: string, n: number, maxChars = 16000): Promise<string> {
  const slug = repoSlug(repo);
  const stdoutOf = async (args: string[]): Promise<string> => {
    try {
      const { stdout } = await execFileAsync('gh', args, { maxBuffer: 20 * 1024 * 1024 });
      return stdout;
    } catch (e) {
      // `gh pr checks` returns 1 while checks are red but still prints the table.
      return String((e as { stdout?: string })?.stdout ?? '');
    }
  };

  const checksJson = await stdoutOf(['pr', 'checks', String(n), '-R', slug, '--json', 'name,state,link']);
  let checks: { name?: string; state?: string; link?: string }[] = [];
  try { checks = JSON.parse(checksJson); } catch { checks = []; }
  const failed = checks.filter((c) => /FAIL|ERROR|CANCEL|TIMED_OUT|ACTION_REQUIRED/i.test(c.state ?? ''));

  // One Actions run per failing check (deduped) — pull each run's failed-step log.
  const runIds: string[] = [];
  for (const c of failed) {
    const m = (c.link ?? '').match(/runs\/(\d+)/);
    if (m && !runIds.includes(m[1])) runIds.push(m[1]);
  }
  const parts: string[] = [];
  for (const id of runIds) {
    const l = await stdoutOf(['run', 'view', id, '-R', slug, '--log-failed']);
    if (l.trim()) parts.push(l);
    if (parts.join('\n').length >= maxChars) break;
  }
  // The summary + the actual error live at the END of a CI log — keep the tail.
  return parts.join('\n').slice(-maxChars);
}

// Every label name already defined on the repo, lowercased (GitHub label names
// are case-insensitive for matching but preserve case).
export async function listLabels(repo: string, run: GhRunner = gh): Promise<string[]> {
  const out = await run(['label', 'list', '-R', repoSlug(repo), '--limit', '200', '--json', 'name']);
  const raw = JSON.parse(out) as { name?: string }[];
  return raw.map((l) => (l.name ?? '').toLowerCase()).filter(Boolean);
}

// Idempotently ensure every pipeline label exists in the repo, and return the
// ones this call had to create.
//
// This is a HARD prerequisite, not a nicety: `gh pr edit --add-label <missing>`
// FAILS outright, and postVerdict's label is the durable review verdict. A
// missing `reviewed-ok` therefore leaves every reviewed PR looking un-reviewed,
// so needsReview() re-dispatches it each heartbeat until the watchdog wedges the
// item and kills the run.
//
// Creates only what's absent — no `--force`. Forcing rewrites the color and
// BLANKS the description of a label the repo already defines for its own
// purposes (`ready`, `blocked` commonly pre-exist), which is a destructive edit
// to someone else's repo just to guarantee presence we already have.
export async function ensureLabels(
  repo: string, run: GhRunner = gh, names: readonly string[] = PIPELINE_LABELS,
): Promise<string[]> {
  const slug = repoSlug(repo);
  const existing = new Set(await listLabels(repo, run));
  const created: string[] = [];
  for (const name of names) {
    if (existing.has(name.toLowerCase())) continue;
    const args = ['label', 'create', name, '-R', slug];
    // Labels outside the pipeline set (the Editor's, say) get gh's default color
    // rather than an invented one.
    if (LABEL_COLORS[name]) args.push('--color', LABEL_COLORS[name]);
    await run(args);
    created.push(name);
  }
  return created;
}
