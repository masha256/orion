#!/usr/bin/python3
"""Writes the --fake fixtures of tools/phase3-proof/test_r3_scripts.py (the slug rule: tools/phase3-proof/r3-lib.sh).

    python3 tools/phase3-proof/fixtures/r3/generate.py      # rewrites happy/ and the stop-*/ overlays next to it

happy/ is one stage block that passes s0..s4 at R3_NOW=2026-11-20T12:00:00Z (D 2026-11-18, D-91 2026-08-19), tag
orion-2026.11.20.1, with prod's step-1 counts measured 2026-11-19 14:30Z. Each stop-*/ dir holds only the files that
replace happy's for one STOP case (the test copies happy/, then the overlay). Stdlib only.
"""
import json
import shutil
from pathlib import Path

HERE = Path(__file__).resolve().parent
ASSETS = "aero cake crv cvxcrv hype link lit pump sdcrv sky uni vvv ycrv".split()
ENV, TAG, D, D91, SINCE = "stage", "orion-2026.11.20.1", "2026-11-18", "2026-08-19", "2026-11-20T12-00-00Z"
MD = {"aero": 45, "cake": 40, "crv": 43, "hype": 55, "link": 37, "lit": 38, "pump": 37, "sky": 36, "uni": 40, "vvv": 57}
OLD = {"cvxcrv": 39, "sdcrv": 39, "ycrv": 39}
NR = {"aero": 45, "hype": 55, "pump": 37}  # notRebuildable: HYPE, PUMP all; AERO's rows before 2026-11-10
# Kept (ruling R15): VVV's active 2026-09-18 disclosure row (prod id 3, a pre-v2 seed: locator {note, legacy_seed}, kind '').
KEPT = {"vvv": [{"id": 3, "observedAt": "2026-09-18T00:00:00.000Z", "reason": "a disclosure row: only market_data and old-locator contract_state rows are rebuilt (Ruling R15)"}]}
CURRENT = {a: ("contract_state", "chain.view_sum") for a in ASSETS}
CURRENT["hype"] = ("first_party_api", "hype.circulating_supply")
CURRENT["pump"] = ("contract_state", "solana.supply_less_owners")
SIGNED = {"aero": 777906035, "cake": 315730000, "crv": 1582336065, "cvxcrv": 150000000, "hype": 237935206,
          "link": 766849970, "lit": 250000000, "pump": 403510000000, "sdcrv": 60000000, "sky": 23428082000,
          "uni": 600000000, "vvv": 49031992, "ycrv": 90000000}
LEVELS_MD = ["cake", "crv", "hype", "link", "lit", "pump", "sky", "uni", "vvv"]


def sql(rows):
    return {"rows": rows, "rowCount": len(rows)}


def supply(state):
    """sql-ro supply rows: pre (before the rebuild), rebuilt (after s2's --yes), purged (after s3's --yes)."""
    out = []
    for a in ASSETS:
        st, kind = CURRENT[a]
        cur = 10 if a == "aero" else 2  # rows on the new source (AERO's since 2026-11-10; the others' nightlies)
        out.append({"asset_id": a, "source_type": st, "kind": kind, "active": cur + (MD.get(a, 0) - NR.get(a, 0) + OLD.get(a, 0) if state != "pre" else 0), "total": cur, "before_rebuild_from": 0})
        if a in MD and state != "purged":
            active = MD[a] if state == "pre" else NR.get(a, 0)
            out.append({"asset_id": a, "source_type": "market_data", "kind": "coingecko", "active": active, "total": MD[a], "before_rebuild_from": MD[a] if a == "aero" else 0})
        if a in OLD:
            out.append({"asset_id": a, "source_type": "contract_state", "kind": "totalSupply()", "active": OLD[a] if state == "pre" else 0, "total": OLD[a], "before_rebuild_from": 0})
        if a in KEPT:  # untouched by the rebuild and the purge: the same in every state
            out.append({"asset_id": a, "source_type": "disclosure", "kind": "", "active": len(KEPT[a]), "total": len(KEPT[a]), "before_rebuild_from": 0})
    return sql(sorted(out, key=lambda r: (r["asset_id"], r["source_type"], r["kind"])))


def levels(pre):
    return sql([{"asset_id": a, "source_type": "market_data" if pre and a in LEVELS_MD else CURRENT[a][0], "value": SIGNED[a] * (1.004 if pre else 1.001)} for a in ASSETS])


def rebuild(a, phase):
    stale = MD.get(a, 0) + OLD.get(a, 0)
    nr = NR.get(a, 0)
    rows = stale if phase != "again" else nr
    rebuilt = stale - nr if phase != "again" else 0
    return {"asset": a, "applied": phase == "yes", "metric": "circulating_supply", "rows": rows, "rebuilt": rebuilt,
            "unchanged": 2, "refused": [], "notRebuildable": [{"id": 1000 + i, "observedAt": "2026-10-01T00:45:00.000Z", "day": "2026-10-01"} for i in range(nr)],
            "kept": KEPT.get(a, []), "calls": 3 * rebuilt}


def purge(a, yes):
    wr = NR.get(a, 0)
    m = {"metric": "circulating_supply", "configured": True, "observations": MD[a], "superseded": MD[a] - wr, "firstDay": "2026-09-24",
         "lastDay": "2026-11-19", "valueSum": 1.0, "latestLevels": 0, "watchState": 0, "fetchCursors": 0,
         "withoutReplacement": [{"id": 2000 + i, "observedAt": "2026-10-01T00:45:00.000Z", "day": "2026-10-01"} for i in range(wr)]}
    return {"asset": a, "perMetric": [m], "exportFile": f"/home/orion-stage/home/purged/{a}-circulating_supply-20261120T120000Z.json" if yes else None,
            "exportSha256": "ab" * 32 if yes else None, "applied": yes}


def report(a, day, cap=1000.0):
    return {"asset": a, "day": day, "marketCap": cap, "incomeStatement": {"perToken": {"circulatingSupply": SIGNED[a]}}}


def put(root, rel, obj, exit_code=None):
    p = root / f"{rel}.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(obj if isinstance(obj, str) else json.dumps(obj, indent=1) + "\n")
    if exit_code is not None:
        (root / f"{rel}.exit").write_text(f"{exit_code}\n")


def happy(root):
    put(root, "data_rebuild-supply-levels", "orion-remote: asset required (usage: data rebuild-supply-levels <asset> [--yes] (a dry run without --yes))\n", 64)
    put(root, "sql-ro_whoami", sql([{"u": f"orion_{ENV}_ro"}]))
    for a in ASSETS:
        put(root, f"report_yield_{a}_--day_{D}", report(a, D))
        put(root, f"report_yield_{a}_--day_{D91}", report(a, D91))
    put(root, "sql-ro_levels", levels(pre=False))  # after the first hourly run on the tag (s1's re-check, s3)
    put(root, "r3-s0/sql-ro_supply", supply("pre"))
    put(root, "r3-s0/sql-ro_levels", levels(pre=True))
    put(root, f"r3-s1/deploy.sh_{ENV}_{TAG}", f"== deploy report ({ENV})\nbefore: orion-2026.11.15.1\nafter: {TAG}\nmigrations applied: none\n")
    put(root, "r3-s1/status", f"env: {ENV}\nhost: venus\ncurrent: /home/orion-{ENV}/releases/{TAG}\npostgres: accepting connections\n")
    put(root, "r3-s1/logs_30", f"2026-11-20T12:01:00Z daemon started: d1 env {ENV} release {TAG} database orion_{ENV} schema orion\n2026-11-20T12:02:00Z heartbeat {TAG}\n")
    put(root, "r3-s1/sql-ro_migrations", sql([{"max": 8}]))
    put(root, f"r3-s1/jobs_--since_{SINCE}.1", [])
    put(root, f"r3-s1/jobs_--since_{SINCE}", [{"id": 77, "kind": "levels", "assetId": None, "slot": "2026-11-20T12:15:00.000Z", "status": "done",
                                                "startedAt": "2026-11-20T12:15:02.000Z", "endedAt": "2026-11-20T12:16:40.000Z", "releaseTag": TAG,
                                                "result": {"assets": 13, "rows": 60, "failed": [], "fired": [], "cleared": [], "undelivered": [], "deadman": True, "prices": None},
                                                "lastError": None}])
    put(root, "r3-s1/sql-ro_levels.1", levels(pre=True))
    put(root, "r3-s2/sql-ro_supply.1", supply("pre"))
    put(root, "r3-s2/sql-ro_supply.2", supply("rebuilt"))
    for a in ASSETS:
        put(root, f"r3-s2/data_rebuild-supply-levels_{a}.1", rebuild(a, "dry"))
        put(root, f"r3-s2/data_rebuild-supply-levels_{a}_--yes", rebuild(a, "yes"))
        put(root, f"r3-s2/data_rebuild-supply-levels_{a}.2", rebuild(a, "again"))
    for a in MD:
        put(root, f"r3-s3/data_purge_{a}_--metrics_circulating_supply_--source-type_market_data", purge(a, False))
        put(root, f"r3-s3/data_purge_{a}_--metrics_circulating_supply_--source-type_market_data_--yes", purge(a, True))
    put(root, "r3-s3/sql-ro_market_data", sql([{"n": 0}]))
    put(root, "r3-s3/sql-ro_supply", supply("purged"))


def stops():
    # s1: latest_levels still holds the 9 market_data rows after the first hourly run.
    put(HERE / "stop-levels-still-md", "r3-s1/sql-ro_levels", levels(pre=True))
    # s1: no levels run on the tag finishes within the polls.
    put(HERE / "stop-no-levels-run", f"r3-s1/jobs_--since_{SINCE}", [])
    # s2: a market_data count at step 5 that differs from step 1's (cake 41, not 40).
    pre = supply("pre")
    for r in pre["rows"]:
        if r["asset_id"] == "cake" and r["source_type"] == "market_data":
            r["active"] = r["total"] = 41
    put(HERE / "stop-md-count", "r3-s2/sql-ro_supply.1", pre)
    # s2: a second vvv disclosure row at step 5 that step 1 did not record (ruling R15: kept rows are re-checked).
    pre = supply("pre")
    for r in pre["rows"]:
        if r["asset_id"] == "vvv" and r["source_type"] == "disclosure":
            r["active"] = r["total"] = 2
    put(HERE / "stop-kept-unrecorded", "r3-s2/sql-ro_supply.1", pre)
    # s2: cake's rebuild dry run keeps a row step 1 did not record.
    r = rebuild("cake", "dry")
    r["kept"] = [{"id": 601, "observedAt": "2026-10-02T00:00:00.000Z", "reason": "a disclosure row: only market_data and old-locator contract_state rows are rebuilt (Ruling R15)"}]
    put(HERE / "stop-kept-rebuild", "r3-s2/data_rebuild-supply-levels_cake.1", r)
    # s2: one crv row refused at its block (exit 3).
    r = rebuild("crv", "dry")
    r["rebuilt"] -= 1
    r["refused"] = [{"id": 501, "observedAt": "2025-11-20T00:00:00.000Z", "reason": "contract 0xabc has no code at block 23800000"}]
    put(HERE / "stop-refused", "r3-s2/data_rebuild-supply-levels_crv.1", r, 3)
    # s3: hype's withoutReplacement one short of step 1's 55.
    p = purge("hype", False)
    p["perMetric"][0]["withoutReplacement"].pop()
    put(HERE / "stop-without-replacement", "r3-s3/data_purge_hype_--metrics_circulating_supply_--source-type_market_data", p)
    # s3: a market_data row left anywhere after the purge.
    put(HERE / "stop-market-data", "r3-s3/sql-ro_market_data", sql([{"n": 1}]))
    # s4: cake's D report moved on a path the allowlist does not allow.
    put(HERE / "stop-gate", f"r3-s4/report_yield_cake_--day_{D}", report("cake", D, cap=2000.0))


def tools(root):
    put(root, "tools/phase3-proof/r3-signed-circulating", {"_comment": "test fixture: Task 7's signed circulating per asset", **SIGNED})
    put(root, "tools/phase3-proof/r3-allowlist", {"_comment": "test fixture: allows nothing", "*": []})


def main():
    for d in HERE.iterdir():
        if d.is_dir() and (d.name in ("happy", "tools") or d.name.startswith("stop-")):
            shutil.rmtree(d)
    happy(HERE / "happy")
    stops()
    tools(HERE / "tools")


if __name__ == "__main__":
    main()
