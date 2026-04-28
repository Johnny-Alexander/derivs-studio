// products.js — derivative product definitions.
//
// Product interface:
//   id, name
//   defaultSpec(market) — build a sensible default spec from current market
//   requiredGrid(spec) -> Float64Array of times (starts with 0, ends at maturity)
//   evaluatePath(spec, grid, path, market) -> { pv, ...extras }
//     pv is the discounted cashflow total for this path (to t=0)
//     extras are product-specific fields used by accumulators
//   accumulate?(spec, result, path, aux) — called by MC engine to build aggregate stats
//   auxInit?(spec) — initial aux accumulator
//   auxFinalize?(spec, aux, nPaths) — turn accumulator into reportable stats
//   analyticPrice?(spec, model, market, modelParams) -> { price, delta, gamma, vega, theta, rho }
//     if present, product can be priced via closed form under a compatible model.
//
// No DOM access here — workers import this too.

export const VanillaPortfolio = {
  id: 'vanilla',
  name: 'Vanilla Multi-Leg',
  defaultSpec(market) {
    return {
      days: 30,
      legs: [{ side: 'long', type: 'call', strike: roundStrike(market.S), qty: 1 }]
    };
  },
  requiredGrid(spec) {
    return new Float64Array([0, spec.days / 365]);
  },
  evaluatePath(spec, grid, path, market) {
    const T = grid[grid.length - 1];
    const S_T = path[path.length - 1];
    const discount = Math.exp(-market.r * T);
    let pv = 0;
    for (const leg of spec.legs) {
      const sign = leg.side === 'long' ? 1 : -1;
      const intrinsic = leg.type === 'call'
        ? Math.max(S_T - leg.strike, 0)
        : Math.max(leg.strike - S_T, 0);
      pv += sign * leg.qty * intrinsic * discount;
    }
    return { pv };
  },
  analyticPrice(spec, model, market, modelParams) {
    if (!model.analyticVanilla) return null;
    const T = spec.days / 365;
    const total = { price: 0, delta: 0, gamma: 0, vega: 0, theta: 0, rho: 0 };
    for (const leg of spec.legs) {
      const g = model.analyticVanilla(leg.type, market.S, leg.strike, T, market, modelParams);
      const sign = leg.side === 'long' ? 1 : -1;
      const mul = sign * leg.qty;
      for (const k of Object.keys(total)) total[k] += mul * g[k];
    }
    return total;
  }
};

export const EuropeanDigital = {
  id: 'digital',
  name: 'European Digital',
  defaultSpec(market) {
    return {
      days: 30,
      type: 'call',
      side: 'long',
      strike: roundStrike(market.S),
      cash: 10,
      qty: 1
    };
  },
  requiredGrid(spec) {
    return new Float64Array([0, spec.days / 365]);
  },
  evaluatePath(spec, grid, path, market) {
    const T = grid[grid.length - 1];
    const S_T = path[path.length - 1];
    const discount = Math.exp(-market.r * T);
    const itm = spec.type === 'call' ? S_T > spec.strike : S_T < spec.strike;
    const sign = spec.side === 'long' ? 1 : -1;
    const pv = sign * spec.qty * spec.cash * (itm ? 1 : 0) * discount;
    return { pv, itm };
  },
  accumulate(spec, result, path, aux) {
    if (result.itm) aux.itmCount++;
  },
  auxInit(spec) { return { itmCount: 0 }; },
  auxFinalize(spec, aux, nPaths) {
    return { probITM: aux.itmCount / nPaths };
  },
  analyticPrice(spec, model, market, modelParams) {
    if (!model.analyticDigital) return null;
    const T = spec.days / 365;
    const g = model.analyticDigital(spec.type, market.S, spec.strike, T, market, modelParams);
    const sign = spec.side === 'long' ? 1 : -1;
    const mul = sign * spec.qty * spec.cash;
    const out = {};
    for (const k of Object.keys(g)) out[k] = mul * g[k];
    return out;
  }
};

// Autocallable note (reverse-convertible style with autocall + memory).
//
// Schedule: n observation dates at regular intervals up to maturity.
// At each intermediate obs i:
//   ratio = S_i / ref
//   if ratio >= couponBarrier:
//     pay coupon rate × (memoryPeriods if memory else 1) × notional
//     (memoryPeriods = 1 + missed periods, missed counter resets)
//   else if memory: missed counter += 1
//   if ratio >= autocallBarrier: pay notional, terminate
// At maturity:
//   if ratio >= couponBarrier:
//     pay final coupon (same rule as above) + notional
//   else if ratio >= kiBarrier (European KI, only observed at maturity):
//     pay notional (capital protected)
//   else:
//     pay notional × ratio  (principal loss 1:1 below the barrier)
export const Autocallable = {
  id: 'autocallable',
  name: 'Autocallable Note',
  defaultSpec(market) {
    return {
      ref: market.S,
      years: 2,
      obsPerYear: 4,         // quarterly observations
      autocallBarrier: 1.00, // at or above ref
      couponBarrier:   0.70,
      kiBarrier:       0.60,
      couponRate:      0.02, // per period (8% p.a. quarterly)
      memory:          true,
      notional:        100
    };
  },
  requiredGrid(spec) {
    const n = Math.max(1, Math.round(spec.years * spec.obsPerYear));
    const grid = new Float64Array(n + 1);
    grid[0] = 0;
    for (let i = 1; i <= n; i++) grid[i] = (i / spec.obsPerYear);
    return grid;
  },
  evaluatePath(spec, grid, path, market) {
    const r = market.r;
    const ref = spec.ref;
    const Nn = spec.notional;
    const n = grid.length - 1;
    let pv = 0;
    let missed = 0;
    let autocalledAt = -1;
    let couponsPaid = 0;
    let totalCouponPV = 0;

    for (let i = 1; i <= n; i++) {
      const t = grid[i];
      const S_i = path[i];
      const ratio = S_i / ref;
      const discount = Math.exp(-r * t);
      const isFinal = (i === n);

      let couponPayment = 0;
      if (ratio >= spec.couponBarrier) {
        const periods = spec.memory ? (missed + 1) : 1;
        couponPayment = Nn * spec.couponRate * periods;
        missed = 0;
      } else if (spec.memory) {
        missed += 1;
      }

      if (couponPayment > 0) {
        pv += couponPayment * discount;
        totalCouponPV += couponPayment * discount;
        couponsPaid += 1;
      }

      if (!isFinal && ratio >= spec.autocallBarrier) {
        pv += Nn * discount;
        autocalledAt = i;
        return {
          pv,
          autocalledAt,
          kiBreached: false,
          life: t,
          couponsPaid,
          totalCouponPV,
          terminalRatio: ratio
        };
      }

      if (isFinal) {
        let redemption;
        let kiBreached = false;
        if (ratio >= spec.couponBarrier) {
          redemption = Nn;
        } else if (ratio >= spec.kiBarrier) {
          redemption = Nn;
        } else {
          redemption = Nn * ratio;
          kiBreached = true;
        }
        pv += redemption * discount;
        return {
          pv,
          autocalledAt: -1,
          kiBreached,
          life: t,
          couponsPaid,
          totalCouponPV,
          terminalRatio: ratio
        };
      }
    }
    return { pv, autocalledAt: -1, kiBreached: false, life: grid[n], couponsPaid, totalCouponPV, terminalRatio: path[n] / ref };
  },
  auxInit(spec) {
    const n = Math.max(1, Math.round(spec.years * spec.obsPerYear));
    return {
      autocallCount: new Array(n).fill(0),
      maturityCount: 0,
      kiCount: 0,
      lifeSum: 0,
      couponSum: 0,
      couponPVSum: 0,
      terminalRatios: [],
      // Keep a small sample of full paths for visualization
      samplePaths: [],
      sampleCap: 24
    };
  },
  accumulate(spec, result, path, aux) {
    if (result.autocalledAt > 0) {
      aux.autocallCount[result.autocalledAt - 1]++;
    } else {
      aux.maturityCount++;
      if (result.kiBreached) aux.kiCount++;
    }
    aux.lifeSum += result.life;
    aux.couponSum += result.couponsPaid;
    aux.couponPVSum += result.totalCouponPV;
    aux.terminalRatios.push(result.terminalRatio);
    if (aux.samplePaths.length < aux.sampleCap) {
      aux.samplePaths.push({
        spots: Array.from(path),
        autocalledAt: result.autocalledAt,
        kiBreached: result.kiBreached
      });
    }
  },
  auxFinalize(spec, aux, nPaths) {
    const n = aux.autocallCount.length;
    const probAutocall = aux.autocallCount.map(c => c / nPaths);
    const cumulativeAC = [];
    let cum = 0;
    for (const p of probAutocall) { cum += p; cumulativeAC.push(cum); }
    return {
      probAutocall,
      cumulativeAutocall: cumulativeAC,
      probMaturity: aux.maturityCount / nPaths,
      probKI: aux.kiCount / nPaths,
      expectedLife: aux.lifeSum / nPaths,
      expectedCoupons: aux.couponSum / nPaths,
      expectedCouponPV: aux.couponPVSum / nPaths,
      terminalRatios: aux.terminalRatios,
      samplePaths: aux.samplePaths,
      nPaths
    };
  }
};

export const PRODUCTS = {
  vanilla: VanillaPortfolio,
  digital: EuropeanDigital,
  autocallable: Autocallable
};

function roundStrike(S) {
  if (S >= 50)  return Math.round(S);
  if (S >= 10)  return Math.round(S * 2) / 2;
  return Math.round(S * 10) / 10;
}
