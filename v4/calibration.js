// calibration.js — Heston calibration via Levenberg–Marquardt on IV residuals.
//
// Inputs:
//   surface : IVSurface (T[], k[], iv[]) — k = log(K/F).
//   S0, market = { r, q }
//   initial : { v0, kappa, theta, xi, rho } (start point)
//   options : { maxIter, tol, weights, onProgress, bounds }
//
// Output:
//   { params, history: [{iter, sse, params, lambda}], iv_model, residuals,
//     converged, reason }
//
// Algorithm: textbook LM with parameter clamping. Forward-difference Jacobian.
// Residuals are weighted IV errors:
//   r_ij = w_ij * (modelIV(T_i, k_j; θ) - marketIV_ij)
//
// We re-build the Carr–Madan pricer once per maturity per evaluation. That's
// O(nT) FFTs per residual eval, and (nParams+1) evals per LM iter. Empirically
// 10–25 iters to converge, so a 5×7 surface costs ~ a second.
//
// Why IV residuals (not price residuals)? IV is dimensionless and roughly
// flat across the surface (~0.1–0.4), so unweighted least-squares gives
// reasonable balance between deep-OTM and ATM points. Price residuals would
// be dominated by ATM where prices are biggest.

import { hestonCallPricer, putFromCall } from './transforms.js';
import { ivFromCallPrice } from './surface.js';

const PARAM_KEYS = ['v0', 'kappa', 'theta', 'xi', 'rho'];

// Bounds keep Heston's char function stable AND prevent classic degeneracies.
// In particular, κ→0 with θ→∞ is a famous local minimum — when the input
// surface isn't a real Heston surface, LM happily slides into that region.
// A min on κ of 0.3 is loose enough not to bias normal calibrations but tight
// enough to keep us out of that hole.
const BOUNDS = {
  v0:    { min: 1e-5,  max: 1.0   },
  kappa: { min: 0.3,   max: 20.0  },
  theta: { min: 1e-5,  max: 0.5   },
  xi:    { min: 1e-3,  max: 3.0   },
  rho:   { min: -0.99, max: 0.99  }
};

function clampParams(p) {
  const out = {};
  for (const k of PARAM_KEYS) {
    out[k] = Math.min(BOUNDS[k].max, Math.max(BOUNDS[k].min, p[k]));
  }
  return out;
}

// Compute model IV at every surface point. Builds one FFT pricer per maturity.
// Returns Float64Array of length nT*nK with model IV (NaN if inversion fails).
//
// Uses a smaller N (2048, eta=0.5) than runtime pricing — accuracy is
// equivalent on this strike range and the Jacobian needs O(thousand) of these.
function evalModelIV(surface, S0, market, params) {
  const { T, k, nT, nK } = surface;
  const r = market.r, q = market.q;
  const out = new Float64Array(nT * nK);

  for (let i = 0; i < nT; i++) {
    const Ti = T[i];
    const F = S0 * Math.exp((r - q) * Ti);
    const callAt = hestonCallPricer({ S0, r, q, T: Ti, params, N: 2048, eta: 0.5 });
    for (let j = 0; j < nK; j++) {
      const K = F * Math.exp(k[j]);
      let price = callAt(K);
      // Numerical noise can push prices microscopically below intrinsic; floor.
      const intrinsic = Math.max(S0 * Math.exp(-q * Ti) - K * Math.exp(-r * Ti), 0);
      if (price < intrinsic) price = intrinsic;
      const iv = ivFromCallPrice(price, S0, K, Ti, r, q, 'call');
      out[i * nK + j] = iv;
    }
  }
  return out;
}

// Build a flat residual vector. Returns { residuals (Float64Array), iv_model,
// sse }. When ivFromCallPrice fails, we substitute a large penalty so LM steers
// away from that region of param space.
function residuals(surface, S0, market, params, weights) {
  const iv_model = evalModelIV(surface, S0, market, params);
  const N = surface.nT * surface.nK;
  const r = new Float64Array(N);
  let sse = 0;
  for (let n = 0; n < N; n++) {
    const m = iv_model[n];
    const w = weights ? weights[n] : 1;
    if (!isFinite(m)) {
      r[n] = 10 * w;       // big penalty
    } else {
      r[n] = w * (m - surface.iv[n]);
    }
    sse += r[n] * r[n];
  }
  return { residuals: r, iv_model, sse };
}

// Forward-difference Jacobian. Reuses the base residual vector (computed
// outside) to save one eval. Returns J as Float64Array of length N*5
// (row-major: row n contains [∂r_n/∂v0, ..., ∂r_n/∂rho]).
function jacobian(surface, S0, market, params, baseRes, weights) {
  const N = surface.nT * surface.nK;
  const J = new Float64Array(N * PARAM_KEYS.length);
  // Bump sizes are scale-aware. For variance-like params (v0, theta) and rho,
  // additive bumps are fine; for kappa/xi we use a small relative bump.
  const bumps = {
    v0:    Math.max(1e-5, params.v0 * 1e-3),
    kappa: Math.max(1e-3, params.kappa * 1e-3),
    theta: Math.max(1e-5, params.theta * 1e-3),
    xi:    Math.max(1e-4, params.xi * 1e-3),
    rho:   1e-4
  };

  for (let p = 0; p < PARAM_KEYS.length; p++) {
    const key = PARAM_KEYS[p];
    const h = bumps[key];
    let bumped = { ...params, [key]: params[key] + h };
    bumped = clampParams(bumped);                     // stay in feasible
    const actualH = bumped[key] - params[key];        // could be 0 at boundary
    if (actualH === 0) {
      // try negative bump instead
      let neg = clampParams({ ...params, [key]: params[key] - h });
      const actualHn = neg[key] - params[key];
      const { residuals: rNeg } = residuals(surface, S0, market, neg, weights);
      for (let n = 0; n < N; n++) {
        J[n * PARAM_KEYS.length + p] = (baseRes[n] - rNeg[n]) / (-actualHn);
      }
    } else {
      const { residuals: rPlus } = residuals(surface, S0, market, bumped, weights);
      for (let n = 0; n < N; n++) {
        J[n * PARAM_KEYS.length + p] = (rPlus[n] - baseRes[n]) / actualH;
      }
    }
  }
  return J;
}

// Solve (A + λ diag(A)) δ = b  for δ, where A = JᵀJ, b = -Jᵀr.
// Marquardt's diagonal scaling is more robust than plain (A + λI).
// Symmetric 5×5 — easy enough to invert via Gauss elimination with partial pivot.
function solveLM(J, r, lambda) {
  const P = PARAM_KEYS.length;
  const N = r.length;
  const A = new Float64Array(P * P);
  const b = new Float64Array(P);

  for (let i = 0; i < P; i++) {
    for (let j = 0; j < P; j++) {
      let s = 0;
      for (let n = 0; n < N; n++) s += J[n * P + i] * J[n * P + j];
      A[i * P + j] = s;
    }
    let s = 0;
    for (let n = 0; n < N; n++) s += J[n * P + i] * r[n];
    b[i] = -s;
  }

  // Marquardt damping: A_ii *= (1 + λ)
  for (let i = 0; i < P; i++) A[i * P + i] *= (1 + lambda);

  // Solve A δ = b via Gauss elimination with partial pivot.
  const M = new Float64Array(P * (P + 1));
  for (let i = 0; i < P; i++) {
    for (let j = 0; j < P; j++) M[i * (P + 1) + j] = A[i * P + j];
    M[i * (P + 1) + P] = b[i];
  }
  for (let col = 0; col < P; col++) {
    // partial pivot
    let pivot = col;
    let pmax = Math.abs(M[col * (P + 1) + col]);
    for (let row = col + 1; row < P; row++) {
      const v = Math.abs(M[row * (P + 1) + col]);
      if (v > pmax) { pmax = v; pivot = row; }
    }
    if (pmax < 1e-14) return null;  // singular
    if (pivot !== col) {
      for (let j = col; j <= P; j++) {
        const tmp = M[col * (P + 1) + j];
        M[col * (P + 1) + j] = M[pivot * (P + 1) + j];
        M[pivot * (P + 1) + j] = tmp;
      }
    }
    // eliminate below
    for (let row = col + 1; row < P; row++) {
      const f = M[row * (P + 1) + col] / M[col * (P + 1) + col];
      for (let j = col; j <= P; j++) M[row * (P + 1) + j] -= f * M[col * (P + 1) + j];
    }
  }
  // back-substitute
  const delta = new Float64Array(P);
  for (let i = P - 1; i >= 0; i--) {
    let s = M[i * (P + 1) + P];
    for (let j = i + 1; j < P; j++) s -= M[i * (P + 1) + j] * delta[j];
    delta[i] = s / M[i * (P + 1) + i];
  }
  return delta;
}

// Main entry point. Synchronous; on a 5×7 surface this takes well under a
// second on a laptop, so we don't bother with workers yet.
export function calibrateHeston({
  surface, S0, market, initial,
  maxIter = 30, tol = 1e-5, lambda0 = 1e-3,
  weights = null,
  onProgress = null
} = {}) {
  let params = clampParams({ ...initial });
  let lambda = lambda0;
  const history = [];
  let { residuals: r, iv_model, sse } = residuals(surface, S0, market, params, weights);
  history.push({ iter: 0, sse, params: { ...params }, lambda });
  if (onProgress) onProgress({ iter: 0, sse, params, iv_model, residuals: r });

  let reason = 'maxIter';
  let converged = false;

  for (let iter = 1; iter <= maxIter; iter++) {
    const J = jacobian(surface, S0, market, params, r, weights);

    // Try steps with adaptive lambda: shrink on success, grow on failure.
    let accepted = false;
    for (let attempt = 0; attempt < 8 && !accepted; attempt++) {
      const delta = solveLM(J, r, lambda);
      if (!delta) { lambda *= 10; continue; }

      const trial = clampParams({
        v0:    params.v0    + delta[0],
        kappa: params.kappa + delta[1],
        theta: params.theta + delta[2],
        xi:    params.xi    + delta[3],
        rho:   params.rho   + delta[4]
      });
      const ev = residuals(surface, S0, market, trial, weights);

      if (ev.sse < sse) {
        // accept
        const dSSE = sse - ev.sse;
        params = trial;
        r = ev.residuals;
        iv_model = ev.iv_model;
        sse = ev.sse;
        lambda = Math.max(1e-9, lambda / 5);
        accepted = true;

        history.push({ iter, sse, params: { ...params }, lambda });
        if (onProgress) onProgress({ iter, sse, params, iv_model, residuals: r });

        if (dSSE / Math.max(1e-12, sse) < tol) {
          converged = true;
          reason = 'tol';
          return { params, history, iv_model, residuals: r, converged, reason };
        }
      } else {
        lambda *= 5;
      }
    }
    if (!accepted) {
      reason = 'no_improvement';
      break;
    }
    if (lambda > 1e10) {
      reason = 'lambda_overflow';
      break;
    }
  }

  return { params, history, iv_model, residuals: r, converged, reason };
}

// Compute weights = sqrt(T)·BS-vega proxy, normalized to mean 1. Optional.
// Use this when you want to weight ATM more heavily — useful for surfaces that
// have noisy wings. Off by default (uniform).
export function vegaLikeWeights(surface, S0, market, atmIV = 0.20) {
  const { T, k, nT, nK } = surface;
  const w = new Float64Array(nT * nK);
  let sum = 0;
  for (let i = 0; i < nT; i++) {
    const Ti = T[i];
    const sqrtT = Math.sqrt(Math.max(Ti, 1e-6));
    for (let j = 0; j < nK; j++) {
      // crude vega proxy: peak at k=0, falls off as |k| grows
      const wij = sqrtT * Math.exp(-(k[j] * k[j]) / (2 * atmIV * atmIV * Ti));
      w[i * nK + j] = wij;
      sum += wij;
    }
  }
  const mean = sum / w.length;
  if (mean > 0) for (let n = 0; n < w.length; n++) w[n] /= mean;
  return w;
}
