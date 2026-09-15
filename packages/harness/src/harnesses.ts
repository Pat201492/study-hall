import type { Harness, Provider } from './contract.js';
import { createClaudeCodeHarness } from './adapters/claudeCode.js';
import { createCodexHarness, openaiProvider as codexProviderRecord } from './adapters/codex.js';
import { localProvider, openCodeHarness } from './adapters/opencode.js';
import { CodexAppServerQuota } from './quota/codexAppServer.js';
import { BasicQuotaMonitor } from './quota/monitor.js';
import { getHarness, harnessIds, providerIds, registerHarness, registerProvider } from './registry.js';

// The registration point. Importing this module and calling registerBuiltins()
// guarantees every built-in provider and harness exists before anything
// resolves one. Kept as a separate file (v1's harnesses.ts) so the import graph
// stays a DAG: registry.ts never imports an adapter.
//
// Providers own their quota monitors so a rate_limit_event seen by ANY Claude
// student and a Codex app-server read both land in one place per provider.

/** Anthropic consumer subscription, ridden ONLY through the unmodified `claude`
 *  binary the user logged into themselves — the documented carve-out. */
export const anthropicQuota = new BasicQuotaMonitor('anthropic');
export const anthropicProvider: Provider = {
  id: 'anthropic',
  label: 'Anthropic (Claude subscription via Claude Code)',
  credentialKind: 'oauth_subscription',
  automationStance: 'sanctioned',
  meter: 'subscription',
  quota: anthropicQuota,
};

/** OpenAI ChatGPT subscription via Codex CLI. Quota is read out of band by one
 *  long-lived `codex app-server`; the engine calls `openaiQuota.start()`. */
export const openaiQuota = new CodexAppServerQuota();
export const openaiProvider: Provider = { ...codexProviderRecord, quota: openaiQuota };

export { localProvider };

export const claudeCodeHarness: Harness = createClaudeCodeHarness({ quota: anthropicQuota });
export const codexHarness: Harness = createCodexHarness();
export { openCodeHarness };

export const BUILTIN_PROVIDERS: readonly Provider[] = Object.freeze([anthropicProvider, openaiProvider, localProvider]);
export const BUILTIN_HARNESSES: readonly Harness[] = Object.freeze([claudeCodeHarness, codexHarness, openCodeHarness]);

/** Register every built-in provider and harness. Idempotent. */
export function registerBuiltins(): { providers: string[]; harnesses: string[] } {
  for (const p of BUILTIN_PROVIDERS) registerProvider(p);
  for (const h of BUILTIN_HARNESSES) registerHarness(h);
  return { providers: providerIds(), harnesses: harnessIds() };
}

/** The harness a provider is driven through by default. */
export const DEFAULT_HARNESS_FOR_PROVIDER: Readonly<Record<string, string>> = Object.freeze({
  anthropic: 'claude-code',
  openai: 'codex',
  local: 'opencode',
});

export function defaultHarnessFor(providerId: string): Harness {
  const id = DEFAULT_HARNESS_FOR_PROVIDER[providerId];
  if (!id) throw new Error(`no default harness for provider "${providerId}"`);
  return getHarness(id);
}
