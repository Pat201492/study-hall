import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildLike, QuotaObservation, QuotaSnapshot, SpawnLike, Usage } from '../src/contract.js';
import {
  CLAUDE_CODE_CAPABILITIES, claudeArgs, claudeCodeHarness, createClaudeCodeHarness, parseClaudeResult,
  quotaFromRateLimitEvent,
} from '../src/adapters/claudeCode.js';
import { RESET_MARGIN_MS } from '../src/adapters/claudeReset.js';
import { fidelityFor } from '../src/registry.js';

// ---- a faked child process --------------------------------------------------
// Captures the spawn args + what was written to stdin, then emits scripted
// stdout/stderr and a close code — no real `claude` is ever launched. The fake
// deliberately has NO pid: proc.treeKill() is a no-op without one, so a guard
// that trips cannot `taskkill` a random real process.

interface SpawnCall {
  bin: string;
  args: string[];
  options: { cwd?: string; shell?: boolean; windowsHide?: boolean; env?: NodeJS.ProcessEnv; stdio?: unknown };
  stdin: string;
  ended: boolean;
}

interface FakeChild extends EventEmitter {
  stdin: { write(s: string): void; end(): void };
  stdout: EventEmitter;
  stderr: EventEmitter;
}

function makeChild(): { child: FakeChild; call: SpawnCall } {
  const child = new EventEmitter() as FakeChild;
  const call: SpawnCall = { bin: '', args: [], options: {}, stdin: '', ended: false };
  child.stdin = { write: (s: string) => { call.stdin += s; }, end: () => { call.ended = true; } };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return { child, call };
}

/** Scripted spawn: emits the given output then closes. */
function makeSpawn(result: { stdout?: string; stderr?: string; code?: number | null } = {}) {
  const calls: SpawnCall[] = [];
  const children: FakeChild[] = [];
  const spawnFn: SpawnLike = (bin, args, options) => {
    const { child, call } = makeChild();
    Object.assign(call, { bin, args, options });
    calls.push(call);
    children.push(child);
    setImmediate(() => {
      if (result.stdout) child.stdout.emit('data', Buffer.from(result.stdout));
      if (result.stderr) child.stderr.emit('data', Buffer.from(result.stderr));
      child.emit('close', result.code === undefined ? 0 : result.code);
    });
    return child as unknown as ChildLike;
  };
  return { spawnFn, calls, children };
}

/** Manual spawn: the test drives stdout/close itself. */
function manualSpawn() {
  const calls: SpawnCall[] = [];
  let child!: FakeChild;
  const spawnFn: SpawnLike = (bin, args, options) => {
    const made = makeChild();
    Object.assign(made.call, { bin, args, options });
    calls.push(made.call);
    child = made.child;
    return child as unknown as ChildLike;
  };
  return { spawnFn, calls, get child() { return child; } };
}

/** A fake ticker the test drives by hand, so nothing waits a real minute. */
function manualTicker() {
  const fns: Array<() => void> = [];
  const setIntervalFn = ((fn: () => void) => {
    fns.push(fn);
    return { unref() { /* no-op */ } } as unknown as NodeJS.Timeout;
  }) as unknown as (fn: () => void, ms: number) => NodeJS.Timeout;
  return { setIntervalFn, tick: (n = 1) => { for (let i = 0; i < n; i++) fns.forEach((f) => f()); } };
}

const fakeBin = () => ({ path: 'C:/fake/claude.exe', found: true, isShim: false });
const harness = () => createClaudeCodeHarness({ resolveBin: fakeBin });

const assistantEvent = (id: string, out: number, input = 500, cacheRead = 100, cacheCreate = 10, text?: string) => JSON.stringify({
  type: 'assistant',
  message: {
    id,
    content: text ? [{ type: 'text', text }] : [],
    usage: {
      output_tokens: out, input_tokens: input,
      cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheCreate,
    },
  },
});

const initEvent = (over: Record<string, unknown> = {}) => JSON.stringify({
  type: 'system', subtype: 'init', session_id: 'sess-init', model: 'claude-opus-4-8', tools: ['Bash'],
  capabilities: ['interrupt_receipt_v1'], ...over,
});

const resultEvent = (over: Record<string, unknown> = {}) => JSON.stringify({
  type: 'result', subtype: 'success', is_error: false,
  result: 'done', session_id: 'sess-9', num_turns: 3,
  duration_ms: 4200, duration_api_ms: 3900, total_cost_usd: 0.0123,
  usage: { output_tokens: 999, input_tokens: 888, cache_read_input_tokens: 777, cache_creation_input_tokens: 666 },
  modelUsage: {
    'claude-opus-4-8': { inputTokens: 10, outputTokens: 40, cacheReadInputTokens: 30000, cacheCreationInputTokens: 2000, thinkingTokens: 12, costUSD: 0.01 },
    'claude-haiku-4-5': { inputTokens: 5, outputTokens: 20, cacheReadInputTokens: 1000, cacheCreationInputTokens: 100, costUSD: 0.0023 },
  },
  ...over,
});

const rateLimitEvent = (over: Record<string, unknown> = {}) => JSON.stringify({
  type: 'rate_limit_event',
  rate_limit_info: {
    status: 'allowed', rateLimitType: 'five_hour', resetsAt: 1789415400,
    unifiedWindows: {
      five_hour: { utilization: 0.14, resetsAt: 1789415400 },
      seven_day: { utilization: 0.2, resetsAt: 1789585200 },
    },
    overageStatus: 'rejected', overageDisabledReason: 'org_level_disabled',
    ...over,
  },
  uuid: 'u', session_id: 'sess-9',
});

// ---- capabilities and argv ----------------------------------------------------

test('claude-code declares the capabilities the spikes verified', () => {
  assert.equal(claudeCodeHarness.id, 'claude-code');
  assert.equal(claudeCodeHarness.provider, 'anthropic');
  assert.equal(claudeCodeHarness.capabilities, CLAUDE_CODE_CAPABILITIES);
  assert.equal(CLAUDE_CODE_CAPABILITIES.warmSessions, true);
  assert.equal(CLAUDE_CODE_CAPABILITIES.seedableSessions, true);
  assert.equal(CLAUDE_CODE_CAPABILITIES.forkSessions, true);
  assert.equal(CLAUDE_CODE_CAPABILITIES.usageIsCumulative, false);
  assert.equal(CLAUDE_CODE_CAPABILITIES.streamsUsage, true);
  assert.equal(CLAUDE_CODE_CAPABILITIES.budgetStop, true);
  assert.equal(CLAUDE_CODE_CAPABILITIES.chat, 'stream-json');
  assert.equal(fidelityFor(CLAUDE_CODE_CAPABILITIES), 'exact');
  assert.equal(typeof claudeCodeHarness.chat, 'function', 'chat is present iff capabilities.chat !== none');
});

test('claudeArgs: the byte-stable default shape', () => {
  assert.deepEqual(claudeArgs({}), ['-p', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions']);
});

test('claudeArgs: every option in its fixed position', () => {
  assert.deepEqual(claudeArgs({
    approval: 'never', model: 'claude-opus-4-8', effort: 'high', tools: ['Bash', 'Read', 'Edit'],
    session: { mode: 'new', seed: 'uuid-1' },
  }), [
    '-p', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions',
    '--model', 'claude-opus-4-8', '--effort', 'high', '--tools', 'Bash', 'Read', 'Edit', '--session-id', 'uuid-1',
  ]);
});

test('claudeArgs: on-request approval maps to acceptEdits, never --bare', () => {
  const a = claudeArgs({ approval: 'on-request' });
  assert.deepEqual(a, ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits']);
  assert.ok(!a.includes('--bare'), '--bare drops OAuth and takes the pool off the subscription');
});

test('claudeArgs: session modes', () => {
  const tail = (o: Parameters<typeof claudeArgs>[0]) => claudeArgs(o).slice(5);
  assert.deepEqual(tail({ session: { mode: 'new', seed: 'a' } }), ['--session-id', 'a']);
  assert.deepEqual(tail({ session: { mode: 'new' } }), [], 'new without a seed emits nothing');
  assert.deepEqual(tail({ session: { mode: 'resume', base: 'b' } }), ['--resume', 'b']);
  assert.deepEqual(tail({ session: { mode: 'fork', base: 'b' } }), ['--resume', 'b', '--fork-session']);
  assert.deepEqual(tail({}), []);
});

test('claudeArgs: each tool is its own argv entry, never comma-joined; empty leaves the CLI default', () => {
  const a = claudeArgs({ tools: ['Bash', 'Read', 'Edit'] });
  const i = a.indexOf('--tools');
  assert.ok(i >= 0);
  assert.deepEqual(a.slice(i + 1, i + 4), ['Bash', 'Read', 'Edit']);
  assert.ok(!a.some((x) => x.includes(',')), 'a single comma-joined argument would read as one tool named "Bash,Read,Edit"');
  for (const tools of [undefined, [] as string[]]) {
    assert.ok(!claudeArgs({ tools }).includes('--tools'), 'an empty knob must never strand a student with no tools');
  }
});

// ---- spawn shape ------------------------------------------------------------------

test('run spawns the resolved binary with shell:false, pipes, merged env, and the prompt on stdin (then EOF)', async () => {
  const { spawnFn, calls } = makeSpawn({ stdout: `${resultEvent()}\n` });
  const r = await harness().run('do the thing', {
    cwd: '/wt', model: 'claude-opus-4-8', tools: ['Bash'], session: { mode: 'new', seed: 'uuid-1' },
    env: { STUDY_HALL_LANE: 'a' }, spawnFn,
  });
  const c = calls[0];
  assert.equal(c.bin, 'C:/fake/claude.exe');
  assert.deepEqual(c.args, claudeArgs({ model: 'claude-opus-4-8', tools: ['Bash'], session: { mode: 'new', seed: 'uuid-1' } }));
  assert.equal(c.options.cwd, '/wt');
  assert.equal(c.options.shell, false);
  assert.equal(c.options.windowsHide, true);
  assert.deepEqual(c.options.stdio, ['pipe', 'pipe', 'pipe']);
  assert.equal(c.options.env?.STUDY_HALL_LANE, 'a');
  assert.equal(c.options.env?.PATH ?? c.options.env?.Path, process.env.PATH ?? process.env.Path, 'process.env is the base');
  assert.equal(c.stdin, 'do the thing');
  assert.equal(c.ended, true, 'stdin must be ended or the CLI waits forever');
  assert.equal(r.text, 'done');
});

test('deps.spawnFn is the default and opts.spawnFn wins over it', async () => {
  const dep = makeSpawn({ stdout: `${resultEvent({ result: 'from-deps' })}\n` });
  const h = createClaudeCodeHarness({ resolveBin: fakeBin, spawnFn: dep.spawnFn });
  assert.equal((await h.run('p', { cwd: '/w' })).text, 'from-deps');
  const per = makeSpawn({ stdout: `${resultEvent({ result: 'from-opts' })}\n` });
  assert.equal((await h.run('p', { cwd: '/w', spawnFn: per.spawnFn })).text, 'from-opts');
  assert.equal(dep.calls.length, 1);
});

// ---- result parsing -----------------------------------------------------------------

test('parseClaudeResult sums modelUsage across models (subagent-inclusive) and keeps the raw event', () => {
  const evt = JSON.parse(resultEvent()) as Record<string, unknown>;
  const r = parseClaudeResult(evt);
  assert.deepEqual(r.usage, {
    inputTokens: 15, outputTokens: 60, cacheReadInputTokens: 31000, cacheCreationInputTokens: 2100, reasoningTokens: 0,
  });
  assert.equal(r.costUsd, 0.0123);
  assert.equal(r.turns, 3);
  assert.equal(r.durationMs, 4200);
  assert.equal(r.apiDurationMs, 3900);
  assert.equal(r.sessionId, 'sess-9');
  assert.equal(r.isError, false);
  assert.equal(r.raw, evt);
  assert.equal((r.raw as { modelUsage: Record<string, { thinkingTokens?: number }> }).modelUsage['claude-opus-4-8'].thinkingTokens, 12,
    'thinking stays in raw; Claude bills it as output');
});

test('parseClaudeResult falls back to the legacy usage block and live turn count', () => {
  const r = parseClaudeResult({ type: 'result', result: 'x', usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3 } }, { turns: 7 });
  assert.deepEqual(r.usage, { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 3, cacheCreationInputTokens: 0, reasoningTokens: 0 });
  assert.equal(r.turns, 7);
  assert.equal(r.costUsd, null);
});

test('parseClaudeResult reads an error result: errors[] as text, api_error_status, subtype', () => {
  const r = parseClaudeResult({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['boom', 'again'], api_error_status: 429 });
  assert.equal(r.isError, true);
  assert.equal(r.text, 'boom; again');
  assert.equal(r.apiErrorStatus, 429);
  assert.equal(r.subtype, 'error_during_execution');
});

test('the final result event supplies text, usage, cost, timings, session and the init model', async () => {
  const { spawnFn } = makeSpawn({ stdout: `${initEvent()}\n${assistantEvent('m1', 10)}\n${resultEvent()}\n` });
  const r = await harness().run('p', { cwd: '/w', spawnFn });
  assert.equal(r.text, 'done');
  assert.equal(r.sessionId, 'sess-9');
  assert.equal(r.turns, 3, 'num_turns wins over the live count');
  assert.equal(r.costUsd, 0.0123);
  assert.equal(r.meter, 'subscription');
  assert.equal(r.durationMs, 4200);
  assert.equal(r.apiDurationMs, 3900);
  assert.equal(r.exitCode, 0);
  assert.equal(r.model, 'claude-opus-4-8');
  assert.equal(r.stoppedBy, undefined);
  assert.deepEqual(r.usage, { inputTokens: 15, outputTokens: 60, cacheReadInputTokens: 31000, cacheCreationInputTokens: 2100, reasoningTokens: 0 });
  assert.equal((r.raw as { type: string }).type, 'result');
});

test('repeated system/init (one per turn) and unknown event types are tolerated', async () => {
  const noise = [
    initEvent({ model: 'first' }),
    JSON.stringify({ type: 'system', subtype: 'hook_started', hook: 'SessionStart' }),
    JSON.stringify({ type: 'system', subtype: 'thinking_tokens', tokens: 3 }),
    JSON.stringify({ type: 'some_future_event', payload: { deep: [1, 2] } }),
    'warning: not json at all',
    initEvent({ model: 'second' }),
    resultEvent(),
  ].join('\n');
  const { spawnFn } = makeSpawn({ stdout: `${noise}\n` });
  const r = await harness().run('p', { cwd: '/w', spawnFn });
  assert.equal(r.text, 'done');
  assert.equal(r.model, 'second', 'the newest init wins');
});

test('events split across chunk boundaries are reassembled, and a final unterminated line is flushed', async () => {
  const m = manualSpawn();
  const line = resultEvent();
  const p = harness().run('p', { cwd: '/w', spawnFn: m.spawnFn });
  m.child.stdout.emit('data', Buffer.from(line.slice(0, 20)));
  m.child.stdout.emit('data', Buffer.from(line.slice(20)));   // no trailing newline
  m.child.emit('close', 0);
  assert.equal((await p).text, 'done');
});

// A CLI build that ignores --output-format stream-json prints one blob. Failing
// every student on a format we merely expected would be worse than parsing it.
test('falls back to a single JSON blob when no result event is streamed', async () => {
  const blob = JSON.stringify({ result: 'legacy', session_id: 's1', usage: {} });
  const { spawnFn } = makeSpawn({ stdout: blob });
  const r = await harness().run('p', { cwd: '/w', spawnFn });
  assert.equal(r.text, 'legacy');
  assert.equal(r.sessionId, 's1');
  assert.deepEqual(r.usage, { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, reasoningTokens: 0 });
});

test('transcriptSink receives every raw stdout line, including non-JSON ones', async () => {
  const lines: string[] = [];
  const { spawnFn } = makeSpawn({ stdout: `${initEvent()}\nnoise line\n${resultEvent()}` });
  await harness().run('p', { cwd: '/w', spawnFn, transcriptSink: (l) => lines.push(l) });
  assert.equal(lines.length, 3);
  assert.equal(lines[1], 'noise line');
  assert.ok(lines[2].startsWith('{"type":"result"'), 'the flushed final line is delivered too');
});

// ---- live usage --------------------------------------------------------------------------

test('onUsage fires per message: output accumulates, input/cache take the newest, repeats per id do not double-count', async () => {
  const { spawnFn } = makeSpawn({
    stdout: [
      assistantEvent('m1', 10, 500, 100, 10),
      assistantEvent('m1', 10, 500, 100, 10),      // same message, second content block
      assistantEvent('m2', 25, 600, 200, 0),
      resultEvent(),
    ].join('\n') + '\n',
  });
  const seen: number[][] = [];
  await harness().run('p', { cwd: '/w', spawnFn, onUsage: (u) => seen.push([u.outputTokens, u.inputTokens, u.cacheReadInputTokens, u.reasoningTokens]) });
  // Output is genuinely additive across messages; input and cache are per-message
  // and would double-count the context if summed, so the newest values carry.
  assert.deepEqual(seen, [[10, 500, 100, 0], [10, 500, 100, 0], [35, 600, 200, 0]]);
});

test('onUsage is never called when the task emits no assistant messages', async () => {
  const { spawnFn } = makeSpawn({ stdout: `${resultEvent()}\n` });
  let calls = 0;
  await harness().run('p', { cwd: '/w', spawnFn, onUsage: () => { calls += 1; } });
  assert.equal(calls, 0);
});

// ---- quota -----------------------------------------------------------------------------------

test('quotaFromRateLimitEvent maps unifiedWindows with seconds -> ms', () => {
  const reading = quotaFromRateLimitEvent(JSON.parse(rateLimitEvent()) as Record<string, unknown>, 1_000);
  assert.ok(reading);
  const o = reading.observation;
  assert.equal(o.provider, 'anthropic');
  assert.equal(o.source, 'stream');
  assert.equal(o.observedAt, 1_000);
  assert.deepEqual(o.fiveHour, { utilization: 0.14, resetsAt: 1789415400_000 });
  assert.deepEqual(o.sevenDay, { utilization: 0.2, resetsAt: 1789585200_000 });
  assert.equal(o.allowed, true);
  assert.equal(o.limitingWindow, 'five_hour');
  assert.equal(reading.resetsAt, 1789415400_000);
});

test('quotaFromRateLimitEvent: rejected -> allowed:false; per-model windows land in extra; no status -> allowed:null', () => {
  const rejected = quotaFromRateLimitEvent(JSON.parse(rateLimitEvent({
    status: 'rejected', rateLimitType: 'seven_day_opus',
    unifiedWindows: { five_hour: { utilization: 0.3, resetsAt: 100 }, seven_day_opus: { utilization: 1.0, resetsAt: 200 } },
    resetsAt: 200,
  })) as Record<string, unknown>, 5)!;
  assert.equal(rejected.observation.allowed, false);
  assert.deepEqual(rejected.observation.extra, { seven_day_opus: { utilization: 1.0, resetsAt: 200_000 } });
  assert.equal(rejected.observation.sevenDay, undefined);
  assert.equal(rejected.resetsAt, 200_000);

  const legacy = quotaFromRateLimitEvent({ type: 'rate_limit_event', rate_limit_info: { rateLimitType: 'seven_day', resetsAt: 300, utilization: 0.5 } }, 5)!;
  assert.equal(legacy.observation.allowed, null, 'never infer recovery from a silent event');
  assert.deepEqual(legacy.observation.sevenDay, { utilization: 0.5, resetsAt: 300_000 }, 'pre-unifiedWindows single window is folded in');
  assert.equal(quotaFromRateLimitEvent({ type: 'rate_limit_event' }, 5), null);
});

test('a rate_limit_event reaches onQuota and the injected monitor', async () => {
  const observed: QuotaObservation[] = [];
  const monitor = {
    provider: 'anthropic',
    snapshot: (): QuotaSnapshot => ({ provider: 'anthropic', state: 'unknown' }),
    observe: (o: QuotaObservation) => { observed.push(o); },
    markExhausted: () => {},
    subscribe: () => () => {},
  };
  const h = createClaudeCodeHarness({ resolveBin: fakeBin, quota: monitor, now: () => 42 });
  const seen: QuotaObservation[] = [];
  const { spawnFn } = makeSpawn({ stdout: `${rateLimitEvent()}\n${resultEvent()}\n` });
  await h.run('p', { cwd: '/w', spawnFn, onQuota: (o) => seen.push(o) });
  assert.equal(seen.length, 1);
  assert.equal(observed.length, 1);
  assert.equal(seen[0], observed[0]);
  assert.equal(seen[0].observedAt, 42);
  assert.equal(seen[0].fiveHour?.resetsAt, 1789415400_000);
});

// ---- guards: budget, idle, cancel ---------------------------------------------------------------

// Emits one stream-json assistant event per turn, each with a distinct message
// id (that is what the engine counts as a turn) and a fixed per-turn context.
function turnSpawn(turns: number, ctxPerTurn = 1000) {
  return makeSpawn({
    stdout: Array.from({ length: turns }, (_, i) => assistantEvent(`msg-${i}`, 5, 0, ctxPerTurn, 0)).join('\n')
      + `\n${resultEvent({ result: 'finished normally', session_id: 'sess-ok' })}\n`,
  });
}

// The load-bearing behaviour is NOT the kill; it is that a capped run RESOLVES
// with its partial work instead of rejecting. Only PUSHED work survives a
// retry — a cap that rejected would throw away everything the student did and
// cost the whole session again.
test('a run over the turn cap RESOLVES with partial work and usage, stopping AT the cap', async () => {
  const stops: Array<{ turns: number; tokens: number; limit: string }> = [];
  const { spawnFn } = turnSpawn(50);
  const r = await harness().run('go', { cwd: '/wt', spawnFn, budget: { maxTurns: 10 }, onBudgetStop: (b) => stops.push(b) });
  assert.equal(r.stoppedBy, 'budget');
  assert.equal(r.turns, 10, 'stops AT the cap and ignores events buffered behind the kill');
  assert.match(r.text, /PARTIAL work/, 'the text must warn the reviewer this is unfinished');
  assert.equal(r.usage.cacheReadInputTokens, 1000, 'context of the last message, as live usage reports it');
  assert.equal(r.usage.outputTokens, 50, '10 turns x 5 output tokens, summed');
  assert.equal(r.costUsd, null, 'no result event means the CLI never priced it');
  assert.equal(stops.length, 1, 'fires exactly once, not per buffered event');
  assert.deepEqual(stops[0], { turns: 10, tokens: 10_000, limit: 'maxTurns' });
});

test('a run over the token cap stops on cumulative billed spend', async () => {
  // 1M context per turn: the 8th turn crosses an 8M ceiling.
  const { spawnFn } = turnSpawn(50, 1_000_000);
  const r = await harness().run('go', { cwd: '/wt', spawnFn, budget: { maxTokens: 8_000_000 } });
  assert.equal(r.stoppedBy, 'budget');
  assert.equal(r.turns, 8);
});

test('a run under budget (or with no budget) finishes normally', async () => {
  const a = await harness().run('go', { cwd: '/wt', spawnFn: turnSpawn(5).spawnFn, budget: { maxTurns: 70 } });
  assert.equal(a.stoppedBy, undefined);
  assert.equal(a.text, 'finished normally');
  const b = await harness().run('go', { cwd: '/wt', spawnFn: turnSpawn(120, 1_000_000).spawnFn, budget: { maxTurns: 0, maxTokens: 0 } });
  assert.equal(b.stoppedBy, undefined, 'a zeroed knob is OFF, never an instant stop');
});

// 2026-08-15: a student hit the plan limit mid-run, the CLI printed the limit as
// an ordinary assistant message, then never emitted a result and never exited.
// The slot stayed occupied for twelve hours. Every other guard measures
// progress or spend; this one measures liveness.
test('a silent student is killed and rejects with the v1 message, carrying its last text', async () => {
  const m = manualSpawn();
  const t = manualTicker();
  const seen: Array<{ ticks: number; lastText: string }> = [];
  const p = harness().run('go', { cwd: '/wt', spawnFn: m.spawnFn, idleTicks: 2, setIntervalFn: t.setIntervalFn, onIdleKill: (i) => seen.push(i) });
  m.child.stdout.emit('data', Buffer.from(`${assistantEvent('m1', 1, 1, 1, 0, "You've hit your session limit · resets 4:10pm (America/New_York)")}\n`));
  // The first tick after output CONSUMES the flag, so N silent ticks needs N+1.
  t.tick(3);
  m.child.emit('close', null);   // treeKill cannot reap a fake; stand in for the close
  const err = await p.then(() => null, (e: Error) => e);
  assert.ok(err, 'must not resolve');
  assert.match(err!.message, /claude -p produced no output for 2 consecutive minute\(s\) — killed as stalled\./);
  assert.match(err!.message, /Last message: You've hit your session limit/);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].ticks, 2);
  // The payoff: a stalled plan limit still classifies as capacity, with its reset.
  const v = harness().classifyFailure(err!.message, Date.parse('2026-08-13T08:00:00Z'));
  assert.equal(v.kind, 'capacity');
  assert.ok(v.resetAt);
});

test('output resets the idle counter and idleTicks:0 disables the watchdog', async () => {
  const m = manualSpawn();
  const t = manualTicker();
  const p = harness().run('go', { cwd: '/wt', spawnFn: m.spawnFn, idleTicks: 3, setIntervalFn: t.setIntervalFn });
  t.tick(2);
  m.child.stdout.emit('data', Buffer.from(`${assistantEvent('m1', 1, 1, 1, 0, 'still working')}\n`));
  t.tick(2);
  m.child.stdout.emit('data', Buffer.from(`${resultEvent({ result: 'survived' })}\n`));
  m.child.emit('close', 0);
  assert.equal((await p).text, 'survived');

  const m2 = manualSpawn();
  const t2 = manualTicker();
  const p2 = harness().run('go', { cwd: '/wt', spawnFn: m2.spawnFn, idleTicks: 0, setIntervalFn: t2.setIntervalFn });
  t2.tick(50);
  m2.child.stdout.emit('data', Buffer.from(`${resultEvent({ result: 'ok' })}\n`));
  m2.child.emit('close', 0);
  assert.equal((await p2).text, 'ok');
});

// A cancel is deliberate, so like a budget stop it RESOLVES with the partial
// usage and a marker: the worktree still holds the work and the caller banks it.
test('an aborted run RESOLVES with stoppedBy "cancelled" and the partial usage once the child dies', async () => {
  const m = manualSpawn();
  const ac = new AbortController();
  const p = harness().run('go', { cwd: '/wt', spawnFn: m.spawnFn, signal: ac.signal });
  m.child.stdout.emit('data', Buffer.from(`${assistantEvent('m1', 1)}\n`));
  ac.abort();                    // treeKill is a no-op on a pid-less fake; the real one dies and closes
  m.child.emit('close', null);
  const r = await p;
  assert.equal(r.stoppedBy, 'cancelled');
  assert.match(r.text, /cancelled by caller/);
  assert.match(r.text, /PARTIAL work/);
  assert.equal(r.turns, 1);
  assert.equal(r.costUsd, null);
  assert.equal(harness().classifyFailure(r.text).kind, 'cancelled');
});

// ---- failures -----------------------------------------------------------------------

test('rejects when the CLI crashes with non-JSON output, and that reads as infra', async () => {
  const { spawnFn } = makeSpawn({ stdout: 'boom not json', stderr: 'stack trace', code: 3 });
  const err = await harness().run('x', { cwd: '/wt', spawnFn }).then(() => null, (e: Error) => e);
  assert.match(err!.message, /^claude -p \(3\) returned no JSON result: stack trace$/);
  assert.equal(harness().classifyFailure(err!.message).kind, 'infra');
});

test('an error result rejects with subtype, tail, api_error_status and the structured reset hint', async () => {
  const { spawnFn } = makeSpawn({
    stdout: [
      rateLimitEvent({ status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1789415400 }),
      resultEvent({ is_error: true, subtype: 'error_during_execution', result: undefined, errors: ["You've hit your session limit · resets 4:10pm (America/New_York)"], api_error_status: 429 }),
    ].join('\n') + '\n',
  });
  const err = await harness().run('x', { cwd: '/wt', spawnFn }).then(() => null, (e: Error) => e);
  assert.equal(err!.message,
    "claude -p error (error_during_execution): You've hit your session limit · resets 4:10pm (America/New_York) [api_error_status=429] [resetsAt=1789415400000]");
  const v = harness().classifyFailure(err!.message, 1789415400_000 - 3_600_000);
  assert.equal(v.kind, 'capacity');
  assert.equal(v.resetAt, 1789415400_000 + RESET_MARGIN_MS, 'the structured hint beats the rendered clock');
});

test('an error result without api_error_status appends nothing extra', async () => {
  const { spawnFn } = makeSpawn({ stdout: `${resultEvent({ is_error: true, subtype: 'error_max_turns', result: 'hit max turns' })}\n` });
  const err = await harness().run('x', { cwd: '/wt', spawnFn }).then(() => null, (e: Error) => e);
  assert.equal(err!.message, 'claude -p error (error_max_turns): hit max turns');
  assert.equal(harness().classifyFailure(err!.message).kind, 'task');
});

test('a spawn error (ENOENT) rejects and classifies as infra', async () => {
  const spawnFn: SpawnLike = () => {
    const { child } = makeChild();
    setImmediate(() => child.emit('error', new Error('spawn C:/fake/claude.exe ENOENT')));
    return child as unknown as ChildLike;
  };
  const err = await harness().run('x', { cwd: '/wt', spawnFn }).then(() => null, (e: Error) => e);
  assert.match(err!.message, /ENOENT/);
  assert.equal(harness().classifyFailure(err!.message).kind, 'infra');
});

test('killAll reaps every in-flight child and lets the run settle on close', async () => {
  const h = harness();
  const m = manualSpawn();
  const p = h.run('go', { cwd: '/wt', spawnFn: m.spawnFn });
  h.killAll();                   // no pid on the fake: nothing to taskkill, registry cleared
  m.child.emit('close', null);
  const err = await p.then(() => null, (e: Error) => e);
  assert.match(err!.message, /returned no JSON result/);
});

// ---- classifyFailure table -----------------------------------------------------------------

test('classifyFailure: capacity, including U+2019 apostrophes and the weekly date form with a reset', () => {
  const h = harness();
  const NOW = Date.parse('2026-08-13T08:00:00Z');
  const cases: Array<[string, number | undefined]> = [
    ["claude -p error (success): You've hit your session limit · resets 4:40am (America/New_York)", NOW + 40 * 60_000 + RESET_MARGIN_MS],
    ['You\u2019ve hit your usage limit', undefined],
    ["You've hit your weekly limit · resets Aug 19, 4:40pm (America/New_York)", NOW + (6 * 24 * 60 + 12 * 60 + 40) * 60_000 + RESET_MARGIN_MS],
    ['Error: 429 too many requests', undefined],
    ['Claude is overloaded and is temporarily unavailable · resets in 2m', undefined],
    ['claude -p error (error_during_execution): boom [api_error_status=529]', undefined],
    ['usage limit reached — check plan', undefined],
  ];
  for (const [msg, resetAt] of cases) {
    const v = h.classifyFailure(msg, NOW);
    assert.equal(v.kind, 'capacity', msg);
    assert.equal(v.resetAt, resetAt, msg);
    assert.notEqual(v.detail, 'model-family', msg);
  }
});

test('classifyFailure: model-family limits are capacity with detail so the engine drops a tier, not the provider', () => {
  const h = harness();
  for (const msg of ["You've hit your Opus limit · resets Aug 19, 4pm (America/New_York)", 'You\u2019ve hit your Sonnet limit']) {
    const v = h.classifyFailure(msg, Date.parse('2026-08-13T08:00:00Z'));
    assert.equal(v.kind, 'capacity');
    assert.equal(v.detail, 'model-family');
  }
});

test('classifyFailure: auth beats everything, infra beats capacity, task is the default', () => {
  const h = harness();
  for (const msg of [
    'OAuth access token has expired. Please run /login',
    'Failed to authenticate. Please run /login',
    'claude -p error (error_during_execution): authentication_failed [api_error_status=401]',
    'oauth_org_not_allowed',
    'Re-authenticate to continue',
  ]) assert.equal(h.classifyFailure(msg).kind, 'auth', msg);

  for (const msg of [
    'claude -p (3) returned no JSON result: 96ms | User: 1578ms | Sys: 390ms',
    'panic(thread 22380): Segmentation fault at address 0x3C',
    'oh no: Bun has crashed. This indicates a bug in Bun, not your code.',
    'Error: spawn claude ENOENT',
    'claude -p (1) returned no JSON result: rate limit',
  ]) assert.equal(h.classifyFailure(msg).kind, 'infra', msg);

  for (const msg of [
    'produced no file changes — nothing to PR',
    'refusing to merge unrelated histories',
    'SyntaxError: Unexpected token',
    'tests failed: 3 failing',
    'claude -p error (error_max_turns): hit max turns',
    '',
  ]) assert.equal(h.classifyFailure(msg).kind, 'task', msg);

  assert.equal(h.classifyFailure('claude -p cancelled by caller (abort signal) after 2 turn(s)').kind, 'cancelled');
  assert.equal(h.classifyFailure('the user cancelled the subscription').kind, 'task', 'only OUR cancel path reads as cancelled');
});

// ---- preflight -------------------------------------------------------------------------------

/** A spawn that answers by argv: --version, then the probe completion. */
function preflightSpawn(probe: Record<string, unknown> | string, versionOut = '2.1.270 (Claude Code)\n') {
  const calls: SpawnCall[] = [];
  const spawnFn: SpawnLike = (bin, args, options) => {
    const { child, call } = makeChild();
    Object.assign(call, { bin, args, options });
    calls.push(call);
    setImmediate(() => {
      if (args[0] === '--version') { child.stdout.emit('data', Buffer.from(versionOut)); child.emit('close', 0); return; }
      child.stdout.emit('data', Buffer.from(typeof probe === 'string' ? probe : JSON.stringify(probe)));
      child.emit('close', 0);
    });
    return child as unknown as ChildLike;
  };
  return { spawnFn, calls };
}

test('preflight: not found -> ok:false without spawning anything', async () => {
  const s = preflightSpawn({});
  const h = createClaudeCodeHarness({ resolveBin: () => ({ path: 'claude', found: false, isShim: false }) });
  const r = await h.preflight({ spawnFn: s.spawnFn });
  assert.equal(r.ok, false);
  assert.equal(r.bin, 'claude');
  assert.match(r.detail!, /not found/);
  assert.equal(s.calls.length, 0);
});

test('preflight: --version then a trivial haiku completion proves auth', async () => {
  const s = preflightSpawn({ type: 'result', subtype: 'success', is_error: false, result: 'OK', session_id: 'p1', modelUsage: {} });
  const r = await harness().preflight({ spawnFn: s.spawnFn, cwd: '/w' });
  assert.deepEqual(r, { ok: true, bin: 'C:/fake/claude.exe', version: '2.1.270', authOk: true });
  assert.deepEqual(s.calls[0].args, ['--version']);
  assert.deepEqual(s.calls[1].args, ['-p', 'Reply with exactly the word OK.', '--output-format', 'json', '--model', 'haiku', '--max-turns', '1']);
  assert.equal(s.calls[1].options.cwd, '/w');
  assert.equal(s.calls[1].options.shell, false);
  assert.ok(!s.calls[1].args.includes('--bare'));
});

test('preflight: an expired login fails the completion, not --version, and reads authOk:false', async () => {
  const s = preflightSpawn({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['OAuth access token has expired. Please run /login'], api_error_status: 401 });
  const r = await harness().preflight({ spawnFn: s.spawnFn });
  assert.equal(r.ok, false);
  assert.equal(r.version, '2.1.270', '--version passes with an expired login — that is the point');
  assert.equal(r.authOk, false);
  assert.match(r.detail!, /^auth: /);
  assert.match(r.detail!, /api_error_status=401/);
});

test('preflight: a probe that prints no JSON reports the tail; a version that prints none fails early', async () => {
  const s = preflightSpawn('Segmentation fault');
  const r = await harness().preflight({ spawnFn: s.spawnFn });
  assert.equal(r.ok, false);
  assert.equal(r.authOk, false);
  assert.match(r.detail!, /returned no JSON result: Segmentation fault/);

  const bad = preflightSpawn({}, 'nope');
  const r2 = await harness().preflight({ spawnFn: bad.spawnFn });
  assert.equal(r2.ok, false);
  assert.equal(r2.version, undefined);
  assert.equal(bad.calls.length, 1, 'no completion is attempted when the binary cannot even report a version');
});

// Type-level guard that the run result satisfies the contract's Usage shape.
test('usage always carries all five fields', async () => {
  const { spawnFn } = makeSpawn({ stdout: `${resultEvent()}\n` });
  const r = await harness().run('p', { cwd: '/w', spawnFn });
  const keys: Array<keyof Usage> = ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens', 'reasoningTokens'];
  for (const k of keys) assert.equal(typeof r.usage[k], 'number', k);
});
