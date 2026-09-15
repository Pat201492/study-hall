import { spawn } from 'node:child_process';
import type {
  ChatOptions, ChatSession, ChildLike, FailureVerdict, Harness, HarnessCapabilities,
  HarnessRunOptions, HarnessRunResult, MeterKind, PreflightResult, QuotaMonitor,
  QuotaObservation, QuotaWindow, SpawnLike, Usage,
} from '../contract.js';
import { attachGuards } from '../guards.js';
import { NdjsonFramer, num } from '../ndjson.js';
import { ChildRegistry, resolveBin as defaultResolveBin, type ResolvedBin } from '../proc.js';
import { parseCapacityReset } from './claudeReset.js';
import { createClaudeChat } from './claudeChat.js';

// The Claude Code adapter. Ported from claude-study-room's src/cliStudent.ts
// (runCliTask) + src/claudeCodeHarness.ts + src/infraFailure.ts, re-cut onto
// the v2 contract. A student does work by spawning the local Claude Code CLI
// (`claude -p --output-format stream-json`) so it rides the CLI's login
// (Pro/Max subscription) instead of a metered ANTHROPIC_API_KEY. NO
// @anthropic-ai/sdk dependency: students on this path never touch the metered
// API, and never `--bare` — its own help text confirms OAuth is not read under
// it, which takes the pool off the subscription this engine exists to ride.
//
// Module graph note: this file imports createClaudeChat from ./claudeChat.js,
// and claudeChat.ts imports the pure helpers (parseClaudeResult,
// quotaFromRateLimitEvent, classifyClaudeFailure) from here. That is a two-
// module ESM cycle and it is benign: every cross-reference is a hoisted
// function declaration used only inside a method body, never at module
// evaluation — so no import order can observe an uninitialised binding.

/**
 * What the Claude Code CLI can do, each field earned by something verified in
 * the spikes (docs/adr/ADR-000-phase0-spikes.md) rather than assumed:
 *
 *   warmSessions/seedableSessions/forkSessions
 *                   --session-id seeds a base the CALLER names, --resume
 *                   --fork-session forks a throwaway run off it (warmSlot.ts).
 *                   The engine's core cost lever: capping students so a session
 *                   split paid repo ramp-up twice moved 9.5M -> 20.5M tokens per
 *                   merged PR. Knowing the id before the first run completes is
 *                   what makes a slot recoverable after a crash.
 *   cacheUsageSplit the result reports cache_read/cache_creation separately,
 *                   which is what lets pricing charge them at 0.1x / 1.25x.
 *   usageIsCumulative false — every run reports its own totals.
 *   reportsCost     result.total_cost_usd (list-price estimate on a
 *                   subscription; never an amount charged).
 *   toolAllowlist   --tools, measured at -11,382 tokens/turn against the default
 *                   surface. mcpToolAllowlist via `--tools mcp__*` patterns.
 *   effortControl   --effort low|medium|high|xhigh|max.
 *   sandboxModes    ['none']: `-p` has no per-run sandbox flag.
 *   streamsUsage    per-message usage on the stream, so the generic guard can
 *                   enforce a budget mid-run; budgetStop follows from it.
 *   cancellable     AbortSignal -> tree-kill.
 *   transcripts     every raw NDJSON line goes to opts.transcriptSink.
 *   chat            one long-lived `--input-format stream-json` process (spike
 *                   (a): stays alive after the first result, answers a second
 *                   stdin message in 1.1 s).
 */
export const CLAUDE_CODE_CAPABILITIES: HarnessCapabilities = Object.freeze({
  warmSessions: true,
  seedableSessions: true,
  forkSessions: true,
  cacheUsageSplit: true,
  usageIsCumulative: false,
  reportsCost: true,
  toolAllowlist: true,
  mcpToolAllowlist: true,
  effortControl: true,
  sandboxModes: ['none'],
  promptTransport: 'stdin',
  streamsUsage: true,
  cancellable: true,
  transcripts: true,
  budgetStop: true,
  chat: 'stream-json',
}) as HarnessCapabilities;

export type ClaudeArgOptions = Pick<HarnessRunOptions, 'model' | 'effort' | 'approval' | 'tools' | 'session'>;

/**
 * The argv for one `claude -p` run. Prompt-independent: the prompt goes over
 * stdin, so nothing dynamic is ever an argument.
 *
 * stream-json emits one JSON event per line instead of a single blob at the
 * end. The FINAL `type:"result"` event carries the same fields the plain json
 * format returns, so the terminal contract is unchanged — what it adds is
 * per-message usage while the task is still running, which is the only way to
 * see a runaway student before it finishes. `-p` requires --verbose to stream.
 *
 * `--tools` takes a space-separated list, so each name is its own argv entry.
 * Omitted entirely when the list is empty, which leaves the CLI default (every
 * tool) rather than a student with no tools at all — an empty knob must not be
 * able to produce a student that cannot act.
 *
 * Warm-session flags: --session-id seeds a stable base; --resume reuses it;
 * --fork-session (with --resume) forks a throwaway run off the warm base.
 */
export function claudeArgs(opts: ClaudeArgOptions): string[] {
  // bypassPermissions is required for tasks that run git/file ops unattended.
  const perm = (opts.approval ?? 'never') === 'never'
    ? ['--dangerously-skip-permissions']
    : ['--permission-mode', 'acceptEdits'];
  const toolList = opts.tools && opts.tools.length ? ['--tools', ...opts.tools] : [];
  const s = opts.session;
  const session = !s ? []
    : s.mode === 'new' ? (s.seed ? ['--session-id', s.seed] : [])
      : s.mode === 'resume' ? (s.base ? ['--resume', s.base] : [])
        : (s.base ? ['--resume', s.base, '--fork-session'] : []);
  return [
    '-p', '--output-format', 'stream-json', '--verbose',
    ...perm,
    ...(opts.model ? ['--model', opts.model] : []),
    ...(opts.effort ? ['--effort', opts.effort] : []),
    ...toolList,
    ...session,
  ];
}

// ---- pure event helpers ------------------------------------------------------

/** One assistant message's usage, keyed by message id (see LiveUsage). */
interface MessageUsage { out: number; in: number; cRead: number; cCreate: number }

/**
 * Live usage, keyed by message id.
 *
 * The stream emits SEVERAL events per assistant message (a thinking block,
 * then text; parallel tool calls share an id), each repeating that message's
 * usage — so summing every event double-counts. Keeping the latest figure per
 * message id and summing across distinct ids is the only accumulation that
 * survives that.
 *
 * What each field is actually worth live, measured against a real run:
 *  - input / cache_read / cache_creation are known when the message starts
 *    and matched the final totals exactly. These are trustworthy live, which
 *    means cache-hit % is accurate mid-task.
 *  - output_tokens is reported at message start (1) and only settles at the
 *    end (56 in the same run), so live output UNDERCOUNTS. It is a floor, not
 *    a total — useful to see movement, not to bill against.
 * The result event overwrites all of it with the authoritative totals.
 */
export class LiveUsage {
  private readonly perMessage = new Map<string, MessageUsage>();

  /** Record one event's usage. Returns false when the event carried none. */
  note(evt: Record<string, unknown>): boolean {
    const msg = evt.message as Record<string, unknown> | undefined;
    const u = msg?.usage as Record<string, unknown> | undefined;
    if (!u || typeof u !== 'object') return false;
    const id = typeof msg?.id === 'string' ? msg.id : `anon-${this.perMessage.size}`;
    this.perMessage.set(id, {
      out: num(u.output_tokens),
      in: num(u.input_tokens),
      cRead: num(u.cache_read_input_tokens),
      cCreate: num(u.cache_creation_input_tokens),
    });
    return true;
  }

  /** Distinct assistant messages seen — what the engine counts as a turn. */
  get turns(): number { return this.perMessage.size; }

  /** Cumulative tokens the run has been billed for: fresh input + cache read +
   *  cache write, summed across distinct messages. */
  get billedTokens(): number {
    let total = 0;
    for (const m of this.perMessage.values()) total += m.in + m.cRead + m.cCreate;
    return total;
  }

  /** Output summed across messages (additive); input/cache from the newest
   *  message (the current context — summing would double-count it). */
  get usage(): Usage {
    let out = 0;
    let last: MessageUsage = { out: 0, in: 0, cRead: 0, cCreate: 0 };
    for (const m of this.perMessage.values()) { out += m.out; last = m; }
    return {
      inputTokens: last.in, outputTokens: out,
      cacheReadInputTokens: last.cRead, cacheCreationInputTokens: last.cCreate,
      reasoningTokens: 0,
    };
  }
}

/** The newest non-empty text block on a message event, or '' — when the CLI
 *  refuses a run it says so here and then may never produce a terminal result,
 *  so this is the only record of WHY a stalled student stalled. */
export function assistantText(evt: Record<string, unknown>): string {
  const msg = evt.message as Record<string, unknown> | undefined;
  const content = msg?.content;
  let text = '';
  if (Array.isArray(content)) {
    for (const c of content) {
      const block = c as { type?: string; text?: string };
      if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) text = block.text.trim();
    }
  }
  return text;
}

/** modelUsage entry -> Usage (camelCase; subagent-inclusive). */
function sumModelUsage(modelUsage: unknown): Usage | null {
  if (!modelUsage || typeof modelUsage !== 'object') return null;
  const entries = Object.values(modelUsage as Record<string, unknown>);
  if (entries.length === 0) return null;
  const total: Usage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, reasoningTokens: 0 };
  for (const e of entries) {
    const m = (e ?? {}) as Record<string, unknown>;
    total.inputTokens += num(m.inputTokens);
    total.outputTokens += num(m.outputTokens);
    total.cacheReadInputTokens += num(m.cacheReadInputTokens);
    total.cacheCreationInputTokens += num(m.cacheCreationInputTokens);
  }
  return total;
}

/** The legacy `usage` block (snake_case; main loop only — undercounts as soon
 *  as a subagent runs, which is why modelUsage is preferred). */
function parseLegacyUsage(usage: unknown): Usage {
  const u = (usage && typeof usage === 'object' ? usage : {}) as Record<string, unknown>;
  return {
    inputTokens: num(u.input_tokens),
    outputTokens: num(u.output_tokens),
    cacheReadInputTokens: num(u.cache_read_input_tokens),
    cacheCreationInputTokens: num(u.cache_creation_input_tokens),
    reasoningTokens: 0,
  };
}

export interface ParsedClaudeResult {
  text: string;
  usage: Usage;
  sessionId: string;
  turns: number;
  costUsd: number | null;
  durationMs: number;
  apiDurationMs?: number;
  isError: boolean;
  subtype: string;
  /** HTTP status the CLI attributes the failure to (429/529/401…), when it says. */
  apiErrorStatus?: number;
  /** The single model the result names, when modelUsage lists exactly one. */
  model?: string;
  raw: Record<string, unknown>;
}

/**
 * Read the terminal `result` event (or the legacy single-blob JSON). Pure.
 *
 * Usage prefers `modelUsage` summed across models: it is subagent-inclusive,
 * whereas `usage` covers only the top-level loop and silently undercounts as
 * soon as nesting occurs (official cost-tracking docs). Claude bills thinking
 * as output, so reasoningTokens is 0; `thinkingTokens` stays in `raw`.
 * `turns` prefers the CLI's own `num_turns`, falling back to the distinct
 * message ids counted live. Error results carry `errors: string[]` and no
 * `result` field, so the text of an error is the errors joined.
 */
export function parseClaudeResult(evt: Record<string, unknown>, fallback: { turns?: number } = {}): ParsedClaudeResult {
  const isError = evt.is_error === true;
  const errors = Array.isArray(evt.errors) ? evt.errors.filter((e): e is string => typeof e === 'string') : [];
  const text = typeof evt.result === 'string' ? evt.result : errors.join('; ');
  const modelUsage = evt.modelUsage && typeof evt.modelUsage === 'object' ? evt.modelUsage as Record<string, unknown> : undefined;
  const modelKeys = modelUsage ? Object.keys(modelUsage) : [];
  return {
    text,
    usage: sumModelUsage(modelUsage) ?? parseLegacyUsage(evt.usage),
    sessionId: typeof evt.session_id === 'string' ? evt.session_id : '',
    turns: typeof evt.num_turns === 'number' && Number.isFinite(evt.num_turns) ? evt.num_turns : (fallback.turns ?? 0),
    costUsd: typeof evt.total_cost_usd === 'number' && Number.isFinite(evt.total_cost_usd) ? evt.total_cost_usd : null,
    durationMs: num(evt.duration_ms),
    apiDurationMs: typeof evt.duration_api_ms === 'number' ? evt.duration_api_ms : undefined,
    isError,
    subtype: typeof evt.subtype === 'string' ? evt.subtype : (isError ? 'error' : 'success'),
    apiErrorStatus: typeof evt.api_error_status === 'number' ? evt.api_error_status : undefined,
    model: modelKeys.length === 1 ? modelKeys[0] : undefined,
    raw: evt,
  };
}

function toWindow(v: unknown): QuotaWindow | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const w = v as Record<string, unknown>;
  if (typeof w.utilization !== 'number' || typeof w.resetsAt !== 'number') return undefined;
  // Providers report resets in epoch SECONDS; the contract is epoch ms.
  return { utilization: w.utilization, resetsAt: w.resetsAt * 1000 };
}

export interface RateLimitReading {
  observation: QuotaObservation;
  /** Epoch ms the limiting window clears, when the event says. */
  resetsAt?: number;
}

/**
 * `rate_limit_event` -> QuotaObservation. Claude Code >= 2.1.268 emits
 * `rate_limit_info.unifiedWindows.{five_hour,seven_day}.{utilization,resetsAt}`
 * on the headless stream (spike (b): populated on the first API response for
 * this account). Older builds carry only ONE representative window
 * (`rateLimitType` + `resetsAt` + optional `utilization`); that shape is folded
 * in as a fallback so the display never reads a missing window as 0%.
 */
export function quotaFromRateLimitEvent(evt: Record<string, unknown>, observedAt: number): RateLimitReading | null {
  const info = evt.rate_limit_info;
  if (!info || typeof info !== 'object') return null;
  const i = info as Record<string, unknown>;
  const windows = (i.unifiedWindows && typeof i.unifiedWindows === 'object' ? i.unifiedWindows : {}) as Record<string, unknown>;
  const status = typeof i.status === 'string' ? i.status : undefined;
  const type = typeof i.rateLimitType === 'string' ? i.rateLimitType : undefined;
  const topReset = typeof i.resetsAt === 'number' ? i.resetsAt * 1000 : undefined;

  let fiveHour = toWindow(windows.five_hour);
  let sevenDay = toWindow(windows.seven_day);
  const extra: Record<string, QuotaWindow> = {};
  for (const [k, v] of Object.entries(windows)) {
    if (k === 'five_hour' || k === 'seven_day') continue;
    const w = toWindow(v);
    if (w) extra[k] = w;
  }
  // Legacy single-window shape.
  if (!fiveHour && !sevenDay && Object.keys(extra).length === 0
      && typeof i.utilization === 'number' && topReset !== undefined && type) {
    const w = { utilization: i.utilization, resetsAt: topReset };
    if (type === 'five_hour') fiveHour = w;
    else if (type === 'seven_day') sevenDay = w;
    else extra[type] = w;
  }

  const limiting = type === 'five_hour' ? fiveHour : type === 'seven_day' ? sevenDay : type ? extra[type] : undefined;
  const resetsAt = topReset ?? limiting?.resetsAt ?? fiveHour?.resetsAt ?? sevenDay?.resetsAt;
  const detail = [
    status ? `status=${status}` : null,
    type ? `window=${type}` : null,
    resetsAt !== undefined ? `resetsAt=${new Date(resetsAt).toISOString()}` : null,
  ].filter(Boolean).join(' ');

  const observation: QuotaObservation = {
    provider: 'anthropic',
    observedAt,
    source: 'stream',
    fiveHour,
    sevenDay,
    extra: Object.keys(extra).length ? extra : undefined,
    // An event with no status says nothing about recovery; never infer it.
    allowed: status === undefined ? null : status !== 'rejected',
    limitingWindow: type,
    detail: detail || undefined,
  };
  return { observation, resetsAt };
}

// ---- failure classification ---------------------------------------------------

// Is this failure the ENVIRONMENT being unavailable rather than the task being
// bad? The distinction is load-bearing. A plan session limit, a rate limit, or
// an expired login makes EVERY student fail identically — and a watchdog that
// only sees "worked, didn't progress" reads that as a board full of unfixable
// items. On 2026-08-05 a session limit did exactly that: four healthy items
// were permanently quarantined, two real PRs were labelled `runner-error`, and
// four spurious reports were filed, for an outage that cleared itself two hours
// later.
//
// Matched on the CLI's own words. Deliberately broad — a false positive costs a
// retry, a false negative costs a wrongly-condemned PR. Limit messages from
// the binary: "You've hit your session limit" (five_hour), "weekly limit"
// (seven_day), "Opus limit" / "Sonnet limit" (per-model weekly buckets). Codex-
// style text uses U+2019 (You’ve), so both apostrophes are accepted.
const AUTH = /OAuth access token has expired|Failed to authenticate|authentication_failed|oauth_org_not_allowed|Re-authenticate|\b401\b/i;
const CANCELLED = /cancelled by caller/i;
// "The student never ran" is not "the issue is bad". On 2026-08-22 the local
// CLI segfaulted on spawn — `claude -p (3) returned no JSON result`, exit in
// ~50ms, before the student read anything — and the v1 engine read all 95 of
// them as "worked, made no progress". 22 healthy issues were labelled
// `runner-error`; the only thing they had in common was being next in the
// queue. A crash is FREE (50ms, not 11 minutes), so it consumes a retry ladder
// ~100x faster than designed, and it is INVISIBLE as an outage: "no JSON
// result" reads like a task that produced nothing. Anchored on the message this
// adapter itself emits plus the crash signatures seen underneath it; kept
// narrow so a task that runs and produces a bad diff is still charged.
const INFRA = /returned no JSON result|segmentation fault|bun has crashed|^\s*panic\(|oh no: bun|spawn \S+ ENOENT|ETXTBSY/im;
const CAPACITY = /You['’]ve hit your|session limit|weekly limit|Opus limit|Sonnet limit|usage limit|rate limit|too many requests|\b429\b|overloaded|capacity|try again later|resets? (at|in|\d|[A-Z][a-z]{2} \d)|\[api_error_status=(429|529)\]/i;
/** Per-model weekly buckets: still capacity, but the engine can drop a tier
 *  instead of switching provider. */
const MODEL_FAMILY = /Opus limit|Sonnet limit/i;

/** Pure classifier behind Harness.classifyFailure. Order matters: an auth
 *  failure often contains "401" AND "rate"-ish words; a cancel is ours; a crash
 *  message may quote anything in its tail. */
export function classifyClaudeFailure(message: string, now: number = Date.now()): FailureVerdict {
  const m = message ?? '';
  if (AUTH.test(m)) return { kind: 'auth', detail: 'claude login rejected — re-run `claude` interactively to sign in' };
  if (CANCELLED.test(m)) return { kind: 'cancelled' };
  if (INFRA.test(m)) return { kind: 'infra' };
  if (CAPACITY.test(m)) {
    const resetAt = parseCapacityReset(m, now) ?? undefined;
    return MODEL_FAMILY.test(m)
      ? { kind: 'capacity', resetAt, detail: 'model-family' }
      : { kind: 'capacity', resetAt };
  }
  return { kind: 'task' };
}

// ---- the harness ---------------------------------------------------------------

export interface ClaudeCodeDeps {
  /** Binary resolution seam (tests never touch the filesystem). */
  resolveBin?: (name: string) => ResolvedBin;
  /** The provider's quota monitor; every rate_limit_event is fed to it. */
  quota?: QuotaMonitor;
  /** Default spawn when a run passes none (opts.spawnFn still wins). */
  spawnFn?: SpawnLike;
  now?: () => number;
  /** How runs on this harness are metered (subscription unless told otherwise). */
  meter?: MeterKind;
  /** Grace before a chat close() falls back to a tree-kill. */
  chatCloseGraceMs?: number;
}

const PROBE_PROMPT = 'Reply with exactly the word OK.';

/** Spawn, collect stdout/stderr, settle on close. For the preflight only. */
function collect(spawnFn: SpawnLike, bin: string, args: string[], cwd: string): Promise<{ stdout: string; stderr: string; code: number | null; error?: Error }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let child: ChildLike;
    try {
      child = spawnFn(bin, args, { cwd, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ stdout, stderr, code: null, error: e as Error });
      return;
    }
    child.stdout?.on('data', (b) => { stdout += b.toString(); });
    child.stderr?.on('data', (b) => { stderr += b.toString(); });
    child.on('error', (e) => { if (!settled) { settled = true; resolve({ stdout, stderr, code: null, error: e }); } });
    child.on('close', (code) => { if (!settled) { settled = true; resolve({ stdout, stderr, code }); } });
    try { child.stdin?.end(); } catch { /* prompt is on argv; nothing to send */ }
  });
}

/** The last JSON object on stdout (json output format prints one). */
function lastJsonObject(stdout: string): Record<string, unknown> | undefined {
  const t = stdout.trim();
  try {
    const v = JSON.parse(t);
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch { /* fall through to the last line */ }
  const lines = t.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{'));
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const v = JSON.parse(lines[i]);
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch { /* not this line */ }
  }
  return undefined;
}

/** Build the adapter with injectable seams. `claudeCodeHarness` is the default. */
export function createClaudeCodeHarness(deps: ClaudeCodeDeps = {}): Harness {
  const resolveBin = deps.resolveBin ?? ((name: string) => defaultResolveBin(name));
  const now = deps.now ?? (() => Date.now());
  const meter: MeterKind = deps.meter ?? 'subscription';
  const children = new ChildRegistry();

  function run(prompt: string, opts: HarnessRunOptions): Promise<HarnessRunResult> {
    const args = claudeArgs(opts);
    const bin = resolveBin('claude');
    const spawnFn: SpawnLike = opts.spawnFn ?? deps.spawnFn ?? (spawn as unknown as SpawnLike);

    return new Promise<HarnessRunResult>((resolve, reject) => {
      const startedAt = now();
      let child: ChildLike;
      try {
        child = spawnFn(bin.path, args, {
          cwd: opts.cwd,
          shell: false,
          windowsHide: true,
          env: { ...process.env, ...(opts.env ?? {}) },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (e) {
        reject(e);
        return;
      }
      children.add(child);
      const guards = attachGuards(child, {
        idleTicks: opts.idleTicks,
        budget: opts.budget,
        signal: opts.signal,
        setIntervalFn: opts.setIntervalFn,
        onIdleKill: opts.onIdleKill,
        onBudgetStop: opts.onBudgetStop,
      });

      let settled = false;
      let stdout = '';
      let stderr = '';
      let result: Record<string, unknown> | undefined;    // last type:"result" event
      let initModel: string | undefined;
      let streamSessionId = '';
      let rejectedResetAt: number | undefined;            // from a rejected rate_limit_event
      const framer = new NdjsonFramer();
      const live = new LiveUsage();
      const sink = opts.transcriptSink;

      const handleEvent = (evt: Record<string, unknown>): void => {
        // Once the budget has tripped this run is over; the tree-kill is in
        // flight but events already buffered in the pipe still arrive. Counting
        // them would report a turn count higher than the cap we enforced.
        if (guards.stoppedBy) return;
        const type = evt.type;
        if (type === 'result') { result = evt; return; }
        if (type === 'system') {
          // One init PER TURN (spike: 2 in a 2-turn session); the newest wins.
          if (evt.subtype === 'init') {
            if (typeof evt.model === 'string') initModel = evt.model;
            if (typeof evt.session_id === 'string') streamSessionId = evt.session_id;
          }
          return;
        }
        if (type === 'rate_limit_event') {
          const reading = quotaFromRateLimitEvent(evt, now());
          if (!reading) return;
          if (reading.observation.allowed === false && reading.resetsAt !== undefined) rejectedResetAt = reading.resetsAt;
          opts.onQuota?.(reading.observation);
          deps.quota?.observe(reading.observation);
          return;
        }
        // assistant / user / anything else carrying a message: unknown types are
        // tolerated by design — rate_limit_event alone has broken two SDKs.
        const text = assistantText(evt);
        if (text) guards.noteText(text);
        if (!live.note(evt)) return;
        opts.onUsage?.(live.usage);
        // Budget check AFTER usage is reported so the caller's last live figure
        // is the one the stop is justified by. Only ever fires once: the first
        // trip kills the tree, and the guard at the top drops every event still
        // in flight behind it.
        guards.noteUsage(live.turns, live.billedTokens);
      };

      const consume = (chunk: string): void => {
        for (const evt of framer.push(chunk, sink)) handleEvent(evt);
      };

      child.stdout?.on('data', (b) => { const s = b.toString(); stdout += s; guards.noteOutput(); consume(s); });
      child.stderr?.on('data', (b) => { stderr += b.toString(); guards.noteOutput(); });

      child.on('error', (e) => {
        guards.stop();
        children.delete(child);
        if (settled) return;
        settled = true;
        reject(e);
      });

      child.on('close', (code) => {
        guards.stop();
        children.delete(child);
        if (settled) return;
        settled = true;
        for (const evt of framer.flush(sink)) handleEvent(evt);   // a final unterminated line
        const durationMs = now() - startedAt;
        const resetHint = rejectedResetAt !== undefined ? ` [resetsAt=${rejectedResetAt}]` : '';

        // Killed for silence: reject so the item is retried, and carry the last
        // thing the student said into the message. That text is how an
        // environmental stall (a plan limit the CLI announced and then hung on)
        // still reaches classifyFailure and gets forgiven rather than condemned.
        if (guards.killedIdle) {
          const why = guards.lastText ? ` Last message: ${guards.lastText.slice(0, 300)}` : '';
          reject(new Error(
            `claude -p produced no output for ${guards.idleTicks} consecutive minute(s) — killed as stalled.${why}${resetHint}`,
          ));
          return;
        }
        // A caller cancel RESOLVES, like a budget stop: we killed the process on
        // purpose and the worktree still holds whatever it had done. The caller's
        // success path banks it; rejecting would throw the partial work away.
        if (guards.cancelled) {
          resolve({
            text: `[cancelled by caller (abort signal) after ${live.turns} turn(s) — this is PARTIAL work, not a finished task]`,
            usage: live.usage,
            sessionId: streamSessionId || opts.session?.seed || '',
            turns: live.turns,
            stoppedBy: 'cancelled',
            costUsd: null,
            meter,
            durationMs,
            exitCode: code,
            model: initModel,
          });
          return;
        }

        let parsed: Record<string, unknown> | undefined = result;
        // Fallback: a CLI build that ignored --output-format stream-json (or an
        // older one) prints a single JSON blob. Parse it the old way rather than
        // failing every student on a format we merely expected.
        if (!parsed) {
          try {
            const blob = JSON.parse(stdout.trim()) as unknown;
            if (blob && typeof blob === 'object' && !Array.isArray(blob)) {
              const b = blob as Record<string, unknown>;
              if (b.type === 'result' || typeof b.result === 'string') parsed = b;
            }
          } catch { /* not JSON — crashed before final result */ }
        }
        const seed = opts.session?.seed;

        // A budget stop RESOLVES rather than rejects, and that asymmetry is the
        // whole point. We killed this process on purpose, so there is no `result`
        // event and the checks below would read it as a crash — but the student's
        // edits are sitting in the worktree, and the caller's success path is what
        // commits and pushes them. Rejecting here would send the run down the
        // error path, skipping commitAndPush, and the next dispatch would wipe the
        // work: addWorktree force-removes the worktree and `branch -D`s it, so
        // ONLY pushed work survives a retry. An unbanked cap costs the full
        // session again and saves nothing. So: hand back what was spent plus a
        // marker, and let the normal commit -> push -> PR -> review -> fix path
        // finish the job in fresh, small-context sessions.
        if (guards.stoppedBy) {
          resolve({
            text: `[stopped by the ${guards.stoppedBy} budget after ${live.turns} turns — this is PARTIAL work, not a finished task]`,
            usage: live.usage,
            sessionId: typeof parsed?.session_id === 'string' ? parsed.session_id : (streamSessionId || seed || ''),
            turns: live.turns,
            stoppedBy: 'budget',
            costUsd: null,   // no result event: the CLI never priced the partial run
            meter,
            durationMs,
            exitCode: code,
            model: initModel,
          });
          return;
        }

        if (!parsed) {
          const tail = (stderr || stdout).trim().slice(-500) || '(no output)';
          reject(new Error(`claude -p (${code}) returned no JSON result: ${tail}`));
          return;
        }
        const r = parseClaudeResult(parsed, { turns: live.turns });
        if (r.isError) {
          const status = r.apiErrorStatus !== undefined ? ` [api_error_status=${r.apiErrorStatus}]` : '';
          reject(new Error(`claude -p error (${r.subtype}): ${r.text.slice(-500)}${status}${resetHint}`));
          return;
        }
        resolve({
          text: r.text,
          usage: r.usage,
          sessionId: r.sessionId || streamSessionId || seed || '',
          turns: r.turns,
          costUsd: r.costUsd,
          meter,
          durationMs: r.durationMs || durationMs,
          apiDurationMs: r.apiDurationMs,
          exitCode: code,
          model: initModel ?? r.model,
          raw: r.raw,
        });
      });

      // Prompt over stdin, then EOF: the CLI reads until end of input.
      try {
        child.stdin?.write(prompt);
        child.stdin?.end();
      } catch (e) {
        // A child that died before reading its prompt reports through 'error'/'close'.
        if (!settled) { settled = true; guards.stop(); children.delete(child); reject(e); }
      }
    });
  }

  /**
   * Resolve the binary and prove it can do WORK. `--version` passes with an
   * expired login, which is exactly the failure this exists to catch, so the
   * second step is a real (haiku, one-turn) completion.
   */
  async function preflight(o: { spawnFn?: SpawnLike; cwd?: string } = {}): Promise<PreflightResult> {
    const bin = resolveBin('claude');
    if (!bin.found) {
      return { ok: false, bin: bin.path, detail: 'claude not found on PATH or in the known install directories' };
    }
    const spawnFn: SpawnLike = o.spawnFn ?? deps.spawnFn ?? (spawn as unknown as SpawnLike);
    const cwd = o.cwd ?? process.cwd();

    const v = await collect(spawnFn, bin.path, ['--version'], cwd);
    if (v.error) return { ok: false, bin: bin.path, detail: `spawn failed: ${v.error.message}` };
    const version = /(\d+\.\d+\.\d+)/.exec(v.stdout)?.[1];
    if (!version) {
      const tail = (v.stderr || v.stdout).trim().slice(-300) || '(no output)';
      return { ok: false, bin: bin.path, detail: `--version (${v.code}) printed no version: ${tail}` };
    }

    const probe = await collect(spawnFn, bin.path,
      ['-p', PROBE_PROMPT, '--output-format', 'json', '--model', 'haiku', '--max-turns', '1'], cwd);
    if (probe.error) return { ok: false, bin: bin.path, version, authOk: false, detail: `probe spawn failed: ${probe.error.message}` };
    const parsed = lastJsonObject(probe.stdout);
    if (!parsed) {
      const tail = (probe.stderr || probe.stdout).trim().slice(-300) || '(no output)';
      return { ok: false, bin: bin.path, version, authOk: false, detail: `claude -p (${probe.code}) returned no JSON result: ${tail}` };
    }
    const r = parseClaudeResult(parsed);
    if (r.isError) {
      const status = r.apiErrorStatus !== undefined ? ` [api_error_status=${r.apiErrorStatus}]` : '';
      const message = `claude -p error (${r.subtype}): ${r.text.slice(-300)}${status}`;
      const verdict = classifyClaudeFailure(message, now());
      const detail = verdict.kind === 'auth' || r.apiErrorStatus === 401
        ? `auth: ${message}`
        : `${verdict.kind}: ${message}`;
      return { ok: false, bin: bin.path, version, authOk: false, detail };
    }
    return { ok: true, bin: bin.path, version, authOk: true };
  }

  const harness: Harness = {
    id: 'claude-code',
    provider: 'anthropic',
    capabilities: CLAUDE_CODE_CAPABILITIES,
    run,
    killAll(): void { children.killAll(); },
    classifyFailure(message: string, at: number = now()): FailureVerdict {
      return classifyClaudeFailure(message, at);
    },
    preflight,
    chat(opts: ChatOptions): ChatSession {
      return createClaudeChat(opts, {
        resolveBin, quota: deps.quota, spawnFn: deps.spawnFn, now, closeGraceMs: deps.chatCloseGraceMs,
      });
    },
  };
  return harness;
}

/** The default adapter: real spawn, real PATH lookup, no quota monitor wired
 *  (the engine builds one with createClaudeCodeHarness({ quota })). */
export const claudeCodeHarness: Harness = createClaudeCodeHarness();
