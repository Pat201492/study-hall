// The watchdog files a report when it gives up on an item. It has never closed
// one when the item is resolved.
//
// `openIssueOnce` dedupes FILING -- it will not file the same title twice -- and
// that was mistaken for lifecycle management. It is not: nothing in the engine
// ever looks back at what it filed. So reports accumulate one per wedged item,
// forever, and outlive the condition by weeks.
//
// Measured on 2026-09-01, before this: the report repo carried 45 open watchdog
// reports against 8 real work items. 40 of the 45 named an item that was already
// closed or merged. Finding the one live report meant reading past 40 dead ones,
// which is the opposite of what a report is for.
//
// The engine already has everything needed to fix this. It fetches every open
// issue and PR on every configured board each tick; an item that was wedged and
// is no longer in that set has been resolved. No extra lookup per report.

/** The board item a watchdog report is about. */
export interface ReportSubject {
  /** owner/repo, as embedded in the qualified item key. */
  repo: string;
  kind: 'issue' | 'pr';
  number: number;
}

// Both per-item report titles embed a qualified key:
//
//   [watchdog] Pat201492/dw:issue-110 on Pat201492/dw never settled after 9 attempts
//   [watchdog] stuck item IMPLEMENT:Pat201492/dw:pr-170 on Pat201492/dw
//
// so one pattern reads both. The optional ROLE prefix is the action kind
// (IMPLEMENT / REVIEW / FIX), which does not change which item is meant.
const SUBJECT = /(?:[A-Z]+:)?([\w.-]+\/[\w.-]+):(issue|pr)-(\d+)/;

/**
 * The item a report names, or null when it names none.
 *
 * Board-level reports ("board contested", "engine killed") deliberately return
 * null: they describe a condition, not an item, so no item's resolution can
 * retire them and closing them automatically would be a guess.
 */
export function reportSubject(title: string): ReportSubject | null {
  if (!title.startsWith('[watchdog]')) return null;
  const m = SUBJECT.exec(title);
  if (!m) return null;
  const number = Number(m[3]);
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  return { repo: m[1], kind: m[2] as 'issue' | 'pr', number };
}

/** One open report in the report repo. */
export interface OpenReport { number: number; title: string }

/**
 * Which reports are safe to close, given what is still open on the boards.
 *
 * `openByRepo` maps each CONFIGURED board to the item keys still open on it
 * (`issue-12`, `pr-40`). A report is retired when its subject's board is present
 * AND the subject is absent from it -- absent from a board we can see means
 * closed or merged.
 *
 * A subject on a board this engine does not currently watch is left alone: we
 * cannot see whether it resolved, and closing a report on that basis would be
 * asserting something unobserved. Same for a report naming no item at all.
 */
export function reportsToClose(
  reports: OpenReport[],
  openByRepo: Map<string, Set<string>>,
): { report: number; subject: ReportSubject }[] {
  const out: { report: number; subject: ReportSubject }[] = [];
  for (const r of reports) {
    const s = reportSubject(r.title);
    if (!s) continue;
    const open = openByRepo.get(s.repo);
    if (!open) continue; // board not watched -> unobservable, leave it
    if (!open.has(`${s.kind}-${s.number}`)) out.push({ report: r.number, subject: s });
  }
  return out;
}

/** How often the sweep runs. */
export const SWEEP_INTERVAL_MS = 10 * 60_000;

/**
 * Is a sweep due?
 *
 * Throttled rather than per-tick because it costs one `gh issue list` against
 * the report repo and answers a question that changes slowly -- items resolve on
 * the order of minutes at best. `last === 0` means "never swept", so a boot
 * sweeps immediately and clears whatever the previous run left behind.
 */
export function sweepDue(last: number, now: number, interval = SWEEP_INTERVAL_MS): boolean {
  return last === 0 || now - last >= interval;
}
