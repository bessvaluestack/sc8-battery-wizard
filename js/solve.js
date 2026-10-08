// Run the dispatch LP in a module worker (falls back to the main thread).
import { logWarn } from './edition.js';

let worker = null, seq = 0;
const pending = new Map();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./solver-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (ev) => {
    const { id, ok, result, error } = ev.data;
    const p = pending.get(id); if (!p) return;
    pending.delete(id);
    ok ? p.resolve(result) : p.reject(new Error(error));
  };
  worker.onerror = (ev) => {
    for (const [, p] of pending) p.reject(new Error('solver worker failed: ' + (ev.message || 'unknown error')));
    pending.clear();
    worker = null;
  };
  return worker;
}

export async function solveDispatch(inputs) {
  if (typeof Worker !== 'undefined') {
    try {
      const w = getWorker();
      return await new Promise((resolve, reject) => {
        const id = ++seq;
        pending.set(id, { resolve, reject });
        w.postMessage({ id, inputs });
      });
    } catch (e) {
      logWarn('worker solve failed, falling back to the main thread:', e);
    }
  }
  const [{ default: loadHighs }, { solveWithCycleCap }] = await Promise.all([
    import('../vendor/highs/highs.mjs'), import('./lp.js'),
  ]);
  const highs = await loadHighs({ locateFile: (f) => new URL('../vendor/highs/' + f, import.meta.url).href });
  return solveWithCycleCap(highs, inputs);
}
