import type { QuotaSnapshot } from '@study-hall/harness/contract';
import type { DeadlockedPr, ParkedItem } from '../types.js';
import type { LadderTallies } from '../assignments.js';
import type { TestRunState } from '../testRun.js';
import type { Tier } from '../tiers.js';
import type { Role } from '../types.js';
import type { RateVerdict } from '../rateBudget.js';
import type { PaceVerdict } from '../windowPace.js';

// The engine-wide status snapshot the dashboard's Boards and Pool tabs read
// (`<stateDir>/status.json`). One file for every board — v1 filed an aggregate
// under one repo's dir and the second repo's tab read nothing. Versioned so a
// reader can name both sides on a mismatch instead of rendering garbage.

export const STATUS_SCHEMA = 'study-hall/status/v1' as const;

export interface BoardItemRef {
  number: number;
  title: string;
  target: 'issue' | 'pr';
  /** The classify kind that would run it (ready) or the reason it waits (blocked). */
  kind?: string;
  reason?: string;
}

export interface InFlightRef {
  /** Qualified action key, e.g. "REVIEW:owner/name:pr-12". */
  key: string;
  number: number;
  target: 'issue' | 'pr';
  role: Role;
  provider: string;
  harness: string;
  model: string;
  runId: string;
  startedAt: string;
  studentId: string;
}

export interface RepoStatus {
  repo: string;
  /** ISO time of the last successful fetch; absent before the first. */
  fetchedAt?: string;
  /** Set when the last fetch failed; the previous lists are kept. */
  error?: string;
  contested: boolean;
  ready: BoardItemRef[];
  blocked: BoardItemRef[];
  inFlight: InFlightRef[];
  parked: ParkedItem[];
  deadlocked: DeadlockedPr[];
  /** Attempts per item key on this board (watchdog ledger), for the parked view. */
  attempts: Record<string, number>;
}

export interface StudentStatus {
  id: string;
  provider: string;
  harness: string;
  model: string;
  tier: Tier | null;
  role: Role | null;
  state: 'busy' | 'idle-warm';
  warm: boolean;
  /** The warm base session id, if seeded/adopted. */
  baseSessionId: string | null;
  repo: string | null;
  item: number | null;
  runId: string | null;
  startedAt: string | null;
  tokens: number;
  cacheHitPct: number;
}

export interface ProviderStatus {
  inFlight: number;
  cap: number;
  quota: QuotaSnapshot | null;
  halted: string | null;
  /** The burn-rate governor's standing: null when this provider is uncapped. */
  rate: RateVerdict | null;
  /** Window pacing's standing: null when it is off for this provider. */
  pace: PaceVerdict | null;
}

export interface EngineStatus {
  schema: typeof STATUS_SCHEMA;
  updatedAt: string;
  pid: number;
  running: boolean;
  stopped: boolean;
  tick: number;
  repos: Record<string, RepoStatus>;
  students: StudentStatus[];
  providers: Record<string, ProviderStatus>;
  parallelism: { effective: number; configured: number };
  capacity?: { pausedUntil: number; reason: string };
  boundedRun: TestRunState | null;
  ladder: LadderTallies | null;
  /** What the last tick decided, for the Overview's one-line summary. */
  lastTick?: { at: string; dispatched: number; acted: number; held: number; probes: number };
}

export function emptyStatus(pid = process.pid): EngineStatus {
  return {
    schema: STATUS_SCHEMA, updatedAt: new Date(0).toISOString(), pid,
    running: false, stopped: false, tick: 0,
    repos: {}, students: [], providers: {},
    parallelism: { effective: 0, configured: 0 },
    boundedRun: null, ladder: null,
  };
}
