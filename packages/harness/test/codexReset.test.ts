import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RESET_MARGIN_MS, parseCodexReset } from '../src/adapters/codexReset.js';

// Codex prints the reset as prose in LOCAL time (codex-rs rust-v0.154.0,
// UsageLimitReachedError: retry_suffix " Try again at {t}." / retry_suffix_after_or
// " or try again at {t}."; %-I:%M %p today, else %b %-d<ordinal>, %Y %-I:%M %p).
// Every expectation is built with the local Date constructor, so the arithmetic
// holds in whatever zone the test machine runs.
const NOW = new Date(2026, 8, 14, 10, 0, 0, 0).getTime(); // 14 Sep 2026 10:00 local
const local = (y: number, mo: number, d: number, h: number, mi: number): number => new Date(y, mo, d, h, mi, 0, 0).getTime();
const MARGIN = RESET_MARGIN_MS;

const PLUS = 'You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 3:40 PM.';

test('the retry_suffix form parses to today at that local time plus the margin', () => {
  assert.equal(parseCodexReset('You’ve hit your usage limit. Try again at 3:40 PM.', NOW), local(2026, 8, 14, 15, 40) + MARGIN);
});

test('the "or try again at" form (Plus plan wording, U+2019 apostrophe) parses the same', () => {
  assert.equal(parseCodexReset(PLUS, NOW), local(2026, 8, 14, 15, 40) + MARGIN);
});

test('a clock time already past today means tomorrow, never the past', () => {
  const at = parseCodexReset('Try again at 9:00 AM.', NOW);
  assert.equal(at, local(2026, 8, 15, 9, 0) + MARGIN);
  assert.ok(at! > NOW);
});

test('12 AM is midnight and 12 PM is noon', () => {
  assert.equal(parseCodexReset('Try again at 12:00 PM.', NOW), local(2026, 8, 14, 12, 0) + MARGIN);
  assert.equal(parseCodexReset('Try again at 12:05 AM.', NOW), local(2026, 8, 15, 0, 5) + MARGIN);
});

test('the dated form with ordinal suffix and year parses to that local date', () => {
  assert.equal(parseCodexReset('Try again at Sep 20th, 2026 3:40 PM.', NOW), local(2026, 8, 20, 15, 40) + MARGIN);
  assert.equal(parseCodexReset('or try again at Oct 1st, 2026 12:00 AM.', NOW), local(2026, 9, 1, 0, 0) + MARGIN);
  assert.equal(parseCodexReset('Try again at Dec 22nd, 2026 7:05 AM.', NOW), local(2026, 11, 22, 7, 5) + MARGIN);
  assert.equal(parseCodexReset('Try again at Nov 3rd, 2027 11:59 PM.', NOW), local(2027, 10, 3, 23, 59) + MARGIN);
});

test('the dated form without a year is this year, or next year once the date has passed', () => {
  assert.equal(parseCodexReset('Try again at Sep 20th 3:40 PM.', NOW), local(2026, 8, 20, 15, 40) + MARGIN);
  assert.equal(parseCodexReset('Try again at Jan 2nd 3:40 PM.', NOW), local(2027, 0, 2, 15, 40) + MARGIN);
});

test('a long month name and a missing ordinal are tolerated', () => {
  assert.equal(parseCodexReset('Try again at September 20, 2026 3:40 PM.', NOW), local(2026, 8, 20, 15, 40) + MARGIN);
});

test('no stated time → null (the monitor falls back to its default hold)', () => {
  assert.equal(parseCodexReset('You’ve hit your usage limit. Try again later.', NOW), null);
  assert.equal(parseCodexReset('Quota exceeded. Check your plan and billing details.', NOW), null);
  assert.equal(parseCodexReset('', NOW), null);
});

test('the margin is a full minute past the stated time', () => {
  assert.equal(MARGIN, 60_000);
  const at = parseCodexReset('Try again at 3:40 PM.', NOW)!;
  assert.equal(at - local(2026, 8, 14, 15, 40), 60_000);
});
