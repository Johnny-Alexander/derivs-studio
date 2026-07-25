// sobol.js — Sobol' low-discrepancy sequence with Joe-Kuo direction numbers.
//
// Antonov-Saleev / Gray-code recurrence:  x_n = x_{n-1} XOR V[c]   where c is
// the count of trailing zeros of n. O(dim) per point.
//
// Randomization: Cranley-Patterson rotation — add a uniform shift in [0, 1)^dim
// modulo 1 before returning. Cheap, unbiased, keeps equidistribution. Welford
// stderr is then a slight underestimate of the true RQMC variance but stays a
// useful proxy.
//
// Direction numbers cover dims 1..MAX_DIM (=17). Higher dimensions fall back
// to pseudo-random uniforms — Sobol degrades past s ≈ 20 without a Brownian-
// bridge construction we don't ship in v3, and a clean fallback is better than
// silent quality loss.

import { mulberry32 } from './core.js';

const W = 30;                          // direction-number bit width
const SCALE = 1 / (1 << W);

// Joe-Kuo new-joe-kuo-6.21201, dims 2..17 (1st dim is van der Corput, special).
// Each row: [s, a, m_1, ..., m_s]. `s` is the polynomial degree, `a` packs the
// inner coefficients (bit (s-1-i) is a_i), m_i are the initial direction
// numbers (odd, < 2^i).
const JK_DATA = [
  [1, 0,  1                       ],   // dim 2
  [2, 1,  1, 3                    ],   // dim 3
  [3, 1,  1, 3, 1                 ],   // dim 4
  [3, 2,  1, 1, 1                 ],   // dim 5
  [4, 1,  1, 1, 3, 3              ],   // dim 6
  [4, 4,  1, 3, 5, 13             ],   // dim 7
  [5, 2,  1, 1, 5, 5, 17          ],   // dim 8
  [5, 4,  1, 1, 5, 5, 5           ],   // dim 9
  [5, 7,  1, 1, 7, 11, 19         ],   // dim 10
  [5, 11, 1, 1, 5, 1, 1           ],   // dim 11
  [5, 13, 1, 1, 1, 3, 11          ],   // dim 12
  [5, 14, 1, 3, 5, 5, 31          ],   // dim 13
  [6, 1,  1, 3, 3, 9, 7, 49       ],   // dim 14
  [6, 13, 1, 1, 1, 15, 21, 21     ],   // dim 15
  [6, 16, 1, 3, 1, 13, 27, 49     ],   // dim 16
  [6, 19, 1, 1, 1, 15, 7, 5       ]    // dim 17
];
export const SOBOL_MAX_DIM = JK_DATA.length + 1;

// Build V[d][i] (0-indexed) — the i-th direction number for dim d as a W-bit
// integer aligned to bit (W-1).  Returns null for dims past the table; caller
// uses pseudo-random for those.
function buildDirectionsForDim(d) {
  if (d === 0) {
    // Van der Corput: m_i = 1 → V_i = 2^(W-1-i).
    const V = new Uint32Array(W);
    for (let i = 0; i < W; i++) V[i] = 1 << (W - 1 - i);
    return V;
  }
  if (d > JK_DATA.length) return null;
  const row = JK_DATA[d - 1];
  const s = row[0];
  const a = row[1];
  const m = new Uint32Array(W);
  for (let i = 0; i < s; i++) m[i] = row[2 + i];
  // m_i = m_{i-s} XOR (m_{i-s} << s) XOR  Σ_{j=1..s-1} a_j (m_{i-j} << j)
  for (let i = s; i < W; i++) {
    let x = m[i - s] ^ (m[i - s] << s);
    for (let j = 1; j < s; j++) {
      if ((a >> (s - 1 - j)) & 1) x ^= (m[i - j] << j);
    }
    m[i] = x >>> 0;
  }
  const V = new Uint32Array(W);
  for (let i = 0; i < W; i++) V[i] = (m[i] << (W - 1 - i)) >>> 0;
  return V;
}

// One Sobol stream. `dim` is the total simulation dimension; dims past
// SOBOL_MAX_DIM use pseudo-random fallback. seed drives both the Cranley-
// Patterson shift and the pseudo fallback (so a fixed seed remains
// reproducible).
export function createSobol({ dim, seed = 1 }) {
  const V = new Array(dim);
  for (let d = 0; d < dim; d++) V[d] = buildDirectionsForDim(d);

  const x = new Uint32Array(dim);
  const rng = mulberry32((seed * 0x9E3779B1 + 0xDEADBEEF) >>> 0);
  // CP shift for QMC dims; also serves as the pseudo source for d ≥ MAX_DIM.
  const shift = new Float64Array(dim);
  for (let d = 0; d < dim; d++) shift[d] = rng();

  let count = 0;

  return {
    dim,
    next(out) {
      count++;
      let c = 0, n = count;
      while ((n & 1) === 0) { n >>= 1; c++; }
      for (let d = 0; d < dim; d++) {
        if (V[d]) {
          x[d] ^= V[d][c];
          let u = x[d] * SCALE + shift[d];
          if (u >= 1) u -= 1;
          out[d] = u;
        } else {
          out[d] = rng();   // pseudo for high-dim tail
        }
      }
    }
  };
}

// Acklam's rational approximation to the inverse-normal CDF. Max relative error
// ≈ 1.15e-9 across (0, 1). Good enough for MC.
const A = [-3.969683028665376e+01,  2.209460984245205e+02,
          -2.759285104469687e+02,  1.383577518672690e+02,
          -3.066479806614716e+01,  2.506628277459239e+00];
const B = [-5.447609879822406e+01,  1.615858368580409e+02,
          -1.556989798598866e+02,  6.680131188771972e+01,
          -1.328068155288572e+01];
const C = [-7.784894002430293e-03, -3.223964580411365e-01,
          -2.400758277161838e+00, -2.549732539343734e+00,
           4.374664141464968e+00,  2.938163982698783e+00];
const D = [ 7.784695709041462e-03,  3.224671290700398e-01,
            2.445134137142996e+00,  3.754408661907416e+00];

export function invNormCdf(p) {
  // Clamp away from 0 and 1 — Sobol can land on 0 in the first call before
  // shifting. Use a tiny epsilon so the tails stay finite.
  if (p < 1e-12) p = 1e-12;
  else if (p > 1 - 1e-12) p = 1 - 1e-12;

  const pl = 0.02425, ph = 1 - 0.02425;
  let q, r;
  if (p < pl) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((C[0]*q+C[1])*q+C[2])*q+C[3])*q+C[4])*q+C[5]) /
           ((((D[0]*q+D[1])*q+D[2])*q+D[3])*q + 1);
  } else if (p <= ph) {
    q = p - 0.5;
    r = q * q;
    return (((((A[0]*r+A[1])*r+A[2])*r+A[3])*r+A[4])*r+A[5]) * q /
           (((((B[0]*r+B[1])*r+B[2])*r+B[3])*r+B[4])*r + 1);
  } else {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((C[0]*q+C[1])*q+C[2])*q+C[3])*q+C[4])*q+C[5]) /
            ((((D[0]*q+D[1])*q+D[2])*q+D[3])*q + 1);
  }
}

// One-call Sobol-driven normal sampler. Each next(out) fills out with `dim`
// independent N(0,1) draws built from Sobol uniforms via inverse-normal CDF.
export function createSobolNormal({ dim, seed = 1 }) {
  const sob = createSobol({ dim, seed });
  const u = new Float64Array(dim);
  return {
    dim,
    next(out) {
      sob.next(u);
      for (let d = 0; d < dim; d++) out[d] = invNormCdf(u[d]);
    }
  };
}
