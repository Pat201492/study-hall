import type { Tier } from './tiers.js';

// Screen 3 (M7): the speed<->token toggle that sets the Protector's objective.
// A pure derivation — no network/timers — so the whole toggle -> (model,
// effort, fast_mode, warm_count) mapping is directly unit-testable, same
// pattern as protector.ts's pure scheduler. See CLAUDE.md's Screen 3 + the
// model-tiering economics table.
//
//   Speed: fast-mode Opus, higher tier, more parallel, cache-reuse deprioritized.
//   Token: cheaper tier, max cache reuse, lower effort, fewer parallel.

export type OptimizationMode = 'speed' | 'token';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh';

export interface DeriveInput {
  /** The task's (or student's) nominal tier before the objective is applied. */
  tier: Tier;
  mode: OptimizationMode;
  /** Task Map's "pin to Opus" — locked; the objective may not retier it. */
  pinned?: boolean;
  /** Warm/concurrency count before the objective scales it (e.g. maxConcurrent). */
  baseWarmCount: number;
}

export interface DerivedTaskParams {
  model: Tier;
  effort: Effort;
  fastMode: boolean;
  warmCount: number;
}

// Speed: uncapped (up to whatever's configured) -> "more parallel".
// Token: scaled down (min 1) -> "fewer parallel", leaning on cache reuse instead.
// override: an explicit user-set parallel count (config.maxParallel). When > 0 it
// wins outright — the objective no longer decides concurrency, the number does.
export function effectiveConcurrency(mode: OptimizationMode, base: number, override?: number): number {
  if (override && override > 0) return Math.max(1, Math.floor(override));
  return mode === 'speed' ? Math.max(1, base) : Math.max(1, Math.ceil(base / 2));
}

// Derive (model, effort, fast_mode, warm_count) for one task from the current
// objective. A pinned task's tier is never overridden, regardless of mode.
export function deriveTaskParams(input: DeriveInput): DerivedTaskParams {
  const { tier, mode, pinned = false, baseWarmCount } = input;
  const warmCount = effectiveConcurrency(mode, baseWarmCount);
  if (mode === 'speed') {
    // "Higher tier" -> escalate to Opus (the only fast-mode tier) unless pinned.
    const model = pinned ? tier : 'opus';
    return { model, effort: 'xhigh', fastMode: model === 'opus', warmCount };
  }
  // "Cheaper tier" -> never escalate; leave the task's own (already-cheap) tier alone.
  return { model: tier, effort: 'low', fastMode: false, warmCount };
}
