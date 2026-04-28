// ui-vanilla.js — vanilla multi-leg portfolio UI
import { priceAnalytic } from './engines.js';
import { drawLineChart } from './charts.js';
import { MODELS } from './models.js';
import { VanillaPortfolio } from './products.js';

const PRESETS = [
  { name: 'Long Call',       build: S => [{ side:'long', type:'call', strike: rK(S,1), qty:1 }] },
  { name: 'Long Put',        build: S => [{ side:'long', type:'put',  strike: rK(S,1), qty:1 }] },
  { name: 'Straddle',        build: S => [
      { side:'long', type:'call', strike:rK(S,1), qty:1 },
      { side:'long', type:'put',  strike:rK(S,1), qty:1 }
  ]},
  { name: 'Strangle',        build: S => [
      { side:'long', type:'call', strike:rK(S,1.05), qty:1 },
      { side:'long', type:'put',  strike:rK(S,0.95), qty:1 }
  ]},
  { name: 'Bull Call Spread', build: S => [
      { side:'long',  type:'call', strike:rK(S,0.98), qty:1 },
      { side:'short', type:'call', strike:rK(S,1.05), qty:1 }
  ]},
  { name: 'Bear Put Spread',  build: S => [
      { side:'long',  type:'put', strike:rK(S,1.02), qty:1 },
      { side:'short', type:'put', strike:rK(S,0.95), qty:1 }
  ]},
  { name: 'Iron Condor',     build: S => [
      { side:'short', type:'put',  strike:rK(S,0.95), qty:1 },
      { side:'long',  type:'put',  strike:rK(S,0.90), qty:1 },
      { side:'short', type:'call', strike:rK(S,1.05), qty:1 },
      { side:'long',  type:'call', strike:rK(S,1.10), qty:1 }
  ]},
  { name: 'Butterfly',       build: S => [
      { side:'long',  type:'call', strike:rK(S,0.95), qty:1 },
      { side:'short', type:'call', strike:rK(S,1.00), qty:2 },
      { side:'long',  type:'call', strike:rK(S,1.05), qty:1 }
  ]},
  { name: 'Risk Reversal',   build: S => [
      { side:'long',  type:'call', strike:rK(S,1.05), qty:1 },
      { side:'short', type:'put',  strike:rK(S,0.95), qty:1 }
  ]}
];
function rK(S, mult){ const raw=S*mult; if(S>=50)return Math.round(raw); if(S>=10)return Math.round(raw*2)/2; return Math.round(raw*10)/10; }

export function mountVanilla({ inputsSlot, outputsSlot, ctx }) {
  let spec = VanillaPortfolio.defaultSpec(ctx.getMarket());
  let activeGreek = 'delta';

  // ---- inputs card ----
  const inputsCard = h('section', { class: 'card' });
  inputsCard.innerHTML = `
    <div class="card-h"><h2>Product · Vanilla</h2><span id="legCount" class="hint"></span></div>
    <div class="card-b">
      <div class="inputs-grid" style="margin-bottom:12px">
        <div class="field" style="grid-column:span 2">
          <label>Days to expiry</label>
          <div class="wrap"><input id="days" type="number" step="1" min="0" value="${spec.days}" /><span class="suffix">days</span></div>
        </div>
      </div>
      <div style="font-size:10px;color:var(--text-mute);letter-spacing:0.12em;text-transform:uppercase;margin-bottom:6px">Presets</div>
      <div class="presets" id="presets"></div>
      <div style="font-size:10px;color:var(--text-mute);letter-spacing:0.12em;text-transform:uppercase;margin:14px 0 6px">Legs</div>
      <div class="leg-head"><span>Side</span><span>Type</span><span>Strike</span><span>Qty</span><span></span></div>
      <div class="legs" id="legs"></div>
      <button class="btn-add" id="addLeg">+ Add leg</button>
    </div>
  `;
  inputsSlot.appendChild(inputsCard);

  const daysEl = inputsCard.querySelector('#days');
  const legsEl = inputsCard.querySelector('#legs');
  const presetsEl = inputsCard.querySelector('#presets');
  const legCountEl = inputsCard.querySelector('#legCount');

  daysEl.addEventListener('input', () => {
    spec.days = Math.max(0, +daysEl.value || 0);
    recompute();
  });
  inputsCard.querySelector('#addLeg').onclick = () => {
    const last = spec.legs[spec.legs.length - 1];
    spec.legs.push({ side:'long', type: last ? last.type : 'call', strike: ctx.getMarket().S, qty: 1 });
    renderLegs(); recompute();
  };

  PRESETS.forEach(p => {
    const b = h('button', { class: 'preset' });
    b.textContent = p.name;
    b.onclick = () => { spec.legs = p.build(ctx.getMarket().S); renderLegs(); recompute(); };
    presetsEl.appendChild(b);
  });

  // ---- output cards ----
  const summaryCard = card('Position Snapshot', `<div class="summary" id="vSummary"></div>`, 'vSummary');
  const pnlCard = card('Profit &amp; Loss', `
    <div class="chart-wrap">
      <svg class="chart" id="vPnl" preserveAspectRatio="none"></svg>
      <div class="tooltip" id="vPnlTip"></div>
    </div>`,
    null,
    `<div class="legend">
      <span><span class="sw" style="background:var(--accent)"></span>At expiry</span>
      <span><span class="sw" style="background:var(--accent-2)"></span>Today (mark-to-market)</span>
    </div>`);
  const greekCard = card('Greeks vs Spot', `
    <div class="chart-wrap">
      <svg class="chart" id="vGreek" preserveAspectRatio="none"></svg>
      <div class="tooltip" id="vGreekTip"></div>
    </div>`, null,
    `<div class="tabs" id="vGreekTabs">
      <button class="tab on" data-g="delta">Delta</button>
      <button class="tab" data-g="gamma">Gamma</button>
      <button class="tab" data-g="vega">Vega</button>
      <button class="tab" data-g="theta">Theta</button>
      <button class="tab" data-g="rho">Rho</button>
    </div>`);

  outputsSlot.appendChild(summaryCard);
  outputsSlot.appendChild(pnlCard);
  outputsSlot.appendChild(greekCard);

  greekCard.querySelector('#vGreekTabs').addEventListener('click', e => {
    const b = e.target.closest('.tab'); if (!b) return;
    greekCard.querySelectorAll('.tab').forEach(x => x.classList.remove('on'));
    b.classList.add('on');
    activeGreek = b.dataset.g;
    drawGreekVsSpot();
  });

  window.addEventListener('resize', () => { drawPnl(); drawGreekVsSpot(); });

  function renderLegs() {
    legsEl.innerHTML = '';
    spec.legs.forEach((leg, i) => {
      const row = h('div', { class: 'leg' });
      const side = h('div', { class: 'seg' });
      side.innerHTML = `
        <button class="long ${leg.side==='long'?'on':''}" data-v="long">LONG</button>
        <button class="short ${leg.side==='short'?'on':''}" data-v="short">SHRT</button>`;
      side.querySelectorAll('button').forEach(btn => btn.onclick = () => { leg.side = btn.dataset.v; renderLegs(); recompute(); });

      const type = h('div', { class: 'seg' });
      type.innerHTML = `
        <button class="call ${leg.type==='call'?'on':''}" data-v="call">CALL</button>
        <button class="put ${leg.type==='put'?'on':''}" data-v="put">PUT</button>`;
      type.querySelectorAll('button').forEach(btn => btn.onclick = () => { leg.type = btn.dataset.v; renderLegs(); recompute(); });

      const strike = h('input', { class: 'num', type: 'number', step: '0.5', value: leg.strike });
      strike.oninput = () => { leg.strike = +strike.value; recompute(); };
      const qty = h('input', { class: 'num', type: 'number', step: '1', min: '1', value: leg.qty });
      qty.oninput = () => { leg.qty = Math.max(1, Math.floor(+qty.value || 1)); recompute(); };
      const rm = h('button', { class: 'rm', title: 'Remove leg' });
      rm.textContent = '×';
      rm.onclick = () => { spec.legs.splice(i, 1); renderLegs(); recompute(); };

      row.append(side, type, strike, qty, rm);
      legsEl.appendChild(row);
    });
    legCountEl.textContent = `${spec.legs.length} ${spec.legs.length===1?'leg':'legs'}`;
  }

  function renderSummary(net) {
    const el = summaryCard.querySelector('#vSummary');
    const costLabel = net.price >= 0 ? 'Debit' : 'Credit';
    el.innerHTML = `
      <div class="kpi price"><div class="k">Position Value</div><div class="v">${money(net.price)}</div><div class="sub">${costLabel} at entry</div></div>
      <div class="kpi delta"><div class="k">Delta</div><div class="v">${num(net.delta,3)}</div><div class="sub">per $1 spot</div></div>
      <div class="kpi gamma"><div class="k">Gamma</div><div class="v">${num(net.gamma,4)}</div><div class="sub">Δ-change per $1</div></div>
      <div class="kpi vega"><div class="k">Vega</div><div class="v">${signed(net.vega,3)}</div><div class="sub">per 1% vol</div></div>
      <div class="kpi theta"><div class="k">Theta</div><div class="v">${signed(net.theta,3)}</div><div class="sub">per day</div></div>
      <div class="kpi rho"><div class="k">Rho</div><div class="v">${signed(net.rho,3)}</div><div class="sub">per 1% rate</div></div>
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

  function drawPnl() {
    const market = ctx.getMarket();
    const model = ctx.getModel();
    const v = model.params.sigma;
    const T = spec.days/365;
    const entry = priceAnalytic({ productId:'vanilla', spec, modelId: model.id, modelParams: model.params, market });
    if (!entry) return;
    const xs = spotRange(market.S, v, T);

    const payoffs = xs.map(S => {
      let p = 0;
      for (const leg of spec.legs) {
        const sign = leg.side==='long' ? 1 : -1;
        const intrinsic = leg.type==='call' ? Math.max(S-leg.strike,0) : Math.max(leg.strike-S,0);
        p += sign * leg.qty * intrinsic;
      }
      return p - entry.price;
    });
    const nows = xs.map(S => {
      const res = priceAnalytic({
        productId: 'vanilla', spec, modelId: model.id, modelParams: model.params,
        market: { ...market, S }
      });
      return res.price - entry.price;
    });

    // breakevens at expiry
    const markers = [];
    for (let i=1;i<xs.length;i++) {
      const a = payoffs[i-1], b = payoffs[i];
      if ((a <= 0 && b >= 0) || (a >= 0 && b <= 0)) {
        const t = Math.abs(a) / (Math.abs(a) + Math.abs(b) || 1);
        const xCross = xs[i-1] + (xs[i]-xs[i-1]) * t;
        markers.push({ x: xCross, y: 0, color: '#fbbf24', label: 'BE ' + xCross.toFixed(2) });
      }
    }

    const verticals = [{ x: market.S, color: 'rgba(125,211,252,0.45)', label: 'SPOT ' + market.S.toFixed(2) }];
    const seenStrikes = new Set();
    for (const leg of spec.legs) {
      if (seenStrikes.has(leg.strike)) continue;
      seenStrikes.add(leg.strike);
      verticals.push({ x: leg.strike, color: leg.type==='call' ? 'rgba(56,189,248,0.35)' : 'rgba(244,114,182,0.35)', label: '' });
    }

    drawLineChart(pnlCard.querySelector('#vPnl'), pnlCard.querySelector('#vPnlTip'), {
      xs,
      series: [
        { label: 'At expiry', color: '#7dd3fc', ys: payoffs, type: 'line', width: 2.2 },
        { label: 'Now', color: '#a78bfa', ys: nows, type: 'dashed' },
        { label: 'Fill', color: '#7dd3fc', ys: payoffs, type: 'area-signed' }
      ],
      markers, verticals,
      xFormat: v => '$' + (v>=100 ? v.toFixed(0) : v.toFixed(1)),
      tooltip: (idx, xs) => `
        <div class="row"><span>Spot</span><span>$${xs[idx].toFixed(2)}</span></div>
        <div class="row"><span style="color:#7dd3fc">At expiry</span><span>${signed(payoffs[idx])}</span></div>
        <div class="row"><span style="color:#a78bfa">Now</span><span>${signed(nows[idx])}</span></div>
      `
    });
  }

  function drawGreekVsSpot() {
    const market = ctx.getMarket();
    const model = ctx.getModel();
    const v = model.params.sigma;
    const T = spec.days/365;
    const xs = spotRange(market.S, v, T);
    const ys = xs.map(S => {
      const res = priceAnalytic({
        productId: 'vanilla', spec, modelId: model.id, modelParams: model.params,
        market: { ...market, S }
      });
      return res ? res[activeGreek] : 0;
    });

    const color = { delta:'#7dd3fc', gamma:'#c4b5fd', vega:'#fde68a', theta:'#fca5a5', rho:'#86efac' }[activeGreek];

    drawLineChart(greekCard.querySelector('#vGreek'), greekCard.querySelector('#vGreekTip'), {
      xs,
      series: [
        { label: activeGreek, color, ys, type:'line', width: 2.2 },
        { label: 'Fill', color, ys, type:'area', fillOpacity: 0.18 }
      ],
      verticals: [{ x: market.S, color: 'rgba(125,211,252,0.35)', label: '' }],
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
    if (model.disabled) {
      renderSummary({ price: NaN, delta: NaN, gamma: NaN, vega: NaN, theta: NaN, rho: NaN });
      return;
    }
    const net = priceAnalytic({ productId:'vanilla', spec, modelId: model.id, modelParams: model.params, market });
    if (!net) return;
    renderSummary(net);
    drawPnl();
    drawGreekVsSpot();
  }

  renderLegs();
  recompute();

  return { recompute, destroy() {
    inputsCard.remove(); summaryCard.remove(); pnlCard.remove(); greekCard.remove();
  }};
}

// ---- helpers ----
function h(tag, attrs) {
  const e = document.createElement(tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  return e;
}
function card(title, bodyHTML, id, headerExtra = '') {
  const s = h('section', { class: 'card' });
  s.innerHTML = `<div class="card-h"><h2>${title}</h2>${headerExtra}</div><div class="card-b">${bodyHTML}</div>`;
  return s;
}
function money(x, d=2) { if (!isFinite(x)) return '—'; return (x<0?'-':'')+'$'+Math.abs(x).toFixed(d); }
function num(x, d=3) { if (!isFinite(x)) return '—'; return (x<0?'-':'')+Math.abs(x).toFixed(d); }
function signed(x, d=2, money=true) {
  if (!isFinite(x)) return '—';
  const s = x>0?'+':x<0?'-':''; const a = Math.abs(x);
  return s + (money?'$':'') + a.toFixed(d);
}
