// SC 8 delivery tariff -> per-interval delivery energy rate + demand charges,
// and the closed-form bill for a fixed import profile. Ported from the reference engine's
// app/tariffs/engine.py (seasons/TOU form only - that is what the compiled
// Con Edison schedules use).
//
// A demand charge bills rate x max(import kW over the intervals in its window
// within the month). The demand interval (15 or 30 minutes) is a billing
// convention: with 30 minutes the determinant is the max of half-hour
// averages of the 15-minute profile.

import { buildIndex, dayMask, hourMask, andMasks, windowMask } from './timeidx.js';

export function buildTariffArrays(tariff, opts = {}) {
  const idx = buildIndex();
  const T = idx.T;
  const energyRate = new Float64Array(T).fill(NaN);
  for (const season of tariff.energy.seasons) {
    const sMask = windowMask(idx, { months: season.months });
    // specific windows first, then the catch-all (hours: null)
    const specific = season.tou.filter((w) => w.hours != null);
    const catchAll = season.tou.filter((w) => w.hours == null);
    for (const w of specific) {
      const m = andMasks(sMask, dayMask(idx, w.days || 'all'), hourMask(idx, w.hours));
      for (let t = 0; t < T; t++) if (m[t] && Number.isNaN(energyRate[t])) energyRate[t] = +w.rate;
    }
    for (const w of catchAll) {
      const m = andMasks(sMask, dayMask(idx, w.days || 'all'));
      for (let t = 0; t < T; t++) if (m[t] && Number.isNaN(energyRate[t])) energyRate[t] = +w.rate;
    }
  }
  let gaps = 0;
  for (let t = 0; t < T; t++) if (Number.isNaN(energyRate[t])) gaps++;
  if (gaps) throw new Error(`Tariff ${tariff.id}: ${gaps} intervals have no energy rate`);

  const demandCharges = [];
  for (const c of (tariff.demand && tariff.demand.charges) || []) {
    demandCharges.push(makeCharge(idx, {
      name: c.name, rate: +c.rate, months: c.months || [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
      days: c.days || 'all', hours: c.hours || null, group: 'delivery_demand',
      determinant: c.determinant,
    }));
  }
  for (const c of opts.extraDemandCharges || []) demandCharges.push(makeCharge(idx, c));

  return {
    tariffId: tariff.id,
    name: tariff.name,
    energyRate,
    demandCharges,
    fixedAnnual: (+tariff.fixed_charge_per_month || 0) * 12,
    monthIndex: idx.month,
    idx,
  };
}

// A demand charge with an explicit day/hour mask (month handled per billing month).
export function makeCharge(idx, c) {
  return {
    name: c.name, rate: +c.rate, months: c.months || [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    days: c.days || 'all', hours: c.hours || null,
    mask: andMasks(dayMask(idx, c.days || 'all'), hourMask(idx, c.hours || null)),
    group: c.group || 'other_demand', determinant: c.determinant || null,
    windowKey: `${c.days || 'all'}|${c.hours ? c.hours.join('-') : 'all'}`,
  };
}

// (charge, month, Int32Array of eligible interval positions) triples.
export function monthlyPeakGroups(charges, idx) {
  const out = [];
  for (const ch of charges) {
    for (const m of ch.months) {
      const a = idx.monthStart[m - 1], b = idx.monthStart[m];
      const pos = [];
      for (let t = a; t < b; t++) if (ch.mask[t]) pos.push(t);
      if (pos.length) out.push({ charge: ch, month: m, idx: Int32Array.from(pos) });
    }
  }
  return out;
}

// Billing demand over a set of interval positions. 30-minute billing takes
// the max of half-hour averages (pairs aligned to :00 / :30).
export function peakOf(importKw, pos, demandIntervalMin) {
  let peak = 0;
  if (demandIntervalMin === 30) {
    for (let i = 0; i < pos.length; i++) {
      const t = pos[i];
      if (t % 2 !== 0) continue;
      const v = 0.5 * (importKw[t] + importKw[t + 1]);
      if (v > peak) peak = v;
    }
  } else {
    for (let i = 0; i < pos.length; i++) { const v = importKw[pos[i]]; if (v > peak) peak = v; }
  }
  return peak;
}

// Closed-form bill for a fixed import profile. `energyRate` is the total
// $/kWh series applied to imports (delivery + adjustments + supply), the
// charges are delivery demand + adjustment demand + supply capacity.
export function billFromProfile({ energyRate, charges, fixedAnnual, idx, importKw, dt, demandIntervalMin }) {
  let energy = 0;
  for (let t = 0; t < idx.T; t++) energy += energyRate[t] * importKw[t];
  energy *= dt;
  const peaks = [];
  const byGroup = {};
  let demand = 0;
  for (const g of monthlyPeakGroups(charges, idx)) {
    const pk = peakOf(importKw, g.idx, demandIntervalMin);
    const cost = g.charge.rate * pk;
    demand += cost;
    byGroup[g.charge.group] = (byGroup[g.charge.group] || 0) + cost;
    peaks.push({ charge: g.charge.name, group: g.charge.group, month: g.month, peakKw: pk, rate: g.charge.rate, cost });
  }
  return { energy, demand, demandByGroup: byGroup, fixed: fixedAnnual, peaks, subtotal: energy + demand + fixedAnnual };
}

// Split an energy series bill into named components for reporting.
export function energyComponents(importKw, dt, components) {
  // components: [{name, rate: Float64Array|number}]
  const out = {};
  for (const c of components) {
    let s = 0;
    if (typeof c.rate === 'number') { for (let t = 0; t < importKw.length; t++) s += importKw[t]; s *= c.rate; }
    else { for (let t = 0; t < importKw.length; t++) s += c.rate[t] * importKw[t]; }
    out[c.name] = s * dt;
  }
  return out;
}

export function monthlyEnergyKwh(kw, idx, dt) {
  const out = new Array(12).fill(0);
  for (let t = 0; t < idx.T; t++) out[idx.month[t] - 1] += kw[t];
  return out.map((v) => v * dt);
}

export function monthlyPeakKw(kw, idx, demandIntervalMin) {
  const out = [];
  for (let m = 1; m <= 12; m++) {
    const pos = [];
    for (let t = idx.monthStart[m - 1]; t < idx.monthStart[m]; t++) pos.push(t);
    out.push(peakOf(kw, pos, demandIntervalMin));
  }
  return out;
}
