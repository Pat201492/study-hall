import type { OpenPull } from './github.js';
import type { Task } from './taskmap.js';
import type { OwnedFile } from './ownership.js';
import { IMPLEMENT_ROLE, REVIEW_ROLE, FIX_ROLE, RESOLVE_ROLE, REWRITE_ROLE, TRIAGE_ROLE } from './roles.js';
import { ciFixDirective, type CiFailureClass } from './ciFailure.js';

// Every prompt a CLI student runs, in one module.
//
// Each builder is the same shape: the byte-stable ROLE constant FIRST, then the
// per-task specifics. That order is the whole point and is load-bearing, not
// style — the stable prefix is what the CLI's own prompt cache hits when a warm
// student is re-roled and resumed (see CLAUDE.md). Interpolating anything
// task-specific ahead of the role block would move the cache boundary and turn
// every task back into a cold read, which is the tax Study Room exists to avoid.
//
// They are pure string builders over a Task/OpenPull plus an issue body — no
// LiveRunner state — so the cached-prefix contract is reviewable in one file
// instead of scattered through the orchestrator.
//
// The repo spec (#125) sits immediately AFTER the role block and before any
// per-task text. That position is chosen, not incidental:
//   - the GUARANTEED-stable prefix is still the role constant alone, which is
//     repo-agnostic, so warm slots stay fully fungible across repos and the
//     Protector's ladder needs no repo dimension;
//   - two tasks in the SAME repo additionally share [role + spec], so the spec
//     caches for consecutive same-repo work at no cost to that fungibility;
//   - a worker switching repos keeps the role portion cached and re-reads only
//     the spec portion — a partial miss, still far cheaper than a cold spawn.
// Nothing task-specific may move ahead of the spec block without pushing the
// cache boundary back to the role constant and undoing the middle benefit.

// A large CLAUDE.md would otherwise dominate every prompt. Truncate with a
// visible marker rather than silently, so a student can tell its context was
// cut and go read the file itself. Generous enough for a real spec; small
// enough that a pathological one cannot crowd out the task.
export const MAX_SPEC_CHARS = 12000;

// The repo-context block. Returns NO lines at all when there is no spec — an
// empty block is better than filler like "(no spec files found in repo)", which
// spends prefix bytes telling the student nothing.
export function specBlock(spec: string): string[] {
  const trimmed = (spec ?? '').trim();
  if (!trimmed) return [];
  const body = trimmed.length > MAX_SPEC_CHARS
    ? `${trimmed.slice(0, MAX_SPEC_CHARS)}\n\n[... spec truncated at ${MAX_SPEC_CHARS} characters — read the files directly for the rest ...]`
    : trimmed;
  return [
    `## Repository conventions`,
    ``,
    `These are this repository's own spec files. Follow them; they override`,
    `general habits. Do not re-read them from disk unless you need a section`,
    `that was truncated.`,
    ``,
    body,
    ``,
  ];
}

// The ownership block (#176): files that belong to ANOTHER in-flight task. The
// implementer is told to leave them alone and to STOP rather than build a
// competing version when it needs one. Empty (no lines) when nothing else has
// declared ownership, so a board that doesn't use `Owns:` is byte-identical.
export function ownershipBlock(owned: OwnedFile[]): string[] {
  if (!owned.length) return [];
  return [
    `## Files owned by other in-flight tasks — do NOT create or edit these`,
    ``,
    `Each of these belongs to a DIFFERENT task being built right now. Do not`,
    `create, edit, or delete any of them. If your issue genuinely cannot be`,
    `satisfied without one, do NOT build your own version — STOP, and state`,
    `clearly which file you need and which task owns it, as a missing dependency`,
    `the board is lacking. A competing copy just re-conflicts for both of you.`,
    ``,
    ...owned.map((o) => `- \`${o.file}\`  (owned by ${o.owner})`),
    ``,
  ];
}

// The implementer's prompt: role block, repo spec, the ownership guard, then the
// issue to build. Ownership sits AFTER the spec (same cache rule as everything
// else): the guaranteed-stable prefix is still the role constant.
export function taskPrompt(task: Task, body: string, spec = '', owned: OwnedFile[] = []): string {
  // Stable role block (cached prefix) first, repo spec next, then per-task.
  return [
    IMPLEMENT_ROLE,
    ``,
    ...specBlock(spec),
    ...ownershipBlock(owned),
    `## Issue ${task.id}: ${task.title}`,
    ``,
    body || '(no description provided)',
  ].join('\n');
}

// The reviewer's task prompt: the byte-stable REVIEW_ROLE prefix (so a re-roled
// warm student's cache keeps hitting) followed by the per-PR specifics — the
// diff (fetched by the student via `gh pr diff`) and the linked issue's
// acceptance criteria to judge it against.
export function reviewPrompt(pr: OpenPull, issueNum: number | null, issueBody: string, slug: string, spec = ''): string {
  return [
    REVIEW_ROLE,
    ``,
    ...specBlock(spec),
    `## Pull request #${pr.number}: ${pr.title}`,
    ``,
    `Read the full diff by running, in this worktree:`,
    `    gh pr diff ${pr.number} -R ${slug}`,
    ``,
    issueNum != null
      ? `This PR claims to close issue #${issueNum}. Its goal + acceptance criteria:\n\n${issueBody || '(no description provided)'}`
      : `(no linked issue found — review the diff on its own merits)`,
    ``,
    `Judge the diff against those acceptance criteria and the repo's CLAUDE.md conventions.`,
    `List every required change as a concrete, file/line-tied item, then end with a single`,
    `final line, exactly one of:`,
    `    VERDICT: APPROVE`,
    `    VERDICT: REQUEST_CHANGES`,
  ].join('\n');
}

/** How much review feedback the fixer is given. */
export const MAX_FEEDBACK_CHARS = 4000;

/**
 * Keep the NEWEST review feedback, not the oldest.
 *
 * prReviewFeedback returns a PR's review history with the newest state first,
 * and this used to hand the fixer `feedback.slice(0, 4000)` — a HEAD slice.
 * Whenever the history ran past the cap, that kept the oldest rounds and threw
 * away the newest, which is the one round the fixer was dispatched to answer.
 *
 * Measured across 31 fix dispatches on the live board: 26% lost the tail of the
 * dispatching verdict — including the items at the end and the final
 * `VERDICT: REQUEST_CHANGES` line — and 10% saw none of it at all, reading only
 * superseded rounds. A fixer answering a stale review produces a diff the
 * reviewer rejects again, and a rework round costs a whole extra session.
 *
 * Slicing from the end fixes the ordering. The cap itself stays: an unbounded
 * history would land in the prompt and be re-read on every turn.
 */
export function keepNewestFeedback(feedback: string, max = MAX_FEEDBACK_CHARS): string {
  const text = feedback ?? '';
  if (text.length <= max) return text;
  const kept = text.slice(-max);
  // Say what was dropped, so a fixer that finds the context thin knows there is
  // older history rather than assuming it has the whole picture.
  return `[... ${text.length - max} characters of OLDER review history omitted ...]\n${kept}`;
}

// The fixer's prompt: the byte-stable FIX_ROLE prefix (so a re-roled warm
// student's cache keeps hitting) then this PR's specifics — the written review
// feedback to address and/or a pointer to the failing checks, plus the linked
// issue's acceptance criteria the fix must still satisfy. The student is already
// checked out on the PR branch and edits + commits + pushes there.
//
// `ci` (#172) carries the pre-classified red-CI failure: its class decides what
// the fixer is TOLD (a harness failure explicitly forbids editing test bodies),
// and a log excerpt is included so the student sees the actual error rather than
// re-deriving it. Absent (or class 'unknown') falls back to the generic "inspect
// the checks" guidance. It stays per-PR text AFTER the role+spec prefix, so the
// cache boundary is unmoved.
export function fixPrompt(
  pr: OpenPull, slug: string, feedback: string, issueBody: string, spec = '',
  ci?: { class: CiFailureClass; log?: string },
): string {
  const lines = [
    FIX_ROLE,
    ``,
    ...specBlock(spec),
    `## PR #${pr.number}: ${pr.title}  (branch \`${pr.headRefName}\`)`,
    ``,
    `You are already checked out on this branch. Read the current diff with:`,
    `    gh pr diff ${pr.number} -R ${slug}`,
    ``,
  ];
  if (feedback) {
    lines.push(`Review feedback to address:`, ``, keepNewestFeedback(feedback), ``);
  }
  if (pr.statusCheckRollup === 'FAILURE') {
    const directive = ci ? ciFixDirective(ci.class) : [];
    if (directive.length) {
      lines.push(`CI is RED on this PR.`, ...directive, ``);
      if (ci?.log?.trim()) {
        lines.push(`The failing CI log (tail):`, '```', ci.log.trim().slice(-3000), '```', ``);
      }
      lines.push(`Confirm the failing checks yourself if needed:`, `    gh pr checks ${pr.number} -R ${slug}`, ``);
    } else {
      lines.push(
        `CI is RED on this PR. Inspect the failing checks and their logs with:`,
        `    gh pr checks ${pr.number} -R ${slug}`,
        `and fix the cause so every check passes.`,
        ``,
      );
    }
  }
  if (!feedback && pr.statusCheckRollup !== 'FAILURE') {
    lines.push(`This PR is marked changes-requested — address the reason it was rejected.`, ``);
  }
  if (issueBody) {
    lines.push(`Issue context (acceptance criteria the fix must still meet):`, ``, issueBody.slice(0, 1500));
  }
  return lines.join('\n');
}

// The triage analyst's prompt: role block, repo spec, then the issue to assess.
// Same prefix ordering as every other builder, so a re-roled warm student keeps
// its cache. The issue body is given in full and unbounded by design -- judging
// whether something is one PR's worth of work requires seeing all of it.
export function triagePrompt(task: Task, body: string, spec = ''): string {
  return [
    TRIAGE_ROLE,
    ``,
    ...specBlock(spec),
    `## Issue ${task.id}: ${task.title}`,
    ``,
    body || '(no description provided)',
  ].join('\n');
}

// The rewriter's prompt: the byte-stable REWRITE_ROLE prefix, then this PR's
// specifics. Unlike fixPrompt it leads with the ISSUE, not the review feedback —
// the point is to reimplement against the acceptance criteria rather than to
// patch the rejected approach one more time. The review history is included as
// evidence of what has already been rejected, explicitly framed as something to
// learn from rather than a checklist to apply.
export function rewritePrompt(
  pr: OpenPull, slug: string, issueBody: string, feedback: string, rounds: number, spec = '',
): string {
  const lines = [
    REWRITE_ROLE,
    ``,
    ...specBlock(spec),
    `## PR #${pr.number}: ${pr.title}  (branch \`${pr.headRefName}\`)`,
    ``,
    `This PR has failed review ${rounds} times. Reimplement it.`,
    ``,
    `The issue's goal and acceptance criteria — build to THIS:`,
    ``,
    issueBody ? issueBody.slice(0, 4000) : '(no issue body found — read the PR description)',
    ``,
    `The current diff, for reference only:`,
    `    gh pr diff ${pr.number} -R ${slug}`,
    ``,
  ];
  if (feedback) {
    lines.push(
      `What reviewers rejected across those rounds. Understand why, then build something`,
      `that does not have these problems — do not simply patch each point:`,
      ``,
      keepNewestFeedback(feedback),
      ``,
    );
  }
  return lines.join('\n');
}

// The resolver's prompt: the byte-stable RESOLVE_ROLE prefix (cache-friendly)
// followed by this PR's specifics. The runner has ALREADY started the base
// merge, so the student only clears the conflict markers — committing/pushing
// is the runner's job (finishMergePush), same division of labor as IMPLEMENT.
//
// `regenerated` names any GENERATED files (lockfiles) whose conflicts the runner
// regenerates itself after this student finishes (#175). The student is told to
// leave those markers alone: a three-way merge of a machine-written lockfile is
// meaningless, and touching it just wastes the diff. Empty in the common case.
export function resolvePrompt(pr: OpenPull, base: string, issueBody: string, spec = '', regenerated: string[] = []): string {
  const lines = [
    RESOLVE_ROLE,
    ``,
    ...specBlock(spec),
    `## PR #${pr.number}: ${pr.title}  (branch \`${pr.headRefName}\`)`,
    ``,
    `A merge of \`origin/${base}\` into this branch is ALREADY in progress and has`,
    `left conflict markers in one or more files. Do NOT re-run \`git merge\`.`,
    `Resolve every conflicted file now, keeping BOTH this PR's changes and the`,
    `base's changes. When the working tree is conflict-free you are done —`,
    `committing and pushing are handled for you.`,
  ];
  if (regenerated.length) {
    lines.push(
      ``,
      `Do NOT resolve these generated files by hand — they are rebuilt from their`,
      `manifest for you after you finish. Leave their conflict markers as they are:`,
      `    ${regenerated.join(', ')}`,
    );
  }
  lines.push(
    ``,
    `Issue context:`,
    issueBody ? issueBody.slice(0, 1500) : '(no issue body)',
  );
  return lines.join('\n');
}
