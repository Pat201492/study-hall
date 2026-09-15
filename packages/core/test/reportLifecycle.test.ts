import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reportSubject, reportsToClose, sweepDue, SWEEP_INTERVAL_MS } from '../src/reportLifecycle.js';

// Measured on the live report repo, 2026-09-01, before this existed:
// 45 open watchdog reports against 8 real work items, 40 of them naming an item
// already closed or merged. openIssueOnce dedupes FILING and nothing ever closed
// one, so finding the live report meant reading past forty dead ones.

test('both per-item report title shapes are parsed', () => {
  assert.deepEqual(
    reportSubject('[watchdog] Pat201492/dw:issue-110 on Pat201492/dw never settled after 9 attempts'),
    { repo: 'Pat201492/dw', kind: 'issue', number: 110 },
  );
  assert.deepEqual(
    reportSubject('[watchdog] stuck item IMPLEMENT:Pat201492/dw:pr-170 on Pat201492/dw'),
    { repo: 'Pat201492/dw', kind: 'pr', number: 170 },
  );
});

test('board-level reports name no item and are never retired automatically', () => {
  // They describe a condition, not an item, so no item's resolution retires
  // them. Closing them on a guess is exactly the behaviour being fixed.
  for (const t of [
    '[watchdog] board contested — dispatch paused on Pat201492/dw',
    '[watchdog] board contested — dispatch paused across 3 repo(s)',
    '[watchdog] engine killed: 4 items wedged at once',
  ]) {
    assert.equal(reportSubject(t), null, t);
  }
});

test('a non-watchdog issue is never a report', () => {
  assert.equal(reportSubject('feat(pool): a blackout window Pat201492/dw:issue-12'), null);
});

test('a resolved subject retires its report; a still-open one does not', () => {
  const reports = [
    { number: 246, title: '[watchdog] stuck item IMPLEMENT:o/r:issue-110 on o/r' },
    { number: 210, title: '[watchdog] stuck item IMPLEMENT:o/r:issue-48 on o/r' },
  ];
  const open = new Map([['o/r', new Set(['issue-48'])]]); // 110 gone, 48 still open
  const out = reportsToClose(reports, open);
  assert.deepEqual(out.map((x) => x.report), [246]);
  assert.deepEqual(out[0].subject, { repo: 'o/r', kind: 'issue', number: 110 });
});

test('issue-N and pr-N are different items sharing a number space', () => {
  const reports = [{ number: 9, title: '[watchdog] stuck item REVIEW:o/r:pr-12 on o/r' }];
  // issue-12 is open; pr-12 is NOT. They must not be confused.
  assert.deepEqual(reportsToClose(reports, new Map([['o/r', new Set(['issue-12'])]])).map((r) => r.report), [9]);
  assert.deepEqual(reportsToClose(reports, new Map([['o/r', new Set(['pr-12'])]])), []);
});

test('a subject on an unwatched board is left alone', () => {
  // We cannot see whether it resolved. Closing on that basis asserts something
  // unobserved — the same error the wedge report used to make about causes.
  const reports = [{ number: 5, title: '[watchdog] stuck item IMPLEMENT:other/repo:issue-1 on other/repo' }];
  assert.deepEqual(reportsToClose(reports, new Map([['o/r', new Set(['issue-1'])]])), []);
});

test('an empty board map retires nothing', () => {
  // Guards the worst failure available here: no evidence reads as "every subject
  // is absent", which would close every report on the board.
  const reports = [{ number: 1, title: '[watchdog] stuck item IMPLEMENT:o/r:issue-1 on o/r' }];
  assert.deepEqual(reportsToClose(reports, new Map()), []);
});

test('the sweep runs at boot, then only on the interval', () => {
  assert.equal(sweepDue(0, 1_000), true, 'never swept -> sweep now, clearing the last run\'s backlog');
  assert.equal(sweepDue(1_000, 1_000 + SWEEP_INTERVAL_MS - 1), false);
  assert.equal(sweepDue(1_000, 1_000 + SWEEP_INTERVAL_MS), true);
});
