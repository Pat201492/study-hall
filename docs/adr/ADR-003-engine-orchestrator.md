# ADR-003 — Engine orchestrator: re-cutting v1's `live.ts` (2026-09-15)

## Status
Design accepted; pure prerequisites landed (`providerSelect.ts`, `config.ts`, `worktree.ts`,
`generated.ts`, the ported core). The orchestrator modules below are the next build.

## Problem
v1's `live.ts` (2,713 lines) fuses orchestration, git, `gh`, process lifecycle, persistence,
telemetry and reporting into one class holding a mutable per-board cursor (`this.rs`) across
awaits. Every multi-repo defect in the handoffs was a key-format mismatch at a `live.ts` call
site; no test targets it; and the warm pool it advertises is never wired into dispatch.

## Decision: five units, repo passed explicitly, the tick is a pure function

```
packages/core/src/engine/
  boardCycle.ts   decide(snapshot, state, clock) -> Decision[]        PURE
  governance.ts   watchdog + parole + capacity + blackout + throttle  PURE over inputs, returns verdicts
  roleRunner.ts   ONE parameterised runner (prompt, worktree, run, effect)   IO
  persistence.ts  every save takes the RepoState it writes; ledger writes    IO
  reporting.ts    GitHub issue bodies + events                               IO
  engine.ts       heartbeat: fetch -> decide -> dispatch; status snapshot    IO glue
  index.ts        `--live` entry: config, registerBuiltins, quota start, engine.start()
```

### boardCycle.decide
Input: per repo `{issues, pulls, taskMap, handled, quarantined, inFlight keys}` + global
`{quotas, inFlight per provider, providerSetting per surface, blackout, capacityPausedUntil,
throttle limit, boundedRun remaining}`. Output: ordered `Decision[]` where each is
`{action: BoardAction (repo-typed), role, tier, provider, harness, model, reason}` or a
`{kind:'probe', provider}` / `{kind:'hold', reason}`. Uses `classify` → `fairShare` →
`selectProvider` → `tierForDifficulty`/`effectiveTier` → `modelFor`. `repo` is a typed field
on `BoardAction` (add to `classify.ts`), never a cast.

### roleRunner.run
One function for implement/review/fix/rewrite/resolve/triage:
1. `prepareWorktree(kind)` — `addWorktree` (implement/triage) or `addWorktreeForBranch`
   (review/fix/resolve), serialised through one git lock per clone.
2. `buildPrompt(kind)` — `taskPrompt`/`reviewPrompt`/`fixPrompt`/`rewritePrompt`/
   `resolvePrompt`/`triagePrompt` from `prompts.ts`, spec via `readSpec` (never re-send CLAUDE.md).
3. `runOnSlot` — the Protector worker owns a `WarmSlot` (from `@study-hall/harness`); the slot
   picks seed/adopt/fork per the harness capabilities. Options: `cwd`, `model`, `effort`
   (`effortFor(tier, mode)`), `approval`/`sandbox` from the provider pool, `tools`, `budget`,
   `onUsage` (live grid), `onQuota` (monitor), `transcriptSink` → `<stateDir>/transcripts/<runId>.jsonl`,
   `signal` (soft stop), `extra.usageBaseline` (Codex).
4. `effect(kind, result)` — implement: `commitAndPush` → `openPr` → `handled`; empty diff →
   `classifyEmptyRun` (satisfied → park `already-satisfied`); review: `parseVerdict` →
   `approvePr`/`requestChangesPr` + label; fix/rewrite: `pushBranch`; resolve: `startBaseMerge`
   → `regenerateLockfiles` → student → `finishMergePush`; triage: `parseTriage` → orchestrator
   files pieces (never the student).
5. `record` — `ledger.recordRun(toRunRecord(...))` with every field the arena needs
   (runId minted at dispatch, startedAt/endedAt, provider/harness/model/effort, warmMechanism,
   worktree/branch/baseSha, promptSha256, toolAllowlist, sandbox/approval, transcriptPath,
   costs by meter); outcomes as `recordOutcome` when the PR opens/merges.
6. `finally` — remove worktree, free the worker, `onChange`.

Failure routing: `harness.classifyFailure(msg)` → `capacity` → `provider.quota.markExhausted(resetAt)`
+ watchdog forgive; `infra` → infra streak + standdown; `auth` → halt that provider's lane
(`halted[provider] = detail`, alert event), never retry; `task` → watchdog attempt; `cancelled`
→ bank partial, no attempt charged.

### governance
Ported verbatim: `Watchdog` (attempt ladder, oscillation cap, lifetime cap, board-churn
fingerprints), `parole`, `blackout`, `throttle`, `infraFailure` pause math, `reportLifecycle`,
`testRun` (bounded run). New: crash-burst standdown (`config.crashBurst`), provider `halted`
map, per-provider in-flight counts feeding `selectProvider`. Capacity reset comes from the
`FailureVerdict.resetAt` (structured), never from regexing English.

### persistence
Per-repo dir `<stateDir>/repos/<owner-name>/` (one canonical form; reads legacy v1
`attempts/lifetime/handled/quarantine.json` from `~/.claude-study-room/https---github.com-*`
on first boot when present). `status.json` is engine-wide at `<stateDir>/status.json` (the
dashboard's Boards/Pool tabs read it) — never per primary repo.

### engine
Heartbeat every `pollMs`, re-entrancy guarded (skip, never queue). Per tick: fetch issues + pulls
per repo → `decide` → dispatch up to `min(throttle.limit, sum of provider caps)` → probes for
`needs-probe` providers (one trivial run) → write status → `ledger.recordEvent` for every
decision reason. Shutdown: `killAllHarnesses()`, write stopped status. Bounded by default
(`boundedRun.n`); unbounded needs `unbounded: true` in config.

## Tests to write with it
- `boardCycle.test.ts`: a 3-tick scenario (issue → implement decision → PR appears → review →
  merge) against fixture boards; failover scenario (Claude `exhausted` → Codex → recovered);
  probe-before-commit; caps; blackout; bounded run parks.
- `roleRunner.test.ts`: fake harness + fake git/gh ports; every effect branch; failure routing
  table; ledger rows carry the arena fields.
- `engine.test.ts`: in-process engine with fake ports, two ticks, status snapshot shape,
  re-entrancy skip, soft stop banks work.
- A Windows process-tree test: spawn a fake child tree, stop, assert no orphans.

## Out of scope for the first cut
Editor/Admissions modes (phase 6), Task-map editing (derived cache only), legacy state-dir
migration beyond read-on-boot.
