import type { QuotaMonitor, QuotaObservation, QuotaSnapshot, QuotaState } from '../contract.js';

// Per-provider quota state machine: AVAILABLE / EXHAUSTED / UNKNOWN.
//
// Three states, not a boolean, because the two providers give different signals:
// Claude Code hands us a continuous 0..1 utilization on every observation, so a
// scheduler can hand over BEFORE a student dies mid-PR (predicted headroom);
// Codex hands us a reliable boolean (`ordinaryUsageAllowed`) whose window
// semantics were in flux in 2026, so its percentage is advisory and its boolean
// is the gate. A provider nobody has observed recently is UNKNOWN — never
// assumed full, never assumed empty — and the engine probes it with one cheap
// task before committing a board to it.

export interface MonitorOptions {
  /** Observations older than this are UNKNOWN (Anthropic's own /usage tolerates 60 min). */
  staleMs?: number;
  /** Hand over when the limiting window's utilization reaches this fraction. */
  handoverAt?: number;
  /** Margin added after a stated reset before the provider is retried. */
  resetMarginMs?: number;
  /** Fallback hold when a capacity failure states no reset time. */
  fallbackHoldMs?: number;
  now?: () => number;
}

export const DEFAULT_MONITOR: Required<Omit<MonitorOptions, 'now'>> = {
  staleMs: 60 * 60_000,
  handoverAt: 0.9,
  resetMarginMs: 60_000,
  fallbackHoldMs: 5 * 60_000,
};

export class BasicQuotaMonitor implements QuotaMonitor {
  private latest: QuotaObservation | undefined;
  private exhaustedUntil: number | undefined;
  private exhaustedDetail: string | undefined;
  private readonly subs = new Set<(s: QuotaSnapshot) => void>();
  private readonly opts: Required<Omit<MonitorOptions, 'now'>>;
  private readonly now: () => number;

  constructor(readonly provider: string, opts: MonitorOptions = {}) {
    this.opts = { ...DEFAULT_MONITOR, ...opts };
    this.now = opts.now ?? (() => Date.now());
  }

  observe(observation: QuotaObservation): void {
    this.latest = observation;
    // A fresh observation that says usage is allowed clears a hold: the
    // provider itself is the authority on recovery.
    if (observation.allowed === true && this.exhaustedUntil !== undefined) {
      this.exhaustedUntil = undefined;
      this.exhaustedDetail = undefined;
    }
    if (observation.allowed === false) {
      const reset = observation.fiveHour?.resetsAt ?? observation.sevenDay?.resetsAt;
      this.hold(reset, observation.detail ?? 'provider reports usage not allowed');
    }
    this.emit();
  }

  markExhausted(resetAt?: number, detail?: string): void {
    this.hold(resetAt, detail ?? 'capacity failure');
    this.emit();
  }

  private hold(resetAt: number | undefined, detail: string): void {
    const now = this.now();
    const until = resetAt && resetAt > now ? resetAt + this.opts.resetMarginMs : now + this.opts.fallbackHoldMs;
    // Never shorten an existing hold on a weaker signal.
    this.exhaustedUntil = Math.max(this.exhaustedUntil ?? 0, until);
    this.exhaustedDetail = detail;
  }

  snapshot(now: number = this.now()): QuotaSnapshot {
    const state = this.stateAt(now);
    return {
      provider: this.provider,
      state,
      observation: this.latest,
      exhaustedUntil: state === 'exhausted' ? this.exhaustedUntil : undefined,
      ageMs: this.latest ? Math.max(0, now - this.latest.observedAt) : undefined,
    };
  }

  private stateAt(now: number): QuotaState {
    if (this.exhaustedUntil !== undefined && now < this.exhaustedUntil) return 'exhausted';
    const o = this.latest;
    if (!o || now - o.observedAt > this.opts.staleMs) return 'unknown';
    if (o.allowed === false) return 'exhausted';
    // Predicted headroom: any known window at/above the handover threshold.
    const windows = [o.fiveHour, o.sevenDay, ...Object.values(o.extra ?? {})].filter((w): w is NonNullable<typeof w> => !!w);
    for (const w of windows) {
      if (w.resetsAt > now && w.utilization >= this.opts.handoverAt) return 'exhausted';
    }
    // AVAILABLE needs positive evidence: the provider said usage is allowed, or
    // at least one window is known and below the threshold. An observation that
    // carries neither (a failed read, "not logged in") is UNKNOWN, never available.
    if (o.allowed === true || windows.length > 0) return 'available';
    return 'unknown';
  }

  subscribe(fn: (snapshot: QuotaSnapshot) => void): () => void {
    this.subs.add(fn);
    return () => { this.subs.delete(fn); };
  }

  private emit(): void {
    const s = this.snapshot();
    for (const fn of this.subs) {
      try { fn(s); } catch { /* a subscriber must not break the monitor */ }
    }
  }
}
