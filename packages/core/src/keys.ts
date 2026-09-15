import { join } from 'node:path';

// The pure half of v1 repoState.ts: every repo-qualified key builder/parser and
// the two path derivations. Zero project imports, so the key-format invariant
// — the load-bearing multi-repo decision — can be tested and reused with no
// filesystem behind it. The fs load/save half lives in repoStateIo.ts.

// A repo's own state directory under ~/.claude-study-room.
//
// Takes the CONFIGURED form (the github.com URL), not the bare slug, because
// that is what index.ts has always used to build the first repo's statusDir:
//   'https://github.com/owner/name' -> 'https---github.com-owner-name'
//
// Passing a slug here produced 'owner-name' instead, which meant repo #1 and
// repos #2+ lived under two different naming schemes for the same repo — and
// the slug form is already the EDITOR's directory, so a second repo's runner
// state landed on top of the Editor's HANDOFF.md and checkout. Deriving both
// from the configured URL keeps every repo in one scheme and leaves the
// existing first-repo directories exactly where they are (no migration).
export function stateDirFor(root: string, configured: string): string {
  return join(root, (configured || 'default').replace(/[/:]/g, '-'));
}

// Each repo's Task Map lives in its OWN state dir. It used to be a single
// constructor-injected path shared by every repo, so each repo's ingest
// overwrote the previous one's map and the last board to refresh won — the
// exact "no shared mutable file" rule #123 set out to establish.
export function taskMapPathFor(s: { stateDir: string }): string {
  return join(s.stateDir, 'taskmap.json');
}

// ---- repo-qualified keys ---------------------------------------------------
// Two boards both have an issue #7. Every id that crosses repo boundaries — task
// ids, action keys, item keys — therefore carries its repo, or one board's
// quarantine silently suppresses the other's work.

/** "owner/name#7" */
export function qualifyTaskId(slug: string, issueNumber: number): string {
  return `${slug}#${issueNumber}`;
}

/** Split "owner/name#7" back apart. Returns null for an unqualified id. */
export function parseTaskId(id: string): { slug: string; number: number } | null {
  const m = id.match(/^(.+?)#(\d+)$/);
  if (!m) return null;
  const number = Number(m[2]);
  // A bare "#7" (the single-repo form) has no slug — not an error, just not
  // qualified; callers fall back to the only configured repo.
  return m[1] ? { slug: m[1], number } : null;
}

/** "REVIEW:owner/name:pr-12" */
export function qualifyActionKey(kind: string, slug: string, target: 'issue' | 'pr', n: number): string {
  return `${kind}:${slug}:${target}-${n}`;
}

/** "owner/name:pr-12" — the item, independent of which action touches it. */
export function qualifyItemKey(slug: string, target: 'issue' | 'pr', n: number): string {
  return `${slug}:${target}-${n}`;
}

/**
 * Pull the repo + target out of either key shape, qualified or not.
 *
 * Tolerates the legacy unqualified forms ("REVIEW:pr-12", "pr-12") so a
 * quarantine.json written by an older single-repo run still loads instead of
 * silently un-parking everything it had condemned.
 */
export function parseQualifiedKey(
  key: string,
): { slug: string | null; kind: 'issue' | 'pr'; number: number } | null {
  // The slug must contain a slash. Without that, "REVIEW:pr-12" parses as
  // slug="REVIEW" — a legacy key silently read as a repo named after its action.
  const qualified = key.match(/^(?:[A-Z]+:)?([^:]+\/[^:]+):(issue|pr)-(\d+)$/);
  if (qualified) {
    return { slug: qualified[1], kind: qualified[2] as 'issue' | 'pr', number: Number(qualified[3]) };
  }
  const bare = key.match(/^(?:[A-Z]+:)?(issue|pr)-(\d+)$/);
  if (bare) return { slug: null, kind: bare[1] as 'issue' | 'pr', number: Number(bare[2]) };
  return null;
}

// Repo-qualified key for an in-flight issue/PR: "owner/name#124".
//
// The runner's in-flight trackers (inFlight, reviewing, fixing, resolving,
// merging) were keyed by bare number. Issue and PR numbers are per-repo, so two
// boards that each have a #5 collided and one silently masked the other.
export function fkey(slug: string, n: number): string {
  return `${slug}#${n}`;
}
