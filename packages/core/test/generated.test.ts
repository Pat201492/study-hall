import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  partitionConflicts, DEFAULT_GENERATED_FILES, type GeneratedFileRule,
} from '../src/generated.js';
import { generatedFilesFor } from '../src/config.js';

// #175: a lockfile conflict is regenerated, never three-way merged. These test
// the PURE decision — which conflicted files regenerate vs which a resolver must
// read. The git/npm IO (worktree.regenerateLockfiles) is exercised live.

test('a lockfile-only conflict needs no resolver — it is all generated', () => {
  const { generated, source } = partitionConflicts(['package-lock.json']);
  assert.equal(source.length, 0);
  assert.deepEqual(generated.map((g) => g.path), ['package-lock.json']);
  assert.deepEqual(generated[0].rule.regen[0], 'npm');
});

test('source conflicts and lockfiles split apart', () => {
  const { generated, source } = partitionConflicts([
    'src/app.ts', 'package.json', 'package-lock.json', 'yarn.lock',
  ]);
  // package.json is authored — a resolver reads it. Only the lockfiles regenerate.
  assert.deepEqual(source, ['src/app.ts', 'package.json']);
  assert.deepEqual(generated.map((g) => g.path), ['package-lock.json', 'yarn.lock']);
});

test('a nested lockfile is matched by basename', () => {
  const { generated, source } = partitionConflicts(['frontend/package-lock.json']);
  assert.equal(source.length, 0);
  assert.equal(generated[0].path, 'frontend/package-lock.json');
});

test('a windows-slashed path still matches', () => {
  const { generated } = partitionConflicts(['frontend\\package-lock.json']);
  assert.equal(generated.length, 1);
});

test('pnpm and yarn lockfiles each get their own regenerate command', () => {
  const { generated } = partitionConflicts(['pnpm-lock.yaml', 'yarn.lock']);
  assert.equal(generated[0].rule.regen[0], 'pnpm');
  assert.equal(generated[1].rule.regen[0], 'yarn');
});

test('a custom rule list overrides the defaults', () => {
  const rules: GeneratedFileRule[] = [{ file: 'Cargo.lock', regen: ['cargo', 'generate-lockfile'] }];
  const { generated, source } = partitionConflicts(['Cargo.lock', 'package-lock.json'], rules);
  // Only Cargo.lock is generated now; package-lock.json is not in the custom list.
  assert.deepEqual(generated.map((g) => g.path), ['Cargo.lock']);
  assert.deepEqual(source, ['package-lock.json']);
});

test('generatedFilesFor falls back to the defaults when unset or empty', () => {
  assert.equal(generatedFilesFor({}), DEFAULT_GENERATED_FILES);
  assert.equal(generatedFilesFor({ generatedFiles: [] }), DEFAULT_GENERATED_FILES);
  const custom: GeneratedFileRule[] = [{ file: 'go.sum', regen: ['go', 'mod', 'tidy'] }];
  assert.equal(generatedFilesFor({ generatedFiles: custom }), custom);
});
