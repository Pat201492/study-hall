import type { QuotaObservation, QuotaWindow } from '@study-hall/harness/contract';

// Pacing from the PROVIDER'S OWN window (issue #20).
//
// The fixed tokens/hour cap (rateBudget.ts) is predictable but blind: it knows
// nothing about how much of the five-hour window is actually left, so the right
// number is a guess that has to be re-guessed whenever the fleet or the model
// changes. This is the other half — it reads the utilization the provider
// itself reports, measures how fast that number is climbing, and compares it
// with what the time remaining affords.
//
// The output feeds the SAME `rateCapped` seam the token cap uses, so there is
// one failover path, one hold reason and one thing to explain: a lane burning
// its window faster than the window can afford is rested until it is not.
//
// Pure over (observations, clock, options).

export interface PaceOptions {
  /** Off unless the operator turns it on, like every other governor here. */
  enabled?: boolean;
  /**
   * Shortest span of observations that may produce a verdict.
   *
   * Two observations a few seconds apart can show any slope at all — one long
   * turn landing is a step change, not a trend. Below this the answer is "not
   * enough evidence", never "fine".
   */
  minSpanMs?: number;
  /** Observations older than this are ignored: the recent slope is the signal. */
  lookbackMs?: number;
  /**
   * How much faster than affordable is allowed before resting.
   *
   * 1 rests the moment the burn would finish the window early. Above 1 tolerates
   * a burst — useful because a board's burn is lumpy, and a window that ends ten
   * minutes early costs nothing if the work landed.
   */
  tolerance?: number;
  /** Ignore a window that resets within this long: the tail is noise. */
  minRemainingMs?: number;
}

export const DEFAULT_PACE: Required<Omit<PaceOptions, 'enabled'>> = {
  minSpanMs: 5 * 60_000,
  lookbackMs: 45 * 60_000,
  tolerance: 1.25,
  minRemainingMs: 5 * 60_000,
};

export interface PaceWindowVerdict {
  /** 'fiveHour' | 'sevenDay' | a provider-specific extra window name. */
  window: string;
  utilization: number;
  resetsAt: number;
  /** Fraction of the window consumed per ms, observed. Null = not enough evidence. */
  slope: number | null;
  /** Fraction per ms the remaining time affords. */
  sustainable: number;
  /** When this window runs out at the observed rate. Null when not burning. */
  projectedExhaustionAt: number | null;
  /** slope / sustainable. Above `tolerance` is too fast. */
  ratio: number | null;
  tooFast: boolean;
}

export interface PaceVerdict {
  provider: string;
  capped: boolean;
  /** The window that binds (the fastest-burning one), or null when none does. */
  limiting: PaceWindowVerdict | null;
  windows: PaceWindowVerdict[];
  reason: string | null;
  /** Why no verdict could be formed, when that is the case. */
  note: string | null;
}

/** A utilization reading for one window at one moment. */
export interface PaceSample { at: number; window: string; utilization: number; resetsAt: number }

const WINDOW_LABEL: Record<string, string> = { fiveHour: '5-hour', sevenDay: '7-day' };

/** Flatten observations into per-window samples, newest last. */
export function paceSamples(observations: readonly QuotaObservation[]): PaceSample[] {
  const out: PaceSample[] = [];
  const push = (at: number, name: string, w: QuotaWindow | undefined): void => {
    if (!w || !Number.isFinite(w.utilization) || !Number.isFinite(w.resetsAt)) return;
    out.push({ at, window: name, utilization: w.utilization, resetsAt: w.resetsAt });
  };
  for (const o of observations) {
    const at = o.observedAt;
    if (!Number.isFinite(at)) continue;
    push(at, 'fiveHour', o.fiveHour);
    push(at, 'sevenDay', o.sevenDay);
    for (const [name, w] of Object.entries(o.extra ?? {})) push(at, name, w);
  }
  return out.sort((a, b) => a.at - b.at);
}

function assessWindow(samples: PaceSample[], now: number, o: Required<Omit<PaceOptions, 'enabled'>>): PaceWindowVerdict | null {
  const recent = samples.filter((s) => s.at > now - o.lookbackMs);
  if (!recent.length) return null;
  const last = recent[recent.length - 1];
  const remaining = last.resetsAt - now;
  if (remaining <= o.minRemainingMs) return null; // the tail of a window is noise
  const sustainable = Math.max(0, 1 - last.utilization) / remaining;

  // A utilization DROP means the window rolled over: everything before it
  // describes a window that no longer exists.
  let start = 0;
  for (let i = 1; i < recent.length; i++) if (recent[i].utilization < recent[i - 1].utilization) start = i;
  const run = recent.slice(start);
  const first = run[0];
  const span = last.at - first.at;
  const base: Omit<PaceWindowVerdict, 'slope' | 'projectedExhaustionAt' | 'ratio' | 'tooFast'> = {
    window: last.window, utilization: last.utilization, resetsAt: last.resetsAt, sustainable,
  };
  if (run.length < 2 || span < o.minSpanMs) return { ...base, slope: null, projectedExhaustionAt: null, ratio: null, tooFast: false };

  const slope = Math.max(0, (last.utilization - first.utilization) / span);
  const left = Math.max(0, 1 - last.utilization);
  const projectedExhaustionAt = slope > 0 ? now + left / slope : null;
  const ratio = sustainable > 0 ? slope / sustainable : slope > 0 ? Infinity : 0;
  return { ...base, slope, projectedExhaustionAt, ratio, tooFast: ratio > o.tolerance };
}

/**
 * Is this provider burning its own window faster than the window affords?
 *
 * Reports every window it can judge, and rests on the fastest-burning one. A
 * provider with no usable observation returns `capped: false` with a `note`
 * saying so — silence here must never read as permission OR as a block; the
 * fixed token cap remains whatever it was.
 */
export function assessPace(provider: string, samples: readonly PaceSample[], now: number, opts: PaceOptions = {}): PaceVerdict {
  const o = { ...DEFAULT_PACE, ...opts };
  if (!opts.enabled) return { provider, capped: false, limiting: null, windows: [], reason: null, note: 'window pacing is off' };
  const byWindow = new Map<string, PaceSample[]>();
  for (const s of samples) {
    if (!byWindow.has(s.window)) byWindow.set(s.window, []);
    byWindow.get(s.window)!.push(s);
  }
  const windows: PaceWindowVerdict[] = [];
  for (const [, rows] of byWindow) {
    const v = assessWindow(rows.sort((a, b) => a.at - b.at), now, o);
    if (v) windows.push(v);
  }
  if (!windows.length) return { provider, capped: false, limiting: null, windows, reason: null, note: 'no usable window observation yet' };
  const judged = windows.filter((w) => w.ratio != null);
  if (!judged.length) return { provider, capped: false, limiting: null, windows, reason: null, note: `not enough evidence yet (need ${Math.round(o.minSpanMs / 60_000)} min of observations)` };

  const worst = judged.sort((a, b) => (b.ratio ?? 0) - (a.ratio ?? 0))[0];
  if (!worst.tooFast) return { provider, capped: false, limiting: worst, windows, reason: null, note: null };
  const label = WINDOW_LABEL[worst.window] ?? worst.window;
  const mins = (ms: number): string => `${Math.max(1, Math.round(ms / 60_000))} min`;
  const early = worst.projectedExhaustionAt != null ? worst.resetsAt - worst.projectedExhaustionAt : 0;
  return {
    provider, capped: true, limiting: worst, windows,
    reason: `${label} window ${Math.round(worst.utilization * 100)} % used and burning ${worst.ratio === Infinity ? 'with no headroom left' : `${worst.ratio!.toFixed(1)}x faster than it affords`}`
      + (early > 0 ? ` — it would run out ${mins(early)} before it resets` : ''),
    note: null,
  };
}
