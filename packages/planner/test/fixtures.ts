// Shared fixture: a rubric-compliant draft body (3 checkbox criteria, > 200
// chars, no scope-deferring phrases). Not a test file, so the glob skips it.
export const GOOD_BODY = [
  '## Goal',
  'Add a CSV export of the runs ledger so a spreadsheet can analyse cost per acceptance criterion without touching the database directly.',
  '',
  '## Scope',
  '- New `GET /api/runs.csv` route on the dashboard server, next to the JSON one.',
  '- Reuses the JSON route\'s filter parsing; no new query semantics.',
  '',
  '## Acceptance',
  '- [ ] `GET /api/runs.csv?repo=x` answers `text/csv` with one header row and one row per run.',
  '- [ ] Every filter the JSON route accepts is honoured by the CSV route.',
  '- [ ] A server test asserts the header row names the five token columns.',
].join('\n');
