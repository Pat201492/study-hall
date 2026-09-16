import { randomUUID } from 'node:crypto';
import type { Usage, UsageFidelity } from '../contract.js';
import { estimateCost, PRICING_TABLE_VERSION } from '../pricing.js';
import type { MeterKind } from '../contract.js';
import { RUN_SCHEMA_VERSION, type RunRecord } from './types.js';

// A run row for spend that is NOT a board role-run: a planner chat turn, a
// preflight completion probe, a judge call.
//
// These burn real tokens against the same account window as the students do.
// Leaving them unbanked made two things wrong at once: the hourly burn governor
// under-counted, and nothing could relate the vendor's utilization percentage to
// a token quantity, because the percentage moved while the ledger showed no
// spend to explain it (study-hall #21).
//
// They are ordinary `runs` rows so every existing reader — the burn window, the
// Runs tab, the window-capacity estimator — sees them without a special case.
// `item: 0` and a role outside the board's set is what marks them, so a
// `$/merged AC` query filters them out by role rather than having to know about
// a second table.

export interface SideRunInput {
  role: string;
  provider: string;
  harness: string;
  usage: Usage;
  startedAt: number;
  endedAt: number;
  meter: MeterKind;
  fidelity?: UsageFidelity;
  model?: string | null;
  effort?: string | null;
  /** The board being planned, where there is one. Never a number: these rows carry `item: 0`. */
  repo?: string;
  sessionId?: string | null;
  turns?: number | null;
  reportedCostUsd?: number | null;
  notes?: string | null;
}

/** Roles that are spend but not board work. Readers filter `$/AC` on these. */
export const SIDE_ROLES = ['planner', 'preflight', 'judge'] as const;

export function isSideRole(role: string): boolean {
  return (SIDE_ROLES as readonly string[]).includes(role);
}

export function sideRun(input: SideRunInput): RunRecord {
  const cost = estimateCost(input.provider, input.model, input.usage);
  return {
    schemaVersion: RUN_SCHEMA_VERSION,
    runId: randomUUID(),
    ts: new Date(input.endedAt).toISOString(),
    startedAt: new Date(input.startedAt).toISOString(),
    endedAt: new Date(input.endedAt).toISOString(),
    durationMs: Math.max(0, input.endedAt - input.startedAt),
    repo: input.repo ?? '-',
    item: 0,
    role: input.role,
    tier: null,
    provider: input.provider,
    harness: input.harness,
    model: input.model ?? null,
    effort: input.effort ?? null,
    meter: input.meter,
    fidelity: input.fidelity ?? 'exact',
    inputTokens: input.usage.inputTokens,
    outputTokens: input.usage.outputTokens,
    cacheReadInputTokens: input.usage.cacheReadInputTokens,
    cacheCreationInputTokens: input.usage.cacheCreationInputTokens,
    reasoningTokens: input.usage.reasoningTokens,
    turns: input.turns ?? 1,
    sessionId: input.sessionId ?? null,
    // Not a student: no worktree, no branch, nothing warm to attribute.
    warmMechanism: 'cold',
    stoppedBy: null,
    reportedCostUsd: input.reportedCostUsd ?? null,
    estimatedCostUsd: cost.usd,
    costBasis: cost.basis,
    pricingTableVersion: PRICING_TABLE_VERSION,
    notes: input.notes ?? null,
  };
}
