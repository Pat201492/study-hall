# ADR-004 — Planner transports verified live (2026-09-15)

## Status
Accepted. Findings from live runs against Claude Code 2.1.270 and Codex CLI 0.154.0 through the
dashboard on port 4800; each row is one real turn.

## Findings

| Question | Result |
|---|---|
| Claude stream-json interrupt | `control_request {subtype: interrupt}` ends the turn in **2.0 s**; the CLI reports the cut turn as `error_during_execution` (`[ede_diagnostic] … stop_reason=null`), which the adapter surfaces as `error` + `turn_done`; the next `user` message is accepted normally. |
| Claude resume after a dashboard restart | `--resume <persisted id>` continues the conversation; the event ring is now persisted to `<stateDir>/planner/<repo>/events.jsonl` (partial text excluded) and replayed on resume with `seq` continuing, so `since` cursors stay valid. |
| Codex MCP tools under `codex exec` | `codex exec` hard-sets `approval_policy=never`; an MCP tool that needs approval is rejected with `MCP tool call requires approval, but approval policy is never`. `-c mcp_servers.plan.default_tools_approval_mode="auto"` did **not** lift it (those `*_approval_mode` keys are the *apps* schema). What works: the tool advertising `annotations.readOnlyHint: true`. The planner's four non-filing tools carry it; `file_issues` does not (the dashboard files, after confirm). |
| Codex planning turn | With the hints, `list_repo_context` and `propose_issues` are called through the MCP server and the draft is staged and linted (ok, standard, 6 criteria). Without them the model still emits the `planner-proposals` fence and the dashboard stages it — the fallback path holds. |
| `/plan-feature` skill in a plain terminal | `scripts/install-planner-skill.ts <owner/name>` renders `~/.claude/skills/plan-feature/SKILL.md` (front matter + PLAN_ROLE + rubric, sha-stamped) and `~/.codex/skills/plan-feature.md`, and prints the `claude mcp add --transport http … --header X-Plan-Token` one-liner. Driven headless (`claude -p "/plan-feature …" --mcp-config …`) it staged `events-csv-export` in the same store. Cost of that run: $1.14 / 23 turns — it read widely; the dashboard session with its tighter tool list is cheaper. |

## Consequences
- Keep `readOnlyHint` on every planner tool that does not touch GitHub; add it to any new one.
- Filing from a Codex session is not possible under `approval_policy=never`; the UI's "File N issues" is the path. If a paid plan ever runs the planner with approvals, revisit.
- The persisted event log is a convenience for replay, not a ledger: the ledger records the planner's filing events; turn usage is on the `turn_done` events.
