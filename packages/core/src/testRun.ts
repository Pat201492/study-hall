import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// Bounded run ("finish N items, then park everything until I say go").
//
// Starting the pool today is all-or-nothing: it runs until someone stops it, and
// stopping it is either a tree-kill that throws away in-flight work or a soft
// stop you have to remember to ask for. Neither is what you want when you are
// TESTING a change — there the question is "does this behave correctly on a
// handful of items", and the answer needs the board to stop by itself once it
// has produced enough to judge, before it spends the rest of the night acting on
// a change nobody has looked at yet.
//
// Deliberately built ON the existing drain, not beside it. Reaching the budget
// requests a soft stop, which means in-flight students still land their work and
// the Protector exits by itself — the semantics are already specified, already
// tested, and (since the merge-guard leak was fixed) actually terminate. A
// second, parallel "stop" concept would be a second thing to get wrong.
//
// Same file-based signalling as drain.ts, for the same reason: the dashboard owns
// the Protector as a spawned child and talks to it only through the filesystem,
// and a file survives a dashboard restart, so a budget set at 2am is still in
// force at 3am.

/** What counts as one completed item. */
export type TestRunUnit =
  /** A PR opened — an implementer finished a whole issue. The default: it is the
   *  unit a human means by "finish an issue", and it is observable on GitHub. */
  | 'pr'
  /** A PR merged — the full pipeline, including review and fix rounds. Slower,
   *  but the only unit that proves the board can finish something end to end. */
  | 'merge';

export interface TestRunState {
  /** Stop dispatching new work once `done` reaches this. */
  limit: number;
  /** How many units have completed since the budget was set. */
  done: number;
  unit: TestRunUnit;
  /** ISO time the budget was set, so a stale one is recognisable. */
  since: string;
}

export function testRunPath(dir: string = join(homedir(), '.claude-study-room')): string {
  return join(dir, 'testrun.json');
}

/** Arm a bounded run. Overwrites any existing budget, and resets progress. */
export function startTestRun(limit: number, unit: TestRunUnit = 'pr', file: string = testRunPath()): TestRunState {
  const state: TestRunState = { limit: Math.max(1, Math.floor(limit)), done: 0, unit, since: new Date().toISOString() };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(state, null, 2), 'utf8');
  return state;
}

/**
 * Clear the budget.
 *
 * Called on resume, and by the engine once the budget is spent. Leaving a
 * finished budget on disk would make the NEXT start drain immediately and look
 * broken — the same failure clearDrain() exists to prevent.
 */
export function clearTestRun(file: string = testRunPath()): void {
  try { if (existsSync(file)) rmSync(file); } catch { /* reported by the caller's next read */ }
}

/** The current budget, or null when the pool is running unbounded. */
export function readTestRun(file: string = testRunPath()): TestRunState | null {
  try {
    if (!existsSync(file)) return null;
    const s = JSON.parse(readFileSync(file, 'utf8')) as Partial<TestRunState>;
    if (typeof s.limit !== 'number' || s.limit < 1) return null;
    return {
      limit: s.limit,
      done: typeof s.done === 'number' && s.done >= 0 ? s.done : 0,
      unit: s.unit === 'merge' ? 'merge' : 'pr',
      since: typeof s.since === 'string' ? s.since : new Date().toISOString(),
    };
  } catch {
    return null;   // unreadable budget is no budget: never strand a board on it
  }
}

/**
 * Record one completed unit and report whether the budget is now spent.
 *
 * Persisted on every increment rather than held in memory, so a crash mid-run
 * resumes with the count it had reached instead of starting the budget over.
 */
export function noteCompletion(unit: TestRunUnit, file: string = testRunPath()): { spent: boolean; state: TestRunState | null } {
  const state = readTestRun(file);
  if (!state) return { spent: false, state: null };
  if (state.unit !== unit) return { spent: false, state };
  state.done += 1;
  try { writeFileSync(file, JSON.stringify(state, null, 2), 'utf8'); } catch { /* count still advances in memory */ }
  return { spent: state.done >= state.limit, state };
}

/** One line for the log and the dashboard: "test run 2/3 PRs". */
export function describeTestRun(state: TestRunState | null): string {
  if (!state) return '';
  return `test run ${state.done}/${state.limit} ${state.unit === 'merge' ? 'merges' : 'PRs'}`;
}
