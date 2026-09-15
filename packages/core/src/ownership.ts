import type { Task } from './taskmap.js';

// File ownership (#176), the pure half.
//
// An issue declares the files it owns in an `Owns:` footer (parsed in
// github.ts). Ownership is a SCHEDULING signal, not a dependency edge: nothing is
// written back to the board. Its two uses:
//   - #176: tell an implementer which files belong to another in-flight task, so
//     it blocks rather than inventing a competing version.
//   - #177: hold a dispatch whose declared ownership collides with work already
//     in flight.
//
// Pure over a Task[] (or the raw glob lists), so both callers test the same rule.

export interface OwnedFile {
  /** The declared glob, verbatim. */
  file: string;
  /** The task id that owns it, e.g. "#56". */
  owner: string;
}

// Every (file, owner) pair the given tasks declare. A task with no `owns` footer
// contributes nothing. Order follows the task list, then each task's own list.
export function ownershipList(tasks: Task[]): OwnedFile[] {
  const out: OwnedFile[] = [];
  for (const t of tasks) {
    for (const file of t.owns ?? []) out.push({ file, owner: t.id });
  }
  return out;
}

// The files owned by tasks OTHER than `selfId` — what an implementer of `selfId`
// must not create or edit. De-duplicated by file, first owner wins (a file two
// tasks both claim is a board mistake, but the implementer only needs to be told
// once, and which owner it names does not change "leave it alone").
export function ownedByOthers(tasks: Task[], selfId: string): OwnedFile[] {
  const seen = new Set<string>();
  const out: OwnedFile[] = [];
  for (const t of tasks) {
    if (t.id === selfId) continue;
    for (const file of t.owns ?? []) {
      if (seen.has(file)) continue;
      seen.add(file);
      out.push({ file, owner: t.id });
    }
  }
  return out;
}

// Normalise a declared glob to a comparable key: trim, strip a leading `./`, and
// drop a trailing `/**` or `/` so `tests/**`, `tests/`, and `tests` all match the
// same directory. Lets #177 compare an issue's `Owns:` glob against the concrete
// paths in an open PR's file set without a full glob engine.
export function ownKey(glob: string): string {
  return glob.trim().replace(/^\.\//, '').replace(/\/(?:\*\*?|\*)?$/, '').replace(/\/$/, '');
}

// Paths in `a` that collide with any in `b` — an exact/normalized match, or one
// glob covering the other's path. The overlap that must HOLD a dispatch (#177):
// two tasks both touching `package.json` collide, as does an issue owning
// `tests/**` against a PR that changed `tests/unit/x.test.ts`.
export function collidingPaths(a: string[], b: string[]): string[] {
  const hits = new Set<string>();
  for (const x of a) {
    for (const y of b) {
      if (ownKey(x) === ownKey(y) || pathMatchesOwn(x, y) || pathMatchesOwn(y, x)) {
        hits.add(x);
        break;
      }
    }
  }
  return [...hits];
}

// Known-contended paths: generated lockfiles, the manifest, and CI/build config
// that almost every task touches. An overlap on one of these is a STRONGER hold
// signal than an ordinary source file (#177) — used only to explain a hold, not
// to change the decision (any overlap already holds).
export const CONTENDED_PATHS: readonly string[] = [
  'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock',
  'tsconfig.json', 'vitest.config.ts', 'vitest.config.mts', 'jest.config.js',
  '.nvmrc', '.github/**',
];

export function isContended(path: string): boolean {
  return CONTENDED_PATHS.some((c) => ownKey(c) === ownKey(path) || pathMatchesOwn(path, c));
}

// Greedy dispatch plan over file-claim sets in PRIORITY ORDER (#177): a claim
// whose files are free is dispatched and then BLOCKS later colliding claims, so
// of two tasks that both own `package.json` the first goes and the rest are held.
// `inFlight` seeds the already-claimed set with work still running from earlier
// ticks. Pure, so the exact rule the engine ships is the rule under test.
export function holdColliding(
  claims: { key: string; files: string[] }[],
  inFlight: string[] = [],
): { dispatch: string[]; held: { key: string; on: string[] }[] } {
  const claimed = [...inFlight];
  const dispatch: string[] = [];
  const held: { key: string; on: string[] }[] = [];
  for (const c of claims) {
    const on = collidingPaths(c.files, claimed);
    if (on.length) {
      held.push({ key: c.key, on });
    } else {
      dispatch.push(c.key);
      claimed.push(...c.files);
    }
  }
  return { dispatch, held };
}

// Does a concrete file path fall under a declared ownership glob? Handles the
// common shapes — an exact file, a `dir/**` subtree, a `*.ext` suffix — without
// pulling in a glob dependency. Conservative: an unrecognised pattern only
// matches an exact string equality.
export function pathMatchesOwn(path: string, glob: string): boolean {
  const p = path.trim().replace(/^\.\//, '');
  const g = glob.trim().replace(/^\.\//, '');
  if (g === p) return true;
  // `dir/**` or `dir/` or `dir` -> anything under that directory.
  const dir = ownKey(g);
  if (g.endsWith('/**') || g.endsWith('/*') || g.endsWith('/')) {
    return p === dir || p.startsWith(`${dir}/`);
  }
  // `*.ext` (or `**/*.ext`) -> match by extension/suffix.
  const star = g.match(/^\*\*?\/?\*?(\.[^*/]+)$/);
  if (star) return p.endsWith(star[1]);
  // A bare directory name with no glob still guards its subtree.
  if (!g.includes('*') && !g.includes('.')) return p === g || p.startsWith(`${g}/`);
  return false;
}
