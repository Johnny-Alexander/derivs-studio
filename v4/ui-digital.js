// ui-digital.js — European digital (cash-or-nothing) UI
import { priceAnalytic } from './engines.js';
import { drawLineChart } from './charts.js';
import { EuropeanDigital } from './products.js';

export function mountDigital({ inputsSlot, outputsSlot, ctx }) {
  let spec = EuropeanDigital.defaultSpec(ctx.getMarket());
  let activeGreek = 'delta';

  // ---- inputs card ----
  const inputsCard = h('section', { class: 'card' });
  inputsCard.innerHTML = `
    <div class="card-h"><h2>Product · Digital</h2><span class="hint">cash-or-nothing, European</span></div>
    <div class="card-b">
      <div class="type-picker" id="dType">
        <label class="${spec.type==='call'?'on':''}"><input type="radio" name="dType" value="call" ${spec.type==='call'?'checked':''}>Digital Call (pays if S_T &gt; K)</label>
        <label class="${spec.type==='put'?'on':''}"><input type="radio" name="dType" value="put"  ${spec.type==='put'?'checked':''}>Digital Put (pays if S_T &lt; K)</label>
      </div>
      <div class="type-picker" id="dSide">
        <label class="${spec.side==='long'?'on':''}"><input type="radio" name="dSide" value="long"  ${spec.side==='long'?'checked':''}>Long</label>
        <label class="${spec.side==='short'?'on':''}"><input type="radio" name="dSide" value="short" ${spec.side==='short'?'checked':''}>Short</label>
      </div>
      <div class="inputs-grid">
        <div class="field"><label>Strike</label>
          <div class="wrap"><input id="dStrike" type="number" step="0.5" value="${spec.strike}" /><span class="suffix">$</span></div></div>
        <div class="field"><label>Cash payout</label>
          <div class="wrap"><input id="dCash" type="number" step="1" min="0" value="${spec.cash}" /><span class="suffix">$</span></div></div>
        <div class="field"><label>Days to expiry</label>
          <div class="wrap"><input id="dDays" type="number" step="1" min="0" value="${spec.days}" /><span class="suffix">days</span></div></div>
        <div class="field"><label>Quantity</label>
          <div class="wrap"><input id="dQty" type="number" step="1" min="1" value="${spec.qty}" /><span class="suffix">×</span></div></div>
      </div>
    </div>
  `;
  inputsSlot.appendChild(inputsCard);

  const bind = (id, fn) => inputsCard.querySelector('#' + id).addEventListener('input', fn);
  bind('dStrike', e => { spec.strike = +e.target.value; recompute(); });
  bind('dCash',   e => { spec.cash = Math.max(0, +e.target.value || 0); recompute(); });
  bind('dDays',   e => { spec.days = Math.max(0, +e.target.value || 0); recompute(); });
  bind('dQty',    e => { spec.qty  = Math.max(1, Math.floor(+e.target.value || 1)); recompute(); });

  inputsCard.querySelector('#dType').addEventListener('change', e => {
    if (!e.target.name) return;
    spec.type = e.target.value;
    // update label highlight
    inputsCard.querySelectorAll('#dType label').forEach(l => l.classList.toggle('on', l.querySelector('input').checked));
    recompute();
  });
  inputsCard.querySelector('#dSide').addEventListener('change', e => {
    if (!e.target.name) return;
    spec.side = e.target.value;
    inputsCard.querySelectorAll('#dSide label').forEach(l => l.classList.toggle('on', l.querySelector('input').checked));
    recompute();
  });

  // ---- output cards ----
  const summaryCard = card('Position Snapshot', `<div class="summary cols-4" id="dSummary"></div>`);
  const priceCard = card('Price vs Spot', `
    <div class="chart-wrap">
      <svg class="chart" id="dPrice" preserveAspectRatio="none"></svg>
      <div class="tooltip" id="dPriceTip"></div>
    </div>`, null,
    `<div class="legend">
      <span><span class="sw" style="background:var(--accent)"></span>Price (today)</span>
      <span><span class="sw" style="background:var(--accent-2)"></span>Payoff at expiry</span>
    </div>`);
  const greekCard = card('Greeks vs Spot', `
    <div class="chart-wrap">
      <svg class="chart" id="dGreek" preserveAspectRatio="none"></svg>
      <div class="tooltip" id="dGreekTip"></div>
    </div>`, null,
    `<div class="tabs" id="dGreekTabs">
      <button class="tab on" data-g="delta">Delta</button>
      <button class="tab" data-g="gamma">Gamma</button>
      <button class="tab" data-g="vega">Vega</button>
      <button class="tab" data-g="theta">Theta</button>
      <button class="tab" data-g="rho">Rho</button>
    </div>`);

  outputsSlot.appendChild(summaryCard);
  outputsSlot.appendChild(priceCard);
  outputsSlot.appendChild(greekCard);

  greekCard.querySelector('#dGreekTabs').addEventListener('click', e => {
    const b = e.target.closest('.tab'); if (!b) return;
    greekCard.querySelectorAll('.tab').forEach(x => x.classList.remove('on'));
    b.classList.add('on');
    activeGreek = b.dataset.g;
    drawGreek();
  });

  window.addEventListener('resize', () => { drawPrice(); drawGreek(); });

  function renderSummary(net, prob) {
    const el = summaryCard.querySelector('#dSummary');
    el.innerHTML = `
      <div class="kpi price"><div class="k">Price</div><div class="v">${money(net.price)}</div><div class="sub">value today</div></div>
      <div class="kpi delta"><div class="k">Delta</div><div class="v">${num(net.delta,4)}</div><div class="sub">per $1 spot</div></div>
      <div class="kpi vega"><div class="k">Vega</div><div class="v">${signed(net.vega,3)}</div><div class="sub">per 1% vol</div></div>
      <div class="kpi prob"><div class="k">Risk-Neutral P(ITM)</div><div class="v">${(prob*100).toFixed(1)}%</div><div class="sub">implied by model</div></div>
    `;
  }

  function spotRange(S, vol, T) {
    const width = Math.max(0.35, Math.min(0.9, vol * Math.sqrt(Math.max(T, 0.1)) * 3 + 0.25));
    const lo = S * Math.max(0.05, 1 - width);
    const hi = S * (1 + width);
    const pts = 160;
    const xs = new Array(pts);
    for (let i=0;i<pts;i++) xs[i] = lo + (hi-lo) * i/(pts-1);
    return xs;
  }

  function drawPrice() {
    const market = ctx.getMarket();
    const model = ctx.getModel();
    if (model.disabled) return;
    const v = ctx.getEffectiveVol ? ctx.getEffectiveVol() : (model.params.sigma ?? 0.25);
    const T = spec.days/365;
    const xs = spotRange(market.S, v, T);

    const prices = xs.map(S => {
      const r = priceAnalytic({ productId:'digital', spec, modelId: model.id, modelParams: model.params, market: { ...market, S } });
      return r ? r.price : 0;
    });
    const payoffs = xs.map(S => {
      const itm = spec.type==='call' ? S > spec.strike : S < spec.strike;
      const sign = spec.side==='long' ? 1 : -1;
      return sign * spec.qty * spec.cash * (itm ? 1 : 0);
    });

    drawLineChart(priceCard.querySelector('#dPrice'), priceCard.querySelector('#dPriceTip'), {
      xs,
      series: [
        { label: 'Payoff', color: '#a78bfa', ys: payoffs, type: 'line', width: 2.2 },
        { label: 'Price', color: '#7dd3fc', ys: prices, type: 'line', width: 2.2 }
      ],
      verticals: [
        { x: market.S, color: 'rgba(125,211,252,0.4)', label: 'SPOT ' + market.S.toFixed(2) },
        { x: spec.strike, color: 'rgba(251,191,36,0.5)', label: 'K ' + spec.strike.toFixed(2) }
      ],
      xFormat: v => '$' + (v>=100 ? v.toFixed(0) : v.toFixed(1)),
      tooltip: (idx, xs) => `
        <div class="row"><span>Spot</span><span>$${xs[idx].toFixed(2)}</span></div>
        <div class="row"><span style="color:#7dd3fc">Price</span><span>${money(prices[idx])}</span></div>
        <div class="row"><span style="color:#a78bfa">Payoff</span><span>${money(payoffs[idx])}</span></div>
      `
    });
  }

  function drawGreek() {
    const market = ctx.getMarket();
    const model = ctx.getModel();
    if (model.disabled) return;
    const v = ctx.getEffectiveVol ? ctx.getEffectiveVol() : (model.params.sigma ?? 0.25);
    const T = spec.days/365;
    const xs = spotRange(market.S, v, T);
    const ys = xs.map(S => {
      const r = priceAnalytic({ productId:'digital', spec, modelId: model.id, modelParams: model.params, market: { ...market, S } });
      return r ? r[activeGreek] : 0;
    });
    const color = { delta:'#7dd3fc', gamma:'#c4b5fd', vega:'#fde68a', theta:'#fca5a5', rho:'#86efac' }[activeGreek];

    drawLineChart(greekCard.querySelector('#dGreek'), greekCard.querySelector('#dGreekTip'), {
      xs,
      series: [
        { label: activeGreek, color, ys, type: 'line', width: 2.2 },
        { label: 'fill', color, ys, type: 'area', fillOpacity: 0.18 }
      ],
      verticals: [
        { x: market.S, color: 'rgba(125,211,252,0.35)', label: '' },
        { x: spec.strike, color: 'rgba(251,191,36,0.35)', label: 'K' }
      ],
      xFormat: v => '$' + (v>=100 ? v.toFixed(0) : v.toFixed(1)),
      yFormat: v => Math.abs(v) >= 1 ? v.toFixed(2) : (Math.abs(v) >= 0.01 ? v.toFixed(3) : v.toExponential(1)),
      tooltip: (idx, xs) => `
        <div class="row"><span>Spot</span><span>$${xs[idx].toFixed(2)}</span></div>
        <div class="row"><span style="color:${color}">${activeGreek[0].toUpperCase()+activeGreek.slice(1)}</span><span>${ys[idx].toFixed(Math.abs(ys[idx])>=1?3:4)}</span></div>
      `
    });
  }

  function recompute() {
    const market = ctx.getMarket();
    const model = ctx.getModel();
    if (model.disabled) return;
    const net = priceAnalytic({ productId:'digital', spec, modelId: model.id, modelParams: model.params, market });
    if (!net) return;
    // Risk-neutral probability of ITM = undiscounted price / cash  (since digital pays 1 * N(±d2) undiscounted)
    // Our digital returns price = qty*cash * exp(-rT)*N(±d2). P(ITM) = N(±d2) = price / (qty * cash * exp(-rT)) / side_sign
    const T = spec.days/365;
    const disc = Math.exp(-market.r * T);
    const sign = spec.side==='long' ? 1 : -1;
    const pITM = (net.price / (sign * spec.qty * spec.cash * disc)) || 0;
    renderSummary(net, Math.min(1, Math.max(0, pITM)));
    drawPrice();
    drawGreek();
  }

  recompute();

  return { recompute, destroy() { inputsCard.remove(); summaryCard.remove(); priceCard.remove(); greekCard.remove(); } };
}

// helpers
function h(tag, attrs) { const e = document.createElement(tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; }
function card(title, bodyHTML, _id, headerExtra='') {
  const s = h('section', { class: 'card' });
  s.innerHTML = `<div class="card-h"><h2>${title}</h2>${headerExtra}</div><div class="card-b">${bodyHTML}</div>`;
  return s;
}
function money(x, d=3) { if (!isFinite(x)) return '—'; return (x<0?'-':'')+'$'+Math.abs(x).toFixed(d); }
function num(x, d=3) { if (!isFinite(x)) return '—'; return (x<0?'-':'')+Math.abs(x).toFixed(d); }
function signed(x, d=3, money=true) {
  if (!isFinite(x)) return '—';
  const s = x>0?'+':x<0?'-':''; const a = Math.abs(x);
  return s + (money?'$':'') + a.toFixed(d);
}
