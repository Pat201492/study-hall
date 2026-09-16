import type { IssueDraft } from './drafts.js';
import { createHash } from 'node:crypto';

// Spec mirror: write the README the ISSUES imply, then compare it with the one
// the repo actually has.
//
// A board of autonomous students is very good at building what the issues say
// and completely blind to whether the issues add up to the project. The two
// documents drift in both directions: a README promises a surface no issue ever
// covered, or a dozen issues quietly build a subsystem the README never
// mentions. The dangerous case is the third one, where both describe the same
// thing differently, because every student is then aimed slightly wrong and
// every PR passes review.
//
// The blinding is STRUCTURAL, not an instruction. The mirror pass is given the
// issue text and nothing else — no README, no file contents, no read tools —
// because a model told "do not look at the README" in a prompt that also
// contains the README has already read it. Two passes, two prompts, and the
// real README appears only in the second.

export interface IssueDigest {
  number: number;
  title: string;
  body: string;
  labels: string[];
  state: 'open' | 'closed';
  /** Closed by a merged PR, as opposed to closed as dropped. Shapes "built" vs "planned". */
  merged?: boolean;
}

export type MirrorFinding = {
  kind: 'unbuilt-promise' | 'unannounced-surface' | 'contradiction';
  subject: string;
  /** What the README says, verbatim where there is anything to quote. */
  readmeSays: string | null;
  /** What the issues say, verbatim. */
  issuesSay: string | null;
  /** Issue numbers the claim rests on. */
  issues: number[];
  detail: string;
};

export interface MirrorReport {
  repo: string;
  generatedAt: string;
  /** The README the issues imply, as written by the blinded pass. */
  mirror: string;
  findings: MirrorFinding[];
  /** Hash of the issue set, so an unchanged repo costs nothing to re-check. */
  issuesSha256: string;
  readmeSha256: string;
  issueCount: number;
  /** False when the compare pass returned nothing parseable; findings are then empty and untrustworthy. */
  parsed: boolean;
  note: string | null;
}

/** One model call. Injected, so the pass runs on whichever provider the tab names. */
export interface MirrorPort {
  provider: string;
  model: string;
  ask(prompt: string): Promise<string>;
}

export const MIRROR_FENCE = 'spec-mirror';

export function issuesSha256(issues: readonly IssueDigest[]): string {
  const canon = [...issues]
    .sort((a, b) => a.number - b.number)
    .map((i) => `${i.number}\u0000${i.state}\u0000${i.merged ? 'merged' : ''}\u0000${i.title}\u0000${i.labels.slice().sort().join(',')}\u0000${i.body}`)
    .join('\u0001');
  return createHash('sha256').update(canon).digest('hex');
}

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/**
 * The issue corpus as the blinded pass sees it.
 *
 * Closed issues are IN and marked, because a mirror built from open issues
 * alone describes a project that has not been built yet, and would report every
 * finished subsystem as an unannounced surface.
 */
export function renderIssues(issues: readonly IssueDigest[]): string {
  return [...issues]
    .sort((a, b) => a.number - b.number)
    .map((i) => {
      const status = i.state === 'closed' ? (i.merged ? 'BUILT' : 'closed without a merge') : 'planned';
      const labels = i.labels.length ? ` · labels: ${i.labels.join(', ')}` : '';
      return [`### #${i.number} — ${i.title}`, `status: ${status}${labels}`, '', i.body.trim() || '(no body)'].join('\n');
    })
    .join('\n\n---\n\n');
}

export function mirrorPrompt(repo: string, issues: readonly IssueDigest[]): string {
  return [
    `Below is every GitHub issue from the repository \`${repo}\`, open and closed.`,
    `Issues marked BUILT were closed by a merged pull request; those marked planned are not built yet.`,
    ``,
    `Write the README this project would have if its issues were the only evidence of what it is.`,
    `Describe what it is, what it does, the surfaces it exposes, the constraints it operates under,`,
    `and what is built versus planned. Write it as a README, not as a summary of the issues:`,
    `no issue numbers, no "this issue adds", no list of tickets.`,
    ``,
    `Where the issues do not say, write nothing rather than inventing it. A short honest README is`,
    `the correct answer for a repo whose issues cover little.`,
    ``,
    `Output the README only, with no preamble.`,
    ``,
    `## The issues`,
    ``,
    renderIssues(issues),
  ].join('\n');
}

export function comparePrompt(repo: string, mirror: string, readme: string): string {
  return [
    `Two descriptions of the same repository, \`${repo}\`.`,
    ``,
    `README A was written from the project's GitHub issues alone, by someone who never saw the real README.`,
    `README B is the one actually in the repository.`,
    ``,
    `Report where they disagree, and only where a reader would act differently because of it.`,
    `Wording, ordering, tone and level of detail are NOT disagreements.`,
    ``,
    `Sort each disagreement into exactly one kind:`,
    `- "unbuilt-promise": B claims something A has no sign of. Usually a stale README, sometimes missing work.`,
    `- "unannounced-surface": A describes something B never mentions. Usually a README that is behind.`,
    `- "contradiction": both describe the same thing, differently. Quote BOTH sides verbatim.`,
    ``,
    `Reply with one fenced \`\`\`${MIRROR_FENCE} block containing JSON:`,
    `{"findings":[{"kind":"…","subject":"…","readmeSays":"…"|null,"issuesSay":"…"|null,"detail":"…"}]}`,
    `An empty findings array is a valid and useful answer.`,
    ``,
    `## README A — implied by the issues`,
    ``,
    mirror,
    ``,
    `## README B — the repository's own`,
    ``,
    readme,
  ].join('\n');
}

const KINDS: MirrorFinding['kind'][] = ['unbuilt-promise', 'unannounced-surface', 'contradiction'];

/** Parse the fenced verdict. Anything unparseable yields no findings and says so. */
export function parseMirror(text: string, issues: readonly IssueDigest[]): { findings: MirrorFinding[]; parsed: boolean } {
  const fence = new RegExp('```' + MIRROR_FENCE + '\\s*([\\s\\S]*?)```', 'i').exec(text)
    ?? /```(?:json)?\s*(\{[\s\S]*?\})\s*```/.exec(text);
  const raw = fence?.[1]?.trim();
  if (!raw) return { findings: [], parsed: false };
  let parsedJson: unknown;
  try { parsedJson = JSON.parse(raw); } catch { return { findings: [], parsed: false }; }
  const rows = (parsedJson as { findings?: unknown })?.findings;
  if (!Array.isArray(rows)) return { findings: [], parsed: false };
  const findings: MirrorFinding[] = [];
  for (const r of rows as Record<string, unknown>[]) {
    const kind = KINDS.includes(r.kind as MirrorFinding['kind']) ? (r.kind as MirrorFinding['kind']) : null;
    const subject = typeof r.subject === 'string' ? r.subject.trim() : '';
    if (!kind || !subject) continue;
    const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
    findings.push({
      kind, subject,
      readmeSays: str(r.readmeSays),
      issuesSay: str(r.issuesSay),
      // The compare pass never sees issue numbers (the mirror has none), so the
      // link back is made here, by matching the subject against issue titles.
      issues: matchIssues(subject, issues),
      detail: str(r.detail) ?? '',
    });
  }
  return { findings: sortFindings(findings), parsed: true };
}

const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'for', 'to', 'in', 'on', 'is', 'it', 'its', 'with', 'per', 'by', 'that', 'this', 'from', 'as', 'at', 'be']);

/** Issues whose title shares a distinctive word with the subject. Best-effort: a pointer, not a claim. */
export function matchIssues(subject: string, issues: readonly IssueDigest[]): number[] {
  const words = new Set(subject.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3 && !STOP.has(w)));
  if (!words.size) return [];
  const hits: { n: number; score: number }[] = [];
  for (const i of issues) {
    const title = i.title.toLowerCase();
    let score = 0;
    for (const w of words) if (title.includes(w)) score++;
    if (score) hits.push({ n: i.number, score });
  }
  return hits.sort((a, b) => b.score - a.score || a.n - b.n).slice(0, 5).map((h) => h.n);
}

/** Contradictions first: they are the ones where work is already aimed wrong. */
export function sortFindings(findings: readonly MirrorFinding[]): MirrorFinding[] {
  const rank = (k: MirrorFinding['kind']): number => (k === 'contradiction' ? 0 : k === 'unbuilt-promise' ? 1 : 2);
  return [...findings].sort((a, b) => rank(a.kind) - rank(b.kind) || a.subject.localeCompare(b.subject));
}

export interface MirrorInput {
  repo: string;
  issues: readonly IssueDigest[];
  readme: string;
  port: MirrorPort;
  now?: () => Date;
}

/**
 * Both passes.
 *
 * The first prompt contains the issues and no README; the second contains both
 * READMEs and no tools. Nothing here reads a file, which is what makes the
 * blinding a property of the code rather than a promise in a prompt.
 */
export async function runSpecMirror(input: MirrorInput): Promise<MirrorReport> {
  const now = input.now ?? (() => new Date());
  if (!input.issues.length) {
    return {
      repo: input.repo, generatedAt: now().toISOString(), mirror: '', findings: [],
      issuesSha256: issuesSha256(input.issues), readmeSha256: sha256(input.readme), issueCount: 0, parsed: false,
      note: 'no issues on this repo: there is nothing to mirror',
    };
  }
  const mirror = (await input.port.ask(mirrorPrompt(input.repo, input.issues))).trim();
  const readme = input.readme.trim();
  if (!readme) {
    return {
      repo: input.repo, generatedAt: now().toISOString(), mirror, findings: [],
      issuesSha256: issuesSha256(input.issues), readmeSha256: sha256(input.readme), issueCount: input.issues.length, parsed: true,
      note: 'the repo has no README — the mirror above is a starting point, not a comparison',
    };
  }
  const verdict = await input.port.ask(comparePrompt(input.repo, mirror, readme));
  const { findings, parsed } = parseMirror(verdict, input.issues);
  return {
    repo: input.repo, generatedAt: now().toISOString(), mirror, findings,
    issuesSha256: issuesSha256(input.issues), readmeSha256: sha256(input.readme), issueCount: input.issues.length, parsed,
    note: parsed ? null : 'the comparison returned nothing parseable — no findings should be read from this run',
  };
}

/** A cached report is reusable only while BOTH documents are byte-identical. */
export function isFresh(report: MirrorReport | null, issues: readonly IssueDigest[], readme: string): boolean {
  if (!report) return false;
  return report.issuesSha256 === issuesSha256(issues) && report.readmeSha256 === sha256(readme);
}

/**
 * A finding as a rubric-shaped draft, for the ordinary propose → lint → file path.
 *
 * Only one of the three kinds is work a worktree-bound student can finish. An
 * unannounced surface is a documentation change with a checkable result: the
 * README gains a section, and a reviewer can see it in the diff.
 *
 * The other two are decisions, not tasks. Choosing between building a promise
 * and withdrawing it is a product call, and a contradiction is exactly the case
 * where nobody yet knows which side is right — handing either to a student
 * means it picks one at random and the PR looks fine. Both are filed
 * `needsHuman`, which is the engine's park path, rather than dressed up as
 * buildable work.
 */
export function draftFromFinding(finding: MirrorFinding): IssueDraft {
  const slug = finding.subject.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'spec-drift';
  const refs = finding.issues.length ? `\n\nRelated issues: ${finding.issues.map((n) => `#${n}`).join(', ')}.` : '';
  const quotes = [
    finding.readmeSays ? `- The README says: "${finding.readmeSays}"` : null,
    finding.issuesSay ? `- The issues say: "${finding.issuesSay}"` : null,
  ].filter(Boolean).join('\n');
  const found = `\n\n<!-- found by the spec mirror: the README implied by this repo's issues disagreed with the one in the repo -->`;

  if (finding.kind === 'unannounced-surface') {
    return {
      key: `docs-readme-${slug}`,
      title: `docs: the README does not mention ${finding.subject}`,
      body: [
        '## Goal',
        `The repository builds ${finding.subject}, and its README never says so. Document it.`,
        '',
        '## Scope',
        '- `README.md` only. No behaviour changes.',
        '',
        '## What the two sources say',
        quotes || `- The issues describe ${finding.subject}; the README does not mention it.`,
        finding.detail ? `\n${finding.detail}` : '',
        '',
        '## Acceptance',
        `- [ ] The README describes ${finding.subject}, in the place a reader would look for it.`,
        '- [ ] The description matches what the linked issues actually built, with no capability the code does not have.',
        '- [ ] No file outside the README changes.',
        refs, found,
      ].join('\n'),
      labels: ['documentation'],
      owns: ['README.md'],
    };
  }

  const isContradiction = finding.kind === 'contradiction';
  return {
    key: `spec-${isContradiction ? 'contradiction' : 'promise'}-${slug}`,
    title: isContradiction
      ? `decide: the README and the issues disagree about ${finding.subject}`
      : `decide: the README promises ${finding.subject}, and no issue builds it`,
    body: [
      '## Goal',
      isContradiction
        ? `The README and this repo's issues describe ${finding.subject} differently. Until someone says which is right, every student working near it is aimed at the wrong target.`
        : `The README promises ${finding.subject}. Nothing in the issues builds it. Either it should be built, or the README should stop claiming it.`,
      '',
      '## What the two sources say',
      quotes || '(nothing quotable was returned)',
      finding.detail ? `\n${finding.detail}` : '',
      '',
      '## Why this is parked rather than assigned',
      'This is a decision, not a task. A student handed it would pick a side at random and the pull request would look correct either way.',
      '',
      '## Acceptance',
      '- [ ] A human decides which side is right and records the decision here.',
      isContradiction
        ? '- [ ] The losing side is corrected: either the README is rewritten or a follow-up issue is filed to change the behaviour.'
        : '- [ ] Either a follow-up issue exists to build it, or the README no longer claims it.',
      refs, found,
    ].join('\n'),
    needsHuman: true,
  };
}
