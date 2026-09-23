// The harness contract: what a coding-agent CLI adapter must provide, and what a
// caller may ask of it. Ported from claude-study-room's src/harness.ts (#298/#304/#307)
// and widened for a second provider.
//
// WHY THIS IS NOT A LOWEST-COMMON-DENOMINATOR INTERFACE
//
// Study Room's entire efficiency result lives in flags a generic orchestrator
// interface would erase: `--session-id` seeds a warm base and `--resume
// --fork-session` forks each task off it. Capping students so a session split
// paid repo ramp-up twice moved cost from 9.5M to 20.5M tokens per merged PR. So
// capabilities are DECLARED and inspectable; a caller adapts visibly and never
// emits a flag into the dark. A harness unsure of a capability declares `false`:
// under-claiming costs a slower run, over-claiming corrupts the arena's numbers.
//
// CONVENTIONS
//  - Every timestamp in this package is epoch MILLISECONDS. Providers report
//    resets in epoch seconds; adapters convert at the boundary.
//  - Usage always carries five fields. Harnesses without a cache split or without
//    a reasoning bucket report 0 there and the fidelity derivation says so.

import type { StdioOptions } from 'node:child_process';

export type MeterKind = 'subscription' | 'metered' | 'local' | 'unknown';
export type AutomationStance = 'sanctioned' | 'gray' | 'prohibited';
export type CredentialKind = 'oauth_subscription' | 'api_key' | 'none';

/** One rate-limit window as a provider reports it. `utilization` is a fraction
 *  (usually 0..1; above 1 when usage legitimately runs past a cap). */
export interface QuotaWindow {
  utilization: number;
  /** Epoch ms when the window resets. */
  resetsAt: number;
}

export interface QuotaObservation {
  provider: string;
  /** Epoch ms when the observation was made. */
  observedAt: number;
  source: 'stream' | 'app-server' | 'probe' | 'error' | 'manual';
  fiveHour?: QuotaWindow;
  sevenDay?: QuotaWindow;
  /** Provider-specific extra windows (e.g. per-model weekly buckets), by name. */
  extra?: Record<string, QuotaWindow>;
  /** Whether ordinary usage is currently allowed. `null`/undefined = unknown —
   *  never infer recovery from percentages or reset times (Codex schema rule). */
  allowed?: boolean | null;
  /** Which window is the limiting one when `allowed === false`. */
  limitingWindow?: string;
  detail?: string;
}

export type QuotaState = 'available' | 'exhausted' | 'unknown';

export interface QuotaSnapshot {
  provider: string;
  state: QuotaState;
  observation?: QuotaObservation;
  /** Epoch ms until which the provider is held exhausted. */
  exhaustedUntil?: number;
  /** Age of the newest observation in ms, if any. */
  ageMs?: number;
}

/** Per-provider quota state machine. Fed by adapters (stream events), by a
 *  provider-native reader (Codex app-server), or by a failure verdict. */
export interface QuotaMonitor {
  readonly provider: string;
  snapshot(now?: number): QuotaSnapshot;
  observe(observation: QuotaObservation): void;
  /** A run failed with a capacity verdict: hold exhausted until `resetAt` (ms). */
  markExhausted(resetAt?: number, detail?: string): void;
  subscribe(fn: (snapshot: QuotaSnapshot) => void): () => void;
  /**
   * Restore the newest stored reading at boot, for display only.
   *
   * Optional: a monitor that fetches its own state on start (the Codex
   * app-server) has no use for it. It must never create a hold and never
   * notify subscribers, or an old exhaustion would be re-applied and the
   * reading re-banked.
   */
  seed?(observation: QuotaObservation): void;
  /** Optional lifecycle for monitors that own a process (Codex app-server). */
  start?(): Promise<void>;
  stop?(): void;
}

/** Provider = auth + quota + policy stance. A harness runs ON a provider. */
export interface Provider {
  id: string;
  label: string;
  credentialKind: CredentialKind;
  /** `prohibited` pairs are refused at registration, not warned about: both
   *  Anthropic and Google enforce server-side and suspend accounts. */
  automationStance: AutomationStance;
  meter: MeterKind;
  /** Concurrent students this provider tolerates (Codex: ~2-3 before 429s). */
  concurrencyCap?: number;
  quota?: QuotaMonitor;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  /** Billed reasoning output where the provider reports it separately (Codex,
   *  OpenCode). Claude Code folds thinking into outputTokens and reports 0 here. */
  reasoningTokens: number;
}

export const ZERO_USAGE: Readonly<Usage> = Object.freeze({
  inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, reasoningTokens: 0,
});

/**
 * In-session context compaction: `'auto'` for the CLI's own window, or an
 * explicit token window at which the conversation is compacted in place.
 *
 * NOT a budget cap, and the difference is the whole reason this is safe to try.
 * A cap STOPS a run; the work resumes in a fresh session that re-reads the repo
 * from cold, which is what moved cost from 9.5M to 20.5M tokens per merged PR.
 * Compaction summarises the trajectory INSIDE one live session — no second
 * session, no second repo ramp-up — so it reduces input tokens without buying
 * back the split-session penalty. That is the claim; `study-arena` decides
 * whether it holds on this board, which is why this ships off by default.
 */
export type AutoCompact = 'auto' | number;

/** The window bounds the Claude CLI accepts for `--autocompact`. */
export const AUTO_COMPACT_MIN_TOKENS = 100_000;
export const AUTO_COMPACT_MAX_TOKENS = 1_000_000;

/**
 * The flag value for a requested window, or null when it is unusable.
 *
 * Null rather than a clamp: a window outside the CLI's range is a config
 * mistake, and silently compacting at a window nobody chose would corrupt the
 * arena's numbers with a setting the prereg never named.
 */
export function autoCompactValue(v: AutoCompact | undefined): string | null {
  if (v === undefined) return null;
  if (v === 'auto') return 'auto';
  if (!Number.isFinite(v) || !Number.isInteger(v)) return null;
  if (v < AUTO_COMPACT_MIN_TOKENS || v > AUTO_COMPACT_MAX_TOKENS) return null;
  return String(v);
}

/** A ceiling on what one run may spend before it is stopped and its partial work
 *  banked. Both limits are OFF when 0/undefined; whichever trips first wins. */
export interface StudentBudget {
  maxTurns?: number;
  /** Cumulative billed tokens (fresh input + cache read + cache write). */
  maxTokens?: number;
}

export type Sandbox = 'none' | 'read-only' | 'workspace-write';
export type Approval = 'never' | 'on-request';
export type ChatTransport = 'stream-json' | 'jsonrpc' | 'resume-loop' | 'none';

export interface HarnessCapabilities {
  /** Can keep a warm base across tasks and run later tasks off it. */
  warmSessions: boolean;
  /** The CALLER may name the base id up front (Claude Code `--session-id`).
   *  False = adopt-only: the id arrives in the first run's output (Codex, OpenCode). */
  seedableSessions: boolean;
  /** Fork-off-base is available as the per-task wipe. A harness that can only
   *  resume accumulates scratch into the base. */
  forkSessions: boolean;
  /** Reports cache-read and cache-write as separate figures. Drives fidelity. */
  cacheUsageSplit: boolean;
  /** Usage figures are cumulative thread totals rather than per-run deltas
   *  (Codex `turn.completed.usage`). The adapter MUST diff against a baseline. */
  usageIsCumulative: boolean;
  /** Emits its own cost figure (Claude `total_cost_usd`, OpenCode `cost`). */
  reportsCost: boolean;
  /** Accepts a per-run built-in tool allowlist (Claude `--tools`). */
  toolAllowlist: boolean;
  /** Accepts a per-MCP-server tool allowlist (Codex config, Claude `--tools mcp__*`). */
  mcpToolAllowlist: boolean;
  /** Accepts a reasoning-effort setting. */
  effortControl: boolean;
  sandboxModes: Sandbox[];
  promptTransport: 'stdin' | 'argv';
  /** Emits mid-run usage so budgets can be enforced by the generic guard. */
  streamsUsage: boolean;
  /** Honours an AbortSignal per run. */
  cancellable: boolean;
  /** Can hand back a per-run transcript path or stream events to a sink. */
  transcripts: boolean;
  /** Can be stopped on a turn/token budget with partial work banked. Always true
   *  when `streamsUsage` is true, because the generic guard enforces it. */
  budgetStop: boolean;
  /** Accepts an in-session context-compaction setting (Claude `--autocompact`).
   *
   *  This is the only trajectory-reduction seam a CLI-backed harness has. The
   *  agent's conversation lives inside the CLI process, so an orchestrator
   *  cannot prune it from outside the way AgentDiet-style trajectory reduction
   *  assumes; it can only ask the CLI to compact at a chosen window. A harness
   *  without such a flag declares `false` and runs on its own default.
   */
  contextCompaction: boolean;
  /** Interactive planner transport this harness offers. */
  chat: ChatTransport;
}

/** How a run relates to a warm base. `mode` is structural for Codex, which
 *  expresses resume/fork as SUBCOMMANDS rather than flags. */
export interface SessionSpec {
  mode: 'new' | 'resume' | 'fork';
  /** For `new` on a seedable harness: the id to seed. */
  seed?: string;
  /** For `resume`/`fork`: the base id (seeded or adopted). */
  base?: string;
}

export interface HarnessRunOptions {
  /** The task's git worktree — the CLI runs and edits files here. */
  cwd: string;
  model?: string;
  /** Free-form: model-advertised values (Claude low..max, Codex per catalog). */
  effort?: string;
  approval?: Approval;
  sandbox?: Sandbox;
  /** Built-in tool allowlist. Empty/omitted leaves the CLI default surface. */
  tools?: string[];
  session?: SessionSpec;
  budget?: StudentBudget;
  /** In-session context compaction. Ignored by a harness whose capabilities
   *  report `contextCompaction: false`, never emitted blind. */
  autoCompact?: AutoCompact;
  /** Consecutive silent minutes before the run is killed as stalled. 0 disables.
   *  Defaults to DEFAULT_IDLE_TICKS. */
  idleTicks?: number;
  signal?: AbortSignal;
  /** Receives every raw stdout line (NDJSON) as it arrives; the caller owns the file. */
  transcriptSink?: (line: string) => void;
  onUsage?: (usage: Usage) => void;
  onQuota?: (observation: QuotaObservation) => void;
  onBudgetStop?: (info: { turns: number; tokens: number; limit: keyof StudentBudget }) => void;
  onIdleKill?: (info: { ticks: number; lastText: string }) => void;
  /** Extra environment for the child (merged over process.env). */
  env?: Record<string, string>;
  /** Per-harness escape hatch (Codex `-c` overrides, CODEX_HOME, thread source…). */
  extra?: Record<string, unknown>;
  /** Test seams — every adapter test fakes the child process through these. */
  spawnFn?: SpawnLike;
  setIntervalFn?: (fn: () => void, ms: number) => NodeJS.Timeout;
}

/** The subset of node:child_process.spawn adapters use, so tests can fake it. */
export type SpawnLike = (
  bin: string,
  args: string[],
  opts: { cwd?: string; shell?: boolean; windowsHide?: boolean; env?: NodeJS.ProcessEnv; stdio?: StdioOptions },
) => ChildLike;

export interface ChildLike {
  pid?: number;
  stdin?: { write(s: string): unknown; end(): unknown } | null;
  stdout?: { on(ev: 'data', fn: (b: Buffer | string) => void): unknown } | null;
  stderr?: { on(ev: 'data', fn: (b: Buffer | string) => void): unknown } | null;
  on(ev: 'close', fn: (code: number | null) => void): unknown;
  on(ev: 'error', fn: (e: Error) => void): unknown;
  on(ev: string, fn: (...a: unknown[]) => void): unknown;
  kill?(signal?: NodeJS.Signals | number): unknown;
}

export interface HarnessRunResult {
  text: string;
  usage: Usage;
  /** The session/thread id this run produced or ran under ('' if unknown). */
  sessionId: string;
  /** Assistant turns observed on the run. */
  turns: number;
  /** Set when the run was cut short on purpose and its partial work banked: a
   *  budget trip or a caller cancel both RESOLVE (the edits are in the worktree
   *  and the caller's success path pushes them). An idle kill REJECTS — there is
   *  nothing to bank from a student that said nothing for twenty minutes. */
  stoppedBy?: 'budget' | 'cancelled';
  transcriptPath?: string;
  /** The harness's own cost figure when `reportsCost`; null otherwise. A client-
   *  side estimate on subscription lanes — never present it as an amount charged. */
  costUsd?: number | null;
  meter: MeterKind;
  durationMs: number;
  apiDurationMs?: number;
  exitCode: number | null;
  /** The model the harness reports it actually used, when it says. */
  model?: string;
  /** The terminal result event, unmangled, for the ledger's `raw` column. */
  raw?: unknown;
}

export type FailureKind = 'capacity' | 'infra' | 'auth' | 'task' | 'cancelled';

export interface FailureVerdict {
  kind: FailureKind;
  /** Epoch ms when a `capacity` failure is expected to clear, if the provider said. */
  resetAt?: number;
  detail?: string;
}

export interface PreflightResult {
  ok: boolean;
  /** Absent when resolution itself failed (nothing spawnable was found). */
  bin?: string;
  version?: string;
  /** True only when a trivial real completion succeeded — `--version` passes with
   *  an expired login, which is exactly the failure this exists to catch. */
  authOk?: boolean;
  detail?: string;
  /**
   * What the probe completion cost, where the adapter can report it.
   *
   * A probe is a real completion against the account's window, so leaving it
   * unbanked let the window move with no spend to explain it (#21). Absent on
   * adapters that cannot report it; absent is not zero.
   */
  usage?: Usage;
}

/** Normalised interactive-session events: the planner UI never branches on provider. */
export type ChatEvent =
  | { type: 'status'; message: string }
  | { type: 'text'; text: string; partial?: boolean }
  | { type: 'tool_call'; id?: string; name: string; input: unknown }
  | { type: 'tool_result'; id?: string; name?: string; output: unknown; isError?: boolean }
  | { type: 'usage'; usage: Usage; costUsd?: number | null }
  | { type: 'quota'; observation: QuotaObservation }
  | { type: 'turn_done'; usage?: Usage; costUsd?: number | null; sessionId?: string }
  | { type: 'error'; message: string; verdict?: FailureVerdict }
  | { type: 'closed'; exitCode: number | null };

export interface ChatOptions {
  /** Fixed for the life of the conversation — the prompt cache is per directory. */
  cwd: string;
  model?: string;
  effort?: string;
  tools?: string[];
  /** Appended to the harness's default system prompt (the planner role). */
  systemPrompt?: string;
  /** MCP server config the harness should connect to (path or inline JSON). */
  mcpConfig?: string;
  /** Resume an existing conversation by id. */
  resume?: string;
  /** Seed id for a brand-new conversation on a seedable harness. */
  sessionId?: string;
  transcriptSink?: (line: string) => void;
  env?: Record<string, string>;
  extra?: Record<string, unknown>;
  spawnFn?: SpawnLike;
}

export interface ChatSession {
  readonly harness: string;
  /** Known after the first turn on adopt-only harnesses. */
  readonly sessionId: string | null;
  send(text: string): Promise<void>;
  interrupt(): Promise<void>;
  close(): Promise<void>;
  on(fn: (e: ChatEvent) => void): () => void;
}

export interface Harness {
  /** Stable id, as written in config and recorded on every ledger row. */
  readonly id: string;
  /** The provider this harness runs on. */
  readonly provider: string;
  readonly capabilities: HarnessCapabilities;
  run(prompt: string, opts: HarnessRunOptions): Promise<HarnessRunResult>;
  /** Tree-kill every in-flight process this harness owns. */
  killAll(): void;
  /** Replaces v1's isCapacityError + isInfraFailure + parseCapacityReset: the
   *  provider's own wording never leaks upstream. */
  classifyFailure(message: string, now?: number): FailureVerdict;
  /** Resolves the binary and proves it can do WORK (a trivial completion). */
  preflight(opts?: { spawnFn?: SpawnLike; cwd?: string }): Promise<PreflightResult>;
  /** Interactive transport for the planner; present iff `capabilities.chat !== 'none'`. */
  chat?(opts: ChatOptions): ChatSession;
}

export type UsageFidelity = 'exact' | 'partial' | 'missing';

/** Minutes of silence per idle tick; ticks are counted, not wall-clock, so a
 *  suspended machine cannot accrue idleness and wake to a massacre. */
export const IDLE_TICK_MS = 60_000;
/** Consecutive silent ticks before a run is killed as stalled (p99.9 real gap 3.6 min). */
export const DEFAULT_IDLE_TICKS = 20;
