import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateDelayMinutes, fmtDelay, scheduleRestoreAction, MAX_DELAY_MIN, GRACE_MS,
} from '../src/schedule.js';

// ---- validateDelayMinutes ---------------------------------------------------
// The field is a free-text number input, so every one of these is reachable by
// typing into it.

test('a positive delay converts to milliseconds', () => {
  const r = validateDelayMinutes(420);
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.ms, 420 * 60_000);
});

test('zero, negative, and non-numeric delays are all rejected', () => {
  for (const bad of [0, -1, NaN, Infinity, -Infinity]) {
    const r = validateDelayMinutes(bad);
    assert.equal(r.ok, false, `${bad} should be rejected`);
  }
});

test('the cap is inclusive at exactly 24h and rejects one minute past it', () => {
  assert.equal(validateDelayMinutes(MAX_DELAY_MIN).ok, true);
  assert.equal(validateDelayMinutes(MAX_DELAY_MIN + 1).ok, false);
});

test('a fractional delay rounds to whole milliseconds', () => {
  const r = validateDelayMinutes(1.5);
  assert.equal(r.ok && r.ms, 90_000);
});

// ---- fmtDelay ---------------------------------------------------------------

test('delays read as hours and minutes past the hour mark', () => {
  assert.equal(fmtDelay(45), '45m');
  assert.equal(fmtDelay(60), '1h 0m');
  assert.equal(fmtDelay(420), '7h 0m');
  assert.equal(fmtDelay(425), '7h 5m');
});

// ---- scheduleRestoreAction --------------------------------------------------
// The decision made against a schedule file found on disk at boot. Firing a
// stale one starts a real pool and spends plan usage, so the boundaries matter.

const NOW = 1_800_000_000_000;

test('a schedule still in the future is re-armed at its original time', () => {
  const at = NOW + 60_000;
  assert.deepEqual(scheduleRestoreAction(at, NOW), { kind: 'arm', at });
});

test('a schedule missed inside the grace window fires immediately', () => {
  const a = scheduleRestoreAction(NOW - 60_000, NOW);
  assert.equal(a.kind, 'fire');
  assert.equal(a.kind === 'fire' && a.lateMs, 60_000);
});

test('a schedule missed past the grace window is discarded, not fired late', () => {
  const a = scheduleRestoreAction(NOW - 90 * 60_000, NOW);
  assert.equal(a.kind, 'discard');
  assert.equal(a.kind === 'discard' && a.lateMs, 90 * 60_000);
});

test('the grace boundary fires at exactly GRACE_MS and discards one ms later', () => {
  assert.equal(scheduleRestoreAction(NOW - GRACE_MS, NOW).kind, 'fire');
  assert.equal(scheduleRestoreAction(NOW - GRACE_MS - 1, NOW).kind, 'discard');
});

test('a schedule due this exact millisecond arms rather than fires', () => {
  // lateMs === 0 is not "missed" — the timer just resolves to a zero delay.
  assert.deepEqual(scheduleRestoreAction(NOW, NOW), { kind: 'arm', at: NOW });
});

test('an unreadable or absent timestamp is invalid, never a start', () => {
  for (const bad of [undefined, null, 0, -1, 'soon', NaN, {}, []]) {
    assert.equal(scheduleRestoreAction(bad, NOW).kind, 'invalid', `${JSON.stringify(bad)} should be invalid`);
  }
});
