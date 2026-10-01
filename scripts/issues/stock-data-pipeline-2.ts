import type { IssueDraft } from '@study-hall/planner';

// Stock-Data-Pipeline: three findings from the 2026-10-01 local end-to-end run
// (30 real tickers, fundamentals + model stages, Trader-Screener screener on top).

export const drafts: IssueDraft[] = [
  {
    key: 'roc-floor-nwc',
    title: 'Greenblatt ROC: floor working capital at 0 so capital-light filers rank sensibly',
    difficulty: 'hard',
    owns: ['data_utils.py', 'api.py'],
    body: `## Goal
\`roc_greenblatt\` = EBIT / ((current assets − current liabilities) + net PP&E) goes negative or explodes when working capital is negative, which is common for subscription, insurance and network businesses that collect cash up front. On 2026-10-01 live data: CSCO capital −$0.10B → **−15,368%**, CRM −$5.78B → −144%, UNH −$13.55B → −140%. The screener's Magic rank sorts ROC descending, so these capital-light filers rank near the **bottom**. Decision (2026-10-01): floor working capital at 0.

## Scope
- \`data_utils.roc_greenblatt\`: capital = \`max(current_assets − current_liabilities, 0) + ppe_net\`. When capital ≤ 0 (no PP&E), return None, never a division by ~0. Add \`roc_greenblatt_detail(...)\` returning \`(value, nwc_floored: bool)\`, or an equivalent, so callers can record whether the floor applied.
- \`fundamentals.py\`: both the XBRL and the yfinance path record \`roc_nwc_floored\` (bool) on the row next to \`roc_greenblatt\`.
- \`api.py\`: \`/api/stocks\` passes \`roc_nwc_floored\` through next to \`roc_greenblatt\`.
- \`ebit_ev_yield\` is unchanged.
- Tests in \`test_magic_formula.py\`.

## Acceptance
- [ ] CSCO-shaped inputs (EBIT 15.37e9, CA 38.66e9, CL 41.52e9, PP&E 2.76e9) give \`roc_greenblatt\` = 15.37/2.76×100 (≈ 556.88), with the floor flagged.
- [ ] Positive working capital is unchanged: (100, 300, 100, 50) still gives 40.0, with the floor not flagged.
- [ ] Negative working capital and PP&E 0 give None, not a division error or an infinity.
- [ ] Missing inputs still give None, never 0 (existing test kept).
- [ ] \`/api/stocks\` rows carry \`roc_nwc_floored\` (test against the API JSON loader).
- [ ] \`python test_magic_formula.py\` and \`pytest\` pass.`,
  },
  {
    key: 'xbrl-aliases-nke-orcl',
    title: 'xbrl_fundamentals: net-interest EBIT fallback (NKE) and LongTermNotesPayable alias (ORCL)',
    difficulty: 'standard',
    owns: ['xbrl_fundamentals.py', 'test_xbrl_fundamentals.py'],
    body: `## Goal
Two real filers fell off the as-filed path on the 2026-10-01 run:
- **NKE** tags no \`OperatingIncomeLoss\` and no \`InterestExpenseNonoperating\`, only \`InterestIncomeExpenseNonoperatingNet\` (+$0.05B, net interest *income*). So the EBIT fallback missed it and the row went to yfinance.
- **ORCL** tags long-term debt as \`LongTermNotesPayable\` ($122.34B; plus \`DebtCurrent\` $7.2B this equals its \`DebtLongtermAndShorttermCombinedAmount\` $129.54B). That isn't in the list, so the row went \`mixed\`.

## Scope
- \`xbrl_fundamentals.py\`:
  - Append \`LongTermNotesPayable\` to the \`long_term_debt\` concept list, after the existing ones.
  - Second EBIT fallback: when \`OperatingIncomeLoss\` and \`InterestExpenseNonoperating\` are both absent but pretax income and \`InterestIncomeExpenseNonoperatingNet\` are present for the same annual period, EBIT = pretax − net. A positive net is income, so it is subtracted. \`derived\` records \`"ebit=pretax-net_interest"\`.
  - The existing \`"ebit=pretax+interest"\` rule keeps precedence.
- Tests in \`test_xbrl_fundamentals.py\` with synthetic companyfacts.

## Acceptance
- [ ] A filer with pretax 3.90e9 and \`InterestIncomeExpenseNonoperatingNet\` 0.05e9 (no \`OperatingIncomeLoss\`, no \`InterestExpenseNonoperating\`) gets \`operating_income\` 3.85e9, with \`"ebit=pretax-net_interest"\` in \`derived\`.
- [ ] A negative net (net interest expense) of −0.40e9 with pretax 3.00e9 gives EBIT 3.40e9.
- [ ] When \`InterestExpenseNonoperating\` is present, the existing \`pretax+interest\` rule is used, not the new one.
- [ ] A filer tagging only \`LongTermNotesPayable\` resolves \`long_term_debt\`, and one tagging both it and \`LongTermDebtNoncurrent\` keeps \`LongTermDebtNoncurrent\`.
- [ ] \`python test_xbrl_fundamentals.py\` passes offline.`,
  },
  {
    key: 'api-macro',
    title: 'Serve GET /api/macro (VIX term structure + 10y-3m spread) from FRED',
    difficulty: 'standard',
    dependsOn: ['roc-floor-nwc'],
    body: `## Goal
Trader-Screener's screener regime banner and Macro tab call \`GET /api/macro\` (its issue #39; served by its pipeline mock), but the real pipeline has no such route. On 2026-10-01 it returned **404**, so the macro-regime soft gates never load against the real pipeline. \`fred.py\` already fetches FRED series. Expose them in the shape the dashboard reads.

## Scope
- \`api.py\`: \`GET /api/macro\` returns \`{vix, vixcls, vix9d, vix3m, t10y3m, t10y3m_monthly, asof}\` (the contract in Trader-Screener \`pipeline-mock/sample_data.py\`):
  - \`vix\` and \`vixcls\`: latest FRED \`VIXCLS\`.
  - \`vix3m\`: latest \`VXVCLS\`.
  - \`t10y3m\`: latest \`T10Y3M\`.
  - \`t10y3m_monthly\`: latest \`T10Y3MM\`.
  - \`vix9d\`: \`null\` (no FRED source).
  - \`asof\`: the newest observation date used.
  - A series that fails or is missing is \`null\` on its own; it does not fail the whole response.
- \`FRED_API_KEY\` unset: HTTP 503 with \`{"error": "FRED_API_KEY not set"}\`. The dashboard already treats a failed \`/api/macro\` as "regime unknown".
- Uses \`fred.latest_with_change\` / \`fetch_series\`, so the existing cache and 429 retry apply.
- Tests with \`fred.fetch_series\` patched. No network.

## Acceptance
- [ ] With patched series, \`/api/macro\` returns all seven keys with the patched latest values, and \`asof\` is the newest date among them.
- [ ] One series raising leaves that key \`null\` and the response still HTTP 200.
- [ ] \`FRED_API_KEY\` unset gives HTTP 503 with the error message.
- [ ] \`vix9d\` is present as \`null\`.
- [ ] Tests pass offline under \`pytest\`.`,
  },
];
