// ui-barrier.js — single-asset barrier option UI.
//
// MC always runs (gives auxiliary touch-probability stats). Under GBM the
// closed-form Reiner–Rubinstein price is shown alongside MC for cross-check;
// under Heston the closed-form slot is dashed out (no analytic).
import { priceAnalytic, priceMonteCarlo } from './engines.js';
import { drawLineChart, drawHistogram } from './charts.js';
import { Barrier } from './products.js';

const BARRIER_LABELS = {
  'up-and-out':   'Up &amp; Out',
  'up-and-in':    'Up &amp; In',
  'down-and-out': 'Down &amp; Out',
  'down-and-in':  'Down &amp; In'
};

export function mountBarrier({ inputsSlot, outputsSlot, ctx }) {
  let spec = Barrier.defaultSpec(ctx.getMarket());
  let nPaths = 20000;
  let runningHandle = null;
  let debounceTimer = null;
  let lastAux = null;
  let lastMC = null;
  let lastClosedForm = null;

  // ---- inputs card ----
  const inputsCard = h('section', { class: 'card' });
  inputsCard.innerHTML = `
    <div class="card-h">
      <h2>Product · Barrier</h2>
      <span class="hint">continuous monitoring</span>
    </div>
    <div class="card-b">
      <div class="type-picker" id="bType">
        <label class="${spec.optionType==='call'?'on':''}"><input type="radio" name="bType" value="call" ${spec.optionType==='call'?'checked':''}>Call</label>
        <label class="${spec.optionType==='put'?'on':''}"><input type="radio" name="bType" value="put" ${spec.optionType==='put'?'checked':''}>Put</label>
      </div>
      <div class="type-picker" id="bSide">
        <label class="${spec.side==='long'?'on':''}"><input type="radio" name="bSide" value="long" ${spec.side==='long'?'checked':''}>Long</label>
        <label class="${spec.side==='short'?'on':''}"><input type="radio" name="bSide" value="short" ${spec.side==='short'?'checked':''}>Short</label>
      </div>
      <div class="field" style="margin-bottom:10px">
        <label>Barrier kind</label>
        <div class="wrap">
          <select id="bKind">
            <option value="up-and-out">Up &amp; Out  — knocked dead if S touches B</option>
            <option value="up-and-in">Up &amp; In   — only alive after S touches B</option>
            <option value="down-and-out">Down &amp; Out — knocked dead if S falls to B</option>
            <option value="down-and-in">Down &amp; In  — only alive after S falls to B</option>
          </select>
        </div>
      </div>
      <div class="inputs-grid">
        <div class="field"><label>Strike</label>
          <div class="wrap"><input id="bStrike" type="number" step="0.5" value="${spec.strike}" /><span class="suffix">$</span></div></div>
        <div class="field"><label>Barrier level</label>
          <div class="wrap"><input id="bBarrier" type="number" step="0.5" value="${spec.barrier}" /><span class="suffix">$</span></div></div>
        <div class="field"><label>Days to expiry</label>
          <div class="wrap"><input id="bDays" type="number" step="1" min="1" value="${spec.days}" /><span class="suffix">days</span></div></div>
        <div class="field"><label>Quantity</label>
          <div class="wrap"><input id="bQty" type="number" step="1" min="1" value="${spec.qty}" /><span class="suffix">×</span></div></div>
        <div class="field span2"><label>MC paths</label>
          <div class="wrap"><select id="bN">
            <option value="5000">5,000 — fast</option>
            <option value="20000" selected>20,000 — balanced</option>
            <option value="50000">50,000 — precise</option>
            <option value="100000">100,000 — slow</option>
          </select></div></div>
      </div>
    </div>
  `;
  inputsSlot.appendChild(inputsCard);
  inputsCard.querySelector('#bKind').value = spec.barrierType;
  inputsCard.querySelector('#bN').value = String(nPaths);

  const bind = (id, fn) => inputsCard.querySelector('#' + id).addEventListener('input', fn);
  bind('bStrike',  e => { spec.strike = +e.target.value || 0; trigger(); });
  bind('bBarrier', e => { spec.barrier = +e.target.value || 0; trigger(); });
  bind('bDays',    e => { spec.days = Math.max(1, +e.target.value || 1); trigger(); });
  bind('bQty',     e => { spec.qty = Math.max(1, Math.floor(+e.target.value || 1)); trigger(); });
  bind('bKind',    e => { spec.barrierType = e.target.value; trigger(); });
  bind('bN',       e => { nPaths = +e.target.value; trigger(); });

  inputsCard.querySelector('#bType').addEventListener('change', e => {
    if (!e.target.name) return;
    spec.optionType = e.target.value;
    inputsCard.querySelectorAll('#bType label').forEach(l => l.classList.toggle('on', l.querySelector('input').checked));
    trigger();
  });
  inputsCard.querySelector('#bSide').addEventListener('change', e => {
    if (!e.target.name) return;
    spec.side = e.target.value;
    inputsCard.querySelectorAll('#bSide label').forEach(l => l.classList.toggle('on', l.querySelector('input').checked));
    trigger();
  });

  // ---- output cards ----
  const summaryCard = card('Position Snapshot', `<div class="summary cols-4" id="bSummary"></div>`, null,
    `<div class="mc-bar" id="bMc" style="min-width:200px;max-width:340px">
       <span id="bMcLabel">Ready</span>
       <div class="bar-track"><div class="bar-fill" id="bMcFill"></div></div>
       <span class="nums" id="bMcNums"></span>
     </div>`);
  const priceCard = card('Price vs Spot', `
    <div class="chart-wrap">
      <svg class="chart" id="bPrice" preserveAspectRatio="none"></svg>
      <div class="tooltip" id="bPriceTip"></div>
    </div>`, null,
    `<div class="legend">
      <span><span class="sw" style="background:#7dd3fc"></span>Closed-form (GBM only)</span>
      <span><span class="sw" style="background:#fbbf24"></span>Strike</span>
      <span><span class="sw" style="background:#fb7185"></span>Barrier</span>
    </div>`);
  const touchCard = card('Cumulative P(barrier touched)', `
    <div class="chart-wrap">
      <svg class="chart short" id="bTouch" preserveAspectRatio="none"></svg>
      <div class="tooltip" id="bTouchTip"></div>
    </div>`, null,
    `<div class="legend">
      <span><span class="sw" style="background:#a78bfa"></span>P(touched by t)</span>
    </div>`);
  outputsSlot.appendChild(summaryCard);
  outputsSlot.appendChild(priceCard);
  outputsSlot.appendChild(touchCard);

  window.addEventListener('resize', () => { drawPrice(); if (lastAux) drawTouch(lastAux); });

  function setBar(label, done, total) {
    summaryCard.querySelector('#bMcLabel').textContent = label;
    const pct = total ? Math.min(100, Math.max(0, 100 * done / total)) : 0;
    summaryCard.querySelector('#bMcFill').style.width = pct + '%';
    summaryCard.querySelector('#bMcNums').textContent = total ? `${shortN(done)} / ${shortN(total)}` : '';
  }

  function trigger() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(recompute, 200);
  }

  function renderSummary() {
    const el = summaryCard.querySelector('#bSummary');
    const cf = lastClosedForm;
    const mc = lastMC;
    const aux = lastAux;
    const cfStr = cf ? money(cf.price) : '—';
    const mcStr = mc ? money(mc.price) : '—';
    const stderrStr = mc ? '±' + mc.stderr.toFixed(3) : '—';
    const probTouch = aux ? (aux.probTouchAny * 100).toFixed(1) + '%' : '—';
    const probAlive = aux ? (aux.probAlive * 100).toFixed(1) + '%' : '—';
    const diff = (cf && mc) ? Math.abs(cf.price - mc.price) : null;
    const diffStr = diff != null ? `Δ ${diff.toFixed(3)}` : '';

    el.innerHTML = `
      <div class="kpi price"><div class="k">Price (closed form)</div><div class="v">${cfStr}</div><div class="sub">${cf ? 'GBM · Reiner–Rubinstein' : 'no closed form for this model'}</div></div>
      <div class="kpi stderr"><div class="k">Price (MC)</div><div class="v">${mcStr}</div><div class="sub">${stderrStr} · ${diffStr}</div></div>
      <div class="kpi prob"><div class="k">P(barrier touched)</div><div class="v">${probTouch}</div><div class="sub">over option life</div></div>
      <div class="kpi life"><div class="k">P(alive at maturity)</div><div class="v">${probAlive}</div><div class="sub">payable terminal payoff</div></div>
    `;
  }

  function spotRange(S, vol, T) {
    const width = Math.max(0.35, Math.min(0.9, vol * Math.sqrt(Math.max(T, 0.1)) * 3 + 0.25));
    const lo = S * Math.max(0.05, 1 - width);
    const hi = S * (1 + width);
    const pts = 120;
    const xs = new Array(pts);
    for (let i = 0; i < pts; i++) xs[i] = lo + (hi - lo) * i / (pts - 1);
    return xs;
  }

  function drawPrice() {
    const market = ctx.getMarket();
    const model = ctx.getModel();
    if (model.disabled) return;
    const v = ctx.getEffectiveVol ? ctx.getEffectiveVol() : (model.params.sigma ?? 0.25);
    const T = spec.days / 365;
    const xs = spotRange(market.S, v, T);

    // Closed-form curve (GBM only). For Heston we draw a flat zero-line and
    // surface a hint instead — running an FFT-based barrier-by-MC sweep here
    // would be too slow.
    let prices, hint = '';
    if (model.analyticBarrier) {
      prices = xs.map(S => {
        const r = priceAnalytic({ productId: 'barrier', spec, modelId: model.id,
                                  modelParams: model.params, market: { ...market, S } });
        return r ? r.price : 0;
      });
    } else {
      prices = xs.map(_ => NaN);
      hint = 'No closed form under ' + model.id + ' — see MC price in Summary';
    }

    drawLineChart(priceCard.querySelector('#bPrice'), priceCard.querySelector('#bPriceTip'), {
      xs,
      series: [{ label: 'Price', color: '#7dd3fc', ys: prices, type: 'line', width: 2.2 }],
      verticals: [
        { x: market.S, color: 'rgba(125,211,252,0.4)', label: 'SPOT ' + market.S.toFixed(2) },
        { x: spec.strike, color: 'rgba(251,191,36,0.55)', label: 'K ' + spec.strike.toFixed(2) },
        { x: spec.barrier, color: 'rgba(251,113,133,0.7)', label: 'B ' + spec.barrier.toFixed(2) }
      ],
      xFormat: vv => '$' + (vv >= 100 ? vv.toFixed(0) : vv.toFixed(1)),
      tooltip: (idx, xs) => `
        <div class="row"><span>Spot</span><span>$${xs[idx].toFixed(2)}</span></div>
        <div class="row"><span style="color:#7dd3fc">Closed form</span><span>${isFinite(prices[idx]) ? money(prices[idx]) : '—'}</span></div>
        ${hint ? `<div class="row"><span style="color:#8d94ad">${hint}</span></div>` : ''}
      `
    });
  }

  function drawTouch(aux) {
    const T = spec.days / 365;
    const n = aux.cumulativeTouch.length;
    const xs = new Array(n);
    for (let i = 0; i < n; i++) xs[i] = T * (i + 1) / n;
    const ys = aux.cumulativeTouch;

    drawLineChart(touchCard.querySelector('#bTouch'), touchCard.querySelector('#bTouchTip'), {
      xs,
      series: [
        { label: 'P(touched)', color: '#a78bfa', ys, type: 'line', width: 2.2 },
        { label: 'fill', color: '#a78bfa', ys, type: 'area', fillOpacity: 0.18 }
      ],
      xFormat: vv => vv.toFixed(2) + 'y',
      yFormat: vv => (vv * 100).toFixed(0) + '%',
      tooltip: (idx, xs) => `
        <div class="row"><span>t</span><span>${xs[idx].toFixed(3)} y</span></div>
        <div class="row"><span style="color:#a78bfa">P(touched by t)</span><span>${(ys[idx]*100).toFixed(1)}%</span></div>
      `
    });
  }

  function recompute() {
    const market = ctx.getMarket();
    const model = ctx.getModel();
    if (model.disabled) {
      lastClosedForm = null; lastMC = null; lastAux = null;
      renderSummary();
      setBar('Model not ready', 0, 0);
      return;
    }

    // Closed form (instant, GBM only).
    lastClosedForm = priceAnalytic({ productId: 'barrier', spec, modelId: model.id,
                                     modelParams: model.params, market });

    // MC (always — provides touch stats).
    if (runningHandle) runningHandle.cancel();
    setBar('Running MC…', 0, nPaths);
    const t0 = performance.now();
    runningHandle = priceMonteCarlo({
      productId: 'barrier', spec, modelId: model.id,
      modelParams: model.params, market, nPaths,
      seed: 1337,
      sampling: ctx.getSampling ? ctx.getSampling() : 'pseudo',
      onProgress: ({ done, total, mean }) => {
        setBar(`Simulating… price ≈ ${money(mean)}`, done, total);
      },
      onDone: ({ price, stderr, nPaths: n, auxiliary }) => {
        const dt = (performance.now() - t0) / 1000;
        setBar(`MC done · ${dt.toFixed(1)}s`, n, n);
        lastMC = { price, stderr, nPaths: n };
        lastAux = auxiliary;
        renderSummary();
        drawPrice();
        drawTouch(auxiliary);
        runningHandle = null;
      },
      onError: err => {
        console.error(err);
        setBar('Error: ' + err.message, 0, 0);
        runningHandle = null;
      }
    });

    // Render closed-form chart immediately (don't wait for MC).
    renderSummary();
    drawPrice();
  }

  recompute();

  return {
    recompute,
    destroy() {
      if (runningHandle) runningHandle.cancel();
      inputsCard.remove(); summaryCard.remove(); priceCard.remove(); touchCard.remove();
    }
  };
}

// helpers
function h(tag, attrs) { const e = document.createElement(tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; }
function card(title, bodyHTML, _id, headerExtra='') {
  const s = h('section', { class: 'card' });
  s.innerHTML = `<div class="card-h"><h2>${title}</h2>${headerExtra}</div><div class="card-b">${bodyHTML}</div>`;
  return s;
}
function money(x, d=3) { if (!isFinite(x)) return '—'; return (x<0?'-':'')+'$'+Math.abs(x).toFixed(d); }
function shortN(n) {
  if (n >= 1e6) return (n/1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n/1e3).toFixed(0) + 'k';
  return '' + n;
}
