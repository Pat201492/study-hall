import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { StudentBudget, Sandbox, Approval } from '@study-hall/harness/contract';
import type { WatchdogConfig } from './watchdog.js';
import type { ThrottleConfig } from './throttle.js';
import { DEFAULT_BLACKOUT, type BlackoutConfig } from './blackout.js';
import { DEFAULT_GENERATED_FILES, type GeneratedFileRule } from './generated.js';
import { DEFAULT_AC_TIERING, type AcTieringConfig } from './difficultyRubric.js';
import type { Role } from './types.js';
import type { Tier } from './tiers.js';
import { normalizeRepo } from './repo.js';

// Engine configuration. Reads the same `config.json` the dashboard reads (its
// provider/port section lives in packages/dashboard/src/config.ts); this module
// owns the ENGINE knobs. Ported from v1 config.ts with the measured defaults and
// comments kept, and widened per provider: the pool is per PROVIDER (each has
// its own tiers/models and its own concurrency), not one Anthropic-shaped map.

export type OptimizationMode = 'speed' | 'token';
export type ReviewMode = 'auto' | 'human';

export interface TierConfig { model: string; maxWarm: number }

export interface ProviderPoolConfig {
  /** Tiers this provider offers; a tier with maxWarm 0 is disabled (tierFallback routes around it). */
  tiers: Partial<Record<Tier, TierConfig>>;
  /** Students this provider may run at once (account-wide; Codex ~2 before 429s). */
  maxConcurrent: number;
  approval: Approval;
  sandbox: Sandbox;
  /** Per-provider CLI tool allowlist; empty = the CLI default surface. */
  tools?: string[];
}

export interface RepoConfig { repo: string; priority?: number; maxWarm?: number }

export interface BoundedRunConfig {
  /** Finish this many units then park. 0 = unbounded (requires `unbounded: true`). */
  n: number;
  unit: 'pr' | 'merge';
  /** Explicit opt-in to an unbounded run — every expensive incident was one. */
  unbounded?: boolean;
}

export interface EngineConfig {
  repos: RepoConfig[];
  stateDir: string;
  optimizationMode: OptimizationMode;
  /** Global ceiling across providers; each provider's maxConcurrent also applies. */
  maxConcurrent: number;
  maxParallel?: number;
  pools: Record<string, ProviderPoolConfig>;
  autoMerge: boolean;
  reviewMode: ReviewMode;
  reportRepo: string;
  watchdog?: Partial<WatchdogConfig>;
  throttle?: Partial<ThrottleConfig>;
  blackout: BlackoutConfig;
  generatedFiles?: GeneratedFileRule[];
  studentBudget: Partial<Record<Role, StudentBudget>>;
  acTiering: AcTieringConfig;
  boundedRun: BoundedRunConfig;
  /** Heartbeat period. v1 drained the GitHub API at 2 s; 20 s is measured-safe. */
  pollMs: number;
  /** Structured crash-burst standdown: N same-signature failures within M minutes. */
  crashBurst: { count: number; windowMs: number; standdownMs: number };
}

/** Tools a board student is given — measured at -11,382 tokens/turn vs the full surface. */
export const DEFAULT_STUDENT_TOOLS: readonly string[] = [
  'Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob', 'PowerShell', 'WebFetch', 'WebSearch',
];

/**
 * OFF by default, because when it was on it was measured and it lost: with
 * `implement` capped at 70 turns / 8M tokens, tokens per MERGED PR went from
 * 9.5M to 20.5M — a split session pays repo ramp-up twice. The machinery stays
 * (it banks partial work correctly); only the default is off.
 */
export const DEFAULT_STUDENT_BUDGET: Partial<Record<Role, StudentBudget>> = {};

export const DEFAULT_POOLS: Record<string, ProviderPoolConfig> = {
  anthropic: {
    tiers: {
      haiku: { model: 'claude-haiku-4-5', maxWarm: 2 },
      sonnet: { model: 'claude-sonnet-5', maxWarm: 3 },
      opus: { model: 'claude-opus-4-8', maxWarm: 3 },
    },
    maxConcurrent: 4,
    approval: 'never',
    sandbox: 'none',
    tools: [...DEFAULT_STUDENT_TOOLS],
  },
  openai: {
    // Codex tiers map onto the same ladder so tierForDifficulty keeps working;
    // there is no objective equivalence between vendor tiers (declared in the arena).
    tiers: {
      haiku: { model: 'gpt-5.6-luna', maxWarm: 1 },
      sonnet: { model: 'gpt-5.6-terra', maxWarm: 2 },
      opus: { model: 'gpt-5.6-sol', maxWarm: 1 },
    },
    maxConcurrent: 2,
    approval: 'never',
    sandbox: 'workspace-write',
  },
};

export const DEFAULT_ENGINE_CONFIG: EngineConfig = {
  repos: [],
  stateDir: join(homedir(), '.study-hall'),
  optimizationMode: 'token',
  maxConcurrent: 4,
  pools: DEFAULT_POOLS,
  autoMerge: true,
  reviewMode: 'auto',
  reportRepo: 'Pat201492/study-hall',
  blackout: { ...DEFAULT_BLACKOUT, enabled: false },
  studentBudget: DEFAULT_STUDENT_BUDGET,
  acTiering: DEFAULT_AC_TIERING,
  boundedRun: { n: 5, unit: 'pr' },
  pollMs: 20_000,
  crashBurst: { count: 5, windowMs: 10 * 60_000, standdownMs: 30 * 60_000 },
};

export function engineConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.STUDY_HALL_CONFIG || 'config.json');
}

function rawConfig(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const v = JSON.parse(readFileSync(path, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}

/** Load with per-key merges so naming one knob keeps the measured defaults for the rest. */
export function loadEngineConfig(path: string = engineConfigPath(), env: NodeJS.ProcessEnv = process.env): EngineConfig {
  const raw = rawConfig(path) as Partial<EngineConfig> & { repos?: Array<string | RepoConfig>; provider?: { concurrency?: Record<string, number> } };
  const pools: Record<string, ProviderPoolConfig> = {};
  for (const [id, base] of Object.entries(DEFAULT_POOLS)) {
    const over = raw.pools?.[id];
    pools[id] = {
      ...base, ...(over ?? {}),
      tiers: { ...base.tiers, ...(over?.tiers ?? {}) },
      maxConcurrent: raw.provider?.concurrency?.[id] ?? over?.maxConcurrent ?? base.maxConcurrent,
    };
  }
  for (const [id, over] of Object.entries(raw.pools ?? {})) if (!pools[id]) pools[id] = over as ProviderPoolConfig;
  const cfg: EngineConfig = {
    ...DEFAULT_ENGINE_CONFIG,
    ...raw,
    repos: (raw.repos ?? []).map((r) => (typeof r === 'string' ? { repo: normalizeRepo(r) } : { ...r, repo: normalizeRepo(r.repo) })),
    pools,
    blackout: { ...DEFAULT_ENGINE_CONFIG.blackout, ...(raw.blackout ?? {}) },
    studentBudget: { ...DEFAULT_STUDENT_BUDGET, ...(raw.studentBudget ?? {}) },
    acTiering: { ...DEFAULT_AC_TIERING, ...(raw.acTiering ?? {}) },
    boundedRun: { ...DEFAULT_ENGINE_CONFIG.boundedRun, ...(raw.boundedRun ?? {}) },
    crashBurst: { ...DEFAULT_ENGINE_CONFIG.crashBurst, ...(raw.crashBurst ?? {}) },
  };
  if (env.STUDY_HALL_STATE_DIR) cfg.stateDir = env.STUDY_HALL_STATE_DIR;
  if (env.POLL_MS) cfg.pollMs = Number(env.POLL_MS) || cfg.pollMs;
  return cfg;
}

/** Generated-file rules in force: the repo's own list when non-empty, else the JS lockfile defaults. */
export function generatedFilesFor(cfg: Pick<EngineConfig, 'generatedFiles'>): readonly GeneratedFileRule[] {
  return cfg.generatedFiles?.length ? cfg.generatedFiles : DEFAULT_GENERATED_FILES;
}

/** The model a provider runs a tier on, honouring disabled tiers via tierFallback upstream. */
export function modelFor(cfg: EngineConfig, provider: string, tier: Tier): string | undefined {
  return cfg.pools[provider]?.tiers[tier]?.model;
}
