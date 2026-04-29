// core.js — pure math primitives. Importable from main thread AND web workers.
// No DOM access.

const SQRT2 = Math.sqrt(2);
const SQRT2PI = Math.sqrt(2 * Math.PI);

export function erf(x) {
  // Abramowitz & Stegun 7.1.26
  const a1 =  0.254829592, a2 = -0.284496736, a3 = 1.421413741,
        a4 = -1.453152027, a5 =  1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}

export const N = x => 0.5 * (1 + erf(x / SQRT2));
export const nPdf = x => Math.exp(-x * x / 2) / SQRT2PI;

// Black–Scholes closed-form (European call/put with continuous dividend)
// T in years, v/r/q as decimals. Returns price and standard greeks.
export function bs(type, S, K, T, r, q, v) {
  if (T <= 0 || v <= 0) {
    const intrinsic = type === 'call' ? Math.max(S - K, 0) : Math.max(K - S, 0);
    const delta = type === 'call' ? (S > K ? 1 : 0) : (S < K ? -1 : 0);
    return { price: intrinsic, delta, gamma: 0, vega: 0, theta: 0, rho: 0 };
  }
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r - q + 0.5 * v * v) * T) / (v * sqrtT);
  const d2 = d1 - v * sqrtT;
  const eqT = Math.exp(-q * T);
  const erT = Math.exp(-r * T);

  let price, delta, rho, theta;
  if (type === 'call') {
    price = S * eqT * N(d1) - K * erT * N(d2);
    delta = eqT * N(d1);
    rho   = K * T * erT * N(d2) / 100;
    theta = (-S * eqT * nPdf(d1) * v / (2 * sqrtT)
             - r * K * erT * N(d2)
             + q * S * eqT * N(d1)) / 365;
  } else {
    price = K * erT * N(-d2) - S * eqT * N(-d1);
    delta = -eqT * N(-d1);
    rho   = -K * T * erT * N(-d2) / 100;
    theta = (-S * eqT * nPdf(d1) * v / (2 * sqrtT)
             + r * K * erT * N(-d2)
             - q * S * eqT * N(-d1)) / 365;
  }
  const gamma = eqT * nPdf(d1) / (S * v * sqrtT);
  const vega  = S * eqT * nPdf(d1) * sqrtT / 100;
  return { price, delta, gamma, vega, theta, rho };
}

// Black–Scholes digital (cash-or-nothing, pays 1 unit of cash)
export function bsDigital(type, S, K, T, r, q, v) {
  if (T <= 0 || v <= 0) {
    const itm = type === 'call' ? S > K : S < K;
    return { price: itm ? 1 : 0, delta: 0, gamma: 0, vega: 0, theta: 0, rho: 0 };
  }
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r - q + 0.5 * v * v) * T) / (v * sqrtT);
  const d2 = d1 - v * sqrtT;
  const erT = Math.exp(-r * T);
  const sign = type === 'call' ? 1 : -1;
  const price = erT * N(sign * d2);
  // Derivatives of erT * N(sign * d2)
  const pdf = nPdf(d2);
  const dd2_dS = 1 / (S * v * sqrtT);
  const delta = sign * erT * pdf * dd2_dS;
  // gamma: d/dS [sign * erT * pdf(d2) * 1/(S v sqrtT)]
  //        = sign * erT * [ pdf'(d2)*dd2_dS / (S v sqrtT) - pdf(d2)/(S^2 v sqrtT) ]
  // pdf'(x) = -x pdf(x)
  const gamma = sign * erT * ( -d2 * pdf * dd2_dS * dd2_dS - pdf / (S * S * v * sqrtT) );
  // vega: d/dv. d2 = d1 - v sqrtT, dd2/dv = dd1/dv - sqrtT.
  // d1 = (ln(S/K) + (r-q+0.5v^2) T)/(v sqrtT)  => dd1/dv = sqrtT - d1/v (standard)
  const dd1_dv = sqrtT - d1 / v;
  const dd2_dv = dd1_dv - sqrtT;
  const vega = sign * erT * pdf * dd2_dv / 100;
  // theta, rho: use small numerical bump for brevity
  const bumpT = 1 / 365;
  const Tn = Math.max(T - bumpT, 1e-9);
  const sqTn = Math.sqrt(Tn);
  const d2n = (Math.log(S / K) + (r - q - 0.5 * v * v) * Tn) / (v * sqTn);
  const priceT = Math.exp(-r * Tn) * N(sign * d2n);
  const theta = priceT - price;
  const bumpR = 0.0001;
  const d2r = (Math.log(S / K) + ((r + bumpR) - q + 0.5 * v * v) * T) / (v * sqrtT) - v * sqrtT;
  const priceR = Math.exp(-(r + bumpR) * T) * N(sign * d2r);
  const rho = (priceR - price) / bumpR / 100;
  return { price, delta, gamma, vega, theta, rho };
}

// ----- Continuous-monitoring barrier options (Reiner-Rubinstein) -----
//
// Single-asset, constant-vol GBM. Barrier is monitored continuously; we use
// the standard 4-block formula:
//   A = vanilla call/put with strike K
//   B = vanilla call/put with strike B (the barrier)
//   C = "image" term using y1 = ln(B^2/(SK))/(σ√T) + (1+μ)σ√T
//   D = "image" term using y2 = ln(B/S)/(σ√T) + (1+μ)σ√T
// where μ = (r-q)/σ² - 1/2, eta = +1 for down barrier, -1 for up,
// and phi = +1 for call, -1 for put.
//
// For barrier=B above the strike with up-and-in/up-and-out parity, we use:
//   knock-out + knock-in = vanilla
//
// barrierType: 'up-and-out' | 'up-and-in' | 'down-and-out' | 'down-and-in'
// type: 'call' | 'put'
// rebate ignored (treated as 0). Live-from-start (no time-to-knockin delay).
//
// Returns { price, delta, gamma, vega, theta, rho } via finite differences on
// the closed form (analytic Greeks for barriers are doable but not worth the
// page-of-algebra for v3).
export function bsBarrier(barrierType, type, S, K, T, r, q, v, B) {
  // Knockout when already past barrier ⇒ worthless (no rebate).
  if (T <= 0 || v <= 0) {
    if ((barrierType === 'up-and-out' && S >= B) || (barrierType === 'down-and-out' && S <= B)) {
      return { price: 0, delta: 0, gamma: 0, vega: 0, theta: 0, rho: 0 };
    }
    if ((barrierType === 'up-and-in' && S >= B) || (barrierType === 'down-and-in' && S <= B)) {
      return bs(type, S, K, T, r, q, v);
    }
    const intrinsic = type === 'call' ? Math.max(S - K, 0) : Math.max(K - S, 0);
    return { price: intrinsic, delta: 0, gamma: 0, vega: 0, theta: 0, rho: 0 };
  }
  // Already-knocked: no rebate, dead.
  if ((barrierType === 'up-and-out'  && S >= B)) return { price: 0, delta: 0, gamma: 0, vega: 0, theta: 0, rho: 0 };
  if ((barrierType === 'down-and-out' && S <= B)) return { price: 0, delta: 0, gamma: 0, vega: 0, theta: 0, rho: 0 };
  // Already-knocked-in: same as vanilla.
  if ((barrierType === 'up-and-in'  && S >= B)) return bs(type, S, K, T, r, q, v);
  if ((barrierType === 'down-and-in' && S <= B)) return bs(type, S, K, T, r, q, v);

  const price = barrierPrice(barrierType, type, S, K, T, r, q, v, B);

  // FD greeks. Step sizes mirror the Heston greeks helper.
  const hS = Math.max(0.01, S * 0.005);
  const Pp = barrierPrice(barrierType, type, S + hS, K, T, r, q, v, B);
  const Pm = barrierPrice(barrierType, type, S - hS, K, T, r, q, v, B);
  const delta = (Pp - Pm) / (2 * hS);
  const gamma = (Pp - 2 * price + Pm) / (hS * hS);

  const hV = 0.005;
  const Pv = barrierPrice(barrierType, type, S, K, T, r, q, v + hV, B);
  const vega = (Pv - price) * (0.01 / hV);  // per 1% vol move

  const hT = Math.max(1e-4, T * 0.01);
  const Pt = barrierPrice(barrierType, type, S, K, T + hT, r, q, v, B);
  const theta = -(Pt - price) / hT / 365;

  const hR = 1e-4;
  const Pr = barrierPrice(barrierType, type, S, K, T, r + hR, q, v, B);
  const rho = (Pr - price) / hR / 100;

  return { price, delta, gamma, vega, theta, rho };
}

// Inner closed-form pricer (no edge cases, no greeks). Returns price only.
function barrierPrice(barrierType, type, S, K, T, r, q, v, B) {
  const sqrtT = Math.sqrt(T);
  const mu = (r - q) / (v * v) - 0.5;
  const lambda = Math.sqrt(mu * mu + 2 * r / (v * v));
  const phi = type === 'call' ? 1 : -1;
  const eta = (barrierType === 'down-and-out' || barrierType === 'down-and-in') ? 1 : -1;

  const x1 = Math.log(S / K) / (v * sqrtT) + (1 + mu) * v * sqrtT;
  const x2 = Math.log(S / B) / (v * sqrtT) + (1 + mu) * v * sqrtT;
  const y1 = Math.log(B * B / (S * K)) / (v * sqrtT) + (1 + mu) * v * sqrtT;
  const y2 = Math.log(B / S) / (v * sqrtT) + (1 + mu) * v * sqrtT;

  const eqT = Math.exp(-q * T);
  const erT = Math.exp(-r * T);

  const A = phi * S * eqT * N(phi * x1) - phi * K * erT * N(phi * x1 - phi * v * sqrtT);
  const Bt = phi * S * eqT * N(phi * x2) - phi * K * erT * N(phi * x2 - phi * v * sqrtT);
  const Cf = phi * S * eqT * Math.pow(B / S, 2 * (mu + 1)) * N(eta * y1)
           - phi * K * erT * Math.pow(B / S, 2 * mu)       * N(eta * y1 - eta * v * sqrtT);
  const D = phi * S * eqT * Math.pow(B / S, 2 * (mu + 1)) * N(eta * y2)
           - phi * K * erT * Math.pow(B / S, 2 * mu)       * N(eta * y2 - eta * v * sqrtT);

  // The mapping from {barrierType, K vs B} to A/B/C/D combinations.
  // For S above the up barrier or below the down barrier we already returned
  // above, so here we always have S strictly inside the live region.
  let kiPrice;
  const isUp = (eta === -1);
  const Kabove = (K > B);

  if (type === 'call') {
    if (isUp) {
      // up-and-in call:  K > B → A;  K < B → Bt - Cf + D
      kiPrice = Kabove ? A : (Bt - Cf + D);
    } else {
      // down-and-in call: K > B → Cf;  K < B → A - Bt + D
      kiPrice = Kabove ? Cf : (A - Bt + D);
    }
  } else {
    if (isUp) {
      // up-and-in put:  K > B → A - Bt + D;  K < B → Cf
      kiPrice = Kabove ? (A - Bt + D) : Cf;
    } else {
      // down-and-in put: K > B → Bt - Cf + D;  K < B → A
      kiPrice = Kabove ? (Bt - Cf + D) : A;
    }
  }

  // Vanilla price for in-out parity.
  const vanilla = bs(type, S, K, T, r, q, v).price;
  const koPrice = Math.max(0, vanilla - kiPrice);

  switch (barrierType) {
    case 'up-and-in':
    case 'down-and-in':  return Math.max(0, kiPrice);
    case 'up-and-out':
    case 'down-and-out': return koPrice;
  }
  return 0;
}

// Mulberry32 PRNG — fast, seedable, reproducible. Good enough for MC.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Marsaglia polar method — turn a uniform RNG into a N(0,1) sampler.
// Returns a function that yields one normal per call.
export function makeNormal(rng) {
  let spare = null;
  return function() {
    if (spare !== null) { const s = spare; spare = null; return s; }
    let u, v, s;
    do {
      u = rng() * 2 - 1;
      v = rng() * 2 - 1;
      s = u * u + v * v;
    } while (s >= 1 || s === 0);
    const mag = Math.sqrt(-2 * Math.log(s) / s);
    spare = v * mag;
    return u * mag;
  };
}

// Welford online variance — numerically stable.
export function welford() {
  let n = 0, mean = 0, M2 = 0;
  return {
    push(x) { n++; const d = x - mean; mean += d / n; const d2 = x - mean; M2 += d * d2; },
    get n() { return n; },
    get mean() { return mean; },
    get variance() { return n > 1 ? M2 / (n - 1) : 0; },
    get stderr() { return n > 1 ? Math.sqrt(M2 / (n - 1) / n) : 0; }
  };
}
