import { fetchIssues, addLabel, commentIssue, issueComments, ensureLabels, repoSlug, openIssue, type RawIssue } from './github.js';
import { assessAdmission, needsHumanComment, NEEDS_HUMAN_LABEL, type Admission } from './buildability.js';
import { auditIssue, needsDetailComment, NEEDS_DETAIL_LABEL, DEFAULT_AUDIT_GATE, auditSignals, type IssueAudit, type IssueAuditGate } from './issueAudit.js';
import { splitPrompt, parseAdmissionsSplit, splitComment, nothingSeparableComment, SPLIT_CONSIDERED_LABEL, type SplitVerdict } from './admissionsSplit.js';
import { TRIAGED_LABEL } from './triage.js';
import { expectedDifficulty } from './difficultyRubric.js';
import { difficultyLabel } from './difficulty.js';

// Admissions (ported from v1 admissions.ts + splitRunner.ts): the sweep that
// flags what the board cannot build — `needs-human` for work no student can
// finish from a worktree, `needs-detail` for issues with nothing checkable —
// and the follow-up that carves buildable pieces out of parked issues. Report
// first: `apply: false` touches nothing and is what the dashboard runs first.
// Every GitHub write goes through an injected port so the tests need no gh.

export interface AdmissionFinding {
  repo: string;
  number: number;
  title: string;
  url: string;
  verdict: Admission['verdict'];
  admission: Admission;
  audit: IssueAudit;
  /** Labels this issue would gain. Empty when nothing needs saying. */
  wouldLabel: string[];
  /** Already carries every label it needs — applying again would be noise. */
  alreadyFlagged: boolean;
}

export interface AdmissionsReport {
  ran: string;
  applied: boolean;
  repos: Array<{ repo: string; open: number; buildable: number; blocked: number; unsure: number; underspecified: number; oversized: number; error?: string }>;
  findings: AdmissionFinding[];
  /** Per-issue log of what the apply actually did, or why it did nothing. */
  actions: string[];
}

export interface AdmissionsPort {
  fetchIssues(repo: string): Promise<RawIssue[]>;
  ensureLabels(repo: string): Promise<void>;
  issueComments(repo: string, n: number): Promise<string[]>;
  addLabel(repo: string, n: number, label: string): Promise<void>;
  commentIssue(repo: string, n: number, body: string): Promise<void>;
  openIssue(repo: string, title: string, body: string): Promise<string>;
}

export const realAdmissionsPort: AdmissionsPort = {
  fetchIssues, ensureLabels: async (r) => { await ensureLabels(r); },
  issueComments: (r, n) => issueComments(r, n), addLabel: (r, n, l) => addLabel(r, n, l, 'issue'),
  commentIssue: (r, n, b) => commentIssue(r, n, b), openIssue: (r, t, b) => openIssue(r, t, b),
};

function labelsOf(i: RawIssue): string[] { return (i.labels ?? []).map((l) => l.name); }
function has(labels: string[], name: string): boolean { return labels.some((l) => l.toLowerCase() === name.toLowerCase()); }

/** Look at one issue and decide what, if anything, it needs. `unsure` produces
 *  no label: a weak signal is reported to a human, never acted on. */
export function assess(repo: string, issue: RawIssue, gate: IssueAuditGate = DEFAULT_AUDIT_GATE): AdmissionFinding {
  const labels = labelsOf(issue);
  const admission = assessAdmission(issue);
  const audit = auditIssue(issue, gate);
  const wouldLabel: string[] = [];
  if (admission.verdict === 'blocked' && !has(labels, NEEDS_HUMAN_LABEL)) wouldLabel.push(NEEDS_HUMAN_LABEL);
  if (audit.verdict === 'underspecified' && !has(labels, NEEDS_DETAIL_LABEL)) wouldLabel.push(NEEDS_DETAIL_LABEL);
  return {
    repo: repoSlug(repo), number: issue.number, title: issue.title,
    url: (issue as { url?: string }).url ?? `https://github.com/${repoSlug(repo)}/issues/${issue.number}`,
    verdict: admission.verdict, admission, audit, wouldLabel,
    alreadyFlagged: wouldLabel.length === 0 && (has(labels, NEEDS_HUMAN_LABEL) || has(labels, NEEDS_DETAIL_LABEL)),
  };
}

const HUMAN_MARKER = 'cannot build this issue as written';
const DETAIL_MARKER = 'not actionable as written';

/**
 * Run the sweep. With `apply: false` nothing is touched. With `apply: true` it
 * adds labels and posts one explanatory comment per newly-flagged issue, guarded
 * on the comment's own marker text so a human removing a label and leaving the
 * comment does not get a second identical wall of text later.
 */
export async function runAdmissions(
  repos: string[], opts: { apply?: boolean; gate?: IssueAuditGate } = {}, port: AdmissionsPort = realAdmissionsPort,
): Promise<AdmissionsReport> {
  const apply = opts.apply === true;
  const report: AdmissionsReport = { ran: new Date().toISOString(), applied: apply, repos: [], findings: [], actions: [] };
  for (const repo of repos) {
    const slug = repoSlug(repo);
    let issues: RawIssue[];
    try { issues = await port.fetchIssues(slug); } catch (e) {
      report.repos.push({ repo: slug, open: 0, buildable: 0, blocked: 0, unsure: 0, underspecified: 0, oversized: 0, error: String((e as Error)?.message ?? e) });
      continue;
    }
    if (apply) { try { await port.ensureLabels(slug); } catch (e) { report.actions.push(`${slug}: could not ensure labels (${(e as Error).message})`); } }
    const row = { repo: slug, open: issues.length, buildable: 0, blocked: 0, unsure: 0, underspecified: 0, oversized: 0 };
    for (const issue of issues) {
      const f = assess(slug, issue, opts.gate);
      report.findings.push(f);
      row[f.verdict]++;
      if (f.audit.verdict === 'underspecified') row.underspecified++;
      if (f.audit.verdict === 'oversized') row.oversized++;
      if (!apply || f.wouldLabel.length === 0) continue;
      let comments: string[] = [];
      try { comments = await port.issueComments(slug, issue.number); } catch { /* comment anyway */ }
      for (const label of f.wouldLabel) {
        try {
          await port.addLabel(slug, issue.number, label);
          const marker = label === NEEDS_HUMAN_LABEL ? HUMAN_MARKER : DETAIL_MARKER;
          if (!comments.some((c) => c.includes(marker))) {
            await port.commentIssue(slug, issue.number, label === NEEDS_HUMAN_LABEL ? needsHumanComment(f.admission) : needsDetailComment(f.audit));
            report.actions.push(`${slug}#${issue.number}: labelled \`${label}\` + explained`);
          } else {
            report.actions.push(`${slug}#${issue.number}: labelled \`${label}\` (already explained)`);
          }
        } catch (e) {
          report.actions.push(`${slug}#${issue.number}: FAILED to apply \`${label}\` — ${(e as Error).message}`);
        }
      }
    }
    report.repos.push(row);
  }
  return report;
}

// ---- the split follow-up ------------------------------------------------------------

export interface SplitRunOptions {
  repos: string[];
  /** Bound on issues considered across the run — a mis-click must not walk the whole board. */
  limit?: number;
  /** Ask and report; file nothing, label nothing. */
  dryRun?: boolean;
  /** The student: runs the split prompt in some checkout and returns its text. */
  run: (prompt: string, repo: string) => Promise<{ text: string }>;
  spec?: (repo: string) => string;
  onIssue?: (e: SplitEvent) => void;
  signal?: AbortSignal;
}

export interface SplitEvent {
  repo: string;
  number: number;
  title: string;
  verdict: SplitVerdict | null;
  filed: number[];
  note: string;
}

export interface SplitSummary {
  considered: number;
  filed: number;
  events: SplitEvent[];
}

/** Carve buildable pieces out of parked issues. Each parent is asked ONCE
 *  (`split-considered`), never closed, never reworded; every filed child is
 *  born `triaged` with its computed difficulty so the board pays nothing to
 *  re-scope it. */
export async function runAdmissionsSplit(opts: SplitRunOptions, port: AdmissionsPort = realAdmissionsPort): Promise<SplitSummary> {
  const limit = Math.max(1, opts.limit ?? 10);
  const dry = opts.dryRun === true;
  const summary: SplitSummary = { considered: 0, filed: 0, events: [] };
  const emit = (e: SplitEvent): void => { summary.events.push(e); opts.onIssue?.(e); };
  for (const repo of opts.repos) {
    const slug = repoSlug(repo);
    const issues = await port.fetchIssues(slug).catch(() => [] as RawIssue[]);
    const targets = issues.filter((i) => {
      const labels = labelsOf(i);
      if (has(labels, SPLIT_CONSIDERED_LABEL)) return false;
      return has(labels, NEEDS_HUMAN_LABEL) || assessAdmission(i).verdict === 'blocked';
    });
    if (!targets.length) continue;
    if (!dry) await port.ensureLabels(slug).catch(() => undefined);
    for (const issue of targets) {
      if (opts.signal?.aborted) return summary;
      if (summary.considered >= limit) return summary;
      summary.considered++;
      const admission = assessAdmission(issue);
      const prompt = splitPrompt(slug, issue.number, issue.title, issue.body ?? '', admission.blockers, opts.spec?.(slug) ?? '');
      let text = '';
      try { text = (await opts.run(prompt, slug)).text ?? ''; } catch (e) {
        emit({ repo: slug, number: issue.number, title: issue.title, verdict: null, filed: [], note: `student failed: ${(e as Error).message}` });
        continue;
      }
      const verdict = parseAdmissionsSplit(text);
      if (!verdict.pieces.length) {
        if (!dry) {
          await port.commentIssue(slug, issue.number, nothingSeparableComment(verdict)).catch(() => undefined);
          await port.addLabel(slug, issue.number, SPLIT_CONSIDERED_LABEL).catch(() => undefined);
        }
        emit({ repo: slug, number: issue.number, title: issue.title, verdict, filed: [], note: `nothing separable — ${verdict.reason || 'no reason given'}` });
        continue;
      }
      if (dry) {
        emit({ repo: slug, number: issue.number, title: issue.title, verdict, filed: [], note: `dry run: ${verdict.pieces.length} piece(s) would be filed` });
        continue;
      }
      const filed: number[] = [];
      for (const piece of verdict.pieces) {
        const body = `${piece.body}\n\n---\nCarved out of #${issue.number}, which needs a human for: ${verdict.remainder || 'the part a student cannot do'}.\nCovers: ${piece.covers}`;
        const url = await port.openIssue(slug, piece.title, body).catch(() => '');
        const n = Number(url.trim().split('/').pop());
        if (!Number.isFinite(n) || n <= 0) continue;
        filed.push(n);
        await port.addLabel(slug, n, TRIAGED_LABEL).catch(() => undefined);
        await port.addLabel(slug, n, difficultyLabel(expectedDifficulty(auditSignals(`${piece.title}\n${body}`)))).catch(() => undefined);
      }
      if (!filed.length) {
        emit({ repo: slug, number: issue.number, title: issue.title, verdict, filed, note: `proposed ${verdict.pieces.length} piece(s), filed none — left untouched` });
        continue;
      }
      summary.filed += filed.length;
      await port.commentIssue(slug, issue.number, splitComment(filed, verdict, NEEDS_HUMAN_LABEL)).catch(() => undefined);
      await port.addLabel(slug, issue.number, SPLIT_CONSIDERED_LABEL).catch(() => undefined);
      emit({ repo: slug, number: issue.number, title: issue.title, verdict, filed, note: `carved into ${filed.map((n) => `#${n}`).join(', ')} — parent stays open and flagged` });
    }
  }
  return summary;
}
