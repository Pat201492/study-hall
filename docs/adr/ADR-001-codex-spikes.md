# ADR-001 — Codex CLI 0.154.0 live spikes (2026-09-14)

Run on this machine (Windows 11, Node 24.15) against `codex-cli 0.154.0` installed with
`npm i -g @openai/codex@0.154.0`, logged in to a **free-tier** ChatGPT account
(`codex login status` → `Logged in using ChatGPT`). Seven `codex exec` launches
(three of which failed before any inference) and two `codex app-server` handshakes
(no inference). Every raw capture is under `packages/harness/test/fixtures/codex/`
and the adapter tests replay them. Scratch cwd: a git-less temp dir, hence
`--skip-git-repo-check` throughout. Each prompt was "Reply with exactly the word …".

## `codex exec --json`

| Question | Observed |
|---|---|
| Event shape of a plain run (`exec-new.jsonl`) | Four lines, exit 0, 4.7 s: `{"type":"thread.started","thread_id":"01a0a077-4032-7723-ab2a-a005300c3e48"}` · `{"type":"turn.started"}` · `{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"OK"}}` · `{"type":"turn.completed","usage":{"input_tokens":14134,"cached_input_tokens":9984,"cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0}}` |
| Is `turn.completed.usage` cumulative or a delta on **resume**? (`exec-resume.jsonl`) | **CUMULATIVE.** `codex exec … resume 01a0a077-4032-… -` (one trivial turn) reported `{"input_tokens":28286,"cached_input_tokens":19968,"cache_write_input_tokens":0,"output_tokens":11,"reasoning_output_tokens":0}` — 28286 = 14134 (base) + 14152 (this turn), 19968 = 2 × 9984, 11 = 5 + 6. The rollout file's `token_count` record confirms the split: `"total_token_usage":{"input_tokens":28286,…,"total_tokens":28297},"last_token_usage":{"input_tokens":14152,"cached_input_tokens":9984,"cache_write_input_tokens":0,"output_tokens":6,"reasoning_output_tokens":0,"total_tokens":14158}`. |
| Same on **fork**? (`exec-fork.jsonl`) | **CUMULATIVE, identical totals, NEW thread id.** `{"type":"thread.started","thread_id":"01a0a077-a53e-7871-9d30-95b09509f81a"}` then `{"type":"turn.completed","usage":{"input_tokens":28286,"cached_input_tokens":19968,"cache_write_input_tokens":0,"output_tokens":11,"reasoning_output_tokens":0}}`. Its rollout `session_meta` carries `"forked_from_id":"01a0a077-4032-7723-ab2a-a005300c3e48","forked_from_ordinal_exclusive":15`. `resume` echoes the **same** id in `thread.started`; `fork` mints one. |
| Does `input_tokens` include `cached_input_tokens`? | **Yes.** The base turn's rollout `token_count` says `"total_tokens":14139` = `input_tokens 14134 + output_tokens 5`, so the cached 9984 are *inside* `input_tokens`. Adapter mapping: `inputTokens = input_tokens − cached_input_tokens` (4150), `cacheReadInputTokens = cached_input_tokens`, `cacheCreationInputTokens = cache_write_input_tokens`, `outputTokens = output_tokens`, `reasoningTokens = reasoning_output_tokens` (a subset of output per the Responses API — reported alongside, never summed; it was 0 in every spike so the subset relation is API semantics, not measured). |
| Prompt on stdin with `-` as the positional | Works for `exec … -`, `exec … resume <id> -` and `exec … fork <id> -`; stdin is read whole, no `<stdin>` wrapper. Without `-` and with a piped-but-empty stdin Codex prints `Reading additional input from stdin...` on stderr and appends it as a `<stdin>` block (run 1). The adapter always uses `-`. |
| Full adapter argv accepted? (`exec-new-stdin.jsonl`) | `exec --json --skip-git-repo-check --cd <dir> --sandbox workspace-write --ignore-user-config --ignore-rules --thread-source study-hall -c approval_policy="never" -c model_reasoning_effort="low" -o <file> -` → exit 0, same 14134/9984/0/5/0 totals on a fresh thread `01a0a078-68d2-7182-bddf-9f99b96d98ea`, `-o` file contained `OK`, rollout `session_meta.thread_source` = `"study-hall"` (the default run recorded `"user"`). Globals also parsed before `resume …` (run 3). |
| Rollout file ↔ thread id | `~/.codex/sessions/2026/09/14/rollout-2026-09-14T11-09-24-01a0a077-4032-7723-ab2a-a005300c3e48.jsonl` — the filename suffix is byte-identical to `thread.started.thread_id`, and `session_meta.session_id == id`. |
| Error shape (`exec-error.jsonl`, `-m nonexistent-model-xyz`) | Exit 1, 2.7 s, no `turn.completed`: `{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Model metadata for \`nonexistent-model-xyz\` not found. Defaulting to fallback metadata; this can degrade performance and cause issues."}}` (non-fatal) · `{"type":"turn.started"}` · `{"type":"error","message":"{\"type\":\"error\",\"status\":400,\"error\":{\"type\":\"invalid_request_error\",\"message\":\"The 'nonexistent-model-xyz' model is not supported when using Codex with a ChatGPT account.\"}}"}` · `{"type":"turn.failed","error":{"message":<same string>}}`. The same text arrives twice; the parser collapses it. |
| `--strict-config -c features.rollout_budget.enabled=true -c features.rollout_budget.limit_tokens=1000` | Exit 1 before any inference, stderr `Error: features.rollout_budget.reminder_at_remaining_tokens is required when rollout_budget is enabled`. So the keys are *recognised* under `--strict-config`… |
| …and with `-c features.rollout_budget.reminder_at_remaining_tokens=100` added | Exit 1 before inference: `Error loading config.toml: data did not match any variant of untagged enum FeatureToml in \`features.rollout_budget\``. The table shape cannot be expressed through dotted `-c` overrides at 0.154.0. **`budgetStop` stays `false`; do not rely on rollout_budget.** |
| Exit codes | 0 on success, 1 on turn.failed / config error; nothing finer. Failure kind comes from message text (`classifyFailure`). |
| Free-tier cost of these spikes | `usedPercent` moved 0 → 1 on the 30-day window after two trivial runs. |

## `codex app-server` (stdio JSON-RPC)

| Question | Observed |
|---|---|
| Handshake | `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"study-hall","title":"study-hall","version":"0.1.0"}}}` → 449 ms later `{"id":1,"result":{"userAgent":"study-hall/0.154.0 (Windows 10.0.26200; x86_64) xterm-256color (study-hall; 0.1.0)","codexHome":"C:\\Users\\pegan\\.codex","platformFamily":"windows","platformOs":"windows"}}`; then `{"jsonrpc":"2.0","method":"initialized","params":{}}`; then the read. |
| Is `jsonrpc` required / echoed? | **Neither.** Responses and notifications never carry `jsonrpc`. A second session sending every message *without* the field behaved identically. The client sends it (JSON-RPC 2.0 spec); both forms are proven. |
| Is `experimentalApi` needed for `account/rateLimits/read`? | **No** — answered with `capabilities` omitted. `params: {}` and `params` omitted both work. |
| Response (`app-server-ratelimits.jsonl`, ids redacted) | `{"id":2,"result":{"ordinaryUsageAllowed":true,"rateLimits":{"limitId":"codex","limitName":null,"normalModelSlug":null,"primary":{"usedPercent":0,"windowDurationMins":43200,"resetsAt":1791990557},"secondary":null,"credits":{"hasCredits":false,"unlimited":false,"balance":null},"individualLimit":null,"spendControlReached":false,"planType":"free","rateLimitReachedType":null},"rateLimitsByLimitId":{"codex":{…same…}},"rateLimitResetCredits":{"availableCount":0,"credits":[]},"accountId":"<redacted>","rateLimitUpsell":null}}` (2.1 s for the first read, 0.4 s for the second). |
| `windowDurationMins` for primary / secondary | **primary 43200 (30 days), secondary `null`** on the free plan — not 300/10080. A reader keyed on position would file a monthly cap as the 5-hour window. The quota reader places windows by duration (≈300 → `fiveHour`, ≈10080 → `sevenDay`, ±5 %) and everything else into `extra` keyed by a readable label (`"30d"`); a null duration is keyed by position and never guessed. |
| Does the read spend allowance? | No: `usedPercent` was identical across back-to-back reads and only moved after exec runs. |
| Unsolicited traffic | One notification right after `initialize`: `{"method":"remoteControl/status/changed","params":{"status":"disabled","serverName":"<redacted>","installationId":"<redacted>","environmentId":null},"emittedAtMs":1789398555318}`. The client must tolerate notifications interleaved with responses. |
| `account/read {"refreshToken":false}` | `{"id":4,"result":{"account":{"type":"chatgpt","email":"<redacted>","planType":"free"},"requiresOpenaiAuth":true}}` — carries the email; not used by the reader. |
| Rollout `rate_limits` | Populated in the exec rollout's `token_count` record too (`"rate_limits":{"limit_id":"codex","primary":{"used_percent":1.0,"window_minutes":43200,"resets_at":1791990569},"secondary":null,…,"plan_type":"free"}`), contrary to the earlier note that it is null for exec sessions — but it is a file, not a stream; app-server stays the source. |

## Environment facts the adapter depends on

| Question | Observed |
|---|---|
| Where is the real executable? | `codex` on PATH is the npm shim dir `%APPDATA%\npm` (`codex` sh script, `codex.cmd`, `codex.ps1`). `bin/codex.js` resolves `@openai/codex-win32-x64/package.json` and runs `<pkg>/vendor/x86_64-pc-windows-msvc/bin/codex.exe`; npm nests that package **inside** `@openai/codex`: `%APPDATA%\npm\node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe`. `npmPackageExe('@openai/codex', 'node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe')` finds it; the hoisted `@openai/codex-win32-x64` layout is tried second. |
| `resolveBin('codex')` on this machine | Returns `C:\Users\pegan\AppData\Roaming\npm\codex` with `isShim: false` — the extension-less sh shim wins because `''` is tried before PATHEXT. `resolveCodexBin` treats any Windows hit that is not `.exe`/`.com` as a shim and walks to the package exe. |
| `codex login status` | Prints `Logged in using ChatGPT` on **stderr**, exit 0. Preflight reads both streams; `authOk` means "credentials present", not "a completion succeeded" (no completion is run in preflight, by design). |
| `codex --version` | `codex-cli 0.154.0` on stdout, exit 0. |
| `codex exec --help` | Saved verbatim to `fixtures/codex/exec-help.txt`; `--json`, `-o`, `--output-schema`, `--skip-git-repo-check`, `--ephemeral`, `--ignore-user-config`, `--ignore-rules`, `--thread-source`, `-s/--sandbox {read-only,workspace-write,danger-full-access}`, `--dangerously-bypass-approvals-and-sandbox`, `-C/--cd`, `-c`, `-m`, `--enable/--disable <FEATURE>`. `resume [SESSION_ID] [PROMPT]` and `fork <SESSION_ID> [PROMPT]` both document "If `-` is used, read from stdin". No `--full-auto`, no `--ask-for-approval`. |
| Windows sandbox | Not exercised: no command was executed by the model in any spike (`~/.codex/config.toml` does not exist; `.sandbox_migration` was written by the first run). `--sandbox workspace-write` is accepted; whether the elevated/unelevated native sandbox is set up on this box is still open. |

## Consequences

- Codex is **adopt-only** and **cumulative**: a warm slot runs once, stores `sessionId` and
  `raw.cumulativeUsage`, then forks per task passing the stored totals back as
  `extra.usageBaseline`. `usageIsCumulative: true`, `cacheUsageSplit: true` → fidelity `exact`
  only because the adapter diffs.
- Per-task wipe = `codex exec fork <base> -`; `resume` accumulates into the base and is used only
  by the planner's resume-loop chat.
- Quota is read out of band by `CodexAppServerQuota` (60 s poll + `account/rateLimits/updated`
  merge); `ordinaryUsageAllowed` is the gate, percentages are advisory, and a failed read shows
  UNKNOWN + reason rather than a stale AVAILABLE.
- `budgetStop: false`, `streamsUsage: false`: usage is the last event of a run, so the generic
  guard can only trip after the turn; `features.rollout_budget` is not reachable via `-c`.
- The adapter strips `CODEX_API_KEY`/`OPENAI_API_KEY` from the child env so the lane can never
  drift onto metered billing by accident; an explicit `opts.env` still wins.
