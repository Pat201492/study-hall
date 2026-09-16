import type { Usage } from '@study-hall/harness/contract';

// Burn-rate governor: a per-provider ceiling on how much may be spent in a
// sliding window, so a subscription window is paced instead of drained.
//
// The provider's own quota signal is necessary but not sufficient. It reacts:
// `handoverAt` hands over at 90 % of a window that is already nearly gone, and
// Codex's boolean only flips once usage is refused. Neither stops a fleet of
// warm students from burning a five-hour window in forty minutes. This module
// is the predictive half — spend measured locally, per hour, per provider — and
// it makes a provider UNAVAILABLE rather than failing anything: the existing
// failover then routes the work to the other service, and takes it back when
// enough spend ages out of the window.
//
// Pure over its inputs (samples + clock), so the ladder is unit-testable and
// the dashboard can show exactly why a provider is being rested.

export interface RateLimit {
  /** Billed tokens allowed per window. 0/undefined = uncapped. */
  tokensPerHour?: number;
  /** Estimated $ allowed per window. 0/undefined = uncapped. Meaningful on a
   *  metered lane; on a subscription lane the $ is an estimate, not a bill. */
  usdPerHour?: number;
  /** The sliding window. Default one hour — the unit the operator thinks in. */
  windowMs?: number;
  /**
   * Fraction of the cap at which NEW dispatch stops.
   *
   * Below 1 because a student started at 99 % of the cap still runs to
   * completion and lands its whole spend inside the window. Reserving a slice
   * keeps the overshoot bounded by roughly one run rather than by one fleet.
   */
  headroom?: number;
}

export const DEFAULT_WINDOW_MS = 60 * 60_000;
export const DEFAULT_HEADROOM = 0.9;

/** One finished run's spend, at the time it finished. */
export interface RateSample {
  at: number;
  /**
   * When the run began. Optional: the burn governor only asks what has been
   * spent recently, and for that the completion time is the honest instant.
   * Window capacity needs the span, because it asks what was spent DURING an
   * interval bracketed by readings the run itself produced while running.
   */
  startedAt?: number;
  tokens: number;
  usd: number;
}

export interface RateFigure {
  spent: number;
  /** null = uncapped. */
  cap: number | null;
  /** spent / cap, or null when uncapped. */
  utilization: number | null;
}

export interface RateVerdict {
  provider: string;
  capped: boolean;
  tokens: RateFigure;
  usd: RateFigure;
  /** Epoch ms when enough spend ages out for dispatch to resume; null when not capped. */
  resumesAt: number | null;
  /** Which limit bit, for the log and the dashboard. */
  reason: string | null;
  /** Spend still in flight, included in `spent` (it is real money already committed). */
  inFlightTokens: number;
  windowMs: number;
}

/**
 * Everything billed in the window.
 *
 * Cache WRITES count: they are charged (1.25x on Anthropic's table) and a warm
 * pool writes a lot of them. Reasoning tokens are a separate bucket only where
 * the provider reports them separately (Codex); Claude folds thinking into
 * output and reports 0, so nothing is double-counted.
 */
export function billedTokens(u: Pick<Usage, 'inputTokens' | 'outputTokens' | 'cacheReadInputTokens' | 'cacheCreationInputTokens' | 'reasoningTokens'>): number {
  return u.inputTokens + u.outputTokens + u.cacheReadInputTokens + u.cacheCreationInputTokens + u.reasoningTokens;
}

export function resolveLimit(limit: RateLimit | undefined): Required<Pick<RateLimit, 'windowMs' | 'headroom'>> & RateLimit {
  return {
    ...limit,
    windowMs: limit?.windowMs && limit.windowMs > 0 ? limit.windowMs : DEFAULT_WINDOW_MS,
    headroom: limit?.headroom != null && limit.headroom > 0 && limit.headroom <= 1 ? limit.headroom : DEFAULT_HEADROOM,
  };
}

/** Is any cap set at all? An uncapped provider is never rested by this module. */
export function hasCap(limit: RateLimit | undefined): boolean {
  return !!((limit?.tokensPerHour ?? 0) > 0 || (limit?.usdPerHour ?? 0) > 0);
}

/**
 * Pure assessment: samples in the window plus whatever is in flight, against
 * the caps.
 *
 * `resumesAt` is computed, not guessed: walk the committed samples oldest-first
 * and find the one whose expiry brings the total back under the line; dispatch
 * resumes a window after THAT sample. In-flight spend never expires (it is
 * still running), so a provider whose in-flight spend alone exceeds the cap
 * reports `resumesAt: null` — it resumes when those runs finish and age out.
 */
export function assessRate(
  provider: string, samples: readonly RateSample[], inFlight: readonly RateSample[], limit: RateLimit | undefined, now: number,
): RateVerdict {
  const l = resolveLimit(limit);
  const from = now - l.windowMs;
  const live = samples.filter((s) => s.at > from).sort((a, b) => a.at - b.at);
  const sum = (rows: readonly RateSample[], key: 'tokens' | 'usd'): number => rows.reduce((n, s) => n + s[key], 0);
  const inFlightTokens = sum(inFlight, 'tokens');
  const spentTokens = sum(live, 'tokens') + inFlightTokens;
  const spentUsd = sum(live, 'usd') + sum(inFlight, 'usd');
  const tokenCap = (l.tokensPerHour ?? 0) > 0 ? l.tokensPerHour! : null;
  const usdCap = (l.usdPerHour ?? 0) > 0 ? l.usdPerHour! : null;
  const tokenLine = tokenCap != null ? tokenCap * l.headroom : null;
  const usdLine = usdCap != null ? usdCap * l.headroom : null;

  const overTokens = tokenLine != null && spentTokens >= tokenLine;
  const overUsd = usdLine != null && spentUsd >= usdLine;
  const capped = overTokens || overUsd;

  let resumesAt: number | null = null;
  if (capped) {
    // The binding line, in the units that bind.
    const [spent, line, pick] = overTokens
      ? [spentTokens, tokenLine!, 'tokens' as const]
      : [spentUsd, usdLine!, 'usd' as const];
    const floor = pick === 'tokens' ? inFlightTokens : sum(inFlight, 'usd');
    let remaining = spent;
    for (const s of live) {
      remaining -= s[pick];
      if (remaining < line) { resumesAt = s.at + l.windowMs; break; }
    }
    // Nothing ages out far enough: in-flight spend alone is over the line.
    if (resumesAt == null && floor >= line) resumesAt = null;
  }

  const reason = capped
    ? overTokens
      ? `${Math.round(spentTokens / 1000)}k tokens in the last ${Math.round(l.windowMs / 60_000)} min (cap ${Math.round((tokenCap ?? 0) / 1000)}k, dispatch stops at ${Math.round(l.headroom * 100)} %)`
      : `$${spentUsd.toFixed(2)} in the last ${Math.round(l.windowMs / 60_000)} min (cap $${(usdCap ?? 0).toFixed(2)})`
    : null;

  return {
    provider, capped,
    tokens: { spent: spentTokens, cap: tokenCap, utilization: tokenCap ? spentTokens / tokenCap : null },
    usd: { spent: spentUsd, cap: usdCap, utilization: usdCap ? spentUsd / usdCap : null },
    resumesAt, reason, inFlightTokens, windowMs: l.windowMs,
  };
}

/**
 * The per-provider accounting the engine keeps.
 *
 * Two buckets, never summed twice: COMMITTED samples (one per finished run,
 * seeded from the ledger at boot so a restart does not forget the last hour)
 * and LIVE spend (one entry per in-flight run, REPLACED on every usage event,
 * removed when the run commits). That split is what makes a fleet of warm
 * students visible the moment they burn, instead of an hour later.
 */
export class RateTracker {
  private committed: RateSample[] = [];
  private readonly inFlight = new Map<string, RateSample>();

  constructor(readonly provider: string, private limit: RateLimit | undefined, private readonly now: () => number = Date.now) {}

  setLimit(limit: RateLimit | undefined): void { this.limit = limit; }
  getLimit(): RateLimit | undefined { return this.limit; }

  /** Restore the window from the ledger at boot. */
  seed(samples: readonly RateSample[]): void {
    this.committed = [...samples].sort((a, b) => a.at - b.at);
    this.prune();
  }

  /** A run's usage so far. Replaces, never adds — usage events are cumulative. */
  live(runId: string, sample: Omit<RateSample, 'at'>): void {
    this.inFlight.set(runId, { at: this.now(), ...sample });
  }

  /** The run finished: its spend becomes a committed sample at `at`. */
  commit(runId: string, sample: RateSample): void {
    this.inFlight.delete(runId);
    this.committed.push(sample);
    this.prune();
  }

  /** The run produced no row (a failure before any usage): forget it. */
  drop(runId: string): void { this.inFlight.delete(runId); }

  private prune(): void {
    const from = this.now() - resolveLimit(this.limit).windowMs;
    if (this.committed.length > 512) this.committed = this.committed.filter((s) => s.at > from);
    else if (this.committed.length && this.committed[0].at <= from) this.committed = this.committed.filter((s) => s.at > from);
  }

  assess(now: number = this.now()): RateVerdict {
    return assessRate(this.provider, this.committed, [...this.inFlight.values()], this.limit, now);
  }

  /** Has anything to say at all? */
  get enabled(): boolean { return hasCap(this.limit); }
}

/**
 * What the operator should consider setting, from what they actually burned:
 * the median of the busiest recent hours. A cap below the observed median just
 * parks the board; one far above it never binds. Null when there is no history.
 */
export function suggestTokensPerHour(samples: readonly RateSample[], now: number, windowMs = DEFAULT_WINDOW_MS, lookbackMs = 7 * 24 * 60 * 60_000): number | null {
  const from = now - lookbackMs;
  const rows = samples.filter((s) => s.at > from);
  if (!rows.length) return null;
  const buckets = new Map<number, number>();
  for (const s of rows) {
    const b = Math.floor(s.at / windowMs);
    buckets.set(b, (buckets.get(b) ?? 0) + s.tokens);
  }
  const busy = [...buckets.values()].filter((v) => v > 0).sort((a, b) => a - b);
  if (!busy.length) return null;
  const mid = busy.length % 2 ? busy[(busy.length - 1) / 2] : (busy[busy.length / 2 - 1] + busy[busy.length / 2]) / 2;
  return Math.round(mid);
}
