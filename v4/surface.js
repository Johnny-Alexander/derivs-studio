// surface.js — implied-volatility surface representation and helpers.
//
// An IVSurface is a 2D grid:
//   maturities T[]  (years, ascending)
//   logMoneyness k[]  (k = log(K/F), ascending across columns; F = S * e^{(r-q)T})
//   iv[i][j]      σ_imp at (T[i], k[j])
//
// Why log-moneyness, not absolute strike? Because implied vol is typically
// well-behaved in k = log(K/F), and the same k-grid works across maturities.
//
// Two ways to build a surface:
//   parametricSmile(opts)  — a simple level/skew/curvature/T-slope form. Good
//     enough for v3's "play with the model" purposes; not a real SVI.
//   IVSurface.from2D(T, k, ivMatrix) — paste-from-Excel convenience.
//
// Inversion: ivFromCallPrice(...) inverts BS via Brent's method to get an
// implied vol from a model-produced call price. We use this to compute IV
// residuals during calibration.

import { bs } from './core.js';

export class IVSurface {
  constructor(T, k, iv) {
    this.T = Float64Array.from(T);
    this.k = Float64Array.from(k);
    // iv stored as Float64Array for speed; row-major: row i is maturity i.
    const nT = this.T.length, nK = this.k.length;
    this.iv = new Float64Array(nT * nK);
    for (let i = 0; i < nT; i++) {
      for (let j = 0; j < nK; j++) {
        this.iv[i * nK + j] = iv[i][j];
      }
    }
    this.nT = nT;
    this.nK = nK;
  }

  // Bilinear lookup. Clamps to grid edges (no extrapolation).
  at(T, k) {
    const T_ = clamp(T, this.T[0], this.T[this.nT - 1]);
    const k_ = clamp(k, this.k[0], this.k[this.nK - 1]);
    const ti = bsearch(this.T, T_);
    const kj = bsearch(this.k, k_);
    const t = (T_ - this.T[ti]) / (this.T[ti + 1] - this.T[ti] || 1);
    const u = (k_ - this.k[kj]) / (this.k[kj + 1] - this.k[kj] || 1);
    const a = this.iv[ti * this.nK + kj];
    const b = this.iv[ti * this.nK + kj + 1];
    const c = this.iv[(ti + 1) * this.nK + kj];
    const d = this.iv[(ti + 1) * this.nK + kj + 1];
    return (1 - t) * ((1 - u) * a + u * b) + t * ((1 - u) * c + u * d);
  }

  // Return [T_i, k_j, iv_ij] for every grid point (used by calibration).
  *points() {
    for (let i = 0; i < this.nT; i++) {
      for (let j = 0; j < this.nK; j++) {
        yield { T: this.T[i], k: this.k[j], iv: this.iv[i * this.nK + j], i, j };
      }
    }
  }

  setIV(i, j, v) { this.iv[i * this.nK + j] = v; }
  getIV(i, j)    { return this.iv[i * this.nK + j]; }
  clone() { return new IVSurface(Array.from(this.T), Array.from(this.k), this._toMatrix()); }
  _toMatrix() {
    const m = [];
    for (let i = 0; i < this.nT; i++) {
      const row = [];
      for (let j = 0; j < this.nK; j++) row.push(this.iv[i * this.nK + j]);
      m.push(row);
    }
    return m;
  }
}

// Parametric "smile" that is reasonably realistic for equity index surfaces:
//   σ(k, T) = σ0 + a*sqrt(T) - skew*k + curvature*k^2
// k = log(K/F). Bounded below at 1e-4 to avoid pathological strikes.
export function parametricSmile({
  T = [0.25, 0.5, 1.0, 1.5, 2.0],
  kPct = [-0.30, -0.20, -0.10, 0.0, 0.10, 0.20, 0.30],
  sigma0 = 0.20,
  termSlope = 0.02,    // σ_atm rises by termSlope*sqrt(T-T[0])
  skew = 0.35,         // 1 unit of k drops vol by `skew` (negative-k = put wing up)
  curvature = 0.5      // smile curvature, raises vol away from ATM
} = {}) {
  const k = kPct.map(x => x);  // already log moneyness when called with logs;
  // But callers can pass percent moneyness like -0.20 = K/F = e^{-0.20} ≈ 0.819.
  // We treat the entries as log-moneyness directly.
  const iv = T.map(t => k.map(kk => {
    const v = sigma0 + termSlope * Math.sqrt(t) - skew * kk + curvature * kk * kk;
    return Math.max(0.02, v);
  }));
  return new IVSurface(T, k, iv);
}

// ------------ BS implied-vol inversion ------------
//
// Given a call price C (or put), find σ such that BS(σ) = price. Brent.
// Returns NaN if no solution (e.g. price below intrinsic).
//
// We use bracket [1e-4, 5.0] which is very wide. Brent converges in ~10 iters.

export function ivFromCallPrice(price, S, K, T, r, q, type = 'call') {
  if (T <= 0) return NaN;
  const intrinsic = type === 'call'
    ? Math.max(S * Math.exp(-q * T) - K * Math.exp(-r * T), 0)
    : Math.max(K * Math.exp(-r * T) - S * Math.exp(-q * T), 0);
  if (price < intrinsic - 1e-10) return NaN;
  const f = sigma => bs(type, S, K, T, r, q, sigma).price - price;
  return brent(f, 1e-4, 5.0, 1e-7, 100);
}

function brent(f, a, b, tol, maxIter) {
  let fa = f(a), fb = f(b);
  if (fa * fb > 0) {
    // expand once if needed
    return NaN;
  }
  if (Math.abs(fa) < Math.abs(fb)) { [a, b] = [b, a]; [fa, fb] = [fb, fa]; }
  let c = a, fc = fa, d = b - a, e = d;
  for (let i = 0; i < maxIter; i++) {
    if (Math.abs(fc) < Math.abs(fb)) {
      a = b; b = c; c = a;
      fa = fb; fb = fc; fc = fa;
    }
    const tol1 = 2 * Number.EPSILON * Math.abs(b) + 0.5 * tol;
    const m = 0.5 * (c - b);
    if (Math.abs(m) <= tol1 || fb === 0) return b;
    if (Math.abs(e) >= tol1 && Math.abs(fa) > Math.abs(fb)) {
      let p, q, s = fb / fa;
      if (a === c) { p = 2 * m * s; q = 1 - s; }
      else {
        const r = fb / fc, t = fa / fc;
        p = s * (2 * m * t * (t - r) - (b - a) * (r - 1));
        q = (t - 1) * (r - 1) * (s - 1);
      }
      if (p > 0) q = -q; else p = -p;
      if (2 * p < Math.min(3 * m * q - Math.abs(tol1 * q), Math.abs(e * q))) {
        e = d; d = p / q;
      } else { d = m; e = m; }
    } else { d = m; e = m; }
    a = b; fa = fb;
    b += Math.abs(d) > tol1 ? d : (m > 0 ? tol1 : -tol1);
    fb = f(b);
    if (fb * fc > 0) { c = a; fc = fa; e = d = b - a; }
  }
  return b;
}

// ------------ utilities ------------

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

// Returns largest index i such that arr[i] <= x, in [0, arr.length - 2].
function bsearch(arr, x) {
  let lo = 0, hi = arr.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (arr[mid] <= x) lo = mid; else hi = mid - 1;
  }
  return lo;
}
