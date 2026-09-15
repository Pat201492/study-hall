import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChatEvent, ChildLike, QuotaObservation, QuotaSnapshot, SpawnLike } from '../src/contract.js';
import { chatArgs, createClaudeChat, interruptLine, userMessageLine } from '../src/adapters/claudeChat.js';
import { claudeCodeHarness, createClaudeCodeHarness } from '../src/adapters/claudeCode.js';

// The planner transport: ONE long-lived `claude -p --input-format stream-json`
// process (spike (a): stays alive after the first result, answers a second
// stdin message in 1.1 s). The fake child has NO pid so a close() fallback
// tree-kill is a no-op rather than a taskkill against a real process.

interface FakeChild extends EventEmitter {
  stdin: { write(s: string): void; end(): void };
  stdout: EventEmitter;
  stderr: EventEmitter;
}

function makeSpawn() {
  const calls: Array<{ bin: string; args: string[]; options: { cwd?: string; shell?: boolean; env?: NodeJS.ProcessEnv } }> = [];
  const written: string[] = [];
  let ended = false;
  let child!: FakeChild;
  const spawnFn: SpawnLike = (bin, args, options) => {
    child = new EventEmitter() as FakeChild;
    child.stdin = { write: (s: string) => { written.push(s); }, end: () => { ended = true; } };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    calls.push({ bin, args, options });
    return child as unknown as ChildLike;
  };
  return { spawnFn, calls, written, get ended() { return ended; }, get child() { return child; } };
}

const fakeBin = () => ({ path: 'C:/fake/claude.exe', found: true, isShim: false });
const line = (o: unknown) => Buffer.from(`${JSON.stringify(o)}\n`);

function collect(session: ReturnType<typeof createClaudeChat>) {
  const events: ChatEvent[] = [];
  session.on((e) => events.push(e));
  return events;
}

// ---- argv ------------------------------------------------------------------------------

test('chatArgs: the byte-stable base shape', () => {
  assert.deepEqual(chatArgs({ cwd: '/planner' }), [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--include-partial-messages', '--replay-user-messages', '--permission-mode', 'default',
  ]);
});

test('chatArgs: every option in its fixed position', () => {
  assert.deepEqual(chatArgs({
    cwd: '/planner', model: 'opus', effort: 'high', tools: ['Read', 'Grep', 'mcp__plan__*'],
    systemPrompt: 'You are the planner.', mcpConfig: '/cfg/plan.json', sessionId: 'uuid-1', resume: 'old-1',
  }), [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--include-partial-messages', '--replay-user-messages', '--permission-mode', 'default',
    '--model', 'opus', '--effort', 'high', '--tools', 'Read', 'Grep', 'mcp__plan__*',
    '--allowedTools', 'Read', 'Grep', 'mcp__plan__*',
    '--append-system-prompt', 'You are the planner.',
    '--mcp-config', '/cfg/plan.json', '--strict-mcp-config',
    '--session-id', 'uuid-1', '--resume', 'old-1',
  ]);
  assert.ok(!chatArgs({ cwd: '/p', tools: [] }).includes('--tools'));
  assert.ok(!chatArgs({ cwd: '/p' }).includes('--bare'));
});

// ---- process shape ------------------------------------------------------------------------

test('createClaudeChat spawns one process with shell:false in the fixed cwd and keeps stdin OPEN', () => {
  const s = makeSpawn();
  const session = createClaudeChat({ cwd: '/planner', model: 'opus', env: { X: '1' }, spawnFn: s.spawnFn }, { resolveBin: fakeBin });
  assert.equal(session.harness, 'claude-code');
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].bin, 'C:/fake/claude.exe');
  assert.deepEqual(s.calls[0].args, chatArgs({ cwd: '/planner', model: 'opus' }));
  assert.equal(s.calls[0].options.cwd, '/planner');
  assert.equal(s.calls[0].options.shell, false);
  assert.equal(s.calls[0].options.env?.X, '1');
  assert.equal(s.ended, false, 'a human is still typing');
  assert.equal(session.sessionId, null, 'unknown until init');
});

test('send writes exactly one NDJSON user line', async () => {
  const s = makeSpawn();
  const session = createClaudeChat({ cwd: '/planner', spawnFn: s.spawnFn }, { resolveBin: fakeBin });
  await session.send('plan the login feature');
  assert.deepEqual(s.written, ['{"type":"user","message":{"role":"user","content":"plan the login feature"},"parent_tool_use_id":null}\n']);
  assert.equal(userMessageLine('x'), '{"type":"user","message":{"role":"user","content":"x"},"parent_tool_use_id":null}\n');
  assert.equal(s.ended, false);
});

test('system/init yields a status event and captures the session id', () => {
  const s = makeSpawn();
  const session = createClaudeChat({ cwd: '/planner', spawnFn: s.spawnFn }, { resolveBin: fakeBin });
  const events = collect(session);
  s.child.stdout.emit('data', line({
    type: 'system', subtype: 'init', session_id: 'sess-chat', model: 'claude-opus-4-8',
    mcp_servers: [{ name: 'plan', status: 'connected' }], capabilities: ['interrupt_receipt_v1'],
  }));
  assert.equal(session.sessionId, 'sess-chat');
  assert.deepEqual(events, [{ type: 'status', message: 'ready · model claude-opus-4-8 · mcp plan:connected' }]);
});

test('text_delta stream events become partial text; assistant blocks become text and tool_call', () => {
  const s = makeSpawn();
  const session = createClaudeChat({ cwd: '/planner', spawnFn: s.spawnFn }, { resolveBin: fakeBin });
  const events = collect(session);
  s.child.stdout.emit('data', line({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } } }));
  s.child.stdout.emit('data', line({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } } }));
  s.child.stdout.emit('data', line({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{' } } }));
  s.child.stdout.emit('data', line({
    type: 'assistant',
    message: { id: 'm1', content: [
      { type: 'text', text: 'Hello' },
      { type: 'tool_use', id: 'tu1', name: 'mcp__plan__lint_issue', input: { title: 'x' } },
    ] },
  }));
  assert.deepEqual(events, [
    { type: 'text', text: 'Hel', partial: true },
    { type: 'text', text: 'lo', partial: true },
    { type: 'text', text: 'Hello' },
    { type: 'tool_call', id: 'tu1', name: 'mcp__plan__lint_issue', input: { title: 'x' } },
  ]);
});

test('user tool_result blocks become tool_result; our replayed user messages are ignored', () => {
  const s = makeSpawn();
  const session = createClaudeChat({ cwd: '/planner', spawnFn: s.spawnFn }, { resolveBin: fakeBin });
  const events = collect(session);
  s.child.stdout.emit('data', line({ type: 'user', message: { role: 'user', content: 'plan the login feature' } }));
  s.child.stdout.emit('data', line({
    type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok: 3 criteria', is_error: false }] },
  }));
  s.child.stdout.emit('data', line({
    type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu2', content: [{ type: 'text', text: 'nope' }], is_error: true }] },
  }));
  assert.deepEqual(events, [
    { type: 'tool_result', id: 'tu1', output: 'ok: 3 criteria', isError: undefined },
    { type: 'tool_result', id: 'tu2', output: [{ type: 'text', text: 'nope' }], isError: true },
  ]);
});

test('result yields usage then turn_done with modelUsage totals, cost and session; the process stays open', () => {
  const s = makeSpawn();
  const session = createClaudeChat({ cwd: '/planner', spawnFn: s.spawnFn }, { resolveBin: fakeBin });
  const events = collect(session);
  s.child.stdout.emit('data', line({
    type: 'result', subtype: 'success', is_error: false, result: 'Here is the plan', session_id: 'sess-chat', num_turns: 1,
    total_cost_usd: 0.05, duration_ms: 1100,
    usage: { input_tokens: 1, output_tokens: 1 },
    modelUsage: { 'claude-opus-4-8': { inputTokens: 10, outputTokens: 40, cacheReadInputTokens: 31000, cacheCreationInputTokens: 0 } },
  }));
  const usage = { inputTokens: 10, outputTokens: 40, cacheReadInputTokens: 31000, cacheCreationInputTokens: 0, reasoningTokens: 0 };
  assert.deepEqual(events, [
    { type: 'usage', usage, costUsd: 0.05 },
    { type: 'turn_done', usage, costUsd: 0.05, sessionId: 'sess-chat' },
  ]);
  assert.equal(session.sessionId, 'sess-chat');
  assert.equal(s.ended, false, 'a second turn can follow');
});

test('an error result yields an error event with a verdict before turn_done', () => {
  const s = makeSpawn();
  const session = createClaudeChat({ cwd: '/planner', spawnFn: s.spawnFn }, { resolveBin: fakeBin });
  const events = collect(session);
  s.child.stdout.emit('data', line({
    type: 'result', subtype: 'error_during_execution', is_error: true, errors: ["You've hit your session limit · resets 4:10pm (UTC)"], api_error_status: 429, session_id: 's',
  }));
  assert.equal(events[0].type, 'error');
  const err = events[0] as Extract<ChatEvent, { type: 'error' }>;
  assert.match(err.message, /error_during_execution/);
  assert.equal(err.verdict?.kind, 'capacity');
  assert.equal(events[2].type, 'turn_done');
});

test('rate_limit_event yields a quota event and feeds the injected monitor', () => {
  const observed: QuotaObservation[] = [];
  const monitor = {
    provider: 'anthropic',
    snapshot: (): QuotaSnapshot => ({ provider: 'anthropic', state: 'unknown' }),
    observe: (o: QuotaObservation) => { observed.push(o); },
    markExhausted: () => {},
    subscribe: () => () => {},
  };
  const s = makeSpawn();
  const session = createClaudeChat({ cwd: '/planner', spawnFn: s.spawnFn }, { resolveBin: fakeBin, quota: monitor, now: () => 7 });
  const events = collect(session);
  s.child.stdout.emit('data', line({
    type: 'rate_limit_event',
    rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour', unifiedWindows: { five_hour: { utilization: 0.14, resetsAt: 1789415400 } } },
  }));
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'quota');
  const q = events[0] as Extract<ChatEvent, { type: 'quota' }>;
  assert.equal(q.observation.fiveHour?.resetsAt, 1789415400_000);
  assert.equal(q.observation.observedAt, 7);
  assert.equal(observed[0], q.observation);
});

test('unknown event types and non-JSON lines are ignored, but every raw line reaches the transcript sink', () => {
  const s = makeSpawn();
  const lines: string[] = [];
  const session = createClaudeChat({ cwd: '/planner', spawnFn: s.spawnFn, transcriptSink: (l) => lines.push(l) }, { resolveBin: fakeBin });
  const events = collect(session);
  s.child.stdout.emit('data', Buffer.from(`${JSON.stringify({ type: 'system', subtype: 'hook_started' })}\nplain noise\n${JSON.stringify({ type: 'control_response', response: {} })}\n`));
  assert.deepEqual(events, []);
  assert.equal(lines.length, 3);
  assert.equal(lines[1], 'plain noise');
});

test('interrupt writes the control_request line with a request id', async () => {
  const s = makeSpawn();
  const session = createClaudeChat({ cwd: '/planner', spawnFn: s.spawnFn }, { resolveBin: fakeBin, uuid: () => 'req-1' });
  s.child.stdout.emit('data', line({ type: 'system', subtype: 'init', session_id: 'x', model: 'm', capabilities: ['interrupt_receipt_v1'] }));
  await session.interrupt();
  assert.deepEqual(s.written, ['{"type":"control_request","request_id":"req-1","request":{"subtype":"interrupt"}}\n']);
  assert.equal(interruptLine('r'), '{"type":"control_request","request_id":"r","request":{"subtype":"interrupt"}}\n');
});

test('close ends stdin, resolves on the process close, and reports closed; send afterwards rejects', async () => {
  const s = makeSpawn();
  const session = createClaudeChat({ cwd: '/planner', spawnFn: s.spawnFn }, { resolveBin: fakeBin, closeGraceMs: 60_000 });
  const events = collect(session);
  const closing = session.close();
  assert.equal(s.ended, true, 'EOF is how the CLI is told the conversation is over');
  assert.equal(session.close(), closing, 'idempotent');
  s.child.emit('close', 0);
  await closing;
  assert.deepEqual(events, [{ type: 'closed', exitCode: 0 }]);
  await assert.rejects(session.send('more'), /closed/);
  await session.close();   // still resolves after exit
});

test('a non-zero exit with stderr surfaces as an error event before closed', () => {
  const s = makeSpawn();
  const session = createClaudeChat({ cwd: '/planner', spawnFn: s.spawnFn }, { resolveBin: fakeBin });
  const events = collect(session);
  s.child.stderr.emit('data', Buffer.from('OAuth access token has expired'));
  s.child.emit('close', 1);
  assert.equal(events[0].type, 'error');
  assert.equal((events[0] as Extract<ChatEvent, { type: 'error' }>).verdict?.kind, 'auth');
  assert.deepEqual(events[1], { type: 'closed', exitCode: 1 });
});

test('unsubscribing stops delivery', () => {
  const s = makeSpawn();
  const session = createClaudeChat({ cwd: '/planner', spawnFn: s.spawnFn }, { resolveBin: fakeBin });
  const events: ChatEvent[] = [];
  const off = session.on((e) => events.push(e));
  off();
  s.child.stdout.emit('data', line({ type: 'system', subtype: 'init', session_id: 'x', model: 'm' }));
  assert.deepEqual(events, []);
});

test('harness.chat() builds the session with the harness deps', () => {
  const s = makeSpawn();
  const h = createClaudeCodeHarness({ resolveBin: fakeBin, spawnFn: s.spawnFn });
  const session = h.chat!({ cwd: '/planner', sessionId: 'seed-1' });
  assert.equal(session.harness, 'claude-code');
  assert.equal(session.sessionId, 'seed-1', 'a seeded id is known before init');
  assert.ok(s.calls[0].args.includes('--session-id'));
  assert.equal(typeof claudeCodeHarness.chat, 'function');
});
