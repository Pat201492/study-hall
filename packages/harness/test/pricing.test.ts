import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ZERO_USAGE, type Usage } from '../src/contract.js';
import {
  PRICES, PRICING_TABLE_VERSION, cacheHitPct, estimateCost, priceFor, tierOf, tokensProcessed,
} from '../src/pricing.js';

const u = (partial: Partial<Usage>): Usage => ({ ...ZERO_USAGE, ...partial });

test('estimateCost charges the list rate for plain input/output tokens', () => {
  const r = estimateCost('anthropic', 'claude-sonnet-5', u({ inputTokens: 1_000_000 }));
  assert.equal(r.usd, 3);
  assert.equal(r.basis, 'list');
  assert.equal(r.tableVersion, PRICING_TABLE_VERSION);
  assert.equal(estimateCost('anthropic', 'claude-sonnet-5', u({ outputTokens: 1_000_000 })).usd, 15);
});

test('cache reads are discounted well below base input price (0.1x)', () => {
  const { usd } = estimateCost('anthropic', 'claude-opus-4-8', u({ cacheReadInputTokens: 1_000_000 }));
  assert.ok(usd < 5, `cache reads should be cheaper than base input rate, got ${usd}`);
  assert.equal(usd, 0.5);
});

test('cache writes carry a premium over base input price (1.25x)', () => {
  const { usd } = estimateCost('anthropic', 'claude-haiku-4-5', u({ cacheCreationInputTokens: 1_000_000 }));
  assert.equal(usd, 1.25);
});

test('sums all five token categories, with reasoning billed as output', () => {
  const { usd } = estimateCost('anthropic', 'claude-sonnet-5', u({
    inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 200, cacheCreationInputTokens: 10, reasoningTokens: 40,
  }));
  const expected = (100 * 3 + (50 + 40) * 15 + 10 * 3 * 1.25 + 200 * 3 * 0.1) / 1_000_000;
  assert.ok(Math.abs(usd - expected) < 1e-12, `got ${usd}, expected ${expected}`);
  // And reasoning alone is priced exactly like output.
  assert.equal(
    estimateCost('anthropic', 'claude-sonnet-5', u({ reasoningTokens: 1_000_000 })).usd,
    estimateCost('anthropic', 'claude-sonnet-5', u({ outputTokens: 1_000_000 })).usd,
  );
});

// The arena must not trust the OpenAI figures: they are placeholders until a
// published price is entered, and every row priced off them says so.
test('OpenAI entries are placeholders and price with basis "estimate"', () => {
  for (const [model, price] of Object.entries(PRICES.openai!)) {
    assert.equal(price.estimate, true, `${model} must be flagged estimate`);
  }
  const r = estimateCost('openai', 'gpt-5.6-terra', u({ inputTokens: 1_000_000 }));
  assert.equal(r.usd, 2);
  assert.equal(r.basis, 'estimate');
  assert.equal(estimateCost('openai', 'gpt-5.6-sol', u({ outputTokens: 1_000_000 })).usd, 20);
  assert.equal(estimateCost('openai', 'gpt-5.6-luna', u({ inputTokens: 1_000_000 })).usd, 1);
  assert.equal(estimateCost('openai', 'gpt-6-astra', u({ outputTokens: 1_000_000 })).usd, 40);
});

test('Anthropic list entries are not flagged as estimates', () => {
  for (const [model, price] of Object.entries(PRICES.anthropic!)) {
    assert.ok(!price.estimate, `${model} is a list price`);
  }
});

// A typo'd model id must not make a lane look free: "unknown" is its own basis.
test('an unknown model or provider prices to 0 with basis "none"', () => {
  const big = u({ inputTokens: 1_000_000, outputTokens: 1_000_000 });
  assert.deepEqual(estimateCost('anthropic', 'claude-nonesuch-9', big), { usd: 0, basis: 'none', tableVersion: PRICING_TABLE_VERSION });
  assert.equal(estimateCost('gemini', 'gemini-3-pro', big).basis, 'none');
  assert.equal(estimateCost('anthropic', undefined, big).basis, 'none');
  assert.equal(estimateCost('anthropic', '', big).basis, 'none');
});

test('a dated or suffixed model id resolves through its prefix pattern', () => {
  const dated = estimateCost('anthropic', 'claude-opus-4-8-20260401', u({ inputTokens: 1_000_000 }));
  const bare = estimateCost('anthropic', 'claude-opus-4-8', u({ inputTokens: 1_000_000 }));
  assert.equal(dated.usd, bare.usd);
  assert.equal(dated.basis, 'list');
  assert.equal(priceFor('anthropic', 'CLAUDE-SONNET-5')?.input, 3);
  assert.equal(priceFor('anthropic', 'claude'), undefined, 'a bare family name matches nothing');
});

test('local models are a real zero, not an unknown', () => {
  const r = estimateCost('local', 'qwen3-coder:30b', u({
    inputTokens: 5_000_000, outputTokens: 1_000_000, cacheReadInputTokens: 9_000_000, cacheCreationInputTokens: 1, reasoningTokens: 7,
  }));
  assert.equal(r.usd, 0);
  assert.equal(r.basis, 'list');
});

// v1 #25 — subscription plan-usage proxies.

test('tokensProcessed counts fresh input + output + cache read (not cache write or reasoning)', () => {
  assert.equal(tokensProcessed(u({
    inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 200, cacheCreationInputTokens: 10, reasoningTokens: 40,
  })), 350);
});

test('cacheHitPct is cache read over all input the model saw', () => {
  // read 800 / (input 100 + read 800 + write 100) = 80%
  assert.equal(cacheHitPct(u({ inputTokens: 100, outputTokens: 999, cacheReadInputTokens: 800, cacheCreationInputTokens: 100 })), 80);
});

test('cacheHitPct is 0 when the model saw no input', () => {
  assert.equal(cacheHitPct(u({ outputTokens: 500 })), 0);
});

test('tierOf maps claude models onto the legacy tiers and nothing else', () => {
  assert.equal(tierOf('claude-opus-4-8'), 'opus');
  assert.equal(tierOf('claude-sonnet-5'), 'sonnet');
  assert.equal(tierOf('claude-haiku-4-5'), 'haiku');
  assert.equal(tierOf('Claude-Opus-4-8[1m]'), 'opus');
  assert.equal(tierOf('gpt-5.6-terra'), undefined);
  assert.equal(tierOf(null), undefined);
});
