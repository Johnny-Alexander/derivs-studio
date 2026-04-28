// mc-worker.js — runs the Monte Carlo loop on a separate thread.
// Imports pricing primitives directly; keeps the main UI responsive.
//
// v3 additions:
//   - Multi-state simulation via model.simulateState. The worker still passes
//     a flat `path` (the spot slice) to product.evaluatePath, so all v2
//     products keep working unchanged. Products that want full state can read
//     it from a second arg passed only when stateDim > 1.
//   - Sampling modes: 'pseudo' (default), 'antithetic'. Antithetic mirrors
//     each block of normals; the engine averages the (Z, -Z) pair into one
//     accumulated PV, halving variance for symmetric payoffs.
//   - Control-variate hook: if product.controlVariate(spec, market, modelParams)
//     returns { analyticPV, evaluateOnPath(grid, path) -> pvCV }, the worker
//     subtracts (pvCV - analyticPV) from each path's PV. Mean is unchanged in
//     expectation but variance drops for products with a correlated CV.

import { mulberry32, makeNormal, welford } from './core.js';
import { MODELS } from './models.js';
import { PRODUCTS } from './products.js';

self.onmessage = function(e) {
  const req = e.data;
  try {
    run(req);
  } catch (err) {
    self.postMessage({ type: 'error', message: err && err.message ? err.message : String(err) });
  }
};

function run({
  productId, spec, modelId, modelParams, market,
  nPaths, seed = 1337,
  sampling = 'pseudo'
}) {
  const model = MODELS[modelId];
  const product = PRODUCTS[productId];
  if (!model || !product) throw new Error('Unknown model/product: ' + modelId + '/' + productId);
  if (!model.simulateState && !model.simulatePath) {
    throw new Error('Model ' + modelId + ' is not ready for simulation.');
  }

  const grid = product.requiredGrid(spec);
  const nSteps = grid.length - 1;
  const stateDim = model.stateDim || 1;
  const normalsPerStep = model.normalsPerStep || 1;
  const normalsLen = nSteps * normalsPerStep;

  const rng = mulberry32(seed);
  const randn = makeNormal(rng);

  // Path = the spot slice of state. We always pass `path` (Float64Array of
  // length grid.length) to product.evaluatePath. Products that need full state
  // (multi-asset, vol path) can later opt-in via product.usesState=true.
  const state = new Float64Array(grid.length * stateDim);
  const path  = new Float64Array(grid.length);
  const normals = new Float64Array(normalsLen);

  const w = welford();
  const aux = product.auxInit ? product.auxInit(spec) : null;

  // Optional control variate. Built once per run because it only depends on
  // (spec, market, modelParams).
  const cv = product.controlVariate
    ? product.controlVariate(spec, market, modelParams, model)
    : null;

  // Antithetic doubles the effective path count. We loop over pseudo-paths
  // and emit one (Z) or two (Z, -Z) MC samples each. nPaths is the number of
  // *Welford pushes*, so antithetic runs nPaths/2 base draws.
  const antithetic = sampling === 'antithetic';
  const baseLoops = antithetic ? Math.ceil(nPaths / 2) : nPaths;
  const reportEvery = Math.max(1, Math.floor(baseLoops / 20));

  let pushed = 0;
  for (let p = 0; p < baseLoops && pushed < nPaths; p++) {
    for (let i = 0; i < normalsLen; i++) normals[i] = randn();
    pushed += runOne(model, product, spec, grid, market, modelParams,
                     state, path, normals, stateDim, cv, w, aux, nPaths - pushed);

    if (antithetic && pushed < nPaths) {
      for (let i = 0; i < normalsLen; i++) normals[i] = -normals[i];
      pushed += runOne(model, product, spec, grid, market, modelParams,
                       state, path, normals, stateDim, cv, w, aux, nPaths - pushed);
    }

    if (p > 0 && p % reportEvery === 0) {
      self.postMessage({
        type: 'progress',
        done: pushed,
        total: nPaths,
        mean: w.mean + (cv ? cv.analyticPV : 0),
        stderr: w.stderr
      });
    }
  }

  // If a CV was used, w.mean is E[PV - (CV - analyticPV)]; add analyticPV back
  // to recover the unbiased estimator of the product price.
  const price = cv ? w.mean + cv.analyticPV : w.mean;

  self.postMessage({
    type: 'done',
    price,
    stderr: w.stderr,
    nPaths: w.n,
    sampling,
    controlVariate: !!cv,
    auxiliary: product.auxFinalize ? product.auxFinalize(spec, aux, w.n) : null
  });
}

// One MC sample: simulate state, slice spot path, evaluate, accumulate. Returns
// 1 if it pushed a sample, 0 if cap was hit.
function runOne(model, product, spec, grid, market, modelParams,
                state, path, normals, stateDim, cv, w, aux, cap) {
  if (cap <= 0) return 0;
  model.simulateState(market.S, grid, market, modelParams, normals, state);
  for (let i = 0; i < grid.length; i++) path[i] = state[i * stateDim];

  const result = product.evaluatePath(spec, grid, path, market);
  let pv = result.pv;
  if (cv) {
    const pvCV = cv.evaluateOnPath(grid, path);
    pv = pv - (pvCV - cv.analyticPV);
  }
  w.push(pv);
  if (product.accumulate && aux) product.accumulate(spec, result, path, aux);
  return 1;
}
