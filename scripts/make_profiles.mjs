#!/usr/bin/env node
// Generate the four preset 15-minute load profiles (35,040 intervals, model
// year 2027) for large master-metered multifamily buildings on Con Edison
// SC 8. Synthetic but shaped on residential redistribution load: an evening
// peak, a summer cooling bump driven by a synthetic daily temperature, and
// (for the heat-pump preset) a winter heating peak. Deterministic (seeded).
//
//   node scripts/make_profiles.mjs        -> data/profiles/<id>.json
//
// Replace any of these with a real interval file through the uploader.
import { writeFileSync, mkdirSync } from 'node:fs';
import { buildIndex, DT_HOURS } from '../js/timeidx.js';

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(rng) { const u = 1 - rng(), v = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

// Hourly shapes (index = hour of day), normalised so the daily max is ~1.
const BASE_WD = [0.62, 0.55, 0.50, 0.47, 0.46, 0.48, 0.56, 0.68, 0.72, 0.70, 0.68, 0.68, 0.68, 0.67, 0.68, 0.72, 0.80, 0.90, 0.97, 1.00, 0.98, 0.92, 0.82, 0.70];
const BASE_WE = [0.66, 0.58, 0.52, 0.48, 0.47, 0.47, 0.50, 0.58, 0.68, 0.76, 0.80, 0.82, 0.82, 0.80, 0.80, 0.82, 0.86, 0.92, 0.98, 1.00, 0.98, 0.92, 0.84, 0.72];
const COOL = [0.20, 0.15, 0.10, 0.08, 0.06, 0.06, 0.08, 0.12, 0.20, 0.30, 0.42, 0.55, 0.68, 0.80, 0.90, 0.97, 1.00, 1.00, 0.98, 0.95, 0.88, 0.75, 0.55, 0.35];
const HEAT = [0.90, 0.90, 0.90, 0.92, 0.95, 1.00, 1.00, 0.95, 0.85, 0.75, 0.65, 0.60, 0.58, 0.58, 0.60, 0.65, 0.75, 0.85, 0.90, 0.92, 0.92, 0.92, 0.90, 0.90];
// Monthly mean temperature, NYC (degF)
const TMEAN = [33, 35, 42, 53, 63, 72, 78, 76, 69, 58, 48, 38];

const PRESETS = [
  { id: 'midrise_gas_windowac', name: 'Mid-rise, 150 units, gas heat, window AC', seed: 11,
    base: 185, cooling: 0.55, heating: 0.0, elasticity: 1.0,
    description: 'Master-metered mid-rise; evening-peaking residential load with a moderate summer AC bump. Rate I sized (~300 kW).' },
  { id: 'highrise_central_cooling', name: 'High-rise, 400 units, central chiller, gas heat', seed: 23,
    base: 430, cooling: 0.85, heating: 0.05, elasticity: 1.0,
    description: 'Central cooling plant makes summer afternoons the annual peak (~850 kW); flat-ish shoulder seasons.' },
  { id: 'complex_heat_pumps', name: 'Large complex, 600 units, electric heat pumps', seed: 37,
    base: 520, cooling: 0.5, heating: 0.95, elasticity: 1.0,
    description: 'Electrified heating: winter-peaking mornings (~1,000 kW) plus a summer cooling peak. Tests non-summer demand charges.' },
  { id: 'tower_rate2', name: 'Tower, 900 units, central plant (>1,500 kW, Rate II)', seed: 41,
    base: 1180, cooling: 0.9, heating: 0.05, elasticity: 1.0,
    description: 'Above the 1,500 kW mandatory time-of-day threshold (~2,300 kW peak); pairs with Rate II and Rider M supply.' },
];

function dailyTemps(rng) {
  const out = new Float64Array(365);
  let dev = 0;
  let doy = 0;
  const DIM = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  for (let m = 0; m < 12; m++) {
    for (let d = 1; d <= DIM[m]; d++, doy++) {
      // interpolate monthly means at mid-month
      const nxt = TMEAN[(m + 1) % 12], prv = TMEAN[(m + 11) % 12];
      const f = (d - 0.5) / DIM[m];
      const mean = f < 0.5 ? prv + (TMEAN[m] - prv) * (f + 0.5) : TMEAN[m] + (nxt - TMEAN[m]) * (f - 0.5);
      dev = 0.75 * dev + gauss(rng) * 4.5; // AR(1) weather
      out[doy] = mean + dev;
    }
  }
  return out;
}

function generate(p) {
  const idx = buildIndex();
  const rng = mulberry32(p.seed);
  const temps = dailyTemps(rng);
  const kw = new Float64Array(idx.T);
  let noise = 0;
  for (let t = 0; t < idx.T; t++) {
    const h = idx.hour[t], q = idx.minute[t] / 60;
    const h2 = (h + 1) % 24;
    const wd = idx.dow[t] < 5;
    const base = wd ? BASE_WD : BASE_WE;
    const lerp = (arr) => arr[h] + (arr[h2] - arr[h]) * q;
    const temp = temps[idx.doy[t]];
    const coolInt = Math.min(1.3, Math.max(0, (temp - 64) / 18));
    const heatInt = Math.min(1.2, Math.max(0, (58 - temp) / 32));
    noise = 0.7 * noise + gauss(rng) * 0.02;
    const shape = lerp(base) + p.cooling * coolInt * lerp(COOL) + p.heating * heatInt * lerp(HEAT);
    kw[t] = Math.max(0.1 * p.base, p.base * shape * (1 + noise));
  }
  return kw;
}

mkdirSync(new URL('../data/profiles/', import.meta.url), { recursive: true });
for (const p of PRESETS) {
  const kw = generate(p);
  let sum = 0, peak = 0;
  for (const v of kw) { sum += v; if (v > peak) peak = v; }
  const annualKwh = sum * DT_HOURS;
  const doc = {
    id: p.id, name: p.name, description: p.description, units: 'kW', interval_min: 15, model_year: 2027,
    generated_by: 'scripts/make_profiles.mjs (synthetic, seeded)', seed: p.seed,
    stats: { annual_kwh: Math.round(annualKwh), peak_kw: Math.round(peak), load_factor: +(annualKwh / (peak * 8760)).toFixed(3) },
    kw: Array.from(kw, (v) => +v.toFixed(1)),
  };
  writeFileSync(new URL(`../data/profiles/${p.id}.json`, import.meta.url), JSON.stringify(doc));
  console.log(p.id, doc.stats);
}
writeFileSync(new URL('../data/profiles/index.json', import.meta.url), JSON.stringify(PRESETS.map((p) => ({ id: p.id, name: p.name, description: p.description })), null, 1));
