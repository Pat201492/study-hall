import type { IssueDraft } from '@study-hall/planner';

// Trader-Screener: standardize revenue one level deeper, then verify every
// standard field against the filer's own calculation linkbase.
// Context: Walmart FY2025 tags net sales 674.538B (RevenueFromContractWithCustomer...)
// and total revenues 680.985B (Revenues), with the 6.447B difference under
// OtherIncome; the single `revenue` field picked whichever tag came first.

export const drafts: IssueDraft[] = [
  {
    key: 'revenue-hierarchy',
    title: 'Canonical map: split revenue into total, sales and derived other revenue',
    difficulty: 'hard',
    owns: ['tools/edgar_scrubber/canonical_concepts.py', 'tools/edgar_scrubber/test_canonical_concepts.py'],
    body: `## Goal
A filer that reports both net sales and total revenues (Walmart FY2025: $674.538B net sales + $6.447B membership and other income = $680.985B total revenues) currently gets one \`revenue\` value: whichever tag comes first in \`revenue_series.REVENUE_TAGS\`. Give the screener both levels on purpose, and the difference between them.

## Scope
- \`tools/edgar_scrubber/canonical_concepts.py\`:
  - \`revenue\` means **total revenue**: \`us-gaap:Revenues\` first, then \`RevenueFromContractWithCustomerExcludingAssessedTax\`, \`RevenueFromContractWithCustomerIncludingAssessedTax\`, \`SalesRevenueNet\`. It gets its own tuple, no longer imported from \`revenue_series.REVENUE_TAGS\`. \`revenue_series.py\` is not changed.
  - New \`sales_revenue\`: \`RevenueFromContractWithCustomerExcludingAssessedTax\`, \`RevenueFromContractWithCustomerIncludingAssessedTax\`, \`SalesRevenueNet\`.
  - New derived field \`other_revenue\`: for each period where \`revenue\` and \`sales_revenue\` both resolve from DIFFERENT concepts, \`revenue − sales_revenue\`, with \`concept = "derived:revenue-sales_revenue"\`. It is not emitted when either side is missing, when both resolve from the same concept, or when the difference is negative.
  - \`DERIVED\`: a set naming the derived fields. \`frames_ingest.ingest_frames\` raises \`ValueError\` for a derived field, because frames cannot fetch a computed value.
- The test that asserted \`CANONICAL["revenue"] == REVENUE_TAGS\` is replaced by the ordering checks below.
- Tests in \`tools/edgar_scrubber/test_canonical_concepts.py\`, with a synthetic Walmart-shaped filer plus the committed Apple fixture.

## Acceptance
- [ ] For a filer tagging \`Revenues\` 680985000000 and \`RevenueFromContractWithCustomerExcludingAssessedTax\` 674538000000 for one annual period, \`revenue\` = 680985000000, \`sales_revenue\` = 674538000000 and \`other_revenue\` = 6447000000, with \`concept\` \`"derived:revenue-sales_revenue"\`.
- [ ] For the Apple fixture (RFCC only), \`revenue\` and \`sales_revenue\` both equal 383285000000 for the FY ending 2023-09-30, and no \`other_revenue\` entry is returned for that period.
- [ ] A filer tagging only \`SalesRevenueNet\` (pre-ASC 606) resolves \`revenue\` and \`sales_revenue\` to that value.
- [ ] \`other_revenue\` is never emitted with a negative value, or when either side is missing.
- [ ] \`frames_ingest.ingest_frames(client, "other_revenue", "CY2024", store)\` raises \`ValueError\` with zero client calls.
- [ ] \`python tools/edgar_scrubber/test_canonical_concepts.py\`, \`pytest tools/edgar_scrubber\` and \`python tools/test_server.py\` pass.`,
  },
  {
    key: 'calc-linkbase-store',
    title: 'Calculation linkbase: fetch, parse and store how a filing\'s lines add up',
    difficulty: 'hard',
    owns: ['tools/edgar_scrubber/calc_linkbase.py', 'tools/edgar_scrubber/test_calc_linkbase.py', 'tools/edgar_scrubber/fixtures/cal/', 'tools/edgar_scrubber/facts_store.py'],
    body: `## Goal
A tag alone cannot say where a line sits: Walmart files membership fees as \`OtherIncome\` inside total revenue, while for another filer \`OtherIncome\` is non-operating. Every XBRL filing ships a calculation linkbase (\`*_cal.xml\`) that states the roll-ups, e.g. \`Revenues = RevenueFromContractWithCustomerExcludingAssessedTax + OtherIncome\`. Read it and keep it beside the facts.

## Scope
- New \`tools/edgar_scrubber/calc_linkbase.py\` (stdlib only):
  - \`find_cal_url(client, cik, accession)\`: reads the filing's \`index.json\` (\`https://www.sec.gov/Archives/edgar/data/<cik>/<accession-no-dashes>/index.json\`) through \`EdgarClient\` (cache-first) and returns the URL of the file ending \`_cal.xml\`, or \`None\` when the filing has none.
  - \`parse_cal(xml_text)\` returns arcs \`{role, parent, child, weight, order}\`. Concepts are normalized to \`us-gaap:Name\` / \`<prefix>:Name\` from the locator \`href\` fragments. It handles both \`calculationArc\` arcroles, \`summation-item\` (2003) and calc 1.1.
  - \`check_rollups(values, arcs, tolerance=0.005)\` takes \`{concept: value}\` for one period and returns \`{parent, expected, reported, children, ok}\` for each parent whose children are all present. \`ok\` is true when \`|reported − Σ weight·child| ≤ tolerance·|reported|\`.
- \`facts_store.py\`: new table \`calc_arcs(cik, accession, role, parent, child, weight, ord, UNIQUE(cik, accession, role, parent, child))\` via the existing additive-migration pattern. Add \`put_arcs(cik, accession, arcs)\` and \`arcs_for(cik, accession)\`. A read-only open of a store without the table returns \`[]\`, as #250 does for \`filed\`.
- Fixtures in \`tools/edgar_scrubber/fixtures/cal/\`: a hand-written minimal \`*_cal.xml\` in standard XBRL linkbase form with a Walmart-shaped revenue roll-up and one negative-weight arc (cost subtracted), plus a matching \`index.json\`.

## Acceptance
- [ ] \`parse_cal\` on the fixture returns the arc \`us-gaap:Revenues ← us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax\` (weight 1) and \`us-gaap:Revenues ← us-gaap:OtherIncome\` (weight 1), with the role URI from the file.
- [ ] A weight −1 arc is parsed as −1.0, and \`check_rollups\` subtracts it.
- [ ] \`check_rollups\` reports \`ok\` for 674538000000 + 6447000000 against 680985000000, and \`not ok\` when the parent is off by more than 0.5%. A parent missing any child is skipped, not reported.
- [ ] \`find_cal_url\` returns the \`_cal.xml\` URL from the fixture \`index.json\` and \`None\` for an index without one (fake client, no network).
- [ ] \`put_arcs\` twice for one accession leaves one row per arc. A read-only open of a store without \`calc_arcs\` returns \`[]\` from \`arcs_for\`.
- [ ] \`python tools/edgar_scrubber/test_calc_linkbase.py\` and \`pytest tools/edgar_scrubber\` pass offline.`,
  },
  {
    key: 'calc-linkbase-wiring',
    title: 'Store each 10-K/10-Q\'s roll-ups on ingest and flag standard values that do not add up',
    difficulty: 'hard',
    dependsOn: ['revenue-hierarchy', 'calc-linkbase-store'],
    body: `## Goal
Use the filer's own roll-ups to check the standard layer: a standardized value whose filing says it should equal the sum of other lines, and does not, gets flagged rather than trusted.

## Scope
- \`tools/server.py\` \`taxonomy_run\`: after a filing's facts are written, fetch and store its arcs (\`calc_linkbase.find_cal_url\`, \`parse_cal\`, \`FactsStore.put_arcs\`). A filing with no \`_cal.xml\`, or a fetch error, logs one line and does not fail the run.
- \`/api/store/standardized\`: each row gains \`checks: {period_end: {ok, expected, reported}}\` from \`check_rollups\` over that filing's arcs, for every canonical field whose resolved concept is a parent in the arcs. Fields with no applicable roll-up carry no \`checks\` entry.
- \`web-dashboard/index.html\` standardized view: a cell whose check is \`ok: false\` is marked with a hover showing expected vs reported. A cell with no check is unmarked.
- Tests in \`tools/test_server.py\` (fake client serving the #calc-linkbase-store fixtures) and \`node --check\` for inline scripts.

## Acceptance
- [ ] A taxonomy run over a filing whose index lists a \`_cal.xml\` stores its arcs, and \`FactsStore.arcs_for\` returns them for that accession.
- [ ] A filing with no \`_cal.xml\` completes the run with facts written and one log line naming the accession.
- [ ] \`/api/store/standardized\` for a seeded Walmart-shaped filer returns \`checks\` with \`ok: true\` on \`revenue\` for that period, and \`ok: false\` when the seeded total is changed by 1%.
- [ ] A field whose concept is not a parent in the arcs has no \`checks\` key.
- [ ] The standardized view marks an \`ok: false\` cell with a hover naming expected and reported. Inline scripts pass \`node --check\`.
- [ ] \`python tools/test_server.py\` and \`pytest tools/edgar_scrubber\` pass.`,
  },
];
