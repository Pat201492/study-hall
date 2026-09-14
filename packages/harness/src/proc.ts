import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, sep } from 'node:path';
import type { ChildLike } from './contract.js';

// Process utilities shared by every adapter: tree-kill, an in-flight registry,
// and launch-context-robust binary resolution. Ported from claude-study-room's
// cliStudent.ts / claudeBin.ts / openCodeHarness.ts with one deliberate change:
// adapters spawn with `shell: false` at a resolved executable, so the prompt
// never crosses a shell and the tracked pid IS the agent (no cmd.exe wrapper).

/** Kill one child and everything it spawned. `/T` takes the tree on Windows. */
export function treeKill(child: ChildLike): void {
  const pid = child.pid;
  if (pid == null) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    else child.kill?.('SIGKILL');
  } catch { /* already exited */ }
}

/** Every in-flight child a harness owns, so shutdown can reap them. */
export class ChildRegistry {
  private readonly active = new Set<ChildLike>();
  add(child: ChildLike): void { this.active.add(child); }
  delete(child: ChildLike): void { this.active.delete(child); }
  get size(): number { return this.active.size; }
  killAll(): void {
    for (const c of this.active) treeKill(c);
    this.active.clear();
  }
}

/** Directories to try once PATH has come up empty — how CLIs get installed on
 *  this host (native installer, npm -g shim, Homebrew). */
export function fallbackDirs(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string[] {
  const dirs = process.platform === 'win32'
    ? [
        join(home, '.local', 'bin'),
        join(home, '.claude', 'local'),
        join(env.APPDATA || '', 'npm'),
        join(env.LOCALAPPDATA || '', 'Programs', 'OpenAI', 'Codex', 'bin'),
        join(env.ProgramFiles || '', 'nodejs'),
      ]
    : [
        join(home, '.local', 'bin'),
        join(home, '.claude', 'local'),
        '/usr/local/bin',
        '/opt/homebrew/bin',
      ];
  return dirs.filter((d) => d && !d.startsWith(sep + sep) && d !== sep);
}

function execExtensions(env: NodeJS.ProcessEnv): string[] {
  if (process.platform !== 'win32') return [''];
  const fromEnv = (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  return ['', ...fromEnv.map((e) => e.toLowerCase())];
}

function firstHit(dirs: string[], name: string, env: NodeJS.ProcessEnv): string | null {
  for (const dir of dirs) {
    for (const ext of execExtensions(env)) {
      const candidate = join(dir, name + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export interface ResolvedBin {
  /** Something spawnable with shell:false, or the bare input when nothing was found. */
  path: string;
  found: boolean;
  /** True when the hit is a .cmd/.bat shim that Node refuses to spawn without a
   *  shell (CVE-2024-27980 hardening). Callers should look for the real .exe. */
  isShim: boolean;
}

/**
 * Resolve a configured binary to something spawnable.
 *  - an explicit path is returned as written (the operator's deliberate choice);
 *  - a bare name is looked up on PATH, then in the known install dirs;
 *  - nothing found returns the input untouched so the preflight can say so.
 * Filesystem-only: no `--version` spawn, because config is re-read constantly.
 */
export function resolveBin(
  configured: string,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): ResolvedBin {
  const raw = (configured || '').trim().replace(/^"|"$/g, '');
  if (!raw) return { path: raw, found: false, isShim: false };
  if (isAbsolute(raw) || raw.includes('/') || raw.includes('\\')) {
    return { path: raw, found: existsSync(raw), isShim: /\.(cmd|bat)$/i.test(raw) };
  }
  const pathDirs = (env.PATH || env.Path || '').split(delimiter).filter(Boolean);
  const hit = firstHit(pathDirs, raw, env) ?? firstHit(fallbackDirs(env, home), raw, env);
  if (!hit) return { path: raw, found: false, isShim: false };
  return { path: hit, found: true, isShim: /\.(cmd|bat)$/i.test(hit) };
}

/**
 * The real executable an npm -g package ships next to its .cmd shim, e.g.
 * `<npm-global>/node_modules/opencode-ai/bin/opencode.exe`. Returns null when
 * the package is not installed that way.
 */
export function npmPackageExe(
  pkg: string,
  relExe: string,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string | null {
  const roots = process.platform === 'win32'
    ? [join(env.APPDATA || '', 'npm'), join(home, 'AppData', 'Roaming', 'npm')]
    : [join(home, '.local', 'lib'), '/usr/local/lib', '/opt/homebrew/lib'];
  for (const root of roots) {
    if (!root) continue;
    const candidate = join(root, 'node_modules', pkg, relExe);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
