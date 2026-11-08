import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractFinancials, normalizeTicker } from '../lib/edgar.js';

const flow = (start, end, val, filed, form = '10-K') => ({ start, end, val, filed, form });
const inst = (end, val, filed, form = '10-K') => ({ end, val, filed, form });
const usd = (arr) => ({ units: { USD: arr } });

function facts() {
  return {
    entityName: 'TestCo',
    facts: {
      dei: {
        EntityCommonStockSharesOutstanding: { units: { shares: [
          // two share classes reported in the same filing -> summed
          { end: '2025-02-01', val: 600, filed: '2025-02-10', form: '10-K', frame: 'A' },
          { end: '2025-02-01', val: 400, filed: '2025-02-10', form: '10-K', frame: 'B' },
        ] } },
      },
      'us-gaap': {
        // Company switched revenue tags in 2024 — both must be merged.
        SalesRevenueNet: usd([flow('2022-01-01', '2022-12-31', 800, '2023-02-01'), flow('2023-01-01', '2023-12-31', 900, '2024-02-01')]),
        RevenueFromContractWithCustomerExcludingAssessedTax: usd([
          flow('2024-01-01', '2024-12-31', 1000, '2025-02-10'),
          flow('2024-10-01', '2024-12-31', 260, '2025-02-10'), // quarterly fact inside a 10-K: ignored
        ]),
        OperatingIncomeLoss: usd([
          flow('2023-01-01', '2023-12-31', 170, '2024-02-01'),
          flow('2023-01-01', '2023-12-31', 175, '2025-02-10'), // restated in a later 10-K: latest wins
          flow('2024-01-01', '2024-12-31', 200, '2025-02-10'),
        ]),
        PaymentsToAcquirePropertyPlantAndEquipment: usd([flow('2024-01-01', '2024-12-31', 40, '2025-02-10')]),
        AssetsCurrent: usd([inst('2024-12-31', 500, '2025-02-10')]),
        LiabilitiesCurrent: usd([inst('2024-12-31', 300, '2025-02-10')]),
        CashAndCashEquivalentsAtCarryingValue: usd([inst('2024-12-31', 120, '2025-02-10')]),
        LongTermDebtCurrent: usd([inst('2024-12-31', 30, '2025-02-10')]),
        CommercialPaper: usd([inst('2024-12-31', 20, '2025-02-10')]),
        LongTermDebtNoncurrent: usd([inst('2024-12-31', 250, '2025-02-10')]),
      },
    },
  };
}

test('merges revenue across tag changes and ignores quarterly facts', () => {
  const { years } = extractFinancials(facts());
  assert.deepEqual(years.map((y) => y.revenue), [800, 900, 1000]);
  assert.deepEqual(years.map((y) => y.label), ['FY2022', 'FY2023', 'FY2024']);
});

test('prefers the most recently filed (restated) value', () => {
  const { years } = extractFinancials(facts());
  assert.equal(years[1].ebit, 175);
});

test('debt, working capital and shares', () => {
  const { years, shares } = extractFinancials(facts());
  const y = years.at(-1);
  assert.equal(y.debt, 30 + 20 + 250);
  // op. NWC = (500 - 120 cash) - (300 - 50 current debt)
  assert.equal(y.nwc, 380 - 250);
  assert.equal(shares.value, 1000);
});

test('ticker normalization maps class-share dots to SEC dashes', () => {
  assert.equal(normalizeTicker(' brk.b '), 'BRK-B');
});
