# ADR-005 — Burn-rate governor: pace the window, don't drain it (2026-09-15)

## Status
Accepted and shipped (`packages/core/src/rateBudget.ts`, wired through `providerSelect` →
`boardCycle` → `engine`, surfaced at `/api/burn` and on the Overview tab).

## Problem
The quota signal we already had only *reacts*:

- Claude Code reports `unifiedWindows.five_hour.utilization` on the stream, and
  `BasicQuotaMonitor` hands over at `handoverAt` (0.9). By then 90 % of a five-hour window is
  gone — the handover is a fire alarm, not a thermostat.
- Codex's `ordinaryUsageAllowed` is a boolean that flips only once usage is *refused*.
- Neither knows about the fleet. Four warm opus students with 8 M-token budgets can spend a
  five-hour window in forty minutes, and nothing in the engine was counting.

The operator's actual want ("a token limit per hour so we don't use up all our usage, that
would automatically toggle between the two services") is a *pacing* control, which is a
different mechanism from an exhaustion signal.

## Decision: a local sliding-window cap that makes a provider UNAVAILABLE

`RateTracker` keeps, per provider, two buckets that are never summed twice:

| bucket | source | why |
|---|---|---|
| committed | one sample per finished run, seeded at boot from `ledger.spendSamples()` | an hour of spend cannot be laundered by restarting the process |
| live | one entry per in-flight run, **replaced** on every `onUsage` | a burning fleet rests the lane now, not an hour later |

`assessRate()` is pure over (samples, in-flight, limit, now). Over the line, the provider is
reported as `rateCapped` — **not** `exhausted`, and never as a failure:

- `selectProvider` skips it under `auto` (the existing failover carries the work to the other
  service) and *holds* under a pin, because a pin says which provider, not "spend without limit".
- `boardCycle` excludes it from the slot budget, and when every usable lane is resting emits one
  **tick-level** `rate-capped` hold. That last part was a real bug the tests caught: the budget
  is zero *because* the lanes rest, and reporting "no slots" would send an operator hunting for a
  concurrency problem that does not exist.

### Three deliberate choices

1. **Billed tokens, not `tokensProcessed`.** Cache *writes* are charged (1.25× on Anthropic's
   table) and a warm pool writes a lot of them. Reasoning tokens are added only where the provider
   reports them separately (Codex); Claude folds thinking into output and reports 0, so nothing is
   double-counted.
2. **`headroom` (default 0.9) stops NEW dispatch below the cap.** A student started at 99 % of the
   cap still runs to completion and lands its whole spend inside the window; reserving a slice
   bounds the overshoot by roughly one run instead of one fleet.
3. **`resumesAt` is computed, not guessed.** Walk the committed samples oldest-first and find the
   one whose expiry brings the total back under the line; dispatch resumes a window after *that*
   sample. In-flight spend never expires, so a lane whose in-flight burn alone exceeds the cap
   honestly reports `resumesAt: null` — "when those runs finish".

## Off by default
No cap ships. A cap nobody chose would silently park a board, and the right number is a fact about
this account: the dashboard suggests one from the ledger's own busiest recent hour, and says plainly
that a cap below it parks the board while one far above it never binds. Raising a cap lifts a rest
on the next tick — an operator never has to wait on a vendor reset to undo their own knob.

## Consequences
- The `$/AC` metric is unaffected: the governor changes *when* work runs, not what it costs.
- Under a pin, a rest holds the board. That is the honest reading of two explicit instructions in
  conflict; the operator resolves it by switching the surface to Both or raising the cap.
- A cap is not a quota: it knows nothing about the vendor's actual window. Deriving the pace from
  the provider's own utilization slope is the follow-up (study-hall #20).
