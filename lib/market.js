// Market data from Yahoo Finance's public chart endpoint (no API key).
// Everything here is optional: the model still runs if this fails, and the user
// can type a share price in by hand.

const YAHOO = 'https://query1.finance.yahoo.com/v8/finance/chart/';
const cache = new Map();

async function chart(symbol, range, interval) {
  const url = `${YAHOO}${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`;
  const hit = cache.get(url);
  if (hit && Date.now() - hit.t < 15 * 60 * 1000) return hit.v;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (TickerDCF)' } });
  if (!res.ok) throw new Error(`Yahoo ${symbol}: HTTP ${res.status}`);
  const json = await res.json();
  const r = json?.chart?.result?.[0];
  if (!r) throw new Error(`Yahoo ${symbol}: no data`);
  cache.set(url, { t: Date.now(), v: r });
  return r;
}

function weeklyCloses(r) {
  const ts = r.timestamp || [];
  const c = r.indicators?.adjclose?.[0]?.adjclose || r.indicators?.quote?.[0]?.close || [];
  const out = new Map();
  ts.forEach((t, i) => { if (c[i] != null) out.set(Math.floor(t / 86400 / 7), c[i]); });
  return out;
}

/** OLS beta of weekly returns vs. the S&P 500 over ~2 years. */
export function computeBeta(stockCloses, marketCloses) {
  const weeks = [...stockCloses.keys()].filter((w) => marketCloses.has(w)).sort((a, b) => a - b);
  const rs = [], rm = [];
  for (let i = 1; i < weeks.length; i++) {
    const a = weeks[i - 1], b = weeks[i];
    rs.push(stockCloses.get(b) / stockCloses.get(a) - 1);
    rm.push(marketCloses.get(b) / marketCloses.get(a) - 1);
  }
  if (rs.length < 30) return null;
  const mean = (x) => x.reduce((s, v) => s + v, 0) / x.length;
  const ms = mean(rs), mm = mean(rm);
  let cov = 0, varM = 0;
  for (let i = 0; i < rs.length; i++) { cov += (rs[i] - ms) * (rm[i] - mm); varM += (rm[i] - mm) ** 2; }
  return varM ? { beta: cov / varM, observations: rs.length } : null;
}

export async function getMarketData(ticker) {
  const sym = ticker.replace(/\./g, '-');
  const [stock, spx, tnx] = await Promise.allSettled([
    chart(sym, '2y', '1wk'),
    chart('^GSPC', '2y', '1wk'),
    chart('^TNX', '5d', '1d'),
  ]);
  const out = { price: null, fiftyTwoWeekHigh: null, fiftyTwoWeekLow: null, beta: null, betaObs: null, riskFree: null, currency: null, asOf: null };
  if (stock.status === 'fulfilled') {
    const m = stock.value.meta;
    out.price = m.regularMarketPrice ?? null;
    out.currency = m.currency ?? null;
    out.asOf = m.regularMarketTime ? new Date(m.regularMarketTime * 1000).toISOString() : null;
    out.fiftyTwoWeekHigh = m.fiftyTwoWeekHigh ?? null;
    out.fiftyTwoWeekLow = m.fiftyTwoWeekLow ?? null;
    if (out.fiftyTwoWeekHigh == null) {
      const q = stock.value.indicators?.quote?.[0] || {};
      const hi = (q.high || []).slice(-52).filter((v) => v != null);
      const lo = (q.low || []).slice(-52).filter((v) => v != null);
      if (hi.length) out.fiftyTwoWeekHigh = Math.max(...hi);
      if (lo.length) out.fiftyTwoWeekLow = Math.min(...lo);
    }
    if (spx.status === 'fulfilled') {
      const b = computeBeta(weeklyCloses(stock.value), weeklyCloses(spx.value));
      if (b) { out.beta = b.beta; out.betaObs = b.observations; }
    }
  } else {
    out.error = String(stock.reason?.message || stock.reason);
  }
  if (tnx.status === 'fulfilled' && tnx.value.meta?.regularMarketPrice) out.riskFree = tnx.value.meta.regularMarketPrice / 100;
  return out;
}
