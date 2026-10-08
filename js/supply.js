// Commodity supply on top of the delivery-only SC 8 schedules.
//
//   coned_msc   Con Edison full service: the observed Market Supply Charge
//               (energy, $/kWh by billing period from the corpus dataset,
//               laid onto the model year by calendar day) + the MSC capacity
//               charge ($/kW-month on the monthly maximum demand) + the
//               merchant function charge + optional adjustment factors.
//   coned_mhp   Con Edison full service under Rider M (day-ahead hourly
//               pricing): zonal DA LBMP + MFC + adjustments, capacity as the
//               Rider M ICAP tag ($/kW-month).
//   esco_fixed  third-party supply at a flat all-in $/kWh (+ optional $/kW-month)
//   esco_lbmp   third-party supply at zonal LBMP + adder (+ optional $/kW-month)
//
// Ported from the reference engine's app/tariffs/supply.py and msc_lookup.py.

import { buildIndex, windowMask, STEPS_PER_HOUR } from './timeidx.js';
import { mscProvenance, lbmpSource } from './edition.js';

export const SUPPLY_MODES = {
  coned_msc: 'Con Edison full service (Market Supply Charge)',
  coned_mhp: 'Con Edison full service, Rider M hourly pricing',
  esco_fixed: 'Third-party supply, fixed $/kWh',
  esco_lbmp: 'Third-party supply, LBMP + adder',
};

export function mscCodeFor(rateNo) {
  // codes.yaml: 008CNV = SC 8 Rates I, III, IV; 008TOD = Rates II and V (Rider M exempt)
  return rateNo === 2 ? '008TOD' : '008CNV';
}

export function mscWindowFor(rateNo) {
  return rateNo === 1 ? 'all' : 'on_off_peak';
}

// Union of the tariff's windows that carry hours (Con Ed's Rate II/III
// delivery energy is flat; the on-peak block lives on the TOD demand charges).
export function onPeakMask(tariff) {
  const idx = buildIndex();
  const mask = new Uint8Array(idx.T);
  const add = (w, months) => {
    if (!w.hours) return;
    const m = windowMask(idx, { months, days: w.days || 'all', hours: w.hours });
    for (let t = 0; t < idx.T; t++) if (m[t]) mask[t] = 1;
  };
  for (const s of tariff.energy.seasons || []) for (const w of s.tou || []) add(w, s.months);
  for (const c of (tariff.demand && tariff.demand.charges) || []) add(c, c.months);
  return mask;
}

function dailyToIntervals(daily) {
  const idx = buildIndex();
  const out = new Float64Array(idx.T);
  for (let t = 0; t < idx.T; t++) out[t] = daily[idx.doy[t]];
  return out;
}

export function hourlyToIntervals(hourly) {
  const idx = buildIndex();
  const out = new Float64Array(idx.T);
  for (let t = 0; t < idx.T; t++) out[t] = hourly[Math.floor(t / STEPS_PER_HOUR)];
  return out;
}

export function mean(arr) { let s = 0; for (let i = 0; i < arr.length; i++) s += arr[i]; return s / arr.length; }

/**
 * @param cfg  { mode, region: 'nyc'|'westchester', zone: 'J'|'H'|'I', rateNo: 1|2|3,
 *               capacityRate (override $/kW-month or null), mfc ($/kWh), reconciliation ($/kWh),
 *               taxReimbursement ($/kWh), fixedRate ($/kWh), adder ($/kWh), escoCapacity ($/kW-month) }
 * @param data { msc, lbmp: {J,H,I}, statements, tariff }
 * @returns { energyRate: Float64Array ($/kWh), capacityRate ($/kW-month, all-hours monthly max), components, description, warnings }
 */
export function buildSupply(cfg, data) {
  const idx = buildIndex();
  const T = idx.T;
  const st = data.statements;
  const warnings = [];
  const region = cfg.region === 'westchester' ? 'westchester' : 'nyc';
  const zone = cfg.zone || (region === 'nyc' ? 'J' : 'H');
  const mfcDefault = st.merchant_function_charge_usd_per_kwh.scs5_6_8_9_12_13_total;
  const taxReimbDefault = st.msc_adjustment_factors_usd_per_kwh.tax_reimbursement_recovery_nonresidential || 0;
  const mfc = num(cfg.mfc, mfcDefault);
  const taxReimb = num(cfg.taxReimbursement, taxReimbDefault);
  // MSC adjustment factors (monthly reconciliation): the statement value for
  // the supply mode and region unless overridden.
  const adjRows = st.msc_adjustment_factors_usd_per_kwh;
  const reconDefault = cfg.mode === 'coned_mhp'
    ? (adjRows.reconciliation_rider_m_nonresidential[region] || 0)
    : (adjRows.reconciliation_all_other_nonresidential[region] || 0);
  const reconciliation = num(cfg.reconciliation, reconDefault);

  const components = []; // [{name, rate: number|Float64Array, kind:'energy'}]
  let energyMarket;      // Float64Array
  let capacityRate = 0;
  let description = '';
  const lbmpHourly = data.lbmp[zone] && data.lbmp[zone].hourly;

  if (cfg.mode === 'coned_msc') {
    const code = mscCodeFor(cfg.rateNo);
    const win = mscWindowFor(cfg.rateNo);
    const z = data.msc.codes[code].zones[zone];
    if (win === 'all') {
      energyMarket = dailyToIntervals(z.windows.all);
    } else {
      const on = dailyToIntervals(z.windows.on_peak), off = dailyToIntervals(z.windows.off_peak);
      const mask = onPeakMask(data.tariff);
      energyMarket = new Float64Array(T);
      for (let t = 0; t < T; t++) energyMarket[t] = mask[t] ? on[t] : off[t];
    }
    capacityRate = num(cfg.capacityRate, st.msc_capacity_usd_per_kw_month[region][`rate${cfg.rateNo}`]);
    components.push({ name: 'Market Supply Charge (energy)', rate: energyMarket });
    description = `Con Edison MSC lookup ${code}/${win}, zone ${zone}, billed ${z.lookback.from} to ${z.lookback.to} (${z.lookback.periods} billing periods)${mscProvenance(data.msc)}; capacity ${capacityRate.toFixed(2)} $/kW-month on the monthly max demand (statement value for ${region === 'nyc' ? 'NYC' : 'Westchester'}, Rate ${['', 'I', 'II', 'III'][cfg.rateNo]})`;
    if (cfg.rateNo === 2) warnings.push('Rate II customers are normally on Rider M hourly pricing; the 008TOD series is the Rider M exempt MSC.');
  } else if (cfg.mode === 'coned_mhp') {
    if (!lbmpHourly) throw new Error(`no LBMP data for zone ${zone}`);
    const lb = hourlyToIntervals(lbmpHourly);
    energyMarket = new Float64Array(T);
    for (let t = 0; t < T; t++) energyMarket[t] = lb[t] / 1000;
    capacityRate = num(cfg.capacityRate, st.msc_capacity_usd_per_kw_month[region].rider_m_icap_tag);
    components.push({ name: 'Rider M day-ahead LBMP (energy)', rate: energyMarket });
    description = `Rider M mandatory hourly pricing: NYISO day-ahead zone ${zone} LBMP (${lbmpSource(data.lbmp[zone])}) laid onto the model year; capacity ${capacityRate.toFixed(2)} $/kW-month (Rider M ICAP tag statement value, applied to the monthly max demand - a simplification of the tag mechanism)`;
    warnings.push('The Rider M capacity charge is really set by the customer\'s ICAP tag (demand at the NYISO peak hour of the prior year); it is applied here to each month\'s maximum demand.');
  } else if (cfg.mode === 'esco_fixed') {
    const r = num(cfg.fixedRate, 0.09);
    energyMarket = new Float64Array(T).fill(r);
    capacityRate = num(cfg.escoCapacity, 0);
    components.push({ name: 'Third-party supply (fixed)', rate: energyMarket });
    description = `Third-party supply at a fixed ${r.toFixed(4)} $/kWh` + (capacityRate ? ` plus ${capacityRate.toFixed(2)} $/kW-month` : ' (capacity assumed included)');
  } else if (cfg.mode === 'esco_lbmp') {
    if (!lbmpHourly) throw new Error(`no LBMP data for zone ${zone}`);
    const adder = num(cfg.adder, 0.02);
    const lb = hourlyToIntervals(lbmpHourly);
    energyMarket = new Float64Array(T);
    for (let t = 0; t < T; t++) energyMarket[t] = lb[t] / 1000 + adder;
    capacityRate = num(cfg.escoCapacity, 0);
    components.push({ name: `Third-party supply (LBMP + ${adder.toFixed(4)})`, rate: energyMarket });
    description = `Third-party supply at zone ${zone} day-ahead LBMP + ${adder.toFixed(4)} $/kWh adder` + (capacityRate ? ` plus ${capacityRate.toFixed(2)} $/kW-month` : '');
  } else {
    throw new Error(`unknown supply mode ${cfg.mode}`);
  }

  const energyRate = new Float64Array(T);
  const isUtility = cfg.mode === 'coned_msc' || cfg.mode === 'coned_mhp';
  const flatAdders = isUtility ? mfc + taxReimb + reconciliation : 0;
  for (let t = 0; t < T; t++) energyRate[t] = energyMarket[t] + flatAdders;
  if (isUtility) {
    components.push({ name: 'Merchant function charge', rate: mfc });
    if (taxReimb) components.push({ name: 'Tax reimbursement recovery', rate: taxReimb });
    if (reconciliation) components.push({ name: 'MSC adjustment factors', rate: reconciliation });
    description += `; MFC ${mfc.toFixed(6)} and MSC adjustment factors ${reconciliation.toFixed(6)} $/kWh (statement values)`;
  }

  return {
    mode: cfg.mode, zone, region, energyRate, capacityRate, components, description, warnings,
    avgEnergyRate: mean(energyRate),
    lbmpAvg: lbmpHourly ? mean(lbmpHourly) / 1000 : null,
  };
}

function num(v, dflt) {
  if (v === null || v === undefined || v === '' || Number.isNaN(+v)) return dflt;
  return +v;
}
