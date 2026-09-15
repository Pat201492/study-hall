// Quarantine with a way out.
//
// Quarantine exists so the board stops spending on an item that cannot converge
// (#112's unrelated-histories loop). It works. What it lacked was an exit: the
// only releases were a human deleting the label and a PR passing review, so an
// item condemned by a bad hour stayed condemned until somebody noticed.
//
// That is not hypothetical. A session limit on 2026-08-13 quarantined ten healthy
// issues; a segfaulting CLI on 2026-08-22 quarantined twenty-two more. Both were
// environments failing, not items -- and both times the board sat holding real
// work behind a label until a human cleared it by hand.
//
// The obvious fix is to classify the failure and forgive the environmental ones,
// and that is done (isCapacityError, isInfraFailure). But classification is a
// blocklist: it forgives the failure modes we have already been burned by, and
// the next novel one arrives unrecognised and condemns the board exactly as
// before. Twice now the "new" failure was a variation on the old one.
//
// Parole is the complement, and it needs to know nothing about causes. Every
// quarantined item is retried eventually. If it was condemned by an outage it
// simply works and rejoins the board; if it is genuinely stuck it fails again and
// goes back with a longer sentence. The backoff means a truly bad item settles at
// roughly one wasted dispatch a day, which is cheap, while nothing healthy is
// held indefinitely on the strength of a single bad afternoon.

export interface ParoleConfig {
  /** How long the FIRST sentence lasts before a retry. */
  firstMs: number;
  /** Multiplier on each re-offence. */
  factor: number;
  /** Longest a sentence may get -- the floor on how often a bad item costs a dispatch. */
  maxMs: number;
}

export const DEFAULT_PAROLE: ParoleConfig = {
  // Long enough that a session limit (which states its own reset, usually hours
  // out) has cleared, short enough that a day's work is not lost to one bad hour.
  firstMs: 2 * 60 * 60_000,
  factor: 2,
  // A genuinely non-converging item then costs about one dispatch a day. Cheaper
  // than the human attention that clearing it by hand would take.
  maxMs: 24 * 60 * 60_000,
};

/** What the runner persists per quarantined key. */
export interface ParoleRecord {
  /** When the CURRENT sentence started (epoch ms). */
  at: number;
  /** How many times this item has already been paroled and re-condemned. */
  paroles: number;
}

/** How long this item's current sentence runs. */
export function sentenceMs(rec: ParoleRecord, cfg: ParoleConfig = DEFAULT_PAROLE): number {
  const grown = cfg.firstMs * cfg.factor ** Math.max(0, rec.paroles);
  return Math.min(grown, cfg.maxMs);
}

/** Is this item's sentence served? */
export function isDue(rec: ParoleRecord, now: number, cfg: ParoleConfig = DEFAULT_PAROLE): boolean {
  return now - rec.at >= sentenceMs(rec, cfg);
}

/**
 * Which quarantined keys have served their sentence.
 *
 * Returned in the order given, so a caller releasing under a cap releases the
 * longest-held first rather than whichever the map happened to yield.
 */
export function dueForParole(
  records: Iterable<[string, ParoleRecord]>,
  now: number,
  cfg: ParoleConfig = DEFAULT_PAROLE,
): string[] {
  return [...records]
    .filter(([, rec]) => isDue(rec, now, cfg))
    .sort((a, b) => a[1].at - b[1].at)
    .map(([key]) => key);
}

/** The record for an item being quarantined again after a parole. */
export function reoffend(prev: ParoleRecord | undefined, now: number): ParoleRecord {
  return { at: now, paroles: (prev?.paroles ?? 0) + 1 };
}

/** The record for an item quarantined for the first time. */
export function firstOffence(now: number): ParoleRecord {
  return { at: now, paroles: 0 };
}

/**
 * Read back persisted parole state, tolerating the legacy shape.
 *
 * quarantine.json used to be a bare string[]. Those keys are real quarantines and
 * must survive the upgrade -- dropping them would un-park every item a previous
 * run had condemned. They are dated from `now`, which gives each one a full first
 * sentence rather than releasing the whole backlog at once on the first tick
 * after an upgrade.
 */
export function parseParole(raw: unknown, now: number): Map<string, ParoleRecord> {
  const out = new Map<string, ParoleRecord>();
  if (!Array.isArray(raw)) return out;
  for (const entry of raw) {
    if (typeof entry === 'string') { out.set(entry, firstOffence(now)); continue; }
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const key = typeof e.key === 'string' ? e.key : '';
    if (!key) continue;
    const at = typeof e.at === 'number' && Number.isFinite(e.at) ? e.at : now;
    const paroles = typeof e.paroles === 'number' && Number.isFinite(e.paroles) ? Math.max(0, e.paroles) : 0;
    out.set(key, { at, paroles });
  }
  return out;
}

/** The persisted shape: self-describing, and still readable by the legacy loader. */
export function serializeParole(records: Map<string, ParoleRecord>): { key: string; at: number; paroles: number }[] {
  return [...records].map(([key, rec]) => ({ key, at: rec.at, paroles: rec.paroles }));
}
