// Ticker-to-DCF: tiny zero-dependency server.
// - Serves the static front end from ./public
// - GET /api/company/:ticker -> EDGAR financials + market data (EDGAR has no CORS, so we proxy)

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCompany } from './lib/company.js';
import { secUserAgent } from './lib/edgar.js';

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC = fileURLToPath(new URL('./public/', import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const m = url.pathname.match(/^\/api\/company\/([^/]+)$/);
    if (m) {
      const { status, body } = await getCompany(decodeURIComponent(m[1]));
      return send(res, status, body);
    }
    if (url.pathname.startsWith('/api/')) return send(res, 404, { error: 'Not found' });

    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = normalize(join(PUBLIC, rel));
    if (!file.startsWith(PUBLIC.endsWith(sep) ? PUBLIC : PUBLIC + sep)) return send(res, 403, 'Forbidden', 'text/plain');
    const body = await readFile(file).catch(() => null);
    if (!body) return send(res, 404, 'Not found', 'text/plain');
    send(res, 200, body, TYPES[extname(file)] || 'application/octet-stream');
  } catch (err) {
    console.error(err);
    send(res, 500, { error: err.message || 'Server error' });
  }
});

server.listen(PORT, () => {
  console.log(`Ticker-to-DCF running at http://localhost:${PORT}`);
  if (!secUserAgent()) console.warn('Warning: SEC_USER_AGENT is not set. The SEC requires a name and email, e.g. SEC_USER_AGENT="Jane Doe jane@example.com" npm start');
});
