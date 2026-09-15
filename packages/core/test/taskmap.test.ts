import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { loadTaskMap, saveTaskMap } from '../src/taskmapIo.js';
import {
  emptyTaskMap, seedTaskMap,
  addTask, removeTask, setModel, setRole, setPriority, setPinned, pinToOpus,
  addDep, removeDep, setStage, isBlocked, readyQueue, nextForTier,
  tierFor, retierTask, retierAll, effortForTask, setDifficulty,
  type TaskMap, type Task,
} from '../src/taskmap.js';

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id, title: id, model: 'sonnet', role: 'implement', priority: 1, deps: [],
    pinned: false, assignedStudent: null, stage: 'ready', ...overrides,
  };
}

// -- model --

test('emptyTaskMap starts with no tasks', () => {
  assert.deepEqual(emptyTaskMap(), { tasks: [] });
});

test('seedTaskMap seeds a chained implement -> review -> merge DAG', () => {
  const map = seedTaskMap();
  assert.equal(map.tasks.length, 3);
  const t2 = map.tasks.find((t) => t.id === 't2')!;
  assert.deepEqual(t2.deps, ['t1']);
});

test('loadTaskMap falls back to an empty map when the file is missing', () => {
  const map = loadTaskMap('does-not-exist.json');
  assert.deepEqual(map.tasks, []);
});

test('saveTaskMap + loadTaskMap round-trips', () => {
  const path = join(tmpdir(), `taskmap-test-${process.pid}-${Date.now()}.json`);
  try {
    const map: TaskMap = { tasks: [task('a', { priority: 7 })] };
    saveTaskMap(path, map);
    const reloaded = loadTaskMap(path);
    assert.equal(reloaded.tasks.length, 1);
    assert.equal(reloaded.tasks[0].priority, 7);
  } finally {
    rmSync(path, { force: true });
  }
});

// -- edit ops --

test('addTask appends a task and rejects a duplicate id', () => {
  const map = emptyTaskMap();
  addTask(map, task('a'));
  assert.equal(map.tasks.length, 1);
  assert.throws(() => addTask(map, task('a')));
});

test('removeTask deletes the task and scrubs it from other tasks\' deps', () => {
  const map: TaskMap = { tasks: [task('a'), task('b', { deps: ['a'] })] };
  removeTask(map, 'a');
  assert.equal(map.tasks.length, 1);
  assert.deepEqual(map.tasks[0].deps, []);
});

test('setModel, setRole, setPriority, setPinned mutate the named task', () => {
  const map: TaskMap = { tasks: [task('a')] };
  setModel(map, 'a', 'opus');
  setRole(map, 'a', 'review');
  setPriority(map, 'a', 42);
  setPinned(map, 'a', true);
  const a = map.tasks[0];
  assert.equal(a.model, 'opus');
  assert.equal(a.role, 'review');
  assert.equal(a.priority, 42);
  assert.equal(a.pinned, true);
});

test('setDifficulty labels a task, and clears the label when passed undefined', () => {
  const map: TaskMap = { tasks: [task('a')] };
  setDifficulty(map, 'a', 'hard');
  assert.equal(map.tasks[0].difficulty, 'hard');
  setDifficulty(map, 'a', undefined);
  assert.equal(map.tasks[0].difficulty, undefined);
});

test('pinToOpus locks a hard task to the opus tier', () => {
  const map: TaskMap = { tasks: [task('a', { model: 'haiku' })] };
  pinToOpus(map, 'a');
  assert.equal(map.tasks[0].model, 'opus');
  assert.equal(map.tasks[0].pinned, true);
});

test('addDep / removeDep edit the dep list', () => {
  const map: TaskMap = { tasks: [task('a'), task('b')] };
  addDep(map, 'a', 'b');
  assert.deepEqual(map.tasks[0].deps, ['b']);
  removeDep(map, 'a', 'b');
  assert.deepEqual(map.tasks[0].deps, []);
});

test('addDep rejects self-deps and deps on unknown tasks', () => {
  const map: TaskMap = { tasks: [task('a')] };
  assert.throws(() => addDep(map, 'a', 'a'));
  assert.throws(() => addDep(map, 'a', 'ghost'));
});

test('addDep rejects an edge that would create a cycle', () => {
  const map: TaskMap = { tasks: [task('a'), task('b')] };
  addDep(map, 'a', 'b'); // a depends on b
  assert.throws(() => addDep(map, 'b', 'a')); // b -> a would close the loop
});

// -- dependency gating --

test('a task with no deps, or all-done deps, is unblocked', () => {
  const map: TaskMap = {
    tasks: [task('a'), task('b', { deps: ['a'], stage: 'ready' })],
  };
  assert.equal(isBlocked(map, 'a'), false);
  assert.equal(isBlocked(map, 'b'), true); // 'a' isn't done yet
  setStage(map, 'a', 'done');
  assert.equal(isBlocked(map, 'b'), false);
});

test('a missing dep blocks rather than silently unblocking', () => {
  const map: TaskMap = { tasks: [task('b', { deps: ['ghost'] })] };
  assert.equal(isBlocked(map, 'b'), true);
});

test('readyQueue returns only ready, unblocked, unassigned tasks, highest priority first', () => {
  const map: TaskMap = {
    tasks: [
      task('low', { priority: 1 }),
      task('high', { priority: 9 }),
      task('gated', { priority: 5, deps: ['low'] }), // 'low' not done -> blocked
      task('taken', { priority: 10, assignedStudent: 'sonnet-1' }),
      task('inflight', { priority: 10, stage: 'implementing' }),
    ],
  };
  const queue = readyQueue(map).map((t) => t.id);
  assert.deepEqual(queue, ['high', 'low']);
});

test('editing a task (priority, deps) changes what readyQueue hands the Protector next', () => {
  const map: TaskMap = { tasks: [task('a', { priority: 1 }), task('b', { priority: 1 })] };
  assert.equal(readyQueue(map)[0].id, 'a'); // tie -> insertion order
  setPriority(map, 'b', 5);
  assert.equal(readyQueue(map)[0].id, 'b'); // reprioritizing b promotes it
  addDep(map, 'b', 'a');
  assert.equal(readyQueue(map)[0].id, 'a'); // now b is gated on a again
});

test('nextForTier filters the ready queue by model tier', () => {
  const map: TaskMap = {
    tasks: [task('h', { model: 'haiku', priority: 5 }), task('s', { model: 'sonnet', priority: 9 })],
  };
  assert.equal(nextForTier(map, 'sonnet')?.id, 's');
  assert.equal(nextForTier(map, 'haiku')?.id, 'h');
  assert.equal(nextForTier(map, 'opus'), undefined);
});

// -- model tiering by difficulty (M8) --

test('tierFor: hard and standard -> opus, simple -> haiku', () => {
  assert.equal(tierFor(task('a', { difficulty: 'hard' }), 'token'), 'opus');
  assert.equal(tierFor(task('b', { difficulty: 'simple' }), 'token'), 'haiku');
  // `standard` moved to opus on measured outcomes — see difficulty.ts.
  assert.equal(tierFor(task('c', { difficulty: 'standard' }), 'token'), 'opus');
});

test('tierFor infers difficulty from the title when no label is set', () => {
  assert.equal(tierFor(task('a', { title: 'Fix typo in docs' }), 'token'), 'haiku');
  assert.equal(tierFor(task('b', { title: 'Migrate the payments database' }), 'token'), 'opus');
});

test('tierFor: the speed/token toggle (#7) shifts the difficulty->tier mapping', () => {
  const t = task('a', { difficulty: 'simple' });
  assert.equal(tierFor(t, 'token'), 'haiku');
  assert.equal(tierFor(t, 'speed'), 'sonnet');
});

test('tierFor never retiers a pinned task, even across a toggle flip', () => {
  const t = task('a', { difficulty: 'simple', model: 'opus', pinned: true });
  assert.equal(tierFor(t, 'token'), 'opus');
  assert.equal(tierFor(t, 'speed'), 'opus');
});

test('retierTask updates an unpinned task\'s model in place; retierAll does the whole map', () => {
  const map: TaskMap = {
    tasks: [
      task('a', { difficulty: 'hard', model: 'sonnet' }),
      task('b', { difficulty: 'simple', model: 'sonnet', pinned: true }),
    ],
  };
  retierTask(map, 'a', 'token');
  assert.equal(map.tasks[0].model, 'opus');
  retierAll(map, 'token');
  assert.equal(map.tasks[0].model, 'opus');
  assert.equal(map.tasks[1].model, 'sonnet'); // pinned, untouched by retierAll
});

test('effortForTask: xhigh coding on sonnet/opus, low on haiku, low for sub-agents', () => {
  assert.equal(effortForTask(task('a', { model: 'opus' }), 'speed'), 'xhigh');
  assert.equal(effortForTask(task('b', { model: 'haiku' }), 'speed'), 'low');
  assert.equal(effortForTask(task('c', { model: 'opus' }), 'speed', { subagent: true }), 'low');
});
