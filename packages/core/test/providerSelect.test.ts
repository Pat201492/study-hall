import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectProvider, type ProviderSelectInput } from '../src/providerSelect.js';
import type { QuotaSnapshot } from '@study-hall/harness/contract';

const q = (state: QuotaSnapshot['state'], detail?: string): QuotaSnapshot => ({ provider: 'x', state, observation: detail ? { provider: 'x', observedAt: 0, source: 'manual', detail } : undefined });

function input(over: Partial<ProviderSelectInput> = {}): ProviderSelectInput {
  return {
    choice: 'auto',
    failoverOrder: ['anthropic', 'openai'],
    quotas: { anthropic: q('available'), openai: q('available') },
    inFlight: {},
    caps: { anthropic: 4, openai: 2 },
    ...over,
  };
}

test('a pinned provider is used when available, probed when unknown, refused when exhausted or halted', () => {
  assert.deepEqual(selectProvider(input({ choice: 'openai' })), { provider: 'openai', reason: 'pinned' });
  assert.deepEqual(selectProvider(input({ choice: 'openai', quotas: { openai: q('unknown') } })), { provider: 'openai', reason: 'needs-probe', probe: 'openai' });
  assert.equal(selectProvider(input({ choice: 'openai', quotas: { openai: q('exhausted', 'weekly limit') } })).reason, 'pinned-but-exhausted');
  assert.equal(selectProvider(input({ choice: 'openai', halted: { openai: 'token expired' } })).reason, 'pinned-but-halted');
  assert.equal(selectProvider(input({ choice: 'openai', inFlight: { openai: 2 } })).reason, 'pinned-at-cap');
});

test('auto walks the failover order and takes the first AVAILABLE provider', () => {
  assert.deepEqual(selectProvider(input()), { provider: 'anthropic', reason: 'first-available' });
  assert.deepEqual(selectProvider(input({ quotas: { anthropic: q('exhausted'), openai: q('available') } })), { provider: 'openai', reason: 'first-available' });
});

test('auto: a provider at its concurrency cap is skipped, not treated as exhausted', () => {
  const s = selectProvider(input({ inFlight: { anthropic: 4 } }));
  assert.deepEqual(s, { provider: 'openai', reason: 'first-available' });
  assert.equal(selectProvider(input({ inFlight: { anthropic: 4, openai: 2 } })).reason, 'all-at-cap');
});

test('auto: an UNKNOWN provider is probed rather than skipped when nothing else is available', () => {
  const s = selectProvider(input({ quotas: { anthropic: q('exhausted'), openai: q('unknown') } }));
  assert.deepEqual(s, { provider: 'openai', reason: 'needs-probe', probe: 'openai' });
  // …but a known-available later provider beats probing an earlier unknown one.
  const t = selectProvider(input({ quotas: { anthropic: q('unknown'), openai: q('available') } }));
  assert.deepEqual(t, { provider: 'openai', reason: 'first-available' });
});

test('auto: everything exhausted or halted yields no provider', () => {
  assert.equal(selectProvider(input({ quotas: { anthropic: q('exhausted'), openai: q('exhausted') } })).reason, 'all-exhausted');
  assert.equal(selectProvider(input({ halted: { anthropic: 'x', openai: 'y' } })).reason, 'all-exhausted');
});

test('a provider resting on its burn-rate cap is skipped in failover, and a pinned one holds with the reason', () => {
  const rested = { anthropic: { reason: '1.2M tokens in the last 60 min (cap 1M)', resumesAt: 1_700_000_000_000 } };
  // Auto: the capped lane is skipped and the work goes to the other service.
  assert.deepEqual(selectProvider(input({ rateCapped: rested })), { provider: 'openai', reason: 'first-available' });
  // Pinned: a pin says WHICH provider, not "spend without limit" — it holds.
  const pinned = selectProvider(input({ choice: 'anthropic', rateCapped: rested }));
  assert.equal(pinned.provider, null);
  assert.equal(pinned.reason, 'pinned-but-rate-capped');
  assert.match(pinned.detail ?? '', /1\.2M tokens/);
  // The other provider is unaffected by a rest on the first.
  assert.equal(selectProvider(input({ choice: 'openai', rateCapped: rested })).reason, 'pinned');
});

test('when every lane is resting, the reason says so and names the one that comes back first', () => {
  const r = selectProvider(input({
    rateCapped: {
      anthropic: { reason: 'anthropic burn', resumesAt: 5_000 },
      openai: { reason: 'openai burn', resumesAt: 1_000 },
    },
  }));
  assert.equal(r.provider, null);
  assert.equal(r.reason, 'all-rate-capped');
  assert.match(r.detail ?? '', /^openai: openai burn/, 'the soonest to resume is the one worth reporting');
});

test('a rest outranks a concurrency cap in the report, and an unknown provider is still probed first', () => {
  // Rest + at-cap together: the rest is the one an operator can lift.
  assert.equal(selectProvider(input({
    rateCapped: { anthropic: { reason: 'burn', resumesAt: null } }, inFlight: { openai: 2 },
  })).reason, 'all-rate-capped');
  // A provider nobody has observed is probed rather than declared rested.
  assert.deepEqual(selectProvider(input({
    quotas: { anthropic: q('unknown'), openai: q('available') },
    rateCapped: { openai: { reason: 'burn', resumesAt: null } },
  })), { provider: 'anthropic', reason: 'needs-probe', probe: 'anthropic' });
});
