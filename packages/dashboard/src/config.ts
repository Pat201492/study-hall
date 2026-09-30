import type { RateLimit } from '@study-hall/core/rateBudget';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

// Dashboard/engine configuration. One file (`config.json` at the repo root,
// overridable with STUDY_HALL_CONFIG), re-read on demand, mutated through one
// seam so the on-disk shape is defined once. Ported pattern from v1 config.ts:
// readRawConfig never throws, mutateConfig writes back only what was set.

export type ProviderChoice = 'anthropic' | 'openai' | 'auto';

/** Surfaces that carry their own provider override. */
export const SURFACES = ['board', 'planner', 'editor', 'admissions', 'arena'] as const;
export type Surface = (typeof SURFACES)[number];

export interface ProviderSettings {
  /** The global choice. `auto` = failover down `failoverOrder`. */
  default: ProviderChoice;
  /** Order tried when `auto`; the first AVAILABLE provider wins. */
  failoverOrder: string[];
  /** Per-surface override; absent = follow the global default. */
  perSurface: Partial<Record<Surface, ProviderChoice>>;
  /** Hand Claude over when the limiting window reaches this fraction. */
  handoverAt: number;
  /** Concurrency per provider (Codex reports 429s above ~2-3 streams). */
  concurrency: Record<string, number>;
  /** Burn-rate ceiling per provider; absent/zero = uncapped (core/rateBudget.ts). */
  rateLimit?: Record<string, RateLimit>;
}

export interface StudyHallConfig {
  port: number;
  /** Root for the ledger, per-repo state, archives. */
  stateDir: string;
  repos: string[];
  provider: ProviderSettings;
  models: Record<string, { haiku?: string; sonnet?: string; opus?: string; default?: string }>;
  /** Where v1 kept its usage.jsonl, for the one-shot import. */
  v1UsagePath: string;
  /** The study-arena checkout the Arena tab reads (defaults to the sibling ../study-arena). */
  arenaDir?: string;
}

export const DEFAULT_CONFIG: StudyHallConfig = {
  port: 4800,
  stateDir: join(homedir(), '.study-hall'),
  repos: [],
  provider: {
    default: 'anthropic',
    failoverOrder: ['anthropic', 'openai'],
    perSurface: {},
    handoverAt: 0.9,
    concurrency: { anthropic: 4, openai: 2, local: 1 },
  },
  models: {
    anthropic: { haiku: 'claude-haiku-4-5', sonnet: 'claude-sonnet-5', opus: 'claude-opus-4-8', default: 'claude-sonnet-5' },
    openai: { haiku: 'gpt-5.6-luna', sonnet: 'gpt-5.6-terra', opus: 'gpt-5.6-sol', default: 'gpt-5.6-terra' },
    local: {},
  },
  v1UsagePath: join(homedir(), '.claude-study-room', 'usage.jsonl'),
};

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.STUDY_HALL_CONFIG || 'config.json');
}

/** The RAW on-disk object, `{}` when missing or corrupt — a hand-edited file can never take the server down. */
export function readRawConfig(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function loadConfig(path: string = configPath(), env: NodeJS.ProcessEnv = process.env): StudyHallConfig {
  const raw = readRawConfig(path) as Partial<StudyHallConfig>;
  const provider = { ...DEFAULT_CONFIG.provider, ...(raw.provider ?? {}) };
  provider.perSurface = { ...(raw.provider?.perSurface ?? {}) };
  provider.concurrency = { ...DEFAULT_CONFIG.provider.concurrency, ...(raw.provider?.concurrency ?? {}) };
  provider.rateLimit = { ...(raw.provider?.rateLimit ?? {}) };
  const cfg: StudyHallConfig = {
    ...DEFAULT_CONFIG,
    ...raw,
    provider,
    models: { ...DEFAULT_CONFIG.models, ...(raw.models ?? {}) },
    repos: Array.isArray(raw.repos) ? raw.repos.filter((r): r is string => typeof r === 'string') : [],
  };
  if (env.STUDY_HALL_PORT) cfg.port = Number(env.STUDY_HALL_PORT) || cfg.port;
  if (env.STUDY_HALL_STATE_DIR) cfg.stateDir = env.STUDY_HALL_STATE_DIR;
  return cfg;
}

/** Read-modify-write through one seam; writes only the raw object, never the defaults. */
export function mutateConfig(path: string, fn: (raw: Record<string, unknown>) => void): void {
  const raw = readRawConfig(path);
  fn(raw);
  writeFileSync(path, JSON.stringify(raw, null, 2) + '\n');
}

/** The provider choice in force for a surface: its override, else the global default. */
export function providerFor(cfg: StudyHallConfig, surface: Surface): ProviderChoice {
  return cfg.provider.perSurface[surface] ?? cfg.provider.default;
}

export function isProviderChoice(v: unknown): v is ProviderChoice {
  return v === 'anthropic' || v === 'openai' || v === 'auto';
}

export function isSurface(v: unknown): v is Surface {
  return typeof v === 'string' && (SURFACES as readonly string[]).includes(v);
}
