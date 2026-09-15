import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newRepoState, loadHandled, saveHandled, loadQuarantine, saveQuarantine } from '../src/repoStateIo.js';
import {
  stateDirFor, qualifyTaskId, parseTaskId, qualifyActionKey, qualifyItemKey, parseQualifiedKey,
} from '../src/keys.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'reposstate-'));
const state = (dir: string, slug = 'me/a') => newRepoState(slug, slug, join(dir, slug.replace('/', '-')));

// ---- keys ------------------------------------------------------------------
// Two boards both have an issue #7. Every id that crosses a repo boundary has to
// carry its repo, or one board's quarantine silently suppresses the other's work.

test('task ids, action keys, and item keys all carry the repo', () => {
  assert.equal(qualifyTaskId('me/a', 7), 'me/a#7');
  assert.equal(qualifyActionKey('REVIEW', 'me/a', 'pr', 12), 'REVIEW:me/a:pr-12');
  assert.equal(qualifyItemKey('me/a', 'pr', 12), 'me/a:pr-12');
});

test('the same number in two repos yields distinct keys', () => {
  assert.notEqual(qualifyItemKey('me/a', 'issue', 7), qualifyItemKey('me/b', 'issue', 7));
  assert.notEqual(qualifyTaskId('me/a', 7), qualifyTaskId('me/b', 7));
});

test('parseQualifiedKey round-trips every qualified shape', () => {
  assert.deepEqual(parseQualifiedKey('REVIEW:me/a:pr-12'), { slug: 'me/a', kind: 'pr', number: 12 });
  assert.deepEqual(parseQualifiedKey('IMPLEMENT:me/a:issue-9'), { slug: 'me/a', kind: 'issue', number: 9 });
  assert.deepEqual(parseQualifiedKey('me/a:pr-12'), { slug: 'me/a', kind: 'pr', number: 12 });
});

// A quarantine.json written by an older single-repo run must still load, or the
// upgrade silently un-parks everything it had condemned.
test('legacy unqualified keys still parse, with a null slug', () => {
  assert.deepEqual(parseQualifiedKey('REVIEW:pr-12'), { slug: null, kind: 'pr', number: 12 });
  assert.deepEqual(parseQualifiedKey('pr-12'), { slug: null, kind: 'pr', number: 12 });
  assert.deepEqual(parseQualifiedKey('issue-9'), { slug: null, kind: 'issue', number: 9 });
});

test('junk keys yield null rather than throwing a boot', () => {
  for (const bad of ['', 'REVIEW', 'me/a:branch-7', 'me/a:pr-', 'pr-x']) {
    assert.equal(parseQualifiedKey(bad), null, bad);
  }
});

test('parseTaskId splits a qualified id and rejects the bare form', () => {
  assert.deepEqual(parseTaskId('me/a#7'), { slug: 'me/a', number: 7 });
  assert.equal(parseTaskId('#7'), null, 'bare id has no slug — caller falls back');
  assert.equal(parseTaskId('nonsense'), null);
});

// ---- per-repo isolation ----------------------------------------------------

test('two repos get separate state dirs', () => {
  const root = '/root';
  assert.notEqual(stateDirFor(root, 'me/a'), stateDirFor(root, 'me/b'));
  assert.ok(!stateDirFor(root, 'me/a').includes('/'.repeat(2)));
});

test('handled and quarantine persist per repo without touching each other', () => {
  const dir = tmp();
  const a = state(dir, 'me/a');
  const b = state(dir, 'me/b');

  a.handled.add(1); a.handled.add(2);
  a.quarantined.add('REVIEW:me/a:pr-5');
  saveHandled(a); saveQuarantine(a);
  saveHandled(b); saveQuarantine(b); // b is empty

  const a2 = state(dir, 'me/a');
  const b2 = state(dir, 'me/b');
  loadHandled(a2); loadQuarantine(a2);
  loadHandled(b2); loadQuarantine(b2);

  assert.deepEqual([...a2.handled].sort(), [1, 2]);
  assert.deepEqual([...a2.quarantined], ['REVIEW:me/a:pr-5']);
  assert.equal(b2.handled.size, 0, "repo A's ledger must not leak into B");
  assert.equal(b2.quarantined.size, 0);
  rmSync(dir, { recursive: true, force: true });
});

test('a corrupt ledger degrades to empty rather than failing the boot', () => {
  const dir = tmp();
  const s = state(dir);
  saveHandled(s); // create the dir
  writeFileSync(join(s.stateDir, 'handled.json'), '{ not json');
  writeFileSync(join(s.stateDir, 'quarantine.json'), 'also not json');

  const fresh = state(dir);
  assert.doesNotThrow(() => { loadHandled(fresh); loadQuarantine(fresh); });
  assert.equal(fresh.handled.size, 0);
  assert.equal(fresh.quarantined.size, 0);
  rmSync(dir, { recursive: true, force: true });
});

test('a missing quarantine file is not an error', () => {
  const dir = tmp();
  const s = state(dir);
  assert.deepEqual(loadQuarantine(s), []);
  rmSync(dir, { recursive: true, force: true });
});

test('non-numeric entries in handled.json are dropped', () => {
  const dir = tmp();
  const s = state(dir);
  saveHandled(s);
  writeFileSync(join(s.stateDir, 'handled.json'), JSON.stringify([1, 'x', null, 3]));
  const fresh = state(dir);
  loadHandled(fresh);
  assert.deepEqual([...fresh.handled].sort(), [1, 3]);
  rmSync(dir, { recursive: true, force: true });
});

// The disambiguator: a repo slug always contains a slash. Without requiring it,
// "REVIEW:pr-12" parses as slug="REVIEW" — a legacy key silently read as a repo
// named after its own action, which would key a quarantine to a repo that does
// not exist.
test('an action-looking prefix is never mistaken for a repo', () => {
  assert.equal(parseQualifiedKey('REVIEW:pr-12')?.slug, null);
  assert.equal(parseQualifiedKey('IMPLEMENT:issue-9')?.slug, null);
  assert.equal(parseQualifiedKey('REVIEW:me/a:pr-12')?.slug, 'me/a');
});
