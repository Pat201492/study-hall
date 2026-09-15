import type { Usage } from './contract.js';

// Versioned price table keyed by PROVIDER + MODEL, replacing v1's Anthropic-only
// tier enum (pricing.ts:1 in claude-study-room). A row is priced at write time
// and stamped with `PRICING_TABLE_VERSION`; recomputing on read would silently
// rewrite history every time this table is edited.
//
// Per-1M-token USD prices (base input/output). Cache read/write default to
// Anthropic's published multipliers off the base input price (5-min write
// ~1.25x input, cache read ~0.1x input) unless an entry states its own.
//
// NOTE (v1 #25): students run through the CLI's subscription login (not a
// metered API key), so on a `subscription` meter these dollars are NOT billed.
// They are an *estimated equivalent API cost*, a reference figure only. The real
// meter on a subscription is plan usage / rate-limit headroom, which we proxy
// with `tokensProcessed` (volume) + `cacheHitPct` (are-we-staying-warm). Keep
// every view honest: never present `estimateCost` as an amount charged.

export const PRICING_TABLE_VERSION = '2026-09-14';

export type CostBasis =
  /** Priced off a published list price. Comparable across rows. */
  | 'list'
  /** Priced off a PLACEHOLDER entry (`estimate: true`). The arena must not
   *  trust it: report separately, never pool with `list` rows. */
  | 'estimate'
  /** No entry for this provider/model: usd is 0 and means "unknown", not free. */
  | 'none';

export interface ModelPrice {
  /** USD per 1M fresh input tokens. */
  input: number;
  /** USD per 1M output tokens (reasoning tokens bill at this rate too). */
  output: number;
  /** USD per 1M cache-read tokens. Defaults to `input * CACHE_READ_MULT`. */
  cacheRead?: number;
  /** USD per 1M cache-write tokens. Defaults to `input * CACHE_WRITE_MULT`. */
  cacheWrite?: number;
  /** PLACEHOLDER — not a verified list price. `estimateCost` reports basis 'estimate'. */
  estimate?: boolean;
}

export const CACHE_WRITE_MULT = 1.25;
export const CACHE_READ_MULT = 0.1;

/**
 * Prices by provider id, then by MODEL PATTERN. A pattern matches a model id
 * when it is equal to it or a prefix of it (so `claude-opus-4-8` also prices a
 * dated `claude-opus-4-8-20260401`); the longest matching pattern wins and `*`
 * matches anything on that provider.
 */
export const PRICES: Record<string, Record<string, ModelPrice>> = {
  anthropic: {
    'claude-haiku-4-5': { input: 1, output: 5 },
    'claude-sonnet-5': { input: 3, output: 15 },
    'claude-opus-4-8': { input: 5, output: 25 },
  },
  // PLACEHOLDERS. These four are NOT verified OpenAI list prices; they exist so
  // a Codex row is priced at all and stamped basis 'estimate'. Replace them with
  // published figures (and bump PRICING_TABLE_VERSION) before any $ comparison
  // that includes the openai lane is reported.
  openai: {
    'gpt-5.6-terra': { input: 2, output: 8, estimate: true },
    'gpt-5.6-sol': { input: 5, output: 20, estimate: true },
    'gpt-5.6-luna': { input: 1, output: 4, estimate: true },
    'gpt-6-astra': { input: 10, output: 40, estimate: true },
  },
  // A local model costs nothing per token; this is a real zero, not "unknown".
  local: {
    '*': { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
};

/** The price entry a (provider, model) pair resolves to, or undefined. */
export function priceFor(provider: string, model: string | null | undefined): ModelPrice | undefined {
  const table = PRICES[provider];
  if (!table) return undefined;
  const id = (model ?? '').trim().toLowerCase();
  let best: { pattern: string; price: ModelPrice } | undefined;
  for (const [pattern, price] of Object.entries(table)) {
    const key = pattern.toLowerCase();
    const hit = key === '*' || (id !== '' && (id === key || id.startsWith(key)));
    if (!hit) continue;
    // A concrete pattern beats the wildcard; among concrete ones the longest wins.
    const rank = key === '*' ? -1 : key.length;
    const bestRank = best ? (best.pattern === '*' ? -1 : best.pattern.length) : -2;
    if (rank > bestRank) best = { pattern: key, price };
  }
  return best?.price;
}

export interface CostEstimate {
  usd: number;
  basis: CostBasis;
  tableVersion: string;
}

/**
 * Estimated *equivalent* API cost for one run's usage — what it WOULD cost on a
 * metered key. NOT billed on a subscription login; reference only.
 *
 * `reasoningTokens` bill at the output rate. Adapters that fill that field MUST
 * report `outputTokens` EXCLUSIVE of reasoning (Codex's `output_tokens` already
 * includes `reasoning_output_tokens`), or the run is double-billed here.
 *
 * An unknown provider/model prices to 0 with basis 'none' — "unknown", never
 * "free" — so a typo'd model id cannot make a lane look cheap.
 */
export function estimateCost(provider: string, model: string | null | undefined, usage: Usage): CostEstimate {
  const p = priceFor(provider, model);
  if (!p) return { usd: 0, basis: 'none', tableVersion: PRICING_TABLE_VERSION };
  const cacheRead = p.cacheRead ?? p.input * CACHE_READ_MULT;
  const cacheWrite = p.cacheWrite ?? p.input * CACHE_WRITE_MULT;
  const usd = (
    usage.inputTokens * p.input +
    (usage.outputTokens + usage.reasoningTokens) * p.output +
    usage.cacheCreationInputTokens * cacheWrite +
    usage.cacheReadInputTokens * cacheRead
  ) / 1_000_000;
  return { usd, basis: p.estimate ? 'estimate' : 'list', tableVersion: PRICING_TABLE_VERSION };
}

// ---- Subscription plan-usage proxies (v1 #25) -------------------------------
// On a subscription the meter that matters isn't $/token, it's plan usage /
// rate-limit headroom. We proxy it with raw volume + cache-warmth.

/**
 * Total tokens the plan processed for a run (fresh input + output + cache read).
 * Cache reads still count toward context/throughput even though they're ~0.1x the
 * $ cost — so they belong in the volume meter, not discounted out of it. Cache
 * WRITES are excluded, as in v1, so the series stays comparable with the
 * 2.97M tokens/AC baseline; `reasoningTokens` are likewise not added here.
 */
export function tokensProcessed(usage: Pick<Usage, 'inputTokens' | 'outputTokens' | 'cacheReadInputTokens'>): number {
  return usage.inputTokens + usage.outputTokens + usage.cacheReadInputTokens;
}

/**
 * Cache-hit percentage (0..100) — the "are we staying warm" signal. Denominator
 * is all input the model saw (fresh input + cache read + cache write), matching
 * Anthropic's usage fields. Returns 0 when there was no input at all.
 */
export function cacheHitPct(usage: Pick<Usage, 'inputTokens' | 'cacheReadInputTokens' | 'cacheCreationInputTokens'>): number {
  const denom = usage.inputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens;
  return denom ? Math.round((usage.cacheReadInputTokens / denom) * 100) : 0;
}

// ---- Legacy tier compatibility ---------------------------------------------

/** v1's Anthropic-shaped tier enum, kept for the role x tier attribution view
 *  and for importing v1 rows. Meaningless on other providers — `tier` is
 *  nullable on every v2 record. */
export type Tier = 'haiku' | 'sonnet' | 'opus';

/** The tier a `claude-*` model id belongs to; undefined for anything else. */
export function tierOf(model: string | null | undefined): Tier | undefined {
  const id = (model ?? '').toLowerCase();
  if (!id.startsWith('claude')) return undefined;
  if (id.includes('haiku')) return 'haiku';
  if (id.includes('sonnet')) return 'sonnet';
  if (id.includes('opus')) return 'opus';
  return undefined;
}
