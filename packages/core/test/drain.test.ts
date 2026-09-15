import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drainFlagPath, requestDrain, clearDrain, drainRequested } from '../src/drain.js';

function scratch(): string {
  return drainFlagPath(mkdtempSync(join(tmpdir(), 'sr-drain-')));
}

test('a soft stop is off until it is asked for, and on once it is', () => {
  const flag = scratch();
  assert.equal(drainRequested(flag), false);
  requestDrain(flag);
  assert.equal(drainRequested(flag), true);
});

test('cancelling a soft stop turns it back off', () => {
  const flag = scratch();
  requestDrain(flag);
  clearDrain(flag);
  assert.equal(drainRequested(flag), false);
});

test('requesting twice is idempotent — the second request is not a second stop', () => {
  const flag = scratch();
  requestDrain(flag);
  requestDrain(flag);
  assert.equal(drainRequested(flag), true);
  clearDrain(flag);
  assert.equal(drainRequested(flag), false); // one clear is enough, not one per request
});

test('cancelling when nothing was requested is a no-op, not an error', () => {
  const flag = scratch();
  assert.doesNotThrow(() => clearDrain(flag));
  assert.equal(drainRequested(flag), false);
});

test('the flag records when it was requested, so a stale one is recognizable', () => {
  const flag = scratch();
  requestDrain(flag);
  const stamp = readFileSync(flag, 'utf8');
  assert.match(stamp, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  assert.ok(Date.now() - Date.parse(stamp) < 60_000);
});

test('the state dir is created on demand', () => {
  // The very first soft stop can land before anything else has written to the
  // state dir, so requestDrain cannot assume the directory is already there.
  const flag = drainFlagPath(join(mkdtempSync(join(tmpdir(), 'sr-drain-')), 'not', 'yet'));
  assert.doesNotThrow(() => requestDrain(flag));
  assert.equal(drainRequested(flag), true);
});

// The failure this guards is the nastiest one available here: an engine killed
// mid-drain leaves the flag behind, and the NEXT pool start would then wind down
// the instant it booted -- which presents as "the pool won't stay up", not as a
// stale request. startPool() and the engine's drain-complete exit both clear it;
// this pins the behaviour those depend on.
test('a flag left behind by a killed engine is cleared, not honored forever', () => {
  const flag = scratch();
  requestDrain(flag);            // engine was draining...
  assert.equal(drainRequested(flag), true);
  clearDrain(flag);              // ...and is killed; the next start clears it
  assert.equal(drainRequested(flag), false);
  assert.equal(existsSync(flag), false);
});

test('drainFlagPath defaults to the shared state dir and takes an override', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sr-drain-'));
  assert.equal(drainFlagPath(dir), join(dir, 'drain.flag'));
  // Default lands beside the other engine state (status.json, the schedule).
  assert.match(drainFlagPath().replace(/\\/g, '/'), /\.claude-study-room\/drain\.flag$/);
});

test('an unreadable flag path reports "not requested" rather than throwing', () => {
  // A FILE where the flag's parent directory should be. drainRequested runs on
  // every heartbeat; it must never be the thing that kills the engine.
  const dir = mkdtempSync(join(tmpdir(), 'sr-drain-'));
  const blocker = join(dir, 'blocked');
  writeFileSync(blocker, 'not a directory', 'utf8');
  const flag = join(blocker, 'drain.flag');
  assert.doesNotThrow(() => assert.equal(drainRequested(flag), false));
  assert.doesNotThrow(() => clearDrain(flag));
});

test('a soft stop survives the process that requested it', () => {
  // The point of a file over an in-memory flag: the dashboard can restart (or
  // the tab can close) and the wind-down is still in force.
  const dir = mkdtempSync(join(tmpdir(), 'sr-drain-'));
  mkdirSync(dir, { recursive: true });
  requestDrain(drainFlagPath(dir));
  // A "new process" is just another reader computing the same path.
  assert.equal(drainRequested(drainFlagPath(dir)), true);
});
