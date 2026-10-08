// node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import loadHighs from '../vendor/highs/highs.mjs';
import { buildIndex, T, DT_HOURS } from '../js/timeidx.js';
import { buildTariffArrays, billFromProfile, peakOf } from '../js/tariff.js';
import { buildStack, billFor, lpInputs, programRevenue, summarize } from '../js/model.js';
import { buildLP, extractSolution, solveWithCycleCap } from '../js/lp.js';
import { parseIntervalCsv, scaleToBill, stats } from '../js/profiles.js';

const read = (p) => JSON.parse(readFileSync(new URL('../data/' + p, import.meta.url), 'utf8'));
const data = {
  tariffs: read('tariffs_sc8.json'), statements: read('statements_sc8.json'), msc: read('msc_sc8.json'),
  lbmp: { J: read('lbmp_J.json'), H: read('lbmp_H.json'), I: read('lbmp_I.json') }, programs: read('programs.json'),
};

test('time index: 35,040 intervals, Jan 1 2027 is a Friday, 12 observed holidays', () => {
  const idx = buildIndex();
  assert.equal(idx.T, 35040);
  assert.equal(idx.dow[0], 4);
  let hol = 0; for (let t = 0; t < idx.T; t += 96) hol += idx.holiday[t];
  assert.equal(hol, 12);
  assert.equal(idx.monthStart[6], (31 + 28 + 31 + 30 + 31 + 30) * 96);
});

test('Rate I LT bill for a flat 100 kW load matches the hand calculation', () => {
  const ta = buildTariffArrays(data.tariffs.corpus_ced_sc8_rate1_lt);
  const idx = buildIndex();
  const imp = new Float64Array(idx.T).fill(100);
  const b = billFromProfile({ energyRate: ta.energyRate, charges: ta.demandCharges, fixedAnnual: ta.fixedAnnual, idx, importKw: imp, dt: DT_HOURS, demandIntervalMin: 30 });
  assert.ok(Math.abs(b.energy - 0.0123 * 876000) < 1e-6);
  assert.ok(Math.abs(b.demand - (4 * 55.65 * 100 + 8 * 42.9 * 100)) < 1e-6);
  assert.equal(b.fixed, 59 * 12);
});

test('Rate II TOD demand windows bill only weekday 8-22 peaks', () => {
  const ta = buildTariffArrays(data.tariffs.corpus_ced_sc8_rate2_lt);
  const idx = buildIndex();
  const imp = new Float64Array(idx.T).fill(100);
  // a 300 kW spike on a Sunday at 10:00 in July must not touch the TOD charges
  for (let t = 0; t < idx.T; t++) if (idx.month[t] === 7 && idx.dow[t] === 6 && idx.hour[t] === 10) imp[t] = 300;
  const b = billFromProfile({ energyRate: ta.energyRate, charges: ta.demandCharges, fixedAnnual: ta.fixedAnnual, idx, importKw: imp, dt: DT_HOURS, demandIntervalMin: 30 });
  const july = b.peaks.filter((p) => p.month === 7);
  const tod = july.filter((p) => p.charge.includes('weekdays'));
  assert.ok(tod.every((p) => Math.abs(p.peakKw - 100) < 1e-9), 'TOD peaks stay at 100');
  assert.ok(july.find((p) => p.charge === 'summer_all_all_hours').peakKw === 300, 'all-hours peak sees the spike');
});

test('30-minute billing demand averages aligned pairs', () => {
  const imp = new Float64Array(8).fill(100); imp[2] = 200; // one 15-min spike
  const pos = Int32Array.from([0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(peakOf(imp, pos, 15), 200);
  assert.equal(peakOf(imp, pos, 30), 150);
});

test('stack: Rate I NYC with Con Ed MSC supply prices every interval', () => {
  const cfg = { rateNo: 1, voltage: 'lt', region: 'nyc', zone: 'J', demandIntervalMin: 30, taxPct: 2.5, supply: { mode: 'coned_msc' }, programs: {} };
  const s = buildStack(cfg, data);
  assert.equal(s.price.length, T);
  assert.ok(s.supply.avgEnergyRate > 0.04 && s.supply.avgEnergyRate < 0.12, `avg supply ${s.supply.avgEnergyRate}`);
  assert.ok(s.supply.capacityRate === 22.87);
  // MSC adjustment factors default to the statement value (NYC, all other non-residential)
  const adj = s.supply.components.find((c) => c.name === 'MSC adjustment factors');
  assert.ok(adj && Math.abs(adj.rate - data.statements.msc_adjustment_factors_usd_per_kwh.reconciliation_all_other_nonresidential.nyc) < 1e-12);
  const mhp = buildStack({ ...cfg, rateNo: 2, supply: { mode: 'coned_mhp' } }, data);
  const adj2 = mhp.supply.components.find((c) => c.name === 'MSC adjustment factors');
  assert.ok(adj2 && Math.abs(adj2.rate - data.statements.msc_adjustment_factors_usd_per_kwh.reconciliation_rider_m_nonresidential.nyc) < 1e-12);
  assert.equal(mhp.supply.capacityRate, 12.45);
  const load = new Float64Array(T).fill(100);
  const b = billFor(s, load);
  assert.ok(b.total > b.subtotal && Math.abs(b.tax - 0.025 * b.subtotal) < 1e-6);
  assert.ok(b.demandByGroup.supply_capacity === 22.87 * 12 * 100);
});

test('dispatch LP: a 50 kW / 100 kWh battery shaves a 2-hour 50 kW spike (short horizon)', async () => {
  const highs = await loadHighs();
  const n = 2 * 96;
  const load = new Float64Array(n).fill(100);
  for (let t = 96 + 72; t < 96 + 80; t++) load[t] = 150; // 18:00-20:00 on day 2
  const price = new Float64Array(n).fill(0.10);
  const peakTerms = [{ key: 'all', rate: 40, idx: Int32Array.from({ length: n }, (_, i) => i) }];
  const battery = { kw: 50, kwh: 100, rte: 0.85, usableFrac: 1.0, cyclesPerYear: 365, throughputCost: 0 };
  const inp = { load, price, peakTerms, battery, dt: 0.25, demandIntervalMin: 15, programs: null, taxFactor: 1 };
  const lp = buildLP(inp);
  const sol = highs.solve(lp, { output_flag: false });
  assert.equal(sol.Status, 'Optimal');
  const r = extractSolution(sol, inp);
  // 100 kWh stored delivers 100 * sqrt(0.85) = 92.2 kWh over the 2 h spike -> 46.1 kW of relief
  const expected = 150 - 100 * Math.sqrt(0.85) / 2;
  assert.ok(Math.abs(r.peaks[0] - expected) < 0.05, `peak ${r.peaks[0]} vs ${expected}`);
  let maxImp = 0; for (let t = 0; t < n; t++) maxImp = Math.max(maxImp, r.imp[t]);
  assert.ok(Math.abs(maxImp - r.peaks[0]) < 1e-4);
});

test('full-year solve on a preset with CSRP enrolled runs and saves money', async () => {
  const highs = await loadHighs();
  const prof = read('profiles/midrise_gas_windowac.json');
  const load = Float64Array.from(prof.kw);
  const cfg = {
    rateNo: 1, voltage: 'lt', region: 'nyc', zone: 'J', demandIntervalMin: 30, taxPct: 2.5,
    supply: { mode: 'coned_msc' },
    programs: { enabled: { csrp: true }, network: 'YORKVILLE', pledgeKw: 100, events: { csrp: 3 } },
  };
  const stack = buildStack(cfg, data);
  assert.equal(stack.programs.programs.length, 1);
  assert.equal(stack.programs.programs[0].events.length, 3);
  const battery = { kw: 100, kwh: 200, rte: 0.88, usableFrac: 0.95, cyclesPerYear: 300, throughputCost: 0 };
  const inp = lpInputs(stack, load, battery, true);
  const t0 = Date.now();
  const r = solveWithCycleCap(highs, inp);
  const base = billFor(stack, load), withB = billFor(stack, r.imp);
  const rev = programRevenue(stack, inp, r);
  const sum = summarize(stack, load, battery, base, withB, null, inp, r, rev);
  console.log(`  baseline $${base.total.toFixed(0)}, with battery $${withB.total.toFixed(0)}, programs $${rev.total.toFixed(0)}, cycles ${sum.cycles.toFixed(0)} (capped: ${r.cycleInfo.capped}), ${Date.now() - t0} ms`);
  assert.ok(sum.savingsBill > 0);
  assert.ok(sum.cycles <= 300.01);
  assert.ok(rev.streams[0].deliveredKw > 0);
});

test('CSRP and DLRP together: performance is paid under both on concurrent hours', () => {
  const cfg = { rateNo: 1, voltage: 'lt', region: 'nyc', zone: 'J', demandIntervalMin: 15, taxPct: 0, supply: { mode: 'coned_msc' },
    programs: { enabled: { csrp: true, dlrp: true }, network: 'YORKVILLE', pledgeKw: 100, events: { csrp: 3, dlrp: 2 } } };
  const stack = buildStack(cfg, data);
  const dlrp = stack.programs.programs.find((p) => p.id === 'dlrp');
  assert.equal(dlrp.performanceIntervals, null);
  assert.ok(stack.programs.notes.some((n) => n.includes('under both programs')));
});

test('two-stage cycle cap: a tight budget binds and reports a marginal value', async () => {
  const highs = await loadHighs();
  const prof = read('profiles/midrise_gas_windowac.json');
  const load = Float64Array.from(prof.kw);
  const cfg = { rateNo: 3, voltage: 'lt', region: 'nyc', zone: 'J', demandIntervalMin: 30, taxPct: 0, supply: { mode: 'coned_mhp' }, programs: {} };
  const stack = buildStack(cfg, data);
  const battery = { kw: 100, kwh: 200, rte: 0.88, usableFrac: 0.95, cyclesPerYear: 60, throughputCost: 0 };
  const inp = lpInputs(stack, load, battery, false);
  const r = solveWithCycleCap(highs, inp);
  assert.equal(r.cycleInfo.capped, true);
  assert.ok(r.cycleInfo.throughputKwh <= 60 * 200 * 1.001, `throughput ${r.cycleInfo.throughputKwh}`);
  assert.ok(r.cycleInfo.uncappedThroughputKwh > 60 * 200);
  assert.ok(r.cycleInfo.marginalUsdPerKwh > 0, `marginal ${r.cycleInfo.marginalUsdPerKwh}`);
});

test('interval CSV parser: ISO kW, Green Button date+time kWh, hourly resample', () => {
  const idx = buildIndex();
  const lines = ['timestamp,kw'];
  for (let t = 0; t < idx.T; t++) {
    const pad = (n) => String(n).padStart(2, '0');
    lines.push(`2025-${pad(idx.month[t])}-${pad(idx.day[t])} ${pad(idx.hour[t])}:${pad(idx.minute[t])},${(100 + idx.hour[t]).toFixed(1)}`);
  }
  const a = parseIntervalCsv(lines.join('\n'));
  assert.equal(a.meta.sourceIntervalMin, 15); assert.equal(a.meta.units, 'kw'); assert.ok(a.meta.coverage > 0.999);
  assert.equal(a.kw[0], 100); assert.equal(a.kw[5], 101);
  // Green Button style, hourly kWh
  const gb = ['DATE,START TIME,END TIME,USAGE (kWh)'];
  for (let t = 0; t < idx.T; t += 4) {
    const pad = (n) => String(n).padStart(2, '0');
    gb.push(`2024-${pad(idx.month[t])}-${pad(idx.day[t])},${pad(idx.hour[t])}:00,${pad(idx.hour[t])}:59,${(50).toFixed(2)}`);
  }
  const b = parseIntervalCsv(gb.join('\n'));
  assert.equal(b.meta.sourceIntervalMin, 60); assert.equal(b.meta.units, 'kwh');
  assert.ok(Math.abs(b.kw[0] - 50) < 1e-9 && Math.abs(b.kw[3] - 50) < 1e-9);
  const s = stats(b.kw);
  assert.ok(Math.abs(s.annualKwh - 50 * 8760) < 1);
});

test('annual bill scaling hits the target', () => {
  const cfg = { rateNo: 1, voltage: 'lt', region: 'nyc', zone: 'J', demandIntervalMin: 30, taxPct: 2.5, supply: { mode: 'coned_msc' }, programs: {} };
  const stack = buildStack(cfg, data);
  const prof = read('profiles/midrise_gas_windowac.json');
  const shape = Float64Array.from(prof.kw);
  const target = 500000;
  const { kw } = scaleToBill(shape, target, (k) => billFor(stack, k).total);
  const got = billFor(stack, kw).total;
  assert.ok(Math.abs(got - target) / target < 1e-4, `got ${got}`);
});
