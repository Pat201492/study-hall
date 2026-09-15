import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseHhMm, minutesOfDay, inWindow, inBlackout, minutesUntilOpen, DEFAULT_BLACKOUT,
} from '../src/blackout.js';

// 95 CLI segfaults fell in two one-hour bursts, both in the 22:00 local hour on
// consecutive nights. No scheduled task fires then and the crash is
// unreproducible, so this is a mitigation, not a fix: give up an hour of
// dispatch, lose the only window in which the board has destroyed itself.

const at = (h: number, m = 0): Date => { const d = new Date(2026, 7, 23, h, m, 0); return d; };

test('parses HH:MM and rejects nonsense', () => {
  assert.equal(parseHhMm('22:00'), 22 * 60);
  assert.equal(parseHhMm('9:05'), 9 * 60 + 5);
  assert.equal(parseHhMm('00:00'), 0);
  for (const bad of ['', 'x', '24:00', '22:60', '2200', '22:0']) assert.equal(parseHhMm(bad), null, bad);
});

test('minutesOfDay reads local wall clock', () => {
  assert.equal(minutesOfDay(at(22, 30)), 22 * 60 + 30);
});

// Half-open on purpose: a 22:00-23:00 window that is still closed AT 23:00 lasts
// a minute longer every day.
test('the window is half-open', () => {
  const from = 22 * 60, to = 23 * 60;
  assert.equal(inWindow(from, from, to), true, 'open at the start');
  assert.equal(inWindow(to - 1, from, to), true);
  assert.equal(inWindow(to, from, to), false, 'closed exactly at the end');
});

test('a window may wrap midnight', () => {
  const from = 22 * 60, to = 2 * 60;
  assert.equal(inWindow(23 * 60, from, to), true);
  assert.equal(inWindow(1 * 60, from, to), true);
  assert.equal(inWindow(3 * 60, from, to), false);
});

// A typo must not be able to stop the board forever.
test('an empty or unparseable window never blacks out', () => {
  assert.equal(inWindow(500, 600, 600), false, 'from === to is empty, not "always"');
  assert.equal(inBlackout(at(22, 30), { enabled: true, from: 'nonsense', to: '23:00' }), false);
  assert.equal(inBlackout(at(22, 30), { enabled: true, from: '22:00', to: '25:00' }), false);
});

test('disabled means never', () => {
  assert.equal(inBlackout(at(22, 30), { ...DEFAULT_BLACKOUT, enabled: false }), false);
});

test('the default window covers the hour the crashes fell in', () => {
  assert.equal(inBlackout(at(21, 59), DEFAULT_BLACKOUT), false);
  assert.equal(inBlackout(at(22, 0), DEFAULT_BLACKOUT), true);
  assert.equal(inBlackout(at(22, 59), DEFAULT_BLACKOUT), true);
  assert.equal(inBlackout(at(23, 0), DEFAULT_BLACKOUT), false);
});

test('it reports how long is left, including across midnight', () => {
  assert.equal(minutesUntilOpen(at(22, 15), DEFAULT_BLACKOUT), 45);
  assert.equal(minutesUntilOpen(at(12, 0), DEFAULT_BLACKOUT), 0, 'not blacked out = 0');
  assert.equal(minutesUntilOpen(at(23, 30), { enabled: true, from: '22:00', to: '02:00' }), 150);
});

// The window is LOCAL wall clock by design — the operator's rule ("22:00-23:00")
// is stated in local time, and the log now prints UTC with an explicit Z so the
// two are never confused for each other (see logger.ts).
test('the window is judged on local wall clock, not UTC', () => {
  const local = at(22, 30);
  assert.equal(inBlackout(local, DEFAULT_BLACKOUT), true);
  // The same instant read as UTC would usually fall in a different hour; the
  // decision must follow getHours(), whatever the zone offset is.
  assert.equal(minutesOfDay(local), local.getHours() * 60 + local.getMinutes());
});

// (v1 also pinned config-merge behaviour via loadConfig — config.ts is not in
// core — and the runner's hold-don't-kill stance via a regex over live.ts. The
// latter is a Governance-unit behaviour in v2 and is tested there.)
