import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  effectiveDifficulty, expectedDifficultyWith, resolveAcTiering, criteriaCount,
  DEFAULT_AC_TIERING,
} from '../src/difficultyRubric.js';
import { auditSignals } from '../src/issueAudit.js';
import { issueToTask } from '../src/github.js';
import { inferDifficulty } from '../src/difficulty.js';
import type { IssueAuditSignals } from '../src/issueAudit.js';

function signals(over: Partial<IssueAuditSignals> = {}): IssueAuditSignals {
  return {
    bodyChars: 400, criteria: 0, checkable: 0, paths: 0, subsystems: 1,
    vagueMarkers: 0, hasCriteriaSection: true, ...over,
  };
}

const body = (n: number) => [
  '## Context', 'Some real context that makes this a plausible issue body.', '',
  '## Acceptance criteria', ...Array.from({ length: n }, (_, i) => `- [ ] criterion number ${i + 1}`),
].join('\n');

// The bands are the rubric's, and the rubric is docs/ISSUE-RUBRIC.md — the sheet
// students read. Drift between them is the bug this asserts against.
test('the default bands mirror the issue rubric', () => {
  assert.deepEqual(DEFAULT_AC_TIERING, { enabled: true, simpleMax: 2, hardMin: 7 });
  assert.equal(expectedDifficultyWith(signals({ criteria: 2 })), 'simple');
  assert.equal(expectedDifficultyWith(signals({ criteria: 3 })), 'standard');
  assert.equal(expectedDifficultyWith(signals({ criteria: 6 })), 'standard');
  assert.equal(expectedDifficultyWith(signals({ criteria: 7 })), 'hard');
});

test('thresholds are configurable and a partial config keeps the measured rest', () => {
  assert.equal(expectedDifficultyWith(signals({ criteria: 5 }), { hardMin: 4 }), 'hard');
  assert.deepEqual(resolveAcTiering({ hardMin: 4 }), { enabled: true, simpleMax: 2, hardMin: 4 });
  assert.deepEqual(resolveAcTiering(), DEFAULT_AC_TIERING);
});

test('criteria drive the difficulty when the body states them', () => {
  const e = effectiveDifficulty('standard', signals({ criteria: 9, subsystems: 2 }), 'standard');
  assert.equal(e.difficulty, 'hard');
  assert.equal(e.source, 'criteria');
  assert.equal(e.criteria, 9);
});

// The label may raise but never lower. It is a human judgement that can know
// something the text does not say; it just cannot be trusted to know less.
test('the stronger of label and criteria wins', () => {
  const up = effectiveDifficulty('hard', signals({ criteria: 1 }), 'standard');
  assert.equal(up.difficulty, 'hard', 'a hard label survives a small criteria count');
  assert.equal(up.source, 'label');

  const down = effectiveDifficulty('simple', signals({ criteria: 8 }), 'standard');
  assert.equal(down.difficulty, 'hard', 'a simple label cannot hold down an 8-criteria issue');
  assert.equal(down.source, 'criteria');
});

// The one failure this must not have. criteria 0 satisfies `<= simpleMax`, so a
// naive implementation routes a badly written issue to the cheapest tier on the
// strength of it being badly written.
test('no parseable criteria falls back to the label, never to simple', () => {
  const e = effectiveDifficulty('standard', signals({ criteria: 0, checkable: 0 }), 'standard');
  assert.equal(e.difficulty, 'standard');
  assert.equal(e.source, 'label-no-criteria');

  const noLabel = effectiveDifficulty(undefined, signals({ criteria: 0, checkable: 0 }), 'hard');
  assert.equal(noLabel.difficulty, 'hard', 'with no label it keeps the keyword inference');
  assert.equal(noLabel.source, 'label-no-criteria');
});

test('disabling restores label-only tiering', () => {
  const e = effectiveDifficulty('simple', signals({ criteria: 12 }), 'standard', { enabled: false });
  assert.equal(e.difficulty, 'simple');
  assert.equal(e.source, 'disabled');
});

test('criteria are counted off a real issue body', () => {
  assert.equal(criteriaCount(auditSignals(body(9))), 9);
  assert.equal(criteriaCount(auditSignals('just prose, nothing checkable')), 0);
});

// End-to-end through the function the engine actually calls.
test('issueToTask tiers a 9-criteria issue up despite a simple label', () => {
  const task = issueToTask(
    { number: 1, title: 'Add the thing', body: body(9), labels: [{ name: 'difficulty:simple' }] },
    'token', inferDifficulty,
  );
  assert.equal(task.difficulty, 'hard');
  assert.equal(task.model, 'opus');
});

// A pin is an operator naming a tier outright. No signal outranks that.
test('a model: pin still overrides everything', () => {
  const task = issueToTask(
    {
      number: 2, title: 'Add the thing', body: body(12),
      labels: [{ name: 'difficulty:simple' }, { name: 'model:haiku' }],
    },
    'token', inferDifficulty,
  );
  assert.equal(task.model, 'haiku', 'the pin wins over a 12-criteria body');
  assert.equal(task.pinned, true);
});

// Speed mode bumps the resulting tier one step; it must act on the tier the new
// signal produced, not re-open the difficulty decision.
test('the Speed/Token toggle still applies on top of the criteria-derived tier', () => {
  const args = {
    number: 3, title: 'Tiny tweak', body: body(1), labels: [] as { name: string }[],
  };
  const token = issueToTask(args, 'token', inferDifficulty);
  assert.equal(token.difficulty, 'simple');
  assert.equal(token.model, 'haiku');

  const speed = issueToTask(args, 'speed', inferDifficulty);
  assert.equal(speed.difficulty, 'simple', 'speed changes the tier, not the difficulty');
  assert.equal(speed.model, 'sonnet');
});

test('an issue with an unparseable body keeps the behaviour it has today', () => {
  const task = issueToTask(
    { number: 4, title: 'Do something', body: 'no criteria here', labels: [{ name: 'difficulty:standard' }] },
    'token', inferDifficulty,
  );
  assert.equal(task.difficulty, 'standard');
  assert.equal(task.model, 'opus');
});
