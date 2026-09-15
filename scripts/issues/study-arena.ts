import type { IssueDraft } from '@study-hall/planner';

// study-arena as issue drafts. Design: study-hall/docs/PLAN.md § "Repo 2" and
// the arena contract in study-hall/docs/research/fills.json (gap 3).

const ref = 'Design: `study-hall/docs/PLAN.md` § "Repo 2: study-arena"; research: `study-hall/docs/research/research-arena-prior-art.json` and the arena contract in `fills.json`.';

export const drafts: IssueDraft[] = [
  {
    key: 'arena-scaffold',
    title: 'scaffold: study-arena consumes @study-hall/harness, versioned export envelope v1',
    difficulty: 'standard',
    body: `## Goal
A repo that runs the same adapters, ledger and quota monitors as production, and publishes results through a versioned contract the dashboard can render without reading this repo's internals.

## Scope
- Node ≥ 22.5, tsx, \`@study-hall/harness\` as a git dependency pinned to a tag.
- \`src/export.ts\`: \`EXPORT_SCHEMA = 'study-arena/export/v1'\`, \`--json\` CLI where stdout is the payload and stderr is progress, sections null when never run, exit codes 0/1/2 (the app-testing-agent contract).
- \`docs/INTEGRATION.md\` written so a consumer can be built from it alone.
${ref}

## Acceptance
- [ ] \`npm test\` runs a test that pins \`EXPORT_SCHEMA\` so a bump is deliberate.
- [ ] \`node --import tsx src/cli.ts export --json\` prints one JSON object with \`schema\`, \`generatedAt\`, \`sections\` and null section bodies on a fresh checkout.
- [ ] The harness package resolves and \`registerBuiltins()\` succeeds from this repo.`,
  },
  {
    key: 'arena-corpus-builder',
    title: 'corpus: frozen replay items from dungeonworks merged PRs with FAIL_TO_PASS / PASS_TO_PASS',
    difficulty: 'hard',
    dependsOn: ['arena-scaffold'],
    body: `## Goal
Turn the repo's own merged history into a frozen benchmark: real issues, pinned starting states, frozen criteria counts, and a test oracle where the PR added tests.

## Scope
- \`src/corpus/build.ts\`: for each merged PR with a \`closingIssuesReferences\` link, record \`baseSha\` (merge commit's first parent), the issue title/body with sha256, \`acCount\` from the engine's own counter (version-stamped), the reference diff, and the test node ids the PR added.
- Derive FAIL_TO_PASS by checking out base, applying only the PR's \`tests/**\`, running pytest; PASS_TO_PASS is the default green suite at base (\`-m 'not llm and not bench'\`).
- Stratify by AC band (≤2 / 3–6 / 7+); manifest written to \`corpus/<name>.json\` with a sha256 of itself.
${ref}

## Acceptance
- [ ] The builder produces at least 12 valid items from dungeonworks and reports how many candidates were discarded and why.
- [ ] Every item's \`acCount\` and body sha are frozen in the manifest and never recomputed at report time.
- [ ] Items whose added tests carry the \`llm\` or \`bench\` markers are excluded.
- [ ] The manifest is deterministic: two builds from the same GitHub state produce identical files.`,
  },
  {
    key: 'arena-corpus-validation',
    title: 'corpus: validate every item — the oracle scores 100 %, an empty patch scores 0 %',
    difficulty: 'standard',
    dependsOn: ['arena-corpus-builder'],
    body: `## Goal
A broken task is not a hard task. Before any lane spends a token, prove each item is solvable by its own merged patch and unsolvable by doing nothing (the ABC task-validity check).

## Scope
- \`src/corpus/validate.ts\`: for each item, check out base in a worktree, apply the reference diff, run FAIL_TO_PASS + PASS_TO_PASS; then run the same with no patch.
${ref}

## Acceptance
- [ ] Validation marks an item invalid when the oracle fails any FAIL_TO_PASS or PASS_TO_PASS test.
- [ ] Validation marks an item invalid when the empty patch passes FAIL_TO_PASS.
- [ ] The report lists valid/invalid counts per AC band and the manifest gains a \`validatedAt\` stamp.`,
  },
  {
    key: 'arena-trial-runner',
    title: 'runner: one trial = worktree at baseSha, pinned ports and env, budget caps, spend ledger',
    difficulty: 'hard',
    dependsOn: ['arena-scaffold'],
    body: `## Goal
Run one (item × lane × replicate) in isolation with the same harness code production uses, and record everything the metrics need.

## Scope
- \`src/run/trial.ts\`: detached worktree at \`baseSha\`, per-trial port offset and data dir injected via env, prompt = role prefix + frozen body only (sha256 recorded), tool allowlist per lane recorded with \`toolAllowlistEnforced\`, warm/cold as an explicit factor (seed then fork vs fresh session).
- Per-trial caps: Claude \`--max-budget-usd\`/\`--max-turns\`; Codex runner-side kill on parsed tokens; \`budget_exhausted\` and \`usage_limit\` are distinct outcomes.
- Every trial appends a ledger row (\`@study-hall/harness\` ledger with trialId/arm/replicate) and a line to \`results/spend.jsonl\` so an interrupted sweep resumes.
- Projected spend printed and gated before a sweep starts; refuses to run while a production engine is dispatching on the same account.
${ref}

## Acceptance
- [ ] A trial on the OpenCode + Ollama lane completes end to end at $0 and writes a ledger row with \`meter: local\`.
- [ ] Two trials of the same item start from byte-identical trees (a test diffs the worktrees).
- [ ] A trial that hits its cap records \`budget_exhausted\`, not a failure, and the worktree is removed.
- [ ] Re-running a sweep skips trials already in \`spend.jsonl\`.
- [ ] Starting a sweep with projected spend above the configured ceiling is refused with the projection printed.`,
  },
  {
    key: 'arena-graders',
    title: 'graders: hard gate + test oracle + blinded rubric LLM judge + human audit sample',
    difficulty: 'hard',
    dependsOn: ['arena-trial-runner', 'arena-corpus-validation'],
    body: `## Goal
Tests alone over-credit patches by about 24 points (METR). Grade on three tiers and measure the judge against a human sample so the verdict is falsifiable.

## Scope
- Tier 1 hard gate: non-empty diff, PASS_TO_PASS green. Tier 2 oracle: FAIL_TO_PASS green where it exists. Tier 3: an LLM judge scoring each frozen acceptance criterion satisfied/not from issue text + diff, lane names and harness-branded strings stripped, both orderings for pairwise, judge model from a different family than the generator.
- 20 % random human audit; report Cohen's κ; κ below 0.7 invalidates the sweep.
${ref}

## Acceptance
- [ ] A trial is \`accepted\` only when tiers 1 and 2 pass and every frozen criterion is judged satisfied.
- [ ] The judge prompt and model are recorded on every graded row (promptSha256, judgeModel).
- [ ] Pairwise judging runs both orderings and records disagreement between them.
- [ ] The audit sample is drawn with a recorded seed and its κ appears in the report.`,
  },
  {
    key: 'arena-metrics-stats',
    title: 'metrics: $/merged AC per (harness × meter × fidelity), tokens/AC, acceptance, Pass@k / Pass^k, paired bootstrap CI',
    difficulty: 'hard',
    dependsOn: ['arena-graders'],
    body: `## Goal
The numbers that decide which lane the engine should use, computed the way the baseline was built and never pooled across incomparable meters.

## Scope
- \`src/stats/metrics.ts\`: primary \`usdPerMergedAC\` (exact-fidelity rows only; numerator = every role-run for accepted items incl. abandoned attempts; denominator = sum of frozen acCounts), \`tokensPerMergedAC\` (all fidelities), acceptance rate, rework multiplier, first-pass rate, minutes/AC, wasted-spend fraction, Pass@1 / Pass@3 / Pass^3.
- \`src/stats/paired.ts\`: within-item ratios between two lanes, bootstrap over items (10 000 resamples) for a 95 % CI on the median ratio, cluster by item across replicates.
- Subscription, metered and local meters are separate columns; a test asserts they are never summed.
${ref}

## Acceptance
- [ ] Hand-checkable fixtures (two items with 3 and 5 criteria, one abandoned attempt, one partial-fidelity row) produce the expected \`usdPerMergedAC\` and \`tokensPerMergedAC\`.
- [ ] The paired CI for identical lanes straddles 1.0; for a lane whose costs are doubled it excludes 1.0.
- [ ] A report renders the (harness × meter) matrix, never a single leaderboard number.
- [ ] Pass^3 is computed from independent replicates, not from test counts within one trial.`,
  },
  {
    key: 'arena-report-and-dashboard-tab',
    title: 'report: pre-registered manifest, markdown verdict, export envelope, Arena tab in study-hall',
    difficulty: 'standard',
    dependsOn: ['arena-metrics-stats'],
    body: `## Goal
A sweep is only worth running if its verdict is falsifiable: the design is committed before trial one and the result is readable in the dashboard.

## Scope
- \`src/preregister.ts\`: manifest with item ids and shas, frozen acCounts, formulas, cell size (12 × 3), stopping rule, declared asymmetries (meter kind, fidelity, reasoning tokens, price tables, tier equivalence, home-turf prompting, contamination, tool surface, warm mechanism); committed and hashed before the sweep.
- \`export\` section \`sweeps\` with per-lane metrics, CIs and the verdict; \`docs/VERDICT-<sweep>.md\`.
- study-hall Arena tab renders the envelope (schema-checked, both versions named on mismatch).
${ref}

## Acceptance
- [ ] A sweep refuses to start unless the manifest hash is committed.
- [ ] The export envelope validates against \`EXPORT_SCHEMA\` and the study-hall Arena tab renders its matrix and CIs.
- [ ] The markdown verdict states sample sizes, the date range, both meters, and one of keep / widen / revert.`,
  },
  {
    key: 'arena-smoke-opencode',
    title: 'sweep: 4 × 1 smoke on the OpenCode + Ollama arm at $0',
    difficulty: 'standard',
    dependsOn: ['arena-trial-runner', 'arena-corpus-validation'],
    body: `## Goal
Debug the whole pipeline (corpus, isolation, grading, ledger, report) on the arm that costs nothing before a single subscription token is spent.

## Scope
- Four validated items, one replicate, OpenCode with \`ollama/qwen2.5-coder:7b\` (num_ctx ≥ 16384), full grading, report rendered.
${ref}

## Acceptance
- [ ] All four trials complete with ledger rows of \`meter: local\` and \`fidelity: exact\`.
- [ ] The report renders with zero-dollar cost columns and non-zero token columns.
- [ ] Every defect found is filed as an issue on this repo before the paid arms run.`,
  },
  {
    key: 'arena-control-arm-claude',
    title: 'sweep: claude-code control arm, 12 items × 3 replicates, paired, cold and warm',
    difficulty: 'standard',
    dependsOn: ['arena-smoke-opencode', 'arena-report-and-dashboard-tab'],
    body: `## Goal
Re-measure the control arm under the new record instead of trusting the unreproducible $2.72/AC figure (implement-only, 65 % of its transcripts already expired).

## Scope
- 12 stratified items × 3 replicates on \`claude-code\`, cold and warm as separate arms, sonnet and opus rungs; scheduled in a window where the production board is parked.
- Treat $2.72 (IQR $1.64–$3.70) only as a sanity band.
${ref}

## Acceptance
- [ ] 72 trials recorded with the pre-registered manifest hash.
- [ ] The verdict reports median $/merged AC with IQR and the cold-vs-warm paired ratio with its CI.
- [ ] The weekly Claude window consumed by the sweep is recorded from the quota observations before and after.`,
  },
  {
    key: 'arena-codex-arm',
    title: 'sweep: Codex arm once a paid ChatGPT plan exists',
    difficulty: 'standard',
    dependsOn: ['arena-control-arm-claude'],
    body: `## Goal
The comparison the arena exists for: the same 12 items on the Codex lane, paired against the control arm.

## Scope
- Requires a paid ChatGPT plan (the free tier is enough for adapter smoke only). Model rungs mapped as declared in \`study-hall\` config; concurrency pinned to 2.
${ref}

## Acceptance
- [ ] 36 Codex trials paired with the control arm's items and replicates.
- [ ] The report's (harness × meter) matrix shows subscription meters side by side and never summed.
- [ ] The verdict names keep / widen / revert for the Codex lane in the engine's failover order.`,
  },
];
