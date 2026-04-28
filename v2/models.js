// models.js — risk-neutral asset-price models.
//
// Model interface:
//   id, name, paramSchema: [{ key, label, unit, scale, default, ... }]
//   simulatePath(S0, grid, market, params, normals, outPath)
//     grid: Float64Array of times [0, t_1, ..., t_n]
//     normals: Float64Array of N(0,1) of length grid.length - 1
//     outPath: Float64Array of length grid.length, filled in place
//   analyticVanilla?(type, S0, K, T, market, params) -> {price, delta, gamma, vega, theta, rho}
//   analyticDigital?(type, S0, K, T, market, params) -> {...}
//
// Keep this file importable by a Web Worker — no DOM access.

import { bs, bsDigital } from './core.js';

export const GBM = {
  id: 'gbm',
  name: 'Black–Scholes / GBM',
  description: 'Geometric Brownian motion. Constant vol, constant rates. Closed-form for vanillas.',
  paramSchema: [
    { key: 'sigma', label: 'Volatility', unit: '%', scale: 100, default: 0.25, min: 0.01, max: 2.0, step: 0.005 }
  ],
  simulatePath(S0, grid, market, params, normals, out) {
    const r = market.r, q = market.q, sigma = params.sigma;
    out[0] = S0;
    for (let i = 1; i < grid.length; i++) {
      const dt = grid[i] - grid[i - 1];
      const drift = (r - q - 0.5 * sigma * sigma) * dt;
      const diff  = sigma * Math.sqrt(dt) * normals[i - 1];
      out[i] = out[i - 1] * Math.exp(drift + diff);
    }
  },
  analyticVanilla(type, S0, K, T, market, params) {
    return bs(type, S0, K, T, market.r, market.q, params.sigma);
  },
  analyticDigital(type, S0, K, T, market, params) {
    return bsDigital(type, S0, K, T, market.r, market.q, params.sigma);
  }
};

// Stubs for future models. These advertise themselves but won't price.
export const HESTON_STUB = {
  id: 'heston',
  name: 'Heston (stochastic vol)',
  description: 'Coming in phase 2. Semi-analytic for vanillas via Carr–Madan FFT; MC for exotics.',
  disabled: true,
  paramSchema: []
};
export const LV_STUB = {
  id: 'localvol',
  name: 'Dupire Local Vol',
  description: 'Coming in phase 3. Calibrated from an implied-vol surface you input.',
  disabled: true,
  paramSchema: []
};
export const SLV_STUB = {
  id: 'slv',
  name: 'Stochastic Local Vol',
  description: 'Coming in phase 4. LV × leverage function tuned to match Heston marginals.',
  disabled: true,
  paramSchema: []
};

export const MODELS = {
  gbm: GBM,
  heston: HESTON_STUB,
  localvol: LV_STUB,
  slv: SLV_STUB
};
