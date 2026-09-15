import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { QuotaObservation, Usage } from '../src/contract.js';
import { PRICING_TABLE_VERSION } from '../src/pricing.js';
import {
  LEDGER_SCHEMA_VERSION, MIRROR_FILES, openLedger, toRunRecord, v1RowToRunRecord,
  type AssignmentRecord, type EventRecord, type OutcomeRecord, type RunRecord,
} from '../src/ledger/index.js';

const USAGE: Usage = {
  inputTokens: 1200,
  outputTokens: 3400,
  cacheReadInputTokens: 980_000,
  cacheCreationInputTokens: 45_000,
  reasoningTokens: 0,
};

const V1_FIXTURE = fileURLToPath(new URL('./fixtures/usage-v1.jsonl', import.meta.url));

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'ledger-')).replace(/\\/g, '/');
}

function lines(file: string): unknown[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/** A run with every column populated, so a round-trip can be a single deepEqual. */
function fullRun(over: Partial<RunRecord> = {}): RunRecord {
  return toRunRecord({
    runId: 'run-1',
    repo: 'Pat201492/dungeonworks', item: 253, role: 'implement',
    provider: 'anthropic', harness: 'claude-code', harnessVersion: '2.1.0',
    model: 'claude-opus-4-8', effort: 'high', meter: 'subscription',
    startedAt: '2026-09-14T10:00:00.000Z', endedAt: '2026-09-14T10:05:00.000Z', apiDurationMs: 250_000,
    turns: 41, sessionId: 'sess-1', seedSessionId: 'seed-1', warmMechanism: 'fork',
    worktree: 'C:/wt/253', branch: 'feat/253', baseSha: 'abc123',
    promptSha256: 'deadbeef', promptTemplateId: 'implement@3',
    toolAllowlist: ['Read', 'Edit', 'Bash'], toolAllowlistEnforced: true,
    sandbox: 'workspace-write', approval: 'never',
    stoppedBy: null, exitCode: 0, errorClass: null, reportedCostUsd: 1.9,
    transcriptPath: 'C:/t/sess-1.jsonl', trialId: 'trial-1', arm: 'anthropic/claude-code/opus/warm',
    replicate: 1, concurrentRuns: 3, notes: null,
    ...over,
  }, USAGE);
}

const OUTCOME: OutcomeRecord = {
  outcomeId: 'out-1', runId: 'run-1', trialId: 'trial-1', repo: 'Pat201492/dungeonworks', item: 253,
  ts: '2026-09-14T10:06:00.000Z', outcome: 'pr-opened', prNumber: 301, prUrl: 'https://github.com/Pat201492/dungeonworks/pull/301',
  additions: 120, deletions: 8, changedFiles: 4, reviewRounds: 0, reviewVerdict: 'none', ciConclusion: 'none',
  mergedAt: null, detail: null,
};

const ASSIGNMENT: AssignmentRecord = {
  ts: '2026-09-14T09:59:00.000Z', repo: 'Pat201492/dungeonworks', kind: 'rerole', tier: 'opus', role: 'implement',
  provider: 'anthropic', workerId: 'w-3', fromRole: 'review', waitReason: null, item: 253, runId: 'run-1',
};

const EVENT: EventRecord = {
  ts: '2026-09-14T10:01:00.000Z', level: 'info', event: 'student.started', repo: 'Pat201492/dungeonworks', item: 253,
  runId: 'run-1', action: 'dispatch', reason: 'warm worker available', data: { worker: 'w-3', attempt: 1 },
};

const QUOTA: QuotaObservation = {
  provider: 'anthropic', observedAt: Date.UTC(2026, 8, 14, 10, 2, 0), source: 'stream',
  fiveHour: { utilization: 0.42, resetsAt: Date.UTC(2026, 8, 14, 13, 0, 0) },
  sevenDay: { utilization: 0.71, resetsAt: Date.UTC(2026, 8, 18, 0, 0, 0) },
  extra: { seven_day_opus: { utilization: 0.9, resetsAt: Date.UTC(2026, 8, 18, 0, 0, 0) } },
  allowed: true, detail: 'rate_limit_event',
};

test('a completed run round-trips through the database with its full attribution', () => {
  const dir = tmp();
  const ledger = openLedger(dir);
  const record = fullRun();
  ledger.recordRun(record);

  const detail = ledger.reader.runDetail('run-1');
  assert.ok(detail);
  assert.deepEqual(detail.run, record);
  assert.equal(record.schemaVersion, 2);
  assert.equal(record.ts, record.endedAt);
  assert.equal(record.durationMs, 300_000);
  assert.equal(record.tier, 'opus', 'tier derived from the claude model id');
  assert.equal(record.fidelity, 'exact');
  // opus: 1200*5 + 3400*25 + 45000*5*1.25 + 980000*5*0.1 = 862250 / 1e6
  assert.ok(Math.abs(record.estimatedCostUsd - 0.86225) < 1e-12, `got ${record.estimatedCostUsd}`);
  assert.equal(record.costBasis, 'list');
  assert.equal(record.pricingTableVersion, PRICING_TABLE_VERSION);
  ledger.close();
});

test('outcomes, assignments, events and quota observations round-trip', () => {
  const dir = tmp();
  const ledger = openLedger(dir);
  ledger.recordRun(fullRun());
  ledger.recordOutcome(OUTCOME);
  ledger.recordAssignment(ASSIGNMENT);
  ledger.recordEvent(EVENT);
  ledger.recordQuota(QUOTA);

  const r = ledger.reader;
  assert.deepEqual(r.outcomesFor('Pat201492/dungeonworks', 253), [OUTCOME]);
  assert.deepEqual(r.assignments(), [ASSIGNMENT]);
  assert.deepEqual(r.ladderTallies().counts, { exact: 0, rerole: 1, crossRepo: 0, spawn: 0, wait: 0 });
  assert.deepEqual(r.events({ runId: 'run-1' }), [EVENT]);
  const [q] = r.quotaHistory('anthropic');
  assert.deepEqual(q, { ...QUOTA, ts: '2026-09-14T10:02:00.000Z' });
  const detail = r.runDetail('run-1')!;
  assert.deepEqual(detail.outcomes, [OUTCOME]);
  assert.deepEqual(detail.events, [EVENT]);
  ledger.close();
});

// The .jsonl files are the crash-safe, greppable mirror: a corrupt DB never
// loses a sample and the export path is `cat`.
test('every record lands as one JSON line in its mirror file', () => {
  const dir = tmp();
  const ledger = openLedger(dir);
  const run = fullRun();
  ledger.recordRun(run);
  ledger.recordOutcome(OUTCOME);
  ledger.recordAssignment(ASSIGNMENT);
  ledger.recordEvent(EVENT);
  ledger.recordQuota(QUOTA);
  ledger.close();

  const asJson = (v: unknown): unknown => JSON.parse(JSON.stringify(v));
  assert.deepEqual(lines(`${dir}/${MIRROR_FILES.runs}`), [asJson(run)]);
  assert.deepEqual(lines(`${dir}/${MIRROR_FILES.outcomes}`), [asJson(OUTCOME)]);
  assert.deepEqual(lines(`${dir}/${MIRROR_FILES.assignments}`), [asJson(ASSIGNMENT)]);
  assert.deepEqual(lines(`${dir}/${MIRROR_FILES.events}`), [asJson(EVENT)]);
  assert.deepEqual(lines(`${dir}/${MIRROR_FILES.quota_observations}`), [asJson({ ...QUOTA, ts: '2026-09-14T10:02:00.000Z' })]);
});

test('mirrorJsonl:false writes the database only', () => {
  const dir = tmp();
  const ledger = openLedger(dir, { mirrorJsonl: false });
  ledger.recordRun(fullRun());
  ledger.recordEvent(EVENT);
  assert.equal(ledger.reader.listRuns().rows.length, 1);
  ledger.close();
  assert.ok(!existsSync(`${dir}/${MIRROR_FILES.runs}`));
  assert.ok(!existsSync(`${dir}/${MIRROR_FILES.events}`));
});

test('appends rather than overwrites, and the same runId updates in place', () => {
  const dir = tmp();
  const ledger = openLedger(dir);
  ledger.recordRun(fullRun({ runId: 'a', role: 'review' }));
  ledger.recordRun(fullRun({ runId: 'b', role: 'fix' }));
  ledger.recordRun(fullRun({ runId: 'c', role: 'rewrite', turns: 1 }));
  ledger.recordRun(fullRun({ runId: 'c', role: 'rewrite', turns: 99 }));

  const { rows } = ledger.reader.listRuns();
  assert.deepEqual(rows.map((r) => r.role), ['rewrite', 'fix', 'review']);
  assert.equal(rows[0]!.turns, 99);
  ledger.close();
});

// A run that reported nothing must still leave a row. Dropping it would remove
// the criterion from the denominator, which biases $/AC DOWNWARD — the direction
// that flatters whichever harness reports usage worst.
test('a run that reported no usage is recorded as missing, not dropped', () => {
  const record = toRunRecord({ repo: 'Pat201492/equipworks', item: 12, role: 'triage', provider: 'anthropic', harness: 'claude-code', model: 'claude-haiku-4-5' }, undefined);
  assert.equal(record.fidelity, 'missing');
  assert.equal(record.inputTokens, 0);
  assert.equal(record.cacheReadInputTokens, 0);
  assert.equal(record.reasoningTokens, 0);
  assert.equal(record.estimatedCostUsd, 0);
  assert.equal(record.costBasis, 'none', 'nothing reported is unknown, not free');
  assert.equal(record.turns, null);
  assert.equal(record.stoppedBy, null);
  assert.equal(record.warmMechanism, 'cold');
  assert.equal(record.meter, 'unknown');
  assert.match(record.runId, /^[0-9a-f-]{36}$/);

  const dir = tmp();
  const ledger = openLedger(dir);
  ledger.recordRun(record);
  assert.equal(ledger.reader.listRuns({ repo: 'Pat201492/equipworks' }).rows.length, 1);
  ledger.close();
});

// The guard that keeps the cross-harness comparison honest: a harness without a
// cache split has no business producing an 'exact' dollar figure.
test('fidelity derives from the cache-split capability unless stated', () => {
  const seed = { repo: 'x/y', item: 1, role: 'implement', provider: 'openai', harness: 'codex', model: 'gpt-5.6-terra' };
  assert.equal(toRunRecord(seed, USAGE).fidelity, 'exact');
  assert.equal(toRunRecord(seed, USAGE, { cacheUsageSplit: true }).fidelity, 'exact');
  assert.equal(toRunRecord(seed, USAGE, { cacheUsageSplit: false }).fidelity, 'partial');
  assert.equal(toRunRecord(seed, USAGE, { cacheUsageSplit: false, fidelity: 'exact' }).fidelity, 'exact');
  assert.equal(toRunRecord({ ...seed, fidelity: 'partial' }, USAGE).fidelity, 'partial');
  assert.equal(toRunRecord(seed, USAGE).costBasis, 'estimate', 'placeholder table entry is flagged on the row');
});

test('toRunRecord fills the time fields from whichever two it is given', () => {
  const seed = { repo: 'x/y', item: 1, role: 'implement', provider: 'anthropic', harness: 'claude-code' };
  const fromDuration = toRunRecord({ ...seed, endedAt: '2026-09-14T10:05:00.000Z', durationMs: 60_000 }, USAGE);
  assert.equal(fromDuration.startedAt, '2026-09-14T10:04:00.000Z');
  assert.equal(fromDuration.ts, '2026-09-14T10:05:00.000Z');
  const fromStamps = toRunRecord({ ...seed, startedAt: '2026-09-14T10:00:00.000Z', endedAt: '2026-09-14T10:02:30.000Z' }, USAGE);
  assert.equal(fromStamps.durationMs, 150_000);
  const now = new Date('2026-09-14T12:00:00.000Z');
  const fromNow = toRunRecord(seed, USAGE, { now });
  assert.equal(fromNow.endedAt, now.toISOString());
  assert.equal(fromNow.startedAt, now.toISOString());
  assert.equal(fromNow.durationMs, 0);
});

// Telemetry must never be able to fail a task: by the time this runs the
// student has already spent the plan usage and the work is already pushed.
test('a write after the database is closed is swallowed, not thrown', () => {
  const dir = tmp();
  const warnings: string[] = [];
  const ledger = openLedger(dir, { warn: (m) => warnings.push(m) });
  ledger.recordRun(fullRun({ runId: 'before-close' }));
  ledger.close();

  assert.doesNotThrow(() => ledger.recordRun(fullRun({ runId: 'after-close' })));
  assert.doesNotThrow(() => ledger.recordOutcome(OUTCOME));
  assert.doesNotThrow(() => ledger.recordAssignment(ASSIGNMENT));
  assert.doesNotThrow(() => ledger.recordEvent(EVENT));
  assert.doesNotThrow(() => ledger.recordQuota(QUOTA));
  assert.doesNotThrow(() => ledger.importV1Usage(V1_FIXTURE));
  assert.doesNotThrow(() => ledger.close());

  assert.ok(warnings.length >= 5, `expected a warning per lost write, got ${warnings.length}`);
  assert.ok(warnings.every((w) => /task unaffected|close failed/.test(w)), warnings.join('\n'));
  // The mirror does not depend on the database: the lines are still there.
  const mirrored = lines(`${dir}/${MIRROR_FILES.runs}`) as RunRecord[];
  assert.deepEqual(mirrored.slice(0, 2).map((r) => r.runId), ['before-close', 'after-close']);
});

test('a mirror append failure is swallowed and the database write still lands', () => {
  const dir = tmp();
  const warnings: string[] = [];
  const ledger = openLedger(dir, { warn: (m) => warnings.push(m) });
  // A directory where the mirror file should be makes every append fail.
  mkdirSync(`${dir}/${MIRROR_FILES.runs}`);

  assert.doesNotThrow(() => ledger.recordRun(fullRun()));
  assert.equal(ledger.reader.listRuns().rows.length, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /runs\.jsonl append failed .* task unaffected/);
  ledger.close();
});

test('reopening the same directory keeps the rows and the schema version', () => {
  const dir = tmp();
  const first = openLedger(dir);
  first.recordRun(fullRun());
  first.close();

  const second = openLedger(dir);
  assert.equal(second.reader.listRuns().rows.length, 1);
  const meta = second.db.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get();
  assert.equal(Number(meta?.value), LEDGER_SCHEMA_VERSION);
  assert.equal(String(second.db.prepare('PRAGMA journal_mode').get()?.journal_mode), 'wal');
  second.close();
});

// ---- v1 import ----------------------------------------------------------------

/** The 14 v1 field names, byte-identical on the v2 record. */
const V1_FIELDS = [
  'ts', 'repo', 'item', 'role', 'tier', 'model', 'harness', 'fidelity',
  'inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens', 'turns', 'stoppedBy',
] as const;

test('importV1Usage loads the 7 real v1 rows and prices them', () => {
  const dir = tmp();
  const ledger = openLedger(dir);
  assert.deepEqual(ledger.importV1Usage(V1_FIXTURE), { imported: 7, skipped: 0 });

  const { rows } = ledger.reader.listRuns({ limit: 100 });
  assert.equal(rows.length, 7);
  const v1 = lines(V1_FIXTURE) as Record<string, unknown>[];
  for (const src of v1) {
    const row = rows.find((r) => r.ts === src.ts);
    assert.ok(row, `row for ${src.ts}`);
    for (const f of V1_FIELDS) assert.equal(row[f], src[f], `${f} carried verbatim`);
    assert.equal(row.schemaVersion, 2);
    assert.equal(row.provider, 'anthropic');
    assert.equal(row.meter, 'subscription');
    assert.equal(row.warmMechanism, 'cold');
    assert.equal(row.reasoningTokens, 0);
    assert.equal(row.costBasis, 'list');
    assert.equal(row.pricingTableVersion, PRICING_TABLE_VERSION);
    assert.match(row.runId, /^v1-[0-9a-f]{24}$/);
    assert.equal(row.startedAt, row.ts);
    assert.equal(row.endedAt, row.ts);
  }
  // First fixture row (item 253 review, opus):
  // 1159*5 + 8888*25 + 113911*5*1.25 + 505028*5*0.1 = 1192452.75 / 1e6
  const review253 = rows.find((r) => r.item === 253 && r.role === 'review')!;
  assert.ok(Math.abs(review253.estimatedCostUsd - 1.19245275) < 1e-12, `got ${review253.estimatedCostUsd}`);

  // Re-importing the same file is a no-op: ids derive from the line bytes.
  assert.deepEqual(ledger.importV1Usage(V1_FIXTURE), { imported: 7, skipped: 0 });
  assert.equal(ledger.reader.listRuns({ limit: 100 }).rows.length, 7);
  ledger.close();
});

test('importV1Usage never throws on a missing file or an unreadable line', () => {
  const dir = tmp();
  const warnings: string[] = [];
  const ledger = openLedger(dir, { warn: (m) => warnings.push(m) });
  assert.deepEqual(ledger.importV1Usage(`${dir}/nope.jsonl`), { imported: 0, skipped: 0 });

  const mixed = `${dir}/mixed.jsonl`;
  const good = (lines(V1_FIXTURE) as unknown[])[0];
  writeFileSync(mixed, `${JSON.stringify(good)}\nnot json\n{"repo":"x/y"}\n\n`, 'utf8');
  assert.deepEqual(ledger.importV1Usage(mixed), { imported: 1, skipped: 2 });
  assert.equal(warnings.length, 3);
  ledger.close();
});

test('v1RowToRunRecord keeps a missing-fidelity row unpriced', () => {
  const rec = v1RowToRunRecord({
    ts: '2026-09-11T16:54:45.722Z', repo: 'x/y', item: 1, role: 'triage', tier: 'haiku', model: 'claude-haiku-4-5',
    harness: 'claude-code', fidelity: 'missing', inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0, turns: null, stoppedBy: null,
  })!;
  assert.equal(rec.fidelity, 'missing');
  assert.equal(rec.costBasis, 'none');
  assert.equal(v1RowToRunRecord({ ts: 'x' }), undefined);
});
