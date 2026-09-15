import { DatabaseSync, type StatementSync } from 'node:sqlite';
import {
  ASSIGNMENT_COLUMNS, EVENT_COLUMNS, OUTCOME_COLUMNS, QUOTA_COLUMNS, RUN_COLUMNS,
} from './schema.js';
import type {
  AssignmentKind, AssignmentRecord, EventLevel, EventRecord, OutcomeKind, OutcomeRecord, QuotaRecord, RunRecord,
} from './types.js';

// Read-only query API over the ledger. Every query is a prepared statement,
// cached by its SQL text, so the dashboard's 2-second poll costs a bind and a
// step rather than a parse.
//
// Two rules that keep the numbers honest, applied here rather than in views:
//  - DOLLARS are summed over 'exact' fidelity rows only. A 'partial' row's $ is
//    a floor, not a measurement (no cache split → cache reads priced as fresh
//    input, ~10x too high on a warm session), so it is never pooled.
//  - TOKENS are summed over every fidelity, and 'missing' rows count in every
//    denominator: dropping them biases $/AC downward, flattering whatever
//    reported worst.

type Bindable = null | number | string;
type Row = Record<string, unknown>;

export type TimeLike = string | number | Date;

/** Normalise a since/until to the ISO form `ts` columns hold (UTC, 'Z'). */
export function toIso(t: TimeLike): string {
  if (t instanceof Date) return t.toISOString();
  if (typeof t === 'number') return new Date(t).toISOString();
  return t;
}

export interface RunFilter {
  repo?: string;
  provider?: string;
  harness?: string;
  role?: string;
  item?: number;
  /** Runs whose ITEM has an outcome of this kind (a 'merged' outcome is
   *  item-level, so this is the only join that makes sense). */
  outcome?: OutcomeKind;
  /** Inclusive lower bound on `ts`. */
  since?: TimeLike;
  /** Exclusive upper bound on `ts` (half-open ranges tile without overlap). */
  until?: TimeLike;
  /** Page size, 1..1000, default 50. */
  limit?: number;
  /** Opaque; pass back the previous page's `nextCursor`. */
  cursor?: string | null;
}

export interface RunPage {
  rows: RunRecord[];
  /** Null on the last page. */
  nextCursor: string | null;
}

export interface RunDetail {
  run: RunRecord;
  /** Every outcome for the run's item (the run's own and item-level ones). */
  outcomes: OutcomeRecord[];
  /** Events tagged with the runId, plus item events inside the run's window. */
  events: EventRecord[];
}

export interface AttributionFilter {
  repo?: string;
  since?: TimeLike;
  until?: TimeLike;
}

export interface AttributionRow {
  role: string;
  tier: string | null;
  provider: string;
  count: number;
  /** How many of `count` back the dollar figure. */
  exactCount: number;
  /** Rows priced off a placeholder table entry (basis 'estimate'): flag the $. */
  estimateBasisCount: number;
  /** input + output + cacheRead, all fidelities. */
  sumTokensProcessed: number;
  /** Exact fidelity only. */
  sumEstimatedCostUsd: number;
  sumCacheRead: number;
  sumInput: number;
  /** Mean over rows that recorded turns (NULL rows are ignored). */
  avgTurns: number | null;
}

export interface CostPerAcCell {
  /** Exact-fidelity $ over ACs; null when no AC was priced. */
  usdPerAC: number | null;
  /** tokensProcessed over ACs, every fidelity; null when no AC was priced. */
  tokensPerAC: number | null;
  mergedItems: number;
  /** Every run on those items: all roles, all attempts, abandoned included. */
  runs: number;
  exactRuns: number;
  sumUsd: number;
  sumTokens: number;
  acCount: number;
}

export interface CostPerAcResult {
  /** Per provider: numerator = that provider's runs on merged items, denominator
   *  = ACs of the merged items it ran on. */
  byProvider: Record<string, CostPerAcCell>;
  /** All providers pooled over the whole merged cohort. */
  total: CostPerAcCell;
  /** Merged items that entered the denominator. */
  mergedItems: number[];
  /** Merged items with no positive `acCounts` entry — excluded from BOTH sides
   *  so an unknown denominator cannot inflate the ratio. */
  unpricedItems: number[];
}

export interface EventFilter {
  since?: TimeLike;
  until?: TimeLike;
  level?: EventLevel;
  repo?: string;
  item?: number;
  runId?: string;
  limit?: number;
}

export interface LadderTallies {
  counts: Record<AssignmentKind, number>;
  total: number;
  /** exact + rerole + crossRepo over total: the warm-pool KPI. */
  warmReuseRate: number | null;
}

const RUN_SELECT = `SELECT id, ${RUN_COLUMNS.join(', ')} FROM runs`;
const OUTCOME_SELECT = `SELECT ${OUTCOME_COLUMNS.join(', ')} FROM outcomes`;
const EVENT_SELECT = `SELECT ${EVENT_COLUMNS.join(', ')} FROM events`;
const QUOTA_SELECT = `SELECT ${QUOTA_COLUMNS.join(', ')} FROM quota_observations`;
const ASSIGNMENT_SELECT = `SELECT ${ASSIGNMENT_COLUMNS.join(', ')} FROM assignments`;

const clampLimit = (n: number | undefined, dflt: number): number =>
  Math.min(1000, Math.max(1, Math.floor(n ?? dflt)));

function parseJson<T>(v: unknown): T | null {
  if (typeof v !== 'string') return null;
  try { return JSON.parse(v) as T; } catch { return null; }
}

function pick(columns: readonly string[], row: Row): Row {
  const out: Row = {};
  for (const c of columns) out[c] = row[c] ?? null;
  return out;
}

export function rowToRun(row: Row): RunRecord {
  const r = pick(RUN_COLUMNS, row);
  r.toolAllowlist = parseJson<string[]>(row.toolAllowlist);
  r.toolAllowlistEnforced = row.toolAllowlistEnforced == null ? null : row.toolAllowlistEnforced === 1;
  return r as unknown as RunRecord;
}

export function rowToOutcome(row: Row): OutcomeRecord {
  return pick(OUTCOME_COLUMNS, row) as unknown as OutcomeRecord;
}

export function rowToEvent(row: Row): EventRecord {
  const r = pick(EVENT_COLUMNS, row);
  r.data = parseJson<Record<string, unknown>>(row.data);
  return r as unknown as EventRecord;
}

export function rowToQuota(row: Row): QuotaRecord {
  const raw = parseJson<QuotaRecord>(row.raw);
  if (raw) return raw;
  // A row without `raw` (should not happen) is rebuilt from the flat columns.
  const rec: QuotaRecord = {
    ts: String(row.ts),
    provider: String(row.provider),
    observedAt: Number(row.observedAt),
    source: row.source as QuotaRecord['source'],
  };
  if (row.fiveHourUtilization != null) {
    rec.fiveHour = { utilization: Number(row.fiveHourUtilization), resetsAt: Number(row.fiveHourResetsAt) };
  }
  if (row.sevenDayUtilization != null) {
    rec.sevenDay = { utilization: Number(row.sevenDayUtilization), resetsAt: Number(row.sevenDayResetsAt) };
  }
  const extra = parseJson<QuotaRecord['extra']>(row.extra);
  if (extra) rec.extra = extra;
  if (row.allowed != null) rec.allowed = row.allowed === 1;
  if (row.limitingWindow != null) rec.limitingWindow = String(row.limitingWindow);
  if (row.detail != null) rec.detail = String(row.detail);
  return rec;
}

const emptyCell = (): CostPerAcCell => ({
  usdPerAC: null, tokensPerAC: null, mergedItems: 0, runs: 0, exactRuns: 0, sumUsd: 0, sumTokens: 0, acCount: 0,
});

/**
 * Open `<dir>/ledger.db` read-only for a process that only queries (the
 * dashboard). WAL lets it read while the engine writes. The file must already
 * exist — a reader never creates a ledger.
 */
export function openLedgerReader(dir: string): LedgerReader {
  const root = dir.replace(/\\/g, '/').replace(/\/+$/, '');
  const db = new DatabaseSync(`${root}/ledger.db`, { readOnly: true });
  db.exec('PRAGMA busy_timeout = 5000');
  return new LedgerReader(db, true);
}

export class LedgerReader {
  private readonly stmts = new Map<string, StatementSync>();

  constructor(readonly db: DatabaseSync, private readonly ownsDb = false) {}

  /** Newest first, keyset-paged on the row id so a page never shifts under a
   *  concurrent append. */
  listRuns(filter: RunFilter = {}): RunPage {
    const where: string[] = [];
    const p: Record<string, Bindable> = {};
    if (filter.repo) { where.push('repo = :repo'); p.repo = filter.repo; }
    if (filter.provider) { where.push('provider = :provider'); p.provider = filter.provider; }
    if (filter.harness) { where.push('harness = :harness'); p.harness = filter.harness; }
    if (filter.role) { where.push('role = :role'); p.role = filter.role; }
    if (filter.item != null) { where.push('item = :item'); p.item = filter.item; }
    if (filter.since != null) { where.push('ts >= :since'); p.since = toIso(filter.since); }
    if (filter.until != null) { where.push('ts < :until'); p.until = toIso(filter.until); }
    if (filter.outcome) {
      where.push('EXISTS (SELECT 1 FROM outcomes o WHERE o.repo = runs.repo AND o.item = runs.item AND o.outcome = :outcome)');
      p.outcome = filter.outcome;
    }
    if (filter.cursor) { where.push('id < :cursor'); p.cursor = Number(filter.cursor); }
    const limit = clampLimit(filter.limit, 50);
    p.limit = limit + 1;
    const sql = `${RUN_SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT :limit`;
    const rows = this.stmt(sql).all(p) as Row[];
    const page = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? String(page[page.length - 1]!.id) : null;
    return { rows: page.map(rowToRun), nextCursor };
  }

  runDetail(runId: string): RunDetail | undefined {
    const row = this.stmt(`${RUN_SELECT} WHERE runId = :runId`).get({ runId }) as Row | undefined;
    if (!row) return undefined;
    const run = rowToRun(row);
    const outcomes = (this.stmt(
      `${OUTCOME_SELECT} WHERE runId = :runId OR (repo = :repo AND item = :item) ORDER BY ts ASC, id ASC`,
    ).all({ runId, repo: run.repo, item: run.item }) as Row[]).map(rowToOutcome);
    const events = (this.stmt(
      `${EVENT_SELECT} WHERE runId = :runId OR (repo = :repo AND item = :item AND ts >= :startedAt AND ts <= :endedAt) ORDER BY ts ASC, id ASC`,
    ).all({ runId, repo: run.repo, item: run.item, startedAt: run.startedAt, endedAt: run.endedAt }) as Row[]).map(rowToEvent);
    return { run, outcomes, events };
  }

  /** The role x tier x provider matrix the Pool screen shows. */
  attribution(filter: AttributionFilter = {}): AttributionRow[] {
    const where: string[] = [];
    const p: Record<string, Bindable> = {};
    if (filter.repo) { where.push('repo = :repo'); p.repo = filter.repo; }
    if (filter.since != null) { where.push('ts >= :since'); p.since = toIso(filter.since); }
    if (filter.until != null) { where.push('ts < :until'); p.until = toIso(filter.until); }
    const sql = `SELECT role, tier, provider,
        COUNT(*) AS count,
        SUM(CASE WHEN fidelity = 'exact' THEN 1 ELSE 0 END) AS exactCount,
        SUM(CASE WHEN costBasis = 'estimate' THEN 1 ELSE 0 END) AS estimateBasisCount,
        SUM(inputTokens + outputTokens + cacheReadInputTokens) AS sumTokensProcessed,
        SUM(CASE WHEN fidelity = 'exact' THEN estimatedCostUsd ELSE 0 END) AS sumEstimatedCostUsd,
        SUM(cacheReadInputTokens) AS sumCacheRead,
        SUM(inputTokens) AS sumInput,
        AVG(turns) AS avgTurns
      FROM runs${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
      GROUP BY role, tier, provider
      ORDER BY role, tier, provider`;
    return (this.stmt(sql).all(p) as Row[]).map((r) => ({
      role: String(r.role),
      tier: r.tier == null ? null : String(r.tier),
      provider: String(r.provider),
      count: Number(r.count),
      exactCount: Number(r.exactCount),
      estimateBasisCount: Number(r.estimateBasisCount),
      sumTokensProcessed: Number(r.sumTokensProcessed),
      sumEstimatedCostUsd: Number(r.sumEstimatedCostUsd),
      sumCacheRead: Number(r.sumCacheRead),
      sumInput: Number(r.sumInput),
      avgTurns: r.avgTurns == null ? null : Number(r.avgTurns),
    }));
  }

  /**
   * The primary metric: $ per merged acceptance criterion.
   *
   * Cohort: items of `repo` with a 'merged' outcome (`since` bounds the MERGE
   * time, so a run that predates the window still counts toward the item it
   * eventually merged). Numerator: every run on those items — all roles, every
   * attempt, abandoned ones included, because the abandoned attempt was part
   * of what it cost to merge. Denominator: the frozen `acCounts` of those items.
   * Dollars use exact-fidelity rows only; tokens use every fidelity.
   */
  costPerMergedAC(args: { repo: string; since?: TimeLike; acCounts: Record<string | number, number> }): CostPerAcResult {
    const p: Record<string, Bindable> = { repo: args.repo };
    let sql = `SELECT DISTINCT item FROM outcomes WHERE repo = :repo AND outcome = 'merged'`;
    if (args.since != null) { sql += ' AND ts >= :since'; p.since = toIso(args.since); }
    const merged = (this.stmt(`${sql} ORDER BY item`).all(p) as Row[]).map((r) => Number(r.item));
    const acOf = (item: number): number => Number(args.acCounts[item] ?? args.acCounts[String(item)] ?? 0);
    const priced = merged.filter((i) => acOf(i) > 0);
    const unpricedItems = merged.filter((i) => !(acOf(i) > 0));
    const total = emptyCell();
    const byProvider: Record<string, CostPerAcCell> = {};
    if (priced.length === 0) return { byProvider, total, mergedItems: [], unpricedItems };

    const runs = this.stmt(
      `SELECT provider, item, fidelity, estimatedCostUsd,
              (inputTokens + outputTokens + cacheReadInputTokens) AS tokens
         FROM runs WHERE repo = :repo AND item IN (SELECT value FROM json_each(:items))`,
    ).all({ repo: args.repo, items: JSON.stringify(priced) }) as Row[];

    const itemsBy = new Map<string, Set<number>>();
    for (const r of runs) {
      const provider = String(r.provider);
      const cell = byProvider[provider] ??= emptyCell();
      const exact = r.fidelity === 'exact';
      const usd = exact ? Number(r.estimatedCostUsd) : 0;
      const tokens = Number(r.tokens);
      for (const c of [cell, total]) {
        c.runs += 1;
        if (exact) c.exactRuns += 1;
        c.sumUsd += usd;
        c.sumTokens += tokens;
      }
      (itemsBy.get(provider) ?? itemsBy.set(provider, new Set()).get(provider)!).add(Number(r.item));
    }
    const finish = (cell: CostPerAcCell, items: Iterable<number>): void => {
      for (const i of items) { cell.mergedItems += 1; cell.acCount += acOf(i); }
      cell.usdPerAC = cell.acCount > 0 ? cell.sumUsd / cell.acCount : null;
      cell.tokensPerAC = cell.acCount > 0 ? cell.sumTokens / cell.acCount : null;
    };
    for (const [provider, items] of itemsBy) finish(byProvider[provider]!, items);
    finish(total, priced);
    return { byProvider, total, mergedItems: priced, unpricedItems };
  }

  /** Observations for one provider, oldest first. */
  quotaHistory(provider: string, since?: TimeLike, limit?: number): QuotaRecord[] {
    const p: Record<string, Bindable> = { provider, limit: clampLimit(limit, 1000) };
    let sql = `${QUOTA_SELECT} WHERE provider = :provider`;
    if (since != null) { sql += ' AND ts >= :since'; p.since = toIso(since); }
    sql += ' ORDER BY ts ASC, id ASC LIMIT :limit';
    return (this.stmt(sql).all(p) as Row[]).map(rowToQuota);
  }

  /** Engine events, newest first. */
  events(filter: EventFilter = {}): EventRecord[] {
    const where: string[] = [];
    const p: Record<string, Bindable> = { limit: clampLimit(filter.limit, 200) };
    if (filter.since != null) { where.push('ts >= :since'); p.since = toIso(filter.since); }
    if (filter.until != null) { where.push('ts < :until'); p.until = toIso(filter.until); }
    if (filter.level) { where.push('level = :level'); p.level = filter.level; }
    if (filter.repo) { where.push('repo = :repo'); p.repo = filter.repo; }
    if (filter.item != null) { where.push('item = :item'); p.item = filter.item; }
    if (filter.runId) { where.push('runId = :runId'); p.runId = filter.runId; }
    const sql = `${EVENT_SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY ts DESC, id DESC LIMIT :limit`;
    return (this.stmt(sql).all(p) as Row[]).map(rowToEvent);
  }

  /** Every outcome recorded for an item, oldest first. */
  outcomesFor(repo: string, item: number): OutcomeRecord[] {
    return (this.stmt(`${OUTCOME_SELECT} WHERE repo = :repo AND item = :item ORDER BY ts ASC, id ASC`)
      .all({ repo, item }) as Row[]).map(rowToOutcome);
  }

  /** Placement decisions, newest first. */
  assignments(filter: AttributionFilter & { limit?: number } = {}): AssignmentRecord[] {
    const where: string[] = [];
    const p: Record<string, Bindable> = { limit: clampLimit(filter.limit, 200) };
    if (filter.repo) { where.push('repo = :repo'); p.repo = filter.repo; }
    if (filter.since != null) { where.push('ts >= :since'); p.since = toIso(filter.since); }
    if (filter.until != null) { where.push('ts < :until'); p.until = toIso(filter.until); }
    const sql = `${ASSIGNMENT_SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY ts DESC, id DESC LIMIT :limit`;
    return (this.stmt(sql).all(p) as Row[]).map((r) => pick(ASSIGNMENT_COLUMNS, r) as unknown as AssignmentRecord);
  }

  /** Placement-ladder counts: the warm-pool KPI that used to reset every boot. */
  ladderTallies(filter: AttributionFilter = {}): LadderTallies {
    const where: string[] = [];
    const p: Record<string, Bindable> = {};
    if (filter.repo) { where.push('repo = :repo'); p.repo = filter.repo; }
    if (filter.since != null) { where.push('ts >= :since'); p.since = toIso(filter.since); }
    if (filter.until != null) { where.push('ts < :until'); p.until = toIso(filter.until); }
    const sql = `SELECT kind, COUNT(*) AS n FROM assignments${where.length ? ` WHERE ${where.join(' AND ')}` : ''} GROUP BY kind`;
    const counts: Record<AssignmentKind, number> = { exact: 0, rerole: 0, crossRepo: 0, spawn: 0, wait: 0 };
    for (const r of this.stmt(sql).all(p) as Row[]) {
      const k = String(r.kind) as AssignmentKind;
      if (k in counts) counts[k] = Number(r.n);
    }
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const reused = counts.exact + counts.rerole + counts.crossRepo;
    return { counts, total, warmReuseRate: total ? reused / total : null };
  }

  /** Close the connection when this reader opened it (`openLedgerReader`). */
  close(): void {
    this.stmts.clear();
    if (this.ownsDb) this.db.close();
  }

  private stmt(sql: string): StatementSync {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }
}
