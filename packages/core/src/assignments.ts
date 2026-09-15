import type { Tier } from './tiers.js';
import { ROLES, TIERS, type Role } from './types.js';
import type { AssignKind, WaitReason, Worker } from './protector.js';

// Assignment telemetry (#126).
//
// The Protector already decides everything worth knowing about a warm pool —
// which ladder step each task took, which workers it re-roled, why a task had to
// wait — and then threw all of it away into a console line. status.json could
// show WHICH students existed but never WHY they were chosen, which is the one
// question a warm pool exists to answer: `exact` vs `spawn` is the difference
// between the pool working and the pool being decorative.
//
// This module is the record. Pure and deterministic — no clock of its own, no
// I/O — so the tallies are unit-testable against a scripted sequence. Callers
// pass `at` in, which also keeps it usable from a replay.

// Ring capacity. status.json is rewritten on every state transition and polled
// by the dashboard every ~1.5s, so the feed has to stay small; a few hundred
// entries is enough to see a cold start turn into steady state.
export const MAX_RECENT = 200;

export interface AssignmentRecord {
  at: number;
  repo: string;
  taskId: string;
  kind: AssignKind;
  tier: Tier;
  role: Role;
  /** null exactly when `kind` is 'wait'. */
  workerId: string | null;
  /** Previous role, set only on a 'rerole'. */
  fromRole?: Role;
  /** Set only on a 'wait'. */
  waitReason?: WaitReason;
}

export interface RebalanceRecord {
  at: number;
  repo: string;
  workerId: string;
  tier: Tier;
  from: Role;
  to: Role;
}

export interface LadderTallies {
  exact: number;
  rerole: number;
  /**
   * Reuse of a worker warm on a DIFFERENT repo (#121). Counted separately so
   * the cost of trading repo affinity away is measurable rather than assumed —
   * this is the number that decides whether spec-in-prefix was worth it.
   */
  crossRepo: number;
  spawn: number;
  wait: number;
  total: number;
  /**
   * Share of placements that reused a warm worker rather than paying a cold
   * start: (exact + rerole + cross-repo) / placed. Cross-repo counts as reuse
   * because it is one — the role prefix still hits and only the spec re-reads.
   * 0 when nothing has been placed yet.
   */
  warmReuseRate: number;
}

// One cell of the warm map: what the pool HAS for a (repo, tier, role) against
// what the board is asking for. A mismatch here is what rebalance() is trying to
// fix, and showing it is how you tell whether it is succeeding.
export interface WarmCell {
  repo: string;
  tier: Tier;
  role: Role;
  free: number;
  busy: number;
  demand: number;
}

export interface AssignmentSnapshot {
  tallies: LadderTallies;
  recent: AssignmentRecord[];
  rebalances: RebalanceRecord[];
  warmMap: WarmCell[];
  waitsByReason: Record<string, number>;
}

function emptyTallies(): LadderTallies {
  return { exact: 0, rerole: 0, crossRepo: 0, spawn: 0, wait: 0, total: 0, warmReuseRate: 0 };
}

export class AssignmentLog {
  private readonly counts: Record<AssignKind, number> = { exact: 0, rerole: 0, 'cross-repo': 0, spawn: 0, wait: 0 };
  private readonly waits: Record<string, number> = {};
  private recentRing: AssignmentRecord[] = [];
  private rebalanceRing: RebalanceRecord[] = [];

  constructor(private readonly cap: number = MAX_RECENT) {}

  record(rec: AssignmentRecord): void {
    this.counts[rec.kind] += 1;
    if (rec.kind === 'wait' && rec.waitReason) {
      this.waits[rec.waitReason] = (this.waits[rec.waitReason] ?? 0) + 1;
    }
    this.recentRing.push(rec);
    if (this.recentRing.length > this.cap) this.recentRing = this.recentRing.slice(-this.cap);
  }

  recordRebalance(rec: RebalanceRecord): void {
    this.rebalanceRing.push(rec);
    if (this.rebalanceRing.length > this.cap) this.rebalanceRing = this.rebalanceRing.slice(-this.cap);
  }

  // Running ladder tallies since boot. The warm-reuse rate is the KPI: a healthy
  // pool is mostly exact, and a pool that is mostly spawn is a cold-start machine
  // wearing a warm-pool costume. Waits are excluded from the denominator — a task
  // that never got placed says nothing about how well placements reuse warmth.
  tallies(): LadderTallies {
    const { exact, rerole, spawn, wait } = this.counts;
    const crossRepo = this.counts['cross-repo'];
    const total = exact + rerole + crossRepo + spawn + wait;
    const placed = exact + rerole + crossRepo + spawn;
    return {
      exact, rerole, crossRepo, spawn, wait, total,
      warmReuseRate: placed > 0 ? (exact + rerole + crossRepo) / placed : 0,
    };
  }

  /** Most recent first, so the dashboard feed reads top-down. */
  recent(): AssignmentRecord[] {
    return [...this.recentRing].reverse();
  }

  rebalances(): RebalanceRecord[] {
    return [...this.rebalanceRing].reverse();
  }

  snapshot(warmMap: WarmCell[]): AssignmentSnapshot {
    return {
      tallies: this.tallies(),
      recent: this.recent(),
      rebalances: this.rebalances(),
      warmMap,
      waitsByReason: { ...this.waits },
    };
  }
}

// Supply (from the live pool) against demand (from this tick's actions), per
// (repo, tier, role). Cells with nothing in them and nothing wanted are dropped
// so the grid stays readable — an all-zero row is noise, not information.
export function warmMap(
  repo: string,
  workers: readonly Worker[],
  demand: { tier: Tier; role: Role }[],
): WarmCell[] {
  const cells: WarmCell[] = [];
  for (const tier of TIERS) {
    for (const role of ROLES) {
      const of = workers.filter((w) => w.tier === tier && w.role === role);
      const busy = of.filter((w) => w.state === 'busy').length;
      const free = of.filter((w) => w.state === 'idle-warm' || w.state === 'asleep').length;
      const want = demand.filter((d) => d.tier === tier && d.role === role).length;
      if (!busy && !free && !want) continue;
      cells.push({ repo, tier, role, free, busy, demand: want });
    }
  }
  return cells;
}

export const _emptyTallies = emptyTallies;
