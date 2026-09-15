import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { ChildRegistry } from '../src/proc.js';

// The tree-kill path on the real platform. Every durability bug in v1's
// handoffs was a win32 process-lifecycle bug and none was reachable by its test
// suite (CI ran on ubuntu only). This spawns a fake child TREE — a node parent
// that spawns a grandchild — registers the parent, kills, and asserts neither
// pid survives. A negative control proves a plain (non-tree) kill leaves the
// grandchild alive, so the assertion is known to be meaningful.

const win32 = process.platform === 'win32';

const PARENT_SCRIPT = `
  const { spawn } = require('node:child_process');
  // detached: libuv puts non-detached children in a job object that dies WITH the
  // parent, which would make the negative control vacuous. Real CLI children
  // (claude.exe's bun/node workers, codex.exe) are not in our job — this models them.
  const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true, detached: true });
  g.unref();
  process.stdout.write(String(g.pid) + '\\n');
  setInterval(() => {}, 1000);
`;

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function spawnTree(): Promise<{ parent: ChildProcess; grandchild: number }> {
  return new Promise((resolve, reject) => {
    const parent = spawn(process.execPath, ['-e', PARENT_SCRIPT], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    let out = '';
    parent.stdout!.on('data', (b) => {
      out += b.toString();
      const m = out.match(/^(\d+)\s*$/m);
      if (m) resolve({ parent, grandchild: Number(m[1]) });
    });
    parent.once('error', reject);
    parent.once('exit', () => { if (!out.trim()) reject(new Error('parent exited before printing the grandchild pid')); });
  });
}

/** Never leave a tree behind, whatever an assertion did. */
function reap(...pids: (number | undefined)[]): void {
  for (const pid of pids) {
    if (pid == null) continue;
    if (win32) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    else { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  }
}

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('ChildRegistry.killAll takes the whole tree — no orphaned grandchild', { skip: !win32 && 'win32 only: the /T tree kill is the path under test' }, async () => {
  const { parent, grandchild } = await spawnTree();
  const parentPid = parent.pid!;
  try {
    assert.equal(alive(parentPid), true);
    assert.equal(alive(grandchild), true);
    const registry = new ChildRegistry();
    registry.add(parent);
    registry.killAll();
    await settle(500);
    assert.equal(alive(parentPid), false, 'parent still alive after killAll');
    assert.equal(alive(grandchild), false, 'grandchild orphaned after killAll');
    assert.equal(registry.size, 0);
  } finally {
    reap(parentPid, grandchild);
  }
});

test('negative control: killing only the tracked child (no /T) leaves the grandchild alive', { skip: !win32 && 'win32 only' }, async () => {
  const { parent, grandchild } = await spawnTree();
  const parentPid = parent.pid!;
  try {
    parent.kill();
    await settle(500);
    assert.equal(alive(parentPid), false, 'parent should be gone');
    assert.equal(alive(grandchild), true, 'the grandchild survives a non-tree kill — which is why treeKill uses /T');
  } finally {
    reap(parentPid, grandchild);
    await settle(200);
    assert.equal(alive(grandchild), false, 'cleanup reaped the grandchild');
  }
});
