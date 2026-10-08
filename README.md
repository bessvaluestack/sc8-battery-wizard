# SC 8 Battery Wizard

A static, browser-only wizard that models a behind-the-meter battery for a
large master-metered multifamily building on Con Edison **Service
Classification 8 (Multiple Dwellings, Redistribution)** and reports the annual
savings. No backend: the tariff engine, supply model, program terms and the
dispatch optimisation (HiGHS compiled to WebAssembly) all run in the page, so
it deploys to GitHub Pages or as a claude.ai artifact as-is.

Inputs are compiled from the Con Edison P.S.C. No. 10 tariff corpus by an
upstream tariff model (the reference engine); `scripts/export_data.py` is the
one-time bridge (see *Data*).

## The wizard

1. **Rate**: SC 8 Rate I / II / III, low or high tension, NYC or Westchester,
   15-minute (default) or 30-minute billing demand, delivery $/kWh
   adjustments (SBC, MAC, RDM, SDR) and the SBC demand surcharge, a
   tax/surcharge percentage.
2. **Supply**: Con Edison full service (observed Market Supply Charge by
   billing period + MSC capacity $/kW-month), Con Edison Rider M hourly
   pricing (zonal day-ahead LBMP + ICAP tag), third-party fixed $/kWh, or
   third-party LBMP + adder.
3. **Riders**: Rider T CSRP and DLRP (rates in the tariff, keyed on the site's
   distribution network: Contracted Hours, county group, DLRP tier) and
   Rider AC Term-DLM (pay-as-bid, rates entered). Pledge, participation and
   events per season are scenario inputs.
4. **Load**: four preset 35,040-interval profiles, an estimate scaled from the
   annual bill (bisection on the modelled bill under the chosen rate and
   supply), or an uploaded interval CSV (ISO or US timestamps, or Green
   Button date + time columns; kW or kWh; any interval 5 to 60 min).
5. **Battery**: kW, kWh, round-trip efficiency, usable depth, annual cycle
   limit, optional throughput cost and installed cost.
6. **Results**: annual savings (bill savings + program revenue), the bill by
   component before and after, monthly peaks, a week of dispatch with state
   of charge, assumptions and provenance, JSON / CSV export.

## Model

- Canonical index: model year 2027, 15-minute, 35,040 intervals, naive local
  time (DST ignored), the reference engine's convention.
- Delivery bill: energy $/kWh + per-window demand charges (`rate x max import
  in window and month`), merged with every other $/kW-month determinant
  (SBC demand, supply capacity) that shares the window.
- Dispatch: one LP over the whole year with the battery sizes fixed, no
  export, cyclic state of charge, an annual discharge budget, perfect
  foresight; program load relief as in the reference engine (`relief <= baseline - import`,
  delivered share = the worst event, reservation paid on the share,
  performance on relief kWh). When programs are enrolled a second bill-only
  solve is reported for comparison.
- Solver: `highs` 1.15.3 (`vendor/highs`, MIT) in a module worker; a full
  year solves in 5 to 20 seconds depending on the rate.

## Run locally

```sh
python3 -m http.server 8080      # any static server; file:// blocks fetch and wasm
open http://localhost:8080/
npm test                            # engine tests + client-build checks
```

## Client edition (`--client`)

The source tree is the internal edition. For clients, build a sanitized copy:

```sh
node scripts/build.mjs --client     # writes dist/
npm run serve:client                # build, then serve dist/ on :8080
```

It differs from the internal edition only in text, never in numbers:

- `js/edition.client.js` ships as `js/edition.js`: no book / dataset
  vintages, compiler notes, internal tooling, solver timings or
  developer hints; errors the user can fix are shown, anything else gets a
  generic message and the console stays quiet. Any wording that should differ
  between editions belongs in those two files (a test keeps their exports in
  step).
- `data/` JSON loses its provenance fields (vintages, status, lineage,
  source files, notes) and the tariff keys lose their `corpus_` prefix.
- Comments are stripped from `js/` and `css/`.
- The build fails if any internal term or vintage string is left in the
  output (`LEAK_TERMS` and `BANNED_WORDS` in `scripts/build.mjs`; the
  banned words are stored as hashes so the repo does not spell them out).

`.github/workflows/pages.yml` runs the tests and publishes the client
edition to GitHub Pages on every push to `main` (Settings -> Pages ->
Source: GitHub Actions).

## Data (`data/`)

| File | Content | Source (paths in the reference engine's repo) |
|---|---|---|
| `tariffs_sc8.json` | SC 8 Rate I/II/III x LT/HT schedules with lineage | `config/tariffs/corpus_ced_sc8_*.yaml`, book `ny.ced.psc10@2026-08-01` (candidate) |
| `statements_sc8.json` | SBC, MAC, RDM, SDR, MSC capacity, MFC, MSC adjustment factors | `config/supply/ny.ced.psc10.yaml` + `config/tariff_db/.../statements` |
| `msc_sc8.json` | Observed MSC $/kWh per calendar day (codes 008CNV / 008TOD, zones J/H/I, all / on / off peak), 12 months to 2026-08 | MSC lookup dataset vintage 2026-09-25 |
| `lbmp_{J,H,I}.json` | NYISO day-ahead hourly LBMP on the model year | `data/lbmp/<zone>.csv` (2025-07 to 2026-06) |
| `programs.json` | CSRP / DLRP / Term-DLM terms and the 83-network table | `config/programs/ny.ced.psc10.yaml` |
| `profiles/*.json` | Four synthetic multifamily profiles | `scripts/make_profiles.mjs` (seeded) |

Regenerate with the reference engine's virtualenv:

```sh
<engine-repo>/.venv/bin/python scripts/export_data.py --source <engine-repo>
node scripts/make_profiles.mjs
```

## Defaults decided with the owner (2026-10-08)

- 15-minute billing demand (Con Edison default); 30-minute available.
- Rate II defaults supply to Rider M hourly pricing (the 008TOD MSC series
  is the Rider M exempt case and stays selectable).
- MSC adjustment factors are included at the statement value for the supply
  mode and region (editable).
- On concurrent CSRP and DLRP event hours the same relief earns performance
  under both programs.
- Import only (no export, no Rider R / standby).
- Single editable tax/surcharge percentage (2.5%).

## Next version (planned)

- Multi-year cash flow: battery capacity fade, utility rate escalation,
  augmentation capex, NPV / IRR / payback.

## Known simplifications

- The MSC capacity charge and the Rider M ICAP tag are one monthly statement
  value applied to every month's maximum demand (the real charge varies by
  month and the tag by the customer's coincident-peak demand).
- MSC adjustment factors are one monthly reconciliation value applied all year.
- Delivery statements not compiled upstream (CES delivery surcharge, DLM
  surcharge, EV make-ready, arrears recovery) are not in the default
  adjustment; add them to the $/kWh override.
- Taxes are a single editable percentage (default 2.5%); residential
  redistribution is sales-tax exempt.
- Program baselines are the no-battery meter, not Con Edison's CBL; event
  days are chosen with perfect price foresight.
- No export, no Rider R / Value Stack, no standby (Rate IV / V) rates, no
  reactive charges, no minimum charges, single year, no degradation or
  escalation.
