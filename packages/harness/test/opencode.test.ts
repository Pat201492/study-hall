import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildLike, SpawnLike } from '../src/contract.js';
import {
  OPENCODE_CAPABILITIES, addStepTokens, classifyOpenCodeFailure, createOpenCodeHarness, localProvider,
  openCodeArgs, openCodeBin, openCodeHarness, parseOpenCodeEvent,
} from '../src/adapters/opencode.js';
import {
  clearRegistries, fidelityFor, getHarness, harnessesFor, registerHarness, registerProvider,
} from '../src/registry.js';

// Captured verbatim from a real `opencode run --format json` against a local
// Ollama model (opencode-ai@1.18.30) — not hand-written to match the parser.
// The arithmetic in it is the load-bearing part: input 6472 + output 2 +
// cache.read 5 == total 6479, which is what proves `input` EXCLUDES cache reads
// exactly as Anthropic's shape does, and therefore that the mapping below is
// not double-counting.
const REAL_LINES = [
  '{"type":"step_start","timestamp":1789010620194,"sessionID":"ses_f76a8683bffe3itdFERKLQ75ZI","part":{"id":"prt_a","messageID":"msg_a","sessionID":"ses_f76a8683bffe3itdFERKLQ75ZI","type":"step-start"}}',
  '{"type":"text","timestamp":1789010620267,"sessionID":"ses_f76a8683bffe3itdFERKLQ75ZI","part":{"id":"prt_b","messageID":"msg_a","sessionID":"ses_f76a8683bffe3itdFERKLQ75ZI","type":"text","text":"OK"}}',
  '{"type":"step_finish","timestamp":1789010620267,"sessionID":"ses_f76a8683bffe3itdFERKLQ75ZI","part":{"id":"prt_c","reason":"stop","messageID":"msg_a","sessionID":"ses_f76a8683bffe3itdFERKLQ75ZI","type":"step-finish","tokens":{"total":6479,"input":6472,"output":2,"reasoning":0,"cache":{"write":0,"read":5}},"cost":0}}',
];
const REAL_STREAM = REAL_LINES.join('\n') + '\n';
const REAL_SESSION = 'ses_f76a8683bffe3itdFERKLQ75ZI';

const stepLine = (i: number, o: number, extra = ''): string =>
  `{"type":"step_finish","part":{"type":"step-finish","sessionID":"s1","tokens":{"input":${i},"output":${o},"cache":{"read":0,"write":0}}${extra}}}`;
const textLine = (t: string): string =>
  `{"type":"text","part":{"type":"text","sessionID":"s1","text":${JSON.stringify(t)}}}`;

type SpawnOpts = Parameters<SpawnLike>[2];

/** An EventEmitter child double. No pid on purpose: treeKill is a no-op on a
 *  pidless child, so a guard trip is observed through its callback and the
 *  test drives `close` itself — nothing here can reach a real process. */
class FakeChild extends EventEmitter implements ChildLike {
  pid: number | undefined = undefined;
  stdinEnded = false;
  stdinWrites: string[] = [];
  stdin = {
    write: (s: string): void => { this.stdinWrites.push(s); },
    end: (): void => { this.stdinEnded = true; },
  };
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill(): boolean { return true; }
}

interface Script { stdout?: string | string[]; stderr?: string; code?: number | null }

function makeSpawn(script?: Script) {
  const calls: { bin: string; args: string[]; options: SpawnOpts }[] = [];
  const children: FakeChild[] = [];
  const spawnFn: SpawnLike = (bin, args, options) => {
    const child = new FakeChild();
    calls.push({ bin, args, options });
    children.push(child);
    if (script) {
      setImmediate(() => {
        const chunks = Array.isArray(script.stdout) ? script.stdout : script.stdout ? [script.stdout] : [];
        for (const c of chunks) child.stdout.emit('data', Buffer.from(c));
        if (script.stderr) child.stderr.emit('data', Buffer.from(script.stderr));
        child.emit('close', script.code === undefined ? 0 : script.code);
      });
    }
    return child;
  };
  return { spawnFn, calls, children };
}

const harness = () => createOpenCodeHarness({ bin: () => 'opencode-fake', now: () => 1000 });

// ---- pure parsing -----------------------------------------------------------

test('the real event stream parses into the v2 result shape', async () => {
  const { spawnFn } = makeSpawn({ stdout: REAL_STREAM });
  const r = await harness().run('Say OK', { cwd: '/wt', spawnFn });
  assert.equal(r.text, 'OK');
  assert.equal(r.sessionId, REAL_SESSION);
  assert.equal(r.turns, 1);
  assert.equal(r.stoppedBy, undefined);
  assert.equal(r.meter, 'local');
  assert.equal(r.exitCode, 0);
  assert.equal(r.costUsd, 0, 'the real step-finish carries cost:0 — an honest zero, not a missing figure');
  assert.deepEqual(r.usage, {
    inputTokens: 6472, outputTokens: 2, cacheReadInputTokens: 5, cacheCreationInputTokens: 0, reasoningTokens: 0,
  });
  const billed = r.usage.inputTokens + r.usage.outputTokens + r.usage.cacheReadInputTokens;
  assert.equal(billed, 6479, 'input + output + cache.read == the total the CLI printed, so input excludes cache reads');
  assert.equal((r.raw as { part: { type: string } }).part.type, 'step-finish', 'raw is the terminal event, unmangled');
});

test('parseOpenCodeEvent classifies the real lines', () => {
  const [start, text, finish] = REAL_LINES.map((l) => JSON.parse(l) as Record<string, unknown>);
  assert.deepEqual(parseOpenCodeEvent(start), { kind: 'other', sessionId: REAL_SESSION });
  assert.deepEqual(parseOpenCodeEvent(text), { kind: 'text', text: 'OK', sessionId: REAL_SESSION });
  const f = parseOpenCodeEvent(finish);
  assert.equal(f.kind, 'step-finish');
  if (f.kind !== 'step-finish') return;
  assert.equal(f.cost, 0);
  assert.equal(f.tokens?.input, 6472);
  assert.deepEqual(parseOpenCodeEvent({ type: 'x', sessionID: 'ses_top' }), { kind: 'other', sessionId: 'ses_top' });
});

// Reasoning tokens are generated text the provider bills as output. v1 folded
// them into outputTokens because it had nowhere else to put them; v2 keeps them
// apart so this lane's output figure is comparable with Codex's, and dropping
// them would still UNDER-report spend — the direction that flatters the lane.
test('reasoning tokens land in reasoningTokens, not outputTokens', () => {
  const u = addStepTokens(
    { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, reasoningTokens: 0 },
    { input: 10, output: 4, reasoning: 40, cache: { read: 1, write: 2 } },
  );
  assert.deepEqual(u, {
    inputTokens: 10, outputTokens: 4, cacheReadInputTokens: 1, cacheCreationInputTokens: 2, reasoningTokens: 40,
  });
});

test('addStepTokens accumulates and treats missing fields as zero', () => {
  const one = addStepTokens(
    { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 1, cacheCreationInputTokens: 1, reasoningTokens: 1 },
    { input: 5 },
  );
  assert.deepEqual(one, {
    inputTokens: 6, outputTokens: 1, cacheReadInputTokens: 1, cacheCreationInputTokens: 1, reasoningTokens: 1,
  });
});

test('a multi-step run sums every step and counts turns', async () => {
  const { spawnFn } = makeSpawn({ stdout: [stepLine(100, 5), stepLine(200, 7)].join('\n') + '\n' });
  const r = await harness().run('x', { cwd: '/wt', spawnFn });
  assert.equal(r.turns, 2);
  assert.equal(r.usage.inputTokens, 300);
  assert.equal(r.usage.outputTokens, 12);
  assert.equal(r.sessionId, 's1');
  assert.equal(r.costUsd, null, 'no step carried a cost figure');
});

test('cost is summed across steps when the CLI reports it', async () => {
  const { spawnFn } = makeSpawn({
    stdout: [stepLine(1, 1, ',"cost":0.25'), stepLine(1, 1, ',"cost":0.5')].join('\n') + '\n',
  });
  const r = await harness().run('x', { cwd: '/wt', spawnFn });
  assert.equal(r.costUsd, 0.75);
});

test('non-JSON noise on stdout is skipped, not fatal, and still reaches the transcript', async () => {
  const lines: string[] = [];
  const { spawnFn } = makeSpawn({ stdout: `downloading ripgrep...\n${REAL_STREAM}bye` });
  const r = await harness().run('x', { cwd: '/wt', spawnFn, transcriptSink: (l) => lines.push(l) });
  assert.equal(r.usage.inputTokens, 6472);
  assert.deepEqual(lines, ['downloading ripgrep...', ...REAL_LINES, 'bye']);
});

// v1 re-parsed the whole accumulated stdout on every chunk (O(n²)) and fired
// onUsage per CHUNK. The framer carries the partial line across the boundary,
// each event is handled once, and onUsage fires per STEP-FINISH.
test('a line split mid-JSON across chunks is reassembled and handled exactly once', async () => {
  const cut = REAL_STREAM.indexOf('"tokens"') + 12; // inside the step-finish object
  const chunks = [REAL_STREAM.slice(0, 40), REAL_STREAM.slice(40, cut), REAL_STREAM.slice(cut)];
  const lines: string[] = [];
  const usages: number[] = [];
  const { spawnFn } = makeSpawn({ stdout: chunks });
  const r = await harness().run('x', {
    cwd: '/wt', spawnFn, transcriptSink: (l) => lines.push(l), onUsage: (u) => usages.push(u.inputTokens),
  });
  assert.equal(r.text, 'OK');
  assert.equal(r.usage.inputTokens, 6472);
  assert.deepEqual(lines, REAL_LINES, 'every raw line reaches the sink once, whole');
  assert.deepEqual(usages, [6472], 'one step-finish, one usage report — not one per chunk');
});

test('a final unterminated line is flushed at close', async () => {
  const { spawnFn } = makeSpawn({ stdout: REAL_LINES.join('\n') }); // no trailing newline
  const r = await harness().run('x', { cwd: '/wt', spawnFn });
  assert.equal(r.turns, 1);
  assert.equal(r.usage.inputTokens, 6472);
});

test('onUsage reports cumulative spend after every step while the run is still going', async () => {
  const seen: number[] = [];
  const { spawnFn } = makeSpawn({ stdout: [stepLine(100, 5), stepLine(200, 7)].join('\n') + '\n' });
  await harness().run('x', { cwd: '/wt', spawnFn, onUsage: (u) => seen.push(u.inputTokens) });
  assert.deepEqual(seen, [100, 300]);
});

// ---- argv / spawn -----------------------------------------------------------

// The prompt is a positional argument here, unlike `claude -p`'s stdin. shell
// must therefore stay OFF: a model-authored prompt containing & | % or a quote
// would otherwise be parsed by the shell instead of passed through.
test('the prompt is the last argv entry and the spawn never goes through a shell', async () => {
  const { spawnFn, calls, children } = makeSpawn({ stdout: REAL_STREAM });
  await harness().run('fix the bug & ship it', {
    cwd: '/wt', model: 'ollama/qwen2.5:3b', spawnFn, env: { OLLAMA_HOST: '127.0.0.1:11434' },
  });
  assert.equal(calls[0].bin, 'opencode-fake');
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls[0].options.cwd, '/wt');
  assert.equal(calls[0].args.at(-1), 'fix the bug & ship it');
  assert.deepEqual(calls[0].args.slice(0, 8), [
    'run', '--format', 'json', '--auto', '--dir', '/wt', '-m', 'ollama/qwen2.5:3b',
  ]);
  assert.equal(calls[0].options.env?.OLLAMA_HOST, '127.0.0.1:11434', 'opts.env is merged into the child env');
  assert.equal(calls[0].options.env?.PATH ?? calls[0].options.env?.Path, process.env.PATH ?? process.env.Path, 'over process.env');
  assert.equal(children[0].stdinEnded, true, 'stdin is closed at once — the prompt is argv');
  assert.deepEqual(children[0].stdinWrites, []);
});

test('on-request approval drops --auto; never (the default) keeps it', () => {
  assert.equal(openCodeArgs('x', { cwd: '/wt', approval: 'on-request' }).includes('--auto'), false);
  assert.equal(openCodeArgs('x', { cwd: '/wt', approval: 'never' }).includes('--auto'), true);
  assert.equal(openCodeArgs('x', { cwd: '/wt' }).includes('--auto'), true);
});

// The distinction #307 draws, in argv. A caller-CHOSEN seed names nothing on the
// server, so it is dropped; an ADOPTED base came back from an earlier run of
// this same harness, so it is safe to resume or fork.
test('a seeded new session is ignored, an adopted base is resumed or forked', () => {
  const seeded = openCodeArgs('x', { cwd: '/wt', session: { mode: 'new', seed: 'uuid-we-invented' } });
  assert.equal(seeded.includes('-s'), false);
  assert.equal(seeded.includes('uuid-we-invented'), false);
  assert.deepEqual(seeded, ['run', '--format', 'json', '--auto', '--dir', '/wt', 'x']);

  const resumed = openCodeArgs('x', { cwd: '/wt', session: { mode: 'resume', base: 'ses_real' } });
  assert.deepEqual(resumed.slice(-3), ['-s', 'ses_real', 'x']);
  assert.equal(resumed.includes('--fork'), false);

  const forked = openCodeArgs('x', { cwd: '/wt', session: { mode: 'fork', base: 'ses_real' } });
  assert.deepEqual(forked.slice(-4), ['-s', 'ses_real', '--fork', 'x']);
});

test('--fork is never emitted without a base to fork off', () => {
  const args = openCodeArgs('x', { cwd: '/wt', session: { mode: 'fork' } });
  assert.equal(args.includes('--fork'), false);
  assert.equal(args.includes('-s'), false);
});

test('tools, effort and sandbox are not turned into flags (the capabilities say so)', () => {
  const args = openCodeArgs('x', { cwd: '/wt', tools: ['Read'], effort: 'high', sandbox: 'read-only' });
  assert.deepEqual(args, ['run', '--format', 'json', '--auto', '--dir', '/wt', 'x']);
});

// ---- failure paths ----------------------------------------------------------

// v1 said `no JSON result` believing it matched the infra classifier's
// `returned no JSON result`, and it never did — a crashed local model read as a
// task that made no progress. This binds the wording to the classifier.
test('a run with no terminal step-finish rejects with wording the infra classifier recognises', async () => {
  const { spawnFn } = makeSpawn({ stdout: 'not json at all', stderr: 'boom', code: 1 });
  const h = harness();
  let message = '';
  await assert.rejects(h.run('x', { cwd: '/wt', spawnFn }), (e: Error) => { message = e.message; return true; });
  assert.match(message, /^opencode \(1\) returned no JSON result: boom$/);
  assert.equal(h.classifyFailure(message).kind, 'infra');
});

test('an empty run says so rather than printing an empty tail', async () => {
  const { spawnFn } = makeSpawn({ code: 0 });
  await assert.rejects(harness().run('x', { cwd: '/wt', spawnFn }), /opencode \(0\) returned no JSON result: \(no output\)/);
});

test('a spawn failure rejects as failed-to-start and classifies as infra', async () => {
  const spawnFn: SpawnLike = () => {
    const child = new FakeChild();
    setImmediate(() => { child.emit('error', new Error('spawn opencode-fake ENOENT')); child.emit('close', -2); });
    return child;
  };
  const h = harness();
  let message = '';
  await assert.rejects(h.run('x', { cwd: '/wt', spawnFn }), (e: Error) => { message = e.message; return true; });
  assert.match(message, /opencode failed to start: spawn opencode-fake ENOENT/);
  assert.equal(h.classifyFailure(message).kind, 'infra');
});

test('a binary that resolves to a shim rejects the run promise, never throws synchronously', async () => {
  const h = createOpenCodeHarness({ env: { OPENCODE_BIN: 'C:/tools/opencode.cmd' } });
  const { spawnFn, calls } = makeSpawn({ stdout: REAL_STREAM });
  await assert.rejects(h.run('x', { cwd: '/wt', spawnFn }), /\.cmd\/\.bat shim/);
  assert.equal(calls.length, 0, 'nothing was spawned');
});

test('classifyFailure: infra is the environment never running the student', () => {
  const h = harness();
  for (const m of [
    'opencode (1) returned no JSON result: boom', 'spawn opencode ENOENT', 'ETXTBSY',
    'connection refused', 'ECONNREFUSED 127.0.0.1:11434', 'model is loading', 'no such model: qwen2.5:3b',
  ]) assert.equal(h.classifyFailure(m).kind, 'infra', m);
});

test('classifyFailure: provider-side limits are capacity, not a bad item', () => {
  const h = harness();
  for (const m of [
    'rate_limit_exceeded', 'insufficient_quota', 'Rate limit reached', 'HTTP 429', 'overloaded_error',
    'server at capacity', 'please try again later',
  ]) assert.equal(h.classifyFailure(m).kind, 'capacity', m);
  assert.equal(h.classifyFailure('rate limit').resetAt, undefined, 'a local model has no reset clock');
});

test('classifyFailure: everything else — including a context overflow — is the task\'s fault', () => {
  const h = harness();
  for (const m of [
    'TypeError: undefined is not a function', 'context length exceeded', 'the model produced an invalid diff',
  ]) assert.equal(h.classifyFailure(m).kind, 'task', m);
  assert.equal(h.classifyFailure('  something odd  ').detail, 'something odd');
});

// ---- guards (the two v1 never gave this lane) -------------------------------

test('a turn budget stops the run, resolves with partial usage, and drops events behind the kill', async () => {
  const stops: { turns: number; tokens: number; limit: string }[] = [];
  const { spawnFn } = makeSpawn({ stdout: [stepLine(100, 5), stepLine(200, 7)].join('\n') + '\n', code: null });
  const r = await harness().run('x', {
    cwd: '/wt', spawnFn, budget: { maxTurns: 1 }, onBudgetStop: (s) => stops.push(s),
  });
  assert.equal(r.stoppedBy, 'budget');
  assert.equal(r.turns, 1, 'the second step-finish was buffered behind the kill and must not count');
  assert.equal(r.usage.inputTokens, 100);
  assert.equal(r.sessionId, 's1');
  assert.equal(r.exitCode, null);
  assert.match(r.text, /stopped by the maxTurns budget after 1 turn\(s\).*PARTIAL/);
  assert.deepEqual(stops, [{ turns: 1, tokens: 100, limit: 'maxTurns' }]);
});

test('a token budget counts fresh input plus both cache buckets', async () => {
  const stops: { turns: number; tokens: number; limit: string }[] = [];
  const { spawnFn } = makeSpawn({ stdout: REAL_STREAM });
  const r = await harness().run('x', {
    cwd: '/wt', spawnFn, budget: { maxTokens: 6000 }, onBudgetStop: (s) => stops.push(s),
  });
  assert.equal(r.stoppedBy, 'budget');
  assert.deepEqual(stops, [{ turns: 1, tokens: 6477, limit: 'maxTokens' }]);
  assert.equal(r.usage.cacheReadInputTokens, 5, 'partial usage is what was actually spent');
});

test('a run under budget is not stopped', async () => {
  const { spawnFn } = makeSpawn({ stdout: REAL_STREAM });
  const r = await harness().run('x', { cwd: '/wt', spawnFn, budget: { maxTurns: 5, maxTokens: 1_000_000 } });
  assert.equal(r.stoppedBy, undefined);
  assert.equal(r.text, 'OK');
});

test('silence for idleTicks consecutive ticks kills the run and rejects with the last message', async () => {
  let tick: (() => void) | undefined;
  const intervals: number[] = [];
  const setIntervalFn = (fn: () => void, ms: number): NodeJS.Timeout => {
    tick = fn; intervals.push(ms);
    return { unref() { return this; } } as unknown as NodeJS.Timeout;
  };
  const kills: { ticks: number; lastText: string }[] = [];
  const { spawnFn, children } = makeSpawn();
  const p = harness().run('x', {
    cwd: '/wt', spawnFn, setIntervalFn, idleTicks: 2, onIdleKill: (i) => kills.push(i),
  });
  const child = children[0];
  assert.ok(tick, 'the watchdog was armed');
  assert.deepEqual(intervals, [60_000], 'one tick per minute');

  child.stdout.emit('data', Buffer.from(textLine('working on it...') + '\n'));
  tick(); // output was seen during this tick: counter resets
  tick(); // silent tick 1
  assert.equal(kills.length, 0);
  tick(); // silent tick 2 == idleTicks: kill
  assert.deepEqual(kills, [{ ticks: 2, lastText: 'working on it...' }]);
  child.emit('close', null);

  // assert.rejects matches a RegExp against String(err), hence no ^ anchor.
  await assert.rejects(
    p,
    /Error: opencode produced no output for 2 consecutive minute\(s\) — killed as stalled\. Last message: working on it\.\.\.$/,
  );
});

test('an idle kill with nothing said omits the last-message clause', async () => {
  let tick: (() => void) | undefined;
  const setIntervalFn = (fn: () => void): NodeJS.Timeout => {
    tick = fn;
    return { unref() { return this; } } as unknown as NodeJS.Timeout;
  };
  const { spawnFn, children } = makeSpawn();
  const p = harness().run('x', { cwd: '/wt', spawnFn, setIntervalFn, idleTicks: 1 });
  assert.ok(tick);
  tick();
  children[0].emit('close', null);
  await assert.rejects(p, /Error: opencode produced no output for 1 consecutive minute\(s\) — killed as stalled\.$/);
});

test('idleTicks 0 disables the watchdog', async () => {
  let armed = false;
  const setIntervalFn = (): NodeJS.Timeout => { armed = true; return { unref() { return this; } } as unknown as NodeJS.Timeout; };
  const { spawnFn } = makeSpawn({ stdout: REAL_STREAM });
  await harness().run('x', { cwd: '/wt', spawnFn, setIntervalFn, idleTicks: 0 });
  assert.equal(armed, false);
});

test('an aborted run resolves with what was spent, marked cancelled', async () => {
  const ac = new AbortController();
  const { spawnFn, children } = makeSpawn();
  const p = harness().run('x', { cwd: '/wt', spawnFn, signal: ac.signal });
  children[0].stdout.emit('data', Buffer.from(REAL_STREAM));
  ac.abort();
  children[0].emit('close', null);
  const r = await p;
  assert.equal(r.stoppedBy, 'cancelled');
  assert.equal(r.usage.inputTokens, 6472);
  assert.equal(r.sessionId, REAL_SESSION);
  assert.match(r.text, /cancelled after 1 turn\(s\).*PARTIAL/);
});

test('killAll with nothing in flight is a no-op', () => {
  assert.doesNotThrow(() => harness().killAll());
});

// ---- binary resolution ------------------------------------------------------

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), 'oc-bin-'));
}

test('OPENCODE_BIN wins, and a .cmd shim there is refused with a clear error', () => {
  const home = tempHome();
  assert.equal(openCodeBin({ OPENCODE_BIN: 'C:/tools/opencode.exe' }, home), 'C:/tools/opencode.exe');
  assert.equal(openCodeBin({ OPENCODE_BIN: '"C:/tools/opencode.exe"' }, home), 'C:/tools/opencode.exe', 'quotes stripped');
  assert.throws(
    () => openCodeBin({ OPENCODE_BIN: 'C:/tools/opencode.cmd' }, home),
    (e: Error) => /opencode\.cmd/.test(e.message) && /OPENCODE_BIN/.test(e.message) && /CVE-2024-27980/.test(e.message),
  );
});

test('the packaged executable is preferred over a PATH shim', () => {
  const home = tempHome();
  const shimDir = join(home, 'shim');
  mkdirSync(shimDir, { recursive: true });
  writeFileSync(join(shimDir, 'opencode.cmd'), '@echo off\r\n');
  const win = process.platform === 'win32';
  // npmPackageExe's roots: %APPDATA%/npm on Windows, ~/.local/lib elsewhere.
  const root = win ? join(home, 'roaming', 'npm') : join(home, '.local', 'lib');
  const exe = join(root, 'node_modules', 'opencode-ai', 'bin', win ? 'opencode.exe' : 'opencode');
  mkdirSync(join(root, 'node_modules', 'opencode-ai', 'bin'), { recursive: true });
  writeFileSync(exe, '');
  const env = { PATH: shimDir, PATHEXT: '.COM;.EXE;.BAT;.CMD', APPDATA: join(home, 'roaming') };
  assert.equal(openCodeBin(env, home), exe);
});

test('with no packaged executable a PATH .cmd shim is refused, and nothing found falls back to the bare name', { skip: process.platform !== 'win32' && 'PATHEXT lookup is Windows-only' }, () => {
  const home = tempHome();
  const shimDir = join(home, 'shim');
  mkdirSync(shimDir, { recursive: true });
  writeFileSync(join(shimDir, 'opencode.cmd'), '@echo off\r\n');
  const empty = join(home, 'empty');
  mkdirSync(empty, { recursive: true });
  assert.throws(
    () => openCodeBin({ PATH: shimDir, PATHEXT: '.COM;.EXE;.BAT;.CMD', APPDATA: empty }, home),
    /\.cmd\/\.bat shim/,
  );
  assert.equal(openCodeBin({ PATH: empty, APPDATA: empty }, home), 'opencode');
});

// ---- preflight --------------------------------------------------------------

test('preflight runs --version and reports authOk because there is no login on this lane', async () => {
  const { spawnFn, calls, children } = makeSpawn({ stdout: '1.18.30\n' });
  const r = await harness().preflight({ spawnFn, cwd: '/wt' });
  assert.deepEqual(calls[0].args, ['--version']);
  assert.equal(calls[0].bin, 'opencode-fake');
  assert.equal(calls[0].options.shell, false);
  assert.equal(children[0].stdinEnded, true);
  assert.equal(r.ok, true);
  assert.equal(r.bin, 'opencode-fake');
  assert.equal(r.version, '1.18.30');
  assert.equal(r.authOk, true);
  assert.match(r.detail ?? '', /opencode-fake/);
});

test('preflight fails on a non-zero --version and on a shim, naming the reason', async () => {
  const { spawnFn } = makeSpawn({ stderr: 'not found', code: 127 });
  const bad = await harness().preflight({ spawnFn });
  assert.equal(bad.ok, false);
  assert.equal(bad.authOk, false);
  assert.match(bad.detail ?? '', /exited 127.*not found/);

  const shim = await createOpenCodeHarness({ env: { OPENCODE_BIN: 'C:/tools/opencode.cmd' } }).preflight({ spawnFn });
  assert.equal(shim.ok, false);
  assert.match(shim.detail ?? '', /\.cmd\/\.bat shim/);
});

test('preflight reports a spawn error rather than hanging', async () => {
  const spawnFn: SpawnLike = () => {
    const child = new FakeChild();
    setImmediate(() => { child.emit('error', new Error('spawn opencode-fake ENOENT')); child.emit('close', -2); });
    return child;
  };
  const r = await harness().preflight({ spawnFn });
  assert.equal(r.ok, false);
  assert.match(r.detail ?? '', /ENOENT/);
});

// ---- capabilities / registration -------------------------------------------

// The capability block, exercised on the local lane. It can hold a warm base but
// cannot be told its name; it reports the cache split; and the budget stop is
// now honest because the guard is in the adapter.
test('capabilities are declared honestly', () => {
  assert.deepEqual(OPENCODE_CAPABILITIES, {
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
    chat: 'none',
  });
  assert.equal(fidelityFor(OPENCODE_CAPABILITIES), 'exact', 'it does report the cache split');
  assert.equal(openCodeHarness.capabilities, OPENCODE_CAPABILITIES);
  assert.equal(openCodeHarness.id, 'opencode');
  assert.equal(openCodeHarness.provider, 'local');
  assert.equal(openCodeHarness.chat, undefined, 'chat is none, so no chat()');
});

test('the local provider is a sanctioned, credential-free, locally-metered lane', () => {
  assert.deepEqual(localProvider, {
    id: 'local', label: 'Local / metered (OpenCode)', credentialKind: 'none', automationStance: 'sanctioned', meter: 'local',
  });
});

test('it registers on the local provider and is addressable by id', () => {
  clearRegistries();
  try {
    assert.throws(() => registerHarness(openCodeHarness), /unknown provider "local"/);
    registerProvider(localProvider);
    registerHarness(openCodeHarness);
    assert.equal(getHarness('opencode'), openCodeHarness);
    assert.deepEqual(harnessesFor('local').map((h) => h.id), ['opencode']);
  } finally {
    clearRegistries();
  }
});
