// Ticker-to-DCF: tiny zero-dependency server.
// - Serves the static front end from ./public
// - GET /api/company/:ticker -> EDGAR financials + market data (EDGAR has no CORS, so we proxy)

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lookupTicker, getCompanyFacts, extractFinancials } from './lib/edgar.js';
import { getMarketData } from './lib/market.js';

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC = fileURLToPath(new URL('./public/', import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

async function handleCompany(res, rawTicker) {
  if (!/^[A-Za-z0-9.\-]{1,10}$/.test(rawTicker)) return send(res, 400, { error: 'Invalid ticker.' });
  const co = await lookupTicker(rawTicker);
  if (!co) return send(res, 404, { error: `Ticker "${rawTicker.toUpperCase()}" not found in SEC's ticker list.` });
  const [facts, market] = await Promise.all([
    getCompanyFacts(co.cik),
    getMarketData(co.ticker).catch((e) => ({ error: String(e.message || e) })),
  ]);
  const fin = extractFinancials(facts);
  send(res, 200, { ...co, entityName: facts.entityName || co.name, ...fin, market, fetchedAt: new Date().toISOString() });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const m = url.pathname.match(/^\/api\/company\/([^/]+)$/);
    if (m) return await handleCompany(res, decodeURIComponent(m[1]));
    if (url.pathname.startsWith('/api/')) return send(res, 404, { error: 'Not found' });

    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = normalize(join(PUBLIC, rel));
    if (!file.startsWith(PUBLIC.endsWith(sep) ? PUBLIC : PUBLIC + sep)) return send(res, 403, 'Forbidden', 'text/plain');
    const body = await readFile(file).catch(() => null);
    if (!body) return send(res, 404, 'Not found', 'text/plain');
    send(res, 200, body, TYPES[extname(file)] || 'application/octet-stream');
  } catch (err) {
    console.error(err);
    send(res, err.status && err.status < 600 ? (err.status === 403 ? 502 : err.status) : 500, { error: err.message || 'Server error' });
  }
});

server.listen(PORT, () => {
  console.log(`Ticker-to-DCF running at http://localhost:${PORT}`);
  if (!process.env.SEC_USER_AGENT) console.log('Tip: set SEC_USER_AGENT="Your Name you@example.com" (the SEC asks every client to identify itself).');
});
