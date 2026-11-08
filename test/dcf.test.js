import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDCF, defaultAssumptions, computeWacc, sensitivity, footballField } from '../public/dcf.js';

// A tiny synthetic company: $1,000 revenue, 20% EBIT margin, flat NWC.
const data = {
  years: [
    { label: 'FY2023', end: '2023-12-31', revenue: 900, ebit: 180, da: 30, capex: 40, nwc: 100, taxRate: 0.25, cash: 50, stInvestments: 0, debt: 200, minorityInterest: 0 },
    { label: 'FY2024', end: '2024-12-31', revenue: 1000, ebit: 200, da: 30, capex: 40, nwc: 100, taxRate: 0.25, cash: 100, stInvestments: 0, debt: 200, minorityInterest: 0 },
  ],
  shares: { value: 10 },
  market: { price: 150 },
};

const base = {
  years: 5, growthY1: 0, growthYN: 0, ebitMargin: 0.2, taxRate: 0.25, daPct: 0.03, capexPct: 0.03, nwcPct: 0.1,
  riskFree: 0.04, beta: 1, erp: 0.06, preTaxKd: 0.05, useCustomWacc: true, wacc: 0.1, terminalGrowth: 0.02,
  exitMultiple: 10, midYear: false, price: 150, shares: 10, debt: 200, cash: 100, minority: 0,
};

test('zero-growth company: UFCF equals NOPAT when D&A = capex and NWC is flat', () => {
  const r = runDCF(data, base);
  for (const p of r.proj) {
    assert.ok(Math.abs(p.ufcf - 150) < 1e-9, `UFCF ${p.ufcf}`);
    assert.ok(Math.abs(p.dNwc) < 1e-9);
  }
});

test('Gordon terminal value and bridge match hand calculation', () => {
  const r = runDCF(data, base);
  const annuity = (1 - 1.1 ** -5) / 0.1;
  const pvFcf = 150 * annuity;
  const tv = (150 * 1.02) / (0.1 - 0.02);
  const ev = pvFcf + tv / 1.1 ** 5;
  assert.ok(Math.abs(r.sumPv - pvFcf) < 1e-6);
  assert.ok(Math.abs(r.gordon.tv - tv) < 1e-6);
  assert.ok(Math.abs(r.gordon.ev - ev) < 1e-6);
  assert.ok(Math.abs(r.gordon.perShare - (ev - 200 + 100) / 10) < 1e-6);
});

test('exit multiple method and its implied growth are internally consistent', () => {
  const r = runDCF(data, base);
  const ebitda = 200 + 30;
  assert.ok(Math.abs(r.exit.tv - ebitda * 10) < 1e-9);
  // Plugging the implied growth back into Gordon reproduces the exit TV
  const g = r.exit.impliedGrowth;
  const tvBack = (r.final.ufcf * (1 + g)) / (0.1 - g);
  assert.ok(Math.abs(tvBack - r.exit.tv) < 1e-6);
  // And Gordon's implied multiple round-trips
  assert.ok(Math.abs(r.gordon.impliedMultiple - r.gordon.tv / ebitda) < 1e-12);
});

test('mid-year convention raises value', () => {
  const end = runDCF(data, base).gordon.perShare;
  const mid = runDCF(data, { ...base, midYear: true }).gordon.perShare;
  assert.ok(mid > end);
});

test('value falls as WACC rises and rises with terminal growth', () => {
  const grid = sensitivity(data, base, 'wacc', [0.08, 0.1, 0.12], 'terminalGrowth', [0.01, 0.02, 0.03], 'gordon');
  for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) assert.ok(grid[i][j + 1] > grid[i][j]);
  for (let j = 0; j < 3; j++) for (let i = 0; i < 2; i++) assert.ok(grid[i + 1][j] < grid[i][j]);
});

test('CAPM WACC uses market-value weights', () => {
  const w = computeWacc({ ...base, price: 100, shares: 8, debt: 200 }); // E=800, D=200
  assert.ok(Math.abs(w.ke - 0.1) < 1e-12);
  assert.ok(Math.abs(w.kd - 0.0375) < 1e-12);
  assert.ok(Math.abs(w.wacc - (0.8 * 0.1 + 0.2 * 0.0375)) < 1e-12);
});

test('defaults are sane and the football field produces ordered ranges', () => {
  const a = defaultAssumptions(data);
  assert.equal(a.shares, 10);
  assert.ok(a.terminalGrowth < computeWacc(a).wacc);
  const bars = footballField(data, a);
  assert.ok(bars.length >= 3);
  for (const b of bars) assert.ok(b.lo <= b.hi, b.label);
});
