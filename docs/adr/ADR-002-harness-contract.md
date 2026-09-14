# ADR-002 — The `@study-hall/harness` contract (2026-09-14)

## Decision
One package, imported by both the engine and `study-arena`, owns: the Harness/Provider contract,
the CLI adapters (claude-code, codex, opencode), the per-provider quota state machine, run guards,
and the run ledger. Adapters spawn the stock binaries with `shell:false`; the package never reads
or copies a credential.

## Kept from v1 (measured, see docs/research/code-student-harness.json)
- Declared, inspectable capabilities; no lowest-common-denominator normalisation (the whole saving
  lives in `--session-id` / `--resume --fork-session`).
- Unknown id throws (a config typo must not run the control while claiming the experiment).
- Fidelity derived from `cacheUsageSplit` (95 % of tokens are cache reads; a flat total misprices ~10x).
- Budget stop RESOLVES with partial work banked; idle watchdog counts ticks, not wall-clock.
- `seedableSessions` split from `warmSessions` (#307) — adopt-only harnesses learn their id.

## Changed
| v1 | v2 | Why |
|---|---|---|
| `HarnessRunOptions = RunCliTaskOptions` (Claude-shaped alias) | real struct: `session {mode,seed,base}`, `approval`, `sandbox`, `effort`, `signal`, `transcriptSink`, `onQuota`, `extra` | Codex expresses resume/fork as subcommands and its control surface as `-c` config; the alias leaked `claudeBin`. |
| `isCapacityError(msg): boolean` + free `isInfraFailure` + `parseCapacityReset` | `classifyFailure(msg, now) → {kind: capacity|infra|auth|task|cancelled, resetAt}` per harness | Codex exit codes are 0/1 only; its wording uses U+2019; `auth` is a third class (halt lane, never retry). |
| no quota | `Provider.quota: QuotaMonitor` (available / exhausted / unknown) | Claude: `rate_limit_event.unifiedWindows` (CLI ≥ 2.1.268). Codex: `app-server account/rateLimits/read`. Unknown is probed, never assumed. |
| 4 token fields | 5 (`reasoningTokens`) | Codex/OpenCode bill reasoning separately; folding it hides a lane's spend. |
| `budgetStop` per adapter | generic `attachGuards` for any adapter with `streamsUsage` | v1's OpenCode lane had no watchdog despite the 12-hour hang that justified it. |
| `usage.jsonl` 14 fields | ledger (sqlite + jsonl mirror): runs, outcomes, assignments, events, quota | "what did it do" was unanswerable; v1 field names kept for import. |
| `--version` preflight | preflight does a trivial real completion | `--version` passes with an expired OAuth token (8 logged 401s after a clean preflight). |

## Policy guardrails encoded
`Provider.automationStance` is checked at registration; `prohibited` pairs throw. Anthropic consumer
OAuth is `sanctioned` only for the unmodified `claude` binary (first-party). OpenAI ChatGPT login is
`gray` (documented `codex exec` on a plan, automation steered to API keys) with `concurrencyCap: 2`.
Every timestamp is epoch ms; providers' seconds are converted at the boundary.
