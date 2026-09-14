import { DEFAULT_IDLE_TICKS, IDLE_TICK_MS, type ChildLike, type StudentBudget } from './contract.js';
import { treeKill } from './proc.js';

// The two run guards every adapter gets for free: a liveness watchdog and a
// spend budget. Ported from claude-study-room's cliStudent.ts, generalised so
// the OpenCode/Codex lanes are protected too (v1 protected only Claude).
//
// IDLE WATCHDOG — counted in TICKS, not wall-clock. This machine sleeps: one
// healthy session showed a 238-minute gap and 33 productive events after it. A
// setTimeout fires immediately on wake, already expired, and would kill every
// in-flight student on lid-open. A suspended machine simply does not tick.
//
// BUDGET — cost is turns x context and context only grows, so a session is
// roughly quadratic in turns; 3 of 69 real sessions burned 34% of everything. A
// budget stop RESOLVES with partial work banked, never rejects: the edits are in
// the worktree and the caller's success path is what pushes them.

/** Which budget (if any) a run has exceeded. 0/undefined = OFF, never "stop now". */
export function overBudget(turns: number, tokens: number, budget?: StudentBudget): keyof StudentBudget | null {
  if (!budget) return null;
  if (budget.maxTurns && turns >= budget.maxTurns) return 'maxTurns';
  if (budget.maxTokens && tokens >= budget.maxTokens) return 'maxTokens';
  return null;
}

export interface GuardOptions {
  idleTicks?: number;
  tickMs?: number;
  budget?: StudentBudget;
  signal?: AbortSignal;
  setIntervalFn?: (fn: () => void, ms: number) => NodeJS.Timeout;
  onIdleKill?: (info: { ticks: number; lastText: string }) => void;
  onBudgetStop?: (info: { turns: number; tokens: number; limit: keyof StudentBudget }) => void;
}

export interface Guards {
  /** Call on every stdout/stderr chunk. */
  noteOutput(): void;
  /** Call as usage arrives; returns the budget limit that just tripped, if any. */
  noteUsage(turns: number, billedTokens: number): keyof StudentBudget | null;
  /** Remember the newest assistant text for the stall diagnosis. */
  noteText(text: string): void;
  /** Clear timers and listeners (call on close). */
  stop(): void;
  readonly killedIdle: boolean;
  readonly idleTicks: number;
  readonly stoppedBy: keyof StudentBudget | null;
  readonly cancelled: boolean;
  readonly lastText: string;
}

/**
 * Attach the guards to a live child. The child is tree-killed when a guard
 * trips; the adapter reads `stoppedBy` / `killedIdle` / `cancelled` on close to
 * decide how to settle.
 */
export function attachGuards(child: ChildLike, opts: GuardOptions): Guards {
  const ticks = opts.idleTicks ?? DEFAULT_IDLE_TICKS;
  const startInterval = opts.setIntervalFn ?? setInterval;
  let sawOutput = false;
  let idleTickCount = 0;
  let killedIdle = false;
  let stoppedBy: keyof StudentBudget | null = null;
  let cancelled = false;
  let lastText = '';

  const timer = ticks > 0
    ? startInterval(() => {
      if (sawOutput) { sawOutput = false; idleTickCount = 0; return; }
      if (++idleTickCount < ticks) return;
      killedIdle = true;
      opts.onIdleKill?.({ ticks: idleTickCount, lastText });
      treeKill(child);
    }, opts.tickMs ?? IDLE_TICK_MS)
    : null;
  // Node keeps the process alive for a pending interval; a student outliving the
  // engine's own exit would be worse than the bug being fixed.
  (timer as { unref?: () => void } | null)?.unref?.();

  const onAbort = (): void => { cancelled = true; treeKill(child); };
  if (opts.signal) {
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener('abort', onAbort, { once: true });
  }

  return {
    noteOutput() { sawOutput = true; },
    noteUsage(turns, billedTokens) {
      if (stoppedBy) return stoppedBy;
      const limit = overBudget(turns, billedTokens, opts.budget);
      if (!limit) return null;
      stoppedBy = limit;
      opts.onBudgetStop?.({ turns, tokens: billedTokens, limit });
      treeKill(child);
      return limit;
    },
    noteText(text) { if (text.trim()) lastText = text.trim(); },
    stop() {
      if (timer) clearInterval(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    },
    get killedIdle() { return killedIdle; },
    get idleTicks() { return idleTickCount; },
    get stoppedBy() { return stoppedBy; },
    get cancelled() { return cancelled; },
    get lastText() { return lastText; },
  };
}
