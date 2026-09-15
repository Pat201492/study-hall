import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessPace, paceSamples, DEFAULT_PACE, type PaceSample } from '../src/windowPace.js';
import type { QuotaObservation } from '@study-hall/harness/contract';

const NOW = 1_700_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const ON = { enabled: true };

/** Utilization climbing linearly from `from` to `to` over the last `spanMin`. */
function ramp(from: number, to: number, spanMin: number, resetsAt: number, window = 'fiveHour', points = 6): PaceSample[] {
  return Array.from({ length: points }, (_, i) => ({
    at: NOW - spanMin * MIN + (i * spanMin * MIN) / (points - 1),
    window,
    utilization: from + ((to - from) * i) / (points - 1),
    resetsAt,
  }));
}

test('a lane burning fast enough to exhaust the window early is rested, and the reason names the window and how early', () => {
  // Half the five-hour window used with two hours left: affordable is 0.5 over
  // 2 h. Observed is 0.2 over 30 min — 1.6x affordable.
  const v = assessPace('anthropic', ramp(0.3, 0.5, 30, NOW + 2 * HOUR), NOW, ON);
  assert.equal(v.capped, true);
  assert.equal(v.limiting?.window, 'fiveHour');
  assert.equal(v.limiting?.utilization, 0.5);
  assert.ok(Math.abs(v.limiting!.ratio! - 1.6) < 0.01, `ratio ${v.limiting?.ratio}`);
  assert.ok(Math.abs(v.limiting!.projectedExhaustionAt! - (NOW + 75 * MIN)) < MIN, 'half the window at 0.2/30min lasts 75 more minutes');
  assert.match(v.reason ?? '', /5-hour window 50 % used and burning 1\.6x faster than it affords/);
  assert.match(v.reason ?? '', /run out 45 min before it resets/);
  assert.equal(v.note, null);
});

test('a lane burning slowly enough to last is never rested by this rule', () => {
  // Same 50 % used and two hours left, but only 0.05 in the last 30 minutes.
  const v = assessPace('anthropic', ramp(0.45, 0.5, 30, NOW + 2 * HOUR), NOW, ON);
  assert.equal(v.capped, false);
  assert.equal(v.limiting?.tooFast, false);
  assert.ok(v.limiting!.ratio! < 1, `ratio ${v.limiting?.ratio}`);
  assert.ok(v.limiting!.projectedExhaustionAt! > v.limiting!.resetsAt, 'it outlasts the window');
  assert.equal(v.reason, null);
});

test('the tolerance leaves room for a lumpy board: exactly affordable is fine, well over is not', () => {
  const affordable = ramp(0.375, 0.5, 30, NOW + 2 * HOUR); // 0.125 per 30 min = exactly 0.5 per 2 h
  assert.equal(assessPace('a', affordable, NOW, ON).capped, false);
  assert.ok(Math.abs(assessPace('a', affordable, NOW, ON).limiting!.ratio! - 1) < 0.01);
  // A tolerance of 1 rests at the same burn the default forgives.
  assert.equal(assessPace('a', affordable, NOW, { ...ON, tolerance: 1 }).capped, false, 'strictly greater than, so exactly affordable still passes');
  const slightly = ramp(0.36, 0.5, 30, NOW + 2 * HOUR);
  assert.equal(assessPace('a', slightly, NOW, { ...ON, tolerance: 1 }).capped, true);
  assert.equal(assessPace('a', slightly, NOW, ON).capped, false, 'the default 1.25 forgives a small burst');
  assert.equal(DEFAULT_PACE.tolerance, 1.25);
});

test('no observation, too short a span, or a window about to reset all yield "no verdict" — never permission', () => {
  const none = assessPace('anthropic', [], NOW, ON);
  assert.equal(none.capped, false);
  assert.equal(none.note, 'no usable window observation yet');

  // Two readings a minute apart can show any slope at all.
  const brief = assessPace('anthropic', ramp(0.1, 0.9, 1, NOW + 2 * HOUR), NOW, ON);
  assert.equal(brief.capped, false);
  assert.match(brief.note ?? '', /not enough evidence yet \(need 5 min/);
  assert.equal(brief.windows[0].slope, null, 'no slope is claimed from a one-minute span');

  // The tail of a window is noise.
  const ending = assessPace('anthropic', ramp(0.3, 0.99, 30, NOW + 2 * MIN), NOW, ON);
  assert.equal(ending.capped, false);
  assert.equal(ending.note, 'no usable window observation yet');

  // And off is off.
  const off = assessPace('anthropic', ramp(0.3, 0.9, 30, NOW + 2 * HOUR), NOW, {});
  assert.equal(off.capped, false);
  assert.equal(off.note, 'window pacing is off');
  assert.deepEqual(off.windows, []);
});

test('a window that rolled over is not read as a burn: samples before the drop describe a window that is gone', () => {
  // A real stream reports one value per window per moment: the old window's
  // readings all precede the new one's.
  const old = ramp(0.6, 0.95, 40, NOW - 20 * MIN, 'fiveHour', 4).map((s) => ({ ...s, at: s.at - 25 * MIN }));
  const fresh = ramp(0.02, 0.06, 20, NOW + 4 * HOUR, 'fiveHour', 4);
  const v = assessPace('anthropic', [...old, ...fresh], NOW, ON);
  assert.equal(v.capped, false, 'the slope is measured within the new window only');
  assert.equal(v.limiting?.utilization, 0.06);
  assert.ok(v.limiting!.slope! < 0.0001);
});

test('the fastest-burning window binds, and every judged window is reported', () => {
  const five = ramp(0.2, 0.3, 30, NOW + 4 * HOUR); // plenty of room
  const week = ramp(0.80, 0.95, 30, NOW + 6 * HOUR, 'sevenDay'); // nearly gone, climbing
  const v = assessPace('anthropic', [...five, ...week], NOW, ON);
  assert.equal(v.capped, true);
  assert.equal(v.limiting?.window, 'sevenDay');
  assert.match(v.reason ?? '', /7-day window 95 % used/);
  assert.deepEqual(v.windows.map((w) => w.window).sort(), ['fiveHour', 'sevenDay']);
  assert.equal(v.windows.find((w) => w.window === 'fiveHour')!.tooFast, false);
});

test('paceSamples flattens observations, including provider-specific extra windows, and drops unusable ones', () => {
  const obs: QuotaObservation[] = [
    { provider: 'anthropic', observedAt: NOW - 10 * MIN, source: 'stream', fiveHour: { utilization: 0.4, resetsAt: NOW + HOUR }, sevenDay: { utilization: 0.2, resetsAt: NOW + 50 * HOUR } },
    { provider: 'openai', observedAt: NOW, source: 'app-server', extra: { '30d': { utilization: 0.1, resetsAt: NOW + 500 * HOUR } } },
    { provider: 'anthropic', observedAt: Number.NaN, source: 'stream', fiveHour: { utilization: 0.9, resetsAt: NOW } },
    { provider: 'anthropic', observedAt: NOW, source: 'stream' },
  ];
  const s = paceSamples(obs);
  assert.deepEqual(s.map((x) => x.window), ['fiveHour', 'sevenDay', '30d']);
  assert.equal(s[0].utilization, 0.4);
  assert.equal(s[2].window, '30d');
  assert.deepEqual(paceSamples([]), []);
});

test('a window with no headroom left and any burn at all is an infinite ratio, not a divide-by-zero', () => {
  const v = assessPace('anthropic', ramp(0.98, 1, 30, NOW + HOUR), NOW, ON);
  assert.equal(v.capped, true);
  assert.equal(v.limiting?.ratio, Infinity);
  assert.match(v.reason ?? '', /with no headroom left/);
});
