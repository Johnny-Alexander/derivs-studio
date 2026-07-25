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
//   controlVariate?(spec, market, modelParams, model) -> { analyticPV, evaluateOnPath } | null
//     v3: optional MC variance-reduction hook. analyticPV is the closed-form
//     price of the CV (e.g. geometric Asian under GBM). evaluateOnPath(grid,
//     path) returns the CV's PV on the simulated path. The MC engine subtracts
//     (pvCV - analyticPV) per path; mean is unbiased, variance shrinks when CV
//     is correlated with the product payoff. Return null to opt out per spec.
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

// Continuous-monitoring barrier (knock-in / knock-out, single-asset).
//
// MC: walk the path on a fine grid (252 obs/yr) and check the barrier at each
// step. Brownian-bridge correction would shrink the discretization bias on the
// touch probability — a worthwhile v4 add — but we sidestep it for now by using
// a fine grid. The bias still discounts the touch probability slightly; users
// running closed-form A/B (under GBM) will see MC under-knock by ~1–2% on
// short maturities.
//
// Closed form: bsBarrier (Reiner–Rubinstein) under GBM via model.analyticBarrier.
// Heston has no closed form for barriers, so it falls back to MC.
export const Barrier = {
  id: 'barrier',
  name: 'Barrier (single-asset)',
  defaultSpec(market) {
    const S = market.S;
    return {
      barrierType: 'up-and-out',     // up-and-out | up-and-in | down-and-out | down-and-in
      optionType:  'call',           // call | put
      side:        'long',
      strike:      roundStrike(S),
      barrier:     roundStrike(S * 1.20),
      days:        90,
      qty:         1
    };
  },
  // Fine grid for continuous-monitoring approximation: ~252 steps/year.
  requiredGrid(spec) {
    const T = spec.days / 365;
    const obsPerYear = 252;
    const n = Math.max(2, Math.ceil(T * obsPerYear));
    const grid = new Float64Array(n + 1);
    for (let i = 0; i <= n; i++) grid[i] = T * i / n;
    return grid;
  },
  evaluatePath(spec, grid, path, market) {
    const T = grid[grid.length - 1];
    const discount = Math.exp(-market.r * T);
    const isUp   = spec.barrierType === 'up-and-out'   || spec.barrierType === 'up-and-in';
    const isOut  = spec.barrierType === 'up-and-out'   || spec.barrierType === 'down-and-out';
    const B = spec.barrier;

    // Walk the path, look for first touch (excluding t=0 — assumed not breached).
    let firstTouchStep = -1;
    for (let i = 1; i < path.length; i++) {
      const breached = isUp ? (path[i] >= B) : (path[i] <= B);
      if (breached) { firstTouchStep = i; break; }
    }
    const touched = firstTouchStep >= 0;
    const alive = isOut ? !touched : touched;

    let pv = 0;
    if (alive) {
      const S_T = path[path.length - 1];
      const intrinsic = spec.optionType === 'call'
        ? Math.max(S_T - spec.strike, 0)
        : Math.max(spec.strike - S_T, 0);
      const sign = spec.side === 'long' ? 1 : -1;
      pv = sign * spec.qty * intrinsic * discount;
    }
    return { pv, touched, firstTouchStep, alive };
  },
  auxInit(spec) {
    const T = spec.days / 365;
    const obsPerYear = 252;
    const n = Math.max(2, Math.ceil(T * obsPerYear));
    return {
      // touchByStep[i] = paths whose *first* touch was at step i (1-indexed).
      touchByStep: new Array(n).fill(0),
      neverTouched: 0,
      aliveAtMaturity: 0,
      knockedAtMaturity: 0
    };
  },
  accumulate(spec, result, path, aux) {
    if (result.firstTouchStep > 0) {
      aux.touchByStep[result.firstTouchStep - 1]++;
    } else {
      aux.neverTouched++;
    }
    if (result.alive) aux.aliveAtMaturity++;
    else aux.knockedAtMaturity++;
  },
  auxFinalize(spec, aux, nPaths) {
    // Cumulative P(touched by step i)
    const n = aux.touchByStep.length;
    const cumulativeTouch = new Array(n);
    let cum = 0;
    for (let i = 0; i < n; i++) {
      cum += aux.touchByStep[i] / nPaths;
      cumulativeTouch[i] = cum;
    }
    return {
      cumulativeTouch,
      probTouchAny: cum,
      probAlive: aux.aliveAtMaturity / nPaths,
      nPaths
    };
  },
  analyticPrice(spec, model, market, modelParams) {
    if (!model.analyticBarrier) return null;
    const T = spec.days / 365;
    const g = model.analyticBarrier(spec.barrierType, spec.optionType,
                                    market.S, spec.strike, T,
                                    market, modelParams, spec.barrier);
    const sign = spec.side === 'long' ? 1 : -1;
    const mul = sign * spec.qty;
    const out = {};
    for (const k of Object.keys(g)) out[k] = mul * g[k];
    return out;
  }
};

// Cliquet / forward-start ladder. Path-dependent, smile-sensitive — the
// showcase product for "calibrate Heston, then see how the cliquet repriced".
//
// Mechanics: per-period return r_i = S_i / S_{i-1} - 1, capped/floored
// pointwise, then summed and capped/floored globally. Payoff = notional *
// max(globalFloor, min(globalCap, sum)).
//
// MC only — no closed form even under GBM (sum of caplet/floorlet pairs has
// correlation across resets that doesn't factor cleanly).
export const Cliquet = {
  id: 'cliquet',
  name: 'Cliquet (capped/floored)',
  defaultSpec(market) {
    return {
      years:       1,
      resets:      12,         // monthly resets
      localCap:    0.04,       // +4% per period
      localFloor: -0.02,       // -2% per period
      globalCap:   0.20,       // +20% over the deal
      globalFloor: 0.0,        // capital protected at par
      notional:    100,
      side:        'long'
    };
  },
  requiredGrid(spec) {
    const n = Math.max(1, Math.floor(spec.resets));
    const T = spec.years;
    const grid = new Float64Array(n + 1);
    for (let i = 0; i <= n; i++) grid[i] = T * i / n;
    return grid;
  },
  evaluatePath(spec, grid, path, market) {
    const T = grid[grid.length - 1];
    const discount = Math.exp(-market.r * T);
    const n = path.length - 1;
    let sum = 0;
    const cappedRets = new Array(n);
    for (let i = 1; i <= n; i++) {
      const r = path[i] / path[i - 1] - 1;
      const c = Math.max(spec.localFloor, Math.min(spec.localCap, r));
      cappedRets[i - 1] = c;
      sum += c;
    }
    const globalRet = Math.max(spec.globalFloor, Math.min(spec.globalCap, sum));
    const sign = spec.side === 'long' ? 1 : -1;
    const pv = sign * spec.notional * globalRet * discount;
    return { pv, globalRet, cappedRets };
  },
  auxInit(spec) {
    const n = Math.max(1, Math.floor(spec.resets));
    return {
      // Aggregated histogram of capped per-period returns
      retSamples: [],   // flat array; sampled for cliquet histogram
      globalRetSamples: [],
      // Per-period distribution stats
      perPeriodSum: new Float64Array(n),
      perPeriodCount: new Int32Array(n),
      cappedAtUpper: 0,        // count of period-rets pinned to localCap
      cappedAtLower: 0,        // count pinned to localFloor
      sampleCap: 4000          // flat histogram cap
    };
  },
  accumulate(spec, result, path, aux) {
    const eps = 1e-9;
    const rets = result.cappedRets;
    for (let i = 0; i < rets.length; i++) {
      aux.perPeriodSum[i] += rets[i];
      aux.perPeriodCount[i]++;
      if (rets[i] >= spec.localCap - eps) aux.cappedAtUpper++;
      else if (rets[i] <= spec.localFloor + eps) aux.cappedAtLower++;
      if (aux.retSamples.length < aux.sampleCap) aux.retSamples.push(rets[i]);
    }
    aux.globalRetSamples.push(result.globalRet);
  },
  auxFinalize(spec, aux, nPaths) {
    const n = aux.perPeriodSum.length;
    const meanPerPeriod = new Array(n);
    for (let i = 0; i < n; i++) {
      meanPerPeriod[i] = aux.perPeriodCount[i] > 0
        ? aux.perPeriodSum[i] / aux.perPeriodCount[i] : 0;
    }
    const totalRets = nPaths * n;
    return {
      meanPerPeriod,
      retSamples: aux.retSamples,
      globalRetSamples: aux.globalRetSamples,
      probUpperCap: aux.cappedAtUpper / Math.max(1, totalRets),
      probLowerCap: aux.cappedAtLower / Math.max(1, totalRets),
      nPaths
    };
  }
};

export const PRODUCTS = {
  vanilla: VanillaPortfolio,
  digital: EuropeanDigital,
  autocallable: Autocallable,
  barrier: Barrier,
  cliquet: Cliquet
};

function roundStrike(S) {
  if (S >= 50)  return Math.round(S);
  if (S >= 10)  return Math.round(S * 2) / 2;
  return Math.round(S * 10) / 10;
}
