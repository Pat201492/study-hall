import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_POOLS, loadEngineConfig, tierLabel } from '../src/config.js';
import { Protector } from '../src/protector.js';
import { issueToTask } from '../src/github.js';

// The ladder keys (haiku/sonnet/opus) are Anthropic's names for three rungs.
// Another vendor's students must carry that vendor's own names.

test('each provider names its tiers in its own words; Anthropic keeps the ladder keys', () => {
  const cfg = { pools: DEFAULT_POOLS };
  assert.deepEqual(['haiku', 'sonnet', 'opus'].map((t) => tierLabel(cfg, 'openai', t as 'opus')), ['luna', 'terra', 'sol']);
  assert.equal(tierLabel(cfg, 'anthropic', 'opus'), 'opus');
  assert.equal(tierLabel(cfg, 'nobody', 'sonnet'), 'sonnet', 'an unknown provider falls back to the key');
});

test('overriding a tier\'s model in config.json keeps its default label and the other tiers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sh-tierlabel-'));
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify({ pools: { openai: { tiers: { opus: { model: 'gpt-next' } } } } }));
  const cfg = loadEngineConfig(path, {});
  assert.equal(cfg.pools.openai.tiers.opus?.model, 'gpt-next');
  assert.equal(cfg.pools.openai.tiers.opus?.label, 'sol');
  assert.equal(cfg.pools.openai.tiers.opus?.maxWarm, DEFAULT_POOLS.openai.tiers.opus?.maxWarm);
  assert.equal(cfg.pools.openai.tiers.sonnet?.model, DEFAULT_POOLS.openai.tiers.sonnet?.model);
});

test('a Protector names its students with the label it is given', () => {
  const p = new Protector({ perTierMax: 2, totalCap: 4, maxConcurrent: 2, worktreeRoot: 'w', idLabel: (t) => (t === 'opus' ? 'sol' : t) });
  const [a] = p.assign([{ id: 't1', tier: 'opus', role: 'implement' }]);
  assert.equal(a.worker?.id, 'sol-1');
  const plain = new Protector({ perTierMax: 2, totalCap: 4, maxConcurrent: 2, worktreeRoot: 'w' });
  assert.equal(plain.assign([{ id: 't1', tier: 'opus', role: 'implement' }])[0].worker?.id, 'opus-1');
});

test('a model: pin label accepts either provider name for a rung', () => {
  const pinned = (label: string) => issueToTask(
    { number: 1, title: 't', body: '', labels: [{ name: label }] } as Parameters<typeof issueToTask>[0],
    'balanced' as Parameters<typeof issueToTask>[1], () => 'simple').model;
  assert.equal(pinned('model:sol'), 'opus');
  assert.equal(pinned('model:terra'), 'sonnet');
  assert.equal(pinned('model:luna'), 'haiku');
  assert.equal(pinned('model:opus'), 'opus');
  assert.notEqual(pinned('model:gpt'), undefined, 'an unknown name is not a pin; difficulty decides');
});
