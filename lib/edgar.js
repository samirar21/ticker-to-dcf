// SEC EDGAR client + XBRL "companyfacts" -> clean annual financials.
//
// EDGAR docs: https://www.sec.gov/search-filings/edgar-application-programming-interfaces
// The SEC requires a descriptive User-Agent with contact info and allows ~10 req/s.

const DAY = 86400000;

/** The SEC requires every client to identify itself with a name and contact email. */
export function secUserAgent() {
  const ua = (process.env.SEC_USER_AGENT || '').trim();
  return /\S+@\S+\.\S+/.test(ua) ? ua : null;
}

const cache = new Map();
async function cachedJson(url, ttlMs) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.t < ttlMs) return hit.v;
  const ua = secUserAgent();
  if (!ua) throw Object.assign(new Error('Server is missing SEC_USER_AGENT. Set it to "Your Name you@yourdomain.com"; the SEC requires a contact on every request.'), { status: 500 });
  const res = await fetch(url, { headers: { 'User-Agent': ua, 'Accept-Encoding': 'gzip, deflate' } });
  if (!res.ok) {
    const msg = res.status === 403
      ? 'SEC EDGAR refused the request (403). Check that SEC_USER_AGENT holds a real name and email, or wait a minute if the SEC rate limit (10 requests/s) was hit.'
      : res.status === 404 && url.includes('companyfacts')
        ? 'EDGAR has no XBRL financial data for this company.'
        : `SEC request failed (${res.status}).`;
    throw Object.assign(new Error(msg), { status: res.status === 403 ? 502 : res.status });
  }
  const v = await res.json();
  cache.set(url, { t: Date.now(), v });
  return v;
}

export async function lookupTicker(ticker) {
  const map = await cachedJson('https://www.sec.gov/files/company_tickers.json', DAY);
  const want = normalizeTicker(ticker);
  for (const row of Object.values(map)) {
    if (row.ticker.toUpperCase() === want) {
      return { ticker: row.ticker.toUpperCase(), cik: String(row.cik_str).padStart(10, '0'), name: row.title };
    }
  }
  return null;
}

export function normalizeTicker(t) {
  return String(t || '').trim().toUpperCase().replace(/\./g, '-');
}

export async function getCompanyFacts(cik) {
  return cachedJson(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`, 6 * 3600 * 1000);
}

// ---------------------------------------------------------------------------
// Concept maps. Order = preference, but per-year we prefer whichever concept the
// company has used most recently (companies switch tags, e.g. ASC 606 in 2018).

const FLOW = {
  revenue: [
    'RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues',
    'RevenueFromContractWithCustomerIncludingAssessedTax', 'SalesRevenueNet',
    'SalesRevenueGoodsNet', 'SalesRevenueServicesNet', 'RevenuesNetOfInterestExpense',
  ],
  cogs: [
    'CostOfRevenue', 'CostOfGoodsAndServicesSold', 'CostOfGoodsSold', 'CostOfServices',
    'CostOfGoodsAndServiceExcludingDepreciationDepletionAndAmortization',
  ],
  grossProfit: ['GrossProfit'],
  ebit: ['OperatingIncomeLoss'],
  pretaxIncome: [
    'IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest',
    'IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments',
    'IncomeLossFromContinuingOperationsBeforeIncomeTaxesDomestic',
  ],
  incomeTax: ['IncomeTaxExpenseBenefit'],
  netIncome: ['NetIncomeLoss', 'ProfitLoss', 'NetIncomeLossAvailableToCommonStockholdersBasic'],
  da: [
    'DepreciationDepletionAndAmortization', 'DepreciationAmortizationAndAccretionNet',
    'DepreciationAndAmortization', 'DepreciationAmortizationAndOther', 'Depreciation',
  ],
  capex: [
    'PaymentsToAcquirePropertyPlantAndEquipment', 'PaymentsToAcquireProductiveAssets',
    'PaymentsForCapitalImprovements', 'PaymentsToAcquireOtherPropertyPlantAndEquipment',
  ],
  sbc: ['ShareBasedCompensation', 'AllocatedShareBasedCompensationExpense'],
  interestExpense: ['InterestExpense', 'InterestExpenseNonoperating', 'InterestExpenseDebt', 'InterestPaidNet'],
  cfo: ['NetCashProvidedByUsedInOperatingActivities', 'NetCashProvidedByUsedInOperatingActivitiesContinuingOperations'],
};

const INSTANT = {
  cash: ['CashAndCashEquivalentsAtCarryingValue', 'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents', 'Cash'],
  stInvestments: ['MarketableSecuritiesCurrent', 'ShortTermInvestments', 'AvailableForSaleSecuritiesDebtSecuritiesCurrent'],
  currentAssets: ['AssetsCurrent'],
  currentLiabilities: ['LiabilitiesCurrent'],
  debtCurrentTotal: ['DebtCurrent', 'LongTermDebtAndCapitalLeaseObligationsCurrent'],
  ltdCurrent: ['LongTermDebtCurrent'],
  commercialPaper: ['CommercialPaper'],
  shortTermBorrowings: ['ShortTermBorrowings'],
  ltdNoncurrent: ['LongTermDebtNoncurrent', 'LongTermDebtAndCapitalLeaseObligations'],
  ltdTotal: ['LongTermDebt'],
  minorityInterest: ['MinorityInterest'],
};

// ---------------------------------------------------------------------------

function factsFor(facts, concept, unit = 'USD') {
  const c = facts?.facts?.['us-gaap']?.[concept];
  return c?.units?.[unit] || [];
}

const isAnnualForm = (f) => /^10-K/.test(f.form || '') || /^20-F/.test(f.form || '') || /^40-F/.test(f.form || '');
const durationDays = (f) => (Date.parse(f.end) - Date.parse(f.start)) / DAY;
const isAnnualFlow = (f) => f.start && isAnnualForm(f) && durationDays(f) > 340 && durationDays(f) < 390;
const near = (a, b, days = 10) => Math.abs(Date.parse(a) - Date.parse(b)) <= days * DAY;

/** Fiscal-year end dates, oldest -> newest, derived from annual revenue (or EBIT/net income) facts. */
function fiscalYearEnds(facts, maxYears) {
  const ends = [];
  for (const key of ['revenue', 'ebit', 'netIncome']) {
    for (const concept of FLOW[key]) {
      for (const f of factsFor(facts, concept)) if (isAnnualFlow(f)) ends.push(f.end);
    }
    if (ends.length) break;
  }
  ends.sort();
  const out = [];
  for (const e of ends) if (!out.length || !near(out[out.length - 1], e, 20)) out.push(e);
  return out.slice(-maxYears);
}

/** Order concepts so the one used most recently comes first. */
function rankConcepts(facts, concepts, pred) {
  return concepts
    .map((c, i) => {
      const fs = factsFor(facts, c).filter(pred);
      const latest = fs.reduce((m, f) => (f.end > m ? f.end : m), '');
      return { c, i, latest };
    })
    .filter((x) => x.latest)
    .sort((a, b) => (b.latest.localeCompare(a.latest)) || a.i - b.i)
    .map((x) => x.c);
}

function pick(facts, concepts, end, pred) {
  for (const c of rankConcepts(facts, concepts, pred)) {
    const matches = factsFor(facts, c).filter((f) => pred(f) && near(f.end, end));
    if (matches.length) {
      matches.sort((a, b) => (b.filed || '').localeCompare(a.filed || ''));
      return { value: matches[0].val, concept: c };
    }
  }
  return null;
}

const isAnnualInstant = (f) => isAnnualForm(f) && !f.start;

function sharesOutstanding(facts, lastEnd) {
  const dei = facts?.facts?.dei?.EntityCommonStockSharesOutstanding?.units?.shares || [];
  const deiLatest = dei.reduce((m, f) => (f.end > m ? f.end : m), '');
  // Ignore cover-page counts that are stale relative to the latest 10-K (some filers stopped tagging them).
  if (dei.length && Date.parse(deiLatest) > Date.parse(lastEnd) - 400 * DAY) {
    // Multi-class issuers (e.g. GOOGL) report one fact per class in the same filing: sum them.
    const latestFiled = dei.reduce((m, f) => (f.filed > m ? f.filed : m), '');
    const inFiling = dei.filter((f) => f.filed === latestFiled);
    const latestEnd = inFiling.reduce((m, f) => (f.end > m ? f.end : m), '');
    const seen = new Set();
    let total = 0;
    for (const f of inFiling.filter((x) => x.end === latestEnd)) {
      const k = `${f.val}|${f.frame || ''}`;
      if (seen.has(k)) continue;
      seen.add(k);
      total += f.val;
    }
    if (total > 0) return { value: total, asOf: latestEnd, source: 'dei:EntityCommonStockSharesOutstanding' };
  }
  for (const concept of ['WeightedAverageNumberOfDilutedSharesOutstanding', 'WeightedAverageNumberOfSharesOutstandingBasic']) {
    const wa = factsFor(facts, concept, 'shares').filter(isAnnualFlow);
    if (!wa.length) continue;
    wa.sort((a, b) => a.end.localeCompare(b.end) || (a.filed || '').localeCompare(b.filed || ''));
    const f = wa[wa.length - 1];
    if (Date.parse(f.end) < Date.parse(lastEnd) - 400 * DAY) continue; // stale
    return { value: f.val, asOf: f.end, source: `us-gaap:${concept}` };
  }
  return null;
}

/**
 * Turn an EDGAR companyfacts payload into a compact, model-ready history.
 * Returns { years: [...oldest->newest], shares, warnings, sources }.
 */
export function extractFinancials(facts, maxYears = 6) {
  const warnings = [];
  const sources = {};
  const ends = fiscalYearEnds(facts, maxYears);
  if (!ends.length) throw Object.assign(new Error('No annual (10-K) financials found in EDGAR for this company.'), { status: 422 });

  const years = ends.map((end) => {
    const y = { end, label: `FY${end.slice(0, 4)}` };
    for (const [k, concepts] of Object.entries(FLOW)) {
      const r = pick(facts, concepts, end, isAnnualFlow);
      y[k] = r ? r.value : null;
      if (r) sources[k] = r.concept;
    }
    for (const [k, concepts] of Object.entries(INSTANT)) {
      const r = pick(facts, concepts, end, isAnnualInstant);
      y[k] = r ? r.value : null;
      if (r) sources[k] = r.concept;
    }

    // Derived lines
    if (y.cogs == null && y.grossProfit != null && y.revenue != null) y.cogs = y.revenue - y.grossProfit;
    if (y.grossProfit == null && y.cogs != null && y.revenue != null) y.grossProfit = y.revenue - y.cogs;
    if (y.capex != null) y.capex = Math.abs(y.capex);

    // Debt: prefer a reported current-debt total; otherwise sum the pieces.
    let current = y.debtCurrentTotal;
    if (current == null) current = (y.ltdCurrent || 0) + (y.commercialPaper || 0) + (y.shortTermBorrowings || 0);
    let longTerm = y.ltdNoncurrent;
    if (longTerm == null && y.ltdTotal != null) {
      longTerm = y.ltdTotal; // LongTermDebt usually already includes the current portion
      current = (y.commercialPaper || 0) + (y.shortTermBorrowings || 0);
    }
    y.debt = (current || 0) + (longTerm || 0);

    // Operating working capital (ex cash & debt)
    if (y.currentAssets != null && y.currentLiabilities != null) {
      const opCA = y.currentAssets - (y.cash || 0) - (y.stInvestments || 0);
      const opCL = y.currentLiabilities - (current || 0);
      y.nwc = opCA - opCL;
    } else y.nwc = null;

    y.taxRate = y.pretaxIncome > 0 && y.incomeTax != null ? y.incomeTax / y.pretaxIncome : null;
    for (const k of ['debtCurrentTotal', 'ltdCurrent', 'commercialPaper', 'shortTermBorrowings', 'ltdNoncurrent', 'ltdTotal']) delete y[k];
    return y;
  });

  const last = years[years.length - 1];
  if (last.revenue == null) warnings.push('Revenue not found under standard tags; this may be a bank/insurer where a DCF is not appropriate.');
  if (last.ebit == null) warnings.push('Operating income (EBIT) not reported; it is approximated from pre-tax income.');
  if (last.da == null) warnings.push('D&A not found; defaulting to 3% of revenue.');
  if (last.capex == null) warnings.push('Capex not found; defaulting to 3% of revenue.');
  if (last.nwc == null) warnings.push('No classified balance sheet; working-capital change assumed zero.');
  for (const y of years) if (y.ebit == null && y.pretaxIncome != null) y.ebit = y.pretaxIncome + (y.interestExpense || 0);

  const ageDays = (Date.now() - Date.parse(last.end)) / DAY;
  if (ageDays > 450) warnings.push(`Latest 10-K data is from ${last.end}; the company may have stopped filing.`);

  if (last.currentAssets == null && last.cogs == null && last.revenue != null) {
    warnings.unshift('This looks like a financial company (no classified balance sheet). An unlevered FCF DCF isn\'t meaningful for banks and insurers, where debt is raw material rather than financing; a DDM or P/B approach fits better.');
  }
  const shares = sharesOutstanding(facts, last.end);
  if (!shares) warnings.push('Shares outstanding not found; enter them manually.');

  return { years, shares, warnings, sources };
}
