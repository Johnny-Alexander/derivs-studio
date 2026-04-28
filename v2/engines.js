// engines.js — pricing engines exposed to the UI layer.
//
// Two engines:
//   - analytic: closed-form (only if product+model support it)
//   - monte-carlo: runs the MC web worker
//
// Main thread only. The worker module (mc-worker.js) is the counterpart.

import { MODELS } from './models.js';
import { PRODUCTS } from './products.js';

// Price a product under a model using closed-form formulas (if available).
// Returns null if the combination doesn't support closed form.
export function priceAnalytic({ productId, spec, modelId, modelParams, market }) {
  const model = MODELS[modelId];
  const product = PRODUCTS[productId];
  if (!model || model.disabled) return null;
  if (!product.analyticPrice) return null;
  return product.analyticPrice(spec, model, market, modelParams);
}

// Run the MC engine. Returns a handle you can `cancel()`.
//   onProgress({ done, total, mean, stderr })
//   onDone({ price, stderr, nPaths, auxiliary })
//   onError(err)
export function priceMonteCarlo({
  productId, spec, modelId, modelParams, market,
  nPaths = 50000, seed = 1337,
  onProgress, onDone, onError
}) {
  const worker = new Worker(new URL('./mc-worker.js', import.meta.url), { type: 'module' });
  let cancelled = false;

  worker.onmessage = (e) => {
    if (cancelled) return;
    const msg = e.data;
    if (msg.type === 'progress' && onProgress) onProgress(msg);
    else if (msg.type === 'done') {
      worker.terminate();
      onDone && onDone(msg);
    } else if (msg.type === 'error') {
      worker.terminate();
      onError && onError(new Error(msg.message));
    }
  };
  worker.onerror = (e) => {
    worker.terminate();
    onError && onError(e);
  };

  worker.postMessage({ productId, spec, modelId, modelParams, market, nPaths, seed });

  return {
    cancel() {
      cancelled = true;
      worker.terminate();
    }
  };
}
