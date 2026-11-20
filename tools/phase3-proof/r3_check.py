#!/usr/bin/python3
r"""The checks of the Phase 3 R3 release block (docs/ops/deploy.md "Phase 3 R3 release"), one subcommand per check.

Called by tools/phase3-proof/r3-s0.sh .. r3-s4.sh. Every check prints `<label> ok ...` or `STOP: <reason>` and exits 0
or 1 (2 for a bad call). Expected counts are never typed here: step 1 (r3-s0.sh) writes ~/r3-<env>/expected.json from
`sql-ro`, and every later check reads that file. What IS written here is configuration, not counts: the 13 assets,
each asset's post-release circulating source (assets/<a>.yaml), the two assets no rebuild can read (HYPE, PUMP: not an
EVM archive read) and AERO's `rebuild_from` (assets/aero.yaml). Stdlib only.

    r3_check.py sql <name>                                  print a named sql-ro query (supply, levels, migrations,
                                                            market_data, whoami)
    r3_check.py usage64 <out> <rc>                          N6: the rebuild verb exists (exit 64 + its usage line)
    r3_check.py whoami <out> <env>                          N6: sql-ro signs in as orion_<env>_ro
    r3_check.py days <days.json> <now-iso>                  D = today-2 UTC and D-91, written once
    r3_check.py expected <supply> <levels> <out> <env> <now> step 1: the expected-counts file
    r3_check.py deploy <out> <tag>                          step 2: deploy report, no migration
    r3_check.py status <status-out> <logs-out> <tag>        step 3: on the tag, logs clean
    r3_check.py migrations <out>                            step 3: schema max 8
    r3_check.py levels-job <jobs> <tag> <since>             step 4: exit 0 done clean, 1 STOP, 3 not yet
    r3_check.py levels-pre <levels> <expected> <jobs> <tag> <since>   step 4 before the hourly run (exempt: step 1's;
                                                            <jobs> read AFTER <levels>: skipped once a run started)
    r3_check.py levels-post <levels> <expected> <signed>    step 4 after it (no exemption, +-2% of the signed value)
    r3_check.py stale <supply> <expected> pre|rebuilt|purged|resume  step 5 / its re-checks after steps 6 and 7 /
                                                            s2 --resume (already rebuilt + remaining = step 1's)
    r3_check.py rebuild-dry <out> <rc> <asset> <expected>   step 6 dry run
    r3_check.py rebuild-dry-resume <out> <rc> <asset> <expected> <supply>  s2 --resume dry run: step 1's less rebuilt
    r3_check.py rebuild-again <out> <rc> <asset> <expected> step 6 second dry run after --yes: 0 rebuilt
    r3_check.py same-rebuild <dry> <yes> <rc> <asset>       step 6 yes == dry
    r3_check.py purge-dry <out> <rc> <asset> <expected>     step 7 dry run
    r3_check.py same-purge <dry> <yes> <rc> <asset>         step 7 yes == dry, prints the export file and sha256
    r3_check.py purge-assets <expected>                     step 7: the assets with market_data rows in step 1
    r3_check.py purge-resume <supply> <expected>            s3 --resume: already purged + remaining = step 1's;
                                                            last line `left: <assets>`
    r3_check.py purge-dry-resume <out> <rc> <asset> <expected> <supply>  s3 --resume dry run
    r3_check.py field <json> <key>                          print one top-level field (s2 --resume: `rebuilt`)
    r3_check.py zero-market-data <out>                      step 8 global market_data = 0
    r3_check.py levels-zero <levels>                        step 8 latest_levels market_data = 0
"""
import datetime
import json
import sys

ASSETS = "aero cake crv cvxcrv hype link lit pump sdcrv sky uni vvv ycrv".split()
METRIC = "circulating_supply"
# Each asset's circulating source after the release: (source_type, locator kind), kind = the locator's `adapter`, else
# its `call`, else its `provider` (the `kind` column of the supply query). From assets/<a>.yaml at the release and
# src/report/sourceTypes.ts (chain.view_sum and solana.supply_less_owners: contract_state; hype.circulating_supply:
# first_party_api). A row of any other (source_type, kind) is stale (the rebuild's target rule, ruling R12) when its
# source_type is market_data or contract_state; a non-current row of any other source_type (disclosure, hand-entered:
# VVV's 2026-09-18 disclosure row) is never a rebuild target (ruling R15): `kept`, untouched by every step, its count
# per asset recorded by step 1 and re-checked by every later check.
CURRENT = {a: ("contract_state", "chain.view_sum") for a in ASSETS}
CURRENT["hype"] = ("first_party_api", "hype.circulating_supply")
CURRENT["pump"] = ("contract_state", "solana.supply_less_owners")
# The listed stale kinds (the artifacts): CoinGecko rows on any asset, and the three wrappers' old erc20_supply rows.
MARKET_DATA = "market_data"
TARGET_TYPES = (MARKET_DATA, "contract_state")
OLD_LOCATOR = ("contract_state", "totalSupply()")
WRAPPERS = ("cvxcrv", "sdcrv", "ycrv")
# notRebuildable (src/db/supplyLevels.ts supplyNotRebuildable): HYPE and PUMP never; AERO before its rebuild_from.
NEVER_REBUILDABLE = ("hype", "pump")
REBUILD_FROM = {"aero": "2026-11-10"}
SIGNED_TOLERANCE = 0.02

ACTIVE = "superseded_by is null and status <> $$rejected$$"
_before = " or ".join(f"(asset_id = $${a}$$ and observed_at < $${d}T00:00:00Z$$)" for a, d in sorted(REBUILD_FROM.items()))
QUERIES = {
    # $$-quoted literals: the query travels inside single quotes over ssh (sql-ro takes one argument).
    "supply": (
        "select asset_id, source_type, coalesce(locator->>$$adapter$$, locator->>$$call$$, locator->>$$provider$$, $$$$) as kind, "
        f"(count(*) filter (where {ACTIVE}))::int as active, count(*)::int as total, "
        f"(count(*) filter (where {ACTIVE} and ({_before})))::int as before_rebuild_from, "
        f"(count(*) filter (where {ACTIVE} and locator->$$rebuilt$$ is not null))::int as rebuilt "
        f"from observations where metric_key = $${METRIC}$$ group by 1, 2, 3 order by 1, 2, 3"
    ),
    "levels": f"select asset_id, source_type, value from latest_levels where metric_key = $${METRIC}$$ order by asset_id",
    "migrations": "select max(id)::int as max from schema_migrations",
    "market_data": "select count(*)::int as n from observations where source_type = $$market_data$$",
    "whoami": "select current_user as u",
}


class Stop(Exception):
    pass


def load(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError) as e:
        raise Stop(f"{path}: not readable JSON ({e})")


def rows(path):
    r = load(path)
    if not isinstance(r, dict) or not isinstance(r.get("rows"), list):
        raise Stop(f"{path}: not a sql-ro result ({json.dumps(r)[:200]})")
    return r["rows"]


def rc_ok(rc, what):
    if int(rc) != 0:
        raise Stop(f"{what} exit {rc}")


def stale_groups(supply_rows):
    """Per asset: {(source_type, kind): (active, total, before_rebuild_from)} of every non-current group."""
    out = {a: {} for a in ASSETS}
    for r in supply_rows:
        a = r["asset_id"]
        if a not in out:
            raise Stop(f"unknown asset {a} in the supply rows")
        key = (r["source_type"], r["kind"])
        if key != CURRENT[a]:
            out[a][key] = (int(r["active"]), int(r["total"]), int(r["before_rebuild_from"]))
    return out


def rebuilt_rows(supply_rows):
    """Per asset: its active circulating rows written by `data rebuild-supply-levels` (locator.rebuilt, any group)."""
    out = {a: 0 for a in ASSETS}
    for r in supply_rows:
        if r["asset_id"] not in out:
            raise Stop(f"unknown asset {r['asset_id']} in the supply rows")
        if "rebuilt" not in r:
            raise Stop("the supply rows have no `rebuilt` column (an r3_check.py before ruling R18?)")
        out[r["asset_id"]] += int(r["rebuilt"])
    return out


def step1_rebuilt(e, asset):
    if "rebuiltRows" not in e:
        raise Stop(f"expected.json has no rebuiltRows for {asset} (written by an s0 before ruling R18: --resume needs it)")
    return int(e["rebuiltRows"])


def classify(groups):
    """Split one asset's non-current groups into market_data, the wrappers' old locator, kept (another source_type than
    market_data / contract_state: never a rebuild target, ruling R15), and anything else (unlisted)."""
    md = {"active": 0, "total": 0, "beforeRebuildFrom": 0}
    old = {"active": 0, "total": 0, "beforeRebuildFrom": 0}
    kept = {"active": 0, "total": 0, "kinds": []}
    other = []
    for (st, kind), (active, total, brf) in sorted(groups.items()):
        if st not in TARGET_TYPES:
            kept["active"] += active
            kept["total"] += total
            kept["kinds"].append({"sourceType": st, "kind": kind, "active": active, "total": total})
            continue
        if st == MARKET_DATA:
            t = md
        elif (st, kind) == OLD_LOCATOR:
            t = old
        else:
            other.append({"sourceType": st, "kind": kind, "active": active, "total": total})
            continue
        t["active"] += active
        t["total"] += total
        t["beforeRebuildFrom"] += brf
    return md, old, kept, other


def kept_note(assets_kept):
    """`vvv disclosure=1` for every asset with kept rows (from {asset: kept})."""
    return " ".join(f"{a} " + ",".join(f"{k['sourceType']}={k['active']}" for k in x["kinds"]) for a, x in sorted(assets_kept.items()) if x["active"])


def not_rebuildable(asset, md, old):
    if asset in NEVER_REBUILDABLE:
        return md["active"] + old["active"]
    return md["beforeRebuildFrom"] + old["beforeRebuildFrom"] if asset in REBUILD_FROM else 0


def c_sql(name):
    if name not in QUERIES:
        raise Stop(f"no query {name}")
    print(QUERIES[name])


def c_usage64(out, rc):
    text = open(out).read()
    if int(rc) != 64 or "data rebuild-supply-levels <asset>" not in text:
        raise Stop(f"N6: `data rebuild-supply-levels` gave exit {rc} without its usage line (orion-host.sh not re-run "
                   f"from the R3 snapshot?): {text.strip()[:300]}")
    print("N6 rebuild-supply-levels verb ok (exit 64, usage line)")


def c_whoami(out, env):
    r = rows(out)
    want = f"orion_{env}_ro"
    if len(r) != 1 or r[0].get("u") != want:
        raise Stop(f"N6: sql-ro current_user is {r}, expected {want}")
    print(f"N6 sql-ro ok ({want})")


def c_days(path, now):
    try:
        d = load(path)
        print(f"days ok (kept from the first s0 run: D {d['D']}, D-91 {d['D91']})")
        return
    except Stop:
        pass
    today = datetime.datetime.fromisoformat(now.replace("Z", "+00:00")).astimezone(datetime.timezone.utc).date()
    D = today - datetime.timedelta(days=2)
    d = {"D": D.isoformat(), "D91": (D - datetime.timedelta(days=91)).isoformat(), "savedAt": now}
    with open(path, "w") as f:
        json.dump(d, f, indent=2)
    print(f"days ok (D {d['D']} = today-2 UTC, D-91 {d['D91']}; saved {path})")


def c_expected(supply, levels, out, env, now):
    srows = rows(supply)
    groups = stale_groups(srows)
    rb_rows = rebuilt_rows(srows)
    assets = {}
    other_all = []
    for a in ASSETS:
        md, old, kept, other = classify(groups[a])
        if old["total"] and a not in WRAPPERS:
            other.append({"sourceType": OLD_LOCATOR[0], "kind": OLD_LOCATOR[1], "active": old["active"], "total": old["total"]})
            old = {"active": 0, "total": 0, "beforeRebuildFrom": 0}
        nr = not_rebuildable(a, md, old)
        stale = md["active"] + old["active"]
        assets[a] = {"marketData": md, "oldLocator": old, "stale": stale, "notRebuildable": nr, "rebuilt": stale - nr,
                     "mdWithoutReplacement": md["active"] if a in NEVER_REBUILDABLE else (md["beforeRebuildFrom"] if a in REBUILD_FROM else 0),
                     "kept": kept["active"], "keptKinds": kept["kinds"], "rebuiltRows": rb_rows[a]}
        other_all += [dict(o, asset=a) for o in other]
    lv = rows(levels)
    md_levels = sorted(r["asset_id"] for r in lv if r["source_type"] == MARKET_DATA)
    exp = {"env": env, "measuredAt": now, "assets": assets, "latestLevelsMarketData": md_levels,
           "marketDataTotal": sum(x["marketData"]["total"] for x in assets.values())}
    with open(out, "w") as f:
        json.dump(exp, f, indent=2, sort_keys=True)
    for a in ASSETS:
        x = assets[a]
        print(f"{a}: market_data {x['marketData']['active']} active / {x['marketData']['total']} total, old locator "
              f"{x['oldLocator']['active']}, expected rebuilt {x['rebuilt']} notRebuildable {x['notRebuildable']} kept {x['kept']}")
    kept_all = {a: {"active": x["kept"], "kinds": x["keptKinds"]} for a, x in assets.items()}
    print(f"kept (never a rebuild target, ruling R15; untouched): {kept_note(kept_all) or 'none'}")
    print(f"market_data total {exp['marketDataTotal']}; latest_levels market_data {len(md_levels)} ({' '.join(md_levels)})")
    if other_all:
        raise Stop("stale circulating rows of an unlisted kind (no block step clears them; bring them to Mike): "
                   + json.dumps(other_all))
    print(f"expected ok (written {out})")


def c_deploy(out, tag):
    text = open(out).read()
    if tag not in text or "migrations applied: none" not in text:
        raise Stop(f"deploy report does not name {tag} with `migrations applied: none`")
    print(f"deploy ok ({tag}, migrations applied: none)")


def c_status(status, logs, tag):
    s = open(status).read()
    cur = [line for line in s.splitlines() if line.startswith("current:")]
    if not cur or not cur[0].rstrip().endswith(tag):
        raise Stop(f"status current is {cur}, expected {tag}")
    lines = open(logs).read().splitlines()
    if not any("daemon started:" in line and f"release {tag}" in line for line in lines):
        raise Stop(f"logs 30 has no `daemon started: ... release {tag}` line")
    bad = [line for line in lines if "ORION ALERT" in line or " error" in line.lower()]
    if bad:
        raise Stop("logs 30 not clean: " + " | ".join(bad))
    print(f"status ok (current {tag}; logs 30 clean)")


def c_migrations(out):
    r = rows(out)
    if len(r) != 1 or r[0].get("max") != 8:
        raise Stop(f"schema_migrations max is {r}, expected 8 (R3 has no migration)")
    print("migrations ok (max 8)")


def levels_job(jobs, tag, since):
    """'done' / 'wait' for the first levels job on the tag that started at or after `since`; Stop when it failed."""
    js = load(jobs)
    if not isinstance(js, list):
        raise Stop(f"{jobs}: not a job list")
    # running / queued / skipped jobs, and any that started before the switch, are ignored.
    mine = [j for j in js if j.get("kind") == "levels" and j.get("releaseTag") == tag and started_after(j, since)]
    ended = sorted((j for j in mine if j.get("status") in ("done", "failed")), key=lambda j: j["startedAt"])
    if not ended:
        return "wait", None
    j = ended[0]
    if j["status"] != "done":
        raise Stop(f"levels job {j.get('id')} on {tag}: {j['status']} ({j.get('lastError')})")
    failed = (j.get("result") or {}).get("failed")
    if failed is None or failed:
        raise Stop(f"levels job {j.get('id')} on {tag} has failed sources: {json.dumps(failed)}")
    return "done", j


def c_levels_job(jobs, tag, since):
    state, j = levels_job(jobs, tag, since)
    if state == "wait" or j is None:
        print(f"levels: no levels run on {tag} finished yet")
        sys.exit(3)
    print(f"levels job ok (id {j.get('id')} on {tag}, no failed source)")


def started_after(j, since):
    t0 = datetime.datetime.fromisoformat(since.replace("Z", "+00:00"))
    return bool(j.get("startedAt")) and datetime.datetime.fromisoformat(j["startedAt"].replace("Z", "+00:00")) >= t0


def c_levels_pre(levels, expected, jobs, tag, since):
    """`jobs` is read after `levels`: a levels job on the tag that started after the switch (running or ended) may have
    overwritten some rows before the levels read, so the pre-check is skipped; a job that started later did not."""
    exp = load(expected)["latestLevelsMarketData"]
    md = sorted(r["asset_id"] for r in rows(levels) if r["source_type"] == MARKET_DATA)
    js = load(jobs)
    if not isinstance(js, list):
        raise Stop(f"{jobs}: not a job list")
    started = sorted((j for j in js if j.get("kind") == "levels" and j.get("releaseTag") == tag and started_after(j, since)),
                     key=lambda j: j["startedAt"])
    if started:
        j = started[0]
        print(f"levels pre skipped (levels job {j.get('id')} on {tag} started {j['startedAt']}, {j.get('status')}, by the "
              f"latest_levels read: it may have overwritten rows ({len(md)} market_data seen); the re-check below has no exemption)")
        return
    if md != exp:
        raise Stop(f"latest_levels market_data before the first hourly run: {len(md)} ({' '.join(md)}), expected "
                   f"step 1's {len(exp)} ({' '.join(exp)})")
    print(f"levels pre ok (expected pre-switch: {len(md)} (assets {' '.join(md)}))")


def c_levels_post(levels, expected, signed):
    lv = rows(levels)
    md = sorted(r["asset_id"] for r in lv if r["source_type"] == MARKET_DATA)
    if md:
        raise Stop(f"latest_levels still holds {len(md)} market_data circulating rows after the hourly run: {' '.join(md)}")
    sg = load(signed)
    by = {r["asset_id"]: float(r["value"]) for r in lv}
    bad = []
    for a in ASSETS:
        if a not in sg:
            raise Stop(f"{signed} has no signed value for {a}")
        if a not in by:
            bad.append(f"{a} missing from latest_levels")
            continue
        ratio = by[a] / float(sg[a])
        if abs(ratio - 1) > SIGNED_TOLERANCE:
            bad.append(f"{a} {by[a]:.0f} vs signed {float(sg[a]):.0f} ({(ratio - 1) * 100:+.2f}%)")
    if bad:
        raise Stop("circulating outside +-2% of the signed value: " + "; ".join(bad))
    print("levels post ok (0 market_data in latest_levels; 13/13 within +-2% of the signed values)")


def c_stale(supply, expected, phase):
    exp = load(expected)["assets"]
    srows = rows(supply)
    groups = stale_groups(srows)
    rb_now = rebuilt_rows(srows) if phase == "resume" else None
    bad, notes, label = [], [], ""
    kept_all = {}
    for a in ASSETS:
        md, old, kept, other = classify(groups[a])
        if other:
            bad.append(f"{a} unlisted stale {json.dumps(other)}")
        e = exp[a]
        kept_all[a] = kept
        if phase == "resume":
            already = rb_now[a] - step1_rebuilt(e, a)
            left = md["active"] + old["active"]
            if already < 0 or already > e["rebuilt"] or already + left != e["stale"]:
                bad.append(f"{a} already rebuilt since step 1 {already} + remaining stale {left} = {already + left}, expected "
                           f"step 1's {e['stale']} (at most {e['rebuilt']} rebuilt)")
            elif already:
                notes.append(f"{a} {already}+{left}={e['stale']}")
            label = "already rebuilt since step 1 + remaining = step 1's stale"
        if kept["active"] != e["kept"]:
            bad.append(f"{a} kept (non-market_data, non-contract_state) rows {kept['active']} {json.dumps(kept['kinds'])}, "
                       f"expected step 1's {e['kept']} (a row step 1 did not record: bring it to Mike)")
        if phase == "resume":
            continue
        if phase == "pre":
            want_md, want_old = e["marketData"]["active"], e["oldLocator"]["active"]
            label = "expected pre-rebuild"
        elif phase == "rebuilt":
            want_md, want_old = e["mdWithoutReplacement"], 0
            label = "left for step 7 (notRebuildable)"
        elif phase == "purged":
            want_md, want_old = 0, 0
            label = ""
        else:
            raise Stop(f"bad phase {phase}")
        if md["active"] != want_md or old["active"] != want_old:
            bad.append(f"{a} stale market_data {md['active']} (expected {want_md}), old locator {old['active']} (expected {want_old})")
        elif md["active"] or old["active"]:
            notes.append(f"{a} market_data={md['active']}" + (f" old-locator={old['active']}" if old["active"] else ""))
    if bad:
        raise Stop(f"stale circulating rows ({phase}): " + "; ".join(bad))
    kn = kept_note(kept_all)
    empty = " (nothing rebuilt since step 1)" if phase == "resume" else " (0 stale rows on all 13)"
    print(f"stale {phase} ok" + (f" ({label}: {' '.join(notes)})" if notes else empty)
          + (f" [kept, as step 1: {kn}]" if kn else ""))


def rebuild_counts(r):
    """(rows, rebuilt, refused, notRebuildable, kept); a result without `kept` (a pre-R15 binary) is a STOP."""
    if not isinstance(r.get("kept"), list):
        raise Stop(f"rebuild result for {r.get('asset')} has no `kept` list (a release before ruling R15?)")
    return (r["rows"], r["rebuilt"], len(r["refused"]), len(r["notRebuildable"]), len(r["kept"]))


def c_rebuild_dry(out, rc, asset, expected):
    r = load(out)
    if isinstance(r, dict) and r.get("refused"):
        raise Stop(f"{asset} rebuild dry run refused {len(r['refused'])} rows (Mike decides): {json.dumps(r['refused'])[:600]}")
    rc_ok(rc, f"{asset} rebuild dry run")
    if "error" in r:
        raise Stop(f"{asset} rebuild dry run error {json.dumps(r['error'])}")
    e = load(expected)["assets"][asset]
    got = rebuild_counts(r)
    want = (e["stale"], e["rebuilt"], 0, e["notRebuildable"], e["kept"])
    if got != want:
        raise Stop(f"{asset} rebuild dry run rows/rebuilt/refused/notRebuildable/kept {got}, expected from step 1 {want}")
    print(f"{asset} rebuild dry ok (rows {got[0]} rebuilt {got[1]} refused 0 notRebuildable {got[3]} kept {got[4]})")


def c_rebuild_dry_resume(out, rc, asset, expected, supply):
    """s2 --resume: step 1's counts less the rows already rebuilt since step 1 (locator.rebuilt, from `supply`)."""
    r = load(out)
    if isinstance(r, dict) and r.get("refused"):
        raise Stop(f"{asset} rebuild dry run (resume) refused {len(r['refused'])} rows (Mike decides): {json.dumps(r['refused'])[:600]}")
    rc_ok(rc, f"{asset} rebuild dry run (resume)")
    if "error" in r:
        raise Stop(f"{asset} rebuild dry run (resume) error {json.dumps(r['error'])}")
    e = load(expected)["assets"][asset]
    already = rebuilt_rows(rows(supply))[asset] - step1_rebuilt(e, asset)
    got = rebuild_counts(r)
    want = (e["stale"] - already, e["rebuilt"] - already, 0, e["notRebuildable"], e["kept"])
    if got != want:
        raise Stop(f"{asset} rebuild dry run (resume) rows/rebuilt/refused/notRebuildable/kept {got}, expected step 1's less "
                   f"the {already} already rebuilt {want}")
    print(f"{asset} rebuild dry (resume) ok (rows {got[0]} rebuilt {got[1]} refused 0 notRebuildable {got[3]} kept {got[4]}; "
          f"already rebuilt {already})")


def c_field(path, key):
    r = load(path)
    if not isinstance(r, dict) or key not in r:
        raise Stop(f"{path} has no {key}")
    print(r[key])


def c_rebuild_again(out, rc, asset, expected):
    r = load(out)
    rc_ok(rc, f"{asset} second rebuild dry run")
    e = load(expected)["assets"][asset]
    got = rebuild_counts(r)
    want = (e["notRebuildable"], 0, 0, e["notRebuildable"], e["kept"])
    if got != want:
        raise Stop(f"{asset} second dry run after --yes {got}, expected {want} (rebuilds 0)")
    print(f"{asset} second dry ok (rebuilds 0)")


def c_same_rebuild(dry, yes, rc, asset):
    y = load(yes)
    rc_ok(rc, f"{asset} rebuild --yes")
    d = load(dry)
    if rebuild_counts(d) != rebuild_counts(y) or y.get("applied") is not True:
        raise Stop(f"{asset} rebuild yes {rebuild_counts(y)} applied={y.get('applied')} != dry {rebuild_counts(d)}")
    print(f"{asset} rebuild yes == dry ok (rebuilt {y['rebuilt']})")


def purge_counts(r):
    pm = r.get("perMetric")
    if not isinstance(pm, list) or [m.get("metric") for m in pm] != [METRIC]:
        raise Stop(f"purge result has no single {METRIC} entry: {json.dumps(r)[:300]}")
    m = pm[0]
    return (m["observations"], len(m.get("withoutReplacement", [])))


def c_purge_dry(out, rc, asset, expected):
    r = load(out)
    if isinstance(r, dict) and "error" in r:
        raise Stop(f"{asset} purge dry run refused {json.dumps(r['error'])[:400]} (a purge_unreplaced_supply_level "
                   f"refusal = a row step 6 should have replaced)")
    rc_ok(rc, f"{asset} purge dry run")
    e = load(expected)["assets"][asset]
    got = purge_counts(r)
    want = (e["marketData"]["total"], e["mdWithoutReplacement"])
    if got != want:
        raise Stop(f"{asset} purge dry run observations/withoutReplacement {got}, expected from step 1 {want}")
    print(f"{asset} purge dry ok (observations {got[0]} withoutReplacement {got[1]})")


def c_same_purge(dry, yes, rc, asset):
    y = load(yes)
    if isinstance(y, dict) and "error" in y:
        raise Stop(f"{asset} purge --yes refused {json.dumps(y['error'])[:400]}")
    rc_ok(rc, f"{asset} purge --yes")
    d = load(dry)
    if purge_counts(d) != purge_counts(y) or y.get("applied") is not True or not y.get("exportFile") or not y.get("exportSha256"):
        raise Stop(f"{asset} purge yes {purge_counts(y)} applied={y.get('applied')} export={y.get('exportFile')} != dry {purge_counts(d)}")
    print(f"{asset} purge yes == dry ok (deleted {purge_counts(y)[0]}; export {y['exportFile']} sha256 {y['exportSha256']})")


def c_levels_zero(levels):
    md = sorted(r["asset_id"] for r in rows(levels) if r["source_type"] == MARKET_DATA)
    if md:
        raise Stop(f"latest_levels holds {len(md)} market_data circulating rows: {' '.join(md)}, expected 0")
    print("latest_levels ok (0 market_data circulating rows)")


def purge_assets(expected):
    """The assets with market_data circulating rows in step 1's file (the ones step 7 purges)."""
    exp = load(expected)["assets"]
    print(" ".join(a for a in ASSETS if exp[a]["marketData"]["total"] > 0))


def md_now(supply_rows):
    """Per asset: its market_data circulating rows now (every status: the purge deletes them all)."""
    out = {a: 0 for a in ASSETS}
    for r in supply_rows:
        if r["asset_id"] not in out:
            raise Stop(f"unknown asset {r['asset_id']} in the supply rows")
        if r["source_type"] == MARKET_DATA:
            out[r["asset_id"]] += int(r["total"])
    return out


def c_purge_resume(supply, expected):
    """s3 --resume: per asset, already purged since step 1 (step 1's market_data total - the rows now) + remaining (the
    rows now) = step 1's total, with 0 <= remaining <= step 1's; the last line is `left: <assets with rows left>` (the
    ones r3-s3.sh --resume purges)."""
    exp = load(expected)["assets"]
    now = md_now(rows(supply))
    bad, notes, left = [], [], []
    for a in ASSETS:
        total = exp[a]["marketData"]["total"]
        if now[a] > total:
            bad.append(f"{a} {now[a]} market_data rows, more than step 1's {total}")
            continue
        if total:
            notes.append(f"{a} {total - now[a]}+{now[a]}={total}")
        if now[a]:
            left.append(a)
    if bad:
        raise Stop("purge resume: " + "; ".join(bad))
    print(f"purge resume ok (already purged since step 1 + remaining = step 1's market_data total: {' '.join(notes)})")
    print("left:" + "".join(f" {x}" for x in left))


def c_purge_dry_resume(out, rc, asset, expected, supply):
    r = load(out)
    if isinstance(r, dict) and "error" in r:
        raise Stop(f"{asset} purge dry run (resume) refused {json.dumps(r['error'])[:400]}")
    rc_ok(rc, f"{asset} purge dry run (resume)")
    e = load(expected)["assets"][asset]
    total, now = e["marketData"]["total"], md_now(rows(supply))[asset]
    purged = total - now
    obs, wr = purge_counts(r)
    if purged + obs != total:
        raise Stop(f"{asset} purge dry run (resume): already purged {purged} + remaining {obs} = {purged + obs}, expected "
                   f"step 1's market_data total {total}")
    if (purged == 0 and wr != e["mdWithoutReplacement"]) or wr > e["mdWithoutReplacement"]:
        raise Stop(f"{asset} purge dry run (resume) withoutReplacement {wr}, expected step 1's {e['mdWithoutReplacement']}"
                   + (" (at most, after a part purge)" if purged else ""))
    print(f"{asset} purge dry (resume) ok (observations {obs} withoutReplacement {wr}; already purged {purged})")


def c_zero_market_data(out):
    r = rows(out)
    if len(r) != 1 or r[0].get("n") != 0:
        raise Stop(f"observations with source_type market_data after the purge: {r}, expected 0")
    print("market_data ok (0 rows in observations)")


COMMANDS = {
    "sql": (c_sql, 1), "usage64": (c_usage64, 2), "whoami": (c_whoami, 2), "days": (c_days, 2),
    "expected": (c_expected, 5), "deploy": (c_deploy, 2), "status": (c_status, 3), "migrations": (c_migrations, 1),
    "levels-job": (c_levels_job, 3), "levels-pre": (c_levels_pre, 5), "levels-post": (c_levels_post, 3),
    "stale": (c_stale, 3), "rebuild-dry": (c_rebuild_dry, 4), "rebuild-again": (c_rebuild_again, 4),
    "same-rebuild": (c_same_rebuild, 4), "purge-dry": (c_purge_dry, 4), "same-purge": (c_same_purge, 4),
    "rebuild-dry-resume": (c_rebuild_dry_resume, 5), "field": (c_field, 2), "purge-resume": (c_purge_resume, 2),
    "purge-dry-resume": (c_purge_dry_resume, 5), "zero-market-data": (c_zero_market_data, 1), "levels-zero": (c_levels_zero, 1), "purge-assets": (purge_assets, 1),
}


def main(argv):
    if not argv or argv[0] not in COMMANDS or len(argv) - 1 != COMMANDS[argv[0]][1]:
        print(__doc__, file=sys.stderr)
        return 2
    try:
        COMMANDS[argv[0]][0](*argv[1:])
    except Stop as e:
        print(f"STOP: {e}")
        return 1
    except (OSError, KeyError, TypeError, ValueError) as e:
        print(f"STOP: {argv[0]}: {type(e).__name__}: {e}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
