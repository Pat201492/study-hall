import { spawn, type SpawnOptions } from 'node:child_process';
import { homedir } from 'node:os';
import type {
  ChildLike, FailureVerdict, Harness, HarnessCapabilities, HarnessRunOptions, HarnessRunResult,
  PreflightResult, Provider, SessionSpec, SpawnLike, Usage,
} from '../contract.js';
import { ZERO_USAGE } from '../contract.js';
import { attachGuards } from '../guards.js';
import { NdjsonFramer, num } from '../ndjson.js';
import { ChildRegistry, npmPackageExe, resolveBin, treeKill } from '../proc.js';

// The OpenCode adapter — ported from claude-study-room's src/openCodeHarness.ts
// (#299/#307) onto the v2 contract, and the local/metered lane's first run with
// the guards the Claude lane always had.
//
// Everything measured below was verified by running the real binary
// (`opencode-ai@1.18.30`) against a local Ollama model on this machine, not read
// off a comparison table. That distinction earned its keep: the widely-cited
// table lists Claude Code as Windows-"Limited" and metered-key-only, and both
// are wrong for this host.
//
// WHAT THIS LANE CAN AND CANNOT BE
//
// It cannot ride the Pro/Max subscription. Anthropic's compliance docs state
// OAuth login is "intended exclusively" for native subscription use and that
// they do not permit third-party developers to route requests through Free, Pro
// or Max credentials; OpenCode removed its Anthropic subscription plugins in
// v1.3.0 after a legal request. So this harness means a LOCAL model or a metered
// key — never the plan the rest of the engine rides. That is why it registers on
// its own `local` provider (credentialKind 'none', meter 'local') rather than on
// the Anthropic one: the registry refuses a prohibited pairing, and this pairing
// must never look like one.
//
// Local is viable but hardware-bound, and the bound is sharper than it looks.
// A trivial "Say OK" run costs 6,472 INPUT tokens before the model writes
// anything, because the agent's system prompt and tool schemas are the floor.
// Measured here: qwen2.5:3b answered in 10.5s; qwen2.5:7b did not finish the
// same prompt in five minutes, twice. The lane's ceiling is prompt-eval
// throughput on whatever hardware is also running the warm Claude pool.
//
// WHAT CHANGED FROM V1 (each item is a pain point the harness research logged)
//
//  - Parsing is INCREMENTAL. v1 re-parsed the entire accumulated stdout on every
//    data chunk to report live usage — O(n²) in stream length, on a lane whose
//    floor is 6,472 tokens of preamble. NdjsonFramer carries the partial line
//    and each event is handled exactly once.
//  - The idle watchdog and the budget stop now apply here. v1 wired only
//    stdout/stderr/error/close, so the two guards that exist because of real
//    12-hour hangs and runaway sessions protected only the Claude lane.
//    attachGuards gives both to this lane, so `budgetStop` is finally TRUE.
//  - The no-result rejection says `returned no JSON result`. v1 said `no JSON
//    result` in the belief it matched the infra classifier, and it never did:
//    a crashed local model was read as a task that made no progress. The
//    wording is now bound to classifyFailure by a test in this package.
//  - `reasoning` tokens have their own field. v1 folded them into outputTokens
//    because the four-field shape had nowhere else to put them; v2's Usage does.

/** Wire format: OpenCode emits one JSON event per line on stdout. The event's
 *  `type` uses underscores (`step_finish`), the part's `type` uses hyphens
 *  (`step-finish`); the part is what carries the payload, so parse off that. */
export interface OpenCodeEvent {
  type?: string;
  timestamp?: number;
  sessionID?: string;
  part?: {
    type?: string;
    text?: string;
    sessionID?: string;
    reason?: string;
    tokens?: StepTokens;
    /** Present on the real step-finish (`"cost":0` on a local model). */
    cost?: number;
  };
}

export interface StepTokens {
  total?: number; input?: number; output?: number; reasoning?: number;
  cache?: { read?: number; write?: number };
}

/**
 * What this harness can actually do. Every `false` is a measured refusal rather
 * than a gap nobody looked into — under-claiming costs a slower run, over-
 * claiming corrupts the arena's numbers.
 *
 *   warmSessions     TRUE since #307. `-s <id> --fork` is a real analogue of
 *                    `--resume --fork-session`, and a warm slot ADOPTS the id
 *                    the first run returns instead of asserting one up front.
 *
 *   seedableSessions FALSE, and this is the distinction #307 exists to draw.
 *                    OpenCode's session id is SERVER-ASSIGNED — it comes back in
 *                    the run's output and cannot be chosen the way
 *                    `claude --session-id <uuid>` chooses one. Emitting a uuid we
 *                    invented would resume a session the server never issued.
 *                    Conflating these two questions into one flag is what made
 *                    this lane run cold and pay repo ramp-up on every task.
 *
 *   forkSessions     TRUE: `--fork` off `-s <base>` is the per-task wipe.
 *
 *   cacheUsageSplit  TRUE. step-finish carries tokens.cache.read and .write
 *                    separately, and `input` excludes cache reads exactly as
 *                    Anthropic's shape does — verified against a real run where
 *                    input 6472 + output 2 + cache.read 5 == total 6479. So rows
 *                    from this harness are fidelity 'exact'.
 *
 *   usageIsCumulative FALSE — believed, not measured. Each step-finish is one
 *                    model call and (on AI-SDK step semantics) reports THAT
 *                    call's tokens, so summing steps is the billed total. But the
 *                    only real capture (opencode-ai@1.18.30, "Say OK") had ONE
 *                    step-finish, so per-step vs running-total was never
 *                    observed. TODO: capture a multi-step run; if step N's
 *                    `input` already includes step N-1's, flip this flag and diff
 *                    against the previous step in addStepTokens.
 *
 *   reportsCost      TRUE. The real step-finish part carries `cost` (0 on a
 *                    local model — an honest zero, not a missing figure; a
 *                    metered key prices it from OpenCode's model table).
 *
 *   toolAllowlist    FALSE. OpenCode does support restricting tools, but through
 *                    `opencode.json` (`tools: { [name]: boolean }`), not per-run
 *                    argv — so this adapter cannot honour `opts.tools`. Declaring
 *                    TRUE and quietly ignoring the list is precisely the silent
 *                    over-claim the capability block exists to prevent: the
 *                    engine would believe it had trimmed the per-turn schema tax
 *                    it measured at 11,382 tokens/turn while every student ran
 *                    the full surface. mcpToolAllowlist is false for the same
 *                    reason (MCP servers are config, not argv).
 *
 *   effortControl    FALSE: no reasoning-effort flag on `opencode run`.
 *   sandboxModes     ['none']: no sandbox flag; the worktree is the boundary.
 *   promptTransport  'argv': the prompt is the last positional (see openCodeArgs).
 *   streamsUsage     TRUE: a step-finish arrives after every model call.
 *   budgetStop       TRUE: the generic guard enforces StudentBudget mid-run and
 *                    the stop RESOLVES with partial work banked (v1 declared
 *                    false because nothing in the CLI exposes a ceiling; the
 *                    ceiling now lives in the adapter, where it always could).
 *   chat             'none': no interactive transport on this lane.
 */
export const OPENCODE_CAPABILITIES: HarnessCapabilities = {
  warmSessions: true,
  seedableSessions: false,
  forkSessions: true,
  cacheUsageSplit: true,
  usageIsCumulative: false,
  reportsCost: true,
  toolAllowlist: false,
  mcpToolAllowlist: false,
  effortControl: false,
  sandboxModes: ['none'],
  promptTransport: 'argv',
  streamsUsage: true,
  cancellable: true,
  transcripts: true,
  budgetStop: true,
  contextCompaction: false,
  chat: 'none',
};

/** The provider this harness runs on: a local model or a metered key, never a
 *  consumer subscription. No credential to check, so preflight's authOk is
 *  about the binary answering, not a login. */
export const localProvider: Provider = {
  id: 'local',
  label: 'Local / metered (OpenCode)',
  credentialKind: 'none',
  automationStance: 'sanctioned',
  meter: 'local',
};

/**
 * Fold one step-finish's tokens into the running total.
 *
 * `reasoning` is generated text the provider bills as output, but it lands in
 * its own field: v1 folded it into outputTokens because the four-field shape had
 * no reasoning bucket, which made this lane's output figure incomparable with
 * Codex's (which reports reasoning separately too). Dropping it is still the
 * one direction a mapping error must not go — it would under-report this
 * harness's spend and flatter it in the arena comparison.
 */
export function addStepTokens(acc: Usage, tokens: StepTokens): Usage {
  return {
    inputTokens: acc.inputTokens + num(tokens.input),
    outputTokens: acc.outputTokens + num(tokens.output),
    cacheReadInputTokens: acc.cacheReadInputTokens + num(tokens.cache?.read),
    cacheCreationInputTokens: acc.cacheCreationInputTokens + num(tokens.cache?.write),
    reasoningTokens: acc.reasoningTokens + num(tokens.reasoning),
  };
}

export type ParsedOpenCodeEvent =
  | { kind: 'text'; text: string; sessionId: string }
  | { kind: 'step-finish'; tokens: StepTokens | null; cost: number | null; sessionId: string }
  | { kind: 'other'; sessionId: string };

/** Classify one parsed NDJSON event. Pure; the run loop folds the result. */
export function parseOpenCodeEvent(raw: Record<string, unknown>): ParsedOpenCodeEvent {
  const ev = raw as OpenCodeEvent;
  const part = ev.part;
  const sessionId = (typeof part?.sessionID === 'string' && part.sessionID)
    || (typeof ev.sessionID === 'string' ? ev.sessionID : '');
  if (part?.type === 'text' && typeof part.text === 'string') {
    return { kind: 'text', text: part.text, sessionId };
  }
  if (part?.type === 'step-finish') {
    const tokens = part.tokens && typeof part.tokens === 'object' ? part.tokens : null;
    const cost = typeof part.cost === 'number' && Number.isFinite(part.cost) ? part.cost : null;
    return { kind: 'step-finish', tokens, cost, sessionId };
  }
  return { kind: 'other', sessionId };
}

/**
 * Build the argv for one run.
 *
 * The prompt is a POSITIONAL argument here, unlike `claude -p` which takes it on
 * stdin. That is why this adapter spawns with `shell: false`: a model-authored
 * prompt containing `&`, `|`, `%` or a quote would be parsed by the shell rather
 * than passed through. With no shell, argv entries are literal.
 *
 * Session handling is the #307 distinction in argv: `resume`/`fork` carry an
 * ADOPTED id — one this harness handed back from an earlier run — so it is safe
 * to resume. A `new` spec's `seed` is a caller-CHOSEN id and is deliberately
 * dropped: the server never issued it, and resuming it would either error or
 * silently start something new while the slot believed it was warm. `--fork`
 * without a base is meaningless and is never emitted.
 *
 * `tools`, `effort` and `sandbox` are not consulted — the capability block says
 * so, and the caller adapts visibly rather than this adapter guessing.
 */
export function openCodeArgs(prompt: string, opts: HarnessRunOptions): string[] {
  const auto = (opts.approval ?? 'never') === 'never';
  return [
    'run', '--format', 'json',
    ...(auto ? ['--auto'] : []),
    '--dir', opts.cwd,
    ...(opts.model ? ['-m', opts.model] : []),
    ...sessionArgs(opts.session),
    prompt,
  ];
}

function sessionArgs(session?: SessionSpec): string[] {
  if (!session || session.mode === 'new' || !session.base) return [];
  return ['-s', session.base, ...(session.mode === 'fork' ? ['--fork'] : [])];
}

function refuseShim(path: string): never {
  throw new Error(
    `opencode resolved to a .cmd/.bat shim (${path}), which Node refuses to spawn without a shell ` +
    '(CVE-2024-27980) and this adapter never puts a model-authored prompt through one. ' +
    'Point OPENCODE_BIN at the real executable, e.g. <npm-global>/node_modules/opencode-ai/bin/opencode.exe.',
  );
}

/**
 * Where the binary comes from.
 *
 * The real constraint is Windows plus `shell: false`. What npm puts on PATH is a
 * `.cmd` shim, and Node refuses to spawn `.bat`/`.cmd` without a shell (the
 * CVE-2024-27980 hardening). Going back to `shell: true` to work around that
 * would reintroduce exactly the injection surface this adapter avoids by
 * refusing to put a model-authored prompt through a shell. Fortunately the
 * package ships a REAL executable next to the shim, so the fix is to find it:
 * `<npm-global>/node_modules/opencode-ai/bin/opencode.exe`.
 *
 * Order: an explicit OPENCODE_BIN wins (an operator's deliberate choice is not
 * second-guessed — but a shim is refused loudly, not spawned through a shell),
 * then the packaged executable, then a concrete PATH hit. A bare name is the
 * last resort and fails at spawn with `spawn opencode ENOENT`, which
 * classifyFailure reads as infra rather than charging the item.
 */
export function openCodeBin(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const pinned = (env.OPENCODE_BIN || '').trim();
  if (pinned) {
    const r = resolveBin(pinned, env, home);
    return r.isShim ? refuseShim(r.path) : r.path;
  }
  const packaged = npmPackageExe(
    'opencode-ai',
    process.platform === 'win32' ? 'bin/opencode.exe' : 'bin/opencode',
    env,
    home,
  );
  if (packaged) return packaged;
  const r = resolveBin('opencode', env, home);
  return r.isShim ? refuseShim(r.path) : r.path;
}

const INFRA_RE = /returned no JSON result|spawn \S+ ENOENT|ETXTBSY|connection refused|ECONNREFUSED|model is loading|no such model/i;
const CAPACITY_RE = /rate_limit_exceeded|insufficient_quota|rate limit|429|overloaded|capacity|try again later/i;

/**
 * Whose fault was a failure? `infra` is the environment never running the
 * student (a crashed CLI, Ollama down, the model not pulled); `capacity` is a
 * metered key's provider being busy; everything else — including a context-
 * length overflow, which the task's own size caused — is charged to the task.
 * A local model has no reset clock, so `resetAt` is never set here.
 */
export function classifyOpenCodeFailure(message: string): FailureVerdict {
  const detail = message.trim().slice(0, 300);
  if (INFRA_RE.test(message)) return { kind: 'infra', detail };
  if (CAPACITY_RE.test(message)) return { kind: 'capacity', detail };
  return { kind: 'task', detail };
}

export interface OpenCodeDeps {
  /** Resolves the executable. Lazy, so a missing install fails at run time with
   *  a clear message rather than at import. Defaults to openCodeBin(env). */
  bin?: () => string;
  spawnFn?: SpawnLike;
  /** Base environment for the child and for binary resolution (process.env). */
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

const nodeSpawn: SpawnLike = (bin, args, opts) => spawn(bin, args, opts as SpawnOptions) as unknown as ChildLike;

const PREFLIGHT_TIMEOUT_MS = 30_000;

export function createOpenCodeHarness(deps: OpenCodeDeps = {}): Harness {
  const env = (): NodeJS.ProcessEnv => deps.env ?? process.env;
  const resolveExe = deps.bin ?? (() => openCodeBin(env()));
  const now = deps.now ?? Date.now;
  const registry = new ChildRegistry();

  function run(prompt: string, opts: HarnessRunOptions): Promise<HarnessRunResult> {
    const spawnFn = opts.spawnFn ?? deps.spawnFn ?? nodeSpawn;
    // Resolve before the promise so a shim/ENOENT surfaces as a rejection of the
    // same promise the caller awaits, never as a synchronous throw from run().
    return new Promise<HarnessRunResult>((resolve, reject) => {
      let bin: string;
      try { bin = resolveExe(); } catch (e) { reject(e instanceof Error ? e : new Error(String(e))); return; }
      const args = openCodeArgs(prompt, opts);
      const started = now();
      const child = spawnFn(bin, args, {
        cwd: opts.cwd, shell: false, windowsHide: true, env: { ...env(), ...opts.env },
      });
      registry.add(child);
      // Nothing is written to stdin — the prompt is argv. Closing it stops the
      // CLI waiting on a stream that will never carry anything.
      child.stdin?.end();

      const guards = attachGuards(child, {
        idleTicks: opts.idleTicks,
        budget: opts.budget,
        signal: opts.signal,
        setIntervalFn: opts.setIntervalFn,
        onIdleKill: opts.onIdleKill,
        onBudgetStop: opts.onBudgetStop,
      });

      const framer = new NdjsonFramer();
      const text: string[] = [];
      let usage: Usage = { ...ZERO_USAGE };
      let cost: number | null = null;
      let sessionId = '';
      let turns = 0;
      let sawResult = false;
      let lastResult: Record<string, unknown> | undefined;
      let stdoutTail = '';
      let stderrTail = '';
      let settled = false;

      const handleEvent = (ev: Record<string, unknown>): void => {
        // Once the budget has tripped this run is over; the tree-kill is in
        // flight but events already buffered in the pipe still arrive. Counting
        // them would report a turn count higher than the cap we enforced.
        if (guards.stoppedBy) return;
        const parsed = parseOpenCodeEvent(ev);
        sessionId ||= parsed.sessionId;
        if (parsed.kind === 'text') {
          text.push(parsed.text);
          // The newest thing the model said is the only record of WHY a stalled
          // student stalled; it rides along in the idle rejection.
          guards.noteText(parsed.text);
          return;
        }
        if (parsed.kind !== 'step-finish') return;
        sawResult = true;
        turns++;
        lastResult = ev;
        if (parsed.tokens) usage = addStepTokens(usage, parsed.tokens);
        if (parsed.cost != null) cost = (cost ?? 0) + parsed.cost;
        // Usage is reported BEFORE the budget check so the caller's last live
        // figure is the one the stop is justified by.
        opts.onUsage?.({ ...usage });
        guards.noteUsage(turns, usage.inputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens);
      };

      child.stdout?.on('data', (d: Buffer | string) => {
        guards.noteOutput();
        const s = String(d);
        stdoutTail = (stdoutTail + s).slice(-2000);
        for (const ev of framer.push(s, opts.transcriptSink)) handleEvent(ev);
      });
      child.stderr?.on('data', (d: Buffer | string) => {
        guards.noteOutput();
        stderrTail = (stderrTail + String(d)).slice(-2000);
      });

      const finish = (): boolean => {
        if (settled) return false;
        settled = true;
        guards.stop();
        registry.delete(child);
        return true;
      };

      child.on('error', (e: Error) => {
        if (!finish()) return;
        reject(new Error(`opencode failed to start: ${e.message}`));
      });

      child.on('close', (code: number | null) => {
        if (!finish()) return;
        for (const ev of framer.flush(opts.transcriptSink)) handleEvent(ev);
        const durationMs = now() - started;

        // Killed for silence: reject so the item is retried, carrying the last
        // thing the model said so an environmental stall (Ollama announcing a
        // load failure and then hanging) still reaches classifyFailure.
        if (guards.killedIdle) {
          const why = guards.lastText ? ` Last message: ${guards.lastText.slice(0, 300)}` : '';
          reject(new Error(
            `opencode produced no output for ${guards.idleTicks} consecutive minute(s) — killed as stalled.${why}`,
          ));
          return;
        }

        // A budget stop (or a cancel) RESOLVES rather than rejects, and that
        // asymmetry is the whole point. We killed this process on purpose, so
        // there may be no step-finish and the check below would read it as a
        // crash — but the model's edits are sitting in the worktree, and the
        // caller's success path is what commits and pushes them. Rejecting
        // would skip that path and the next dispatch would wipe the work.
        const partial = (stoppedBy: 'budget' | 'cancelled', marker: string): HarnessRunResult => ({
          text: `[${marker} after ${turns} turn(s) — this is PARTIAL work, not a finished task]`,
          usage, sessionId, turns, stoppedBy, costUsd: cost, meter: 'local', durationMs,
          exitCode: code, raw: lastResult,
        });
        if (guards.stoppedBy) { resolve(partial('budget', `stopped by the ${guards.stoppedBy} budget`)); return; }
        if (guards.cancelled) { resolve(partial('cancelled', 'cancelled')); return; }

        // A run with no terminal step-finish produced no usable answer, whatever
        // the exit code says. The wording is the contract the infra classifier
        // keys on — see classifyOpenCodeFailure and the test binding the two.
        if (!sawResult) {
          const tail = (stderrTail || stdoutTail).trim().slice(-500) || '(no output)';
          reject(new Error(`opencode (${code}) returned no JSON result: ${tail}`));
          return;
        }

        resolve({
          text: text.join(''),
          usage, sessionId, turns, costUsd: cost, meter: 'local', durationMs,
          exitCode: code, raw: lastResult,
        });
      });
    });
  }

  async function preflight(opts: { spawnFn?: SpawnLike; cwd?: string } = {}): Promise<PreflightResult> {
    let bin: string;
    try {
      bin = resolveExe();
    } catch (e) {
      return { ok: false, bin: 'opencode', authOk: false, detail: e instanceof Error ? e.message : String(e) };
    }
    const spawnFn = opts.spawnFn ?? deps.spawnFn ?? nodeSpawn;
    return new Promise<PreflightResult>((resolve) => {
      let child: ChildLike;
      try {
        child = spawnFn(bin, ['--version'], { cwd: opts.cwd, shell: false, windowsHide: true, env: env() });
      } catch (e) {
        resolve({ ok: false, bin, authOk: false, detail: `opencode failed to start: ${e instanceof Error ? e.message : String(e)}` });
        return;
      }
      child.stdin?.end();
      let out = '';
      let err = '';
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        treeKill(child);
        resolve({ ok: false, bin, authOk: false, detail: `${bin} --version produced nothing in ${PREFLIGHT_TIMEOUT_MS / 1000}s — killed` });
      }, PREFLIGHT_TIMEOUT_MS);
      timer.unref?.();
      child.stdout?.on('data', (d: Buffer | string) => { out += String(d); });
      child.stderr?.on('data', (d: Buffer | string) => { err += String(d); });
      child.on('error', (e: Error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ ok: false, bin, authOk: false, detail: `opencode failed to start: ${e.message}` });
      });
      child.on('close', (code: number | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (code !== 0) {
          resolve({
            ok: false, bin, authOk: false,
            detail: `${bin} --version exited ${code}: ${(err || out).trim().slice(-300) || '(no output)'}`,
          });
          return;
        }
        const version = out.trim() || undefined;
        // No login exists on this lane: a local model or a metered key answers
        // or it does not, and `--version` cannot tell us that. authOk here means
        // "there is no credential to have expired", not "a completion succeeded".
        resolve({
          ok: true, bin, version, authOk: true,
          detail: `${bin} --version ok${version ? ` (${version})` : ''}; no login on the local lane`,
        });
      });
    });
  }

  return {
    id: 'opencode',
    provider: localProvider.id,
    capabilities: OPENCODE_CAPABILITIES,
    run,
    killAll(): void { registry.killAll(); },
    classifyFailure(message: string): FailureVerdict { return classifyOpenCodeFailure(message); },
    preflight,
  };
}

export const openCodeHarness: Harness = createOpenCodeHarness();
