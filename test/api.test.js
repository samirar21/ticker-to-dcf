import { test } from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/company/[ticker].js';

function call(ticker) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200, headers: {},
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      end(body) { resolve({ status: this.statusCode, headers: this.headers, body: JSON.parse(body) }); },
    };
    handler({ query: { ticker }, url: `/api/company/${ticker}` }, res);
  });
}

test('rejects malformed tickers without calling the SEC', async () => {
  const r = await call('AAPL;rm -rf');
  assert.equal(r.status, 400);
  assert.equal(r.headers['cache-control'], 'no-store');
});

test('explains a missing SEC_USER_AGENT instead of sending an anonymous request', async () => {
  const saved = process.env.SEC_USER_AGENT;
  delete process.env.SEC_USER_AGENT;
  try {
    const r = await call('AAPL');
    assert.equal(r.status, 500);
    assert.match(r.body.error, /SEC_USER_AGENT/);
  } finally {
    if (saved !== undefined) process.env.SEC_USER_AGENT = saved;
  }
});
