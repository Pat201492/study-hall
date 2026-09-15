import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  ZERO_USAGE,
  type ChatEvent, type ChatOptions, type ChatSession, type ChildLike, type FailureVerdict, type Harness,
  type HarnessCapabilities, type HarnessRunOptions, type HarnessRunResult, type PreflightResult, type Provider,
  type Sandbox, type SessionSpec, type SpawnLike, type Usage,
} from '../contract.js';
import { attachGuards } from '../guards.js';
import { NdjsonFramer, num } from '../ndjson.js';
import { ChildRegistry, npmPackageExe, resolveBin, treeKill, type ResolvedBin } from '../proc.js';
import { parseCodexReset } from './codexReset.js';

// OpenAI Codex CLI adapter (pinned 0.154.0). Facts below were verified live on
// this machine on 2026-09-14 (docs/adr/ADR-001-codex-spikes.md):
//
//  - `codex exec --json` emits JSONL: thread.started{thread_id} / turn.started /
//    item.* / turn.completed{usage} / turn.failed{error.message} / error{message}.
//  - Usage on turn.completed is CUMULATIVE for the thread: a resume or fork of a
//    14134-token base reported 28286 on its own single turn. The adapter diffs
//    against a caller-supplied baseline and exposes the raw totals so the
//    caller can store the next one.
//  - `input_tokens` INCLUDES `cached_input_tokens` (rollout total_tokens =
//    input + output), so fresh input = input - cached.
//  - The prompt goes on stdin with `-` as the positional; `resume <id> -` and
//    `fork <id> -` accept it too. resume echoes the SAME thread id in
//    thread.started; fork mints a new one.
//  - Exit code is 0 or 1 only; failure kind must come from message text.
//  - No rate-limit data in the exec stream: quota lives in quota/codexAppServer.ts.

export const openaiProvider: Provider = {
  id: 'openai',
  label: 'OpenAI (ChatGPT subscription)',
  credentialKind: 'oauth_subscription',
  automationStance: 'gray',
  meter: 'subscription',
  concurrencyCap: 2,
};

export const CODEX_CAPABILITIES: HarnessCapabilities = {
  warmSessions: true,
  seedableSessions: false,
  forkSessions: true,
  cacheUsageSplit: true,
  usageIsCumulative: true,
  reportsCost: false,
  toolAllowlist: false,
  mcpToolAllowlist: true,
  effortControl: true,
  sandboxModes: ['read-only', 'workspace-write', 'none'],
  promptTransport: 'stdin',
  // Usage arrives only on turn.completed — the last event of a run — so the
  // generic budget guard can only trip between turns. Declared honestly.
  streamsUsage: false,
  cancellable: true,
  transcripts: true,
  budgetStop: false,
  chat: 'resume-loop',
};

export const DEFAULT_THREAD_SOURCE = 'study-hall';

// ---------------------------------------------------------------------------
// argv
// ---------------------------------------------------------------------------

export interface CodexArgOptions {
  cwd: string;
  model?: string;
  effort?: string;
  sandbox?: Sandbox;
  session?: SessionSpec;
  /** threadSource, configOverrides, outputSchemaFile, lastMessageFile, ignoreUserConfig. */
  extra?: Record<string, unknown>;
}

/** A TOML basic string for a `-c key="value"` override. */
function tomlString(v: string): string {
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Pure argv builder. Global flags go before the subcommand (they parse on
 * either side at 0.154.0); the session subcommand and the `-` stdin sentinel
 * go last, mirroring OpenAI's own SDK (sdk/typescript/src/exec.ts).
 */
export function codexArgs(opts: CodexArgOptions): string[] {
  const extra = opts.extra ?? {};
  const args = ['exec', '--json', '--skip-git-repo-check', '--cd', opts.cwd];
  if (opts.model) args.push('-m', opts.model);
  const sandbox = opts.sandbox ?? 'workspace-write';
  if (sandbox === 'none') args.push('--dangerously-bypass-approvals-and-sandbox');
  else args.push('--sandbox', sandbox);
  // The operator's ~/.codex/config.toml is skipped unless explicitly kept
  // (extra.ignoreUserConfig === false): config-file MCP servers need it.
  if (extra.ignoreUserConfig !== false) args.push('--ignore-user-config');
  args.push('--ignore-rules');
  args.push('--thread-source', typeof extra.threadSource === 'string' && extra.threadSource ? extra.threadSource : DEFAULT_THREAD_SOURCE);
  args.push('-c', 'approval_policy="never"');
  if (opts.effort) args.push('-c', `model_reasoning_effort=${tomlString(opts.effort)}`);
  const overrides = extra.configOverrides;
  if (overrides && typeof overrides === 'object') {
    for (const [k, v] of Object.entries(overrides as Record<string, unknown>)) args.push('-c', `${k}=${String(v)}`);
  }
  if (typeof extra.outputSchemaFile === 'string' && extra.outputSchemaFile) args.push('--output-schema', extra.outputSchemaFile);
  if (typeof extra.lastMessageFile === 'string' && extra.lastMessageFile) args.push('-o', extra.lastMessageFile);
  const session = opts.session;
  if (session?.mode === 'fork' && session.base) args.push('fork', session.base, '-');
  else if (session?.mode === 'resume' && session.base) args.push('resume', session.base, '-');
  else args.push('-');
  return args;
}

// ---------------------------------------------------------------------------
// Stream parsing (pure)
// ---------------------------------------------------------------------------

/** turn.completed.usage as Codex emits it — CUMULATIVE for the thread. */
export interface CodexRawUsage {
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
}

export interface CodexParse {
  /** thread.started.thread_id ('' if never seen). */
  sessionId: string;
  /** The last agent_message text (last one wins). */
  text: string;
  /** Every agent_message text, in order. */
  texts: string[];
  /** Cumulative thread totals from the last turn.completed, or null. */
  cumulativeUsage: CodexRawUsage | null;
  /** Count of turn.completed events. */
  turns: number;
  /** Fatal messages from `error` / `turn.failed` (consecutive duplicates collapsed). */
  errors: string[];
  /** Non-fatal `item.type === 'error'` messages (e.g. unknown model metadata). */
  warnings: string[];
  itemsCompleted: number;
  threadStarted?: Record<string, unknown>;
  turnCompleted?: Record<string, unknown>;
}

export interface CodexParser {
  feed(event: Record<string, unknown>): void;
  result(): CodexParse;
}

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export function rawUsageFrom(v: unknown): CodexRawUsage | null {
  const u = obj(v);
  if (!u) return null;
  return {
    input_tokens: num(u.input_tokens),
    cached_input_tokens: num(u.cached_input_tokens),
    cache_write_input_tokens: num(u.cache_write_input_tokens),
    output_tokens: num(u.output_tokens),
    reasoning_output_tokens: num(u.reasoning_output_tokens),
  };
}

export function createCodexParser(): CodexParser {
  const p: CodexParse = {
    sessionId: '', text: '', texts: [], cumulativeUsage: null, turns: 0, errors: [], warnings: [], itemsCompleted: 0,
  };
  const pushError = (m: string): void => {
    if (p.errors[p.errors.length - 1] !== m) p.errors.push(m);
  };
  return {
    feed(ev) {
      switch (ev.type) {
        case 'thread.started': {
          if (typeof ev.thread_id === 'string') p.sessionId = ev.thread_id;
          p.threadStarted = ev;
          break;
        }
        case 'item.completed': {
          const item = obj(ev.item);
          if (!item) break;
          p.itemsCompleted += 1;
          if (item.type === 'agent_message' && typeof item.text === 'string') {
            p.texts.push(item.text);
            p.text = item.text;
          } else if (item.type === 'error' && typeof item.message === 'string') {
            p.warnings.push(item.message);
          }
          break;
        }
        case 'turn.completed': {
          p.turns += 1;
          p.turnCompleted = ev;
          const u = rawUsageFrom(ev.usage);
          if (u) p.cumulativeUsage = u;
          break;
        }
        case 'turn.failed': {
          const err = obj(ev.error);
          pushError(err && typeof err.message === 'string' ? err.message : 'turn failed');
          break;
        }
        case 'error': {
          if (typeof ev.message === 'string') pushError(ev.message);
          break;
        }
        default:
          break;
      }
    },
    result() { return p; },
  };
}

/** Pure: fold a whole event list (e.g. a replayed fixture) into a CodexParse. */
export function parseCodexStream(events: Iterable<Record<string, unknown>>): CodexParse {
  const parser = createCodexParser();
  for (const ev of events) parser.feed(ev);
  return parser.result();
}

// ---------------------------------------------------------------------------
// Usage mapping
// ---------------------------------------------------------------------------

/**
 * Codex raw → contract Usage. `input_tokens` includes the cached subset
 * (verified: rollout total_tokens == input_tokens + output_tokens), so fresh
 * input is the difference. `output_tokens` likewise includes reasoning per the
 * Responses API contract; reasoningTokens is reported alongside, not added.
 */
export function mapCodexUsage(raw: CodexRawUsage | null | undefined): Usage {
  if (!raw) return { ...ZERO_USAGE };
  const cached = num(raw.cached_input_tokens);
  return {
    inputTokens: Math.max(0, num(raw.input_tokens) - cached),
    outputTokens: num(raw.output_tokens),
    cacheReadInputTokens: cached,
    cacheCreationInputTokens: num(raw.cache_write_input_tokens),
    reasoningTokens: num(raw.reasoning_output_tokens),
  };
}

/** Saturating per-field difference (a compacted base could otherwise go negative). */
export function subtractUsage(total: Usage, baseline: Usage): Usage {
  return {
    inputTokens: Math.max(0, total.inputTokens - baseline.inputTokens),
    outputTokens: Math.max(0, total.outputTokens - baseline.outputTokens),
    cacheReadInputTokens: Math.max(0, total.cacheReadInputTokens - baseline.cacheReadInputTokens),
    cacheCreationInputTokens: Math.max(0, total.cacheCreationInputTokens - baseline.cacheCreationInputTokens),
    reasoningTokens: Math.max(0, total.reasoningTokens - baseline.reasoningTokens),
  };
}

/**
 * The baseline a warm slot stored from a previous run's `raw.cumulativeUsage`.
 * Accepts either shape — Codex raw (`input_tokens`) or contract Usage
 * (`inputTokens`) — because the mapping is linear and callers keep whichever.
 */
export function usageBaseline(extra?: Record<string, unknown>): Usage {
  const b = obj(extra?.usageBaseline);
  if (!b) return { ...ZERO_USAGE };
  if ('input_tokens' in b || 'cached_input_tokens' in b) return mapCodexUsage(rawUsageFrom(b));
  return {
    inputTokens: num(b.inputTokens),
    outputTokens: num(b.outputTokens),
    cacheReadInputTokens: num(b.cacheReadInputTokens),
    cacheCreationInputTokens: num(b.cacheCreationInputTokens),
    reasoningTokens: num(b.reasoningTokens),
  };
}

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

const AUTH_RE = /access token could not be refreshed|log out and sign in again|Please sign in again|Not logged in/i;
// Codex writes "You’ve" with U+2019; both apostrophes are matched.
const CAPACITY_RE = /You[’']ve hit your usage limit|Quota exceeded|exceeded retry limit, last status: 429|rate limit exceeded|Selected model is at capacity|currently experiencing high demand|out of credits|spend cap/i;
const INFRA_RE = /returned no JSON result|spawn \S+ ENOENT|ETXTBSY|Connection failed|stream disconnected/i;

/**
 * Provider wording never leaks upstream: the engine sees a FailureKind.
 * 'shared rollout token budget exhausted' and "ran out of room in the model's
 * context window" deliberately fall through to 'task' — the item's fault or a
 * budget working, not the provider being unavailable.
 */
export function classifyCodexFailure(message: string, now: number = Date.now()): FailureVerdict {
  const m = message ?? '';
  if (AUTH_RE.test(m)) return { kind: 'auth', detail: m };
  if (CAPACITY_RE.test(m)) {
    const resetAt = parseCodexReset(m, now);
    return resetAt ? { kind: 'capacity', resetAt, detail: m } : { kind: 'capacity', detail: m };
  }
  if (INFRA_RE.test(m)) return { kind: 'infra', detail: m };
  return { kind: 'task', detail: m };
}

// ---------------------------------------------------------------------------
// Binary resolution
// ---------------------------------------------------------------------------

const PLATFORM_PACKAGES: Record<string, string> = {
  'x86_64-pc-windows-msvc': '@openai/codex-win32-x64',
  'aarch64-pc-windows-msvc': '@openai/codex-win32-arm64',
  'x86_64-unknown-linux-musl': '@openai/codex-linux-x64',
  'aarch64-unknown-linux-musl': '@openai/codex-linux-arm64',
  'x86_64-apple-darwin': '@openai/codex-darwin-x64',
  'aarch64-apple-darwin': '@openai/codex-darwin-arm64',
};

export function codexTargetTriple(platform: string = process.platform, arch: string = process.arch): string | null {
  const cpu = arch === 'x64' ? 'x86_64' : arch === 'arm64' ? 'aarch64' : null;
  if (!cpu) return null;
  if (platform === 'win32') return `${cpu}-pc-windows-msvc`;
  if (platform === 'darwin') return `${cpu}-apple-darwin`;
  if (platform === 'linux' || platform === 'android') return `${cpu}-unknown-linux-musl`;
  return null;
}

/**
 * The real Codex executable. On Windows `resolveBin('codex')` lands on the npm
 * shim (`%APPDATA%\npm\codex`, `codex.cmd`), which Node refuses to spawn with
 * shell:false; the exe ships inside the platform package that
 * `@openai/codex/bin/codex.js` resolves at runtime:
 *   <npm-global>/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/
 *     vendor/x86_64-pc-windows-msvc/bin/codex.exe        (npm nests it here)
 *   <npm-global>/node_modules/@openai/codex-win32-x64/vendor/...  (hoisted layout)
 * The standalone installer's %LOCALAPPDATA%\Programs\OpenAI\Codex\bin is
 * already in resolveBin's fallback dirs.
 */
export function resolveCodexBin(
  configured = 'codex',
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  platform: string = process.platform,
  arch: string = process.arch,
): ResolvedBin {
  const r = resolveBin(configured, env, home);
  const win = platform === 'win32';
  const spawnable = r.found && !r.isShim && (!win || /\.(exe|com)$/i.test(r.path));
  if (spawnable) return r;
  const triple = codexTargetTriple(platform, arch);
  const pkg = triple ? PLATFORM_PACKAGES[triple] : undefined;
  if (triple && pkg) {
    const rel = join('vendor', triple, 'bin', win ? 'codex.exe' : 'codex');
    const hit = npmPackageExe('@openai/codex', join('node_modules', pkg, rel), env, home)
      ?? npmPackageExe(pkg, rel, env, home);
    if (hit) return { path: hit, found: true, isShim: false };
  }
  return { ...r, isShim: r.found && (r.isShim || win) };
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/**
 * Child env: the inherited API keys are REMOVED so a stray shell export can
 * never silently move the lane from the ChatGPT subscription onto metered
 * billing; `opts.env` is applied afterwards so an explicit choice still wins.
 * CODEX_HOME comes from `extra.codexHome` when given (the dir must exist).
 */
export function codexEnv(opts: { env?: Record<string, string>; extra?: Record<string, unknown> }, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  delete env.CODEX_API_KEY;
  delete env.OPENAI_API_KEY;
  Object.assign(env, opts.env ?? {});
  if (typeof opts.extra?.codexHome === 'string' && opts.extra.codexHome) env.CODEX_HOME = opts.extra.codexHome;
  return env;
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

export interface CodexHarnessDeps {
  /** Configured binary (bare name or path). Default 'codex'. */
  bin?: string;
  spawnFn?: SpawnLike;
  env?: NodeJS.ProcessEnv;
  home?: string;
  now?: () => number;
  setIntervalFn?: HarnessRunOptions['setIntervalFn'];
}

interface Captured { code: number | null; stdout: string; stderr: string }

function capture(
  spawnFn: SpawnLike, registry: ChildRegistry, bin: string, args: string[],
  opts: { cwd?: string; env: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<Captured> {
  return new Promise((resolve) => {
    let child: ChildLike;
    try {
      child = spawnFn(bin, args, { cwd: opts.cwd, shell: false, windowsHide: true, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ code: null, stdout: '', stderr: (e as Error).message });
      return;
    }
    registry.add(child);
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (code: number | null, extra = ''): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      registry.delete(child);
      resolve({ code, stdout, stderr: stderr + extra });
    };
    const timer = setTimeout(() => { treeKill(child); finish(null, ' (timed out)'); }, opts.timeoutMs ?? 30_000);
    (timer as { unref?: () => void }).unref?.();
    child.stdout?.on('data', (b) => { stdout += String(b); });
    child.stderr?.on('data', (b) => { stderr += String(b); });
    child.on('error', (e) => finish(null, e.message));
    child.on('close', (code) => finish(code));
  });
}

const OUTPUT_TAIL_CHARS = 600;

export function createCodexHarness(deps: CodexHarnessDeps = {}): Harness {
  const registry = new ChildRegistry();
  const now = deps.now ?? (() => Date.now());
  const baseEnv = (): NodeJS.ProcessEnv => deps.env ?? process.env;
  const home = (): string => deps.home ?? homedir();
  const binPath = (): string => resolveCodexBin(deps.bin ?? 'codex', baseEnv(), home()).path;

  function run(prompt: string, opts: HarnessRunOptions): Promise<HarnessRunResult> {
    return new Promise((resolve, reject) => {
      const startedAt = now();
      const spawnFn = opts.spawnFn ?? deps.spawnFn ?? spawn;
      const bin = binPath();
      const args = codexArgs(opts);
      const env = codexEnv(opts, baseEnv());
      let child: ChildLike;
      try {
        child = spawnFn(bin, args, { cwd: opts.cwd, shell: false, windowsHide: true, env, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (e) {
        reject(new Error(`codex exec (spawn) returned no JSON result: ${(e as Error).message}`));
        return;
      }
      registry.add(child);
      const guards = attachGuards(child, {
        idleTicks: opts.idleTicks,
        budget: opts.budget,
        signal: opts.signal,
        setIntervalFn: opts.setIntervalFn ?? deps.setIntervalFn,
        onIdleKill: opts.onIdleKill,
        onBudgetStop: opts.onBudgetStop,
      });
      const framer = new NdjsonFramer();
      const parser = createCodexParser();
      const baseline = usageBaseline(opts.extra);
      let tail = '';
      const noteTail = (s: string): void => { tail = (tail + s).slice(-OUTPUT_TAIL_CHARS); };
      let settled = false;

      const onEvent = (ev: Record<string, unknown>): void => {
        parser.feed(ev);
        if (ev.type === 'item.completed') {
          const item = obj(ev.item);
          if (item?.type === 'agent_message' && typeof item.text === 'string') guards.noteText(item.text);
        } else if (ev.type === 'turn.completed') {
          const p = parser.result();
          const usage = subtractUsage(mapCodexUsage(p.cumulativeUsage), baseline);
          opts.onUsage?.(usage);
          guards.noteUsage(p.turns, usage.inputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens);
        }
      };
      const onLine = (line: string): void => {
        opts.transcriptSink?.(line);
        if (!line.startsWith('{')) noteTail(line + '\n');
      };

      const settle = (code: number | null, spawnError?: Error): void => {
        if (settled) return;
        settled = true;
        for (const ev of framer.flush(onLine)) onEvent(ev);
        guards.stop();
        registry.delete(child);
        const p = parser.result();
        const durationMs = now() - startedAt;
        if (spawnError) {
          reject(new Error(`codex exec (spawn) returned no JSON result: ${spawnError.message}`));
          return;
        }
        const usage = subtractUsage(mapCodexUsage(p.cumulativeUsage), baseline);
        const raw = {
          cumulativeUsage: p.cumulativeUsage,
          threadStarted: p.threadStarted,
          turnCompleted: p.turnCompleted,
          errors: p.errors,
          warnings: p.warnings,
          stderrTail: tail.trim().slice(-400),
        };

        // Killed for silence: REJECT so the item is retried, carrying the last
        // thing the model said so a provider stall still reaches classifyFailure.
        if (guards.killedIdle) {
          const why = guards.lastText ? ` Last message: ${guards.lastText.slice(0, 300)}` : '';
          reject(new Error(`codex exec produced no output for ${guards.idleTicks} consecutive minute(s) — killed as stalled.${why}`));
          return;
        }

        // A budget stop or a cancel RESOLVES with partial work banked: the edits
        // are in the worktree and the caller's success path is what pushes them.
        const partial = (stoppedBy: 'budget' | 'cancelled', marker: string): HarnessRunResult => ({
          text: p.text || `[${marker} after ${p.turns} turn(s) — this is PARTIAL work, not a finished task]`,
          usage, sessionId: p.sessionId, turns: p.turns, stoppedBy, costUsd: null, meter: 'subscription',
          durationMs, exitCode: code, raw,
        });
        if (guards.stoppedBy) { resolve(partial('budget', `stopped by the ${guards.stoppedBy} budget`)); return; }
        if (guards.cancelled) { resolve(partial('cancelled', 'cancelled')); return; }

        if (p.turns === 0) {
          // turn.failed / error carry the provider's own wording — that is what
          // classifyFailure keys on (usage limit, auth, ...), so it is the message.
          if (p.errors.length) { reject(new Error(p.errors[p.errors.length - 1])); return; }
          // No thread.started / turn.completed at all: the wording the infra
          // classifier keys on.
          reject(new Error(`codex exec (${code}) returned no JSON result: ${tail.trim().slice(-400) || '(no output)'}`));
          return;
        }
        resolve({
          text: p.text,
          usage,
          sessionId: p.sessionId,
          turns: p.turns,
          costUsd: null,
          meter: 'subscription',
          durationMs,
          exitCode: code,
          raw,
        });
      };

      child.stdout?.on('data', (b) => {
        guards.noteOutput();
        for (const ev of framer.push(String(b), onLine)) onEvent(ev);
      });
      child.stderr?.on('data', (b) => { guards.noteOutput(); noteTail(String(b)); });
      child.on('error', (e) => settle(null, e));
      child.on('close', (code) => settle(code));
      try {
        child.stdin?.write(prompt);
        child.stdin?.end();
      } catch { /* the close handler reports whatever the child did */ }
    });
  }

  async function preflight(o: { spawnFn?: SpawnLike; cwd?: string } = {}): Promise<PreflightResult> {
    const spawnFn = o.spawnFn ?? deps.spawnFn ?? spawn;
    const r = resolveCodexBin(deps.bin ?? 'codex', baseEnv(), home());
    if (!r.found) return { ok: false, bin: r.path, detail: 'codex not found on PATH or in the known install dirs' };
    if (r.isShim) return { ok: false, bin: r.path, detail: `only the npm shim was found (${r.path}); the platform package exe is missing` };
    const env = codexEnv({}, baseEnv());
    const v = await capture(spawnFn, registry, r.path, ['--version'], { cwd: o.cwd, env });
    if (v.code !== 0) {
      return { ok: false, bin: r.path, detail: `codex --version exited ${v.code}: ${(v.stdout + v.stderr).trim()}` };
    }
    const version = v.stdout.trim().replace(/^codex-cli\s+/i, '') || undefined;
    // `codex login status` prints "Logged in using ChatGPT" on STDERR, exit 0.
    // It reads the credential store only — an expired token still passes, so
    // authOk here means "credentials present", not "a completion succeeded".
    const s = await capture(spawnFn, registry, r.path, ['login', 'status'], { cwd: o.cwd, env });
    const said = (s.stdout + s.stderr).trim();
    const authOk = s.code === 0 && /logged in/i.test(said) && !/not logged in/i.test(said);
    return { ok: authOk, bin: r.path, version, authOk, detail: said || `codex login status exited ${s.code}` };
  }

  function chat(opts: ChatOptions): ChatSession {
    return createCodexChat(opts, { registry, spawnFn: opts.spawnFn ?? deps.spawnFn ?? spawn, bin: binPath(), env: baseEnv(), now });
  }

  return {
    id: 'codex',
    provider: openaiProvider.id,
    capabilities: CODEX_CAPABILITIES,
    run,
    killAll() { registry.killAll(); },
    classifyFailure: classifyCodexFailure,
    preflight,
    chat,
  };
}

// ---------------------------------------------------------------------------
// Chat: a per-turn `codex exec resume <id>` loop
// ---------------------------------------------------------------------------

/**
 * Maps exec JSONL events to normalised ChatEvents. Tool items produce a
 * tool_call on item.started (or on item.completed when no start was seen) and
 * a tool_result on item.completed. Identical `error` + `turn.failed` messages
 * collapse into one error event.
 */
export class CodexChatEventMapper {
  private readonly started = new Set<string>();
  private lastError: string | null = null;
  private baseline: Usage;
  sessionId: string | null;

  constructor(sessionId: string | null = null, baseline: Usage = { ...ZERO_USAGE }) {
    this.sessionId = sessionId;
    this.baseline = baseline;
  }

  map(ev: Record<string, unknown>, classify: (m: string) => FailureVerdict = (m) => classifyCodexFailure(m)): ChatEvent[] {
    const out: ChatEvent[] = [];
    switch (ev.type) {
      case 'thread.started': {
        if (typeof ev.thread_id === 'string' && ev.thread_id !== this.sessionId) {
          this.sessionId = ev.thread_id;
          out.push({ type: 'status', message: `thread ${ev.thread_id}` });
        }
        break;
      }
      case 'item.started': {
        const item = obj(ev.item);
        const call = item && toolCall(item);
        if (item && call) {
          const id = typeof item.id === 'string' ? item.id : undefined;
          if (id) this.started.add(id);
          out.push({ type: 'tool_call', id, ...call });
        }
        break;
      }
      case 'item.completed': {
        const item = obj(ev.item);
        if (!item) break;
        const id = typeof item.id === 'string' ? item.id : undefined;
        if (item.type === 'agent_message' && typeof item.text === 'string') {
          out.push({ type: 'text', text: item.text });
        } else if (item.type === 'reasoning' && typeof item.text === 'string') {
          out.push({ type: 'status', message: `reasoning: ${item.text}` });
        } else if (item.type === 'error' && typeof item.message === 'string') {
          out.push({ type: 'status', message: `warning: ${item.message}` });
        } else {
          const call = toolCall(item);
          if (call) {
            if (!id || !this.started.has(id)) out.push({ type: 'tool_call', id, ...call });
            if (id) this.started.delete(id);
            out.push({ type: 'tool_result', id, name: call.name, ...toolResult(item) });
          }
        }
        break;
      }
      case 'turn.completed': {
        const raw = rawUsageFrom(ev.usage);
        const total = mapCodexUsage(raw);
        const usage = subtractUsage(total, this.baseline);
        if (raw) this.baseline = total;
        out.push({ type: 'usage', usage, costUsd: null });
        out.push({ type: 'turn_done', usage, costUsd: null, sessionId: this.sessionId ?? undefined });
        break;
      }
      case 'turn.failed':
      case 'error': {
        const err = obj(ev.error);
        const message = typeof ev.message === 'string' ? ev.message
          : err && typeof err.message === 'string' ? err.message : 'turn failed';
        if (message !== this.lastError) {
          this.lastError = message;
          out.push({ type: 'error', message, verdict: classify(message) });
        }
        break;
      }
      default:
        break;
    }
    return out;
  }
}

function toolCall(item: Record<string, unknown>): { name: string; input: unknown } | null {
  switch (item.type) {
    case 'command_execution': return { name: 'command_execution', input: { command: item.command } };
    case 'mcp_tool_call': return { name: `${String(item.server ?? 'mcp')}.${String(item.tool ?? 'tool')}`, input: item.arguments };
    case 'file_change': return { name: 'file_change', input: { changes: item.changes } };
    case 'web_search': return { name: 'web_search', input: { query: item.query } };
    case 'collab_tool_call': return { name: `collab.${String(item.tool ?? 'tool')}`, input: { prompt: item.prompt } };
    default: return null;
  }
}

function toolResult(item: Record<string, unknown>): { output: unknown; isError?: boolean } {
  const status = typeof item.status === 'string' ? item.status : undefined;
  const failed = status === 'failed' || status === 'declined';
  switch (item.type) {
    case 'command_execution': {
      const exit = typeof item.exit_code === 'number' ? item.exit_code : null;
      return { output: { exit_code: exit, aggregated_output: item.aggregated_output, status }, isError: failed || (exit !== null && exit !== 0) };
    }
    case 'mcp_tool_call':
      return { output: item.error ?? item.result ?? null, isError: failed || item.error != null };
    case 'file_change':
      return { output: { status, changes: item.changes }, isError: failed };
    default:
      return { output: { status }, isError: failed };
  }
}

interface ChatDeps {
  registry: ChildRegistry;
  spawnFn: SpawnLike;
  bin: string;
  env: NodeJS.ProcessEnv;
  now: () => number;
}

/**
 * One `codex exec` process per turn: the first turn creates the thread and
 * adopts its id, every later `send` is `codex exec resume <id> -`. Notes:
 *  - `systemPrompt` is prepended to the FIRST turn's text (exec has no
 *    per-run system-prompt flag; base instructions are config-file keys);
 *  - `mcpConfig` is NOT applied: Codex registers MCP servers in
 *    $CODEX_HOME/config.toml (or `-c mcp_servers.<name>.*` overrides passed via
 *    extra.configOverrides). The user's config file is read by default here
 *    (extra.ignoreUserConfig defaults to false for chat) so those servers load;
 *  - `tools` is ignored (no built-in tool allowlist on Codex);
 *  - usage per turn is the cumulative diff against the previous turn; seed
 *    extra.usageBaseline when resuming a thread whose totals you know.
 */
export function createCodexChat(opts: ChatOptions, deps: ChatDeps): ChatSession {
  const listeners = new Set<(e: ChatEvent) => void>();
  const emit = (e: ChatEvent): void => {
    for (const fn of listeners) { try { fn(e); } catch { /* a listener must not break the session */ } }
  };
  const mapper = new CodexChatEventMapper(opts.resume ?? null, usageBaseline(opts.extra));
  let current: ChildLike | null = null;
  let closed = false;
  let firstTurn = true;
  let warnedMcp = false;

  const runTurn = (prompt: string): Promise<void> => new Promise((resolve) => {
    const extra: Record<string, unknown> = { ...(opts.extra ?? {}), ignoreUserConfig: opts.extra?.ignoreUserConfig ?? false };
    const args = codexArgs({
      cwd: opts.cwd,
      model: opts.model,
      effort: opts.effort,
      sandbox: typeof extra.sandbox === 'string' ? (extra.sandbox as Sandbox) : 'workspace-write',
      session: mapper.sessionId ? { mode: 'resume', base: mapper.sessionId } : { mode: 'new' },
      extra,
    });
    const env = codexEnv({ env: opts.env, extra }, deps.env);
    let child: ChildLike;
    try {
      child = deps.spawnFn(deps.bin, args, { cwd: opts.cwd, shell: false, windowsHide: true, env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      emit({ type: 'error', message: `codex exec (spawn) returned no JSON result: ${(e as Error).message}`, verdict: classifyCodexFailure('returned no JSON result') });
      resolve();
      return;
    }
    current = child;
    deps.registry.add(child);
    const framer = new NdjsonFramer();
    let sawJson = false;
    let tail = '';
    let settled = false;
    const onEvent = (ev: Record<string, unknown>): void => {
      sawJson = true;
      for (const e of mapper.map(ev)) emit(e);
    };
    const onLine = (line: string): void => {
      opts.transcriptSink?.(line);
      if (!line.startsWith('{')) tail = (tail + line + '\n').slice(-OUTPUT_TAIL_CHARS);
    };
    const settle = (code: number | null, err?: Error): void => {
      if (settled) return;
      settled = true;
      for (const ev of framer.flush(onLine)) onEvent(ev);
      deps.registry.delete(child);
      if (current === child) current = null;
      if (err || !sawJson) {
        const message = `codex exec (${err ? 'spawn' : code}) returned no JSON result: ${(err?.message ?? tail).trim().slice(-400)}`;
        emit({ type: 'error', message, verdict: classifyCodexFailure(message) });
      }
      resolve();
    };
    child.stdout?.on('data', (b) => { for (const ev of framer.push(String(b), onLine)) onEvent(ev); });
    child.stderr?.on('data', (b) => { tail = (tail + String(b)).slice(-OUTPUT_TAIL_CHARS); });
    child.on('error', (e) => settle(null, e));
    child.on('close', (code) => settle(code));
    try {
      child.stdin?.write(prompt);
      child.stdin?.end();
    } catch { /* close handler reports */ }
  });

  return {
    harness: 'codex',
    get sessionId() { return mapper.sessionId; },
    async send(text: string): Promise<void> {
      if (closed) throw new Error('codex chat session is closed');
      if (current) throw new Error('a codex turn is already in flight');
      if (opts.mcpConfig && !warnedMcp) {
        warnedMcp = true;
        emit({ type: 'status', message: 'mcpConfig ignored: Codex registers MCP servers in $CODEX_HOME/config.toml (or -c mcp_servers.* via extra.configOverrides)' });
      }
      const prompt = firstTurn && opts.systemPrompt ? `${opts.systemPrompt}\n\n${text}` : text;
      firstTurn = false;
      await runTurn(prompt);
    },
    async interrupt(): Promise<void> {
      if (current) treeKill(current);
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      if (current) treeKill(current);
      emit({ type: 'closed', exitCode: null });
    },
    on(fn) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
  };
}

export const codexHarness: Harness = createCodexHarness();
