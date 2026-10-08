// Assemble one scenario (rate + supply + riders + load + battery) into the
// bill stack, the LP inputs, and the results. Pure functions; the solver
// runs in the worker (see solve.js).

import { buildIndex, DT_HOURS, MONTH_NAMES } from './timeidx.js';
import { buildTariffArrays, makeCharge, monthlyPeakGroups, billFromProfile, peakOf, monthlyEnergyKwh, monthlyPeakKw } from './tariff.js';
import { buildSupply } from './supply.js';
import { buildPrograms } from './programs.js';

export const RATE_LABELS = { 1: 'Rate I (standard)', 2: 'Rate II (mandatory time-of-day, >1,500 kW)', 3: 'Rate III (voluntary time-of-day)' };

// Match on the key suffix: the source data prefixes keys with their origin
// and the client build drops that prefix.
export function tariffFor(tariffs, rateNo, voltage) {
  const key = Object.keys(tariffs).find((k) => k.endsWith(`sc8_rate${rateNo}_${voltage}`));
  return key ? tariffs[key] : null;
}

/**
 * Build everything that does not depend on the load profile.
 * @param cfg  { rateNo, voltage:'lt'|'ht', region:'nyc'|'westchester', zone, demandIntervalMin,
 *               adjustments: { kwh (delivery $/kWh), sbcDemand (bool), extraKwh, extraDemand ($/kW-mo) },
 *               taxPct, supply: {...}, programs: {...} }
 */
export function buildStack(cfg, data) {
  const idx = buildIndex();
  const tariff = tariffFor(data.tariffs, cfg.rateNo, cfg.voltage);
  if (!tariff) throw new Error(`no tariff for Rate ${cfg.rateNo} ${cfg.voltage}`);
  const st = data.statements;

  // --- delivery adjustments on the demand determinant (SBC) ---
  const extraDemand = [];
  const adj = cfg.adjustments || {};
  if (adj.sbcDemand !== false) {
    if (cfg.rateNo === 1) {
      const v = st.delivery_adjustments_usd_per_kw_month.sbc_sc8_rate_i_monthly_max.value;
      extraDemand.push({ name: 'SBC surcharge (monthly max)', rate: v, group: 'delivery_adjustment_demand', determinant: 'monthly_max_demand_kw' });
    } else {
      const row = st.delivery_adjustments_usd_per_kw_month.sbc_sc8_rates_ii_iii_tod;
      extraDemand.push({ name: 'SBC surcharge (TOD weekdays 8-22)', rate: row.value, days: row.window.days, hours: row.window.hours, months: row.window.months, group: 'delivery_adjustment_demand', determinant: 'tod_demand_kw' });
    }
  }
  if (+adj.extraDemand) extraDemand.push({ name: 'Other demand adjustment', rate: +adj.extraDemand, group: 'delivery_adjustment_demand' });
  const ta = buildTariffArrays(tariff, { extraDemandCharges: extraDemand });

  // --- delivery $/kWh adjustments ---
  const k = st.delivery_adjustments_usd_per_kwh;
  const kwhAdjDefault = (k.sbc_total_nyserda.value || 0) + (k.mac.value || 0) + (k.mac_adjustment_factor.value || 0) + (k.rdm_sc8.value || 0) + (k.sdr_sc8_rates_i_ii_iii.value || 0);
  const kwhAdj = (adj.kwh === null || adj.kwh === undefined || adj.kwh === '') ? kwhAdjDefault : +adj.kwh;

  // --- supply ---
  const supply = buildSupply({ ...cfg.supply, region: cfg.region, zone: cfg.zone, rateNo: cfg.rateNo }, { ...data, tariff });
  const charges = [...ta.demandCharges];
  if (supply.capacityRate > 0) charges.push(makeCharge(idx, { name: 'Supply capacity (monthly max)', rate: supply.capacityRate, group: 'supply_capacity' }));

  const T = idx.T;
  const price = new Float64Array(T);
  for (let t = 0; t < T; t++) price[t] = ta.energyRate[t] + kwhAdj + supply.energyRate[t];

  // --- programs ---
  const programs = buildPrograms(cfg.programs || {}, data, cfg.zone || supply.zone);

  const taxFactor = 1 + (+cfg.taxPct || 0) / 100;
  return {
    idx, tariff, ta, supply, charges, price, kwhAdj, kwhAdjDefault, programs, taxFactor,
    demandIntervalMin: cfg.demandIntervalMin === 15 ? 15 : 30,
    energyComponents: [
      { name: 'Delivery energy', rate: ta.energyRate },
      { name: 'Delivery $/kWh adjustments', rate: kwhAdj },
      ...supply.components,
    ],
  };
}

// Annual bill for an import profile under a stack.
export function billFor(stack, importKw) {
  const dt = DT_HOURS;
  const b = billFromProfile({ energyRate: stack.price, charges: stack.charges, fixedAnnual: stack.ta.fixedAnnual, idx: stack.idx, importKw, dt, demandIntervalMin: stack.demandIntervalMin });
  const comps = {};
  for (const c of stack.energyComponents) {
    let s = 0;
    if (typeof c.rate === 'number') { for (let t = 0; t < importKw.length; t++) s += importKw[t]; s *= c.rate; }
    else { for (let t = 0; t < importKw.length; t++) s += c.rate[t] * importKw[t]; }
    comps[c.name] = s * dt;
  }
  const pretax = b.subtotal;
  const tax = pretax * (stack.taxFactor - 1);
  return { ...b, energyComponents: comps, tax, total: pretax + tax };
}

// LP inputs for the worker: merge every $/kW determinant that shares a
// (month, window) into one peak term with the summed rate.
export function lpInputs(stack, load, battery, withPrograms) {
  const groups = monthlyPeakGroups(stack.charges, stack.idx);
  const merged = new Map();
  for (const g of groups) {
    const key = `${g.month}|${g.charge.windowKey}`;
    if (!merged.has(key)) merged.set(key, { key, rate: 0, idx: g.idx, month: g.month, names: [] });
    const m = merged.get(key); m.rate += g.charge.rate; m.names.push(g.charge.name);
  }
  const peakTerms = [...merged.values()];
  let programs = null;
  if (withPrograms && stack.programs.programs.length) {
    programs = stack.programs.programs.filter((p) => p.events.length).map((p) => {
      const all = new Set(); for (const e of p.events) for (const t of e.intervals) all.add(t);
      return {
        id: p.id, pledgeKw: p.pledgeKw, events: p.events.map((e) => ({ intervals: e.intervals })),
        allIntervals: Int32Array.from([...all].sort((a, b) => a - b)),
        performanceIntervals: p.performanceIntervals, performanceRate: p.performanceRate,
        reservationValuePerKw: p.reservationValuePerKw,
      };
    });
    if (!programs.length) programs = null;
  }
  return {
    load, price: stack.price, peakTerms, battery, dt: DT_HOURS, demandIntervalMin: stack.demandIntervalMin,
    programs, taxFactor: stack.taxFactor,
  };
}

export function programRevenue(stack, lpIn, sol) {
  const out = { total: 0, streams: [] };
  if (!lpIn.programs) return out;
  lpIn.programs.forEach((pg, pi) => {
    const s = sol.programs[pi];
    const perf = pg.performanceIntervals || pg.allIntervals;
    let relief = 0, perfKwh = 0;
    for (const t of pg.allIntervals) relief += s.r[t] * DT_HOURS;
    for (const t of perf) perfKwh += s.r[t] * DT_HOURS;
    const reservation = pg.reservationValuePerKw * s.D;
    const performance = pg.performanceRate * perfKwh;
    const meta = stack.programs.programs.find((p) => p.id === pg.id);
    out.streams.push({
      id: pg.id, label: meta.label, pledgeKw: pg.pledgeKw, deliveredKw: s.D, factor: pg.pledgeKw ? s.D / pg.pledgeKw : 0,
      reservation, performance, reliefKwh: relief, events: pg.events.length, terms: meta.terms,
      eventDays: meta.events.map((e) => e.day), hours: meta.events.length ? meta.events[0].hours : null,
    });
    out.total += reservation + performance;
  });
  return out;
}

export function summarize(stack, load, battery, baselineBill, solBill, solBillOnly, lpIn, sol, revenue) {
  const idx = stack.idx;
  const dt = DT_HOURS;
  let thr = 0; for (let t = 0; t < idx.T; t++) thr += sol.dis[t];
  thr *= dt;
  const cycles = battery.kwh > 0 ? thr / battery.kwh : 0;
  const savingsBill = baselineBill.total - solBill.total;
  const monthly = [];
  for (let m = 1; m <= 12; m++) {
    const a = idx.monthStart[m - 1], b = idx.monthStart[m];
    const pos = []; for (let t = a; t < b; t++) pos.push(t);
    monthly.push({
      month: MONTH_NAMES[m - 1],
      peakBefore: peakOf(load, pos, stack.demandIntervalMin), peakAfter: peakOf(sol.imp, pos, stack.demandIntervalMin),
    });
  }
  // per-month cost delta from the peak tables
  const costBefore = new Array(12).fill(0), costAfter = new Array(12).fill(0);
  for (const p of baselineBill.peaks) costBefore[p.month - 1] += p.cost;
  for (const p of solBill.peaks) costAfter[p.month - 1] += p.cost;
  const eBefore = monthlyEnergyKwh(load, idx, dt), eAfter = monthlyEnergyKwh(sol.imp, idx, dt);
  monthly.forEach((m, i) => { m.demandBefore = costBefore[i]; m.demandAfter = costAfter[i]; m.kwhBefore = eBefore[i]; m.kwhAfter = eAfter[i]; });
  return {
    savingsBill, programRevenue: revenue.total, savingsTotal: savingsBill + revenue.total,
    throughputKwh: thr, cycles, cycleLimit: battery.cyclesPerYear,
    peakBefore: Math.max(...monthlyPeakKw(load, idx, stack.demandIntervalMin)),
    peakAfter: Math.max(...monthlyPeakKw(sol.imp, idx, stack.demandIntervalMin)),
    monthly, billOnlySavings: solBillOnly ? baselineBill.total - solBillOnly.total : null,
  };
}
