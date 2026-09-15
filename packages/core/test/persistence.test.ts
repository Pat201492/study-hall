import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Persistence, repoStateDir, legacyStateDirs } from '../src/engine/persistence.js';
import { emptyStatus, STATUS_SCHEMA } from '../src/engine/status.js';
import { firstOffence } from '../src/parole.js';

function scratch(): { stateDir: string; legacyRoot: string } {
  const root = mkdtempSync(join(tmpdir(), 'sh-persist-'));
  return { stateDir: join(root, 'state'), legacyRoot: join(root, 'legacy') };
}

test('saving a secondary repo writes that repo file and never the primary one', () => {
  const { stateDir, legacyRoot } = scratch();
  const p = new Persistence({ stateDir, legacyRoot });
  p.saveHandled('Pat201492/primary', new Set([1, 2]));
  p.saveHandled('Pat201492/secondary', new Set([5]));

  assert.deepEqual(JSON.parse(readFileSync(join(repoStateDir(stateDir, 'Pat201492/secondary'), 'handled.json'), 'utf8')), [5]);
  assert.deepEqual(JSON.parse(readFileSync(join(repoStateDir(stateDir, 'Pat201492/primary'), 'handled.json'), 'utf8')), [1, 2]);
  assert.deepEqual([...p.load('Pat201492/secondary').memory.handled], [5]);
  assert.deepEqual([...p.load('Pat201492/primary').memory.handled], [1, 2]);

  // A URL and a slug name the same canonical dir.
  assert.equal(repoStateDir(stateDir, 'https://github.com/Pat201492/primary'), repoStateDir(stateDir, 'Pat201492/primary'));
  assert.equal(repoStateDir(stateDir, 'o/r'), join(stateDir, 'repos', 'o-r'));
});

test('attempts and lifetime stay separate files, each filtered to the repo it belongs to', () => {
  const { stateDir, legacyRoot } = scratch();
  const p = new Persistence({ stateDir, legacyRoot });
  const attempts = { 'o/a:issue-1': 3, 'o/b:issue-1': 1 };
  const lifetime = { 'o/a:issue-1': 12, 'o/b:issue-1': 2 };
  p.saveAttempts('o/a', attempts);
  p.saveLifetime('o/a', lifetime);
  const dir = repoStateDir(stateDir, 'o/a');
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'attempts.json'), 'utf8')), { 'o/a:issue-1': 3 });
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'lifetime.json'), 'utf8')), { 'o/a:issue-1': 12 });
  const m = p.load('o/a').memory;
  assert.deepEqual(m.attempts, { 'o/a:issue-1': 3 });
  assert.deepEqual(m.lifetime, { 'o/a:issue-1': 12 });
  assert.ok(!existsSync(join(repoStateDir(stateDir, 'o/b'), 'attempts.json')));
});

test('quarantine persists parole records and reloads them', () => {
  const { stateDir, legacyRoot } = scratch();
  const p = new Persistence({ stateDir, legacyRoot });
  const at = 1_700_000_000_000;
  p.saveQuarantine('o/r', new Set(['o/r:pr-4']), new Map([['o/r:pr-4', { at, paroles: 2 }]]));
  const m = p.load('o/r', at + 1).memory;
  assert.deepEqual([...m.quarantined], ['o/r:pr-4']);
  assert.deepEqual(m.paroleOf.get('o/r:pr-4'), { at, paroles: 2 });
});

test('a fresh state dir next to a v1 install imports the four legacy files once and logs it', () => {
  const { stateDir, legacyRoot } = scratch();
  const legacy = join(legacyRoot, 'https---github.com-Pat201492-dungeonworks');
  mkdirSync(legacy, { recursive: true });
  writeFileSync(join(legacy, 'handled.json'), JSON.stringify([110, 111]));
  writeFileSync(join(legacy, 'attempts.json'), JSON.stringify({ 'Pat201492/dungeonworks:issue-110': 9 }));
  writeFileSync(join(legacy, 'lifetime.json'), JSON.stringify({ 'Pat201492/dungeonworks:issue-110': 15 }));
  writeFileSync(join(legacy, 'quarantine.json'), JSON.stringify([{ key: 'Pat201492/dungeonworks:issue-110', at: 5, paroles: 1 }]));

  const logs: string[] = [];
  const p = new Persistence({ stateDir, legacyRoot, log: (m) => logs.push(m) });
  const first = p.load('Pat201492/dungeonworks', 10);
  assert.equal(first.importedFrom, legacy);
  assert.deepEqual(first.imported, ['handled.json', 'quarantine.json', 'attempts.json', 'lifetime.json']);
  assert.deepEqual([...first.memory.handled], [110, 111]);
  assert.deepEqual(first.memory.attempts, { 'Pat201492/dungeonworks:issue-110': 9 });
  assert.deepEqual(first.memory.lifetime, { 'Pat201492/dungeonworks:issue-110': 15 });
  assert.deepEqual(first.memory.paroleOf.get('Pat201492/dungeonworks:issue-110'), { at: 5, paroles: 1 });
  assert.equal(logs.length, 1);
  assert.match(logs[0], /imported v1 state/);

  // Canonical copies now exist; a second load reads them and imports nothing.
  assert.ok(existsSync(join(repoStateDir(stateDir, 'Pat201492/dungeonworks'), 'lifetime.json')));
  const second = p.load('Pat201492/dungeonworks', 10);
  assert.equal(second.importedFrom, undefined);
  assert.deepEqual(second.imported, []);

  // The slug-form legacy dir is tried second.
  assert.deepEqual(legacyStateDirs(legacyRoot, 'o/r'), [join(legacyRoot, 'https---github.com-o-r'), join(legacyRoot, 'o-r')]);
});

test('a repo with no state anywhere loads empty and imports nothing', () => {
  const { stateDir, legacyRoot } = scratch();
  const p = new Persistence({ stateDir, legacyRoot });
  const r = p.load('o/new');
  assert.equal(r.importedFrom, undefined);
  assert.equal(r.memory.handled.size, 0);
  assert.deepEqual(r.memory.attempts, {});
});

test('status.json lives at the state root, carries every repo, and round-trips', () => {
  const { stateDir, legacyRoot } = scratch();
  const p = new Persistence({ stateDir, legacyRoot });
  const status = emptyStatus(4242);
  for (const repo of ['o/a', 'o/b']) {
    status.repos[repo] = { repo, contested: false, ready: [], blocked: [], inFlight: [], parked: [], deadlocked: [], attempts: {} };
  }
  status.running = true;
  p.writeStatus(status);
  assert.equal(p.statusPath(), join(stateDir, 'status.json'));
  const back = p.readStatus();
  assert.ok(back);
  assert.equal(back.schema, STATUS_SCHEMA);
  assert.deepEqual(Object.keys(back.repos), ['o/a', 'o/b']);
  assert.equal(back.pid, 4242);
  assert.equal(back.running, true);
  assert.ok(!existsSync(join(stateDir, `status.json.${process.pid}.tmp`)), 'tmp file renamed away');

  // A foreign or torn file reads as null, never as a status.
  writeFileSync(p.statusPath(), '{"schema":"other"}');
  assert.equal(p.readStatus(), null);
});
