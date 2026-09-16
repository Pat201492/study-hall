import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { QuotaObservation } from '@study-hall/harness/contract';
import { capacitySamples, estimateWindowCapacity, sustainableTokensPerHour, windowDurationMs } from '../src/windowCapacity.js';
import type { RateSample } from '../src/rateBudget.js';

const MIN = 60_000;
const RESET = 10_000_000;

const obs = (at: number, utilization: number, resetsAt = RESET): QuotaObservation => ({
  provider: 'anthropic', observedAt: at, source: 'stream', fiveHour: { utilization, resetsAt },
});
const spend = (at: number, tokens: number): RateSample => ({ at, tokens, usd: 0 });

test('capacity is tokens over the utilization delta, taken only from pairs that can carry the claim', () => {
  const observations = [obs(0, 0.10), obs(10 * MIN, 0.20), obs(20 * MIN, 0.30)];
  // 1 M tokens moved the window 10 points twice: a 10 M window.
  const samples = capacitySamples(observations, [spend(5 * MIN, 1_000_000), spend(15 * MIN, 1_000_000)]);
  assert.equal(samples.length, 2);
  assert.deepEqual(samples.map((s) => Math.round(s.implied)), [10_000_000, 10_000_000]);

  const e = estimateWindowCapacity(observations, [spend(5 * MIN, 1_000_000), spend(15 * MIN, 1_000_000)], 20 * MIN).fiveHour;
  assert.equal(e.tokens, 10_000_000);
  assert.equal(e.samples, 2);
  assert.equal(e.utilization, 0.30);
  assert.equal(e.impliedSpent, 3_000_000);
  assert.equal(e.remaining, 7_000_000);
  assert.equal(e.note, null);
  assert.equal(sustainableTokensPerHour(e), 2_000_000, 'a 10 M five-hour window affords 2 M an hour');
});

test('the median sets the estimate and the spread stays visible, so one cache-heavy run cannot move it', () => {
  const observations = [obs(0, 0.10), obs(10 * MIN, 0.20), obs(20 * MIN, 0.30), obs(30 * MIN, 0.40)];
  const s = [spend(5 * MIN, 1_000_000), spend(15 * MIN, 1_100_000), spend(25 * MIN, 5_000_000)];
  const e = estimateWindowCapacity(observations, s, 30 * MIN).fiveHour;
  assert.equal(e.tokens, 11_000_000, 'the median of 10 M, 11 M and 50 M');
  assert.equal(e.low, 10_000_000);
  assert.equal(e.high, 50_000_000);
  assert.match(e.note ?? '', /disagree by 5.0x/);
});

test('a rollover, a rounding-sized move, a long gap and an unexplained move are all refused', () => {
  // resetsAt changes: the second reading describes a different window instance.
  assert.equal(capacitySamples([obs(0, 0.80), obs(10 * MIN, 0.05, RESET + 1)], [spend(5 * MIN, 1_000_000)]).length, 0);
  // A one-point move is inside the rounding of the reported percentage.
  assert.equal(capacitySamples([obs(0, 0.10), obs(10 * MIN, 0.11)], [spend(5 * MIN, 1_000_000)]).length, 0);
  // Three hours apart: too much unbanked spend can hide in the gap.
  assert.equal(capacitySamples([obs(0, 0.10), obs(180 * MIN, 0.30)], [spend(5 * MIN, 1_000_000)]).length, 0);
  // The window moved and the ledger has nothing to explain it: no claim is made.
  assert.equal(capacitySamples([obs(0, 0.10), obs(10 * MIN, 0.30)], []).length, 0);
});

test('a window with no usable pair still reports itself, with the reason instead of a number', () => {
  const e = estimateWindowCapacity([obs(0, 0.42)], [], 1 * MIN).fiveHour;
  assert.equal(e.tokens, null);
  assert.equal(e.samples, 0);
  assert.equal(e.utilization, 0.42);
  assert.equal(e.impliedSpent, null);
  assert.match(e.note ?? '', /needs two readings/);
  assert.equal(sustainableTokensPerHour(e), null);
});

test('ledger spend is counted from the current window start, which is the reset minus the window length', () => {
  const observations = [obs(0, 0.10), obs(10 * MIN, 0.20)];
  // The five-hour window started 5 h before RESET; spend before that belongs to the previous one.
  const start = RESET - 5 * 60 * MIN;
  const e = estimateWindowCapacity(observations, [spend(start - MIN, 9_999), spend(5 * MIN, 1_000_000)], 20 * MIN).fiveHour;
  assert.equal(e.ledgerSpentThisWindow, 1_000_000, 'the older sample is in the previous window');
  assert.equal(e.resetsAt, RESET);
});

test('window lengths are known for the named windows and parsed for provider extras', () => {
  assert.equal(windowDurationMs('fiveHour'), 5 * 60 * 60_000);
  assert.equal(windowDurationMs('sevenDay'), 7 * 24 * 60 * 60_000);
  assert.equal(windowDurationMs('30d'), 30 * 24 * 60 * 60_000);
  assert.equal(windowDurationMs('12h'), 12 * 60 * 60_000);
  assert.equal(windowDurationMs('weekly_opus'), null, 'an unparseable name is not guessed at');
});

test('one sample is reported as an order of magnitude, not a number', () => {
  const e = estimateWindowCapacity([obs(0, 0.10), obs(10 * MIN, 0.20)], [spend(5 * MIN, 1_000_000)], 10 * MIN).fiveHour;
  assert.equal(e.tokens, 10_000_000);
  assert.equal(e.samples, 1);
  assert.equal(e.low, e.high);
  assert.match(e.note ?? '', /order of magnitude/);
});

test('a run is credited to the interval it burned in, not to the instant it ended', () => {
  // The case that made an estimate impossible in practice: the readings that
  // bracket an interval arrive on a run's own stream WHILE it runs, so the run
  // always ended after both of them. Bucketing by end time found no tokens to
  // explain any move, and every window reported "size unknown" forever.
  const observations = [obs(10 * MIN, 0.10), obs(20 * MIN, 0.20)];
  const run = { at: 30 * MIN, startedAt: 0, tokens: 3_000_000, usd: 0 };
  const samples = capacitySamples(observations, [run]);
  assert.equal(samples.length, 1, 'the run overlaps the interval even though it ended after it');
  // 10 of the run's 30 minutes fall inside the interval: a third of its spend.
  assert.equal(Math.round(samples[0].tokens), 1_000_000);
  assert.equal(Math.round(samples[0].implied), 10_000_000);
});

test('a run wholly inside the interval is counted exactly, and one wholly outside not at all', () => {
  const observations = [obs(0, 0.10), obs(20 * MIN, 0.20)];
  const inside = { at: 15 * MIN, startedAt: 5 * MIN, tokens: 1_000_000, usd: 0 };
  const before = { at: -1 * MIN, startedAt: -10 * MIN, tokens: 9_000_000, usd: 0 };
  const s = capacitySamples(observations, [before, inside]);
  assert.equal(s.length, 1);
  assert.equal(s[0].tokens, 1_000_000, 'the earlier run contributes nothing');
});

test('a sample with no start time keeps the old instant rule, so older ledger rows still work', () => {
  const observations = [obs(0, 0.10), obs(20 * MIN, 0.20)];
  const legacy: RateSample = { at: 10 * MIN, tokens: 1_000_000, usd: 0 };
  assert.equal(capacitySamples(observations, [legacy])[0].tokens, 1_000_000);
  const after: RateSample = { at: 30 * MIN, tokens: 1_000_000, usd: 0 };
  assert.equal(capacitySamples(observations, [after]).length, 0, 'and still falls outside when it ended later');
});
