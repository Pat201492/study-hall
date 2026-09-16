# @study-hall/app — Windows launcher

- `run.cmd` — boots the dashboard (`packages/dashboard/src/server.ts`) on port 4800 (`STUDY_HALL_PORT`), opens the browser once `/api/health` answers, restarts on crash (capped), stands down on Windows session teardown, never auto-starts the pool unless `--start-pool`.
- `install-scheduled-task.ps1` — registers the logon Scheduled Task `StudyHall` (runs as you, no execution-time limit). This is the durability path; `-Uninstall` removes it.
- `create-desktop-shortcut.ps1` — a Desktop shortcut to `run.cmd`.

`.cmd` files are CRLF-pinned in `.gitattributes`; a LF-only `.cmd` makes `cmd.exe` report the script itself as "not recognized".

## Verified on a real logon (2026-09-15, issue #8)

A logoff/logon cycle on PAT-DESKTOP exercised the whole path:

```
[Tue 09/15/2026 22:09:45.77] dashboard exited code 1073807364 - Windows session teardown, not restarting
[Tue 09/15/2026 22:12:40.94] launching dashboard
```

Logon at 22:12:38, task ran the same second, dashboard launched two seconds later, `/api/health`
answering. The serving process is parented to the Task Scheduler service and owns no window
handle, so no console can take it down — which is the whole reason the Scheduled Task is the
install path rather than a detached spawn.
