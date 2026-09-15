import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import type { Ledger } from '@study-hall/harness';
import { ManagedProcess } from '@study-hall/core/managedProcess';
import { Persistence } from '@study-hall/core/engine/persistence';
import type { EngineStatus, RepoStatus } from '@study-hall/core/engine/status';
import { classify, isParked, parkedItems, deadlockedPulls, pullIssueNumber, PARKED_LABELS } from '@study-hall/core/classify';
import { fetchIssues, listOpenPulls, removeLabel, parseDeps, repoSlug, type RawIssue, type OpenPull } from '@study-hall/core/github';
import { loadEngineConfig } from '@study-hall/core/config';
import { requestDrain, clearDrain, drainRequested } from '@study-hall/core/drain';
import type { Router } from './router.js';
import { configPath, mutateConfig, type StudyHallConfig } from './config.js';

// Engine ownership and the board/pool views.
//
// The dashboard owns the engine as a ManagedProcess child (vendored tsx via
// `node --import tsx`, never npx) and reads its status.json for the Boards and
// Pool tabs. Boards are ALSO refreshed live from GitHub so a stopped engine
// still shows a truthful board; the engine's own view (in-flight, attempts,
// contested) is merged in when the snapshot is fresh.

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');

export interface BoardGitHub {
  fetchIssues(repo: string): Promise<RawIssue[]>;
  listOpenPulls(repo: string): Promise<OpenPull[]>;
  removeLabel(repo: string, n: number, label: string, kind: 'issue' | 'pr'): Promise<void>;
}

export const realBoardGitHub: BoardGitHub = {
  fetchIssues, listOpenPulls: (r) => listOpenPulls(r), removeLabel: (r, n, l, k) => removeLabel(r, n, l, k),
};

export interface EngineDeps {
  cfg: () => StudyHallConfig;
  ledger: Ledger;
  github?: BoardGitHub;
  /** Override the spawned command (tests use a sleeper). */
  engineCommand?: { command: string; args: string[] };
  now?: () => number;
}

export interface EngineView {
  running: boolean;
  pid: number | null;
  /** True when status.json says the engine process wrote it recently. */
  live: boolean;
  status: EngineStatus | null;
  drainRequested: boolean;
  logTail: string[];
}

export interface BoardView extends Omit<RepoStatus, 'attempts'> {
  counts: { issues: number; pulls: number };
  attempts: Record<string, number>;
  /** Whether the engine's snapshot (in-flight, attempts) was merged in. */
  fromEngine: boolean;
}

const STALE_MS = 90_000;

export function mountEngine(router: Router, deps: EngineDeps): { stop: () => void; view: () => EngineView } {
  const now = deps.now ?? Date.now;
  const hub = deps.github ?? realBoardGitHub;
  const stateDir = (): string => deps.cfg().stateDir;
  const persistence = (): Persistence => new Persistence({ stateDir: stateDir() });
  const drainFlag = (): string => join(stateDir(), 'drain.flag');
  const proc = new ManagedProcess({ name: 'engine', logFile: join(stateDir(), 'engine.log') });

  const readStatus = (): EngineStatus | null => persistence().readStatus();
  const isLive = (s: EngineStatus | null): boolean => !!s && !s.stopped && now() - Date.parse(s.updatedAt) < STALE_MS;

  const view = (): EngineView => {
    const status = readStatus();
    return { running: proc.isRunning(), pid: proc.isRunning() ? (status?.pid ?? null) : null, live: proc.isRunning() && isLive(status), status, drainRequested: drainRequested(drainFlag()), logTail: proc.logLines(40) };
  };

  const start = (): { ok: boolean; msg: string } => {
    if (proc.isRunning()) return { ok: false, msg: 'engine already running — stop it first' };
    const c = deps.cfg();
    if (!c.repos.length) return { ok: false, msg: 'no repos configured — add one in Settings first' };
    clearDrain(drainFlag());
    const cmd = deps.engineCommand ?? { command: process.execPath, args: ['--import', 'tsx', join('packages', 'core', 'src', 'index.ts'), '--live'] };
    const ok = proc.start(cmd.command, cmd.args, {
      cwd: REPO_ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, STUDY_HALL_CONFIG: resolve(configPath()), STUDY_HALL_STATE_DIR: c.stateDir },
    });
    deps.ledger.recordEvent({ ts: new Date(now()).toISOString(), level: 'info', event: 'engine.start-requested', reason: ok ? 'spawned' : 'already running' });
    return ok ? { ok: true, msg: 'engine starting' } : { ok: false, msg: 'engine already running' };
  };

  router.get('/api/engine', () => view());
  router.get('/api/engine/log', (ctx) => ({ lines: proc.logLines(ctx.query.get('n') ? Number(ctx.query.get('n')) : 200) }));
  router.post('/api/engine/start', () => start());
  router.post('/api/engine/stop', () => {
    const stopped = proc.stop();
    clearDrain(drainFlag());
    deps.ledger.recordEvent({ ts: new Date(now()).toISOString(), level: 'info', event: 'engine.stop-requested', reason: stopped ? 'tree-killed' : 'not running' });
    return stopped ? { ok: true, msg: 'engine stopped (students killed)' } : { ok: false, msg: 'engine was not running' };
  });
  router.post('/api/engine/drain', () => {
    if (!proc.isRunning()) return { ok: false, msg: 'engine was not running' };
    requestDrain(drainFlag());
    deps.ledger.recordEvent({ ts: new Date(now()).toISOString(), level: 'info', event: 'engine.drain-requested' });
    return { ok: true, msg: 'drain requested — in-flight work finishes, nothing new starts' };
  });

  router.post('/api/settings/bounded-run', (ctx) => {
    const { n, unit, unbounded } = ctx.body as { n?: unknown; unit?: unknown; unbounded?: unknown };
    const count = Number(n);
    if (!Number.isInteger(count) || count < 0) throw new Error('n must be a non-negative integer');
    if (unit !== undefined && unit !== 'pr' && unit !== 'merge') throw new Error('unit must be pr | merge');
    if (count === 0 && unbounded !== true) throw new Error('n=0 means unbounded and needs unbounded:true');
    mutateConfig(configPath(), (raw) => {
      raw.boundedRun = { n: count, unit: unit ?? 'pr', ...(count === 0 ? { unbounded: true } : {}) };
    });
    deps.ledger.recordEvent({ ts: new Date(now()).toISOString(), level: 'info', event: 'settings.bounded-run', reason: count === 0 ? 'UNBOUNDED' : `${count} ${unit ?? 'pr'}` });
    return { ok: true, boundedRun: loadEngineConfig(configPath()).boundedRun, note: 'takes effect on the next engine start' };
  });

  // ---- boards ------------------------------------------------------------------------
  const boardView = async (repo: string, status: EngineStatus | null, live: boolean): Promise<BoardView> => {
    const slug = repoSlug(repo);
    const fromEngine = live && !!status?.repos[slug];
    const es = status?.repos[slug];
    const ecfg = loadEngineConfig(configPath());
    try {
      const [issues, pulls] = await Promise.all([hub.fetchIssues(slug), hub.listOpenPulls(slug)]);
      const actions = classify(issues, pulls, { autoMerge: ecfg.autoMerge, triage: ecfg.triage, issueAudit: ecfg.issueAudit }, slug);
      const title = (target: 'issue' | 'pr', n: number): string => (target === 'issue' ? issues.find((i) => i.number === n)?.title : pulls.find((p) => p.number === n)?.title) ?? '';
      const ready = actions.map((a) => ({ number: a.number, title: title(a.target, a.number), target: a.target, kind: a.kind, reason: a.reason }));
      const readyNums = new Set(actions.filter((a) => a.target === 'issue').map((a) => a.number));
      const inPr = new Set(pulls.map((p) => pullIssueNumber(p)).filter((n): n is number => n != null));
      const open = new Set(issues.map((i) => i.number));
      const blocked = issues.filter((i) => !readyNums.has(i.number) && !inPr.has(i.number) && !isParked(i.labels.map((l) => l.name)))
        .map((i) => ({ number: i.number, title: i.title, target: 'issue' as const, reason: parseDeps(i.body).some((d) => open.has(Number(d.slice(1)))) ? 'open dependencies' : 'not actionable' }));
      const attempts = es?.attempts ?? {};
      return {
        repo: slug, fetchedAt: new Date(now()).toISOString(), contested: fromEngine ? es!.contested : false,
        ready, blocked, inFlight: fromEngine ? es!.inFlight : [],
        parked: parkedItems(issues, pulls).map((p) => ({ repo: slug, number: p.number, target: p.target, title: p.title, labels: p.labels, attempts: attempts[`${slug}:${p.target}-${p.number}`] ?? 0 })),
        deadlocked: deadlockedPulls(pulls).map((p) => ({ repo: slug, number: p.number, title: p.title, labels: p.labels.filter((l) => l === 'reviewed-ok' || isParked([l])) })),
        attempts, counts: { issues: issues.length, pulls: pulls.length }, fromEngine,
      };
    } catch (e) {
      // Keep the engine's last view when we have one; never blank the other boards.
      const base: RepoStatus = es ?? { repo: slug, contested: false, ready: [], blocked: [], inFlight: [], parked: [], deadlocked: [], attempts: {} };
      return { ...base, error: (e as Error).message, counts: { issues: 0, pulls: 0 }, fromEngine };
    }
  };

  router.get('/api/boards', async () => {
    const v = view();
    const repos = await Promise.all(deps.cfg().repos.map((r) => boardView(r, v.status, v.live)));
    return { repos, engine: { running: v.running, live: v.live, tick: v.status?.tick ?? 0, updatedAt: v.status?.updatedAt ?? null, boundedRun: v.status?.boundedRun ?? null, lastTick: v.status?.lastTick ?? null } };
  });

  router.post('/api/board/unpark', async (ctx) => {
    const { repo, number, target, label } = ctx.body as { repo?: unknown; number?: unknown; target?: unknown; label?: unknown };
    if (typeof repo !== 'string' || !Number.isInteger(number) || (target !== 'issue' && target !== 'pr')) throw new Error('repo, number and target (issue|pr) are required');
    if (typeof label !== 'string' || !PARKED_LABELS.includes(label)) throw new Error(`label must be one of ${PARKED_LABELS.join(', ')}`);
    await hub.removeLabel(repoSlug(repo), number as number, label, target);
    deps.ledger.recordEvent({ ts: new Date(now()).toISOString(), level: 'info', event: 'board.unpark', repo: repoSlug(repo), item: number as number, reason: label });
    return { ok: true, removed: label };
  });

  // ---- pool -----------------------------------------------------------------------------
  router.get('/api/pool', () => {
    const v = view();
    const s = v.status;
    return {
      engine: { running: v.running, live: v.live, updatedAt: s?.updatedAt ?? null, tick: s?.tick ?? 0 },
      students: v.live ? s!.students : [],
      providers: s?.providers ?? {},
      parallelism: s?.parallelism ?? null,
      capacity: s?.capacity ?? null,
      // Durable: the ledger's assignment rows survive restarts; process memory does not.
      ladder: flatTallies(deps.ledger.reader.ladderTallies()),
      ladderSession: v.live ? s!.ladder : null,
    };
  });

  const stop = (): void => { proc.kill(); };
  process.once('exit', stop);
  return { stop, view };
}

/** The ledger reader nests counts; the engine's AssignmentLog is flat. One shape for the tab,
 *  with the engine's definition of warm reuse (reused over PLACED — waits placed nothing). */
export function flatTallies(t: { counts: Record<string, number>; total: number }): { exact: number; rerole: number; crossRepo: number; spawn: number; wait: number; total: number; warmReuseRate: number } {
  const c = { exact: 0, rerole: 0, crossRepo: 0, spawn: 0, wait: 0, ...t.counts };
  const placed = c.exact + c.rerole + c.crossRepo + c.spawn;
  return { ...c, total: t.total, warmReuseRate: placed ? (c.exact + c.rerole + c.crossRepo) / placed : 0 };
}

export function engineLogPath(cfg: StudyHallConfig): string {
  return join(cfg.stateDir, 'engine.log');
}

export function repoRootHasEngine(): boolean {
  return existsSync(join(REPO_ROOT, 'packages', 'core', 'src', 'index.ts'));
}
