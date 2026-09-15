import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZERO_USAGE, type Usage } from '../src/contract.js';
import {
  openLedger, openLedgerReader, toRunRecord,
  type Ledger, type OutcomeRecord, type RunBuildContext, type RunRecord, type RunSeed,
} from '../src/ledger/index.js';

const REPO = 'Pat201492/dungeonworks';
const T0 = Date.UTC(2026, 8, 14, 10, 0, 0);
/** ISO timestamp `min` minutes after T0. */
const at = (min: number): string => new Date(T0 + min * 60_000).toISOString();

function open(): Ledger {
  return openLedger(mkdtempSync(join(tmpdir(), 'ledger-reader-')), { mirrorJsonl: false });
}

/** A sonnet run on the anthropic subscription lane, ended `item` minutes after T0 unless told otherwise. */
function run(
  id: string,
  over: Partial<RunSeed> & { item: number },
  usage: Partial<Usage> = {},
  ctx?: RunBuildContext,
): RunRecord {
  return toRunRecord({
    runId: id, repo: REPO, role: 'implement', provider: 'anthropic', harness: 'claude-code',
    model: 'claude-sonnet-5', meter: 'subscription', endedAt: at(over.item), ...over,
  }, { ...ZERO_USAGE, ...usage }, ctx);
}

function outcome(id: string, item: number, kind: OutcomeRecord['outcome'], over: Partial<OutcomeRecord> = {}): OutcomeRecord {
  return { outcomeId: id, repo: REPO, item, ts: at(100 + item), outcome: kind, ...over };
}

test('listRuns pages newest-first on a keyset cursor that survives concurrent appends', () => {
  const ledger = open();
  for (let item = 1; item <= 7; item++) ledger.recordRun(run(`r${item}`, { item }));
  const r = ledger.reader;

  const p1 = r.listRuns({ limit: 3 });
  assert.deepEqual(p1.rows.map((x) => x.item), [7, 6, 5]);
  assert.ok(p1.nextCursor);

  // A row appended between pages must not shift the next page.
  ledger.recordRun(run('r8', { item: 8 }));

  const p2 = r.listRuns({ limit: 3, cursor: p1.nextCursor });
  assert.deepEqual(p2.rows.map((x) => x.item), [4, 3, 2]);
  assert.ok(p2.nextCursor);
  const p3 = r.listRuns({ limit: 3, cursor: p2.nextCursor });
  assert.deepEqual(p3.rows.map((x) => x.item), [1]);
  assert.equal(p3.nextCursor, null);

  // An exact-fit page reports no next cursor.
  assert.equal(r.listRuns({ limit: 8 }).nextCursor, null);
  assert.equal(r.listRuns().rows.length, 8, 'default limit is 50');
  ledger.close();
});

test('listRuns filters by repo, provider, harness, role, item, time window and item outcome', () => {
  const ledger = open();
  ledger.recordRun(run('a', { item: 1 }));
  ledger.recordRun(run('b', { item: 2, role: 'review' }));
  ledger.recordRun(run('c', { item: 3, provider: 'openai', harness: 'codex', model: 'gpt-5.6-terra' }));
  ledger.recordRun(run('d', { item: 4, repo: 'Pat201492/equipworks' }));
  ledger.recordRun(run('e', { item: 5 }));
  ledger.recordOutcome(outcome('o5', 5, 'merged'));
  const r = ledger.reader;
  const items = (rows: RunRecord[]): number[] => rows.map((x) => x.item).sort((p, q) => p - q);

  assert.deepEqual(items(r.listRuns({ repo: REPO }).rows), [1, 2, 3, 5]);
  assert.deepEqual(items(r.listRuns({ provider: 'openai' }).rows), [3]);
  assert.deepEqual(items(r.listRuns({ harness: 'claude-code' }).rows), [1, 2, 4, 5]);
  assert.deepEqual(items(r.listRuns({ role: 'review' }).rows), [2]);
  assert.deepEqual(items(r.listRuns({ item: 4 }).rows), [4]);
  // since is inclusive, until exclusive: the two tile without overlap.
  assert.deepEqual(items(r.listRuns({ since: at(3) }).rows), [3, 4, 5]);
  assert.deepEqual(items(r.listRuns({ until: at(3) }).rows), [1, 2]);
  assert.deepEqual(items(r.listRuns({ since: new Date(T0 + 2 * 60_000), until: T0 + 4 * 60_000 }).rows), [2, 3]);
  assert.deepEqual(items(r.listRuns({ outcome: 'merged' }).rows), [5]);
  assert.deepEqual(items(r.listRuns({ outcome: 'merged', role: 'review' }).rows), []);
  ledger.close();
});

test('runDetail returns the run with its item outcomes and its events', () => {
  const ledger = open();
  ledger.recordRun(run('impl', { item: 9, startedAt: at(0), endedAt: at(9) }));
  ledger.recordRun(run('rev', { item: 9, role: 'review', startedAt: at(10), endedAt: at(12) }));
  ledger.recordOutcome(outcome('o1', 9, 'pr-opened', { runId: 'impl', prNumber: 42 }));
  ledger.recordOutcome(outcome('o2', 9, 'merged', { ts: at(500) }));
  ledger.recordEvent({ ts: at(1), level: 'info', event: 'tool', repo: REPO, item: 9, runId: 'impl' });
  ledger.recordEvent({ ts: at(2), level: 'warn', event: 'stall', repo: REPO, item: 9 });
  ledger.recordEvent({ ts: at(11), level: 'info', event: 'tool', repo: REPO, item: 9 });
  ledger.recordEvent({ ts: at(3), level: 'info', event: 'unrelated', repo: REPO, item: 10 });
  const r = ledger.reader;

  const d = r.runDetail('impl')!;
  assert.equal(d.run.runId, 'impl');
  assert.deepEqual(d.outcomes.map((o) => o.outcome), ['pr-opened', 'merged']);
  assert.deepEqual(d.events.map((e) => e.event), ['tool', 'stall']);
  assert.deepEqual(r.runDetail('rev')!.events.map((e) => e.ts), [at(11)]);
  assert.equal(r.runDetail('nope'), undefined);
  ledger.close();
});

// The role x tier x provider matrix. Dollars are exact-fidelity only; tokens,
// counts and cache reads include every row; avgTurns ignores rows without one.
test('attribution groups by role x tier x provider with fidelity-aware sums', () => {
  const ledger = open();
  ledger.recordRun(run('a', { item: 1, turns: 10 }, { inputTokens: 1_000_000 }));               // $3
  ledger.recordRun(run('b', { item: 2, turns: 20 }, { outputTokens: 1_000_000 }));              // $15
  ledger.recordRun(run('c', { item: 3 }, { inputTokens: 1_000_000 }, { cacheUsageSplit: false })); // partial: $ excluded
  ledger.recordRun(run('d', { item: 4, role: 'review', model: 'claude-opus-4-8', turns: 5 }, { cacheReadInputTokens: 1_000_000 })); // $0.5
  ledger.recordRun(run('e', { item: 5, provider: 'openai', harness: 'codex', model: 'gpt-5.6-terra', turns: 7 }, { inputTokens: 1_000_000 })); // $2 estimate
  ledger.recordRun(run('f', { item: 6, repo: 'Pat201492/equipworks', turns: 1 }, { inputTokens: 1_000_000 })); // other repo
  const r = ledger.reader;

  const rows = r.attribution({ repo: REPO });
  assert.equal(rows.length, 3);
  const cell = (role: string, tier: string | null, provider: string) =>
    rows.find((x) => x.role === role && x.tier === tier && x.provider === provider)!;

  const impl = cell('implement', 'sonnet', 'anthropic');
  assert.equal(impl.count, 3);
  assert.equal(impl.exactCount, 2);
  assert.equal(impl.estimateBasisCount, 0);
  assert.equal(impl.sumEstimatedCostUsd, 18);
  assert.equal(impl.sumTokensProcessed, 3_000_000);
  assert.equal(impl.sumInput, 2_000_000);
  assert.equal(impl.sumCacheRead, 0);
  assert.equal(impl.avgTurns, 15);

  const rev = cell('review', 'opus', 'anthropic');
  assert.equal(rev.count, 1);
  assert.equal(rev.sumEstimatedCostUsd, 0.5);
  assert.equal(rev.sumCacheRead, 1_000_000);
  assert.equal(rev.avgTurns, 5);

  const codex = cell('implement', null, 'openai');
  assert.equal(codex.sumEstimatedCostUsd, 2);
  assert.equal(codex.estimateBasisCount, 1, 'placeholder-priced rows are flagged');

  assert.equal(r.attribution().length, 3, 'the other repo joins the same sonnet cell');
  assert.equal(r.attribution().find((x) => x.tier === 'sonnet')!.count, 4);
  assert.equal(r.attribution({ repo: REPO, since: at(4) }).length, 2);
  ledger.close();
});

// The primary metric, on numbers small enough to check by hand:
//   item 101 (3 ACs, merged): A $3 exact, B $1.5 exact (abandoned attempt),
//                            C partial (would be $0.6; tokens count, $ do not)
//   item 102 (5 ACs, merged): D $1.5 exact; G $2 exact on openai (placeholder price)
//   item 103 (2 ACs, PR open only): E excluded entirely
//   item 104 (merged, no acCount):  F excluded from both sides, reported as unpriced
test('costPerMergedAC counts every run on merged items, exact $ only, all-fidelity tokens', () => {
  const ledger = open();
  ledger.recordRun(run('A', { item: 101 }, { inputTokens: 1_000_000 }));
  ledger.recordRun(run('B', { item: 101, endedAt: at(50) }, { inputTokens: 500_000 }));
  ledger.recordRun(run('C', { item: 101, role: 'review' }, { inputTokens: 200_000 }, { cacheUsageSplit: false }));
  ledger.recordRun(run('D', { item: 102 }, { outputTokens: 100_000 }));
  ledger.recordRun(run('G', { item: 102, role: 'review', provider: 'openai', harness: 'codex', model: 'gpt-5.6-terra' }, { inputTokens: 1_000_000 }));
  ledger.recordRun(run('E', { item: 103 }, { inputTokens: 1_000_000 }));
  ledger.recordRun(run('F', { item: 104 }, { inputTokens: 1_000_000 }));
  ledger.recordOutcome(outcome('ab', 101, 'abandoned', { runId: 'B', ts: at(51) }));
  ledger.recordOutcome(outcome('m101', 101, 'merged', { ts: at(200) }));
  ledger.recordOutcome(outcome('m102', 102, 'merged', { ts: at(210) }));
  ledger.recordOutcome(outcome('p103', 103, 'pr-opened'));
  ledger.recordOutcome(outcome('m104', 104, 'merged', { ts: at(220) }));
  const acCounts = { 101: 3, 102: 5, 103: 2 };

  const res = ledger.reader.costPerMergedAC({ repo: REPO, acCounts });
  assert.deepEqual(res.mergedItems, [101, 102]);
  assert.deepEqual(res.unpricedItems, [104]);

  const a = res.byProvider.anthropic!;
  assert.equal(a.runs, 4);
  assert.equal(a.exactRuns, 3);
  assert.equal(a.mergedItems, 2);
  assert.equal(a.acCount, 8);
  assert.equal(a.sumUsd, 6);                 // 3 + 1.5 + 1.5; the partial row's $ stays out
  assert.equal(a.sumTokens, 1_800_000);      // 1e6 + 5e5 + 2e5 + 1e5; every fidelity
  assert.equal(a.usdPerAC, 0.75);
  assert.equal(a.tokensPerAC, 225_000);

  const o = res.byProvider.openai!;
  assert.equal(o.runs, 1);
  assert.equal(o.mergedItems, 1);
  assert.equal(o.acCount, 5);                // only the merged item openai ran on
  assert.equal(o.usdPerAC, 0.4);
  assert.equal(o.tokensPerAC, 200_000);

  assert.equal(res.total.runs, 5);
  assert.equal(res.total.acCount, 8);
  assert.equal(res.total.usdPerAC, 1);       // (6 + 2) / 8
  assert.equal(res.total.tokensPerAC, 350_000);

  // `since` bounds the MERGE time: only item 102 merged after at(205).
  const late = ledger.reader.costPerMergedAC({ repo: REPO, since: at(205), acCounts });
  assert.deepEqual(late.mergedItems, [102]);
  assert.equal(late.byProvider.anthropic!.usdPerAC, 0.3);
  assert.equal(late.total.runs, 2);

  // Nothing merged (or nothing priced) → null ratios, never a divide-by-zero.
  const none = ledger.reader.costPerMergedAC({ repo: 'Pat201492/equipworks', acCounts });
  assert.deepEqual(none.mergedItems, []);
  assert.equal(none.total.usdPerAC, null);
  assert.deepEqual(none.byProvider, {});
  const unpriced = ledger.reader.costPerMergedAC({ repo: REPO, acCounts: {} });
  assert.deepEqual(unpriced.unpricedItems, [101, 102, 104]);
  assert.equal(unpriced.total.tokensPerAC, null);
  ledger.close();
});

test('quotaHistory, events and outcomesFor honour their filters and ordering', () => {
  const ledger = open();
  for (const [i, util] of [0.1, 0.5, 0.9].entries()) {
    ledger.recordQuota({ provider: 'anthropic', observedAt: T0 + i * 60_000, source: 'stream', fiveHour: { utilization: util, resetsAt: T0 + 3_600_000 } });
  }
  ledger.recordQuota({ provider: 'openai', observedAt: T0, source: 'app-server', allowed: false, limitingWindow: 'sevenDay' });
  ledger.recordEvent({ ts: at(1), level: 'info', event: 'a', repo: REPO });
  ledger.recordEvent({ ts: at(2), level: 'error', event: 'b', repo: REPO, item: 1, data: { code: 429 } });
  ledger.recordEvent({ ts: at(3), level: 'info', event: 'c', repo: 'Pat201492/equipworks' });
  ledger.recordOutcome(outcome('o2', 7, 'merged', { ts: at(20) }));
  ledger.recordOutcome(outcome('o1', 7, 'pr-opened', { ts: at(10) }));
  const r = ledger.reader;

  assert.deepEqual(r.quotaHistory('anthropic').map((q) => q.fiveHour!.utilization), [0.1, 0.5, 0.9]);
  assert.deepEqual(r.quotaHistory('anthropic', at(1)).map((q) => q.fiveHour!.utilization), [0.5, 0.9]);
  assert.deepEqual(r.quotaHistory('anthropic', undefined, 1).map((q) => q.ts), [at(0)]);
  const [oq] = r.quotaHistory('openai');
  assert.equal(oq!.allowed, false);
  assert.equal(oq!.limitingWindow, 'sevenDay');

  assert.deepEqual(r.events().map((e) => e.event), ['c', 'b', 'a']);
  assert.deepEqual(r.events({ level: 'error' }).map((e) => e.event), ['b']);
  assert.deepEqual(r.events({ level: 'error' })[0]!.data, { code: 429 });
  assert.deepEqual(r.events({ repo: REPO, limit: 1 }).map((e) => e.event), ['b']);
  assert.deepEqual(r.events({ since: at(2), until: at(3) }).map((e) => e.event), ['b']);
  assert.deepEqual(r.events({ item: 1 }).map((e) => e.event), ['b']);

  assert.deepEqual(r.outcomesFor(REPO, 7).map((o) => o.outcome), ['pr-opened', 'merged']);
  assert.deepEqual(r.outcomesFor(REPO, 8), []);
  ledger.close();
});

test('a read-only reader on the same directory sees the writer’s rows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-ro-'));
  const ledger = openLedger(dir, { mirrorJsonl: false });
  ledger.recordRun(run('w1', { item: 1 }));
  const ro = openLedgerReader(dir);
  assert.equal(ro.listRuns().rows.length, 1);
  ledger.recordRun(run('w2', { item: 2 }));
  assert.equal(ro.listRuns().rows.length, 2, 'WAL lets the reader see new commits');
  assert.throws(() => ro.db.exec("INSERT INTO events (ts, level, event) VALUES ('x', 'info', 'y')"), /readonly/);
  ro.close();
  ledger.close();
});
