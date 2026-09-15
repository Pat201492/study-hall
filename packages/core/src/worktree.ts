import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { orphanWorktrees } from './watchdog.js';
import type { GeneratedConflict } from './generated.js';

// Git worktree ownership: one clone of the target repo, plus a dedicated
// worktree per task so concurrent students never collide on files or index.
// A student does all its work inside its worktree (cwd-pinned by the
// WorktreeToolExecutor); this module handles the git plumbing around it —
// clone, branch off latest master, commit, push. It NEVER merges (PR-only).

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 20 * 1024 * 1024 });
  return stdout.trim();
}

export interface RepoClone {
  url: string;
  dir: string;           // the clone
  worktreesRoot: string; // sibling dir holding per-task worktrees
  base: string;          // base branch (e.g. "master")
}

// Ensure a local clone exists and its base branch is current with origin.
// Idempotent: clones on first call, fast-forwards on later calls.
export async function ensureClone(
  url: string, dir: string, base = 'master',
  identity = { name: 'Pat201492', email: 'pegan604@gmail.com' },
): Promise<RepoClone> {
  if (!existsSync(join(dir, '.git'))) {
    await execFileAsync('git', ['clone', url, dir], { maxBuffer: 20 * 1024 * 1024 });
  }
  await git(dir, ['config', 'user.name', identity.name]);
  await git(dir, ['config', 'user.email', identity.email]);
  // Resolve the real base branch: honor `base` only if it exists on origin,
  // otherwise fall back to origin's default branch (main vs master, etc.).
  base = await resolveBase(dir, base);
  await git(dir, ['fetch', 'origin', base, '--prune']);
  // Keep the primary clone parked on an up-to-date base; worktrees branch off origin/base.
  await git(dir, ['checkout', base]).catch(() => undefined);
  await git(dir, ['reset', '--hard', `origin/${base}`]).catch(() => undefined);
  return { url, dir, worktreesRoot: join(dirname(dir), 'worktrees'), base };
}

// Determine the branch to build from. Prefers `preferred` when it exists on
// origin; otherwise uses origin's HEAD (set by `git clone`), then a first-head
// fallback, then 'main'. Keeps the pool working on repos whose default isn't master.
async function resolveBase(dir: string, preferred: string): Promise<string> {
  const exists = await git(dir, ['ls-remote', '--exit-code', '--heads', 'origin', preferred])
    .then(() => true).catch(() => false);
  if (exists) return preferred;
  const head = await git(dir, ['symbolic-ref', 'refs/remotes/origin/HEAD']).catch(() => '');
  const m = head.match(/origin\/(.+)$/);
  if (m) return m[1];
  const ls = await git(dir, ['ls-remote', '--symref', 'origin', 'HEAD']).catch(() => '');
  const m2 = ls.match(/refs\/heads\/(\S+)\s+HEAD/);
  return m2 ? m2[1] : 'main';
}

// Add a fresh worktree on a new branch cut from the CURRENT origin/base, so
// each task starts from the latest merged state (a dependency merged since the
// last task is already present). Returns the absolute worktree path.
export async function addWorktree(repo: RepoClone, branch: string): Promise<string> {
  await git(repo.dir, ['fetch', 'origin', repo.base, '--prune']);
  const wt = join(repo.worktreesRoot, branch.replace(/[/\\]/g, '__'));
  // Clean any stale worktree/branch from a previous run so re-runs don't fail.
  await removeWorktree(repo, wt).catch(() => undefined);
  await git(repo.dir, ['branch', '-D', branch]).catch(() => undefined);
  await git(repo.dir, ['worktree', 'add', '-b', branch, wt, `origin/${repo.base}`]);
  return wt;
}

// Add a worktree checked out on an EXISTING remote branch (a PR's head), so a
// resolver/fixer works on the PR's ACTUAL content — not a fresh branch cut from
// base. Fetches the branch (and base, for a later `git merge origin/base`)
// first. Returns the absolute worktree path.
export async function addWorktreeForBranch(repo: RepoClone, branch: string): Promise<string> {
  await git(repo.dir, ['fetch', 'origin', branch, repo.base, '--prune']);
  const wt = join(repo.worktreesRoot, branch.replace(/[/\\]/g, '__'));
  // Clean any stale worktree/local branch from a previous run so re-runs don't fail.
  await removeWorktree(repo, wt).catch(() => undefined);
  await git(repo.dir, ['branch', '-D', branch]).catch(() => undefined);
  await git(repo.dir, ['worktree', 'add', '-b', branch, wt, `origin/${branch}`]);
  return wt;
}

// Merge origin/base into the worktree's branch to bring a stale PR up to date.
// A clean merge auto-commits and returns { conflicts: false }; a conflicting one
// leaves conflict markers (unmerged paths) for a resolver to fix and returns
// { conflicts: true }. Throws only on a real git error (a non-zero merge with no
// unmerged paths is not an ordinary conflict).
export async function startBaseMerge(repo: RepoClone, wt: string): Promise<{ conflicts: boolean }> {
  try {
    await git(wt, ['merge', `origin/${repo.base}`, '--no-edit']);
    return { conflicts: false };
  } catch (e) {
    const unmerged = await git(wt, ['ls-files', '--unmerged']).catch(() => '');
    if (unmerged.trim().length === 0) throw e;
    return { conflicts: true };
  }
}

// The paths git currently reports as unmerged (conflict markers in the working
// tree) — the file list a resolver has to clear. Empty when the tree is clean.
export async function conflictedFiles(wt: string): Promise<string[]> {
  const out = await git(wt, ['diff', '--name-only', '--diff-filter=U']).catch(() => '');
  return out.split('\n').map((l) => l.trim()).filter(Boolean);
}

// The outcome of one lockfile regeneration.
export interface RegenResult {
  path: string;
  ok: boolean;
  error?: string;
}

// Regenerate each conflicted generated file (#175) from its now-merged manifest
// instead of three-way merging it. For each: take the base version to clear the
// markers, run the rule's regenerate command in the file's directory, and stage
// the result. A generated lockfile carries no information a resolver could read,
// and a merge of it is meaningless even when it "succeeds".
//
// If regeneration FAILS, the conflict is restored (`git checkout -m`) rather than
// left staged with a stale base version: an install that won't complete is a
// genuine dependency conflict — real signal — and must surface as a still-
// conflicted file a resolver escalates to, not be silently committed wrong.
export async function regenerateLockfiles(
  wt: string, generated: GeneratedConflict[],
): Promise<RegenResult[]> {
  const out: RegenResult[] = [];
  for (const { path, rule } of generated) {
    const cwd = join(wt, dirname(path));
    try {
      // Base version first: a lockfile full of conflict markers is invalid JSON,
      // and the package manager needs a parseable one to resolve against.
      await git(wt, ['checkout', '--theirs', '--', path]);
      const [bin, ...args] = rule.regen;
      await execFileAsync(bin, args, { cwd, maxBuffer: 20 * 1024 * 1024 });
      await git(wt, ['add', '--', path]);
      out.push({ path, ok: true });
    } catch (e) {
      // Restore the conflict so an escalated resolver sees it, rather than
      // leaving base's (wrong-for-the-merge) version staged.
      await git(wt, ['checkout', '-m', '--', path]).catch(() => undefined);
      out.push({ path, ok: false, error: String((e as Error)?.message ?? e) });
    }
  }
  return out;
}

// Finalize a resolution: stage the resolved files, complete the merge commit if
// one is still in progress (conflicts were just cleared), and push the branch.
// Idempotent — if the student already committed/pushed, the add/commit are
// no-ops and the push reports "up to date".
export async function finishMergePush(wt: string, branch: string, message: string): Promise<void> {
  await git(wt, ['add', '-A']).catch(() => undefined);
  const merging = await git(wt, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).then(() => true, () => false);
  if (merging) await git(wt, ['commit', '--no-edit', '-m', message]);
  await git(wt, ['push', 'origin', branch]);
}

// True if the worktree has any staged/unstaged/untracked changes.
export async function hasChanges(wt: string): Promise<boolean> {
  const out = await git(wt, ['status', '--porcelain']);
  return out.length > 0;
}

// Stage everything, commit, and push the branch to origin. Returns false if
// there was nothing to commit (the student made no file changes).
export async function commitAndPush(wt: string, branch: string, message: string): Promise<boolean> {
  if (!(await hasChanges(wt))) return false;
  await git(wt, ['add', '-A']);
  await git(wt, ['commit', '-m', message]);
  await git(wt, ['push', '-u', 'origin', branch]);
  return true;
}

// Current HEAD commit sha of the worktree. Lets a caller detect whether a
// student's run advanced the branch (a fix landed a commit) vs left it
// untouched, without depending on commitAndPush's "were there uncommitted
// changes" return (a student that self-commits leaves a clean tree).
export async function headSha(wt: string): Promise<string> {
  return git(wt, ['rev-parse', 'HEAD']);
}

// Push the branch's current commits to origin (idempotent — reports "up to
// date" if the student already pushed). The fixer commits on the PR branch
// itself, so this ensures those commits reach origin even when the working tree
// is already clean (nothing for commitAndPush to push).
export async function pushBranch(wt: string, branch: string): Promise<void> {
  await git(wt, ['push', 'origin', branch]);
}

// Remove a worktree (force, so a dirty tree is still cleaned up).
export async function removeWorktree(repo: RepoClone, wt: string): Promise<void> {
  await git(repo.dir, ['worktree', 'remove', '--force', wt]);
}

// The paths git currently tracks as worktrees (the primary clone + each
// registered worktree), parsed from `git worktree list --porcelain`.
export async function listRegisteredWorktrees(repo: RepoClone): Promise<string[]> {
  const out = await git(repo.dir, ['worktree', 'list', '--porcelain']).catch(() => '');
  return out.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice('worktree '.length).trim());
}

// Reap leftover worktree DIRECTORIES from a prior (crashed) run: dirs under
// worktreesRoot that git no longer tracks and that aren't currently in use.
// `git worktree prune` alone won't remove them (they're unregistered), yet the
// dir still exists so a later `git worktree add <dir>` fails "already exists"
// and every dispatch collides. prune -> diff (watchdog.orphanWorktrees) -> rm ->
// prune. Returns the orphan dirs removed.
export async function reapOrphanWorktrees(repo: RepoClone, inUse: string[] = []): Promise<string[]> {
  if (!existsSync(repo.worktreesRoot)) return [];
  await git(repo.dir, ['worktree', 'prune']).catch(() => undefined);
  const registered = await listRegisteredWorktrees(repo);
  const onDisk = (await readdir(repo.worktreesRoot).catch(() => [] as string[]))
    .map((d) => join(repo.worktreesRoot, d));
  const orphans = orphanWorktrees(onDisk, registered, inUse);
  for (const dir of orphans) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  if (orphans.length) await git(repo.dir, ['worktree', 'prune']).catch(() => undefined);
  return orphans;
}
