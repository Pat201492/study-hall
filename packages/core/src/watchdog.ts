// The Supervisor watchdog. The Protector (protector.ts) is the SCHEDULING brain
// — assign a task to a warm worker. This is the SAFETY layer around a LIVE run:
// it watches the board the runner dispatches and catches the failure the
// scheduler can't see — an item that is worked every heartbeat yet never makes
// progress (the #112 "refusing to merge unrelated histories" loop: RESOLVE
// re-dispatched forever, tokens burned, the PR's state never changes).
//
// Two deliberately-asymmetric escalation levels:
//   - per-item WEDGED  -> quarantine that ONE item (the runner stops re-
//     dispatching it) and file a report. One bad branch never blocks the fleet.
//   - SYSTEMIC         -> too many items wedged at once, or the engine erroring
//     tick after tick: kill the program + a summary report. Reserved for real
//     breakage, so a single stuck PR can't take the whole run down.
//
// Pure over its inputs (no fs / network / timers), exactly like protector.ts, so
// the counting + escalation ladder is fully unit-testable. The IO — deciding a
// worked item didn't progress, scanning worktrees, filing the GitHub issue —
// lives in the runner (live.ts), which feeds this module bump()/clear() calls.

export interface WatchdogConfig {
  /** Consecutive worked-but-no-progress attempts before an item is WEDGED. */
  wedgeTicks: number;
  /** How many items wedged at once escalates a quarantine into a program kill. */
  fatalWedgeCount: number;
  /** How many consecutive engine/tick errors escalate into a program kill. */
  fatalErrorStreak: number;
  /**
   * Total work dispatches one BOARD ITEM may absorb before it is treated as
   * non-converging, regardless of how much its state churns in between.
   *
   * This is the oscillation cap, and it is deliberately separate from
   * wedgeTicks. wedgeTicks catches an item that never MOVES; this catches one
   * that never SETTLES — the fix<->review ping-pong, where each cycle adds
   * `changes-requested`, the fix clears it, and the item's signature therefore
   * changes every tick. That reads as progress, so the no-progress counter
   * resets forever and the stasis detector can never fire. Observed on
   * Trader-Screener #114: 8 reviews, 7 fixes, 8 commits in 15 minutes, ~60% of
   * the run's tokens, with nothing in the engine able to stop it.
   */
  maxItemAttempts: number;
  /**
   * Failed review rounds after which the Protector stops asking for another FIX
   * and asks for a REWRITE instead. Patching a rejected approach repeatedly
   * grows the diff while converging on nothing -- Trader-Screener #126 took ten
   * commits across nine review rounds and never landed. Must be BELOW
   * maxItemAttempts, so the rewrite gets its own attempts before the item is
   * given up on entirely.
   */
  rewriteAfterAttempts: number;
  /**
   * How many issue specs may change between two ingests before Study Room
   * concludes it is NOT the only writer on this board and backs off.
   *
   * Study Room reads a spec, builds against it, then reviews the result against
   * the spec — and every one of those is a separate fetch. Another agent editing
   * issues mid-run breaks that: the implementer builds v1, the reviewer judges it
   * against v2, and the PR can never satisfy criteria that keep moving. Observed
   * on Trader-Screener, where 11 issues were rewritten inside 12 seconds.
   *
   * Backing off is a pause, not a kill: a human is actively working: the right
   * move is to stop spending model time until the board settles, then resume.
   */
  boardChurnLimit: number;
  /**
   * Dispatches an item gets when it is handed BACK to the board -- by a human
   * removing its parking label, or by parole serving its sentence.
   *
   * Deliberately NOT a full maxItemAttempts reset. A release used to call
   * forgetItem, which handed the item a fresh budget of nine; if the condition
   * that wedged it had not actually cleared, it spent all nine proving that
   * again before re-parking. Observed on dungeonworks #110/#111: the label was
   * cleared by hand on 2026-08-23 and the item burned its way back to
   * `runner-error` by 2026-09-01, at ~$4.23 an implement dispatch.
   *
   * One dispatch answers the only question a release asks -- did the condition
   * clear? -- so a release that was wrong costs one attempt, not nine.
   */
  probeAttempts: number;
  /**
   * Total dispatches an item may EVER cost, summed across every parole, every
   * manual unpark and every probe. Nothing else in the ladder is monotonic:
   * attempts reset on release, so an item that re-wedges forever is only ever
   * bounded per-sentence. Parole's own floor is about one dispatch a day, which
   * is cheap for a week and unbounded over months.
   *
   * This is the ceiling that makes 'forever' impossible without knowing why an
   * item is stuck -- the same cause-agnostic argument parole.ts makes for
   * retrying: classification only forgives failures we have already been burned
   * by. Past the cap an item stops being auto-released and needs a human.
   */
  lifetimeDispatchCap: number;
}

export const DEFAULT_WATCHDOG_CONFIG: WatchdogConfig = {
  wedgeTicks: 4,
  fatalWedgeCount: 4,
  fatalErrorStreak: 5,
  // Room for a couple of honest fix->review rounds; a third is a disagreement
  // the engine is not going to resolve by trying harder.
  // Raised from 6: the rewrite escalation now sits at 5, and the item needs
  // room for the rewrite plus a round or two of review after it.
  maxItemAttempts: 9,
  rewriteAfterAttempts: 5,
  // One or two edits while a run is going is ordinary human tidying. Three specs
  // moving between two ingests is someone else driving the board.
  boardChurnLimit: 3,
  // One dispatch is enough to learn whether a release was justified.
  probeAttempts: 1,
  // ~9 for a full first life, plus a handful of probes. Past this the item has
  // cost more than any issue on the board is worth and needs a human decision.
  lifetimeDispatchCap: 15,
};

// The verdict the runner acts on each heartbeat.
export type Escalation =
  | { level: 'ok' }
  | { level: 'quarantine'; keys: string[] }                  // isolate these, keep running
  | { level: 'kill'; reason: string; wedged: string[] };     // stop the program + report

export class Watchdog {
  readonly cfg: WatchdogConfig;
  // key -> consecutive worked-but-no-progress attempts.
  private readonly counts = new Map<string, number>();
  // keys already surfaced by newlyWedged(), so each is reported once, not per tick.
  private readonly reported = new Set<string>();
  // Keys the runner has ISOLATED. Critically, these no longer count toward the
  // systemic kill threshold. A quarantined item is never dispatched again, so it
  // is never bumped and never cleared — leaving it in `counts` meant its stale
  // wedge count stayed forever, the wedged() total only ever climbed, and the
  // Nth quarantine killed an engine whose N stuck items were already costing
  // nothing. Quarantine could never actually do its job.
  private readonly isolated = new Set<string>();
  // ITEM key ("pr-114") -> total work dispatches, across every action kind.
  // Keyed by item rather than action because the ping-pong alternates between
  // REVIEW:pr-114 and FIX:pr-114 — per-action counters each stay low forever
  // while the pair burns a student every three minutes.
  private readonly attempts = new Map<string, number>();
  // ITEM key -> dispatches this item has EVER cost. Never reset by a release,
  // which is the whole point: it is the one counter a re-wedge loop cannot
  // launder by going around again. Cleared only when the item leaves the board.
  private readonly lifetime = new Map<string, number>();
  // ITEM key -> probe dispatches remaining, for items handed back by a human or
  // by parole. Present here means 'on probation': exhausting the budget re-parks
  // the item immediately instead of letting it walk the full attempt ladder.
  private readonly probing = new Map<string, number>();
  // board -> (issue number -> spec fingerprint as of THAT board's last ingest).
  // The board's own memory of what it was told to build, so a rewrite is
  // detectable at all.
  //
  // Scoped by board, because issue numbers are per-repo. One flat number->fp map
  // was correct for a single repo and silently wrong for several: each repo's
  // ingest replaced the whole map, so the next repo diffed ITS #7 against the
  // previous repo's #7 and reported the collision as a rewrite. Three boards
  // sharing a number range therefore reported churn on every tick, tripped
  // boardChurnLimit forever, and paused dispatch on a board nobody was editing.
  private readonly boardSpecs = new Map<string, Map<number, string>>();
  private readonly churnedLast = new Map<string, number>();
  private errorStreak = 0;

  constructor(cfg: Partial<WatchdogConfig> = {}) {
    this.cfg = { ...DEFAULT_WATCHDOG_CONFIG, ...cfg };
  }

  /**
   * Mark a key as isolated by the runner: stop counting it toward the systemic
   * kill, and stop re-reporting it. Also used at boot to restore a quarantine
   * persisted by a previous run, so a restart doesn't re-burn the same items.
   */
  isolate(key: string): void {
    this.isolated.add(key);
    this.reported.add(key);
    this.counts.delete(key);
  }

  /** Keys currently isolated (what the runner persists). */
  isolatedKeys(): string[] {
    return [...this.isolated];
  }

  isIsolated(key: string): boolean {
    return this.isolated.has(key);
  }

  /** A heartbeat completed without an engine error — resets the fatal streak. */
  tickOk(): void {
    this.errorStreak = 0;
  }

  /** A heartbeat failed (board fetch / engine error) — advances the fatal streak. */
  tickError(): void {
    this.errorStreak += 1;
  }

  /** An item was worked and came back with no progress — one step toward wedged. */
  bump(key: string): void {
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }

  /** An item progressed (state changed) or left the board — forget it entirely,
   *  including any isolation: a human who fixed the underlying PR should get the
   *  item worked again without restarting the engine. */
  clear(key: string): void {
    this.counts.delete(key);
    this.reported.delete(key);
    this.isolated.delete(key);
  }

  /** Record that a board item was dispatched for work. Counts every kind of
   *  work, so alternating roles on one item still accumulate. */
  attempt(item: string): void {
    this.attempts.set(item, (this.attempts.get(item) ?? 0) + 1);
    this.lifetime.set(item, (this.lifetime.get(item) ?? 0) + 1);
    const left = this.probing.get(item);
    if (left !== undefined) this.probing.set(item, left - 1);
  }

  /**
   * Set an item's attempt count from evidence outside this process -- a PR's own
   * rejection history, or counts persisted by a previous run. Never LOWERS the
   * count: what this engine has already watched happen is at least as true as
   * anything seeded, and a seed must not hand a churning item a fresh budget.
   */
  seedAttempts(item: string, n: number): void {
    // Clamp a seed into the REWRITE band rather than past it. A PR with ten
    // prior rejections accumulated all of them as FIXES; the rewrite is a
    // different strategy that has never been tried on it. Seeding the raw count
    // would push it straight past the give-up cap and quarantine it without ever
    // attempting the escalation that exists for exactly this case.
    //
    // Counts this engine OBSERVES are not clamped — those really did include
    // whatever the ladder dispatched, rewrite included.
    const capped = Math.min(n, this.cfg.rewriteAfterAttempts);
    if (capped > (this.attempts.get(item) ?? 0)) this.attempts.set(item, capped);
  }

  /**
   * Give an item back one attempt, because the dispatch it is being charged for
   * never actually ran — a plan session limit, a rate limit or an expired login
   * killed the student before it could touch the work.
   *
   * The no-progress counter has `clear()` for this; the attempt LEDGER had
   * nothing, so a capacity outage still walked healthy items to the give-up cap.
   * Observed on 2026-08-13: test-tracker #37 and #47 were "worked 9x without
   * settling" and quarantined, when all nine were the same session limit and not
   * one of them ran.
   *
   * Gives back ONE, not all: attempts this engine really did spend stay spent, so
   * an outage in the middle of a genuine fix/review ping-pong doesn't hand that
   * item a fresh budget.
   */
  forgiveAttempt(item: string): void {
    const n = this.attempts.get(item);
    if (n === undefined) return;
    if (n <= 1) this.attempts.delete(item);
    else this.attempts.set(item, n - 1);
    // A dispatch that never ran cost nothing, so it must not consume the
    // lifetime ceiling or a probe -- otherwise an outage walks an item to the
    // permanent cap without a single student ever reading it.
    const life = this.lifetime.get(item);
    if (life !== undefined) {
      if (life <= 1) this.lifetime.delete(item);
      else this.lifetime.set(item, life - 1);
    }
    const left = this.probing.get(item);
    if (left !== undefined) this.probing.set(item, left + 1);
  }

  /** Every item's attempt count, for persisting across restarts. */
  attemptSnapshot(): Record<string, number> {
    return Object.fromEntries(this.attempts);
  }

  attemptsFor(item: string): number {
    return this.attempts.get(item) ?? 0;
  }

  /**
   * Items past the attempt cap that aren't isolated yet — each surfaced once, so
   * the runner reports and quarantines a non-converging item a single time.
   */
  newlyExhausted(): string[] {
    const out: string[] = [];
    // A spent probe budget re-parks the item at once: the release already asked
    // 'has the condition cleared?', and the answer came back no.
    for (const [item, left] of this.probing) {
      if (left <= 0 && !this.isolated.has(item)) {
        this.isolate(item);
        this.probing.delete(item);
        out.push(item);
      }
    }
    for (const [item, n] of this.attempts) {
      if (this.probing.has(item)) continue; // on probation: judged by the probe budget
      if (n >= this.cfg.maxItemAttempts && !this.isolated.has(item)) {
        this.isolate(item);
        out.push(item);
      }
    }
    return out;
  }

  /**
   * Fold in ONE board's ingest fingerprints and report which of its issue numbers
   * had their spec REWRITTEN since the last look at that same board.
   *
   * Only counts issues present both times: a new issue isn't churn (there is no
   * previous spec to contradict), and a closed one isn't either.
   *
   * `board` identifies the board being observed (the repo slug). It defaults to
   * the single unnamed board, so a one-repo caller needs no scope at all.
   */
  observeBoard(specs: Map<number, string>, board = ''): number[] {
    const changed: number[] = [];
    const prev = this.boardSpecs.get(board);
    for (const [n, fp] of specs) {
      const before = prev?.get(n);
      if (before !== undefined && before !== fp) changed.push(n);
    }
    this.boardSpecs.set(board, new Map(specs));
    this.churnedLast.set(board, changed.length);
    return changed;
  }

  /** True when this board's last ingest showed more spec churn than the limit —
   *  i.e. another writer is actively reshaping ITS work. Asked per board: churn
   *  is a fact about one repo, and one contested board must not pause the rest. */
  boardContested(board = ''): boolean {
    return this.churnCount(board) >= this.cfg.boardChurnLimit;
  }

  /** How many of this board's specs moved in its last ingest. */
  churnCount(board = ''): number {
    return this.churnedLast.get(board) ?? 0;
  }

  /** Every board currently over the churn limit. */
  contestedBoards(): string[] {
    return [...this.churnedLast.keys()].filter((b) => this.boardContested(b));
  }

  /** The fingerprint recorded for an issue on a board, if any. */
  specFor(n: number, board = ''): string | undefined {
    return this.boardSpecs.get(board)?.get(n);
  }

  /**
   * Has this item failed enough review rounds that another patch is not worth
   * dispatching? True once its attempts reach rewriteAfterAttempts and before
   * the give-up cap, so the runner swaps FIX for REWRITE.
   */
  needsRewrite(item: string): boolean {
    // A probe asks one question -- did the condition clear? -- and a rewrite is a
    // different, more expensive strategy. An item released on probation has
    // usually been rewritten already; doing it again on the way back in spends
    // the probe on the one thing that has demonstrably not worked.
    if (this.probing.has(item)) return false;
    const n = this.attempts.get(item) ?? 0;
    return n >= this.cfg.rewriteAfterAttempts && n < this.cfg.maxItemAttempts;
  }

  /** Every item with attempt history, so the runner can reconcile against the
   *  live board and forget the ones that have left it. */
  trackedItems(): string[] {
    // Union, not just attempts: an item released on probation has its attempts
    // cleared and would otherwise be invisible here until its first dispatch,
    // so an item that left the board mid-probation would never be forgotten.
    return [...new Set([...this.attempts.keys(), ...this.lifetime.keys(), ...this.probing.keys()])];
  }

  /** An item left the board (merged, closed) — drop its attempt history so a
   *  long-lived engine doesn't accumulate counts against numbers that are gone. */
  forgetItem(item: string): void {
    this.attempts.delete(item);
    this.isolated.delete(item);
    this.lifetime.delete(item);
    this.probing.delete(item);
  }

  /**
   * Hand an item back to the board ON PROBATION, with `probeAttempts` dispatches
   * rather than a fresh full budget.
   *
   * This is the release path for a human clearing a parking label and for parole
   * serving a sentence. Both used forgetItem, which is why clearing a label by
   * hand never held: the item came back with all nine attempts and spent them
   * re-proving it was stuck. The lifetime ledger deliberately survives -- a
   * release is a second chance, not an amnesty.
   */
  probe(item: string): void {
    this.attempts.delete(item);
    this.isolated.delete(item);
    this.probing.set(item, Math.max(1, this.cfg.probeAttempts));
  }

  /** Dispatches this item has ever cost, across every release (0 if unseen). */
  lifetimeFor(item: string): number {
    return this.lifetime.get(item) ?? 0;
  }

  /**
   * Has this item cost more than the board is willing to spend on it, ever?
   * Past this, parole stops auto-releasing: a human decides whether it lives.
   */
  lifetimeExhausted(item: string): boolean {
    return this.lifetimeFor(item) >= this.cfg.lifetimeDispatchCap;
  }

  /** Every item's lifetime dispatch count, for persisting across restarts. */
  lifetimeSnapshot(): Record<string, number> {
    return Object.fromEntries(this.lifetime);
  }

  /**
   * Restore a lifetime count from a previous run. Never LOWERS it, and is never
   * clamped the way seedAttempts is: a ceiling that a restart could reset is not
   * a ceiling, and restarts are exactly how the old counters got laundered.
   */
  seedLifetime(item: string, n: number): void {
    if (n > (this.lifetime.get(item) ?? 0)) this.lifetime.set(item, n);
  }

  /** Current consecutive no-progress count for an item (0 if unseen). */
  countFor(key: string): number {
    return this.counts.get(key) ?? 0;
  }

  /** Every item at or past the wedge threshold that is NOT already isolated. */
  wedged(): string[] {
    return [...this.counts]
      .filter(([k, c]) => c >= this.cfg.wedgeTicks && !this.isolated.has(k))
      .map(([k]) => k);
  }

  /** Wedged items not yet surfaced — so the runner reports each stuck item once. */
  newlyWedged(): string[] {
    const out: string[] = [];
    for (const key of this.wedged()) {
      if (!this.reported.has(key)) {
        this.reported.add(key);
        out.push(key);
      }
    }
    return out;
  }

  /**
   * The current escalation: systemic conditions (error streak, too many wedged)
   * outrank a single-item quarantine, which outranks ok.
   *
   * The kill threshold counts only items NOT yet isolated — i.e. the engine is
   * wedging faster than it can quarantine, which is a real systemic failure.
   * Counting already-isolated items instead made the kill inevitable: they never
   * progress, so the total only grew, and every restart re-walked the same path
   * to the same kill.
   */
  assess(): Escalation {
    const wedged = this.wedged();
    if (this.errorStreak >= this.cfg.fatalErrorStreak) {
      return { level: 'kill', reason: `engine errored ${this.errorStreak} heartbeats in a row`, wedged };
    }
    if (wedged.length >= this.cfg.fatalWedgeCount) {
      return { level: 'kill', reason: `${wedged.length} board items wedged with no progress`, wedged };
    }
    if (wedged.length > 0) {
      return { level: 'quarantine', keys: wedged };
    }
    return { level: 'ok' };
  }
}

// ---- Orphan worktree detection (pure) --------------------------------------
// Leftover worktree DIRECTORIES on disk that git no longer tracks — dead-session
// students tree-killed mid-clone. `git worktree prune` skips these (they aren't
// registered), yet the dir still exists, so the next `git worktree add <dir>`
// fails "already exists" and every new dispatch collides. Given the on-disk set,
// the git-registered set, and any dirs currently in use, return the leftovers
// that are safe to delete. Compared by basename so posix/windows separators and
// absolute/relative paths still match.
export function orphanWorktrees(
  onDisk: string[],
  registered: string[],
  inUse: string[] = [],
): string[] {
  const keep = new Set([...registered, ...inUse].map(basename));
  return onDisk.filter((dir) => !keep.has(basename(dir)));
}

function basename(p: string): string {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] ?? p;
}
