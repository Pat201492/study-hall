import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Harness, HarnessCapabilities, HarnessRunOptions, HarnessRunResult, Usage } from '../src/contract.js';
import { ZERO_USAGE } from '../src/contract.js';
import { claudeCodeHarness, CLAUDE_CODE_CAPABILITIES } from '../src/adapters/claudeCode.js';
import { WarmSlot, type WarmRunFn } from '../src/warmSlot.js';

// The seed-then-fork state machine, generalised over the contract. What it
// defends: a slot must never emit session flags at a harness that ignores them
// (a slot reporting itself warm while paying full ramp-up every task is
// invisible except as cost), and an adopt-only harness must learn its base id
// from the first run rather than invent one.

function result(over: Partial<HarnessRunResult> = {}): HarnessRunResult {
  return {
    text: '', usage: { ...ZERO_USAGE }, sessionId: 'x', turns: 1, meter: 'subscription',
    durationMs: 1, exitCode: 0, ...over,
  };
}

/** A runner that records the options each run received and hands back the given
 *  session ids in order — standing in for a server that names its own sessions. */
function recorder(sessionIds: string[], usages: Usage[] = []) {
  const seen: HarnessRunOptions[] = [];
  let i = 0;
  const runFn: WarmRunFn = async (_p, o) => {
    seen.push(o);
    const n = i++;
    return result({ sessionId: sessionIds[n] ?? '', usage: usages[n] ?? { ...ZERO_USAGE } });
  };
  return { runFn, seen };
}

/** A harness that admits exactly what it is told it can do. */
function stubHarness(id: string, over: Partial<HarnessCapabilities> = {}): Harness {
  return {
    id,
    provider: 'stub',
    capabilities: {
      ...CLAUDE_CODE_CAPABILITIES,
      warmSessions: false, seedableSessions: false, forkSessions: false, usageIsCumulative: false,
      ...over,
    },
    run: async () => result(),
    killAll: () => {},
    classifyFailure: () => ({ kind: 'task' }),
    preflight: async () => ({ ok: true, bin: id }),
  };
}

/** Adopt-only with fork (OpenCode / Codex shape). */
const adoptOnly = (over: Partial<HarnessCapabilities> = {}) =>
  stubHarness('adopt-only', { warmSessions: true, seedableSessions: false, forkSessions: true, ...over });

// ---- the seedable path (Claude Code) ------------------------------------------------

test('first task seeds the base with {new, seed}; later tasks fork with {fork, base}', async () => {
  const { runFn, seen } = recorder(['base', 'fork']);
  const s = new WarmSlot({ harness: claudeCodeHarness, id: 'slot-uuid', runFn });

  assert.equal(s.isWarm, false);
  assert.deepEqual(s.nextSession(), { mode: 'new', seed: 'slot-uuid' });
  await s.run('prompt 1', { cwd: '/wt', model: 'claude-opus-4-8' });
  assert.equal(s.isWarm, true);
  await s.run('prompt 2', { cwd: '/wt', model: 'claude-opus-4-8' });

  assert.deepEqual(seen[0].session, { mode: 'new', seed: 'slot-uuid' });
  assert.deepEqual(seen[1].session, { mode: 'fork', base: 'slot-uuid' });
  assert.equal(seen[1].cwd, '/wt');
  assert.equal(seen[1].model, 'claude-opus-4-8');
  assert.equal(s.baseId, 'slot-uuid');
});

test('a seedable slot resumes ITS id, not the one the run returned', async () => {
  const { runFn, seen } = recorder(['ses_server_would_say_this']);
  const s = new WarmSlot({ harness: claudeCodeHarness, id: 'slot-uuid', runFn });
  await s.run('one', { cwd: '/wt' });
  await s.run('two', { cwd: '/wt' });
  assert.deepEqual(seen[1].session, { mode: 'fork', base: 'slot-uuid' });
  assert.equal(s.baseId, 'slot-uuid');
  assert.equal(s.usageBaseline, null, 'per-run usage needs no baseline');
  assert.equal(seen[1].extra, undefined);
});

test('second task on a warm slot shows a cache hit / lower input tokens than the first', async () => {
  const cold: Usage = { inputTokens: 2000, outputTokens: 50, cacheReadInputTokens: 0, cacheCreationInputTokens: 2000, reasoningTokens: 0 };
  const warm: Usage = { inputTokens: 30, outputTokens: 50, cacheReadInputTokens: 1980, cacheCreationInputTokens: 0, reasoningTokens: 0 };
  const { runFn } = recorder(['base', 'fork'], [cold, warm]);
  const s = new WarmSlot({ harness: claudeCodeHarness, id: 'slot-uuid', runFn });
  const r1 = await s.run('prompt 1', { cwd: '/wt' });
  const r2 = await s.run('prompt 2', { cwd: '/wt' });
  assert.ok(r2.usage.inputTokens < r1.usage.inputTokens, 'task 2 input tokens lower');
  assert.ok(r2.usage.cacheReadInputTokens > r1.usage.cacheReadInputTokens, 'task 2 hits the cache');
});

test('state is idle-warm between runs and settles back after an error; a failed first run is not warm', async () => {
  const boom: WarmRunFn = async () => { throw new Error('cli crashed'); };
  const s = new WarmSlot({ harness: claudeCodeHarness, id: 'slot-uuid', runFn: boom });
  assert.equal(s.state, 'idle-warm');
  await assert.rejects(s.run('x', { cwd: '/wt' }), /cli crashed/);
  assert.equal(s.state, 'idle-warm');
  assert.equal(s.isWarm, false);
});

test('rejects a second concurrent run — one run at a time per slot', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const slow: WarmRunFn = async () => { await gate; return result(); };
  const s = new WarmSlot({ harness: claudeCodeHarness, id: 'slot-uuid', runFn: slow });
  const first = s.run('x', { cwd: '/wt' });
  assert.equal(s.state, 'busy');
  await assert.rejects(s.run('y', { cwd: '/wt' }), /busy/);
  release();
  await first;
  assert.equal(s.state, 'idle-warm');
});

test('generates a random uuid when none is supplied', () => {
  const { runFn } = recorder([]);
  const a = new WarmSlot({ harness: claudeCodeHarness, runFn });
  const b = new WarmSlot({ harness: claudeCodeHarness, runFn });
  assert.match(a.id, /^[0-9a-f-]{36}$/);
  assert.notEqual(a.id, b.id);
});

// ---- the adopt-only path (the six v1 adoptSession cases) ---------------------------------

test('an adopt-only slot runs bare, then forks the id the run returned, keeping the FIRST base', async () => {
  const { runFn, seen } = recorder(['ses_server_1', 'ses_server_2', 'ses_server_3']);
  const s = new WarmSlot({ harness: adoptOnly(), runFn });

  assert.equal(s.canSeed, false);
  assert.equal(s.isWarm, false, 'no base exists before the first run');
  assert.deepEqual(s.nextSession(), { mode: 'new' });

  await s.run('one', { cwd: '/wt' });
  assert.deepEqual(seen[0].session, { mode: 'new' }, 'nothing invented is sent to the server');
  assert.equal(s.isWarm, true, 'the returned id is now a real base');
  assert.equal(s.baseId, 'ses_server_1');

  await s.run('two', { cwd: '/wt' });
  assert.deepEqual(seen[1].session, { mode: 'fork', base: 'ses_server_1' });
  await s.run('three', { cwd: '/wt' });
  assert.deepEqual(seen[2].session, { mode: 'fork', base: 'ses_server_1' }, 'it keeps the FIRST base, not the latest run');
});

// A failed first run must not poison the slot. Adopting nothing and then
// resuming it would send an undefined base forever.
test('a first run that fails leaves the slot unseeded, and the next run seeds afresh', async () => {
  let calls = 0;
  const seen: HarnessRunOptions[] = [];
  const runFn: WarmRunFn = async (_p, o) => {
    seen.push(o);
    if (++calls === 1) throw new Error('provider exploded');
    return result({ sessionId: 'ses_after_retry' });
  };
  const s = new WarmSlot({ harness: adoptOnly(), runFn });
  await assert.rejects(s.run('one', { cwd: '/wt' }), /provider exploded/);
  assert.equal(s.isWarm, false, 'a crashed run is not a warm base');
  assert.equal(s.baseId, null);
  assert.equal(s.state, 'idle-warm', 'and the slot is free again');

  await s.run('two', { cwd: '/wt' });
  assert.deepEqual(seen[1].session, { mode: 'new' }, 'it seeds afresh rather than resuming nothing');
  assert.equal(s.baseId, 'ses_after_retry');
});

// A run that returns no id at all is the same situation as a crash: there is
// nothing to resume, so the slot must stay cold rather than resume ''.
test('a run that returns no session id does not become a base', async () => {
  const { runFn } = recorder(['']);
  const s = new WarmSlot({ harness: adoptOnly(), runFn });
  await s.run('one', { cwd: '/wt' });
  assert.equal(s.isWarm, false);
  assert.equal(s.baseId, null);
});

// The engine persists a base id across restarts so a resumed slot re-hits its
// warm base. On an adopt-only harness that stored id IS a real server id.
test('an adoptedId on an adopt-only harness is forked, not seeded', async () => {
  const { runFn, seen } = recorder(['ses_ignored']);
  const s = new WarmSlot({ harness: adoptOnly(), adoptedId: 'ses_from_disk', runFn });
  assert.equal(s.isWarm, true, 'a persisted id means the base already exists');
  await s.run('one', { cwd: '/wt' });
  assert.deepEqual(seen[0].session, { mode: 'fork', base: 'ses_from_disk' });
});

test('an adoptedId on a SEEDABLE harness is ignored — a generated uuid is the only base it can name', () => {
  const { runFn } = recorder([]);
  const s = new WarmSlot({ harness: claudeCodeHarness, id: 'slot', adoptedId: 'ses_from_elsewhere', runFn });
  assert.equal(s.isWarm, false);
  assert.equal(s.baseId, null);
});

// A harness with neither capability still degrades to cold runs, loudly.
test('a harness without warm sessions runs cold, stays not-warm, and says so once', async () => {
  const { runFn, seen } = recorder(['ses_1', 'ses_2']);
  const lines: string[] = [];
  const s = new WarmSlot({ harness: stubHarness('coldy'), runFn, log: (m) => lines.push(m) });
  assert.equal(s.supportsWarm, false);
  assert.equal(s.nextSession(), undefined);
  await s.run('one', { cwd: '/wt' });
  await s.run('two', { cwd: '/wt' });
  assert.equal(s.isWarm, false, 'a cold slot must never count toward warm capacity');
  assert.equal(s.baseId, null);
  for (const o of seen) assert.equal(o.session, undefined);
  assert.ok(!('session' in seen[0]), 'no session key at all — nothing for an adapter to misread');
  const warnings = lines.filter((l) => l.includes('has no warm sessions'));
  assert.equal(warnings.length, 1, 'logged once per slot, not once per task');
  assert.equal(warnings[0], 'harness "coldy" has no warm sessions — slot ' + s.id + ' runs cold, paying repo ramp-up on every task');
});

// ---- resume-only and cumulative usage (the Codex traps) --------------------------------------

test('a harness that can resume but not fork resumes its base and says so once', async () => {
  const { runFn, seen } = recorder(['ses_1', 'ses_2', 'ses_3']);
  const lines: string[] = [];
  const s = new WarmSlot({ harness: adoptOnly({ forkSessions: false }), runFn, log: (m) => lines.push(m) });
  await s.run('one', { cwd: '/wt' });
  await s.run('two', { cwd: '/wt' });
  await s.run('three', { cwd: '/wt' });
  assert.deepEqual(seen[1].session, { mode: 'resume', base: 'ses_1' });
  assert.deepEqual(seen[2].session, { mode: 'resume', base: 'ses_1' });
  const warnings = lines.filter((l) => l.includes('cannot fork sessions'));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /scratch accumulates/);
});

test('usageBaseline is captured after the seeding run on a cumulative harness and passed to later runs', async () => {
  const seedUsage: Usage = { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 900, cacheCreationInputTokens: 50, reasoningTokens: 5 };
  const { runFn, seen } = recorder(['t1', 't2', 't3'], [seedUsage, seedUsage, seedUsage]);
  const s = new WarmSlot({ harness: adoptOnly({ usageIsCumulative: true }), runFn });
  await s.run('one', { cwd: '/wt' });
  assert.deepEqual(s.usageBaseline, seedUsage);
  assert.equal(seen[0].extra, undefined, 'the seed run has nothing to diff against');

  await s.run('two', { cwd: '/wt', extra: { codexHome: '/x' } });
  assert.deepEqual(seen[1].extra, { codexHome: '/x', usageBaseline: seedUsage }, 'merged over the caller’s extra');
  assert.deepEqual(seen[1].session, { mode: 'fork', base: 't1' });

  await s.run('three', { cwd: '/wt' });
  assert.deepEqual(s.usageBaseline, seedUsage, 'the baseline is the SEED run, not the latest');
});

test('wipeContext is a no-op — the fork IS the wipe', async () => {
  const { runFn } = recorder(['base']);
  const s = new WarmSlot({ harness: claudeCodeHarness, id: 'slot', runFn });
  await s.run('one', { cwd: '/wt' });
  s.wipeContext();
  assert.equal(s.isWarm, true);
});

// ---- persistence ------------------------------------------------------------------------

test('toJSON / fromJSON round-trips a seeded seedable slot', async () => {
  const { runFn, seen } = recorder(['base', 'fork']);
  const s = new WarmSlot({ harness: claudeCodeHarness, id: 'slot-uuid', runFn });
  await s.run('one', { cwd: '/wt' });
  const json = JSON.parse(JSON.stringify(s.toJSON()));
  assert.deepEqual(json, { id: 'slot-uuid', harness: 'claude-code', baseSeeded: true, adoptedId: null, usageBaseline: null });

  const back = WarmSlot.fromJSON(json, { harness: claudeCodeHarness, runFn });
  assert.equal(back.id, 'slot-uuid');
  assert.equal(back.isWarm, true, 'a restarted engine resumes its warm base instead of paying ramp-up again');
  assert.equal(back.baseId, 'slot-uuid');
  await back.run('two', { cwd: '/wt' });
  assert.deepEqual(seen[1].session, { mode: 'fork', base: 'slot-uuid' });
});

test('toJSON / fromJSON round-trips an adopted base and its usage baseline', async () => {
  const seedUsage: Usage = { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 3, cacheCreationInputTokens: 4, reasoningTokens: 5 };
  const h = adoptOnly({ usageIsCumulative: true });
  const { runFn, seen } = recorder(['ses_1', 'ses_2'], [seedUsage]);
  const s = new WarmSlot({ harness: h, id: 'slot-a', runFn });
  await s.run('one', { cwd: '/wt' });
  const json = s.toJSON();
  assert.deepEqual(json, { id: 'slot-a', harness: 'adopt-only', baseSeeded: true, adoptedId: 'ses_1', usageBaseline: seedUsage });

  const back = WarmSlot.fromJSON(json, { harness: h, runFn });
  assert.equal(back.baseId, 'ses_1');
  assert.deepEqual(back.usageBaseline, seedUsage);
  await back.run('two', { cwd: '/wt' });
  assert.deepEqual(seen[1].session, { mode: 'fork', base: 'ses_1' });
  assert.deepEqual(seen[1].extra, { usageBaseline: seedUsage });
});

test('an unseeded slot round-trips as unseeded, and a harness mismatch throws', () => {
  const { runFn } = recorder([]);
  const s = new WarmSlot({ harness: claudeCodeHarness, id: 'slot-b', runFn });
  const back = WarmSlot.fromJSON(s.toJSON(), { harness: claudeCodeHarness, runFn });
  assert.equal(back.isWarm, false);
  assert.throws(() => WarmSlot.fromJSON(s.toJSON(), { harness: adoptOnly(), runFn }), /persisted on harness "claude-code", not "adopt-only"/);
});

test('without a runFn the slot runs on the harness itself', async () => {
  const seen: HarnessRunOptions[] = [];
  const h: Harness = { ...stubHarness('direct', { warmSessions: true, seedableSessions: true, forkSessions: true }), run: async (_p, o) => { seen.push(o); return result(); } };
  const s = new WarmSlot({ harness: h, id: 'slot-c' });
  await s.run('one', { cwd: '/wt' });
  assert.deepEqual(seen[0].session, { mode: 'new', seed: 'slot-c' });
});
