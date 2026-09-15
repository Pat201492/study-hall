import { auditIssue, auditSignals, DEFAULT_AUDIT_GATE, type IssueAudit } from '@study-hall/core/issueAudit';
import { needsTriage, TRIAGED_LABEL } from '@study-hall/core/triage';
import { assessAdmission, NEEDS_HUMAN_LABEL, type Admission } from '@study-hall/core/buildability';
import { expectedDifficulty } from '@study-hall/core/difficultyRubric';
import { DIFFICULTIES, difficultyLabel, type Difficulty } from '@study-hall/core/difficulty';
import { parseDeps, parseOwns, PIPELINE_LABELS, type RawIssue } from '@study-hall/core/github';

// Draft issues: the shape the planner proposes, the lint that decides whether a
// draft may be filed, the filing order, and the body rendering that turns draft
// keys into real issue numbers. All pure, so every rule is unit-testable and
// the dashboard can show verdicts before anything touches GitHub.

export interface IssueDraft {
  /** Stable idempotency key (slug). The filing ledger dedupes on it. */
  key: string;
  title: string;
  body: string;
  labels?: string[];
  /** Draft keys or existing issue numbers (`#12` / 12) this issue depends on. */
  dependsOn?: Array<string | number>;
  /** File globs this issue OWNS (exactly one issue per shared file). */
  owns?: string[];
  /** The planner may raise the computed difficulty, never lower it. */
  difficulty?: Difficulty;
  /** Explicitly not buildable by a student; filed parked as needs-human. */
  needsHuman?: boolean;
}

export type LintVerdict = 'ok' | 'warn' | 'reject';

export interface DraftLint {
  key: string;
  verdict: LintVerdict;
  reasons: string[];
  computed: {
    difficulty: Difficulty;
    labels: string[];
    criteria: number;
    checkable: number;
    subsystems: number;
    bodyChars: number;
    vagueMarkers: number;
    audit: IssueAudit['verdict'];
    wouldTriage: boolean;
    admission: Admission['verdict'];
  };
  duplicateOf?: { number: number; title: string };
}

export interface LintContext {
  openIssues?: Array<Pick<RawIssue, 'number' | 'title' | 'body'>>;
  /** Labels that exist on the repo (plus the pipeline set the engine registers). */
  repoLabels?: string[];
  /** Other drafts in the same batch, for dependency resolution. */
  batch?: IssueDraft[];
}

const KEY_RE = /^[a-z0-9][a-z0-9-]{1,79}$/;

export function normaliseKey(key: string): string {
  return key.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

function depRef(d: string | number): { kind: 'number'; number: number } | { kind: 'key'; key: string } {
  if (typeof d === 'number') return { kind: 'number', number: d };
  const m = /^#?(\d+)$/.exec(d.trim());
  if (m) return { kind: 'number', number: Number(m[1]) };
  return { kind: 'key', key: normaliseKey(d) };
}

function similarTitle(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const x = norm(a); const y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const xs = new Set(x.split(' ')); const ys = new Set(y.split(' '));
  const inter = [...xs].filter((w) => ys.has(w) && w.length > 2).length;
  return inter >= 4 && inter / Math.max(xs.size, ys.size) >= 0.7;
}

/** Lint one draft against the rubric, the repo, and its batch. */
export function lintDraft(draft: IssueDraft, ctx: LintContext = {}): DraftLint {
  const reasons: string[] = [];
  let verdict: LintVerdict = 'ok';
  const reject = (r: string) => { reasons.push(r); verdict = 'reject'; };
  const warn = (r: string) => { reasons.push(r); if (verdict === 'ok') verdict = 'warn'; };

  const key = normaliseKey(draft.key ?? '');
  if (!KEY_RE.test(key)) reject(`key "${draft.key}" is not a stable slug (a-z, 0-9, -; 2-80 chars)`);
  if (!draft.title?.trim()) reject('missing title');
  else if (draft.title.length > 120) warn(`title is ${draft.title.length} chars; keep it under 120`);

  const body = draft.body ?? '';
  const signals = auditSignals(body);
  const audit = auditIssue({ number: 0, title: draft.title ?? '', body, labels: [] }, DEFAULT_AUDIT_GATE);
  if (audit.verdict === 'underspecified') for (const r of audit.reasons) reject(`underspecified: ${r}`);
  if (audit.verdict === 'oversized') for (const r of audit.reasons) reject(`oversized — split it: ${r}`);
  if (signals.vagueMarkers > 0) warn(`${signals.vagueMarkers} scope-deferring phrase(s) ("etc", "as needed", …): state the scope instead`);
  if (!/^##\s+Acceptance/im.test(body)) warn('no "## Acceptance" heading (checkbox lines under it are what reviewers judge)');
  if (!/^##\s+Goal/im.test(body)) warn('no "## Goal" heading');

  const wouldTriage = needsTriage({ number: 0, title: draft.title ?? '', body, labels: [] });
  if (wouldTriage && audit.verdict !== 'oversized') warn('the engine would route this to scope triage (body length or criteria count); consider splitting');

  const admission = assessAdmission({ number: 0, title: draft.title ?? '', body, labels: (draft.labels ?? []).map((name) => ({ name })) });
  if (admission.verdict === 'blocked' && !draft.needsHuman) {
    reject(`not buildable by a worktree-bound student (${admission.blockers.map((b) => b.kind).join(', ')}); carve out the buildable part or set needsHuman`);
  } else if (admission.verdict === 'unsure') {
    warn(`possible external blocker: ${admission.blockers.map((b) => `${b.kind} ("${b.evidence}")`).join('; ')}`);
  }

  // Difficulty: computed from the criteria; the planner may raise, never lower.
  const computed = expectedDifficulty(signals);
  let difficulty = computed;
  if (draft.difficulty) {
    if (!DIFFICULTIES.includes(draft.difficulty)) reject(`unknown difficulty "${draft.difficulty}"`);
    else if (DIFFICULTIES.indexOf(draft.difficulty) < DIFFICULTIES.indexOf(computed)) {
      warn(`difficulty "${draft.difficulty}" is below what ${Math.max(signals.criteria, signals.checkable)} criteria imply (${computed}); using ${computed}`);
    } else difficulty = draft.difficulty;
  }

  // Labels: only ones the repo (or the engine) knows, plus the computed ones.
  const known = new Set([...(ctx.repoLabels ?? []), ...PIPELINE_LABELS]);
  const labels = new Set<string>();
  for (const l of draft.labels ?? []) {
    if (/^difficulty:/.test(l)) continue;   // computed below
    if (ctx.repoLabels && !known.has(l)) warn(`label "${l}" does not exist on the repo; it will be created with a default colour`);
    labels.add(l);
  }
  labels.add(difficultyLabel(difficulty));
  labels.add(TRIAGED_LABEL);                 // the planner did the sizing
  if (draft.needsHuman) labels.add(NEEDS_HUMAN_LABEL);

  // Dependencies must resolve to a batch key or an existing open issue.
  const batchKeys = new Set((ctx.batch ?? []).map((d) => normaliseKey(d.key)));
  const open = new Set((ctx.openIssues ?? []).map((i) => i.number));
  for (const d of draft.dependsOn ?? []) {
    const ref = depRef(d);
    if (ref.kind === 'key') {
      if (ref.key === key) reject('an issue cannot depend on itself');
      else if (!batchKeys.has(ref.key)) reject(`dependsOn "${d}" is not a draft key in this batch`);
    } else if (ctx.openIssues && !open.has(ref.number)) {
      warn(`dependsOn #${ref.number} is not an OPEN issue; the engine only gates on open dependencies`);
    }
  }
  for (const line of parseDeps(body)) warn(`body already carries "Depends on ${line}"; prefer the dependsOn field so numbers are substituted at filing`);

  // Owns: one owner per shared file across the batch and the board.
  const ownsHere = new Set([...(draft.owns ?? []), ...parseOwns(body)]);
  for (const other of ctx.batch ?? []) {
    if (normaliseKey(other.key) === key) continue;
    for (const g of [...(other.owns ?? []), ...parseOwns(other.body ?? '')]) {
      if (ownsHere.has(g)) reject(`"${g}" is owned by draft "${other.key}" too — exactly one owner, the rest depend on it`);
    }
  }
  for (const i of ctx.openIssues ?? []) {
    for (const g of parseOwns(i.body ?? '')) if (ownsHere.has(g)) warn(`"${g}" is already owned by open issue #${i.number}; depend on it instead`);
  }

  let duplicateOf: DraftLint['duplicateOf'];
  for (const i of ctx.openIssues ?? []) {
    if (similarTitle(i.title, draft.title ?? '')) { duplicateOf = { number: i.number, title: i.title }; break; }
  }
  if (duplicateOf) warn(`title resembles open issue #${duplicateOf.number} "${duplicateOf.title}"`);

  return {
    key, verdict, reasons,
    computed: {
      difficulty, labels: [...labels], criteria: signals.criteria, checkable: signals.checkable,
      subsystems: signals.subsystems, bodyChars: signals.bodyChars, vagueMarkers: signals.vagueMarkers,
      audit: audit.verdict, wouldTriage, admission: admission.verdict,
    },
    duplicateOf,
  };
}

export function lintBatch(drafts: IssueDraft[], ctx: Omit<LintContext, 'batch'> = {}): DraftLint[] {
  const keys = new Map<string, number>();
  const lints = drafts.map((d) => lintDraft(d, { ...ctx, batch: drafts }));
  for (const l of lints) keys.set(l.key, (keys.get(l.key) ?? 0) + 1);
  for (const l of lints) {
    if ((keys.get(l.key) ?? 0) > 1) { l.verdict = 'reject'; l.reasons.push(`duplicate key "${l.key}" in the batch`); }
  }
  return lints;
}

/**
 * Filing order: dependencies first (Kahn's algorithm over in-batch keys), so a
 * dependant's body can carry its dependency's REAL number. Throws on a cycle.
 */
export function orderForFiling(drafts: IssueDraft[]): IssueDraft[] {
  const byKey = new Map(drafts.map((d) => [normaliseKey(d.key), d]));
  const indeg = new Map<string, number>();
  const out = new Map<string, string[]>();
  for (const k of byKey.keys()) { indeg.set(k, 0); out.set(k, []); }
  for (const d of drafts) {
    const k = normaliseKey(d.key);
    for (const dep of d.dependsOn ?? []) {
      const ref = depRef(dep);
      if (ref.kind !== 'key' || !byKey.has(ref.key) || ref.key === k) continue;
      out.get(ref.key)!.push(k);
      indeg.set(k, (indeg.get(k) ?? 0) + 1);
    }
  }
  const queue = [...indeg.entries()].filter(([, n]) => n === 0).map(([k]) => k);
  const ordered: IssueDraft[] = [];
  while (queue.length) {
    const k = queue.shift()!;
    ordered.push(byKey.get(k)!);
    for (const n of out.get(k) ?? []) {
      indeg.set(n, indeg.get(n)! - 1);
      if (indeg.get(n) === 0) queue.push(n);
    }
  }
  if (ordered.length !== drafts.length) {
    const stuck = [...indeg.entries()].filter(([, n]) => n > 0).map(([k]) => k);
    throw new Error(`dependency cycle among drafts: ${stuck.join(', ')}`);
  }
  return ordered;
}

export const PLANNER_KEY_FOOTER = 'planner-key';

/**
 * The body as filed: draft text, then `Depends on #N` lines (one per line, the
 * no-colon single-dep form the engine writes, resolved through `numbers`), an
 * `Owns:` line, and the idempotency footer the ledger can be rebuilt from.
 */
export function renderBody(draft: IssueDraft, numbers: Map<string, number>, rubricSha?: string): string {
  const lines = [draft.body.trimEnd()];
  const deps: number[] = [];
  for (const d of draft.dependsOn ?? []) {
    const ref = depRef(d);
    if (ref.kind === 'number') deps.push(ref.number);
    else {
      const n = numbers.get(ref.key);
      if (n == null) throw new Error(`draft "${draft.key}" depends on "${ref.key}", which has no issue number yet`);
      deps.push(n);
    }
  }
  const owns = [...new Set(draft.owns ?? [])];
  if (deps.length || owns.length) lines.push('');
  for (const n of [...new Set(deps)]) lines.push(`Depends on #${n}`);
  if (owns.length) lines.push(`Owns: ${owns.join(', ')}`);
  lines.push('', `<!-- ${PLANNER_KEY_FOOTER}: ${normaliseKey(draft.key)}${rubricSha ? ` rubric:${rubricSha.slice(0, 12)}` : ''} -->`);
  return lines.join('\n');
}

/** The key a filed body carries, for rebuilding the ledger from GitHub. */
export function plannerKeyOf(body: string): string | null {
  const m = new RegExp(`<!--\\s*${PLANNER_KEY_FOOTER}:\\s*([a-z0-9-]+)`).exec(body ?? '');
  return m ? m[1] : null;
}

/** Fallback: the fenced JSON array the role prompt asks for when tools are unavailable. */
export function parseProposals(text: string): IssueDraft[] {
  const fence = new RegExp('```planner-proposals\\s*([\\s\\S]*?)```', 'i').exec(text ?? '')
    ?? /```json\s*(\[[\s\S]*?\])\s*```/i.exec(text ?? '');
  if (!fence) return [];
  try {
    const arr = JSON.parse(fence[1]);
    if (!Array.isArray(arr)) return [];
    return arr.filter((d) => d && typeof d === 'object' && typeof d.key === 'string' && typeof d.title === 'string' && typeof d.body === 'string');
  } catch { return []; }
}
