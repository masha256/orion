#!/usr/bin/python3
"""The Reclassification Table's expected v2 figures, computed from the OLD release's `report yield --json` outputs.

    expected.py <out>/old [--ycrv-styc-separate] [-o <file>]

Reads <old>/sdcrv.json, <old>/ycrv.json and <old>/lit.json (HolderYieldReport, src/report/holderYield.ts) and writes
{"<asset>": {"<dotted v2 path>": value}} to <old>/../expected.json (or -o), the file `compare.py --reclass` reads.
The formulas are the plan's Reclassification Table (global constraints), as written:

  sdCRV revenue             = income.revenue.annualized - income line vote_incentives (flow_usd.bribes)
  sdCRV belowLine.toHolders = income line vote_incentives
  sdCRV operatingCosts      = income line boost_delegators (v1 cost)
  sdCRV ratios.payoutRatio  = (income line vecrv_fees + income line crv_fee_share) / sdCRV revenue
  yCRV revenue              = volume.annualized (flow_usd.yearn_gross)
                              [+ income line styc_fee (flow_usd.yearn_styc_fee) with --ycrv-styc-separate]
  yCRV unreconciled         = yCRV revenue - income line ybs_payout - income line treasury
                              [- income line styc_fee with --ycrv-styc-separate]
                              Ruling R6 (ycrv-styc-probe.md): by default the st-yCRV fee has no revenue, holders or
                              protocol line in v2, so it is never subtracted (v1 income.protocol includes it).
  LIT revenue               = revenue.annualized + (robinhood stream grossAnnualized - annualized)
  LIT costOfRevenue         = robinhood stream grossAnnualized * 0.5
  LIT grossProfit           = revenue.annualized (v1)

Refuses (exit 1, nothing written) when an input is missing, null or ambiguous.
"""
import argparse
import json
import sys
from pathlib import Path

# yCRV's income lines (assets/ycrv.yaml reporting.income.lines): flow_usd.fees, flow_usd.yearn_revenue and
# flow_usd.yearn_styc_fee.
YCRV_HOLDERS_LINE = "ybs_payout"
YCRV_TREASURY_LINE = "treasury"
YCRV_STYC_LINE = "styc_fee"
ROBINHOOD_SHARE = 0.5


class ExpectedError(Exception):
    pass


def num(value, what):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ExpectedError(f"{what} is {json.dumps(value)}, not a number")
    return value


def load(old, asset):
    p = Path(old) / f"{asset}.json"
    try:
        text = p.read_text()
    except OSError as e:
        raise ExpectedError(f"{p}: unreadable ({e.strerror})") from None
    if not text.strip():
        raise ExpectedError(f"{p}: empty")
    try:
        obj = json.loads(text)
    except json.JSONDecodeError as e:
        raise ExpectedError(f"{p}: unparseable ({e})") from None
    if not isinstance(obj, dict):
        raise ExpectedError(f"{p}: not a report object")
    return obj


def block(obj, key, asset):
    b = obj.get(key)
    if not isinstance(b, dict):
        raise ExpectedError(f"{asset}: `{key}` is {json.dumps(b)[:60]}, not an object")
    return b


def total(obj, key, asset):
    """obj[key].annualized for a block, or obj.income[key].annualized when key is an income total."""
    return num(block(obj, key, asset).get("annualized"), f"{asset} {key}.annualized")


def one(items, id_, what):
    found = [x for x in items if isinstance(x, dict) and x.get("id") == id_]
    if len(found) != 1:
        raise ExpectedError(f"{what}: {len(found)} entries with id {id_!r}, need exactly 1")
    return found[0]


def income_line(obj, asset, id_):
    inc = block(obj, "income", asset)
    lines = inc.get("lines")
    if not isinstance(lines, list):
        raise ExpectedError(f"{asset}: income.lines is not a list")
    return num(one(lines, id_, f"{asset} income.lines").get("annualized"), f"{asset} income line {id_}.annualized")


def income_total(obj, asset, key):
    inc = block(obj, "income", asset)
    return total(inc, key, f"{asset} income")


def sdcrv(obj):
    a = "sdcrv"
    vote = income_line(obj, a, "vote_incentives")
    revenue = income_total(obj, a, "revenue") - vote
    if revenue == 0:
        raise ExpectedError("sdcrv: revenue less vote_incentives is 0: payoutRatio is undefined")
    holders_paid = income_line(obj, a, "vecrv_fees") + income_line(obj, a, "crv_fee_share")
    return {
        "incomeStatement.revenue.annualized": revenue,
        "incomeStatement.belowLine.toHolders": vote,
        "incomeStatement.operatingCosts.annualized": income_line(obj, a, "boost_delegators"),
        "incomeStatement.ratios.payoutRatio": holders_paid / revenue,
    }


def ycrv(obj, styc_separate):
    a = "ycrv"
    holders = income_line(obj, a, YCRV_HOLDERS_LINE)
    treasury = income_line(obj, a, YCRV_TREASURY_LINE)
    revenue = total(obj, "volume", a)
    unreconciled = revenue - holders - treasury
    if styc_separate:  # the spec alternative: styc_fee is a revenue stream and a protocol line
        styc = income_line(obj, a, YCRV_STYC_LINE)
        revenue = revenue + styc
        unreconciled = revenue - holders - treasury - styc
    return {
        "incomeStatement.revenue.annualized": revenue,
        "incomeStatement.unreconciled.annualized": unreconciled,
    }


def lit(obj):
    a = "lit"
    rev = block(obj, "revenue", a)
    v1 = num(rev.get("annualized"), "lit revenue.annualized")
    streams = rev.get("streams")
    if not isinstance(streams, list):
        raise ExpectedError("lit: revenue.streams is not a list")
    rh = one(streams, "robinhood", "lit revenue.streams")
    gross = num(rh.get("grossAnnualized"), "lit robinhood grossAnnualized")
    net = num(rh.get("annualized"), "lit robinhood annualized")
    return {
        "incomeStatement.revenue.annualized": v1 + (gross - net),
        "incomeStatement.costOfRevenue.annualized": gross * ROBINHOOD_SHARE,
        "incomeStatement.grossProfit.annualized": v1,
    }


def expected_values(old, ycrv_styc_separate=False):
    return {
        "_meta": {"source": str(Path(old).resolve()), "ycrvStycSeparate": ycrv_styc_separate},
        "sdcrv": sdcrv(load(old, "sdcrv")),
        "ycrv": ycrv(load(old, "ycrv"), ycrv_styc_separate),
        "lit": lit(load(old, "lit")),
    }


def main(argv=None):
    ap = argparse.ArgumentParser(description=(__doc__ or "").split("\n\n")[0])
    ap.add_argument("old", help="the old side's directory (<out>/old)")
    ap.add_argument("--ycrv-styc-separate", action="store_true", help="add the styc_fee line to yCRV revenue (Task 2's probe finds it a separate stream)")
    ap.add_argument("-o", "--output", help="where to write (default <old>/../expected.json)")
    args = ap.parse_args(argv)
    try:
        values = expected_values(args.old, args.ycrv_styc_separate)
    except ExpectedError as e:
        print(f"expected.py: refused: {e}", file=sys.stderr)
        return 1
    dest = Path(args.output) if args.output else Path(args.old).resolve().parent / "expected.json"
    dest.write_text(json.dumps(values, indent=2) + "\n")
    print(dest)
    return 0


if __name__ == "__main__":
    sys.exit(main())
