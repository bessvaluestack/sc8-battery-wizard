// Small SVG charts with a hover layer (no library). Colors come from the
// page's CSS tokens (--s1..--s4, --fg, --muted, --line) so both themes work.

const NS = 'http://www.w3.org/2000/svg';
function el(tag, attrs = {}, parent) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
}
function niceTicks(max, n = 4) {
  if (max <= 0) return [0];
  const raw = max / n, mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const steps = [1, 2, 2.5, 5, 10];
  let step = steps.find((s) => s * mag >= raw) * mag;
  const out = [];
  for (let v = 0; v <= max + 1e-9; v += step) out.push(+v.toFixed(6));
  if (out[out.length - 1] < max) out.push(out[out.length - 1] + step);
  return out;
}

function tooltip(container) {
  let tip = container.querySelector('.tip');
  if (!tip) { tip = document.createElement('div'); tip.className = 'tip'; tip.hidden = true; container.appendChild(tip); }
  return tip;
}

/** Grouped bars. series: [{name, values[], color}], labels[] */
export function barChart(container, { labels, series, yFormat = (v) => v.toFixed(0), height = 240, yLabel = '' }) {
  container.innerHTML = '';
  container.classList.add('chart');
  const W = 720, H = height, padL = 72, padR = 12, padT = 18, padB = 34;
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': yLabel }, container);
  const max = Math.max(...series.flatMap((s) => s.values), 0);
  const ticks = niceTicks(max);
  const yMax = ticks[ticks.length - 1] || 1;
  const x0 = padL, x1 = W - padR, y0 = H - padB, y1 = padT;
  const sx = (x1 - x0) / labels.length;
  const y = (v) => y0 - (v / yMax) * (y0 - y1);
  for (const tv of ticks) {
    el('line', { x1: x0, x2: x1, y1: y(tv), y2: y(tv), class: 'grid' }, svg);
    el('text', { x: x0 - 8, y: y(tv) + 4, class: 'tick', 'text-anchor': 'end' }, svg).textContent = yFormat(tv);
  }
  el('line', { x1: x0, x2: x1, y1: y0, y2: y0, class: 'axis' }, svg);
  const n = series.length, gap = 2, inner = sx * 0.72, bw = (inner - gap * (n - 1)) / n;
  labels.forEach((lab, i) => {
    el('text', { x: x0 + sx * (i + 0.5), y: y0 + 18, class: 'tick', 'text-anchor': 'middle' }, svg).textContent = lab;
    series.forEach((s, j) => {
      const v = s.values[i] || 0;
      const bx = x0 + sx * i + (sx - inner) / 2 + j * (bw + gap);
      const top = y(v);
      const h = Math.max(0, y0 - top);
      el('rect', { x: bx, y: top, width: bw, height: h, rx: 2, fill: s.color, 'data-i': i }, svg);
    });
  });
  if (series.length > 1) {
    const lg = document.createElement('div'); lg.className = 'legend';
    for (const s of series) { const it = document.createElement('span'); it.innerHTML = `<i style="background:${s.color}"></i>${s.name}`; lg.appendChild(it); }
    container.appendChild(lg);
  }
  const tip = tooltip(container);
  svg.addEventListener('mousemove', (ev) => {
    const r = svg.getBoundingClientRect();
    const px = (ev.clientX - r.left) * (W / r.width);
    const i = Math.floor((px - x0) / sx);
    if (i < 0 || i >= labels.length) { tip.hidden = true; return; }
    tip.hidden = false;
    tip.innerHTML = `<b>${labels[i]}</b>` + series.map((s) => `<div><i style="background:${s.color}"></i>${s.name}: ${yFormat(s.values[i] || 0)}</div>`).join('');
    tip.style.left = Math.min(ev.clientX - r.left + 12, r.width - 160) + 'px';
    tip.style.top = (ev.clientY - r.top - 10) + 'px';
  });
  svg.addEventListener('mouseleave', () => { tip.hidden = true; });
}

/** Lines over an index 0..n-1. series: [{name, values, color, area}], xTicks: [{i, label}] */
export function lineChart(container, { series, xTicks = [], yFormat = (v) => v.toFixed(0), height = 240, yLabel = '', labelAt = (i) => String(i) }) {
  container.innerHTML = '';
  container.classList.add('chart');
  const n = series[0].values.length;
  const W = 720, H = height, padL = 72, padR = 12, padT = 14, padB = 30;
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': yLabel }, container);
  let max = 0; for (const s of series) for (const v of s.values) if (v > max) max = v;
  const ticks = niceTicks(max);
  const yMax = ticks[ticks.length - 1] || 1;
  const x0 = padL, x1 = W - padR, y0 = H - padB, y1 = padT;
  const x = (i) => x0 + (i / Math.max(1, n - 1)) * (x1 - x0);
  const y = (v) => y0 - (v / yMax) * (y0 - y1);
  for (const tv of ticks) {
    el('line', { x1: x0, x2: x1, y1: y(tv), y2: y(tv), class: 'grid' }, svg);
    el('text', { x: x0 - 8, y: y(tv) + 4, class: 'tick', 'text-anchor': 'end' }, svg).textContent = yFormat(tv);
  }
  for (const tk of xTicks) {
    el('line', { x1: x(tk.i), x2: x(tk.i), y1: y0, y2: y0 + 4, class: 'axis' }, svg);
    el('text', { x: x(tk.i), y: y0 + 18, class: 'tick', 'text-anchor': 'middle' }, svg).textContent = tk.label;
  }
  el('line', { x1: x0, x2: x1, y1: y0, y2: y0, class: 'axis' }, svg);
  for (const s of series) {
    let d = '';
    for (let i = 0; i < n; i++) d += (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(s.values[i]).toFixed(1);
    if (s.area) el('path', { d: d + `L${x(n - 1).toFixed(1)} ${y0}L${x(0).toFixed(1)} ${y0}Z`, fill: s.color, opacity: 0.15 }, svg);
    el('path', { d, fill: 'none', stroke: s.color, 'stroke-width': s.width || 1.6, 'stroke-linejoin': 'round' }, svg);
  }
  const cross = el('line', { x1: 0, x2: 0, y1: y1, y2: y0, class: 'cross' }, svg); cross.style.display = 'none';
  const dots = series.map((s) => { const c = el('circle', { r: 4, fill: s.color, stroke: 'var(--surface)', 'stroke-width': 2 }, svg); c.style.display = 'none'; return c; });
  if (series.length > 1) {
    const lg = document.createElement('div'); lg.className = 'legend';
    for (const s of series) { const it = document.createElement('span'); it.innerHTML = `<i style="background:${s.color}"></i>${s.name}`; lg.appendChild(it); }
    container.appendChild(lg);
  }
  const tip = tooltip(container);
  svg.addEventListener('mousemove', (ev) => {
    const r = svg.getBoundingClientRect();
    const px = (ev.clientX - r.left) * (W / r.width);
    const i = Math.round(((px - x0) / (x1 - x0)) * (n - 1));
    if (i < 0 || i >= n) { tip.hidden = true; cross.style.display = 'none'; dots.forEach((d) => (d.style.display = 'none')); return; }
    cross.style.display = ''; cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i));
    dots.forEach((d, j) => { d.style.display = ''; d.setAttribute('cx', x(i)); d.setAttribute('cy', y(series[j].values[i])); });
    tip.hidden = false;
    tip.innerHTML = `<b>${labelAt(i)}</b>` + series.map((s) => `<div><i style="background:${s.color}"></i>${s.name}: ${yFormat(s.values[i])}</div>`).join('');
    tip.style.left = Math.min(ev.clientX - r.left + 12, r.width - 170) + 'px';
    tip.style.top = (ev.clientY - r.top - 10) + 'px';
  });
  svg.addEventListener('mouseleave', () => { tip.hidden = true; cross.style.display = 'none'; dots.forEach((d) => (d.style.display = 'none')); });
}
