// Vercel serverless function: GET /api/company/:ticker
// (Locally, server.js serves the same route.)

import { getCompany } from '../../lib/company.js';

export default async function handler(req, res) {
  const ticker = req.query?.ticker ?? decodeURIComponent(new URL(req.url, 'http://localhost').pathname.split('/').pop());
  const { status, body } = await getCompany(Array.isArray(ticker) ? ticker[0] : ticker);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  // Cache successful lookups at Vercel's edge for 15 min (and serve stale for a day while refreshing),
  // so repeat visits don't hit the SEC again.
  res.setHeader('Cache-Control', status === 200 ? 'public, s-maxage=900, stale-while-revalidate=86400' : 'no-store');
  res.end(JSON.stringify(body));
}
