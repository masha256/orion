#!/usr/bin/env python3
"""Check an `orion agent run lit --type disclosure --dry-run --json` result against spec 11.3 (criteria 1-5).

Also takes `orion agent runs show <id> --json` output (spec 15, ruling 19). The watcher's ingest writes the run result
to --run-json (default transcripts/<asset>/<post_id>.run.json; on a dry run, next to --queue-file).

Usage: check_acceptance.py <run.json>
Prints one PASS or FAIL line per criterion; exit 0 when all five pass, else 1 (2 on unreadable input).
The scratch DB row-count half of criterion 5 is not in the run JSON: it is printed as a NOTE to check by hand.
"""
import json
import re
import sys

TRANCHES_PATH = ["metrics", "unlocks_next_year", "source", "params", "tranches"]
TRANCHES_VALUE = {"first": "2027-01-29", "every_months": 1, "count": 36}
LOCATOR_RANGE = (12 * 60 + 20, 12 * 60 + 55)  # 12:20..12:55, inclusive

_AMOUNT = re.compile(r"\$?\s*(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(m\b|mn\b|million\b|k\b|thousand\b|b\b|billion\b)?",
                     re.I)
_SCALE = {"m": 1e6, "mn": 1e6, "million": 1e6, "k": 1e3, "thousand": 1e3, "b": 1e9, "billion": 1e9}


def amounts(text):
    """Every number in the text, with M/million/k/B scales applied (7,410,898 / $7.41M / 7.41 million -> 7.41e6)."""
    out = []
    for num, scale in _AMOUNT.findall(text or ""):
        out.append(float(num.replace(",", "")) * _SCALE.get(scale.lower(), 1) if scale else float(num.replace(",", "")))
    return out


def has_amount(text, lo, hi):
    return any(lo <= v <= hi for v in amounts(text))


def locator_seconds(loc):
    m = re.search(r"(\d{1,3}):(\d{2})", str(loc or ""))
    return int(m.group(1)) * 60 + int(m.group(2)) if m else None


def finding_text(f):
    return " ".join(str(f.get(k) or "") for k in ("title", "claim", "orionReading", "proposedFix"))


def first_pass(candidates, judge, none_reason):
    """'At least one' semantics: (True, why) for the first candidate the judge passes; else the first candidate's
    failure reason, or none_reason when no candidate was judged at all. judge(c) -> None (not a candidate) or
    (ok, why)."""
    first_fail = None
    for c in candidates:
        verdict = judge(c)
        if verdict is None:
            continue
        if verdict[0]:
            return verdict
        first_fail = first_fail or verdict
    return first_fail or (False, none_reason)


def criterion_1(result, doc_source):
    def judge(p):
        change = p.get("change") or {}
        if change.get("kind") != "config":
            return None
        if not any(isinstance(e, dict) and e.get("path") == TRANCHES_PATH and e.get("value") == TRANCHES_VALUE
                   for e in change.get("edits") or []):
            return None
        cites = [c for c in p.get("citations") or []
                 if (doc_source is None and str(c.get("source", "")).startswith("doc:")) or c.get("source") == doc_source]
        if not any(LOCATOR_RANGE[0] <= (locator_seconds(c.get("locator")) or -1) <= LOCATOR_RANGE[1] for c in cites):
            return False, "a tranches config proposal exists but cites the document at no locator in 12:20-12:55"
        effect = p.get("effect") or {}
        for h in ("6m", "12m"):
            e = effect.get(h)
            if not isinstance(e, dict) or e.get("from") != e.get("to"):
                return False, f"the tranches proposal's {h} effect is not from == to ({e})"
        return True, "config proposal sets tranches " + json.dumps(TRANCHES_VALUE) + ", cited in 12:20-12:55, effect from == to"
    return first_pass(result["staged"].get("proposals") or [], judge,
                      "no staged config proposal edits " + ".".join(TRANCHES_PATH) + " = " + json.dumps(TRANCHES_VALUE))


def criterion_2(result):
    def judge(f):
        if f.get("category") != "holder_flow" or "flow_usd.buyback" not in (f.get("metricKeys") or []):
            return None
        if not re.search(r"robinhood", finding_text(f), re.I):
            return False, "the holder_flow finding does not mention Robinhood"
        reading = f.get("orionReading") or ""
        if not has_amount(reading, 7.36e6, 7.46e6):
            return False, "orion_reading does not carry Orion's Q3 buys (~7.41M)"
        if not (has_amount(reading, 8.45e6, 8.55e6) or has_amount(reading, 0.9e6, 1.2e6)):
            return False, "orion_reading does not set the buys against the disclosed 8.5M (or the ~1M Robinhood share)"
        return True, "holder_flow finding on flow_usd.buyback, Robinhood, ~7.41M against the disclosed figure"
    return first_pass(result["staged"].get("devFindings") or [], judge,
                      "no dev finding with category holder_flow and metric flow_usd.buyback")


def criterion_3(result):
    def judge(f):
        if f.get("category") not in ("revenue", "source") or "flow_usd.llama_revenue" not in (f.get("metricKeys") or []):
            return None
        text = finding_text(f)
        if not (re.search(r"defillama", text, re.I) and re.search(r"robinhood", text, re.I)):
            return False, "the revenue/source finding does not mention both DefiLlama and Robinhood"
        reading = f.get("orionReading") or ""
        if not (has_amount(reading, 9.80e6, 9.90e6) and has_amount(reading, 8.45e6, 8.55e6)):
            return False, "orion_reading does not carry DefiLlama's Q3 (~9.85M) against 8.5M"
        return True, f"{f.get('category')} finding on flow_usd.llama_revenue, DefiLlama and Robinhood, ~9.85M against 8.5M"
    return first_pass(result["staged"].get("devFindings") or [], judge,
                      "no dev finding with category revenue or source and metric flow_usd.llama_revenue")


def criterion_4(result):
    cats = ((result["staged"].get("journal") or {}).get("catalysts")) or []
    missing = []
    if not any(re.search(r"CFTC|DCM|DCO", c.get("event") or "", re.I) and str(c.get("from") or "").startswith("2026-11")
               and "2027-04-30" <= str(c.get("to") or "") <= "2027-05-29" for c in cats):
        missing.append("CFTC DCM/DCO with from in 2026-11 and to in 2027-04-30..2027-05-29")
    if not any(re.search(r"option", c.get("event") or "", re.I) and c.get("by") and str(c["by"]) <= "2026-12-31"
               for c in cats):
        missing.append("vanilla options by <= 2026-12-31")
    if not any(re.search(r"EVM|mainnet", c.get("event") or "", re.I) and c.get("by") and str(c["by"]) <= "2026-12-31"
               for c in cats):
        missing.append("EVM mainnet by <= 2026-12-31")
    if missing:
        return False, "missing catalyst(s): " + "; ".join(missing)
    return True, "CFTC, options and EVM mainnet catalysts with the expected dates"


def criterion_5(result):
    run = result.get("run") or {}
    problems = []
    if result["staged"].get("assumptionChanges"):
        problems.append(f"{len(result['staged']['assumptionChanges'])} staged assumption change(s)")
    if run.get("outcome") != "completed":
        problems.append(f"outcome {run.get('outcome')}")
    if run.get("dryRun") is not True:
        problems.append("not a dry run")
    if problems:
        return False, "; ".join(problems)
    return True, "no staged assumption change, outcome completed, dry run"


def normalize(result):
    """The `agent run --json` shape ({run, staged, ...}) as is; the `agent runs show <id> --json` shape (the run row,
    no top-level staged) as {run: result, staged: result.summary.staged}."""
    if isinstance(result, dict) and "staged" not in result and isinstance(result.get("summary"), dict):
        return {"run": result, "staged": result["summary"].get("staged")}
    return result


def check(result):
    """-> (all passed, output lines). Takes either shape (see normalize)."""
    result = normalize(result)
    if not isinstance(result, dict) or not isinstance(result.get("staged"), dict):
        err = result.get("error") if isinstance(result, dict) else None
        return False, [f"FAIL criterion {n}: no staged output in the run JSON ({err})" for n in range(1, 6)]
    doc_id = ((result.get("run") or {}).get("triggerDetail") or {}).get("docId")
    doc_source = f"doc:{doc_id}" if doc_id is not None else None
    results = [criterion_1(result, doc_source), criterion_2(result), criterion_3(result), criterion_4(result),
               criterion_5(result)]
    lines = [f"{'PASS' if ok else 'FAIL'} criterion {n}: {why}" for n, (ok, why) in enumerate(results, 1)]
    lines.append("NOTE criterion 5: scratch DB row counts (only agent_runs, agent_transcripts, documents may change) "
                 "are not in the run JSON; compare them by hand")
    staged = result["staged"]
    lines.append(f"INFO staged: {len(staged.get('proposals') or [])} proposal(s), "
                 f"{len(staged.get('devFindings') or [])} dev finding(s), "
                 f"{len((staged.get('journal') or {}).get('catalysts') or [])} catalyst(s)")
    return all(ok for ok, _ in results), lines


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if len(argv) != 1:
        print("usage: check_acceptance.py <run.json>", file=sys.stderr)
        return 2
    try:
        with open(argv[0], encoding="utf-8") as f:
            result = json.load(f)
    except (OSError, ValueError) as e:
        print(f"check_acceptance.py: cannot read {argv[0]}: {e}", file=sys.stderr)
        return 2
    ok, lines = check(result)
    print("\n".join(lines))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
