import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOwns } from '../src/github.js';
import { ownershipList, ownedByOthers, pathMatchesOwn, ownKey } from '../src/ownership.js';
import { ownershipBlock, taskPrompt } from '../src/prompts.js';
import type { Task } from '../src/taskmap.js';

// #176: issues declare the files they own; an implementer is told which files
// belong to another in-flight task and must block rather than invent.

function task(id: string, owns?: string[]): Task {
  return {
    id, title: `t${id}`, model: 'sonnet', role: 'implement', priority: 1,
    deps: [], pinned: false, assignedStudent: null, stage: 'ready', owns,
  };
}

test('parseOwns reads a comma-separated Owns: footer', () => {
  const body = 'Do the thing.\n\nOwns: vitest.config.ts, playwright.config.ts, tests/**\n\nDepends on #5';
  assert.deepEqual(parseOwns(body), ['vitest.config.ts', 'playwright.config.ts', 'tests/**']);
});

test('parseOwns handles multiple lines, bullets, and backticks, de-duped', () => {
  const body = '- Owns: `a.ts`\n* owns: b.ts, a.ts';
  assert.deepEqual(parseOwns(body), ['a.ts', 'b.ts']);
});

test('parseOwns returns nothing when there is no footer', () => {
  assert.deepEqual(parseOwns('just a normal issue body'), []);
});

test('ownershipList flattens every declared (file, owner) pair', () => {
  const list = ownershipList([task('#56', ['vitest.config.ts']), task('#57'), task('#58', ['schema.prisma'])]);
  assert.deepEqual(list, [
    { file: 'vitest.config.ts', owner: '#56' },
    { file: 'schema.prisma', owner: '#58' },
  ]);
});

test('ownedByOthers excludes the task itself and de-dupes by file', () => {
  const tasks = [task('#56', ['vitest.config.ts']), task('#57', ['vitest.config.ts', 'a.ts'])];
  // From #57's view, vitest.config.ts belongs to #56 (first owner), plus nothing of its own.
  assert.deepEqual(ownedByOthers(tasks, '#57'), [{ file: 'vitest.config.ts', owner: '#56' }]);
  // From #56's view, a.ts belongs to #57.
  assert.deepEqual(ownedByOthers(tasks, '#56'), [
    { file: 'vitest.config.ts', owner: '#57' }, // #57 also lists it; #56 sees #57 as an owner
    { file: 'a.ts', owner: '#57' },
  ]);
});

test('the implement prompt names the owned files and forbids creating them', () => {
  const owned = ownedByOthers([task('#56', ['vitest.config.ts']), task('#57')], '#57');
  const block = ownershipBlock(owned).join('\n');
  assert.match(block, /do NOT create or edit/i);
  assert.match(block, /vitest\.config\.ts/);
  assert.match(block, /owned by #56/);
  // And it is actually threaded through taskPrompt (after the role prefix).
  const p = taskPrompt(task('#57'), 'body', '', owned);
  assert.match(p, /Files owned by other in-flight tasks/);
  assert.match(p, /STOP/);
});

test('no ownership -> the prompt is byte-identical to before (empty block)', () => {
  assert.deepEqual(ownershipBlock([]), []);
  const withEmpty = taskPrompt(task('#1'), 'body', 'spec');
  const explicitEmpty = taskPrompt(task('#1'), 'body', 'spec', []);
  assert.equal(withEmpty, explicitEmpty);
});

test('pathMatchesOwn covers exact, subtree, and extension globs', () => {
  assert.equal(pathMatchesOwn('vitest.config.ts', 'vitest.config.ts'), true);
  assert.equal(pathMatchesOwn('tests/unit/a.test.ts', 'tests/**'), true);
  assert.equal(pathMatchesOwn('tests', 'tests/**'), true);
  assert.equal(pathMatchesOwn('src/app.ts', 'tests/**'), false);
  assert.equal(pathMatchesOwn('src/a.snap', '*.snap'), true);
  assert.equal(pathMatchesOwn('a/b/c.snap', '**/*.snap'), true);
  assert.equal(pathMatchesOwn('src/app.ts', 'src'), true);
  assert.equal(pathMatchesOwn('other/app.ts', 'src'), false);
});

test('ownKey normalises directory globs to a comparable key', () => {
  assert.equal(ownKey('tests/**'), 'tests');
  assert.equal(ownKey('./tests/'), 'tests');
  assert.equal(ownKey('a/b'), 'a/b');
});

// ---- #177: file-collision hold ---------------------------------------------
import { collidingPaths, isContended, holdColliding } from '../src/ownership.js';

test('collidingPaths finds exact, subtree, and glob overlaps', () => {
  assert.deepEqual(collidingPaths(['package.json'], ['package.json']), ['package.json']);
  assert.deepEqual(collidingPaths(['tests/**'], ['tests/unit/a.test.ts']), ['tests/**']);
  assert.deepEqual(collidingPaths(['src/a.ts'], ['src/b.ts']), []);
});

test('isContended flags lockfiles, manifest, and CI config', () => {
  assert.equal(isContended('package.json'), true);
  assert.equal(isContended('package-lock.json'), true);
  assert.equal(isContended('.github/workflows/ci.yml'), true);
  assert.equal(isContended('src/app.ts'), false);
});

// The acceptance: two ready tasks that both own package.json — exactly one is
// dispatched, the other is held on file contention.
test('two tasks owning package.json: one dispatches, one is held (acceptance)', () => {
  const { dispatch, held } = holdColliding([
    { key: '#52', files: ['package.json'] },
    { key: '#53', files: ['package.json'] },
  ]);
  assert.deepEqual(dispatch, ['#52']);
  assert.equal(held.length, 1);
  assert.equal(held[0].key, '#53');
  assert.deepEqual(held[0].on, ['package.json']);
});

test('non-overlapping tasks both dispatch', () => {
  const { dispatch, held } = holdColliding([
    { key: '#52', files: ['a.ts'] },
    { key: '#53', files: ['b.ts'] },
  ]);
  assert.deepEqual(dispatch, ['#52', '#53']);
  assert.equal(held.length, 0);
});

test('a claim already in flight holds a colliding new task', () => {
  const { dispatch, held } = holdColliding(
    [{ key: '#57', files: ['vitest.config.ts'] }],
    ['vitest.config.ts'], // #56 already building it
  );
  assert.deepEqual(dispatch, []);
  assert.deepEqual(held.map((h) => h.key), ['#57']);
});
