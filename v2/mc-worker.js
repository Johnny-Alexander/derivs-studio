// mc-worker.js — runs the Monte Carlo loop on a separate thread.
// Imports pricing primitives directly; keeps the main UI responsive.

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

function run({ productId, spec, modelId, modelParams, market, nPaths, seed = 1337 }) {
  const model = MODELS[modelId];
  const product = PRODUCTS[productId];
  if (!model || !product) throw new Error('Unknown model/product: ' + modelId + '/' + productId);
  if (!model.simulatePath) throw new Error('Model ' + modelId + ' is not ready for simulation.');

  const grid = product.requiredGrid(spec);
  const nSteps = grid.length - 1;

  const rng = mulberry32(seed);
  const randn = makeNormal(rng);

  const path = new Float64Array(grid.length);
  const normals = new Float64Array(nSteps);

  const w = welford();
  const aux = product.auxInit ? product.auxInit(spec) : null;

  // progress reporting ~20 times over the run
  const reportEvery = Math.max(1, Math.floor(nPaths / 20));

  for (let p = 0; p < nPaths; p++) {
    for (let i = 0; i < nSteps; i++) normals[i] = randn();
    model.simulatePath(market.S, grid, market, modelParams, normals, path);
    const result = product.evaluatePath(spec, grid, path, market);
    w.push(result.pv);
    if (product.accumulate && aux) product.accumulate(spec, result, path, aux);

    if (p > 0 && p % reportEvery === 0) {
      self.postMessage({
        type: 'progress',
        done: p + 1,
        total: nPaths,
        mean: w.mean,
        stderr: w.stderr
      });
    }
  }

  const result = {
    type: 'done',
    price: w.mean,
    stderr: w.stderr,
    nPaths: w.n,
    auxiliary: product.auxFinalize ? product.auxFinalize(spec, aux, w.n) : null
  };
  self.postMessage(result);
}
