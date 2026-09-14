import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachGuards, overBudget } from '../src/guards.js';
import type { ChildLike } from '../src/contract.js';

function fakeChild(): ChildLike & { killed: number } {
  const c = {
    pid: undefined as number | undefined, killed: 0,
    on: () => c,
    kill: () => { c.killed++; return true; },
  };
  // No pid → treeKill is a no-op; we assert through the guard state instead.
  return c as unknown as ChildLike & { killed: number };
}

/** Captures the tick function so a test can drive the idle watchdog by hand. */
function fakeInterval() {
  let tick: (() => void) | null = null;
  const setIntervalFn = ((fn: () => void) => { tick = fn; return { unref() {} } as unknown as NodeJS.Timeout; });
  return { setIntervalFn, tick: () => tick?.() };
}

test('overBudget: 0/undefined means OFF, and whichever limit trips first wins', () => {
  assert.equal(overBudget(5, 100, undefined), null);
  assert.equal(overBudget(5, 100, { maxTurns: 0, maxTokens: 0 }), null);
  assert.equal(overBudget(5, 100, { maxTurns: 5 }), 'maxTurns');
  assert.equal(overBudget(4, 100, { maxTurns: 5, maxTokens: 100 }), 'maxTokens');
  assert.equal(overBudget(4, 99, { maxTurns: 5, maxTokens: 100 }), null);
});

test('the idle watchdog counts CONSECUTIVE silent ticks and resets on output', () => {
  const { setIntervalFn, tick } = fakeInterval();
  const kills: number[] = [];
  const g = attachGuards(fakeChild(), { idleTicks: 3, setIntervalFn, onIdleKill: (i) => kills.push(i.ticks) });
  tick(); tick();
  g.noteOutput();           // the student spoke — the streak resets
  tick();                   // consumes the output flag
  tick(); tick();
  assert.equal(g.killedIdle, false, 'two silent ticks after output is not yet dead');
  tick();
  assert.equal(g.killedIdle, true);
  assert.deepEqual(kills, [3]);
  g.stop();
});

test('idleTicks: 0 disables the watchdog entirely', () => {
  const { setIntervalFn, tick } = fakeInterval();
  const g = attachGuards(fakeChild(), { idleTicks: 0, setIntervalFn });
  for (let i = 0; i < 100; i++) tick();
  assert.equal(g.killedIdle, false);
  g.stop();
});

test('the budget trips once, reports the spend at that moment, and stays tripped', () => {
  const { setIntervalFn } = fakeInterval();
  const stops: Array<{ turns: number; tokens: number; limit: string }> = [];
  const g = attachGuards(fakeChild(), { setIntervalFn, budget: { maxTokens: 1000 }, onBudgetStop: (i) => stops.push(i) });
  assert.equal(g.noteUsage(1, 400), null);
  assert.equal(g.noteUsage(2, 1000), 'maxTokens');
  assert.equal(g.noteUsage(3, 5000), 'maxTokens', 'events already in the pipe do not re-fire the stop');
  assert.deepEqual(stops, [{ turns: 2, tokens: 1000, limit: 'maxTokens' }]);
  g.stop();
});

test('an abort signal marks the run cancelled', () => {
  const { setIntervalFn } = fakeInterval();
  const ac = new AbortController();
  const g = attachGuards(fakeChild(), { setIntervalFn, signal: ac.signal });
  assert.equal(g.cancelled, false);
  ac.abort();
  assert.equal(g.cancelled, true);
  g.stop();
});

test('noteText keeps the newest non-blank text for the stall diagnosis', () => {
  const { setIntervalFn } = fakeInterval();
  const g = attachGuards(fakeChild(), { setIntervalFn });
  g.noteText('  first ');
  g.noteText('   ');
  g.noteText("You've hit your session limit");
  assert.equal(g.lastText, "You've hit your session limit");
  g.stop();
});
