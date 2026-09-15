// The model tiers, cost/capability-ascending (haiku < sonnet < opus).
//
// In v1 `Tier` lived in pricing.ts and `TIERS` in pool.ts. Pricing now belongs
// to @study-hall/harness and the pool simulator is not ported, so the pure
// engine modules take both from here and core stays dependency-free.
export type Tier = 'haiku' | 'sonnet' | 'opus';

export const TIERS: Tier[] = ['haiku', 'sonnet', 'opus'];
