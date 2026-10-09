// Wizard controller: state, rendering, and the run.
import { buildIndex, DT_HOURS, MONTH_NAMES, labelOf } from './timeidx.js';
import { buildStack, billFor, lpInputs, programRevenue, summarize, eventEnergyCheck, MIN_PERFORMANCE, RATE_LABELS } from './model.js';
import { SUPPLY_MODES } from './supply.js';
import { PROGRAM_IDS, PROGRAM_LABELS } from './programs.js';
import { stats, scaleToBill, parseIntervalCsv, toCsv } from './profiles.js';
import { solveDispatch } from './solve.js';
import { barChart, lineChart } from './charts.js';
import { monthlyEnergyKwh, monthlyPeakKw } from './tariff.js';
import * as edition from './edition.js';

const STEPS = ['Rate', 'Supply', 'Riders', 'Load', 'Battery', 'Results'];
const STORAGE_KEY = 'sc8-battery-wizard.v2';

const DEFAULTS = {
  step: 0,
  rateNo: 1, voltage: 'lt', region: 'nyc', zone: 'J', demandIntervalMin: 15, taxPct: 2.5,
  adjustments: { kwh: null, sbcDemand: true, extraDemand: 0 },
  supply: { mode: 'coned_msc', capacityRate: null, mfc: null, reconciliation: null, taxReimbursement: null, fixedRate: 0.09, adder: 0.02, escoCapacity: 0 },
  programs: { enabled: { csrp: false, dlrp: false, term_dlm: false }, network: '', pledgeKw: 100, participation: 'direct', events: { csrp: 3, dlrp: 2, term_dlm: 3 }, termDlm: { reservationRate: '', performanceRate: '' } },
  load: { mode: 'preset', presetId: 'highrise_central_cooling', billTarget: null, billShape: 'highrise_central_cooling', uploadUnits: 'auto', loadTab: 'preset' },
  battery: { kw: 200, kwh: 400, rte: 88, usable: 95, cycles: 300, throughputCost: 0, capexK: '' },
};

let state = loadState();
let data = null;            // fetched JSON
const presetCache = new Map();
let uploaded = null;        // { kw, meta, name } - not persisted
let results = null;
let running = false;

const $ = (sel) => document.querySelector(sel);
const fmt$ = (v, d = 0) => (v < 0 ? '-' : '') + '$' + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtN = (v, d = 0) => (+v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const roman = { 1: 'I', 2: 'II', 3: 'III' };
// An input problem the user can fix: shown verbatim in every edition.
const userError = (msg) => Object.assign(new Error(msg), { user: true });

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return deepMerge(structuredClone(DEFAULTS), JSON.parse(raw));
  } catch (e) { /* ignore */ }
  return structuredClone(DEFAULTS);
}
function saveState() { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ } }
function deepMerge(a, b) {
  for (const k of Object.keys(b || {})) {
    if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) && a[k] && typeof a[k] === 'object') deepMerge(a[k], b[k]);
    else a[k] = b[k];
  }
  return a;
}
function getPath(obj, path) { return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj); }
function setPath(obj, path, v) { const ks = path.split('.'); let o = obj; for (const k of ks.slice(0, -1)) { if (o[k] == null) o[k] = {}; o = o[k]; } o[ks[ks.length - 1]] = v; }

// ---------------------------------------------------------------- data
async function loadData() {
  const get = (p) => fetch(p).then((r) => { if (!r.ok) throw new Error(`${p}: ${r.status}`); return r.json(); });
  const [tariffs, statements, msc, J, H, I, programs, presets] = await Promise.all([
    get('data/tariffs_sc8.json'), get('data/statements_sc8.json'), get('data/msc_sc8.json'),
    get('data/lbmp_J.json'), get('data/lbmp_H.json'), get('data/lbmp_I.json'), get('data/programs.json'), get('data/profiles/index.json'),
  ]);
  data = { tariffs, statements, msc, lbmp: { J, H, I }, programs, presets };
}
async function loadPreset(id) {
  if (!presetCache.has(id)) {
    const r = await fetch(`data/profiles/${id}.json`);
    if (!r.ok) throw new Error(`preset ${id}: ${r.status}`);
    const doc = await r.json();
    presetCache.set(id, { ...doc, kw: Float64Array.from(doc.kw) });
  }
  return presetCache.get(id);
}

// ---------------------------------------------------------------- stack + load (memoised)
let stackCache = { key: null, value: null, error: null };
function stackConfig() {
  const s = state;
  return {
    rateNo: +s.rateNo, voltage: s.voltage, region: s.region, zone: s.zone, demandIntervalMin: +s.demandIntervalMin, taxPct: +s.taxPct || 0,
    adjustments: s.adjustments, supply: s.supply, programs: s.programs,
  };
}
function getStack() {
  const cfg = stackConfig();
  const key = JSON.stringify(cfg);
  if (stackCache.key !== key) {
    stackCache = { key, value: null, error: null };
    try { stackCache.value = buildStack(cfg, data); } catch (e) { stackCache.error = e; edition.logError(e); }
  }
  if (stackCache.error) throw stackCache.error;
  return stackCache.value;
}

let loadCache = { key: null, value: null };
async function getLoad() {
  const L = state.load;
  const stackKey = stackCache.key || JSON.stringify(stackConfig());
  let key;
  if (L.mode === 'preset') key = `preset:${L.presetId}`;
  else if (L.mode === 'bill') key = `bill:${L.billTarget}:${L.billShape}:${stackKey}`;
  else key = `upload:${uploaded ? uploaded.name + uploaded.kw.length : 'none'}`;
  if (loadCache.key === key) return loadCache.value;
  let value = null;
  if (L.mode === 'preset') {
    const p = await loadPreset(L.presetId);
    value = { kw: p.kw, label: p.name, source: 'preset', meta: p };
  } else if (L.mode === 'bill') {
    const p = await loadPreset(L.billShape);
    const stack = getStack();
    const { kw, scale } = scaleToBill(p.kw, +L.billTarget || 0, (k) => billFor(stack, k).total);
    value = { kw, label: `Estimated from ${fmt$(+L.billTarget)} / yr (${p.name} shape, x${scale.toFixed(3)})`, source: 'bill', meta: { shape: p.name, scale } };
  } else if (uploaded) {
    value = { kw: uploaded.kw, label: `Uploaded: ${uploaded.name}`, source: 'upload', meta: uploaded.meta };
  }
  loadCache = { key, value };
  return value;
}

// A preset's modelled annual bill under the current rate and supply, to the
// nearest $1,000: where the "From the annual bill" estimate starts.
const roundBill = (v) => Math.round(v / 1000) * 1000;
async function presetBill(id) {
  const p = await loadPreset(id);
  return roundBill(billFor(getStack(), p.kw).total);
}

// ---------------------------------------------------------------- rendering
function render() {
  renderStepper();
  renderPanel().catch((e) => { $('#panel').innerHTML = edition.errorHtml(e); edition.logError(e); });
  renderRail().catch((e) => edition.logError(e));
  saveState();
}

function renderStepper() {
  const el = $('#stepper');
  el.innerHTML = STEPS.map((s, i) => `<button type="button" data-step="${i}" class="${i === state.step ? 'active' : ''} ${i < state.step ? 'done' : ''}" ${i === 5 && !results ? 'disabled' : ''}><span class="n">${i + 1}</span><span class="l">${s}</span></button>`).join('');
  el.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => go(+b.dataset.step)));
}
function go(step) { state.step = Math.max(0, Math.min(5, step)); render(); window.scrollTo({ top: 0 }); }
function navButtons(opts = {}) {
  const prev = state.step > 0 ? `<button type="button" class="btn" data-nav="-1">Back</button>` : '<span></span>';
  const next = state.step < 4 ? `<button type="button" class="btn primary" data-nav="1">${opts.nextLabel || 'Next: ' + STEPS[state.step + 1]}</button>` : (opts.next || '');
  return `<div class="actions">${prev}${next}</div>`;
}

async function renderPanel() {
  const panel = $('#panel');
  const fns = [stepRate, stepSupply, stepRiders, stepLoad, stepBattery, stepResults];
  panel.innerHTML = await fns[state.step]();
  bindInputs(panel);
  panel.querySelectorAll('[data-nav]').forEach((b) => b.addEventListener('click', () => go(state.step + +b.dataset.nav)));
  const after = panel._after; if (after) { panel._after = null; after(); }
  if (state.step === 3) await afterLoadStep();
  if (state.step === 5) afterResults();
}

function bindInputs(root) {
  root.querySelectorAll('[data-path]').forEach((input) => {
    input.addEventListener('change', async () => {
      let v;
      if (input.type === 'checkbox') v = input.checked;
      else if (input.type === 'number') v = input.value === '' ? (input.dataset.nullable ? null : 0) : +input.value;
      else v = input.value;
      if (input.dataset.cast === 'int') v = parseInt(v, 10);
      setPath(state, input.dataset.path, v);
      if (input.dataset.path === 'region') state.zone = v === 'nyc' ? 'J' : (state.zone === 'J' ? 'H' : state.zone);
      // Rate II customers are on Rider M hourly pricing by default.
      if (input.dataset.path === 'rateNo' && v === 2 && state.supply.mode === 'coned_msc') state.supply.mode = 'coned_mhp';
      // A new load shape restarts the bill estimate at that preset's own bill; the user edits from there.
      if (input.dataset.path === 'load.billShape') {
        try { state.load.billTarget = await presetBill(v); } catch (e) { edition.logError(e); }
      }
      results = null;
      render();
    });
  });
}

function field(label, inner, help = '') {
  return `<div class="field"><label class="lab">${label}</label>${inner}${help ? `<span class="help">${help}</span>` : ''}</div>`;
}
function numInput(path, value, { step = 'any', min, max, unit, nullable = false, placeholder = '' } = {}) {
  const v = value === null || value === undefined ? '' : value;
  const inp = `<input type="number" id="f-${path.replace(/\./g, '-')}" data-path="${path}" ${nullable ? 'data-nullable="1"' : ''} value="${v}" step="${step}" ${min !== undefined ? `min="${min}"` : ''} ${max !== undefined ? `max="${max}"` : ''} placeholder="${placeholder}">`;
  return unit ? `<div class="unit">${inp}<span>${unit}</span></div>` : inp;
}
function select(path, value, options, cast) {
  return `<select id="f-${path.replace(/\./g, '-')}" data-path="${path}" ${cast ? `data-cast="${cast}"` : ''}>${options.map(([v, l]) => `<option value="${v}" ${String(v) === String(value) ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
}

// ---------------------------------------------------------------- step 1: rate
async function stepRate() {
  const st = data.statements, k = st.delivery_adjustments_usd_per_kwh;
  const stack = getStack();
  const t = stack.tariff;
  const kwhRows = [['NYSERDA SBC surcharge', k.sbc_total_nyserda], ['Monthly Adjustment Clause (MAC)', k.mac], ['MAC adjustment factor', k.mac_adjustment_factor], ['Revenue decoupling (RDM), SC 8', k.rdm_sc8], ['Delivery revenue surcharge (SDR)', k.sdr_sc8_rates_i_ii_iii]];
  const demandTable = stack.ta.demandCharges.map((c) => `<tr><td>${esc(c.name.replace(/_/g, ' '))}</td><td>${c.months.length === 12 ? 'all year' : c.months.map((m) => MONTH_NAMES[m - 1]).join(', ')}</td><td>${c.days}${c.hours ? `, ${c.hours[0]}:00 to ${c.hours[1]}:00` : ', all hours'}</td><td class="num">${c.rate.toFixed(2)}</td></tr>`).join('');
  return `
    <h2>Delivery rate</h2>
    <p class="lede">Con Edison P.S.C. No. 10, Service Classification 8 (Multiple Dwellings, Redistribution).${edition.rateProvenance(t)}</p>
    <fieldset><legend>SC 8 rate</legend>
      <div class="choices">
        ${[1, 2, 3].map((n) => `<label class="choice"><input type="radio" name="rateNo" data-path="rateNo" data-cast="int" value="${n}" ${state.rateNo === n ? 'checked' : ''}><b>Rate ${roman[n]}</b><small>${n === 1 ? 'Standard service: one all-hours demand charge per month, summer and other-month prices.' : n === 2 ? 'Mandatory time-of-day above 1,500 kW: weekday 8-18 and 8-22 demand windows plus an all-hours charge (low tension). Supply defaults to Rider M hourly pricing.' : 'Voluntary time-of-day for smaller customers: the Rate II windows at Rate III prices.'}</small></label>`).join('')}
      </div>
    </fieldset>
    <div class="grid2">
      ${field('Service voltage', select('voltage', state.voltage, [['lt', 'Low tension (secondary)'], ['ht', 'High tension (primary)']]))}
      ${field('Service area', select('region', state.region, [['nyc', 'New York City (NYISO zone J)'], ['westchester', 'Westchester (zone H / I)']]), 'Sets the supply capacity charge, LBMP zone and CSRP rate group.')}
      ${state.region === 'westchester' ? field('NYISO zone', select('zone', state.zone, [['H', 'H (Millwood)'], ['I', 'I (Dunwoodie)']])) : ''}
      ${field('Billing demand interval', select('demandIntervalMin', state.demandIntervalMin, [['15', '15-minute demand (Con Edison default)'], ['30', '30-minute integrated demand']], 'int'), 'The determinant the demand charges bill on.')}
      ${field('Taxes and surcharges on the bill', numInput('taxPct', state.taxPct, { step: 0.1, min: 0, max: 20, unit: '%' }), 'Applied to delivery and supply. Residential redistribution is sales-tax exempt; GRT-type surcharges are a few percent. Illustrative default.')}
    </div>
    <details><summary>Delivery adjustments and surcharges (advanced)</summary>
      <p class="note">Per-kWh statements in force on ${esc(st.in_force_on)}; the demand-based SBC surcharge rides the same determinant as the delivery demand charge. ${edition.UNLISTED_STATEMENTS}</p>
      <div class="tablewrap"><table><thead><tr><th>Statement</th><th>Effective</th><th class="num">$/kWh</th></tr></thead><tbody>
        ${kwhRows.map(([n, r]) => `<tr><td>${n}</td><td>${esc(r.statement.effective || '')}</td><td class="num">${(+r.value).toFixed(6)}</td></tr>`).join('')}
        <tr class="total"><td>Sum (default below)</td><td></td><td class="num">${stack.kwhAdjDefault.toFixed(6)}</td></tr>
      </tbody></table></div>
      <div class="grid2">
        ${field('Delivery $/kWh adjustments (override)', numInput('adjustments.kwh', state.adjustments.kwh, { step: 0.0001, unit: '$/kWh', nullable: true, placeholder: stack.kwhAdjDefault.toFixed(6) }), 'Leave blank to use the sum above.')}
        ${field('Other $/kW-month on the monthly maximum', numInput('adjustments.extraDemand', state.adjustments.extraDemand, { step: 0.01, unit: '$/kW-mo' }), 'Anything else billed on the monthly peak.')}
      </div>
      <label class="check"><input type="checkbox" data-path="adjustments.sbcDemand" ${state.adjustments.sbcDemand !== false ? 'checked' : ''}><span>Include the SBC demand surcharge <span class="d">${state.rateNo === 1 ? `${st.delivery_adjustments_usd_per_kw_month.sbc_sc8_rate_i_monthly_max.value} $/kW-month on the monthly maximum (Rate I)` : `${st.delivery_adjustments_usd_per_kw_month.sbc_sc8_rates_ii_iii_tod.value} $/kW-month on the weekday 8-22 demand (Rates II and III)`}</span></span></label>
    </details>
    <h3>Rate card: ${esc(t.name)}</h3>
    <p class="note">${esc(t.applicability || '').slice(0, 420)}${(t.applicability || '').length > 420 ? '...' : ''}</p>
    <div class="tablewrap"><table>
      <thead><tr><th>Charge</th><th>Months</th><th>Window</th><th class="num">Rate</th></tr></thead>
      <tbody>
        <tr><td>Customer charge</td><td>all year</td><td></td><td class="num">${(+t.fixed_charge_per_month).toFixed(2)} $/mo</td></tr>
        <tr><td>Delivery energy</td><td>all year</td><td>all hours</td><td class="num">${(+t.energy.seasons[0].tou[0].rate).toFixed(4)} $/kWh</td></tr>
        ${demandTable.replace(/class="num">([\d.]+)</g, 'class="num">$1 $/kW-mo<')}
      </tbody>
    </table></div>
    <p class="note">Not modelled: reactive power charges (General Rule 10.11), Rate IV / Rate V standby service, minimum charges.</p>
    ${navButtons()}`;
}

// ---------------------------------------------------------------- step 2: supply
async function stepSupply() {
  const stack = getStack();
  const sup = stack.supply, S = state.supply, st = data.statements;
  const cap = st.msc_capacity_usd_per_kw_month[state.region];
  const adjRow = st.msc_adjustment_factors_usd_per_kwh;
  const monthlyAvg = (() => { const idx = stack.idx; const s = new Array(12).fill(0), n = new Array(12).fill(0); for (let t = 0; t < idx.T; t++) { s[idx.month[t] - 1] += sup.energyRate[t]; n[idx.month[t] - 1]++; } return s.map((v, i) => v / n[i]); })();
  const fields = {
    coned_msc: `<div class="grid2">
        ${field('MSC capacity charge', numInput('supply.capacityRate', S.capacityRate, { step: 0.01, unit: '$/kW-mo', nullable: true, placeholder: cap[`rate${state.rateNo}`] }), `Statement value for Rate ${roman[state.rateNo]}, ${state.region === 'nyc' ? 'NYC' : 'Westchester'}: ${cap[`rate${state.rateNo}`]} $/kW-month (one monthly statement; summer months run higher). Blank = statement value.`)}
        ${field('Merchant function charge', numInput('supply.mfc', S.mfc, { step: 0.000001, unit: '$/kWh', nullable: true, placeholder: st.merchant_function_charge_usd_per_kwh.scs5_6_8_9_12_13_total }), 'SCs 5, 6, 8, 9, 12, 13 total MFC.')}
        ${field('MSC adjustment factors', numInput('supply.reconciliation', S.reconciliation, { step: 0.000001, unit: '$/kWh', nullable: true, placeholder: adjRow.reconciliation_all_other_nonresidential[state.region] }), `Month-specific reconciliation; the current statement prints ${adjRow.reconciliation_all_other_nonresidential[state.region]} $/kWh for non-residential "all other" in ${state.region === 'nyc' ? 'NYC' : 'Westchester'}. Blank = statement value.`)}
      </div>`,
    coned_mhp: `<div class="grid2">
        ${field('Rider M capacity (ICAP tag)', numInput('supply.capacityRate', S.capacityRate, { step: 0.01, unit: '$/kW-mo', nullable: true, placeholder: cap.rider_m_icap_tag }), `Statement value ${cap.rider_m_icap_tag} $/kW-month, applied to each month's maximum demand (simplification of the tag).`)}
        ${field('Merchant function charge', numInput('supply.mfc', S.mfc, { step: 0.000001, unit: '$/kWh', nullable: true, placeholder: st.merchant_function_charge_usd_per_kwh.scs5_6_8_9_12_13_total }))}
        ${field('MSC adjustment factors', numInput('supply.reconciliation', S.reconciliation, { step: 0.000001, unit: '$/kWh', nullable: true, placeholder: adjRow.reconciliation_rider_m_nonresidential[state.region] }), `Rider M non-residential statement value: ${adjRow.reconciliation_rider_m_nonresidential[state.region]} $/kWh. Blank = statement value.`)}
      </div>`,
    esco_fixed: `<div class="grid2">
        ${field('Fixed supply price', numInput('supply.fixedRate', S.fixedRate, { step: 0.0001, unit: '$/kWh' }), 'All-in energy price from the ESCO contract.')}
        ${field('Separate capacity charge', numInput('supply.escoCapacity', S.escoCapacity, { step: 0.01, unit: '$/kW-mo' }), 'Leave 0 if capacity is bundled in the $/kWh.')}
      </div>`,
    esco_lbmp: `<div class="grid2">
        ${field('Adder over day-ahead LBMP', numInput('supply.adder', S.adder, { step: 0.0001, unit: '$/kWh' }), 'ESCO margin, ancillaries and losses.')}
        ${field('Separate capacity charge', numInput('supply.escoCapacity', S.escoCapacity, { step: 0.01, unit: '$/kW-mo' }))}
      </div>`,
  };
  const panelHtml = `
    <h2>Energy supply</h2>
    <p class="lede">SC 8 delivery is billed separately from the commodity. Pick who supplies the energy; the battery's value depends on the $/kWh shape and on any capacity charge billed on the monthly peak.</p>
    <fieldset><legend>Supplier</legend>
      <div class="choices">
        ${Object.entries(SUPPLY_MODES).map(([m, l]) => `<label class="choice"><input type="radio" name="supplyMode" data-path="supply.mode" value="${m}" ${S.mode === m ? 'checked' : ''}><b>${l}</b><small>${{
    coned_msc: edition.MSC_BLURB,
    coned_mhp: 'Mandatory hourly pricing: NYISO zone day-ahead LBMP by hour plus the Rider M capacity tag.',
    esco_fixed: 'A flat contract price; the battery then earns only on delivery demand charges (and any separate capacity charge).',
    esco_lbmp: 'Index contract: hourly LBMP plus a fixed adder.',
  }[m]}</small></label>`).join('')}
      </div>
    </fieldset>
    ${fields[S.mode]}
    <div class="card soft" style="margin-top:1rem">
      <b>Supply as modelled</b>
      <p class="note">${esc(sup.description)}</p>
      <div class="kpis">
        <div class="kpi"><div class="k">Average energy</div><div class="v">${(sup.avgEnergyRate * 100).toFixed(2)}&cent;</div><div class="s">per kWh, load-unweighted</div></div>
        <div class="kpi"><div class="k">Capacity</div><div class="v">${fmt$(sup.capacityRate, 2)}</div><div class="s">per kW-month on the monthly max</div></div>
        ${sup.lbmpAvg ? `<div class="kpi"><div class="k">Zone ${sup.zone} LBMP</div><div class="v">${(sup.lbmpAvg * 100).toFixed(2)}&cent;</div><div class="s">average, ${esc(data.lbmp[sup.zone].source_span.map((s) => s.slice(0, 7)).join(' to '))}</div></div>` : ''}
      </div>
      ${sup.warnings.map((w) => `<p class="flag">${esc(w)}</p>`).join('')}
      <div id="supplyChart"></div>
    </div>
    ${navButtons()}`;
  $('#panel')._after = () => barChart($('#supplyChart'), { labels: MONTH_NAMES, series: [{ name: 'Supply energy, monthly average', values: monthlyAvg.map((v) => v * 100), color: 'var(--s1)' }], yFormat: (v) => v.toFixed(1) + '¢', height: 170, yLabel: 'supply ¢/kWh by month' });
  return panelHtml;
}

// ---------------------------------------------------------------- step 3: riders
async function stepRiders() {
  const stack = getStack();
  const P = state.programs, pg = data.programs;
  const nets = Object.entries(pg.networks).sort((a, b) => a[0].localeCompare(b[0]));
  const anyOn = PROGRAM_IDS.some((id) => P.enabled[id]);
  const preview = stack.programs;
  const net = preview.network;
  const termsHtml = preview.programs.map((p) => `
    <tr><td>${esc(p.label)}</td><td class="num">${p.events.length}</td><td class="num">${p.terms.reservationRate ? p.terms.reservationRate.toFixed(2) : '0.00'}</td><td class="num">${p.terms.performanceRate.toFixed(2)}</td><td>${p.terms.group ? esc(p.terms.group.replace(/_/g, ' ')) + ', ' + p.terms.threshold + ' events' : 'program agreement'}</td><td>${p.events.map((e) => e.day).join(', ') || '-'}${p.events.length ? ` (${p.events[0].hours[0]}:00 to ${p.events[0].hours[1]}:00)` : ''}</td></tr>`).join('');
  return `
    <h2>Riders and demand-response programs</h2>
    <p class="lede">A non-exporting battery can pledge load relief into Con Edison's Rider T programs (rates in the tariff) and Rider AC Term-DLM (pay-as-bid). Supply riders live on the previous step (Rider M); Rider R and standby rates do not apply to a non-exporting system and are not modelled.</p>
    <fieldset><legend>Enrol</legend>
      ${PROGRAM_IDS.map((id) => { const pr = pg.programs[id]; return `<label class="check"><input type="checkbox" data-path="programs.enabled.${id}" ${P.enabled[id] ? 'checked' : ''}><span><b>${PROGRAM_LABELS[id]}</b><span class="d">${pr.season.start} to ${pr.season.end}, ${pr.days === 'weekdays' ? 'non-holiday weekdays' : 'any day'}, ${pr.events[Object.keys(pr.events).find((k) => pr.events[k].counts_toward_rate_step) || Object.keys(pr.events)[0]].obligation_hours || 4}-hour events from the network's Contracted Hours; minimum ${pr.min_kw} kW per direct participant.${id === 'csrp' ? ' Reservation $/kW-month by county group, stepping up from the fifth counted event; $1/kWh performance.' : id === 'dlrp' ? ' Reservation by DLRP tier, stepping up at five contingency events; $1/kWh performance.' : ' Rates come from the Program Agreement: enter them below.'}</span></span></label>`; }).join('')}
    </fieldset>
    ${anyOn ? `
    <div class="grid2">
      ${field('Distribution network', select('programs.network', P.network, [['', 'Select the site network'], ...nets.map(([n, r]) => [n, `${n} (${r.county_group === 'westchester_staten_island' ? 'Westchester / SI' : 'NYC'}, ${r.dlrp_tier.replace('_', ' ')}, ${r.contracted_hours[0]}:00 to ${r.contracted_hours[1]}:00)`])]), 'Contracted Hours, DLRP tier and CSRP county group key on it (2026 call-window edition).')}
      ${field('Pledged load relief', numInput('programs.pledgeKw', P.pledgeKw, { step: 1, min: 0, unit: 'kW' }), 'Entered, never optimised. Paid in proportion to what the dispatch delivers.')}
      ${field('Participation', select('programs.participation', P.participation, [['direct', 'Direct participant'], ['aggregated', 'Through an aggregator']]), 'Aggregated lets a pledge below 50 kW count toward the aggregation minimum.')}
      ${P.enabled.csrp ? field('CSRP planned events per season', numInput('programs.events.csrp', P.events.csrp, { step: 1, min: 0, max: 30 }), 'Scenario input (not in the tariff). Five or more moves the reservation to the higher step.') : ''}
      ${P.enabled.dlrp ? field('DLRP contingency events per season', numInput('programs.events.dlrp', P.events.dlrp, { step: 1, min: 0, max: 30 })) : ''}
      ${P.enabled.term_dlm ? field('Term-DLM events per season', numInput('programs.events.term_dlm', P.events.term_dlm, { step: 1, min: 0, max: 30 })) : ''}
      ${P.enabled.term_dlm ? field('Term-DLM reservation rate', numInput('programs.termDlm.reservationRate', P.termDlm.reservationRate, { step: 0.01, unit: '$/kW-mo' }), 'From the Program Agreement.') : ''}
      ${P.enabled.term_dlm ? field('Term-DLM performance rate', numInput('programs.termDlm.performanceRate', P.termDlm.performanceRate, { step: 0.01, unit: '$/kWh' })) : ''}
    </div>
    ${preview.blocked.map((b) => `<p class="flag">${esc(b)}</p>`).join('')}
    ${preview.programs.length ? `
      <h3>Terms for ${esc(net.name)}</h3>
      <div class="tablewrap"><table><thead><tr><th>Program</th><th class="num">Events</th><th class="num">Reservation $/kW-mo</th><th class="num">Performance $/kWh</th><th>Rate key</th><th>Event days (model year)</th></tr></thead><tbody>${termsHtml}</tbody></table></div>
      <p class="note">Reservation is paid over the five Capability Period months on the delivered share of the pledge (the worst event sets it). ${preview.notes.map(esc).join(' ')}</p>` : ''}
    ` : '<p class="note">No program enrolled: the battery earns on the bill alone.</p>'}
    ${navButtons()}`;
}

// ---------------------------------------------------------------- step 4: load
async function stepLoad() {
  const L = state.load;
  const tab = L.loadTab || L.mode;
  if (tab === 'bill' && L.billTarget == null) L.billTarget = await presetBill(L.billShape);
  const presetCards = data.presets.map((p) => `<label class="choice"><input type="radio" name="presetId" data-path="load.presetId" value="${p.id}" ${L.presetId === p.id ? 'checked' : ''}><b>${esc(p.name)}</b><small>${esc(p.description)}</small></label>`).join('');
  return `
    <h2>Load profile</h2>
    <p class="lede">A full year at 15 minutes (35,040 intervals) on the model-year calendar. Use a preset, estimate one from the annual bill under the rate and supply you picked, or upload interval data.</p>
    <div class="tabs">
      ${[['preset', 'Preset profiles'], ['bill', 'From the annual bill'], ['upload', 'Upload interval data']].map(([k, l]) => `<button type="button" data-tab="${k}" class="${tab === k ? 'active' : ''}">${l}</button>`).join('')}
    </div>
    <div class="tabpane">
      ${tab === 'preset' ? `<div class="choices">${presetCards}</div><p class="note">${edition.PRESET_NOTE}</p>` : ''}
      ${tab === 'bill' ? `<div class="grid2">
          ${field('Annual electricity bill', numInput('load.billTarget', L.billTarget, { step: 1000, min: 0, unit: '$ / year' }), 'Total of twelve bills, delivery plus supply, taxes included. Starts at the modelled bill for the selected load shape: replace it with the actual figure.')}
          ${field('Building\'s load shape', select('load.billShape', L.billShape, data.presets.map((p) => [p.id, p.name])), 'The preset whose shape is scaled until the modelled bill matches.')}
        </div>
        <p class="note">The scale is solved by bisection on the modelled bill under the current rate, adjustments, supply and tax settings, so changing those re-estimates the profile.</p>` : ''}
      ${tab === 'upload' ? `<div class="grid2">
          <div class="field"><label class="lab" for="f-upload">Interval file (CSV)</label><input type="file" id="f-upload" accept=".csv,.txt,text/csv"><span class="help">A timestamp column (ISO or M/D/YYYY H:MM) or separate date and time columns, plus a kW or kWh column. Any year; 5 to 60-minute intervals; Feb 29 dropped; gaps interpolated.</span></div>
          ${field('Units', select('load.uploadUnits', L.uploadUnits, [['auto', 'Detect from the header'], ['kw', 'kW (average demand)'], ['kwh', 'kWh per interval']]))}
        </div>
        ${uploaded ? `<p class="ok">Parsed ${esc(uploaded.name)}: ${fmtN(uploaded.meta.rows)} rows, ${uploaded.meta.sourceIntervalMin}-minute ${uploaded.meta.units} from ${esc(uploaded.meta.timestampColumn)} / ${esc(uploaded.meta.valueColumn)}, years ${uploaded.meta.years.join(', ')}, ${(uploaded.meta.coverage * 100).toFixed(1)}% of the year covered${uploaded.meta.badRows ? `, ${uploaded.meta.badRows} rows skipped` : ''}.</p>` : '<p class="note">No file loaded yet (uploads are kept in memory only).</p>'}
        <p id="uploadError" class="bad"></p>` : ''}
    </div>
    <div id="loadSummary"><p class="note">Loading profile...</p></div>
    ${navButtons()}`;
}

async function afterLoadStep() {
  const panel = $('#panel');
  panel.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', async () => {
    const tab = b.dataset.tab;
    if (tab === 'bill' && (state.load.loadTab || state.load.mode) !== 'bill') {
      // Start the estimate from what was just on screen: the selected preset's
      // shape and the baseline bill shown for the current profile.
      try {
        const shown = await getLoad();
        if (state.load.mode === 'preset') state.load.billShape = state.load.presetId;
        state.load.billTarget = shown ? roundBill(billFor(getStack(), shown.kw).total) : await presetBill(state.load.billShape);
      } catch (e) { edition.logError(e); }
    }
    state.load.loadTab = tab;
    if (tab !== 'upload' || uploaded) state.load.mode = tab;
    results = null; render();
  }));
  const fileInput = $('#f-upload');
  if (fileInput) fileInput.addEventListener('change', async () => {
    const f = fileInput.files[0]; if (!f) return;
    try {
      const text = await f.text();
      const parsed = parseIntervalCsv(text, { units: state.load.uploadUnits === 'auto' ? undefined : state.load.uploadUnits });
      uploaded = { ...parsed, name: f.name };
      state.load.mode = 'upload'; state.load.loadTab = 'upload';
      results = null; render();
    } catch (e) { $('#uploadError').textContent = e.message; }
  });
  const box = $('#loadSummary');
  try {
    const load = await getLoad();
    if (!load) { box.innerHTML = '<p class="note">Choose or upload a profile to continue.</p>'; return; }
    const stack = getStack();
    const s = stats(load.kw);
    const bill = billFor(stack, load.kw);
    const idx = stack.idx;
    const mKwh = monthlyEnergyKwh(load.kw, idx, DT_HOURS), mPk = monthlyPeakKw(load.kw, idx, stack.demandIntervalMin);
    box.innerHTML = `
      <h3>${esc(load.label)}</h3>
      <div class="kpis">
        <div class="kpi"><div class="k">Annual energy</div><div class="v">${fmtN(s.annualKwh / 1000, 0)}</div><div class="s">MWh</div></div>
        <div class="kpi"><div class="k">Peak demand</div><div class="v">${fmtN(s.peakKw, 0)}</div><div class="s">kW, ${stack.demandIntervalMin}-min</div></div>
        <div class="kpi"><div class="k">Load factor</div><div class="v">${(s.loadFactor * 100).toFixed(0)}%</div><div class="s">annual</div></div>
        <div class="kpi"><div class="k">Baseline bill</div><div class="v">${fmt$(bill.total)}</div><div class="s">per year, ${(bill.total / s.annualKwh * 100).toFixed(1)}¢/kWh all-in</div></div>
      </div>
      <div class="grid2">
        <div><div id="chartMonthlyKwh"></div></div>
        <div><div id="chartMonthlyPeak"></div></div>
      </div>
      ${state.rateNo !== 2 && s.peakKw > 1500 ? '<p class="flag">Peak above 1,500 kW: Con Edison bills such customers under Rate II (mandatory time-of-day).</p>' : ''}
      ${state.rateNo === 2 && s.peakKw < 900 ? '<p class="flag">Peak below 900 kW for a year moves a Rate II customer back to Rate I.</p>' : ''}
      <div class="inline" style="margin-top:0.6rem"><button type="button" class="btn small" id="dlProfile">Download profile as CSV</button><span class="note">timestamp,kw on the 2027 model calendar</span></div>`;
    barChart($('#chartMonthlyKwh'), { labels: MONTH_NAMES, series: [{ name: 'Energy, MWh', values: mKwh.map((v) => v / 1000), color: 'var(--s1)' }], yFormat: (v) => v.toFixed(0), height: 180, yLabel: 'monthly energy MWh' });
    barChart($('#chartMonthlyPeak'), { labels: MONTH_NAMES, series: [{ name: 'Peak, kW', values: mPk, color: 'var(--s2)' }], yFormat: (v) => v.toFixed(0), height: 180, yLabel: 'monthly peak kW' });
    $('#dlProfile').addEventListener('click', () => download(`load_profile_${load.source}.csv`, toCsv(load.kw, idx, labelOf), 'text/csv'));
  } catch (e) { box.innerHTML = edition.errorHtml(e); edition.logError(e); }
  renderRail();
}

// ---------------------------------------------------------------- step 5: battery
async function stepBattery() {
  const B = state.battery;
  const dur = B.kw > 0 ? (B.kwh / B.kw) : 0;
  return `
    <h2>Battery system</h2>
    <p class="lede">A behind-the-meter, non-exporting system dispatched with perfect foresight against the whole year: demand windows, supply prices, the annual cycle budget and any enrolled program events are co-optimised in one linear program (HiGHS, in your browser).</p>
    <div class="grid3">
      ${field('Power', numInput('battery.kw', B.kw, { step: 1, min: 0, unit: 'kW' }), 'Inverter rating, charge and discharge.')}
      ${field('Energy', numInput('battery.kwh', B.kwh, { step: 1, min: 0, unit: 'kWh' }), `Nameplate. ${dur ? dur.toFixed(1) + ' h duration.' : ''}`)}
      ${field('Round-trip efficiency', numInput('battery.rte', B.rte, { step: 0.5, min: 50, max: 100, unit: '%' }), 'AC to AC; split evenly between charge and discharge.')}
      ${field('Usable depth of discharge', numInput('battery.usable', B.usable, { step: 1, min: 10, max: 100, unit: '%' }), 'Share of nameplate the controller may use.')}
      ${field('Annual cycle limit', numInput('battery.cycles', B.cycles, { step: 1, min: 0, unit: 'cycles / yr' }), 'Equivalent full cycles of discharged energy per year (warranty cap). 0 = unlimited.')}
      ${field('Throughput cost', numInput('battery.throughputCost', B.throughputCost, { step: 0.001, min: 0, unit: '$/kWh' }), 'Optional degradation charge per kWh discharged; stops cycling for pennies.')}
      ${field('Installed cost (optional)', numInput('battery.capexK', B.capexK, { step: 1, min: 0, unit: 'k$', nullable: true }), 'Thousands of dollars. Only used for a simple payback figure.')}
    </div>
    ${pledgeFlags()}
    <div id="runBox"></div>
    <div class="actions"><button type="button" class="btn" data-nav="-1">Back</button><button type="button" class="btn primary" id="runBtn" ${running ? 'disabled' : ''}>Run simulation</button></div>`;
}

// Warn when the battery cannot carry one full program event at the pledge.
function pledgeFlags() {
  let progs;
  try { progs = getStack().programs.programs.filter((p) => p.events.length); } catch (e) { return ''; }
  if (!progs.length) return '';
  const b = batterySpec(), pledge = progs[0].pledgeKw;
  const hours = Math.max(...progs.map((p) => p.events[0].hours[1] - p.events[0].hours[0]));
  const names = progs.map((p) => p.id.toUpperCase().replace('_', '-')).join(' / ');
  const { needKwh, usableKwh, etaD } = eventEnergyCheck(b, pledge, hours);
  const flags = [];
  if (usableKwh < needKwh) flags.push(`Too small for the ${fmtN(pledge)} kW pledge on the Riders step: one ${hours}-hour ${names} event needs about ${fmtN(needKwh)} kWh of usable storage (${(etaD * 100).toFixed(0)}% discharge efficiency), and this battery has ${fmtN(usableKwh)} kWh usable (${fmtN(b.kwh)} kWh x ${(b.usableFrac * 100).toFixed(0)}%). Add energy or lower the pledge.`);
  if (b.kw < pledge) flags.push(`The ${fmtN(b.kw)} kW power rating is below the ${fmtN(pledge)} kW pledge, so no event can be met in full.`);
  return flags.map((f) => `<p class="flag">${f}</p>`).join('');
}

function batterySpec() {
  const B = state.battery;
  return { kw: +B.kw || 0, kwh: +B.kwh || 0, rte: Math.min(1, Math.max(0.05, (+B.rte || 88) / 100)), usableFrac: Math.min(1, Math.max(0.05, (+B.usable || 95) / 100)), cyclesPerYear: +B.cycles || 0, throughputCost: +B.throughputCost || 0 };
}

async function run() {
  if (running) return;
  const box = $('#runBox');
  const btn = $('#runBtn');
  try {
    running = true; if (btn) btn.disabled = true;
    const stack = getStack();
    const load = await getLoad();
    if (!load) throw userError('No load profile selected.');
    const battery = batterySpec();
    if (battery.kw <= 0 || battery.kwh <= 0) throw userError('Enter a battery power and energy above zero.');
    const withPrograms = stack.programs.programs.some((p) => p.events.length);
    const show = (msg) => { box.innerHTML = `<div class="progress">${msg}<div class="bar"><i></i></div></div>`; };
    show(edition.SOLVING);
    const t0 = performance.now();
    const inp = lpInputs(stack, load.kw, battery, withPrograms);
    const sol = await solveDispatch(inp);
    let solBillOnly = null, billOnlyInputs = null, billOnlySol = null;
    if (withPrograms) {
      show('Solving the bill-only dispatch for comparison.');
      billOnlyInputs = lpInputs(stack, load.kw, battery, false);
      billOnlySol = await solveDispatch(billOnlyInputs);
      solBillOnly = billFor(stack, billOnlySol.imp);
    }
    const baseline = billFor(stack, load.kw);
    const withB = billFor(stack, sol.imp);
    const revenue = programRevenue(stack, inp, sol);
    const summary = summarize(stack, load.kw, battery, baseline, withB, solBillOnly, inp, sol, revenue);
    results = { stack, load, battery, inp, sol, baseline, withB, revenue, summary, solBillOnly, billOnlySol, elapsedMs: performance.now() - t0, timing: sol.timing };
    running = false;
    go(5);
  } catch (e) {
    running = false; if (btn) btn.disabled = false;
    box.innerHTML = edition.runFailedHtml(e);
    edition.logError(e);
  }
}

// ---------------------------------------------------------------- step 6: results
async function stepResults() {
  if (!results) return `<h2>Results</h2><p class="note">Run a simulation first.</p>${navButtons()}`;
  const R = results, S = R.summary, B = R.baseline, W = R.withB;
  const pct = B.total > 0 ? (S.savingsTotal / B.total * 100) : 0;
  const capex = (+state.battery.capexK || 0) * 1000;
  const rows = [];
  const comp = (name, b, w) => rows.push(`<tr><td>${name}</td><td class="num">${fmt$(b)}</td><td class="num">${fmt$(w)}</td><td class="num ${b - w >= 0 ? 'ok' : 'bad'}">${fmt$(b - w)}</td></tr>`);
  for (const name of Object.keys(B.energyComponents)) comp(name, B.energyComponents[name], W.energyComponents[name]);
  const groups = { delivery_demand: 'Delivery demand charges', delivery_adjustment_demand: 'SBC demand surcharge', supply_capacity: 'Supply capacity charge' };
  for (const [g, label] of Object.entries(groups)) if (B.demandByGroup[g] !== undefined || W.demandByGroup[g] !== undefined) comp(label, B.demandByGroup[g] || 0, W.demandByGroup[g] || 0);
  comp('Customer charge', B.fixed, W.fixed);
  comp(`Taxes and surcharges (${state.taxPct}%)`, B.tax, W.tax);
  rows.push(`<tr class="total"><td>Annual bill</td><td class="num">${fmt$(B.total)}</td><td class="num">${fmt$(W.total)}</td><td class="num ok">${fmt$(S.savingsBill)}</td></tr>`);
  for (const s of R.revenue.streams) {
    rows.push(`<tr><td>${esc(s.label)}: reservation (${s.terms.months} months x ${s.terms.reservationRate.toFixed(2)} $/kW x ${fmtN(s.deliveredKw, 1)} kW delivered of ${fmtN(s.pledgeKw)} pledged)</td><td class="num">-</td><td class="num">${fmt$(-s.reservation)}</td><td class="num ok">${fmt$(s.reservation)}</td></tr>`);
    rows.push(`<tr><td>${esc(s.label)}: performance (${fmtN(s.reliefKwh)} kWh relief over ${s.events} events, ${s.eventDays.join(', ')})</td><td class="num">-</td><td class="num">${fmt$(-s.performance)}</td><td class="num ok">${fmt$(s.performance)}</td></tr>`);
  }
  if (R.revenue.streams.length) rows.push(`<tr class="total"><td>Net annual cost</td><td class="num">${fmt$(B.total)}</td><td class="num">${fmt$(W.total - R.revenue.total)}</td><td class="num ok">${fmt$(S.savingsTotal)}</td></tr>`);
  const monthRows = S.monthly.map((m) => `<tr><td>${m.month}</td><td class="num">${fmtN(m.peakBefore)}</td><td class="num">${fmtN(m.peakAfter)}</td><td class="num">${fmtN(m.peakBefore - m.peakAfter)}</td><td class="num">${fmt$(m.demandBefore - m.demandAfter)}</td><td class="num">${fmtN(m.kwhAfter - m.kwhBefore)}</td></tr>`).join('');
  const weak = R.revenue.streams.filter((s) => (s.id === 'csrp' || s.id === 'dlrp') && s.factor < MIN_PERFORMANCE).map((s) => {
    const worst = s.eventKw.indexOf(Math.min(...s.eventKw));
    const avg = s.eventKw.reduce((a, b) => a + b, 0) / s.eventKw.length / s.pledgeKw;
    return `<p class="flag">${esc(s.label)}: the battery delivers ${(s.factor * 100).toFixed(0)}% of the ${fmtN(s.pledgeKw)} kW pledge on its weakest event (${s.eventDays[worst]}) and ${(avg * 100).toFixed(0)}% on average over ${s.events} events, below ${MIN_PERFORMANCE * 100}% performance for the year. Add battery energy or power, or lower the pledge.</p>`;
  });
  const weeks = weekOptions(R.load.kw);
  const sup = R.stack.supply;
  const assumptions = [
    `Rate ${roman[state.rateNo]}, ${state.voltage.toUpperCase()}, ${state.region === 'nyc' ? 'New York City' : 'Westchester'} (zone ${R.stack.supply.zone})${edition.rateProvenanceClause(R.stack.tariff)}; ${R.stack.demandIntervalMin}-minute billing demand.`,
    `Delivery $/kWh adjustments ${R.stack.kwhAdj.toFixed(6)} $/kWh; statements in force on ${esc(data.statements.in_force_on)}.`,
    esc(sup.description) + '.',
    ...sup.warnings.map(esc),
    `Non-exporting battery: imports never go negative, no Rider R / Value Stack, no standby (Rate IV / V) rates.`,
    `Perfect-foresight dispatch over the model year (2027 calendar, DST ignored); cyclic state of charge; LP relaxation with a post-solve netting of simultaneous charge and discharge.`,
    `Cycle budget: ${fmtN(S.throughputKwh)} kWh discharged = ${S.cycles.toFixed(0)} equivalent full cycles${S.cycleLimit ? ` of the ${S.cycleLimit} allowed` : ' (no cap)'}.` + cycleNote(R),
    ...(R.stack.programs.notes || []).map(esc),
    `One year, no escalation, no degradation, no capacity augmentation.`,
  ];
  const html = `
    <h2>Results</h2>
    <p class="lede">${esc(R.load.label)}; ${fmtN(R.battery.kw)} kW / ${fmtN(R.battery.kwh)} kWh, ${(R.battery.rte * 100).toFixed(0)}% round trip.${edition.solvedIn(R.elapsedMs)}</p>
    <div class="hero">
      <div><div class="k">Annual savings</div><div class="v">${fmt$(S.savingsTotal)}</div><div class="s">${pct.toFixed(1)}% of the ${fmt$(B.total)} baseline</div></div>
      <div><div class="k">Bill savings</div><div class="v">${fmt$(S.savingsBill)}</div><div class="s">${R.revenue.total ? `plus ${fmt$(R.revenue.total)} program revenue` : 'no program revenue'}</div></div>
      <div><div class="k">Annual peak</div><div class="v">${fmtN(S.peakBefore)} &rarr; ${fmtN(S.peakAfter)}</div><div class="s">kW, ${R.stack.demandIntervalMin}-minute</div></div>
      ${capex ? `<div><div class="k">Simple payback</div><div class="v">${S.savingsTotal > 0 ? (capex / S.savingsTotal).toFixed(1) + ' yr' : '-'}</div><div class="s">on ${fmt$(capex / 1000)}k installed</div></div>` : ''}
    </div>
    ${weak.join('')}
    ${S.billOnlySavings !== null ? `<p class="note">Dispatching for the bill alone would save ${fmt$(S.billOnlySavings)}; holding capacity for program events ${S.billOnlySavings > S.savingsBill ? `costs ${fmt$(S.billOnlySavings - S.savingsBill)} of bill savings` : 'costs nothing on the bill'} and earns ${fmt$(R.revenue.total)}.</p>` : ''}
    <h3>Annual bill, baseline vs with battery</h3>
    <div class="tablewrap"><table><thead><tr><th>Component</th><th class="num">Baseline</th><th class="num">With battery</th><th class="num">Savings</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>
    <h3>Monthly peaks</h3>
    <div id="chartPeaks"></div>
    <div class="tablewrap"><table><thead><tr><th>Month</th><th class="num">Peak before kW</th><th class="num">Peak after kW</th><th class="num">Reduction kW</th><th class="num">Demand $ saved</th><th class="num">Extra kWh (losses)</th></tr></thead><tbody>${monthRows}</tbody></table></div>
    <h3>Dispatch</h3>
    <div class="inline"><label class="lab" for="weekSel" style="margin:0">Week</label><select id="weekSel">${weeks.map((w) => `<option value="${w.start}" ${w.selected ? 'selected' : ''}>${w.label}</option>`).join('')}</select></div>
    <div id="chartWeek"></div>
    <div id="chartSoc"></div>
    <h3>Assumptions and provenance</h3>
    <ul class="tight">${assumptions.map((a) => `<li>${a}</li>`).join('')}</ul>
    <div class="inline" style="margin-top:1rem"><button type="button" class="btn small" id="dlJson">Download results (JSON)</button><button type="button" class="btn small" id="dlDispatch">Download dispatch (CSV)</button></div>
    <div class="actions"><button type="button" class="btn" data-nav="-1">Back to battery</button><button type="button" class="btn" id="rerun">Change inputs and re-run</button></div>`;
  return html;
}

function cycleNote(R) {
  const c = R.sol.cycleInfo;
  if (!c || !R.battery.cyclesPerYear) return '';
  if (!c.binding) return ' The cap does not bind.';
  const perCycle = c.marginalUsdPerKwh != null ? c.marginalUsdPerKwh * R.battery.kwh : null;
  return ` The cap binds: unconstrained, the dispatch would run ${(c.uncappedThroughputKwh / R.battery.kwh).toFixed(0)} cycles${perCycle != null ? `; one more cycle of budget is worth about ${fmt$(perCycle)} a year at the margin` : ''}.`;
}

function weekOptions(load) {
  const idx = buildIndex();
  let peakT = 0; for (let t = 0; t < idx.T; t++) if (load[t] > load[peakT]) peakT = t;
  const out = [];
  for (let start = 0; start + 7 * 96 <= idx.T; start += 7 * 96) {
    const end = start + 7 * 96 - 1;
    out.push({ start, label: `${MONTH_NAMES[idx.month[start] - 1]} ${idx.day[start]} to ${MONTH_NAMES[idx.month[end] - 1]} ${idx.day[end]}`, selected: peakT >= start && peakT <= end });
  }
  if (!out.some((w) => w.selected)) out[out.length - 1].selected = true;
  return out;
}

function afterResults() {
  if (!results) return;
  const R = results, S = R.summary;
  barChart($('#chartPeaks'), { labels: MONTH_NAMES, series: [{ name: 'Before', values: S.monthly.map((m) => m.peakBefore), color: 'var(--s1)' }, { name: 'With battery', values: S.monthly.map((m) => m.peakAfter), color: 'var(--s2)' }], yFormat: (v) => fmtN(v) + ' kW', height: 220, yLabel: 'monthly billing peak kW' });
  const drawWeek = () => {
    const start = +$('#weekSel').value;
    const n = 7 * 96;
    const idx = R.stack.idx;
    const slice = (arr) => Array.from(arr.subarray(start, start + n));
    const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const xTicks = []; for (let d = 0; d < 7; d++) { const t = start + d * 96; xTicks.push({ i: d * 96, label: `${DAYS[idx.dow[t]]} ${idx.month[t]}/${idx.day[t]}` }); }
    const labelAt = (i) => labelOf(idx, start + i);
    lineChart($('#chartWeek'), { series: [{ name: 'Building load', values: slice(R.load.kw), color: 'var(--s1)' }, { name: 'Grid import', values: slice(R.sol.imp), color: 'var(--s2)' }], xTicks, labelAt, yFormat: (v) => fmtN(v) + ' kW', height: 240, yLabel: 'kW' });
    lineChart($('#chartSoc'), { series: [{ name: 'State of charge', values: slice(R.sol.soc), color: 'var(--s3)', area: true }], xTicks, labelAt, yFormat: (v) => fmtN(v) + ' kWh', height: 150, yLabel: 'kWh' });
  };
  $('#weekSel').addEventListener('change', drawWeek);
  drawWeek();
  $('#rerun').addEventListener('click', () => go(4));
  $('#dlJson').addEventListener('click', () => {
    const out = { inputs: stackConfig(), battery: R.battery, load: { label: R.load.label, source: R.load.source, stats: stats(R.load.kw) }, baseline: R.baseline, withBattery: R.withB, programRevenue: R.revenue, summary: R.summary, generated: new Date().toISOString() };
    download('sc8_battery_results.json', JSON.stringify(out, (k, v) => (v instanceof Float64Array || v instanceof Int32Array ? undefined : v), 1), 'application/json');
  });
  $('#dlDispatch').addEventListener('click', () => {
    const idx = R.stack.idx;
    const lines = ['timestamp,load_kw,import_kw,charge_kw,discharge_kw,soc_kwh,price_usd_per_kwh'];
    for (let t = 0; t < idx.T; t++) lines.push(`${labelOf(idx, t)},${R.load.kw[t].toFixed(2)},${R.sol.imp[t].toFixed(2)},${R.sol.ch[t].toFixed(2)},${R.sol.dis[t].toFixed(2)},${R.sol.soc[t].toFixed(2)},${R.stack.price[t].toFixed(5)}`);
    download('sc8_battery_dispatch.csv', lines.join('\n'), 'text/csv');
  });
}

function download(name, text, type) {
  try {
    const blob = new Blob([text], { type });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  } catch (e) { edition.logError(e); }
}

// ---------------------------------------------------------------- rail
async function renderRail() {
  const rail = $('#rail');
  let stack = null, err = null;
  try { stack = getStack(); } catch (e) { err = e; }
  let load = null; try { load = await getLoad(); } catch (e) { /* shown in panel */ }
  const B = state.battery;
  const s = load ? stats(load.kw) : null;
  const bill = load && stack ? billFor(stack, load.kw) : null;
  rail.innerHTML = `
    <div class="card"><h4>Scenario</h4><dl>
      <dt>Rate</dt><dd>SC 8 Rate ${roman[state.rateNo]} ${state.voltage.toUpperCase()}, ${state.region === 'nyc' ? 'NYC' : 'Westchester'} (zone ${state.zone})</dd>
      <dt>Supply</dt><dd>${esc(SUPPLY_MODES[state.supply.mode])}${stack ? `, ${(stack.supply.avgEnergyRate * 100).toFixed(1)}¢/kWh avg, ${fmt$(stack.supply.capacityRate, 2)}/kW-mo` : ''}</dd>
      <dt>Programs</dt><dd>${PROGRAM_IDS.filter((id) => state.programs.enabled[id]).map((id) => id.toUpperCase().replace('_', '-')).join(', ') || 'none'}${stack && stack.programs.network ? ` at ${esc(stack.programs.network.name)}, ${fmtN(state.programs.pledgeKw)} kW` : ''}</dd>
      <dt>Load</dt><dd>${load ? `${esc(load.label)}<br>${fmtN(s.annualKwh / 1000)} MWh, ${fmtN(s.peakKw)} kW peak` : 'not set'}</dd>
      <dt>Battery</dt><dd>${fmtN(B.kw)} kW / ${fmtN(B.kwh)} kWh, ${B.rte}% RTE, ${B.cycles || 'unlimited'} cycles/yr</dd>
    </dl></div>
    ${bill ? `<div class="card"><h4>Baseline annual bill</h4><div class="big">${fmt$(bill.total)}</div><dl>
      <dt>Energy</dt><dd>${fmt$(bill.energy)}</dd><dt>Demand</dt><dd>${fmt$(bill.demand)}</dd><dt>Fixed + tax</dt><dd>${fmt$(bill.fixed + bill.tax)}</dd>
      <dt>All-in</dt><dd>${(bill.total / s.annualKwh * 100).toFixed(1)}¢/kWh</dd></dl></div>` : ''}
    ${results ? `<div class="card"><h4>Last run</h4><div class="big ok">${fmt$(results.summary.savingsTotal)}</div><p class="note">annual savings; <a href="#results" data-goto="5">see results</a></p></div>` : ''}
    ${err ? edition.railErrorHtml(err) : ''}`;
  rail.querySelectorAll('[data-goto]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); go(+a.dataset.goto); }));
}

// ---------------------------------------------------------------- boot
async function boot() {
  const status = $('#status');
  $('#footnote').innerHTML = edition.FOOTER;
  try {
    await loadData();
    status.textContent = '';
    if (state.step === 5) state.step = 4;
    document.addEventListener('click', (e) => { if (e.target && e.target.id === 'runBtn') run(); });
    render();
  } catch (e) {
    status.textContent = 'Failed to load data';
    $('#panel').innerHTML = edition.loadFailedHtml(e);
  }
}
boot();
