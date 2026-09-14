# ADR-000 — Phase 0 spike results (2026-09-14)

Live trials run on this machine (Windows 11, Node 24.15). Each Claude trial was one haiku turn.

## Claude Code (native install on PATH upgraded 2.1.158 → 2.1.270)

| Question | Result |
|---|---|
| Does `claude -p --input-format stream-json --output-format stream-json --verbose --replay-user-messages` stay alive after the first `result` and answer a second stdin user message? | **Yes.** Two `result/success` events, process exits 0 only after stdin is closed. Turn 2 took 1.1 s (turn 1: 3.9 s incl. boot). |
| Is `rate_limit_event.rate_limit_info.unifiedWindows` populated for this account (claude.ai Max 5x) under `-p`? | **Yes**, on the first API response: `five_hour {utilization 0.14, resetsAt 1789415400}`, `seven_day {utilization 0.2, resetsAt 1789585200}`; top-level `status: allowed`, `overageStatus: rejected (org_level_disabled)`. One event per session unless a rounded percentage moves. |
| `--tools` still accepted? | Yes (`--tools <tools...>`, plus `--allowedTools`, `--permission-prompts`, `--max-budget-usd`, `--effort`, `--mcp-config`, `--strict-mcp-config`, `--append-system-prompt`). |
| Stdin interrupt protocol? | `system/init.capabilities = ["interrupt_receipt_v1","interrupt_cancel_queued_v1","msg_lifecycle_v1"]` — feature-detect on this array. |
| Per-turn shape | A `system/init` is emitted **per turn** (2 in a 2-turn session), plus `system/hook_started`/`hook_response` (SessionStart hooks run), `system/thinking_tokens`, `user` (replayed), `assistant`, `result`. Parser must tolerate repeated init and unknown types. |
| `result.modelUsage` fields | `inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, webSearchRequests, costUSD, contextWindow, maxOutputTokens, thinkingTokens, canonicalModel, provider ("firstParty"), costBasis ("list")`. Use `modelUsage`, not `usage` (subagent-inclusive). |
| Cost of a trivial turn with the full 31-tool surface | ~31 k cache-read tokens/turn (system prompt + CLAUDE.md + tool schemas) — `--tools` trimming is the per-turn lever for the planner. |

Consequences: planner transport = one long-lived stock `claude` process (fallback per-turn `--resume`);
Claude quota is read off the student stream; no `.credentials.json` access anywhere.

## Codex CLI 0.154.0 (`npm i -g @openai/codex@0.154.0`; login pending)

| Question | Result |
|---|---|
| `codex exec` flags | `--json`, `-o/--output-last-message`, `--output-schema`, `--skip-git-repo-check`, `--ephemeral`, `--ignore-user-config`, `--ignore-rules`, `--color`, `-s/--sandbox {read-only,workspace-write,danger-full-access}`, `--approve-for-me`, `--dangerously-bypass-approvals-and-sandbox`, `-C/--cd`, `--add-dir`, `--thread-source`, `-c key=value`, `-m`. |
| `--full-auto` / `--ask-for-approval` on exec | **Absent** (docs stale). Use `--sandbox workspace-write` and `-c approval_policy="never"`. |
| Session subcommands | `codex exec fork <SESSION_ID> [PROMPT]` and `codex exec resume [SESSION_ID] [--last] [--all] [PROMPT]` exist; prompt `-` reads stdin. |
| App-server protocol | `codex app-server generate-json-schema --out docs/research/codex-schema` produced 39 files (v1 + v2), including `account/rateLimits/read` in `ClientRequest.json`. `app-server` is marked experimental; pin 0.154.0. |
| Auth | `codex login status` → Not logged in. Free-tier ChatGPT login launched in a console window for the user. Cumulative-usage diff, fork semantics, `account/rateLimits/read` handshake and Windows sandbox setup are **still to run after login** (tracked in ADR-001). |

## Environment
`node:sqlite` present on Node 24.15 (`DatabaseSync`, `StatementSync`, `Session`, `backup`).
Transcripts for dungeonworks/equipworks (270 dirs, 218 MB) archived to `~/.study-hall/archive/claude-projects`;
`cleanupPeriodDays: 3650` set in `~/.claude/settings.json`.
