# Ticker → DCF

Type a ticker. The app pulls historical financials from the 10-K filings in **SEC EDGAR**, projects unlevered free cash flow, and values the company two ways (perpetuity growth and exit multiple). Every assumption is a slider, and the sensitivity tables, football field and step-by-step walkthrough update live.

No API keys, no dependencies, no build step: Node 18+ and a browser.

```bash
git clone https://github.com/samirar21/ticker-to-dcf && cd ticker-to-dcf
```

```bash
SEC_USER_AGENT="Your Name you@example.com" npm start
```

Then open http://localhost:3000 (or deep-link straight to a company: `http://localhost:3000/#AAPL`).

> The SEC asks every API client to identify itself with a name and email in the User-Agent. Set `SEC_USER_AGENT` to yours.

## What it does

| Step | How |
| --- | --- |
| **Ticker → company** | Looks up the CIK in SEC's `company_tickers.json` |
| **Financials** | Pulls `data.sec.gov/api/xbrl/companyfacts`, keeps annual 10-K facts (350–390-day periods), dedupes restatements (latest filing wins), and merges revenue across tag changes (e.g. `SalesRevenueNet` → `RevenueFromContractWithCustomer…` after ASC 606) |
| **Market data** | Price, 52-week range and 10Y Treasury yield from Yahoo Finance's public chart API. **Beta is computed by regression**: 2 years of weekly returns vs. the S&P 500 |
| **Projections** | 5 years. Revenue growth fades linearly from Year 1 to Year 5, EBIT margin ramps to target, D&A and capex as % of revenue, NWC glides to a target % of revenue |
| **WACC** | CAPM cost of equity (Rf + β × ERP), cost of debt = interest expense ÷ debt, market-value weights. Override with the WACC slider at any time |
| **Terminal value** | Gordon growth *and* exit EV/EBITDA, each cross-checked with its implied counterpart (implied multiple / implied perpetual growth) |
| **Output** | EV → equity bridge, per-share value, WACC × g and WACC × multiple sensitivity grids, football field, CSV export, and a narrated walkthrough |

## Interview story: how to walk through it

1. **Unlevered FCF** = EBIT × (1 − t) + D&A − capex − ΔNWC. Unlevered because we value the whole firm, so we discount at WACC and subtract net debt at the end.
2. **Discount** each year at WACC (mid-year convention by default, since cash arrives through the year).
3. **Terminal value**: Gordon growth `FCF × (1+g) / (WACC − g)`, cross-checked against an exit multiple. If the market multiple implies 6–7% *perpetual* growth, the market is pricing in a long runway, or your WACC is too high.
4. **Bridge**: EV − debt + cash − minority interest = equity value; ÷ diluted shares.
5. **Sanity checks**: terminal value is usually 60–80% of EV, which is why the sensitivity table matters more than the point estimate.

## Limitations (good to say out loud in an interview)

- Uses fiscal-year 10-K data, not LTM, and values as of the latest fiscal year end (no stub period).
- Debt excludes operating leases; shares are basic shares outstanding from the 10-K cover page (or diluted weighted average), so there's no treasury-stock-method dilution.
- Not suitable for banks/insurers (the app warns you). Use a DDM or P/B for those.
- XBRL tagging varies by company; equity-bridge inputs (price, shares, debt, cash) are editable if something looks off.

## Project layout

```
server.js          zero-dependency HTTP server + /api/company/:ticker (EDGAR has no CORS, so we proxy)
lib/edgar.js       ticker → CIK, companyfacts → clean annual financials
lib/market.js      price, 52-week range, regression beta, risk-free rate
public/dcf.js      pure DCF engine (shared by browser + tests)
public/app.js      UI: sliders, sensitivity tables, football field, walkthrough
test/              node:test suite: DCF math checked by hand, XBRL edge cases
```

```bash
npm test
```

Data: SEC EDGAR (public domain) · Yahoo Finance. For education only, not investment advice.
