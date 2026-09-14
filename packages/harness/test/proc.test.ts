import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChildRegistry, fallbackDirs, npmPackageExe, resolveBin } from '../src/proc.js';

const isWin = process.platform === 'win32';

test('resolveBin: an explicit path is returned as written, with its existence and shim-ness', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sh-proc-'));
  const exe = join(dir, isWin ? 'tool.exe' : 'tool');
  writeFileSync(exe, '');
  const r = resolveBin(exe, {}, dir);
  assert.equal(r.path, exe);
  assert.equal(r.found, true);
  assert.equal(r.isShim, false);
  const shim = join(dir, 'tool.cmd');
  writeFileSync(shim, '');
  assert.equal(resolveBin(shim, {}, dir).isShim, true);
  assert.equal(resolveBin(join(dir, 'missing.exe'), {}, dir).found, false);
});

test('resolveBin: a bare name is found on PATH, then in the fallback dirs, else returned untouched', () => {
  const home = mkdtempSync(join(tmpdir(), 'sh-home-'));
  const pathDir = mkdtempSync(join(tmpdir(), 'sh-path-'));
  const name = 'sh-fake-cli';
  const ext = isWin ? '.exe' : '';
  const env: NodeJS.ProcessEnv = { PATH: pathDir, PATHEXT: '.EXE;.CMD' };

  assert.equal(resolveBin(name, env, home).found, false);
  assert.equal(resolveBin(name, env, home).path, name);

  const local = join(home, '.local', 'bin');
  mkdirSync(local, { recursive: true });
  writeFileSync(join(local, name + ext), '');
  const viaFallback = resolveBin(name, env, home);
  assert.equal(viaFallback.found, true);
  assert.equal(viaFallback.path, join(local, name + ext));

  writeFileSync(join(pathDir, name + ext), '');
  assert.equal(resolveBin(name, env, home).path, join(pathDir, name + ext), 'PATH wins over fallbacks');
});

test('fallbackDirs never yields an empty or root-only directory', () => {
  for (const d of fallbackDirs({}, '/home/x')) {
    assert.ok(d.length > 1);
  }
});

test('npmPackageExe finds a packaged executable next to an npm shim', () => {
  const home = mkdtempSync(join(tmpdir(), 'sh-npm-'));
  const env: NodeJS.ProcessEnv = isWin ? { APPDATA: join(home, 'AppData', 'Roaming') } : {};
  const root = isWin ? join(home, 'AppData', 'Roaming', 'npm') : join(home, '.local', 'lib');
  const exe = join(root, 'node_modules', 'some-cli', 'bin', 'some-cli.exe');
  assert.equal(npmPackageExe('some-cli', 'bin/some-cli.exe', env, home), null);
  mkdirSync(join(root, 'node_modules', 'some-cli', 'bin'), { recursive: true });
  writeFileSync(exe, '');
  assert.equal(npmPackageExe('some-cli', 'bin/some-cli.exe', env, home), exe);
});

test('ChildRegistry tracks children and killAll empties it without throwing on pid-less children', () => {
  const reg = new ChildRegistry();
  const a = { on: () => a } as unknown as import('../src/contract.js').ChildLike;
  reg.add(a);
  assert.equal(reg.size, 1);
  assert.doesNotThrow(() => reg.killAll());
  assert.equal(reg.size, 0);
});
