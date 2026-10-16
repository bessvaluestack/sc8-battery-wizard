// The owner pro-forma (templates/proforma.xlsx, built by
// scripts/make_proforma_template.mjs) filled from a run: the hourly profiles,
// the savings and the program revenue, plus the installed cost when one was
// entered. O&M, finance and resiliency inputs are left as the template has
// them (blank, or zero for "none") for the user to set.
import { unzipSync, zipSync, strFromU8, strToU8 } from '../vendor/fflate/fflate.mjs';
import { setCells, fillRows } from './xlsx.js';
import { STEPS_PER_HOUR, DT_HOURS } from './timeidx.js';

export const TEMPLATE_URL = new URL('../templates/proforma.xlsx', import.meta.url);
export const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const SHEET = { inputs: 1, rates: 2, hourly: 3, valueStreams: 4 };
const FIRST_ROW = 6; // hour 1 and January are on row 6 of their sheets
const COLS = (from, n) => Array.from({ length: n }, (_, i) => String.fromCharCode(from.charCodeAt(0) + i));

/**
 * Everything the workbook needs from a run.
 * @param run  { stack, load (kW, 15-min), sol, summary, revenue, battery }
 * @param opts { rateLabel, programMonths: { csrp: [5..9], ... }, monthlyBills: [12] | null, installedCost ($) }
 */
export function proformaData({ stack, load, sol, summary, revenue, battery }, { rateLabel, programMonths = {}, monthlyBills = null, installedCost = 0 }) {
  const idx = stack.idx, tf = stack.taxFactor, hours = idx.T / STEPS_PER_HOUR;

  // Hourly averages. kW go in at 0.1 W so that baseline minus dispatch (the
  // workbook's net grid demand) is exactly the import, never a hair below zero.
  const baseline = new Float64Array(hours), dispatch = new Float64Array(hours), rate = new Float64Array(hours);
  for (let h = 0; h < hours; h++) {
    let b = 0, imp = 0, p = 0;
    for (let k = 0; k < STEPS_PER_HOUR; k++) { const t = h * STEPS_PER_HOUR + k; b += load[t]; imp += sol.imp[t]; p += stack.price[t]; }
    const bq = Math.round(Math.max(0, b / STEPS_PER_HOUR) * 1e4), iq = Math.round(Math.max(0, imp / STEPS_PER_HOUR) * 1e4);
    baseline[h] = bq / 1e4;
    dispatch[h] = (bq - iq) / 1e4;
    rate[h] = (p / STEPS_PER_HOUR) * tf; // every price component is constant within an hour
  }

  // Monthly: billing peaks, demand savings and effective rates, taxes included.
  const energyBase = new Array(12).fill(0);
  for (let t = 0; t < idx.T; t++) energyBase[idx.month[t] - 1] += stack.price[t] * load[t] * DT_HOURS * tf;
  const programs = new Array(12).fill(0);
  for (const s of revenue.streams) {
    const season = programMonths[s.id] || [5, 6, 7, 8, 9];
    for (const m of season) programs[m - 1] += s.reservation / season.length;
    s.eventPerfKwh.forEach((kwh, e) => { programs[+s.eventDays[e].split('/')[0] - 1] += s.terms.performanceRate * kwh; });
  }

  const inputs = { C9: 'Con Edison', C10: rateLabel, C16: battery.kw, C17: battery.kwh, C18: battery.usableFrac, C19: 1 - battery.usableFrac, C20: 1, C21: battery.rte };
  if (battery.cyclesPerYear > 0) inputs.C23 = battery.cyclesPerYear;
  // The installed cost is all-in: it goes on the first capital line, the rest are zero.
  if (installedCost > 0) {
    Object.assign(inputs, { C32: installedCost, C33: 0, C34: 0, C35: 0, C36: 0, C37: 0, C38: 0 });
    inputs.E32 = 'All-in installed cost from the SC 8 Battery Wizard; the lines below are 0. Split it across them if you have a breakdown.';
  }
  const rates = {}, valueStreams = {};
  summary.monthly.forEach((m, i) => {
    const r = FIRST_ROW + i;
    const avgRate = m.kwhBefore > 0 ? energyBase[i] / m.kwhBefore : 0;
    rates[`F${r}`] = m.peakBefore > 0 ? (m.demandBefore * tf) / m.peakBefore : 0;
    for (const c of COLS('G', 4)) rates[`${c}${r}`] = avgRate;
    if (monthlyBills) rates[`C${r}`] = +monthlyBills[i] || 0;
    Object.assign(valueStreams, { [`C${r}`]: m.peakBefore, [`D${r}`]: m.peakAfter, [`G${r}`]: (m.demandBefore - m.demandAfter) * tf, [`K${r}`]: programs[i] });
  });
  return { hourly: { baseline, dispatch, rate }, inputs, rates, valueStreams };
}

// Fill the template bytes with proformaData() and return the new workbook.
export function fillProforma(template, d) {
  const files = unzipSync(template);
  const edit = (n, fn) => { const p = `xl/worksheets/sheet${n}.xml`; files[p] = strToU8(fn(strFromU8(files[p]))); };
  const { baseline, dispatch, rate } = d.hourly;
  edit(SHEET.inputs, (x) => setCells(x, d.inputs));
  edit(SHEET.rates, (x) => setCells(x, d.rates));
  edit(SHEET.hourly, (x) => fillRows(x, (n) => {
    const h = n - FIRST_ROW;
    return h >= 0 && h < baseline.length ? { D: baseline[h], E: dispatch[h], H: rate[h] } : null;
  }));
  edit(SHEET.valueStreams, (x) => setCells(x, d.valueStreams));
  return zipSync(files, { level: 6 });
}
