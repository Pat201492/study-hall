// The rules behind the dashboard's deferred pool start ("Start in X minutes").
//
// Kept out of dashboard.ts because importing that module binds a port — and
// these decisions are exactly the part worth testing. Everything here is pure;
// the timer, the file, and the actual startPool() call stay in dashboard.ts.

/** Sanity bound on a deferral. setTimeout tops out around 24.8 days; a schedule
 *  further out than a day is far more likely a typo than an intention. */
export const MAX_DELAY_MIN = 24 * 60;

/** How late a missed schedule may be and still fire. See scheduleRestoreAction. */
export const GRACE_MS = 5 * 60_000;

export type DelayCheck = { ok: true; ms: number } | { ok: false; msg: string };

export function validateDelayMinutes(minutes: number): DelayCheck {
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return { ok: false, msg: 'Enter a positive number of minutes.' };
  }
  if (minutes > MAX_DELAY_MIN) {
    return { ok: false, msg: `Too far out — ${MAX_DELAY_MIN} minutes (24h) is the cap.` };
  }
  return { ok: true, ms: Math.round(minutes * 60_000) };
}

export function fmtDelay(minutes: number): string {
  const m = Math.round(minutes);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}

export type RestoreAction =
  | { kind: 'arm'; at: number }        // still in the future — re-arm the timer
  | { kind: 'fire'; lateMs: number }   // came due while down, but only just — start now
  | { kind: 'discard'; lateMs: number }// came due long ago — drop it, loudly
  | { kind: 'invalid' };               // unreadable/absent — drop it, quietly

/**
 * What to do with a schedule found on disk at boot.
 *
 * A schedule that came due while the dashboard was DOWN is discarded rather
 * than fired late. Starting a pool spends plan usage against a real account, so
 * a six-hour-stale timer firing on boot is a surprise, not a favour — and the
 * whole reason a schedule exists is usually "start once my limit resets", which
 * is a moment that has already passed by then.
 *
 * The grace window covers the one case where firing late is unambiguously what
 * was meant: the dashboard bounced within a few minutes of the deadline, so the
 * intent is still current.
 */
export function scheduleRestoreAction(at: unknown, now: number, graceMs = GRACE_MS): RestoreAction {
  const t = Number(at);
  if (!Number.isFinite(t) || t <= 0) return { kind: 'invalid' };
  const lateMs = now - t;
  if (lateMs <= 0) return { kind: 'arm', at: t };
  if (lateMs <= graceMs) return { kind: 'fire', lateMs };
  return { kind: 'discard', lateMs };
}
