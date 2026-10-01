import type { IssueDraft } from '@study-hall/planner';

// Trader-Screener: make the screener's data visible and its Magic Formula inputs
// legible. Found on the 2026-10-01 end-to-end run against a local pipeline.

export const drafts: IssueDraft[] = [
  {
    key: 'screener-notes-collapse',
    title: 'Screener: fold the seven explainer notes into one collapsed panel so the table is above the fold',
    difficulty: 'standard',
    owns: ['web-dashboard/index.html'],
    body: `## Goal
At 1500×950 the screener renders seven explainer notes between the controls and the table (\`defaultviewnote\`, \`lqnote\`, \`lagnote\`, \`volnote\`, \`risknote\`, \`ivnote\`, \`oflownote\` in \`renderScreener\`), so the first table row starts at the bottom edge of the screen. Keep every note, but let the data lead.

## Scope
- \`web-dashboard/index.html\` \`renderScreener\`: wrap those seven note divs, unchanged, in one \`<details>\` titled "How to read this screener (7 notes)", collapsed by default.
- \`regimeBannerHTML()\` and the discipline cool-down note stay outside it, always visible, because they show live state, not documentation.
- The open/closed state is remembered per viewer in \`localStorage\`. Every read and write is wrapped in try/catch, and the panel defaults to collapsed when storage is unavailable.

## Acceptance
- [ ] All seven notes are inside one \`<details>\` element, collapsed on first load, with their text unchanged.
- [ ] The regime banner and the cool-down note (when active) render outside the \`<details>\`.
- [ ] Opening the panel and re-rendering the screener (e.g. changing a filter) keeps it open, and a reload restores the last state.
- [ ] With \`localStorage\` throwing, the screener still renders and the panel starts collapsed.
- [ ] Inline scripts pass \`node --check\` after extraction.`,
  },
  {
    key: 'screener-magic-provenance',
    title: 'Screener: show Greenblatt ROC and where each Magic Formula input came from',
    difficulty: 'hard',
    dependsOn: ['screener-notes-collapse'],
    owns: ['pipeline-mock/sample_data.py', 'pipeline-mock/test_mock_server.py', 'web-dashboard/demo-data.js'],
    body: `## Goal
Magic Rank is computed from \`roc_greenblatt\` + \`ebit_ev_yield\` (\`computeMagicRanks\`), but the screener shows neither ROC it ranks on (only \`roic\`, the pipeline's NOPAT-based figure), nor whether a value came from the filing or yfinance, nor when a rule changed it. Stock-Data-Pipeline now serves that on \`/api/stocks\`: \`magic_source\` (\`xbrl\` / \`yfinance\` / \`mixed\`), \`magic_period_end\`, \`magic_derived\` (comma list, e.g. \`ebit=pretax+interest\`) and \`roc_nwc_floored\` (working capital floored at 0, pipeline #28).

## Scope
- \`web-dashboard/index.html\` \`SCREENER_COLS\`:
  - New column \`roc_greenblatt\` ("ROC (G)"), percent, numeric sort. Its cell shows a ⌊ marker when \`roc_nwc_floored\` is true.
  - New column \`magic_source\` ("Inputs"): a badge reading *filed* / *yfinance* / *mixed*. The hover tooltip names \`magic_period_end\` and each \`magic_derived\` rule.
  - The existing \`roic\` column's tooltip states it is NOPAT-based and is not what Magic Rank uses.
  - Both new columns are \`tier:'collected'\`, appear in the Columns picker, and are **not** added to \`DEFAULT_CANDIDATES\`: the #47 promotion gate is unchanged.
- \`pipeline-mock/sample_data.py\` rows gain the four fields, with realistic mixes: some \`yfinance\`, one \`mixed\`, some floored, some derived. \`pipeline-mock/test_mock_server.py\` asserts they are present on \`/api/stocks\`.
- \`web-dashboard/demo-data.js\` demo rows gain the same four fields, so demo mode shows the columns populated.

## Acceptance
- [ ] Turning on "ROC (G)" shows \`roc_greenblatt\` as a percent, sorts numerically, and marks floored rows with ⌊ plus a tooltip saying working capital was floored at 0.
- [ ] The "Inputs" badge shows filed / yfinance / mixed, and its tooltip lists the period end and every derived rule. A row with no \`magic_source\` shows "–".
- [ ] The \`roic\` column tooltip says it is not the Magic Rank input.
- [ ] \`DEFAULT_CANDIDATES\` is unchanged, and neither new column is visible until enabled.
- [ ] \`python pipeline-mock/test_mock_server.py\` passes and asserts the four fields on \`/api/stocks\`.
- [ ] Demo mode (\`?demo=1\`) renders both columns populated, and inline scripts pass \`node --check\`.`,
  },
];
