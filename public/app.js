import { defaultAssumptions, runDCF, sensitivity, steps, footballField, computeWacc, effectiveWacc, clamp } from './dcf.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

let data = null;      // payload from /api/company
let defaults = null;  // starting assumptions
let a = null;         // live assumptions
let method = 'blended';
let sensMode = 'price';
let U = 1e9, UL = '$B';

// ---------- formatting ----------
const pct = (v, d = 1) => (v == null || !Number.isFinite(v) ? '—' : `${(v * 100).toFixed(d)}%`);
const px = (v) => (v == null || !Number.isFinite(v) ? '—' : `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const mult = (v) => (v == null || !Number.isFinite(v) ? '—' : `${v.toFixed(1)}x`);
const num = (v, d = 1) => {
  if (v == null || !Number.isFinite(v)) return '—';
  const s = Math.abs(v / U).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
  return v < 0 ? `(${s})` : s;
};
const big = (v) => {
  if (v == null || !Number.isFinite(v)) return '—';
  const abs = Math.abs(v), sign = v < 0 ? '-' : '';
  if (abs >= 1e12) return `${sign}$${(abs / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(1)}B`;
  return `${sign}$${(abs / 1e6).toFixed(0)}M`;
};

// ---------- slider definitions ----------
const CTL = {
  wacc:           { label: 'WACC', min: 0.04, max: 0.18, step: 0.001, fmt: (v) => pct(v, 1) },
  riskFree:       { label: 'Risk-free rate (10Y UST)', min: 0, max: 0.08, step: 0.0005, fmt: (v) => pct(v, 2) },
  beta:           { label: 'Levered beta', min: 0.3, max: 3, step: 0.01, fmt: (v) => v.toFixed(2) },
  erp:            { label: 'Equity risk premium', min: 0.03, max: 0.09, step: 0.0025, fmt: (v) => pct(v, 2) },
  preTaxKd:       { label: 'Pre-tax cost of debt', min: 0.01, max: 0.14, step: 0.0005, fmt: (v) => pct(v, 2) },
  terminalGrowth: { label: 'Terminal growth (g)', min: 0, max: 0.05, step: 0.0025, fmt: (v) => pct(v, 2) },
  exitMultiple:   { label: 'Exit EV/EBITDA', min: 3, max: 40, step: 0.5, fmt: (v) => `${v.toFixed(1)}x` },
  growthY1:       { label: 'Revenue growth — Year 1', min: -0.3, max: 0.8, step: 0.005, fmt: (v) => pct(v, 1) },
  growthYN:       { label: 'Revenue growth — Year 5', min: -0.1, max: 0.3, step: 0.005, fmt: (v) => pct(v, 1) },
  ebitMargin:     { label: 'EBIT margin — Year 5', min: -0.3, max: 0.8, step: 0.005, fmt: (v) => pct(v, 1) },
  taxRate:        { label: 'Tax rate', min: 0, max: 0.4, step: 0.005, fmt: (v) => pct(v, 1) },
  daPct:          { label: 'D&A % revenue', min: 0, max: 0.3, step: 0.001, fmt: (v) => pct(v, 1) },
  capexPct:       { label: 'Capex % revenue', min: 0, max: 0.4, step: 0.001, fmt: (v) => pct(v, 1) },
  nwcPct:         { label: 'Net working capital % revenue — Year 5', min: -0.4, max: 0.5, step: 0.005, fmt: (v) => pct(v, 1) },
};

function hintFor(key, r) {
  const s = r.stats;
  switch (key) {
    case 'wacc': return a.useCustomWacc ? 'Manual override · <a href="#" data-act="capm">use CAPM</a>' : 'From CAPM build-up below';
    case 'beta': return data.market?.beta != null ? `Regression: ${data.market.beta.toFixed(2)} (${data.market.betaObs} weekly obs. vs S&P 500)` : 'No market data, so set to 1.0';
    case 'riskFree': return data.market?.riskFree != null ? `Live 10Y yield: ${pct(data.market.riskFree, 2)}` : '';
    case 'preTaxKd': return data.years.at(-1).interestExpense ? 'Interest expense ÷ total debt' : 'Rf + 150bp (no interest expense found)';
    case 'exitMultiple': return a.tradingMultiple ? `Trading today at ${mult(a.tradingMultiple)} LTM EBITDA` : '';
    case 'growthY1': return `LTM ${pct(s.lastGrowth)} · 3Y CAGR ${pct(s.cagr3)}`;
    case 'growthYN': return 'Growth fades linearly from Year 1 to Year 5';
    case 'ebitMargin': return `LTM ${pct(s.ebitMargin)} · 3Y avg ${pct(s.ebitMargin3)}; ramps linearly`;
    case 'taxRate': return `3Y avg effective ${pct(s.taxRate3)}`;
    case 'daPct': return `3Y avg ${pct(s.daPct3)}`;
    case 'capexPct': return `3Y avg ${pct(s.capexPct3)}`;
    case 'nwcPct': return `Today ${pct(s.nwcPct)}, so the yearly change in NWC is a cash flow`;
    case 'terminalGrowth': return 'Keep below long-run nominal GDP (~4%)';
    default: return '';
  }
}

function buildControls() {
  for (const el of $$('.ctl')) {
    const key = el.dataset.key, c = CTL[key];
    el.innerHTML = `<div class="ctl-top"><label for="s-${key}">${c.label}</label><output id="o-${key}"></output></div>
      <input type="range" id="s-${key}" min="${c.min}" max="${c.max}" step="${c.step}" />
      <div class="ctl-hint" id="h-${key}"></div>`;
    $('input', el).addEventListener('input', (e) => {
      const v = Number(e.target.value);
      if (key === 'wacc') { a.useCustomWacc = true; a.wacc = v; }
      else {
        a[key] = v;
        if (['riskFree', 'beta', 'erp', 'preTaxKd', 'taxRate'].includes(key) && !a.useCustomWacc) a.wacc = null;
      }
      schedule();
    });
  }
  document.addEventListener('click', (e) => {
    if (e.target.matches('[data-act="capm"]')) { e.preventDefault(); a.useCustomWacc = false; schedule(); }
  });
}

function syncControls(r) {
  for (const key of Object.keys(CTL)) {
    const input = $(`#s-${key}`); if (!input) continue;
    const v = key === 'wacc' ? r.wacc : a[key];
    if (document.activeElement !== input) input.value = v;
    $(`#o-${key}`).textContent = CTL[key].fmt(v);
    $(`#h-${key}`).innerHTML = hintFor(key, r);
  }
}

// ---------- rendering ----------
let raf = 0;
const schedule = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(render); };

function headline(r) { return method === 'gordon' ? r.gordon.perShare : method === 'exit' ? r.exit.perShare : r.blended; }

function render() {
  if (a.terminalGrowth >= effectiveWacc(a) - 0.005) a.terminalGrowth = Math.max(0, Math.round((effectiveWacc(a) - 0.0075) / 0.0025) * 0.0025);
  const r = runDCF(data, a);
  syncControls(r);
  const value = headline(r);
  const up = a.price ? value / a.price - 1 : null;
  $('#k-price').textContent = px(a.price);
  $('#k-value').textContent = px(value);
  $('#k-method').textContent = `(${method === 'gordon' ? 'perpetuity' : method === 'exit' ? 'exit multiple' : 'blended'})`;
  const ku = $('#k-upside');
  ku.textContent = up == null ? '—' : `${up >= 0 ? '+' : ''}${pct(up)}`;
  ku.className = up == null ? '' : up >= 0 ? 'pos' : 'neg';
  $('#k-wacc').textContent = pct(r.wacc);
  renderWaccTable(r);
  renderFootball(r, value);
  renderSensitivity(r);
  renderSummary(r);
  renderTable(r);
  renderWalk(r, value, up);
}

function renderWaccTable(r) {
  const w = computeWacc(a);
  $('#wacc-table').innerHTML = `<table>
    <tr><td>Cost of equity = Rf + β × ERP</td><td>${pct(w.ke, 2)}</td></tr>
    <tr><td>After-tax cost of debt</td><td>${pct(w.kd, 2)}</td></tr>
    <tr><td>Equity weight (E / (D+E))</td><td>${pct(w.wE)}</td></tr>
    <tr><td>Debt weight</td><td>${pct(w.wD)}</td></tr>
    <tr class="tot"><td>WACC (CAPM)</td><td>${pct(w.wacc, 2)}</td></tr></table>`;
}

function renderFootball(r, value) {
  const bars = footballField(data, a);
  const marks = [a.price, value].filter((v) => v != null && Number.isFinite(v));
  const all = bars.flatMap((b) => [b.lo, b.hi]).concat(marks).filter((v) => Number.isFinite(v));
  if (!all.length) { $('#football').innerHTML = '<p class="hint">Not enough data.</p>'; return; }
  let lo = Math.min(...all), hi = Math.max(...all);
  const pad = (hi - lo) * 0.08 || Math.abs(hi) * 0.1 || 1;
  lo = Math.max(lo < 0 ? lo - pad : 0, lo - pad); hi += pad;
  const tick = niceStep((hi - lo) / 5);
  lo = Math.floor(lo / tick) * tick; hi = Math.ceil(hi / tick) * tick;
  const pos = (v) => ((v - lo) / (hi - lo)) * 100;
  const ticks = []; for (let t = lo; t <= hi + 1e-9; t += tick) ticks.push(t);

  $('#football').innerHTML = `
    <div class="ff-rows">
      ${bars.map((b) => `
        <div class="ff-row">
          <div class="ff-label"><strong>${b.label}</strong><span>${b.sub}</span></div>
          <div class="ff-track">
            ${ticks.map((t) => `<i class="ff-grid" style="left:${pos(t)}%"></i>`).join('')}
            <div class="ff-bar ${b.kind}" style="left:${pos(b.lo)}%;width:${Math.max(0.6, pos(b.hi) - pos(b.lo))}%">
              <span class="lo">${px(b.lo)}</span><span class="hi">${px(b.hi)}</span>
            </div>
          </div>
        </div>`).join('')}
      <div class="ff-row axis"><div class="ff-label"></div><div class="ff-track">
        ${ticks.map((t) => `<span class="ff-tick" style="left:${pos(t)}%">$${t.toLocaleString(undefined, { maximumFractionDigits: tick < 1 ? 2 : 0 })}</span>`).join('')}
      </div></div>
      <div class="ff-overlay"><div class="ff-label"></div><div class="ff-track">
        ${a.price ? `<div class="ff-line price" style="left:${pos(a.price)}%"><b>Current ${px(a.price)}</b></div>` : ''}
        ${Number.isFinite(value) ? `<div class="ff-line value" style="left:${pos(value)}%"><b>DCF ${px(value)}</b></div>` : ''}
      </div></div>
    </div>
    <div class="legend"><span class="sw market"></span>Market-based <span class="sw dcf"></span>Intrinsic (DCF) <span class="sw scenario"></span>Scenario <span class="sw line-price"></span>Current price <span class="sw line-value"></span>Base case</div>`;
}

function niceStep(raw) {
  const p = 10 ** Math.floor(Math.log10(raw || 1));
  const n = raw / p;
  return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * p;
}

function renderSensitivity(r) {
  const w = r.wacc;
  const waccs = steps(w, 0.005);
  const gs = steps(a.terminalGrowth, 0.0025);
  const ms = steps(a.exitMultiple, 1);
  const gGrid = sensitivity(data, a, 'wacc', waccs, 'terminalGrowth', gs, 'gordon');
  const mGrid = sensitivity(data, a, 'wacc', waccs, 'exitMultiple', ms, 'exit');
  $('#sens-g').innerHTML = sensTable(waccs, gs, gGrid, (v) => pct(v, 2));
  $('#sens-m').innerHTML = sensTable(waccs, ms, mGrid, (v) => `${v.toFixed(1)}x`);
}

function sensTable(rows, cols, grid, colFmt) {
  const cell = (v, i, j) => {
    const center = i === 2 && j === 2;
    if (v == null) return `<td class="${center ? 'center' : ''}">n/m</td>`;
    const up = a.price ? v / a.price - 1 : null;
    const t = up == null ? 0 : clamp(up, -0.6, 0.6) / 0.6;
    const bg = t >= 0 ? `rgba(var(--pos-rgb), ${(t * 0.45).toFixed(3)})` : `rgba(var(--neg-rgb), ${(-t * 0.45).toFixed(3)})`;
    const txt = sensMode === 'upside' && up != null ? `${up >= 0 ? '+' : ''}${(up * 100).toFixed(0)}%` : px(v);
    return `<td class="${center ? 'center' : ''}" style="background:${bg}">${txt}</td>`;
  };
  return `<table class="sens"><thead><tr><th></th>${cols.map((c) => `<th>${colFmt(c)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((rv, i) => `<tr><th>${pct(rv, 1)}</th>${grid[i].map((v, j) => cell(v, i, j)).join('')}</tr>`).join('')}</tbody></table>`;
}

function renderSummary(r) {
  const col = (title, m, extra) => `
    <div class="sum-col ${method === (title.startsWith('Perp') ? 'gordon' : 'exit') ? 'on' : ''}">
      <h4>${title}</h4>
      <dl>
        <dt>PV of FCF (Y1–Y${a.years})</dt><dd>${big(r.sumPv)}</dd>
        <dt>Terminal value</dt><dd>${big(m.tv)}</dd>
        <dt>PV of terminal value</dt><dd>${big(m.pvTv)}</dd>
        <dt class="b">Enterprise value</dt><dd class="b">${big(m.ev)}</dd>
        <dt>− Debt</dt><dd>${big(a.debt)}</dd>
        <dt>+ Cash &amp; ST investments</dt><dd>${big(a.cash)}</dd>
        ${a.minority ? `<dt>− Minority interest</dt><dd>${big(a.minority)}</dd>` : ''}
        <dt class="b">Equity value</dt><dd class="b">${big(m.equity)}</dd>
        <dt>÷ Diluted shares</dt><dd>${a.shares ? (a.shares / 1e6).toLocaleString(undefined, { maximumFractionDigits: 0 }) + 'M' : '—'}</dd>
        <dt class="b big">Implied share price</dt><dd class="b big">${px(m.perShare)}</dd>
        <dt>TV as % of EV</dt><dd class="${m.tvShare > 0.8 ? 'warn' : ''}">${pct(m.tvShare, 0)}</dd>
        ${extra}
      </dl>
    </div>`;
  $('#summary').innerHTML =
    col('Perpetuity growth', r.gordon, `<dt>Implied exit multiple</dt><dd>${mult(r.gordon.impliedMultiple)}</dd>`) +
    col('Exit multiple', r.exit, `<dt>Implied perpetual growth</dt><dd class="${r.exit.impliedGrowth > 0.04 ? 'warn' : ''}">${pct(r.exit.impliedGrowth, 2)}</dd>`);
}

const ROWS = [
  ['Revenue', (c) => num(c.revenue), 'b'],
  ['  % growth', (c) => pct(c.growth), 'sub'],
  ['EBIT', (c) => num(c.ebit), ''],
  ['  % margin', (c) => pct(c.ebitMargin), 'sub'],
  ['− Taxes', (c) => num(c.ebit != null ? -(c.ebit - c.nopat) : null), ''],
  ['  tax rate', (c) => pct(c.taxRate), 'sub'],
  ['NOPAT', (c) => num(c.nopat), 'b'],
  ['+ D&A', (c) => num(c.da), ''],
  ['− Capex', (c) => num(c.capex != null ? -c.capex : null), ''],
  ['− Increase in NWC', (c) => num(c.dNwc != null ? -c.dNwc : null), ''],
  ['Unlevered FCF', (c) => num(c.ufcf), 'b hl'],
  ['  FCF margin', (c) => pct(c.ufcf != null ? c.ufcf / c.revenue : null), 'sub'],
  ['Discount period', (c) => (c.actual ? '' : c.period.toFixed(1)), 'sub'],
  ['Discount factor', (c) => (c.actual ? '' : c.df.toFixed(3)), 'sub'],
  ['PV of UFCF', (c) => (c.actual ? '' : num(c.pv)), 'b'],
];

function renderTable(r) {
  const cols = [...r.hist.slice(-3), ...r.proj];
  $('#model-table').innerHTML = `<thead><tr><th>${UL}</th>${cols.map((c) => `<th class="${c.actual ? 'act' : 'proj'}">${c.label}${c.actual ? '<small>Actual</small>' : '<small>Projected</small>'}</th>`).join('')}</tr></thead>
    <tbody>${ROWS.map(([label, f, cls]) => `<tr class="${cls}"><td>${label.trim()}</td>${cols.map((c) => `<td class="${c.actual ? 'act' : 'proj'}">${f(c)}</td>`).join('')}</tr>`).join('')}</tbody>`;
  $('#units-note').textContent = `${UL === '$B' ? 'US$ billions' : 'US$ millions'}. Actuals are from 10-K XBRL facts. Historical UFCF uses each year's effective tax rate. ${a.midYear ? 'Mid-year discounting is on; the terminal value is discounted from the end of Year ' + a.years + '.' : 'End-of-year discounting.'}`;
}

function renderWalk(r, value, up) {
  const h = r.hist.at(-1), f = r.proj.at(-1), w = computeWacc(a);
  const revCagr = (f.revenue / h.revenue) ** (1 / a.years) - 1;
  const tvShareWarn = r.gordon.tvShare > 0.75 ? ` That's high; most of the value sits in the terminal year, so the terminal growth rate and WACC matter far more than the near-term forecast.` : '';
  const items = [
    `<b>Start from the 10-K.</b> ${data.entityName} did ${big(h.revenue)} of revenue in ${h.label} at a ${pct(h.ebitMargin)} EBIT margin, and turned ${big(h.ufcf)} of that into unlevered free cash flow.`,
    `<b>Project unlevered free cash flow for ${a.years} years.</b> Revenue grows ${pct(a.growthY1)} in Year 1 and fades to ${pct(a.growthYN)} by Year ${a.years} (${pct(revCagr)} CAGR), reaching ${big(f.revenue)}. EBIT margin moves from ${pct(h.ebitMargin)} to ${pct(a.ebitMargin)}. UFCF = EBIT × (1 − ${pct(a.taxRate, 0)} tax) + D&A − capex − increase in NWC, which gives ${big(f.ufcf)} in Year ${a.years}.`,
    `<b>Discount at WACC.</b> ${a.useCustomWacc ? `I'm using a ${pct(r.wacc)} WACC (a manual override; CAPM gives ${pct(w.wacc)}).` : `Cost of equity is ${pct(a.riskFree, 2)} risk-free + ${a.beta.toFixed(2)} beta × ${pct(a.erp, 1)} ERP = ${pct(w.ke)}. After-tax cost of debt is ${pct(w.kd)}. At market-value weights of ${pct(w.wE, 0)} equity and ${pct(w.wD, 0)} debt, WACC is ${pct(r.wacc)}.`} The present value of the forecast cash flows is ${big(r.sumPv)}.`,
    `<b>Terminal value, two ways.</b> Perpetuity growth: ${big(f.ufcf)} × (1 + ${pct(a.terminalGrowth, 1)}) ÷ (${pct(r.wacc)} − ${pct(a.terminalGrowth, 1)}) = ${big(r.gordon.tv)}, which implies ${mult(r.gordon.impliedMultiple)} EBITDA. Exit multiple: ${mult(a.exitMultiple)} × Year-${a.years} EBITDA of ${big(f.ebitda)} = ${big(r.exit.tv)}, which implies ${pct(r.exit.impliedGrowth, 1)} growth forever. The PV of the terminal value is ${pct(r.gordon.tvShare, 0)} of EV under the perpetuity method.${tvShareWarn}`,
    `<b>Bridge from enterprise value to equity value.</b> EV − ${big(a.debt)} debt + ${big(a.cash)} cash${a.minority ? ` − ${big(a.minority)} minority interest` : ''} = equity value. Divided by ${a.shares ? (a.shares / 1e6).toLocaleString(undefined, { maximumFractionDigits: 0 }) + 'M' : 'an unknown number of'} shares${a.shares ? '' : ' (enter a share count under Equity bridge inputs)'}, that's ${px(r.gordon.perShare)} (perpetuity) and ${px(r.exit.perShare)} (exit multiple).`,
    `<b>So what?</b> The ${method === 'blended' ? 'blended' : method === 'gordon' ? 'perpetuity' : 'exit-multiple'} value is ${px(value)}${up != null ? ` against a ${px(a.price)} share price: ${up >= 0 ? 'upside' : 'downside'} of ${pct(Math.abs(up))}` : ''}. ${Math.abs(r.gordon.perShare / r.exit.perShare - 1) > 0.25 ? `The two methods disagree by more than 25%. The exit multiple needs ${pct(r.exit.impliedGrowth, 1)} perpetual growth to hold, which tells you the market is pricing in more growth than a ${pct(a.terminalGrowth, 1)} terminal rate.` : 'The two methods roughly agree, which is a good sign the terminal assumptions are internally consistent.'} The sensitivity tables show how much of that conclusion depends on WACC and terminal growth.`,
  ];
  $('#walk').innerHTML = items.map((t) => `<li>${t}</li>`).join('');
}

// ---------- CSV ----------
function downloadCsv() {
  const r = runDCF(data, a);
  const cols = [...r.hist.slice(-3), ...r.proj];
  const raw = (v) => (v == null || !Number.isFinite(v) ? '' : v);
  const lines = [
    [`${data.ticker} DCF (${UL === '$B' ? 'USD bn' : 'USD mm'})`, ...cols.map((c) => c.label)],
    ...[['Revenue', 'revenue'], ['EBIT', 'ebit'], ['NOPAT', 'nopat'], ['D&A', 'da'], ['Capex', 'capex'], ['Increase in NWC', 'dNwc'], ['Unlevered FCF', 'ufcf'], ['PV of UFCF', 'pv']]
      .map(([l, k]) => [l, ...cols.map((c) => (c[k] == null ? '' : raw(c[k] / U)))]),
    [],
    ['WACC', r.wacc], ['Terminal growth', a.terminalGrowth], ['Exit multiple', a.exitMultiple],
    ['EV (perpetuity)', r.gordon.ev / U], ['EV (exit)', r.exit.ev / U],
    ['Price/share (perpetuity)', r.gordon.perShare], ['Price/share (exit)', r.exit.perShare], ['Current price', a.price ?? ''],
  ];
  const blob = new Blob([lines.map((l) => l.join(',')).join('\n')], { type: 'text/csv' });
  const link = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `${data.ticker}-dcf.csv` });
  link.click(); URL.revokeObjectURL(link.href);
}

// ---------- bridge inputs ----------
function syncBridgeInputs() {
  $$('.u').forEach((s) => (s.textContent = UL));
  $('#in-price').value = a.price ?? '';
  $('#in-shares').value = a.shares ? (a.shares / 1e6).toFixed(1) : '';
  $('#in-debt').value = (a.debt / U).toFixed(2);
  $('#in-cash').value = (a.cash / U).toFixed(2);
}
function bindBridgeInputs() {
  const on = (id, f) => $(id).addEventListener('input', (e) => { const v = parseFloat(e.target.value); if (Number.isFinite(v)) { f(v); schedule(); } });
  on('#in-price', (v) => (a.price = v > 0 ? v : null));
  on('#in-shares', (v) => (a.shares = v * 1e6));
  on('#in-debt', (v) => (a.debt = v * U));
  on('#in-cash', (v) => (a.cash = v * U));
}

// ---------- loading ----------
function show(id) { for (const s of ['empty', 'loading', 'error', 'model']) $(`#${s}`).hidden = s !== id; }

async function load(ticker) {
  ticker = ticker.trim().toUpperCase();
  if (!ticker) return;
  $('#ticker').value = ticker;
  if (location.hash.slice(1) !== ticker) history.replaceState(null, '', `#${ticker}`);
  show('loading');
  try {
    const res = await fetch(`/api/company/${encodeURIComponent(ticker.replace(/\./g, '-'))}`);
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    data = body;
    if (!data.years.some((y) => y.revenue)) throw new Error('No revenue in the 10-K data. Banks, insurers and REITs usually need a different model (DDM, P/B or FFO).');
    defaults = defaultAssumptions(data);
    a = structuredClone(defaults);
    const lastRev = data.years.filter((y) => y.revenue).at(-1).revenue;
    U = lastRev >= 1e10 ? 1e9 : 1e6; UL = U === 1e9 ? '$B' : '$M';
    $('#co-name').textContent = data.entityName;
    const last = data.years.at(-1);
    $('#co-meta').innerHTML = `<b>${data.ticker}</b> · CIK ${data.cik} · ${data.years.length} fiscal years · latest 10-K period ends ${last.end} · <a href="https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${data.cik}&type=10-K" target="_blank" rel="noopener">filings ↗</a>`;
    const warns = [...data.warnings];
    if (!data.market?.price) warns.push("Couldn't fetch a live share price. Enter one under Equity bridge inputs to see upside and the trading range.");
    $('#warnings').innerHTML = warns.map((w) => `<div class="warn-box">${w}</div>`).join('');
    syncBridgeInputs();
    $('#midYear').checked = a.midYear;
    show('model');
    render();
    document.title = `${data.ticker} DCF · Ticker to DCF`;
  } catch (err) {
    $('#error-msg').textContent = err.message;
    show('error');
  }
}

// ---------- wire up ----------
buildControls();
bindBridgeInputs();
$('#search').addEventListener('submit', (e) => { e.preventDefault(); load($('#ticker').value); });
$$('.chips button').forEach((b) => b.addEventListener('click', () => load(b.dataset.t)));
$('#reset').addEventListener('click', () => { a = structuredClone(defaults); syncBridgeInputs(); $('#midYear').checked = a.midYear; schedule(); });
$('#midYear').addEventListener('change', (e) => { a.midYear = e.target.checked; schedule(); });
$$('[data-method]').forEach((b) => b.addEventListener('click', () => {
  method = b.dataset.method; $$('[data-method]').forEach((x) => x.classList.toggle('on', x === b)); schedule();
}));
$$('#sens-mode button').forEach((b) => b.addEventListener('click', () => {
  sensMode = b.dataset.mode; $$('#sens-mode button').forEach((x) => x.classList.toggle('on', x === b)); schedule();
}));
$('#csv').addEventListener('click', downloadCsv);
window.addEventListener('hashchange', () => { const t = location.hash.slice(1); if (t && t !== data?.ticker) load(t); });
if (location.hash.length > 1) load(location.hash.slice(1));
