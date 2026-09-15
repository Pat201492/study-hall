import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tierForDifficulty, effortFor, inferDifficulty } from '../src/difficulty.js';

// -- difficulty -> tier --

test('tierForDifficulty: standard routes to opus — measured, not assumed', () => {
  // Over 48 implement dispatches: opus merged 100% and was approved on the
  // first review 85% of the time on a median 1.09M tokens; sonnet managed 82%,
  // 48%, and 2.74M. Even at opus's ~1.67x weight that is cheaper per MERGED PR,
  // because a rework round costs far more than the tier difference saves.
  assert.equal(tierForDifficulty('standard', 'token'), 'opus');
  assert.equal(tierForDifficulty('hard', 'token'), 'opus');
  // Trivia is untouched: the measurement compared the two tiers competing for
  // real implement work, and said nothing about haiku.
  assert.equal(tierForDifficulty('simple', 'token'), 'haiku');
});

test('tierForDifficulty: speed mode shifts every tier up (never above opus)', () => {
  assert.equal(tierForDifficulty('simple', 'speed'), 'sonnet');
  assert.equal(tierForDifficulty('standard', 'speed'), 'opus');
  assert.equal(tierForDifficulty('hard', 'speed'), 'opus');
});

// -- effort selection --

test('effortFor: xhigh coding on sonnet/opus, low on haiku', () => {
  assert.equal(effortFor('haiku', 'token'), 'low');
  assert.equal(effortFor('sonnet', 'speed'), 'xhigh');
  assert.equal(effortFor('opus', 'speed'), 'xhigh');
});

test('effortFor: sub-agent calls are always low effort regardless of tier', () => {
  assert.equal(effortFor('opus', 'speed', { subagent: true }), 'low');
  assert.equal(effortFor('sonnet', 'token', { subagent: true }), 'low');
});

test('effortFor: token mode dials xhigh down to medium (lower effort, more cache reuse)', () => {
  assert.equal(effortFor('sonnet', 'token'), 'medium');
  assert.equal(effortFor('opus', 'token'), 'medium');
});

test('effortFor: haiku stays low in both modes (nothing to dial down further)', () => {
  assert.equal(effortFor('haiku', 'speed'), 'low');
  assert.equal(effortFor('haiku', 'token'), 'low');
});

// -- difficulty heuristic --

test('inferDifficulty flags hard-signal titles as hard', () => {
  assert.equal(inferDifficulty('Rearchitect the auth module for the new SSO provider'), 'hard');
  assert.equal(inferDifficulty('Fix race condition in the scheduler'), 'hard');
});

test('inferDifficulty flags simple-signal titles as simple', () => {
  assert.equal(inferDifficulty('Fix typo in README'), 'simple');
  assert.equal(inferDifficulty('Rename variable for clarity'), 'simple');
});

test('inferDifficulty defaults to standard when no signal matches', () => {
  assert.equal(inferDifficulty('Add pagination to the task list endpoint'), 'standard');
});
