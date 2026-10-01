import type { IssueDraft } from '@study-hall/planner';

// Stock-Data-Pipeline: graduate the as-filed XBRL Magic Formula inputs from
// Trader-Screener (accepted on Trader-Screener #241, 2026-09-30).

const ref = 'Decision and comparison data: Pat201492/Trader-Screener#241. Reference implementation: Trader-Screener `tools/edgar_scrubber/canonical_concepts.py` and `magic_inputs.py` at `bd8e53f`.';

export const drafts: IssueDraft[] = [
  {
    key: 'xbrl-fundamentals-module',
    title: 'xbrl_fundamentals: as-filed Magic Formula inputs from SEC companyfacts',
    difficulty: 'hard',
    owns: ['xbrl_fundamentals.py', 'test_xbrl_fundamentals.py', 'fixtures/companyfacts_320193.json'],
    body: `## Goal
Trader-Screener #241 accepted the as-filed XBRL computation of \`roc_greenblatt\` and \`ebit_ev_yield\` as the source of truth, with yfinance as the fallback. This issue ports the reading side into the pipeline as a self-contained module. Wiring it into the fundamentals stage is a separate issue.

## Scope
- New \`xbrl_fundamentals.py\` (stdlib only):
  - \`CANONICAL\`: the seven fields \`operating_income\`, \`assets_current\`, \`liabilities_current\`, \`ppe_net\`, \`long_term_debt\`, \`short_term_debt\`, \`cash\`, with the same ordered us-gaap concept lists as the reference (including the #258 aliases).
  - \`inputs_from_companyfacts(companyfacts)\` returns \`{field: value}\` for the filer's latest 10-K annual period, plus \`period_end\`, \`accession\` and \`filed\` for that 10-K. It also returns \`derived\` and \`missing\` lists.
  - The two #259 rules are ported exactly: \`short_term_debt = 0\` only when \`LongTermDebt == LongTermDebtNoncurrent\` at the same end; EBIT fallback = pretax income + \`InterestExpenseNonoperating\` only when \`OperatingIncomeLoss\` is absent.
- \`fetch_companyfacts(cik)\`: \`https://data.sec.gov/api/xbrl/companyfacts/CIK##########.json\`, with a \`User-Agent\` from the \`SEC_USER_AGENT\` env var. It raises a clear error when that is unset and never uses a placeholder address. Responses are cached under \`DATA_DIR/xbrl_cache/\`, with no more than 10 requests per second.
- Copy \`tools/edgar_scrubber/fixtures/companyfacts_320193.json\` from Trader-Screener into \`fixtures/\` for offline tests.
${ref}

## Acceptance
- [ ] Against the Apple fixture, \`inputs_from_companyfacts\` returns \`operating_income\` 114301000000 for the FY ending 2023-09-30 when restricted to that period, and the latest 10-K's \`accession\` and \`filed\` otherwise.
- [ ] A synthetic filer tagging only \`PropertyPlantAndEquipmentAndFinanceLeaseRightOfUseAssetAfterAccumulatedDepreciationAndAmortization\` resolves \`ppe_net\`.
- [ ] The zero-current-debt and EBIT-fallback rules fire only under the #259 conditions and are named in \`derived\`. Otherwise the field is in \`missing\` and never 0.
- [ ] \`fetch_companyfacts\` with \`SEC_USER_AGENT\` unset raises before any request.
- [ ] A second fetch of a cached CIK makes no network call (test with a patched opener).
- [ ] \`python test_xbrl_fundamentals.py\` passes offline.`,
  },
  {
    key: 'xbrl-magic-formula-wiring',
    title: 'fundamentals stage: prefer as-filed XBRL for roc_greenblatt / ebit_ev_yield, yfinance as fallback',
    difficulty: 'hard',
    dependsOn: ['xbrl-fundamentals-module'],
    body: `## Goal
Serve the accepted as-filed XBRL values for the two Magic Formula legs on \`/api/stocks\`, falling back to today's yfinance computation per ticker, and say which source each row used.

## Scope
- \`fundamentals.py\` \`extract_fundamentals\`: when the ticker's CIK resolves (SEC \`company_tickers.json\`, cached like companyfacts), compute \`roc_greenblatt\` and \`ebit_ev_yield\` with the existing \`data_utils\` functions from \`xbrl_fundamentals.inputs_from_companyfacts\`. Use yfinance \`marketCap\` for EV, and total debt = \`long_term_debt\` + \`short_term_debt\`. If either XBRL leg is None, that leg falls back to the current yfinance computation.
- New record fields: \`magic_source\` (\`"xbrl"\`, \`"yfinance"\` or \`"mixed"\`), \`magic_period_end\`, \`magic_accession\` and \`magic_derived\`. Persisted wherever \`roc_greenblatt\` already is, and passed through on \`/api/stocks\` next to the existing fields in \`api.py\`.
- \`SEC_USER_AGENT\` unset: the XBRL path is skipped for the whole run with one logged warning, and every row falls back to \`"yfinance"\`. The run does not fail.
- Tests in \`test_magic_formula.py\` with a patched companyfacts loader. No network.
${ref}

## Acceptance
- [ ] With XBRL inputs complete, the row's \`roc_greenblatt\` / \`ebit_ev_yield\` equal \`data_utils\` applied to the XBRL values, and \`magic_source == "xbrl"\`.
- [ ] With \`ppe_net\` missing from XBRL, \`roc_greenblatt\` comes from yfinance and \`magic_source == "mixed"\`.
- [ ] With \`SEC_USER_AGENT\` unset, every row is \`"yfinance"\`, the run completes, and exactly one warning is logged.
- [ ] \`/api/stocks\` rows carry \`magic_source\`, \`magic_period_end\`, \`magic_accession\` and \`magic_derived\` (test against the API's JSON loader).
- [ ] \`python test_magic_formula.py\` passes offline.`,
  },
];
