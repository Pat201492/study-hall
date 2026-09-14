import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  clearRegistries, fidelityFor, getHarness, getProvider, harnessIds, harnessesFor,
  killAllHarnesses, providerIds, registerHarness, registerProvider,
} from '../src/registry.js';
import type { Harness, HarnessCapabilities, Provider } from '../src/contract.js';

const caps: HarnessCapabilities = {
  warmSessions: false, seedableSessions: false, forkSessions: false, cacheUsageSplit: false,
  usageIsCumulative: false, reportsCost: false, toolAllowlist: false, mcpToolAllowlist: false,
  effortControl: false, sandboxModes: ['none'], promptTransport: 'stdin', streamsUsage: false,
  cancellable: false, transcripts: false, budgetStop: false, chat: 'none',
};

function provider(id: string, over: Partial<Provider> = {}): Provider {
  return { id, label: id, credentialKind: 'none', automationStance: 'sanctioned', meter: 'local', ...over };
}

function harness(id: string, providerId: string, onKill?: () => void, over: Partial<HarnessCapabilities> = {}): Harness {
  return {
    id, provider: providerId, capabilities: { ...caps, ...over },
    run: async () => { throw new Error('not used'); },
    killAll: () => { onKill?.(); },
    classifyFailure: () => ({ kind: 'task' }),
    preflight: async () => ({ ok: true, bin: id }),
  };
}

beforeEach(() => clearRegistries());

test('an unknown provider or harness id throws instead of falling back', () => {
  assert.throws(() => getProvider('nope'), /unknown provider "nope"/);
  registerProvider(provider('p1'));
  registerHarness(harness('h1', 'p1'));
  assert.throws(() => getHarness('h1-typo'), /unknown harness "h1-typo"/);
  assert.throws(() => getHarness('h1-typo'), /h1/);
  assert.deepEqual(providerIds(), ['p1']);
  assert.deepEqual(harnessIds(), ['h1']);
});

test('a harness on an unregistered provider cannot be registered', () => {
  assert.throws(() => registerHarness(harness('h', 'ghost')), /unknown provider "ghost"/);
});

// Both Anthropic and Google enforce server-side and suspend accounts, so a
// prohibited pairing is a registration error, not a warning.
test('a prohibited provider stance refuses the pairing', () => {
  registerProvider(provider('consumer-oauth', { automationStance: 'prohibited' }));
  assert.throws(() => registerHarness(harness('third-party', 'consumer-oauth')), /automation stance is prohibited/);
  assert.deepEqual(harnessIds(), []);
});

test('re-registering an id replaces it and returns what was displaced', () => {
  registerProvider(provider('p'));
  const first = harness('h', 'p');
  const second = harness('h', 'p');
  assert.equal(registerHarness(first), undefined);
  assert.equal(registerHarness(second), first);
  assert.equal(getHarness('h'), second);
});

test('harnessesFor lists every harness on a provider', () => {
  registerProvider(provider('a'));
  registerProvider(provider('b'));
  registerHarness(harness('a1', 'a'));
  registerHarness(harness('a2', 'a'));
  registerHarness(harness('b1', 'b'));
  assert.deepEqual(harnessesFor('a').map((h) => h.id), ['a1', 'a2']);
});

test('killAllHarnesses reaps every registration, even past a thrower', () => {
  registerProvider(provider('p'));
  const reaped: string[] = [];
  registerHarness(harness('kill-a', 'p', () => reaped.push('a')));
  registerHarness(harness('kill-boom', 'p', () => { throw new Error('no'); }));
  registerHarness(harness('kill-c', 'p', () => reaped.push('c')));
  assert.doesNotThrow(() => killAllHarnesses());
  assert.deepEqual(reaped.sort(), ['a', 'c']);
});

test('usage fidelity follows the cache-split capability', () => {
  assert.equal(fidelityFor({ cacheUsageSplit: true }), 'exact');
  assert.equal(fidelityFor({ cacheUsageSplit: false }), 'partial');
});
