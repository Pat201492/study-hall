import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Harness, MeterKind, PreflightResult, QuotaMonitor, QuotaSnapshot, Usage } from '@study-hall/harness/contract';
import { WarmSlot } from '@study-hall/harness/warmSlot';
import { tokensProcessed, cacheHitPct } from '@study-hall/harness/pricing';
import type { Ledger, EventRecord, RunRecord } from '@study-hall/harness/ledger/index';
import { sideRun } from '@study-hall/harness/ledger/sideRun';
import { decide, type BoardSnapshot, type CycleConfig, type Decision } from './boardCycle.js';
import { GitLock } from './gitLock.js';
import { Governance, type GovernanceVerdict } from './governance.js';
import { Persistence, type RepoMemory } from './persistence.js';
import { runRole as realRunRole, realGit, realGitHub, RoleRunError, type GitPort, type GitHubPort, type RoleRunOutput, type RoleRunInput, type RunnerDeps, type DispatchDecision } from './roleRunner.js';
import { Reporter, watchdogReport, wedgedReport, contestedReport, killReport, type ReportPort } from './reporting.js';
import { STATUS_SCHEMA, type EngineStatus, type RepoStatus, type StudentStatus, type InFlightRef } from './status.js';
import { boardProviderChoice, rateLimitFor, paceFor, type EngineConfig } from '../config.js';
import { billedTokens, RateTracker, type RateVerdict } from '../rateBudget.js';
import { assessPace, paceSamples, DEFAULT_PACE, type PaceSample, type PaceVerdict } from '../windowPace.js';
import { classify, isParked, parkedItems, deadlockedPulls, pullIssueNumber, type BoardAction } from '../classify.js';
import { issuesToTaskMap, specFingerprint, type RawIssue, type OpenPull } from '../github.js';
import * as gh from '../github.js';
import { ensureClone, reapOrphanWorktrees, type RepoClone } from '../worktree.js';
import { inferDifficulty } from '../difficulty.js';
import { Protector, type Task as ProtectorTask, type Worker } from '../protector.js';
import { AssignmentLog } from '../assignments.js';
import { qualifyActionKey, qualifyItemKey, parseQualifiedKey } from '../keys.js';
import { reoffend } from '../parole.js';
import { effectiveConcurrency } from '../optimizer.js';
import { readTestRun, startTestRun, clearTestRun, noteCompletion, type TestRunState } from '../testRun.js';
import { auditIssue, needsDetailComment, NEEDS_DETAIL_LABEL } from '../issueAudit.js';
import type { Task } from '../taskmap.js';
import type { DeadlockedPr, ParkedItem } from '../types.js';

// The heartbeat. Every `pollMs`: fetch every board -> reconcile the watchdog,
// parole and unparks against what GitHub shows -> assess governance ->
// decide() -> execute the decisions (merges and label flips inline, students on
// warm slots in the background) -> persist -> snapshot. Re-entrancy guarded:
// an overlapping tick is SKIPPED and logged, never queued.
//
// Everything that touches the world goes through `EnginePorts`, so the scenario
// test drives real ticks over fixture boards with a fake runner and no binary.

export interface EngineGitHub {
  fetchIssues(repo: string): Promise<RawIssue[]>;
  listOpenPulls(repo: string): Promise<OpenPull[]>;
  mergePr(repo: string, branch: string): Promise<void>;
  addLabel(repo: string, n: number, label: string, kind: 'issue' | 'pr'): Promise<void>;
  removeLabel(repo: string, n: number, label: string, kind: 'issue' | 'pr'): Promise<void>;
  commentIssue(repo: string, n: number, body: string): Promise<void>;
  rejectedReviewCount(repo: string, n: number): Promise<number>;
  ensureLabels(repo: string): Promise<string[]>;
  githubRateLimitReset(): Promise<number | null>;
}

export interface EngineGit {
  ensureClone(url: string, dir: string, base: string, identity?: { name: string; email: string }): Promise<RepoClone>;
  reapOrphanWorktrees(clone: RepoClone, inUse: string[]): Promise<string[]>;
}

export interface HarnessPort {
  get(id: string): Harness;
  quotaFor(provider: string): QuotaMonitor | undefined;
  /** The provider's meter, for spend that is not a role-run (a preflight probe). */
  meterFor?(provider: string): MeterKind | undefined;
  killAll(): void;
}

export interface EngineLog {
  info(m: string): void; ok(m: string): void; warn(m: string): void; err(m: string): void;
}

export interface EnginePorts {
  github: EngineGitHub;
  git: EngineGit;
  runnerGit?: GitPort;
  runnerGitHub?: GitHubPort;
  reports: ReportPort;
  harnesses: HarnessPort;
  ledger: Ledger;
  readSpec: (cloneDir: string) => string;
  runRole?: (input: RoleRunInput, deps: RunnerDeps) => Promise<RoleRunOutput>;
  now?: () => number;
  log?: EngineLog;
}

export const realEngineGitHub: EngineGitHub = {
  fetchIssues: gh.fetchIssues, listOpenPulls: (r) => gh.listOpenPulls(r), mergePr: gh.mergePr,
  addLabel: (r, n, l, k) => gh.addLabel(r, n, l, k), removeLabel: (r, n, l, k) => gh.removeLabel(r, n, l, k),
  commentIssue: (r, n, b) => gh.commentIssue(r, n, b), rejectedReviewCount: (r, n) => gh.rejectedReviewCount(r, n),
  ensureLabels: (r) => gh.ensureLabels(r), githubRateLimitReset: () => gh.githubRateLimitReset(),
};

export const realEngineGit: EngineGit = { ensureClone, reapOrphanWorktrees };

export const realReports: ReportPort = {
  openIssueOnce: (r, t, b) => gh.openIssueOnce(r, t, b),
  openWatchdogReports: (r) => gh.openWatchdogReports(r),
  closeIssue: (r, n, c) => gh.closeIssue(r, n, c),
};

/** v1 readSpec: CLAUDE.md is injected by the CLI already, so only NAME it;
 *  docs/SPEC.md is sent when it differs. */
export function readSpec(cloneDir: string): string {
  const parts: string[] = [];
  const claudeMd = join(cloneDir, 'CLAUDE.md');
  const injected = existsSync(claudeMd) ? readFileSync(claudeMd, 'utf8') : '';
  if (injected) {
    parts.push('===== CLAUDE.md =====\nAlready in your context IN FULL — the CLI injects this repository\'s CLAUDE.md\n'
      + 'automatically. Follow it. Do NOT read, cat or grep it from disk; doing so would\nadd a second copy of something you can already see.');
  }
  const specMd = join(cloneDir, 'docs/SPEC.md');
  if (existsSync(specMd)) {
    const body = readFileSync(specMd, 'utf8');
    if (body.trim() !== injected.trim()) parts.push(`===== docs/SPEC.md =====\n${body}`);
  }
  return parts.join('\n\n');
}

interface RepoRuntime {
  slug: string;
  configured: string;
  clone: RepoClone;
  spec: string;
  memory: RepoMemory;
  tasks: Task[];
  issues: RawIssue[];
  pulls: OpenPull[];
  fetchedAt?: string;
  fetchError?: string;
  deadlocked: DeadlockedPr[];
  parked: ParkedItem[];
  contestedReported: boolean;
}

interface InFlightEntry {
  decision: DispatchDecision;
  runId: string;
  workerId: string;
  startedAt: string;
  usage: Usage | null;
  abort: AbortController;
  promise: Promise<void>;
}

export interface EngineOptions {
  config: () => EngineConfig;
  persistence: Persistence;
  governance: Governance;
  ports: EnginePorts;
  /** provider id -> harness id. */
  harnessFor: Record<string, string>;
  /** Idle ticks before a silent student is killed; passed through to the harness. */
  reportRepo?: string;
}

export type TickOutcome = 'ran' | 'skipped-overlap' | 'skipped-stopped';

const SILENT_HOLDS = new Set(['no-slots']);

export class Engine {
  readonly repos = new Map<string, RepoRuntime>();
  readonly inFlight = new Map<string, InFlightEntry>();
  private readonly inFlightFiles = new Map<string, string[]>();
  private readonly lastDispatched = new Map<string, string>();
  private readonly capacityFailed = new Set<string>();
  private readonly protectors = new Map<string, Protector>();
  private readonly slots = new Map<string, WarmSlot>();
  private readonly lastUsage = new Map<string, { tokens: number; cacheHitPct: number }>();
  /** Burn-rate governor, one per provider; only capped providers get a tracker. */
  private readonly rate = new Map<string, RateTracker>();
  private readonly rateResting = new Map<string, number | null>();
  /** One queue per clone, so git's shared metadata is written by one caller at a time. */
  private readonly gitLock = new GitLock({
    onRetry: (attempt, waitMs, e) => this.log.warn(`git is locked by another writer (attempt ${attempt}, waiting ${waitMs} ms): ${e.message.split('\n')[0]}`),
  });
  private readonly restingReason = new Map<string, string>();
  readonly assignments = new AssignmentLog();
  private readonly reporter: Reporter;
  private readonly log: EngineLog;
  private readonly now: () => number;
  private readonly runRole: (input: RoleRunInput, deps: RunnerDeps) => Promise<RoleRunOutput>;
  private ticking = false;
  private tickCount = 0;
  private fairShareOffset = 0;
  private lastTick: EngineStatus['lastTick'];
  private blackedOut = false;
  running = false;
  draining = false;
  stoppedReason: string | null = null;
  /** Called after anything observable changes, so status.json is fresh. */
  onChange: () => void = () => {};

  constructor(private readonly opts: EngineOptions) {
    this.log = opts.ports.log ?? { info: () => {}, ok: () => {}, warn: () => {}, err: () => {} };
    this.now = opts.ports.now ?? Date.now;
    this.runRole = opts.ports.runRole ?? realRunRole;
    this.reporter = new Reporter(opts.reportRepo ?? opts.config().reportRepo, opts.ports.reports, (m) => this.log.info(m));
  }

  private get cfg(): EngineConfig { return this.opts.config(); }
  private get gov(): Governance { return this.opts.governance; }
  private get persist(): Persistence { return this.opts.persistence; }
  private get ledger(): Ledger { return this.opts.ports.ledger; }

  private event(e: Omit<EventRecord, 'ts'>): void {
    this.ledger.recordEvent({ ts: new Date(this.now()).toISOString(), ...e });
  }

  // ---- boot -----------------------------------------------------------------------

  async boot(): Promise<void> {
    const cfg = this.cfg;
    if (!cfg.repos.length) throw new Error('no repos configured — set `repos` in config.json before --live');
    if (cfg.boundedRun.n <= 0 && !cfg.boundedRun.unbounded) {
      throw new Error('boundedRun.n is 0 and `unbounded: true` is not set — an unbounded run must be explicit');
    }

    for (const r of cfg.repos) {
      const slug = r.repo;
      const dir = join(this.persist.dirFor(slug), 'repo');
      const configured = `https://github.com/${slug}`;
      this.log.info(`${slug}: cloning → ${dir}`);
      // Boot is sequential per repo, so this cannot race the engine itself. It
      // goes through the lock anyway for the retry: another process (the
      // planner's checkout, a human running git) may hold the config lock.
      const clone = await this.gitLock.run(dir, () => this.opts.ports.git.ensureClone(configured, dir, 'main', cfg.gitIdentity));
      const reaped = await this.gitLock.run(dir, () => this.opts.ports.git.reapOrphanWorktrees(clone, [])).catch(() => [] as string[]);
      if (reaped.length) this.log.ok(`${slug}: reaped ${reaped.length} orphan worktree dir(s)`);
      await this.opts.ports.github.ensureLabels(configured)
        .then((made) => { if (made.length) this.log.ok(`${slug}: created missing pipeline label(s): ${made.join(', ')}`); })
        .catch((e) => this.log.err(`${slug}: could not ensure pipeline labels: ${(e as Error).message}`));
      const loaded = this.persist.load(slug, this.now());
      if (loaded.importedFrom) this.log.ok(`${slug}: imported v1 state (${loaded.imported.join(', ')}) from ${loaded.importedFrom}`);
      for (const [item, n] of Object.entries(loaded.memory.attempts)) this.gov.watchdog.seedAttempts(item, n);
      for (const [item, n] of Object.entries(loaded.memory.lifetime)) this.gov.watchdog.seedLifetime(item, n);
      for (const key of loaded.memory.quarantined) this.gov.quarantine(key);
      const rt: RepoRuntime = {
        slug, configured, clone, spec: this.opts.ports.readSpec(clone.dir), memory: loaded.memory,
        tasks: [], issues: [], pulls: [], deadlocked: [], parked: [], contestedReported: false,
      };
      this.repos.set(slug, rt);
      const pulls = await this.opts.ports.github.listOpenPulls(configured).catch(() => [] as OpenPull[]);
      await this.seedRejections(rt, pulls);
    }

    // Provider pools: one Protector per provider, sized from its pool.
    for (const [id, pool] of Object.entries(cfg.pools)) {
      const perTierMax = Math.max(1, ...Object.values(pool.tiers).map((t) => t?.maxWarm ?? 0));
      this.protectors.set(id, new Protector({ perTierMax, totalCap: pool.maxConcurrent, maxConcurrent: pool.maxConcurrent, worktreeRoot: join(this.persist.stateDir, 'students', id) }));
    }

    // Burn-rate governors, seeded from the ledger so a restart does not forget
    // the hour it just spent — the whole point is a window that cannot be
    // laundered by bouncing the process.
    this.syncRateTrackers();
    if (this.rate.size) {
      const oldest = Math.min(...[...this.rate.values()].map((t) => t.assess(this.now()).windowMs));
      const samples = this.ledger.reader.spendSamples(new Date(this.now() - oldest));
      for (const [id, tracker] of this.rate) {
        tracker.seed(samples.filter((s) => s.provider === id));
        const v = tracker.assess(this.now());
        this.log.info(`${id}: burn cap ${Math.round((v.tokens.cap ?? 0) / 1000)}k tokens/${Math.round(v.windowMs / 60_000)}min — ${Math.round(v.tokens.spent / 1000)}k already spent in the window${v.capped ? ' (RESTING)' : ''}`);
      }
    }

    // Quota monitors and a real preflight per provider in the failover order.
    for (const id of cfg.provider.failoverOrder) {
      const quota = this.opts.ports.harnesses.quotaFor(id);
      quota?.subscribe((s) => { if (s.observation) this.ledger.recordQuota(s.observation); });
      await quota?.start?.().catch((e) => this.log.warn(`${id}: quota monitor did not start: ${(e as Error).message}`));
      await this.preflight(id);
    }

    // Bounded by default. The budget file survives a crash so the count resumes.
    const trFile = this.testRunPath();
    if (cfg.boundedRun.n > 0) {
      const existing = readTestRun(trFile);
      if (!existing || existing.limit !== cfg.boundedRun.n || existing.unit !== cfg.boundedRun.unit) startTestRun(cfg.boundedRun.n, cfg.boundedRun.unit, trFile);
      this.log.info(`bounded run: ${readTestRun(trFile)?.done ?? 0}/${cfg.boundedRun.n} ${cfg.boundedRun.unit}(s)`);
    } else {
      clearTestRun(trFile);
      this.log.warn('UNBOUNDED run — every expensive incident was one.');
    }

    this.running = true;
    this.event({ level: 'info', event: 'engine.boot', data: { repos: [...this.repos.keys()], providers: cfg.provider.failoverOrder } });
    this.onChange();
  }

  private testRunPath(): string { return join(this.persist.stateDir, 'testrun.json'); }

  /** Config is re-read every tick: add trackers for newly capped providers, drop
   *  them when a cap is removed (the lane comes back at once, not at a reset). */
  private syncRateTrackers(): void {
    const cfg = this.cfg;
    for (const id of new Set([...cfg.provider.failoverOrder, ...Object.keys(cfg.pools)])) {
      const limit = rateLimitFor(cfg, id);
      const existing = this.rate.get(id);
      if (!limit) {
        if (existing) { this.rate.delete(id); this.rateResting.delete(id); this.log.info(`${id}: burn cap removed — lane available again`); }
        continue;
      }
      if (existing) existing.setLimit(limit);
      else this.rate.set(id, new RateTracker(id, limit, this.now));
    }
  }

  /** Window pacing for one provider, from the utilization the provider itself reported. */
  private assessPaceFor(provider: string, now: number): PaceVerdict | null {
    const opts = paceFor(this.cfg, provider);
    if (!opts) return null;
    const lookback = opts.lookbackMs ?? DEFAULT_PACE.lookbackMs;
    let samples: PaceSample[] = [];
    try { samples = paceSamples(this.ledger.reader.quotaHistory(provider, new Date(now - lookback))); }
    catch (e) { this.log.warn(`${provider}: could not read quota history for pacing: ${(e as Error).message}`); }
    return assessPace(provider, samples, now, opts);
  }

  /**
   * Providers resting this tick, with transitions logged once.
   *
   * Two governors, one seam: the fixed burn cap (rateBudget) and window pacing
   * (windowPace). Either resting rests the lane, and when both speak the reason
   * carries both — an operator raising one number should not be surprised that
   * the other still holds.
   */
  private assessRates(now: number): { capped: Record<string, { reason: string; resumesAt: number | null } | undefined>; verdicts: Record<string, RateVerdict>; paces: Record<string, PaceVerdict> } {
    const capped: Record<string, { reason: string; resumesAt: number | null } | undefined> = {};
    const verdicts: Record<string, RateVerdict> = {};
    const paces: Record<string, PaceVerdict> = {};
    const cfg = this.cfg;
    for (const id of new Set([...this.rate.keys(), ...cfg.provider.failoverOrder, ...Object.keys(cfg.pools)])) {
      const v = this.rate.get(id)?.assess(now) ?? null;
      const p = this.assessPaceFor(id, now);
      if (v) verdicts[id] = v;
      if (p) paces[id] = p;
      const reasons = [v?.capped ? v.reason : null, p?.capped ? p.reason : null].filter((r): r is string => !!r);
      const resting = reasons.length > 0;
      const was = this.rateResting.get(id);
      if (resting) {
        const reason = reasons.join('; ');
        capped[id] = { reason, resumesAt: v?.capped ? v.resumesAt : null };
        if (was === undefined || this.restingReason.get(id) !== reason) {
          this.rateResting.set(id, capped[id]!.resumesAt);
          this.restingReason.set(id, reason);
          this.log.warn(`${id}: RESTING — ${reason}${capped[id]!.resumesAt ? `; resumes ${new Date(capped[id]!.resumesAt!).toLocaleTimeString()}` : ''}`);
          this.event({ level: 'warn', event: 'provider.rate-capped', reason, data: { provider: id, spent: v?.tokens.spent ?? null, cap: v?.tokens.cap ?? null, resumesAt: capped[id]!.resumesAt, inFlightTokens: v?.inFlightTokens ?? 0, paceRatio: p?.limiting?.ratio ?? null, window: p?.limiting?.window ?? null } });
        }
      } else if (was !== undefined) {
        this.rateResting.delete(id);
        this.restingReason.delete(id);
        this.log.ok(`${id}: back under its limits${v ? ` (${Math.round(v.tokens.spent / 1000)}k of ${Math.round((v.tokens.cap ?? 0) / 1000)}k this window)` : ''} — dispatching again`);
        this.event({ level: 'info', event: 'provider.rate-resumed', data: { provider: id, spent: v?.tokens.spent ?? null, cap: v?.tokens.cap ?? null } });
      }
    }
    return { capped, verdicts, paces };
  }

  private async seedRejections(rt: RepoRuntime, pulls: OpenPull[]): Promise<void> {
    await Promise.all(pulls.map(async (pr) => {
      const item = qualifyItemKey(rt.slug, 'pr', pr.number);
      if (this.gov.watchdog.attemptsFor(item) > 0) return;
      const n = await this.opts.ports.github.rejectedReviewCount(rt.configured, pr.number).catch(() => 0);
      if (n > 0) this.gov.watchdog.seedAttempts(item, n);
    }));
    this.persistCounters(rt.slug);
  }

  /** A real trivial completion — `--version` passes with an expired login. */
  private async preflight(provider: string): Promise<PreflightResult | null> {
    const harnessId = this.opts.harnessFor[provider];
    if (!harnessId) return null;
    let harness: Harness;
    try { harness = this.opts.ports.harnesses.get(harnessId); } catch (e) { this.log.err(`${provider}: ${(e as Error).message}`); return null; }
    const startedAt = this.now();
    const r = await harness.preflight().catch((e) => ({ ok: false, detail: (e as Error).message } as PreflightResult));
    // A probe is a real completion. Bank it, or the window moves with nothing
    // in the ledger to explain it and the burn governor under-counts (#21).
    if (r.usage) {
      this.ledger.recordRun(sideRun({
        role: 'preflight', provider, harness: harness.id, usage: r.usage, startedAt, endedAt: this.now(),
        meter: this.opts.ports.harnesses.meterFor?.(provider) ?? 'subscription', notes: r.version ? `probe on ${r.version}` : null,
      }));
    }
    const quota = this.opts.ports.harnesses.quotaFor(provider);
    if (r.ok && r.authOk !== false) {
      quota?.observe({ provider, observedAt: this.now(), source: 'probe', allowed: true, detail: r.version ? `preflight ok (${r.version})` : 'preflight ok' });
      if (this.gov.isHalted(provider)) { this.gov.clearHalt(provider); this.log.ok(`${provider}: lane restored`); }
      this.log.ok(`${provider}: preflight ok${r.version ? ` (${r.version})` : ''} via ${r.bin ?? harnessId}`);
    } else {
      const verdict = harness.classifyFailure(r.detail ?? 'preflight failed', this.now());
      if (verdict.kind === 'auth' || r.authOk === false) {
        this.gov.onFailure({ verdict: { kind: 'auth', detail: r.detail ?? 'preflight: not authenticated' }, provider, item: '', key: '', message: r.detail ?? '', now: this.now() });
        this.log.err(`${provider}: lane HALTED — ${r.detail ?? 'not authenticated'}`);
      } else if (verdict.kind === 'capacity') {
        quota?.markExhausted(verdict.resetAt, r.detail);
        this.log.warn(`${provider}: at capacity (${r.detail ?? ''})`);
      } else {
        this.log.err(`${provider}: preflight failed — ${r.detail ?? 'unknown'}`);
      }
    }
    this.event({ level: r.ok ? 'info' : 'warn', event: 'provider.preflight', data: { provider, ...r } });
    return r;
  }

  // ---- tick ---------------------------------------------------------------------------

  async tick(): Promise<TickOutcome> {
    if (!this.running) return 'skipped-stopped';
    if (this.ticking) {
      this.log.warn('tick overlapped the previous one — skipped (never queued)');
      this.event({ level: 'warn', event: 'tick.overlap' });
      return 'skipped-overlap';
    }
    this.ticking = true;
    try {
      await this.tickBody();
      this.gov.watchdog.tickOk();
    } catch (e) {
      this.gov.watchdog.tickError();
      this.log.err(`tick error: ${(e as Error).message}`);
      this.event({ level: 'error', event: 'tick.error', reason: (e as Error).message });
      const esc = this.gov.watchdog.assess();
      if (esc.level === 'kill') await this.killAndReport(esc.reason, esc.wedged);
    } finally {
      this.tickCount += 1;
      this.ticking = false;
      this.writeStatus();
    }
    return 'ran';
  }

  private async tickBody(): Promise<void> {
    const cfg = this.cfg;
    const now = this.now();

    // 1. Fetch every board. A board whose fetch fails keeps its previous lists.
    let fetched = 0;
    const fetchErrors: { slug: string; capacity: boolean; msg: string }[] = [];
    const onBoard = new Set<string>();
    const openByRepo = new Map<string, Set<string>>();
    for (const rt of this.repos.values()) {
      try {
        const [issues, pulls] = await Promise.all([this.opts.ports.github.fetchIssues(rt.configured), this.opts.ports.github.listOpenPulls(rt.configured)]);
        fetched += 1;
        rt.issues = issues; rt.pulls = pulls; rt.fetchedAt = new Date(now).toISOString(); rt.fetchError = undefined;
        rt.tasks = issuesToTaskMap(issues, cfg.optimizationMode, inferDifficulty, cfg.acTiering).tasks;
        for (const p of pulls) onBoard.add(qualifyItemKey(rt.slug, 'pr', p.number));
        for (const i of issues) onBoard.add(qualifyItemKey(rt.slug, 'issue', i.number));
        openByRepo.set(rt.slug, new Set([...pulls.map((p) => `pr-${p.number}`), ...issues.map((i) => `issue-${i.number}`)]));
        // Spec churn: another writer reshaping the board?
        const specs = new Map(issues.map((i) => [i.number, specFingerprint(i.title, i.body)]));
        this.gov.watchdog.observeBoard(specs, rt.slug);
        this.updateBoardHealth(rt);
        this.reconcileUnparked(rt);
        this.paroleDue(rt, now);
        this.reconcileHandled(rt);
      } catch (e) {
        const msg = (e as Error)?.message ?? String(e);
        const capacity = /rate limit|API rate limit exceeded|abuse detection|secondary rate/i.test(msg);
        rt.fetchError = msg;
        fetchErrors.push({ slug: rt.slug, capacity, msg });
        this.log.err(`${rt.slug}: board fetch failed${capacity ? ' — GitHub rate limit' : ''}: ${msg}`);
      }
    }
    if (!fetched) {
      if (fetchErrors.length && fetchErrors.every((f) => f.capacity)) {
        const resetSec = await this.opts.ports.github.githubRateLimitReset().catch(() => null);
        const until = resetSec != null ? Math.min(Math.max(resetSec * 1000, now + 30_000), now + 60 * 60_000) : now + 5 * 60_000;
        this.gov.pauseDispatch(until, 'GitHub rate limit');
        this.event({ level: 'warn', event: 'capacity.github', reason: fetchErrors[0].msg, data: { until } });
        return;
      }
      throw new Error(`every board fetch failed: ${fetchErrors.map((f) => f.msg).join('; ')}`);
    }
    void this.reporter.sweep(openByRepo, now);

    // 2. Watchdog reconcile against what the boards show now.
    this.reconcileWatchdog(onBoard);
    const esc = this.gov.watchdog.assess();
    if (esc.level === 'kill') { await this.killAndReport(esc.reason, esc.wedged); return; }
    const newlyWedged = this.gov.watchdog.newlyWedged();
    const ticksAtWedge = new Map(newlyWedged.map((k) => [k, this.gov.watchdog.countFor(k)]));
    if (esc.level === 'quarantine') for (const key of esc.keys) this.quarantineKey(key, 'wedged');
    for (const key of newlyWedged) {
      const rt = this.repoForKey(key);
      if (rt) void this.reporter.file(wedgedReport(key, rt.slug, ticksAtWedge.get(key) ?? 0));
    }
    for (const item of this.gov.watchdog.newlyExhausted()) this.quarantineKey(item, 'exhausted');

    // 3. Governance for this tick.
    const g = this.gov.assessTick(now);
    if (g.blackout !== this.blackedOut) {
      this.blackedOut = g.blackout;
      this.log.info(g.blackout ? `blackout: holding dispatch for ${g.blackoutMinutes}m` : 'blackout over — dispatching again');
    }
    const contested = new Set(this.gov.watchdog.contestedBoards());
    for (const rt of this.repos.values()) {
      if (contested.has(rt.slug) && !rt.contestedReported) {
        rt.contestedReported = true;
        this.log.err(`${rt.slug}: board contested — ${this.gov.watchdog.churnCount(rt.slug)} spec(s) rewritten. Pausing this board.`);
        void this.reporter.file(contestedReport(rt.slug, this.gov.watchdog.churnCount(rt.slug)));
      } else if (!contested.has(rt.slug) && rt.contestedReported) {
        rt.contestedReported = false;
        this.log.ok(`${rt.slug}: board settled — resuming`);
      }
    }
    const configuredParallel = effectiveConcurrency(cfg.optimizationMode, cfg.maxConcurrent, cfg.maxParallel);
    this.gov.setParallelism(configuredParallel);

    // 4. Decide.
    const boards: BoardSnapshot[] = [...this.repos.values()].map((rt) => ({
      repo: rt.slug, issues: rt.issues, pulls: rt.pulls,
      handled: rt.memory.handled, quarantined: rt.memory.quarantined, promoted: this.promoted(rt),
      contested: contested.has(rt.slug),
    }));
    const inFlightPerProvider: Record<string, number> = {};
    for (const e of this.inFlight.values()) inFlightPerProvider[e.decision.provider] = (inFlightPerProvider[e.decision.provider] ?? 0) + 1;
    const quotas: Record<string, QuotaSnapshot | undefined> = {};
    for (const id of cfg.provider.failoverOrder) quotas[id] = this.opts.ports.harnesses.quotaFor(id)?.snapshot(now);
    const choice = boardProviderChoice(cfg);
    if (choice !== 'auto' && !quotas[choice]) quotas[choice] = this.opts.ports.harnesses.quotaFor(choice)?.snapshot(now);
    const testRun = readTestRun(this.testRunPath());
    const rewriteItems = new Set<string>();
    for (const item of this.gov.watchdog.trackedItems()) if (this.gov.watchdog.needsRewrite(item)) rewriteItems.add(item);
    const cycleCfg: CycleConfig = {
      optimizationMode: cfg.optimizationMode, pools: cfg.pools, maxConcurrent: configuredParallel, autoMerge: cfg.autoMerge,
      acTiering: cfg.acTiering, harnessFor: this.opts.harnessFor, triage: cfg.triage, issueAudit: cfg.issueAudit,
    };
    this.syncRateTrackers();
    const rates = this.assessRates(now);
    const result = decide(boards, {
      now, inFlight: new Set(this.inFlight.keys()), inFlightFiles: [...this.inFlightFiles.values()].flat(), inFlightPerProvider,
      quotas, halted: g.halted, rateCapped: rates.capped, providerChoice: choice, failoverOrder: cfg.provider.failoverOrder,
      throttleLimit: g.throttleLimit, boundedRemaining: testRun ? Math.max(0, testRun.limit - testRun.done) : null, boundedUnit: testRun?.unit,
      rewriteItems, attempts: this.gov.watchdog.attemptSnapshot(), pausedUntil: g.pausedUntil, pauseReason: g.pauseReason,
      blackout: g.blackout, drain: this.draining, fairShareOffset: this.fairShareOffset++,
    }, cycleCfg);

    // 5. Execute.
    let dispatched = 0; let acted = 0; let held = 0; let probes = 0;
    for (const d of result.decisions) {
      switch (d.kind) {
        case 'dispatch':
          if (this.dispatch(d)) dispatched += 1;
          break;
        case 'act':
          acted += 1;
          void this.act(d);
          break;
        case 'probe':
          probes += 1;
          this.log.info(`probing ${d.provider} — ${d.reason}`);
          this.event({ level: 'info', event: 'provider.probe', reason: d.reason, data: { provider: d.provider } });
          void this.preflight(d.provider);
          break;
        case 'hold':
          held += 1;
          if (!SILENT_HOLDS.has(d.reason)) {
            const where = d.action ? `${d.action.kind} ${d.action.repo}#${d.action.number}` : d.repo ?? 'tick';
            this.log.info(`hold ${where}: ${d.reason}${d.detail ? ` — ${d.detail}` : ''}`);
            this.event({ level: 'info', event: `hold.${d.reason}`, repo: d.action?.repo ?? d.repo ?? null, item: d.action?.number ?? null, action: d.action?.kind ?? null, reason: d.detail ?? d.reason });
          }
          if (d.reason === 'bounded-run-spent' && this.inFlight.size === 0 && !this.stoppedReason) {
            this.log.ok(`bounded run complete (${testRun?.done}/${testRun?.limit} ${testRun?.unit}s) — parking. Raise boundedRun.n or set unbounded to continue.`);
            this.stop('bounded run complete');
          }
          break;
      }
    }
    this.gov.observeContention(result.contention);
    this.lastTick = { at: new Date(now).toISOString(), dispatched, acted, held, probes };
    this.refreshTokens();
  }

  // ---- reconcile helpers ------------------------------------------------------------------

  private promoted(rt: RepoRuntime): Set<number> {
    // A PROMOTE that fired is visible on the board (the label is gone); a
    // number still carrying `blocked` after the flip is retried, which is safe.
    return new Set<number>();
  }

  private updateBoardHealth(rt: RepoRuntime): void {
    const before = new Set(rt.deadlocked.map((d) => d.number));
    rt.deadlocked = deadlockedPulls(rt.pulls).map((p) => ({ repo: rt.slug, number: p.number, title: p.title, labels: p.labels.filter((l) => l === 'reviewed-ok' || isParked([l])) }));
    for (const d of rt.deadlocked) if (!before.has(d.number)) this.log.err(`${rt.slug}#${d.number}: DEADLOCK — approved and given up on (${d.labels.join(', ')}); a human must settle it`);
    rt.parked = parkedItems(rt.issues, rt.pulls).map((p) => ({ repo: rt.slug, number: p.number, target: p.target, title: p.title, labels: p.labels, attempts: this.gov.watchdog.attemptsFor(qualifyItemKey(rt.slug, p.target, p.number)) }));
  }

  /** A human removed a parking label: hand the item back on probation. */
  private reconcileUnparked(rt: RepoRuntime): void {
    const stillParked = new Set<string>();
    const onBoard = new Set<string>();
    for (const i of rt.issues) { const k = qualifyItemKey(rt.slug, 'issue', i.number); onBoard.add(k); if (isParked(i.labels.map((l) => l.name))) stillParked.add(k); }
    for (const p of rt.pulls) { const k = qualifyItemKey(rt.slug, 'pr', p.number); onBoard.add(k); if (isParked(p.labels)) stillParked.add(k); }
    let changed = false;
    for (const key of [...rt.memory.quarantined]) {
      const t = parseQualifiedKey(key);
      if (!t) continue;
      const item = qualifyItemKey(t.slug ?? rt.slug, t.kind, t.number);
      if (onBoard.has(item) && !stillParked.has(item)) {
        rt.memory.quarantined.delete(key);
        rt.memory.paroleOf.delete(key);
        this.gov.release(item, key);
        changed = true;
        this.log.ok(`${item}: parking label removed — back on the board with a probe dispatch`);
        this.event({ level: 'info', event: 'item.released', repo: rt.slug, item: t.number, reason: 'label removed' });
      }
    }
    if (changed) { this.persist.saveQuarantine(rt.slug, rt.memory.quarantined, rt.memory.paroleOf); this.persistCounters(rt.slug); }
  }

  private paroleDue(rt: RepoRuntime, now: number): void {
    const { release, exhausted } = this.gov.paroleDue(rt.memory.paroleOf, now);
    for (const key of exhausted) {
      this.log.err(`${key}: parole due but lifetime cap spent (${this.gov.watchdog.lifetimeFor(key)}) — staying parked; a human decides`);
    }
    if (!release.length) return;
    for (const key of release) {
      const t = parseQualifiedKey(key);
      const item = t ? qualifyItemKey(t.slug ?? rt.slug, t.kind, t.number) : key;
      rt.memory.quarantined.delete(key);
      this.gov.release(item, key);
      this.log.ok(`${key}: quarantine served — back on the board with a probe dispatch`);
      this.event({ level: 'info', event: 'item.paroled', repo: rt.slug, item: t?.number ?? null });
      if (t) void this.opts.ports.github.removeLabel(rt.configured, t.number, 'runner-error', t.kind).catch((e) => this.log.err(`#${t.number} could not clear runner-error on parole: ${(e as Error).message}`));
    }
    this.persist.saveQuarantine(rt.slug, rt.memory.quarantined, rt.memory.paroleOf);
    this.persistCounters(rt.slug);
  }

  /** Forget handled numbers whose issue left the board (closed/merged). */
  private reconcileHandled(rt: RepoRuntime): void {
    const open = new Set(rt.issues.map((i) => i.number));
    let changed = false;
    for (const n of [...rt.memory.handled]) if (!open.has(n)) { rt.memory.handled.delete(n); changed = true; }
    if (changed) this.persist.saveHandled(rt.slug, rt.memory.handled);
  }

  private actionSignature(a: BoardAction): string {
    const rt = this.repos.get(a.repo);
    if (a.target === 'pr') {
      const pr = rt?.pulls.find((p) => p.number === a.number);
      if (!pr) return 'gone';
      return `${pr.mergeable}|${pr.statusCheckRollup}|${pr.reviewDecision}|${[...pr.labels].sort().join(',')}`;
    }
    return `issue|handled=${rt?.memory.handled.has(a.number) ?? false}`;
  }

  private reconcileWatchdog(onBoard: Set<string>): void {
    const cfg = this.cfg;
    const wanted = new Map<string, BoardAction>();
    for (const rt of this.repos.values()) {
      for (const a of classify(rt.issues, rt.pulls, { autoMerge: cfg.autoMerge, triage: cfg.triage, issueAudit: cfg.issueAudit }, rt.slug)) wanted.set(qualifyActionKey(a.kind, rt.slug, a.target, a.number), a);
    }
    for (const [key, sigAtDispatch] of [...this.lastDispatched]) {
      if (this.inFlight.has(key)) continue;
      const a = wanted.get(key);
      if (this.capacityFailed.delete(key)) this.gov.watchdog.clear(key);
      else if (a && this.actionSignature(a) === sigAtDispatch) this.gov.watchdog.bump(key);
      else this.gov.watchdog.clear(key);
      this.lastDispatched.delete(key);
    }
    for (const item of this.gov.watchdog.trackedItems()) {
      if (onBoard.has(item)) continue;
      this.gov.watchdog.forgetItem(item);
      const rt = this.repoForKey(item);
      if (rt && rt.memory.quarantined.delete(item)) this.persist.saveQuarantine(rt.slug, rt.memory.quarantined, rt.memory.paroleOf);
    }
  }

  private repoForKey(key: string): RepoRuntime | undefined {
    const slug = parseQualifiedKey(key)?.slug;
    return slug ? this.repos.get(slug) : undefined;
  }

  private quarantineKey(key: string, why: 'wedged' | 'exhausted'): void {
    const rt = this.repoForKey(key);
    if (!rt || rt.memory.quarantined.has(key)) return;
    const t = parseQualifiedKey(key)!;
    const item = qualifyItemKey(rt.slug, t.kind, t.number);
    const attempts = this.gov.watchdog.attemptsFor(item);
    rt.memory.quarantined.add(key);
    rt.memory.paroleOf.set(key, reoffend(rt.memory.paroleOf.get(key), this.now()));
    this.gov.quarantine(key);
    this.persist.saveQuarantine(rt.slug, rt.memory.quarantined, rt.memory.paroleOf);
    this.log.err(`watchdog: ${key} ${why === 'exhausted' ? `worked ${attempts}x without settling` : 'wedged with no progress'} — quarantined (runner-error)`);
    this.event({ level: 'warn', event: `item.quarantined`, repo: rt.slug, item: t.number, reason: why, data: { attempts } });
    void this.opts.ports.github.addLabel(rt.configured, t.number, 'runner-error', t.kind).catch((e) => this.log.err(`#${t.number} runner-error label failed: ${(e as Error).message}`));
    if (why === 'exhausted') void this.reporter.file(watchdogReport(item, rt.slug, attempts));
  }

  private persistCounters(slug: string): void {
    this.persist.saveAttempts(slug, this.gov.watchdog.attemptSnapshot());
    this.persist.saveLifetime(slug, this.gov.watchdog.lifetimeSnapshot());
  }

  // ---- execute ------------------------------------------------------------------------------

  private async act(d: Extract<Decision, { kind: 'act' }>): Promise<void> {
    const rt = this.repos.get(d.action.repo);
    if (!rt) return;
    const a = d.action;
    this.lastDispatched.set(d.key, this.actionSignature(a));
    try {
      switch (a.kind) {
        case 'MERGE': {
          const pr = rt.pulls.find((p) => p.number === a.number);
          if (!pr) return;
          await this.opts.ports.github.mergePr(rt.configured, pr.headRefName);
          this.log.ok(`${rt.slug}#${pr.number} merged (squash) — ${pr.title}`);
          this.ledger.recordOutcome({ outcomeId: randomUUID(), repo: rt.slug, item: pullIssueNumber(pr) ?? pr.number, ts: new Date(this.now()).toISOString(), outcome: 'merged', prNumber: pr.number, mergedAt: new Date(this.now()).toISOString() });
          this.event({ level: 'info', event: 'pr.merged', repo: rt.slug, item: pr.number, action: 'MERGE' });
          this.noteUnit('merge');
          break;
        }
        case 'PROMOTE':
          await this.opts.ports.github.removeLabel(rt.configured, a.number, 'blocked', 'issue');
          this.log.ok(`${rt.slug}#${a.number} promoted — deps closed, dropped 'blocked'`);
          this.event({ level: 'info', event: 'issue.promoted', repo: rt.slug, item: a.number, action: 'PROMOTE' });
          break;
        case 'NEEDS_DETAIL': {
          const issue = rt.issues.find((i) => i.number === a.number);
          if (!issue) return;
          await this.opts.ports.github.addLabel(rt.configured, a.number, NEEDS_DETAIL_LABEL, 'issue');
          await this.opts.ports.github.commentIssue(rt.configured, a.number, needsDetailComment(auditIssue(issue, this.cfg.issueAudit?.gate)));
          this.log.warn(`${rt.slug}#${a.number} flagged ${NEEDS_DETAIL_LABEL}: ${a.reason}`);
          this.event({ level: 'info', event: 'issue.needs-detail', repo: rt.slug, item: a.number, reason: a.reason });
          break;
        }
        default:
          return;
      }
    } catch (e) {
      this.log.err(`${a.kind} ${rt.slug}#${a.number} failed: ${(e as Error).message}`);
      this.event({ level: 'error', event: 'act.failed', repo: rt.slug, item: a.number, action: a.kind, reason: (e as Error).message });
    } finally {
      this.onChange();
    }
  }

  private dispatch(d: DispatchDecision): boolean {
    const rt = this.repos.get(d.action.repo);
    if (!rt) return false;
    const protector = this.protectors.get(d.provider);
    if (!protector) { this.log.err(`no pool for provider ${d.provider}`); return false; }
    const ptask: ProtectorTask = { id: d.action.target === 'issue' ? `#${d.action.number}` : `pr-${d.action.number}`, tier: d.tier, role: d.role, repo: rt.slug };
    const before = new Map(protector.pool.map((w) => [w.id, w.role]));
    const asg = protector.assignOne(ptask);
    const w = asg.worker;
    const runId = randomUUID();
    this.assignments.record({
      at: this.now(), repo: rt.slug, taskId: ptask.id, kind: asg.kind, tier: d.tier, role: d.role, workerId: w?.id ?? null,
      ...(asg.kind === 'rerole' && w ? { fromRole: before.get(w.id) ?? w.role } : {}), ...(asg.waitReason ? { waitReason: asg.waitReason } : {}),
    });
    this.ledger.recordAssignment({
      ts: new Date(this.now()).toISOString(), repo: rt.slug, kind: asg.kind === 'cross-repo' ? 'crossRepo' : asg.kind, tier: d.tier, role: d.role,
      provider: d.provider, workerId: w?.id ?? null, fromRole: asg.kind === 'rerole' && w ? before.get(w.id) ?? null : null,
      waitReason: asg.waitReason ?? null, item: d.action.number, runId: w ? runId : null,
    });
    if (!w) {
      this.log.info(`${d.action.kind} ${rt.slug}#${d.action.number} waiting — ${asg.waitReason}`);
      return false;
    }
    const slot = this.slotFor(w, d.harness);
    const abort = new AbortController();
    const entry: InFlightEntry = { decision: d, runId, workerId: w.id, startedAt: new Date(this.now()).toISOString(), usage: null, abort, promise: Promise.resolve() };
    this.inFlight.set(d.key, entry);
    if (d.files.length) this.inFlightFiles.set(d.key, d.files);
    this.lastDispatched.set(d.key, this.actionSignature(d.action));
    const counters = this.gov.recordDispatch(d.item);
    this.persistCounters(rt.slug);
    this.log.info(`↻ ${d.action.kind} ${rt.slug}#${d.action.number} → ${w.id} (${asg.kind}, ${d.provider}/${d.model}) ${d.reason}`);
    this.event({ level: 'info', event: 'dispatch', repo: rt.slug, item: d.action.number, runId, action: d.action.kind, reason: d.reason, data: { role: d.role, provider: d.provider, harness: d.harness, model: d.model, tier: d.tier, worker: w.id, assignment: asg.kind, attempts: counters.attempts } });
    this.onChange();

    const cfg = this.cfg;
    const pool = cfg.pools[d.provider];
    entry.promise = this.runRole({
      decision: d, runId, worker: { id: w.id, slot },
      repo: { slug: rt.slug, configured: rt.configured, clone: rt.clone, spec: rt.spec, tasks: rt.tasks, pulls: rt.pulls },
      pool: { approval: pool.approval, sandbox: pool.sandbox, tools: pool.tools },
      budget: cfg.studentBudget[d.role], autoCompact: cfg.autoCompact,
      rounds: this.gov.watchdog.attemptsFor(d.item), signal: abort.signal,
      onUsage: (u) => {
        entry.usage = u;
        // Live burn counts the moment it happens: a fleet that starts five warm
        // students should rest the lane now, not an hour from now.
        this.rate.get(d.provider)?.live(runId, { tokens: billedTokens(u), usd: 0 });
      },
      onQuota: (o) => this.opts.ports.harnesses.quotaFor(d.provider)?.observe(o),
    }, {
      git: this.opts.ports.runnerGit ?? realGit, gh: this.opts.ports.runnerGitHub ?? realGitHub,
      // Two students preparing worktrees against one clone race git's config
      // lock, and the loser fails outright (#27). The runner has always routed
      // git through this seam; nothing supplied one until now.
      gitLock: this.gitLock.forClone(rt.clone.dir),
      log: (m) => this.log.info(m), now: this.now, transcriptDir: join(this.persist.stateDir, 'transcripts'),
      generatedFiles: cfg.generatedFiles?.length ? cfg.generatedFiles : undefined,
    }).then((out) => this.onRunDone(rt, d, out), (e) => this.onRunFailed(rt, d, e))
      .finally(() => {
        this.inFlight.delete(d.key);
        this.inFlightFiles.delete(d.key);
        // Every exit path clears the live burn entry; a committed one has already
        // replaced it, so this is a no-op except after a run that spent nothing.
        this.rate.get(d.provider)?.drop(runId);
        protector.finish(w.id);
        this.onChange();
      });
    return true;
  }

  private slotFor(w: Worker, harnessId: string): WarmSlot {
    let slot = this.slots.get(w.id);
    if (!slot) {
      slot = new WarmSlot({ harness: this.opts.ports.harnesses.get(harnessId), log: (m) => this.log.warn(m) });
      this.slots.set(w.id, slot);
      w.session = slot;
    }
    return slot;
  }

  private onRunDone(rt: RepoRuntime, d: DispatchDecision, out: RoleRunOutput): void {
    this.gov.recordSuccess();
    if (out.run) { this.ledger.recordRun(out.run); this.noteUsage(d, out.run); }
    if (out.outcome) this.ledger.recordOutcome(out.outcome);
    const eff = out.effect;
    this.event({ level: 'info', event: `run.${eff.kind}`, repo: rt.slug, item: d.action.number, runId: out.run?.runId ?? null, action: d.action.kind, data: eff as unknown as Record<string, unknown> });
    switch (eff.kind) {
      case 'pr-opened':
        rt.memory.handled.add(d.action.number);
        this.persist.saveHandled(rt.slug, rt.memory.handled);
        this.log.ok(`${rt.slug}#${d.action.number} PR opened: ${eff.url}`);
        this.noteUnit('pr');
        break;
      case 'already-satisfied': {
        const key = qualifyItemKey(rt.slug, 'issue', d.action.number);
        rt.memory.quarantined.add(key);
        rt.memory.paroleOf.set(key, reoffend(rt.memory.paroleOf.get(key), this.now()));
        this.gov.quarantine(key);
        this.persist.saveQuarantine(rt.slug, rt.memory.quarantined, rt.memory.paroleOf);
        this.log.ok(`${rt.slug}#${d.action.number} already satisfied (${eff.criteria} criteria) — parked`);
        break;
      }
      case 'review': this.log.ok(`${rt.slug}#${d.action.number} review: ${eff.verdict}`); break;
      case 'fix': this.log.ok(`${rt.slug}#${d.action.number} ${d.role}: ${eff.changed ? `pushed ${eff.sha}` : 'no change'}`); break;
      case 'resolve': this.log.ok(`${rt.slug}#${d.action.number} resolve: ${eff.pushed ? 'pushed' : 'push failed'}${eff.regenerated.length ? `, regenerated ${eff.regenerated.join(', ')}` : ''}`); break;
      case 'triage': this.log.ok(`${rt.slug}#${d.action.number} triage: ${eff.singlePr ? 'one PR of work' : `split into ${eff.filed.map((n) => `#${n}`).join(', ')}`}`); break;
      case 'empty': this.log.warn(`${rt.slug}#${d.action.number} produced no file changes (${eff.verdict})`); break;
      case 'pushed-no-pr': this.log.err(`${rt.slug}#${d.action.number} pushed but PR open failed: ${eff.error}`); break;
      case 'settled': this.log.info(`${rt.slug}#${d.action.number} was ${eff.state.toLowerCase()} while the ${d.role} ran`); break;
      case 'skipped': this.log.warn(`${rt.slug}#${d.action.number} skipped: ${eff.reason}`); break;
    }
  }

  private onRunFailed(rt: RepoRuntime, d: DispatchDecision, e: unknown): void {
    const err = e instanceof RoleRunError ? e : new RoleRunError((e as Error)?.message ?? String(e), { kind: 'task', detail: (e as Error)?.message }, null, 'run');
    if (err.run) { this.ledger.recordRun(err.run); this.noteUsage(d, err.run); }
    this.log.err(`${d.role} ${rt.slug}#${d.action.number} failed (${err.verdict.kind}): ${err.message}`);
    const verdicts = this.gov.onFailure({ verdict: err.verdict, provider: d.provider, item: d.item, key: d.key, message: err.message, now: this.now() });
    if (err.verdict.kind === 'capacity' || err.verdict.kind === 'auth' || err.verdict.kind === 'infra' || err.verdict.kind === 'cancelled') this.capacityFailed.add(d.key);
    this.persistCounters(rt.slug);
    this.ledger.recordOutcome({
      outcomeId: randomUUID(), runId: err.run?.runId ?? null, repo: rt.slug, item: d.action.number, ts: new Date(this.now()).toISOString(),
      outcome: err.verdict.kind === 'capacity' ? 'capacity-blocked' : err.verdict.kind === 'infra' ? 'infra-failure' : 'failed', detail: err.message.slice(0, 300),
    });
    this.event({ level: 'error', event: `run.failed.${err.verdict.kind}`, repo: rt.slug, item: d.action.number, runId: err.run?.runId ?? null, action: d.action.kind, reason: err.message.slice(0, 300), data: { provider: d.provider, phase: err.phase } });
    for (const v of verdicts) this.applyVerdict(v, d.provider);
  }

  private applyVerdict(v: GovernanceVerdict, provider: string): void {
    this.event({ level: v.kind === 'charge' || v.kind === 'forgive' ? 'info' : 'warn', event: `governance.${v.kind}`, data: v as unknown as Record<string, unknown> });
    switch (v.kind) {
      case 'pause-provider':
        this.opts.ports.harnesses.quotaFor(v.provider)?.markExhausted(v.until, v.reason);
        this.log.warn(`${v.provider}: capacity — paused until ${new Date(v.until).toISOString()} (${v.reason})`);
        break;
      case 'halt-provider':
        this.log.err(`${v.provider}: lane HALTED — ${v.detail}. Fix the login, then clear the halt.`);
        break;
      case 'pause-dispatch':
        this.log.warn(`dispatch paused until ${new Date(v.until).toISOString()} — ${v.streak} infra failures in a row`);
        break;
      case 'standdown':
        this.log.err(`crash burst (${v.count}× "${v.signature}") — standing down until ${new Date(v.until).toISOString()}`);
        void this.reporter.file(killReport(`crash burst on ${provider}: ${v.signature}`, []));
        break;
      default:
        break;
    }
  }

  private noteUsage(d: DispatchDecision, run: RunRecord): void {
    const e = [...this.inFlight.values()].find((x) => x.decision.key === d.key);
    const u = { inputTokens: run.inputTokens, outputTokens: run.outputTokens, cacheReadInputTokens: run.cacheReadInputTokens, cacheCreationInputTokens: run.cacheCreationInputTokens };
    this.lastUsage.set(e?.workerId ?? d.key, { tokens: tokensProcessed(u), cacheHitPct: cacheHitPct(u) });
    // The run's spend moves from the live bucket to a committed sample, dated
    // when it landed, so it ages out of the window on its own.
    this.rate.get(d.provider)?.commit(run.runId, {
      at: Date.parse(run.endedAt) || this.now(),
      tokens: billedTokens({ ...u, reasoningTokens: run.reasoningTokens }),
      usd: run.fidelity === 'exact' ? run.estimatedCostUsd : 0,
    });
  }

  private noteUnit(unit: 'pr' | 'merge'): void {
    const { spent, state } = noteCompletion(unit, this.testRunPath());
    if (state) this.log.info(`bounded run ${state.done}/${state.limit} ${state.unit}s`);
    if (spent) this.log.ok('bounded run budget spent — no new work will start');
  }

  private refreshTokens(): void {
    for (const e of this.inFlight.values()) if (e.usage) this.lastUsage.set(e.workerId, { tokens: tokensProcessed(e.usage), cacheHitPct: cacheHitPct(e.usage) });
  }

  // ---- lifecycle ------------------------------------------------------------------------------

  private async killAndReport(reason: string, wedged: string[]): Promise<void> {
    this.log.err(`watchdog KILL: ${reason}`);
    this.event({ level: 'error', event: 'engine.kill', reason, data: { wedged } });
    await this.reporter.file(killReport(reason, wedged));
    this.stop(`watchdog: ${reason}`);
  }

  /** Stop scheduling; abort every in-flight student. */
  stop(reason = 'stopped'): void {
    if (!this.running && this.stoppedReason) return;
    this.running = false;
    this.stoppedReason = reason;
    for (const e of this.inFlight.values()) e.abort.abort();
    this.opts.ports.harnesses.killAll();
    this.event({ level: 'info', event: 'engine.stop', reason });
    this.onChange();
  }

  /** Soft stop: start nothing new, let in-flight students finish and bank their work. */
  async drain(): Promise<void> {
    this.draining = true;
    this.event({ level: 'info', event: 'engine.drain' });
    await Promise.allSettled([...this.inFlight.values()].map((e) => e.promise));
    this.stop('drained');
  }

  get busy(): number { return this.inFlight.size; }

  /** Restore a halted lane after the operator fixed the login; re-preflights. */
  async clearHalt(provider: string): Promise<boolean> {
    if (!this.gov.clearHalt(provider)) return false;
    await this.preflight(provider);
    return !this.gov.isHalted(provider);
  }

  // ---- status ---------------------------------------------------------------------------------

  snapshot(): EngineStatus {
    const cfg = this.cfg;
    const now = this.now();
    const repos: Record<string, RepoStatus> = {};
    for (const rt of this.repos.values()) {
      const actions = classify(rt.issues, rt.pulls, { autoMerge: cfg.autoMerge, triage: cfg.triage, issueAudit: cfg.issueAudit }, rt.slug);
      const openIssues = new Set(rt.issues.map((i) => i.number));
      const inFlight: InFlightRef[] = [];
      for (const [key, e] of this.inFlight) {
        if (e.decision.action.repo !== rt.slug) continue;
        inFlight.push({ key, number: e.decision.action.number, target: e.decision.action.target, role: e.decision.role, provider: e.decision.provider, harness: e.decision.harness, model: e.decision.model, runId: e.runId, startedAt: e.startedAt, studentId: e.workerId });
      }
      const ready = actions.map((a) => ({ number: a.number, title: (a.target === 'issue' ? rt.issues.find((i) => i.number === a.number)?.title : rt.pulls.find((p) => p.number === a.number)?.title) ?? '', target: a.target, kind: a.kind, reason: a.reason }));
      const readyNums = new Set(actions.filter((a) => a.target === 'issue').map((a) => a.number));
      const inPr = new Set(rt.pulls.map((p) => pullIssueNumber(p)).filter((n): n is number => n != null));
      const blocked = rt.issues
        .filter((i) => !readyNums.has(i.number) && !inPr.has(i.number) && !isParked(i.labels.map((l) => l.name)))
        .map((i) => ({ number: i.number, title: i.title, target: 'issue' as const, reason: gh.parseDeps(i.body).filter((d) => openIssues.has(Number(d.slice(1)))).length ? 'open dependencies' : 'not actionable' }));
      const attempts: Record<string, number> = {};
      for (const [k, n] of Object.entries(this.gov.watchdog.attemptSnapshot())) if (k.startsWith(`${rt.slug}:`)) attempts[k] = n;
      repos[rt.slug] = { repo: rt.slug, fetchedAt: rt.fetchedAt, error: rt.fetchError, contested: this.gov.watchdog.boardContested(rt.slug), ready, blocked, inFlight, parked: rt.parked, deadlocked: rt.deadlocked, attempts };
    }
    const students: StudentStatus[] = [];
    const busyWorkers = new Map<string, InFlightEntry>();
    for (const e of this.inFlight.values()) busyWorkers.set(e.workerId, e);
    for (const [provider, protector] of this.protectors) {
      for (const w of protector.pool) {
        const e = busyWorkers.get(w.id);
        const slot = this.slots.get(w.id);
        const last = this.lastUsage.get(w.id);
        students.push({
          id: w.id, provider, harness: e?.decision.harness ?? slot?.harness.id ?? this.opts.harnessFor[provider] ?? '', model: e?.decision.model ?? cfg.pools[provider]?.tiers[w.tier]?.model ?? '',
          tier: w.tier, role: e?.decision.role ?? w.role, state: e ? 'busy' : 'idle-warm', warm: slot?.isWarm ?? false, baseSessionId: slot?.baseId ?? null,
          repo: e?.decision.action.repo ?? w.repo ?? null, item: e?.decision.action.number ?? null, runId: e?.runId ?? null, startedAt: e?.startedAt ?? null,
          tokens: e?.usage ? tokensProcessed(e.usage) : last?.tokens ?? 0, cacheHitPct: e?.usage ? cacheHitPct(e.usage) : last?.cacheHitPct ?? 0,
        });
      }
    }
    const providers: EngineStatus['providers'] = {};
    const halted = this.gov.halted();
    for (const id of new Set([...cfg.provider.failoverOrder, ...Object.keys(cfg.pools)])) {
      providers[id] = {
        inFlight: [...this.inFlight.values()].filter((e) => e.decision.provider === id).length,
        cap: cfg.pools[id]?.maxConcurrent ?? 0,
        quota: this.opts.ports.harnesses.quotaFor(id)?.snapshot(now) ?? null,
        halted: halted[id] ?? null,
        rate: this.rate.get(id)?.assess(now) ?? null,
        pace: this.assessPaceFor(id, now),
      };
    }
    const pause = this.gov.dispatchPause(now);
    return {
      schema: STATUS_SCHEMA, updatedAt: new Date(now).toISOString(), pid: process.pid,
      running: this.running, stopped: !this.running && this.stoppedReason !== null, tick: this.tickCount,
      repos, students, providers,
      parallelism: { effective: this.gov.throttle.limit(), configured: this.gov.throttle.configured() },
      capacity: pause ? { pausedUntil: pause.until, reason: pause.reason } : undefined,
      boundedRun: readTestRun(this.testRunPath()) as TestRunState | null,
      ladder: this.assignments.tallies(),
      lastTick: this.lastTick,
    };
  }

  writeStatus(): void {
    try { this.persist.writeStatus(this.snapshot()); } catch (e) { this.log.err(`status write failed: ${(e as Error).message}`); }
  }
}
