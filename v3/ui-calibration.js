// ui-calibration.js — Heston calibration card.
//
// Lives in the inputs column. Visible only while the active model is Heston.
// Workflow:
//   1. Default IV surface (parametricSmile) is loaded on mount.
//   2. User clicks "Calibrate" — runs LM synchronously (small surface, fast).
//   3. Card shows iter count, RMSE in IV %, residual heatmap.
//   4. "Apply" pushes the fit params into state.model.params.

import { parametricSmile, IVSurface } from './surface.js';
import { calibrateHeston } from './calibration.js';
import { drawHeatmap } from './charts.js';

export function mountCalibration({ host, ctx, applyParams, onChange }) {
  // Default surface: a moderate equity-index smile. Tuned to be fittable by
  // Heston (gentler curvature than a pure quadratic-in-k blowup at the wings).
  const SURFACE_DEFAULTS = {
    T: [0.25, 0.5, 1.0, 1.5, 2.0],
    kPct: [-0.20, -0.10, -0.05, 0.0, 0.05, 0.10, 0.20],
    sigma0: 0.20,
    termSlope: 0.025,
    skew: 0.25,
    curvature: 0.30
  };
  let surface = parametricSmile(SURFACE_DEFAULTS);

  let lastResult = null;

  const card = document.createElement('section');
  card.className = 'card';
  card.innerHTML = `
    <div class="card-h">
      <h2>Calibration · Heston</h2>
      <span class="hint" id="calStatus">idle</span>
    </div>
    <div class="card-b">
      <div style="font-size:12px;color:var(--text-mute);line-height:1.5;margin-bottom:10px">
        Default surface: parametric equity-index smile (5 maturities × 7 log-moneyness points).
        Calibration fits (v₀, κ, θ, ξ, ρ) by minimizing IV residuals via Levenberg–Marquardt.
      </div>
      <div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap">
        <button class="preset" id="calRun">Calibrate</button>
        <button class="preset" id="calReset">Reset surface</button>
        <button class="preset" id="calApply" disabled>Apply params</button>
      </div>
      <div id="calMetrics" style="font-family:'SF Mono',monospace;font-size:11px;color:var(--text-dim);margin-bottom:10px;line-height:1.6"></div>
      <div class="chart-wrap" style="margin-top:6px">
        <svg class="chart short" id="calHeatmap" preserveAspectRatio="none"></svg>
        <div class="tooltip" id="calHeatmapTip"></div>
      </div>
      <div style="font-size:10px;color:var(--text-mute);text-align:center;margin-top:6px;letter-spacing:0.06em;text-transform:uppercase">
        Residuals · model IV − market IV (rows: maturity, cols: log-moneyness)
      </div>
    </div>
  `;

  host.appendChild(card);

  const statusEl = card.querySelector('#calStatus');
  const metricsEl = card.querySelector('#calMetrics');
  const runBtn = card.querySelector('#calRun');
  const resetBtn = card.querySelector('#calReset');
  const applyBtn = card.querySelector('#calApply');
  const heatmapEl = card.querySelector('#calHeatmap');
  const heatmapTipEl = card.querySelector('#calHeatmapTip');

  function renderMarketSurface() {
    // Show the input surface so the user sees what we're targeting.
    const N = surface.nT * surface.nK;
    const vals = new Float64Array(N);
    for (let i = 0; i < N; i++) vals[i] = surface.iv[i];
    drawHeatmap(heatmapEl, heatmapTipEl, {
      xs: Array.from(surface.k),
      ys: Array.from(surface.T),
      values: vals,
      colormap: 'sequential',
      xLabel: 'k',
      yLabel: 'T',
      xFormat: v => v.toFixed(2),
      yFormat: v => v.toFixed(2),
      valueFormat: v => (v * 100).toFixed(2) + '%',
      tooltip: (r, c, v) => `
        <div class="row"><span>T</span><span>${surface.T[r].toFixed(2)}</span></div>
        <div class="row"><span>k</span><span>${surface.k[c].toFixed(2)}</span></div>
        <div class="row"><span>market IV</span><span>${(v*100).toFixed(2)}%</span></div>`
    });
    metricsEl.innerHTML = `
      <div>grid: ${surface.nT}×${surface.nK} = ${surface.nT * surface.nK} points</div>
      <div>IV range: ${(surface.iv.reduce((a,b)=>Math.min(a,b), Infinity)*100).toFixed(2)}% — ${(surface.iv.reduce((a,b)=>Math.max(a,b), -Infinity)*100).toFixed(2)}%</div>
    `;
  }

  function renderResiduals(result) {
    const N = surface.nT * surface.nK;
    const diffs = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const m = result.iv_model[i];
      diffs[i] = isFinite(m) ? (m - surface.iv[i]) : NaN;
    }
    drawHeatmap(heatmapEl, heatmapTipEl, {
      xs: Array.from(surface.k),
      ys: Array.from(surface.T),
      values: diffs,
      colormap: 'diverging',
      symmetric: true,
      xLabel: 'k',
      yLabel: 'T',
      xFormat: v => v.toFixed(2),
      yFormat: v => v.toFixed(2),
      valueFormat: v => (v >= 0 ? '+' : '') + (v * 100).toFixed(3) + '%',
      tooltip: (r, c, v) => {
        const mkt = surface.iv[r * surface.nK + c];
        const mdl = result.iv_model[r * surface.nK + c];
        return `
          <div class="row"><span>T</span><span>${surface.T[r].toFixed(2)}</span></div>
          <div class="row"><span>k</span><span>${surface.k[c].toFixed(2)}</span></div>
          <div class="row"><span>market IV</span><span>${(mkt*100).toFixed(2)}%</span></div>
          <div class="row"><span>model IV</span><span>${isFinite(mdl) ? (mdl*100).toFixed(2)+'%' : '—'}</span></div>
          <div class="row"><span>residual</span><span>${(v >= 0 ? '+' : '') + (v*100).toFixed(3)}%</span></div>`;
      }
    });

    // metrics
    let ssr = 0, n = 0, maxAbs = 0;
    for (const d of diffs) {
      if (!isFinite(d)) continue;
      ssr += d * d; n++;
      if (Math.abs(d) > maxAbs) maxAbs = Math.abs(d);
    }
    const rmse = n > 0 ? Math.sqrt(ssr / n) : NaN;
    const p = result.params;
    metricsEl.innerHTML = `
      <div>iter: <b style="color:var(--text)">${result.history.length - 1}</b> · ${result.converged ? `<span style="color:var(--pos)">converged</span>` : `<span style="color:var(--warn)">${result.reason}</span>`}</div>
      <div>RMSE in IV: <b style="color:var(--text)">${(rmse*100).toFixed(3)}%</b> · max |residual|: ${(maxAbs*100).toFixed(3)}%</div>
      <div style="margin-top:6px">v₀=${(Math.sqrt(p.v0)*100).toFixed(2)}%  κ=${p.kappa.toFixed(3)}  θ=${(Math.sqrt(p.theta)*100).toFixed(2)}%  ξ=${p.xi.toFixed(3)}  ρ=${p.rho.toFixed(3)}</div>
    `;
  }

  runBtn.addEventListener('click', () => {
    const market = ctx.getMarket();
    const model = ctx.getModel();
    if (model.id !== 'heston') return;
    statusEl.textContent = 'running...';
    runBtn.disabled = true;
    applyBtn.disabled = true;

    // Defer one frame so the "running…" status renders before we block.
    setTimeout(() => {
      try {
        // Start from a deliberately wrong-ish point so the calibration is doing
        // real work — not from the model's current params (which would be too
        // easy if the user just calibrated and we re-run).
        const initial = { v0: 0.04, kappa: 1.5, theta: 0.06, xi: 0.4, rho: -0.5 };
        const t0 = performance.now();
        const result = calibrateHeston({
          surface,
          S0: market.S,
          market: { r: market.r, q: market.q },
          initial
        });
        const ms = performance.now() - t0;
        lastResult = result;
        renderResiduals(result);
        statusEl.textContent = `${ms.toFixed(0)} ms`;
        applyBtn.disabled = false;
      } catch (e) {
        console.error(e);
        statusEl.textContent = 'error';
        metricsEl.textContent = String(e.message || e);
      } finally {
        runBtn.disabled = false;
      }
    }, 16);
  });

  resetBtn.addEventListener('click', () => {
    surface = parametricSmile(SURFACE_DEFAULTS);
    lastResult = null;
    statusEl.textContent = 'idle';
    applyBtn.disabled = true;
    renderMarketSurface();
  });

  applyBtn.addEventListener('click', () => {
    if (!lastResult) return;
    applyParams(lastResult.params);
    statusEl.textContent = 'applied';
  });

  renderMarketSurface();
  window.addEventListener('resize', () => {
    if (lastResult) renderResiduals(lastResult); else renderMarketSurface();
  });

  return {
    setVisible(v) { card.style.display = v ? '' : 'none'; },
    destroy() { card.remove(); }
  };
}
