import type { OpenPull } from './github.js';

// Who drives the merge after review (local copy of v1 config.ts:26 — the only
// two StudyRoomConfig fields this module reads, so core needs no config import):
//   'auto'  — a review-role student's approve is trusted; the engine self-merges
//             a reviewed-ok PR (still subject to autoMerge + green + mergeable).
//   'human' — the engine reviews + labels but never merges; it stops at
//             reviewed-ok for a human to merge (mirrors autoMerge:false, but
//             explicit that the ENGINE did the review).
export type ReviewMode = 'auto' | 'human';

/** The two board-policy fields the merge gates read. */
export interface MergePolicy {
  autoMerge?: boolean;
  reviewMode?: ReviewMode;
}

// Board POLICY, separated from the orchestrator that acts on it (live.ts).
//
// Every function here is pure over its inputs — a PR's labels/checks/mergeability
// or two config fields — so the ladder that decides FIX > RESOLVE > MERGE >
// REVIEW can be read and tested without loading the LiveRunner. That matters
// because these six functions ARE the safety rules: what may merge, what a human
// still owns, and what an ambiguous review means.

// A MERGE-gate decision: merge the PR now, or wait (with the blocking reason so
// the log says *why* an open PR is sitting there).
export type MergeDecision = { action: 'merge' } | { action: 'wait'; reason: string };

// The MERGE gate: may this open PR be squash-merged now? Order is deliberate —
// the review verdict is checked before the merge gates so a reviewed-ok PR that
// still waits reports "waiting for a human", not "unreviewed" (the acceptance
// "otherwise it waits, reviewed"). reviewMode of none/off/skip drops the
// reviewed-ok requirement (no reviewer in the loop); reviewMode 'human' keeps the
// review but never self-merges (a human merges the reviewed-ok PR); 'auto' (the
// default) trusts the engine's own approve and proceeds to merge. Merging never
// bypasses a configured review.
// The ONE reader of config.reviewMode. Everything that acts on review policy
// goes through this, because the two call sites had already drifted: mergeGate
// lowercased its input and canAutoMerge did not, so `reviewMode: "Human"` made
// canAutoMerge return true (merge allowed) while mergeGate said wait. They
// disagreed, and the disagreement failed OPEN on the side that grants merge
// permission — classify is fed canAutoMerge, so such a board emitted MERGE
// actions for PRs a human was supposed to merge.
//
// An unrecognised value fails CLOSED, to 'human'. config.json carried
// "standard", which is not a valid ReviewMode; it silently fell through to full
// auto-merge because it merely wasn't the string 'human'. A value nobody
// recognises must not grant permission to merge unattended — the safe reading
// of "I don't know what you meant" is "ask a person".
export type NormalizedReviewMode = 'auto' | 'human' | 'no-review';

export function normalizeReviewMode(raw?: string): { mode: NormalizedReviewMode; recognised: boolean } {
  const v = (raw ?? 'auto').trim().toLowerCase();
  if (!v || v === 'auto') return { mode: 'auto', recognised: true };
  if (v === 'human') return { mode: 'human', recognised: true };
  // Explicitly "no reviewer in the loop" — drops the reviewed-ok requirement.
  if (v === 'none' || v === 'off' || v === 'skip') return { mode: 'no-review', recognised: true };
  return { mode: 'human', recognised: false };
}

// A human-readable complaint about an unrecognised reviewMode, or null. Callers
// log this at boot so a typo is loud rather than silently changing merge policy.
export function reviewModeIssue(raw?: string): string | null {
  if (normalizeReviewMode(raw).recognised) return null;
  return `reviewMode "${raw}" is not valid (use auto | human | none). `
    + 'Treating it as "human" — the engine will review and label but never merge for you.';
}

export function mergeGate(pr: OpenPull, autoMerge: boolean, reviewMode?: string): MergeDecision {
  const { mode } = normalizeReviewMode(reviewMode);
  const requiresReview = mode !== 'no-review';
  if (pr.labels.includes('changes-requested')) return { action: 'wait', reason: 'changes-requested' };
  if (requiresReview && !pr.labels.includes('reviewed-ok')) return { action: 'wait', reason: 'awaiting reviewed-ok' };
  // reviewMode 'human': the engine reviewed + labelled, but the merge is a human's
  // to make — an explicit-about-WHO-reviewed stop, distinct from autoMerge off.
  if (mode === 'human') return { action: 'wait', reason: 'reviewMode human — human merges' };
  if (!autoMerge) return { action: 'wait', reason: 'autoMerge off — human merges' };
  if (pr.statusCheckRollup === 'FAILURE') return { action: 'wait', reason: 'checks red' };
  if (pr.statusCheckRollup === 'PENDING') return { action: 'wait', reason: 'checks pending' };
  if (pr.mergeable !== 'MERGEABLE') return { action: 'wait', reason: `not mergeable (${pr.mergeable})` };
  return { action: 'merge' };
}

// A RESOLVE-gate decision: hand this PR to a resolver now, or wait (with why).
export type ResolveDecision = { action: 'resolve' } | { action: 'wait'; reason: string };

// The RESOLVE gate: should this open PR be handed to a resolver now? Order
// mirrors the classify ladder — a PR that also has changes-requested or red CI
// belongs to FIX first (resolving conflicts on top of unfixed code just re-
// conflicts), so only a purely CONFLICTING PR resolves. Pure over its input.
export function resolveGate(pr: OpenPull): ResolveDecision {
  const changesRequested = pr.labels.includes('changes-requested') || pr.reviewDecision === 'CHANGES_REQUESTED';
  if (changesRequested) return { action: 'wait', reason: 'changes-requested — fix first' };
  if (pr.statusCheckRollup === 'FAILURE') return { action: 'wait', reason: 'checks red — fix first' };
  if (pr.mergeable === 'CONFLICTING') return { action: 'resolve' };
  return { action: 'wait', reason: `not conflicting (${pr.mergeable})` };
}

// A FIX-gate decision: hand this PR to a fixer now, or wait (with why).
export type FixDecision = { action: 'fix' } | { action: 'wait'; reason: string };

// The FIX gate: does this open PR need a fixer now? Mirrors classify.ts's FIX
// branch, the top of the PR ladder — a changes-requested verdict OR red CI
// hands the PR to a fixer ahead of RESOLVE/REVIEW/MERGE (fixing the code before
// re-resolving conflicts on top of it, or re-reviewing it). Pure over the PR,
// so it's unit-testable without a `gh` binary.
export function fixGate(pr: OpenPull): FixDecision {
  const changesRequested = pr.labels.includes('changes-requested') || pr.reviewDecision === 'CHANGES_REQUESTED';
  const redCI = pr.statusCheckRollup === 'FAILURE';
  if (changesRequested || redCI) return { action: 'fix' };
  return { action: 'wait', reason: 'no changes-requested / red CI' };
}

// The REVIEW gate: does this open PR still need a review verdict? Mirrors
// classify.ts's REVIEW branch — a PR that a reviewer/fixer/resolver already owns
// (changes-requested, red CI, conflicting) or that already carries a verdict
// (reviewed-ok / APPROVED) is NOT for the reviewer. Everything else — an open PR
// with no verdict yet — is exactly the "role Study Room advertises but never
// runs live" this action fills. Pure over the PR, so it's unit-testable.
export function needsReview(pr: OpenPull): boolean {
  const changesRequested = pr.labels.includes('changes-requested') || pr.reviewDecision === 'CHANGES_REQUESTED';
  const reviewedOk = pr.labels.includes('reviewed-ok') || pr.reviewDecision === 'APPROVED';
  const redCI = pr.statusCheckRollup === 'FAILURE';
  if (changesRequested || redCI) return false;      // FIX owns it
  if (pr.mergeable === 'CONFLICTING') return false; // RESOLVE owns it
  return !reviewedOk;
}

export type ReviewVerdict = 'APPROVE' | 'REQUEST_CHANGES';

// Parse a reviewer student's free text into one verdict. The review prompt asks
// for a final `VERDICT: APPROVE|REQUEST_CHANGES` line (last one wins, so a prior
// mention in the reasoning doesn't override the conclusion); absent that, fall
// back to phrasing keywords. Conservative default: an unparseable review does
// NOT approve — it requests changes, so an ambiguous verdict can never green-light
// a merge.
export function parseVerdict(text: string): ReviewVerdict {
  const t = text.toUpperCase();
  const marks = [...t.matchAll(/VERDICT:\s*(APPROVE|REQUEST[_ -]?CHANGES)/g)];
  if (marks.length) {
    return marks[marks.length - 1][1].startsWith('APPROVE') ? 'APPROVE' : 'REQUEST_CHANGES';
  }
  if (/REQUEST[_ -]?CHANGES|CHANGES[_ -]?REQUESTED/.test(t)) return 'REQUEST_CHANGES';
  if (/\bAPPROVED?\b/.test(t)) return 'APPROVE';
  return 'REQUEST_CHANGES';
}

// May the engine self-merge a reviewed-ok PR? Only when the board opts into
// autoMerge AND the review isn't gated to a human. reviewMode 'human' reviews +
// labels but leaves the merge to a person, so it must never self-merge — this is
// the policy classify's `autoMerge` flag is fed (a 'human'-mode board therefore
// never yields a MERGE action; the PR waits at reviewed-ok). Pure over the two
// config fields, so the gating is unit-testable.
export function canAutoMerge(cfg: Pick<MergePolicy, 'autoMerge' | 'reviewMode'>): boolean {
  // Via normalizeReviewMode, NOT a raw !== 'human' — see the note there. A bare
  // comparison here is what let "Human" and "standard" through.
  return (cfg.autoMerge ?? false) && normalizeReviewMode(cfg.reviewMode).mode !== 'human';
}
