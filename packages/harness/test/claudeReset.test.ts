import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCapacityReset, MAX_RESET_WAIT_MS, RESET_MARGIN_MS } from '../src/adapters/claudeReset.js';

// The CLI states when a plan limit clears; nothing read it, so the v1 runner
// poked the limit every five minutes instead. Between 2026-08-12 03:29 and
// 2026-08-13 11:15 that was 126 dispatches killed by limits whose reset times
// the messages had stated 85, 69 and 32 times.
//
// Fixed `now` throughout: 2026-08-13T08:00:00Z is 04:00 in America/New_York
// (EDT, UTC-4), so every expectation below is arithmetic rather than a guess.
const NOW = Date.parse('2026-08-13T08:00:00Z');
const MIN = 60_000;
const MARGIN = RESET_MARGIN_MS;   // wake just after the stated minute

const REAL = "claude -p error (success): You've hit your session limit · resets 4:40am (America/New_York)";

test('parses the real CLI message and waits until the stated reset', () => {
  // 04:00 EDT -> 04:40 EDT is 40 minutes.
  assert.equal(parseCapacityReset(REAL, NOW), NOW + 40 * MIN + MARGIN);
});

test('a reset with no minutes parses (`resets 11pm`)', () => {
  // 04:00 -> 23:00 same day = 19h.
  assert.equal(parseCapacityReset('resets 11pm (America/New_York)', NOW), NOW + 19 * 60 * MIN + MARGIN);
});

test('a time already past today is read as tomorrow, not as the past', () => {
  // 04:00 now, 03:00 stated -> 23h away, never negative.
  const at = parseCapacityReset('resets 3:00am (America/New_York)', NOW);
  assert.equal(at, NOW + 23 * 60 * MIN + MARGIN);
  assert.ok(at! > NOW, 'a reset must never be scheduled in the past');
});

test('12am is midnight and 12pm is noon — the pair the mod-12 rule inverts', () => {
  // 04:00 -> next midnight is 20h away.
  assert.equal(parseCapacityReset('resets 12am (America/New_York)', NOW), NOW + 20 * 60 * MIN + MARGIN);
  // 04:00 -> noon is 8h away.
  assert.equal(parseCapacityReset('resets 12pm (America/New_York)', NOW), NOW + 8 * 60 * MIN + MARGIN);
});

test('the reset is honoured in ITS timezone, not the machine’s', () => {
  // 08:00 UTC. Same wall-clock string, different zone, different answer.
  const ny = parseCapacityReset('resets 9:00am (America/New_York)', NOW);   // 04:00 EDT -> 5h
  const utc = parseCapacityReset('resets 9:00am (UTC)', NOW);               // 08:00 UTC -> 1h
  assert.equal(ny, NOW + 5 * 60 * MIN + MARGIN);
  assert.equal(utc, NOW + 1 * 60 * MIN + MARGIN);
});

test('every reset time seen in the real logs parses to a sane wait', () => {
  for (const s of ['4:40am (America/New_York)', '11pm (America/New_York)',
    '9:40am (America/New_York)', '2:40am (America/New_York)', '6pm (America/New_York)']) {
    const at = parseCapacityReset(`You've hit your session limit · resets ${s}`, NOW);
    assert.ok(at !== null, `${s} must parse`);
    assert.ok(at! > NOW && at! - NOW <= MAX_RESET_WAIT_MS, `${s} must yield a plausible wait`);
  }
});

// ---- the >24h date form (weekly limits) --------------------------------------
// Claude Code renders a reset more than 24 h out as an en-US date: short month,
// day, lowercased am/pm, minutes dropped at :00, the year only when it differs.

test('the weekly-limit date form parses in its zone (minutes present)', () => {
  // Aug 19 16:40 EDT = 20:40Z; from Aug 13 08:00Z that is 6d 12h 40m.
  const at = parseCapacityReset("You've hit your weekly limit · resets Aug 19, 4:40pm (America/New_York)", NOW);
  assert.equal(at, NOW + (6 * 24 * 60 + 12 * 60 + 40) * MIN + MARGIN);
});

test('the date form with minutes dropped at :00 parses (`resets Aug 14, 4pm (UTC)`)', () => {
  assert.equal(parseCapacityReset('resets Aug 14, 4pm (UTC)', NOW), NOW + 32 * 60 * MIN + MARGIN);
});

test('the date form carries the year when the CLI renders one', () => {
  // Rendered near New Year: Dec 30 08:00Z -> Jan 3 2027 09:10 EST (14:10Z) = 4d 6h 10m.
  const dec30 = Date.parse('2026-12-30T08:00:00Z');
  const at = parseCapacityReset('resets Jan 3, 2027, 9:10am (America/New_York)', dec30);
  assert.equal(at, dec30 + (4 * 24 * 60 + 6 * 60 + 10) * MIN + MARGIN);
});

test('12am / 12pm in the date form are midnight and noon', () => {
  assert.equal(parseCapacityReset('resets Aug 14, 12am (UTC)', NOW), NOW + 16 * 60 * MIN + MARGIN);
  assert.equal(parseCapacityReset('resets Aug 14, 12pm (UTC)', NOW), NOW + 28 * 60 * MIN + MARGIN);
});

test('a date form with no zone is honoured against local time rather than discarded', () => {
  const at = parseCapacityReset('resets Aug 14, 4pm', NOW);
  assert.ok(at !== null && at > NOW && at - NOW <= MAX_RESET_WAIT_MS);
});

test('a dated reset already in the past returns null (stale message)', () => {
  assert.equal(parseCapacityReset('resets Feb 5, 4:40pm (America/New_York)', NOW), null);
});

// ---- the structured hint ------------------------------------------------------
// The adapter appends `[resetsAt=<ms>]` from a rejected rate_limit_event: the
// epoch the CLI itself was rendering from, so it beats any string form.

test('the structured hint is read as epoch ms and beats the rendered string', () => {
  const at = NOW + 3 * 60 * MIN;
  const msg = `claude -p error (error_during_execution): You've hit your session limit · resets 11pm (UTC) [resetsAt=${at}]`;
  assert.equal(parseCapacityReset(msg, NOW), at + MARGIN);
});

test('a structured hint in the past or beyond the ceiling returns null', () => {
  assert.equal(parseCapacityReset(`[resetsAt=${NOW - 1}]`, NOW), null);
  assert.equal(parseCapacityReset(`[resetsAt=${NOW + MAX_RESET_WAIT_MS + MIN}]`, NOW), null);
});

// ---- falling back is the safe direction ------------------------------------
// A wrong answer here freezes the whole board silently, which is far worse than
// backing off five minutes too often. Every uncertain case returns null so the
// caller keeps its flat backoff.

test('a message with no reset time returns null', () => {
  assert.equal(parseCapacityReset('overloaded, try again later', NOW), null);
  assert.equal(parseCapacityReset('', NOW), null);
});

test('a timezone this runtime does not know returns null', () => {
  assert.equal(parseCapacityReset('resets 4:40am (Mars/Olympus_Mons)', NOW), null);
  assert.equal(parseCapacityReset('resets Aug 14, 4pm (Mars/Olympus_Mons)', NOW), null);
});

test('a nonsensical clock time returns null rather than a wild pause', () => {
  assert.equal(parseCapacityReset('resets 13:00am (UTC)', NOW), null);
  assert.equal(parseCapacityReset('resets 4:99am (UTC)', NOW), null);
  assert.equal(parseCapacityReset('resets Aug 14, 13:00am (UTC)', NOW), null);
});

test('the ceiling is eight days and nothing parses past it', () => {
  assert.equal(MAX_RESET_WAIT_MS, 8 * 24 * 60 * MIN);
  assert.equal(parseCapacityReset('resets Aug 22, 8:00am (UTC)', NOW), null, 'nine days out');
  for (let h = 1; h <= 12; h++) {
    for (const ap of ['am', 'pm']) {
      const at = parseCapacityReset(`resets ${h}:30${ap} (America/New_York)`, NOW);
      assert.ok(at !== null && at - NOW <= MAX_RESET_WAIT_MS, `${h}${ap} exceeded the ceiling`);
    }
  }
});
