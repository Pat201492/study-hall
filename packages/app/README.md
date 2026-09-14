# @study-hall/app — Windows launcher

- `run.cmd` — boots the dashboard (`packages/dashboard/src/server.ts`) on port 4800 (`STUDY_HALL_PORT`), opens the browser once `/api/health` answers, restarts on crash (capped), stands down on Windows session teardown, never auto-starts the pool unless `--start-pool`.
- `install-scheduled-task.ps1` — registers the logon Scheduled Task `StudyHall` (runs as you, no execution-time limit). This is the durability path; `-Uninstall` removes it.
- `create-desktop-shortcut.ps1` — a Desktop shortcut to `run.cmd`.

`.cmd` files are CRLF-pinned in `.gitattributes`; a LF-only `.cmd` makes `cmd.exe` report the script itself as "not recognized".
