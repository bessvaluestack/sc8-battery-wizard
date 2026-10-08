// Con Edison demand-response riders on the model-year index: Rider T CSRP /
// DLRP (reservation + performance, rates in the tariff) and Rider AC
// Term-DLM (pay-as-bid Program Agreement, rates entered by the user).
// Ported from the reference engine's app/programs/events.py + eligibility.py.
//
// Events (design decision 1): the n highest-priced days of the
// Capability Period (May 1 - Sep 30) by the zone's day-ahead LBMP over the
// obligation block, which starts at the network's Contracted Hours; CSRP and
// Term-DLM on non-holiday weekdays, DLRP on any day. Picked with perfect
// knowledge of prices, never of the site's load.

import { buildIndex, STEPS_PER_HOUR } from './timeidx.js';
import { hourlyToIntervals } from './supply.js';
import { aggregatorNote, PLEDGE_MISSING } from './edition.js';

export const PROGRAM_IDS = ['csrp', 'dlrp', 'term_dlm'];
export const PROGRAM_LABELS = {
  csrp: 'Rider T - Commercial System Relief Program (CSRP)',
  dlrp: 'Rider T - Distribution Load Relief Program (DLRP)',
  term_dlm: 'Rider AC - Term Dynamic Load Management (Term-DLM)',
};

function countedEventType(prog) {
  for (const [t, e] of Object.entries(prog.events || {})) if (e.counts_toward_rate_step) return t;
  return Object.keys(prog.events || {})[0] || 'planned';
}

function obligationHours(prog) {
  const e = (prog.events || {})[countedEventType(prog)] || {};
  return e.obligation_hours || 4;
}

export function selectEvents(prog, network, nEvents, lbmp15) {
  const idx = buildIndex();
  if (!network || !network.contracted_hours || nEvents <= 0) return [];
  const a = network.contracted_hours[0];
  const hours = [a, a + obligationHours(prog)];
  const season = prog.season || { start: '05-01', end: '09-30' };
  const [sm, sd] = season.start.split('-').map(Number), [em, ed] = season.end.split('-').map(Number);
  const weekdaysOnly = (prog.days || 'weekdays') === 'weekdays';
  const exclHol = prog.exclude_holidays !== false;
  const span = (hours[1] - hours[0]) * STEPS_PER_HOUR;
  const byDay = new Map();
  for (let t = 0; t < idx.T; t++) {
    const md = idx.month[t] * 100 + idx.day[t];
    if (md < sm * 100 + sd || md > em * 100 + ed) continue;
    if (weekdaysOnly && idx.dow[t] >= 5) continue;
    if (exclHol && idx.holiday[t]) continue;
    if (idx.hour[t] < hours[0] || idx.hour[t] >= hours[1]) continue;
    const key = idx.doy[t];
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(t);
  }
  const days = [];
  for (const [doy, pos] of byDay) {
    if (pos.length !== span) continue;
    let s = 0; for (const t of pos) s += lbmp15[t];
    days.push({ doy, pos, price: s / pos.length });
  }
  days.sort((x, y) => (y.price - x.price) || (x.doy - y.doy));
  const chosen = days.slice(0, nEvents).sort((x, y) => x.doy - y.doy);
  return chosen.map((d) => ({
    day: `${idx.month[d.pos[0]]}/${idx.day[d.pos[0]]}`, doy: d.doy, hours, intervals: Int32Array.from(d.pos),
    priceUsdPerMwh: d.price,
  }));
}

export function terms(prog, programId, network, nEvents, overrides = {}) {
  const months = (prog.season && prog.season.months ? prog.season.months.length : 5);
  const threshold = nEvents >= 5 ? '>=5' : '<=4';
  const out = { program: programId, nEvents, months, threshold, flags: [] };
  if (prog.option === 'agreement') {
    out.rateSource = 'program_agreement';
    out.group = null;
    out.reservationRate = +overrides.reservationRate || 0;
    out.performanceRate = +overrides.performanceRate || 0;
    if (!out.reservationRate) out.flags.push('Term-DLM rates are pay-as-bid (not in the tariff): enter the agreement\'s reservation rate.');
  } else {
    const key = prog.reservation_rate_key;
    const group = key === 'dlrp_tier' ? (network.dlrp_tier || 'tier_1') : (network.county_group || 'westchester_staten_island');
    out.rateSource = 'tariff';
    out.group = group;
    out.reservationRate = ((prog.reservation_rates || {})[group] || {})[threshold] || 0;
    out.performanceRate = (prog.performance_rates || {})[countedEventType(prog)] || 0;
  }
  out.reservationValuePerKw = out.months * out.reservationRate; // $/kW over the season
  return out;
}

/**
 * @param cfg  { enabled: {csrp, dlrp, term_dlm}, network: name, pledgeKw, events: {csrp, dlrp, term_dlm},
 *               termDlm: {reservationRate, performanceRate}, participation: 'direct'|'aggregated' }
 * @param data { programs (programs.json), lbmp: {J,H,I} }
 * @returns { programs: [...LP-ready program dicts], notes: [], blocked: [] }
 */
export function buildPrograms(cfg, data, zone) {
  const out = { programs: [], notes: [], blocked: [], network: null };
  const enabled = PROGRAM_IDS.filter((id) => cfg.enabled && cfg.enabled[id]);
  if (!enabled.length) return out;
  const net = data.programs.networks[cfg.network];
  if (!net) { out.blocked.push('Pick the site\'s distribution network: the reservation rate, Contracted Hours and DLRP tier key on it.'); return out; }
  out.network = { name: cfg.network, ...net };
  const pledge = +cfg.pledgeKw || 0;
  if (pledge <= 0) { out.blocked.push(PLEDGE_MISSING); return out; }
  const lbmp15 = hourlyToIntervals(data.lbmp[zone].hourly);
  const eventSets = {};
  for (const id of enabled) {
    const prog = data.programs.programs[id];
    if (!prog) continue;
    if (prog.min_kw && pledge < prog.min_kw) {
      if (cfg.participation === 'aggregated') out.notes.push(aggregatorNote(id.toUpperCase(), pledge, prog.min_kw));
      else { out.blocked.push(`${id.toUpperCase()}: the pledge (${pledge} kW) is below the ${prog.min_kw} kW minimum for a Direct Participant; choose aggregated participation or raise the pledge.`); continue; }
    }
    const n = +(cfg.events && cfg.events[id]) || 0;
    const evs = selectEvents(prog, net, n, lbmp15);
    const tm = terms(prog, id, net, n, id === 'term_dlm' ? cfg.termDlm : {});
    if (!evs.length) { out.notes.push(`${id.toUpperCase()}: no events (count 0 or no Contracted Hours) - reservation value needs at least one event to size the delivered share.`); }
    eventSets[id] = new Set(); for (const e of evs) for (const t of e.intervals) eventSets[id].add(t);
    out.programs.push({
      id, label: PROGRAM_LABELS[id], pledgeKw: pledge, events: evs, terms: tm,
      reservationValuePerKw: tm.reservationValuePerKw, performanceRate: tm.performanceRate,
      performanceIntervals: null,
    });
    for (const f of tm.flags) out.notes.push(f);
  }
  // Concurrent CSRP + DLRP hours: performance is paid under both programs
  // (owner decision 2026-10-08), so no interval is excluded from either.
  const csrp = out.programs.find((p) => p.id === 'csrp'), dlrp = out.programs.find((p) => p.id === 'dlrp');
  if (csrp && dlrp) {
    let overlap = 0;
    for (const t of eventSets.dlrp) if (eventSets.csrp.has(t)) overlap++;
    if (overlap) out.notes.push('CSRP and DLRP events overlap on the top-priced days; the same relief earns performance under both programs.');
  }
  out.notes.push('Baseline for load relief = the no-battery meter (this profile). Con Edison\'s Customer Baseline Load method is not reproduced; a daily-cycling battery erodes a CBL over time.');
  out.notes.push('Event days are the highest-priced Capability Period days by day-ahead LBMP, chosen with perfect foresight; reservation is paid in proportion to the delivered share (maximin over events).');
  return out;
}
