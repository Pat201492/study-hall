// A window in which the pool holds dispatch.
//
// Not a scheduler: the engine still runs whenever it is started, and in-flight
// students still finish. It simply starts nothing new while the window is open,
// then resumes on its own -- the same shape as the capacity pause, which already
// proved that "let work finish, stop starting" is the safe way to stand down.
//
// Motivated by 95 CLI segfaults that fell in two one-hour bursts, both in the
// 22:00 local hour on consecutive nights. No scheduled task triggers then, the
// crash is unreproducible in controlled runs, and a later run passed through the
// same hour cleanly -- so the cause is unknown and this is deliberately a
// mitigation rather than a fix. It costs an hour of dispatch a day and removes
// the only window in which the board has ever destroyed itself.
//
// Times are LOCAL wall clock, because that is how the correlation was observed
// and how anyone reading the config will think about it. Everything here works in
// minutes-of-day so the rules stay pure and testable without timezone games; the
// caller converts a Date once.

export interface BlackoutConfig {
  enabled: boolean;
  /** Local "HH:MM" the window opens. */
  from: string;
  /** Local "HH:MM" the window closes. May be earlier than `from` (wraps midnight). */
  to: string;
}

export const DEFAULT_BLACKOUT: BlackoutConfig = {
  enabled: true,
  from: '22:00',
  to: '23:00',
};

/** "HH:MM" -> minutes since local midnight, or null if unparseable. */
export function parseHhMm(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s).trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** Minutes since local midnight for a Date. */
export function minutesOfDay(d: Date): number {
  return d.getHours() * 60 + d.getMinutes();
}

/**
 * Is `minute` inside [from, to)?
 *
 * Half-open on purpose: a window of 22:00-23:00 must not still be closed at
 * exactly 23:00, or a one-hour blackout silently lasts a minute longer every day.
 *
 * Wraps midnight when `to` <= `from` (22:00-02:00 is a real thing someone will
 * configure), and a window whose ends are equal is treated as EMPTY rather than
 * as "always", because the alternative bricks the board on a typo.
 */
export function inWindow(minute: number, from: number, to: number): boolean {
  if (from === to) return false;
  return from < to
    ? minute >= from && minute < to
    : minute >= from || minute < to;
}

/** Is the pool inside its blackout right now? Unparseable config = not blacked out. */
export function inBlackout(now: Date, cfg: BlackoutConfig): boolean {
  if (!cfg.enabled) return false;
  const from = parseHhMm(cfg.from);
  const to = parseHhMm(cfg.to);
  // A bad string must not be able to stop the board forever, and must not be
  // silently treated as midnight either.
  if (from == null || to == null) return false;
  return inWindow(minutesOfDay(now), from, to);
}

/** Minutes until the window closes, for the log line. 0 when not blacked out. */
export function minutesUntilOpen(now: Date, cfg: BlackoutConfig): number {
  if (!inBlackout(now, cfg)) return 0;
  const to = parseHhMm(cfg.to);
  if (to == null) return 0;
  const cur = minutesOfDay(now);
  return to > cur ? to - cur : 24 * 60 - cur + to;
}
