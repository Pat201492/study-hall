# study-hall

Study Room v2. A warm pool of coding-agent CLIs (Claude Code, Codex CLI, OpenCode, …) driving GitHub
boards, with a **planning terminal** that turns feature ideas into rubric-compliant issues, a
**durable run ledger** (what each run did, tokens, cost, provider, transcript), and **per-provider
quota display** (5-hour / weekly windows) with a provider toggle on every screen.

Layout: `packages/harness` (the shared adapter package `study-arena` imports), `core` (engine),
`planner`, `dashboard`, `app` (Windows launcher + logon Scheduled Task). Plan: `docs/PLAN.md`.
Research dossiers behind every design call: `docs/research/`.

Runs on Node ≥ 22.5 (`node:sqlite`), zero native dependencies, Windows-first, no CI (tests run locally).
