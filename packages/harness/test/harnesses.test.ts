import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { clearRegistries, getHarness, getProvider, harnessIds, providerIds } from '../src/registry.js';
import {
  anthropicProvider, anthropicQuota, claudeCodeHarness, codexHarness, defaultHarnessFor, openCodeHarness,
  openaiProvider, registerBuiltins,
} from '../src/harnesses.js';
import { CodexAppServerQuota } from '../src/quota/codexAppServer.js';

beforeEach(() => clearRegistries());

test('registerBuiltins registers three providers and three harnesses, idempotently', () => {
  const first = registerBuiltins();
  assert.deepEqual(first.providers, ['anthropic', 'openai', 'local']);
  assert.deepEqual(first.harnesses, ['claude-code', 'codex', 'opencode']);
  const second = registerBuiltins();
  assert.deepEqual(second, first);
  assert.equal(providerIds().length, 3);
  assert.equal(harnessIds().length, 3);
});

test('every built-in harness runs on a registered provider with a compatible stance', () => {
  registerBuiltins();
  for (const h of [claudeCodeHarness, codexHarness, openCodeHarness]) {
    const p = getProvider(h.provider);
    assert.notEqual(p.automationStance, 'prohibited');
    assert.equal(getHarness(h.id), h);
  }
  assert.equal(claudeCodeHarness.provider, 'anthropic');
  assert.equal(codexHarness.provider, 'openai');
  assert.equal(openCodeHarness.provider, 'local');
});

test('providers own their quota monitors, and Codex quota is a lazy app-server client', () => {
  assert.equal(anthropicProvider.quota, anthropicQuota);
  assert.equal(anthropicQuota.snapshot().state, 'unknown', 'nothing observed yet');
  assert.ok(openaiProvider.quota instanceof CodexAppServerQuota);
  assert.equal((openaiProvider.quota as CodexAppServerQuota).running, false, 'not started until the engine says so');
  assert.equal(openaiProvider.concurrencyCap, 2);
});

test('defaultHarnessFor maps each provider to its harness and refuses unknown providers', () => {
  registerBuiltins();
  assert.equal(defaultHarnessFor('anthropic').id, 'claude-code');
  assert.equal(defaultHarnessFor('openai').id, 'codex');
  assert.equal(defaultHarnessFor('local').id, 'opencode');
  assert.throws(() => defaultHarnessFor('google'), /no default harness/);
});

// The capability blocks are the arena's fairness inputs: pin what each lane claims.
test('capability claims that decide fidelity and warmth are what the dossiers verified', () => {
  assert.equal(claudeCodeHarness.capabilities.seedableSessions, true);
  assert.equal(claudeCodeHarness.capabilities.usageIsCumulative, false);
  assert.equal(codexHarness.capabilities.seedableSessions, false);
  assert.equal(codexHarness.capabilities.usageIsCumulative, true, 'turn.completed.usage is a thread total');
  assert.equal(codexHarness.capabilities.forkSessions, true);
  assert.equal(openCodeHarness.capabilities.seedableSessions, false);
  for (const h of [claudeCodeHarness, codexHarness, openCodeHarness]) {
    assert.equal(h.capabilities.cacheUsageSplit, true, `${h.id} rows are fidelity exact`);
  }
});
