import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  startTestRun, clearTestRun, readTestRun, noteCompletion, describeTestRun,
} from '../src/testRun.js';

// A bounded run: "finish N items, then park everything until I say go."
//
// The point is testing a change without committing the night to it. So the
// properties that matter are: it stops at exactly N, it stops ONCE, and it
// leaves nothing behind that would make the next start wind down immediately —
// that last one being the failure clearDrain() already exists to prevent.

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'testrun-')), 'testrun.json');
}

test('no budget means unbounded — completions are not counted', () => {
  const f = tmpFile();
  assert.equal(readTestRun(f), null);
  const r = noteCompletion('pr', f);
  assert.equal(r.spent, false);
  assert.equal(r.state, null, 'an unbounded pool must never be told to wind down');
});

test('counts up to the limit and reports spent exactly once', () => {
  const f = tmpFile();
  startTestRun(3, 'pr', f);
  assert.equal(noteCompletion('pr', f).spent, false);   // 1/3
  assert.equal(noteCompletion('pr', f).spent, false);   // 2/3
  assert.equal(noteCompletion('pr', f).spent, true);    // 3/3 -> wind down
});

test('only the configured unit counts', () => {
  const f = tmpFile();
  startTestRun(1, 'merge', f);
  assert.equal(noteCompletion('pr', f).spent, false, 'a PR must not spend a merge budget');
  assert.equal(readTestRun(f)!.done, 0);
  assert.equal(noteCompletion('merge', f).spent, true);
});

test('progress survives a crash — the count is on disk, not in memory', () => {
  const f = tmpFile();
  startTestRun(3, 'pr', f);
  noteCompletion('pr', f);
  noteCompletion('pr', f);
  // A fresh process reads the same file and does not restart the budget.
  assert.equal(readTestRun(f)!.done, 2);
  assert.equal(noteCompletion('pr', f).spent, true);
});

test('clearing removes the budget, so the next start runs unbounded', () => {
  const f = tmpFile();
  startTestRun(2, 'pr', f);
  clearTestRun(f);
  assert.equal(readTestRun(f), null);
  assert.equal(existsSync(f), false);
  assert.equal(noteCompletion('pr', f).spent, false, 'a cleared budget must not wind anything down');
});

test('re-arming resets progress rather than resuming a spent budget', () => {
  const f = tmpFile();
  startTestRun(2, 'pr', f);
  noteCompletion('pr', f);
  const again = startTestRun(2, 'pr', f);
  assert.equal(again.done, 0, 'a new test run starts from zero');
});

test('a limit below 1 is clamped, never zero', () => {
  const f = tmpFile();
  // A budget of 0 would be spent before anything ran and park the board on start.
  assert.equal(startTestRun(0, 'pr', f).limit, 1);
  assert.equal(startTestRun(-5, 'pr', f).limit, 1);
  assert.equal(startTestRun(2.7, 'pr', f).limit, 2);
});

test('an unreadable budget is treated as no budget, never as a stall', () => {
  const f = tmpFile();
  writeFileSync(f, '{ not json', 'utf8');
  assert.equal(readTestRun(f), null, 'a corrupt file must not strand the board');
  writeFileSync(f, JSON.stringify({ limit: 0 }), 'utf8');
  assert.equal(readTestRun(f), null);
});

test('the label reads as progress for the log and the dashboard', () => {
  const f = tmpFile();
  const s = startTestRun(3, 'pr', f);
  assert.equal(describeTestRun(s), 'test run 0/3 PRs');
  noteCompletion('pr', f);
  assert.equal(describeTestRun(readTestRun(f)), 'test run 1/3 PRs');
  assert.equal(describeTestRun(startTestRun(2, 'merge', f)), 'test run 0/2 merges');
  assert.equal(describeTestRun(null), '', 'unbounded shows nothing');
});

test('cleanup', () => { rmSync(tmpdir() + '/testrun-', { recursive: true, force: true }); assert.ok(true); });
