// models.js — risk-neutral asset-price models.
//
// Model interface (v3):
//   id, name, paramSchema: [{ key, label, unit, scale, default, ... }]
//   stateDim: integer ≥ 1. Number of state variables per time step. Default 1
//             (asset only). Heston is 2 (S, v), SLV is 2, etc. The first slot
//             of the state vector is always the spot price S.
//   normalsPerStep: integer ≥ 1. Number of independent N(0,1)s consumed per
//             step. Default 1. Heston needs 2 (correlated inside the model).
//   simulateState(S0, grid, market, params, normals, outState)
//     grid: Float64Array of times [0, t_1, ..., t_n]
//     normals: Float64Array of N(0,1) of length (grid.length - 1) * normalsPerStep
//     outState: Float64Array of length grid.length * stateDim, filled in place.
//               State at time grid[i] lives at outState[i*stateDim .. i*stateDim+stateDim-1].
//   simulatePath(S0, grid, market, params, normals, outPath)
//     Backwards-compatible wrapper. Default impl reads slot 0 of simulateState.
//     Models that only define simulatePath get a default simulateState that
//     stores it in slot 0. Either direction works — see attachDefaults below.
//   analyticVanilla?(type, S0, K, T, market, params) -> {price, delta, gamma, vega, theta, rho}
//   analyticDigital?(type, S0, K, T, market, params) -> {...}
//
// Keep this file importable by a Web Worker — no DOM access.

import { bs, bsDigital } from './core.js';
import { hestonCallPricer, putFromCall } from './transforms.js';

// Fill in defaults so every model has both stateDim/normalsPerStep and both
// simulatePath/simulateState. Idempotent.
export function attachDefaults(model) {
  if (model.stateDim == null) model.stateDim = 1;
  if (model.normalsPerStep == null) model.normalsPerStep = 1;
  if (!model.simulateState && model.simulatePath) {
    const sd = model.stateDim;
    model.simulateState = function(S0, grid, market, params, normals, outState) {
      // Re-use a temp Float64Array so we don't allocate per call from the worker.
      const tmp = new Float64Array(grid.length);
      model.simulatePath(S0, grid, market, params, normals, tmp);
      for (let i = 0; i < grid.length; i++) outState[i * sd] = tmp[i];
    };
  }
  if (!model.simulatePath && model.simulateState) {
    const sd = model.stateDim;
    model.simulatePath = function(S0, grid, market, params, normals, outPath) {
      const state = new Float64Array(grid.length * sd);
      model.simulateState(S0, grid, market, params, normals, state);
      for (let i = 0; i < grid.length; i++) outPath[i] = state[i * sd];
    };
  }
  return model;
}

export const GBM = attachDefaults({
  id: 'gbm',
  name: 'Black–Scholes / GBM',
  description: 'Geometric Brownian motion. Constant vol, constant rates. Closed-form for vanillas.',
  stateDim: 1,
  normalsPerStep: 1,
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
  },
  effectiveVol(params) { return params.sigma; }
});

// Heston (stochastic vol) — full implementation in v3.
//
// Risk-neutral dynamics:
//   dS = (r - q) S dt + sqrt(v) S dW1
//   dv = κ(θ - v) dt + ξ sqrt(v) dW2,   corr(dW1, dW2) = ρ
//
// Simulation: full-truncation Euler on v (the "FT" scheme) — robust around
// v ≈ 0 with no negative-variance blowups. Log-Euler on S using v_t+ = max(v, 0).
//
// Vanilla pricing: Carr–Madan FFT. One FFT amortizes across the strike axis,
// so we cache the pricer between repeated K queries with the same (S, T).
// Greeks: finite differences. Cheap because the FFT call is ~ms.
//
// Digital pricing: -dC/dK via a small call spread on the FFT curve.

export const HESTON = attachDefaults({
  id: 'heston',
  name: 'Heston (stochastic vol)',
  description: 'Stochastic variance with mean-reversion. Carr–Madan FFT for vanillas, full-truncation Euler MC for exotics. Set ξ→0 with v0=θ to recover BS at σ=√θ.',
  stateDim: 2,
  normalsPerStep: 2,
  paramSchema: [
    { key: 'v0',    label: 'Initial variance v\u2080', unit: '%', scale: 100, format: 'pctVar', default: 0.0625, min: 0.0001, max: 1.0,  step: 0.001 },
    { key: 'kappa', label: 'Mean-reversion κ',         unit: '',   scale: 1,   default: 1.5,    min: 0.05,   max: 20.0, step: 0.1 },
    { key: 'theta', label: 'Long-run variance θ',      unit: '%', scale: 100, format: 'pctVar', default: 0.0625, min: 0.0001, max: 1.0,  step: 0.001 },
    { key: 'xi',    label: 'Vol-of-vol ξ',             unit: '',   scale: 1,   default: 0.4,    min: 0.0,    max: 3.0,  step: 0.05 },
    { key: 'rho',   label: 'Correlation ρ',            unit: '',   scale: 1,   default: -0.7,   min: -0.999, max: 0.999, step: 0.05 }
  ],
  effectiveVol(params) { return Math.sqrt(Math.max(1e-8, params.theta)); },

  // Full-truncation Euler. normals layout per step:
  //   normals[2k]   -> Z1 (drives S)
  //   normals[2k+1] -> Zperp (independent)
  // Z2 (driving v) is built as ρ Z1 + sqrt(1-ρ²) Zperp.
  simulateState(S0, grid, market, params, normals, outState) {
    const r = market.r, q = market.q;
    const { kappa, theta, xi, rho, v0 } = params;
    const sd = 2;
    const sqrtOneMinusRho2 = Math.sqrt(Math.max(0, 1 - rho * rho));

    let S = S0, v = Math.max(0, v0);
    outState[0] = S;
    outState[1] = v;
    for (let i = 1; i < grid.length; i++) {
      const dt = grid[i] - grid[i - 1];
      const sqrtDt = Math.sqrt(dt);
      const Z1 = normals[(i - 1) * 2];
      const Zp = normals[(i - 1) * 2 + 1];
      const Z2 = rho * Z1 + sqrtOneMinusRho2 * Zp;

      const vPos = Math.max(0, v);
      const sqrtV = Math.sqrt(vPos);

      // log-Euler on S using vPos
      const drift = (r - q - 0.5 * vPos) * dt;
      const diff  = sqrtV * sqrtDt * Z1;
      S = S * Math.exp(drift + diff);

      // FT-Euler on v: v_{t+dt} = v + κ(θ - vPos) dt + ξ sqrtV sqrtDt Z2
      v = v + kappa * (theta - vPos) * dt + xi * sqrtV * sqrtDt * Z2;

      outState[i * sd]     = S;
      outState[i * sd + 1] = v;
    }
  },

  analyticVanilla(type, S0, K, T, market, params) {
    if (T <= 0) {
      const intrinsic = type === 'call' ? Math.max(S0 - K, 0) : Math.max(K - S0, 0);
      return { price: intrinsic, delta: type === 'call' ? (S0 > K ? 1 : 0) : (S0 < K ? -1 : 0),
               gamma: 0, vega: 0, theta: 0, rho: 0 };
    }
    return hestonGreeks(type, S0, K, T, market, params);
  },

  analyticDigital(type, S0, K, T, market, params) {
    return hestonDigitalGreeks(type, S0, K, T, market, params);
  }
});
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
  heston: HESTON,
  localvol: LV_STUB,
  slv: SLV_STUB
};

// ---------- Heston greeks via finite differences on FFT pricer ----------
//
// One Carr–Madan FFT gives us C(K) for the whole strike axis in ~ms. Greeks
// in S, sigma-of-vol params, T, r are bumped numerically. We reuse the same
// pricer when we can (e.g. delta/gamma bump only S, so we rebuild the FFT
// for each spot bump — still cheap).

function hestonGreeks(type, S0, K, T, market, params) {
  const r = market.r, q = market.q;
  const priceCallAt = (S, T_, r_) =>
    hestonCallPricer({ S0: S, r: r_, q, T: T_, params })(K);

  const C0 = priceCallAt(S0, T, r);
  // bumps
  const hS = Math.max(0.01, S0 * 0.005);
  const Cp = priceCallAt(S0 + hS, T, r);
  const Cm = priceCallAt(S0 - hS, T, r);
  const deltaCall = (Cp - Cm) / (2 * hS);
  const gamma = (Cp - 2 * C0 + Cm) / (hS * hS);

  const hT = Math.max(1e-4, T * 0.01);
  // theta: d/dT (price) — but quoted "per day", and we want time-decay (negative T direction)
  const Cf = priceCallAt(S0, T + hT, r);
  const dC_dT = (Cf - C0) / hT;       // ∂C/∂T (calendar time forward)
  const thetaCall = -dC_dT / 365;     // per-day, sign convention: option loses value as T→0

  const hR = 1e-4;
  const dC_dr = (priceCallAt(S0, T, r + hR) - C0) / hR;
  const rhoCall = dC_dr / 100;        // per 1% rate

  // vega proxy: bump v0 (the "current variance") by ~1% vol equivalent.
  // d(σ_eff^2)/d(σ_eff) at σ_eff = sqrt(v0) is 2*sqrt(v0). So a 1% σ bump in
  // total variance terms is roughly Δv0 = 2*sqrt(v0)*0.01.
  const sigEff = Math.sqrt(Math.max(1e-8, params.v0));
  const dV0 = 2 * sigEff * 0.01;
  const params2 = { ...params, v0: Math.max(1e-8, params.v0 + dV0) };
  const Cv = hestonCallPricer({ S0, r, q, T, params: params2 })(K);
  const vegaCall = (Cv - C0);  // already "per 1% vol" by construction

  // Convert to call/put. Put parity: P = C - S e^{-qT} + K e^{-rT}.
  if (type === 'call') {
    return { price: C0, delta: deltaCall, gamma, vega: vegaCall, theta: thetaCall, rho: rhoCall };
  } else {
    const P0 = putFromCall(C0, S0, K, r, q, T);
    // delta_put = delta_call - e^{-qT}; gamma same; vega same;
    // theta_put = theta_call + r K e^{-rT} - q S e^{-qT}, but we already used
    // numerical theta; re-derive via parity for safety:
    const Pf = putFromCall(Cf, S0, K, r, q, T + hT);
    const thetaPut = -(Pf - P0) / hT / 365;
    const Pp_ = putFromCall(Cp, S0 + hS, K, r, q, T);
    const Pm_ = putFromCall(Cm, S0 - hS, K, r, q, T);
    const deltaPut = (Pp_ - Pm_) / (2 * hS);
    const gammaPut = (Pp_ - 2 * P0 + Pm_) / (hS * hS);
    const Pr_ = putFromCall(priceCallAt(S0, T, r + hR), S0, K, r + hR, q, T);
    const rhoPut = ((Pr_ - P0) / hR) / 100;
    const Pv_ = putFromCall(Cv, S0, K, r, q, T);
    const vegaPut = (Pv_ - P0);
    return { price: P0, delta: deltaPut, gamma: gammaPut, vega: vegaPut, theta: thetaPut, rho: rhoPut };
  }
}

// Digital under Heston: cash-or-nothing. Use call-spread limit:
//   D_call(K) = -∂C/∂K = (C(K-h) - C(K+h)) / (2h) e^0   (numerical)
// With one Carr–Madan pricer we already have prices on a fine log-strike grid,
// so this is a cheap centered difference.
function hestonDigitalGreeks(type, S0, K, T, market, params) {
  if (T <= 0) {
    const itm = type === 'call' ? S0 > K : S0 < K;
    return { price: itm ? 1 : 0, delta: 0, gamma: 0, vega: 0, theta: 0, rho: 0 };
  }
  const r = market.r, q = market.q;
  const callPrice = hestonCallPricer({ S0, r, q, T, params });
  const hK = Math.max(0.01, K * 0.001);
  const dCall = (callPrice(K - hK) - callPrice(K + hK)) / (2 * hK);
  const dPrice = type === 'call' ? dCall : (Math.exp(-r * T) - dCall);

  // greeks: bump S, T, r, v0 and rebuild pricer. Slower than vanilla but still fast.
  const bumpS = Math.max(0.01, S0 * 0.005);
  const dPriceAt = (S, T_, r_, p) => {
    const cp = hestonCallPricer({ S0: S, r: r_, q, T: T_, params: p });
    const dC = (cp(K - hK) - cp(K + hK)) / (2 * hK);
    return type === 'call' ? dC : (Math.exp(-r_ * T_) - dC);
  };
  const Pp = dPriceAt(S0 + bumpS, T, r, params);
  const Pm = dPriceAt(S0 - bumpS, T, r, params);
  const delta = (Pp - Pm) / (2 * bumpS);
  const gamma = (Pp - 2 * dPrice + Pm) / (bumpS * bumpS);

  const hT = Math.max(1e-4, T * 0.01);
  const Pf = dPriceAt(S0, T + hT, r, params);
  const theta = -(Pf - dPrice) / hT / 365;

  const hR = 1e-4;
  const Pr = dPriceAt(S0, T, r + hR, params);
  const rho = (Pr - dPrice) / hR / 100;

  const sigEff = Math.sqrt(Math.max(1e-8, params.v0));
  const dV0 = 2 * sigEff * 0.01;
  const Pv = dPriceAt(S0, T, r, { ...params, v0: Math.max(1e-8, params.v0 + dV0) });
  const vega = (Pv - dPrice);

  return { price: dPrice, delta, gamma, vega, theta, rho };
}
