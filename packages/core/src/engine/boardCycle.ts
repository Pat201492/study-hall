import type { QuotaSnapshot } from '@study-hall/harness/contract';
import { classify, fairShare, pullIssueNumber, type BoardAction, type ClassifyConfig } from '../classify.js';
import { issueToTask, type RawIssue, type OpenPull } from '../github.js';
import { inferDifficulty, effortFor, type Effort } from '../difficulty.js';
import { effectiveTier } from '../tierFallback.js';
import { collidingPaths, isContended } from '../ownership.js';
import { selectProvider, type ProviderChoice, type SelectReason } from '../providerSelect.js';
import { qualifyActionKey, qualifyItemKey } from '../keys.js';
import { modelFor, type EngineConfig, type ProviderPoolConfig } from '../config.js';
import type { Task } from '../taskmap.js';
import type { Role } from '../types.js';
import { TIERS, type Tier } from '../tiers.js';

// The heartbeat's decision step as a PURE function of (board snapshots, engine
// state, config). No fs, no gh, no child_process, no clock reads — `now` is an
// input. The engine fetches, calls decide(), then executes the returned
// decisions; every "why did it (not) dispatch" question is answerable from the
// returned list, and a scenario test can drive ticks over fixture boards without
// a binary on the machine.
//
// Ported from v1 live.ts's dispatch loop (#124 fair share, #177 file-collision
// hold, #178 contention signal, rewrite escalation, bounded run) with the repo
// carried as a typed field on every action and the provider chosen per
// dispatch through selectProvider.

/** One repo's board as fetched this tick plus the per-repo memory that gates it. */
export interface BoardSnapshot {
  /** owner/name */
  repo: string;
  issues: RawIssue[];
  pulls: OpenPull[];
  /** Issue numbers a PR has already been opened for (until the fetch shows the PR). */
  handled: ReadonlySet<number>;
  /** Item/action keys the watchdog has isolated on this board (qualified keys). */
  quarantined: ReadonlySet<string>;
  /** Issue numbers a PROMOTE label flip already fired for. */
  promoted: ReadonlySet<number>;
  /** Another writer is reshaping this board (watchdog.boardContested). */
  contested?: boolean;
}

/** Engine-wide state the decision depends on. Everything is data; nothing is read live. */
export interface CycleState {
  /** Epoch ms. */
  now: number;
  /** Qualified ACTION keys currently running, e.g. "REVIEW:owner/name:pr-12". */
  inFlight: ReadonlySet<string>;
  /** File globs/paths claimed by in-flight file-writing work (#177). */
  inFlightFiles: readonly string[];
  /** Students running per provider id. */
  inFlightPerProvider: Record<string, number>;
  quotas: Record<string, QuotaSnapshot | undefined>;
  /** Providers whose lane is halted (auth failure) and why. */
  halted?: Record<string, string | undefined>;
  /** The board surface's provider setting: an id, or 'auto' for failover. */
  providerChoice: ProviderChoice;
  failoverOrder: string[];
  /** Throttle.limit() for this tick (adaptive parallelism, #178). */
  throttleLimit: number;
  /** Bounded run: units still allowed; null = unbounded. */
  boundedRemaining: number | null;
  /** What a bounded unit is. With `pr`, new IMPLEMENT dispatches (plus those in
   *  flight) are capped at the remaining count so the run cannot overshoot. */
  boundedUnit?: 'pr' | 'merge';
  /** Item keys whose FIX should be a REWRITE (watchdog.needsRewrite). */
  rewriteItems?: ReadonlySet<string>;
  /** Attempts per item key, so a dispatch can be marked as a re-dispatch. */
  attempts?: Record<string, number>;
  /** A global (GitHub) capacity pause until this epoch ms, with its reason. */
  pausedUntil?: number;
  pauseReason?: string;
  /** Operator blackout window is open. */
  blackout?: boolean;
  /** A soft stop was requested: finish in-flight work, start nothing. */
  drain?: boolean;
  /** Rotates which repo wins ties (fairShare); the engine increments it per tick. */
  fairShareOffset?: number;
}

export type CycleConfig = Pick<EngineConfig, 'optimizationMode' | 'pools' | 'maxConcurrent' | 'autoMerge'> & {
  triage?: boolean;
  issueAudit?: ClassifyConfig['issueAudit'];
  acTiering?: EngineConfig['acTiering'];
  /** provider id -> harness id that runs its students. */
  harnessFor: Record<string, string>;
};

export type HoldReason =
  | 'blackout' | 'drain' | 'capacity-pause' | 'bounded-run-spent' | 'contested'
  | 'file-collision' | 'no-slots' | 'provider' | 'no-model';

export type Decision =
  | {
      kind: 'dispatch';
      action: BoardAction;
      /** "KIND:owner/name:target-n" — the in-flight key. */
      key: string;
      /** "owner/name:target-n" — the watchdog's item key. */
      item: string;
      role: Role;
      tier: Tier;
      provider: string;
      harness: string;
      model: string;
      effort: Effort;
      /** Files this dispatch claims until it finishes (#177). */
      files: string[];
      /** The item already absorbed attempts — a contention signal (#178). */
      redispatch: boolean;
      reason: string;
    }
  | {
      /** Orchestrator-only work: MERGE is a gh squash, PROMOTE/NEEDS_DETAIL a label. No student. */
      kind: 'act';
      action: BoardAction;
      key: string;
      item: string;
      reason: string;
    }
  | { kind: 'probe'; provider: string; reason: string }
  | {
      kind: 'hold';
      scope: 'tick' | 'repo' | 'action';
      reason: HoldReason;
      repo?: string;
      action?: BoardAction;
      detail?: string;
    };

export interface CycleResult {
  decisions: Decision[];
  /** resolve dispatches + re-dispatches this tick — the throttle's input. */
  contention: number;
  slots: { budget: number; used: number };
}

const NEEDS_WORKER: Record<BoardAction['kind'], boolean> = {
  MERGE: false, PROMOTE: false, NEEDS_DETAIL: false,
  FIX: true, RESOLVE: true, REVIEW: true, TRIAGE: true, IMPLEMENT: true,
};

/** Does this action WRITE repo files (so a file collision matters)? REVIEW writes
 *  nothing and TRIAGE only files issues, so neither can collide. */
function claimsFiles(a: BoardAction): boolean {
  return a.kind === 'IMPLEMENT' || a.kind === 'FIX' || a.kind === 'RESOLVE';
}

function poolTiers(pool: ProviderPoolConfig | undefined): Record<Tier, { maxWarm: number }> {
  const out = {} as Record<Tier, { maxWarm: number }>;
  for (const t of TIERS) out[t] = { maxWarm: pool?.tiers[t]?.maxWarm ?? 0 };
  return out;
}

function providerCap(cfg: CycleConfig, id: string): number | undefined {
  return cfg.pools[id]?.maxConcurrent;
}

/** Concurrency budget for new dispatches this tick: the throttle, the global
 *  ceiling and the sum of per-provider headroom all apply. */
export function slotBudget(cfg: CycleConfig, state: CycleState): number {
  const totalInFlight = Object.values(state.inFlightPerProvider).reduce((n, v) => n + (v ?? 0), 0);
  let providerHeadroom = 0;
  for (const id of state.failoverOrder) {
    if (state.halted?.[id]) continue;
    const cap = providerCap(cfg, id);
    if (cap == null) continue;
    providerHeadroom += Math.max(0, cap - (state.inFlightPerProvider[id] ?? 0));
  }
  return Math.max(0, Math.min(state.throttleLimit, cfg.maxConcurrent - totalInFlight, providerHeadroom));
}

interface RepoView {
  snap: BoardSnapshot;
  tasks: Map<string, Task>;
}

function taskFor(view: RepoView, issueNumber: number): Task | undefined {
  return view.tasks.get(`#${issueNumber}`);
}

/** The tier an action runs on. An issue action runs on its task's tier; a PR
 *  action on the tier its issue was implemented at (a reviewer/fixer reasons at
 *  the code's own model), sonnet when the PR has no task. Then routed through
 *  the provider's enabled tiers. */
function tierFor(a: BoardAction, view: RepoView, pool: ProviderPoolConfig | undefined): Tier {
  let nominal: Tier = 'sonnet';
  if (a.target === 'issue') {
    nominal = taskFor(view, a.number)?.model ?? 'sonnet';
  } else {
    const pr = view.snap.pulls.find((p) => p.number === a.number);
    const n = pr ? pullIssueNumber(pr) : null;
    nominal = (n != null ? taskFor(view, n)?.model : undefined) ?? 'sonnet';
  }
  return effectiveTier(nominal, poolTiers(pool));
}

/** The files an action will touch (#177): an issue's `Owns:` set for IMPLEMENT;
 *  a PR's changed paths plus its issue's `Owns:` for FIX/RESOLVE. */
function claimFiles(a: BoardAction, view: RepoView): string[] {
  const files = new Set<string>();
  if (a.target === 'issue') {
    for (const g of taskFor(view, a.number)?.owns ?? []) files.add(g);
  } else {
    const pr = view.snap.pulls.find((p) => p.number === a.number);
    for (const f of pr?.files ?? []) files.add(f);
    const n = pr ? pullIssueNumber(pr) : null;
    if (n != null) for (const g of taskFor(view, n)?.owns ?? []) files.add(g);
  }
  return [...files];
}

function alreadyRunning(a: BoardAction, key: string, snap: BoardSnapshot, state: CycleState): boolean {
  if (state.inFlight.has(key)) return true;
  if (a.kind === 'IMPLEMENT' && snap.handled.has(a.number)) return true;
  if (a.kind === 'PROMOTE' && snap.promoted.has(a.number)) return true;
  return false;
}

function describeSelect(reason: SelectReason, detail?: string): string {
  return detail ? `${reason}: ${detail}` : reason;
}

export function decide(boards: BoardSnapshot[], state: CycleState, cfg: CycleConfig): CycleResult {
  const decisions: Decision[] = [];
  const budget = slotBudget(cfg, state);
  const result = (used: number, contention: number): CycleResult => ({ decisions, contention, slots: { budget, used } });

  // Tick-level holds. Nothing — not even a merge — happens under these: a
  // blackout and a drain are operator intent, a capacity pause means GitHub
  // itself is refusing us, and a spent bounded run is the operator's "stop here
  // so I can look".
  if (state.blackout) { decisions.push({ kind: 'hold', scope: 'tick', reason: 'blackout' }); return result(0, 0); }
  if (state.drain) { decisions.push({ kind: 'hold', scope: 'tick', reason: 'drain' }); return result(0, 0); }
  if (state.pausedUntil != null && state.now < state.pausedUntil) {
    decisions.push({ kind: 'hold', scope: 'tick', reason: 'capacity-pause', detail: state.pauseReason });
    return result(0, 0);
  }
  if (state.boundedRemaining != null && state.boundedRemaining <= 0) {
    decisions.push({ kind: 'hold', scope: 'tick', reason: 'bounded-run-spent' });
    return result(0, 0);
  }

  // Classify every board, drop contested ones, interleave fairly.
  const views = new Map<string, RepoView>();
  const byRepo = new Map<string, BoardAction[]>();
  for (const snap of boards) {
    if (snap.contested) {
      decisions.push({ kind: 'hold', scope: 'repo', reason: 'contested', repo: snap.repo });
      continue;
    }
    const tasks = new Map<string, Task>();
    for (const issue of snap.issues) {
      const t = issueToTask(issue, cfg.optimizationMode, inferDifficulty, cfg.acTiering);
      tasks.set(t.id, t);
    }
    views.set(snap.repo, { snap, tasks });
    byRepo.set(snap.repo, classify(snap.issues, snap.pulls, cfg, snap.repo));
  }
  const ordered = fairShare(byRepo, state.fairShareOffset ?? 0);

  const inFlightPerProvider: Record<string, number> = { ...state.inFlightPerProvider };
  const caps: Record<string, number | undefined> = {};
  for (const id of state.failoverOrder) caps[id] = providerCap(cfg, id);
  if (state.providerChoice !== 'auto') caps[state.providerChoice] = providerCap(cfg, state.providerChoice);

  const claimed = [...state.inFlightFiles];
  let used = 0;
  let contention = 0;
  let probed: string | null = null;
  let providerHoldReported = false;
  let newUnits = [...state.inFlight].filter((k) => k.startsWith('IMPLEMENT:')).length;
  const unitCapped = (a: BoardAction): boolean =>
    state.boundedRemaining != null && (state.boundedUnit ?? 'pr') === 'pr' && a.kind === 'IMPLEMENT' && newUnits >= state.boundedRemaining;

  for (const action of ordered) {
    const view = views.get(action.repo)!;
    const key = qualifyActionKey(action.kind, action.repo, action.target, action.number);
    const item = qualifyItemKey(action.repo, action.target, action.number);

    if (view.snap.quarantined.has(item) || view.snap.quarantined.has(key)) continue;
    if (alreadyRunning(action, key, view.snap, state)) continue;

    if (!NEEDS_WORKER[action.kind]) {
      decisions.push({ kind: 'act', action, key, item, reason: action.reason });
      continue;
    }

    if (used >= budget) {
      decisions.push({ kind: 'hold', scope: 'action', reason: 'no-slots', action });
      continue;
    }
    if (unitCapped(action)) {
      decisions.push({ kind: 'hold', scope: 'action', reason: 'bounded-run-spent', action, detail: ` unit(s) left,  already started` });
      continue;
    }

    // File-collision hold (#177): a scheduling hold, not a board edit; retried
    // next tick once the colliding work lands. No slot consumed.
    let files: string[] = [];
    if (claimsFiles(action)) {
      files = claimFiles(action, view);
      const collision = collidingPaths(files, claimed);
      if (collision.length) {
        const contended = collision.filter(isContended);
        decisions.push({
          kind: 'hold', scope: 'action', reason: 'file-collision', action,
          detail: `${collision.join(', ')}${contended.length ? ` (contended: ${contended.join(', ')})` : ''}`,
        });
        continue;
      }
    }

    // A probe is already going out this tick; nothing else may commit to a
    // provider nobody has observed. Quietly wait for it.
    if (probed) continue;

    const sel = selectProvider({
      choice: state.providerChoice, failoverOrder: state.failoverOrder,
      quotas: state.quotas, inFlight: inFlightPerProvider, caps, halted: state.halted,
    });
    if (sel.reason === 'needs-probe' && sel.probe) {
      probed = sel.probe;
      decisions.push({ kind: 'probe', provider: sel.probe, reason: `no recent observation of ${sel.probe}` });
      continue;
    }
    if (!sel.provider) {
      // One hold line per tick is enough — the reason is the same for every action.
      if (!providerHoldReported) {
        decisions.push({ kind: 'hold', scope: 'action', reason: 'provider', action, detail: describeSelect(sel.reason, sel.detail) });
        providerHoldReported = true;
      }
      continue;
    }

    const provider = sel.provider;
    const pool = cfg.pools[provider];
    const tier = tierFor(action, view, pool);
    const model = modelFor({ pools: cfg.pools } as EngineConfig, provider, tier);
    if (!model) {
      decisions.push({ kind: 'hold', scope: 'action', reason: 'no-model', action, detail: `${provider} has no enabled tier for ${tier}` });
      continue;
    }
    const harness = cfg.harnessFor[provider];
    if (!harness) {
      decisions.push({ kind: 'hold', scope: 'action', reason: 'provider', action, detail: `no harness registered for ${provider}` });
      continue;
    }

    // A FIX becomes a REWRITE once the item has failed enough review rounds —
    // decided here so the ladder, warm map and attribution all key off the real role.
    const rewriting = action.kind === 'FIX' && (state.rewriteItems?.has(item) ?? false);
    const role: Role = rewriting ? 'rewrite' : (action.role ?? 'implement');
    const redispatch = (state.attempts?.[item] ?? 0) > 0;

    decisions.push({
      kind: 'dispatch', action, key, item, role, tier, provider, harness, model,
      effort: effortFor(tier, cfg.optimizationMode), files, redispatch,
      reason: `${action.reason} [${describeSelect(sel.reason)}]`,
    });
    used += 1;
    if (action.kind === 'IMPLEMENT') newUnits += 1;
    inFlightPerProvider[provider] = (inFlightPerProvider[provider] ?? 0) + 1;
    claimed.push(...files);
    if (action.kind === 'RESOLVE') contention += 1;
    if (redispatch) contention += 1;
  }

  return result(used, contention);
}
