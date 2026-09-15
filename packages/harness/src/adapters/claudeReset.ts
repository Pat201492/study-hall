// When does a Claude plan limit actually clear?
//
// The CLI says so, in the error text it hands back:
//
//     You've hit your session limit · resets 4:40am (America/New_York)
//
// Nothing read it. The runner backed off a flat five minutes and tried again,
// which for a limit that clears at a fixed hour means retrying into a wall for
// as long as the outage lasts. Measured on the v1 engine between 2026-08-12
// 03:29 and 2026-08-13 11:15: 126 student dispatches killed by the limit, across
// outages whose reset times the CLI had stated 85, 69 and 32 times respectively.
//
// Those retries are not merely wasted. Until the fix in v1 #214 every one of
// them was charged against the item it was dispatched for, which walked ten
// healthy issues to the give-up cap and quarantined them. Waiting for the stated
// time instead removes the whole class of damage at its source.
//
// Ported from claude-study-room's src/capacityReset.ts and extended for the
// weekly limits Claude Code 2.1.x renders as a DATE when the reset is more than
// 24 hours away ("resets Feb 5, 4pm (America/New_York)"), plus the structured
// `[resetsAt=<ms>]` hint the adapter appends when it saw a rejected
// rate_limit_event — the renderer's string is a courtesy; the epoch is the truth.
//
// Pure over (message, now) — no clock, no I/O — so every format and boundary is
// unit-testable without an outage to observe.

/** Structured hint appended by the adapter: `[resetsAt=1770325200000]` (epoch ms). */
const STRUCTURED = /\[resetsAt=(\d{10,})\]/;

// `resets Feb 5, 4:40pm (America/New_York)`, `resets Feb 5, 4pm (UTC)`,
// `resets Jan 3, 2027, 9:10am (America/New_York)`. The CLI's renderer (binary
// symbol Hi) uses en-US short month, numeric day, lowercased am/pm, minutes
// dropped at :00, and appends the year only when it differs from the current
// one. The zone is optional here for the same reason as below.
const DATE_FORM = /resets?\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2}),?\s+(?:(\d{4}),?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b(?:\s*\(([^)]+)\))?/i;

// `resets 4:40am (America/New_York)`, `resets 11pm`, `resets 9:40 am (UTC)`.
// The zone is optional: the CLI has always supplied one, but a message without
// it is still worth honouring against local time rather than discarding.
const TIME_FORM = /resets?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b(?:\s*\(([^)]+)\))?/i;

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * Longest pause a parsed reset may produce.
 *
 * A guard against this function, not against Claude. A five-hour or weekly
 * limit clears within a week, so anything beyond eight days means the parse or
 * the timezone maths went wrong — and a wrong answer here freezes the whole
 * board silently, which is a far worse failure than backing off five minutes
 * too often. Out-of-range results are discarded in favour of the caller's flat
 * backoff. (v1 capped at 25 h because only session limits existed; weekly
 * limits render up to seven days out.)
 */
export const MAX_RESET_WAIT_MS = 8 * 24 * 60 * 60_000;

/**
 * Wake a little AFTER the stated minute.
 *
 * Resuming at exactly 4:40:00 races the reset: the limit is reported to the
 * minute, so the first dispatch back can land in the last second before it
 * lifts, fail, and start another backoff cycle. A minute of margin costs
 * nothing against an outage measured in hours.
 */
export const RESET_MARGIN_MS = 60_000;

/** Wall-clock components of instant `t` in `zone`, re-encoded as if they were
 *  UTC — so (wall - t) is the zone's offset at that instant. Null when the zone
 *  is not one Intl recognises. Reading a rendered clock and diffing avoids
 *  constructing a date in another timezone, which is where DST and offset
 *  arithmetic normally go wrong: both sides are already in the target zone. */
function wallClockAsUtc(t: number, zone?: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric',
      hour12: false,
    }).formatToParts(new Date(t));
    const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
    // hour12:false yields 24 for midnight in some ICU versions.
    const fields = [get('year'), get('month'), get('day'), get('hour') % 24, get('minute'), get('second')];
    if (!fields.every(Number.isFinite)) return null;
    const [y, mo, d, h, mi, s] = fields;
    return Date.UTC(y, mo - 1, d, h, mi, s);
  } catch {
    return null;   // RangeError: unknown time zone
  }
}

/** The instant at which `zone`'s wall clock reads the given components. Two
 *  passes so a target on the far side of a DST switch still lands on the
 *  stated wall time. */
function zonedToEpoch(y: number, monthIndex: number, day: number, hour: number, minute: number, zone?: string): number | null {
  const wanted = Date.UTC(y, monthIndex, day, hour, minute);
  const w1 = wallClockAsUtc(wanted, zone);
  if (w1 === null) return null;
  let guess = wanted - (w1 - wanted);
  const w2 = wallClockAsUtc(guess, zone);
  if (w2 === null) return null;
  if (w2 !== wanted) guess += wanted - w2;
  return guess;
}

/** 12am is midnight, 12pm is noon — the one pair the mod-12 rule inverts. */
function to24h(hour12: number, meridiem: string): number {
  if (meridiem === 'am') return hour12 === 12 ? 0 : hour12;
  return hour12 === 12 ? 12 : hour12 + 12;
}

/** Discard anything outside (now, now + MAX_RESET_WAIT_MS]. */
function plausible(at: number, now: number): number | null {
  if (!Number.isFinite(at) || at <= now || at - now > MAX_RESET_WAIT_MS) return null;
  return at;
}

function parseStructured(message: string, now: number): number | null | undefined {
  const m = STRUCTURED.exec(message);
  if (!m) return undefined;
  const at = Number(m[1]);
  // A hint in the past is a stale message, not a reset five minutes from now:
  // waiting on it would be wrong in the direction that silently freezes a board.
  if (!Number.isFinite(at) || at <= now) return null;
  return plausible(at + RESET_MARGIN_MS, now);
}

function parseDateForm(message: string, now: number): number | null | undefined {
  const m = DATE_FORM.exec(message);
  if (!m) return undefined;
  const monthIndex = MONTHS.indexOf(m[1].toLowerCase());
  const day = Number(m[2]);
  const minute = m[5] ? Number(m[5]) : 0;
  const hour12 = Number(m[4]);
  const zone = m[7]?.trim();
  if (monthIndex < 0 || day < 1 || day > 31 || hour12 < 1 || hour12 > 12 || minute > 59) return null;

  // No year rendered means the reset falls in the CURRENT year — in the zone
  // the CLI rendered it for, which is not necessarily the machine's.
  let year: number;
  if (m[3]) {
    year = Number(m[3]);
  } else {
    const nowWall = wallClockAsUtc(now, zone);
    if (nowWall === null) return null;
    year = new Date(nowWall).getUTCFullYear();
  }
  const at = zonedToEpoch(year, monthIndex, day, to24h(hour12, m[6].toLowerCase()), minute, zone);
  if (at === null) return null;
  return plausible(at + RESET_MARGIN_MS, now);
}

function parseTimeForm(message: string, now: number): number | null | undefined {
  const m = TIME_FORM.exec(message);
  if (!m) return undefined;
  const hour12 = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;   // `resets 11pm` has no minutes
  const zone = m[4]?.trim();
  if (hour12 < 1 || hour12 > 12 || minute > 59) return null;

  const targetMinutes = to24h(hour12, m[3].toLowerCase()) * 60 + minute;
  const nowWall = wallClockAsUtc(now, zone);
  if (nowWall === null) return null;
  const nowDate = new Date(nowWall);
  const nowMinutes = nowDate.getUTCHours() * 60 + nowDate.getUTCMinutes();

  let delta = targetMinutes - nowMinutes;
  if (delta <= 0) delta += 24 * 60;      // already passed today -> tomorrow

  return plausible(now + delta * 60_000 + RESET_MARGIN_MS, now);
}

/**
 * The absolute time (epoch ms) a capacity limit clears, parsed out of the CLI's
 * own error message. Returns null when the message states no reset time, names
 * a timezone this runtime does not know, or yields an implausible wait — in
 * every one of those cases the caller should fall back to its flat backoff
 * rather than guess.
 *
 * Forms, most authoritative first:
 *   1. `[resetsAt=<epoch ms>]`  — appended by the adapter from a rejected
 *      rate_limit_event; the epoch the CLI itself was rendering from.
 *   2. `resets Feb 5, 4:40pm (Zone)` — the >24 h rendering (weekly limits).
 *   3. `resets 4:40am (Zone)` — the same-day rendering. A stated time that
 *      has already passed today is read as tomorrow's: "resets 4:40am" seen at
 *      11pm means the 4:40am five hours away, not the one seventeen hours
 *      behind us.
 */
export function parseCapacityReset(message: string, now: number): number | null {
  const text = message ?? '';
  for (const parse of [parseStructured, parseDateForm, parseTimeForm]) {
    const r = parse(text, now);
    if (r !== undefined) return r;
  }
  return null;
}
