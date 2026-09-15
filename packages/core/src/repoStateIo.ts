import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { log } from './logger.js';
import type { TaskMap } from './taskmap.js';
import type { DeadlockedPr, ParkedItem } from './types.js';
import { parseParole, serializeParole, firstOffence, type ParoleRecord } from './parole.js';

// The fs half of v1 repoState.ts: the RepoState bundle and the per-repo
// persistence for handled/quarantine/attempts/lifetime. The pure key helpers
// (qualify*/parseQualifiedKey/fkey/stateDirFor/taskMapPathFor) live in keys.ts.

// Everything LiveRunner holds that belongs to ONE repo.
//
// The split is the point of this module: the engine's state divides cleanly into
// per-board facts (this file) and cross-board governance that must stay global
// (the Protector, the Watchdog's capacity backoff, the concurrency budget, the
// warm pool, attribution). Driving several repos means N of these behind one of
// those — never N engines, because the plan rate limit is account-wide and N
// engines each believe they own the whole concurrency budget.
//
// Each repo keeps its own state directory, so nothing here is a shared mutable
// file. A quarantine in repo A cannot suppress work in repo B.

// Local copy of the clone shape v1 worktree.ts exported; worktree.ts (git
// plumbing) is not part of core, and this is the only field that needed it.
export interface RepoClone {
  url: string;
  dir: string;           // the clone
  worktreesRoot: string; // sibling dir holding per-task worktrees
  base: string;          // base branch (e.g. "master")
}

export interface RepoState {
  /** owner/name — the identity everything else is keyed by. */
  slug: string;
  /** As configured (URL or slug); passed to `gh`, which accepts either. */
  configured: string;
  /** Where this repo's clone, worktrees, and json live. */
  stateDir: string;
  /** The working clone. Set by boot. */
  clone: RepoClone;
  /** The repo's CLAUDE.md / docs/SPEC.md, for the students' cached prefix. */
  spec: string;
  /** The board, re-derived from open issues each ingest. */
  taskMap: TaskMap;
  /** Issue numbers we have already opened a PR for. */
  handled: Set<number>;
  /** Action/item keys the watchdog has isolated on this board. */
  quarantined: Set<string>;
  /**
   * When each quarantine started and how many times the item has been paroled
   * and re-condemned. Parallel to `quarantined` (which stays a plain Set because
   * most readers only ask "is this held?"), and the reason a quarantine can end
   * without a human: see parole.ts.
   */
  paroleOf: Map<string, ParoleRecord>;
  /** Issue numbers whose spec was rewritten mid-run. */
  specChanged: Set<number>;
  /** Issue numbers a PROMOTE label-flip has already fired for. */
  promoted: Set<number>;
  /** When this repo last re-ingested, for the staggered refresh. */
  lastIngest: number;
  /** Set once this repo's churn has been reported, so it is not filed per tick. */
  contestedReported: boolean;
  /** Open PRs currently in the reviewed-ok+runner-error deadlock (#173), for
   *  /api/status. Refreshed each fetch; entering the state logs once, not per
   *  tick (live.ts diffs this against the previous list by number). */
  deadlocked: DeadlockedPr[];
  /** Board items carrying a parking label (#174), for the dashboard's Parked
   *  section. Refreshed each fetch. */
  parked: ParkedItem[];
}

export function newRepoState(slug: string, configured: string, stateDir: string): RepoState {
  return {
    slug,
    configured,
    stateDir,
    clone: undefined as unknown as RepoClone, // boot assigns
    spec: '',
    taskMap: { tasks: [] },
    handled: new Set(),
    quarantined: new Set(),
    paroleOf: new Map(),
    specChanged: new Set(),
    promoted: new Set(),
    lastIngest: 0,
    contestedReported: false,
    deadlocked: [],
    parked: [],
  };
}

// ---- persistence -----------------------------------------------------------
// Each file lives under the repo's own state dir. Reads degrade to empty rather
// than throwing: losing a ledger costs duplicated work, but failing to boot
// costs the whole run, and the run is the expensive thing.

export function handledPath(s: RepoState): string { return join(s.stateDir, 'handled.json'); }
export function quarantinePath(s: RepoState): string { return join(s.stateDir, 'quarantine.json'); }

export function loadHandled(s: RepoState): void {
  try {
    const raw = JSON.parse(readFileSync(handledPath(s), 'utf8')) as number[];
    if (Array.isArray(raw)) s.handled = new Set(raw.filter((n) => Number.isFinite(n)));
  } catch { /* fresh */ }
}

export function saveHandled(s: RepoState): void {
  mkdirSync(s.stateDir, { recursive: true });
  writeFileSync(handledPath(s), JSON.stringify([...s.handled]));
}

export function loadQuarantine(s: RepoState, now = Date.now()): string[] {
  if (!existsSync(quarantinePath(s))) return [];
  try {
    // Reads both shapes: the current [{key, at, paroles}] and the legacy bare
    // string[]. A legacy file's keys are real quarantines, so they load dated
    // from now -- each serves a full first sentence rather than the whole backlog
    // being released on the first tick after an upgrade.
    const records = parseParole(JSON.parse(readFileSync(quarantinePath(s), 'utf8')), now);
    for (const [k, rec] of records) { s.quarantined.add(k); s.paroleOf.set(k, rec); }
    return [...records.keys()];
  } catch {
    return [];
  }
}

export function saveQuarantine(s: RepoState): void {
  try {
    mkdirSync(s.stateDir, { recursive: true });
    // Every held key gets a record, so a quarantine written by a path that did
    // not stamp one still has a sentence and can still be paroled. Without this
    // an unstamped key would be held forever -- the exact bug parole exists to
    // remove.
    for (const k of s.quarantined) if (!s.paroleOf.has(k)) s.paroleOf.set(k, firstOffence(Date.now()));
    for (const k of [...s.paroleOf.keys()]) if (!s.quarantined.has(k)) s.paroleOf.delete(k);
    writeFileSync(quarantinePath(s), JSON.stringify(serializeParole(s.paroleOf)));
  } catch (e) {
    log.err(`${s.slug}: could not persist quarantine: ${e}`);
  }
}

// Attempt counts, persisted per repo.
//
// The watchdog counted attempts in memory only, so every restart handed a
// churning PR a fresh budget of fixes -- the rewrite escalation could never
// fire on an engine that restarts often, and #112's give-up cap was equally
// blind. Quarantine was made durable in #111; the counts that lead to it were
// not.
export function attemptsPath(s: RepoState): string { return join(s.stateDir, 'attempts.json'); }
// Lifetime dispatch counts live in their OWN file rather than extending
// attempts.json: that file is a flat Record<string, number> written by every
// tick, and widening its shape would make an older engine silently drop the
// ceiling it cannot parse. A separate file degrades to 'no history yet'.
export function lifetimePath(s: RepoState): string { return join(s.stateDir, 'lifetime.json'); }

export function loadLifetime(s: RepoState): Record<string, number> {
  try {
    const raw = JSON.parse(readFileSync(lifetimePath(s), 'utf8')) as Record<string, number>;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw)) if (Number.isFinite(v) && v > 0) out[k] = Number(v);
    return out;
  } catch {
    return {};
  }
}

export function saveLifetime(s: RepoState, counts: Record<string, number>): void {
  try {
    mkdirSync(s.stateDir, { recursive: true });
    const mine = Object.fromEntries(Object.entries(counts).filter(([k]) => k.startsWith(`${s.slug}:`)));
    writeFileSync(lifetimePath(s), JSON.stringify(mine));
  } catch (e) {
    log.err(`${s.slug}: could not persist lifetime dispatch counts: ${e}`);
  }
}

export function loadAttempts(s: RepoState): Record<string, number> {
  try {
    const raw = JSON.parse(readFileSync(attemptsPath(s), 'utf8')) as Record<string, number>;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw)) if (Number.isFinite(v) && v > 0) out[k] = Number(v);
    return out;
  } catch {
    return {};
  }
}

export function saveAttempts(s: RepoState, counts: Record<string, number>): void {
  try {
    mkdirSync(s.stateDir, { recursive: true });
    // Only this repo's items — the runner holds one watchdog across all boards.
    const mine = Object.fromEntries(Object.entries(counts).filter(([k]) => k.startsWith(`${s.slug}:`)));
    writeFileSync(attemptsPath(s), JSON.stringify(mine));
  } catch (e) {
    log.err(`${s.slug}: could not persist attempt counts: ${e}`);
  }
}
