// One entry point for "ticker -> everything the front end needs".
// Used by both the local Node server (server.js) and the Vercel function (api/company/[ticker].js).

import { lookupTicker, getCompanyFacts, extractFinancials } from './edgar.js';
import { getMarketData } from './market.js';

/** Returns { status, body } and never throws. */
export async function getCompany(rawTicker) {
  try {
    const ticker = String(rawTicker || '').trim();
    if (!/^[A-Za-z0-9.\-]{1,10}$/.test(ticker)) return { status: 400, body: { error: 'Invalid ticker.' } };
    const co = await lookupTicker(ticker);
    if (!co) return { status: 404, body: { error: `Ticker "${ticker.toUpperCase()}" not found in SEC's ticker list.` } };
    const [facts, market] = await Promise.all([
      getCompanyFacts(co.cik),
      getMarketData(co.ticker).catch((e) => ({ error: String(e.message || e) })),
    ]);
    const fin = extractFinancials(facts);
    return { status: 200, body: { ...co, entityName: facts.entityName || co.name, ...fin, market, fetchedAt: new Date().toISOString() } };
  } catch (err) {
    console.error(err);
    const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
    return { status, body: { error: err.message || 'Server error' } };
  }
}
