import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { emptyTaskMap, type TaskMap } from './taskmap.js';

// The fs half of v1 taskmap.ts. The types and the DAG/edit/tiering ops stay in
// taskmap.ts, which is now import-free of node:fs so it can be used (and
// tested) anywhere a plan is manipulated in memory.

export function loadTaskMap(path: string): TaskMap {
  if (!existsSync(path)) return emptyTaskMap();
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    if (!raw || !Array.isArray(raw.tasks)) return emptyTaskMap();
    return raw as TaskMap;
  } catch {
    return emptyTaskMap();
  }
}

export function saveTaskMap(path: string, map: TaskMap): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(map, null, 2));
}
