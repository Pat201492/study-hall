import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import type { ChildLike, QuotaSnapshot, SpawnLike } from '../src/contract.js';
import {
  CodexAppServerQuota, type GetAccountRateLimitsResponse, mapRateLimits, mergeRateLimitUpdate, windowLabel, windowSlot,
} from '../src/quota/codexAppServer.js';

// The fixture is the raw stdio of a real `codex app-server` (0.154.0) handshake
// on this machine, identifiers redacted. What it proves: the server OMITS the
// "jsonrpc" field on the wire; `account/rateLimits/read` answers without any
// experimentalApi capability; and a FREE plan reports ONE window —
// primary.windowDurationMins 43200 (30 days), secondary null — so a reader that
// assumed primary=5h/secondary=weekly would file a monthly cap as a 5-hour one.
const FIXTURE = readFileSync(new URL('./fixtures/codex/app-server-ratelimits.jsonl', import.meta.url), 'utf8')
  .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>);
const RATE_LIMITS = FIXTURE.find((m) => m.id === 2)!.result as GetAccountRateLimitsResponse;
const INIT_RESULT = FIXTURE.find((m) => m.id === 1)!.result;
const NOTIFICATION = FIXTURE.find((m) => m.method === 'remoteControl/status/changed')!;
const NOW = 1789398555318; // the fixture's emittedAtMs; resetsAt 1791990557 s is ~30 days later

type SpawnOpts = Parameters<SpawnLike>[2];
type Reply = { result: unknown } | { error: { code: number; message: string } } | undefined;
type Responder = (req: { id?: number; method: string; params?: unknown }) => Reply;

/** A fake app-server: parses each JSON-RPC line written to stdin and answers
 *  asynchronously the way the real one does — no "jsonrpc" field, notifications
 *  interleaved. No pid, so treeKill is a no-op and the test drives `close`. */
class FakeServer extends EventEmitter implements ChildLike {
  pid: number | undefined = undefined;
  requests: { id?: number; method: string; params?: unknown; raw: Record<string, unknown> }[] = [];
  responder: Responder = () => undefined;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = {
    write: (s: string): void => {
      for (const line of s.split('\n').filter((l) => l.trim())) {
        const raw = JSON.parse(line) as Record<string, unknown>;
        const req = { id: raw.id as number | undefined, method: raw.method as string, params: raw.params, raw };
        this.requests.push(req);
        if (req.method === 'initialize') this.emitLine(NOTIFICATION); // notifications must be tolerated
        const reply = this.responder(req);
        if (req.id !== undefined && reply) setImmediate(() => this.emitLine({ id: req.id, ...reply }));
      }
    },
    end: (): void => { /* nothing */ },
  };
  emitLine(obj: Record<string, unknown>): void { this.stdout.emit('data', Buffer.from(JSON.stringify(obj) + '\n')); }
  kill(): boolean { return true; }
}

function makeServer(responder?: Responder) {
  const servers: FakeServer[] = [];
  const calls: { bin: string; args: string[]; options: SpawnOpts }[] = [];
  const spawnFn: SpawnLike = (bin, args, options) => {
    const s = new FakeServer();
    if (responder) s.responder = responder;
    servers.push(s);
    calls.push({ bin, args, options });
    return s;
  };
  return { spawnFn, servers, calls };
}

const okResponder: Responder = (req) => {
  if (req.method === 'initialize') return { result: INIT_RESULT };
  if (req.method === 'account/rateLimits/read') return { result: RATE_LIMITS };
  return undefined;
};

interface Timer { fn: () => void; ms: number }
function fakeTimers() {
  const timers: Timer[] = [];
  const cleared: NodeJS.Timeout[] = [];
  const setIntervalFn = (fn: () => void, ms: number): NodeJS.Timeout => {
    timers.push({ fn, ms });
    return { unref() { /* fake */ } } as unknown as NodeJS.Timeout;
  };
  const clearIntervalFn = (t: NodeJS.Timeout): void => { cleared.push(t); };
  return { timers, cleared, setIntervalFn, clearIntervalFn };
}

// ---- pure mapping ------------------------------------------------------------

test('the real free-plan response maps to ONE 30-day window in extra, allowed true, and reads as AVAILABLE', () => {
  const obs = mapRateLimits(RATE_LIMITS, NOW);
  assert.equal(obs.provider, 'openai');
  assert.equal(obs.source, 'app-server');
  assert.equal(obs.observedAt, NOW);
  assert.equal(obs.allowed, true);
  assert.equal(obs.fiveHour, undefined, '43200 min is not a 5-hour window, whatever position it sits in');
  assert.equal(obs.sevenDay, undefined);
  assert.deepEqual(obs.extra, { '30d': { utilization: 0, resetsAt: 1791990557 * 1000 } });
  assert.equal(obs.limitingWindow, undefined);
  assert.match(obs.detail!, /plan=free/);
  assert.match(obs.detail!, /limit=codex/);
  const q = new CodexAppServerQuota({ now: () => NOW });
  q.observe(obs);
  assert.equal(q.snapshot().state, 'available');
});

test('windows are placed by duration with the TUI\'s ±5% tolerance, never by primary/secondary position', () => {
  const resp: GetAccountRateLimitsResponse = {
    ordinaryUsageAllowed: null,
    rateLimits: {
      limitId: 'codex', planType: 'plus', rateLimitReachedType: 'rate_limit_reached',
      // Swapped on purpose: the weekly window sits in `primary` here.
      primary: { usedPercent: 42, windowDurationMins: 10080, resetsAt: 1730950800 },
      secondary: { usedPercent: 25, windowDurationMins: 299, resetsAt: 1730947200 },
    },
  };
  const obs = mapRateLimits(resp, NOW);
  assert.deepEqual(obs.fiveHour, { utilization: 0.25, resetsAt: 1730947200000 });
  assert.deepEqual(obs.sevenDay, { utilization: 0.42, resetsAt: 1730950800000 });
  assert.equal(obs.allowed, undefined, 'null ordinaryUsageAllowed is UNKNOWN, never inferred from percentages');
  assert.equal(obs.limitingWindow, 'rate_limit_reached');
  assert.match(obs.detail!, /ordinaryUsageAllowed=unknown/);
  assert.match(obs.detail!, /plan=plus/);

  assert.deepEqual(windowSlot(300, 'primary'), { slot: 'fiveHour' });
  assert.deepEqual(windowSlot(10100, 'secondary'), { slot: 'sevenDay' });
  assert.deepEqual(windowSlot(1440, 'primary'), { extra: '1d' });
  assert.deepEqual(windowSlot(43200, 'primary'), { extra: '30d' });
  assert.deepEqual(windowSlot(null, 'secondary'), { extra: 'secondary' }, 'no duration → keyed by position, not guessed');
  assert.equal(windowLabel(120), '2h');
  assert.equal(windowLabel(90), '90min');
  assert.equal(windowLabel(525600), '365d');
});

test('a null resetsAt maps to 0 (never a future reset the monitor could hold on) and extra buckets ride along', () => {
  const resp: GetAccountRateLimitsResponse = {
    ordinaryUsageAllowed: true,
    rateLimits: { limitId: 'codex', primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: null } },
    rateLimitsByLimitId: {
      codex: { limitId: 'codex', primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: null } },
      'gpt-5.3-codex-spark': { limitId: 'gpt-5.3-codex-spark', primary: { usedPercent: 80, windowDurationMins: 300, resetsAt: 1730947200 } },
    },
  };
  const obs = mapRateLimits(resp, NOW);
  assert.deepEqual(obs.fiveHour, { utilization: 0.1, resetsAt: 0 });
  assert.deepEqual(obs.extra, { 'gpt-5.3-codex-spark:fiveHour': { utilization: 0.8, resetsAt: 1730947200000 } });
});

test('ordinaryUsageAllowed false holds the provider exhausted with the reached type as the limiting window', () => {
  const q = new CodexAppServerQuota({ now: () => NOW });
  q.observe(mapRateLimits({
    ordinaryUsageAllowed: false,
    rateLimits: { limitId: 'codex', planType: 'free', rateLimitReachedType: 'rate_limit_reached', primary: { usedPercent: 100, windowDurationMins: 43200, resetsAt: 1791990557 } },
  }, NOW));
  const s = q.snapshot();
  assert.equal(s.state, 'exhausted');
  assert.equal(s.observation?.limitingWindow, 'rate_limit_reached');
});

test('mergeRateLimitUpdate folds a sparse update in without letting nulls clear known values', () => {
  const merged = mergeRateLimitUpdate(RATE_LIMITS, {
    limitId: 'codex', planType: null, primary: { usedPercent: 50, windowDurationMins: 43200, resetsAt: 1791990557 },
  });
  assert.equal(merged.rateLimits.primary?.usedPercent, 50);
  assert.equal(merged.rateLimits.planType, 'free', 'a null in a rolling update does not clear the plan');
  assert.equal(merged.rateLimitsByLimitId?.codex?.primary?.usedPercent, 50);
  assert.equal(merged.ordinaryUsageAllowed, true, 'the top-level fields of the last read are kept');
  // A different bucket lands only in rateLimitsByLimitId.
  const other = mergeRateLimitUpdate(merged, { limitId: 'spark', primary: { usedPercent: 7, windowDurationMins: 300 } });
  assert.equal(other.rateLimits.primary?.usedPercent, 50);
  assert.equal(other.rateLimitsByLimitId?.spark?.primary?.usedPercent, 7);
  // No prior read at all: the update is the snapshot.
  assert.equal(mergeRateLimitUpdate(null, { primary: { usedPercent: 3 } }).rateLimits.primary?.usedPercent, 3);
});

// ---- the live client ---------------------------------------------------------

test('start(): initialize → initialized → account/rateLimits/read, then the snapshot is AVAILABLE with the free-plan window', async () => {
  const { spawnFn, servers, calls } = makeServer(okResponder);
  const t = fakeTimers();
  const q = new CodexAppServerQuota({
    bin: 'C:/fake/codex.exe', spawnFn, now: () => NOW, setIntervalFn: t.setIntervalFn, clearIntervalFn: t.clearIntervalFn,
    env: { PATH: '', CODEX_API_KEY: 'stray' },
  });
  await q.start();
  assert.deepEqual(calls[0].args, ['app-server']);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.env?.CODEX_API_KEY, undefined, 'the quota read must ride the same subscription auth as the runs');
  const reqs = servers[0].requests;
  assert.deepEqual(reqs.map((r) => r.method), ['initialize', 'initialized', 'account/rateLimits/read']);
  assert.equal(reqs[0].raw.jsonrpc, '2.0');
  assert.equal(typeof reqs[0].id, 'number');
  assert.deepEqual((reqs[0].params as { clientInfo: { name: string } }).clientInfo.name, 'study-hall');
  assert.equal(reqs[1].id, undefined, 'initialized is a notification');
  assert.deepEqual(reqs[2].params, {});
  assert.equal(reqs[2].raw.jsonrpc, '2.0');

  const s = q.snapshot();
  assert.equal(s.state, 'available');
  assert.equal(s.observation?.allowed, true);
  assert.deepEqual(s.observation?.extra, { '30d': { utilization: 0, resetsAt: 1791990557000 } });
  assert.equal(s.ageMs, 0);
  assert.deepEqual(q.lastResponse, RATE_LIMITS);
  assert.equal(q.running, true);
  assert.deepEqual(t.timers.map((x) => x.ms), [60_000], 'polls every 60 s by default');
  q.stop();
  assert.equal(q.running, false);
  assert.equal(t.cleared.length, 1);
});

test('an account/rateLimits/updated notification is merged into the last read and re-observed', async () => {
  const { spawnFn, servers } = makeServer(okResponder);
  const t = fakeTimers();
  const q = new CodexAppServerQuota({ bin: 'x', spawnFn, now: () => NOW, setIntervalFn: t.setIntervalFn, clearIntervalFn: t.clearIntervalFn });
  await q.start();
  const seen: QuotaSnapshot[] = [];
  q.subscribe((s) => seen.push(s));
  servers[0].emitLine({
    method: 'account/rateLimits/updated',
    params: { rateLimits: { limitId: 'codex', primary: { usedPercent: 95, windowDurationMins: 43200, resetsAt: 1791990557 } } },
  });
  assert.equal(seen.length, 1);
  const s = q.snapshot();
  assert.deepEqual(s.observation?.extra, { '30d': { utilization: 0.95, resetsAt: 1791990557000 } });
  assert.equal(s.observation?.allowed, true, 'fields the update did not carry are kept from the read');
  assert.match(s.observation?.detail ?? '', /plan=free/);
  assert.equal(s.state, 'exhausted', 'predicted headroom: 95% of a window that resets in the future');
  assert.equal(q.lastResponse?.rateLimits.primary?.usedPercent, 95);
  q.stop();
});

test('the poll timer re-reads; pollMs is honoured', async () => {
  const { spawnFn, servers } = makeServer(okResponder);
  const t = fakeTimers();
  const q = new CodexAppServerQuota({ bin: 'x', spawnFn, pollMs: 5_000, now: () => NOW, setIntervalFn: t.setIntervalFn, clearIntervalFn: t.clearIntervalFn });
  await q.start();
  assert.equal(t.timers[0].ms, 5_000);
  const before = servers[0].requests.filter((r) => r.method === 'account/rateLimits/read').length;
  t.timers[0].fn();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(servers[0].requests.filter((r) => r.method === 'account/rateLimits/read').length, before + 1);
  q.stop();
});

test('"Not logged in" is an observation with allowed null: UNKNOWN plus the reason, and a later good read recovers', async () => {
  let loggedIn = false;
  const { spawnFn } = makeServer((req) => {
    if (req.method === 'initialize') return { result: INIT_RESULT };
    if (req.method === 'account/rateLimits/read') return loggedIn ? { result: RATE_LIMITS } : { error: { code: -32001, message: 'Not logged in' } };
    return undefined;
  });
  const t = fakeTimers();
  const q = new CodexAppServerQuota({ bin: 'x', spawnFn, now: () => NOW, setIntervalFn: t.setIntervalFn, clearIntervalFn: t.clearIntervalFn });
  const seen: QuotaSnapshot[] = [];
  q.subscribe((s) => seen.push(s));
  await q.start();
  const s = q.snapshot();
  assert.equal(s.state, 'unknown');
  assert.equal(s.observation?.allowed, null);
  assert.equal(s.observation?.source, 'app-server');
  assert.match(s.observation?.detail ?? '', /account\/rateLimits\/read failed: Not logged in/);
  assert.equal(seen.length, 1, 'subscribers hear about the degraded state');
  assert.equal(seen[0].state, 'unknown');

  loggedIn = true;
  await q.poll();
  assert.equal(q.snapshot().state, 'available');
  assert.equal(q.snapshot().observation?.allowed, true);
  q.stop();
});

test('a stale AVAILABLE never survives a failed read: the degraded observation wins the snapshot', async () => {
  let fail = false;
  const { spawnFn } = makeServer((req) => {
    if (req.method === 'initialize') return { result: INIT_RESULT };
    if (req.method === 'account/rateLimits/read') return fail ? { error: { code: 1, message: 'boom' } } : { result: RATE_LIMITS };
    return undefined;
  });
  const t = fakeTimers();
  const q = new CodexAppServerQuota({ bin: 'x', spawnFn, now: () => NOW, setIntervalFn: t.setIntervalFn, clearIntervalFn: t.clearIntervalFn });
  await q.start();
  assert.equal(q.snapshot().state, 'available');
  fail = true;
  await q.poll();
  assert.equal(q.snapshot().state, 'unknown');
  assert.match(q.snapshot().observation?.detail ?? '', /boom/);
  q.stop();
});

test('the server dying under us degrades to UNKNOWN with the exit reason; stop() does not', async () => {
  const { spawnFn, servers } = makeServer(okResponder);
  const t = fakeTimers();
  const q = new CodexAppServerQuota({ bin: 'x', spawnFn, now: () => NOW, setIntervalFn: t.setIntervalFn, clearIntervalFn: t.clearIntervalFn });
  await q.start();
  servers[0].stderr.emit('data', Buffer.from('panic: something\n'));
  servers[0].emit('close', 1);
  const s = q.snapshot();
  assert.equal(s.state, 'unknown');
  assert.match(s.observation?.detail ?? '', /codex app-server exited \(1\): panic: something/);
  assert.equal(q.running, false);
  assert.equal(t.cleared.length, 1, 'the poll timer is cleared when the server goes');

  const second = new CodexAppServerQuota({ bin: 'x', spawnFn, now: () => NOW, setIntervalFn: t.setIntervalFn, clearIntervalFn: t.clearIntervalFn });
  await second.start();
  second.stop();
  servers[1].emit('close', null);
  assert.equal(second.snapshot().state, 'available', 'an intentional stop keeps the last good observation');
});

test('start() rejects when the handshake itself fails, and markExhausted delegates to the state machine', async () => {
  const { spawnFn } = makeServer((req) => req.method === 'initialize' ? { error: { code: -32600, message: 'bad client' } } : undefined);
  const q = new CodexAppServerQuota({ bin: 'x', spawnFn, now: () => NOW, setIntervalFn: fakeTimers().setIntervalFn });
  await assert.rejects(q.start(), /bad client/);
  q.stop();

  const m = new CodexAppServerQuota({ now: () => NOW });
  m.markExhausted(NOW + 600_000, 'usage limit');
  assert.equal(m.snapshot().state, 'exhausted');
  assert.equal(m.provider, 'openai');
});
