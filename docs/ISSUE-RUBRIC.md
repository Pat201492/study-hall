# Filing issues for Study Room

Point an agent at this file before it files issues for a repo:

> Read `docs/ISSUE-RUBRIC.md` in the claude-study-room repo, then file issues for
> `<owner/repo>` following it exactly.

Study Room reads issues off GitHub and builds them with a pool of Claude
students. Two things in an issue decide what that costs: **whether it is
actionable**, and **the difficulty label**. Both are mechanical, and both are
checked — see "How this is verified" at the end.

---

## 1. Every issue needs checkable acceptance criteria

An implementer that cannot tell when it is done invents the scope, and the
reviewer then judges that invented scope against criteria that were never
written. That is a fix/review loop with no fixed point.

Required shape:

```markdown
## Goal
One or two sentences: what this is for.

## Scope
- The concrete pieces of work, as bullets.

## Acceptance
- [ ] a thing that must independently be true
- [ ] another thing that must independently be true
```

- Bulleted `## Scope` plus a prose `## Acceptance` is also fine — both parse.
- A heading with nothing checkable under it does **not** count.
- Avoid scope-deferring phrases: "etc", "and so on", "as needed", "various".
  They move a decision the reviewer cannot check onto the implementer.
- If two issues touch the same shared file, give exactly ONE of them an
  `Owns: <files>` footer and have the others say `Depends on: #N`. Otherwise both
  create the same file and re-conflict forever.

## 2. Every issue needs exactly one difficulty label

`difficulty:simple` · `difficulty:standard` · `difficulty:hard`

Together with the criteria you write, this label decides which model builds the
issue. It is part of the deliverable, not decoration.

Since #302 the engine counts the criteria in the body and applies the same bands
below on its own. **The label can only tier an issue UP from what its criteria
imply, never down** — a `difficulty:simple` label on an issue listing nine
criteria is ignored. Measured over 126 issues paired with their transcripts, the
label correlated with tokens spent at ρ = −0.056 and the criteria count at
ρ = 0.557, so where the two disagree the count is believed. The label still
matters: it is the only way to say an issue is harder than its text looks.

Count the **independently checkable criteria** and the **distinct subsystems**
the work touches, then:

| label | when |
|---|---|
| `difficulty:simple` | ≤2 criteria, ONE file or one mechanical edit, no new module, nothing depends on the result. A wrong first attempt is cheap to throw away. Typos, renames, changelog entries, lint/formatting. |
| `difficulty:standard` | 3–6 criteria, confined to files that already belong together, editing existing modules rather than adding new contracts. **The normal case.** |
| `difficulty:hard` | **Any** of: 7+ criteria; touches 3+ subsystems or packages; creates a new module, schema or contract others will depend on; or involves security, auth, concurrency, data migration or money. |

### When unsure, choose the harder label

This is measured, not caution for its own sake. Over 48 implement dispatches on
these boards:

| | merged | approved on FIRST review | tokens/session |
|---|---|---|---|
| work routed to the strongest model | **100%** | **85%** | **1.09M** |
| work labelled `simple` | 82% | 48% | 2.74M |

The second row is the point. Those were the issues someone had judged *easy*, and
they came back for rework at more than twice the rate and cost **2.5× more
tokens** than the hard work did. `Import: batch rollback` and
`Review: equipment history view` were both labelled `simple`. Neither is trivia.

The costs are asymmetric:

- **Labelling up** costs ~1.67× per token, for one session.
- **Labelling down** costs another review round, another fix, and a second
  session — and a session's cost grows with the **square** of its length. One
  avoided rework round pays for the stronger tier many times over.

> `simple` means **trivia**. If you find yourself justifying why something is
> simple, it is not simple.

## 3. One issue = one pull request

If an issue carries 7+ independently checkable criteria, or its criteria fall
into groups touching disjoint subsystems, **split it** into several issues linked
with `Depends on: #N`. Size is a reason to split: a session's cost is roughly
quadratic in its length, so two half-sized PRs cost about half of one
double-sized one — and a reviewer judging four criteria catches what a reviewer
judging twelve waves through.

Splitting may never drop or weaken a criterion. Every requirement survives; it is
only redistributed.

## 4. Filing them in order

File dependencies **before** dependants, so `Depends on: #N` can reference a real
number. Study Room will not start an issue whose dependencies are still open, so
the order you file in becomes the order the board builds in.

---

## How this is verified

None of the above is on trust:

- `src/issueAudit.ts` scores every issue for actionability at ingest and can
  refuse to dispatch one with no checkable criteria (`audit-dryrun.ts` shows what
  it would say without changing anything).
- `src/difficultyRubric.ts` derives the difficulty this rubric implies from the
  issue's own text, and `relabel-issues.ts` reports any label sitting **below**
  it. Only under-labelling is flagged, for the asymmetry reason above.

If you file issues that pass both, nothing further is needed.
