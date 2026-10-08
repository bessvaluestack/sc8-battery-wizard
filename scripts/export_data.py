#!/usr/bin/env python
"""One-time exporter: pull the Con Edison SC 8 inputs out of the reference
engine's repo (the upstream tariff model) into plain JSON files this
static app can fetch.

    <engine-repo>/.venv/bin/python scripts/export_data.py --source <engine-repo>

Writes into data/:
  tariffs_sc8.json    the six compiled SC 8 schedules (Rate I/II/III x LT/HT)
  statements_sc8.json surcharges + utility supply components (SBC, MAC, RDM,
                      SDR, MSC capacity, MFC, MSC adjustment factors)
  msc_sc8.json        observed Market Supply Charge, daily $/kWh laid onto
                      the model year (codes 008CNV / 008TOD, zones J/H/I,
                      windows all / on_peak / off_peak)
  lbmp_<Z>.json       NYISO day-ahead zonal LBMP, 8,760 hourly $/MWh on the
                      model year, zones J, H, I
  programs.json       Rider T (CSRP / DLRP) and Rider AC (Term-DLM) terms +
                      the network table (Contracted Hours, DLRP tier, group)

Every file records its provenance (book vintage, dataset vintage, source
file) so the app can print it next to the numbers.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE.parent / "data"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", required=True, help="path to the reference engine repo")
    args = ap.parse_args()
    repo = Path(args.source).resolve()
    if not (repo / "app").is_dir():
        sys.exit(f"reference engine repo not found at {repo}")
    sys.path.insert(0, str(repo))
    import os
    os.chdir(repo)  # app.config resolves config/ relative to the repo

    import numpy as np
    import pandas as pd
    import yaml

    from app.tariffs.msc_lookup import daily_mean, load_series, load_vintage, onto_model_year
    from app.tariffs.vder import load_lbmp
    from app.timeidx import year_index

    OUT.mkdir(parents=True, exist_ok=True)

    # ---- tariffs ---------------------------------------------------------
    tariffs = {}
    for f in sorted((repo / "config" / "tariffs").glob("corpus_ced_sc8_rate[123]_*.yaml")):
        t = yaml.safe_load(f.read_text())
        tariffs[t["id"]] = {
            "id": t["id"], "name": t["name"], "service_class": t["service_class"],
            "applicability": t.get("applicability"), "rate_basis": t.get("rate_basis"),
            "fixed_charge_per_month": t.get("fixed_charge_per_month", 0.0),
            "energy": t["energy"], "demand": t.get("demand"),
            "book_vintage": t.get("book_vintage"), "conversion_notes": t.get("conversion_notes"),
            "unmodelled": t.get("unmodelled"), "lineage": t.get("lineage"),
            "source_file": f"config/tariffs/{f.name}",
        }
    (OUT / "tariffs_sc8.json").write_text(json.dumps(tariffs, indent=1))
    print("tariffs:", list(tariffs))

    # ---- statements ------------------------------------------------------
    sup = yaml.safe_load((repo / "config" / "supply" / "ny.ced.psc10.yaml").read_text())
    st = sup["statements"]

    def pick(kind: str, key: str) -> float | None:
        for e in st.get(kind) or []:
            if e.get("key") == key:
                return float(e["value"])
        return None

    S = repo / "config" / "tariff_db" / "ny" / "ced" / "statements" / "ny.ced.psc10"

    def stmt_rows(code: str) -> tuple[dict, list[dict]]:
        f = sorted((S / code).glob("*.json"))[-1]
        d = json.loads(f.read_text())
        s = (d.get("statements") or [{}])[0]
        return {"file": f.name, "name": s.get("name"), "effective": s.get("effective")}, s.get("rows") or []

    def row_value(rows: list[dict], id_suffix: str) -> float | None:
        for r in rows:
            if str(r.get("id", "")).endswith(id_suffix):
                return float(r["rate"]["value"])
        return None

    sbc_meta, sbc_rows = stmt_rows("SBC")
    rdm_meta, rdm_rows = stmt_rows("RDM")
    sdr_meta, sdr_rows = stmt_rows("SDR")
    mac_meta, mac_rows = stmt_rows("MAC")
    macadj_meta, macadj_rows = stmt_rows("MAC_ADJ")

    statements = {
        "book_vintage": sup.get("book_vintage"), "in_force_on": sup.get("in_force_on"),
        "status": sup.get("status"),
        "delivery_adjustments_usd_per_kwh": {
            "sbc_total_nyserda": {"value": row_value(sbc_rows, "total_nyserda_sbc_surcharge.kwh"),
                                   "statement": sbc_meta, "applies": "all SCs"},
            "mac": {"value": row_value(mac_rows, "all_except_sc_11.kwh"), "statement": mac_meta,
                    "applies": "all except SC 11"},
            "mac_adjustment_factor": {"value": row_value(macadj_rows, "mac_adj.all.kwh"),
                                      "statement": macadj_meta, "applies": "all"},
            "rdm_sc8": {"value": row_value(rdm_rows, "rdm.sc_8.kwh"), "statement": rdm_meta,
                        "applies": "SC 8"},
            "sdr_sc8_rates_i_ii_iii": {"value": row_value(sdr_rows, "sc_8_rates_i_ii_and_iii.kwh"),
                                       "statement": sdr_meta, "applies": "SC 8 Rates I, II, III"},
        },
        "delivery_adjustments_usd_per_kw_month": {
            "sbc_sc8_rate_i_monthly_max": {"value": row_value(sbc_rows, "sc_8_rate_i.monthly_max_demand_kw.n3"),
                                            "statement": sbc_meta, "determinant": "monthly_max_demand_kw"},
            "sbc_sc8_rates_ii_iii_tod": {"value": row_value(sbc_rows, "sc_8_rates_ii_and_iii.total.tod_demand_kw"),
                                          "statement": sbc_meta, "determinant": "tod_demand_kw",
                                          "window": {"days": "weekdays", "hours": [8, 22], "months": list(range(1, 13))}},
        },
        "msc_capacity_usd_per_kw_month": {
            "note": "Statement of Market Supply Charge - Capacity (one monthly statement, not a 12-month profile); billed on the monthly maximum demand of full-service customers",
            "nyc": {"rate1": pick("MSC CAP", "sc8_rate_i_nyc"), "rate2": pick("MSC CAP", "sc8_rate_ii_nyc"),
                    "rate3": pick("MSC CAP", "sc8_rate_iii_nyc"), "rider_m_icap_tag": pick("MSC CAP", "rider_m_icap_tag_nyc")},
            "westchester": {"rate1": pick("MSC CAP", "sc8_rate_i_westchester"), "rate2": pick("MSC CAP", "sc8_rate_ii_westchester"),
                            "rate3": pick("MSC CAP", "sc8_rate_iii_westchester"),
                            "rider_m_icap_tag": pick("MSC CAP", "rider_m_icap_tag_westchester")},
        },
        "merchant_function_charge_usd_per_kwh": {
            "scs5_6_8_9_12_13_total": pick("MFC", "scs5_6_8_9_12_13_total_merchant_function_charge_all"),
            "components": {
                "supply_related": pick("MFC", "scs5_6_8_9_12_13_supply_related_charge_all"),
                "credit_and_collection": pick("MFC", "scs5_6_8_9_12_13_credit_and_collection_related_charge_all"),
                "uncollectible_bill_expense": pick("MFC", "scs5_6_8_9_12_13_uncollectible_bill_expense_msc_all"),
                "transition_adjustment": pick("MFC", "scs5_6_8_9_12_13_transition_adjustment_all"),
            },
        },
        "msc_adjustment_factors_usd_per_kwh": {
            "note": "Statement of Adjustment Factors - MSC: month-specific reconciliation factors; the app defaults them to zero and shows these values",
            "reconciliation_all_other_nonresidential": {"nyc": pick("MSC ADJ", "msc_reconciliation_all_other_nonresidential_nyc"),
                                                         "westchester": pick("MSC ADJ", "msc_reconciliation_all_other_nonresidential_westchester")},
            "reconciliation_rider_m_nonresidential": {"nyc": pick("MSC ADJ", "msc_reconciliation_rider_m_nonresidential_nyc"),
                                                       "westchester": pick("MSC ADJ", "msc_reconciliation_rider_m_nonresidential_westchester")},
            "tax_reimbursement_recovery_nonresidential": pick("MSC ADJ", "tax_reimbursement_recovery_provision_nonresidential_nyc"),
        },
        "indexed_not_compiled": sup.get("indexed_not_compiled"),
    }
    (OUT / "statements_sc8.json").write_text(json.dumps(statements, indent=1))
    print("statements written")

    # ---- MSC lookup (daily) ---------------------------------------------
    vin = load_vintage()
    if vin is None:
        sys.exit("no MSC vintage vendored in the reference engine")
    daily_idx = year_index(interval_min=1440)
    msc = {"vintage": vin["vintage"], "document_id": vin["manifest"].get("document_id"),
           "date_range": vin["manifest"].get("date_range"), "lookback_months": 12,
           "model_year_days": len(daily_idx), "codes": {}}
    for code in ("008CNV", "008TOD"):
        series = load_series(vin["dir"], code)
        zones = {}
        for zone in ("J", "H", "I"):
            zd = (series.get("zones") or {}).get(zone) or {}
            wins = {}
            info_any = None
            for win in ("all", "on_peak", "off_peak"):
                entries = (zd.get(win) or {}).get("lt") or []
                dm, info = daily_mean(entries, lookback_months=12, max_period_days=35)
                info_any = info
                wins[win] = [round(float(x), 6) for x in onto_model_year(dm, daily_idx)]
            zones[zone] = {"windows": wins, "lookback": {k: info_any.get(k) for k in ("from", "to", "periods")}}
        msc["codes"][code] = {"description": vin["codes"][code]["description"], "zones": zones}
    (OUT / "msc_sc8.json").write_text(json.dumps(msc))
    print("msc written")

    # ---- LBMP (hourly, model year) --------------------------------------
    hidx = year_index(interval_min=60)
    for zone in ("J", "H", "I"):
        vals, source = load_lbmp(zone, hidx)
        src_file = repo / "data" / "lbmp" / f"{zone}.csv"
        span = None
        if src_file.exists():
            df = pd.read_csv(src_file)
            span = [str(df.iloc[0, 0]), str(df.iloc[-1, 0])]
        (OUT / f"lbmp_{zone}.json").write_text(json.dumps({
            "zone": zone, "source": source, "source_span": span, "units": "usd_per_mwh",
            "model_year": int(hidx[0].year), "hourly": [round(float(v), 2) for v in vals]}))
        print("lbmp", zone, source, span, "avg", round(float(np.mean(vals)), 2))

    # ---- programs + networks --------------------------------------------
    pg = yaml.safe_load((repo / "config" / "programs" / "ny.ced.psc10.yaml").read_text())
    keep = ("name", "rider", "option", "season", "days", "exclude_holidays", "min_kw", "events",
            "rates_in_tariff", "reservation_rate_key", "reservation_rates", "performance_rates",
            "performance_factor_initial")
    programs = {"book_vintage": pg.get("book_vintage"), "status": pg.get("status"),
                "in_force_on": pg.get("in_force_on"),
                "programs": {k: {kk: v.get(kk) for kk in keep} for k, v in pg["programs"].items()
                             if k in ("csrp", "dlrp", "term_dlm", "auto_dlm")},
                "networks": pg["networks"], "networks_source": pg.get("networks_source"),
                "notes": pg.get("notes")}
    (OUT / "programs.json").write_text(json.dumps(programs, indent=1))
    print("programs written:", len(pg["networks"]), "networks")


if __name__ == "__main__":
    main()
