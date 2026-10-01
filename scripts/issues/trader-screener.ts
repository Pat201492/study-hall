import type { IssueDraft } from '@study-hall/planner';

// Trader-Screener: Bloomberg-style fundamentals layering (canonical map,
// point-in-time, frames ingest, standardized views, magic-formula compare).

export const drafts: IssueDraft[] = [
  {
    "key": "canonical-concepts",
    "title": "Canonical concept map: resolve filer XBRL tags to standard fundamentals fields",
    "difficulty": "hard",
    "dependsOn": [],
    "owns": [
      "tools/edgar_scrubber/canonical_concepts.py",
      "tools/edgar_scrubber/test_canonical_concepts.py"
    ],
    "body": "## Goal\nFilers tag the same line item with different us-gaap concepts (Apple revenue is `SalesRevenueNet` to FY2017, `Revenues` in FY2018, `RevenueFromContractWithCustomerExcludingAssessedTax` from FY2019). Add one module that maps each standard field to its concepts and resolves a filer's facts to one value per period, so filers and years can be compared.\n\n## Scope\n- New `tools/edgar_scrubber/canonical_concepts.py` (stdlib only), holding `CANONICAL`: an ordered concept list for each of these 17 fields: `revenue`, `cost_of_revenue`, `gross_profit`, `operating_income`, `net_income`, `eps_diluted`, `total_assets`, `total_liabilities`, `stockholders_equity`, `cash`, `assets_current`, `liabilities_current`, `ppe_net`, `long_term_debt`, `short_term_debt`, `operating_cash_flow`, `capex`.\n- `resolve(facts, field)`: takes the fact dicts `FactsStore.facts_for(cik)` returns and gives one entry per period, `{period_start, period_end, value, concept, accession}`.\n- The `revenue` entry reuses `revenue_series.REVENUE_TAGS`, imported rather than copied, so the two lists cannot drift.\n- Resolution follows `revenue_series` (#184): take the UNION across a field's concepts keyed by period. An earlier-listed concept wins only when two concepts cover the same period. Annual vs quarterly is decided by duration in days, never by `fp`.\n- New `tools/edgar_scrubber/test_canonical_concepts.py`, offline, using the committed Apple companyfacts fixture that `test_taxonomy_fields.py` already loads.\n\n## Acceptance\n- [ ] `CANONICAL` defines all 17 fields listed in Scope, each as a non-empty ordered list of taxonomy-qualified concepts (`us-gaap:...`).\n- [ ] `CANONICAL[\"revenue\"]` is built from `revenue_series.REVENUE_TAGS` by import, and a test asserts the two match.\n- [ ] `resolve()` returns the union across concepts: a period reported only under a later-listed concept is still returned, and a period reported under two concepts returns the earlier-listed concept's value, with `concept` naming which one was used.\n- [ ] Resolving against the Apple fixture gives the FY ending 2023-09-30: revenue 383285000000, operating_income 114301000000, net_income 96995000000, total_assets 352583000000.\n- [ ] `resolve()` with an unknown field name raises `KeyError`. A known field the filer never tags returns an empty list, not an error.\n- [ ] `python tools/edgar_scrubber/test_canonical_concepts.py` and `pytest tools/edgar_scrubber/test_canonical_concepts.py` both pass with no network access."
  },
  {
    "key": "facts-filed-date",
    "title": "Point-in-time facts: record each fact's filed date and query 'as known on' a date",
    "difficulty": "hard",
    "dependsOn": [],
    "owns": [
      "tools/edgar_scrubber/facts_store.py",
      "tools/edgar_scrubber/taxonomy_fields.py",
      "tools/server.py"
    ],
    "body": "## Goal\nA backtest must only see a number after it was public. SEC companyfacts entries carry a `filed` date, but `taxonomy_fields` drops it and `FactRecord` has nowhere to put it, so the facts store cannot answer \"what was known on date D\". Record the date and add an as-of query. The look-ahead discipline in `Project.md` (#42) needs this.\n\n## Scope\n- `taxonomy_fields.fields_for_filing` / `fields_for_form`: add `filed` (ISO date from the companyfacts entry) to each occurrence dict.\n- `facts_store.FactRecord`: add optional `filed: str = None`. The `facts` table gains a nullable `filed TEXT` column. On an existing database it is added with `ALTER TABLE` only when missing, the same pattern `OutputStore` uses for `candidate_count`, so existing rows are kept and read back `filed = NULL`.\n- `FactsStore.as_of(cik, concept, period_start, period_end, as_of_date)`: the latest version whose `filed <= as_of_date`, ordered as `latest()` orders. Rows with `filed IS NULL` are never returned by `as_of`.\n- `tools/server.py` `taxonomy_run`: pass `occ[\"filed\"]` into each `FactRecord`.\n- Tests in `test_facts_store.py`, `test_taxonomy_fields.py` and `tools/test_server.py`.\n\n## Acceptance\n- [ ] Occurrences from `fields_for_filing` on the Apple fixture carry a non-empty ISO `filed` date equal to the fixture entry's `filed` value.\n- [ ] Opening a `facts.sqlite` created before this change adds the `filed` column without losing any row (test builds an old-schema db, opens it, and counts rows before and after).\n- [ ] `as_of()` returns the pre-restatement value for a date between the original and restating filings, and the restated value for a date after both (test with two versions of one period).\n- [ ] `as_of()` returns None for a date before the first filing, and never returns a row whose `filed` is NULL.\n- [ ] A taxonomy run through `server.taxonomy_run` (fake client, as the existing gate in `test_server.py` does) stores a `filed` date on every written fact.\n- [ ] `python tools/test_server.py` and `pytest tools/edgar_scrubber` pass."
  },
  {
    "key": "frames-ingest",
    "title": "Cross-filer ingest from the SEC frames API for canonical fields",
    "difficulty": "hard",
    "dependsOn": [
      "canonical-concepts",
      "facts-filed-date"
    ],
    "owns": [
      "tools/edgar_scrubber/frames_ingest.py",
      "tools/edgar_scrubber/test_frames_ingest.py",
      "tools/edgar_scrubber/fixtures/frames/"
    ],
    "body": "## Goal\nThe facts store holds one filer at a time, fetched per filing. Ranking filers needs one field across every filer for a period. SEC's frames API returns exactly that in one call per concept and period (`EdgarClient.frames()` already exists). Ingest it into the facts store for the canonical fields.\n\n## Scope\n- New `tools/edgar_scrubber/frames_ingest.py` with `ingest_frames(client, field, period, store)`: for each concept in `canonical_concepts.CANONICAL[field]`, call `client.frames(taxonomy, tag, unit, period)` once. Write one `FactRecord` per returned row (`cik`, `concept`, `unit`, `period_start`/`period_end` from `start`/`end`, or `end` twice for instants, `accession` from `accn`, `source=\"xbrl\"`, `form=\"\"`, `filed=None` because frames carry no filed date).\n- Period strings follow SEC's frames grammar: `CY2024` (annual duration), `CY2024Q3` (quarter duration), `CY2024Q4I` (instant). Anything else raises `ValueError` before any request.\n- A `filers` table in the facts store (`cik TEXT PRIMARY KEY, name TEXT`), filled from each frames row's `entityName`, with a `FactsStore.filer_names()` reader. `server.filer_name()` checks this table before the companyfacts cache.\n- CLI: `python tools/edgar_scrubber/frames_ingest.py --fields revenue,operating_income --period CY2024` prints per field: requests made, rows written, distinct filers.\n- Offline test with a fake client and small synthetic frames fixtures under `tools/edgar_scrubber/fixtures/frames/`, shaped like SEC's frames response (`taxonomy, tag, ccp, uom, label, pts, data[{accn, cik, entityName, loc, start, end, val}]`).\n\n## Acceptance\n- [ ] `ingest_frames` makes exactly one `frames()` call per concept in the field's `CANONICAL` list, and writes one fact per fixture data row with the fields mapped as listed in Scope.\n- [ ] Instant periods (`...I`) produce facts with `period_start == period_end`. Duration periods keep the row's own `start`.\n- [ ] An invalid period string raises `ValueError` and the fake client records zero calls.\n- [ ] `entityName` values land in the `filers` table, and `server.filer_name(cik)` returns them without the companyfacts cache present.\n- [ ] Running ingest twice on the same fixture leaves the fact count unchanged (idempotent on the store's key).\n- [ ] `python tools/edgar_scrubber/test_frames_ingest.py` passes with no network access."
  },
  {
    "key": "standardized-api",
    "title": "Standardized and cross-filer compare endpoints on the tool runner",
    "difficulty": "hard",
    "dependsOn": [
      "frames-ingest"
    ],
    "owns": [],
    "body": "## Goal\nServe the canonical layer to the dashboard: one filer's statement in standard fields, and one standard field ranked across filers, optionally as known on a date.\n\n## Scope\n- `tools/server.py`: `GET /api/store/standardized?cik=&period=annual|quarterly&as_of=`. It returns `{cik, name, periods, rows:[{field, values:{period_end: value}, concepts:{period_end: concept}}]}` using `canonical_concepts.resolve`, one row per `CANONICAL` field the filer has.\n- `GET /api/store/compare?field=&period_end=&tickers=&as_of=`. It returns `{field, period_end, rows:[{cik, name, value, concept}], unresolved:[...]}`, sorted by value descending. `tickers` (comma list) filters to those filers, resolved to CIKs from the cached `company_tickers.json` only (never a network call). Tickers that cannot be resolved are listed in `unresolved`, not dropped silently.\n- `as_of` (ISO date), when given, uses `FactsStore.as_of` semantics. Facts with no `filed` date (frames ingests) are excluded, and the response carries `excluded_no_filed_date` with their count.\n- Tests in `tools/test_server.py` against a temp store seeded by the fixtures from the earlier issues.\n\n## Acceptance\n- [ ] `/api/store/standardized` for the seeded Apple store returns a `revenue` row whose FY-2023 value is 383285000000 and whose `concepts` entry names the us-gaap concept used.\n- [ ] `/api/store/compare?field=revenue&period_end=<fixture end>` returns every seeded filer sorted by value descending, each with `name`.\n- [ ] `tickers=` filtering returns only the matched filers, and an unknown ticker appears in `unresolved`.\n- [ ] With `as_of` set, a fact filed after that date is not returned, and `excluded_no_filed_date` counts the frames facts left out.\n- [ ] An unknown `field` or malformed `as_of` returns HTTP 400 with an `error` message.\n- [ ] `python tools/test_server.py` passes."
  },
  {
    "key": "standardized-ui",
    "title": "EDGAR Results: standardized view and cross-filer compare",
    "difficulty": "standard",
    "dependsOn": [
      "standardized-api"
    ],
    "owns": [],
    "body": "## Goal\nShow the canonical layer on the EDGAR Results tab (added in #234): read one filer in standard fields, and rank filers on one field.\n\n## Scope\n- `web-dashboard/index.html` only.\n- For taxonomy forms (10-K, 10-Q, 8-K), a toggle above the facts grid: `as reported` (the existing `/api/store/facts` grid) or `standardized` (`/api/store/standardized`). Hovering a standardized cell shows the us-gaap concept it came from.\n- A `Compare` view on the same tab: a canonical-field select, a period-end select, a tickers text input (comma separated) and an optional as-of date. It shows a table of filer name, value and a proportional bar, sorted as the API returns it. Unresolved tickers are named above the table.\n- Empty states: no standardized data (\"run a 10-K or frames ingest first\") and no compare rows.\n\n## Acceptance\n- [ ] The as reported / standardized toggle switches the grid between the two endpoints without reloading the page. The selected filer and period stay selected.\n- [ ] Standardized cells show their source concept in the hover title.\n- [ ] The Compare view renders rows in API order with name, formatted value and a bar scaled to the largest value, and lists `unresolved` tickers.\n- [ ] Both empty states render text naming the next action instead of a blank area.\n- [ ] Inline dashboard scripts pass `node --check` after extraction (the method used in #234's test plan)."
  },
  {
    "key": "magic-formula-compare",
    "title": "Magic Formula inputs from standardized XBRL, compared against pipeline values",
    "difficulty": "hard",
    "dependsOn": [
      "canonical-concepts"
    ],
    "owns": [
      "tools/edgar_scrubber/magic_inputs.py",
      "tools/edgar_scrubber/test_magic_inputs.py"
    ],
    "body": "## Goal\nThe screener ranks on `roic` and `ebit_ev_yield` from Stock-Data-Pipeline, which is the only writer of shared data (ARCHITECTURE.md, #109). Before any field graduates there, measure how far a filer-tagged XBRL computation agrees with the pipeline's values. This issue is exploratory and local only; it writes no shared data.\n\n## Scope\n- New `tools/edgar_scrubber/magic_inputs.py` (stdlib only), with `compute(facts_by_field, mkt_cap)`. It returns `{roic, ebit_ev_yield, inputs, missing}` using Greenblatt's definitions:\n  - EBIT = `operating_income`.\n  - ROC = EBIT / ((`assets_current` − `liabilities_current`) + `ppe_net`).\n  - EV = `mkt_cap` + `long_term_debt` + `short_term_debt` − `cash`.\n  - Earnings yield = EBIT / EV.\n  - Both are expressed in percent, matching the pipeline contract in `pipeline-mock/sample_data.py`.\n- Any missing input gives `None` for the affected metric, with the missing canonical field names listed in `missing`. It never substitutes a zero.\n- CLI: `python tools/edgar_scrubber/magic_inputs.py --pipeline <url-or-json-file> --tickers AAPL,MSFT` reads `mkt_cap`, `roic` and `ebit_ev_yield` per ticker from the pipeline's `/api/stocks` shape, computes locally from the facts store, and prints local, pipeline and delta % per ticker.\n- Offline test using the Apple fixture and a `pipeline-mock` style JSON.\n\n## Acceptance\n- [ ] `compute()` follows the formulas in Scope exactly, and a test with hand-computed inputs checks both outputs to 4 decimal places.\n- [ ] A missing `ppe_net` gives `roic = None` with `\"ppe_net\"` in `missing`, while `ebit_ev_yield` is still computed when its inputs are present.\n- [ ] The CLI reads a local JSON file in the `/api/stocks` shape and prints one line per ticker with local, pipeline and delta % values.\n- [ ] The module opens no pipeline write path. Its only output is stdout, and a test asserts nothing is written outside the scrubber's local store root.\n- [ ] `python tools/edgar_scrubber/test_magic_inputs.py` passes with no network access."
  },
  {
    "key": "graduate-fundamentals",
    "title": "Graduate standardized fundamentals into Stock-Data-Pipeline (decision + port)",
    "difficulty": "hard",
    "needsHuman": true,
    "dependsOn": [
      "magic-formula-compare",
      "standardized-api"
    ],
    "owns": [],
    "body": "## Goal\nIf the magic-formula-compare deltas show the XBRL computation is reliable, port the canonical map and frames ingest into Stock-Data-Pipeline under ARCHITECTURE.md's graduation checklist, and retire the local extractor.\n\n## Scope\n- Human decision: accept or reject the deltas the compare CLI reports on a named ticker set.\n- The work lands in the Stock-Data-Pipeline repo, not this one. The port is filed there as its own issues.\n- In this repo: set the manifest's `graduatedTo` and retire the local extractor, per ARCHITECTURE.md line 70.\n\n## Acceptance\n- [ ] A decision is recorded (in this issue) with the ticker set, the deltas and accept/reject.\n- [ ] If accepted, port issues are filed in Stock-Data-Pipeline and linked here.\n- [ ] If accepted, `web-dashboard/tools-manifest.json` sets `graduatedTo` for the graduated fields, and the local ingest path is removed in the same PR.\n\nNeeds human: cross-repo decision and a live data comparison. Not buildable by a single worktree-bound student."
  }
];
