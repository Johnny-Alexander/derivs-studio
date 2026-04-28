// app.js — bootstrap. Owns market/model state, product switcher, PWA register.
import { MODELS } from './models.js';
import { PRODUCTS } from './products.js';
import { mountVanilla } from './ui-vanilla.js';
import { mountDigital } from './ui-digital.js';
import { mountAutocallable } from './ui-autocallable.js';

const state = {
  market: { S: 100, r: 0.045, q: 0.00 }, // rate and div as decimals
  model:  { id: 'gbm', params: { sigma: 0.25 }, disabled: false }
};

// ---- DOM refs ----
const inputsSlot = document.getElementById('inputsSlot');
const outputsSlot = document.getElementById('outputsSlot');
const switcher = document.getElementById('productSwitcher');

// ---- Market card ----
const marketCard = document.createElement('section');
marketCard.className = 'card';
marketCard.innerHTML = `
  <div class="card-h"><h2>Market</h2></div>
  <div class="card-b">
    <div class="inputs-grid">
      <div class="field"><label>Spot</label>
        <div class="wrap"><input id="mSpot" type="number" step="0.01" value="100" /><span class="suffix">$</span></div></div>
      <div class="field"><label>Risk-free rate</label>
        <div class="wrap"><input id="mRate" type="number" step="0.1" value="4.5" /><span class="suffix">%</span></div></div>
      <div class="field"><label>Dividend yield</label>
        <div class="wrap"><input id="mDiv" type="number" step="0.1" value="0.0" /><span class="suffix">%</span></div></div>
      <div class="field"><label>Volatility</label>
        <div class="wrap"><input id="mVol" type="number" step="0.5" value="25" /><span class="suffix">%</span></div></div>
    </div>
  </div>
`;

// ---- Model card ----
const modelCard = document.createElement('section');
modelCard.className = 'card';
modelCard.innerHTML = `
  <div class="card-h"><h2>Model</h2><span class="hint" id="modelHint"></span></div>
  <div class="card-b">
    <div class="field" style="margin-bottom:10px">
      <label>Dynamics</label>
      <div class="wrap"><select id="mModel"></select></div>
    </div>
    <div id="modelDesc" style="font-size:12px;color:var(--text-mute);line-height:1.5"></div>
  </div>
`;

const modelSelect = modelCard.querySelector('#mModel');
Object.values(MODELS).forEach(m => {
  const opt = document.createElement('option');
  opt.value = m.id;
  opt.textContent = m.name + (m.disabled ? ' — soon' : '');
  opt.disabled = !!m.disabled;
  modelSelect.appendChild(opt);
});
modelSelect.value = state.model.id;

function updateModelInfo() {
  const m = MODELS[state.model.id];
  modelCard.querySelector('#modelDesc').textContent = m.description || '';
  modelCard.querySelector('#modelHint').textContent = m.disabled ? 'stub' : 'ready';
  state.model.disabled = !!m.disabled;
}
updateModelInfo();

modelSelect.addEventListener('change', () => {
  state.model.id = modelSelect.value;
  updateModelInfo();
  if (state.model.disabled) return;
  // If a new model needs different params, re-derive defaults. For GBM we keep sigma.
  rebuildCurrentProduct();
});

// ---- Market bindings ----
const spotEl = marketCard.querySelector('#mSpot');
const rateEl = marketCard.querySelector('#mRate');
const divEl  = marketCard.querySelector('#mDiv');
const volEl  = marketCard.querySelector('#mVol');

spotEl.value = state.market.S;
rateEl.value = (state.market.r * 100).toFixed(2);
divEl.value  = (state.market.q * 100).toFixed(2);
volEl.value  = (state.model.params.sigma * 100).toFixed(1);

[spotEl, rateEl, divEl, volEl].forEach(el => el.addEventListener('input', () => {
  state.market.S = +spotEl.value || 0;
  state.market.r = (+rateEl.value || 0) / 100;
  state.market.q = (+divEl.value  || 0) / 100;
  state.model.params.sigma = Math.max(0.0001, (+volEl.value || 0) / 100);
  if (currentUI && currentUI.recompute) currentUI.recompute();
}));

inputsSlot.appendChild(marketCard);
inputsSlot.appendChild(modelCard);

// ---- Context passed to product UIs ----
const ctx = {
  getMarket: () => state.market,
  getModel:  () => state.model
};

let currentProduct = 'vanilla';
let currentUI = null;

function rebuildCurrentProduct() {
  mountProduct(currentProduct);
}

function clearProductArea() {
  if (currentUI && currentUI.destroy) currentUI.destroy();
  currentUI = null;
  // Remove only product cards (keep market + model which are appended first).
  while (inputsSlot.childNodes.length > 2) inputsSlot.removeChild(inputsSlot.lastChild);
  while (outputsSlot.firstChild) outputsSlot.removeChild(outputsSlot.firstChild);
}

function mountProduct(id) {
  clearProductArea();
  currentProduct = id;
  switcher.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.id === id));
  const opts = { inputsSlot, outputsSlot, ctx };
  if (id === 'vanilla')      currentUI = mountVanilla(opts);
  else if (id === 'digital') currentUI = mountDigital(opts);
  else if (id === 'autocallable') currentUI = mountAutocallable(opts);
}

// Wire switcher
switcher.addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  mountProduct(b.dataset.id);
});

// initial mount
mountProduct('vanilla');

// ---- PWA: register service worker ----
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}
