// ui-cliquet.js — capped/floored cliquet UI. MC only.
//
// The headline trick: switch model between GBM and (calibrated) Heston and
// watch the price move. Forward-skew dominates this product, so a flat-vol
// GBM systematically misprices vs a stochastic-vol model with the same ATM IV.
import { priceMonteCarlo } from './engines.js';
import { drawHistogram, drawLineChart } from './charts.js';
import { Cliquet } from './products.js';

export function mountCliquet({ inputsSlot, outputsSlot, ctx }) {
  let spec = Cliquet.defaultSpec(ctx.getMarket());
  let nPaths = 20000;
  let runningHandle = null;
  let debounceTimer = null;
  let lastResult = null;

  // ---- inputs card ----
  const inputsCard = h('section', { class: 'card' });
  inputsCard.innerHTML = `
    <div class="card-h">
      <h2>Product · Cliquet</h2>
      <span class="hint">forward-skew sensitive · MC only</span>
    </div>
    <div class="card-b">
      <div class="ac-grid">
        <div class="field"><label>Maturity</label>
          <div class="wrap"><input id="cYears" type="number" step="0.25" min="0.25" value="${spec.years}" /><span class="suffix">yrs</span></div></div>
        <div class="field"><label>Reset frequency</label>
          <div class="wrap">
            <select id="cResets">
              <option value="4">4 — quarterly</option>
              <option value="12">12 — monthly</option>
              <option value="26">26 — bi-weekly</option>
              <option value="52">52 — weekly</option>
            </select>
          </div></div>
        <div class="field"><label>Local cap</label>
          <div class="wrap"><input id="cLocCap" type="number" step="0.5" value="${(spec.localCap*100).toFixed(2)}" /><span class="suffix">%</span></div></div>
        <div class="field"><label>Local floor</label>
          <div class="wrap"><input id="cLocFlr" type="number" step="0.5" value="${(spec.localFloor*100).toFixed(2)}" /><span class="suffix">%</span></div></div>
        <div class="field"><label>Global cap</label>
          <div class="wrap"><input id="cGloCap" type="number" step="1" value="${(spec.globalCap*100).toFixed(0)}" /><span class="suffix">%</span></div></div>
        <div class="field"><label>Global floor</label>
          <div class="wrap"><input id="cGloFlr" type="number" step="1" value="${(spec.globalFloor*100).toFixed(0)}" /><span class="suffix">%</span></div></div>
        <div class="field"><label>Notional</label>
          <div class="wrap"><input id="cN" type="number" step="1" value="${spec.notional}" /><span class="suffix">$</span></div></div>
        <div class="field"><label>MC paths</label>
          <div class="wrap"><select id="cP">
            <option value="5000">5,000 — fast</option>
            <option value="20000" selected>20,000 — balanced</option>
            <option value="50000">50,000 — precise</option>
            <option value="100000">100,000 — slow</option>
          </select></div></div>
      </div>
    </div>
  `;
  inputsSlot.appendChild(inputsCard);
  inputsCard.querySelector('#cResets').value = String(spec.resets);
  inputsCard.querySelector('#cP').value = String(nPaths);

  const bind = (id, fn) => inputsCard.querySelector('#' + id).addEventListener('input', fn);
  bind('cYears',  e => { spec.years = Math.max(0.25, +e.target.value || 0.25); trigger(); });
  bind('cResets', e => { spec.resets = +e.target.value; trigger(); });
  bind('cLocCap', e => { spec.localCap   = (+e.target.value || 0) / 100; trigger(); });
  bind('cLocFlr', e => { spec.localFloor = (+e.target.value || 0) / 100; trigger(); });
  bind('cGloCap', e => { spec.globalCap  = (+e.target.value || 0) / 100; trigger(); });
  bind('cGloFlr', e => { spec.globalFloor= (+e.target.value || 0) / 100; trigger(); });
  bind('cN',      e => { spec.notional = Math.max(1, +e.target.value || 1); trigger(); });
  bind('cP',      e => { nPaths = +e.target.value; trigger(); });

  // ---- output cards ----
  const summaryCard = card('Position Snapshot', `<div class="summary cols-4" id="cSum"></div>`, null,
    `<div class="mc-bar" id="cMc" style="min-width:200px;max-width:340px">
       <span id="cMcLabel">Ready</span>
       <div class="bar-track"><div class="bar-fill" id="cMcFill"></div></div>
       <span class="nums" id="cMcNums"></span>
     </div>`);
  const perPeriodCard = card('Mean capped return per reset', `
    <div class="chart-wrap">
      <svg class="chart short" id="cPer" preserveAspectRatio="none"></svg>
      <div class="tooltip" id="cPerTip"></div>
    </div>`, null,
    `<div class="legend">
      <span><span class="sw" style="background:#7dd3fc"></span>E[capped r_i]</span>
      <span><span class="sw" style="background:#fbbf24"></span>Local cap</span>
      <span><span class="sw" style="background:#fb7185"></span>Local floor</span>
    </div>`);
  const histCard = card('Distribution of cliquet payoff', `
    <div class="chart-wrap">
      <svg class="chart" id="cHist" preserveAspectRatio="none"></svg>
    </div>`, null,
    `<div class="legend">
      <span>final return Σ capped(r_i), capped/floored globally</span>
    </div>`);
  outputsSlot.appendChild(summaryCard);
  outputsSlot.appendChild(perPeriodCard);
  outputsSlot.appendChild(histCard);

  window.addEventListener('resize', () => { if (lastResult) drawAll(lastResult); });

  function setBar(label, done, total) {
    summaryCard.querySelector('#cMcLabel').textContent = label;
    const pct = total ? Math.min(100, Math.max(0, 100 * done / total)) : 0;
    summaryCard.querySelector('#cMcFill').style.width = pct + '%';
    summaryCard.querySelector('#cMcNums').textContent = total ? `${shortN(done)} / ${shortN(total)}` : '';
  }
  function trigger() { clearTimeout(debounceTimer); debounceTimer = setTimeout(recompute, 200); }

  function renderSummary(price, stderr, n, aux) {
    const el = summaryCard.querySelector('#cSum');
    const N = spec.notional;
    const pctOfN = price / N * 100;
    const stderrPct = stderr / N * 100;
    const upperHits = aux ? (aux.probUpperCap * 100).toFixed(1) + '%' : '—';
    const lowerHits = aux ? (aux.probLowerCap * 100).toFixed(1) + '%' : '—';
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
      <div class="kpi gamma">
        <div class="k">P(period at cap)</div>
        <div class="v">${upperHits}</div>
        <div class="sub">capped to local cap</div>
      </div>
      <div class="kpi ki">
        <div class="k">P(period at floor)</div>
        <div class="v">${lowerHits}</div>
        <div class="sub">floored to local floor</div>
      </div>
    `;
  }

  function drawAll(aux) {
    // --- per-period mean capped return ---
    const n = aux.meanPerPeriod.length;
    const xs = new Array(n);
    for (let i = 0; i < n; i++) xs[i] = i + 1;
    drawLineChart(perPeriodCard.querySelector('#cPer'), perPeriodCard.querySelector('#cPerTip'), {
      xs,
      series: [
        { label: 'mean', color: '#7dd3fc', ys: aux.meanPerPeriod, type: 'line', width: 2.2 },
        { label: 'fill', color: '#7dd3fc', ys: aux.meanPerPeriod, type: 'area', fillOpacity: 0.16 }
      ],
      verticals: [],
      xFormat: vv => 'p' + Math.round(vv),
      yFormat: vv => (vv * 100).toFixed(2) + '%',
      tooltip: (idx, xs) => `
        <div class="row"><span>Period</span><span>${Math.round(xs[idx])}</span></div>
        <div class="row"><span style="color:#7dd3fc">E[capped r]</span><span>${(aux.meanPerPeriod[idx]*100).toFixed(2)}%</span></div>
      `
    });
    // overlay cap/floor lines via in-place SVG decoration
    const svg = perPeriodCard.querySelector('#cPer');
    addHorizontalRef(svg, spec.localCap,   '#fbbf24', `cap ${(spec.localCap*100).toFixed(1)}%`,   xs, aux.meanPerPeriod);
    addHorizontalRef(svg, spec.localFloor, '#fb7185', `floor ${(spec.localFloor*100).toFixed(1)}%`, xs, aux.meanPerPeriod);

    // --- payoff histogram ---
    drawHistogram(histCard.querySelector('#cHist'), null, {
      values: aux.globalRetSamples.filter(v => isFinite(v)),
      bins: 50,
      color: '#a78bfa',
      xFormat: v => (v * 100).toFixed(0) + '%',
      verticals: [
        { x: spec.globalCap,   color: '#fbbf24', label: 'cap' },
        { x: spec.globalFloor, color: '#fb7185', label: 'floor' },
        { x: 0,                color: 'rgba(255,255,255,0.3)', label: '0' }
      ]
    });
  }

  function recompute() {
    const market = ctx.getMarket();
    const model = ctx.getModel();
    if (model.disabled) {
      renderSummary(NaN, 0, 0, null);
      setBar('Model not ready', 0, 0);
      return;
    }
    if (runningHandle) runningHandle.cancel();
    setBar('Running MC…', 0, nPaths);
    const t0 = performance.now();
    runningHandle = priceMonteCarlo({
      productId: 'cliquet', spec, modelId: model.id,
      modelParams: model.params, market, nPaths,
      seed: 1337,
      sampling: ctx.getSampling ? ctx.getSampling() : 'pseudo',
      onProgress: ({ done, total, mean }) => {
        setBar(`Simulating… FV ≈ $${(isFinite(mean)?mean:0).toFixed(2)}`, done, total);
      },
      onDone: ({ price, stderr, nPaths: n, auxiliary }) => {
        const dt = (performance.now() - t0) / 1000;
        setBar(`MC done · ${dt.toFixed(1)}s`, n, n);
        lastResult = auxiliary;
        renderSummary(price, stderr, n, auxiliary);
        drawAll(auxiliary);
        runningHandle = null;
      },
      onError: err => {
        console.error(err);
        setBar('Error: ' + err.message, 0, 0);
        runningHandle = null;
      }
    });
  }

  recompute();

  return {
    recompute,
    destroy() {
      if (runningHandle) runningHandle.cancel();
      inputsCard.remove(); summaryCard.remove(); perPeriodCard.remove(); histCard.remove();
    }
  };
}

// Decorate an existing line-chart svg with a horizontal reference line at y=val.
// Reads the chart's data domain off the cfg we just rendered to align scales.
function addHorizontalRef(svgEl, val, color, label, xs, ys) {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const W = svgEl.clientWidth || 800;
  const H = svgEl.clientHeight || 240;
  const m = { l: 54, r: 16, t: 16, b: 28 };
  // y-domain matches drawLineChart: pad ymin/ymax by 8% if equal, else by data range.
  let ymin = Infinity, ymax = -Infinity;
  for (const y of ys) { if (!isFinite(y)) continue; if (y < ymin) ymin = y; if (y > ymax) ymax = y; }
  if (!isFinite(ymin) || !isFinite(ymax)) return;
  // Include the ref value so it's visible.
  if (val < ymin) ymin = val;
  if (val > ymax) ymax = val;
  const sy = v => (H - m.b) - (v - ymin) * (H - m.t - m.b) / ((ymax - ymin) || 1);
  const y = sy(val);
  const line = document.createElementNS(SVG_NS, 'line');
  line.setAttribute('x1', m.l); line.setAttribute('x2', W - m.r);
  line.setAttribute('y1', y);   line.setAttribute('y2', y);
  line.setAttribute('stroke', color);
  line.setAttribute('stroke-dasharray', '5 4');
  line.setAttribute('stroke-width', 1.2);
  line.setAttribute('opacity', '0.65');
  svgEl.appendChild(line);
  const t = document.createElementNS(SVG_NS, 'text');
  t.setAttribute('x', W - m.r - 6); t.setAttribute('y', y - 4);
  t.setAttribute('text-anchor', 'end'); t.setAttribute('fill', color);
  t.setAttribute('font-size', '10'); t.setAttribute('font-family', 'SF Mono, monospace');
  t.textContent = label;
  svgEl.appendChild(t);
}

function h(tag, attrs) { const e = document.createElement(tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; }
function card(title, bodyHTML, _id, headerExtra='') {
  const s = h('section', { class: 'card' });
  s.innerHTML = `<div class="card-h"><h2>${title}</h2>${headerExtra}</div><div class="card-b">${bodyHTML}</div>`;
  return s;
}
function shortN(n) {
  if (n >= 1e6) return (n/1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n/1e3).toFixed(0) + 'k';
  return '' + n;
}
