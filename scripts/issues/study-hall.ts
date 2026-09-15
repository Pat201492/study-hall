import type { IssueDraft } from '@study-hall/planner';

// The remaining study-hall work as rubric-compliant issue drafts, filed through
// the planner's own fileBatch (dependencies first, real numbers substituted,
// labels at birth). Design references: docs/PLAN.md, docs/adr/ADR-003.

const ref = 'Design: `docs/adr/ADR-003-engine-orchestrator.md`; v1 reference `claude-study-room/src/live.ts`.';

export const drafts: IssueDraft[] = [
  {
    key: 'engine-board-cycle',
    title: 'engine: typed repo on BoardAction and the pure boardCycle.decide()',
    difficulty: 'hard',
    owns: ['packages/core/src/engine/boardCycle.ts', 'packages/core/src/classify.ts'],
    body: `## Goal
Make the heartbeat's decision step a pure function of (board snapshot, engine state, clock) so it is unit-testable and every dispatch carries the provider that will run it.

## Scope
- Add \`repo: string\` as a typed field on \`BoardAction\` in \`packages/core/src/classify.ts\` (v1 stamped it by cast at live.ts:1167 and read it back by cast at :1531 — every multi-repo key bug came from that).
- New \`packages/core/src/engine/boardCycle.ts\` exporting \`decide(input): Decision[]\` composed from \`classify\`, \`fairShare\`, \`selectProvider\`, \`tierForDifficulty\`/\`effectiveTier\` and \`modelFor\`.
- Decision kinds: dispatch (action + role + tier + provider + harness + model + reason), probe (provider in UNKNOWN), hold (blackout, capacity pause, contested board, bounded run spent).
${ref}

## Acceptance
- [ ] \`BoardAction.repo\` is a required typed field; no \`as unknown as BoardAction\` remains in core.
- [ ] \`decide()\` imports nothing impure (no fs, no child_process, no gh, no clock reads).
- [ ] A scenario test drives three ticks over fixture boards: an open issue becomes an IMPLEMENT decision, a PR with \`reviewed-ok\` becomes MERGE, a parked issue yields nothing.
- [ ] A failover test: Claude quota \`exhausted\` routes the same action to Codex; Claude \`available\` again routes it back.
- [ ] A provider in \`unknown\` yields a probe decision before any dispatch commits to it.
- [ ] Per-provider concurrency caps and the global throttle limit bound the number of dispatch decisions per tick.`,
  },
  {
    key: 'engine-governance',
    title: 'engine: governance module — watchdog, parole, capacity, blackout, throttle, crash-burst, halted lanes',
    difficulty: 'standard',
    owns: ['packages/core/src/engine/governance.ts'],
    body: `## Goal
Gather every "should we dispatch at all" rule into one pure module that takes observations and returns verdicts, so the ladders v1 earned from priced incidents survive the re-cut intact.

## Scope
- \`packages/core/src/engine/governance.ts\` wrapping the ported \`Watchdog\`, \`parole\`, \`blackout\`, \`throttle\`, \`infraFailure\` pause math, \`reportLifecycle\` and \`testRun\` (bounded run).
- New: crash-burst standdown from \`config.crashBurst\` (N same-signature failures within M minutes) replacing the fixed 22:00 window; a \`halted\` map per provider for auth failures; per-provider in-flight counts.
- Capacity reset comes from a harness \`FailureVerdict.resetAt\`, never from regexing English.
${ref}

## Acceptance
- [ ] A capacity verdict forgives the item's attempt AND lifetime unit (v1 \`forgiveAttempt\`) and pauses that provider until \`resetAt\` plus margin.
- [ ] An auth verdict halts that provider's lane with a reason and does not retry; other providers keep dispatching.
- [ ] Five infra failures sharing a signature within ten minutes trigger the standdown; a sixth different signature does not extend it.
- [ ] The blackout window, parole release and the oscillation/lifetime caps behave exactly as their ported unit tests already assert (those tests keep passing unchanged).
- [ ] Every verdict is a plain object the engine can log as a ledger event (no side effects inside governance).`,
  },
  {
    key: 'engine-persistence',
    title: 'engine: persistence — canonical per-repo state dir, engine-wide status.json, legacy v1 read-on-boot',
    difficulty: 'standard',
    owns: ['packages/core/src/engine/persistence.ts', 'packages/core/src/repoStateIo.ts'],
    body: `## Goal
One canonical place per repo for handled/quarantine/attempts/lifetime state, one engine-wide status snapshot for the dashboard, and a painless first boot next to an existing v1 install.

## Scope
- \`packages/core/src/engine/persistence.ts\`: every save takes the \`RepoState\` it writes (v1 \`saveHandled\`/\`parkSpecChanged\` wrote the PRIMARY repo's file for any board).
- State root \`<stateDir>/repos/<owner-name>/\` (one form; v1 had two naming generations).
- \`status.json\` at \`<stateDir>/status.json\` covering every board (v1 filed an aggregate under one repo's dir).
- On first boot, read v1's \`~/.claude-study-room/https---github.com-<owner>-<name>/{attempts,lifetime,handled,quarantine}.json\` when present so counters carry over.
${ref}

## Acceptance
- [ ] Saving a secondary repo's handled set writes that repo's file and never the primary's (regression test with two repos).
- [ ] \`status.json\` is written once per tick at the state root and contains every configured repo.
- [ ] A fresh state dir next to a v1 install imports the four legacy files for a repo and logs what it imported.
- [ ] Attempts and lifetime stay separate files (a widened attempts file must not drop the ceiling for an older reader).`,
  },
  {
    key: 'engine-role-runner',
    title: 'engine: one parameterised RoleRunner with warm slots and full ledger rows',
    difficulty: 'hard',
    dependsOn: ['engine-board-cycle', 'engine-governance', 'engine-persistence'],
    owns: ['packages/core/src/engine/roleRunner.ts'],
    body: `## Goal
Replace v1's four copy-pasted role runners (runTask/runReview/runFix/runResolve, which drifted) with ONE runner whose steps are parameterised by role, and finally wire the warm pool into dispatch.

## Scope
- \`packages/core/src/engine/roleRunner.ts\`: prepareWorktree → buildPrompt (prompts.ts, spec via readSpec, never re-send CLAUDE.md) → run on the worker's \`WarmSlot\` → effect → record → cleanup.
- Each Protector worker owns a \`WarmSlot\` from \`@study-hall/harness\` (seed/adopt/fork per harness capabilities); Codex runs pass \`extra.usageBaseline\`.
- Run options from the provider pool: model, effort (\`effortFor\`), approval/sandbox, tools, budget, \`transcriptSink\` to \`<stateDir>/transcripts/<runId>.jsonl\`, \`onUsage\`, \`onQuota\`, abort signal.
- The implement effect only in this issue (commit → push → PR; empty diff → \`classifyEmptyRun\`); other effects are follow-ups.
${ref}

## Acceptance
- [ ] A fake harness records that the second task on a worker ran with \`session.mode === 'fork'\` off the first task's base (warm), on both a seedable and an adopt-only harness.
- [ ] The ledger row for a run carries runId (minted at dispatch), startedAt/endedAt, provider, harness, model, effort, warmMechanism, worktree, branch, baseSha, promptSha256, toolAllowlist, sandbox, approval, transcriptPath and both cost columns.
- [ ] An implement run with a non-empty diff commits, pushes, opens a PR and records a \`pr-opened\` outcome; an empty diff whose text says every criterion is DONE parks the issue as \`already-satisfied\`.
- [ ] A budget or cancel stop still commits and pushes the partial work (resolve-not-reject preserved).
- [ ] The worktree is removed and the worker freed on success, failure and cancel (finally path tested).`,
  },
  {
    key: 'engine-failure-routing',
    title: 'engine: failure routing — capacity, infra, auth, task, cancelled',
    difficulty: 'standard',
    dependsOn: ['engine-role-runner'],
    body: `## Goal
Every failed run is classified by its harness and routed to the right consequence, so an outage is never charged to an item and an expired login never loops.

## Scope
- In the runner's catch path call \`harness.classifyFailure(message)\` and route: capacity → \`provider.quota.markExhausted(resetAt)\` + governance forgive; infra → infra streak; auth → halt lane + alert event; task → watchdog attempt; cancelled → bank partial, no attempt charged.
- Log one ledger event per verdict with the provider, item and detail.
${ref}

## Acceptance
- [ ] A Claude "You've hit your session limit · resets 4:40am" failure pauses the anthropic lane until the parsed reset and charges no attempt.
- [ ] A Codex "You’ve hit your usage limit" (U+2019) failure does the same for the openai lane.
- [ ] A Codex "access token could not be refreshed" failure halts the openai lane with the message and never re-dispatches until the operator clears it.
- [ ] A "returned no JSON result" failure increments the infra streak and, at the configured count, pauses dispatch with escalating backoff.
- [ ] An ordinary task failure charges exactly one attempt to the item's key.`,
  },
  {
    key: 'engine-review-fix-effects',
    title: 'engine: review, fix and rewrite effects on the RoleRunner',
    difficulty: 'standard',
    dependsOn: ['engine-role-runner'],
    body: `## Goal
Port the PR-side roles onto the single runner so a PR moves from opened → reviewed → fixed → approved without any role-specific runner class.

## Scope
- review: worktree on the PR branch, \`reviewPrompt\`, \`parseVerdict\` (last VERDICT wins, ambiguity is REQUEST_CHANGES), \`approvePr\`/\`requestChangesPr\` as comments plus the \`reviewed-ok\`/\`changes-requested\` label, outcome row.
- fix and rewrite: \`fixPrompt\`/\`rewritePrompt\` with \`keepNewestFeedback\`, rewrite chosen by \`watchdog.needsRewrite\` at assignment time, \`pushBranch\` after the student commits.
${ref}

## Acceptance
- [ ] A review run whose text ends in \`VERDICT: APPROVE\` labels the PR \`reviewed-ok\` and records a \`review-approve\` outcome; ambiguous text records \`review-changes\`.
- [ ] A label write failure throws (the label is the durable verdict) and the run is retried, not silently approved.
- [ ] The fifth failed review round dispatches a rewrite, billed under role \`rewrite\` in the ledger.
- [ ] A fix run that pushed a commit records the new head sha on the outcome.`,
  },
  {
    key: 'engine-resolve-triage-effects',
    title: 'engine: resolve (base merge + lockfile regeneration) and triage (orchestrator files the pieces)',
    difficulty: 'hard',
    dependsOn: ['engine-role-runner'],
    body: `## Goal
Port the two roles with the most machinery: bringing a stale PR up to date with base, and splitting an oversized issue into pieces the orchestrator files.

## Scope
- resolve: \`startBaseMerge\` → \`partitionConflicts\` → \`regenerateLockfiles\` → student on the remaining source conflicts → \`finishMergePush\`.
- triage: \`triagePrompt\` → \`parseTriage\`; the ORCHESTRATOR files pieces via \`openIssue\`, labels each with \`difficultyLabel(expectedDifficulty(...))\` and \`triaged\`, appends \`Depends on #N\` to the parent via \`addIssueDeps\`, labels the parent \`epic\`; fewer than two usable pieces leaves the issue intact.
${ref}

## Acceptance
- [ ] A conflicted \`package-lock.json\` is regenerated from the merged manifest, never handed to the student.
- [ ] A regeneration failure restores the conflict so the student sees it (the \`git checkout -m\` path).
- [ ] A triage result with three pieces files three issues in the returned order, each labelled with its own computed difficulty, and the parent gains three \`Depends on\` lines and the \`epic\` label.
- [ ] A triage result with one piece files nothing and the parent keeps only \`triaged\`.
- [ ] The student never runs \`gh\` (the tool allowlist excludes it and a test asserts the argv).`,
  },
  {
    key: 'engine-heartbeat',
    title: 'engine: heartbeat, --live entry, status snapshot, soft stop and bounded run',
    difficulty: 'standard',
    dependsOn: ['engine-board-cycle', 'engine-governance', 'engine-persistence', 'engine-role-runner'],
    owns: ['packages/core/src/engine/engine.ts', 'packages/core/src/index.ts'],
    body: `## Goal
The process that ties it together: fetch → decide → dispatch every \`pollMs\`, bounded by default, stoppable without losing work, and observable by the dashboard.

## Scope
- \`packages/core/src/engine/engine.ts\` + \`packages/core/src/index.ts --live\`: registerBuiltins, start provider quota monitors, preflight each provider with a trivial real completion (a \`--version\` passes with an expired login), re-entrancy-guarded tick (skip, never queue), probes for \`needs-probe\` decisions, \`status.json\` per tick, ledger event per decision reason.
- Soft stop via the ported drain flag; bounded run via \`testRun\` shape with \`config.boundedRun\`; unbounded requires \`unbounded: true\`.
- Shutdown: \`killAllHarnesses()\`, stopped snapshot.
${ref}

## Acceptance
- [ ] With fake GitHub and harness ports, two ticks dispatch one implement, then observe its PR and dispatch a review.
- [ ] An overlapping tick is skipped and logged, never queued.
- [ ] The default config parks the engine after \`boundedRun.n\` PRs; \`unbounded: true\` is required to run without a bound.
- [ ] A soft stop lets in-flight students finish, banks their work, then exits 0.
- [ ] \`status.json\` matches the documented shape the Boards and Pool tabs read.`,
  },
  {
    key: 'core-process-tree-test',
    title: 'core: Windows process-tree integration test — no orphaned CLI processes after stop',
    difficulty: 'standard',
    body: `## Goal
Prove the tree-kill path on the real platform. Every durability bug in v1's handoffs was a win32 process-lifecycle bug and none was reachable by its test suite (CI ran on ubuntu only).

## Scope
- A test under \`packages/core/test\` (or harness) that spawns a fake child tree (a node script that spawns a grandchild that sleeps), registers it with \`ChildRegistry\`, calls \`killAll\`, and asserts via \`tasklist\`/\`Get-CimInstance\` that neither pid survives.
- Runs only on win32 (skip elsewhere) and is part of \`npm test\`.

## Acceptance
- [ ] The test passes on this Windows 11 machine as part of \`npm test\`.
- [ ] Killing the tracked child alone (no \`/T\`) is shown to leave the grandchild alive in a negative control, so the assertion is known to be meaningful.
- [ ] The test cleans up its own processes even when an assertion fails.`,
  },
  {
    key: 'dashboard-boards-tab',
    title: 'dashboard: Boards tab from the engine status snapshot',
    difficulty: 'standard',
    dependsOn: ['engine-heartbeat'],
    body: `## Goal
Show each configured board the way the engine sees it: what is ready, blocked, in flight, parked and deadlocked, with one-click unpark.

## Scope
- \`packages/dashboard/webui/js/boards.js\` reading \`GET /api/boards\` (served from \`<stateDir>/status.json\` + a fresh issue/PR fetch per repo).
- Per repo: ready/blocked/in-flight/parked lists with parked reasons, deadlocked PRs, the provider that ran each in-flight item.
- \`POST /api/board/unpark\` restricted to \`PARKED_LABELS\`.

## Acceptance
- [ ] Each configured repo renders its own section; a repo whose fetch fails shows the error without blanking the others.
- [ ] Parked items show every parking label and an unpark button that removes exactly that label.
- [ ] In-flight items show the provider/harness/model running them and link to the run in the Runs tab.
- [ ] The tab carries the provider toggle for surface \`board\`.`,
  },
  {
    key: 'dashboard-pool-tab',
    title: 'dashboard: Pool tab — live students per provider and ladder tallies from the ledger',
    difficulty: 'standard',
    dependsOn: ['engine-heartbeat'],
    body: `## Goal
Make the warm pool visible and honest: who is running, how warm they are, and whether the assignment ladder is actually reusing warm workers.

## Scope
- \`packages/dashboard/webui/js/pool.js\`: live students (provider, harness, model, role, warm/cold, tokens, cache-hit %, current item) from \`status.json\`; ladder tallies (exact/rerole/crossRepo/spawn/wait, warmReuseRate) from \`GET /api/ladder\` so they survive restarts.
- Per-provider concurrency in use vs cap.

## Acceptance
- [ ] Idle-warm workers render as warm (not junk) with their base session id.
- [ ] Ladder tallies come from the ledger, not from process memory, and persist across an engine restart (test against a seeded ledger).
- [ ] Each provider shows in-flight/cap and its quota state inline.
- [ ] Attribution tiles (tasks, tokens processed, cache-hit, estimated $ marked "not billed") are computed by \`GET /api/attribution\`.`,
  },
  {
    key: 'dashboard-engine-controls',
    title: 'dashboard: engine start/stop/drain controls and bounded-run setting',
    difficulty: 'simple',
    dependsOn: ['engine-heartbeat'],
    body: `## Goal
Start and stop the v2 engine from the Overview without a terminal, with the bounded-run default visible so an unattended run is a deliberate choice.

## Scope
- Dashboard owns the engine as a \`ManagedProcess\` child (vendored tsx, never npx); \`POST /api/engine/start|stop|drain\`; bounded-run controls write \`boundedRun\` in config.

## Acceptance
- [ ] Start spawns \`packages/core/src/index.ts --live\` and the Overview dot turns green within one heartbeat.
- [ ] Stop tree-kills the engine and its students; drain lets in-flight work finish first.`,
  },
  {
    key: 'planner-codex-path-and-skill',
    title: 'planner: verify the Codex chat path end to end and ship the /plan-feature skill for your own terminal',
    difficulty: 'standard',
    body: `## Goal
The planner must be provider-agnostic in practice, not just in the interface, and usable from a plain Claude Code or Codex terminal without the dashboard.

## Scope
- Run one real planning turn with the provider toggle on ChatGPT (Codex resume-loop chat) against the free-tier login and fix whatever the normalised event mapping misses.
- \`packages/planner/skills/plan-feature/SKILL.md\` (Claude Code) and the equivalent Codex skill, both loading \`docs/ISSUE-RUBRIC.md\` and registering the dashboard's MCP server.

## Acceptance
- [ ] A Codex planning session calls \`list_repo_context\` and \`propose_issues\` through the MCP server and the drafts appear in the Planner tab.
- [ ] \`/plan-feature <idea>\` in a Claude Code terminal stages drafts in the same store.
- [ ] Both paths refuse to file without an explicit confirm.`,
  },
  {
    key: 'planner-resume-and-interrupt',
    title: 'planner: resume the last session after a dashboard restart and verify the interrupt control shape',
    difficulty: 'simple',
    body: `## Goal
A dashboard restart should cost a cached resume, not a cold seed, and the Stop button should actually stop a turn.

## Scope
- On \`POST /api/planner/start\` with \`resume: true\`, reopen the persisted session id via the harness resume path and replay the event ring from the ledger.
- Confirm the stdin interrupt message shape against Claude Code 2.1.270 (\`system/init.capabilities\` lists \`interrupt_receipt_v1\`) and adjust \`interruptLine\`.

## Acceptance
- [ ] After restarting the dashboard, "Resume last" continues the same conversation (the CLI session id matches the persisted one).
- [ ] Interrupt during a long turn ends that turn within five seconds and the session accepts the next message.`,
  },
  {
    key: 'core-git-identity-config',
    title: 'core: make the git identity used for student commits configurable',
    difficulty: 'simple',
    body: `## Goal
\`worktree.ts\` carries a hardcoded committer name and email from v1. The identity must come from config so the repo can be reused by anyone and the arena can label commits per lane.

## Scope
- Add \`gitIdentity: { name, email }\` to \`EngineConfig\` with a default read from \`git config --global\`, and thread it into \`ensureClone\`.

## Acceptance
- [ ] No name or email literal remains in \`packages/core/src/worktree.ts\`.
- [ ] A test shows \`ensureClone\` applies the configured identity to the clone.`,
  },
  {
    key: 'phase6-editor-admissions-port',
    title: 'phase 6: port the Editor and Admissions modes behind the provider toggle',
    difficulty: 'hard',
    dependsOn: ['engine-heartbeat'],
    body: `## Goal
The two upstream-of-the-board modes (architect-altitude Editor that files issues; Admissions sweep that flags what the board cannot build) return, on any provider.

## Scope
- Port \`editor.ts\`/\`editorState.ts\`/\`editorAll.ts\` and \`admissions.ts\`/\`admissionsSplit.ts\`/\`splitRunner.ts\` from v1 onto \`WarmSlot\` + the ledger; Editor passes keep the proposal fence and idempotency ledger; Admissions stays report-first.
- Dashboard Editor and Admissions tabs with the provider toggle (surfaces \`editor\`, \`admissions\`).

## Acceptance
- [ ] An Editor run on a fixture repo files issues through the same \`file_issues\` path the planner uses (one filing implementation).
- [ ] Re-running an Editor pass files nothing already in the ledger.
- [ ] An Admissions scan in report mode changes nothing on GitHub; apply mode adds only \`needs-human\`/\`needs-detail\` with the marker-guarded comment.
- [ ] Both modes run on Codex when the toggle says ChatGPT.`,
  },
  {
    key: 'cutover-bounded-run-equipworks',
    title: 'cutover: run v2 bounded on equipworks beside v1, compare ledgers, migrate config',
    difficulty: 'standard',
    dependsOn: ['engine-heartbeat', 'dashboard-boards-tab', 'dashboard-pool-tab', 'engine-failure-routing'],
    body: `## Goal
Prove v2 on one real board before it replaces v1, with numbers rather than a feeling.

## Scope
- Configure study-hall for \`Pat201492/equipworks\` only; v1 keeps \`dungeonworks\`.
- Bounded run of five PRs on the anthropic lane; then five more with the toggle on Both to observe at least one failover.
- Compare cost per merged acceptance criterion and rework multiplier from the v2 ledger against v1's usage.jsonl for the same week; write the verdict to \`docs/CUTOVER.md\`.

## Acceptance
- [ ] Five PRs opened by v2 on equipworks, each with a ledger row and an outcome row.
- [ ] At least one failover event recorded with the quota observation that caused it.
- [ ] \`docs/CUTOVER.md\` states the two cost figures, the sample sizes and the decision (cut over, widen, or hold).
- [ ] v1 was not restarted during the comparison (the user's rule).`,
  },
  {
    key: 'app-scheduled-task-verify',
    title: 'app: verify run.cmd and the logon Scheduled Task on this machine',
    difficulty: 'simple',
    body: `## Goal
The durability path is written but not yet exercised. Install the task, log off and on, and prove the dashboard comes back without a console.

## Scope
- \`install-scheduled-task.ps1\` on this machine (task \`StudyHall\`, port 4800), then a logoff/logon cycle.

## Acceptance
- [ ] After logon, \`GET http://localhost:4800/api/health\` answers within two minutes with no terminal window open.
- [ ] Closing a console that started \`run.cmd\` by hand does not kill a task-started dashboard.
- [ ] \`dashboard.task.log\` shows the teardown exit codes are not restarted into.`,
  },
];
