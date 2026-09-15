import { TIERS, type Tier } from './tiers.js';

// Warm-pool tier prioritization: a tier whose warm count is 0 is "disabled", and
// every task that would run on it falls back to the nearest ENABLED tier —
// searching UPWARD (more capable) first, then downward. So "0 haiku warm" routes
// all haiku work to sonnet; if sonnet is also 0, to opus. A disabled top tier
// (0 opus warm) falls back down to sonnet. If NOTHING is enabled, the original
// tier is returned unchanged (degenerate — nothing to route to).
//
// TIERS is cost/capability-ascending (haiku < sonnet < opus), so "upward" =
// stronger model. Pure over its inputs, so the routing is unit-testable.
export function effectiveTier(tier: Tier, pool: Record<Tier, { maxWarm: number }>): Tier {
  const enabled = (t: Tier): boolean => (pool[t]?.maxWarm ?? 0) > 0;
  if (enabled(tier)) return tier;
  const i = TIERS.indexOf(tier);
  for (let d = 1; d < TIERS.length; d++) {
    const up = TIERS[i + d];
    if (up && enabled(up)) return up;
    const down = TIERS[i - d];
    if (down && enabled(down)) return down;
  }
  return tier;
}
