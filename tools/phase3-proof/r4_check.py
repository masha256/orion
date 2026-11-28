#!/usr/bin/python3
r"""The checks of the Phase 3 R4 history step (tools/phase3-proof/r4-backfill.sh; docs/ops/deploy.md "Phase 3 R4
release"; spec section 6), one subcommand per check.

Every check prints `<label> ok ...` (or its plan lines) or `STOP: <reason>` and exits 0 or 1; `fees`, `chunk` and `job`
also exit 3 ("nothing to purge", "nothing missing", "not finished yet"); 2 is a bad call. Configuration written here, not
counts: AERO's five pool-scan metrics, their first day (`since: 2026-10-22`, assets/aero.yaml), the adapter's chunk
(max_scan_days 7, src/ingest/adapters/pool.ts DEFAULT_MAX_SCAN_DAYS) and revision days (3), the retired metric
`flow_usd.fees` and the source types its rows may carry, each env's nightly slot (schedule.yaml) and the backfill gate
around it (src/daemon/jobs/backfill.ts: no start from 4 h before the slot to 2 h after), and the two RPC quiet windows
(16:30-17:15 and 05:00-06:30 America/Los_Angeles). Stdlib only (zoneinfo needs the system tz database).

    r4_check.py sql <name>                       print a named sql-ro query (fees, fees_anomalies, days)
    r4_check.py window <env> <now-iso>           no start inside the backfill gate or an RPC quiet window, nor within
                                                 LEAD_MIN minutes before one opens
    r4_check.py fees <fees> <anomalies> [<n>]    the flow_usd.fees rows to purge (exit 3: none left); <n>: their
                                                 expected total (prod at scoping: 308 = 306 third_party + 2 derived)
    r4_check.py purge-dry <out> <rc> <fees>      the purge dry run deletes exactly those rows
    r4_check.py same-purge <dry> <yes> <rc>      --yes == the dry run; prints the export file and its sha256
    r4_check.py fees-count <fees>                print the flow_usd.fees row total (the prompt's count)
    r4_check.py zero-fees <fees>                 no flow_usd.fees row is left
    r4_check.py plan <days> <now-iso> <out>      missing days per metric, --backfill-days, the chunk count
                                                 ceil(missing / 7) + 1; writes <out> (JSON)
    r4_check.py chunk <days> <now-iso> <k> <n>   the days the next job scans per metric (exit 3: nothing missing)
    r4_check.py queued <out> <rc>                prints `<job id> <slot>` of the queued backfill job
    r4_check.py job <jobs> <id>                  exit 0 done (prints its remaining_missing lines), 3 not yet, 1 STOP
    r4_check.py progress <before> <after> <now>  the job stored at least one missing day and no metric lost one
    r4_check.py verify <days> <now-iso>          exactly one active one-day row per metric per day, since -> yesterday
    r4_check.py field <json> <key>               print one top-level field of a JSON file

`<days>` is a `sql-ro days` result: one row per (metric_key, day) of AERO's five metrics' active rows, `day` = the UTC
day the row covers (observed_at - 1 day: a daily flow row is stamped at the end of its day, src/ingest/apiFlow.ts).
"""
import datetime
import json
import math
import sys
from zoneinfo import ZoneInfo

ASSET = "aero"
METRICS = ("flow_usd.voter_fees", "flow_usd.lp_fees", "flow_usd.pool_fees_gross", "flow_usd.vote_incentives",
           "flow_usd.protocol_subsidy")
SINCE = "2026-10-22"
CHUNK_DAYS = 7          # pool.ts DEFAULT_MAX_SCAN_DAYS (AERO sets no max_scan_days)
REVISION_DAYS = 3       # pool.ts planDays: yesterday, -1, -2 ride along every run
FEES = "flow_usd.fees"
FEES_SOURCE_TYPES = ("third_party", "derived")  # DefiLlama rows + the two 2026-09-10 corrections (spec section 6)
NIGHTLY_UTC = {"prod": (0, 45), "stage": (2, 45)}  # schedule.yaml nightly + staging_overrides
GATE_BEFORE = datetime.timedelta(hours=4)   # backfill.ts BACKFILL_CLEARANCE_MS
GATE_AFTER = datetime.timedelta(hours=2)    # backfill.ts BACKFILL_DEFER_AFTER_MS
PT = ZoneInfo("America/Los_Angeles")
QUIET_PT = (((16, 30), (17, 15)), ((5, 0), (6, 30)))
LEAD_MIN = 15  # a chunk takes ~5-10 min: none starts this close to a closed window

ACTIVE = "superseded_by is null and status <> $$rejected$$"
_metrics = ", ".join(f"$${m}$$" for m in METRICS)
QUERIES = {
    # $$-quoted literals: the query travels inside single quotes over ssh (sql-ro takes one argument).
    "fees": (f"select source_type, count(*)::int as n, count(superseded_by)::int as superseded from observations "
             f"where asset_id = $${ASSET}$$ and metric_key = $${FEES}$$ group by 1 order by 1"),
    "fees_anomalies": (f"select id, kind, status from anomalies where asset_id = $${ASSET}$$ and metric_key = $${FEES}$$ "
                       f"and status = $$open$$ order by id"),
    "days": (f"select metric_key, to_char((observed_at - interval $$1 day$$) at time zone $$UTC$$, $$YYYY-MM-DD$$) as day, "
             f"count(*)::int as n, min(period_days)::float8 as pmin, max(period_days)::float8 as pmax from observations "
             f"where asset_id = $${ASSET}$$ and metric_key in ({_metrics}) and {ACTIVE} group by 1, 2 order by 1, 2"),
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


def instant(text):
    try:
        t = datetime.datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        raise Stop(f"bad instant {text!r}")
    if t.tzinfo is None:
        raise Stop(f"instant {text!r} has no zone")
    return t.astimezone(datetime.timezone.utc)


def day_add(d, n):
    return (datetime.date.fromisoformat(d) + datetime.timedelta(days=n)).isoformat()


def yesterday(now):
    return (now.date() - datetime.timedelta(days=1)).isoformat()


def day_range(a, b):
    out, d = [], a
    while d <= b:
        out.append(d)
        d = day_add(d, 1)
    return out


def span(days):
    if not days:
        return "-"
    return days[0] if len(days) == 1 else f"{days[0]}..{days[-1]} ({len(days)})"


# ---- timing --------------------------------------------------------------------------------------------------------

def closed_windows(env, now):
    """(name, start, end) of every closed window touching [now - 1 day, now + 2 days], in UTC."""
    out = []
    h, m = NIGHTLY_UTC[env]
    for k in range(-1, 3):
        d = now.date() + datetime.timedelta(days=k)
        slot = datetime.datetime(d.year, d.month, d.day, h, m, tzinfo=datetime.timezone.utc)
        out.append((f"backfill gate ({env} nightly {h:02d}:{m:02d} UTC -4 h / +2 h)", slot - GATE_BEFORE, slot + GATE_AFTER))
        local = now.astimezone(PT).date() + datetime.timedelta(days=k)
        for (sh, sm), (eh, em) in QUIET_PT:
            s = datetime.datetime(local.year, local.month, local.day, sh, sm, tzinfo=PT).astimezone(datetime.timezone.utc)
            e = datetime.datetime(local.year, local.month, local.day, eh, em, tzinfo=PT).astimezone(datetime.timezone.utc)
            out.append((f"RPC quiet window {sh:02d}:{sm:02d}-{eh:02d}:{em:02d} PT", s, e))
    return out


def c_window(env, now_text):
    if env not in NIGHTLY_UTC:
        raise Stop(f"env must be stage or prod, not {env!r}")
    now = instant(now_text)
    lead = datetime.timedelta(minutes=LEAD_MIN)
    fmt = lambda t: f"{t:%H:%M} UTC ({t.astimezone(PT):%H:%M %Z})"
    for name, s, e in sorted(closed_windows(env, now), key=lambda w: w[1]):
        if s - lead <= now < e:
            inside = "inside" if now >= s else f"{LEAD_MIN} min or less before"
            raise Stop(f"now {fmt(now)} is {inside} the {name}, {fmt(s)} to {fmt(e)}: start (or rerun: it resumes) after {fmt(e)}")
    nxt = min((w for w in closed_windows(env, now) if w[1] > now), key=lambda w: w[1])
    print(f"window ok (now {fmt(now)}; next closed: {nxt[0]} from {fmt(nxt[1])})")


# ---- the flow_usd.fees purge ---------------------------------------------------------------------------------------

def fees_total(path):
    by = {}
    for r in rows(path):
        by[r.get("source_type")] = int(r.get("n", 0))
    return by


def c_fees(fees, anomalies, expect=None):
    by = fees_total(fees)
    total = sum(by.values())
    open_ = rows(anomalies)
    if open_:
        raise Stop(f"{len(open_)} open anomal{'y' if len(open_) == 1 else 'ies'} on aero {FEES} "
                   f"({', '.join('#%s %s' % (a.get('id'), a.get('kind')) for a in open_)}): the purge refuses them "
                   f"(purge_open_anomaly); resolve each on Mike's go (`resolve <id> \"source removed in R4\"`), then rerun")
    other = sorted(k for k in by if k not in FEES_SOURCE_TYPES)
    if other:
        raise Stop(f"aero {FEES} has rows of source type {', '.join(map(str, other))} (expected only "
                   f"{' + '.join(FEES_SOURCE_TYPES)}): {by}")
    if total == 0:
        print(f"fees ok (no aero {FEES} row left: already purged, the purge step is skipped)")
        return 3
    if expect is not None and total != int(expect):
        raise Stop(f"aero {FEES} has {total} rows ({by}), expected {expect}")
    print(f"fees ok ({total} aero {FEES} rows to purge: " + ", ".join(f"{k} {v}" for k, v in sorted(by.items())) + "; 0 open anomalies)")
    return 0


def purge_metric(r, what):
    if not isinstance(r, dict):
        raise Stop(f"{what}: not a purge result")
    if "error" in r:
        e = r["error"]
        code = e.get("code") if isinstance(e, dict) else e
        hint = (": the env still configures flow_usd.fees, so it is not on the R4 release yet (deploy first)"
                if code == "purge_configured_metric" else "")
        raise Stop(f"{what} refused: {json.dumps(e)[:300]}{hint}")
    pm = r.get("perMetric")
    if not isinstance(pm, list) or len(pm) != 1 or pm[0].get("metric") != FEES:
        raise Stop(f"{what}: perMetric is not exactly [{FEES}]: {json.dumps(pm)[:300]}")
    return pm[0]


def c_purge_dry(out, rc, fees):
    r = load(out)
    m = purge_metric(r, "purge dry run")
    if int(rc) != 0:
        raise Stop(f"purge dry run exit {rc}")
    if r.get("applied") is not False:
        raise Stop("purge dry run reports applied (it must not write)")
    total = sum(fees_total(fees).values())
    if m.get("configured") is not False:
        raise Stop(f"{FEES} is still configured on this env (deploy the R4 release first)")
    if int(m.get("observations", -1)) != total:
        raise Stop(f"purge dry run would delete {m.get('observations')} rows, sql-ro counted {total}")
    print(f"purge dry ok (observations {m['observations']} superseded {m.get('superseded')} days "
          f"{m.get('firstDay')}..{m.get('lastDay')} valueSum {m.get('valueSum')} fetchCursors {m.get('fetchCursors')} "
          f"latestLevels {m.get('latestLevels')} watchState {m.get('watchState')})")


def c_same_purge(dry, yes, rc):
    d = purge_metric(load(dry), "purge dry run")
    y_full = load(yes)
    y = purge_metric(y_full, "purge --yes")
    if int(rc) != 0:
        raise Stop(f"purge --yes exit {rc}")
    if y_full.get("applied") is not True:
        raise Stop("purge --yes did not apply")
    keys = ("observations", "superseded", "firstDay", "lastDay", "fetchCursors", "latestLevels", "watchState")
    diff = [k for k in keys if d.get(k) != y.get(k)]
    if diff:
        raise Stop("purge --yes != dry run: " + ", ".join(f"{k} {d.get(k)} -> {y.get(k)}" for k in diff))
    if not y_full.get("exportFile") or not y_full.get("exportSha256"):
        raise Stop("purge --yes printed no exportFile / exportSha256")
    print(f"purge ok ({y['observations']} rows deleted, == the dry run) export {y_full['exportFile']} "
          f"sha256 {y_full['exportSha256']}")


def c_fees_count(fees):
    print(sum(fees_total(fees).values()))


def c_zero_fees(fees):
    by = fees_total(fees)
    if sum(by.values()):
        raise Stop(f"aero {FEES} rows left after the purge: {by}")
    print(f"zero fees ok (0 aero {FEES} rows)")


# ---- the backfill --------------------------------------------------------------------------------------------------

def stored(path):
    """{metric: {day: (n, pmin, pmax)}} from a sql-ro days result."""
    out = {m: {} for m in METRICS}
    for r in rows(path):
        m = r.get("metric_key")
        if m not in out:
            raise Stop(f"{path}: row of unexpected metric {m!r}")
        out[m][r["day"]] = (int(r["n"]), r.get("pmin"), r.get("pmax"))
    return out


def missing(st, now):
    want = day_range(SINCE, yesterday(now))
    return {m: [d for d in want if d not in st[m]] for m in METRICS}


def backfill_days(now):
    return (now.date() - datetime.date.fromisoformat(SINCE)).days


def next_days(miss, now):
    """pool.ts planDays: the missing days and the 3 revision days, sorted, the oldest CHUNK_DAYS."""
    y = yesterday(now)
    rev = [d for d in (day_add(y, -2), day_add(y, -1), y) if d >= SINCE]
    return sorted(set(miss) | set(rev))[:CHUNK_DAYS]


def c_plan(days, now_text, out):
    now = instant(now_text)
    miss = missing(stored(days), now)
    worst = max(len(v) for v in miss.values())
    bd = backfill_days(now)
    if not 1 <= bd <= 400:
        raise Stop(f"--backfill-days {bd} outside 1..400 (BACKFILL_MAX_DAYS)")
    chunks = math.ceil(worst / CHUNK_DAYS) + 1 if worst else 0
    plan = {"now": now_text, "yesterday": yesterday(now), "backfillDays": bd, "missing": {m: len(v) for m, v in miss.items()},
            "maxMissing": worst, "chunks": chunks}
    with open(out, "w") as f:
        json.dump(plan, f, indent=1)
    for m in METRICS:
        print(f"  {m}: {len(miss[m])} missing of {len(day_range(SINCE, yesterday(now)))} days {SINCE}..{yesterday(now)}"
              + (f" (first {miss[m][0]}, last {miss[m][-1]})" if miss[m] else ""))
    print(f"plan ok (--backfill-days {bd}; at most ceil({worst} / {CHUNK_DAYS}) + 1 = {chunks} jobs)" if worst
          else "plan ok (nothing missing: no backfill job needed)")


def c_chunk(days, now_text, k, n):
    now = instant(now_text)
    miss = missing(stored(days), now)
    if not any(miss.values()):
        print(f"chunk {k}/{n}: nothing missing on any of the five metrics: the loop is done")
        return 3
    per = {m: next_days(miss[m], now) for m in METRICS}
    if len({tuple(v) for v in per.values()}) == 1:
        print(f"chunk {k}/{n}: days {span(per[METRICS[0]])} on all five metrics")
    else:
        print(f"chunk {k}/{n}:")
        for m in METRICS:
            print(f"  {m}: days {span(per[m])}")
    return 0


def c_queued(out, rc):
    r = load(out)
    if int(rc) != 0 or not isinstance(r, dict) or "error" in r:
        raise Stop(f"job run-now backfill exit {rc}: {json.dumps(r)[:300]}")
    if r.get("kind") != "backfill" or r.get("assetId") != ASSET or not isinstance(r.get("id"), int) or not r.get("slot"):
        raise Stop(f"job run-now backfill printed no aero backfill job: {json.dumps(r)[:300]}")
    print(f"{r['id']} {r['slot']}")


def c_job(jobs, job_id):
    js = load(jobs)
    if not isinstance(js, list):
        raise Stop(f"{jobs}: not a job list")
    j = next((x for x in js if x.get("id") == int(job_id)), None)
    if j is None:
        raise Stop(f"job {job_id} not in `jobs --since` (removed?)")
    st = j.get("status")
    if st in ("queued", "running"):
        return 3
    if st != "done":
        raise Stop(f"backfill job {job_id} {st}: {j.get('lastError')}")
    res = j.get("result") if isinstance(j.get("result"), dict) else {}
    written = res.get("written") or {}
    lines = [x for x in res.get("fetchLines") or [] if "remaining_missing" in x]
    print(f"job {job_id} done (written: " + (", ".join(f"{k} {v}" for k, v in sorted(written.items())) or "none") + ")")
    for x in lines:
        print(f"  {x}")
    return 0


def c_progress(before, after, now_text):
    now = instant(now_text)
    b, a = missing(stored(before), now), missing(stored(after), now)
    lost = {m: sorted(set(a[m]) - set(b[m])) for m in METRICS}
    lost = {m: v for m, v in lost.items() if v}
    if lost:
        raise Stop(f"days missing now that were stored before the job: {lost}")
    gained = sum(len(b[m]) - len(a[m]) for m in METRICS)
    if any(b.values()) and gained == 0:
        raise Stop("the job stored no missing day on any metric (see its fetch lines and `logs`)")
    print(f"progress ok (missing per metric now: " + ", ".join(f"{m.split('.')[1]} {len(a[m])}" for m in METRICS) + ")")


def c_verify(days, now_text):
    now = instant(now_text)
    st = stored(days)
    want = day_range(SINCE, yesterday(now))
    bad = []
    for m in METRICS:
        have = st[m]
        miss = [d for d in want if d not in have]
        extra = sorted(d for d in have if d not in want)
        dup = sorted(d for d, (n, _, _) in have.items() if n != 1)
        period = sorted(d for d, (_, lo, hi) in have.items() if lo != 1 or hi != 1)
        if miss:
            bad.append(f"{m} missing {span(miss)}")
        if extra:
            bad.append(f"{m} rows outside {SINCE}..{yesterday(now)}: {span(extra)}")
        if dup:
            bad.append(f"{m} more than one active row on {span(dup)}")
        if period:
            bad.append(f"{m} a row that is not one day long on {span(period)}")
    if bad:
        raise Stop("; ".join(bad))
    print(f"verify ok (5 metrics x {len(want)} days {SINCE}..{yesterday(now)}: exactly one active one-day row each)")


def c_field(path, key):
    r = load(path)
    if not isinstance(r, dict) or key not in r:
        raise Stop(f"{path}: no field {key}")
    print(r[key])


def c_sql(name):
    if name not in QUERIES:
        raise Stop(f"no query {name}")
    print(QUERIES[name])


CMDS = {
    "sql": (c_sql, 1, 1), "window": (c_window, 2, 2), "fees": (c_fees, 2, 3), "purge-dry": (c_purge_dry, 3, 3),
    "same-purge": (c_same_purge, 3, 3), "zero-fees": (c_zero_fees, 1, 1), "fees-count": (c_fees_count, 1, 1), "plan": (c_plan, 3, 3),
    "chunk": (c_chunk, 4, 4), "queued": (c_queued, 2, 2), "job": (c_job, 2, 2), "progress": (c_progress, 3, 3),
    "verify": (c_verify, 2, 2), "field": (c_field, 2, 2),
}


def main(argv):
    if len(argv) < 1 or argv[0] not in CMDS:
        print(__doc__, file=sys.stderr)
        return 2
    fn, lo, hi = CMDS[argv[0]]
    if not lo <= len(argv) - 1 <= hi:
        print(f"r4_check.py {argv[0]}: wrong number of arguments", file=sys.stderr)
        return 2
    try:
        rc = fn(*argv[1:])
    except Stop as e:
        print(f"STOP: {e}")
        return 1
    return rc or 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
