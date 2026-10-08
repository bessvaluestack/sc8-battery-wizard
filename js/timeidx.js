// Canonical model-year time index: 2027, 15-minute, 35,040 intervals, naive
// local time (DST deliberately ignored, same convention as the reference engine).
// Everything (load, rates, supply, dispatch) aligns to this index.

export const MODEL_YEAR = 2027;
export const STEP_MIN = 15;
export const STEPS_PER_HOUR = 60 / STEP_MIN;
export const DT_HOURS = STEP_MIN / 60;
export const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
export const T = 365 * 24 * STEPS_PER_HOUR;
export const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// US federal holidays 2027 as observed (pandas USFederalHolidayCalendar):
// New Year's, MLK, Presidents, Memorial, Juneteenth (obs. Fri 18 Jun),
// Independence (obs. Mon 5 Jul), Labor, Columbus, Veterans, Thanksgiving,
// Christmas (obs. Fri 24 Dec), New Year's 2028 (obs. Fri 31 Dec).
export const HOLIDAYS_2027 = ['01-01', '01-18', '02-15', '05-31', '06-18', '07-05', '09-06', '10-11', '11-11', '11-25', '12-24', '12-31'];

// 2027-01-01 is a Friday. dow: 0 = Monday ... 6 = Sunday.
const JAN1_DOW = 4;

let cached = null;

export function buildIndex() {
  if (cached) return cached;
  const month = new Uint8Array(T), day = new Uint8Array(T), dow = new Uint8Array(T);
  const hour = new Uint8Array(T), minute = new Uint8Array(T), doy = new Uint16Array(T);
  const holiday = new Uint8Array(T);
  const holidaySet = new Set(HOLIDAYS_2027);
  const monthStart = new Int32Array(13);
  let t = 0, d = 0;
  for (let m = 0; m < 12; m++) {
    monthStart[m] = t;
    for (let dd = 1; dd <= DAYS_IN_MONTH[m]; dd++, d++) {
      const key = `${String(m + 1).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
      const hol = holidaySet.has(key) ? 1 : 0;
      const wd = (JAN1_DOW + d) % 7;
      for (let h = 0; h < 24; h++) {
        for (let q = 0; q < STEPS_PER_HOUR; q++, t++) {
          month[t] = m + 1; day[t] = dd; dow[t] = wd; hour[t] = h; minute[t] = q * STEP_MIN;
          doy[t] = d; holiday[t] = hol;
        }
      }
    }
  }
  monthStart[12] = T;
  cached = { month, day, dow, hour, minute, doy, holiday, monthStart, T, dt: DT_HOURS };
  return cached;
}

export function dayMask(idx, days) {
  const m = new Uint8Array(idx.T);
  for (let t = 0; t < idx.T; t++) {
    const wd = idx.dow[t];
    m[t] = (days === 'weekdays') ? (wd < 5 ? 1 : 0) : (days === 'weekends') ? (wd >= 5 ? 1 : 0) : 1;
  }
  return m;
}

export function hourMask(idx, hours) {
  const m = new Uint8Array(idx.T);
  if (!hours) { m.fill(1); return m; }
  const [a, b] = hours;
  for (let t = 0; t < idx.T; t++) {
    const h = idx.hour[t];
    m[t] = (a <= b) ? ((h >= a && h < b) ? 1 : 0) : ((h >= a || h < b) ? 1 : 0);
  }
  return m;
}

export function monthMask(idx, months) {
  const m = new Uint8Array(idx.T);
  if (!months) { m.fill(1); return m; }
  const set = new Set(months);
  for (let t = 0; t < idx.T; t++) m[t] = set.has(idx.month[t]) ? 1 : 0;
  return m;
}

export function andMasks(...masks) {
  const out = new Uint8Array(masks[0].length);
  for (let t = 0; t < out.length; t++) {
    let v = 1;
    for (const m of masks) if (!m[t]) { v = 0; break; }
    out[t] = v;
  }
  return out;
}

export function windowMask(idx, { months, days, hours } = {}) {
  return andMasks(monthMask(idx, months || null), dayMask(idx, days || 'all'), hourMask(idx, hours || null));
}

// Interval position of a (month 1-12, day, hour, minute) tuple.
export function position(idx, m, d, h, min) {
  let doy = 0;
  for (let i = 0; i < m - 1; i++) doy += DAYS_IN_MONTH[i];
  doy += d - 1;
  return doy * 24 * STEPS_PER_HOUR + h * STEPS_PER_HOUR + Math.floor(min / STEP_MIN);
}

export function labelOf(idx, t) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${MODEL_YEAR}-${pad(idx.month[t])}-${pad(idx.day[t])} ${pad(idx.hour[t])}:${pad(idx.minute[t])}`;
}
