// Module worker: builds the LP text off the main thread and solves it with
// the vendored HiGHS WebAssembly build (vendor/highs, MIT, highs-js 1.15.3).
import loadHighs from '../vendor/highs/highs.mjs';
import { solveWithCycleCap } from './lp.js';

let highsPromise = null;
function getHighs() {
  if (!highsPromise) {
    highsPromise = loadHighs({ locateFile: (f) => new URL('../vendor/highs/' + f, import.meta.url).href });
  }
  return highsPromise;
}

self.onmessage = async (ev) => {
  const { id, inputs } = ev.data;
  try {
    const t0 = performance.now();
    const highs = await getHighs();
    const t1 = performance.now();
    const res = solveWithCycleCap(highs, inputs);
    res.timing.loadMs = t1 - t0;
    res.timing.totalMs = performance.now() - t0;
    self.postMessage({ id, ok: true, result: res }, [res.imp.buffer, res.ch.buffer, res.dis.buffer, res.soc.buffer]);
  } catch (e) {
    self.postMessage({ id, ok: false, error: String(e && e.message || e) });
  }
};
