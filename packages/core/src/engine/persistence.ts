import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  newRepoState, loadHandled, saveHandled, loadQuarantine, saveQuarantine,
  loadAttempts, saveAttempts, loadLifetime, saveLifetime, type RepoState,
} from '../repoStateIo.js';
import type { ParoleRecord } from '../parole.js';
import { normalizeRepo } from '../repo.js';
import { STATUS_SCHEMA, type EngineStatus } from './status.js';

// Every durable per-repo fact the engine remembers between ticks and restarts,
// in ONE canonical place per repo, plus the engine-wide status snapshot.
//
// Every save takes the repo it writes. v1's saveHandled/parkSpecChanged wrote
// the PRIMARY repo's file for whichever board was being worked, so a secondary
// repo's handled set landed in the wrong directory and came back empty on
// boot. Here the repo is the first argument of every call and the file is
// derived from it, so there is no cursor to be pointing at the wrong board.
//
// Layout: `<stateDir>/repos/<owner>-<name>/{handled,quarantine,attempts,lifetime}.json`
// (one naming form; v1 had two), `<stateDir>/status.json` engine-wide. The file
// formats are v1's, read and written by the ported repoStateIo functions, so a
// first boot next to a v1 install can import its counters as-is.

export const LEGACY_ROOT = join(homedir(), '.claude-study-room');

export interface RepoMemory {
  handled: Set<number>;
  quarantined: Set<string>;
  paroleOf: Map<string, ParoleRecord>;
  attempts: Record<string, number>;
  lifetime: Record<string, number>;
}

export interface LoadResult {
  memory: RepoMemory;
  /** Set when the canonical dir was empty and a legacy v1 dir was read instead. */
  importedFrom?: string;
  /** Which legacy files were found and copied. */
  imported: string[];
}

export const MEMORY_FILES = ['handled.json', 'quarantine.json', 'attempts.json', 'lifetime.json'] as const;

/** `<stateDir>/repos/<owner>-<name>` — the one canonical form. */
export function repoStateDir(stateDir: string, repo: string): string {
  return join(stateDir, 'repos', normalizeRepo(repo).replace(/[/:]/g, '-'));
}

/** The two forms v1 used, newest convention first. */
export function legacyStateDirs(legacyRoot: string, repo: string): string[] {
  const slug = normalizeRepo(repo);
  return [
    join(legacyRoot, `https---github.com-${slug.replace('/', '-')}`),
    join(legacyRoot, slug.replace('/', '-')),
  ];
}

export interface PersistenceOptions {
  stateDir: string;
  /** Where a v1 install keeps its per-repo dirs; read on first boot only. */
  legacyRoot?: string;
  log?: (message: string) => void;
}

export class Persistence {
  readonly stateDir: string;
  private readonly legacyRoot: string;
  private readonly log: (message: string) => void;

  constructor(opts: PersistenceOptions) {
    this.stateDir = opts.stateDir;
    this.legacyRoot = opts.legacyRoot ?? LEGACY_ROOT;
    this.log = opts.log ?? (() => {});
  }

  dirFor(repo: string): string {
    return repoStateDir(this.stateDir, repo);
  }

  /** A RepoState-shaped handle for the ported v1 loaders/savers, pointed at `dir`. */
  private handle(repo: string, dir = this.dirFor(repo)): RepoState {
    return newRepoState(normalizeRepo(repo), repo, dir);
  }

  private hasAnyMemory(dir: string): boolean {
    return MEMORY_FILES.some((f) => existsSync(join(dir, f)));
  }

  /**
   * Read a repo's memory. When the canonical dir has none of the four files and
   * a legacy v1 dir does, read the legacy files, write them to the canonical dir
   * and report what was imported — so counters carry over and the next boot
   * reads only the canonical place.
   */
  load(repo: string, now = Date.now()): LoadResult {
    const dir = this.dirFor(repo);
    let importedFrom: string | undefined;
    const imported: string[] = [];
    if (!this.hasAnyMemory(dir)) {
      const legacy = legacyStateDirs(this.legacyRoot, repo).find((d) => this.hasAnyMemory(d));
      if (legacy) {
        mkdirSync(dir, { recursive: true });
        for (const f of MEMORY_FILES) {
          const src = join(legacy, f);
          if (!existsSync(src)) continue;
          writeFileSync(join(dir, f), readFileSync(src));
          imported.push(f);
        }
        importedFrom = legacy;
        this.log(`${normalizeRepo(repo)}: imported v1 state (${imported.join(', ')}) from ${legacy}`);
      }
    }
    const s = this.handle(repo, dir);
    loadHandled(s);
    loadQuarantine(s, now);
    return {
      memory: {
        handled: s.handled, quarantined: s.quarantined, paroleOf: s.paroleOf,
        attempts: loadAttempts(s), lifetime: loadLifetime(s),
      },
      importedFrom, imported,
    };
  }

  saveHandled(repo: string, handled: ReadonlySet<number>): void {
    const s = this.handle(repo);
    s.handled = new Set(handled);
    saveHandled(s);
  }

  saveQuarantine(repo: string, quarantined: ReadonlySet<string>, paroleOf: ReadonlyMap<string, ParoleRecord>): void {
    const s = this.handle(repo);
    s.quarantined = new Set(quarantined);
    s.paroleOf = new Map(paroleOf);
    saveQuarantine(s);
  }

  /** Persists only this repo's keys out of the engine-wide watchdog snapshot. */
  saveAttempts(repo: string, counts: Record<string, number>): void {
    saveAttempts(this.handle(repo), counts);
  }

  saveLifetime(repo: string, counts: Record<string, number>): void {
    saveLifetime(this.handle(repo), counts);
  }

  // ---- engine-wide status ---------------------------------------------------

  statusPath(): string {
    return join(this.stateDir, 'status.json');
  }

  /** Atomic write (tmp + rename) so a dashboard reading mid-write never sees a torn file. */
  writeStatus(status: EngineStatus): void {
    mkdirSync(this.stateDir, { recursive: true });
    const tmp = `${this.statusPath()}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ ...status, schema: STATUS_SCHEMA }, null, 2));
    renameSync(tmp, this.statusPath());
  }

  readStatus(): EngineStatus | null {
    try {
      const raw = JSON.parse(readFileSync(this.statusPath(), 'utf8')) as EngineStatus;
      return raw && raw.schema === STATUS_SCHEMA ? raw : null;
    } catch { return null; }
  }
}
