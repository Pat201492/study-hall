// Serialise git operations that write a repository's shared metadata.
//
// `git worktree add` writes the clone's `.git/config`, taking `.git/config.lock`
// to do it. Two students preparing worktrees against one clone at the same
// moment race for that lock, and the loser does not wait — it fails:
//
//   error: could not lock config file .git/config: File exists
//
// That cost a student on the first real board run (#27). The runner already
// routed every git call through a `gitLock` seam and documented it as guarding
// this exact race; nothing ever supplied one, so the guard was a comment.
//
// Two layers, because the engine is not the only writer. Inside the process a
// keyed queue orders the calls outright. Outside it — the planner keeps its own
// checkout, the arena clones, a human runs git — nothing can be ordered, so a
// lock failure is retried until the other writer finishes.
//
// What this never does is delete a lock file. A `.git/config.lock` that exists
// is either a live writer mid-write, whose work removing it would corrupt, or
// debris from a crash that a human should look at.

/** Milliseconds to wait before each retry. Short, because a config write is short. */
export const LOCK_BACKOFF_MS = [50, 150, 400, 1_000, 2_500] as const;

const LOCK_RE = /could not lock config file|Unable to create .*\.lock|File exists|index\.lock/i;

/** Is this the transient "someone else is writing" failure, rather than a real one? */
export function isLockContention(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e ?? '');
  return LOCK_RE.test(m);
}

export interface GitLockOptions {
  backoffMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  /** Called once per retry, for the log. */
  onRetry?: (attempt: number, waitMs: number, error: Error) => void;
}

/**
 * A per-key serial queue with retry on lock contention.
 *
 * The key is the clone directory: two different repositories never contend, so
 * ordering them together would throw away concurrency for nothing.
 */
export class GitLock {
  private readonly tails = new Map<string, Promise<unknown>>();
  private readonly backoff: readonly number[];
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onRetry: (attempt: number, waitMs: number, error: Error) => void;

  constructor(opts: GitLockOptions = {}) {
    this.backoff = opts.backoffMs ?? LOCK_BACKOFF_MS;
    this.sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
    this.onRetry = opts.onRetry ?? (() => {});
  }

  /** Queue `fn` behind anything already running for `key`. */
  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.tails.get(key) ?? Promise.resolve();
    // The queue must not break on a failed call: a rejected task still lets the
    // next one start, so one bad worktree cannot wedge the board.
    const next = prior.then(() => this.attempt(fn), () => this.attempt(fn));
    this.tails.set(key, next.then(() => undefined, () => undefined));
    return next;
  }

  /** A lock held by another PROCESS cannot be queued, only waited out. */
  private async attempt<T>(fn: () => Promise<T>): Promise<T> {
    for (let i = 0; ; i++) {
      try {
        return await fn();
      } catch (e) {
        if (i >= this.backoff.length || !isLockContention(e)) throw e;
        const wait = this.backoff[i];
        this.onRetry(i + 1, wait, e instanceof Error ? e : new Error(String(e)));
        await this.sleep(wait);
      }
    }
  }

  /** A `gitLock` for one clone, the shape RunnerDeps asks for. */
  forClone(clone: string): <T>(fn: () => Promise<T>) => Promise<T> {
    return (fn) => this.run(clone, fn);
  }

  /** Queues waiting or running, for a status line. */
  get keys(): string[] {
    return [...this.tails.keys()];
  }
}
