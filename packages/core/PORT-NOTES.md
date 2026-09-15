# `@study-hall/core` — port notes

Phase 2 port of the PURE engine modules from `claude-study-room` (v1, read-only reference at
`C:\Users\pegan\dev\claude-study-room`) into `packages/core`. Everything below was copied with its
measured comments intact; the only content changes are the three deliberate fixes, the logger
timestamp, and the import/type shims that keep `core` free of any dependency on `config.ts`,
`pool.ts`'s simulator, `pricing.ts`, `live.ts`, `worktree.ts` or `packages/harness`.

Byte-level normalisation on copy (not content): UTF-8 BOMs stripped (v1 `classify`, `github`,
`issueAudit`, `roles`, `repoState`, `watchdog` and three tests carried one) and CRLF → LF, per this
repo's `.gitattributes` (`* text=auto eol=lf`).

## What was ported (`packages/core/src`, 35 files)

Verbatim (imports re-pointed only): `protector`, `classify`, `gates`, `ownership`, `throttle`,
`assignments`, `watchdog`, `parole`, `schedule`, `tierFallback`, `optimizer`, `blackout`,
`emptyRun`, `ciFailure`, `reportLifecycle`, `testRun`, `drain`, `managedProcess`, `issueAudit`,
`triage`, `buildability`, `difficultyRubric`, `difficulty`, `github`, `roles`, `prompts`,
`carveOut`, `logger`.

Split:

- v1 `repoState.ts` → `keys.ts` (the pure half: `qualifyTaskId`, `parseTaskId`, `qualifyActionKey`,
  `qualifyItemKey`, `parseQualifiedKey`, `fkey`, `stateDirFor`, `taskMapPathFor`; zero project
  imports — `taskMapPathFor` takes `{ stateDir }` so it needs no `RepoState`) and `repoStateIo.ts`
  (the `RepoState` bundle, `newRepoState`, and the handled/quarantine/attempts/lifetime load/save
  over `node:fs`). Key formats `owner/name#7`, `owner/name:pr-12`, `KIND:owner/name:pr-12` are kept
  exactly, including `parseQualifiedKey`'s slug-must-contain-a-slash rule.
- v1 `taskmap.ts` → `taskmap.ts` (types + DAG/edit/tiering ops, now fs-free) and `taskmapIo.ts`
  (`loadTaskMap`/`saveTaskMap`).

New shims (tiny, local, so `core` imports nothing from `packages/harness`):

- `tiers.ts` — `type Tier = 'haiku'|'sonnet'|'opus'` and `TIERS`. v1 had `Tier` in `pricing.ts`
  (now `@study-hall/harness`) and `TIERS` in `pool.ts`.
- `types.ts` — the shared shapes from v1 `pool.ts` (`Role` re-export, `ROLES`, `StudentState`,
  `Student`, `AttributionCell`, `AttributionMatrix`, `DeadlockedPr`, `ParkedItem`, `BoardHealth`,
  `PoolState`, `emptyAttribution`, `initPool`). The M5 random-walk simulator (`tick`,
  `spawnStudent`, `reconcile`, `finishTask`, `STAGE_FOR_ROLE`) is NOT ported — v2 has no `sim` mode.
- `repo.ts` — `normalizeRepo`, a verbatim copy of v1 `config.ts:361-369`, the one config helper
  `github.ts` needed.
- `gates.ts` gained a local `ReviewMode` / `MergePolicy` (copy of v1 `config.ts:26` and the two
  `StudyRoomConfig` fields it reads) in place of `Pick<StudyRoomConfig, ...>`.
- `repoStateIo.ts` carries a local `RepoClone` (copy of v1 `worktree.ts:22-27`).
- `OptimizationMode` is taken from `optimizer.ts` (identical union to v1 `config.ts:18`).

Not ported here, by design: `pricing.ts`, `capacityReset.ts`, `contextCard.ts` (nothing in
`roles`/`prompts` imports it), `pool.ts`'s simulator, `config.ts`, `live.ts`, `worktree.ts`,
`cliStudent.ts`, harnesses, editor, dashboard. No `index.ts` barrel was added: `protector.ts` and
`taskmap.ts` both export a `Task` type and `optimizer.ts`/`difficulty.ts` both export `Effort`, so a
wildcard barrel would not typecheck; the orchestrator should import modules by name.

## The three deliberate fixes

### 1. `parseDeps` reads the colon form and every number on the line

v1 `src/github.ts:126-132`: `const re = /depends on #(\d+)/gi;` — verified `'Depends on: #5' → []`
and `'Depends on #12, #13' → ['#12']`. The rubric (`docs/ISSUE-RUBRIC.md:41,96`), `EDITOR_ROLE`
(`roles.ts:289`) and the planner all prescribe `Depends on: #N`, so only engine-authored deps
(`addIssueDeps`, v1 `github.ts:570`, which writes the bare form) ever gated dispatch.

Now (`packages/core/src/github.ts`, `parseDeps`): `depends on:?` followed by one or more `#N`
separated by spaces, commas or `and`, same line only, order-preserving, de-duplicated. Accepts
`Depends on #12`, `Depends on: #12`, `Depends on: #12, #13`, `Depends on #12 #13`,
`Depends on: #12, #13 and #14`. `addIssueDeps` still writes `Depends on #N` (and is now
idempotent against a colon-form line already in the body). Tests: six new cases in
`test/github.test.ts` under "parseDeps: both forms, every number".

### 2. `maxCriteria` 4 → 7 in both gates, and `TRIAGE_ROLE` aligned to the same bar

v1 `src/issueAudit.ts:82` (`DEFAULT_AUDIT_GATE.maxCriteria: 4`) and `src/triage.ts:57`
(`DEFAULT_TRIAGE_GATE.maxCriteria: 4`), both `>=` comparisons, routed any issue with 4+ criteria to
TRIAGE (`classify.ts:316`). The rubric calls 3–6 criteria the `standard` band — "the normal case" —
and `DEFAULT_AC_TIERING.hardMin` is 7, so a rubric-compliant standard issue paid an Opus triage
session to be told SINGLE_PR (40/40 verdicts in the measured window).

Now both gates are `7`, so 7+ is the one number where the tiering rubric says `hard`, the audit says
`oversized`, and triage fires. `roles.ts` `TRIAGE_ROLE` is aligned consistently (v1 `roles.ts:175`
"5 or more" → "7 or more"; `roles.ts:183` "roughly four or fewer" → "roughly six or fewer") — the
prompt is byte-stable, just a different byte-stable constant. Tests re-pinned: `issueAudit.test.ts`
("too many criteria is oversized" 6→7 criteria; "an oversized issue routes to TRIAGE" 6→7;
"NEEDS_DETAIL outranks TRIAGE" 6→7) and `triage.test.ts` ("many separate acceptance criteria trip
the gate" 4→7; "an explicit checklist wins" 4→7). Added: a 3–6-criteria-is-`ready` regression in
`issueAudit.test.ts`, a 6-criteria-goes-straight-to-IMPLEMENT case, and a 3–6-does-not-trip case
in `triage.test.ts`.

### 3. `PIPELINE_LABELS` registers `editor-proposed` and `context-card`

v1 `src/github.ts:305-333` omitted both although the engine writes them (`editor.ts:435`,
`contextCard.ts:222` `CARD_LABEL`), contradicting the list's own stated purpose ("every label the
engine WRITES"); `editor.ts:358` worked around it by calling `ensureLabels` with an explicit name
list. Added with colours `editor-proposed: 0052cc`, `context-card: c2e0c6` in `LABEL_COLORS`. The
"every label the engine writes is registered" test now also asserts `needs-detail`, `needs-human`
and the two new labels.

## Logger: UTC with an explicit `Z`; blackout stays local wall clock

v1 `src/logger.ts:10-12` printed `toISOString().replace('T',' ').slice(0,19)` — a UTC instant
formatted to look like local time, while every operational rule (blackout window, capacity reset,
the 22:00 crash hour) is local. Correlating a log line with the launcher log or a blackout needed an
undocumented 4-hour mental conversion (`2026-08-22T02` UTC IS the 22:00 local burst).
`packages/core/src/logger.ts` now prints `2026-08-22T02:17:37Z` and exports `timestamp(d?)` so
the format is tested behaviourally (`test/logger.test.ts`).

`blackout.ts` is unchanged and deliberately local (`d.getHours()`): the operator's rule is stated
as "22:00–23:00" on the wall clock, so the decision must follow the local hour whatever the zone
offset. The contrast is asserted in `logger.test.ts` ("the blackout window, by contrast, is local
wall clock") and `blackout.test.ts` ("the window is judged on local wall clock, not UTC"). The log
line and the window now visibly disagree by the zone offset instead of silently looking alike.

## Tests (`packages/core/test`, 38 files, 488 cases, all green)

Ported from v1 (37 files): `protector`, `classify`, `gates`, `ownership`, `throttle`, `assignments`,
`fairShare`, `watchdog`, `watchdogReconcile`, `parole`, `schedule`, `tierFallback`, `optimizer`,
`blackout`, `emptyRun`, `ciFailure`, `reportLifecycle`, `testRun`, `drain`, `managedProcess`,
`repoState`, `crossRepoKeys`, `taskmap`, `issueAudit`, `triage`, `buildability`, `difficulty`,
`acTiering`, `github`, `roles`, `prompts`, `carveOut`, `probeBudget`, `releaseConverged`,
`seedAttempts`, `rewriteEscalation`, `specCollision`. New: `logger`.

Those 37 files held 489 cases in v1; 15 were dropped and 14 added → 488.

Dropped as source-regex text-locks (`assert.match` over a `readFileSync`'d `live.ts`/`pool.ts`),
7 cases: `blackout` "the runner holds dispatch rather than stopping"; `parole` "the runner paroles
due items and resets their budget"; `github` "scope triage records its pieces in the body";
`releaseConverged` "an approved PR is released from quarantine before anything reads it" and
"release clears BOTH key shapes"; `rewriteEscalation` "Role has ONE definition — pool re-exports
taskmap"; `specCollision` "the engine scopes its ingest and pauses only the contested boards". Each
pinned a `live.ts` wiring fact that belongs to the v2 `Governance`/`BoardCycle` units and is to be
tested there behaviourally.

Dropped because they exercised a module that is not in `core`, 8 cases: `gates` ×3
(`parseActionKey`/`parseItemKey` — `live.ts`'s legacy unqualified-key parsers, superseded by
`parseQualifiedKey`); `blackout` "config merges per key" (`config.loadConfig`); `github` ×1 and
`specCollision` ×3 (`cliStudent.isCapacityError` — the capacity classifier is per-harness in
`@study-hall/harness`). One assertion line (`ROLE_SINGULAR.rewrite`, a dashboard presentation map
in `roleView.ts`) was removed from an otherwise-kept `rewriteEscalation` case.

Not ported as whole files (33 of v1's 70): the purely text-lock suites `staleDashboard` (6/6),
`sharedCursor` (4/4), `tickReentrancy` (4/4), `webui` (48 cases, 56 source assertions, no server or
DOM); and every suite for a module outside `core` (`admissions*`, `adoptSession`, `capacityReset`,
`claudeBin`, `cliStudent`, `config`, `contextCard`, `drainCompletes`, `editor*`, `feedbackOrdering`,
`generated`, `harness`, `idleWatchdog`, `infraFailure`, `openCodeHarness`, `pool`, `pricing`,
`reportAttribution`, `roleView`, `statusSnapshot`, `studentBudget`, `studentTools`, `testingAgent`,
`usageStore`, `warmCliSession`).

Assertions on exported ROLE string constants (`roles.test.ts`, `prompts.test.ts`,
`rewriteEscalation.test.ts`) are kept — those test the byte-stable constants, not source text. No
test spawns `claude`/`codex`/`opencode` or touches the network; `github.test.ts` and
`specCollision.test.ts` inject a fake `GhRunner` as v1 did; `managedProcess.test.ts` spawns only
`process.execPath`.

## Left as-is, flagged for the orchestrator work

- `drain.ts` and `testRun.ts` default their flag directory to `~/.claude-study-room` (v1 `drain.ts:26`,
  `testRun.ts:45`). Both take the dir as a parameter; the v2 state-root name and the state-dir
  migration (PLAN Phase 2) decide the default, so it was not changed here.
- `stateDirFor` still derives the configured-URL form (`https---github.com-owner-name`); the
  "one canonical `owner-name` dir + read legacy" migration is orchestrator scope.
- `managedProcess.ts` still decodes child output with the default utf8 (the v1 mojibake source,
  research `code-ops-tests-log.json`); fixing it means choosing the child codepage at spawn, which
  is harness/launcher scope.
- `github.ts`'s `fetchIssues`, `openPr`, `mergePr`, `failingCiLog` shell the real `gh` with no
  injectable runner, exactly as in v1; the tests never reach them.
