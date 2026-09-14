# study-hall (Study Room v2) + study-arena (harness arena)

## Context

`Pat201492/claude-study-room` is a 15k-line TS engine (300+ PRs) that drives GitHub boards with a
pool of headless `claude -p` students. It works, but four things the user wants are structurally
missing, and a read-only sweep (16 agents, 11 lenses, 2026-09-13) found why:

1. **Issue creation is fire-and-forget.** No interactive session exists anywhere; the rubric
   (`docs/ISSUE-RUBRIC.md`) is a doc no model reads; `parseDeps` cannot parse the `Depends on: #N`
   form the rubric prescribes; the audit gate (`maxCriteria: 4`) contradicts the rubric's 3–6 band, so
   rubric-compliant issues burn a triage session.
2. **Memory dies with the process.** `usage.jsonl` (14 fields, 7 rows, write-only, no reader) is the
   only durable record. No run id, duration, session id, transcript link, PR, outcome, or provider.
   Attribution/assignment rings are in-memory. The $2.72/AC baseline is not reproducible (scripts never
   committed; 27/77 transcripts already expired by default 30-day cleanup).
3. **One provider.** `HarnessRunOptions` is an alias of the Claude CLI's options; `getHarness()` is
   never called with an id; capacity = regex over English error text; no quota read exists. Codex CLI
   is not installed. The registered second harness (OpenCode) cannot ride any subscription.
4. **The warm pool is not warm.** No dispatch site passes `--session-id/--resume/--fork-session`;
   `WarmCliSession` is wired only into the Editor. `live.ts` (2,713 lines) holds a mutable per-board
   cursor across awaits; every multi-repo bug in the handoffs was a key-format mismatch there.

User decisions (2026-09-13/14): **new repo, port the proven core**; names **`study-hall`** (package `@study-hall/harness`) and **`study-arena`**; durability = **logon Scheduled Task**; **Codex installed now** with a free-tier login for Phase 0 spikes; dashboard = **vanilla ES modules, no bundler**; **no GitHub Actions** (memory: free plan, shared minutes) — tests run locally on Windows; provider is a **UI toggle on every
tab** (Claude / ChatGPT / Both = failover); planner lives in a **dashboard tab**; arena is a **second
repo consuming a shared harness package** from repo 1. Old engine keeps running untouched
(memory: never restart it) until v2 is proven in the arena.

Key research facts that shape the design (full dossiers in session scratchpad `code-*.json`,
`research-*.json`, `fills.json`):

| Fact | Consequence |
|---|---|
| Claude Code ≥2.1.268 emits `rate_limit_event.rate_limit_info.unifiedWindows.{five_hour,seven_day}.{utilization,resetsAt}` on headless stream-json stdout. Engine spawns 2.1.158 (no field). 2.1.270 is on disk (VS Code ext). | Upgrade CLI; read quota off the stream we already parse. Zero extra calls, zero policy risk. Never read `.credentials.json`. |
| Codex: `codex app-server` JSON-RPC `account/rateLimits/read` → `{ordinaryUsageAllowed, primary/secondary.{usedPercent,windowDurationMins,resetsAt}}` + push `account/rateLimits/updated`. `codex exec --json` has NO quota. | Codex quota via one long-lived app-server process per engine. Handover/recovery gate = `ordinaryUsageAllowed`, per schema doc. |
| Codex sessions: adopt-only ids (`thread.started.thread_id`), `codex exec fork <id>` = the wipe, `turn.completed.usage` is CUMULATIVE thread total (rehydrated on resume/fork), exit codes 0/1 only, error text uses U+2019 (`You’ve`). | Codex adapter = OpenCode's adopt path + usage-baseline diff + text classifier. |
| `claude -p --input-format stream-json --output-format stream-json` = long-lived bidirectional chat; Windows stdin bug fixed in 2.1.211. Agent SDK on subscription is disallowed by Anthropic's docs; unmodified `claude` binary is the carve-out. | Planner chat = spawn stock `claude`, stream-json both ways. No SDK, no PTY required. |
| MCP is the only tool surface Claude Code, Codex and Gemini all speak. | Issue lint/file tools = one MCP server in the dashboard, shared by every provider and by the user's own terminal. |
| Harness choice swings cost 32× at equal quality (AA Coding Agent Index); run-to-run SD 2–6 pp; tests alone over-credit ~24 pp (METR). | Arena must be paired-by-task, ≥3 replicates, cost-per-merged-AC, and tests + rubric judge, never a single leaderboard number. |
| Policy: Anthropic permits an end user on the **unmodified** `claude` binary with their own sub; forbids token intermediation. OpenAI documents `codex exec` on a ChatGPT plan but steers automation to API keys; no per-plan concurrency limit; 429s reported above ~2–3 streams. | Provider records carry `automationStance`; Codex lane concurrency separately capped (default 2). Keep API-key lane available for both. |

---

## Repo 1: `study-hall` — architecture

npm workspaces monorepo, TS via `tsx` (no build step), Node ≥ 22.5 (for `node:sqlite`; machine has
24.15). Zero native deps. Windows-first.

```
study-hall/
  packages/
    harness/     @study-hall/harness  — the shared package the arena imports
    core/        pure engine modules (ported verbatim) + new orchestrator
    planner/     PLAN_ROLE, rubric-as-prompt, validators, MCP tool handlers
    dashboard/   http server (router, SSE, MCP mount) + webui/ (ES modules, no bundler)
    app/         launcher: run.cmd, install-scheduled-task.ps1, electron tray (optional)
  docs/          ISSUE-RUBRIC.md (single source, tested against the prompt constant), ADRs
```

### `@study-hall/harness` (the arena dependency)

Port `src/harness.ts` registry semantics verbatim (declared capabilities; unknown id throws; fidelity
derived from capability; `killAll` sweeps past throwers). Replace the leaky alias with a real
contract. Everything marked NEW is justified by a concrete gap in the dossiers.

```ts
// Provider = auth + quota. Harness = CLI adapter. Model = id + effort. Not orthogonal → resolve().
type MeterKind = 'subscription' | 'metered' | 'local' | 'unknown';
interface Provider { id: 'anthropic' | 'openai' | 'local' | string;
  credentialKind: 'oauth_subscription' | 'api_key' | 'none';
  automationStance: 'sanctioned' | 'gray' | 'prohibited';   // refuse prohibited pairs at construct time
  meter: MeterKind; quota?: QuotaMonitor; }

interface HarnessCapabilities {
  warmSessions: boolean; seedableSessions: boolean; forkSessions: boolean;        // #307 split kept
  cacheUsageSplit: boolean; usageIsCumulative: boolean;                            // NEW: Codex trap
  reportsCost: boolean; toolAllowlist: boolean; mcpToolAllowlist: boolean;
  effortControl: boolean; sandboxModes: Sandbox[]; promptTransport: 'stdin'|'argv';
  streamsUsage: boolean; cancellable: boolean; transcripts: boolean;
  chat: 'stream-json' | 'jsonrpc' | 'resume-loop' | 'none';                         // NEW: planner transport
}
interface HarnessRunOptions { cwd; model?; effort?: string; approval?: 'never'|'on-request';
  sandbox?: 'none'|'read-only'|'workspace-write'; tools?: string[];
  session?: { mode: 'new'|'resume'|'fork'; seed?: string; base?: string };         // Codex needs mode
  budget?: StudentBudget; idleTicks?: number; signal?: AbortSignal;
  transcriptSink?: (line: string) => void; onUsage?; onQuota?: (q: QuotaObservation) => void;
  extra?: Record<string, unknown>;   // per-harness escape hatch (Codex -c overrides, CODEX_HOME)
  spawnFn?; setIntervalFn?;          // test seams, kept — every test depends on them
}
interface HarnessRunResult { text; usage: Usage /*4 fields + reasoningTokens*/; sessionId; turns;
  stoppedBy?; transcriptPath?; costUsd?: number|null; meter: MeterKind; raw?: unknown;
  durationMs; apiDurationMs?; exitCode; }
interface FailureVerdict { kind: 'capacity'|'infra'|'auth'|'task'|'cancelled'; resetAt?: number; detail? }
interface Harness { id; provider: Provider['id']; capabilities;
  run(prompt, opts): Promise<HarnessRunResult>; killAll(): void;
  classifyFailure(msg, now?): FailureVerdict;         // absorbs capacityReset.ts + infraFailure.ts
  preflight(): Promise<{ok; bin; version?; authOk?; detail?}>;  // a real completion probe, not --version
  chat?(opts): ChatSession;                           // planner transport (see below)
}
```

Adapters:

- **`claude-code`** — port `cliStudent.ts` (NDJSON framer with partial-line carry, per-message-id
  usage dedup, tick-counted idle watchdog, budget-stop that RESOLVES and banks work) and
  `warmCliSession.ts` seed-then-fork state machine. Spawn `shell:false` at the resolved `.exe`
  (`claudeBin.ts` returns `{path, needsShell}`). Read `result.modelUsage` (subagent-inclusive),
  `num_turns`, `duration_ms`, `total_cost_usd`, `api_error_status`. On `rate_limit_event` publish
  `unifiedWindows` to the provider's `QuotaMonitor`. Tolerate unknown event types. Capacity trigger:
  `api_error_status===429` ‖ `rate_limit_info.status==='rejected'` ‖ (fallback) SDK
  `USAGE_LIMIT_ERROR_PREFIXES` strings. Reset from `resetsAt`, never from text. Model-family limits
  (`seven_day_opus/sonnet`) → tier fallback, not provider switch. Never `--bare` (drops OAuth).
- **`codex`** — argv per OpenAI's own SDK (`sdk/typescript/src/exec.ts`): prompt on stdin, `exec
  --json --skip-git-repo-check --cd <wt> -m <model> --sandbox workspace-write --ignore-user-config
  --ignore-rules --thread-source study-hall -c model_reasoning_effort=… -c approval_policy=never`;
  warm = seed once, adopt `thread.started.thread_id`, then `exec fork <base>` per task (never
  `resume` for tasks). Usage = `turn.completed.usage` minus stored baseline (cumulative trap).
  Reasoning tokens kept as their own column. `classifyFailure`: `/you[’']ve hit your usage limit|quota
  exceeded|exceeded retry limit, last status: 429|rate limit exceeded|selected model is at capacity/i`
  → capacity; `/access token could not be refreshed/` → **auth** (halt lane + alert, never retry);
  budget/context errors → task. Per-lane `CODEX_HOME` via `extra`. Concurrency cap default 2.
  `budgetStop` declared false until `features.rollout_budget` is trialed.
- **`opencode`** — port as-is (local/metered lane; fix O(n²) re-parse; add idle watchdog via the
  generic wrapper). Kept for the arena's zero-cost plumbing arm.
- Generic wrapper enforces idle watchdog + budget for any adapter with `streamsUsage`.

Quota monitors (`QuotaMonitor` per provider): `{ state: 'available'|'exhausted'|'unknown', fiveHour?,
sevenDay?, observedAt, source }`. Claude: fed by `rate_limit_event` from any student; probe = one
trivial run when stale. Codex: one long-lived `codex app-server` per engine, `initialize` once, poll
`account/rateLimits/read` every 60 s + merge `account/rateLimits/updated`; `ordinaryUsageAllowed`
is the exhausted/recovered gate; `null` = unknown. Dashboard shows **percent, reset time, and age
of observation** per window; a missing window renders `?`, never 0 %.

Ledger (`packages/harness/ledger`): `node:sqlite` DB `~/.study-hall/ledger.db` (WAL) + append-only
JSONL mirror (`runs.jsonl`, `outcomes.jsonl`) that never throws. Tables: `runs` (one row per
role-run: runId, startedAt, endedAt, durationMs, repo, item, role, tier, provider, harness,
harnessVersion, model, effort, meter, fidelity, input/output/cacheRead/cacheCreate/reasoning tokens,
turns, sessionId, seedSessionId, warmMechanism, worktree, branch, baseSha, promptSha256, toolAllowlist,
sandbox, stoppedBy, exitCode, errorClass, reportedCostUsd, estimatedCostUsd, pricingTableVersion,
transcriptPath), `outcomes` (runId/trialId → prNumber, prUrl, additions, deletions, changedFiles,
reviewVerdict, reviewRounds, ciConclusion, merged, mergedAt, outcome enum), `assignments` (ladder
events: exact/rerole/crossRepo/spawn/wait), `quota_observations`, `events` (structured engine log:
ts UTC, level, event, repo, item, action, reason). Cost stored at write time with a pricing-table
version; subscription vs metered never summed (separate columns, separate meters in every view).
Reader API: `listRuns(filter, page)`, `runDetail(id)`, `attribution(role×tier×provider)`,
`costPerMergedAC(repo, since)`, `transcript(id)` (streams the CLI's own JSONL by stored path).

### `core` — the engine

Port **verbatim** (zero-import pure modules, all with real tests): `protector.ts`, `classify.ts`,
`gates.ts`, `ownership.ts`, `throttle.ts`, `assignments.ts`, `watchdog.ts`, `parole.ts`,
`schedule.ts`, `tierFallback.ts`, `optimizer.ts`, `blackout.ts`, `emptyRun.ts`, `ciFailure.ts`,
`reportLifecycle.ts`, `testRun.ts`, `drain.ts`, `managedProcess.ts`, the key helpers of
`repoState.ts` (`owner/name#7`, `owner/name:pr-12`, `KIND:owner/name:pr-12` — keep exactly),
`issueAudit.ts`, `triage.ts`, `buildability.ts`, `difficultyRubric.ts`, `difficulty.ts`,
`github.ts` (fix `parseDeps`), `roles.ts` prompts (byte-stable constants), `prompts.ts`.

Re-cut `live.ts` into five units, repo passed explicitly everywhere (delete the `this.rs` cursor):
`BoardCycle` (fetch → classify → fairShare → decide; pure over an injected GitHub port; the tick is a
function of (snapshot, state, clock) → decisions), `RoleRunner` (ONE parameterised runner replacing
runTask/runReview/runFix/runResolve/runTriage), `Governance` (watchdog/quarantine/parole/capacity/
blackout/throttle; returns decisions), `Persistence` (ledger + per-repo files; every save takes its
RepoState), `Reporting`. `repo` becomes a typed field on `BoardAction`.

New behaviours: (1) **warm sessions wired into dispatch** — each Protector worker owns a
`WarmSlot` (seed/adopt/fork) and a persistent worktree; the ladder finally measures real warmth;
(2) **provider selection** — `resolveProvider(surface, cfg, quotas)`: `'anthropic' | 'openai' | 'auto'`,
`auto` = ordered failover list; Claude hands over at a configurable predicted-headroom threshold
(default 90 % of five_hour), Codex on `ordinaryUsageAllowed===false`; a provider in `unknown` gets
one probe task before the board commits; (3) structured JSONL events as the primary log (UTC `Z`),
human log derived; (4) bounded runs by default (`testRun` shape: finish N PRs then park) — unbounded
requires an explicit flag; (5) preflight = a real trivial completion per provider at boot and after
every capacity pause (a `--version` passes with an expired token); (6) generic crash-burst standdown
(N same-signature failures in M minutes) replacing the fixed 22:00 blackout (kept as operator
override); (7) one process, N boards, one governor per provider; (8) tests: no source-regex text locks;
no GitHub Actions (memory rule) — `npm test` runs locally on Windows, the real target, including a process-tree kill/orphan integration test.

### `planner`

- `PLAN_ROLE` — new byte-stable constant assembled from `TRIAGE_ROLE` (split bar, `Owns:` rule),
  `EDITOR_ROLE` body shape, `DIFFICULTY_RUBRIC`, and `ISSUE_RUBRIC_PROMPT` (loaded from
  `docs/ISSUE-RUBRIC.md` at startup with a drift test). Not in `ROLE_PROMPTS`; planning is
  upstream of the board.
- **Fix the rubric contradictions first** (cheap, unblocks everything): `parseDeps` accepts
  `Depends on:? #N(, #M)*`; audit + triage gates raised to `maxCriteria: 7` to match the rubric and
  the 7+ tiering band; vague-phrase ban enforced as a lint warning; `editor-proposed` and
  `context-card` added to `PIPELINE_LABELS`.
- Validators run on the DRAFT: `auditBody(body)`, `needsTriage`, `assessAdmission`,
  `expectedDifficulty` (user may raise, never lower), duplicate title check, dependency order.
- **MCP server** mounted at `http://127.0.0.1:<port>/mcp` (streamable HTTP, `@modelcontextprotocol/sdk`,
  loopback only, shared secret header): tools `lint_issue`, `find_duplicate_issue`, `list_labels`,
  `list_open_issues`, `propose_issues` (stage a batch), `file_issues` (files in topological order,
  substitutes real numbers into dependants, dedupes via a durable ledger keyed by idempotency key,
  appends `<!-- planner-key: … -->`, labels `triaged` + difficulty at birth, `needs-human` when blocked).
  The model **proposes; the orchestrator files** (Editor's proven seam). Registered for Claude Code
  (`.mcp.json` / `--mcp-config`) and Codex (`~/.codex/config.toml [mcp_servers.plan]`).
- **Chat transport** (`ChatSession` behind `harness.chat()`): Claude = one long-lived stock
  `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages
  --replay-user-messages --session-id <uuid> --permission-mode default --tools <read-only set>
  --mcp-config <plan> --append-system-prompt <PLAN_ROLE>`; fixed cwd for the conversation (cache is
  per-directory); `idleTicks: 0`; budget advisory only; session id persisted so a dashboard restart
  resumes via per-turn `--resume` (fallback transport, same parser). Codex = `codex app-server`
  JSON-RPC `thread/start` → `turn/start` / `turn/steer` / `turn/interrupt`, `item/agentMessage/delta`.
  Both emit one normalised event union `{text | toolCall | toolResult | turnDone | usage | quota}`;
  the UI never branches on provider.
- **"Open in a real terminal"** button: spawn a detached console (`cmd /c start … claude …` — the
  `ghLoginStart` precedent) running the interactive CLI with the planner skill and the same MCP
  server, for users who want the true TUI. Filing still goes through `file_issues`.
- Skill `/plan-feature` (Claude Code `SKILL.md`) and a Codex skill with the same text, so the persona
  is authored once.

### `dashboard`

Node `http` server, new router (method + path + parsed query, path params), handlers may own the
response (SSE), explicit 404 naming stale-process cause kept. Port single source of truth: 4800
(v1 keeps 4700). Tabs (ES modules, one file per tab, JSDoc-typed, no bundler):

| Tab | Content |
|---|---|
| Overview | Per-provider quota bars (5h / 7d, reset, observation age), provider toggle (global default + per-tab override, persisted in config), engine state, bounded-run control, drain/stop. |
| Boards | Per-repo board, parked items with one-click unpark, deadlocks. Task map read-only (derived cache, honestly labelled). |
| Pool | Live students: provider, harness, model, role, warm/cold, tokens, cache-hit, current item. Ladder tallies from the ledger (survive restarts). |
| Runs | Paged history from the ledger: filters (repo, provider, harness, role, outcome, date); run detail (tokens split, cost columns per meter, PR, review rounds, CI, session id, prompt hash); transcript viewer streaming the stored JSONL; cost-per-merged-AC per repo/provider. |
| Planner | Chat pane (rendered stream events, tool calls, live typing via SSE), staged drafts with lint verdicts + computed labels + dependency order, "File N issues" confirm, "Open in terminal". Provider toggle. |
| Editor / Admissions | Ported later (phase 6); same provider toggle. |
| Arena | Renders the arena's exported report envelope (versioned schema, read-only). |
| Settings | Repos, pool sizes per provider, failover order/threshold, Codex concurrency, budgets, paths. |

### `app` — durability

Ship `install-scheduled-task.ps1` (logon-triggered, runs as user, no execution-time limit) as THE
install path — it is the only method that survived console teardown (WMI failed twice; tool-launched
processes die at session boundaries). Launcher keeps the earned scars: netstat single-instance guard,
capped restart loop, the three teardown exit codes that must not restart (`0xC000026B`, `0xC0000142`,
`0x40010004`), `ping`-as-sleep, vendored `tsx` spawn (never `npx`), CRLF-pinned `.cmd`. Electron tray
is optional and bumps to ≥ 35 (Node 22 ABI) only if packaged.

---

## Repo 2: `study-arena`

Depends on `@study-hall/harness` (git dependency, pinned tag) so adapters, ledger, quota and failure
classification are byte-identical to production. Answers one question: *for these repos' issue
shapes, which (provider, harness, model) resolves the most acceptance criteria per unit of spend at
acceptable review quality?*

- **Corpus** — frozen replay of merged issues from `Pat201492/dungeonworks` (120 merged PRs, 112
  issue-linked, pytest, `-m 'not llm and not bench'` default) + a 5-item synthetic calibration set
  with a test oracle. Per item: `baseSha` (merge commit's first parent), frozen body + sha256, frozen
  `acCount` (same counter as the engine, version-stamped), reference diff (never an oracle),
  FAIL_TO_PASS/PASS_TO_PASS node ids where the PR added tests. Validate the corpus by running the
  oracle (merge commit) and an empty patch through the grader first. Stratify by AC band.
- **Design** — paired by task; cell = 12 items × 3 replicates (cut replicates before items, never
  below 2); arms = (provider × harness × model rung × warm/cold); smoke (4×1) → ranking (12×3) →
  finalists (top-2, ×5). Pre-registered manifest (items, hashes, formulas, cell size, stopping rule,
  declared asymmetries) committed before trial 1.
- **Isolation** — one reference clone; `git worktree add --detach <baseSha>` per trial; per-trial
  port offset + data dir; concurrency pinned and recorded; never runs while the production board is
  dispatching on the same account (quota is account-wide).
- **Grading** — (i) hard gate: non-empty diff, tests green at base + branch; (ii) oracle where it
  exists (F2P ∧ P2P); (iii) rubric LLM judge per frozen AC, blinded, harness strings stripped, judge
  model from a different family than either generator, both orderings; (iv) 20 % human audit,
  report Cohen's κ. Accepted = (i) ∧ (ii) ∧ all ACs satisfied.
- **Metrics** — primary `$ / merged AC` per (harness × meter × fidelity) cell, exact-fidelity rows
  only, numerator = every role-run incl. abandoned; `plan-tokens / merged AC` (all fidelities);
  accept rate, rework multiplier, first-pass rate; minutes/AC; wasted-spend fraction; Pass@1 / Pass@3
  / Pass^3. Report median + IQR + bootstrap 95 % CI on paired within-item ratios; a CI straddling 1
  reads "no detectable difference — pick on cost". Never one leaderboard number; a (harness × meter)
  matrix.
- **Budget** — per-trial caps (`--max-budget-usd`/`--max-turns` on Claude; runner-side kill on
  parsed tokens for Codex); projected spend printed and gated before launch; spend ledger after every
  run; `budget_exhausted`/`usage_limit` are distinct outcomes excluded from denominators;
  `autoContinueAtUsageLimit` off.
- **Output** — versioned export envelope (`study-arena/export/v1`, `--json`, stdout payload only,
  null = never run) consumed by the dashboard's Arena tab; markdown verdict per experiment.
- **Sequencing** — build and validate all plumbing on the OpenCode + Ollama arm (zero cost), then the
  `claude-code` control arm (re-measure; treat $2.72 only as a sanity band), then Codex when a
  ChatGPT subscription exists (Codex is bundled in the ChatGPT free tier — enough for adapter smoke
  tests, not for a full sweep).

---

## Phases

Each phase ends green (`npm run typecheck && npm test` locally on Windows) and independently useful.

### Phase 0 — Spikes and prerequisites (before any architecture is frozen)
1. Snapshot v1 transcripts now: set `cleanupPeriodDays` high in `~/.claude/settings.json` and copy
   `~/.claude/projects/*dungeonworks*` + `*equipworks*` to `~/.study-hall/archive/`. (Every day loses
   baseline data.)
2. Upgrade Claude Code on PATH to ≥ 2.1.270 (2.1.211 stdin fix, 2.1.268 `unifiedWindows`). Record
   the resolved path + version at engine boot forever after.
3. Live trials (each one cheap turn; results go in `docs/ADR-000-spikes.md`): (a) does
   `-p --input-format stream-json` stay alive and answer a second user message; (b) is
   `unifiedWindows` populated for this account under `-p`; (c) `--tools` still accepted; (d) is
   `{"type":"interrupt"}` honoured (feature-detect via `system/init.capabilities`).
4. Install Codex CLI 0.154.0 (pin; `check_for_update_on_startup=false`), `codex login --device-auth`
   with the free ChatGPT tier; trial: `exec --json` event shapes, fork/resume, cumulative-usage diff
   (run → resume → compare), `app-server` `initialize` + `account/rateLimits/read`, real
   `--help` for `--full-auto` / `--ask-for-approval` absence, Windows sandbox setup.
5. Confirm `node:sqlite` on Node 24; decide Electron bump (≥ 35) only if packaging is wanted.

### Phase 1 — Repo scaffold + `@study-hall/harness`
Workspaces, local test runner, ADR template (no CI workflows). Harness contract; providers with `automationStance`; adapters
`claude-code` (ported runner + warm slot), `codex`, `opencode`; generic idle/budget wrapper; quota
monitors; ledger (sqlite + jsonl) with reader API; failure classifiers per harness incl. `auth`.
Tests ported: `harness.test.ts` byte-identical-argv technique, `adoptSession.test.ts` six cases (now
run against claude-code, codex, opencode doubles), `cliStudent.test.ts`, `usageStore.test.ts`, new
Codex JSONL fixtures (captured in Phase 0), quota state-machine tests, ledger query tests.

### Phase 2 — Engine port
Pure modules copied with their tests; `BoardCycle`/`RoleRunner`/`Governance`/`Persistence`/
`Reporting`; warm slots wired; provider resolution + failover; structured events; bounded default;
preflight completion probe; crash-burst standdown; state-dir migration (one canonical
`owner-name` dir; reads legacy `attempts/lifetime/handled/quarantine.json`). Verification: a fake
GitHub port + fake harnesses drive a 3-tick scenario test (dispatch → PR → review → merge) and a
failover scenario (Claude exhausted → Codex → recovered).

### Phase 3 — Dashboard core
Router + SSE + config; Overview, Boards, Pool, Runs, Settings tabs; quota bars with age; provider
toggle plumbing (global + per-tab, persisted); scheduled-task installer + launcher. Verification:
HTTP tests against a started server (no source-regex tests); manual: bounded run of N=2 on a
scratch repo with `claude-code` only.

### Phase 4 — Planner
Rubric fixes + drift test; `PLAN_ROLE`; validators; MCP server + tools + client registration for
Claude/Codex; `ChatSession` for Claude (stream-json) and Codex (app-server); Planner tab; "open in
terminal"; `/plan-feature` skill. Verification: plan a real feature end-to-end on a scratch repo →
lint verdicts shown → filed in dependency order → `parseDeps` sees every dep → engine ingests them as
`triaged` with correct difficulty; repeat with the Codex provider; restart the dashboard mid-chat and
resume.

### Phase 5 — Arena
Corpus builder (gh + pytest extraction, oracle validation), runner, graders, stats/report, export
envelope; smoke on OpenCode/Ollama; control arm on `claude-code`; verdict doc. Verification: oracle
scores 100 % and empty patch 0 % on every item; a full 4×1 smoke completes under the printed
projected spend; report renders in the Arena tab.

### Phase 6 — Cutover
Editor/Admissions ported behind the provider toggle; run v2 bounded on one board (equipworks) while
v1 keeps the other; compare ledger vs v1 outcomes for a week; migrate config; stop v1 only on the
user's explicit go (memory rule). Archive v1 with a final `docs/REVIEW` linking the dossiers.

---

## Verification (end-to-end)

- `npm test` + `npm run typecheck` in both repos locally on Windows; process-tree test
  proves no orphaned `claude.exe`/`codex.exe` after stop.
- Quota: with the pool idle, the Overview shows both providers' windows with an age < 2 min after one
  probe; kill Codex login → Codex lane shows `unknown` then `auth` halt with alert, Claude lane
  unaffected.
- Failover: set Claude threshold to 1 % → dispatch moves to Codex; reset threshold → moves back after
  the next observation; every switch is an `events` row and a Runs filter.
- Memory: kill the engine mid-run; restart; Runs tab still lists the partial run with `stoppedBy`,
  its transcript opens, attribution tiles unchanged.
- Planner: rubric drift test fails if `docs/ISSUE-RUBRIC.md` and the prompt constant diverge; a draft
  with `Depends on: #12, #13` files with both deps visible to the engine.
- Arena: pre-registered manifest hash matches the report; paired CI reported; the OpenCode arm runs
  the full protocol at $0 before any subscription token is spent.

## Known unknowns needing a live trial (Phase 0)
Stream-json stdin longevity; `unifiedWindows` presence for this account; Codex cumulative-usage
semantics on fork; `features.rollout_budget` reachability; Codex concurrency ceiling on a real plan;
whether `account/rateLimits/read` needs `experimentalApi`; Anthropic Agent-SDK-credit pool status
(paused 2026-06-15 — re-check before cutover).

## Out of scope
Modifying or restarting v1; Gemini/Antigravity (no compliant headless path today); Amp (WSL-only);
Docker isolation on Windows (worktrees + per-trial ports suffice at this scale); a hosted/multi-user
version (policy forbids intermediating subscription auth).
