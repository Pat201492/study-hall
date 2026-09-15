import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveTaskParams, effectiveConcurrency } from '../src/optimizer.js';
import type { Tier } from '../src/tiers.js';

const TIERS: Tier[] = ['haiku', 'sonnet', 'opus'];

// ---- toggle -> derived (model, effort, fast_mode, warm_count) mapping -----

test('speed mode escalates every unpinned tier to opus, xhigh effort, fast-mode on', () => {
  for (const tier of TIERS) {
    const d = deriveTaskParams({ tier, mode: 'speed', baseWarmCount: 4 });
    assert.equal(d.model, 'opus');
    assert.equal(d.effort, 'xhigh');
    assert.equal(d.fastMode, true);
    assert.equal(d.warmCount, 4, 'speed keeps the full warm count (more parallel)');
  }
});

test('token mode never escalates tier, low effort, fast-mode off', () => {
  for (const tier of TIERS) {
    const d = deriveTaskParams({ tier, mode: 'token', baseWarmCount: 4 });
    assert.equal(d.model, tier, 'token leaves the task at its own (already-cheap) tier');
    assert.equal(d.effort, 'low');
    assert.equal(d.fastMode, false);
    assert.equal(d.warmCount, 2, 'token halves the warm count (fewer parallel)');
  }
});

test('a pinned task keeps its tier even in speed mode', () => {
  const d = deriveTaskParams({ tier: 'haiku', mode: 'speed', pinned: true, baseWarmCount: 4 });
  assert.equal(d.model, 'haiku');
  assert.equal(d.fastMode, false, 'fast-mode only applies to the opus tier');
});

test('a pinned task is unaffected in token mode (already identity)', () => {
  const d = deriveTaskParams({ tier: 'opus', mode: 'token', pinned: true, baseWarmCount: 4 });
  assert.equal(d.model, 'opus');
  assert.equal(d.effort, 'low');
  assert.equal(d.fastMode, false);
});

test('warm_count never drops below 1 even with a tiny base', () => {
  assert.equal(deriveTaskParams({ tier: 'haiku', mode: 'token', baseWarmCount: 1 }).warmCount, 1);
  assert.equal(deriveTaskParams({ tier: 'haiku', mode: 'token', baseWarmCount: 0 }).warmCount, 1);
  assert.equal(deriveTaskParams({ tier: 'haiku', mode: 'speed', baseWarmCount: 0 }).warmCount, 1);
});

test('warm_count rounds token mode up (odd base counts still get a worker)', () => {
  assert.equal(deriveTaskParams({ tier: 'haiku', mode: 'token', baseWarmCount: 3 }).warmCount, 2);
  assert.equal(deriveTaskParams({ tier: 'haiku', mode: 'token', baseWarmCount: 5 }).warmCount, 3);
});

// ---- effectiveConcurrency (the scalar tick() uses to gate parallelism) ----

test('effectiveConcurrency: speed keeps the configured max, token roughly halves it', () => {
  assert.equal(effectiveConcurrency('speed', 6), 6);
  assert.equal(effectiveConcurrency('token', 6), 3);
  assert.equal(effectiveConcurrency('speed', 1), 1);
  assert.equal(effectiveConcurrency('token', 1), 1, 'never scales below 1');
});

test('effectiveConcurrency: an explicit override pins concurrency, ignoring the objective', () => {
  assert.equal(effectiveConcurrency('token', 2, 3), 3, 'override beats the token halving');
  assert.equal(effectiveConcurrency('speed', 8, 2), 2, 'override caps below the speed max');
  assert.equal(effectiveConcurrency('token', 4, 0), 2, '0 = auto (falls back to token halving)');
  assert.equal(effectiveConcurrency('speed', 4, undefined), 4, 'undefined = auto (speed max)');
  assert.equal(effectiveConcurrency('token', 6, 2.9), 2, 'override floors to an int, min 1');
});
