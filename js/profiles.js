// Load profiles: presets, annual-bill scaling, and the interval uploader.
import { buildIndex, position, DT_HOURS, STEPS_PER_HOUR, STEP_MIN } from './timeidx.js';

export function stats(kw) {
  let sum = 0, peak = 0;
  for (let t = 0; t < kw.length; t++) { sum += kw[t]; if (kw[t] > peak) peak = kw[t]; }
  const annualKwh = sum * DT_HOURS;
  return { annualKwh, peakKw: peak, loadFactor: peak > 0 ? annualKwh / (peak * 8760) : 0 };
}

// Scale a shape so that billFn(scale * shape) hits the target annual $ (bisection; the bill is monotone in scale).
export function scaleToBill(shape, targetBill, billFn) {
  const scaled = (s) => { const out = new Float64Array(shape.length); for (let t = 0; t < out.length; t++) out[t] = shape[t] * s; return out; };
  let lo = 1e-4, hi = 1;
  while (billFn(scaled(hi)) < targetBill && hi < 1e5) hi *= 2;
  for (let i = 0; i < 50; i++) {
    const mid = 0.5 * (lo + hi);
    if (billFn(scaled(mid)) < targetBill) lo = mid; else hi = mid;
  }
  const s = 0.5 * (lo + hi);
  return { kw: scaled(s), scale: s };
}

// ---- interval CSV parsing -------------------------------------------------
// Accepts: a timestamp column (ISO, "M/D/YYYY H:MM", "YYYY-MM-DD HH:MM[:SS]",
// with optional T/Z) or separate date + time columns (Green Button style),
// and a numeric value column. kW vs kWh from the header (or the override).
// Any source year; values land on the model year by (month, day, hour,
// minute); other intervals are resampled; Feb 29 dropped; gaps interpolated.

const VALUE_HINTS = ['kw', 'kwh', 'load', 'demand', 'usage', 'consumption', 'power', 'energy', 'value'];

function splitLine(line, delim) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { q = !q; continue; }
    if (ch === delim && !q) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function parseDateTime(s) {
  if (!s) return null;
  s = s.trim();
  let m;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?/))) {
    return { y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5] };
  }
  if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM|am|pm)?/))) {
    let h = +m[4];
    if (m[7]) { const pm = m[7].toLowerCase() === 'pm'; if (pm && h < 12) h += 12; if (!pm && h === 12) h = 0; }
    return { y: +m[3] < 100 ? 2000 + +m[3] : +m[3], mo: +m[1], d: +m[2], h, mi: +m[5] };
  }
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) return { y: +m[1], mo: +m[2], d: +m[3], h: 0, mi: 0 };
  if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/))) return { y: +m[3] < 100 ? 2000 + +m[3] : +m[3], mo: +m[1], d: +m[2], h: 0, mi: 0 };
  const dd = new Date(s);
  if (!Number.isNaN(dd.getTime())) return { y: dd.getFullYear(), mo: dd.getMonth() + 1, d: dd.getDate(), h: dd.getHours(), mi: dd.getMinutes() };
  return null;
}

function parseTime(s) {
  const m = String(s).trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM|am|pm)?/);
  if (!m) return null;
  let h = +m[1];
  if (m[4]) { const pm = m[4].toLowerCase() === 'pm'; if (pm && h < 12) h += 12; if (!pm && h === 12) h = 0; }
  return { h, mi: +m[2] };
}

export function parseIntervalCsv(text, opts = {}) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length < 50) throw new Error('Too few rows to build a profile (need a year of interval data).');
  const delim = (lines[0].match(/\t/g) || []).length > (lines[0].match(/,/g) || []).length ? '\t' : (lines[0].includes(';') && !lines[0].includes(',') ? ';' : ',');
  // header: the first line with a non-numeric first cell whose following line parses
  let headerIdx = -1;
  for (let i = 0; i < Math.min(lines.length, 30); i++) {
    const cells = splitLine(lines[i], delim);
    if (cells.length >= 2 && cells.some((c) => /[a-zA-Z]/.test(c)) && !parseDateTime(cells[0])) { headerIdx = i; break; }
  }
  const header = headerIdx >= 0 ? splitLine(lines[headerIdx], delim) : [];
  const rows = lines.slice(headerIdx + 1).map((l) => splitLine(l, delim)).filter((r) => r.length >= 2);
  const ncol = Math.max(...rows.slice(0, 50).map((r) => r.length));

  // find timestamp column(s)
  let tsCol = -1, dateCol = -1, timeCol = -1;
  const sample = rows.slice(0, 200);
  for (let c = 0; c < ncol; c++) {
    const ok = sample.filter((r) => { const p = parseDateTime(r[c]); return p && (p.h || p.mi || /[ T]\d{1,2}:\d{2}/.test(r[c])); }).length;
    if (ok > sample.length * 0.9) { tsCol = c; break; }
  }
  if (tsCol < 0) {
    for (let c = 0; c < ncol; c++) {
      const okD = sample.filter((r) => parseDateTime(r[c])).length;
      if (okD > sample.length * 0.9 && dateCol < 0) { dateCol = c; continue; }
      const okT = sample.filter((r) => parseTime(r[c])).length;
      if (okT > sample.length * 0.9 && timeCol < 0 && c !== dateCol) timeCol = c;
    }
    if (dateCol < 0 || timeCol < 0) throw new Error('No timestamp column found (expected ISO or M/D/YYYY H:MM, or separate date and time columns).');
  }
  // value column: numeric, prefer a kW/kWh-ish header
  let valCol = -1, best = -1;
  for (let c = 0; c < ncol; c++) {
    if (c === tsCol || c === dateCol || c === timeCol) continue;
    const okN = sample.filter((r) => r[c] !== undefined && r[c] !== '' && !Number.isNaN(+r[c].replace(/,/g, ''))).length;
    if (okN < sample.length * 0.9) continue;
    const name = (header[c] || '').toLowerCase();
    const score = okN / sample.length + (VALUE_HINTS.some((h) => name.includes(h)) ? 1 : 0) + (name.includes('end') ? -0.5 : 0);
    if (score > best) { best = score; valCol = c; }
  }
  if (valCol < 0) throw new Error('No numeric value column found.');
  const valName = (header[valCol] || '').toLowerCase();
  let units = opts.units || (valName.includes('kwh') || valName.includes('energy') || valName.includes('usage') ? 'kwh' : 'kw');

  // parse rows -> (minute-of-year key within model year, value)
  const idx = buildIndex();
  const sums = new Float64Array(idx.T), counts = new Uint16Array(idx.T);
  const stamps = [];
  let badRows = 0;
  const DIM = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  for (const r of rows) {
    let p;
    if (tsCol >= 0) p = parseDateTime(r[tsCol]);
    else { const d = parseDateTime(r[dateCol]), tm = parseTime(r[timeCol]); p = d && tm ? { ...d, h: tm.h, mi: tm.mi } : null; }
    const v = r[valCol] === undefined ? NaN : +String(r[valCol]).replace(/,/g, '');
    if (!p || Number.isNaN(v)) { badRows++; continue; }
    if (p.mo === 2 && p.d === 29) continue;
    if (p.mo < 1 || p.mo > 12 || p.d < 1 || p.d > DIM[p.mo - 1] || p.h > 23) { badRows++; continue; }
    stamps.push(Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi));
    const pos = position(idx, p.mo, p.d, p.h, p.mi);
    sums[pos] += v; counts[pos] += 1;
  }
  if (stamps.length < 50) throw new Error('Could not parse enough rows (check the timestamp format).');
  // source interval from the median delta
  const sorted = stamps.slice().sort((a, b) => a - b);
  const deltas = [];
  for (let i = 1; i < Math.min(sorted.length, 5000); i++) { const d = (sorted[i] - sorted[i - 1]) / 60000; if (d > 0) deltas.push(d); }
  deltas.sort((a, b) => a - b);
  const srcMin = deltas.length ? deltas[Math.floor(deltas.length / 2)] : 15;
  if (!(srcMin >= 1 && srcMin <= 120)) throw new Error(`Unsupported source interval: ${srcMin} minutes.`);

  // per-interval value (mean of hits); kWh -> kW using the SOURCE interval
  const kw = new Float64Array(idx.T).fill(NaN);
  for (let t = 0; t < idx.T; t++) if (counts[t]) {
    const mean = sums[t] / counts[t];
    kw[t] = units === 'kwh' ? mean * (60 / srcMin) : mean;
  }
  // coarser-than-15-min sources: forward-fill within the source block
  if (srcMin > STEP_MIN) {
    const span = Math.round(srcMin / STEP_MIN);
    for (let t = 0; t < idx.T; t++) if (!Number.isNaN(kw[t])) for (let j = 1; j < span && t + j < idx.T; j++) if (Number.isNaN(kw[t + j])) kw[t + j] = kw[t];
  }
  // gaps: linear interpolation, edges filled with the nearest value
  let covered = 0; for (let t = 0; t < idx.T; t++) if (!Number.isNaN(kw[t])) covered++;
  const coverage = covered / idx.T;
  if (coverage < 0.5) throw new Error(`Only ${(coverage * 100).toFixed(0)}% of the year is covered; need most of a year.`);
  let last = -1;
  for (let t = 0; t < idx.T; t++) {
    if (!Number.isNaN(kw[t])) {
      if (last < t - 1) {
        const a = last >= 0 ? kw[last] : kw[t];
        for (let j = last + 1; j < t; j++) kw[j] = last >= 0 ? a + (kw[t] - a) * (j - last) / (t - last) : kw[t];
      }
      last = t;
    }
  }
  if (last < idx.T - 1) for (let j = last + 1; j < idx.T; j++) kw[j] = kw[last];
  for (let t = 0; t < idx.T; t++) if (kw[t] < 0) kw[t] = 0;
  const years = [...new Set(stamps.map((s) => new Date(s).getUTCFullYear()))].sort();
  return {
    kw,
    meta: {
      rows: rows.length, badRows, sourceIntervalMin: srcMin, units, coverage, years,
      timestampColumn: tsCol >= 0 ? (header[tsCol] || `column ${tsCol + 1}`) : `${header[dateCol] || 'date'} + ${header[timeCol] || 'time'}`,
      valueColumn: header[valCol] || `column ${valCol + 1}`,
    },
  };
}

export function toCsv(kw, idx, labelOf) {
  const out = ['timestamp,kw'];
  for (let t = 0; t < idx.T; t++) out.push(`${labelOf(idx, t)},${kw[t].toFixed(2)}`);
  return out.join('\n');
}
