import type { FailureVerdict } from '@study-hall/harness/contract';
import { DEFAULT_MONITOR } from '@study-hall/harness/quota/monitor';
import { Watchdog, type WatchdogConfig, type Escalation } from '../watchdog.js';
import { Throttle, type ThrottleConfig } from '../throttle.js';
import { inBlackout, minutesUntilOpen, type BlackoutConfig } from '../blackout.js';
import { dueForParole, DEFAULT_PAROLE, type ParoleConfig, type ParoleRecord } from '../parole.js';

// Every "should we dispatch at all" rule in one place, pure over its inputs:
// observations go in, verdicts come out as plain objects the engine logs as
// ledger events and applies. Nothing here touches fs, gh, a process or a clock —
// `now` is always an argument.
//
// The ladders inside (watchdog, parole, throttle, blackout) are the ported v1
// modules, unchanged; this wraps them and adds what v2 needs: failure routing by
// the harness's structured verdict (never by regexing English), a per-provider
// halted map for auth failures, and a crash-burst standdown that replaces the
// fixed 22:00 blackout as the default guard.

export interface CrashBurstConfig {
  /** Same-signature failures within `windowMs` that trigger a standdown. */
  count: number;
  windowMs: number;
  standdownMs: number;
}

export interface InfraPauseConfig {
  /** Consecutive infra failures tolerated before dispatch pauses. */
  pauseAfter: number;
  /** First backoff once the threshold is crossed; doubles per further failure. */
  baseMs: number;
  /** Ceiling, so a recovered machine is not left idle. */
  maxMs: number;
}

/** v1 infraFailure.ts: one crash is transient, three in a row is the binary
 *  being broken right now, and every student shares one binary. */
export const DEFAULT_INFRA_PAUSE: InfraPauseConfig = { pauseAfter: 3, baseMs: 2 * 60_000, maxMs: 15 * 60_000 };

export const DEFAULT_CRASH_BURST: CrashBurstConfig = { count: 5, windowMs: 10 * 60_000, standdownMs: 30 * 60_000 };

export interface GovernanceConfig {
  watchdog?: Partial<WatchdogConfig>;
  throttle?: Partial<ThrottleConfig>;
  blackout: BlackoutConfig;
  crashBurst?: CrashBurstConfig;
  infra?: InfraPauseConfig;
  parole?: ParoleConfig;
  /** Throttle ceiling — the operator's configured parallelism. */
  maxParallel: number;
  /** Margin past a provider's reset before dispatch resumes on it. */
  resetMarginMs?: number;
  /** How long to hold a provider exhausted when the failure named no reset. */
  fallbackHoldMs?: number;
}

/** A plain object: the engine logs it as a ledger event and applies it. */
export type GovernanceVerdict =
  | { kind: 'pause-provider'; provider: string; until: number; item: string; reason: string }
  | { kind: 'halt-provider'; provider: string; detail: string }
  | { kind: 'pause-dispatch'; until: number; reason: string; streak: number }
  | { kind: 'standdown'; until: number; signature: string; count: number }
  | { kind: 'forgive'; item: string; reason: string }
  | { kind: 'charge'; item: string; attempts: number; lifetime: number };

export interface FailureInput {
  verdict: FailureVerdict;
  provider: string;
  /** Qualified item key ("owner/name:pr-12"). */
  item: string;
  /** Qualified action key ("FIX:owner/name:pr-12"). */
  key: string;
  message: string;
  now: number;
}

export interface TickGovernance {
  blackout: boolean;
  blackoutMinutes: number;
  /** Dispatch is paused engine-wide until this epoch ms (infra, standdown, GitHub). */
  pausedUntil?: number;
  pauseReason?: string;
  halted: Record<string, string>;
  throttleLimit: number;
  escalation: Escalation;
}

/** Collapse a failure message to a comparable signature: first line, digits and
 *  hex runs blanked, capped. Two crashes that differ only in a pid or a path
 *  fragment share a signature; two different faults do not. */
export function failureSignature(message: string): string {
  const first = (message.split(/\r?\n/).find((l) => l.trim()) ?? '').trim();
  return first.replace(/0x[0-9a-f]+/gi, '#').replace(/\d+/g, '#').replace(/\s+/g, ' ').slice(0, 120);
}

/** How long to stop dispatching after `consecutive` infra failures; 0 = keep going. */
export function infraPauseMs(consecutive: number, cfg: InfraPauseConfig = DEFAULT_INFRA_PAUSE): number {
  if (consecutive < cfg.pauseAfter) return 0;
  const step = consecutive - cfg.pauseAfter;
  return Math.min(cfg.baseMs * 2 ** step, cfg.maxMs);
}

export class Governance {
  readonly watchdog: Watchdog;
  readonly throttle: Throttle;
  private readonly blackoutCfg: BlackoutConfig;
  private readonly crashBurst: CrashBurstConfig;
  private readonly infra: InfraPauseConfig;
  private readonly paroleCfg: ParoleConfig;
  private readonly resetMarginMs: number;
  private readonly fallbackHoldMs: number;

  private readonly haltedLanes = new Map<string, string>();
  private infraStreak = 0;
  private infraPausedUntil = 0;
  private crashes: { at: number; signature: string }[] = [];
  private standdownUntil = 0;
  private standdownSignature = '';
  private externalPauseUntil = 0;
  private externalPauseReason = '';

  constructor(cfg: GovernanceConfig) {
    this.watchdog = new Watchdog(cfg.watchdog);
    this.throttle = new Throttle(cfg.maxParallel, cfg.throttle);
    this.blackoutCfg = cfg.blackout;
    this.crashBurst = cfg.crashBurst ?? DEFAULT_CRASH_BURST;
    this.infra = cfg.infra ?? DEFAULT_INFRA_PAUSE;
    this.paroleCfg = cfg.parole ?? DEFAULT_PAROLE;
    this.resetMarginMs = cfg.resetMarginMs ?? DEFAULT_MONITOR.resetMarginMs;
    this.fallbackHoldMs = cfg.fallbackHoldMs ?? DEFAULT_MONITOR.fallbackHoldMs;
  }

  // ---- per tick ------------------------------------------------------------

  assessTick(now: number): TickGovernance {
    const date = new Date(now);
    const pause = this.dispatchPause(now);
    return {
      blackout: inBlackout(date, this.blackoutCfg),
      blackoutMinutes: minutesUntilOpen(date, this.blackoutCfg),
      pausedUntil: pause?.until,
      pauseReason: pause?.reason,
      halted: this.halted(),
      throttleLimit: this.throttle.limit(),
      escalation: this.watchdog.assess(),
    };
  }

  /** The longest-running engine-wide pause, if any. */
  dispatchPause(now: number): { until: number; reason: string } | null {
    const candidates: { until: number; reason: string }[] = [];
    if (this.standdownUntil > now) candidates.push({ until: this.standdownUntil, reason: `crash burst: ${this.standdownSignature}` });
    if (this.infraPausedUntil > now) candidates.push({ until: this.infraPausedUntil, reason: `${this.infraStreak} infra failures in a row` });
    if (this.externalPauseUntil > now) candidates.push({ until: this.externalPauseUntil, reason: this.externalPauseReason });
    if (!candidates.length) return null;
    return candidates.sort((a, b) => b.until - a.until)[0];
  }

  /** An external capacity signal (GitHub rate limit): hold dispatch until `until`. */
  pauseDispatch(until: number, reason: string): void {
    this.externalPauseUntil = Math.max(this.externalPauseUntil, until);
    this.externalPauseReason = reason;
  }

  /** Fold in one tick's contention (resolve dispatches + re-dispatches). */
  observeContention(contention: number): number {
    return this.throttle.observe(contention);
  }

  setParallelism(ceiling: number): void {
    this.throttle.setCeiling(ceiling);
  }

  // ---- dispatch bookkeeping ------------------------------------------------

  /** Every unit of real model work counts against the item's budget, whichever role spent it. */
  recordDispatch(item: string): { attempts: number; lifetime: number } {
    this.watchdog.attempt(item);
    return { attempts: this.watchdog.attemptsFor(item), lifetime: this.watchdog.lifetimeFor(item) };
  }

  recordSuccess(): void {
    this.infraStreak = 0;
  }

  // ---- failure routing -----------------------------------------------------

  onFailure(input: FailureInput): GovernanceVerdict[] {
    const { verdict, provider, item, key, now } = input;
    switch (verdict.kind) {
      case 'capacity': {
        // The dispatch never ran: give the attempt AND the lifetime unit back,
        // forget the no-progress bump, and hold the provider until its reset.
        this.watchdog.forgiveAttempt(item);
        this.watchdog.clear(key);
        const base = verdict.resetAt && verdict.resetAt > now ? verdict.resetAt : now + this.fallbackHoldMs;
        return [
          { kind: 'forgive', item, reason: 'capacity' },
          { kind: 'pause-provider', provider, until: base + this.resetMarginMs, item, reason: verdict.detail ?? input.message.split(/\r?\n/)[0] },
        ];
      }
      case 'auth': {
        const detail = verdict.detail ?? input.message.split(/\r?\n/)[0] ?? 'authentication failed';
        this.haltedLanes.set(provider, detail);
        this.watchdog.forgiveAttempt(item);
        this.watchdog.clear(key);
        return [
          { kind: 'forgive', item, reason: 'auth' },
          { kind: 'halt-provider', provider, detail },
        ];
      }
      case 'infra': {
        this.watchdog.forgiveAttempt(item);
        this.watchdog.clear(key);
        this.infraStreak += 1;
        const out: GovernanceVerdict[] = [{ kind: 'forgive', item, reason: 'infra' }];
        const pause = infraPauseMs(this.infraStreak, this.infra);
        if (pause > 0) {
          this.infraPausedUntil = Math.max(this.infraPausedUntil, now + pause);
          out.push({ kind: 'pause-dispatch', until: this.infraPausedUntil, reason: 'infra', streak: this.infraStreak });
        }
        const burst = this.recordCrash(input.message, now);
        if (burst) out.push(burst);
        return out;
      }
      case 'cancelled': {
        // Partial work is banked by the runner; the item is not charged for a stop
        // the operator asked for.
        this.watchdog.forgiveAttempt(item);
        this.watchdog.clear(key);
        return [{ kind: 'forgive', item, reason: 'cancelled' }];
      }
      case 'task':
      default:
        // The attempt was charged at dispatch; the watchdog's no-progress ladder
        // judges the item on the next tick. Report the standing so the event
        // carries it.
        return [{ kind: 'charge', item, attempts: this.watchdog.attemptsFor(item), lifetime: this.watchdog.lifetimeFor(item) }];
    }
  }

  /** N same-signature failures inside the window -> standdown. A different
   *  signature starts its own count and never extends an existing standdown. */
  private recordCrash(message: string, now: number): GovernanceVerdict | null {
    const signature = failureSignature(message);
    this.crashes = this.crashes.filter((c) => now - c.at < this.crashBurst.windowMs);
    this.crashes.push({ at: now, signature });
    const same = this.crashes.filter((c) => c.signature === signature).length;
    if (same < this.crashBurst.count) return null;
    if (this.standdownUntil > now && this.standdownSignature === signature) return null; // already standing down for it
    this.standdownUntil = now + this.crashBurst.standdownMs;
    this.standdownSignature = signature;
    this.crashes = this.crashes.filter((c) => c.signature !== signature);
    return { kind: 'standdown', until: this.standdownUntil, signature, count: same };
  }

  // ---- halted lanes --------------------------------------------------------

  halted(): Record<string, string> {
    return Object.fromEntries(this.haltedLanes);
  }

  isHalted(provider: string): boolean {
    return this.haltedLanes.has(provider);
  }

  /** An operator fixed the login: hand the lane back. */
  clearHalt(provider: string): boolean {
    return this.haltedLanes.delete(provider);
  }

  // ---- quarantine and release ----------------------------------------------

  /** Isolate an item (the watchdog stops counting it toward the systemic kill). */
  quarantine(key: string): void {
    this.watchdog.isolate(key);
  }

  /** Hand an item back ON PROBATION (a human cleared its label, or parole served). */
  release(item: string, key?: string): void {
    this.watchdog.probe(item);
    if (key) this.watchdog.clear(key);
  }

  /** Quarantined keys whose sentence is served and whose lifetime budget is not
   *  spent — the ones parole may release now. Past the lifetime cap an item
   *  needs a human, and is reported separately. */
  paroleDue(records: Iterable<[string, ParoleRecord]>, now: number): { release: string[]; exhausted: string[] } {
    const due = dueForParole(records, now, this.paroleCfg);
    const release: string[] = [];
    const exhausted: string[] = [];
    for (const key of due) (this.watchdog.lifetimeExhausted(key) ? exhausted : release).push(key);
    return { release, exhausted };
  }

  infraStreakCount(): number {
    return this.infraStreak;
  }
}
