import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

// The Editor's durable state (ported from v1 editorState.ts): the filed-issue
// ledger that makes dedupe survive a restart, the per-pass telemetry, and the
// warm-base id a resumed run re-hits instead of paying a cold seed.

export type EditorStatus = 'CONTINUE' | 'DONE';
export type EditorStoppedBy = '' | 'guard' | 'stalled' | 'budget' | 'cancelled';

export interface FiledIssue {
  /** Idempotency key the proposing pass assigned to this change. */
  key: string;
  title: string;
  url: string;
  /** 1-based pass that filed it. */
  instance: number;
}

export interface PassRecord {
  instance: number;
  status: EditorStatus;
  chunk: number;
  /** Scope-chunk size this pass was told to use (adaptive sizing moves it). */
  maxIssuesPerChunk: number;
  inputTokens: number;
  outputTokens: number;
  /** Issues this pass actually got filed (proposals minus dupes). */
  filed: number;
  /** Proposals this pass made that were skipped as already-filed. */
  skipped: number;
  /** True if the pass dirtied the repo tree and was reverted. */
  guardrailHit: boolean;
  provider?: string;
  runId?: string;
}

export interface EditorState {
  goal: string;
  repo: string;
  /** Warm-base session id, reused across restarts so a resumed run re-hits the
   *  cached role prefix instead of paying a cold seed. */
  sessionId: string;
  provider?: string;
  harness?: string;
  startedAt: string;
  updatedAt: string;
  status: EditorStatus;
  /** Set when the run stopped for a reason other than DONE. */
  stoppedBy: EditorStoppedBy;
  instances: number;
  passes: PassRecord[];
  filed: FiledIssue[];
  guardrailHits: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  /** The handoff as of the last pass, so the dashboard needn't read two files. */
  handoff: string;
  /** True while a run is in progress (cleared on every exit path). */
  running?: boolean;
}

export function emptyState(goal: string, repo: string, sessionId: string, now: string): EditorState {
  return {
    goal, repo, sessionId, startedAt: now, updatedAt: now, status: 'CONTINUE', stoppedBy: '',
    instances: 0, passes: [], filed: [], guardrailHits: 0, totalInputTokens: 0, totalOutputTokens: 0, handoff: '',
  };
}

/** Load prior state for a resumed run, or null when there is none. A corrupt or
 *  half-written file returns null rather than throwing: losing the dedupe
 *  ledger costs duplicate issues, but crashing on start costs the whole run. */
export function loadState(path: string): EditorState | null {
  if (!existsSync(path)) return null;
  try {
    const s = JSON.parse(readFileSync(path, 'utf8')) as EditorState;
    if (!s || typeof s !== 'object' || !Array.isArray(s.filed)) return null;
    return { ...s, passes: s.passes ?? [], filed: s.filed ?? [] };
  } catch {
    return null;
  }
}

export function saveState(path: string, state: EditorState): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2));
}

/** Keys already filed, for the dedupe check. Normalized so trivial casing or
 *  whitespace differences between passes don't slip a duplicate through. */
export function filedKeys(state: EditorState): Set<string> {
  return new Set(state.filed.map((f) => normalizeKey(f.key)));
}

export function normalizeKey(key: string): string {
  return key.trim().toLowerCase().replace(/\s+/g, '-');
}
