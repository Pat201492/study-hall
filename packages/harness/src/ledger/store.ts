import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import type { QuotaObservation, Usage, UsageFidelity } from '../contract.js';
import { PRICING_TABLE_VERSION, estimateCost, tierOf, type CostEstimate } from '../pricing.js';
import {
  ASSIGNMENT_COLUMNS, EVENT_COLUMNS, OUTCOME_COLUMNS, QUOTA_COLUMNS, RUN_COLUMNS, migrate,
} from './schema.js';
import { LedgerReader } from './reader.js';
import {
  RUN_SCHEMA_VERSION,
  type AssignmentRecord, type EventRecord, type OutcomeRecord, type QuotaRecord, type RunRecord,
} from './types.js';

// Durable record of what every completed student run actually spent, and what
// came of it. Ported from claude-study-room's usageStore.ts (#297).
//
// Until v1 #297, `recordUsage()` folded a finished run into two in-memory
// meters and dropped it. Nothing survived the process, so the 2026-08-31
// cost-per-acceptance-criterion analysis had to RECONSTRUCT spend by parsing
// `~/.claude/projects` transcripts — which only works by accident of every
// student being a `claude` process writing transcripts to a path we know. That
// accident ends the moment a second harness runs a task: its spend lands
// somewhere this engine has never heard of and $/AC stops being computable.
// This store is therefore a PREREQUISITE for the multi-harness comparison, not
// telemetry housekeeping — without it the whole experiment is unfalsifiable.
//
// Engine-wide rather than per-repo. The question this store exists to answer —
// "what does a merged acceptance criterion cost, and does harness B beat harness
// A at it?" — is asked ACROSS repos, so `repo` is a column on every row and the
// primary query is one SELECT, not a directory walk.
//
// Two write paths, deliberately: the SQLite file is the QUERY store (WAL, so a
// dashboard process reads while the engine writes); the `.jsonl` files beside
// it are the append-only, crash-safe, greppable MIRROR. Each row is written to
// both, each write guarded separately, so a corrupt or locked DB never loses a
// sample and a full disk never fails a task.

/** Harness id assumed for v1 rows that do not name one. */
export const DEFAULT_V1_HARNESS = 'claude-code';

export interface LedgerOptions {
  /** Also append every record to `<dir>/<stream>.jsonl`. Default true. */
  mirrorJsonl?: boolean;
  now?: () => Date;
  /** Sink for never-throw failures. Defaults to console.warn. */
  warn?: (message: string) => void;
}

export interface ImportSummary {
  /** Rows that reached the database. */
  imported: number;
  /** Lines that could not be parsed or mapped, or whose write failed. */
  skipped: number;
}

export interface Ledger {
  readonly dir: string;
  readonly dbPath: string;
  readonly db: DatabaseSync;
  /** Read-only query API over the same connection. */
  readonly reader: LedgerReader;
  recordRun(record: RunRecord): void;
  recordOutcome(record: OutcomeRecord): void;
  recordAssignment(record: AssignmentRecord): void;
  recordEvent(record: EventRecord): void;
  recordQuota(observation: QuotaObservation | QuotaRecord): void;
  /** Load v1's usage.jsonl. Idempotent: a row's id is derived from its bytes. */
  importV1Usage(jsonlPath: string): ImportSummary;
  close(): void;
}

/** File names of the JSONL mirror, by table. */
export const MIRROR_FILES = {
  runs: 'runs.jsonl',
  outcomes: 'outcomes.jsonl',
  assignments: 'assignments.jsonl',
  events: 'events.jsonl',
  quota_observations: 'quota.jsonl',
} as const;

/**
 * Open (or create) `<dir>/ledger.db`, switch it to WAL with a busy timeout, and
 * bring it to the current schema. THIS throws — a ledger that cannot be opened
 * at boot is a loud failure; only the record methods are never-throw.
 */
export function openLedger(dir: string, opts: LedgerOptions = {}): Ledger {
  const root = dir.replace(/\\/g, '/').replace(/\/+$/, '');
  mkdirSync(root, { recursive: true });
  const dbPath = `${root}/ledger.db`;
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  migrate(db);
  return new SqliteLedger(root, dbPath, db, opts);
}

// ---- Record building --------------------------------------------------------

export interface RunBuildContext {
  /** The harness's declared `cacheUsageSplit` capability (see registry
   *  `fidelityFor`): false makes a run with usage 'partial'. Default true. */
  cacheUsageSplit?: boolean;
  /** Explicit fidelity; wins over the derivation. */
  fidelity?: UsageFidelity;
  now?: Date;
}

/** What the caller must know about a run; everything else has a default. */
export type RunSeed =
  Pick<RunRecord, 'repo' | 'item' | 'role' | 'provider' | 'harness'>
  & Partial<Omit<RunRecord, 'repo' | 'item' | 'role' | 'provider' | 'harness'>>;

function priceRun(provider: string, model: string | null, usage: Usage | null | undefined): CostEstimate {
  // Nothing reported means nothing to price: basis 'none', never a confident $0.
  if (!usage) return { usd: 0, basis: 'none', tableVersion: PRICING_TABLE_VERSION };
  return estimateCost(provider, model, usage);
}

/**
 * Build a RunRecord without writing it — the half worth unit-testing. Prices the
 * usage against the current table and stamps the table version, so the dollar
 * figure is reproducible after the table changes.
 *
 * A run that reported nothing is recorded as 'missing' with zeroed tokens
 * rather than dropped: $/AC needs the criterion counted in the denominator even
 * when its spend is unknown, and a silently absent row would bias the average
 * DOWN — the direction that flatters whatever produced it.
 */
export function toRunRecord(partial: RunSeed, usage: Usage | null | undefined, ctx: RunBuildContext = {}): RunRecord {
  const now = ctx.now ?? new Date();
  const endedAt = partial.endedAt ?? partial.ts ?? now.toISOString();
  const endMs = Date.parse(endedAt);
  const startedAt = partial.startedAt
    ?? (partial.durationMs != null && Number.isFinite(endMs) ? new Date(endMs - partial.durationMs).toISOString() : endedAt);
  const startMs = Date.parse(startedAt);
  const durationMs = partial.durationMs
    ?? (Number.isFinite(endMs) && Number.isFinite(startMs) ? Math.max(0, endMs - startMs) : 0);
  const model = partial.model ?? null;
  const fidelity: UsageFidelity = ctx.fidelity ?? partial.fidelity
    ?? (usage ? (ctx.cacheUsageSplit === false ? 'partial' : 'exact') : 'missing');
  const cost = priceRun(partial.provider, model, usage);
  return {
    ...partial,
    schemaVersion: RUN_SCHEMA_VERSION,
    runId: partial.runId ?? randomUUID(),
    ts: endedAt,
    startedAt,
    endedAt,
    durationMs,
    repo: partial.repo,
    item: partial.item,
    role: partial.role,
    tier: partial.tier ?? tierOf(model) ?? null,
    provider: partial.provider,
    harness: partial.harness,
    model,
    meter: partial.meter ?? 'unknown',
    fidelity,
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    cacheReadInputTokens: usage?.cacheReadInputTokens ?? 0,
    cacheCreationInputTokens: usage?.cacheCreationInputTokens ?? 0,
    reasoningTokens: usage?.reasoningTokens ?? 0,
    turns: partial.turns ?? null,
    warmMechanism: partial.warmMechanism ?? 'cold',
    stoppedBy: partial.stoppedBy ?? null,
    estimatedCostUsd: cost.usd,
    costBasis: cost.basis,
    pricingTableVersion: cost.tableVersion,
  };
}

/** One line of v1's usage.jsonl — the 14 names the v2 record keeps verbatim. */
export interface V1UsageRow {
  ts: string;
  repo: string;
  item: number;
  role: string;
  tier: string;
  model: string | null;
  harness: string;
  fidelity: UsageFidelity;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  turns: number | null;
  stoppedBy: 'budget' | null;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * Map a v1 row onto a v2 RunRecord, or undefined when the line lacks the four
 * fields nothing can be inferred without. v1 ran only Claude Code on the
 * Anthropic subscription and recorded neither timing nor warmth, so those
 * columns take the neutral values and `notes` says so.
 */
export function v1RowToRunRecord(row: Partial<V1UsageRow>, rawLine?: string): RunRecord | undefined {
  if (typeof row.ts !== 'string' || typeof row.repo !== 'string'
    || typeof row.item !== 'number' || typeof row.role !== 'string') return undefined;
  const model = row.model ?? null;
  const fidelity: UsageFidelity = row.fidelity ?? 'exact';
  const usage: Usage = {
    inputTokens: num(row.inputTokens),
    outputTokens: num(row.outputTokens),
    cacheReadInputTokens: num(row.cacheReadInputTokens),
    cacheCreationInputTokens: num(row.cacheCreationInputTokens),
    reasoningTokens: 0,
  };
  const cost = priceRun('anthropic', model, fidelity === 'missing' ? null : usage);
  // Deterministic id from the line's bytes: re-importing the same file upserts
  // the same rows instead of doubling the baseline.
  const digest = createHash('sha256').update(rawLine ?? JSON.stringify(row)).digest('hex').slice(0, 24);
  return {
    schemaVersion: RUN_SCHEMA_VERSION,
    runId: `v1-${digest}`,
    ts: row.ts,
    startedAt: row.ts,
    endedAt: row.ts,
    durationMs: 0,
    repo: row.repo,
    item: row.item,
    role: row.role,
    tier: row.tier ?? tierOf(model) ?? null,
    provider: 'anthropic',
    harness: row.harness ?? DEFAULT_V1_HARNESS,
    model,
    meter: 'subscription',
    fidelity,
    ...usage,
    turns: row.turns ?? null,
    warmMechanism: 'cold',
    stoppedBy: row.stoppedBy ?? null,
    estimatedCostUsd: cost.usd,
    costBasis: cost.basis,
    pricingTableVersion: cost.tableVersion,
    notes: 'imported from v1 usage.jsonl (schemaVersion 1): startedAt, durationMs and warmMechanism were not recorded',
  };
}

// ---- SQL helpers ------------------------------------------------------------

type Bindable = null | number | string;

/** Coerce a record field to something node:sqlite will bind: undefined → NULL,
 *  booleans → 0/1, arrays/objects → JSON. Unknown keys throw in node:sqlite, so
 *  the object is built from the column list, never from the record's keys. */
function bindable(v: unknown): Bindable {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number' || typeof v === 'string') return v;
  if (typeof v === 'bigint') return Number(v);
  return JSON.stringify(v);
}

function params(columns: readonly string[], record: Record<string, unknown>): Record<string, Bindable> {
  const out: Record<string, Bindable> = {};
  for (const c of columns) out[c] = bindable(record[c]);
  return out;
}

function insertSql(table: string, columns: readonly string[], conflictKey?: string): string {
  const base = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map((c) => `:${c}`).join(', ')})`;
  if (!conflictKey) return base;
  const updates = columns.filter((c) => c !== conflictKey).map((c) => `${c} = excluded.${c}`).join(', ');
  return `${base} ON CONFLICT(${conflictKey}) DO UPDATE SET ${updates}`;
}

const errMsg = (e: unknown): string => String((e as Error)?.message ?? e);

// ---- The store --------------------------------------------------------------

class SqliteLedger implements Ledger {
  readonly reader: LedgerReader;
  private readonly mirror: boolean;
  private readonly warn: (message: string) => void;
  private readonly stmts = new Map<string, StatementSync>();

  constructor(
    readonly dir: string,
    readonly dbPath: string,
    readonly db: DatabaseSync,
    opts: LedgerOptions,
  ) {
    this.mirror = opts.mirrorJsonl ?? true;
    this.warn = opts.warn ?? ((m) => console.warn(m));
    this.reader = new LedgerReader(db);
  }

  recordRun(record: RunRecord): void {
    this.write('runs', RUN_COLUMNS, 'runId', record as unknown as Record<string, unknown>);
  }

  recordOutcome(record: OutcomeRecord): void {
    this.write('outcomes', OUTCOME_COLUMNS, 'outcomeId', record as unknown as Record<string, unknown>);
  }

  recordAssignment(record: AssignmentRecord): void {
    this.write('assignments', ASSIGNMENT_COLUMNS, undefined, record as unknown as Record<string, unknown>);
  }

  recordEvent(record: EventRecord): void {
    this.write('events', EVENT_COLUMNS, undefined, record as unknown as Record<string, unknown>);
  }

  recordQuota(observation: QuotaObservation | QuotaRecord): void {
    let rec: QuotaRecord;
    let row: Record<string, unknown>;
    try {
      const ts = 'ts' in observation && typeof observation.ts === 'string'
        ? observation.ts
        : new Date(observation.observedAt).toISOString();
      rec = { ...observation, ts };
      row = {
        ts,
        provider: rec.provider,
        observedAt: rec.observedAt,
        source: rec.source,
        fiveHourUtilization: rec.fiveHour?.utilization ?? null,
        fiveHourResetsAt: rec.fiveHour?.resetsAt ?? null,
        sevenDayUtilization: rec.sevenDay?.utilization ?? null,
        sevenDayResetsAt: rec.sevenDay?.resetsAt ?? null,
        extra: rec.extra ?? null,
        allowed: rec.allowed ?? null,
        limitingWindow: rec.limitingWindow ?? null,
        detail: rec.detail ?? null,
        raw: rec,
      };
    } catch (e) {
      this.warn(`ledger quota observation unusable (${errMsg(e)}) — sample lost, task unaffected`);
      return;
    }
    this.write('quota_observations', QUOTA_COLUMNS, undefined, row, rec as unknown as Record<string, unknown>);
  }

  importV1Usage(jsonlPath: string): ImportSummary {
    let text: string;
    try {
      text = readFileSync(jsonlPath, 'utf8');
    } catch (e) {
      this.warn(`ledger v1 import: cannot read ${jsonlPath} (${errMsg(e)})`);
      return { imported: 0, skipped: 0 };
    }
    let imported = 0;
    let skipped = 0;
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      let row: Partial<V1UsageRow> | undefined;
      try { row = JSON.parse(line) as Partial<V1UsageRow>; } catch { row = undefined; }
      const rec = row ? v1RowToRunRecord(row, line) : undefined;
      if (!rec) { skipped++; this.warn(`ledger v1 import: skipped unreadable line: ${line.slice(0, 80)}`); continue; }
      if (this.write('runs', RUN_COLUMNS, 'runId', rec as unknown as Record<string, unknown>)) imported++;
      else skipped++;
    }
    return { imported, skipped };
  }

  close(): void {
    try { this.db.close(); } catch (e) { this.warn(`ledger close failed (${errMsg(e)})`); }
    this.stmts.clear();
  }

  /**
   * Append one record to its JSONL mirror and its table. NEVER throws.
   *
   * A telemetry write must not be able to fail a task: by the time this runs
   * the student has already spent the plan usage and the work is already on
   * disk or pushed, so letting a full disk or a locked file turn into a
   * rejection would discard finished work to protect a log line. Errors are
   * logged and swallowed; a missing row costs one sample, a thrown one costs a
   * PR. The mirror goes first because it is the cheapest write that can
   * succeed, and each path is guarded on its own so one failing cannot take the
   * other with it.
   *
   * Synchronous on purpose. Writes are a few hundred bytes and land once per
   * completed task — minutes apart, right after a CLI process exited — so the
   * blocking cost is irrelevant, while ordering and the absence of an
   * unhandled-rejection path are both worth having.
   *
   * @returns whether the DATABASE write succeeded (the mirror is best-effort).
   */
  private write(
    table: keyof typeof MIRROR_FILES,
    columns: readonly string[],
    conflictKey: string | undefined,
    row: Record<string, unknown>,
    mirrorRecord: Record<string, unknown> = row,
  ): boolean {
    if (this.mirror) {
      try {
        appendFileSync(`${this.dir}/${MIRROR_FILES[table]}`, `${JSON.stringify(mirrorRecord)}\n`, 'utf8');
      } catch (e) {
        this.warn(`ledger ${MIRROR_FILES[table]} append failed (${errMsg(e)}) — mirror line lost, task unaffected`);
      }
    }
    try {
      this.stmt(insertSql(table, columns, conflictKey)).run(params(columns, row));
      return true;
    } catch (e) {
      this.warn(`ledger ${table} write failed (${errMsg(e)}) — sample lost, task unaffected`);
      return false;
    }
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
