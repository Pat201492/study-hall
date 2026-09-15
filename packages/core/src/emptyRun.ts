// "The student wrote nothing" is not one event. It is two, and they need
// opposite responses.
//
// A run that produces no diff is charged as a no-progress heartbeat, and nine of
// those give up on the item. That is right when the student failed. It is wrong
// when the student succeeded and the correct output was an empty diff — because
// the work is ALREADY on the base branch.
//
// dungeonworks #110/#111 are the worked example. Both were implemented by PR
// #129 and never closed, so every dispatch cut a worktree, found
// composer/manifest.py already complete, correctly wrote nothing, and was
// charged for it. Nine attempts and six attempts respectively, plus a rewrite
// escalation, on work that had been merged three weeks earlier.
//
// The engine already knows: commitAndPush returns false on an empty tree. What
// it lacked was any way to tell the two cases apart, so live.ts had one branch
// for both — `setStage(..., 'ready') // let it be retried`, forever.
//
// The signal costs nothing to collect, because the student already emits it.
// IMPLEMENT_ROLE requires: "list the issue's acceptance criteria one per line,
// each marked DONE or NOT DONE". That verdict is sitting in the run's own text
// and was being discarded on this path. This module reads it.
//
// Deliberately NOT a new instruction. Two previous prompt-level attempts at
// changing student behaviour backfired (cliStudent.ts) -- they told students to
// act differently and students obliged by turning one action into three. This
// adds nothing to the prompt: it parses what is already produced, and when the
// parse fails it says so, so the caller keeps today's behaviour.

/**
 * What an empty-diff run actually reported about itself.
 *
 * - `satisfied` — the student checked every acceptance criterion and found all
 *   of them already met. The item needs a human to confirm and close, not
 *   another dispatch.
 * - `blocked`   — at least one criterion is NOT DONE. A genuine failure: charge
 *   it, exactly as before.
 * - `unknown`   — no verdict could be read. Fall back to the old behaviour
 *   rather than guessing; a parser that silently invents a verdict is worse than
 *   one that abstains.
 */
export type EmptyRunVerdict = 'satisfied' | 'blocked' | 'unknown';

/** A criterion line and whether the student marked it done. */
interface Criterion { done: boolean }

// "NOT DONE" contains "DONE", so the negative has to be tested first — matching
// DONE first would read every failure as a success, which is the one error this
// module absolutely must not make.
const NOT_DONE = /\bNOT[\s_-]*DONE\b/i;
const DONE = /\bDONE\b/i;

// Students mark criteria in whatever shape reads well: "1. ... DONE",
// "- [x] ... DONE", "criterion 3 — NOT DONE". The common shape is a short line
// that ENDS in the verdict, so anchor there rather than trying to parse the
// prose in front of it.
const VERDICT_LINE = /(?:^|\n)\s*(?:[-*+]|\d+[.)]|\[[ xX]\])?\s*[^\n]{0,300}?(NOT[\s_-]*DONE|DONE)\s*[.!]?\s*(?=\n|$)/gi;

/** Every criterion verdict the run's text declares, in order. */
function readCriteria(text: string): Criterion[] {
  const out: Criterion[] = [];
  for (const m of text.matchAll(VERDICT_LINE)) {
    const verdict = m[1] ?? '';
    out.push({ done: !NOT_DONE.test(verdict) && DONE.test(verdict) });
  }
  return out;
}

/**
 * Classify a run that produced no file changes.
 *
 * Conservative by construction: `satisfied` requires that criteria were found
 * AND that every one of them is DONE. Anything ambiguous returns `unknown`, and
 * the caller then behaves exactly as it did before this module existed.
 */
export function classifyEmptyRun(text: string): EmptyRunVerdict {
  if (!text || !text.trim()) return 'unknown';
  const criteria = readCriteria(text);
  if (!criteria.length) return 'unknown';
  return criteria.every((c) => c.done) ? 'satisfied' : 'blocked';
}

/**
 * How many criteria the verdict was read from — for the log line and the issue
 * comment, so an operator can see the evidence rather than taking the engine's
 * word for it.
 */
export function criteriaCount(text: string): number {
  return readCriteria(text).length;
}
