// The board as a build-order chart: open issues laid out in dependency waves.
//
// Ported from v1's Plan screen, which drew each repo's open issues as columns —
// "BUILDABLE NOW", then "AFTER WAVE 1" and so on — with an arrow per "unblocks".
// The list view answers "what is happening right now"; this answers "what is
// this board shaped like, and what is actually reachable".
//
// The layout is computed HERE rather than in the browser so the part that can be
// wrong is the part that has tests. The page only draws what it is given.
//
// One graph per repository, never a shared canvas. Issue numbers are per-repo,
// so #7 on two boards are different issues; merging them into one coordinate
// space would collapse the pair into a single node and draw dependency edges
// between unrelated work.

export type PlanStage = 'ready' | 'blocked' | 'in-pr' | 'parked';

export interface PlanItem {
  number: number;
  title: string;
  stage: PlanStage;
  /** Issue numbers this one depends on. Numbers outside the open set are dropped. */
  deps: number[];
}

export interface PlanNode extends PlanItem {
  /** How many waves deep: 0 is buildable now. */
  wave: number;
  /** Dependencies that are still open, so the drawing only has edges it can reach. */
  openDeps: number[];
  /** True when this node sits in a dependency cycle, which is a board that cannot drain. */
  inCycle: boolean;
}

export interface PlanLayout {
  /** Columns, left to right; `columns[0]` is buildable now. */
  columns: PlanNode[][];
  waves: number;
  total: number;
  buildableNow: number;
  /** Numbers in at least one cycle. A non-empty list is a deadlock a human must break. */
  cycles: number[];
}

/**
 * Wave layout over one repo's open issues.
 *
 * A node's wave is one past its deepest open dependency. A cycle has no such
 * answer, so every node in one is reported and placed in the first wave rather
 * than silently given a number: a board whose issues depend on each other in a
 * loop can never drain, and saying "buildable now" about it would be a lie the
 * chart tells confidently.
 */
export function planLayout(items: readonly PlanItem[]): PlanLayout {
  const open = new Set(items.map((i) => i.number));
  const byNum = new Map(items.map((i) => [i.number, i]));
  const openDeps = (n: number): number[] => (byNum.get(n)?.deps ?? []).filter((d) => open.has(d) && d !== n);

  const wave = new Map<number, number>();
  const cycles = new Set<number>();

  // Iterative depth-first walk: the board is small, but a cycle must be
  // detected rather than recursed into, and a deep chain must not blow the stack.
  const state = new Map<number, 'visiting' | 'done'>();
  // The nodes currently open on the walk, in order. A back edge into this path
  // names the whole loop, not just the two ends of the edge that found it.
  const path: number[] = [];
  for (const item of items) {
    if (state.get(item.number) === 'done') continue;
    const stack: number[] = [item.number];
    while (stack.length) {
      const n = stack[stack.length - 1];
      if (state.get(n) === 'done') { stack.pop(); continue; }
      if (state.get(n) === 'visiting') {
        const depths = openDeps(n).filter((d) => wave.has(d)).map((d) => wave.get(d)!);
        wave.set(n, depths.length ? Math.max(...depths) + 1 : 0);
        state.set(n, 'done');
        path.pop();
        stack.pop();
        continue;
      }
      state.set(n, 'visiting');
      path.push(n);
      for (const d of openDeps(n)) {
        if (state.get(d) === 'visiting') {
          // Everything from d to here is inside the loop.
          for (const m of path.slice(path.indexOf(d))) cycles.add(m);
          continue;
        }
        if (state.get(d) !== 'done') stack.push(d);
      }
    }
  }

  const nodes: PlanNode[] = items.map((i) => ({
    ...i,
    openDeps: openDeps(i.number),
    inCycle: cycles.has(i.number),
    // A node in a cycle has no honest depth; it is shown first and marked.
    wave: cycles.has(i.number) ? 0 : wave.get(i.number) ?? 0,
  }));

  const depth = nodes.reduce((m, n) => Math.max(m, n.wave), 0);
  const columns: PlanNode[][] = Array.from({ length: depth + 1 }, () => []);
  for (const n of [...nodes].sort((a, b) => a.number - b.number)) columns[n.wave].push(n);

  return {
    columns,
    waves: columns.filter((c) => c.length).length,
    total: nodes.length,
    // "Buildable now" is the engine's own verdict, not a position in this graph:
    // an issue with no open dependency can still be parked or already in a PR.
    buildableNow: nodes.filter((n) => n.stage === 'ready' && !n.inCycle).length,
    cycles: [...cycles].sort((a, b) => a - b),
  };
}

export const WAVE_LABEL = (i: number): string => (i === 0 ? 'BUILDABLE NOW' : `AFTER WAVE ${i}`);
