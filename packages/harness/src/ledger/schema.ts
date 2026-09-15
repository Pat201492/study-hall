import type { DatabaseSync } from 'node:sqlite';

// DDL and migrations for the ledger database.
//
// WHY SQLITE (research/code-dashboard-telemetry.json): the dashboard's queries
// are aggregations JSONL cannot serve cheaply — the role x tier x provider
// attribution matrix, per-repo/per-harness rollups, cost-per-merged-AC (a join
// between runs and outcomes), a paged recent-runs feed — all polled every 2 s.
// A JSONL answer is a full-file rescan per poll. `node:sqlite` needs no native
// rebuild (the packaging constraint that ruled out better-sqlite3). The
// append-only .jsonl files stay as the crash-safe, greppable mirror, so a
// corrupt DB never loses a sample.
//
// Column names are the record field names verbatim; the store and reader build
// their SQL from the lists below, so a column exists in exactly one place.

/** Version of the DDL below; stored in `meta.schemaVersion`. */
export const LEDGER_SCHEMA_VERSION = 2;

export const RUN_COLUMNS = [
  'runId', 'schemaVersion', 'ts', 'startedAt', 'endedAt', 'durationMs', 'apiDurationMs',
  'repo', 'item', 'role', 'tier', 'provider', 'harness', 'harnessVersion', 'model', 'effort',
  'meter', 'fidelity',
  'inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens', 'reasoningTokens',
  'turns', 'sessionId', 'seedSessionId', 'warmMechanism',
  'worktree', 'branch', 'baseSha', 'promptSha256', 'promptTemplateId',
  'toolAllowlist', 'toolAllowlistEnforced', 'sandbox', 'approval',
  'stoppedBy', 'exitCode', 'errorClass',
  'reportedCostUsd', 'estimatedCostUsd', 'costBasis', 'pricingTableVersion',
  'transcriptPath', 'trialId', 'arm', 'replicate', 'concurrentRuns', 'notes',
] as const;

export const OUTCOME_COLUMNS = [
  'outcomeId', 'runId', 'trialId', 'repo', 'item', 'ts', 'outcome',
  'prNumber', 'prUrl', 'additions', 'deletions', 'changedFiles',
  'reviewRounds', 'reviewVerdict', 'ciConclusion', 'mergedAt', 'detail',
] as const;

export const ASSIGNMENT_COLUMNS = [
  'ts', 'repo', 'kind', 'tier', 'role', 'provider', 'workerId', 'fromRole', 'waitReason', 'item', 'runId',
] as const;

export const EVENT_COLUMNS = [
  'ts', 'level', 'event', 'repo', 'item', 'runId', 'action', 'reason', 'data',
] as const;

/** Quota windows are flattened for querying; the whole observation is also kept
 *  as JSON in `raw` so nothing a provider said is lost. */
export const QUOTA_COLUMNS = [
  'ts', 'provider', 'observedAt', 'source',
  'fiveHourUtilization', 'fiveHourResetsAt', 'sevenDayUtilization', 'sevenDayResetsAt',
  'extra', 'allowed', 'limitingWindow', 'detail', 'raw',
] as const;

const DDL_V2 = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id                       INTEGER PRIMARY KEY,
  runId                    TEXT NOT NULL UNIQUE,
  schemaVersion            INTEGER NOT NULL,
  ts                       TEXT NOT NULL,
  startedAt                TEXT NOT NULL,
  endedAt                  TEXT NOT NULL,
  durationMs               INTEGER NOT NULL,
  apiDurationMs            INTEGER,
  repo                     TEXT NOT NULL,
  item                     INTEGER NOT NULL,
  role                     TEXT NOT NULL,
  tier                     TEXT,
  provider                 TEXT NOT NULL,
  harness                  TEXT NOT NULL,
  harnessVersion           TEXT,
  model                    TEXT,
  effort                   TEXT,
  meter                    TEXT NOT NULL,
  fidelity                 TEXT NOT NULL,
  inputTokens              INTEGER NOT NULL,
  outputTokens             INTEGER NOT NULL,
  cacheReadInputTokens     INTEGER NOT NULL,
  cacheCreationInputTokens INTEGER NOT NULL,
  reasoningTokens          INTEGER NOT NULL DEFAULT 0,
  turns                    INTEGER,
  sessionId                TEXT,
  seedSessionId            TEXT,
  warmMechanism            TEXT NOT NULL,
  worktree                 TEXT,
  branch                   TEXT,
  baseSha                  TEXT,
  promptSha256             TEXT,
  promptTemplateId         TEXT,
  toolAllowlist            TEXT,
  toolAllowlistEnforced    INTEGER,
  sandbox                  TEXT,
  approval                 TEXT,
  stoppedBy                TEXT,
  exitCode                 INTEGER,
  errorClass               TEXT,
  reportedCostUsd          REAL,
  estimatedCostUsd         REAL NOT NULL,
  costBasis                TEXT NOT NULL,
  pricingTableVersion      TEXT NOT NULL,
  transcriptPath           TEXT,
  trialId                  TEXT,
  arm                      TEXT,
  replicate                INTEGER,
  concurrentRuns           INTEGER,
  notes                    TEXT
);
CREATE INDEX IF NOT EXISTS runs_ts        ON runs (ts);
CREATE INDEX IF NOT EXISTS runs_repo_item ON runs (repo, item);
CREATE INDEX IF NOT EXISTS runs_provider  ON runs (provider);
CREATE INDEX IF NOT EXISTS runs_harness   ON runs (harness);
CREATE INDEX IF NOT EXISTS runs_role_tier ON runs (role, tier);

CREATE TABLE IF NOT EXISTS outcomes (
  id            INTEGER PRIMARY KEY,
  outcomeId     TEXT NOT NULL UNIQUE,
  runId         TEXT,
  trialId       TEXT,
  repo          TEXT NOT NULL,
  item          INTEGER NOT NULL,
  ts            TEXT NOT NULL,
  outcome       TEXT NOT NULL,
  prNumber      INTEGER,
  prUrl         TEXT,
  additions     INTEGER,
  deletions     INTEGER,
  changedFiles  INTEGER,
  reviewRounds  INTEGER,
  reviewVerdict TEXT,
  ciConclusion  TEXT,
  mergedAt      TEXT,
  detail        TEXT
);
CREATE INDEX IF NOT EXISTS outcomes_repo_item ON outcomes (repo, item);
CREATE INDEX IF NOT EXISTS outcomes_outcome   ON outcomes (outcome);

CREATE TABLE IF NOT EXISTS assignments (
  id         INTEGER PRIMARY KEY,
  ts         TEXT NOT NULL,
  repo       TEXT NOT NULL,
  kind       TEXT NOT NULL,
  tier       TEXT,
  role       TEXT NOT NULL,
  provider   TEXT NOT NULL,
  workerId   TEXT,
  fromRole   TEXT,
  waitReason TEXT,
  item       INTEGER,
  runId      TEXT
);
CREATE INDEX IF NOT EXISTS assignments_ts ON assignments (ts);

CREATE TABLE IF NOT EXISTS events (
  id     INTEGER PRIMARY KEY,
  ts     TEXT NOT NULL,
  level  TEXT NOT NULL,
  event  TEXT NOT NULL,
  repo   TEXT,
  item   INTEGER,
  runId  TEXT,
  action TEXT,
  reason TEXT,
  data   TEXT
);
CREATE INDEX IF NOT EXISTS events_ts ON events (ts);

CREATE TABLE IF NOT EXISTS quota_observations (
  id                   INTEGER PRIMARY KEY,
  ts                   TEXT NOT NULL,
  provider             TEXT NOT NULL,
  observedAt           INTEGER NOT NULL,
  source               TEXT NOT NULL,
  fiveHourUtilization  REAL,
  fiveHourResetsAt     INTEGER,
  sevenDayUtilization  REAL,
  sevenDayResetsAt     INTEGER,
  extra                TEXT,
  allowed              INTEGER,
  limitingWindow       TEXT,
  detail               TEXT,
  raw                  TEXT
);
CREATE INDEX IF NOT EXISTS quota_provider_ts ON quota_observations (provider, ts);
`;

/** Migration steps keyed by the version they bring the database TO. Each must be
 *  safe to re-run (IF NOT EXISTS / guarded ALTERs). */
const MIGRATIONS: Record<number, (db: DatabaseSync) => void> = {
  2: (db) => { db.exec(DDL_V2); },
};

/** The `meta.schemaVersion` a database reports, 0 for a fresh file. */
export function schemaVersionOf(db: DatabaseSync): number {
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get();
  return row ? Number(row.value) : 0;
}

/**
 * Bring the database to LEDGER_SCHEMA_VERSION. Idempotent: opening an
 * up-to-date file re-runs nothing but the version read. Throws when the file is
 * NEWER than this code knows — writing rows under a schema you do not understand
 * is worse than refusing to start.
 */
export function migrate(db: DatabaseSync): void {
  const current = schemaVersionOf(db);
  if (current > LEDGER_SCHEMA_VERSION) {
    throw new Error(`ledger schema ${current} is newer than this build supports (${LEDGER_SCHEMA_VERSION})`);
  }
  if (current === LEDGER_SCHEMA_VERSION) return;
  db.exec('BEGIN');
  try {
    for (let v = current + 1; v <= LEDGER_SCHEMA_VERSION; v++) {
      MIGRATIONS[v]?.(db);
    }
    db.prepare(
      "INSERT INTO meta (key, value) VALUES ('schemaVersion', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(String(LEDGER_SCHEMA_VERSION));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
