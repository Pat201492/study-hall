import { randomUUID } from 'node:crypto';
import type { Harness, HarnessRunOptions, HarnessRunResult, SessionSpec, Usage } from './contract.js';

// Warm session reuse, generalised over the harness contract. Ported from
// claude-study-room's src/warmCliSession.ts (#23/#298/#307).
//
// The old design claimed "the CLI is process-per-task and can't stay warm" —
// false: `claude -p` supports --session-id / --resume / --fork-session, which
// keep a session's context (spec + role prefix) on disk between tasks so the
// CLI's own prompt cache HITS instead of a cold re-read. This restores Study
// Room's core "don't re-read the spec cold every task" saving on the
// SUBSCRIPTION path (no metered API, no dollar bill; the ceiling is rate
// limits, and warm reuse buys headroom by cutting re-read tokens — not free
// infinity). Capping students so a session split paid repo ramp-up twice moved
// cost from 9.5M to 20.5M tokens per merged PR; that is what a warm base saves.
//
// A WarmSlot is one warm POOL SLOT with a stable base id:
//   - FIRST task:  session {mode:'new', seed:<id>}     (seed the warm base)
//   - LATER tasks: session {mode:'fork', base:<id>}    (fork off the base)
// Forking keeps the cached prefix but discards this task's scratch — that IS
// the per-task memory wipe. A base session is a free-to-keep disk file (unlike
// the raw-API cache's 5-min TTL), so there is NO re-warm timer — cold-on-disk +
// cheap resume is fine.
//
// Four shapes, not two, because harnesses differ in what they can be TOLD:
//   no warm support         -> no session at all (and say so, once)
//   a base exists, can fork -> fork off it
//   a base exists, resume   -> resume it (scratch accumulates; say so, once)
//   no base yet, seedable   -> name one
//   no base yet, adopt-only -> run bare and LEARN the id from the result

/** idle-warm = no run in flight; busy = a run in flight. */
export type WarmSlotState = 'idle-warm' | 'busy';

/** Per-run options; the slot owns the session spec, so callers cannot set it. */
export type WarmRunOptions = Omit<HarnessRunOptions, 'session'>;

export type WarmRunFn = (prompt: string, opts: HarnessRunOptions) => Promise<HarnessRunResult>;

export interface WarmSlotOptions {
  harness: Harness;
  /** Stable id for this slot; the seed on a seedable harness. Defaults to a
   *  fresh random uuid. */
  id?: string;
  /** A REAL server-issued id restored from disk on an adopt-only harness. A
   *  generated uuid names nothing on such a server and must never be handed
   *  back as a resume target, which is why this is a separate field. */
  adoptedId?: string;
  /** Injectable runner, so tests fake the CLI — no real binary in tests. */
  runFn?: WarmRunFn;
  /** Where the once-per-slot degradation notices go. */
  log?: (message: string) => void;
}

/** Persisted shape, so a restarted engine resumes its warm bases instead of
 *  paying ramp-up again. */
export interface WarmSlotJSON {
  id: string;
  harness: string;
  baseSeeded: boolean;
  adoptedId: string | null;
  usageBaseline: Usage | null;
}

export class WarmSlot {
  /** The stable slot id — the seed on a seedable harness. */
  readonly id: string;
  /** The harness this slot runs on — its capabilities decide warm vs cold. */
  readonly harness: Harness;
  private readonly runFn: WarmRunFn;
  private readonly log: (message: string) => void;
  private baseSeeded = false;
  /** The base id on a harness that cannot be told one — learned from the
   *  first run's result, null until that run succeeds. */
  private adoptedId: string | null = null;
  private _state: WarmSlotState = 'idle-warm';
  private _usageBaseline: Usage | null = null;
  /** Logged once per slot, not per run: they are facts about the harness, and
   *  repeating them every task would bury the board's actual output. */
  private warnedCold = false;
  private warnedResumeOnly = false;

  constructor(opts: WarmSlotOptions) {
    this.harness = opts.harness;
    this.id = opts.id ?? randomUUID();
    this.log = opts.log ?? ((m) => console.warn(m));
    if (!this.canSeed && opts.adoptedId) this.adoptedId = opts.adoptedId;
    // An injected runFn still wins, so every test double keeps working without
    // knowing harnesses exist.
    this.runFn = opts.runFn ?? ((prompt, o) => this.harness.run(prompt, o));
  }

  /** True when this slot's harness can actually hold a warm base. */
  get supportsWarm(): boolean {
    return this.harness.capabilities.warmSessions;
  }

  /** True when this slot may NAME its base rather than adopt one. */
  get canSeed(): boolean {
    return this.harness.capabilities.seedableSessions;
  }

  /**
   * The id a run would fork off, or null when no base exists yet.
   *
   * Seedable harnesses know their id from construction, so the only question is
   * whether a run has landed. Adopt-only harnesses do not have one until a run
   * returns it — which is why this is derived rather than a boolean: `baseSeeded`
   * alone cannot tell "seeded" from "seeded AND we know its name".
   */
  get baseId(): string | null {
    if (!this.supportsWarm) return null;
    if (this.canSeed) return this.baseSeeded ? this.id : null;
    return this.adoptedId;
  }

  get state(): WarmSlotState {
    return this._state;
  }

  /** True once the base session exists (its prefix is warm on disk). Always
   *  false on a harness that cannot hold one — the pool must not count a cold
   *  slot toward its warm capacity and schedule against headroom it does not
   *  have. */
  get isWarm(): boolean {
    return this.baseId !== null;
  }

  /** The cumulative Usage after the seeding run, on harnesses whose figures are
   *  thread totals (`usageIsCumulative`, Codex). Handed to every fork/resume
   *  run as `extra.usageBaseline` so the adapter can diff against it; null on
   *  harnesses that report per-run deltas. */
  get usageBaseline(): Usage | null {
    return this._usageBaseline;
  }

  /** The session spec the NEXT run would carry, or undefined for a cold run. */
  nextSession(): SessionSpec | undefined {
    if (!this.supportsWarm) return undefined;
    const base = this.baseId;
    if (base) return this.harness.capabilities.forkSessions ? { mode: 'fork', base } : { mode: 'resume', base };
    return this.canSeed ? { mode: 'new', seed: this.id } : { mode: 'new' };
  }

  /**
   * Run one task on this warm slot. The first task seeds the stable base; every
   * later task forks off it so the spec/role prefix stays cached but the task's
   * scratch is discarded. The second task's usage should show a cache hit /
   * lower input tokens than the first (the cold re-read the base already paid).
   *
   * The slot is single-flight: state is `busy` for the duration and back to
   * `idle-warm` when it settles (even on error). Throws if a run is already in
   * flight.
   */
  async run(prompt: string, opts: WarmRunOptions): Promise<HarnessRunResult> {
    if (this._state === 'busy') {
      throw new Error(`WarmSlot ${this.id} is busy — one run at a time`);
    }
    this._state = 'busy';
    try {
      // A harness that cannot hold a warm base runs COLD, and says so. The
      // alternative — emitting session flags at something that does not
      // understand them — either errors or, worse, is ignored, leaving a slot
      // that reports itself warm while paying full ramp-up on every task. That
      // failure is invisible in the numbers except as cost, and cost is exactly
      // what the arena measures, so it degrades LOUDLY.
      const session = this.nextSession();
      const caps = this.harness.capabilities;
      if (!this.supportsWarm && !this.warnedCold) {
        this.warnedCold = true;
        this.log(
          `harness "${this.harness.id}" has no warm sessions — slot ${this.id} runs cold, `
          + 'paying repo ramp-up on every task',
        );
      }
      if (session?.mode === 'resume' && !this.warnedResumeOnly) {
        this.warnedResumeOnly = true;
        this.log(
          `harness "${this.harness.id}" cannot fork sessions — slot ${this.id} resumes its base, `
          + 'so every task\'s scratch accumulates in it',
        );
      }
      const wasSeeded = this.baseId !== null;
      const runOpts: HarnessRunOptions = session ? { ...opts, session } : { ...opts };
      if (wasSeeded && caps.usageIsCumulative && this._usageBaseline) {
        runOpts.extra = { ...(opts.extra ?? {}), usageBaseline: this._usageBaseline };
      }

      const result = await this.runFn(prompt, runOpts);
      this.baseSeeded = true;
      // Adopt the server's id so the NEXT task can fork off this run's base.
      // Only on success: a run that threw before returning an id leaves the slot
      // unseeded, so the next task seeds afresh rather than resuming nothing.
      if (!this.canSeed && !this.adoptedId && result?.sessionId) {
        this.adoptedId = result.sessionId;
      }
      if (!wasSeeded && this.baseId !== null && caps.usageIsCumulative && result?.usage) {
        this._usageBaseline = { ...result.usage };
      }
      return result;
    } finally {
      this._state = 'idle-warm';
    }
  }

  /**
   * Per-task memory wipe. With fork every task after the first already runs in
   * a throwaway session, so the base never accumulates scratch — there is
   * nothing to clear. Kept for parity with the raw-API student's wipeContext();
   * the fork IS the wipe.
   */
  wipeContext(): void {
    /* fork discards scratch; base session stays warm. */
  }

  toJSON(): WarmSlotJSON {
    return {
      id: this.id,
      harness: this.harness.id,
      baseSeeded: this.baseSeeded,
      adoptedId: this.adoptedId,
      usageBaseline: this._usageBaseline ? { ...this._usageBaseline } : null,
    };
  }

  /** Restore a persisted slot. Throws on a harness mismatch: resuming an id
   *  under a different CLI would name nothing, or worse, something else. */
  static fromJSON(json: WarmSlotJSON, opts: Omit<WarmSlotOptions, 'id' | 'adoptedId'>): WarmSlot {
    if (json.harness !== opts.harness.id) {
      throw new Error(`WarmSlot ${json.id} was persisted on harness "${json.harness}", not "${opts.harness.id}"`);
    }
    const slot = new WarmSlot({ ...opts, id: json.id, adoptedId: json.adoptedId ?? undefined });
    slot.baseSeeded = json.baseSeeded === true;
    slot._usageBaseline = json.usageBaseline ? { ...json.usageBaseline } : null;
    return slot;
  }
}
