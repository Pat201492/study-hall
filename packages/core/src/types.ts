import type { Role } from './taskmap.js';
import type { Effort } from './optimizer.js';
import type { AssignmentSnapshot } from './assignments.js';
import { TIERS, type Tier } from './tiers.js';

// The canonical Role/Tier/Student/PoolState shapes that the engine and the
// dashboard both import. Ported from v1 pool.ts WITHOUT its M5 random-walk
// simulator (tick/spawnStudent/reconcile/STAGE_FOR_ROLE): v2 has no `sim` mode,
// so what remains is the shared vocabulary only.

// Re-exported, not redeclared — see the note on Role in taskmap.ts.
export type { Role };
export { TIERS, type Tier } from './tiers.js';
export type StudentState = 'busy' | 'idle-warm' | 'asleep' | 'recycling';

export const ROLES: Role[] = ['triage', 'implement', 'review', 'fix', 'rewrite', 'resolve', 'merge'];

export interface Student {
  id: string;
  tier: Tier;
  model: string;
  role: Role | null;
  state: StudentState;
  task: string | null;
  taskId: string | null; // Task Map id this student is working, if any
  tokens: number;
  cacheHitPct: number;
  ticksLeft: number;
  /** Derived from the current speed/token objective (M7) while busy. */
  effort?: Effort;
  fastMode?: boolean;
}

export interface AttributionCell {
  tasks: number;
  tokens: number; // tokensProcessed: fresh input + output + cache read
  cost: number; // estimated equivalent API $ — NOT billed on a subscription (#25)
  cacheReadTokens: number; // numerator for the aggregate cache-hit %
  cacheInputTokens: number; // denominator: input + cache read + cache write
}

export type AttributionMatrix = Record<Role, Record<Tier, AttributionCell>>;

// One PR in the approved-and-given-up-on deadlock (#173), for the dashboard to
// render as a distinct state instead of silence.
export interface DeadlockedPr {
  repo: string;
  number: number;
  title: string;
  /** The contradictory labels present (reviewed-ok + a parking label). */
  labels: string[];
}

// One parked board item (#174): an issue or PR carrying a parking label
// (runner-error / spec-changed), which classify emits no action for. Surfaced so
// a parked board never reads as an idle one, and can be handed back with a click.
export interface ParkedItem {
  repo: string;
  number: number;
  target: 'issue' | 'pr';
  title: string;
  /** Which parking labels are present. */
  labels: string[];
  /** Work dispatches this item absorbed before it was parked. */
  attempts: number;
}

// Board-level health the pool grid can't express — items that are stuck in a way
// no student will ever pick up. Grows as more silent-stall states are surfaced:
// the reviewed-ok+runner-error deadlock (#173) and every parked item (#174).
export interface BoardHealth {
  deadlocked: DeadlockedPr[];
  parked: ParkedItem[];
}

export interface PoolState {
  running: boolean;
  students: Student[];
  attribution: AttributionMatrix;
  /**
   * What the Protector decided, not just what it holds (#126). Optional because
   * the `sim` mode below has no Protector to report on.
   */
  protector?: AssignmentSnapshot;
  /**
   * Effective vs configured build parallelism (#178). While the board thrashes
   * the throttle lowers `effective` below `configured`; the dashboard shows both
   * so a throttled pool doesn't read as a broken one. Optional (no `sim` value).
   */
  parallelism?: { effective: number; configured: number };
  /**
   * Board items stuck in a state no student will pick up (#173). Optional
   * because the `sim` mode has no live board to report on.
   */
  boardHealth?: BoardHealth;
  /**
   * Dispatch is paused for a capacity outage (#170) — a GitHub or Claude rate
   * limit, not a broken board. `reason` names which; `pausedUntil` is the epoch
   * ms it resumes. Absent when not paused (and in `sim` mode).
   */
  capacity?: { pausedUntil: number; reason: string };
}

export function emptyAttribution(): AttributionMatrix {
  const m = {} as AttributionMatrix;
  for (const r of ROLES) {
    m[r] = {} as Record<Tier, AttributionCell>;
    for (const t of TIERS) m[r][t] = { tasks: 0, tokens: 0, cost: 0, cacheReadTokens: 0, cacheInputTokens: 0 };
  }
  return m;
}

export function initPool(): PoolState {
  return { running: false, students: [], attribution: emptyAttribution() };
}
