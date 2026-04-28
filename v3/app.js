// app.js — bootstrap. Owns market/model state, product switcher, PWA register.
//
// v3: model params card is rendered dynamically from the active model's
// paramSchema. Each param has a key, a label, an optional unit, and an
// optional `scale` (display-multiplier). Format hints:
//   format: 'pctVar' — value stored as variance, displayed as σ% = √v · 100.
//   default: stored value is multiplied by `scale` to display.
import { MODELS } from './models.js';
import { PRODUCTS } from './products.js';
import { mountVanilla } from './ui-vanilla.js';
import { mountDigital } from './ui-digital.js';
import { mountAutocallable } from './ui-autocallable.js';
import { mountCalibration } from './ui-calibration.js';

// Forward-declare so updateModelInfo() can toggle calibration visibility before
// the calibration card is actually constructed. Assigned later in this file.
let calibrationUI = null;

// state.model.params holds the active model's params. It is rebuilt from the
// model's paramSchema whenever the user switches models.
const state = {
  market: { S: 100, r: 0.045, q: 0.00 },
  model:  { id: 'gbm', params: defaultParams('gbm'), disabled: false }
};

function defaultParams(modelId) {
  const m = MODELS[modelId];
  if (!m || !m.paramSchema) return {};
  const out = {};
  for (const f of m.paramSchema) out[f.key] = f.default;
  return out;
}

// ---- DOM refs ----
const inputsSlot = document.getElementById('inputsSlot');
const outputsSlot = document.getElementById('outputsSlot');
const switcher = document.getElementById('productSwitcher');

// ---- Market card (no vol — vol lives in the Model card per active schema) ----
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
    <div id="modelDesc" style="font-size:12px;color:var(--text-mute);line-height:1.5;margin-bottom:10px"></div>
    <div id="modelParams" class="inputs-grid"></div>
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

const modelParamsHost = modelCard.querySelector('#modelParams');

// Render fields based on the active model's paramSchema. Each field's display
// value is `state.model.params[key] * (scale ?? 1)`, except for fields with
// `format: 'pctVar'`, which display √v · 100 (so users see σ%, not v%).
function renderModelParams() {
  modelParamsHost.innerHTML = '';
  const m = MODELS[state.model.id];
  if (!m || !m.paramSchema) return;
  for (const f of m.paramSchema) {
    const wrap = document.createElement('div');
    wrap.className = 'field';
    const labelText = f.unit ? `${f.label}` : f.label;
    const suffix = f.unit ? `<span class="suffix">${f.unit}</span>` : '';
    const scale = f.scale ?? 1;
    const stored = state.model.params[f.key];
    let displayed;
    if (f.format === 'pctVar') {
      displayed = (Math.sqrt(Math.max(0, stored)) * 100).toFixed(2);
    } else {
      displayed = (stored * scale).toFixed(scaleDecimals(f.step ?? 0.01, scale));
    }
    wrap.innerHTML = `
      <label>${labelText}</label>
      <div class="wrap">
        <input type="number" step="${f.step ?? 0.01}" value="${displayed}" data-key="${f.key}" data-format="${f.format||''}" data-scale="${scale}" />
        ${suffix}
      </div>
    `;
    const inp = wrap.querySelector('input');
    inp.addEventListener('input', () => {
      const v = +inp.value;
      const key = f.key;
      let stored;
      if (f.format === 'pctVar') {
        const sigma = (v / 100);
        stored = Math.max(1e-8, sigma * sigma);
      } else {
        stored = v / scale;
      }
      // clamp
      if (f.min != null) stored = Math.max(f.min, stored);
      if (f.max != null) stored = Math.min(f.max, stored);
      state.model.params[key] = stored;
      if (currentUI && currentUI.recompute) currentUI.recompute();
    });
    modelParamsHost.appendChild(wrap);
  }
}

function scaleDecimals(step, scale) {
  const s = step * scale;
  if (s >= 1) return 1;
  if (s >= 0.1) return 2;
  if (s >= 0.01) return 3;
  return 4;
}

function updateModelInfo() {
  const m = MODELS[state.model.id];
  modelCard.querySelector('#modelDesc').textContent = m.description || '';
  modelCard.querySelector('#modelHint').textContent = m.disabled ? 'stub' : 'ready';
  state.model.disabled = !!m.disabled;
  if (calibrationUI) calibrationUI.setVisible(state.model.id === 'heston');
}
updateModelInfo();
renderModelParams();

modelSelect.addEventListener('change', () => {
  state.model.id = modelSelect.value;
  state.model.params = defaultParams(state.model.id);
  updateModelInfo();
  renderModelParams();
  if (state.model.disabled) return;
  rebuildCurrentProduct();
});

// ---- Market bindings ----
const spotEl = marketCard.querySelector('#mSpot');
const rateEl = marketCard.querySelector('#mRate');
const divEl  = marketCard.querySelector('#mDiv');

spotEl.value = state.market.S;
rateEl.value = (state.market.r * 100).toFixed(2);
divEl.value  = (state.market.q * 100).toFixed(2);

[spotEl, rateEl, divEl].forEach(el => el.addEventListener('input', () => {
  state.market.S = +spotEl.value || 0;
  state.market.r = (+rateEl.value || 0) / 100;
  state.market.q = (+divEl.value  || 0) / 100;
  if (currentUI && currentUI.recompute) currentUI.recompute();
}));

inputsSlot.appendChild(marketCard);
inputsSlot.appendChild(modelCard);

// ---- Calibration card (Heston-only). Shown/hidden by updateModelInfo. ----
calibrationUI = mountCalibration({
  host: inputsSlot,
  ctx: { getMarket: () => state.market, getModel: () => state.model },
  applyParams: (p) => {
    // Push fitted params back into state.model.params and refresh model-card
    // inputs so the user sees them update.
    state.model.params = { ...p };
    renderModelParams();
    if (currentUI && currentUI.recompute) currentUI.recompute();
  }
});
calibrationUI.setVisible(state.model.id === 'heston');

// ---- Context passed to product UIs ----
const ctx = {
  getMarket: () => state.market,
  getModel:  () => state.model,
  // Effective vol for chart-axis sizing. Falls back to 0.25 if the model
  // doesn't expose one (shouldn't happen in v3, but stays safe).
  getEffectiveVol: () => {
    const m = MODELS[state.model.id];
    if (m && m.effectiveVol) return m.effectiveVol(state.model.params);
    return state.model.params.sigma ?? 0.25;
  }
};

let currentProduct = 'vanilla';
let currentUI = null;

function rebuildCurrentProduct() {
  mountProduct(currentProduct);
}

function clearProductArea() {
  if (currentUI && currentUI.destroy) currentUI.destroy();
  currentUI = null;
  // Keep the fixed left-column cards: Market, Model, Calibration.
  while (inputsSlot.childNodes.length > 3) inputsSlot.removeChild(inputsSlot.lastChild);
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

switcher.addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  mountProduct(b.dataset.id);
});

mountProduct('vanilla');

// Service worker disabled during active development — it caches modules and
// makes iterative debugging painful. Re-enable once v3 ships.
// if ('serviceWorker' in navigator && location.protocol !== 'file:') {
//   window.addEventListener('load', () => {
//     navigator.serviceWorker.register('./sw.js').catch(() => {});
//   });
// }
