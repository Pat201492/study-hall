import type { IssueDraft } from '@study-hall/planner';

// Trader-Screener: close the concept-map gaps the #241 graduation comparison
// found on 2026-09-30 (5 of 10 large filers missing a Magic Formula input).

export const drafts: IssueDraft[] = [
  {
    key: 'canonical-aliases-241',
    title: 'Canonical map: add the PP&E and debt tags large filers actually use',
    difficulty: 'standard',
    owns: ['tools/edgar_scrubber/canonical_concepts.py', 'tools/edgar_scrubber/test_canonical_concepts.py'],
    body: `## Goal
The #241 comparison (decision comment on #241) found GOOGL, META and HD with no \`ppe_net\`, and KO and HD with no debt, because they tag concepts the canonical map does not list. Add those aliases so the fields resolve.

## Scope
- \`tools/edgar_scrubber/canonical_concepts.py\`:
  - Append \`us-gaap:PropertyPlantAndEquipmentAndFinanceLeaseRightOfUseAssetAfterAccumulatedDepreciationAndAmortization\` to \`CANONICAL["ppe_net"]\`, after \`PropertyPlantAndEquipmentNet\`.
  - Append \`us-gaap:LongTermDebtAndCapitalLeaseObligations\` to \`CANONICAL["long_term_debt"]\`.
  - Append \`us-gaap:LongTermDebtAndCapitalLeaseObligationsCurrent\` to \`CANONICAL["short_term_debt"]\`.
  - Existing concepts keep their order, so a filer that tags both keeps today's value.
- Tests in \`tools/edgar_scrubber/test_canonical_concepts.py\` with synthetic fact dicts shaped like \`FactsStore.facts_for\` rows.

## Acceptance
- [ ] \`resolve(facts, "ppe_net")\` returns the value of a filer that tags only the finance-lease PP&E concept, with \`concept\` naming it.
- [ ] \`resolve(facts, "long_term_debt")\` and \`resolve(facts, "short_term_debt")\` return values for a filer that tags only the capital-lease debt concepts.
- [ ] A filer tagging both \`PropertyPlantAndEquipmentNet\` and the finance-lease concept for one period still resolves to \`PropertyPlantAndEquipmentNet\`.
- [ ] \`python tools/edgar_scrubber/test_canonical_concepts.py\` and \`pytest tools/edgar_scrubber\` pass.`,
  },
  {
    key: 'magic-inputs-policy-241',
    title: 'Magic Formula inputs: provable zero current debt, and an EBIT fallback for filers with no operating income',
    difficulty: 'hard',
    dependsOn: ['canonical-aliases-241'],
    owns: ['tools/edgar_scrubber/magic_inputs.py', 'tools/edgar_scrubber/test_magic_inputs.py'],
    body: `## Goal
Two policy rules decided on #241 (2026-09-30) so META and JNJ get Magic Formula inputs. Neither substitutes a guessed zero: each applies only when the filer's own tags prove the value.

## Scope
- \`tools/edgar_scrubber/magic_inputs.py\` \`facts_by_field_for\` (or a helper it calls):
  - **Zero current debt:** when \`short_term_debt\` resolves to nothing, and the filer's latest \`us-gaap:LongTermDebt\` equals its \`us-gaap:LongTermDebtNoncurrent\` at the same \`period_end\`, set \`short_term_debt = 0\`. Otherwise it stays missing.
  - **EBIT fallback:** when \`operating_income\` resolves to nothing, use \`us-gaap:IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest\` + \`us-gaap:InterestExpenseNonoperating\` for the same annual period. If either is absent it stays missing.
- \`compute()\`'s result gains \`derived\`: a list naming each rule that fired (\`"short_term_debt=0"\`, \`"ebit=pretax+interest"\`). The CLI report prints it in the \`missing\` column's place when non-empty.
- Tests in \`tools/edgar_scrubber/test_magic_inputs.py\` with synthetic facts.

## Acceptance
- [ ] With \`LongTermDebt == LongTermDebtNoncurrent\` and no current-debt concept, \`short_term_debt\` is 0 and \`derived\` contains \`"short_term_debt=0"\`.
- [ ] When the two differ, or \`LongTermDebt\` is absent, \`short_term_debt\` stays missing and no rule is reported.
- [ ] With no \`OperatingIncomeLoss\` but pretax income 32.58e9 and \`InterestExpenseNonoperating\` 0.97e9 for one annual period, EBIT is 33.55e9 and \`derived\` contains \`"ebit=pretax+interest"\`.
- [ ] A filer that tags \`OperatingIncomeLoss\` never uses the fallback, even when pretax and interest are present.
- [ ] If either fallback input is absent, \`operating_income\` stays in \`missing\`.
- [ ] \`python tools/edgar_scrubber/test_magic_inputs.py\` and \`pytest tools/edgar_scrubber\` pass.`,
  },
];
