import { parseDeps, type RawIssue, type OpenPull } from './github.js';
import { needsTriage, EPIC_LABEL } from './triage.js';
import { auditIssue, NEEDS_DETAIL_LABEL, type IssueAuditGate } from './issueAudit.js';
import { NEEDS_HUMAN_LABEL } from './buildability.js';
import type { Role } from './taskmap.js';

// Board classifier: given the fetched board (open issues from fetchIssues +
// open PRs from listOpenPulls), decide the single next action for every
// actionable item, mirroring claude-queue-runner's ladder. Pure over its inputs
// — no gh, no I/O — so each branch is unit-testable without a `gh` binary.
//
// Ladder, first match wins per item:
//   PR  changes-requested OR red CI ............ FIX
//   PR  CONFLICTING with base .................. RESOLVE
//   PR  reviewed-ok + green + mergeable ........ MERGE   (only when autoMerge)
//   PR  no review verdict yet .................. REVIEW
//   issue deps-closed, stale `blocked` label ... PROMOTE
//   issue labelled `epic` ...................... none (its pieces carry the work)
//   issue deps-closed .......................... IMPLEMENT
// Items with nothing to do — an issue still blocked by an open dependency, a PR
// waiting on pending CI, an issue whose PR is already in flight — yield NO
// action rather than a bogus one.
//
// Readiness gates on deps-closed, NOT on a `ready` label (see the plan fix in
// commit 5b94599): an issue whose blocking issues are all closed is buildable.

export type ActionKind = 'MERGE' | 'FIX' | 'RESOLVE' | 'REVIEW' | 'PROMOTE' | 'NEEDS_DETAIL' | 'TRIAGE' | 'IMPLEMENT';

export interface BoardAction {
  /** owner/name of the board this action belongs to — a typed field, never a cast (v1 stamped it by cast and every multi-repo key bug came from that). */
  repo: string;
  kind: ActionKind;
  target: 'issue' | 'pr';
  number: number;      // issue or PR number
  role: Role | null;   // the student role to run; PROMOTE is a label flip -> null
  reason: string;      // human-readable why, for the console/log
}

// classify only reads `autoMerge`. Study Room is PR-ONLY by design (see
// github.ts): a merge-ready PR yields a MERGE action only when the board is
// explicitly allowed to auto-merge; otherwise a human merges and it just waits.
// Typed loosely so a full StudyRoomConfig satisfies it structurally.
export interface ClassifyConfig {
  /** Set false to skip scope triage entirely and implement every issue directly. */
  triage?: boolean;
  autoMerge?: boolean;
  /**
   * Deterministic issue audit (issueAudit.ts).
   *
   * Defaults to OBSERVATION mode: the audit runs and its verdict is reported,
   * but an `underspecified` issue is still implemented exactly as before. That
   * default is deliberate. A gate that blocks dispatch can stall a whole board
   * if its thresholds are wrong, and thresholds set from a handful of repos have
   * no business being trusted before anyone has seen how many issues they would
   * actually catch. Run it in observation mode, read the counts, THEN enforce.
   */
  issueAudit?: { enforce?: boolean; gate?: IssueAuditGate };
}

// Action-level priority: finish in-flight work before starting new work.
// Lower rank = more urgent (earlier in the returned list). Satisfies the
// acceptance order "merge before review before implement".
const RANK: Record<ActionKind, number> = {
  // TRIAGE outranks IMPLEMENT: assessing whether an issue is one PR's worth
  // is only useful BEFORE a student starts writing code against it. NEEDS_DETAIL
  // outranks TRIAGE for the same reason one step earlier — splitting an issue
  // that states no criteria just yields several issues that state no criteria.
  MERGE: 0, FIX: 1, RESOLVE: 2, REVIEW: 3, PROMOTE: 4, NEEDS_DETAIL: 5, TRIAGE: 6, IMPLEMENT: 7,
};

// The ladder order as a list, DERIVED from RANK rather than restated. The
// multi-repo merge needs to walk kinds in order too, and a second hand-written
// copy of this sequence would silently keep the old order the day RANK changes.
export const RANKED_KINDS: ActionKind[] =
  (Object.keys(RANK) as ActionKind[]).sort((a, b) => RANK[a] - RANK[b]);

// Merge several repos' action lists into one dispatch order (#124).
//
// Ladder rank still dominates — finishing in-flight work before starting new
// work is the point of the ladder, and it holds across repos too. WITHIN a rank
// the repos take turns, so a board with 30 ready issues cannot take every slot
// ahead of a board with 2. `offset` rotates who goes first, so the same repo
// does not permanently win every tie; callers pass an incrementing cursor.
//
// Exported and pure so the RULE is testable against the code that actually
// ships. It previously lived as a private method on LiveRunner with the test
// asserting a hand-copied duplicate — which passes whatever the real one does.
export function fairShare(byRepo: Map<string, BoardAction[]>, offset = 0): BoardAction[] {
  const lists = [...byRepo.values()].filter((l) => l.length);
  if (lists.length <= 1) return lists[0] ?? [];

  const out: BoardAction[] = [];
  const start = ((offset % lists.length) + lists.length) % lists.length;
  for (const kind of RANKED_KINDS) {
    const queues = lists.map((l) => l.filter((a) => a.kind === kind));
    for (let i = 0; queues.some((q) => q.length > i); i++) {
      for (let j = 0; j < queues.length; j++) {
        const q = queues[(j + start) % queues.length];
        if (q[i]) out.push(q[i]);
      }
    }
  }
  return out;
}

// A FIX action maps to the 'fix' role here. The runner may upgrade it to
// 'rewrite' at dispatch time once the item has failed enough review rounds --
// classify is pure and has no attempt history, so it cannot make that call.
// NEEDS_DETAIL is null for the same reason PROMOTE is: it is a label + comment,
// not work. Spending a student to tell a human their issue is thin would cost
// more than the issue is currently worth.
const ROLE_FOR: Record<ActionKind, Role | null> = {
  MERGE: 'merge', FIX: 'fix', RESOLVE: 'resolve', REVIEW: 'review',
  PROMOTE: null, NEEDS_DETAIL: null, TRIAGE: 'triage', IMPLEMENT: 'implement',
};

function makeAction(repo: string, kind: ActionKind, target: 'issue' | 'pr', number: number, reason: string): BoardAction {
  return { repo, kind, target, number, role: ROLE_FOR[kind], reason };
}

function hasLabel(labels: string[], name: string): boolean {
  return labels.some((l) => l.toLowerCase() === name);
}

// The issue number a PR is for, parsed from its head branch (repo convention:
// `.../issue-<n>-...`). null when the branch doesn't encode one.
export function pullIssueNumber(pr: OpenPull): number | null {
  const m = pr.headRefName.match(/issue[-/](\d+)/i);
  return m ? Number(m[1]) : null;
}

// The engine's durable "I give up on this one" marker. The watchdog applies it
// after an item has been worked repeatedly with no progress; classify then emits
// NO action for it, so it costs nothing until a human looks. Honoured here rather
// than only in the runner's in-memory quarantine set, because that set died with
// the process — a restart re-dispatched the same unfixable items, re-wedged them,
// and re-killed the engine. Remove the label to hand the item back to the board.
export const GIVE_UP_LABEL = 'runner-error';

// Parked because the SPEC moved underneath the work, not because the engine
// failed at it. Distinct from runner-error so an operator can tell "someone
// rewrote the issue" apart from "the engine gave up"; both stop dispatch
// identically, and both are cleared by removing the label.
export const SPEC_CHANGED_LABEL = 'spec-changed';

// Parked because the work is ALREADY DONE on the base branch, not because the
// engine failed at it. Distinct from runner-error for the same reason
// spec-changed is: `runner-error` sent an operator hunting for a crash that
// never happened. dungeonworks #110/#111 carried it for nine and six attempts
// each while their code sat merged on main since PR #129.
//
// Like every parking label it stops dispatch and is cleared by removing it --
// but the right resolution here is usually to CLOSE the item, not release it.
export const ALREADY_SATISFIED_LABEL = 'already-satisfied';

// Every label that parks an item: present on an issue or PR, classify emits no
// action for it. This is the ONE definition of "parked" — exported so callers
// that report on the board (the ingest headline in live.ts) agree with the
// dispatcher instead of drifting from it. #129 was exactly that drift: the
// headline counted a label-agnostic readyQueue, so a fully parked board logged
// "2 ready to start" and then dispatched nothing, which reads as a hang.
// `needs-human` joins the parking labels rather than getting its own mechanism.
// Parking is exactly the semantics Admissions wants: the issue stays OPEN and
// visible on GitHub, keeps its place in the dependency graph, and simply yields
// no action — so no student is ever dispatched to work it cannot finish. It also
// inherits the existing override for free: remove the label and the next ingest
// picks the issue up, which reconcileUnparked already handles.
export const PARKED_LABELS: readonly string[] = [
  GIVE_UP_LABEL, SPEC_CHANGED_LABEL, NEEDS_HUMAN_LABEL, ALREADY_SATISFIED_LABEL,
];

// True when any parking label is present. Prefer this over open-coding the
// label checks, so adding a third parking label updates every caller at once.
export function isParked(labels: string[]): boolean {
  return PARKED_LABELS.some((name) => hasLabel(labels, name));
}

// Which parking labels are on this item, for operator-facing breakdowns.
export function parkedReasons(labels: string[]): string[] {
  return PARKED_LABELS.filter((name) => hasLabel(labels, name));
}

// A PR that is BOTH approved and given-up-on is a silent deadlock (#173):
// `reviewed-ok` says the work is good, `runner-error` says the engine could not
// land it. The two contradict — it can never merge, and because isParked()
// short-circuits classifyPull it yields NO action, so it sits invisible until a
// human goes looking (PR #56 sat this way ~90 minutes on 2026-08-08). Detected
// and surfaced here; never auto-resolved by stripping a label, because which
// label is wrong depends on WHY it parked, and guessing risks either re-wedging
// the engine or merging something the watchdog stopped for cause.
export function isDeadlocked(pr: OpenPull): boolean {
  const reviewedOk = hasLabel(pr.labels, 'reviewed-ok') || pr.reviewDecision === 'APPROVED';
  const gaveUp = hasLabel(pr.labels, GIVE_UP_LABEL);
  return reviewedOk && gaveUp;
}

// Every open PR in the approved-and-given-up-on deadlock, in board order.
export function deadlockedPulls(pulls: OpenPull[]): OpenPull[] {
  return pulls.filter(isDeadlocked);
}

// A parked board item and which parking labels hold it (#174).
export interface ParkedRef {
  target: 'issue' | 'pr';
  number: number;
  title: string;
  labels: string[]; // the parking labels present (a subset of PARKED_LABELS)
}

// Every issue/PR carrying a parking label, so the dashboard can list what is
// parked (and why) instead of a quiet board reading as idle. Issues first, then
// PRs, each in board order. Pure — the same parkedReasons the dispatcher trusts.
export function parkedItems(issues: RawIssue[], pulls: OpenPull[]): ParkedRef[] {
  const out: ParkedRef[] = [];
  for (const i of issues) {
    const labels = parkedReasons(i.labels.map((l) => l.name));
    if (labels.length) out.push({ target: 'issue', number: i.number, title: i.title, labels });
  }
  for (const p of pulls) {
    const labels = parkedReasons(p.labels);
    if (labels.length) out.push({ target: 'pr', number: p.number, title: p.title, labels });
  }
  return out;
}

// One PR -> at most one action.
function classifyPull(repo: string, pr: OpenPull, cfg: ClassifyConfig): BoardAction | null {
  if (isParked(pr.labels)) return null;
  const changesRequested = hasLabel(pr.labels, 'changes-requested') || pr.reviewDecision === 'CHANGES_REQUESTED';
  const reviewedOk = hasLabel(pr.labels, 'reviewed-ok') || pr.reviewDecision === 'APPROVED';
  const redCI = pr.statusCheckRollup === 'FAILURE';
  // No checks configured ('') counts as green — there's nothing to block on.
  const greenCI = pr.statusCheckRollup === 'SUCCESS' || pr.statusCheckRollup === '';

  if (changesRequested || redCI) {
    return makeAction(repo, 'FIX', 'pr', pr.number, changesRequested ? 'Reviewer requested changes.' : 'CI is red.');
  }
  if (pr.mergeable === 'CONFLICTING') {
    return makeAction(repo, 'RESOLVE', 'pr', pr.number, 'PR conflicts with its base branch.');
  }
  if (reviewedOk && greenCI && pr.mergeable === 'MERGEABLE') {
    if (!cfg.autoMerge) return null; // PR-only: a human merges.
    return makeAction(repo, 'MERGE', 'pr', pr.number, 'Approved, green, and mergeable.');
  }
  if (!reviewedOk) {
    return makeAction(repo, 'REVIEW', 'pr', pr.number, 'PR has no review verdict yet.');
  }
  return null; // reviewed-ok but CI pending / mergeability unknown -> wait.
}

// One issue -> at most one action. `openIssueNumbers` is the set of still-open
// issue numbers; a dep NOT in it is closed (its PR merged).
function classifyIssue(repo: string, issue: RawIssue, openIssueNumbers: Set<number>, cfg: ClassifyConfig = {}): BoardAction | null {
  const deps = parseDeps(issue.body).map((d) => Number(d.slice(1)));
  const openDeps = deps.filter((n) => openIssueNumbers.has(n));
  if (openDeps.length > 0) return null; // still blocked by an open dependency.

  // Deps all closed. A stale `blocked` label means a dependency's PR just
  // merged -> promote it (drop `blocked`) so the next ingest implements it.
  const labels = issue.labels.map((l) => l.name);
  if (isParked(labels)) return null;
  if (hasLabel(labels, 'blocked')) {
    return makeAction(repo, 'PROMOTE', 'issue', issue.number, 'Blocking dependencies are now closed.');
  }

  // An epic is a TRACKER, not a unit of work. Scope triage carved its criteria
  // into children and each child carries exactly one, so there is nothing left
  // on the parent to build.
  //
  // `epic` already suppressed re-TRIAGE (triage.ts) and settled the size
  // question for the audit (issueAudit.ts). Nothing suppressed IMPLEMENT, and
  // dispatching a student at an epic went wrong in both directions on
  // dungeonworks in one afternoon:
  //
  //   - #81 was split into #234/#235/#236, then dispatched IMPLEMENT four times
  //     between 18:37 and 18:43. Each student found every criterion already
  //     owned by a child, changed no files, and the watchdog quarantined the
  //     issue as `runner-error`.
  //   - #76, #78 and #82 were split, then their epic students built the WHOLE
  //     parent and merged it as one PR (#245, #246, #248). That orphaned all
  //     eight pieces: #237-#244 each burned four more no-op dispatches
  //     describing code that was already in `main`.
  //
  // Placed AFTER the deps check so a blocked epic simply reads as blocked, and
  // after PROMOTE so a stale `blocked` label is still cleaned off it. It holds
  // once the pieces close too — an epic never becomes implementable, it just
  // stops having open children.
  if (hasLabel(labels, EPIC_LABEL)) return null;

  // Deterministic audit BEFORE any student is considered (issueAudit.ts). It
  // reads the issue text and costs nothing, so it is always the cheapest thing
  // that can decide the item — and the two failure modes it catches (no stated
  // criteria; more scope than one PR) are both far cheaper to catch here than
  // after a session has been spent discovering them.
  const audit = auditIssue(issue, cfg.issueAudit?.gate);

  // A human already removing the label is the override: `needs-detail` present
  // means the audit spoke and nobody has disagreed, so keep waiting rather than
  // re-commenting every heartbeat.
  const flagged = hasLabel(labels, NEEDS_DETAIL_LABEL);

  if (audit.verdict === 'underspecified' && cfg.issueAudit?.enforce) {
    if (flagged) return null;   // already labelled and waiting on a human
    return makeAction(repo, 'NEEDS_DETAIL', 'issue', issue.number,
      `Not actionable as written: ${audit.reasons.join('; ')}.`,
    );
  }

  // Oversized and never assessed: find out whether one PR can satisfy it before
  // a student spends a dispatch discovering it cannot. Trader-Screener #126
  // took 16 commits across 10 review rounds for exactly this reason.
  //
  // The audit's `oversized` verdict and needsTriage() are held to the same
  // thresholds on purpose (see DEFAULT_AUDIT_GATE); either one asking for triage
  // is enough, so a future divergence fails toward assessing rather than toward
  // silently building an epic.
  if (cfg.triage !== false && (audit.verdict === 'oversized' || needsTriage(issue))) {
    return makeAction(repo, 'TRIAGE', 'issue', issue.number, 'Large issue, not yet assessed for scope.');
  }
  return makeAction(repo, 'IMPLEMENT', 'issue', issue.number,
    deps.length ? 'Dependencies closed; ready to build.' : 'Ready to build.',
  );
}

export function classify(issues: RawIssue[], pulls: OpenPull[], cfg: ClassifyConfig = {}, repo = ''): BoardAction[] {
  const actions: BoardAction[] = [];

  // Issues whose parking label must also hold back their PR.
  //
  // Parking is recorded on the ISSUE, but once a PR exists classify drives the
  // PR and never looks at the issue again — so a parked issue with an open PR
  // kept being worked. dungeonworks #18 is the case: flagged `needs-human`
  // because its deliverable is a GPU measurement, yet its PR #108 sat on
  // `changes-requested` and was dispatched FIX again on the next boot. Three of
  // the four changes that review demanded (run the 324-call matrix, record the
  // decision, commit the report) cannot be produced from a worktree at all, so
  // every fix round was guaranteed to fail on the same three items.
  //
  // A PR cannot outrun its issue's blocker. If the work cannot be finished, the
  // PR carrying it cannot be finished either.
  const parkedIssues = new Set<number>();
  for (const issue of issues) {
    if (isParked(issue.labels.map((l) => l.name))) parkedIssues.add(issue.number);
  }

  // PRs first: they are the in-flight work the board should drive to done.
  for (const pr of pulls) {
    const linked = pullIssueNumber(pr);
    if (linked !== null && parkedIssues.has(linked)) continue;
    const a = classifyPull(repo, pr, cfg);
    if (a) actions.push(a);
  }

  // An issue that already has an open PR is in the PR pipeline — its PR drives
  // the action, so don't also emit IMPLEMENT/PROMOTE for the issue.
  const issuesInPr = new Set<number>();
  for (const pr of pulls) {
    const n = pullIssueNumber(pr);
    if (n !== null) issuesInPr.add(n);
  }

  const openIssueNumbers = new Set(issues.map((i) => i.number));
  for (const issue of issues) {
    if (issuesInPr.has(issue.number)) continue;
    const a = classifyIssue(repo, issue, openIssueNumbers, cfg);
    if (a) actions.push(a);
  }

  // Most urgent kind first, then lowest number (mirrors github.ts's
  // "lower issue number = higher priority").
  return actions.sort((a, b) => RANK[a.kind] - RANK[b.kind] || a.number - b.number);
}
