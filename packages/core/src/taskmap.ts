import type { Tier } from './tiers.js';
import type { OptimizationMode } from './optimizer.js';
import { type Difficulty, type Effort, tierForDifficulty, effortFor, inferDifficulty } from './difficulty.js';

// The Task Map (M6, screen 2): the plan the Protector executes. Persisted as
// JSON so the dashboard can edit it live and the Protector picks up edits on
// its next heartbeat (same "reload config.json every tick" pattern as
// dashboard.ts's pool-size edits — see index.ts).
//
// Two lenses on the same task list:
//  - Task Map proper: the dependency DAG (deps[] gate a task until every dep
//    reaches 'done').
//  - Workflow map: the same tasks viewed as a pipeline Kanban, columns =
//    Stage. Dragging a card is just setStage().

// The single definition of a board role. pool.ts re-exports this rather than
// declaring its own copy — there used to be two identical unions in the two
// files, so adding a role meant remembering both, and TypeScript reported the
// mismatch as an inscrutable "Map<string, Role> is not assignable to
// Map<string, Role>" rather than as the duplication it was.
export type Role = 'triage' | 'implement' | 'review' | 'fix' | 'rewrite' | 'resolve' | 'merge';
export type Stage = 'ready' | 'implementing' | 'review' | 'fixing' | 'merging' | 'done';

export const STAGES: Stage[] = ['ready', 'implementing', 'review', 'fixing', 'merging', 'done'];

export interface Task {
  id: string;
  title: string;
  model: Tier;
  role: Role;
  priority: number; // higher = more urgent
  deps: string[]; // ids of tasks that must reach 'done' first
  pinned: boolean; // locked to `model` — the Protector may not retier it
  assignedStudent: string | null;
  stage: Stage;
  difficulty?: Difficulty; // drives `model` via retierTask when unpinned (M8)
  owns?: string[]; // file globs this issue declares it owns (#176), from `Owns:`
}

export interface TaskMap {
  tasks: Task[];
}

export function emptyTaskMap(): TaskMap {
  return { tasks: [] };
}

// A small example DAG so the screen isn't blank on first run: seed
// task -> implement -> review -> merge chain, gated by deps.
export function seedTaskMap(): TaskMap {
  return {
    tasks: [
      { id: 't1', title: 'Implement feature', model: 'sonnet', role: 'implement', priority: 5, deps: [], pinned: false, assignedStudent: null, stage: 'ready' },
      { id: 't2', title: 'Review feature', model: 'sonnet', role: 'review', priority: 5, deps: ['t1'], pinned: false, assignedStudent: null, stage: 'ready' },
      { id: 't3', title: 'Merge feature', model: 'haiku', role: 'merge', priority: 3, deps: ['t2'], pinned: false, assignedStudent: null, stage: 'ready' },
    ],
  };
}

// loadTaskMap / saveTaskMap live in taskmapIo.ts (the only fs-touching half).

function findTask(map: TaskMap, id: string): Task {
  const t = map.tasks.find((x) => x.id === id);
  if (!t) throw new Error(`No such task: ${id}`);
  return t;
}

// -- Edit ops. The dashboard calls these against the loaded map, then
// saveTaskMap()s the result — the Protector reloads the file every
// heartbeat, so edits apply live with no restart (see pool.ts / index.ts). --

export function addTask(map: TaskMap, task: Task): void {
  if (map.tasks.some((t) => t.id === task.id)) throw new Error(`Task ${task.id} already exists.`);
  map.tasks.push(task);
}

export function removeTask(map: TaskMap, id: string): void {
  findTask(map, id);
  map.tasks = map.tasks.filter((t) => t.id !== id);
  for (const t of map.tasks) t.deps = t.deps.filter((d) => d !== id);
}

export function setModel(map: TaskMap, id: string, model: Tier): void {
  findTask(map, id).model = model;
}

export function setRole(map: TaskMap, id: string, role: Role): void {
  findTask(map, id).role = role;
}

export function setPriority(map: TaskMap, id: string, priority: number): void {
  findTask(map, id).priority = priority;
}

export function setPinned(map: TaskMap, id: string, pinned: boolean): void {
  findTask(map, id).pinned = pinned;
}

// Label (or clear, via undefined) a task's difficulty — the dashboard's route
// for the M8 "heavy/simple label" the issue asks for. Doesn't retier by
// itself; callers pass the result through retierTask/retierAll to make it
// take effect on `model`.
export function setDifficulty(map: TaskMap, id: string, difficulty: Difficulty | undefined): void {
  findTask(map, id).difficulty = difficulty;
}

// "Pin a hard task to Opus" — the one-click action named in the spec: bump
// the tier to opus AND lock it so re-tiering logic leaves it alone.
export function pinToOpus(map: TaskMap, id: string): void {
  const t = findTask(map, id);
  t.model = 'opus';
  t.pinned = true;
}

export function setStage(map: TaskMap, id: string, stage: Stage): void {
  findTask(map, id).stage = stage;
}

// -- Model tiering by difficulty (M8) --

// The tier a task should run at right now: pinned tasks keep their locked
// `model` untouched; everything else is difficulty -> tier (explicit label,
// else inferred from the title) through the current Speed/Token toggle (#7).
export function tierFor(task: Task, mode: OptimizationMode): Tier {
  if (task.pinned) return task.model;
  const difficulty = task.difficulty ?? inferDifficulty(task.title);
  return tierForDifficulty(difficulty, mode);
}

// Apply tierFor to `task.model` in place — a no-op on pinned tasks. This is
// what the Protector calls to keep the map's tiers current as the toggle or
// a task's difficulty label changes.
export function retierTask(map: TaskMap, id: string, mode: OptimizationMode): void {
  const t = findTask(map, id);
  t.model = tierFor(t, mode);
}

export function retierAll(map: TaskMap, mode: OptimizationMode): void {
  for (const t of map.tasks) t.model = tierFor(t, mode);
}

// Effort for a task at its CURRENT tier, honoring the same toggle.
export function effortForTask(task: Task, mode: OptimizationMode, opts: { subagent?: boolean } = {}): Effort {
  return effortFor(task.model, mode, opts);
}

// True if `id` depends (transitively, via depId) on itself — i.e. adding the
// depId -> id edge would close a loop.
function wouldCycle(map: TaskMap, id: string, depId: string): boolean {
  const seen = new Set<string>();
  const stack = [depId];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === id) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const t = map.tasks.find((x) => x.id === cur);
    if (t) stack.push(...t.deps);
  }
  return false;
}

export function addDep(map: TaskMap, id: string, depId: string): void {
  if (id === depId) throw new Error('A task cannot depend on itself.');
  const t = findTask(map, id);
  findTask(map, depId); // throws if depId doesn't exist
  if (wouldCycle(map, id, depId)) throw new Error(`Adding dep ${depId} -> ${id} would create a cycle.`);
  if (!t.deps.includes(depId)) t.deps.push(depId);
}

export function removeDep(map: TaskMap, id: string, depId: string): void {
  const t = findTask(map, id);
  t.deps = t.deps.filter((d) => d !== depId);
}

// -- Dependency gating --

// A task is blocked until every dep has reached the 'done' stage (a missing
// dep — e.g. deleted — blocks too, rather than silently unblocking).
export function isBlocked(map: TaskMap, id: string): boolean {
  const t = findTask(map, id);
  return t.deps.some((depId) => {
    const dep = map.tasks.find((x) => x.id === depId);
    return !dep || dep.stage !== 'done';
  });
}

// Tasks the Protector may pick up next tick: at the 'ready' stage, unblocked,
// and not already claimed by a student — highest priority first.
//
// Deliberately LABEL-AGNOSTIC: a TaskMap carries no labels, so this cannot see
// `runner-error` / `spec-changed` parking, which classify() honours. The two
// therefore disagree on a parked board, and anything reporting "what will run"
// must subtract parked items itself — see isParked() in classify.ts and the
// ingest headline in live.ts (#129).
export function readyQueue(map: TaskMap): Task[] {
  return map.tasks
    .filter((t) => t.stage === 'ready' && !t.assignedStudent && !isBlocked(map, t.id))
    .sort((a, b) => b.priority - a.priority);
}

// The next task of a given tier the Protector should assign — what an
// idle-warm student of that model picks up. Respects readyQueue's priority
// order; a pinned task's tier was already fixed by pinToOpus/setModel.
export function nextForTier(map: TaskMap, tier: Tier): Task | undefined {
  return readyQueue(map).find((t) => t.model === tier);
}
