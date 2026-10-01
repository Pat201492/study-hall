import type { IssueDraft } from '@study-hall/planner';

// Trader-Screener follow-ups found running the fundamentals layer (#235-#240)
// on live data, 2026-09-30.

export const drafts: IssueDraft[] = [
  {
    key: 'cik-normalize',
    title: 'Facts store: one canonical CIK form, so a filer is not split across two keys',
    difficulty: 'hard',
    owns: ['tools/edgar_scrubber/facts_store.py'],
    body: `## Goal
The same filer lands in \`facts.sqlite\` under two CIK strings. The 10-K path (\`server.taxonomy_run\`) writes the zero-padded \`0000320193\`, and the frames path (\`frames_ingest.ingest_frames\`) writes the bare \`320193\`. Found live on 2026-09-30: Apple has rows under both. Every per-CIK reader (\`facts_for\`, \`/api/store/standardized\`, \`/api/store/compare\`) sees half of each filer.

## Scope
- \`facts_store.py\`: \`put_facts\` and \`put_filers\` normalise every CIK to the 10-digit zero-padded form (\`edgar_client.cik10\`). Every read method that takes a \`cik\` argument (\`latest\`, \`history\`, \`facts_for\`, \`as_of\`, \`guidance_for\`) normalises it the same way, so callers passing either form get the same rows.
- A one-time additive migration on writable open: rewrite non-padded \`facts.cik\` and \`filers.cik\` values to the padded form. A row whose padded key already exists is dropped, not duplicated (the table's UNIQUE key). A read-only open never migrates, matching #250.
- Tests in \`test_facts_store.py\`.

## Acceptance
- [ ] Writing the same fact once with \`cik="320193"\` and once with \`cik="0000320193"\` leaves exactly one row, stored as \`0000320193\`.
- [ ] \`facts_for("320193")\` and \`facts_for("0000320193")\` return identical rows.
- [ ] Opening a store that holds rows under both forms for one filer (writable) leaves one padded CIK with no duplicate \`(concept, period_start, period_end, accession)\` rows, and a test counts rows before and after.
- [ ] A read-only open of an un-migrated mixed store still reads without raising and does not rewrite it.
- [ ] \`python tools/edgar_scrubber/test_facts_store.py\`, \`pytest tools/edgar_scrubber\` and \`python tools/test_server.py\` pass.`,
  },
  {
    key: 'compare-by-fiscal-year',
    title: 'Compare filers by fiscal year, not by exact period-end date',
    difficulty: 'hard',
    dependsOn: ['cik-normalize'],
    body: `## Goal
\`/api/store/compare\` keeps only facts whose \`period_end\` equals one date, so a fiscal year ending anywhere but that day drops out. Live on 2026-09-30 with \`period_end=2024-12-31\`, only 3763 of about 5000 filers ranked on operating income: Apple (Sep), Microsoft (Jun), NVIDIA (Jan) and Walmart (Jan) were all missing although their FY2024 frames facts were in the store. Rank each filer's annual figure for a fiscal year instead.

## Scope
- \`tools/server.py\` \`store_compare\`: accept \`fy=<year>\` as an alternative to \`period_end\`. For each filer, take its ANNUAL facts (duration 350-380 days, the same window \`_PERIOD_WINDOWS["annual"]\` uses) whose \`period_end\` falls in \`[<fy>-01-01 + 1 month, <fy+1>-01-01 + 1 month)\`. This window matches SEC's frames alignment, where a fiscal year ending 2025-01-26 belongs to CY2024. If a filer has several, take the latest \`period_end\`. Each row carries its own \`period_end\`.
- Exactly one of \`fy\` / \`period_end\` is required. Both or neither returns HTTP 400.
- \`web-dashboard/index.html\` Compare view: the period select offers fiscal years (the default) and shows each row's own period end.
- Tests in \`tools/test_server.py\` with filers whose fiscal years end in Jan, Jun, Sep and Dec.

## Acceptance
- [ ] \`/api/store/compare?field=revenue&fy=2024\` over a seeded store returns filers with FY ends 2024-06-30, 2024-09-28, 2024-12-31 and 2025-01-26, each once, sorted by value descending.
- [ ] Each returned row carries its own \`period_end\`.
- [ ] A quarterly-duration fact at a matching end date is never ranked as the annual figure.
- [ ] Passing both \`fy\` and \`period_end\`, or neither, returns HTTP 400 with an \`error\` message. \`period_end\` alone keeps its current behaviour.
- [ ] The Compare view defaults to a fiscal-year select and shows each row's period end. Inline scripts pass \`node --check\`.
- [ ] \`python tools/test_server.py\` passes.`,
  },
];
