import type { RawIssue } from './github.js';

// Issue triage: decide whether an issue is achievable as ONE pull request
// before a student starts writing code, and split it if not.
//
// The failure this exists to stop, observed on Trader-Screener: #126 took 16
// commits across 10 review rounds and never converged, because the issue asked
// for more than one coherent PR could satisfy. Each fix answered the last
// objection and drew a fresh one. #128's review found "three of five axes were
// never really varied" — one acceptance criterion needed GPU runs no single PR
// could deliver. Nothing in the engine ever asked "is this one PR's worth?".
//
// Triage may SPLIT and may COMMENT. It may not delete or weaken an acceptance
// criterion: the same model reviews against that bar later, so letting it lower
// the bar would make the review meaningless. Splitting preserves every
// requirement and only redistributes it.
//
// Pure and deterministic — no network, no clock — so the gate and the parsing
// are unit-testable without a board.

// Labels that record triage state, so an issue is assessed at most once.
export const TRIAGED_LABEL = 'triaged';
export const EPIC_LABEL = 'epic';

/** A sub-issue a triage student proposes carving out of an oversized issue. */
export interface SplitProposal {
  title: string;
  body: string;
  /** Which acceptance criteria of the parent this piece carries. Free text. */
  covers: string;
}

export interface TriageVerdict {
  /** true = one PR can satisfy the whole issue; leave it alone. */
  singlePr: boolean;
  reason: string;
  splits: SplitProposal[];
}

// Heuristic gate. Triage costs a student, so only issues that LOOK oversized
// pay for it. Tuned against the observed boards: Trader-Screener's issues run
// 3,900-6,200 chars and its PRs churned; PoolWorks and putt-pilot ran
// 2,000-2,400 chars and landed first or second try.
export interface TriageGate {
  /** Body length past which an issue is a triage candidate. */
  maxChars: number;
  /** Distinct acceptance criteria / checklist lines past which likewise. */
  maxCriteria: number;
}

export const DEFAULT_TRIAGE_GATE: TriageGate = {
  // Below the smallest Trader-Screener issue that churned, above the largest
  // issue on a board that finished cleanly.
  maxChars: 3000,
  // Four or more separately-checkable outcomes rarely land as one reviewable
  // diff — that is the shape #126 and #128 both had.
  //
  // Raised 4 -> 7 (v1 triage.ts:57). The rubric that students and the planner
  // are held to calls 3-6 criteria the `standard` band and 7+ `hard`
  // (DEFAULT_AC_TIERING.hardMin), so at 4 this gate contradicted the rubric it
  // sits behind: a compliant 4-6 criteria issue paid an Opus triage session to
  // be told SINGLE_PR. Now the gate, the audit and TRIAGE_ROLE's split bar all
  // agree on 7. #126/#128 remain well above it.
  maxCriteria: 7,
};

const LINE_BREAK = /\r?\n/;
const CHECKBOX = /^\s*[-*]\s*\[[ xX]\]/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*)$/;
const LIST_ITEM = /^\s*([-*]|\d+\.)\s+\S/;
const CRITERIA_HEADING = /acceptance|requirement|deliverable|criteria/;

/**
 * How many separately-verifiable outcomes this issue asks for.
 *
 * Checkboxes win outright when present — an explicit checklist is the clearest
 * statement an issue can make about what must independently be true.
 *
 * Otherwise, list items under a criteria-ish heading are counted PER SECTION
 * and the largest section wins, rather than summed. Issues routinely restate
 * the same requirements under both "Deliverables" and "Acceptance": cardworks#4
 * does exactly that, and summing scored it 6, which would have triaged a
 * 1,425-character issue for no reason.
 */
export function countCriteria(body: string): number {
  const lines = (body ?? '').split(LINE_BREAK);

  const checkboxes = lines.filter((l) => CHECKBOX.test(l)).length;
  if (checkboxes) return checkboxes;

  const perSection = new Map<string, number>();
  let section = '';
  for (const line of lines) {
    const heading = line.match(HEADING);
    if (heading) {
      const title = heading[1].toLowerCase();
      section = CRITERIA_HEADING.test(title) ? title : '';
      continue;
    }
    if (section && LIST_ITEM.test(line)) {
      perSection.set(section, (perSection.get(section) ?? 0) + 1);
    }
  }
  return perSection.size ? Math.max(...perSection.values()) : 0;
}

/**
 * Is this issue worth spending a triage student on?
 *
 * Deliberately a cheap syntactic signal, not a judgement — the judgement is the
 * student's job. Getting this wrong only costs (or saves) one dispatch; it
 * never blocks work, because an issue that fails the gate goes straight to
 * IMPLEMENT exactly as before.
 */
export function needsTriage(issue: RawIssue, gate: TriageGate = DEFAULT_TRIAGE_GATE): boolean {
  const labels = issue.labels.map((l) => l.name.toLowerCase());
  // Already assessed, or already an epic a human is managing.
  if (labels.includes(TRIAGED_LABEL) || labels.includes(EPIC_LABEL)) return false;
  const body = issue.body ?? '';
  return body.length > gate.maxChars || countCriteria(body) >= gate.maxCriteria;
}

export const SPLIT_FENCE = 'triage-splits';

/**
 * Parse a triage student's verdict.
 *
 * The student proposes; the ORCHESTRATOR files. Same division as the Editor's
 * `editor-proposals` (#84): an instance filing its own issues cannot dedupe
 * against what a previous pass filed, and cannot be stopped from filing junk.
 *
 * A verdict that says "one PR", or that fails to parse at all, both mean "leave
 * it alone" — the safe direction is always to proceed with the issue unchanged
 * rather than to carve up a real board from a malformed answer.
 */
export function parseTriage(text: string): TriageVerdict {
  const leave = (reason: string): TriageVerdict => ({ singlePr: true, reason, splits: [] });
  if (/VERDICT:\s*SINGLE_PR/i.test(text)) return leave('student judged it one PR of work');

  const fence = new RegExp('```' + SPLIT_FENCE + '\\s*([\\s\\S]*?)```', 'i');
  const m = text.match(fence);
  // Models drop the language tag often enough that being strict would lose real
  // proposals; fall back to any fenced JSON array.
  const raw = m ? m[1] : (text.match(/```(?:json)?\s*(\[[\s\S]*?\])\s*```/)?.[1] ?? '');
  if (!raw.trim()) return leave('no split proposed');

  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return leave('split block was not valid JSON'); }
  if (!Array.isArray(parsed)) return leave('split block was not a list');

  const splits = parsed
    .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
    .map((p) => ({
      title: String(p.title ?? '').trim(),
      body: String(p.body ?? '').trim(),
      covers: String(p.covers ?? '').trim(),
    }))
    .filter((p) => p.title && p.body);

  // A "split" into one piece is the original issue wearing a hat. Two is the
  // minimum that actually distributes anything.
  if (splits.length < 2) return leave(`only ${splits.length} usable piece(s) proposed`);

  return { singlePr: false, reason: `split into ${splits.length} pieces`, splits };
}
