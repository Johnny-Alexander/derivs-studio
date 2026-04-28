// ui-autocallable.js — autocallable note UI (MC priced)
import { priceMonteCarlo } from './engines.js';
import { drawLineChart, drawBarChart, drawPathsChart, drawHistogram } from './charts.js';
import { Autocallable } from './products.js';

export function mountAutocallable({ inputsSlot, outputsSlot, ctx }) {
  let spec = Autocallable.defaultSpec(ctx.getMarket());
  let nPaths = 20000;
  let runningHandle = null;
  let debounceTimer = null;
  let lastAux = null; // last MC auxiliary stats for chart redraws on resize

  // ---- inputs card ----
  const inputsCard = h('section', { class: 'card' });
  inputsCard.innerHTML = `
    <div class="card-h">
      <h2>Product · Autocallable</h2>
      <span class="hint">MC priced</span>
    </div>
    <div class="card-b">
      <div class="ac-grid">
        <div class="field"><label>Reference level</label>
          <div class="wrap"><input id="acRef" type="number" step="0.01" value="${spec.ref}" /><span class="suffix">$</span></div></div>
        <div class="field"><label>Notional</label>
          <div class="wrap"><input id="acN" type="number" step="1" value="${spec.notional}" /><span class="suffix">$</span></div></div>
        <div class="field"><label>Maturity</label>
          <div class="wrap"><input id="acYears" type="number" step="0.25" min="0.25" value="${spec.years}" /><span class="suffix">yrs</span></div></div>
        <div class="field"><label>Observations / yr</label>
          <div class="wrap">
            <select id="acObs">
              <option value="1">1 — annual</option>
              <option value="2">2 — semi-annual</option>
              <option value="4">4 — quarterly</option>
              <option value="12">12 — monthly</option>
            </select>
          </div></div>
        <div class="field"><label>Autocall barrier</label>
          <div class="wrap"><input id="acAC" type="number" step="1" value="${(spec.autocallBarrier*100).toFixed(0)}" /><span class="suffix">% of ref</span></div></div>
        <div class="field"><label>Coupon barrier</label>
          <div class="wrap"><input id="acCpn" type="number" step="1" value="${(spec.couponBarrier*100).toFixed(0)}" /><span class="suffix">% of ref</span></div></div>
        <div class="field"><label>KI barrier (at maturity)</label>
          <div class="wrap"><input id="acKI" type="number" step="1" value="${(spec.kiBarrier*100).toFixed(0)}" /><span class="suffix">% of ref</span></div></div>
        <div class="field"><label>Coupon rate / period</label>
          <div class="wrap"><input id="acRate" type="number" step="0.1" value="${(spec.couponRate*100).toFixed(2)}" /><span class="suffix">%</span></div></div>
        <div class="field span2" style="display:flex;gap:10px;align-items:end;justify-content:space-between">
          <div class="toggle-pill ${spec.memory?'on':''}" id="acMem">
            <span class="dot"></span>Memory coupon
          </div>
          <div class="field" style="flex:1;margin-left:10px">
            <label>MC paths</label>
            <div class="wrap">
              <select id="acN2">
                <option value="5000">5,000 — fast</option>
                <option value="20000" selected>20,000 — balanced</option>
                <option value="50000">50,000 — precise</option>
                <option value="100000">100,000 — slow</option>
              </select>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
  inputsSlot.appendChild(inputsCard);

  // set the select values
  inputsCard.querySelector('#acObs').value = String(spec.obsPerYear);
  inputsCard.querySelector('#acN2').value = String(nPaths);

  const bind = (id, fn) => inputsCard.querySelector('#' + id).addEventListener('input', fn);
  bind('acRef',   e => { spec.ref = +e.target.value || ctx.getMarket().S; trigger(); });
  bind('acN',     e => { spec.notional = Math.max(1, +e.target.value || 1); trigger(); });
  bind('acYears', e => { spec.years = Math.max(0.25, +e.target.value || 0.25); trigger(); });
  bind('acObs',   e => { spec.obsPerYear = +e.target.value; trigger(); });
  bind('acAC',    e => { spec.autocallBarrier = (+e.target.value || 0) / 100; trigger(); });
  bind('acCpn',   e => { spec.couponBarrier   = (+e.target.value || 0) / 100; trigger(); });
  bind('acKI',    e => { spec.kiBarrier       = (+e.target.value || 0) / 100; trigger(); });
  bind('acRate',  e => { spec.couponRate = (+e.target.value || 0) / 100; trigger(); });
  bind('acN2',    e => { nPaths = +e.target.value; trigger(); });

  const memEl = inputsCard.querySelector('#acMem');
  memEl.onclick = () => { spec.memory = !spec.memory; memEl.classList.toggle('on', spec.memory); trigger(); };

  // ---- output cards ----
  const summaryCard = card('Position Snapshot', `<div class="summary" id="acSummary"></div>`, null,
    `<div class="mc-bar" id="acMc" style="min-width:200px;max-width:340px">
       <span id="acMcLabel">Ready</span>
       <div class="bar-track"><div class="bar-fill" id="acMcFill"></div></div>
       <span class="nums" id="acMcNums"></span>
     </div>`);
  const pathsCard = card('Simulated Paths', `
    <div class="chart-wrap">
      <svg class="chart" id="acPaths" preserveAspectRatio="none"></svg>
    </div>`, null,
    `<div class="legend">
      <span><span class="sw" style="background:#fbbf24"></span>AC barrier</span>
      <span><span class="sw" style="background:#7dd3fc"></span>Coupon barrier</span>
      <span><span class="sw" style="background:#fb7185"></span>KI barrier</span>
      <span><span class="sw" style="background:#34d399"></span>Autocalled</span>
      <span><span class="sw" style="background:#fb7185"></span>KI breached</span>
      <span><span class="sw" style="background:#8d94ad"></span>At maturity (no KI)</span>
    </div>`);
  const acDistCard = card('Autocall Probability', `
    <div class="chart-wrap">
      <svg class="chart short" id="acDist" preserveAspectRatio="none"></svg>
      <div class="tooltip" id="acDistTip"></div>
    </div>`, null,
    `<div class="legend">
      <span><span class="sw" style="background:#7dd3fc"></span>P(autocalled this date)</span>
      <span><span class="sw" style="background:#a78bfa"></span>Cumulative P(autocalled by now)</span>
    </div>`);
  const histCard = card('Distribution of Terminal Ratio', `
    <div class="chart-wrap">
      <svg class="chart short" id="acHist" preserveAspectRatio="none"></svg>
    </div>`, null,
    `<div class="legend">
       <span>S<sub>T</sub> / ref · only paths reaching maturity</span>
     </div>`);

  outputsSlot.appendChild(summaryCard);
  outputsSlot.appendChild(pathsCard);
  outputsSlot.appendChild(acDistCard);
  outputsSlot.appendChild(histCard);

  window.addEventListener('resize', () => { if (lastAux) drawAllCharts(lastAux); });

  function setBar(label, done, total) {
    inputsCard; // (no-op reference)
    const l = summaryCard.querySelector('#acMcLabel');
    const fill = summaryCard.querySelector('#acMcFill');
    const nums = summaryCard.querySelector('#acMcNums');
    l.textContent = label;
    const pct = total ? Math.min(100, Math.max(0, 100 * done / total)) : 0;
    fill.style.width = pct + '%';
    nums.textContent = total ? `${shortN(done)} / ${shortN(total)}` : '';
  }

  function trigger() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(recompute, 200);
  }

  function recompute() {
    const market = ctx.getMarket();
    const model = ctx.getModel();
    if (model.disabled) {
      renderSummary({ price: NaN, stderr: 0 }, null);
      setBar('Model not ready', 0, 0);
      return;
    }
    if (runningHandle) runningHandle.cancel();
    setBar('Running MC…', 0, nPaths);

    const t0 = performance.now();
    runningHandle = priceMonteCarlo({
      productId: 'autocallable', spec, modelId: model.id,
      modelParams: model.params, market, nPaths,
      seed: 1337,
      onProgress: ({ done, total, mean, stderr }) => {
        setBar(`Simulating… price ≈ ${fmtPrice(mean, spec.notional)}`, done, total);
      },
      onDone: ({ price, stderr, nPaths: n, auxiliary }) => {
        const dt = (performance.now() - t0) / 1000;
        setBar(`MC done · ${dt.toFixed(1)}s`, n, n);
        renderSummary({ price, stderr, nPaths: n }, auxiliary);
        lastAux = auxiliary;
        drawAllCharts(auxiliary);
        runningHandle = null;
      },
      onError: err => {
        console.error(err);
        setBar('Error: ' + err.message, 0, 0);
        runningHandle = null;
      }
    });
  }

  function renderSummary({ price, stderr, nPaths: n }, aux) {
    const el = summaryCard.querySelector('#acSummary');
    const N = spec.notional;
    const pctOfN = price / N * 100;
    const stderrPct = stderr / N * 100;
    const cumulativeAC = aux ? aux.cumulativeAutocall[aux.cumulativeAutocall.length - 1] : null;

    el.innerHTML = `
      <div class="kpi price">
        <div class="k">Fair Value</div>
        <div class="v">${isFinite(price) ? '$' + price.toFixed(2) : '—'}</div>
        <div class="sub">${isFinite(pctOfN) ? pctOfN.toFixed(2) + '% of notional' : ''}</div>
      </div>
      <div class="kpi stderr">
        <div class="k">Std Error</div>
        <div class="v">${isFinite(stderr) ? '±' + stderr.toFixed(3) : '—'}</div>
        <div class="sub">${isFinite(stderrPct) ? '±' + stderrPct.toFixed(3) + '%' : ''} · ${n ? shortN(n) : 0} paths</div>
      </div>
      <div class="kpi life">
        <div class="k">Expected Life</div>
        <div class="v">${aux ? aux.expectedLife.toFixed(2) : '—'}</div>
        <div class="sub">years until redemption</div>
      </div>
      <div class="kpi prob">
        <div class="k">P(autocalled)</div>
        <div class="v">${aux ? (cumulativeAC*100).toFixed(1) + '%' : '—'}</div>
        <div class="sub">any observation</div>
      </div>
      <div class="kpi ki">
        <div class="k">P(KI at maturity)</div>
        <div class="v">${aux ? (aux.probKI*100).toFixed(1) + '%' : '—'}</div>
        <div class="sub">principal loss</div>
      </div>
      <div class="kpi gamma">
        <div class="k">E[coupons paid]</div>
        <div class="v">${aux ? aux.expectedCoupons.toFixed(2) : '—'}</div>
        <div class="sub">number of payments</div>
      </div>
    `;
  }

  function drawAllCharts(aux) {
    const market = ctx.getMarket();
    // --- Sample paths ---
    const timesArr = Array.from(Autocallable.requiredGrid(spec));
    const colorByOutcome = (p) => {
      if (p.autocalledAt > 0) return '#34d399';
      if (p.kiBreached) return '#fb7185';
      return '#8d94ad';
    };
    const paths = aux.samplePaths.map(p => ({
      spots: p.spots.slice(0, (p.autocalledAt > 0 ? p.autocalledAt + 1 : p.spots.length)),
      color: colorByOutcome(p),
      opacity: 0.55,
      width: 1.2
    }));
    // Normalize: paths that autocalled early have shorter arrays; pad by NaN to align with times.
    const maxLen = timesArr.length;
    for (const p of paths) {
      while (p.spots.length < maxLen) p.spots.push(NaN);
    }
    // Filter out NaN by just using all spots — drawPathsChart handles them via the SVG rendering (NaN -> jumps).
    // Simpler: trim times to each path length. Build per-path time arrays via different approach:
    // We'll draw each path separately using its true length. Use a small helper here.
    drawPathSamples(pathsCard.querySelector('#acPaths'), {
      refTimes: timesArr,
      samples: aux.samplePaths,
      ref: spec.ref,
      barriers: [
        { y: spec.ref * spec.autocallBarrier, color: '#fbbf24', label: `AC ${(spec.autocallBarrier*100).toFixed(0)}%` },
        { y: spec.ref * spec.couponBarrier, color: '#7dd3fc', label: `Cpn ${(spec.couponBarrier*100).toFixed(0)}%` },
        { y: spec.ref * spec.kiBarrier, color: '#fb7185', label: `KI ${(spec.kiBarrier*100).toFixed(0)}%` },
        { y: spec.ref, color: 'rgba(255,255,255,0.25)', label: 'Ref' }
      ],
      obsDates: timesArr.slice(1)
    });

    // --- Autocall probability bars ---
    const obsCount = aux.probAutocall.length;
    const labels = aux.probAutocall.map((_, i) => 'obs ' + (i + 1));
    const marginalAC = aux.probAutocall;
    const cumulativeAC = aux.cumulativeAutocall;
    const combinedColors = marginalAC.map(() => '#7dd3fc');

    // Draw two series on the same svg? Bar chart for marginal, line overlay for cumulative.
    // For simplicity use two separate SVGs side by side is overkill. Draw bars + overlay line.
    drawACChart(acDistCard.querySelector('#acDist'), acDistCard.querySelector('#acDistTip'), {
      labels, marginal: marginalAC, cumulative: cumulativeAC
    });

    // --- Histogram of terminal ratio for paths that reached maturity ---
    drawHistogram(histCard.querySelector('#acHist'), null, {
      values: aux.terminalRatios.filter(v => isFinite(v)),
      bins: 40,
      color: '#a78bfa',
      xFormat: v => v.toFixed(2),
      verticals: [
        { x: spec.autocallBarrier, color: '#fbbf24', label: 'AC' },
        { x: spec.couponBarrier,   color: '#7dd3fc', label: 'Cpn' },
        { x: spec.kiBarrier,       color: '#fb7185', label: 'KI' },
        { x: 1.0,                  color: 'rgba(255,255,255,0.3)', label: 'Ref' }
      ]
    });
  }

  recompute();

  return { recompute, destroy() {
    if (runningHandle) runningHandle.cancel();
    inputsCard.remove(); summaryCard.remove(); pathsCard.remove();
    acDistCard.remove(); histCard.remove();
  }};
}

// Dedicated path sample chart that handles per-path truncation correctly
function drawPathSamples(svgEl, cfg) {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  svgEl.innerHTML = '';
  const times = cfg.refTimes;
  if (!times || times.length < 2 || !cfg.samples || !cfg.samples.length) return;
  const W = svgEl.clientWidth || 800;
  const H = svgEl.clientHeight || 340;
  const m = { l: 54, r: 16, t: 14, b: 28 };
  const xmin = times[0], xmax = times[times.length - 1];

  // y-range: include all barriers + all path values
  let ymin = Infinity, ymax = -Infinity;
  for (const s of cfg.samples)
    for (let i = 0; i < s.spots.length; i++) {
      const y = s.spots[i];
      if (!isFinite(y)) continue;
      if (y < ymin) ymin = y;
      if (y > ymax) ymax = y;
    }
  for (const b of cfg.barriers) { if (b.y < ymin) ymin = b.y; if (b.y > ymax) ymax = b.y; }
  const pad = (ymax - ymin) * 0.08 || 1;
  ymin -= pad; ymax += pad;

  const sx = v => m.l + (v - xmin) * (W - m.l - m.r) / ((xmax - xmin) || 1);
  const sy = v => (H - m.b) - (v - ymin) * (H - m.t - m.b) / ((ymax - ymin) || 1);

  // gridlines
  const mkEl = (tag, a) => { const e = document.createElementNS(SVG_NS, tag); for (const k in a) e.setAttribute(k, a[k]); return e; };
  const ticks = 5;
  for (let i = 0; i <= ticks; i++) {
    const v = ymin + (ymax - ymin) * i / ticks;
    const y = sy(v);
    svgEl.appendChild(mkEl('line', {
      x1: m.l, x2: W - m.r, y1: y, y2: y,
      stroke: 'rgba(255,255,255,0.05)', 'stroke-dasharray': '3 4'
    }));
    const t = mkEl('text', { x: m.l - 8, y: y + 3.5, 'text-anchor': 'end',
      fill: '#8d94ad', 'font-size': 10, 'font-family': 'SF Mono, monospace' });
    t.textContent = v.toFixed(0);
    svgEl.appendChild(t);
  }

  // barriers
  for (const b of cfg.barriers) {
    const y = sy(b.y);
    svgEl.appendChild(mkEl('line', {
      x1: m.l, x2: W - m.r, y1: y, y2: y,
      stroke: b.color, 'stroke-dasharray': '6 4', 'stroke-width': 1.5, opacity: 0.85
    }));
    if (b.label) {
      const t = mkEl('text', { x: W - m.r - 6, y: y - 4, 'text-anchor': 'end',
        fill: b.color, 'font-size': 10, 'font-family': 'SF Mono, monospace' });
      t.textContent = b.label;
      svgEl.appendChild(t);
    }
  }

  // observation date verticals + x labels
  for (const t of cfg.obsDates || []) {
    const x = sx(t);
    svgEl.appendChild(mkEl('line', {
      x1: x, x2: x, y1: m.t, y2: H - m.b,
      stroke: 'rgba(255,255,255,0.06)', 'stroke-dasharray': '2 3'
    }));
  }
  // x axis labels every few
  const xTickCount = Math.min(6, times.length - 1);
  for (let i = 0; i <= xTickCount; i++) {
    const t = xmin + (xmax - xmin) * i / xTickCount;
    const x = sx(t);
    const lbl = mkEl('text', { x, y: H - m.b + 16, 'text-anchor': 'middle',
      fill: '#8d94ad', 'font-size': 10, 'font-family': 'SF Mono, monospace' });
    lbl.textContent = t.toFixed(1) + 'y';
    svgEl.appendChild(lbl);
  }

  // paths
  for (const s of cfg.samples) {
    // Determine effective length: if autocalled, draw only up to that point.
    const end = s.autocalledAt > 0 ? s.autocalledAt : s.spots.length - 1;
    let d = '';
    for (let i = 0; i <= end; i++) {
      const t = times[i];
      const y = s.spots[i];
      if (!isFinite(y)) continue;
      d += (i === 0 ? 'M' : 'L') + sx(t).toFixed(2) + ',' + sy(y).toFixed(2) + ' ';
    }
    const color = s.autocalledAt > 0 ? '#34d399' : (s.kiBreached ? '#fb7185' : '#8d94ad');
    svgEl.appendChild(mkEl('path', {
      d, fill: 'none', stroke: color, 'stroke-width': 1.2, opacity: 0.55, 'stroke-linejoin': 'round'
    }));
    // terminal marker
    const tx = sx(times[end]);
    const ty = sy(s.spots[end]);
    if (isFinite(ty)) svgEl.appendChild(mkEl('circle', { cx: tx, cy: ty, r: 2.4, fill: color, opacity: 0.9 }));
  }
}

// Bar + line overlay for marginal / cumulative autocall probability
function drawACChart(svgEl, tipEl, cfg) {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  svgEl.innerHTML = '';
  const W = svgEl.clientWidth || 800;
  const H = svgEl.clientHeight || 240;
  const m = { l: 46, r: 16, t: 14, b: 28 };
  const n = cfg.labels.length;
  if (n === 0) return;
  const ymax = Math.max(0.05, Math.max(...cfg.marginal, ...cfg.cumulative)) * 1.1;
  const sx = i => m.l + (i + 0.5) * (W - m.l - m.r) / n;
  const sy = v => (H - m.b) - v * (H - m.t - m.b) / ymax;

  const mkEl = (tag, a) => { const e = document.createElementNS(SVG_NS, tag); for (const k in a) e.setAttribute(k, a[k]); return e; };

  // grid
  const ticks = 4;
  for (let i = 0; i <= ticks; i++) {
    const v = (ymax) * i / ticks;
    const y = sy(v);
    svgEl.appendChild(mkEl('line', { x1: m.l, x2: W - m.r, y1: y, y2: y,
      stroke: i === 0 ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.05)',
      'stroke-dasharray': i === 0 ? '0' : '3 4' }));
    const t = mkEl('text', { x: m.l - 8, y: y + 3.5, 'text-anchor': 'end',
      fill: '#8d94ad', 'font-size': 10, 'font-family': 'SF Mono, monospace' });
    t.textContent = (v * 100).toFixed(0) + '%';
    svgEl.appendChild(t);
  }

  // bars
  const cellW = (W - m.l - m.r) / n;
  const barW = Math.max(2, Math.min(34, cellW * 0.55));
  cfg.marginal.forEach((v, i) => {
    const cx = sx(i);
    const y = sy(v);
    const h = sy(0) - y;
    svgEl.appendChild(mkEl('rect', {
      x: cx - barW / 2, y, width: barW, height: Math.max(0, h),
      fill: '#7dd3fc', rx: 3, opacity: 0.85
    }));
  });

  // cumulative line
  let d = '';
  cfg.cumulative.forEach((v, i) => { d += (i === 0 ? 'M' : 'L') + sx(i).toFixed(2) + ',' + sy(v).toFixed(2) + ' '; });
  svgEl.appendChild(mkEl('path', { d, fill: 'none', stroke: '#a78bfa', 'stroke-width': 2, 'stroke-linejoin': 'round' }));
  cfg.cumulative.forEach((v, i) => {
    svgEl.appendChild(mkEl('circle', { cx: sx(i), cy: sy(v), r: 3, fill: '#a78bfa', stroke: '#07080f', 'stroke-width': 1.2 }));
  });

  // x axis labels (every k-th)
  const skip = Math.max(1, Math.ceil(n / 10));
  for (let i = 0; i < n; i++) {
    if (i % skip !== 0 && i !== n - 1) continue;
    const lbl = mkEl('text', { x: sx(i), y: H - m.b + 16, 'text-anchor': 'middle',
      fill: '#8d94ad', 'font-size': 10, 'font-family': 'SF Mono, monospace' });
    lbl.textContent = cfg.labels[i];
    svgEl.appendChild(lbl);
  }

  // hover
  if (tipEl) {
    for (let i = 0; i < n; i++) {
      const cx = sx(i);
      const hit = mkEl('rect', { x: cx - cellW / 2, y: m.t, width: cellW, height: H - m.t - m.b, fill: 'transparent' });
      hit.addEventListener('mouseenter', () => {
        tipEl.style.display = 'block';
        tipEl.style.left = cx + 'px';
        tipEl.style.top = sy(cfg.cumulative[i]) + 'px';
        tipEl.innerHTML = `
          <div class="row"><span>${cfg.labels[i]}</span><span></span></div>
          <div class="row"><span style="color:#7dd3fc">this date</span><span>${(cfg.marginal[i]*100).toFixed(1)}%</span></div>
          <div class="row"><span style="color:#a78bfa">cumulative</span><span>${(cfg.cumulative[i]*100).toFixed(1)}%</span></div>
        `;
      });
      hit.addEventListener('mouseleave', () => tipEl.style.display = 'none');
      svgEl.appendChild(hit);
    }
  }
}

// helpers
function h(tag, attrs) { const e = document.createElement(tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; }
function card(title, bodyHTML, _id, headerExtra='') {
  const s = h('section', { class: 'card' });
  s.innerHTML = `<div class="card-h"><h2>${title}</h2>${headerExtra}</div><div class="card-b">${bodyHTML}</div>`;
  return s;
}
function fmtPrice(v, N) { return isFinite(v) ? (v/N*100).toFixed(2) + '%' : '—'; }
function shortN(n) {
  if (n >= 1e6) return (n/1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n/1e3).toFixed(0) + 'k';
  return '' + n;
}
