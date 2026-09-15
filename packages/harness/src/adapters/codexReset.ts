// Codex surfaces a usage-limit reset time as PROSE inside the error message,
// never as a machine field of the exec JSONL (verified from codex-rs at
// rust-v0.154.0, UsageLimitReachedError Display + retry_suffix helpers):
//
//   " Try again at 3:40 PM."                 reset is today (local time, %-I:%M %p)
//   " or try again at 3:40 PM."              the "after or" suffix variant
//   " Try again at Sep 20th, 2026 3:40 PM."  another day (%b %-d<ordinal>, %Y %-I:%M %p)
//   " Try again later."                      no time known → null
//
// The parse returns epoch MILLISECONDS plus a 60 s margin so a retry never
// lands on the boundary itself (the provider's clock and ours disagree by
// seconds; the margin absorbs it).

export const RESET_MARGIN_MS = 60_000;

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// "try again at Sep 20th, 2026 3:40 PM" — ordinal suffix and year optional,
// month name tolerated in long form ("September") too.
const DATED = /try again at\s+([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:(\d{4}),?\s+)?(\d{1,2}):(\d{2})\s*([AaPp][Mm])/i;
// "try again at 3:40 PM" — today, or tomorrow when that clock time has passed.
const TIMED = /try again at\s+(\d{1,2}):(\d{2})\s*([AaPp][Mm])/i;

function hour24(hour12: number, meridiem: string): number {
  const pm = meridiem.toLowerCase() === 'pm';
  if (hour12 === 12) return pm ? 12 : 0;
  return pm ? hour12 + 12 : hour12;
}

/**
 * Epoch ms (plus margin) at which Codex said usage would be allowed again, or
 * null when the message names no time. Local time, because that is how Codex
 * renders it.
 */
export function parseCodexReset(message: string, now: number = Date.now()): number | null {
  if (!message) return null;

  const dated = DATED.exec(message);
  if (dated) {
    const month = MONTHS.indexOf(dated[1].slice(0, 3).toLowerCase());
    if (month < 0) return null;
    const day = Number(dated[2]);
    const hour = hour24(Number(dated[4]), dated[6]);
    const minute = Number(dated[5]);
    const base = new Date(now);
    const explicitYear = dated[3] ? Number(dated[3]) : undefined;
    let at = new Date(explicitYear ?? base.getFullYear(), month, day, hour, minute, 0, 0).getTime();
    // No year printed and the date already passed this year → it means next year.
    if (explicitYear === undefined && at <= now) {
      at = new Date(base.getFullYear() + 1, month, day, hour, minute, 0, 0).getTime();
    }
    return at + RESET_MARGIN_MS;
  }

  const timed = TIMED.exec(message);
  if (timed) {
    const hour = hour24(Number(timed[1]), timed[3]);
    const minute = Number(timed[2]);
    const base = new Date(now);
    let at = new Date(base.getFullYear(), base.getMonth(), base.getDate(), hour, minute, 0, 0).getTime();
    // Date arithmetic via the constructor keeps DST transitions correct.
    if (at <= now) at = new Date(base.getFullYear(), base.getMonth(), base.getDate() + 1, hour, minute, 0, 0).getTime();
    return at + RESET_MARGIN_MS;
  }

  return null;
}
