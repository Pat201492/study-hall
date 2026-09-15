import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatEvent, ChildLike, SpawnLike, Usage } from '../src/contract.js';
import {
  CODEX_CAPABILITIES, CodexChatEventMapper, DEFAULT_THREAD_SOURCE, classifyCodexFailure, codexArgs, codexEnv,
  codexHarness, createCodexHarness, mapCodexUsage, openaiProvider, parseCodexStream, rawUsageFrom, resolveCodexBin,
  subtractUsage, usageBaseline,
} from '../src/adapters/codex.js';
import { parseCodexReset } from '../src/adapters/codexReset.js';
import { clearRegistries, fidelityFor, harnessesFor, registerHarness, registerProvider } from '../src/registry.js';

// Fixtures are the RAW stdout of the real `codex exec --json` (0.154.0) runs
// recorded in docs/adr/ADR-001-codex-spikes.md — not hand-written to match the
// parser. Their arithmetic is the load-bearing part:
//   exec-new     input 14134 / cached 9984 / output 5      (thread A, one turn)
//   exec-resume  input 28286 / cached 19968 / output 11    (thread A, turn two)
//   exec-fork    same totals on a NEW thread forked off A
// 28286 == 14134 + 14152: the second turn REPORTS THE THREAD TOTAL, so a warm
// slot must diff against a baseline. And the rollout's total_tokens for the
// base turn was 14139 == 14134 + 5, so input_tokens INCLUDES the cached 9984.
const fixture = (name: string): string => readFileSync(new URL(`./fixtures/codex/${name}`, import.meta.url), 'utf8');
const lines = (name: string): string[] => fixture(name).split('\n').filter((l) => l.trim());
const NEW = fixture('exec-new.jsonl');
const RESUME = fixture('exec-resume.jsonl');
const FORK = fixture('exec-fork.jsonl');
const ERROR = fixture('exec-error.jsonl');
const BASE_ID = '01a0a077-4032-7723-ab2a-a005300c3e48';
const FORK_ID = '01a0a077-a53e-7871-9d30-95b09509f81a';
const BASE_RAW = { input_tokens: 14134, cached_input_tokens: 9984, cache_write_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0 };
const BASE_USAGE: Usage = { inputTokens: 4150, outputTokens: 5, cacheReadInputTokens: 9984, cacheCreationInputTokens: 0, reasoningTokens: 0 };
const SECOND_TURN: Usage = { inputTokens: 4168, outputTokens: 6, cacheReadInputTokens: 9984, cacheCreationInputTokens: 0, reasoningTokens: 0 };

type SpawnOpts = Parameters<SpawnLike>[2];

/** EventEmitter child double. No pid on purpose: treeKill is a no-op on a
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

interface Script { stdout?: string | string[]; stderr?: string; code?: number | null; error?: Error }
type ScriptFn = (args: string[], call: number) => Script | undefined;

function makeSpawn(script?: Script | ScriptFn) {
  const calls: { bin: string; args: string[]; options: SpawnOpts }[] = [];
  const children: FakeChild[] = [];
  const spawnFn: SpawnLike = (bin, args, options) => {
    const child = new FakeChild();
    const s = typeof script === 'function' ? script(args, calls.length) : script;
    calls.push({ bin, args, options });
    children.push(child);
    if (s) {
      setImmediate(() => {
        if (s.error) { child.emit('error', s.error); return; }
        const chunks = Array.isArray(s.stdout) ? s.stdout : s.stdout ? [s.stdout] : [];
        for (const c of chunks) child.stdout.emit('data', Buffer.from(c));
        if (s.stderr) child.stderr.emit('data', Buffer.from(s.stderr));
        child.emit('close', s.code === undefined ? 0 : s.code);
      });
    }
    return child;
  };
  return { spawnFn, calls, children };
}

const FAKE_BIN = 'C:/fake/codex.exe';
const harness = (env: NodeJS.ProcessEnv = { PATH: '' }) =>
  createCodexHarness({ bin: FAKE_BIN, env, home: '/nonexistent', now: () => 1000 });

// ---- capabilities / provider -------------------------------------------------

test('capabilities are declared honestly and the harness registers on the gray openai provider', () => {
  assert.equal(codexHarness.id, 'codex');
  assert.equal(codexHarness.provider, 'openai');
  assert.equal(CODEX_CAPABILITIES.warmSessions, true);
  assert.equal(CODEX_CAPABILITIES.seedableSessions, false, 'thread ids are Codex-generated UUIDv7; adopt-only');
  assert.equal(CODEX_CAPABILITIES.forkSessions, true);
  assert.equal(CODEX_CAPABILITIES.usageIsCumulative, true, 'turn.completed.usage is the thread total');
  assert.equal(CODEX_CAPABILITIES.cacheUsageSplit, true);
  assert.equal(CODEX_CAPABILITIES.streamsUsage, false, 'usage arrives only at turn.completed');
  assert.equal(CODEX_CAPABILITIES.budgetStop, false);
  assert.equal(CODEX_CAPABILITIES.promptTransport, 'stdin');
  assert.equal(CODEX_CAPABILITIES.chat, 'resume-loop');
  assert.deepEqual(CODEX_CAPABILITIES.sandboxModes, ['read-only', 'workspace-write', 'none']);
  assert.equal(fidelityFor(CODEX_CAPABILITIES), 'exact');
  assert.equal(openaiProvider.automationStance, 'gray');
  assert.equal(openaiProvider.meter, 'subscription');
  assert.equal(openaiProvider.credentialKind, 'oauth_subscription');
  assert.equal(openaiProvider.concurrencyCap, 2);
  clearRegistries();
  registerProvider(openaiProvider);
  registerHarness(codexHarness);
  assert.deepEqual(harnessesFor('openai').map((h) => h.id), ['codex']);
  clearRegistries();
});

// ---- argv ------------------------------------------------------------------

test('a bare new run: globals before the subcommand, the stdin sentinel last', () => {
  assert.deepEqual(codexArgs({ cwd: '/wt' }), [
    'exec', '--json', '--skip-git-repo-check', '--cd', '/wt',
    '--sandbox', 'workspace-write',
    '--ignore-user-config', '--ignore-rules',
    '--thread-source', DEFAULT_THREAD_SOURCE,
    '-c', 'approval_policy="never"',
    '-',
  ]);
});

test('every option lands in the documented position, in order', () => {
  assert.deepEqual(codexArgs({
    cwd: 'C:/wt', model: 'gpt-5.6-terra', effort: 'xhigh', sandbox: 'read-only',
    session: { mode: 'resume', base: BASE_ID },
    extra: {
      threadSource: 'lane-a',
      configOverrides: { web_search: '"disabled"', 'sandbox_workspace_write.network_access': 'true' },
      outputSchemaFile: 'C:/schema.json',
      lastMessageFile: 'C:/last.txt',
    },
  }), [
    'exec', '--json', '--skip-git-repo-check', '--cd', 'C:/wt',
    '-m', 'gpt-5.6-terra',
    '--sandbox', 'read-only',
    '--ignore-user-config', '--ignore-rules',
    '--thread-source', 'lane-a',
    '-c', 'approval_policy="never"',
    '-c', 'model_reasoning_effort="xhigh"',
    '-c', 'web_search="disabled"',
    '-c', 'sandbox_workspace_write.network_access=true',
    '--output-schema', 'C:/schema.json',
    '-o', 'C:/last.txt',
    'resume', BASE_ID, '-',
  ]);
});

test('sandbox none is the bypass flag, never --sandbox', () => {
  const args = codexArgs({ cwd: '/wt', sandbox: 'none' });
  assert.ok(args.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.ok(!args.includes('--sandbox'));
});

test('fork and resume are subcommands appended last with the base id and the stdin sentinel', () => {
  assert.deepEqual(codexArgs({ cwd: '/wt', session: { mode: 'fork', base: BASE_ID } }).slice(-3), ['fork', BASE_ID, '-']);
  assert.deepEqual(codexArgs({ cwd: '/wt', session: { mode: 'resume', base: BASE_ID } }).slice(-3), ['resume', BASE_ID, '-']);
  // A seed is meaningless on an adopt-only harness; a resume without a base cannot be honoured.
  assert.deepEqual(codexArgs({ cwd: '/wt', session: { mode: 'new', seed: 'chosen' } }).slice(-1), ['-']);
  assert.deepEqual(codexArgs({ cwd: '/wt', session: { mode: 'resume' } }).slice(-1), ['-']);
  assert.ok(!codexArgs({ cwd: '/wt', session: { mode: 'new', seed: 'chosen' } }).includes('chosen'));
});

test('extra.ignoreUserConfig=false keeps the operator config.toml (config-file MCP servers) but still skips .rules', () => {
  const args = codexArgs({ cwd: '/wt', extra: { ignoreUserConfig: false } });
  assert.ok(!args.includes('--ignore-user-config'));
  assert.ok(args.includes('--ignore-rules'));
});

test('a quote inside the effort value cannot break out of the TOML string', () => {
  const args = codexArgs({ cwd: '/wt', effort: 'hi"gh' });
  assert.equal(args[args.indexOf('-c', args.indexOf('approval_policy="never"')) + 1], 'model_reasoning_effort="hi\\"gh"');
});

// ---- spawn shape -------------------------------------------------------------

test('the prompt goes on stdin (then stdin ends), argv is codexArgs, and the spawn never uses a shell', async () => {
  const { spawnFn, calls, children } = makeSpawn({ stdout: NEW });
  const opts = { cwd: '/wt', model: 'gpt-5.6-luna', spawnFn, session: { mode: 'fork' as const, base: BASE_ID } };
  await harness().run('fix the bug & ship it', opts);
  assert.equal(calls[0].bin, FAKE_BIN);
  assert.deepEqual(calls[0].args, codexArgs(opts));
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.cwd, '/wt');
  assert.deepEqual(children[0].stdinWrites, ['fix the bug & ship it']);
  assert.equal(children[0].stdinEnded, true);
});

test('inherited API keys are stripped, opts.env wins, CODEX_HOME comes from extra.codexHome', async () => {
  const { spawnFn, calls } = makeSpawn({ stdout: NEW });
  await harness({ PATH: '', CODEX_API_KEY: 'sk-stray', OPENAI_API_KEY: 'sk-stray2', KEEP: '1' }).run('x', {
    cwd: '/wt', spawnFn, env: { EXTRA: 'yes' }, extra: { codexHome: 'C:/study-hall/.codex' },
  });
  const env = calls[0].options.env!;
  assert.equal(env.CODEX_API_KEY, undefined, 'a stray key would move the lane off the subscription');
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.KEEP, '1');
  assert.equal(env.EXTRA, 'yes');
  assert.equal(env.CODEX_HOME, 'C:/study-hall/.codex');
  // An explicit opts.env key is the operator's choice and survives.
  assert.equal(codexEnv({ env: { CODEX_API_KEY: 'deliberate' } }, { CODEX_API_KEY: 'stray' }).CODEX_API_KEY, 'deliberate');
});

// ---- parsing the real streams ---------------------------------------------------

test('the real exec-new stream parses: thread id adopted, last agent_message is the text, usage mapped', async () => {
  const usages: Usage[] = [];
  const { spawnFn } = makeSpawn({ stdout: NEW });
  const r = await harness().run('Reply with exactly the word OK.', { cwd: '/wt', spawnFn, onUsage: (u) => usages.push(u) });
  assert.equal(r.text, 'OK');
  assert.equal(r.sessionId, BASE_ID);
  assert.equal(r.turns, 1);
  assert.equal(r.exitCode, 0);
  assert.equal(r.meter, 'subscription');
  assert.equal(r.costUsd, null);
  assert.equal(r.stoppedBy, undefined);
  assert.deepEqual(r.usage, BASE_USAGE);
  assert.deepEqual(usages, [BASE_USAGE], 'one turn.completed, one usage report');
  const raw = r.raw as { cumulativeUsage: unknown; threadStarted: { type: string }; turnCompleted: { type: string } };
  assert.deepEqual(raw.cumulativeUsage, BASE_RAW, 'the raw thread totals ride along so a warm slot can store its baseline');
  assert.equal(raw.threadStarted.type, 'thread.started');
  assert.equal(raw.turnCompleted.type, 'turn.completed');
});

test('input_tokens includes the cached subset: fresh input is the difference', () => {
  // The base turn's rollout said total_tokens 14139 == input 14134 + output 5, so
  // cached 9984 is INSIDE input_tokens; billing fresh input as 14134 would price
  // the cache read at full rate.
  assert.deepEqual(mapCodexUsage(BASE_RAW), BASE_USAGE);
  assert.equal(BASE_USAGE.inputTokens + BASE_USAGE.cacheReadInputTokens, 14134);
  assert.deepEqual(mapCodexUsage(null), { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, reasoningTokens: 0 });
  assert.deepEqual(rawUsageFrom({ input_tokens: 3, cached_input_tokens: 1, output_tokens: 2, reasoning_output_tokens: 1 }),
    { input_tokens: 3, cached_input_tokens: 1, cache_write_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 1 });
});

test('a resumed thread reports the THREAD TOTAL; diffing against the stored baseline yields the turn', async () => {
  const p = parseCodexStream(lines('exec-resume.jsonl').map((l) => JSON.parse(l) as Record<string, unknown>));
  assert.equal(p.sessionId, BASE_ID, 'resume echoes the SAME thread id');
  assert.equal(p.text, 'TWO');
  assert.equal(p.cumulativeUsage!.input_tokens, 28286);
  assert.equal(28286, 14134 + 14152, 'the second turn added 14152 (= 14134 + "OK" + the new user message)');
  assert.equal(p.cumulativeUsage!.cached_input_tokens, 2 * 9984);
  assert.equal(p.cumulativeUsage!.output_tokens, 5 + 6);

  // Baseline in Codex's raw shape (what raw.cumulativeUsage hands back)…
  const { spawnFn } = makeSpawn({ stdout: RESUME });
  const r = await harness().run('Reply with exactly the word TWO.', {
    cwd: '/wt', spawnFn, session: { mode: 'resume', base: BASE_ID }, extra: { usageBaseline: BASE_RAW },
  });
  assert.deepEqual(r.usage, SECOND_TURN);
  // …or in contract Usage shape: the mapping is linear, so both give the turn.
  const { spawnFn: spawn2 } = makeSpawn({ stdout: RESUME });
  const r2 = await harness().run('x', { cwd: '/wt', spawnFn: spawn2, extra: { usageBaseline: BASE_USAGE } });
  assert.deepEqual(r2.usage, SECOND_TURN);
  // Without a baseline the caller gets the (over-counted) total — and the flag
  // usageIsCumulative on the capabilities is what tells the arena it must diff.
  const { spawnFn: spawn3 } = makeSpawn({ stdout: RESUME });
  const r3 = await harness().run('x', { cwd: '/wt', spawnFn: spawn3 });
  assert.equal(r3.usage.inputTokens, 28286 - 19968);
});

test('a fork off the base mints a NEW thread id and inherits the base totals the same way', async () => {
  const { spawnFn } = makeSpawn({ stdout: FORK });
  const r = await harness().run('Reply with exactly the word THREE.', {
    cwd: '/wt', spawnFn, session: { mode: 'fork', base: BASE_ID }, extra: { usageBaseline: BASE_RAW },
  });
  assert.equal(r.sessionId, FORK_ID);
  assert.notEqual(r.sessionId, BASE_ID);
  assert.equal(r.text, 'THREE');
  assert.deepEqual(r.usage, SECOND_TURN);
});

test('subtractUsage saturates at zero and usageBaseline tolerates junk', () => {
  assert.deepEqual(subtractUsage(BASE_USAGE, SECOND_TURN), {
    inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, reasoningTokens: 0,
  });
  assert.deepEqual(usageBaseline(undefined), { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, reasoningTokens: 0 });
  assert.deepEqual(usageBaseline({ usageBaseline: 'nope' }), usageBaseline({}));
  assert.deepEqual(usageBaseline({ usageBaseline: BASE_RAW }), BASE_USAGE);
});

test('every raw line reaches the transcript sink once, and a line split across chunks is reassembled', async () => {
  const cut = NEW.indexOf('"usage"') + 9;
  const chunks = [NEW.slice(0, 30), NEW.slice(30, cut), NEW.slice(cut)];
  const seen: string[] = [];
  const usages: number[] = [];
  const { spawnFn } = makeSpawn({ stdout: chunks, stderr: 'Reading additional input from stdin...\n' });
  const r = await harness().run('x', { cwd: '/wt', spawnFn, transcriptSink: (l) => seen.push(l), onUsage: (u) => usages.push(u.inputTokens) });
  assert.equal(r.text, 'OK');
  assert.deepEqual(seen, lines('exec-new.jsonl'));
  assert.deepEqual(usages, [4150], 'one turn.completed, one usage report — not one per chunk');
});

test('a final unterminated line is flushed at close', async () => {
  const { spawnFn } = makeSpawn({ stdout: NEW.trimEnd() });
  const r = await harness().run('x', { cwd: '/wt', spawnFn });
  assert.equal(r.turns, 1);
  assert.deepEqual(r.usage, BASE_USAGE);
});

// ---- failure paths -----------------------------------------------------------

test('no thread.started / turn.completed at all rejects with the wording the infra classifier keys on', async () => {
  const stderr = 'Error: features.rollout_budget.reminder_at_remaining_tokens is required when rollout_budget is enabled\n';
  const { spawnFn } = makeSpawn({ stderr, code: 1 });
  await assert.rejects(harness().run('x', { cwd: '/wt', spawnFn }), (e: Error) => {
    assert.match(e.message, /^codex exec \(1\) returned no JSON result: Error: features\.rollout_budget/);
    assert.equal(codexHarness.classifyFailure(e.message).kind, 'infra');
    return true;
  });
});

test('an empty run says so rather than printing an empty tail', async () => {
  const { spawnFn } = makeSpawn({ code: 0 });
  await assert.rejects(harness().run('x', { cwd: '/wt', spawnFn }), /returned no JSON result: \(no output\)/);
});

test('the real error stream (bad model) rejects with the provider text, which classifies as the task\'s fault', async () => {
  const { spawnFn } = makeSpawn({ stdout: ERROR, code: 1 });
  await assert.rejects(harness().run('x', { cwd: '/wt', spawnFn }), (e: Error) => {
    assert.match(e.message, /'nonexistent-model-xyz' model is not supported when using Codex with a ChatGPT account/);
    assert.equal(classifyCodexFailure(e.message).kind, 'task');
    return true;
  });
  const p = parseCodexStream(lines('exec-error.jsonl').map((l) => JSON.parse(l) as Record<string, unknown>));
  assert.equal(p.errors.length, 1, 'error + turn.failed carry the same text and collapse into one');
  assert.equal(p.warnings.length, 1, 'the non-fatal item.type=error is a warning');
  assert.equal(p.turns, 0);
  assert.equal(p.sessionId, '01a0a079-9094-74b1-9dce-b402707949a5');
});

test('a spawn failure rejects on the run promise and classifies as infra', async () => {
  const { spawnFn } = makeSpawn({ error: new Error(`spawn ${FAKE_BIN} ENOENT`) });
  await assert.rejects(harness().run('x', { cwd: '/wt', spawnFn }), (e: Error) => {
    assert.match(e.message, /returned no JSON result: spawn C:\/fake\/codex\.exe ENOENT/);
    assert.equal(classifyCodexFailure(e.message).kind, 'infra');
    return true;
  });
});

test('a usage-limit turn.failed rejects with Codex\'s wording and classifies as capacity with the reset', async () => {
  const msg = 'You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 3:40 PM.';
  const stream = [
    `{"type":"thread.started","thread_id":"${BASE_ID}"}`,
    '{"type":"turn.started"}',
    `{"type":"error","message":${JSON.stringify(msg)}}`,
    `{"type":"turn.failed","error":{"message":${JSON.stringify(msg)}}}`,
  ].join('\n') + '\n';
  const { spawnFn } = makeSpawn({ stdout: stream, code: 1 });
  await assert.rejects(harness().run('x', { cwd: '/wt', spawnFn }), (e: Error) => {
    assert.equal(e.message, msg);
    const now = new Date(2026, 8, 14, 10, 0).getTime();
    const v = codexHarness.classifyFailure(e.message, now);
    assert.equal(v.kind, 'capacity');
    assert.equal(v.resetAt, parseCodexReset(msg, now));
    return true;
  });
});

// ---- classifyFailure table ---------------------------------------------------

test('classifyFailure: auth', () => {
  for (const m of [
    'The access token could not be refreshed. Please log out and sign in again.',
    'Please sign in again to continue.',
    'Not logged in',
    'codex: log out and sign in again',
  ]) assert.equal(classifyCodexFailure(m).kind, 'auth', m);
});

test('classifyFailure: capacity — including the U+2019 apostrophe Codex actually prints', () => {
  for (const m of [
    'You’ve hit your usage limit. Try again later.',              // U+2019
    "You've hit your usage limit. Try again at 3:40 PM.",          // ASCII, in case a shell re-encodes it
    'You’ve hit your usage limit for gpt-6-astra. Switch to another model now, or try again at 3:40 PM.',
    'Quota exceeded. Check your plan and billing details.',
    'exceeded retry limit, last status: 429 Too Many Requests',
    'rate limit exceeded',
    'Selected model is at capacity. Please try a different model.',
    'We’re currently experiencing high demand, which may cause temporary errors.',
    'Your workspace is out of credits.',
    'You have reached your spend cap for this month.',
  ]) assert.equal(classifyCodexFailure(m).kind, 'capacity', m);
  const now = new Date(2026, 8, 14, 10, 0).getTime();
  const v = classifyCodexFailure('You’ve hit your usage limit. Try again at 3:40 PM.', now);
  assert.equal(v.resetAt, new Date(2026, 8, 14, 15, 40).getTime() + 60_000);
  assert.equal(classifyCodexFailure('You’ve hit your usage limit. Try again later.', now).resetAt, undefined);
});

test('classifyFailure: infra', () => {
  for (const m of [
    'codex exec (1) returned no JSON result: Error loading config.toml',
    'spawn C:/x/codex.exe ENOENT',
    'ETXTBSY: text file busy',
    'Connection failed: connection reset',
    'stream disconnected before completion',
  ]) assert.equal(classifyCodexFailure(m).kind, 'infra', m);
});

test('classifyFailure: task — a rollout budget trip or a context overflow is not the provider being down', () => {
  for (const m of [
    'shared rollout token budget exhausted',
    "Codex ran out of room in the model's context window",
    'Codex ran out of room in the model’s context window',
    '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'x\' model is not supported when using Codex with a ChatGPT account."}}',
    'the tests failed',
  ]) assert.equal(classifyCodexFailure(m).kind, 'task', m);
});

// ---- guards ----------------------------------------------------------------

test('a token budget trips after turn.completed and RESOLVES with stoppedBy budget and the usage', async () => {
  const stops: { turns: number; tokens: number; limit: string }[] = [];
  const { spawnFn } = makeSpawn({ stdout: NEW });
  const r = await harness().run('x', { cwd: '/wt', spawnFn, budget: { maxTokens: 100 }, onBudgetStop: (i) => stops.push(i) });
  assert.equal(r.stoppedBy, 'budget');
  assert.deepEqual(r.usage, BASE_USAGE);
  assert.deepEqual(stops.map((s) => s.limit), ['maxTokens']);
  assert.equal(stops[0].tokens, 4150 + 9984, 'billed = fresh input + cache read + cache write');
});

test('a cancel RESOLVES with stoppedBy cancelled and whatever partial usage was seen', async () => {
  const { spawnFn, children } = makeSpawn();
  const ac = new AbortController();
  const p = harness().run('x', { cwd: '/wt', spawnFn, signal: ac.signal });
  children[0].stdout.emit('data', Buffer.from(`{"type":"thread.started","thread_id":"${BASE_ID}"}\n`));
  ac.abort();
  children[0].emit('close', null);
  const r = await p;
  assert.equal(r.stoppedBy, 'cancelled');
  assert.equal(r.sessionId, BASE_ID);
  assert.equal(r.turns, 0);
  assert.match(r.text, /PARTIAL/);
});

test('an idle kill REJECTS as stalled, carrying the last thing the model said', async () => {
  let tick: (() => void) | undefined;
  const { spawnFn, children } = makeSpawn();
  const p = harness().run('x', {
    cwd: '/wt', spawnFn, idleTicks: 1,
    setIntervalFn: (fn) => { tick = fn; return { unref() { /* fake */ } } as unknown as NodeJS.Timeout; },
  });
  children[0].stdout.emit('data', Buffer.from('{"type":"item.completed","item":{"id":"i","type":"agent_message","text":"halfway there"}}\n'));
  tick!(); // saw output → counter reset
  tick!(); // silent tick → killed
  children[0].emit('close', null);
  await assert.rejects(p, /codex exec produced no output for 1 consecutive minute\(s\) — killed as stalled\. Last message: halfway there/);
});

// ---- binary resolution -------------------------------------------------------

test('resolveCodexBin walks past the npm shim to the platform package exe (nested or hoisted)', () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-bin-'));
  const npm = join(root, 'npm');
  const nested = join(npm, 'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin');
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(nested, 'codex.exe'), '');
  writeFileSync(join(npm, 'codex'), '#!/bin/sh');
  writeFileSync(join(npm, 'codex.cmd'), '@echo off');
  const env = { PATH: npm, Path: npm, APPDATA: root, PATHEXT: '.COM;.EXE;.BAT;.CMD' };
  // The extension-less sh shim is what resolveBin picks first on Windows; it is not spawnable.
  const r = resolveCodexBin('codex', env, '/nonexistent', 'win32', 'x64');
  assert.equal(r.path, join(nested, 'codex.exe'));
  assert.equal(r.found, true);
  assert.equal(r.isShim, false);
  // Hoisted layout.
  const hoisted = join(npm, 'node_modules', '@openai', 'codex-win32-arm64', 'vendor', 'aarch64-pc-windows-msvc', 'bin');
  mkdirSync(hoisted, { recursive: true });
  writeFileSync(join(hoisted, 'codex.exe'), '');
  assert.equal(resolveCodexBin('codex', env, '/nonexistent', 'win32', 'arm64').path, join(hoisted, 'codex.exe'));
  // Nothing found → the bare name comes back unfound so preflight can say so.
  const none = resolveCodexBin('codex', { PATH: '', Path: '', APPDATA: join(root, 'empty') }, '/nonexistent', 'win32', 'x64');
  assert.equal(none.found, false);
  assert.equal(none.path, 'codex');
  // Off Windows a PATH hit is spawnable as-is.
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'codex'), '');
  const nix = resolveCodexBin('codex', { PATH: bin }, '/nonexistent', 'linux', 'x64');
  assert.equal(nix.path, join(bin, 'codex'));
});

// ---- preflight -------------------------------------------------------------

test('preflight: --version then `login status` (which prints on STDERR); authOk is the credential store, not a completion', async () => {
  const { spawnFn, calls } = makeSpawn((args) => args[0] === '--version'
    ? { stdout: 'codex-cli 0.154.0\n' }
    : { stderr: 'Logged in using ChatGPT\n', code: 0 });
  const h = createCodexHarness({ bin: process.execPath, env: { PATH: '' }, home: '/nonexistent' });
  const r = await h.preflight({ spawnFn });
  assert.equal(r.ok, true);
  assert.equal(r.bin, process.execPath);
  assert.equal(r.version, '0.154.0');
  assert.equal(r.authOk, true);
  assert.deepEqual(calls.map((c) => c.args), [['--version'], ['login', 'status']]);
  assert.equal(calls[0].options.env?.CODEX_API_KEY, undefined);
});

test('preflight: not logged in → ok false with the reason; a missing binary never spawns', async () => {
  const { spawnFn, calls } = makeSpawn((args) => args[0] === '--version'
    ? { stdout: 'codex-cli 0.154.0\n' }
    : { stderr: 'Not logged in\n', code: 1 });
  const r = await createCodexHarness({ bin: process.execPath, env: { PATH: '' }, home: '/nonexistent' }).preflight({ spawnFn });
  assert.equal(r.ok, false);
  assert.equal(r.authOk, false);
  assert.match(r.detail!, /Not logged in/);
  assert.equal(calls.length, 2);

  const { spawnFn: neverSpawn, calls: none } = makeSpawn();
  const missing = await harness().preflight({ spawnFn: neverSpawn });
  assert.equal(missing.ok, false);
  assert.match(missing.detail!, /not found/);
  assert.equal(none.length, 0);
});

// ---- chat: resume loop ------------------------------------------------------

test('the chat event mapper: tool items pair a tool_call with a tool_result; duplicate errors collapse', () => {
  const m = new CodexChatEventMapper();
  const evs: ChatEvent[] = [];
  for (const l of lines('exec-error.jsonl')) evs.push(...m.map(JSON.parse(l) as Record<string, unknown>));
  assert.deepEqual(evs.map((e) => e.type), ['status', 'status', 'error']);
  assert.match((evs[1] as { message: string }).message, /^warning: Model metadata/);
  assert.equal((evs[2] as { verdict: { kind: string } }).verdict.kind, 'task');
  assert.equal(m.sessionId, '01a0a079-9094-74b1-9dce-b402707949a5');

  const started = m.map({ type: 'item.started', item: { id: 'c1', type: 'command_execution', command: 'npm test', status: 'in_progress' } });
  assert.deepEqual(started, [{ type: 'tool_call', id: 'c1', name: 'command_execution', input: { command: 'npm test' } }]);
  const done = m.map({ type: 'item.completed', item: { id: 'c1', type: 'command_execution', command: 'npm test', aggregated_output: 'ok', exit_code: 0, status: 'completed' } });
  assert.equal(done.length, 1);
  assert.equal(done[0].type, 'tool_result');
  assert.equal((done[0] as { isError?: boolean }).isError, false);
  const mcp = m.map({ type: 'item.completed', item: { id: 'm1', type: 'mcp_tool_call', server: 'github', tool: 'get_issue', arguments: { n: 1 }, error: 'boom', status: 'failed' } });
  assert.deepEqual(mcp.map((e) => e.type), ['tool_call', 'tool_result'], 'no item.started seen → the call is synthesised');
  assert.equal((mcp[0] as { name: string }).name, 'github.get_issue');
  assert.equal((mcp[1] as { isError?: boolean }).isError, true);
  const text = m.map({ type: 'item.completed', item: { id: 't', type: 'agent_message', text: 'hi' } });
  assert.deepEqual(text, [{ type: 'text', text: 'hi' }]);
});

test('chat: the first send creates the thread and adopts its id; later sends resume it; usage is the per-turn diff', async () => {
  const { spawnFn, calls, children } = makeSpawn((_args, call) => ({ stdout: call === 0 ? NEW : RESUME }));
  const h = harness();
  const s = h.chat!({ cwd: '/wt', model: 'gpt-5.6-terra', spawnFn, systemPrompt: 'You are the planner.', mcpConfig: 'C:/mcp.json' });
  const evs: ChatEvent[] = [];
  s.on((e) => evs.push(e));
  assert.equal(s.sessionId, null);

  await s.send('Reply with exactly the word OK.');
  assert.equal(s.sessionId, BASE_ID);
  assert.deepEqual(calls[0].args.slice(-1), ['-']);
  assert.ok(!calls[0].args.includes('resume'));
  assert.ok(!calls[0].args.includes('--ignore-user-config'), 'chat reads the operator config.toml so config-file MCP servers load');
  assert.equal(children[0].stdinWrites[0], 'You are the planner.\n\nReply with exactly the word OK.');
  assert.ok(evs.some((e) => e.type === 'status' && /mcpConfig ignored/.test(e.message)));
  const done1 = evs.find((e) => e.type === 'turn_done') as { usage: Usage; sessionId: string };
  assert.deepEqual(done1.usage, BASE_USAGE);
  assert.equal(done1.sessionId, BASE_ID);
  assert.deepEqual(evs.filter((e) => e.type === 'text'), [{ type: 'text', text: 'OK' }]);

  evs.length = 0;
  await s.send('Reply with exactly the word TWO.');
  assert.deepEqual(calls[1].args.slice(-3), ['resume', BASE_ID, '-']);
  assert.equal(children[1].stdinWrites[0], 'Reply with exactly the word TWO.', 'the system prompt rides only the first turn');
  const done2 = evs.find((e) => e.type === 'turn_done') as { usage: Usage };
  assert.deepEqual(done2.usage, SECOND_TURN, 'the thread total minus the previous turn');
  assert.equal(s.sessionId, BASE_ID);

  await s.close();
  assert.deepEqual(evs.slice(-1), [{ type: 'closed', exitCode: null }]);
  await assert.rejects(s.send('again'), /closed/);
});

test('chat: a run that produces no JSON surfaces an infra error event instead of hanging', async () => {
  const { spawnFn } = makeSpawn({ stderr: 'Error loading config.toml: boom\n', code: 1 });
  const s = harness().chat!({ cwd: '/wt', spawnFn });
  const evs: ChatEvent[] = [];
  s.on((e) => evs.push(e));
  await s.send('x');
  const err = evs.find((e) => e.type === 'error') as { message: string; verdict: { kind: string } };
  assert.match(err.message, /codex exec \(1\) returned no JSON result: Error loading config\.toml: boom/);
  assert.equal(err.verdict.kind, 'infra');
});
