// jobs.js — small worker-pool manager for v3.
//
// v2 spawned one Web Worker per priceMonteCarlo call. Calibration in v3 wants
// to run many short pricing jobs at once (e.g. one FFT pricer per surface
// point), and we want a way to cancel them as a group.
//
// This module sits *above* engines.js / priceMonteCarlo. Single-product
// pricing keeps using priceMonteCarlo directly; jobs.js is the entry point
// when you have a batch of jobs that share a lifecycle.
//
// API:
//   const pool = new JobPool({ concurrency, workerUrl });
//   const handle = pool.submit({ payload, onMessage, onError, tag });
//   pool.cancel(handle);          // cancel one job
//   pool.cancelAll(tag);          // cancel every job with this tag (or all if undefined)
//   pool.shutdown();              // terminate all workers, drop queue
//
//   payload is forwarded as-is via worker.postMessage. The worker contract
//   (mc-worker.js, fft-worker.js, etc.) is the responsibility of the caller.
//
// Concurrency defaults to navigator.hardwareConcurrency - 1 (min 1, max 8).
// We don't want to peg the UI thread on a phone.

function defaultConcurrency() {
  const hc = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
  return Math.max(1, Math.min(8, hc - 1));
}

export class JobPool {
  constructor({ concurrency, workerUrl, workerOptions } = {}) {
    if (!workerUrl) throw new Error('JobPool: workerUrl is required');
    this.workerUrl = workerUrl;
    this.workerOptions = workerOptions || { type: 'module' };
    this.concurrency = concurrency || defaultConcurrency();
    this._queue = [];        // pending jobs
    this._active = new Map(); // jobId -> { worker, job }
    this._nextId = 1;
    this._shutdown = false;
  }

  submit({ payload, onMessage, onDone, onError, tag = null }) {
    if (this._shutdown) throw new Error('JobPool is shut down');
    const id = this._nextId++;
    const handle = {
      id, tag, cancelled: false,
      payload, onMessage, onDone, onError
    };
    this._queue.push(handle);
    this._drain();
    return handle;
  }

  cancel(handle) {
    if (!handle) return;
    handle.cancelled = true;
    const active = this._active.get(handle.id);
    if (active) {
      active.worker.terminate();
      this._active.delete(handle.id);
      this._drain();
    } else {
      // Still queued: just leave the cancelled flag; _drain will skip it.
    }
  }

  cancelAll(tag) {
    // Cancel queued jobs in O(n).
    this._queue = this._queue.filter(h => {
      if (tag === undefined || h.tag === tag) { h.cancelled = true; return false; }
      return true;
    });
    // Cancel active jobs.
    for (const [id, { worker, job }] of this._active) {
      if (tag === undefined || job.tag === tag) {
        job.cancelled = true;
        worker.terminate();
        this._active.delete(id);
      }
    }
    this._drain();
  }

  shutdown() {
    this._shutdown = true;
    this._queue = [];
    for (const { worker } of this._active.values()) worker.terminate();
    this._active.clear();
  }

  get pending()   { return this._queue.length; }
  get running()   { return this._active.size; }
  get capacity()  { return this.concurrency; }

  _drain() {
    if (this._shutdown) return;
    while (this._active.size < this.concurrency && this._queue.length) {
      const job = this._queue.shift();
      if (job.cancelled) continue;
      this._spawn(job);
    }
  }

  _spawn(job) {
    const worker = new Worker(this.workerUrl, this.workerOptions);
    this._active.set(job.id, { worker, job });

    worker.onmessage = (e) => {
      if (job.cancelled) return;
      const msg = e.data;
      if (msg && msg.type === 'done') {
        worker.terminate();
        this._active.delete(job.id);
        if (job.onDone) job.onDone(msg);
        this._drain();
      } else if (msg && msg.type === 'error') {
        worker.terminate();
        this._active.delete(job.id);
        if (job.onError) job.onError(new Error(msg.message));
        this._drain();
      } else if (job.onMessage) {
        job.onMessage(msg);
      }
    };
    worker.onerror = (e) => {
      worker.terminate();
      this._active.delete(job.id);
      if (job.onError) job.onError(e);
      this._drain();
    };

    worker.postMessage(job.payload);
  }
}

// Convenience: an MC pool wired to mc-worker.js with the priceMonteCarlo
// payload shape. Useful when several products want to share workers.
export function createMcPool(options = {}) {
  return new JobPool({
    workerUrl: new URL('./mc-worker.js', import.meta.url),
    ...options
  });
}
