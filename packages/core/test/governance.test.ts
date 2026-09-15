import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Governance, failureSignature, infraPauseMs, DEFAULT_CRASH_BURST, type GovernanceVerdict } from '../src/engine/governance.js';
import { DEFAULT_BLACKOUT } from '../src/blackout.js';
import { firstOffence } from '../src/parole.js';

const NOW = 1_700_000_000_000;

function gov(over: Partial<ConstructorParameters<typeof Governance>[0]> = {}): Governance {
  return new Governance({ blackout: { ...DEFAULT_BLACKOUT, enabled: false }, maxParallel: 4, ...over });
}

const kinds = (v: GovernanceVerdict[]) => v.map((x) => x.kind);

test('a capacity verdict forgives the attempt AND the lifetime unit and pauses that provider until reset plus margin', () => {
  const g = gov();
  g.recordDispatch('o/r:pr-12');
  g.recordDispatch('o/r:pr-12');
  assert.equal(g.watchdog.attemptsFor('o/r:pr-12'), 2);
  assert.equal(g.watchdog.lifetimeFor('o/r:pr-12'), 2);

  const resetAt = NOW + 45 * 60_000;
  const v = g.onFailure({
    verdict: { kind: 'capacity', resetAt }, provider: 'anthropic',
    item: 'o/r:pr-12', key: 'FIX:o/r:pr-12', message: "You've hit your session limit · resets 4:40am", now: NOW,
  });
  assert.deepEqual(kinds(v), ['forgive', 'pause-provider']);
  const pause = v[1] as Extract<GovernanceVerdict, { kind: 'pause-provider' }>;
  assert.equal(pause.provider, 'anthropic');
  assert.equal(pause.until, resetAt + 60_000);
  assert.equal(g.watchdog.attemptsFor('o/r:pr-12'), 1, 'one attempt given back');
  assert.equal(g.watchdog.lifetimeFor('o/r:pr-12'), 1, 'one lifetime unit given back');

  // No reset named -> the fallback hold from now.
  const noReset = g.onFailure({ verdict: { kind: 'capacity' }, provider: 'openai', item: 'o/r:issue-3', key: 'IMPLEMENT:o/r:issue-3', message: 'You’ve hit your usage limit', now: NOW });
  assert.equal((noReset[1] as { until: number }).until, NOW + 300_000 + 60_000);
});

test('an auth verdict halts that provider lane with the reason; other providers are untouched', () => {
  const g = gov();
  const v = g.onFailure({
    verdict: { kind: 'auth', detail: 'access token could not be refreshed' }, provider: 'openai',
    item: 'o/r:issue-1', key: 'IMPLEMENT:o/r:issue-1', message: 'ERROR: access token could not be refreshed', now: NOW,
  });
  assert.deepEqual(kinds(v), ['forgive', 'halt-provider']);
  assert.deepEqual(g.halted(), { openai: 'access token could not be refreshed' });
  assert.equal(g.isHalted('anthropic'), false);
  assert.equal(g.assessTick(NOW).halted.openai, 'access token could not be refreshed');

  // The lane stays halted until an operator clears it — a second tick does not lift it.
  assert.equal(g.assessTick(NOW + 3_600_000).halted.openai, 'access token could not be refreshed');
  assert.equal(g.clearHalt('openai'), true);
  assert.deepEqual(g.halted(), {});
});

test('five infra failures sharing a signature within ten minutes trigger the standdown; a different sixth does not extend it', () => {
  const g = gov();
  const fire = (msg: string, at: number) => g.onFailure({ verdict: { kind: 'infra' }, provider: 'anthropic', item: 'o/r:issue-1', key: 'IMPLEMENT:o/r:issue-1', message: msg, now: at });

  let standdown: Extract<GovernanceVerdict, { kind: 'standdown' }> | undefined;
  for (let i = 0; i < DEFAULT_CRASH_BURST.count; i++) {
    const v = fire(`claude returned no JSON result (pid ${1000 + i})`, NOW + i * 60_000);
    const s = v.find((x) => x.kind === 'standdown');
    if (s) standdown = s as typeof standdown;
  }
  assert.ok(standdown, 'standdown fired on the fifth same-signature failure');
  assert.equal(standdown.count, 5);
  assert.equal(standdown.signature, 'claude returned no JSON result (pid #)');
  const firedAt = NOW + 4 * 60_000;
  assert.equal(standdown.until, firedAt + DEFAULT_CRASH_BURST.standdownMs);

  // A sixth failure with a DIFFERENT signature neither extends nor restarts the standdown.
  const six = fire('spawn codex ENOENT', firedAt + 60_000);
  assert.ok(!six.some((x) => x.kind === 'standdown'));
  assert.equal(g.dispatchPause(firedAt + 60_000)?.until, standdown.until);

  // The infra streak paused dispatch too (three in a row), with escalating backoff.
  assert.equal(infraPauseMs(2), 0);
  assert.equal(infraPauseMs(3), 2 * 60_000);
  assert.equal(infraPauseMs(4), 4 * 60_000);
  assert.equal(infraPauseMs(10), 15 * 60_000);
  assert.equal(g.infraStreakCount(), 6);
  g.recordSuccess();
  assert.equal(g.infraStreakCount(), 0);
});

test('a task failure charges exactly the attempts already recorded; a cancel forgives', () => {
  const g = gov();
  g.recordDispatch('o/r:issue-7');
  const task = g.onFailure({ verdict: { kind: 'task' }, provider: 'anthropic', item: 'o/r:issue-7', key: 'IMPLEMENT:o/r:issue-7', message: 'tests failed', now: NOW });
  assert.deepEqual(task, [{ kind: 'charge', item: 'o/r:issue-7', attempts: 1, lifetime: 1 }]);

  const cancel = g.onFailure({ verdict: { kind: 'cancelled' }, provider: 'anthropic', item: 'o/r:issue-7', key: 'IMPLEMENT:o/r:issue-7', message: 'cancelled', now: NOW });
  assert.deepEqual(kinds(cancel), ['forgive']);
  assert.equal(g.watchdog.attemptsFor('o/r:issue-7'), 0);
});

test('every verdict is a plain object (JSON round-trips unchanged) with no side effects inside governance', () => {
  const g = gov();
  const all = [
    ...g.onFailure({ verdict: { kind: 'capacity', resetAt: NOW + 1 }, provider: 'a', item: 'o/r:pr-1', key: 'FIX:o/r:pr-1', message: 'm', now: NOW }),
    ...g.onFailure({ verdict: { kind: 'auth' }, provider: 'b', item: 'o/r:pr-1', key: 'FIX:o/r:pr-1', message: 'expired', now: NOW }),
    ...g.onFailure({ verdict: { kind: 'infra' }, provider: 'a', item: 'o/r:pr-1', key: 'FIX:o/r:pr-1', message: 'crash', now: NOW }),
    ...g.onFailure({ verdict: { kind: 'task' }, provider: 'a', item: 'o/r:pr-1', key: 'FIX:o/r:pr-1', message: 'bad', now: NOW }),
  ];
  for (const v of all) assert.deepEqual(JSON.parse(JSON.stringify(v)), v);
});

test('tick assessment: blackout window, throttle limit, external pause, escalation', () => {
  const g = new Governance({ blackout: { enabled: true, from: '22:00', to: '23:00' }, maxParallel: 3 });
  const at2230 = new Date(2026, 8, 15, 22, 30).getTime();
  const at1200 = new Date(2026, 8, 15, 12, 0).getTime();
  assert.equal(g.assessTick(at2230).blackout, true);
  assert.equal(g.assessTick(at2230).blackoutMinutes, 30);
  assert.equal(g.assessTick(at1200).blackout, false);

  assert.equal(g.assessTick(at1200).throttleLimit, 3);
  g.observeContention(5);
  assert.equal(g.assessTick(at1200).throttleLimit, 2);

  g.pauseDispatch(at1200 + 90_000, 'GitHub rate limit');
  assert.deepEqual(g.dispatchPause(at1200), { until: at1200 + 90_000, reason: 'GitHub rate limit' });
  assert.equal(g.dispatchPause(at1200 + 100_000), null);
  assert.equal(g.assessTick(at1200).escalation.level, 'ok');
});

test('parole: served sentences are released unless the lifetime cap is spent', () => {
  const g = gov({ watchdog: { lifetimeDispatchCap: 2 } });
  g.recordDispatch('o/r:issue-9');
  g.recordDispatch('o/r:issue-9');
  const records: [string, ReturnType<typeof firstOffence>][] = [
    ['o/r:issue-8', firstOffence(NOW - 3 * 60 * 60_000)],
    ['o/r:issue-9', firstOffence(NOW - 3 * 60 * 60_000)],
    ['o/r:issue-10', firstOffence(NOW - 60_000)],
  ];
  const due = g.paroleDue(records, NOW);
  assert.deepEqual(due, { release: ['o/r:issue-8'], exhausted: ['o/r:issue-9'] });
  g.release('o/r:issue-8', 'IMPLEMENT:o/r:issue-8');
  assert.equal(g.watchdog.needsRewrite('o/r:issue-8'), false);
});

test('failureSignature blanks numbers and hex so crashes that differ by pid or address collapse', () => {
  assert.equal(failureSignature('segfault at 0x7ffd3 in worker 12\nstack...'), 'segfault at # in worker #');
  assert.notEqual(failureSignature('spawn codex ENOENT'), failureSignature('returned no JSON result'));
});
