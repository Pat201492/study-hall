import { spawn } from 'node:child_process';
import type { ChildLike, QuotaMonitor, QuotaObservation, QuotaSnapshot, QuotaWindow, SpawnLike } from '../contract.js';
import { NdjsonFramer, num } from '../ndjson.js';
import { treeKill } from '../proc.js';
import { resolveCodexBin } from '../adapters/codex.js';
import { BasicQuotaMonitor, type MonitorOptions } from './monitor.js';

// Codex quota reader. `codex exec --json` provably cannot carry rate limits, so
// one long-lived `codex app-server` (stdio JSON-RPC, one object per line) is
// polled for `account/rateLimits/read` and its `account/rateLimits/updated`
// notifications are merged in. Verified live on 0.154.0 (ADR-001):
//   - handshake: initialize → initialized (notification) → any method;
//   - `account/rateLimits/read` needs NO experimentalApi capability;
//   - the server OMITS "jsonrpc" on the wire and accepts requests with or
//     without it — we send it, per the JSON-RPC 2.0 spec;
//   - a free-plan account reports ONE window: primary windowDurationMins 43200
//     (30 days), secondary null. Windows are placed by duration, never by
//     position: ≈300 → fiveHour, ≈10080 → sevenDay, anything else → extra.
//   - the read spends no plan allowance (usedPercent unchanged across reads).

export interface RateLimitWindow {
  usedPercent: number;
  windowDurationMins?: number | null;
  /** Unix SECONDS. */
  resetsAt?: number | null;
}

export interface RateLimitSnapshot {
  limitId?: string | null;
  limitName?: string | null;
  normalModelSlug?: string | null;
  primary?: RateLimitWindow | null;
  secondary?: RateLimitWindow | null;
  credits?: { hasCredits: boolean; unlimited: boolean; balance?: string | null } | null;
  individualLimit?: { limit: string; remainingPercent: number; resetsAt: number; used: string } | null;
  spendControlReached?: boolean | null;
  planType?: string | null;
  rateLimitReachedType?: string | null;
}

export interface GetAccountRateLimitsResponse {
  ordinaryUsageAllowed?: boolean | null;
  rateLimits: RateLimitSnapshot;
  rateLimitsByLimitId?: Record<string, RateLimitSnapshot> | null;
  rateLimitResetCredits?: { availableCount: number; credits?: unknown[] | null } | null;
  accountId?: string | null;
  rateLimitUpsell?: unknown;
}

export const FIVE_HOUR_MINS = 300;
export const SEVEN_DAY_MINS = 10_080;

/** Within ±5%, the tolerance Codex's own TUI uses to label windows. */
function near(mins: number, target: number): boolean {
  return Math.abs(mins - target) <= target * 0.05;
}

function toWindow(w: RateLimitWindow): QuotaWindow {
  const resets = typeof w.resetsAt === 'number' && Number.isFinite(w.resetsAt) ? w.resetsAt * 1000 : 0;
  return { utilization: num(w.usedPercent) / 100, resetsAt: resets };
}

/** A readable key for a window that is neither 5 h nor 7 d: 43200 → "30d", 1440 → "1d", 120 → "2h", 90 → "90min". */
export function windowLabel(mins: number): string {
  if (mins > 0 && mins % 1440 === 0) return `${mins / 1440}d`;
  if (mins > 0 && mins % 60 === 0) return `${mins / 60}h`;
  return `${mins}min`;
}

/** Where a window belongs, judged by its duration (never by primary/secondary position). */
export function windowSlot(mins: number | null | undefined, position: 'primary' | 'secondary'): { slot: 'fiveHour' | 'sevenDay' } | { extra: string } {
  if (typeof mins !== 'number' || !Number.isFinite(mins)) return { extra: position };
  if (near(mins, FIVE_HOUR_MINS)) return { slot: 'fiveHour' };
  if (near(mins, SEVEN_DAY_MINS)) return { slot: 'sevenDay' };
  return { extra: windowLabel(mins) };
}

/** Pure: GetAccountRateLimitsResponse → QuotaObservation. */
export function mapRateLimits(resp: GetAccountRateLimitsResponse, observedAt: number): QuotaObservation {
  const snap = resp.rateLimits ?? {};
  const obs: QuotaObservation = { provider: 'openai', observedAt, source: 'app-server' };
  const allowed = resp.ordinaryUsageAllowed;
  if (allowed === true || allowed === false) obs.allowed = allowed;
  const extra: Record<string, QuotaWindow> = {};
  const place = (w: RateLimitWindow | null | undefined, position: 'primary' | 'secondary', prefix = ''): void => {
    if (!w) return;
    const where = windowSlot(w.windowDurationMins, position);
    if ('slot' in where && !prefix) obs[where.slot] = toWindow(w);
    else extra[`${prefix}${'slot' in where ? where.slot : where.extra}`] = toWindow(w);
  };
  place(snap.primary, 'primary');
  place(snap.secondary, 'secondary');
  // Other metered buckets (e.g. a model with its own limit) ride along in extra.
  for (const [id, s] of Object.entries(resp.rateLimitsByLimitId ?? {})) {
    if (!s || id === snap.limitId) continue;
    place(s.primary, 'primary', `${id}:`);
    place(s.secondary, 'secondary', `${id}:`);
  }
  if (Object.keys(extra).length) obs.extra = extra;
  if (snap.rateLimitReachedType) obs.limitingWindow = snap.rateLimitReachedType;
  const detail: string[] = [];
  if (snap.planType) detail.push(`plan=${snap.planType}`);
  if (snap.limitId) detail.push(`limit=${snap.limitId}`);
  if (snap.credits?.hasCredits) detail.push(snap.credits.unlimited ? 'credits=unlimited' : `credits=${snap.credits.balance ?? 'yes'}`);
  if (snap.spendControlReached) detail.push('spend-control-reached');
  if (allowed == null) detail.push('ordinaryUsageAllowed=unknown');
  if (detail.length) obs.detail = detail.join(' ');
  return obs;
}

function mergeSnapshot(prev: RateLimitSnapshot | undefined, update: RateLimitSnapshot): RateLimitSnapshot {
  const out: RateLimitSnapshot = { ...(prev ?? {}) };
  for (const [k, v] of Object.entries(update)) {
    // "Nullable account metadata may be unavailable in a rolling update and
    // does not clear a previously observed value."
    if (v !== null && v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

/** Pure: fold an `account/rateLimits/updated` snapshot into the last read. */
export function mergeRateLimitUpdate(prev: GetAccountRateLimitsResponse | null, update: RateLimitSnapshot): GetAccountRateLimitsResponse {
  const base: GetAccountRateLimitsResponse = prev ?? { rateLimits: {} };
  const mainId = base.rateLimits?.limitId ?? null;
  const sameBucket = !update.limitId || !mainId || update.limitId === mainId;
  const merged: GetAccountRateLimitsResponse = { ...base, rateLimits: sameBucket ? mergeSnapshot(base.rateLimits, update) : base.rateLimits };
  const id = update.limitId ?? mainId;
  if (id) {
    merged.rateLimitsByLimitId = { ...(base.rateLimitsByLimitId ?? {}), [id]: mergeSnapshot(base.rateLimitsByLimitId?.[id], update) };
  }
  return merged;
}

export interface CodexAppServerOptions {
  /** Configured binary; resolved through resolveCodexBin by default. */
  bin?: string;
  /** Poll interval for account/rateLimits/read. Default 60 s. */
  pollMs?: number;
  spawnFn?: SpawnLike;
  setIntervalFn?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearIntervalFn?: (t: NodeJS.Timeout) => void;
  now?: () => number;
  monitor?: MonitorOptions;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** How long a JSON-RPC request may wait for its response. Default 20 s. */
  requestTimeoutMs?: number;
  clientInfo?: { name: string; title?: string | null; version: string };
}

interface Pending { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }

/**
 * QuotaMonitor for the `openai` provider, wrapping a BasicQuotaMonitor and
 * owning one `codex app-server` process. A failed read (not logged in, server
 * gone) is kept as a DEGRADED observation: the snapshot reports UNKNOWN with
 * the reason, and never AVAILABLE on the strength of an old percentage.
 */
export class CodexAppServerQuota implements QuotaMonitor {
  readonly provider = 'openai';
  private readonly inner: BasicQuotaMonitor;
  private readonly subs = new Set<(s: QuotaSnapshot) => void>();
  private readonly pending = new Map<number, Pending>();
  private readonly framer = new NdjsonFramer();
  private readonly now: () => number;
  private child: ChildLike | null = null;
  private timer: NodeJS.Timeout | null = null;
  private nextId = 1;
  private last: GetAccountRateLimitsResponse | null = null;
  private degraded: QuotaObservation | null = null;
  private stopping = false;
  private stderrTail = '';

  constructor(private readonly opts: CodexAppServerOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.inner = new BasicQuotaMonitor('openai', { ...(opts.monitor ?? {}), now: this.now });
    this.inner.subscribe((s) => this.emit(this.decorate(s)));
  }

  /** The most recent full `account/rateLimits/read` response (merged with updates). */
  get lastResponse(): GetAccountRateLimitsResponse | null { return this.last; }
  get running(): boolean { return this.child !== null; }

  snapshot(now: number = this.now()): QuotaSnapshot {
    return this.decorate(this.inner.snapshot(now));
  }

  observe(observation: QuotaObservation): void {
    this.degraded = null;
    this.inner.observe(observation);
  }

  markExhausted(resetAt?: number, detail?: string): void {
    this.inner.markExhausted(resetAt, detail);
  }

  subscribe(fn: (snapshot: QuotaSnapshot) => void): () => void {
    this.subs.add(fn);
    return () => { this.subs.delete(fn); };
  }

  async start(): Promise<void> {
    if (this.child) return;
    this.stopping = false;
    const spawnFn = this.opts.spawnFn ?? spawn;
    const baseEnv = this.opts.env ?? process.env;
    const bin = this.opts.bin ?? resolveCodexBin('codex', baseEnv).path;
    const env: NodeJS.ProcessEnv = { ...baseEnv };
    delete env.CODEX_API_KEY;
    delete env.OPENAI_API_KEY;
    const child = spawnFn(bin, ['app-server'], {
      cwd: this.opts.cwd, shell: false, windowsHide: true, env, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    child.stdout?.on('data', (b) => {
      for (const m of this.framer.push(String(b))) this.onMessage(m);
    });
    child.stderr?.on('data', (b) => { this.stderrTail = (this.stderrTail + String(b)).slice(-400); });
    child.on('error', (e) => this.onExit(null, e.message));
    child.on('close', (code) => this.onExit(code));

    await this.request('initialize', {
      clientInfo: this.opts.clientInfo ?? { name: 'study-hall', title: 'study-hall', version: '0.1.0' },
    });
    this.notify('initialized', {});
    await this.poll();
    const setIntervalFn = this.opts.setIntervalFn ?? setInterval;
    this.timer = setIntervalFn(() => { void this.poll(); }, this.opts.pollMs ?? 60_000);
    (this.timer as { unref?: () => void } | null)?.unref?.();
  }

  stop(): void {
    this.stopping = true;
    this.clearTimer();
    const child = this.child;
    this.child = null;
    this.rejectPending(new Error('codex app-server stopped'));
    if (child) treeKill(child);
  }

  /** One `account/rateLimits/read`; a failure degrades the snapshot to UNKNOWN + reason. */
  async poll(): Promise<void> {
    if (!this.child) return;
    try {
      const r = await this.request('account/rateLimits/read', {}) as GetAccountRateLimitsResponse;
      this.last = r;
      this.observe(mapRateLimits(r, this.now()));
    } catch (e) {
      this.degrade(`account/rateLimits/read failed: ${(e as Error).message}`);
    }
  }

  private decorate(s: QuotaSnapshot): QuotaSnapshot {
    if (!this.degraded) return s;
    if (s.state === 'exhausted') return { ...s, observation: this.degraded };
    return { ...s, state: 'unknown', observation: this.degraded, ageMs: Math.max(0, this.now() - this.degraded.observedAt) };
  }

  private degrade(detail: string): void {
    this.degraded = { provider: 'openai', observedAt: this.now(), source: 'app-server', allowed: null, detail };
    this.emit(this.snapshot());
  }

  private emit(s: QuotaSnapshot): void {
    for (const fn of this.subs) {
      try { fn(s); } catch { /* a subscriber must not break the monitor */ }
    }
  }

  private clearTimer(): void {
    if (this.timer) {
      (this.opts.clearIntervalFn ?? clearInterval)(this.timer);
      this.timer = null;
    }
  }

  private rejectPending(err: Error): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.reject(err);
    }
  }

  private onExit(code: number | null, why?: string): void {
    if (!this.child) return;
    this.child = null;
    this.clearTimer();
    const reason = `codex app-server exited (${why ?? code})${this.stderrTail ? `: ${this.stderrTail.trim()}` : ''}`;
    this.rejectPending(new Error(reason));
    if (!this.stopping) this.degrade(reason);
  }

  private send(msg: Record<string, unknown>): void {
    this.child?.stdin?.write(JSON.stringify(msg) + '\n');
  }

  private notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  private request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      if (!this.child) { reject(new Error('codex app-server is not running')); return; }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, this.opts.requestTimeoutMs ?? 20_000);
      (timer as { unref?: () => void }).unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.send(params === undefined ? { jsonrpc: '2.0', id, method } : { jsonrpc: '2.0', id, method, params });
    });
  }

  private onMessage(m: Record<string, unknown>): void {
    const hasId = typeof m.id === 'number' || typeof m.id === 'string';
    if (hasId && ('result' in m || 'error' in m)) {
      const p = this.pending.get(Number(m.id));
      if (!p) return;
      this.pending.delete(Number(m.id));
      clearTimeout(p.timer);
      if ('error' in m) {
        const err = (m.error ?? {}) as { code?: number; message?: string };
        p.reject(new Error(err.message ?? `JSON-RPC error ${err.code ?? ''}`.trim()));
      } else {
        p.resolve(m.result);
      }
      return;
    }
    if (m.method === 'account/rateLimits/updated') {
      const params = (m.params ?? {}) as { rateLimits?: RateLimitSnapshot };
      if (params.rateLimits) {
        this.last = mergeRateLimitUpdate(this.last, params.rateLimits);
        this.observe(mapRateLimits(this.last, this.now()));
      }
    }
    // Other notifications (remoteControl/status/changed, …) and server→client
    // requests are irrelevant to an account-only connection and are ignored.
  }
}
