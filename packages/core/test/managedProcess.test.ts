import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ManagedProcess } from '../src/managedProcess.js';

// Waits for the child to exit by polling isRunning(). The close handler is what
// clears the handle, so this also proves the handler ran.
async function waitForExit(mp: ManagedProcess, ms = 10000): Promise<void> {
  const deadline = Date.now() + ms;
  while (mp.isRunning()) {
    if (Date.now() > deadline) throw new Error(`${mp.name} did not exit within ${ms}ms`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

test('push splits on either newline convention and drops blank lines', () => {
  const mp = new ManagedProcess({ name: 'T' });
  mp.push('one\r\ntwo\n\n   \nthree');
  assert.deepEqual(mp.logLines(), ['one', 'two', 'three']);
});

test('the log ring caps at logCap, dropping the OLDEST lines', () => {
  const mp = new ManagedProcess({ name: 'T', logCap: 3 });
  mp.push('a\nb\nc\nd\ne');
  assert.deepEqual(mp.logLines(), ['c', 'd', 'e']);
});

test('logLines(n) returns the newest n; logLines() returns a copy, not the ring', () => {
  const mp = new ManagedProcess({ name: 'T' });
  mp.push('a\nb\nc');
  assert.deepEqual(mp.logLines(2), ['b', 'c']);

  const snapshot = mp.logLines();
  snapshot.push('mutated');
  assert.deepEqual(mp.logLines(), ['a', 'b', 'c']); // caller can't corrupt the ring
});

test('clearLog empties the ring', () => {
  const mp = new ManagedProcess({ name: 'T' });
  mp.push('a\nb');
  mp.clearLog();
  assert.deepEqual(mp.logLines(), []);
});

test('stop / kill are safe no-ops when nothing is running', () => {
  const mp = new ManagedProcess({ name: 'T' });
  assert.equal(mp.isRunning(), false);
  assert.equal(mp.stop(), false); // false -> caller reports "not running"
  assert.doesNotThrow(() => mp.kill());
});

test('start captures stdout + stderr and appends an exit marker', async () => {
  const mp = new ManagedProcess({ name: 'Child' });
  const started = mp.start(
    process.execPath,
    ['-e', "process.stdout.write('out-line\\n'); process.stderr.write('err-line\\n');"],
    { windowsHide: true },
  );
  assert.equal(started, true);
  assert.equal(mp.isRunning(), true);

  await waitForExit(mp);
  const lines = mp.logLines();
  assert.ok(lines.includes('out-line'), `stdout missing: ${JSON.stringify(lines)}`);
  assert.ok(lines.includes('err-line'), `stderr missing: ${JSON.stringify(lines)}`);
  assert.equal(lines.at(-1), '=== Child exited (code 0) ===');
  assert.equal(mp.isRunning(), false); // handle cleared by the close handler
});

test('start refuses a second child while one is running', async () => {
  const mp = new ManagedProcess({ name: 'Child' });
  mp.start(process.execPath, ['-e', 'setTimeout(()=>{},300)'], { windowsHide: true });
  assert.equal(mp.start(process.execPath, ['-e', ''], { windowsHide: true }), false);
  mp.kill();
  assert.equal(mp.isRunning(), false);
});

test('kill reaps a live child and clears the handle immediately', async () => {
  const mp = new ManagedProcess({ name: 'Child' });
  mp.start(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true });
  assert.equal(mp.isRunning(), true);
  mp.kill();
  // Cleared synchronously — `close` is not delivered during process exit, which
  // is the context kill() runs in.
  assert.equal(mp.isRunning(), false);
});

// ---- Spawn failure ---------------------------------------------------------
// The regression that matters: a ChildProcess with no 'error' listener re-throws
// a failed spawn as an uncaught exception, taking the dashboard down with it.

test('a spawn failure is recorded and releases the handle, instead of throwing', async () => {
  const mp = new ManagedProcess({ name: 'Child' });
  assert.equal(mp.start(join(tmpdir(), 'no-such-binary-9f3a1c'), [], { windowsHide: true }), true);

  await waitForExit(mp); // the 'error' handler is what clears the handle here
  const lines = mp.logLines();
  assert.ok(
    lines.some((l) => l.startsWith('=== Child failed to start:')),
    `no failure line: ${JSON.stringify(lines)}`,
  );
  assert.equal(mp.isRunning(), false); // a later Start can simply be pressed again
});

// ---- Persistence -----------------------------------------------------------

test('lines are teed to logFile with a timestamp, and clearLog leaves the file alone', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sr-mp-'));
  const logFile = join(dir, 'nested', 'engine.log'); // nested: the dir is created on demand
  const mp = new ManagedProcess({ name: 'Child', logFile });

  mp.start(process.execPath, ['-e', "process.stdout.write('persisted-line\\n')"], { windowsHide: true });
  await waitForExit(mp);

  const written = readFileSync(logFile, 'utf8');
  assert.match(written, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z persisted-line$/m);
  assert.match(written, /=== Child exited \(code 0\) ===/);

  // The file outlives the ring — clearing the view must not destroy the record
  // of the run that just failed, which is the whole point of persisting it.
  mp.clearLog();
  assert.deepEqual(mp.logLines(), []);
  assert.equal(readFileSync(logFile, 'utf8'), written);
});

test('the log file rotates to .1 at logFileCap instead of growing forever', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sr-mp-'));
  const logFile = join(dir, 'engine.log');
  const mp = new ManagedProcess({ name: 'T', logFile, logFileCap: 200 });

  mp.push('a'.repeat(300));   // one write is already over cap
  mp.push('after-rotate');    // ...so this one rotates first, then lands in a fresh file

  assert.equal(existsSync(`${logFile}.1`), true);
  assert.match(readFileSync(logFile, 'utf8'), /after-rotate/);
  assert.match(readFileSync(`${logFile}.1`, 'utf8'), /a{300}/);
});

test('a failing log file costs the persisted copy, never the ring', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sr-mp-'));
  // A FILE where the log's parent directory should be, so mkdir/append both fail.
  const blocker = join(dir, 'blocked');
  writeFileSync(blocker, 'not a directory', 'utf8');
  const mp = new ManagedProcess({ name: 'T', logFile: join(blocker, 'engine.log') });

  assert.doesNotThrow(() => mp.push('still-ringed'));
  assert.deepEqual(mp.logLines(), ['still-ringed']);
});

test('a stopped child does not null out a replacement started in its place', async () => {
  const mp = new ManagedProcess({ name: 'Child' });
  mp.start(process.execPath, ['-e', "process.stdout.write('first\\n')"], { windowsHide: true });
  await waitForExit(mp);

  mp.start(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true });
  assert.equal(mp.isRunning(), true);
  mp.kill();
});
