import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitLock, isLockContention, LOCK_BACKOFF_MS } from '../src/engine/gitLock.js';

const noSleep = async (): Promise<void> => {};

/** A clone that behaves like git: one writer at a time, and the loser is refused. */
function fakeClone() {
  let held = false;
  const order: string[] = [];
  return {
    order,
    /** Mirrors `git worktree add`: takes the config lock for the length of the write. */
    async write(tag: string): Promise<string> {
      if (held) throw new Error('error: could not lock config file .git/config: File exists');
      held = true;
      order.push(`start ${tag}`);
      await new Promise((r) => setTimeout(r, 5));
      order.push(`end ${tag}`);
      held = false;
      return tag;
    },
  };
}

test('two students preparing worktrees against one clone are ordered, not failed', async () => {
  // The first real board run lost issue #256 to exactly this: concurrent
  // `git worktree add` on one clone, and the loser failed outright (#27).
  const clone = fakeClone();
  const unlocked = await Promise.allSettled([clone.write('a'), clone.write('b')]);
  assert.equal(unlocked.filter((r) => r.status === 'rejected').length, 1, 'without a lock, one of the two loses');

  const clone2 = fakeClone();
  const lock = new GitLock({ sleep: noSleep });
  const results = await Promise.all([
    lock.run('/clones/dw', () => clone2.write('a')),
    lock.run('/clones/dw', () => clone2.write('b')),
  ]);
  assert.deepEqual(results, ['a', 'b']);
  assert.deepEqual(clone2.order, ['start a', 'end a', 'start b', 'end b'], 'the second waits for the first to finish');
});

test('different clones never wait on each other', async () => {
  const lock = new GitLock({ sleep: noSleep });
  const order: string[] = [];
  const slow = async (tag: string, ms: number): Promise<string> => {
    await new Promise((r) => setTimeout(r, ms));
    order.push(tag);
    return tag;
  };
  await Promise.all([lock.run('/clones/a', () => slow('slow', 20)), lock.run('/clones/b', () => slow('fast', 1))]);
  assert.deepEqual(order, ['fast', 'slow'], 'a second repository is not held behind the first');
});

test('a lock held by another PROCESS is waited out, not queued and not deleted', async () => {
  // The planner keeps its own checkout and a human can run git: some writers
  // cannot be ordered, only outlasted.
  let attempts = 0;
  const waits: number[] = [];
  const lock = new GitLock({ sleep: async (ms) => { waits.push(ms); } });
  const out = await lock.run('/clones/dw', async () => {
    attempts++;
    if (attempts < 3) throw new Error('error: could not lock config file .git/config: File exists');
    return 'added';
  });
  assert.equal(out, 'added');
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [LOCK_BACKOFF_MS[0], LOCK_BACKOFF_MS[1]], 'backoff grows between attempts');
});

test('a lock that never clears still fails, so the item is released rather than held forever', async () => {
  const lock = new GitLock({ sleep: noSleep });
  let attempts = 0;
  await assert.rejects(
    lock.run('/clones/dw', async () => { attempts++; throw new Error('could not lock config file .git/config: File exists'); }),
    /could not lock config file/,
  );
  assert.equal(attempts, LOCK_BACKOFF_MS.length + 1, 'one try per backoff step, plus the first');
});

test('a real failure is not retried: only contention is transient', async () => {
  const lock = new GitLock({ sleep: noSleep });
  let attempts = 0;
  await assert.rejects(
    lock.run('/clones/dw', async () => { attempts++; throw new Error("fatal: invalid reference: origin/nope"); }),
    /invalid reference/,
  );
  assert.equal(attempts, 1, 'a bad branch name is wrong however long you wait');
});

test('one failed operation does not wedge the queue behind it', async () => {
  const lock = new GitLock({ sleep: noSleep });
  const failed = lock.run('/clones/dw', async () => { throw new Error('fatal: something specific'); });
  await assert.rejects(failed, /something specific/);
  assert.equal(await lock.run('/clones/dw', async () => 'next'), 'next');
  // And a rejection queued behind a rejection still runs.
  const a = lock.run('/clones/dw', async () => { throw new Error('fatal: first'); });
  const b = lock.run('/clones/dw', async () => 'second');
  await assert.rejects(a, /first/);
  assert.equal(await b, 'second');
});

test('contention is recognised by message, including git index and ref locks', () => {
  assert.ok(isLockContention(new Error('error: could not lock config file .git/config: File exists')));
  assert.ok(isLockContention(new Error('fatal: Unable to create /r/.git/index.lock: File exists')));
  assert.ok(!isLockContention(new Error('fatal: invalid reference: origin/nope')));
  assert.ok(!isLockContention(new Error('error: pathspec did not match any file')));
  assert.ok(!isLockContention(undefined));
});

test('forClone hands the runner the one-argument shape it expects', async () => {
  const lock = new GitLock({ sleep: noSleep });
  const fn = lock.forClone('/clones/dw');
  assert.equal(await fn(async () => 42), 42);
  assert.deepEqual(lock.keys, ['/clones/dw']);
});
