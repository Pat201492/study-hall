# Best practices

The rules this project keeps re-learning, each one paid for. Read this before changing the engine,
the ledger, the arena or anything that spends tokens.

Every rule below has a commit or an issue behind it. Where the lesson cost something real, the cost
is named, because a rule without its scar gets optimised away by the next person.

---

## 1. Spend that is not banked is spend you cannot govern

Every turn that burns tokens writes a `runs` row. Not only board work: planner conversations,
preflight probes, quota probes, judge calls.

The engine used to bank role-runs only. Planner turns and probes moved the vendor's window while the
ledger showed nothing, so the hourly burn governor under-counted, and the window-capacity estimator
had a percentage that moved with no tokens to explain it (#21). `ledger/sideRun.ts` writes those as
ordinary rows under their own roles (`planner`, `preflight`, `judge`), so every existing reader sees
them and a cost-per-criterion query filters them out by role instead of needing a second table.

**Rule.** If a code path calls `harness.run()` or a chat transport, it banks. No exceptions for
"it's only a probe" — a probe cost about 1.4 cents a click and moved the very window it measured.

## 2. A percentage is not a quantity. Derive the quantity, and refuse to guess it

Anthropic and OpenAI both report a window as a percentage and a reset time. You cannot set a token
cap from a percentage, and the dashboard cannot relate "31 % used" to "13.2 M tokens last hour".

`core/windowCapacity.ts` derives the quantity from paired readings: two readings of one window give
a delta, the runs overlapping that interval give the tokens, and the capacity is tokens over delta.
It refuses four ways, each with a test:

- across a window rollover, because a utilization DROP describes a window that no longer exists;
- on a move smaller than the reported percentage's own rounding, where the error can be 100 %;
- across a gap long enough to hide unbanked spend;
- on a move the ledger has no tokens to explain.

It takes the median and reports the spread, because one cache-heavy run would otherwise set the
number.

## 3. Attribute spend to the interval it burned in, not to the instant it landed

A run banks its whole cost stamped with `endedAt`, but it spent that cost over minutes, and the
quota readings that bracket an interval arrive **on that same run's stream while it is running**.
Every reading a run produces therefore precedes that run's only token sample.

Bucketing by end time put the tokens permanently outside the interval they explained, so window
capacity reported "size unknown" on every window and always would have (#25). Spend samples carry
`startedAt`, and capacity prorates each run across its span.

The burn governor deliberately still uses the completion instant: it asks what was spent recently,
and for that question the end time is the honest answer. **Two readers of the same data can want
different timestamps. Say which, and why, at both sites.**

## 4. Refuse to guess, out loud

Every estimator returns a reason instead of a number when it cannot know. `tokens: null` with
"needs two readings of one window, a rise of at least 2 points, and banked spend in between" is a
usable answer. A plausible number from one noisy sample is not.

The same rule covers `?` instead of `0 %` for an unobserved quota window, `resumesAt: null` meaning
"when those runs finish", and a judge verdict that failed to parse reporting no findings rather than
implying agreement.

## 5. Blinding is structural, never instructed

A model told "do not look at the README" in a prompt that contains the README has already read it.

The spec mirror runs two passes: the first gets issue text only, with an empty tool allowlist,
touching no file; the real README appears only in the second prompt (#22). A test asserts the real
README's content never reaches the first prompt. The arena's rubric judge is the same shape: harness
strings stripped, and a judge from a different model family than either generator, enforced at the
call rather than requested in the prompt.

## 6. The model proposes, the orchestrator files

Nothing a model writes reaches GitHub without passing lint and a human confirm. The planner drafts,
the tools lint, the dashboard stages, the operator presses File. The Editor, the planner and the
spec mirror all share that one path.

An agent that files its own issues cannot dedupe against what a wiped predecessor already filed, and
the human reviewing drafts IS the review gate the whole engine is built around.

## 7. Run the free arm first

The $0 OpenCode/Ollama arm found five defects before a paid token was spent (study-arena #6):
an argv length limit, collection errors read as "nothing failed", renamed tests scored as
regressions, duplicated declared asymmetries, and a report that never checked its own
pre-registration.

**Three of the five would have surfaced as a quality result, not as an error.** A lane would simply
have looked bad and the corpus would have looked small but plausible. That is the whole argument for
the free arm: the failures it catches are the ones that are hardest to see in a number.

## 8. A test that did not run is not a test that failed

Corpus validation counted node ids the reference patch had renamed or deleted as regressions, and
discarded three good items (study-arena #13). Expected ids split three ways: passed, failing (it ran
and lost, or its module would not import), and missing (no verdict at all).

The two callers then take **opposite positions on purpose**:

| caller | missing id | why |
|---|---|---|
| corpus validation | forgiven | renaming a test is what a refactor does |
| trial grading | fatal | deleting the test that catches you is the oldest way to turn a suite green |

Where two callers of one helper disagree, say so at both sites. A future reader will otherwise
"fix" the inconsistency.

## 9. Pre-registration you never check is decoration

The report printed the pre-registered corpus hash while reading a corpus that had changed, and
nothing compared them (study-arena #14). Worse, the hash covered the validation verdicts, which a
re-validation rewrites and a task never does, so it moved when nothing about the work moved. A
digest that changes for no reason teaches its reader to ignore it.

Hash the frozen spec separately from the mutable verdicts, compare on every report, and let a moved
corpus **lead** the findings rather than sit in a footnote.

## 10. Never sum two meters

A subscription dollar is an estimate from a price table. A metered dollar is an amount charged. The
arena reports a (harness × meter) matrix and never one leaderboard number, and `$/AC` rows are
exact-fidelity only. The primary cost metric is **dollars per merged acceptance criterion**, with
$2.72/AC as the v1 baseline.

## 11. When a test fails, decide which side is wrong — then say it

Several times the code was right and the fixture was wrong: a Pass@1 denominator that should have
excluded budget-exhausted trials, a slot budget where a global ceiling legitimately bound first, a
`resumesAt` expectation where only the oldest sample needed to expire, and a rollover fixture that
interleaved two windows' readings at identical timestamps, which cannot happen in a real stream.

Changing a test to match the code is sometimes correct and always suspicious. **Do it only with the
reason written down, in the commit and in the test.**

## 12. An action that spends money must show what it bought

The quota probe worked perfectly and looked broken for weeks: the click handler refreshed the header
and never repainted the provider cards, so after a probe that had just observed a window the bars
still read "No window observed yet" (#24).

If a button costs money, the screen it was pressed on shows the result of that spend, immediately.

---

## Windows, because this runs on Windows

These are scars, not preferences.

- **Durability is a logon Scheduled Task.** Detached spawns and WMI both failed; a console-launched
  copy dies with its console. Verified on a real logoff/logon cycle: task ran at the logon second,
  dashboard answered health 16 seconds later, parented to the Task Scheduler service with zero
  window handles (#8).
- **Three exit codes are teardown, not a crash**: `0xC000026B`, `0xC0000142`, `0x40010004`. Restart
  into a dying session and every child dies the same way, *including the `ping` used as a sleep*, so
  a 5-second backoff collapses to milliseconds and the whole restart budget burns in a third of a
  second. Stand down; the logon task brings it back.
- **`ping` is the sleep.** `timeout.exe` refuses to run when stdin is redirected, which is exactly
  how a shortcut, a Task Scheduler launch and every tool-spawned run invoke a script, and it returns
  instantly — turning a backoff into a hot spin.
- **`.cmd` files are CRLF-pinned** in `.gitattributes`. A LF-only `.cmd` makes `cmd.exe` report the
  script itself as "not recognized".
- **Vendored `tsx`, never `npx`.** The Task Scheduler PATH is thinner than a shell's.
- **Kill trees with `taskkill /T /F`**, and prefix `MSYS_NO_PATHCONV=1` in Git Bash or `/PID` is
  mangled into a path.
- **argv has a limit.** 2,334 pytest node ids on one command line is `ENAMETOOLONG`; run the files
  instead and check the ids against the parsed summary (study-arena #11).
- **Git Bash `/tmp` is not `C:\tmp`** for a spawned child's cwd, and backticks inside
  `git commit -m "…"` run command substitution — one such commit hung on a `codex exec`. Always
  `git commit -F <file>`.

## Editing source with scripts

`sed`, `perl` and Python one-liners have repeatedly mangled TypeScript in this repo: a NUL byte
injected into a regex, literal newlines where `\n` was meant, a broken union type, and a source file
that `grep` then reported as binary.

**After any scripted edit, read the changed lines back and run the typecheck.** Prefer an exact-line
address or a unique anchor over a loose pattern, and never `git add -A` a scripted sweep without
looking at the diff.

## Things that are never done without being asked

- Restarting or modifying the v1 engine (`run-dashboard.cmd`, port 4700). v2 lives on 4800.
- Cutting over from v1. That needs an explicit go.
- Adding GitHub Actions. The free plan's minutes and storage are shared across private repos; tests
  run locally on Windows, which is the real target.
- Reading or copying `.credentials.json` / `auth.json`, or setting `CODEX_API_KEY` in a child env.
  Only the unmodified `claude` binary with the user's own login is spawned.

## Configuration

`config.json` is **not** in git and should stay that way: it holds machine paths, and a shared one
would fight between machines. `config.example.json` IS in git and documents every key, so a fresh
clone knows the shape without reading `dashboard/src/config.ts`.

Two consequences worth stating, because both have already surprised someone:

- **The boards you add in Settings live only on that machine.** Adding a repo writes `config.json`.
  Moving to another machine means adding them again.
- **Anything the app refuses to run without must be committable.** The arena refused to sweep
  without a committed pre-registration manifest while `.gitignore` excluded the directory it wrote
  that manifest to, so the guard could never hold and every run passed `--unregistered` instead.
  A guard that cannot be satisfied is not a guard.

## 13. A seam is not a guard until something is plugged into it

`RunnerDeps.gitLock` existed from the first day of the engine port, was used at every git call
site, and carried the comment "serialises git operations per clone (worktree add/remove race
otherwise)". Nothing ever supplied one, so the fallback ran every call unserialised. The race the
comment predicted then happened on the first real board run and cost a student (#27).

A declared-but-unwired seam reads like protection in every review after it. **Either wire it or
delete it**, and prefer a test that fails without the wiring: the test here first proves two
concurrent writers collide without the lock, then that they are ordered with it.
