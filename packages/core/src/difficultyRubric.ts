import type { Difficulty } from './difficulty.js';
import type { IssueAuditSignals } from './issueAudit.js';

// The difficulty rubric: how an issue earns `difficulty:simple|standard|hard`.
//
// This exists because the label used to be the ONLY thing that decided which
// model builds an issue. `difficultyFromLabels()` won over every heuristic, and
// on the live boards 70 of 71 open issues carry one — so the keyword inference
// in difficulty.ts was effectively dead code, and the label was the whole
// control surface. A wrong label is not cosmetic; it routes work to the wrong tier.
//
// Since #302 the label shares that job with the issue's own stated criteria, and
// can only RAISE the difficulty, never lower it — see effectiveDifficulty() for
// the measurement that forced the change. The rubric below is still what a model
// filing an issue reads, and it still matters: the label is the only way to tier
// an issue UP beyond what its text implies.
//
// Measured on this engine, over 48 implement dispatches:
//
//                                merged   approved FIRST review   tokens/session
//   work routed to opus           100%          85% (17/20)            1.09M
//   work labelled `simple`         82%          48% (12/25)            2.74M
//
// The second row is the important one. Those were the issues someone had judged
// EASY, and they came back for rework at more than twice the rate and cost 2.5x
// more tokens than the hard work did. "Import: batch rollback" and "Review:
// equipment history view" were both labelled `simple`. Neither is trivia.
//
// Hence the asymmetry rule below. Over-labelling costs ~1.67x per token for one
// session. Under-labelling costs an extra review round, an extra fix, and a
// second session — and session cost is roughly QUADRATIC in length, so one
// avoided rework round pays for the stronger tier many times over.

/** The sheet, in the words the model filing an issue actually reads. */
export const DIFFICULTY_RUBRIC = [
  `## Difficulty labels — how to tag an issue`,
  ``,
  `Every issue you file MUST carry exactly one of \`difficulty:simple\`,`,
  `\`difficulty:standard\` or \`difficulty:hard\`. Together with the criteria you`,
  `write, that label decides which model builds it — so it is part of the`,
  `deliverable, not decoration.`,
  ``,
  `The engine counts your stated criteria and applies the same bands below. Your`,
  `label can only tier an issue UP from what those criteria imply, never down: a`,
  `\`simple\` label on an issue listing nine criteria is ignored, because it was`,
  `measured to be wrong far more often than it was right.`,
  ``,
  `Count the INDEPENDENTLY CHECKABLE criteria (things that must each be true for`,
  `the issue to be done) and the distinct subsystems the work touches, then:`,
  ``,
  `  difficulty:simple    <=2 criteria, ONE file or one mechanical edit, no new`,
  `                       module, nothing else depends on the result. A wrong`,
  `                       first attempt is cheap to throw away and redo.`,
  `                       Typos, renames, changelog entries, lint/formatting.`,
  ``,
  `  difficulty:standard  3-6 criteria, confined to files that already belong`,
  `                       together, editing existing modules rather than adding`,
  `                       new contracts. This is the normal case.`,
  ``,
  `  difficulty:hard      ANY of: 7 or more criteria; touches 3+ subsystems or`,
  `                       packages; creates a new module, schema or contract that`,
  `                       other work will depend on; or involves security, auth,`,
  `                       concurrency, data migration or money.`,
  ``,
  `WHEN UNSURE, CHOOSE THE HARDER LABEL. This is not caution for its own sake —`,
  `it is measured. On this board, work labelled \`simple\` was approved on its first`,
  `review only 48% of the time and burned 2.5x more tokens than work routed to the`,
  `strongest model, which merged 100% of the time. Labelling up costs ~1.67x per`,
  `token for one session. Labelling down costs another review round, another fix,`,
  `and a second session — and a session's cost grows with the SQUARE of its`,
  `length, so a single avoided rework round pays for the stronger tier many times`,
  `over.`,
  ``,
  `\`simple\` means TRIVIA. If you find yourself justifying why something is simple,`,
  `it is not simple.`,
].join('\n');

/**
 * The difficulty the issue's own text implies, from the same mechanical signals
 * the audit already extracts.
 *
 * Still never used to SET a label — labelling stays a judgement call. It began
 * as a checker on one: a rubric that only lives in a prompt is a hope, and
 * prompt instructions have a poor record on this engine — two shipped, both
 * measured, both reverted. Since #302 the same signal also drives TIERING
 * through effectiveDifficulty(), which is the deterministic path that does not
 * depend on anyone having labelled correctly.
 *
 * Thresholds mirror the rubric's wording exactly, so the sheet and the checker
 * cannot drift apart without a test noticing.
 */
export function expectedDifficulty(signals: IssueAuditSignals): Difficulty {
  const criteria = Math.max(signals.criteria, signals.checkable);
  // SUBSYSTEMS, not file paths. The rubric's words are "touches 3+ subsystems or
  // packages", and counting raw paths does not measure that: a well-scoped piece
  // that edits `composer/manifest.py`, `composer/__init__.py` and two test files
  // names four paths but spans two packages. Scored on paths, every one of scope
  // triage's own split pieces came out `hard` — which would have made the checker
  // disagree with the rubric it exists to enforce.
  if (criteria >= 7 || signals.subsystems >= 3) return 'hard';
  if (criteria <= 2 && signals.subsystems <= 1) return 'simple';
  return 'standard';
}

/**
 * Thresholds for turning a criteria count into a difficulty (#302).
 *
 * Defaults mirror docs/ISSUE-RUBRIC.md word for word — <=2 simple, 3-6
 * standard, 7+ hard — so the sheet students read, the checker, and the tiering
 * decision cannot drift apart. They are configurable because the bands are a
 * measurement, and a measurement can be redone; they are not configurable so
 * that someone can tune them by feel.
 */
export interface AcTieringConfig {
  /** Off restores label-only tiering exactly as it was before #302. */
  enabled: boolean;
  /** At or below this many criteria (with <=1 subsystem) an issue is trivia. */
  simpleMax: number;
  /** At or above this many criteria an issue is hard, whatever else it says. */
  hardMin: number;
}

export const DEFAULT_AC_TIERING: AcTieringConfig = { enabled: true, simpleMax: 2, hardMin: 7 };

/** Fill a partial on-disk config from the measured defaults. Callers pass what
 *  the config file held, which may name one field or none. */
export function resolveAcTiering(cfg?: Partial<AcTieringConfig>): AcTieringConfig {
  return { ...DEFAULT_AC_TIERING, ...(cfg ?? {}) };
}

/** Criteria the body actually states — triage's strict count or the audit's
 *  broader one, whichever saw more. 0 means nothing parsed. */
export function criteriaCount(signals: IssueAuditSignals): number {
  return Math.max(signals.criteria, signals.checkable);
}

const RANK: Record<Difficulty, number> = { simple: 0, standard: 1, hard: 2 };

/**
 * How far a label sits below what the issue's text implies.
 *
 * Only UNDER-labelling is reported, and that asymmetry is the point: routing a
 * small issue to a strong model wastes a fraction of one session, while routing
 * a large one to a weak model buys a rework loop. Returns 0 when the label is at
 * or above the implied level.
 */
export function underLabelledBy(label: Difficulty, signals: IssueAuditSignals): number {
  return Math.max(0, RANK[expectedDifficulty(signals)] - RANK[label]);
}

/** Same rubric, with the thresholds made explicit so they can be re-measured. */
export function expectedDifficultyWith(
  signals: IssueAuditSignals, partial?: Partial<AcTieringConfig>,
): Difficulty {
  const cfg = resolveAcTiering(partial);
  const criteria = criteriaCount(signals);
  if (criteria >= cfg.hardMin || signals.subsystems >= 3) return 'hard';
  if (criteria <= cfg.simpleMax && signals.subsystems <= 1) return 'simple';
  return 'standard';
}

/** Where a task's difficulty came from — carried so the dry run and the log can
 *  say WHY an issue moved tier, rather than only that it did. */
export type DifficultySource = 'label' | 'criteria' | 'label-no-criteria' | 'disabled';

export interface EffectiveDifficulty {
  difficulty: Difficulty;
  source: DifficultySource;
  /** Criteria the body stated; 0 when nothing parsed. */
  criteria: number;
}

/**
 * The difficulty an issue should actually be built at (#302).
 *
 * The label used to decide this alone. Measured over 126 dungeonworks issues
 * paired with their transcripts, that label correlates with tokens spent at
 * **rho = -0.056** — no relationship at all, and if anything inverted: issues
 * labelled `hard` spent a median 13.1M tokens while issues labelled `standard`
 * spent 24.9M. The stated criteria count correlates at **rho = 0.557**, and the
 * rubric's own bands separate cleanly: <=2 criteria 3.8M, 3-6 criteria 6.6M, 7+
 * criteria 28.1M. So the count is the signal and the label is noise.
 *
 * Two rules keep that from being reckless.
 *
 * **The stronger of the two wins.** A label is a human (or triage) judgement and
 * may know something the text does not say, so it can only raise, never lower.
 * The asymmetry is the same one underLabelledBy() was built on and it is
 * measured: over-tiering wastes ~1.67x per token on one session, under-tiering
 * buys a whole rework round, and session cost grows with the square of length.
 * The corpus says under-calling is also the direction this board actually errs
 * in — 87 of 126 issues carried 7+ criteria while 102 were labelled `standard`.
 *
 * **No parsed criteria means no opinion.** An issue whose body states nothing
 * checkable yields criteria 0, which would otherwise satisfy `<= simpleMax` and
 * route real work to the cheapest tier on the strength of a badly written issue.
 * That is the one failure this function must not have, so it hands back to the
 * label instead. Empty is unknown, never easy.
 */
export function effectiveDifficulty(
  label: Difficulty | undefined,
  signals: IssueAuditSignals,
  fallback: Difficulty,
  partial?: Partial<AcTieringConfig>,
): EffectiveDifficulty {
  const cfg = resolveAcTiering(partial);
  const criteria = criteriaCount(signals);
  if (!cfg.enabled) return { difficulty: label ?? fallback, source: 'disabled', criteria };
  // Nothing checkable in the body: the count carries no information, so the
  // label (or the keyword inference behind it) keeps the decision.
  if (criteria === 0) return { difficulty: label ?? fallback, source: 'label-no-criteria', criteria };

  const expected = expectedDifficultyWith(signals, cfg);
  if (!label) return { difficulty: expected, source: 'criteria', criteria };
  return RANK[expected] > RANK[label]
    ? { difficulty: expected, source: 'criteria', criteria }
    : { difficulty: label, source: 'label', criteria };
}
