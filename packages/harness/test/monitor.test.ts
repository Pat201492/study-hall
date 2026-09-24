import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BasicQuotaMonitor } from '../src/quota/monitor.js';
import type { QuotaObservation } from '../src/contract.js';

const T0 = 1_700_000_000_000;
const H = 3_600_000;

function obs(over: Partial<QuotaObservation>, at = T0): QuotaObservation {
  return { provider: 'anthropic', observedAt: at, source: 'stream', ...over };
}

test('starts UNKNOWN, becomes AVAILABLE on a fresh observation with headroom', () => {
  let now = T0;
  const m = new BasicQuotaMonitor('anthropic', { now: () => now });
  assert.equal(m.snapshot().state, 'unknown');
  m.observe(obs({ fiveHour: { utilization: 0.14, resetsAt: T0 + 3 * H }, sevenDay: { utilization: 0.2, resetsAt: T0 + 48 * H }, allowed: true }));
  assert.equal(m.snapshot().state, 'available');
  assert.equal(m.snapshot().ageMs, 0);
  now = T0 + 10 * 60_000;
  assert.equal(m.snapshot().ageMs, 10 * 60_000);
});

test('a stale observation degrades to UNKNOWN, never to "plenty of headroom"', () => {
  let now = T0;
  const m = new BasicQuotaMonitor('anthropic', { now: () => now, staleMs: 30 * 60_000 });
  m.observe(obs({ fiveHour: { utilization: 0.1, resetsAt: T0 + 3 * H }, allowed: true }));
  now = T0 + 31 * 60_000;
  assert.equal(m.snapshot().state, 'unknown');
});

test('predicted headroom: a window at the handover threshold is EXHAUSTED until it resets', () => {
  let now = T0;
  const m = new BasicQuotaMonitor('anthropic', { now: () => now, handoverAt: 0.9, staleMs: 3 * H });
  m.observe(obs({ fiveHour: { utilization: 0.92, resetsAt: T0 + H }, allowed: true }));
  assert.equal(m.snapshot().state, 'exhausted');
  now = T0 + H + 1;
  // The window has reset and the observation is still within the staleness bound:
  // no longer limiting. (Past the bound it would read UNKNOWN and be probed.)
  assert.equal(m.snapshot().state, 'available');
});

test('allowed:false holds the provider until the stated reset plus margin', () => {
  let now = T0;
  const m = new BasicQuotaMonitor('openai', { now: () => now, resetMarginMs: 60_000 });
  m.observe(obs({ provider: 'openai', source: 'app-server', allowed: false, fiveHour: { utilization: 1, resetsAt: T0 + 2 * H } }));
  const s = m.snapshot();
  assert.equal(s.state, 'exhausted');
  assert.equal(s.exhaustedUntil, T0 + 2 * H + 60_000);
  now = T0 + 2 * H + 30_000;
  assert.equal(m.snapshot().state, 'exhausted', 'inside the margin');
  now = T0 + 2 * H + 61_000;
  // Past the hold, and the last observation is older than the staleness bound:
  // UNKNOWN, not available — recovery is never inferred from a reset time; the
  // engine probes and the provider's next read decides.
  assert.equal(m.snapshot().state, 'unknown');
  m.observe(obs({ provider: 'openai', source: 'app-server', allowed: true, fiveHour: { utilization: 0.3, resetsAt: T0 + 7 * H } }, now));
  assert.equal(m.snapshot().state, 'available');
});

test('markExhausted without a reset time falls back to a flat hold, and never shortens a longer hold', () => {
  let now = T0;
  const m = new BasicQuotaMonitor('anthropic', { now: () => now, fallbackHoldMs: 5 * 60_000, resetMarginMs: 0 });
  m.markExhausted(T0 + H, 'stated reset');
  m.markExhausted(undefined, 'weaker signal');
  assert.equal(m.snapshot().exhaustedUntil, T0 + H);
  now = T0 + H + 1;
  assert.equal(m.snapshot().state, 'unknown', 'no observation exists, so after the hold it is unknown, not available');
});

test('subscribers are told on every observation and a throwing subscriber cannot break the monitor', () => {
  const m = new BasicQuotaMonitor('anthropic', { now: () => T0 });
  const states: string[] = [];
  m.subscribe(() => { throw new Error('boom'); });
  const off = m.subscribe((s) => states.push(s.state));
  m.observe(obs({ fiveHour: { utilization: 0.5, resetsAt: T0 + H }, allowed: true }));
  m.markExhausted(T0 + H);
  off();
  m.observe(obs({ allowed: true, fiveHour: { utilization: 0.1, resetsAt: T0 + 2 * H } }));
  assert.deepEqual(states, ['available', 'exhausted']);
});

test('a seeded reading survives a restart: the number and its true age come back, freshness does not', () => {
  // The monitor is in-memory, so a restart showed "unknown, never observed"
  // beside a burn card that had seeded itself from the same ledger and knew the
  // window was at 11 %. Seeding restores the reading; the staleness rule still
  // decides what the state is.
  let now = T0 + 20 * H;
  const m = new BasicQuotaMonitor('anthropic', { now: () => now });
  const stored = obs({ fiveHour: { utilization: 0.11, resetsAt: T0 + 5 * H }, allowed: true }, T0);
  m.seed(stored);
  const s = m.snapshot();
  assert.equal(s.observation?.fiveHour?.utilization, 0.11, 'the last known reading is shown');
  assert.equal(s.ageMs, 20 * H, 'with its real age, not as if it were fresh');
  assert.equal(s.state, 'unknown', 'a 20-hour-old reading is not evidence of anything now');

  // Seeded inside the staleness window, it is ordinary evidence again.
  now = T0 + 10 * 60_000;
  const fresh = new BasicQuotaMonitor('anthropic', { now: () => now });
  fresh.seed(stored);
  assert.equal(fresh.snapshot().state, 'available');
});

test('a newer reading from another process is adopted; an older one is ignored', () => {
  // The engine is its own process: its students' readings reach the ledger and
  // never this monitor. Seeded only at boot, the card sat 13 hours stale while
  // the ledger held readings from minutes earlier (#37).
  let now = T0 + 60_000;
  const m = new BasicQuotaMonitor('anthropic', { now: () => now });
  assert.equal(m.seed(obs({ fiveHour: { utilization: 0.4, resetsAt: T0 + 5 * H }, allowed: true }, T0)), true);
  assert.equal(m.snapshot().observation?.fiveHour?.utilization, 0.4);

  // Mid-run, the ledger has something newer.
  assert.equal(m.seed(obs({ fiveHour: { utilization: 0.6, resetsAt: T0 + 5 * H }, allowed: true }, T0 + 30_000)), true);
  assert.equal(m.snapshot().observation?.fiveHour?.utilization, 0.6);
  assert.equal(m.snapshot().state, 'available', 'and it drives state, not just the display');

  // A row read again, or one that arrives out of order, changes nothing.
  assert.equal(m.seed(obs({ fiveHour: { utilization: 0.1, resetsAt: T0 + 5 * H }, allowed: true }, T0 + 30_000)), false);
  assert.equal(m.seed(obs({ fiveHour: { utilization: 0.1, resetsAt: T0 + 5 * H }, allowed: true }, T0)), false);
  assert.equal(m.snapshot().observation?.fiveHour?.utilization, 0.6, 'the clock only moves forwards');
});

test('seeding never overwrites a live reading, never holds, and never notifies', () => {
  const now = T0;
  const m = new BasicQuotaMonitor('anthropic', { now: () => now });
  const seen: number[] = [];
  m.subscribe(() => seen.push(1));

  // An old exhaustion is not an exhaustion now: seeding must not re-apply it.
  m.seed(obs({ allowed: false, fiveHour: { utilization: 1, resetsAt: T0 + H }, detail: 'yesterday' }, T0 - 30 * H));
  assert.equal(m.snapshot().exhaustedUntil, undefined, 'no hold is created from stored history');
  assert.equal(m.snapshot().state, 'unknown');
  // A subscriber banks observations to the ledger; emitting here would bank it twice.
  assert.equal(seen.length, 0, 'seeding notifies nobody');

  // Anything observed since boot wins, and a later seed cannot undo it.
  m.observe(obs({ fiveHour: { utilization: 0.2, resetsAt: T0 + 3 * H }, allowed: true }));
  assert.equal(seen.length, 1);
  // An OLDER seed cannot undo a live reading; a newer one is simply the truth
  // arriving from the process that took it.
  m.seed(obs({ fiveHour: { utilization: 0.9, resetsAt: T0 + 3 * H }, allowed: true }, T0 - H));
  assert.equal(m.snapshot().observation?.fiveHour?.utilization, 0.2, 'the live reading stands');
  assert.equal(seen.length, 1, 'and seeding still notifies nobody, so nothing is re-banked');
});
