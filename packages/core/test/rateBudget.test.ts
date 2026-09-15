import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessRate, billedTokens, hasCap, resolveLimit, suggestTokensPerHour, RateTracker, DEFAULT_WINDOW_MS, type RateSample } from '../src/rateBudget.js';

const NOW = 1_700_000_000_000;
const MIN = 60_000;
const sample = (minutesAgo: number, tokens: number, usd = 0): RateSample => ({ at: NOW - minutesAgo * MIN, tokens, usd });
const CAP = { tokensPerHour: 1_000_000, headroom: 1 };

test('billed tokens count every charged bucket, including cache writes and separately-reported reasoning', () => {
  assert.equal(billedTokens({ inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 1000, cacheCreationInputTokens: 500, reasoningTokens: 40 }), 1650);
  // Claude folds thinking into output and reports 0 reasoning: nothing is double-counted.
  assert.equal(billedTokens({ inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, reasoningTokens: 0 }), 3);
});

test('spend outside the window does not count, and an uncapped provider is never rested', () => {
  const samples = [sample(90, 900_000), sample(30, 100_000)];
  const v = assessRate('anthropic', samples, [], CAP, NOW);
  assert.equal(v.tokens.spent, 100_000, 'the 90-minute-old sample aged out of the hour');
  assert.equal(v.capped, false);
  assert.equal(v.tokens.utilization, 0.1);
  const uncapped = assessRate('anthropic', samples, [], undefined, NOW);
  assert.equal(uncapped.capped, false);
  assert.equal(uncapped.tokens.cap, null);
  assert.equal(uncapped.tokens.utilization, null);
  assert.equal(hasCap(undefined), false);
  assert.equal(hasCap({ tokensPerHour: 0 }), false);
  assert.equal(hasCap({ tokensPerHour: 1 }), true);
  assert.equal(hasCap({ usdPerHour: 2 }), true);
});

test('crossing the cap rests the provider and names the binding limit', () => {
  const v = assessRate('anthropic', [sample(50, 600_000), sample(10, 500_000)], [], CAP, NOW);
  assert.equal(v.capped, true);
  assert.equal(v.tokens.spent, 1_100_000);
  assert.match(v.reason ?? '', /1100k tokens in the last 60 min \(cap 1000k/);
  assert.equal(v.provider, 'anthropic');
});

test('headroom stops NEW dispatch before the cap, so one run cannot overshoot far', () => {
  const samples = [sample(10, 910_000)];
  assert.equal(assessRate('a', samples, [], { tokensPerHour: 1_000_000, headroom: 1 }, NOW).capped, false);
  const withHeadroom = assessRate('a', samples, [], { tokensPerHour: 1_000_000, headroom: 0.9 }, NOW);
  assert.equal(withHeadroom.capped, true);
  assert.match(withHeadroom.reason ?? '', /dispatch stops at 90 %/);
  assert.equal(resolveLimit({}).headroom, 0.9, 'the default reserves a slice');
  assert.equal(resolveLimit({ headroom: 2 }).headroom, 0.9, 'a nonsense headroom falls back');
  assert.equal(resolveLimit({}).windowMs, DEFAULT_WINDOW_MS);
});

test('resumesAt is computed from when spend ages out, not guessed', () => {
  // 600k at 50 min ago + 500k at 10 min ago = 1.1M over a 1M cap. Dropping the
  // first brings it to 500k, so dispatch resumes an hour after that sample.
  const v = assessRate('a', [sample(50, 600_000), sample(10, 500_000)], [], CAP, NOW);
  assert.equal(v.resumesAt, NOW - 50 * MIN + DEFAULT_WINDOW_MS);
  assert.equal(v.resumesAt! - NOW, 10 * MIN, 'ten minutes from now');
  // Only as many samples as it takes: 600k + 600k + 100k = 1.3M, and dropping
  // just the oldest 600k already brings it to 700k, under the 1M cap.
  const two = assessRate('a', [sample(55, 600_000), sample(50, 600_000), sample(5, 100_000)], [], CAP, NOW);
  assert.equal(two.resumesAt, NOW - 55 * MIN + DEFAULT_WINDOW_MS);
  assert.equal(two.resumesAt! - NOW, 5 * MIN);
});

test('in-flight spend counts immediately and never expires, so a burning fleet rests the lane now', () => {
  const inFlight = [{ at: NOW, tokens: 1_200_000, usd: 0 }];
  const v = assessRate('a', [], inFlight, CAP, NOW);
  assert.equal(v.capped, true);
  assert.equal(v.inFlightTokens, 1_200_000);
  assert.equal(v.resumesAt, null, 'nothing can age out: it resumes when those runs finish');
});

test('a $ cap binds independently of the token cap', () => {
  const samples = [sample(10, 1000, 12)];
  const v = assessRate('openai', samples, [], { tokensPerHour: 1_000_000, usdPerHour: 10 }, NOW);
  assert.equal(v.capped, true);
  assert.match(v.reason ?? '', /\$12\.00 in the last 60 min \(cap \$10\.00\)/);
  assert.equal(v.usd.utilization, 1.2);
  assert.ok((v.tokens.utilization ?? 1) < 0.01, 'the token cap is nowhere near binding — the $ cap is what rested it');
});

test('a custom window is honoured end to end', () => {
  const limit = { tokensPerHour: 100_000, windowMs: 15 * MIN, headroom: 1 };
  const samples = [sample(20, 90_000), sample(5, 50_000)];
  const v = assessRate('a', samples, [], limit, NOW);
  assert.equal(v.tokens.spent, 50_000, 'only the last 15 minutes count');
  assert.equal(v.windowMs, 15 * MIN);
  assert.equal(v.capped, false);
  assert.match(assessRate('a', [sample(5, 150_000)], [], limit, NOW).reason ?? '', /last 15 min/);
});

// ---- the tracker the engine keeps ---------------------------------------------------

test('the tracker never double-counts: live spend is replaced, then committed once', () => {
  let clock = NOW;
  const t = new RateTracker('anthropic', CAP, () => clock);
  t.seed([sample(30, 200_000)]);
  assert.equal(t.assess(clock).tokens.spent, 200_000);

  // Cumulative usage events for one run: the newest replaces the older.
  t.live('run-1', { tokens: 100_000, usd: 0 });
  t.live('run-1', { tokens: 300_000, usd: 0 });
  assert.equal(t.assess(clock).tokens.spent, 500_000, '200k committed + 300k live, not 600k');

  // The run finishes: the live entry becomes exactly one committed sample.
  t.commit('run-1', { at: clock, tokens: 320_000, usd: 1 });
  assert.equal(t.assess(clock).tokens.spent, 520_000);
  assert.equal(t.assess(clock).inFlightTokens, 0);

  // A second run that spends nothing and fails is dropped, not counted.
  t.live('run-2', { tokens: 50_000, usd: 0 });
  assert.equal(t.assess(clock).tokens.spent, 570_000);
  t.drop('run-2');
  assert.equal(t.assess(clock).tokens.spent, 520_000);

  // An hour later everything has aged out.
  clock = NOW + 61 * MIN;
  assert.equal(t.assess(clock).tokens.spent, 0);
  assert.equal(t.assess(clock).capped, false);
});

test('the tracker rests and resumes across the window, and a raised cap lifts the rest at once', () => {
  let clock = NOW;
  const t = new RateTracker('anthropic', { tokensPerHour: 500_000, headroom: 1 }, () => clock);
  t.commit('a', { at: clock, tokens: 600_000, usd: 0 });
  assert.equal(t.assess(clock).capped, true);
  assert.equal(t.assess(clock).resumesAt, clock + DEFAULT_WINDOW_MS);

  // Raising the cap is the operator's override: no waiting on a reset.
  t.setLimit({ tokensPerHour: 2_000_000, headroom: 1 });
  assert.equal(t.assess(clock).capped, false);

  // Lower it again and let the window roll forward instead.
  t.setLimit({ tokensPerHour: 500_000, headroom: 1 });
  assert.equal(t.assess(clock).capped, true);
  clock = NOW + 61 * MIN;
  assert.equal(t.assess(clock).capped, false);
  assert.equal(t.enabled, true);
  t.setLimit(undefined);
  assert.equal(t.enabled, false);
  assert.equal(t.assess(clock).capped, false);
});

test('the suggestion is the median of the busiest recent hours, or null with no history', () => {
  const hours = [1, 2, 3, 4].flatMap((h) => [{ at: NOW - h * 60 * MIN, tokens: h * 100_000, usd: 0 }]);
  assert.equal(suggestTokensPerHour(hours, NOW), 250_000);
  assert.equal(suggestTokensPerHour([], NOW), null);
  assert.equal(suggestTokensPerHour([{ at: NOW - 30 * 24 * 60 * MIN, tokens: 999, usd: 0 }], NOW), null, 'older than the lookback');
});
