import type {
  Approval, FailureKind, MeterKind, QuotaObservation, Sandbox, UsageFidelity,
} from '../contract.js';
import type { CostBasis } from '../pricing.js';

// The ledger's record shapes. One `RunRecord` per ROLE-RUN, `OutcomeRecord`s
// appended as outcomes arrive (a merge lands days after the run, so it is a
// second row type rather than an in-place update of the spend row), and the
// assignment ladder / engine events / quota observations as their own streams.
//
// Ported from claude-study-room's usageStore.ts. The 14 v1 field names are kept
// BYTE-IDENTICAL (ts, repo, item, role, tier, model, harness, fidelity,
// inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens,
// turns, stoppedBy) so v1's usage.jsonl rows import without a rename table, and
// `schemaVersion` distinguishes the two generations.

/** Schema generation written by this package. v1 rows carry none (treated as 1). */
export const RUN_SCHEMA_VERSION = 2 as const;

/** How a run related to a warm base. 'cold' = no base at all. */
export type WarmMechanism = 'seed' | 'adopted' | 'fork' | 'resume' | 'cold';

/** Why a run stopped early, if it did. Widened from v1's 'budget'-only. */
export type StoppedBy = 'budget' | 'idle' | 'cancelled';

export interface RunRecord {
  schemaVersion: typeof RUN_SCHEMA_VERSION;
  /** Minted at dispatch, not completion, so events and outcomes can reference it. */
  runId: string;
  /** v1 name: completion time. Always equals `endedAt`. */
  ts: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  apiDurationMs?: number | null;
  /** `owner/name` of the board the item lives on. */
  repo: string;
  /** Issue or PR number the run was working. */
  item: number;
  role: string;
  /** The provider's own tier name (`opus` on Anthropic, `sol` on OpenAI), never
   *  the shared ladder key on a non-Anthropic run. Null for side runs. */
  tier?: string | null;
  provider: string;
  harness: string;
  harnessVersion?: string | null;
  model?: string | null;
  effort?: string | null;
  meter: MeterKind;
  /** How much to trust the token fields — see UsageFidelity in contract.ts.
   *  'missing' rows are KEPT so the item stays in the $/AC denominator. */
  fidelity: UsageFidelity;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  reasoningTokens: number;
  /** Turn count is the multiplier in the quadratic cost model (turns x context),
   *  so it is the field that explains an outlier row without the transcript. */
  turns: number | null;
  sessionId?: string | null;
  seedSessionId?: string | null;
  warmMechanism: WarmMechanism;
  worktree?: string | null;
  branch?: string | null;
  baseSha?: string | null;
  promptSha256?: string | null;
  promptTemplateId?: string | null;
  toolAllowlist?: string[] | null;
  toolAllowlistEnforced?: boolean | null;
  sandbox?: Sandbox | null;
  approval?: Approval | null;
  /** Set when the student was cut short rather than finishing — a banked-partial
   *  run's spend must not be read as the cost of finished work. */
  stoppedBy: StoppedBy | null;
  exitCode?: number | null;
  errorClass?: FailureKind | null;
  /** The harness's own cost figure (Claude `total_cost_usd`): a client-side
   *  estimate on subscription lanes, never an amount charged. */
  reportedCostUsd?: number | null;
  /** Our estimate at write time, from the pricing table version stamped below. */
  estimatedCostUsd: number;
  costBasis: CostBasis;
  pricingTableVersion: string;
  transcriptPath?: string | null;
  trialId?: string | null;
  arm?: string | null;
  replicate?: number | null;
  concurrentRuns?: number | null;
  notes?: string | null;
}

export type OutcomeKind =
  | 'pr-opened' | 'merged' | 'closed-unmerged' | 'empty-diff'
  | 'review-approve' | 'review-changes'
  | 'fix-pushed' | 'resolved' | 'triaged'
  | 'failed' | 'abandoned' | 'budget-stopped' | 'idle-killed'
  | 'capacity-blocked' | 'infra-failure';

export type ReviewVerdict = 'approved' | 'changes-requested' | 'none';
export type CiConclusion = 'success' | 'failure' | 'none';

export interface OutcomeRecord {
  outcomeId: string;
  /** The run that produced this outcome, when one did. A 'merged' outcome is
   *  item-level and usually has none. */
  runId?: string | null;
  trialId?: string | null;
  repo: string;
  item: number;
  ts: string;
  outcome: OutcomeKind;
  prNumber?: number | null;
  prUrl?: string | null;
  additions?: number | null;
  deletions?: number | null;
  changedFiles?: number | null;
  reviewRounds?: number | null;
  reviewVerdict?: ReviewVerdict | null;
  ciConclusion?: CiConclusion | null;
  mergedAt?: string | null;
  detail?: string | null;
}

/** The warm-pool placement ladder. `warmReuseRate` is the KPI that says whether
 *  the pool works at all; v1 kept it in a 200-entry ring that reset every boot. */
export type AssignmentKind = 'exact' | 'rerole' | 'crossRepo' | 'spawn' | 'wait';

export interface AssignmentRecord {
  ts: string;
  repo: string;
  kind: AssignmentKind;
  tier?: string | null;
  role: string;
  provider: string;
  workerId?: string | null;
  fromRole?: string | null;
  waitReason?: string | null;
  item?: number | null;
  runId?: string | null;
}

export type EventLevel = 'debug' | 'info' | 'warn' | 'error';

/** Structured engine log line. `event` is the machine name; `action`/`reason`
 *  are the two words the dashboard shows. */
export interface EventRecord {
  ts: string;
  level: EventLevel;
  event: string;
  repo?: string | null;
  item?: number | null;
  runId?: string | null;
  action?: string | null;
  reason?: string | null;
  data?: Record<string, unknown> | null;
}

/** A QuotaObservation with a ledger timestamp (ISO of `observedAt` unless given). */
export interface QuotaRecord extends QuotaObservation {
  ts: string;
}
