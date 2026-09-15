import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { Router } from './router.js';
import type { StudyHallConfig } from './config.js';

// The Arena tab reads study-arena's versioned export envelope through the
// arena's own CLI (stdout = payload, stderr = progress) and refuses to render
// an unknown schema version, naming both sides. Nothing here knows how the
// arena computes anything — the envelope is the contract (study-arena/docs/INTEGRATION.md).

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');

export const ARENA_EXPORT_SCHEMA = 'study-arena/export/v1';

export interface ArenaDeps {
  cfg: () => StudyHallConfig;
  /** Test seam: returns the raw stdout of `arena export --json`. */
  exportJson?: (arenaDir: string) => Promise<string>;
}

export function arenaDirFor(cfg: StudyHallConfig): string {
  const raw = (cfg as StudyHallConfig & { arenaDir?: string }).arenaDir;
  return raw ? resolve(raw) : resolve(REPO_ROOT, '..', 'study-arena');
}

async function realExport(arenaDir: string): Promise<string> {
  const { stdout } = await execFileAsync(process.execPath, ['--import', 'tsx', join('src', 'cli.ts'), 'export', '--json'], { cwd: arenaDir, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  return stdout;
}

export function checkEnvelope(raw: unknown): { ok: true; envelope: Record<string, unknown> } | { ok: false; reason: string; expected: string; found: string | null } {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'the export is not an object', expected: ARENA_EXPORT_SCHEMA, found: null };
  const e = raw as { schema?: unknown; sections?: unknown };
  if (e.schema !== ARENA_EXPORT_SCHEMA) return { ok: false, reason: 'schema mismatch', expected: ARENA_EXPORT_SCHEMA, found: typeof e.schema === 'string' ? e.schema : null };
  if (!e.sections || typeof e.sections !== 'object') return { ok: false, reason: 'missing sections', expected: ARENA_EXPORT_SCHEMA, found: e.schema };
  return { ok: true, envelope: raw as Record<string, unknown> };
}

export function mountArena(router: Router, deps: ArenaDeps): void {
  const exportJson = deps.exportJson ?? realExport;
  router.get('/api/arena', async () => {
    const dir = arenaDirFor(deps.cfg());
    if (!existsSync(join(dir, 'src', 'cli.ts'))) return { ok: false, reason: `no study-arena checkout at ${dir} (set arenaDir in config.json)`, arenaDir: dir };
    let raw: unknown;
    try { raw = JSON.parse(await exportJson(dir)); } catch (e) { return { ok: false, reason: `arena export failed: ${(e as Error).message.split('\n')[0]}`, arenaDir: dir }; }
    const c = checkEnvelope(raw);
    if (!c.ok) return { ok: false, reason: c.reason, expected: c.expected, found: c.found, arenaDir: dir };
    return { ok: true, arenaDir: dir, envelope: c.envelope };
  });
}
