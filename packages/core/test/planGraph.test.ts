import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planLayout, WAVE_LABEL, type PlanItem } from '../src/planGraph.js';

const it = (number: number, deps: number[] = [], stage: PlanItem['stage'] = 'ready'): PlanItem =>
  ({ number, title: `issue ${number}`, deps, stage });

test('issues fall into waves: a node sits one past its deepest open dependency', () => {
  const l = planLayout([it(1), it(2, [1]), it(3, [2]), it(4), it(5, [1, 4])]);
  assert.deepEqual(l.columns.map((c) => c.map((n) => n.number)), [[1, 4], [2, 5], [3]]);
  assert.equal(l.waves, 3);
  assert.equal(l.total, 5);
  assert.equal(WAVE_LABEL(0), 'BUILDABLE NOW');
  assert.equal(WAVE_LABEL(2), 'AFTER WAVE 2');
});

test('a dependency on something closed or absent does not hold an issue back', () => {
  // #9 is not in the open set: it is already built, so #1 is buildable now.
  const l = planLayout([it(1, [9]), it(2, [1])]);
  assert.deepEqual(l.columns.map((c) => c.map((n) => n.number)), [[1], [2]]);
  assert.deepEqual(l.columns[0][0].openDeps, [], 'the drawing only keeps edges it can reach');
});

test('a cycle is reported rather than given a confident wave number', () => {
  // A board whose issues depend on each other in a loop can never drain.
  // Calling any of them "buildable now" would be a lie told with a straight face.
  const l = planLayout([it(1, [3]), it(2, [1]), it(3, [2]), it(4)]);
  assert.deepEqual(l.cycles, [1, 2, 3]);
  assert.ok(l.columns[0].find((n) => n.number === 1)?.inCycle);
  assert.equal(l.columns[0].find((n) => n.number === 4)?.inCycle, false);
  assert.equal(l.buildableNow, 1, 'only #4 is honestly startable');
});

test('buildable now is the engine\'s verdict, not a position in the graph', () => {
  // No open dependency, but parked or already in a PR: the chart must not
  // promise work the board will not hand out.
  const l = planLayout([it(1, [], 'ready'), it(2, [], 'parked'), it(3, [], 'in-pr'), it(4, [], 'blocked')]);
  assert.equal(l.columns[0].length, 4, 'all four have nothing blocking them structurally');
  assert.equal(l.buildableNow, 1);
});

test('a self-dependency is ignored rather than making the issue its own blocker', () => {
  const l = planLayout([it(1, [1]), it(2, [1])]);
  assert.deepEqual(l.columns.map((c) => c.map((n) => n.number)), [[1], [2]]);
  assert.deepEqual(l.cycles, []);
});

test('a long chain lays out without recursion, and an empty board is empty rather than broken', () => {
  const chain = Array.from({ length: 400 }, (_, i) => it(i + 1, i ? [i] : []));
  const l = planLayout(chain);
  assert.equal(l.waves, 400);
  assert.equal(l.columns[399][0].number, 400);

  const empty = planLayout([]);
  assert.deepEqual(empty.columns, [[]]);
  assert.equal(empty.total, 0);
  assert.equal(empty.buildableNow, 0);
  assert.equal(empty.waves, 0);
});

test('columns are ordered by issue number, so the chart does not reshuffle between refreshes', () => {
  const a = planLayout([it(30), it(10), it(20)]);
  const b = planLayout([it(20), it(30), it(10)]);
  assert.deepEqual(a.columns[0].map((n) => n.number), [10, 20, 30]);
  assert.deepEqual(a.columns, b.columns);
});
