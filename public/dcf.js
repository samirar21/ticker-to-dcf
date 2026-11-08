// Pure DCF engine — no DOM. Shared by the browser UI and the Node test suite.
//
// Unlevered FCF = EBIT x (1 - tax) + D&A - Capex - change in NWC
// EV        = sum of PV(UFCF) + PV(terminal value)
// Equity    = EV - debt + cash & ST investments - minority interest
// Per share = equity / diluted shares

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const avg = (xs) => { const v = xs.filter((x) => x != null && Number.isFinite(x)); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
const ratio = (a, b) => (a != null && b ? a / b : null);

/** Historical ratios + the base-year snapshot the projection starts from. */
export function analyzeHistory(data) {
  const ys = data.years.filter((y) => y.revenue);
  const last = ys[ys.length - 1];
  const hist = ys.map((y, i) => {
    const prev = ys[i - 1];
    const taxRate = y.taxRate != null ? clamp(y.taxRate, 0, 0.4) : 0.21;
    const dNwc = prev && y.nwc != null && prev.nwc != null ? y.nwc - prev.nwc : null;
    const nopat = y.ebit != null ? y.ebit * (1 - taxRate) : null;
    const ufcf = nopat != null ? nopat + (y.da || 0) - (y.capex || 0) - (dNwc || 0) : null;
    return {
      label: y.label, end: y.end, revenue: y.revenue,
      growth: prev ? y.revenue / prev.revenue - 1 : null,
      ebit: y.ebit, ebitMargin: ratio(y.ebit, y.revenue),
      grossMargin: ratio(y.grossProfit, y.revenue),
      taxRate, nopat, da: y.da, capex: y.capex, dNwc, ufcf,
      ebitda: y.ebit != null ? y.ebit + (y.da || 0) : null,
      daPct: ratio(y.da, y.revenue), capexPct: ratio(y.capex, y.revenue), nwcPct: ratio(y.nwc, y.revenue),
      sbcPct: ratio(y.sbc, y.revenue), netIncome: y.netIncome, actual: true,
    };
  });
  const recent = hist.slice(-3);
  const cagr = (n) => (ys.length > n ? (last.revenue / ys[ys.length - 1 - n].revenue) ** (1 / n) - 1 : null);
  return {
    hist, last,
    stats: {
      cagr3: cagr(3), lastGrowth: hist[hist.length - 1].growth,
      ebitMargin: hist[hist.length - 1].ebitMargin, ebitMargin3: avg(recent.map((h) => h.ebitMargin)),
      taxRate3: avg(recent.map((h) => (h.taxRate))),
      daPct3: avg(recent.map((h) => h.daPct)), capexPct3: avg(recent.map((h) => h.capexPct)),
      nwcPct: hist[hist.length - 1].nwcPct,
    },
  };
}

/** Sensible starting assumptions derived from history + market data. */
export function defaultAssumptions(data) {
  const { last, stats } = analyzeHistory(data);
  const mkt = data.market || {};
  const g1raw = avg([stats.lastGrowth, stats.cagr3]) ?? 0.05;
  const growthY1 = clamp(g1raw, -0.1, 0.4);
  const terminalGrowth = 0.025;

  // WACC build-up (CAPM)
  const riskFree = mkt.riskFree ?? 0.0425;
  const beta = mkt.beta != null ? clamp(mkt.beta, 0.5, 2.5) : 1.0;
  const erp = 0.055;
  const debt = last.debt || 0;
  const rawKd = last.interestExpense && debt ? last.interestExpense / debt : null;
  const preTaxKd = clamp(rawKd ?? riskFree + 0.015, riskFree, 0.12);
  const taxRate = clamp(stats.taxRate3 ?? 0.21, 0.1, 0.3);
  const shares = data.shares?.value || null;
  const price = mkt.price || null;

  const lastEbitda = (last.ebit || 0) + (last.da || 0);
  const ev = price && shares ? price * shares + debt - (last.cash || 0) - (last.stInvestments || 0) + (last.minorityInterest || 0) : null;
  const tradingMultiple = ev && lastEbitda > 0 ? ev / lastEbitda : null;

  return {
    years: 5,
    growthY1: round(growthY1, 3),
    growthYN: round(clamp(growthY1 * 0.5, terminalGrowth + 0.005, 0.1), 3),
    ebitMargin: round(clamp(stats.ebitMargin ?? 0.15, -0.2, 0.7), 3),
    taxRate: round(taxRate, 3),
    daPct: round(stats.daPct3 ?? 0.03, 3),
    capexPct: round(stats.capexPct3 ?? 0.03, 3),
    nwcPct: round(clamp(stats.nwcPct ?? 0, -0.3, 0.4), 3),
    riskFree: round(riskFree, 4), beta: round(beta, 2), erp, preTaxKd: round(preTaxKd, 4),
    useCustomWacc: false, wacc: null,
    terminalGrowth,
    // Default exit multiple: today's EV/EBITDA, capped at 25x so the terminal value isn't just "the market is right".
    exitMultiple: round(clamp(tradingMultiple ?? 12, 5, 25) * 2, 0) / 2,
    midYear: true,
    price, shares, debt, cash: (last.cash || 0) + (last.stInvestments || 0), minority: last.minorityInterest || 0,
    tradingMultiple,
  };
}

const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;

/** WACC from CAPM inputs and market-value weights. */
export function computeWacc(a) {
  const ke = a.riskFree + a.beta * a.erp;
  const kd = a.preTaxKd * (1 - a.taxRate);
  const E = a.price && a.shares ? a.price * a.shares : null;
  const D = a.debt || 0;
  const wE = E ? E / (E + D) : 1;
  const wD = 1 - wE;
  return { ke, kd, preTaxKd: a.preTaxKd, wE, wD, E, D, wacc: wE * ke + wD * kd };
}

export const effectiveWacc = (a) => (a.useCustomWacc && a.wacc != null ? a.wacc : computeWacc(a).wacc);

/** Build the projection and value the company under both terminal-value methods. */
export function runDCF(data, a) {
  const { hist, last, stats } = analyzeHistory(data);
  const wacc = effectiveWacc(a);
  const g = a.terminalGrowth;
  const N = a.years;
  const m0 = hist[hist.length - 1].ebitMargin ?? a.ebitMargin;
  const nwc0 = last.nwc != null ? last.nwc : a.nwcPct * last.revenue;

  const proj = [];
  let rev = last.revenue, nwcPrev = nwc0;
  const baseYear = Number(last.end.slice(0, 4));
  for (let t = 1; t <= N; t++) {
    const w = N === 1 ? 1 : (t - 1) / (N - 1);
    const growth = a.growthY1 + (a.growthYN - a.growthY1) * w;           // linear fade Y1 -> YN
    const ebitMargin = m0 + (a.ebitMargin - m0) * (t / N);                // linear ramp to target
    rev *= 1 + growth;
    const ebit = rev * ebitMargin;
    const tax = Math.max(0, ebit) * a.taxRate;
    const nopat = ebit - tax;
    const da = rev * a.daPct;
    const capex = rev * a.capexPct;
    // NWC glides from today's level to the target % of revenue
    const nwc = rev * (nwc0 / last.revenue + (a.nwcPct - nwc0 / last.revenue) * (t / N));
    const dNwc = nwc - nwcPrev;
    nwcPrev = nwc;
    const ufcf = nopat + da - capex - dNwc;
    const period = a.midYear ? t - 0.5 : t;
    const df = 1 / (1 + wacc) ** period;
    proj.push({
      label: `FY${baseYear + t}E`, revenue: rev, growth, ebit, ebitMargin, taxRate: a.taxRate, tax, nopat,
      da, capex, dNwc, ufcf, ebitda: ebit + da, period, df, pv: ufcf * df, actual: false,
      daPct: a.daPct, capexPct: a.capexPct,
    });
  }

  const sumPv = proj.reduce((s, p) => s + p.pv, 0);
  const final = proj[N - 1];
  const dfN = 1 / (1 + wacc) ** N; // terminal value discounted from end of year N

  const bridge = (ev) => {
    const equity = ev - (a.debt || 0) + (a.cash || 0) - (a.minority || 0);
    return { ev, equity, perShare: a.shares ? equity / a.shares : null };
  };

  // Perpetuity growth (Gordon) method
  const tvG = wacc > g ? (final.ufcf * (1 + g)) / (wacc - g) : NaN;
  const pvTvG = tvG * dfN;
  const gordon = { tv: tvG, pvTv: pvTvG, ...bridge(sumPv + pvTvG) };
  gordon.tvShare = pvTvG / gordon.ev;
  gordon.impliedMultiple = tvG / final.ebitda;

  // Exit multiple method
  const tvM = final.ebitda * a.exitMultiple;
  const pvTvM = tvM * dfN;
  const exit = { tv: tvM, pvTv: pvTvM, ...bridge(sumPv + pvTvM) };
  exit.tvShare = pvTvM / exit.ev;
  exit.impliedGrowth = (tvM * wacc - final.ufcf) / (tvM + final.ufcf);

  const blended = (gordon.perShare + exit.perShare) / 2;
  return { hist, proj, stats, wacc, waccBuild: computeWacc(a), sumPv, gordon, exit, blended, final };
}

export function perShare(data, a, method) {
  const r = runDCF(data, a);
  if (method === 'gordon') return r.gordon.perShare;
  if (method === 'exit') return r.exit.perShare;
  return r.blended;
}

/** 2-D sensitivity grid: rows vary `rowKey`, cols vary `colKey`. WACC is forced custom. */
export function sensitivity(data, a, rowKey, rowVals, colKey, colVals, method) {
  return rowVals.map((rv) => colVals.map((cv) => {
    const x = { ...a, useCustomWacc: true, wacc: effectiveWacc(a), [rowKey]: rv, [colKey]: cv };
    const v = perShare(data, x, method);
    return Number.isFinite(v) ? v : null;
  }));
}

export const steps = (center, step, n = 2) => Array.from({ length: 2 * n + 1 }, (_, i) => round(center + (i - n) * step, 6));

/** Ranges for the football field. */
export function footballField(data, a) {
  const w = effectiveWacc(a);
  const base = { ...a, useCustomWacc: true, wacc: w };
  const range = (grid) => { const v = grid.flat().filter((x) => x != null); return v.length ? [Math.min(...v), Math.max(...v)] : null; };
  const bars = [];
  const mkt = data.market || {};
  if (mkt.fiftyTwoWeekLow && mkt.fiftyTwoWeekHigh) bars.push({ label: '52-week trading range', sub: 'Market', lo: mkt.fiftyTwoWeekLow, hi: mkt.fiftyTwoWeekHigh, kind: 'market' });
  bars.push({ label: 'DCF — perpetuity growth', sub: `WACC ±1%, g ±0.5%`, kind: 'dcf',
    ...toLoHi(range(sensitivity(data, base, 'wacc', [w - 0.01, w, w + 0.01], 'terminalGrowth', [a.terminalGrowth - 0.005, a.terminalGrowth, a.terminalGrowth + 0.005], 'gordon'))) });
  bars.push({ label: 'DCF — exit multiple', sub: `WACC ±1%, multiple ±2.0x`, kind: 'dcf',
    ...toLoHi(range(sensitivity(data, base, 'wacc', [w - 0.01, w, w + 0.01], 'exitMultiple', [a.exitMultiple - 2, a.exitMultiple, a.exitMultiple + 2], 'exit'))) });
  const bear = perShare(data, { ...base, growthY1: a.growthY1 - 0.03, growthYN: a.growthYN - 0.015, ebitMargin: a.ebitMargin - 0.03 });
  const bull = perShare(data, { ...base, growthY1: a.growthY1 + 0.03, growthYN: a.growthYN + 0.015, ebitMargin: a.ebitMargin + 0.03 });
  bars.push({ label: 'Operating scenarios', sub: 'Bear/bull: growth ±3pp, margin ±3pp', kind: 'scenario', lo: Math.min(bear, bull), hi: Math.max(bear, bull) });
  if (a.tradingMultiple) {
    // What the stock is worth at today's EV/EBITDA applied to next year's projected EBITDA (+/-15%)
    const r = runDCF(data, base);
    const fwd = r.proj[0].ebitda;
    const toPx = (mult) => (fwd * mult - (a.debt || 0) + (a.cash || 0) - (a.minority || 0)) / a.shares;
    bars.push({ label: 'Forward EV/EBITDA', sub: `${(a.tradingMultiple * 0.85).toFixed(1)}x–${(a.tradingMultiple * 1.15).toFixed(1)}x NTM EBITDA`, kind: 'market', lo: toPx(a.tradingMultiple * 0.85), hi: toPx(a.tradingMultiple * 1.15) });
  }
  return bars.filter((b) => Number.isFinite(b.lo) && Number.isFinite(b.hi));
}

const toLoHi = (r) => (r ? { lo: r[0], hi: r[1] } : { lo: NaN, hi: NaN });
