import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Throttle, DEFAULT_THROTTLE_CONFIG } from '../src/throttle.js';

// #178: shrink effective parallelism while the board thrashes (resolves +
// re-dispatches), restore it once merges stop conflicting. Pure ladder.

test('starts at the configured ceiling and never exceeds it', () => {
  const t = new Throttle(6);
  assert.equal(t.limit(), 6);
  assert.equal(t.configured(), 6);
  // A clean streak past recovery cannot push it above the ceiling.
  for (let i = 0; i < 10; i++) t.observe(0);
  assert.equal(t.limit(), 6);
  assert.equal(t.isThrottled(), false);
});

test('a thrashing tick shrinks the effective cap, never below 1', () => {
  const t = new Throttle(6, { contentionThreshold: 1, recoverTicks: 3 });
  t.observe(2); assert.equal(t.limit(), 5); // 2 > threshold 1 -> shrink
  t.observe(3); assert.equal(t.limit(), 4);
  for (let i = 0; i < 10; i++) t.observe(5);
  assert.equal(t.limit(), 1);              // floored at 1
  assert.equal(t.isThrottled(), true);
});

// The acceptance: a board where every merge triggers a resolve settles LOWER
// within a few ticks and recovers once merges stop conflicting.
test('settles low under sustained thrash, then recovers when it clears (acceptance)', () => {
  const t = new Throttle(6, { contentionThreshold: 1, recoverTicks: 3 });
  // Every merge triggers a resolve + a re-dispatch: contention 2 each tick.
  for (let i = 0; i < 4; i++) t.observe(2);
  assert.equal(t.limit(), 2, 'settles to a low cap within a few ticks');
  // Merges stop conflicting — clean ticks restore parallelism one step per
  // recoverTicks clean ticks.
  for (let i = 0; i < 3; i++) t.observe(0);
  assert.equal(t.limit(), 3);
  for (let i = 0; i < 3; i++) t.observe(0);
  assert.equal(t.limit(), 4);
});

test('an isolated resolve (at threshold) does not throttle', () => {
  const t = new Throttle(6, { contentionThreshold: 1, recoverTicks: 3 });
  t.observe(1); // == threshold, not >
  assert.equal(t.limit(), 6);
});

test('low-but-nonzero contention holds steady and blocks recovery', () => {
  const t = new Throttle(6, { contentionThreshold: 2, recoverTicks: 2 });
  t.observe(3); assert.equal(t.limit(), 5);   // shrink
  t.observe(1); assert.equal(t.limit(), 5);   // 1 <= threshold, no shrink...
  t.observe(1); assert.equal(t.limit(), 5);   // ...and never recovers (not clean)
  t.observe(0); t.observe(0); assert.equal(t.limit(), 6); // two clean ticks recover
});

test('lowering the ceiling clamps immediately; raising it recovers gradually', () => {
  const t = new Throttle(6);
  t.setCeiling(3);
  assert.equal(t.limit(), 3);          // clamped down at once
  t.setCeiling(6);
  assert.equal(t.limit(), 3);          // raised ceiling does NOT jump back up
  for (let i = 0; i < DEFAULT_THROTTLE_CONFIG.recoverTicks; i++) t.observe(0);
  assert.equal(t.limit(), 4);          // steps up one clean streak at a time
});
