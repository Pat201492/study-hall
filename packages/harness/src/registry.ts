import type {
  AutomationStance, Harness, HarnessCapabilities, Provider, UsageFidelity,
} from './contract.js';

// Registries for providers and harnesses. Ported semantics from
// claude-study-room's src/harness.ts:
//   - an UNKNOWN id throws rather than falling back, so a config typo cannot
//     quietly run the control while claiming to run the experiment;
//   - fidelity is DERIVED from a capability, so an adapter cannot claim exact
//     numbers by forgetting to say otherwise;
//   - killAll sweeps every registration and one thrower cannot block the rest.
// New here: a harness registers ON a provider, and a `prohibited` pairing is a
// registration error, not a warning.

const providers = new Map<string, Provider>();
const harnesses = new Map<string, Harness>();

export function registerProvider(provider: Provider): Provider | undefined {
  const previous = providers.get(provider.id);
  providers.set(provider.id, provider);
  return previous;
}

export function getProvider(id: string): Provider {
  const p = providers.get(id);
  if (!p) {
    const known = [...providers.keys()].join(', ') || '(none registered)';
    throw new Error(`unknown provider "${id}" — registered: ${known}`);
  }
  return p;
}

export function providerIds(): string[] {
  return [...providers.keys()];
}

/**
 * Register a harness. Throws when its provider is unknown or when the pairing is
 * policy-prohibited (e.g. a non-first-party client on Anthropic consumer OAuth):
 * both vendors enforce server-side, so this is a correctness constraint.
 */
export function registerHarness(harness: Harness, opts: { allowStance?: AutomationStance[] } = {}): Harness | undefined {
  const provider = getProvider(harness.provider);
  const allowed = opts.allowStance ?? ['sanctioned', 'gray'];
  if (!allowed.includes(provider.automationStance)) {
    throw new Error(
      `refusing to register harness "${harness.id}" on provider "${provider.id}": automation stance is ${provider.automationStance}`,
    );
  }
  const previous = harnesses.get(harness.id);
  harnesses.set(harness.id, harness);
  return previous;
}

export function harnessIds(): string[] {
  return [...harnesses.keys()];
}

/** Resolve by id. No default: v2 always names its harness. */
export function getHarness(id: string): Harness {
  const h = harnesses.get(id);
  if (!h) {
    const known = harnessIds().join(', ') || '(none registered)';
    throw new Error(`unknown harness "${id}" — registered: ${known}`);
  }
  return h;
}

/** Every harness registered on a provider. */
export function harnessesFor(providerId: string): Harness[] {
  return [...harnesses.values()].filter((h) => h.provider === providerId);
}

export function killAllHarnesses(): void {
  for (const h of harnesses.values()) {
    try { h.killAll(); } catch { /* a harness that cannot reap must not block the ones that can */ }
  }
}

/** Test seam: drop every registration. */
export function clearRegistries(): void {
  harnesses.clear();
  providers.clear();
}

/**
 * The usage fidelity a harness's numbers deserve. `taskCost()` prices cache
 * reads at 0.1x base input; across 69 real sessions 95% of tokens were cache
 * reads, so a flat total mapped onto inputTokens prices a warm session ~10x too
 * high. A harness whose figures are cumulative is `exact` only if the adapter
 * diffs against a baseline — adapters declare `usageIsCumulative` and MUST diff;
 * the arena records both flags so a violation is detectable after the fact.
 */
export function fidelityFor(capabilities: Pick<HarnessCapabilities, 'cacheUsageSplit'>): UsageFidelity {
  return capabilities.cacheUsageSplit ? 'exact' : 'partial';
}
