import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fkey, parseQualifiedKey, qualifyActionKey } from '../src/keys.js';

// The bug this pins, observed live: Trader-Screener had PR'd its own #47, #48
// and #49 back in July, so its `handled` ledger contained those numbers. The
// dispatch loop read the PRIMARY repo's ledger for EVERY repo's actions, and
// keyed its in-flight trackers by bare number. PoolWorks' only three issues are
// #47, #48 and #49 — so every one of them looked already-handled and the board
// never dispatched a single issue. Silently: no error, no quarantine, just a
// board that reported "2 ready to start" forever.

test('the same number on two repos yields different in-flight keys', () => {
  assert.notEqual(fkey('owner/a', 47), fkey('owner/b', 47));
  assert.equal(fkey('owner/a', 47), 'owner/a#47');
});

test('a bare number can no longer make one board mask another', () => {
  // Model the old tracker: keyed by number. Both boards collapse to one entry.
  const bare = new Set<number>();
  bare.add(47);
  assert.equal(bare.has(47), true, 'repo B looks busy because repo A is');

  // Keyed by repo, they are independent.
  const keyed = new Set<string>();
  keyed.add(fkey('owner/a', 47));
  assert.equal(keyed.has(fkey('owner/a', 47)), true);
  assert.equal(keyed.has(fkey('owner/b', 47)), false, 'repo B must be unaffected');
});

test('keyInFlight can actually parse the keys the runner generates', () => {
  // The old pattern was /^(\w+):(?:issue|pr)-(\d+)$/, which cannot match a
  // repo-qualified key — so it returned false for everything and the watchdog
  // treated running work as stuck.
  const key = qualifyActionKey('FIX', 'Pat201492/Trader-Screener', 'pr', 124);
  assert.doesNotMatch(key, /^(\w+):(?:issue|pr)-(\d+)$/, 'real keys are qualified');
  const parsed = parseQualifiedKey(key);
  assert.ok(parsed, 'must parse');
  assert.equal(parsed!.slug, 'Pat201492/Trader-Screener');
  assert.equal(parsed!.number, 124);
  assert.equal(key.split(':', 1)[0], 'FIX');
});

test('an unqualified legacy key is not guessed onto a repo', () => {
  const parsed = parseQualifiedKey('REVIEW:pr-12');
  assert.ok(parsed);
  assert.equal(parsed!.slug, null, 'no slug — must not be attributed to a board');
});
