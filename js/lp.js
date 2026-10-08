// Dispatch LP in CPLEX LP text for HiGHS. Battery sizes are fixed (the user
// sets them), so the problem is a pure dispatch LP over the whole year:
//
//   min  sum_t price_t * imp_t * dt          (delivery + supply energy, taxed)
//      + sum_k rate_k * pk_k                 (every $/kW-month determinant:
//                                             delivery demand windows, SBC
//                                             demand, supply capacity)
//      + c_thr * dt * sum_t dis_t            (optional throughput cost)
//      - sum_p [ resValue_p * D_p + perf_p * dt * sum_{t in perf} r_{p,t} ]
//   s.t. imp_t - ch_t + dis_t = load_t                       (no export)
//        soc_{t+1} = soc_t + (eta_c ch_t - dis_t / eta_d) dt, cyclic
//        0 <= ch, dis <= P ; 0 <= soc <= E_usable
//        imp (or the half-hour average) <= pk_k for every interval in window k
//        sum_t dis_t dt <= cycles_per_year * E_nameplate
//        programs: r <= load_t - imp_t, r <= pledge, mean_e(r) >= D, D <= pledge
//
// Same formulation as the reference engine's app/optimizer/model.py with the sizes pinned
// and export fixed at zero (a behind-the-meter SC 8 battery with no Rider R).

function f6(x) { return (Math.abs(x) < 5e-7 ? 0 : x).toFixed(6); }

export function buildLP(inp) {
  const { load, price, peakTerms, battery, dt, demandIntervalMin, programs, taxFactor } = inp;
  const T = load.length;
  const P = +battery.kw, E = +battery.kwh;
  const eta = Math.sqrt(+battery.rte);
  const usable = E * (+battery.usableFrac);
  const cycles = +battery.cyclesPerYear;
  const thr = +battery.throughputCost || 0;
  const tax = taxFactor || 1;
  const out = [];
  const push = (s) => out.push(s);

  // ---- objective ------------------------------------------------------
  push('Minimize');
  let line = ' obj:';
  let n = 0;
  const term = (coef, name) => {
    if (coef === 0) return;
    line += (coef < 0 ? ' - ' : ' + ') + f6(Math.abs(coef)) + ' ' + name;
    if (++n % 12 === 0) { push(line); line = ' '; }
  };
  for (let t = 0; t < T; t++) term(price[t] * dt * tax, 'i' + t);
  if (thr > 0) for (let t = 0; t < T; t++) term(thr * dt, 'd' + t);
  peakTerms.forEach((k, j) => term(k.rate * tax, 'p' + j));
  if (programs) programs.forEach((pg, pi) => {
    term(-pg.reservationValuePerKw, 'D' + pi);
    const perf = pg.performanceIntervals || pg.allIntervals;
    if (pg.performanceRate > 0) for (const t of perf) term(-pg.performanceRate * dt, `r${pi}_${t}`);
  });
  if (line.trim() !== '') push(line);

  // ---- constraints ----------------------------------------------------
  push('Subject To');
  const ec = f6(eta * dt), ed = f6(dt / eta);
  for (let t = 0; t < T; t++) {
    push(` b${t}: i${t} - c${t} + d${t} = ${f6(load[t])}`);
    const nx = (t + 1) % T;
    push(` s${t}: s${nx} - s${t} - ${ec} c${t} + ${ed} d${t} = 0`);
  }
  peakTerms.forEach((k, j) => {
    const pos = k.idx;
    if (demandIntervalMin === 30) {
      for (let i = 0; i < pos.length; i++) {
        const t = pos[i];
        if (t % 2 !== 0 || t + 1 >= T) continue;
        push(` k${j}_${t}: 0.5 i${t} + 0.5 i${t + 1} - p${j} <= 0`);
      }
    } else {
      for (let i = 0; i < pos.length; i++) push(` k${j}_${pos[i]}: i${pos[i]} - p${j} <= 0`);
    }
  });
  // annual throughput cap
  if (cycles > 0 && E > 0) {
    line = ' cyc:'; n = 0;
    for (let t = 0; t < T; t++) {
      line += ' + ' + f6(dt) + ' d' + t;
      if (++n % 16 === 0) { push(line); line = ' '; }
    }
    push(line + ` <= ${f6(cycles * E)}`);
  }
  if (programs) programs.forEach((pg, pi) => {
    for (const t of pg.allIntervals) push(` pr${pi}_${t}: r${pi}_${t} + i${t} <= ${f6(load[t])}`);
    pg.events.forEach((ev, ei) => {
      const coef = f6(1 / ev.intervals.length);
      let l = ` pe${pi}_${ei}:`;
      for (const t of ev.intervals) l += ` + ${coef} r${pi}_${t}`;
      push(l + ` - D${pi} >= 0`);
    });
  });

  // ---- bounds ---------------------------------------------------------
  push('Bounds');
  for (let t = 0; t < T; t++) {
    push(` c${t} <= ${f6(P)}`);
    push(` d${t} <= ${f6(P)}`);
    push(` s${t} <= ${f6(usable)}`);
  }
  if (programs) programs.forEach((pg, pi) => {
    for (const t of pg.allIntervals) push(` r${pi}_${t} <= ${f6(pg.pledgeKw)}`);
    push(` D${pi} <= ${f6(pg.pledgeKw)}`);
  });
  push('End');
  return out.join('\n');
}

// Two-stage solve: the annual cycle row couples every interval and makes the
// simplex several times slower, so solve without it first and only add the
// cap when the free dispatch overshoots the budget. The capped solve's row
// dual is the marginal value of one more kWh of annual discharge budget.
export function solveWithCycleCap(highs, inputs, opts = { output_flag: false }) {
  const cap = +inputs.battery.cyclesPerYear || 0;
  const E = +inputs.battery.kwh || 0;
  const timing = {};
  const dt = inputs.dt;
  const sumDis = (r) => { let s = 0; for (let t = 0; t < r.dis.length; t++) s += r.dis[t]; return s * dt; };
  const free = { ...inputs, battery: { ...inputs.battery, cyclesPerYear: 0 } };
  let t0 = performance.now();
  const lp1 = buildLP(free);
  const sol1 = highs.solve(lp1, opts);
  if (sol1.Status !== 'Optimal') throw new Error(`solver status ${sol1.Status}`);
  const r1 = extractSolution(sol1, free);
  timing.uncappedMs = performance.now() - t0;
  const thr1 = sumDis(r1);
  r1.cycleInfo = { capped: false, binding: false, throughputKwh: thr1, capKwh: cap * E, marginalUsdPerKwh: 0 };
  r1.timing = timing;
  if (!(cap > 0 && E > 0 && thr1 > cap * E * 1.0005)) return r1;
  t0 = performance.now();
  const lp2 = buildLP(inputs);
  const sol2 = highs.solve(lp2, opts);
  if (sol2.Status !== 'Optimal') throw new Error(`solver status ${sol2.Status}`);
  const r2 = extractSolution(sol2, inputs);
  timing.cappedMs = performance.now() - t0;
  const row = (sol2.Rows || []).find((r) => r.Name === 'cyc');
  r2.cycleInfo = { capped: true, binding: true, throughputKwh: sumDis(r2), capKwh: cap * E, uncappedThroughputKwh: thr1,
    marginalUsdPerKwh: row && typeof row.Dual === 'number' ? Math.max(0, -row.Dual) : null };
  r2.timing = timing;
  return r2;
}

// Pull the dispatch out of a HiGHS solution object (highs.solve() result).
export function extractSolution(sol, inp) {
  const T = inp.load.length;
  const cols = sol.Columns;
  const imp = new Float64Array(T), ch = new Float64Array(T), dis = new Float64Array(T), soc = new Float64Array(T);
  const get = (name) => { const c = cols[name]; return c ? c.Primal : 0; };
  for (let t = 0; t < T; t++) {
    imp[t] = Math.max(0, get('i' + t)); ch[t] = Math.max(0, get('c' + t));
    dis[t] = Math.max(0, get('d' + t)); soc[t] = Math.max(0, get('s' + t));
  }
  // LP netting cleanup: remove residual simultaneous charge/discharge.
  for (let t = 0; t < T; t++) {
    const both = Math.min(ch[t], dis[t]);
    if (both > 0) { ch[t] -= both; dis[t] -= both; }
    imp[t] = Math.max(0, inp.load[t] + ch[t] - dis[t]);
  }
  const peaks = inp.peakTerms.map((k, j) => get('p' + j));
  const programs = (inp.programs || []).map((pg, pi) => {
    const r = {};
    for (const t of pg.allIntervals) r[t] = Math.max(0, get(`r${pi}_${t}`));
    return { id: pg.id, D: Math.max(0, get('D' + pi)), r };
  });
  return { status: sol.Status, objective: sol.ObjectiveValue, imp, ch, dis, soc, peaks, programs };
}
