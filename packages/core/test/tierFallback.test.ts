import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effectiveTier } from '../src/tierFallback.js';

const P = (h: number, s: number, o: number) => ({
  haiku: { model: 'claude-haiku-4-5', maxWarm: h },
  sonnet: { model: 'claude-sonnet-5', maxWarm: s },
  opus: { model: 'claude-opus-4-8', maxWarm: o },
});

test('an enabled tier is used as-is', () => {
  assert.equal(effectiveTier('haiku', P(2, 4, 2)), 'haiku');
  assert.equal(effectiveTier('sonnet', P(2, 4, 2)), 'sonnet');
  assert.equal(effectiveTier('opus', P(2, 4, 2)), 'opus');
});

test('0 haiku warm routes haiku work up to sonnet', () => {
  assert.equal(effectiveTier('haiku', P(0, 4, 2)), 'sonnet');
});

test('0 haiku AND 0 sonnet routes haiku up to opus', () => {
  assert.equal(effectiveTier('haiku', P(0, 0, 2)), 'opus');
});

test('a disabled top tier falls back DOWN to the nearest enabled', () => {
  assert.equal(effectiveTier('opus', P(2, 4, 0)), 'sonnet');
  assert.equal(effectiveTier('opus', P(2, 0, 0)), 'haiku');
});

test('a disabled middle tier prefers upward (opus) over downward', () => {
  assert.equal(effectiveTier('sonnet', P(2, 0, 2)), 'opus', 'up-first when both sides enabled');
  assert.equal(effectiveTier('sonnet', P(2, 0, 0)), 'haiku', 'falls down when nothing above');
});

test('nothing enabled -> original tier unchanged (degenerate, no crash)', () => {
  assert.equal(effectiveTier('sonnet', P(0, 0, 0)), 'sonnet');
});
