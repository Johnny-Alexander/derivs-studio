// ui-localvol.js — Local-vol surface card. Visible only when LV is active.
//
// Owns the IV surface and the precomputed local-vol grid, and pushes both
// into state.model.params so models.js LV can read them on both threads (the
// MC worker receives them via postMessage).
//
// Default surface mirrors the Calibration card, but is decoupled — the user
// can have one surface for "Heston calibration target" and a different one
// driving LV simulation. They could be unified later; for v3 the duplication
// is the simpler architecture.

import { parametricSmile } from './surface.js';
import { buildLocalVol, packIV } from './localvol.js';
import { drawHeatmap } from './charts.js';

export function mountLocalVol({ host, ctx, applyParams }) {
  const SURFACE_DEFAULTS = {
    T: [0.25, 0.5, 1.0, 1.5, 2.0],
    kPct: [-0.30, -0.20, -0.10, 0.0, 0.10, 0.20, 0.30],
    sigma0: 0.20,
    termSlope: 0.025,
    skew: 0.30,
    curvature: 0.40
  };
  let opts = { ...SURFACE_DEFAULTS };
  let surface = parametricSmile(opts);
  let view = 'lv';   // 'iv' (input) or 'lv' (output)

  const card = document.createElement('section');
  card.className = 'card';
  card.innerHTML = `
    <div class="card-h">
      <h2>Surface · Local Vol</h2>
      <span class="hint" id="lvStatus">idle</span>
    </div>
    <div class="card-b">
      <div style="font-size:12px;color:var(--text-mute);line-height:1.5;margin-bottom:10px">
        Parametric IV surface in log-moneyness. Dupire's formula gives σ_loc(k, T) on the same grid; MC samples it at the running spot via k = ln(S/F).
      </div>
      <div class="inputs-grid" style="margin-bottom:10px">
        <div class="field"><label>ATM σ₀</label>
          <div class="wrap"><input id="lvS0" type="number" step="0.5" value="${(opts.sigma0*100).toFixed(1)}" /><span class="suffix">%</span></div></div>
        <div class="field"><label>Term slope</label>
          <div class="wrap"><input id="lvTerm" type="number" step="0.5" value="${(opts.termSlope*100).toFixed(1)}" /><span class="suffix">%/√y</span></div></div>
        <div class="field"><label>Skew</label>
          <div class="wrap"><input id="lvSk" type="number" step="0.05" value="${opts.skew.toFixed(2)}" /></div></div>
        <div class="field"><label>Curvature</label>
          <div class="wrap"><input id="lvCv" type="number" step="0.05" value="${opts.curvature.toFixed(2)}" /></div></div>
      </div>
      <div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap">
        <button class="preset on" id="lvViewLv" data-v="lv">σ_loc heatmap</button>
        <button class="preset" id="lvViewIv" data-v="iv">σ_imp heatmap</button>
        <button class="preset" id="lvReset">Reset</button>
      </div>
      <div id="lvMetrics" style="font-family:'SF Mono',monospace;font-size:11px;color:var(--text-dim);margin-bottom:10px;line-height:1.6"></div>
      <div class="chart-wrap">
        <svg class="chart short" id="lvHeatmap" preserveAspectRatio="none"></svg>
        <div class="tooltip" id="lvHeatmapTip"></div>
      </div>
      <div style="font-size:10px;color:var(--text-mute);text-align:center;margin-top:6px;letter-spacing:0.06em;text-transform:uppercase" id="lvHmLabel">
        σ_loc (rows: T, cols: k)
      </div>
    </div>
  `;
  host.appendChild(card);

  const statusEl = card.querySelector('#lvStatus');
  const metricsEl = card.querySelector('#lvMetrics');
  const hmEl = card.querySelector('#lvHeatmap');
  const hmTipEl = card.querySelector('#lvHeatmapTip');
  const hmLabelEl = card.querySelector('#lvHmLabel');

  const bind = (id, fn) => card.querySelector('#' + id).addEventListener('input', fn);
  bind('lvS0',   e => { opts.sigma0    = (+e.target.value || 0) / 100; rebuild(); });
  bind('lvTerm', e => { opts.termSlope = (+e.target.value || 0) / 100; rebuild(); });
  bind('lvSk',   e => { opts.skew      = +e.target.value || 0; rebuild(); });
  bind('lvCv',   e => { opts.curvature = +e.target.value || 0; rebuild(); });

  card.querySelector('#lvReset').addEventListener('click', () => {
    opts = { ...SURFACE_DEFAULTS };
    card.querySelector('#lvS0').value   = (opts.sigma0*100).toFixed(1);
    card.querySelector('#lvTerm').value = (opts.termSlope*100).toFixed(1);
    card.querySelector('#lvSk').value   = opts.skew.toFixed(2);
    card.querySelector('#lvCv').value   = opts.curvature.toFixed(2);
    rebuild();
  });
  card.querySelector('#lvViewLv').addEventListener('click', () => setView('lv'));
  card.querySelector('#lvViewIv').addEventListener('click', () => setView('iv'));

  function setView(v) {
    view = v;
    card.querySelector('#lvViewLv').classList.toggle('on', v === 'lv');
    card.querySelector('#lvViewIv').classList.toggle('on', v === 'iv');
    hmLabelEl.textContent = v === 'lv'
      ? 'σ_loc (rows: T, cols: k)'
      : 'σ_imp input (rows: T, cols: k)';
    drawSurface();
  }

  function drawSurface() {
    const N = surface.nT * surface.nK;
    let values, fmt, tooltipFn;
    if (view === 'lv' && lastLV) {
      values = lastLV.sigmaLoc;
      fmt = v => (v * 100).toFixed(2) + '%';
      tooltipFn = (r, c, v) => `
        <div class="row"><span>T</span><span>${surface.T[r].toFixed(2)}</span></div>
        <div class="row"><span>k</span><span>${surface.k[c].toFixed(2)}</span></div>
        <div class="row"><span>σ_loc</span><span>${(v*100).toFixed(2)}%</span></div>`;
    } else {
      values = surface.iv;
      fmt = v => (v * 100).toFixed(2) + '%';
      tooltipFn = (r, c, v) => `
        <div class="row"><span>T</span><span>${surface.T[r].toFixed(2)}</span></div>
        <div class="row"><span>k</span><span>${surface.k[c].toFixed(2)}</span></div>
        <div class="row"><span>σ_imp</span><span>${(v*100).toFixed(2)}%</span></div>`;
    }
    drawHeatmap(hmEl, hmTipEl, {
      xs: Array.from(surface.k),
      ys: Array.from(surface.T),
      values,
      colormap: 'sequential',
      xLabel: 'k', yLabel: 'T',
      xFormat: v => v.toFixed(2),
      yFormat: v => v.toFixed(2),
      valueFormat: fmt,
      tooltip: tooltipFn
    });
  }

  let lastLV = null;
  function rebuild() {
    surface = parametricSmile(opts);
    const t0 = performance.now();
    lastLV = buildLocalVol(surface, { floor: 0.02 });
    const ms = performance.now() - t0;

    // metrics
    let sl_min = Infinity, sl_max = -Infinity;
    for (const v of lastLV.sigmaLoc) {
      if (v < sl_min) sl_min = v;
      if (v > sl_max) sl_max = v;
    }
    let iv_min = Infinity, iv_max = -Infinity;
    for (const v of surface.iv) {
      if (v < iv_min) iv_min = v;
      if (v > iv_max) iv_max = v;
    }
    metricsEl.innerHTML = `
      <div>grid: ${surface.nT}×${surface.nK} = ${surface.nT * surface.nK} points · Dupire in ${ms.toFixed(1)} ms</div>
      <div>σ_imp range: ${(iv_min*100).toFixed(2)}% — ${(iv_max*100).toFixed(2)}%</div>
      <div>σ_loc range: ${(sl_min*100).toFixed(2)}% — ${(sl_max*100).toFixed(2)}%</div>
    `;

    // Push into model params and trigger product recompute.
    const ivPlain = packIV(surface);
    applyParams({
      iv: ivPlain,
      lv: lastLV,
      atmSigma: surface.iv[0 * surface.nK + Math.floor(surface.nK / 2)]   // σ at k≈0, T=T[0]
    });
    statusEl.textContent = 'ready';
    drawSurface();
  }

  rebuild();
  window.addEventListener('resize', drawSurface);

  return {
    setVisible(v) { card.style.display = v ? '' : 'none'; },
    rebuild,
    destroy() { card.remove(); }
  };
}
