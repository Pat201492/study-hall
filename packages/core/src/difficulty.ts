import type { Tier } from './tiers.js';
import type { OptimizationMode } from './optimizer.js';

// Model tiering by task DIFFICULTY (M8, see CLAUDE.md's "Model tiering
// economics"): the Protector picks a tier per-task from a difficulty label —
// simple -> Haiku, standard -> Sonnet, hard -> Opus — never a blanket tier.
// Opus is ~1.67x Sonnet (not 5x, that's vs Haiku), so a hard task justifies
// Opus; Sonnet is the default workhorse.

export type Difficulty = 'simple' | 'standard' | 'hard';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh';

// Every Difficulty as a list, so anything that has to ENUMERATE the difficulty
// labels (ensureLabels' registration set, relabel-issues) derives them from the
// type instead of restating the three strings.
export const DIFFICULTIES: readonly Difficulty[] = ['simple', 'standard', 'hard'];

// The GitHub label that carries a difficulty — one source of truth, because this
// label is the entire tiering control surface: difficultyFromLabels() beats every
// heuristic, so a call site that spells the string slightly differently gets its
// issue routed by keyword guesswork instead. Must stay in step with
// PIPELINE_LABELS (github.ts), which is asserted by test/github.test.ts.
export function difficultyLabel(d: Difficulty): string {
  return `difficulty:${d}`;
}

// Measured on this engine over 48 implement dispatches, rather than assumed
// from the per-token weights:
//
//              merged   approved on FIRST review   median tokens/session
//   opus        100%           85% (17/20)                 1.09M
//   sonnet       82%           48% (12/25)                 2.74M
//
// Opus lands work first time nearly twice as often AND spends 2.5x fewer tokens
// doing it. Even after its ~1.67x usage weight that is ~1.82M effective against
// Sonnet's 2.74M — cheaper in plan usage, with nothing left unmerged.
//
// The reason is the same quadratic effect that governs everything else here:
// Sonnet's cheaper tokens get spent twice when a PR comes back for another
// review round, and a rework round costs far more than the tier difference ever
// saved. Cheaper per token is not cheaper per merged PR.
//
// So `standard` routes to Opus. Sonnet remains the tier for genuinely small
// work, and Haiku for trivia, because neither of those was what the measurement
// covered — it compared the two tiers actually competing for implement work.
const BASE_TIER: Record<Difficulty, Tier> = {
  simple: 'haiku',
  standard: 'opus',
  hard: 'opus',
};

// Speed mode trades cost for quality/throughput: bump every difficulty one
// tier up (opus is already the ceiling). Token mode keeps the cost-efficient
// base mapping — see CLAUDE.md's Optimization toggle section.
const TIER_UP: Record<Tier, Tier> = { haiku: 'sonnet', sonnet: 'opus', opus: 'opus' };

// difficulty -> tier, with the Speed/Token toggle (#7) as an override on top
// of the base mapping. `pinned` tasks bypass this entirely upstream (see
// taskmap.ts's pinToOpus/setPinned) — this function only covers the
// difficulty-driven case.
export function tierForDifficulty(difficulty: Difficulty, mode: OptimizationMode): Tier {
  const base = BASE_TIER[difficulty];
  return mode === 'speed' ? TIER_UP[base] : base;
}

// Effort for a task already assigned to `tier`: xhigh coding on Sonnet/Opus,
// low on Haiku (Haiku only wins when it's right first try — no room for a
// half-effort pass) and low for sub-agent calls regardless of tier.
function baseEffort(tier: Tier, subagent: boolean): Effort {
  if (subagent) return 'low';
  return tier === 'haiku' ? 'low' : 'xhigh';
}

// Token mode additionally dials back effort (maximal cache reuse, lower
// spend) even on tiers that would otherwise run xhigh; Speed mode keeps the
// tier's base effort since quality/throughput is the point.
export function effortFor(tier: Tier, mode: OptimizationMode, opts: { subagent?: boolean } = {}): Effort {
  const base = baseEffort(tier, opts.subagent ?? false);
  if (mode === 'token' && base === 'xhigh') return 'medium';
  return base;
}

// Keyword heuristic for when a task has no explicit difficulty label — scans
// the title/description for hard/simple signals, defaulting to 'standard'
// (Sonnet) when nothing matches, matching the spec's "default -> Sonnet".
const HARD_SIGNALS = /\b(migrat|rearchitect|architecture|security|race condition|concurren|deadlock|distributed|auth(entication|orization)?|encrypt|payment)/i;

// `simple` means TRIVIA — work where a wrong first attempt is cheap to redo.
// The bar is deliberately high, because misclassifying real work as simple is
// the expensive direction: it routes to a weaker tier, and the measurements
// above say a weaker tier pays for itself twice over in review rounds.
//
// `docs?` and `comment` were removed from this list. They are the words most
// likely to appear INSIDE a substantial issue — "document the contract",
// "comment on the schema" — and matching them sent real implementation work to
// the cheap tier. An issue that is genuinely only a docs change still matches
// via `changelog`, `typo`, or its own small size.
const SIMPLE_SIGNALS = /\b(typo|rename|formatting|lint|whitespace|bump version|changelog)\b/i;

export function inferDifficulty(text: string): Difficulty {
  if (HARD_SIGNALS.test(text)) return 'hard';
  if (SIMPLE_SIGNALS.test(text)) return 'simple';
  return 'standard';
}
