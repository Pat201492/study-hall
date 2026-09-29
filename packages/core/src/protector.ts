import type { Tier } from './tiers.js';
import { ROLES, TIERS, type Role } from './types.js';

// The Protector's real pool engine: students grouped BY MODEL (tier), role
// assigned dynamically by swapping the cached role block. This module is the
// scheduling brain — pure, deterministic, no network/timers — so the whole
// assignment ladder, warm-count-tracks-demand, rebalance, and recycle logic is
// directly unit-testable. It orchestrates lightweight Worker descriptors; the
// real warm Claude Code CLI session behind each one lives in src/cliStudent.ts
// and src/warmCliSession.ts, attached via the optional `attach` hook.
//
// Cache economics that drive every decision here (see CLAUDE.md):
//   same-role reuse  = cached prefix HIT                    (cheapest) -> step 1
//   cross-role reuse = prefix re-cache, warm session kept   (mid)      -> step 2
//   cold spawn       = new session + full prefix WRITE      (dearest)  -> step 3
//
// The prompt order is [ROLE block FIRST, per-task specifics SECOND]; that
// contract lives in src/prompts.ts, which is the file to read before changing
// it. The repo spec is NOT part of the prefix today — live.ts loads it into
// `this.spec` and nothing consumes it (#125) — so the cached prefix is the role
// constant alone. Two consequences the ladder relies on: workers are
// repo-agnostic and fully fungible across repos, and a re-role re-caches the
// whole prefix rather than just a trailing role block, so step 2 buys a live
// session and worktree, not a warm cache. Whether the spec belongs in the
// prefix at all is still open (#125, #121).

export type WorkerState = 'busy' | 'idle-warm' | 'asleep' | 'recycling';

export interface Worker {
  id: string;
  tier: Tier;
  /** Currently cached role prefix. Survives a wipe (sticky), changes on re-role. */
  role: Role;
  /**
   * Repo of this worker's LAST task, or null before its first. Used for
   * ORDERING only — never for gating. A worker is never bound to a repo: task
   * worktrees are per-task, and the role prefix is repo-agnostic, so any worker
   * can take any repo's work. This field only lets the ladder PREFER a worker
   * whose spec block is already warm (#121).
   */
  repo?: string | null;
  state: WorkerState;
  /** Task id while busy, else null. */
  task: string | null;
  /** Dedicated git worktree, so reused workers never collide. */
  worktree: string;
  /** Monotonic "warmth" marker — higher = more recently freed (warmer cache). */
  lastFinishedSeq: number;
  /** Consecutive failed health checks. */
  healthMisses: number;
  /** Opaque handle to the real warm session (a Student), if attached. */
  session?: unknown;
}

// A unit of work the Protector must place on a warm worker.
export interface Task {
  id: string;
  /** Model tier the task requires. */
  tier: Tier;
  role: Role;
  /** Repo this task belongs to. Optional: single-repo callers omit it. */
  repo?: string | null;
}

// The assignment ladder, cheapest first. `cross-repo` sits BELOW rerole and
// ABOVE spawn: a worker from another repo still has the role prefix cached and
// re-reads only the spec block — a partial miss, materially cheaper than a cold
// prefix write. Trading same-repo warmth away is therefore worth doing rather
// than spawning, and worth COUNTING so the cost is measurable (#121).
export type AssignKind = 'exact' | 'rerole' | 'cross-repo' | 'spawn' | 'wait';

// Why a task could not be placed. A wait is otherwise invisible and reads as the
// engine doing nothing, when it is usually the cap working as intended (#126).
export type WaitReason = 'tier-at-cap' | 'pool-at-cap';

export interface Assignment {
  task: Task;
  kind: AssignKind;
  /** The placed worker, or null when the task must wait (at cap, all busy). */
  worker: Worker | null;
  /** Set only when `kind` is 'wait' — which cap blocked the placement. */
  waitReason?: WaitReason;
}

export interface ProtectorConfig {
  /** Max warm students per tier (the "3 per model" headroom cap). */
  perTierMax: number;
  /** Hard total cap = min(machine RAM/CPU, API rate limit, subscription cap). */
  totalCap: number;
  /** Board concurrency; warm count of the active tier tracks this. */
  maxConcurrent: number;
  /** Parent dir each student's dedicated worktree lives under. */
  worktreeRoot: string;
  /** Name used in a student's id for a tier (`sol-1`, not `opus-1`, on OpenAI). Defaults to the tier key. */
  idLabel?: (tier: Tier) => string;
}

export const DEFAULT_PROTECTOR_CONFIG: ProtectorConfig = {
  perTierMax: 3,
  totalCap: 6,
  maxConcurrent: 4,
  worktreeRoot: '.students',
};

// After this many consecutive health-check misses a worker is considered wedged
// and recycled (a one-off cold-start) rather than left blocking a slot.
export const RECYCLE_AFTER_MISSES = 2;

// A worker not busy and not being recycled is free to take (or be re-roled to)
// a task — covers both idle-warm and asleep (asleep just needs a re-warm first).
function isFree(w: Worker): boolean {
  return w.state === 'idle-warm' || w.state === 'asleep';
}

// Per-(tier, role) count of demand across a task list — the shape the warm pool
// is steered toward so most assignments land on step 1 (exact) of the ladder.
export function demandByTierRole(tasks: Task[]): Record<Tier, Record<Role, number>> {
  const d = {} as Record<Tier, Record<Role, number>>;
  for (const t of TIERS) {
    d[t] = {} as Record<Role, number>;
    for (const r of ROLES) d[t][r] = 0;
  }
  for (const task of tasks) d[task.tier][task.role] += 1;
  return d;
}

// Needed warm count per tier = concurrent actionable tasks of that tier, capped
// at perTierMax. This is DEMAND-driven, not a flat N-per-model: an idle tier
// wants 0 warm students, so it isn't kept hot.
export function warmTargets(tasks: Task[], cfg: ProtectorConfig): Record<Tier, number> {
  const demand = demandByTierRole(tasks);
  const out = {} as Record<Tier, number>;
  for (const tier of TIERS) {
    const total = ROLES.reduce((n, r) => n + demand[tier][r], 0);
    out[tier] = Math.min(total, cfg.perTierMax, cfg.maxConcurrent);
  }
  return out;
}

export class Protector {
  readonly cfg: ProtectorConfig;
  private workers: Worker[] = [];
  private idSeq = 0;
  private finishSeq = 0;
  // Optional hook to attach/replace the real warm session on spawn/recycle.
  private readonly attach?: (w: Worker) => unknown;

  constructor(cfg: Partial<ProtectorConfig> = {}, attach?: (w: Worker) => unknown) {
    this.cfg = { ...DEFAULT_PROTECTOR_CONFIG, ...cfg };
    this.attach = attach;
  }

  // Read-only snapshot for the dashboard / tests.
  get pool(): readonly Worker[] {
    return this.workers;
  }

  private countTier(tier: Tier): number {
    return this.workers.filter((w) => w.tier === tier).length;
  }

  // Caps count EVERY worker (recycling included) so we never exceed the physical
  // slot budget mid-recycle.
  private canSpawn(tier: Tier): boolean {
    return this.countTier(tier) < this.cfg.perTierMax && this.workers.length < this.cfg.totalCap;
  }

  private spawn(tier: Tier, role: Role): Worker {
    this.idSeq += 1;
    const id = `${this.cfg.idLabel?.(tier) ?? tier}-${this.idSeq}`;
    const w: Worker = {
      id,
      tier,
      role,
      state: 'idle-warm',
      task: null,
      worktree: `${this.cfg.worktreeRoot}/${id}`,
      lastFinishedSeq: 0,
      healthMisses: 0,
    };
    if (this.attach) w.session = this.attach(w);
    this.workers.push(w);
    return w;
  }

  private occupy(w: Worker, task: Task, kind: AssignKind): Assignment {
    w.role = task.role;
    w.state = 'busy';
    w.task = task.id;
    // The worker now carries this repo's spec in its prefix. Sticky like `role`,
    // for the same reason: it is what the NEXT assignment's ladder reads.
    if (task.repo !== undefined) w.repo = task.repo;
    return { task, kind, worker: w };
  }

  // Place ONE task via the matching ladder: exact -> re-role same model ->
  // spawn -> wait. `remaining` is the still-pending queue used only to protect
  // still-needed roles when choosing a re-role victim.
  assignOne(task: Task, remaining: Task[] = []): Assignment {
    const { tier, role } = task;
    const free = this.workers.filter((w) => w.tier === tier && isFree(w));
    // Repo participates as a PREFERENCE only. When the task carries no repo
    // (single-repo callers), sameRepo() is true for every worker and the ladder
    // collapses to exactly its pre-#121 behaviour.
    const sameRepo = (w: Worker): boolean =>
      task.repo == null || w.repo == null || w.repo === task.repo;

    // 1. Exact — an idle/warm (repo, tier, role) worker: full prefix HIT.
    const exact = free.filter((w) => w.role === role && sameRepo(w)).sort(byWarmthDesc);
    if (exact.length > 0) return this.occupy(exact[0], task, 'exact');

    // 2. Re-role same (repo, model) — reuse a free worker of this tier in
    //    another role; the spec block stays cached, only the role block
    //    re-caches. Pick the victim whose CURRENT role has the least remaining
    //    demand (don't cannibalize a still-needed role); tie-break warmest.
    const sameRepoFree = free.filter(sameRepo);
    if (sameRepoFree.length > 0) {
      return this.occupy(pickRerole(sameRepoFree, remaining, tier), task, 'rerole');
    }

    // 3. Cross-repo — same (tier, role) on another repo's worker. The role
    //    prefix is still cached; only the spec block is re-read. A partial
    //    miss, and strictly cheaper than a cold spawn — so we take it rather
    //    than hold a slot idle. This is the rung that must never become a gate:
    //    no slot may sit idle-warm for repo A while repo B waits on a spawn.
    if (free.length > 0) {
      // Prefer a worker already in the right role (only the spec re-reads);
      // otherwise fall back to the same victim-selection as a re-role.
      const rightRole = free.filter((w) => w.role === role).sort(byWarmthDesc);
      const w = rightRole.length > 0 ? rightRole[0] : pickRerole(free, remaining, tier);
      return this.occupy(w, task, 'cross-repo');
    }

    // 4. Spawn — no free worker of this model at all: full cold-start, only if
    //    under the per-tier and total caps.
    if (this.canSpawn(tier)) {
      const w = this.spawn(tier, role);
      return this.occupy(w, task, 'spawn');
    }

    // 5. Wait — at cap and every worker of this model is busy. Name WHICH cap:
    //    a tier at its own ceiling is a different operator story from the whole
    //    pool being full, and neither is the engine idling.
    const waitReason: WaitReason = this.countTier(tier) >= this.cfg.perTierMax
      ? 'tier-at-cap'
      : 'pool-at-cap';
    return { task, kind: 'wait', worker: null, waitReason };
  }

  // Place a whole queue in priority order. Each task's re-role victim selection
  // sees only the tasks still after it, so a role with pending demand isn't
  // cannibalized to serve an earlier task.
  assign(tasks: Task[]): Assignment[] {
    const out: Assignment[] = [];
    for (let i = 0; i < tasks.length; i++) {
      out.push(this.assignOne(tasks[i], tasks.slice(i + 1)));
    }
    return out;
  }

  // Task finished: the worker frees but KEEPS its role (sticky — the role block
  // stays cached), and its warmth marker bumps so it's preferred on reuse.
  finish(workerId: string): void {
    const w = this.byId(workerId);
    if (!w) return;
    this.finishSeq += 1;
    w.state = 'idle-warm';
    w.task = null;
    w.lastFinishedSeq = this.finishSeq;
  }

  // Park an idle-warm worker asleep (still warm, still reusable).
  sleep(workerId: string): void {
    const w = this.byId(workerId);
    if (w && w.state === 'idle-warm') w.state = 'asleep';
  }

  // Proactive rebalance: shape the free warm pool's role mix toward the queue's
  // (tier, role) demand BEFORE the tasks land, so most later assignments hit the
  // exact-match step instead of paying a re-role. Never touches busy workers.
  // Returns the workers re-roled and their new role.
  rebalance(tasks: Task[]): { worker: Worker; from: Role; to: Role }[] {
    const demand = demandByTierRole(tasks);
    const changes: { worker: Worker; from: Role; to: Role }[] = [];
    for (const tier of TIERS) {
      const free = this.workers.filter((w) => w.tier === tier && isFree(w));
      const supply = {} as Record<Role, number>;
      for (const r of ROLES) supply[r] = 0;
      for (const w of free) supply[w.role] += 1;

      // Repeatedly move a surplus worker (its role oversupplied vs demand) to the
      // most-under-supplied role, until no beneficial move remains.
      for (;;) {
        const deficit = ROLES.filter((r) => demand[tier][r] > supply[r]).sort(
          (a, b) => demand[tier][b] - supply[b] - (demand[tier][a] - supply[a]),
        )[0];
        if (deficit === undefined) break;
        // Prefer re-roling the least-warm surplus worker (least cache to lose).
        const surplus = free
          .filter((w) => w.role !== deficit && supply[w.role] > demand[tier][w.role])
          .sort((a, b) => a.lastFinishedSeq - b.lastFinishedSeq)[0];
        if (!surplus) break;
        const from = surplus.role;
        supply[from] -= 1;
        supply[deficit] += 1;
        surplus.role = deficit;
        changes.push({ worker: surplus, from, to: deficit });
      }
    }
    return changes;
  }

  // Ensure exactly the demand-driven warm count exists per tier: spawn ONLY when
  // demand exceeds the live pool (never redundant — free workers are reused
  // first), and park surplus idle workers asleep so idle tiers aren't kept hot.
  reconcileWarm(tasks: Task[]): void {
    const targets = warmTargets(tasks, this.cfg);
    const demand = demandByTierRole(tasks);
    for (const tier of TIERS) {
      const want = targets[tier];
      // Free (reusable) workers of this tier — reused before any spawn.
      const free = this.workers.filter((w) => w.tier === tier && isFree(w));
      // Spawn up toward demand, respecting caps.
      const deficitRoles = rolesByDemandDesc(demand[tier]);
      let need = want - free.length;
      let ri = 0;
      while (need > 0 && this.canSpawn(tier)) {
        const role = deficitRoles[ri % deficitRoles.length] ?? ROLES[0];
        this.spawn(tier, role);
        ri += 1;
        need -= 1;
      }
      // Park surplus idle-warm workers asleep (never touch busy/asleep).
      const idle = this.workers.filter((w) => w.tier === tier && w.state === 'idle-warm');
      let surplus = idle.length - want;
      for (const w of idle) {
        if (surplus <= 0) break;
        w.state = 'asleep';
        surplus -= 1;
      }
    }
  }

  // Health-check every worker; a miss increments its counter, a pass clears it.
  // A worker over the miss threshold is flagged 'recycling' so it stops taking
  // work — but the rest of the pool keeps serving (recycle never blocks).
  // Returns the ids flagged for recycling this pass.
  healthCheck(isHealthy: (w: Worker) => boolean): string[] {
    const flagged: string[] = [];
    for (const w of this.workers) {
      if (w.state === 'recycling') continue;
      if (isHealthy(w)) {
        w.healthMisses = 0;
        continue;
      }
      w.healthMisses += 1;
      if (w.healthMisses >= RECYCLE_AFTER_MISSES) {
        w.state = 'recycling';
        w.task = null;
        flagged.push(w.id);
      }
    }
    return flagged;
  }

  // Replace a wedged worker with a fresh one of the same (tier, role) — a
  // one-off cold-start. Remove-then-spawn keeps the slot budget flat, so caps
  // hold across the swap. Returns the fresh worker (null if id unknown).
  recycle(workerId: string): Worker | null {
    const idx = this.workers.findIndex((w) => w.id === workerId);
    if (idx < 0) return null;
    const old = this.workers[idx];
    this.workers.splice(idx, 1);
    return this.spawn(old.tier, old.role);
  }

  private byId(id: string): Worker | undefined {
    return this.workers.find((w) => w.id === id);
  }
}

// Warmest first — the most-recently-finished worker has the freshest cache.
function byWarmthDesc(a: Worker, b: Worker): number {
  return b.lastFinishedSeq - a.lastFinishedSeq;
}

// The re-role victim: the free worker whose CURRENT role has the least
// remaining demand, tie-broken by warmth. Shared by the rerole and cross-repo
// rungs so both cannibalize the same least-needed worker (#121).
function pickRerole(free: Worker[], remaining: Task[], tier: Tier): Worker {
  const demand = roleDemandForTier(remaining, tier);
  return [...free].sort((a, b) => {
    const da = demand[a.role];
    const db = demand[b.role];
    if (da !== db) return da - db;
    return b.lastFinishedSeq - a.lastFinishedSeq;
  })[0];
}

// Remaining demand per role for one tier (0 for roles with none pending). Used
// to pick a re-role victim that isn't still needed in its current role.
function roleDemandForTier(tasks: Task[], tier: Tier): Record<Role, number> {
  const d = {} as Record<Role, number>;
  for (const r of ROLES) d[r] = 0;
  for (const t of tasks) if (t.tier === tier) d[t.role] += 1;
  return d;
}

// Roles ordered by demand (most first) — the order fresh spawns fill so the
// warm pool's role mix mirrors the queue.
function rolesByDemandDesc(demand: Record<Role, number>): Role[] {
  return ROLES.filter((r) => demand[r] > 0).sort((a, b) => demand[b] - demand[a]);
}
