import type { RawIssue } from './github.js';
import { countCriteria, TRIAGED_LABEL, EPIC_LABEL } from './triage.js';

// Issue audit: is this issue actually fit to hand to a student?
//
// The board had a gate for one failure mode (too big -> TRIAGE) and none for
// its opposite. An issue with no acceptance criteria went straight to an
// implementer, who then had to INVENT the scope; the reviewer later judged that
// invented scope against criteria that never existed, requested changes, and the
// fix loop ran until something gave. The engine spent a full session to discover
// what a regex can see for free.
//
// Measured on 69 real sessions, the case for doing this deterministically:
//   - a student session costs ~2.5M tokens and its cost is QUADRATIC in length,
//     so the cheapest possible check is the one that never spawns a student;
//   - triage, the one gate that did exist, returned SINGLE_PR 40 times out of 40
//     while spending a student each time -- a judgement call that expensive
//     should only be paid for when a cheap signal says it is needed.
//
// So this module is pure, synchronous, and free: no network, no clock, no CLI.
// It reads the issue text and nothing else, which also makes every threshold
// directly unit-testable against real issue bodies.
//
// It deliberately does NOT judge technical merit. "Is this a good idea" is a
// human/Editor question. This asks only "can a student act on this as written".

export type AuditVerdict =
  /** Fit to build: dispatch as normal. */
  | 'ready'
  /** Too much for one PR: worth paying a triage student to split it. */
  | 'oversized'
  /** Not actionable as written: no criteria a reviewer could judge against. */
  | 'underspecified';

export interface IssueAuditSignals {
  bodyChars: number;
  /** Size signal — triage's stricter counter, used for the oversized verdict. */
  criteria: number;
  /** Actionability signal — the broader counter, used for underspecified. */
  checkable: number;
  /** Distinct file/module paths named in the body (a proxy for blast radius). */
  paths: number;
  /** Distinct top-level subsystems the body names (blast radius). */
  subsystems: number;
  /** Phrases that defer scope instead of stating it ("etc", "and so on"). */
  vagueMarkers: number;
  hasCriteriaSection: boolean;
}

export interface IssueAudit {
  verdict: AuditVerdict;
  /** Human-readable reasons, for the log line and the issue comment. */
  reasons: string[];
  signals: IssueAuditSignals;
}

export interface IssueAuditGate {
  /** Bodies shorter than this cannot carry a buildable spec. */
  minChars: number;
  /** Bodies longer than this are oversized regardless of criteria count. */
  maxChars: number;
  /** This many separately-checkable outcomes is more than one PR. */
  maxCriteria: number;
  /** Naming this many distinct paths means the change spans too much. */
  maxPaths: number;
}

// Thresholds are set from the boards actually observed, not from taste.
//
// minChars 200: every issue that built cleanly first try carried at least a goal
// plus one criterion, which does not fit in less.
//
// maxChars/maxCriteria match DEFAULT_TRIAGE_GATE so this module cannot disagree
// with the gate it feeds -- an issue this calls `oversized` is exactly one
// needsTriage() would send to a triage student.
//
// maxCriteria 7, not 4 (v1 issueAudit.ts:82). The rubric's `standard` band is
// 3-6 criteria — "the normal case" — and its `hard` band starts at 7
// (DEFAULT_AC_TIERING.hardMin). At 4 a rubric-compliant standard issue was
// `oversized` here, routed to TRIAGE by classify, and TRIAGE_ROLE — which
// splits at a higher bar — reliably spent an Opus session to answer SINGLE_PR
// (40 verdicts out of 40 in the measured window). The three thresholds now
// name the same number: 7+ is the point where the tiering rubric says `hard`,
// this audit says `oversized`, and the triage prompt says split.
//
// maxPaths 8: dungeonworks issues that ran 70-130 turns named this many or more
// distinct modules; the ones that landed named a handful.
export const DEFAULT_AUDIT_GATE: IssueAuditGate = {
  minChars: 200,
  maxChars: 3000,
  maxCriteria: 7,
  maxPaths: 8,
};

const CRITERIA_HEADING = /^\s{0,3}#{1,6}\s+.*(acceptance|requirement|deliverable|criteria|definition of done)/im;

// What the AUDIT counts as "something a reviewer could check". Deliberately
// broader than triage's countCriteria(), and deliberately a separate function.
//
// triage's counter feeds a SIZE gate, where over-counting means paying for an
// unnecessary triage student. This one feeds an ACTIONABILITY gate, where
// under-counting means blocking real work — so the two want different errors and
// must not share a threshold.
//
// Measured: the first version reused triage's counter and called all 24 open
// test-tracker issues underspecified, because that board writes a bulleted
// `## Scope` section with a PROSE `## Acceptance` summary. Those issues are
// well-specified; the counter simply could not see their format.
const CRITERIA_WORDS = /(acceptance|requirement|deliverable|criteria|definition of done|scope|tasks?|behaviou?r)/i;
const CHECKABLE_HEADING = new RegExp(`^\\s{0,3}#{1,6}\\s+.*${CRITERIA_WORDS.source}`, 'i');
const HEADING_ANY = /^\s{0,3}#{1,6}\s+(.*)$/;

// A criteria section does not have to be a markdown heading. Scope triage files
// its split pieces as `Acceptance criteria carried:` followed by a numbered
// list, and the Editor uses bold labels — neither is a `##` heading, so a
// heading-only rule scored the engine's OWN output as zero criteria. That is the
// worst possible blind spot: it would mark every freshly-split issue
// `underspecified` and route it by path count alone.
//
// Bounded deliberately: short, ends in a colon, and names a criteria word. A
// sentence of prose that happens to contain "scope" does not open a section.
const LABEL_LINE = new RegExp(`^\\s{0,3}(?:[*_]{0,2})[^.!?]{0,80}${CRITERIA_WORDS.source}[^.!?]{0,40}:\\s*(?:[*_]{0,2})\\s*$`, 'i');
const CHECKBOX_ANY = /^\s*[-*]\s*\[[ xX]\]/;
const LIST_ANY = /^\s*([-*]|\d+\.)\s+\S/;

/** Minimum prose under an acceptance heading to count as a stated outcome. */
const MIN_PROSE_CHARS = 40;

/**
 * Count of independently checkable things this issue asks for, by ANY of the
 * conventions the boards actually use: checkboxes, bullets under a scope- or
 * acceptance-ish heading, or a prose acceptance statement.
 */
export function countCheckable(body: string): number {
  const lines = (body ?? '').split(/\r?\n/);

  const boxes = lines.filter((l) => CHECKBOX_ANY.test(l)).length;
  if (boxes) return boxes;

  const perSection = new Map<string, number>();
  const prose = new Map<string, number>();
  let section = '';
  for (const line of lines) {
    const h = line.match(HEADING_ANY);
    if (h) { section = CHECKABLE_HEADING.test(line) ? h[1].toLowerCase() : ''; continue; }
    // A non-heading label line opens a section too, but never closes one: a
    // heading is the only thing that ends a criteria block.
    if (LABEL_LINE.test(line)) { section = line.trim().toLowerCase(); continue; }
    if (!section) continue;
    if (LIST_ANY.test(line)) perSection.set(section, (perSection.get(section) ?? 0) + 1);
    else prose.set(section, (prose.get(section) ?? 0) + line.trim().length);
  }
  if (perSection.size) return Math.max(...perSection.values());
  // No bullets, but a real prose statement of what must be true still gives a
  // reviewer something to judge against.
  for (const chars of prose.values()) if (chars >= MIN_PROSE_CHARS) return 1;
  return 0;
}

// Scope-deferring phrases. Each says "there is more here, decide it yourself",
// which is precisely the decision a reviewer cannot later check the work
// against. Word-bounded so `etcetera` in prose does not count twice.
const VAGUE = [
  /\betc\.?\b/i,
  /\band so on\b/i,
  /\band more\b/i,
  /\bas (?:needed|appropriate|required)\b/i,
  /\bvarious\b/i,
  /\bamong others\b/i,
  /\bif necessary\b/i,
  /\bwhere applicable\b/i,
];

// A path-ish token: `dir/file.ext`, `pkg/module`, or a backticked path. Matching
// on the slash keeps ordinary prose out -- "the LLM adapter" is not a path,
// `dmserver/llm.py` is.
// A path must END IN A REAL FILE EXTENSION.
//
// The previous pattern also accepted any `word/word`, which in an issue body is
// overwhelmingly PROSE, not a path: `ruff/mypy clean`, `verify/license logic`,
// `.png/.webp/.jpg`, `layout/decoration passes`, `categories/layers/anchors`.
// Every one of those was counted as a distinct file. The resulting `paths`
// figure was noise — it is why three tightly-scoped split pieces scored 11, 6
// and 12 "paths", and any threshold tuned against it (including the correlation
// that put paths at r=0.19) was measuring nothing.
//
// The extension list is closed on purpose. An open `\.\w+$` re-admits
// `.png/.webp` and `dwcore.tags.load_vocab()`.
const PATH_EXT = 'py|ts|tsx|js|jsx|json|ya?ml|md|toml|cfg|ini|sql|sh|css|html|rs|go|java|rb|php|swift|kt';
const PATH_TOKEN = new RegExp(String.raw`(?:^|[\s\`("'\[])([\w.-]+(?:\/[\w.-]+)+\.(?:${PATH_EXT}))\b`, 'g');

/** Distinct file/module paths named in the body. */
export function countPaths(body: string): number {
  return pathsIn(body).size;
}

function pathsIn(body: string): Set<string> {
  const found = new Set<string>();
  for (const m of (body ?? '').matchAll(PATH_TOKEN)) {
    const p = m[1].replace(/[.,;:)\]`'"]+$/, '');
    // A bare URL is a reference, not a file this issue touches.
    if (/^https?:/.test(p) || p.includes('://')) continue;
    found.add(p.toLowerCase());
  }
  return found;
}

/**
 * Distinct SUBSYSTEMS the body names — the top-level segment of each path.
 *
 * Blast radius is about how many parts of the tree a change spans, not how many
 * files it lists. `composer/manifest.py` and `composer/__init__.py` are one
 * subsystem; `composer/…` and `dwcore/…` are two. Counting raw paths made a
 * tightly-scoped issue that happens to enumerate its files look enormous.
 */
// Directories that are a CONSEQUENCE of a change rather than part of its blast
// radius. Every issue worth building touches tests, and most touch docs, so
// counting them adds a constant to every score and discriminates nothing —
// while pushing tightly-scoped work over a "3+ subsystems" bar. `.github` is
// deliberately NOT here: changing CI genuinely does widen the blast radius.
const NOT_BLAST_RADIUS = new Set(['test', 'tests', '__tests__', 'spec', 'specs', 'docs', 'doc']);

export function countSubsystems(body: string): number {
  const roots = new Set<string>();
  for (const p of pathsIn(body)) {
    const head = p.split('/')[0];
    if (!head || head === '.' || head === '..') continue;
    if (NOT_BLAST_RADIUS.has(head)) continue;
    roots.add(head);
  }
  return roots.size;
}

/** How many distinct scope-deferring phrases the body uses. */
export function countVague(body: string): number {
  return VAGUE.filter((re) => re.test(body ?? '')).length;
}

export function auditSignals(body: string): IssueAuditSignals {
  const text = body ?? '';
  return {
    bodyChars: text.length,
    criteria: countCriteria(text),
    checkable: countCheckable(text),
    paths: countPaths(text),
    subsystems: countSubsystems(text),
    vagueMarkers: countVague(text),
    hasCriteriaSection: CRITERIA_HEADING.test(text),
  };
}

/**
 * Audit one issue.
 *
 * Order matters and is chosen: `underspecified` is checked BEFORE `oversized`,
 * because a vague issue that is also long is still vague — splitting it would
 * just produce several vague issues, and the split would be made by a student
 * guessing at criteria that were never written down.
 *
 * An issue a human has already ruled on (`triaged`/`epic`) is always `ready`.
 * Those labels are the record that the scope question was settled, and
 * re-litigating it every heartbeat is how an issue gets quarantined for reasons
 * nothing logged.
 */
export function auditIssue(issue: RawIssue, gate: IssueAuditGate = DEFAULT_AUDIT_GATE): IssueAudit {
  const body = issue.body ?? '';
  const signals = auditSignals(body);
  const labels = issue.labels.map((l) => l.name.toLowerCase());
  // `triaged`/`epic` settle the SIZE question only, and deliberately not the
  // criteria question. Measured reason: triage returned SINGLE_PR 40/40 and
  // labelled every issue `triaged` on the way through, so treating that label
  // as a blanket exemption made this audit blind to exactly the issues it
  // exists to catch — dungeonworks#8 carried 11 criteria and 12 paths, cost
  // 53.1M tokens, and was waved through as `ready`.
  //
  // Size still has to defer to the label or the board livelocks: classify
  // routes `oversized` to TRIAGE, and TRIAGE is what sets `triaged`, so
  // re-judging size after triage has spoken would re-dispatch it every
  // heartbeat until the watchdog quarantined the issue.
  const sizeSettled = labels.includes(TRIAGED_LABEL) || labels.includes(EPIC_LABEL);

  const reasons: string[] = [];

  {
    // Length is only evidence when criteria are ABSENT. An issue that states
    // six explicit checkboxes in four short lines is perfectly actionable, and
    // an early version of this function called it underspecified on character
    // count alone — flagging the clearest issues on the board. Criteria first,
    // length only as a fallback signal for issues that state none.
    //
    // The HEADING alone is not criteria. An `## Acceptance` section containing
    // prose rather than checkable items leaves a reviewer with nothing to judge
    // against, which is the same failure as having no section at all:
    // test-tracker#27 has the heading, parses to zero criteria, and ran 202
    // turns for 13.6M tokens. Only countable items count.
    const hasCriteria = signals.checkable > 0;
    if (!hasCriteria) {
      reasons.push(signals.hasCriteriaSection
        ? 'has an acceptance section but nothing checkable in it'
        : 'no acceptance criteria a reviewer could judge the PR against');
      if (signals.bodyChars < gate.minChars) {
        reasons.push(`body is only ${signals.bodyChars} chars — too short to state a goal and a criterion`);
      }
      return { verdict: 'underspecified', reasons, signals };
    }

    // Everything below is the SIZE judgement, which defers to triage's label.
    if (sizeSettled) return { verdict: 'ready', reasons: ['scope already assessed'], signals };

    if (signals.criteria >= gate.maxCriteria) {
      reasons.push(`${signals.criteria} separately-checkable criteria (limit ${gate.maxCriteria})`);
    }
    if (signals.bodyChars > gate.maxChars) {
      reasons.push(`body is ${signals.bodyChars} chars (limit ${gate.maxChars})`);
    }
    if (signals.paths > gate.maxPaths) {
      reasons.push(`names ${signals.paths} distinct paths (limit ${gate.maxPaths}) — blast radius spans too much`);
    }
    if (reasons.length) return { verdict: 'oversized', reasons, signals };
  }

  return { verdict: 'ready', reasons: ['actionable as written'], signals };
}

/** Label applied to an issue the audit could not accept. */
export const NEEDS_DETAIL_LABEL = 'needs-detail';

/**
 * The comment posted on an underspecified issue.
 *
 * It names the missing thing rather than refusing vaguely, because the whole
 * point is that a human (or the Editor) can fix it in one edit and the board
 * picks it up on the next ingest with no further intervention.
 */
export function needsDetailComment(audit: IssueAudit): string {
  return [
    `**Study Room did not start this issue: it is not actionable as written.**`,
    ``,
    ...audit.reasons.map((r) => `- ${r}`),
    ``,
    `An implementer given this would have to invent the scope, and the reviewer`,
    `would then judge that invented scope against criteria that were never`,
    `stated — which is a fix/review loop that cannot converge.`,
    ``,
    `Add an \`## Acceptance\` section listing what must independently be true, and`,
    `the board will pick this up on its next ingest. Remove the`,
    `\`${NEEDS_DETAIL_LABEL}\` label to force it through unchanged.`,
  ].join('\n');
}


