// transforms.js — Fourier-transform pricing primitives.
//
// Contents:
//   - Complex arithmetic on parallel Float64Arrays (re[], im[]) for the FFT
//     and on { re, im } scalars for char-function evaluation.
//   - Radix-2 iterative FFT (Cooley–Tukey, in-place).
//   - Heston risk-neutral characteristic function for ln(S_T).
//   - Carr–Madan call pricer (one FFT call → 1D interpolatable price curve).
//
// Importable from main thread or worker. No DOM access.
//
// Conventions:
//   r, q, T, sigma, v0, kappa, theta, xi, rho — risk-neutral params.
//   sigma is BS vol, ξ (xi) is the Heston vol-of-vol.

// ---------- complex scalar ops ----------

export function cAdd(a, b)  { return { re: a.re + b.re, im: a.im + b.im }; }
export function cSub(a, b)  { return { re: a.re - b.re, im: a.im - b.im }; }
export function cMul(a, b)  { return { re: a.re*b.re - a.im*b.im, im: a.re*b.im + a.im*b.re }; }
export function cDiv(a, b)  {
  const d = b.re*b.re + b.im*b.im;
  return { re: (a.re*b.re + a.im*b.im) / d, im: (a.im*b.re - a.re*b.im) / d };
}
export function cExp(a)     {
  const e = Math.exp(a.re);
  return { re: e*Math.cos(a.im), im: e*Math.sin(a.im) };
}
// Principal branch of ln(z). Branch cut on the negative real axis.
export function cLog(a)     { return { re: 0.5*Math.log(a.re*a.re + a.im*a.im), im: Math.atan2(a.im, a.re) }; }
// Principal branch of sqrt(z). Re(sqrt) ≥ 0.
export function cSqrt(a) {
  const r = Math.sqrt(a.re*a.re + a.im*a.im);
  const re = Math.sqrt((r + a.re) / 2);
  const im = Math.sign(a.im || 1) * Math.sqrt((r - a.re) / 2);
  return { re, im };
}
export function cScale(a, s) { return { re: a.re*s, im: a.im*s }; }

// ---------- radix-2 in-place FFT ----------
//
// re[], im[] are Float64Arrays of length N (power of 2). Modified in place.
// `inverse` divides by N at the end.

export function fft(re, im, inverse = false) {
  const N = re.length;
  if ((N & (N - 1)) !== 0) throw new Error('fft length must be a power of 2: got ' + N);
  // Bit-reversal permutation
  for (let i = 1, j = 0; i < N; i++) {
    let bit = N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let tr = re[i]; re[i] = re[j]; re[j] = tr;
      let ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  // Cooley–Tukey
  const sign = inverse ? 1 : -1;
  for (let size = 2; size <= N; size <<= 1) {
    const half = size >> 1;
    const ang = sign * 2 * Math.PI / size;
    const wRe = Math.cos(ang), wIm = Math.sin(ang);
    for (let start = 0; start < N; start += size) {
      let curRe = 1, curIm = 0;
      for (let k = 0; k < half; k++) {
        const i1 = start + k;
        const i2 = i1 + half;
        const tRe = re[i2]*curRe - im[i2]*curIm;
        const tIm = re[i2]*curIm + im[i2]*curRe;
        re[i2] = re[i1] - tRe;
        im[i2] = im[i1] - tIm;
        re[i1] += tRe;
        im[i1] += tIm;
        const nRe = curRe*wRe - curIm*wIm;
        const nIm = curRe*wIm + curIm*wRe;
        curRe = nRe; curIm = nIm;
      }
    }
  }
  if (inverse) {
    const inv = 1 / N;
    for (let i = 0; i < N; i++) { re[i] *= inv; im[i] *= inv; }
  }
}

// ---------- Heston characteristic function ----------
//
// φ(u) = E[exp(i u ln(S_T))]  under the risk-neutral measure.
//
// Uses the "little trap" formulation (Albrecher et al.) — numerically stable
// because g lies inside the unit disk for typical params, so log(1 - g e^{-dT})
// stays on its principal branch as T grows.
//
// u is COMPLEX (passed as (uRe, uIm)) because Carr–Madan evaluates the CF at
// v - (α+1)i. params: { v0, kappa, theta, xi, rho }. S0, r, q, T explicit.
// Returns { re, im }.

export function hestonCF(uRe, uIm, S0, r, q, T, params) {
  const { v0, kappa, theta, xi, rho } = params;
  const u = { re: uRe, im: uIm };

  // i*u  (i times u): if u = a + bi, then i*u = -b + ai
  const iu = { re: -u.im, im: u.re };

  // alpha_h = kappa - rho * xi * i * u
  const alpha_h = cSub({ re: kappa, im: 0 }, cScale(iu, rho * xi));

  // d = sqrt(alpha_h^2 + xi^2 * (i*u + u^2))
  // u^2 = (a+bi)^2 = a^2 - b^2 + 2abi
  const u2 = { re: u.re*u.re - u.im*u.im, im: 2*u.re*u.im };
  const iuPlusU2 = cAdd(iu, u2);
  const inner = cAdd(cMul(alpha_h, alpha_h), cScale(iuPlusU2, xi*xi));
  const d = cSqrt(inner);

  // c_plus = alpha_h - d, c_minus = alpha_h + d
  const cPlus  = cSub(alpha_h, d);
  const cMinus = cAdd(alpha_h, d);

  // g = c_plus / c_minus  (little trap)
  const g = cDiv(cPlus, cMinus);

  // edT = exp(-d * T)
  const edT = cExp(cScale(d, -T));

  // A = (kappa*theta / xi^2) * (c_plus * T - 2 * log((1 - g*edT)/(1 - g)))
  const oneMinusGEdT = cSub({ re: 1, im: 0 }, cMul(g, edT));
  const oneMinusG    = cSub({ re: 1, im: 0 }, g);
  const logTerm = cLog(cDiv(oneMinusGEdT, oneMinusG));
  const A = cScale(
    cSub(cScale(cPlus, T), cScale(logTerm, 2)),
    (kappa * theta) / (xi * xi)
  );

  // B = (v0/xi^2) * c_plus * (1 - edT) / (1 - g*edT)
  const oneMinusEdT = cSub({ re: 1, im: 0 }, edT);
  const B = cScale(
    cMul(cPlus, cDiv(oneMinusEdT, oneMinusGEdT)),
    v0 / (xi * xi)
  );

  // exponent = i u (ln S0 + (r - q) T) + A + B
  const c = Math.log(S0) + (r - q) * T;
  // i*u * c = (-u.im + i*u.re) * c
  const driftTerm = { re: -u.im * c, im: u.re * c };
  const exponent = cAdd(cAdd(driftTerm, A), B);
  return cExp(exponent);
}

// ---------- Carr–Madan call pricer ----------
//
// Returns a function f(K) -> European call price. One FFT amortizes the cost
// over the whole (log) strike grid; we linearly interpolate at the requested K.
//
// alpha is the dampening factor. 1.5 is a good default for Heston.
// N must be a power of 2; eta is the integration-grid spacing.
//
// Strikes returned span [S0 * exp(-b), S0 * exp(b - lambda)] with
//   lambda = 2π / (N η),  b = N λ / 2.

export function carrMadanCall({
  S0, r, q, T, cf, alpha = 1.5, N = 4096, eta = 0.25
}) {
  const lambda = 2 * Math.PI / (N * eta);
  const b = N * lambda / 2;

  const re = new Float64Array(N);
  const im = new Float64Array(N);

  // Simpson's 1/3 weights, with first endpoint weighted 1 (not 1/2):
  //   w_0 = 1, w_j = 3 + (-1)^j  for j ≥ 1
  // multiplied by η/3 outside the FFT.

  const erT = Math.exp(-r * T);

  for (let j = 0; j < N; j++) {
    const v = j * eta;
    // ψ(v) = e^{-rT} * φ(v - (α+1)i) / (α^2 + α - v^2 + i(2α+1)v)
    // cf is called as cf(uRe, uIm) so the complex shift -(α+1) goes through.
    const phi = cf(v, -(alpha + 1));
    const denom = { re: alpha*alpha + alpha - v*v, im: (2*alpha + 1) * v };
    const psi = cMul({ re: erT * phi.re, im: erT * phi.im }, cDiv({ re: 1, im: 0 }, denom));

    // Simpson weight
    let w;
    if (j === 0) w = eta / 3;
    else if (j % 2 === 1) w = (4 * eta) / 3;
    else w = (2 * eta) / 3;

    // Twiddle exp(i * v * b)
    const tw = { re: Math.cos(v * b), im: Math.sin(v * b) };
    const z = cMul(tw, psi);
    re[j] = z.re * w;
    im[j] = z.im * w;
  }

  fft(re, im, false);

  // Strike grid k_u = -b + λ u, K_u = exp(k_u) (in our convention, prices are
  // for a unit-S0 contract; we multiply by S0 at the end if cf was for ln S_T).
  // Actually our cf is for ln(S_T) directly (includes ln S0 in the drift),
  // so K_u as exp(k_u) where k_u IS the strike's log (not log moneyness).

  // Build strike axis and price axis.
  const kAxis = new Float64Array(N);
  const cAxis = new Float64Array(N);
  for (let u = 0; u < N; u++) {
    const k_u = -b + lambda * u;
    kAxis[u] = k_u;
    cAxis[u] = (Math.exp(-alpha * k_u) / Math.PI) * re[u];
  }

  // Return a function that linearly interpolates in log-strike.
  return function price(K) {
    const lk = Math.log(K);
    if (lk <= kAxis[0])     return Math.max(S0 * Math.exp(-q * T) - K * erT, 0); // floor
    if (lk >= kAxis[N - 1]) return 0;
    // binary search
    let lo = 0, hi = N - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (kAxis[mid] <= lk) lo = mid; else hi = mid;
    }
    const t = (lk - kAxis[lo]) / (kAxis[hi] - kAxis[lo]);
    return Math.max(0, cAxis[lo] * (1 - t) + cAxis[hi] * t);
  };
}

// Convenience: build a Heston call pricer ready to call price(K).
export function hestonCallPricer({ S0, r, q, T, params, alpha = 1.5, N = 4096, eta = 0.25 }) {
  const cf = (uRe, uIm) => hestonCF(uRe, uIm, S0, r, q, T, params);
  return carrMadanCall({ S0, r, q, T, cf, alpha, N, eta });
}

// Put price via call–put parity:  P = C - S0 e^{-qT} + K e^{-rT}
export function putFromCall(callPrice, S0, K, r, q, T) {
  return callPrice - S0 * Math.exp(-q * T) + K * Math.exp(-r * T);
}
