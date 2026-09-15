// Scope triage splits an issue too big to build into pieces, and stamps each
// piece with where it came from:
//
//   Carved out of #45 by scope triage. Covers: 1, 2, 3
//
// That footer is written by live.ts and splitRunner.ts and is the only record
// that the pieces belong to a parent. Nothing reads it back, and that is the
// gap this module closes.
//
// The failure it catches, observed on dungeonworks: #45 was split into #110 and
// #111 on 2026-08-14. The next day PR #129 implemented #45 WHOLESALE and closed
// it. The two carve-outs were never closed, so the board kept dispatching them
// against work that was already merged -- 9 and 6 attempts, plus a rewrite
// escalation, before the watchdog gave up and mislabelled both `runner-error`.
//
// A parent closing as COMPLETED via a merged PR is repo evidence, not a guess:
// the parent's whole scope landed, and a carve-out covers a SUBSET of that
// scope. That is a stronger basis for `already-satisfied` than the student
// self-report emptyRun.ts uses, and it costs no dispatch at all to observe.
//
// Deliberately narrow. A parent closed as NOT_PLANNED says nothing about
// whether the children are still wanted -- someone may have closed the umbrella
// precisely BECAUSE the pieces now carry the work. Only COMPLETED counts.

/** A carve-out and the issue it was split from. */
export interface CarveOut {
  /** The piece's own issue number. */
  child: number;
  /** The issue it was carved out of. */
  parent: number;
}

// Both writers use "Carved out of #<n>" and then diverge ("by scope triage.
// Covers: ..." vs ", which needs a human for: ..."), so match only the shared
// prefix. Anchored to line start so a passing mention in prose -- "this is
// unrelated to the work carved out of #12" -- cannot register a parent.
const CARVED_FROM = /^\s*Carved out of #(\d+)\b/im;

/** The issue this body was carved out of, or null if it is not a carve-out. */
export function parentIssue(body: string): number | null {
  const m = CARVED_FROM.exec(body ?? '');
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Every carve-out among these issues, paired with its parent. */
export function carveOuts(issues: { number: number; body: string }[]): CarveOut[] {
  const out: CarveOut[] = [];
  for (const i of issues) {
    const parent = parentIssue(i.body);
    // A body claiming to be carved out of itself is malformed, not a cycle to
    // chase -- drop it rather than letting it park itself later.
    if (parent !== null && parent !== i.number) out.push({ child: i.number, parent });
  }
  return out;
}

/**
 * Carve-outs whose parent is NOT among the open issues — the only ones worth
 * asking GitHub about.
 *
 * The open set comes from the ingest that already happened, so this narrowing is
 * free: a parent still open cannot have been completed, and the overwhelming
 * majority of carve-outs on a live board are in exactly that state. Only what
 * survives here costs an API call.
 */
export function candidatesForSweep(all: CarveOut[], openIssueNumbers: Set<number>): CarveOut[] {
  return all.filter((c) => !openIssueNumbers.has(c.parent));
}

/** Distinct parent numbers to resolve, so one parent shared by five pieces is one call. */
export function parentsToResolve(candidates: CarveOut[]): number[] {
  return [...new Set(candidates.map((c) => c.parent))];
}

/** What GitHub says about a parent issue's closure. */
export interface ParentClosure {
  closed: boolean;
  /** CLOSED with stateReason COMPLETED — as opposed to NOT_PLANNED / DUPLICATE. */
  completed: boolean;
  /** The merged PR that closed it, when GitHub records one. */
  byPr: number | null;
}

/**
 * The carve-outs whose parent completed, and the PR that did it.
 *
 * Requires `completed` AND a closing PR. Completion alone is not enough: an
 * issue hand-closed as done leaves no artifact to point an operator at, and a
 * park an operator cannot check is a park they have to take on faith.
 */
export function supersededBy(
  candidates: CarveOut[],
  closure: Map<number, ParentClosure>,
): { child: number; parent: number; pr: number }[] {
  const out: { child: number; parent: number; pr: number }[] = [];
  for (const c of candidates) {
    const st = closure.get(c.parent);
    if (st?.closed && st.completed && st.byPr !== null) {
      out.push({ child: c.child, parent: c.parent, pr: st.byPr });
    }
  }
  return out;
}
