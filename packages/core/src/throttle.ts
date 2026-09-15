// Adaptive parallelism under board thrash (#178).
//
// `maxParallel` is a constant, but the useful amount of parallelism is not. Early
// milestones — where every task edits the scaffold — support far less concurrency
// than later ones where work has spread across separate modules. On 2026-08-08 the
// board ran 6-wide through exactly the phase that could support about 2, and spent
// the difference on conflict resolution: every merge re-conflicted every open PR
// and RESOLVE was re-dispatched again and again.
//
// This tracks a rolling CONTENTION signal (resolve dispatches + re-dispatches per
// tick) and shrinks the effective cap when it spikes, restoring it toward the
// configured value once the board runs clean. It never raises parallelism past
// what the operator set — `maxParallel` stays the ceiling; this only lowers
// utilization under thrash.
//
// Pure over its inputs (like watchdog.ts / optimizer.ts), so the shrink/recover
// ladder is unit-testable. live.ts feeds it one contention number per tick and
// uses limit() as an extra cap on the dispatch budget.

export interface ThrottleConfig {
  /** Contention STRICTLY above this shrinks the effective cap by one. 1 means a
   *  tick with two or more contention events (say a resolve plus a re-dispatch)
   *  throttles; an isolated resolve does not. */
  contentionThreshold: number;
  /** Consecutive CLEAN ticks (zero contention) before the cap is restored by one
   *  step. Recovery is deliberately slower than the shrink, so a board that just
   *  stopped thrashing isn't immediately pushed back into it. */
  recoverTicks: number;
}

export const DEFAULT_THROTTLE_CONFIG: ThrottleConfig = {
  contentionThreshold: 1,
  recoverTicks: 3,
};

export class Throttle {
  private readonly cfg: ThrottleConfig;
  private ceiling: number;         // the configured max — never exceeded
  private effective: number;       // current cap, in [1, ceiling]
  private cleanStreak = 0;

  constructor(ceiling: number, cfg: Partial<ThrottleConfig> = {}) {
    this.cfg = { ...DEFAULT_THROTTLE_CONFIG, ...cfg };
    this.ceiling = Math.max(1, ceiling);
    this.effective = this.ceiling;
  }

  /** The operator's configured max changed live (dashboard edit / toggle). Track
   *  it as the new ceiling and clamp the effective cap into [1, ceiling] — a
   *  raised ceiling does NOT instantly restore parallelism (recovery still steps
   *  up one clean tick at a time); a lowered one takes effect immediately. */
  setCeiling(ceiling: number): void {
    this.ceiling = Math.max(1, ceiling);
    this.effective = Math.min(this.effective, this.ceiling);
  }

  /**
   * Fold in one tick's contention and return the new effective cap.
   *   - above threshold -> shrink by one (never below 1), reset recovery.
   *   - exactly zero     -> a clean tick; after recoverTicks of them, grow by one.
   *   - low but nonzero  -> hold steady, but reset the recovery streak (the board
   *                         is not yet clean).
   */
  observe(contention: number): number {
    if (contention > this.cfg.contentionThreshold) {
      this.effective = Math.max(1, this.effective - 1);
      this.cleanStreak = 0;
    } else if (contention === 0) {
      this.cleanStreak += 1;
      if (this.cleanStreak >= this.cfg.recoverTicks) {
        this.effective = Math.min(this.ceiling, this.effective + 1);
        this.cleanStreak = 0;
      }
    } else {
      this.cleanStreak = 0;
    }
    return this.effective;
  }

  /** The current effective cap (always in [1, ceiling]). */
  limit(): number {
    return Math.min(this.effective, this.ceiling);
  }

  /** Is the pool currently throttled below what the operator configured? Drives
   *  the dashboard showing "effective/configured" so a throttled pool does not
   *  read as a broken one. */
  isThrottled(): boolean {
    return this.limit() < this.ceiling;
  }

  configured(): number {
    return this.ceiling;
  }
}
