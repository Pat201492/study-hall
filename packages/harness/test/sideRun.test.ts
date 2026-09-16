import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Usage } from '../src/contract.js';
import { isSideRole, sideRun, SIDE_ROLES } from '../src/ledger/sideRun.js';
import { PRICING_TABLE_VERSION } from '../src/pricing.js';

const usage: Usage = {
  inputTokens: 1_000, outputTokens: 2_000, cacheReadInputTokens: 30_000, cacheCreationInputTokens: 4_000, reasoningTokens: 0,
};

test('a planner turn banks an ordinary run row, so every existing reader counts it', () => {
  const r = sideRun({
    role: 'planner', provider: 'anthropic', harness: 'claude-code', usage,
    startedAt: 1_000, endedAt: 61_000, meter: 'subscription', model: 'claude-sonnet-5', repo: 'o/r', sessionId: 's1',
  });
  assert.equal(r.role, 'planner');
  assert.equal(r.item, 0, 'no board item: this is spend, not work on an issue');
  assert.equal(r.repo, 'o/r');
  assert.equal(r.durationMs, 60_000);
  assert.equal(r.inputTokens + r.outputTokens + r.cacheReadInputTokens + r.cacheCreationInputTokens + r.reasoningTokens, 37_000);
  assert.equal(r.warmMechanism, 'cold');
  assert.equal(r.pricingTableVersion, PRICING_TABLE_VERSION);
  assert.equal(r.stoppedBy, null);
  assert.equal(r.ts, r.endedAt, 'v1 compatibility: ts is the completion time');
});

test('a probe with no repo is attributed to no board rather than to a fake one', () => {
  const r = sideRun({ role: 'preflight', provider: 'anthropic', harness: 'claude-code', usage, startedAt: 0, endedAt: 500, meter: 'subscription' });
  assert.equal(r.repo, '-');
  assert.equal(r.turns, 1);
  assert.equal(r.notes, null);
});

test('these roles are filterable, which is how $/AC stays a figure about board work', () => {
  assert.deepEqual([...SIDE_ROLES], ['planner', 'preflight', 'judge']);
  assert.ok(isSideRole('planner') && isSideRole('preflight') && isSideRole('judge'));
  assert.ok(!isSideRole('task') && !isSideRole('review') && !isSideRole('fix'));
});

test('two rows never collide, because the id is minted per row', () => {
  const a = sideRun({ role: 'planner', provider: 'anthropic', harness: 'claude-code', usage, startedAt: 0, endedAt: 1, meter: 'subscription' });
  const b = sideRun({ role: 'planner', provider: 'anthropic', harness: 'claude-code', usage, startedAt: 0, endedAt: 1, meter: 'subscription' });
  assert.notEqual(a.runId, b.runId);
});
