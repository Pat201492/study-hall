import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timestamp, log } from '../src/logger.js';
import { minutesOfDay } from '../src/blackout.js';

// v1's logger printed `toISOString()` with the T swapped for a space and the Z
// sliced off — a UTC instant that LOOKED like a local wall-clock time. Every
// operational rule (blackout window, capacity reset, the 22:00 crash hour) is
// local, so reading the log needed an undocumented 4-hour mental conversion.
// The fix is one character: keep the Z.

test('timestamps are UTC and say so with an explicit Z', () => {
  const d = new Date(Date.UTC(2026, 7, 22, 2, 17, 37, 123));
  assert.equal(timestamp(d), '2026-08-22T02:17:37Z');
});

test('the T separator and the Z are never dropped (the v1 trap)', () => {
  const s = timestamp();
  assert.match(s, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.doesNotMatch(s, / /, 'a space in place of the T is what made UTC read as local');
});

test('the blackout window, by contrast, is local wall clock', () => {
  // Same instant, two clocks: the log line carries the UTC hour, the blackout
  // decision the local one. They differ by the zone offset and the code must
  // not pretend otherwise.
  const d = new Date(2026, 7, 22, 22, 0, 0); // 22:00 LOCAL
  assert.equal(minutesOfDay(d), 22 * 60);
  const utcMinutes = d.getUTCHours() * 60 + d.getUTCMinutes();
  assert.equal(utcMinutes, (22 * 60 + d.getTimezoneOffset() + 24 * 60) % (24 * 60));
  assert.match(timestamp(d), /Z$/);
});

test('every log level prefixes the same UTC stamp', () => {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (m: string) => { lines.push(m); };
  try {
    log.info('a'); log.ok('b'); log.warn('c'); log.err('d'); log.step('e');
  } finally {
    console.log = orig;
  }
  assert.equal(lines.length, 5);
  for (const l of lines) assert.match(l, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/);
});
