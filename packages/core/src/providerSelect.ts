import type { QuotaSnapshot } from '@study-hall/harness/contract';

// Which provider drives the next dispatch. Pure over (settings, quota snapshots,
// in-flight counts) so the failover rule is unit-testable and the dashboard can
// show WHY a provider was chosen.
//
// Three-state quota, not a boolean: AVAILABLE dispatches; EXHAUSTED hands over;
// UNKNOWN means nobody has observed the provider recently — the engine sends ONE
// probe there before committing a board, never assumes full, never assumes empty.

export type ProviderChoice = 'auto' | string;

export interface ProviderSelectInput {
  /** The surface's setting: a provider id, or 'auto' for failover. */
  choice: ProviderChoice;
  /** Order tried under 'auto'. */
  failoverOrder: string[];
  quotas: Record<string, QuotaSnapshot | undefined>;
  /** Students currently running per provider. */
  inFlight: Record<string, number>;
  /** Concurrency cap per provider (Codex ~2 before 429s). */
  caps: Record<string, number | undefined>;
  /** Providers whose lane is halted (auth failure) until an operator acts. */
  halted?: Record<string, string | undefined>;
}

export type SelectReason =
  | 'pinned' | 'pinned-but-exhausted' | 'pinned-but-halted' | 'pinned-at-cap'
  | 'first-available' | 'all-at-cap' | 'all-exhausted' | 'needs-probe';

export interface ProviderSelection {
  provider: string | null;
  reason: SelectReason;
  /** A provider in UNKNOWN that should be probed before it is trusted. */
  probe?: string;
  detail?: string;
}

function stateOf(input: ProviderSelectInput, id: string): 'available' | 'exhausted' | 'unknown' {
  return input.quotas[id]?.state ?? 'unknown';
}

function atCap(input: ProviderSelectInput, id: string): boolean {
  const cap = input.caps[id];
  return cap != null && cap > 0 && (input.inFlight[id] ?? 0) >= cap;
}

export function selectProvider(input: ProviderSelectInput): ProviderSelection {
  const halted = input.halted ?? {};
  if (input.choice !== 'auto') {
    const id = input.choice;
    if (halted[id]) return { provider: null, reason: 'pinned-but-halted', detail: halted[id] };
    if (stateOf(input, id) === 'exhausted') return { provider: null, reason: 'pinned-but-exhausted', detail: input.quotas[id]?.observation?.detail };
    if (atCap(input, id)) return { provider: null, reason: 'pinned-at-cap' };
    if (stateOf(input, id) === 'unknown') return { provider: id, reason: 'needs-probe', probe: id };
    return { provider: id, reason: 'pinned' };
  }

  let sawCap = false;
  let firstUnknown: string | undefined;
  for (const id of input.failoverOrder) {
    if (halted[id]) continue;
    const st = stateOf(input, id);
    if (st === 'exhausted') continue;
    if (atCap(input, id)) { sawCap = true; continue; }
    if (st === 'unknown') { firstUnknown ??= id; continue; }
    return { provider: id, reason: 'first-available' };
  }
  // Nothing is known-available. Prefer probing an unknown over declaring exhaustion:
  // a provider nobody has looked at is not a provider that is out.
  if (firstUnknown) return { provider: firstUnknown, reason: 'needs-probe', probe: firstUnknown };
  if (sawCap) return { provider: null, reason: 'all-at-cap' };
  return { provider: null, reason: 'all-exhausted' };
}
