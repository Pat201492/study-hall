import type { QuotaObservation } from '@study-hall/harness/contract';
import type { RateSample } from './rateBudget.js';
import { paceSamples, type PaceSample } from './windowPace.js';

// How many TOKENS a vendor window actually holds.
//
// Anthropic and OpenAI both report a window as a percentage and a reset time,
// never as a quantity. That is unusable for setting an hourly cap: the Overview
// can say "the five-hour window is 31 % used" and "13.2 M tokens last hour" and
// leave the operator to relate the two by feel.
//
// The quantity is derivable. Two readings of the same window give a utilization
// delta; the runs that landed between them give the tokens that caused it; the
// implied capacity is tokens / delta. Nothing is requested from the vendor that
// the engine is not already reading off the stream.
//
// Three things this will not do:
//
//   - Infer from a delta too small to be signal. Utilization arrives rounded to
//     whole percents, so a one-point move carries up to 100 % error.
//   - Infer across a window rollover. A utilization DROP describes a window that
//     no longer exists; the same rule window pacing uses.
//   - Average. One cache-heavy run would set the number. The median of the
//     samples is reported with its spread, so a wide spread stays visible.
//
// It is an ESTIMATE from below whenever spend is unbanked: a turn that burns
// without writing a ledger row moves the vendor's percentage but contributes no
// tokens here, which makes the implied capacity look smaller than it is. That is
// why `ledgerSpentThisWindow` is reported beside it — the two disagreeing is the
// symptom, and the fix is to bank every turn that burns.

export interface CapacityOptions {
  /** Utilization must move at least this much for a pair to be usable. */
  minDelta?: number;
  /** Pairs spanning longer than this are dropped: the longer the gap, the more unbanked spend hides in it. */
  maxSpanMs?: number;
  /** A pair carrying less than this many tokens says nothing. */
  minTokens?: number;
}

export const DEFAULT_CAPACITY: Required<CapacityOptions> = {
  minDelta: 0.02,
  maxSpanMs: 2 * 60 * 60_000,
  minTokens: 1_000,
};

/** One (delta, tokens) pair and what it implies. */
export interface CapacitySample {
  window: string;
  from: number;
  to: number;
  tokens: number;
  delta: number;
  /** tokens / delta — the whole window at this burn. */
  implied: number;
}

export interface CapacityEstimate {
  window: string;
  /** Implied tokens for the whole window; null when nothing can be inferred yet. */
  tokens: number | null;
  /** How many usable pairs the estimate rests on. */
  samples: number;
  /** Spread across those pairs; equal to `tokens` when there is only one. */
  low: number | null;
  high: number | null;
  /** The window's own latest reading. */
  utilization: number | null;
  resetsAt: number | null;
  /** estimate x utilization, and estimate x (1 - utilization). */
  impliedSpent: number | null;
  remaining: number | null;
  /**
   * Tokens the LEDGER can account for inside the current window. Well below
   * `impliedSpent` means turns are burning without banking a run row.
   */
  ledgerSpentThisWindow: number | null;
  note: string | null;
}

/** 'fiveHour' -> 5 h. An extra window named like `30d` or `12h` is parsed. */
export function windowDurationMs(window: string): number | null {
  if (window === 'fiveHour') return 5 * 60 * 60_000;
  if (window === 'sevenDay') return 7 * 24 * 60 * 60_000;
  const m = /^(\d+)\s*([hd])$/i.exec(window.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  return m[2].toLowerCase() === 'h' ? n * 60 * 60_000 : n * 24 * 60 * 60_000;
}

const median = (xs: readonly number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

const tokensBetween = (spend: readonly RateSample[], from: number, to: number): number =>
  spend.reduce((n, s) => (s.at > from && s.at <= to ? n + s.tokens : n), 0);

/**
 * Every usable (delta, tokens) pair, oldest first.
 *
 * A pair is usable when both readings describe the SAME window instance (equal
 * `resetsAt`, so no rollover happened between them), utilization rose by at
 * least `minDelta`, the gap is no longer than `maxSpanMs`, and the ledger has
 * at least `minTokens` to explain it.
 */
export function capacitySamples(
  observations: readonly QuotaObservation[], spend: readonly RateSample[], opts: CapacityOptions = {},
): CapacitySample[] {
  const o = { ...DEFAULT_CAPACITY, ...opts };
  const byWindow = new Map<string, PaceSample[]>();
  for (const s of paceSamples(observations)) {
    const rows = byWindow.get(s.window) ?? [];
    rows.push(s);
    byWindow.set(s.window, rows);
  }
  const out: CapacitySample[] = [];
  for (const [window, rows] of byWindow) {
    rows.sort((a, b) => a.at - b.at);
    for (let i = 1; i < rows.length; i++) {
      const a = rows[i - 1];
      const b = rows[i];
      if (a.resetsAt !== b.resetsAt) continue; // the window rolled over between the two
      const delta = b.utilization - a.utilization;
      if (delta < o.minDelta) continue; // noise, or nothing happened
      if (b.at - a.at > o.maxSpanMs) continue;
      const tokens = tokensBetween(spend, a.at, b.at);
      if (tokens < o.minTokens) continue; // the ledger cannot explain this move
      out.push({ window, from: a.at, to: b.at, tokens, delta, implied: tokens / delta });
    }
  }
  return out.sort((x, y) => x.to - y.to);
}

/**
 * Per-window capacity, keyed by window name.
 *
 * Every window the observations mention appears, so a window with no usable
 * pair yet reports `tokens: null` with a note saying why rather than vanishing.
 */
export function estimateWindowCapacity(
  observations: readonly QuotaObservation[], spend: readonly RateSample[], now: number, opts: CapacityOptions = {},
): Record<string, CapacityEstimate> {
  const samples = capacitySamples(observations, spend, opts);
  const byWindow = new Map<string, CapacitySample[]>();
  for (const s of samples) {
    const rows = byWindow.get(s.window) ?? [];
    rows.push(s);
    byWindow.set(s.window, rows);
  }
  const latest = new Map<string, PaceSample>();
  for (const s of paceSamples(observations)) {
    const seen = latest.get(s.window);
    if (!seen || s.at > seen.at) latest.set(s.window, s);
  }

  const out: Record<string, CapacityEstimate> = {};
  for (const window of new Set([...latest.keys(), ...byWindow.keys()])) {
    const rows = byWindow.get(window) ?? [];
    const implied = rows.map((r) => r.implied);
    const tokens = implied.length ? Math.round(median(implied)) : null;
    const live = latest.get(window) ?? null;
    const duration = windowDurationMs(window);
    const windowStart = live && duration ? live.resetsAt - duration : null;
    const ledgerSpent = windowStart == null ? null : tokensBetween(spend, windowStart, now);
    const utilization = live?.utilization ?? null;
    out[window] = {
      window,
      tokens,
      samples: rows.length,
      low: implied.length ? Math.round(Math.min(...implied)) : null,
      high: implied.length ? Math.round(Math.max(...implied)) : null,
      utilization,
      resetsAt: live?.resetsAt ?? null,
      impliedSpent: tokens != null && utilization != null ? Math.round(tokens * utilization) : null,
      remaining: tokens != null && utilization != null ? Math.round(tokens * (1 - utilization)) : null,
      ledgerSpentThisWindow: ledgerSpent,
      note: noteFor(tokens, rows, implied),
    };
  }
  return out;
}

function noteFor(tokens: number | null, rows: readonly CapacitySample[], implied: readonly number[]): string | null {
  if (tokens == null) return 'no reading yet where the ledger can explain the move — needs two readings of one window, a rise of at least 2 points, and banked spend in between';
  if (rows.length === 1) return 'one sample: treat as an order of magnitude, not a number';
  const lo = Math.min(...implied);
  const hi = Math.max(...implied);
  // A spread this wide usually means unbanked spend, not a moving window.
  if (lo > 0 && hi / lo >= 3) return `samples disagree by ${(hi / lo).toFixed(1)}x — some spend is moving the window without banking a run row`;
  return null;
}

/**
 * The hourly cap that would spend a window exactly evenly.
 *
 * The honest way to pick a number: a five-hour window holding N tokens affords
 * N/5 per hour. Below that the board never reaches the limit; above it, it will.
 */
export function sustainableTokensPerHour(estimate: CapacityEstimate): number | null {
  const duration = windowDurationMs(estimate.window);
  if (estimate.tokens == null || !duration) return null;
  return Math.round(estimate.tokens / (duration / 3_600_000));
}
