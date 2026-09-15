import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureClone, resolveIdentity, addWorktree, commitAndPush, removeWorktree } from '../src/worktree.js';

// Real git against a temp bare origin: the identity is applied to the clone and
// lands on a student commit; no literal name or email lives in the module.

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function origin(): { url: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'sh-wt-'));
  const bare = join(root, 'origin.git');
  execFileSync('git', ['init', '--bare', '-b', 'main', bare]);
  const seed = join(root, 'seed');
  execFileSync('git', ['clone', bare, seed]);
  writeFileSync(join(seed, 'README.md'), 'seed\n');
  git(seed, 'config', 'user.name', 'Seed');
  git(seed, 'config', 'user.email', 'seed@example.com');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-m', 'seed');
  git(seed, 'push', '-u', 'origin', 'main');
  return { url: bare, root };
}

test('ensureClone applies the configured identity to the clone and student commits carry it', async () => {
  const { url, root } = origin();
  const clone = await ensureClone(url, join(root, 'repo'), 'main', { name: 'Study Hall Bot', email: 'bot@example.test' });
  assert.equal(clone.base, 'main');
  assert.equal(git(clone.dir, 'config', 'user.name'), 'Study Hall Bot');
  assert.equal(git(clone.dir, 'config', 'user.email'), 'bot@example.test');

  const wt = await addWorktree(clone, 'study/issue-1');
  writeFileSync(join(wt, 'a.txt'), 'hello\n');
  assert.equal(await commitAndPush(wt, 'study/issue-1', 'Issue 1\n\nCloses #1'), true);
  assert.equal(git(wt, 'log', '-1', '--format=%an <%ae>'), 'Study Hall Bot <bot@example.test>');
  await removeWorktree(clone, wt);
  assert.equal(git(clone.dir, 'ls-remote', '--heads', 'origin', 'study/issue-1').includes('study/issue-1'), true);
});

test('resolveIdentity falls back to the global git config and refuses to guess when there is none', async () => {
  const explicit = await resolveIdentity({ name: 'A', email: 'a@b' });
  assert.deepEqual(explicit, { name: 'A', email: 'a@b' });
  const globalName = execFileSync('git', ['config', '--global', '--get', 'user.name'], { encoding: 'utf8' }).trim();
  if (globalName) {
    const fromGlobal = await resolveIdentity();
    assert.equal(fromGlobal.name, globalName);
  }
  // A partial identity is completed from the global config rather than shipped half-empty.
  const partial = await resolveIdentity({ name: '', email: 'x@y' } as never).catch((e: Error) => e);
  if (globalName) assert.equal((partial as { email: string }).email, 'x@y');
  else assert.match((partial as Error).message, /no git identity/);
});

