// localvol.js — Dupire local volatility from an IV surface.
//
// Construction (Gatheral parameterization in implied total variance):
//
//   w(k, T) = σ_imp²(k, T) · T            (total implied variance)
//   σ_loc²(k, T) = ∂w/∂T / D(k, w, w_k, w_kk)
//
// where
//
//   D = 1 - (k/w)·∂w/∂k
//       + 0.25 · (-0.25 - 1/w + k²/w²) · (∂w/∂k)²
//       + 0.5 · ∂²w/∂k²
//
// We compute σ_loc on the SAME (T, k) grid as the input IV surface, using
// central differences interior and one-sided at the edges. The returned
// surface is then bilinearly looked up at (S, t) by computing
//   k = ln(S / F(t)),  F(t) = S0 · exp((r-q)·t).
//
// Floors σ_loc² at floor² to keep MC stable in regions where Dupire would
// otherwise emit non-positive values (input surface has static arbitrage, or
// numerical noise near the edges). The floor matters; without it MC blows up
// roughly 1 path in 1000 even on well-behaved surfaces.

// Returns { T, k, sigmaLoc, nT, nK } — plain object so it round-trips through
// postMessage to the MC worker.
export function buildLocalVol(ivSurface, opts = {}) {
  const floor = opts.floor ?? 0.02;
  const { nT, nK, T, k, iv } = ivSurface;

  // Total implied variance w(k, T) = σ²·T
  const w = new Float64Array(nT * nK);
  for (let i = 0; i < nT; i++) {
    for (let j = 0; j < nK; j++) {
      const s = iv[i * nK + j];
      w[i * nK + j] = s * s * T[i];
    }
  }

  const idx = (i, j) => i * nK + j;
  const sigmaLoc = new Float64Array(nT * nK);

  for (let i = 0; i < nT; i++) {
    for (let j = 0; j < nK; j++) {
      const wij = w[idx(i, j)];
      const kj = k[j];

      // ∂w/∂T — central interior, one-sided at boundaries.
      let wT;
      if (i === 0)               wT = (w[idx(1, j)]      - w[idx(0, j)])      / (T[1] - T[0]);
      else if (i === nT - 1)     wT = (w[idx(nT - 1, j)] - w[idx(nT - 2, j)]) / (T[nT - 1] - T[nT - 2]);
      else                       wT = (w[idx(i + 1, j)]  - w[idx(i - 1, j)])  / (T[i + 1] - T[i - 1]);

      // ∂w/∂k — central interior, one-sided at boundaries.
      let wk;
      if (j === 0)               wk = (w[idx(i, 1)]      - w[idx(i, 0)])      / (k[1] - k[0]);
      else if (j === nK - 1)     wk = (w[idx(i, nK - 1)] - w[idx(i, nK - 2)]) / (k[nK - 1] - k[nK - 2]);
      else                       wk = (w[idx(i, j + 1)]  - w[idx(i, j - 1)])  / (k[j + 1] - k[j - 1]);

      // ∂²w/∂k² — non-uniform-grid central stencil interior, mirrored at edges.
      let wkk;
      if (j === 0) {
        // mirror 1-step formula
        const dk0 = k[1] - k[0];
        const dk1 = k[2] - k[1];
        wkk = 2 * (w[idx(i, 0)] / (dk0 * (dk0 + dk1))
                 - w[idx(i, 1)] / (dk0 * dk1)
                 + w[idx(i, 2)] / (dk1 * (dk0 + dk1)));
      } else if (j === nK - 1) {
        const dk0 = k[nK - 2] - k[nK - 3];
        const dk1 = k[nK - 1] - k[nK - 2];
        wkk = 2 * (w[idx(i, nK - 3)] / (dk0 * (dk0 + dk1))
                 - w[idx(i, nK - 2)] / (dk0 * dk1)
                 + w[idx(i, nK - 1)] / (dk1 * (dk0 + dk1)));
      } else {
        const dk0 = k[j] - k[j - 1];
        const dk1 = k[j + 1] - k[j];
        wkk = 2 * (w[idx(i, j - 1)] / (dk0 * (dk0 + dk1))
                 - w[idx(i, j)]     / (dk0 * dk1)
                 + w[idx(i, j + 1)] / (dk1 * (dk0 + dk1)));
      }

      const denom = 1
        - (kj / wij) * wk
        + 0.25 * (-0.25 - 1 / wij + (kj * kj) / (wij * wij)) * wk * wk
        + 0.5 * wkk;

      let sl2 = wT / denom;
      if (!isFinite(sl2) || sl2 < floor * floor) sl2 = floor * floor;
      sigmaLoc[i * nK + j] = Math.sqrt(sl2);
    }
  }

  return {
    T: Float64Array.from(T),
    k: Float64Array.from(k),
    sigmaLoc,
    nT, nK
  };
}

// Bilinear lookup of σ_loc at (S, t). Surface is stored in (T, k) space; we
// translate via k = ln(S / F(t)). Out-of-grid values clamp to nearest edge.
//
// Hot loop in MC, so we inline the binary search.
export function lvAt(lv, S0, r, q, S, t) {
  const F = S0 * Math.exp((r - q) * t);
  const kVal = Math.log(Math.max(S, 1e-12) / F);

  const Tarr = lv.T, karr = lv.k, nT = lv.nT, nK = lv.nK, sl = lv.sigmaLoc;
  const Tc = t < Tarr[0] ? Tarr[0] : (t > Tarr[nT - 1] ? Tarr[nT - 1] : t);
  const kc = kVal < karr[0] ? karr[0] : (kVal > karr[nK - 1] ? karr[nK - 1] : kVal);

  // bsearch for ti such that Tarr[ti] <= Tc < Tarr[ti+1]
  let ti = 0, hi = nT - 2;
  while (ti < hi) {
    const mid = (ti + hi + 1) >> 1;
    if (Tarr[mid] <= Tc) ti = mid; else hi = mid - 1;
  }
  let kj = 0; hi = nK - 2;
  while (kj < hi) {
    const mid = (kj + hi + 1) >> 1;
    if (karr[mid] <= kc) kj = mid; else hi = mid - 1;
  }

  const tt = (Tc - Tarr[ti]) / ((Tarr[ti + 1] - Tarr[ti]) || 1);
  const uu = (kc - karr[kj]) / ((karr[kj + 1] - karr[kj]) || 1);
  const a = sl[ti * nK + kj];
  const b = sl[ti * nK + kj + 1];
  const c = sl[(ti + 1) * nK + kj];
  const d = sl[(ti + 1) * nK + kj + 1];
  return (1 - tt) * ((1 - uu) * a + uu * b) + tt * ((1 - uu) * c + uu * d);
}

// Bilinear lookup of σ_imp on the (T, k) IV grid (raw arrays, no IVSurface
// instance — for use across postMessage). Used by analyticVanilla under LV
// where vanillas reprice the surface by construction.
export function ivAt(ivPlain, T, k) {
  const Tarr = ivPlain.T, karr = ivPlain.k, nT = ivPlain.nT, nK = ivPlain.nK, ivArr = ivPlain.iv;
  const Tc = T < Tarr[0] ? Tarr[0] : (T > Tarr[nT - 1] ? Tarr[nT - 1] : T);
  const kc = k < karr[0] ? karr[0] : (k > karr[nK - 1] ? karr[nK - 1] : k);

  let ti = 0, hi = nT - 2;
  while (ti < hi) {
    const mid = (ti + hi + 1) >> 1;
    if (Tarr[mid] <= Tc) ti = mid; else hi = mid - 1;
  }
  let kj = 0; hi = nK - 2;
  while (kj < hi) {
    const mid = (kj + hi + 1) >> 1;
    if (karr[mid] <= kc) kj = mid; else hi = mid - 1;
  }
  const tt = (Tc - Tarr[ti]) / ((Tarr[ti + 1] - Tarr[ti]) || 1);
  const uu = (kc - karr[kj]) / ((karr[kj + 1] - karr[kj]) || 1);
  const a = ivArr[ti * nK + kj];
  const b = ivArr[ti * nK + kj + 1];
  const c = ivArr[(ti + 1) * nK + kj];
  const d = ivArr[(ti + 1) * nK + kj + 1];
  return (1 - tt) * ((1 - uu) * a + uu * b) + tt * ((1 - uu) * c + uu * d);
}

// Pack an IVSurface (class instance, with Float64Array fields) into a plain
// transferable shape suitable for postMessage. Mirrors the IVSurface field
// layout but as a plain object so the worker doesn't need the class.
export function packIV(ivSurface) {
  return {
    T: Float64Array.from(ivSurface.T),
    k: Float64Array.from(ivSurface.k),
    iv: Float64Array.from(ivSurface.iv),
    nT: ivSurface.nT,
    nK: ivSurface.nK
  };
}
