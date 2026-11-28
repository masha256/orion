#!/usr/bin/python3
r"""DEV-ONLY acceptance check of Phase 3 R4 (spec sections 1 and 9): AERO's on-chain holders figure against DefiLlama's
holders revenue, per UTC day, from two SAVED files. It never fetches anything and nothing in Orion runs it: DefiLlama is
a dev-time reference only (Phase 3: no live DefiLlama / CoinGecko in src/). Stdlib only.

    r4_acceptance.py <orion json> <defillama json> --dl-stamp start|end [--to YYYY-MM-DD] [--tolerance 0.03] [--json]
    r4_acceptance.py --print-sql      the sql-ro query whose saved result is an accepted <orion json>

Per day d from 2026-10-23 to D: orion(d) = flow_usd.voter_fees + flow_usd.vote_incentives + flow_usd.protocol_subsidy
(allocator fees + allocator-earned incentives, both classes), gap = orion / dl - 1. FAIL when |gap| > tolerance (3%) on
any day, or when a day in 2026-10-23..D lacks a figure on either side. 2026-10-22 is shown and exempt (DefiLlama had no
price for the new AERO on the launch day). D = --to, else the last day all three Orion metrics hold.

<orion json>, rows only (a `report yield` JSON carries window totals, not days, and is refused):
- `data show aero --json` (over ssh: `data show aero <metric>` once per metric, or all metrics at once): active
  observations; a one-day flow row stamped observedAt covers the UTC day before it (src/ingest/apiFlow.ts);
- a saved `sql-ro` result of --print-sql (`{"rows": [{"metric_key", "day", "value"}]}`, `day` = the covered day);
- `{"<metric>": {"YYYY-MM-DD": value}}` keyed by the covered day.
<defillama json>, a saved dev-only download of DefiLlama's daily holders revenue for Aero (e.g. its
`summary/fees/<slug>?dataType=dailyHoldersRevenue` reply): `{"totalDataChart": [[unix s, value], ...]}`, a bare list of
`[unix s, value]` pairs, or `{"YYYY-MM-DD": value}`. --dl-stamp is REQUIRED (no default: a wrong one shifts every day by
one and fails falsely):
- `start` for a raw api.llama.fi summary chart download: the row stamped D covers day D (measured by the R4 scoping on
  the `aero-protocol` chart: Ink 11-01 tape $788 vs row 11-01 $787 vs row 11-02 $2,295);
- `end` for Orion's own stored DefiLlama rows (`flow_usd.fees`, or the R4 purge export of them): the row stamped D+1
  covers day D (a daily flow row is stamped at the end of its day).

Exit 0 pass, 1 fail, 2 bad input.
"""
import argparse
import datetime
import json
import sys

FIRST = "2026-10-23"
EXEMPT = ("2026-10-22",)
METRICS = ("flow_usd.voter_fees", "flow_usd.vote_incentives", "flow_usd.protocol_subsidy")
TOLERANCE = 0.03
SQL = ("select metric_key, to_char((observed_at - interval $$1 day$$) at time zone $$UTC$$, $$YYYY-MM-DD$$) as day, "
       "value from observations where asset_id = $$aero$$ and metric_key in ("
       + ", ".join(f"$${m}$$" for m in METRICS)
       + ") and period_days = 1 and superseded_by is null and status <> $$rejected$$ order by 1, 2")


class Bad(Exception):
    pass


def day_add(d, n):
    return (datetime.date.fromisoformat(d) + datetime.timedelta(days=n)).isoformat()


def is_day(s):
    try:
        datetime.date.fromisoformat(s)
        return isinstance(s, str) and len(s) == 10
    except (TypeError, ValueError):
        return False


def put(out, metric, day, value, where):
    if metric not in out:
        return
    if not is_day(day):
        raise Bad(f"{where}: bad day {day!r}")
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        raise Bad(f"{where}: {metric} {day}: value {value!r} is not a number")
    if day in out[metric]:
        raise Bad(f"{where}: two rows of {metric} for {day} (save active rows only)")
    out[metric][day] = float(value)


def orion_days(doc, where):
    """{metric: {covered day: value}} for the three METRICS."""
    out = {m: {} for m in METRICS}
    if isinstance(doc, dict) and ("incomeStatement" in doc or "windowDays" in doc):
        raise Bad(f"{where}: a report carries window totals, not per-day values: save rows (`data show aero --json` or "
                  f"the --print-sql result)")
    if isinstance(doc, dict) and isinstance(doc.get("rows"), list):
        for r in doc["rows"]:
            put(out, r.get("metric_key"), r.get("day"), r.get("value"), where)
    elif isinstance(doc, list):
        for o in doc:
            if not isinstance(o, dict) or "metricKey" not in o or "observedAt" not in o:
                raise Bad(f"{where}: a list entry is not an observation ({json.dumps(o)[:120]})")
            if o["metricKey"] not in out:
                continue
            if o.get("supersededBy") is not None or o.get("status") == "rejected":
                continue
            if o.get("periodDays") != 1:
                raise Bad(f"{where}: {o['metricKey']} row {o.get('id')} is not a one-day row (periodDays {o.get('periodDays')})")
            stamp = datetime.datetime.fromisoformat(o["observedAt"].replace("Z", "+00:00")).astimezone(datetime.timezone.utc)
            put(out, o["metricKey"], (stamp - datetime.timedelta(days=1)).date().isoformat(), o.get("value"), where)
    elif isinstance(doc, dict) and any(k in METRICS for k in doc):
        for m, byday in doc.items():
            if m in out:
                if not isinstance(byday, dict):
                    raise Bad(f"{where}: {m} is not a {{day: value}} map")
                for d, v in byday.items():
                    put(out, m, d, v, where)
    else:
        raise Bad(f"{where}: not Orion rows (data show JSON, a sql-ro result or {{metric: {{day: value}}}})")
    return out


def dl_days(doc, stamp, where):
    """{covered day: value}. stamp `end`: a row stamped D+1 covers D; `start`: stamped D covers D."""
    shift = -1 if stamp == "end" else 0
    out = {}

    def add(stamp_day, v):
        d = day_add(stamp_day, shift)
        if not isinstance(v, (int, float)) or isinstance(v, bool):
            raise Bad(f"{where}: {stamp_day}: value {v!r} is not a number")
        if d in out:
            raise Bad(f"{where}: two rows cover {d}")
        out[d] = float(v)

    pairs = doc.get("totalDataChart") if isinstance(doc, dict) and "totalDataChart" in doc else doc
    if isinstance(pairs, list):
        for p in pairs:
            if not (isinstance(p, list) and len(p) == 2 and isinstance(p[0], (int, float))):
                raise Bad(f"{where}: a chart row is not [unix seconds, value] ({json.dumps(p)[:80]})")
            t = datetime.datetime.fromtimestamp(p[0], datetime.timezone.utc)
            if (t.hour, t.minute, t.second) != (0, 0, 0):
                raise Bad(f"{where}: chart row {p[0]} is not at 00:00 UTC")
            add(t.date().isoformat(), p[1])
    elif isinstance(doc, dict) and doc and all(is_day(k) for k in doc):
        for k, v in doc.items():
            add(k, v)
    else:
        raise Bad(f"{where}: not a DefiLlama chart ({{totalDataChart: [[ts, v]]}}, [[ts, v]] or {{day: value}})")
    return out


def compare(orion, dl, to=None, tolerance=TOLERANCE):
    full = sorted(set.intersection(*(set(orion[m]) for m in METRICS)))
    if to is None:
        if not full:
            raise Bad("the Orion file holds no day with all three metrics")
        to = full[-1]
    if to < FIRST:
        raise Bad(f"--to {to} is before {FIRST}")
    days = []
    d = EXEMPT[0]
    while d <= to:
        days.append(d)
        d = day_add(d, 1)
    rows, fails = [], 0
    for d in days:
        parts = {m: orion[m].get(d) for m in METRICS}
        ref = dl.get(d)
        exempt = d in EXEMPT
        if any(v is None for v in parts.values()) or ref is None:
            what = [m for m, v in parts.items() if v is None] + ([] if ref is not None else ["defillama"])
            status = "exempt" if exempt else "FAIL"
            rows.append({"day": d, **{m: parts[m] for m in METRICS}, "orion": None, "dl": ref, "gap": None, "status": status,
                         "note": "missing " + ", ".join(what)})
            fails += status == "FAIL"
            continue
        total = sum(parts.values())
        gap = None if ref == 0 else total / ref - 1
        ok = gap is not None and abs(gap) <= tolerance + 1e-12  # 103 / 100 - 1 is 0.030000000000000027
        status = "exempt" if exempt else ("ok" if ok else "FAIL")
        fails += status == "FAIL"
        rows.append({"day": d, **parts, "orion": total, "dl": ref, "gap": gap, "status": status,
                     "note": "defillama 0" if ref == 0 else ""})
    return {"from": FIRST, "to": to, "tolerance": tolerance, "days": rows, "fails": fails,
            "maxAbsGap": max((abs(r["gap"]) for r in rows if r["gap"] is not None and r["status"] != "exempt"), default=None)}


def fmt(v):
    return "-" if v is None else f"{v:,.0f}"


def main(argv):
    ap = argparse.ArgumentParser(description="DEV-ONLY: AERO on-chain holders figure vs DefiLlama holders revenue (saved files)")
    ap.add_argument("orion", nargs="?")
    ap.add_argument("defillama", nargs="?")
    ap.add_argument("--to")
    ap.add_argument("--dl-stamp", choices=("start", "end"),
                    help="REQUIRED: start = raw api.llama.fi chart (stamp D covers D); end = Orion's stored DefiLlama rows / the prod export (stamp D+1 covers D)")
    ap.add_argument("--tolerance", type=float, default=TOLERANCE)
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--print-sql", action="store_true")
    a = ap.parse_args(argv)
    if a.print_sql:
        print(SQL)
        return 0
    if not a.orion or not a.defillama:
        ap.print_usage(sys.stderr)
        return 2
    if a.dl_stamp is None:
        ap.error("--dl-stamp is required: start = a raw api.llama.fi chart (the row stamped D covers day D); "
                 "end = Orion's stored DefiLlama rows or the prod purge export (the row stamped D+1 covers day D)")
    try:
        if a.to is not None and not is_day(a.to):
            raise Bad(f"--to {a.to!r} is not YYYY-MM-DD")
        docs = []
        for p in (a.orion, a.defillama):
            try:
                with open(p) as f:
                    docs.append(json.load(f))
            except (OSError, ValueError) as e:
                raise Bad(f"{p}: not readable JSON ({e})")
        r = compare(orion_days(docs[0], a.orion), dl_days(docs[1], a.dl_stamp, a.defillama), a.to, a.tolerance)
    except Bad as e:
        print(f"BAD INPUT: {e}", file=sys.stderr)
        return 2
    if a.json:
        print(json.dumps(r, indent=1))
    else:
        print(f"DEV-ONLY R4 acceptance: voter_fees + vote_incentives + protocol_subsidy vs DefiLlama holders revenue "
              f"(--dl-stamp {a.dl_stamp}), |gap| <= {a.tolerance:.1%}, {r['from']}..{r['to']} (2026-10-22 exempt)")
        print(f"{'day':10}  {'voter_fees':>10}  {'vote_inc':>9}  {'subsidy':>9}  {'orion':>10}  {'defillama':>10}  {'gap':>7}  status")
        for x in r["days"]:
            gap = "-" if x["gap"] is None else f"{x['gap']:+.2%}"
            print(f"{x['day']:10}  {fmt(x[METRICS[0]]):>10}  {fmt(x[METRICS[1]]):>9}  {fmt(x[METRICS[2]]):>9}  "
                  f"{fmt(x['orion']):>10}  {fmt(x['dl']):>10}  {gap:>7}  {x['status']}{('  ' + x['note']) if x['note'] else ''}")
        mx = "-" if r["maxAbsGap"] is None else f"{r['maxAbsGap']:.2%}"
        print(f"{'PASS' if r['fails'] == 0 else 'FAIL'}: {r['fails']} failing day(s), max |gap| {mx}")
    return 0 if r["fails"] == 0 else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
