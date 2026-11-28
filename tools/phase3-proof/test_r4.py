"""Tests of the Phase 3 R4 tools (tools/phase3-proof): r4_acceptance.py (DEV-ONLY, saved files), r4_check.py and
r4-backfill.sh in --fake mode (no ssh: every remote call reads a file this test writes), r4-allowlist.json (the
skeleton) and r4-gen-scan.py (only when R4_SCOPING_DIR names the R4 scoping directory: it then reproduces
assets/aero.yaml's scan block byte for byte).

    python3 -m unittest tools/phase3-proof/test_r4.py
"""
import datetime
import importlib.util
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
FIX = HERE / "fixtures" / "r4"
sys.path.insert(0, str(HERE))
import flatdiff  # noqa: E402
import r4_acceptance  # noqa: E402
import r4_check  # noqa: E402

M5 = r4_check.METRICS
NOW = "2026-11-28T15:00:00Z"  # 07:00 PST: clear of both RPC quiet windows and prod's / stage's backfill gate
ALL_DAYS = r4_check.day_range("2026-10-22", "2026-11-27")  # 37 days


def slug(*words):
    s = "_".join(words)
    return "".join(c if (c.isalnum() and c.isascii()) or c in "._=-" else "-" for c in s)


class Acceptance(unittest.TestCase):
    def run_cli(self, *args):
        p = subprocess.run([sys.executable, str(HERE / "r4_acceptance.py"), *map(str, args)], capture_output=True, text=True)
        return p.returncode, p.stdout, p.stderr

    def test_docstring_marks_it_dev_only_and_offline(self):
        doc = r4_acceptance.__doc__ or ""
        self.assertTrue(doc.startswith("DEV-ONLY"))
        self.assertIn("never fetches", doc)
        src = (HERE / "r4_acceptance.py").read_text()
        for word in ("urllib", "http.client", "requests", "socket"):
            self.assertNotIn(f"import {word}", src)

    def test_pass_with_sql_rows_and_the_launch_day_exempt(self):
        rc, out, _ = self.run_cli(FIX / "orion-sqlro.json", FIX / "dl-holders.json", "--dl-stamp", "end")
        self.assertEqual(rc, 0, out)
        self.assertIn("2026-10-22     100,000     20,000      5,000     125,000     100,000  +25.00%  exempt", out)
        self.assertIn("-2.90%  ok", out)
        self.assertIn("PASS: 0 failing day(s), max |gap| 2.90%", out)

    def test_data_show_rows_give_the_same_result(self):
        a = r4_acceptance.compare(r4_acceptance.orion_days(json.loads((FIX / "orion-show.json").read_text()), "show"),
                                  r4_acceptance.dl_days(json.loads((FIX / "dl-holders.json").read_text()), "end", "dl"))
        b = r4_acceptance.compare(r4_acceptance.orion_days(json.loads((FIX / "orion-sqlro.json").read_text()), "sql"),
                                  r4_acceptance.dl_days(json.loads((FIX / "dl-holders.json").read_text()), "end", "dl"))
        self.assertEqual(a, b)
        self.assertEqual(a["to"], "2026-10-25")

    def test_both_stamp_conventions(self):
        dl = r4_acceptance.dl_days({"totalDataChart": [[1792800000, 5.0]]}, "end", "x")  # 2026-10-24T00:00Z
        self.assertEqual(dl, {"2026-10-23": 5.0})
        self.assertEqual(r4_acceptance.dl_days({"totalDataChart": [[1792800000, 5.0]]}, "start", "x"), {"2026-10-24": 5.0})
        self.assertEqual(r4_acceptance.dl_days({"2026-10-24": 5}, "end", "x"), {"2026-10-23": 5.0})
        # dl-holders.json is stamped D+1 (Orion-row convention): read as `start` it is one day off and fails falsely.
        rc, out, _ = self.run_cli(FIX / "orion-sqlro.json", FIX / "dl-holders.json", "--dl-stamp", "start")
        self.assertEqual(rc, 1, out)
        # The same values stamped D (a raw api.llama.fi chart) pass with `start`.
        chart = json.loads((FIX / "dl-holders.json").read_text())["totalDataChart"]
        d = Path(tempfile.mkdtemp(prefix="r4-stamp-"))
        try:
            (d / "raw.json").write_text(json.dumps({"totalDataChart": [[t - 86400, v] for t, v in chart]}))
            rc, out, _ = self.run_cli(FIX / "orion-sqlro.json", d / "raw.json", "--dl-stamp", "start")
            self.assertEqual(rc, 0, out)
            self.assertIn("(--dl-stamp start)", out)
            rc, out, _ = self.run_cli(FIX / "orion-sqlro.json", d / "raw.json", "--dl-stamp", "end")
            self.assertEqual(rc, 1, out)
        finally:
            shutil.rmtree(d)

    def test_dl_stamp_is_required(self):
        rc, out, err = self.run_cli(FIX / "orion-sqlro.json", FIX / "dl-holders.json")
        self.assertEqual(rc, 2, out)
        self.assertIn("--dl-stamp is required", err)
        self.assertIn("raw api.llama.fi chart (the row stamped D covers day D)", err)
        self.assertIn("Orion's stored DefiLlama rows or the prod purge export (the row stamped D+1 covers day D)", err)
        self.assertEqual(out, "")

    def test_a_gap_over_3_percent_fails_and_exactly_3_passes(self):
        orion = {m: {"2026-10-23": 0.0} for m in r4_acceptance.METRICS}
        orion["flow_usd.voter_fees"]["2026-10-23"] = 103.0
        self.assertEqual(r4_acceptance.compare(orion, {"2026-10-23": 100.0})["fails"], 0)
        orion["flow_usd.voter_fees"]["2026-10-23"] = 103.01
        r = r4_acceptance.compare(orion, {"2026-10-23": 100.0})
        self.assertEqual((r["fails"], r["days"][-1]["status"]), (1, "FAIL"))
        orion["flow_usd.voter_fees"]["2026-10-23"] = 96.9
        self.assertEqual(r4_acceptance.compare(orion, {"2026-10-23": 100.0})["fails"], 1)

    def test_all_three_metrics_are_summed(self):
        orion = {"flow_usd.voter_fees": {"2026-10-23": 90.0}, "flow_usd.vote_incentives": {"2026-10-23": 6.0},
                 "flow_usd.protocol_subsidy": {"2026-10-23": 4.0}}
        r = r4_acceptance.compare(orion, {"2026-10-23": 100.0})
        self.assertEqual((r["days"][-1]["orion"], r["fails"]), (100.0, 0))

    def test_a_missing_day_on_either_side_fails_except_the_launch_day(self):
        orion = json.loads((FIX / "orion-sqlro.json").read_text())
        orion["rows"] = [r for r in orion["rows"] if not (r["day"] == "2026-10-24" and r["metric_key"] == "flow_usd.protocol_subsidy")]
        o = r4_acceptance.orion_days(orion, "x")
        dl = r4_acceptance.dl_days(json.loads((FIX / "dl-holders.json").read_text()), "end", "dl")
        r = r4_acceptance.compare(o, dl)
        bad = [x for x in r["days"] if x["status"] == "FAIL"]
        self.assertEqual([(x["day"], x["note"]) for x in bad], [("2026-10-24", "missing flow_usd.protocol_subsidy")])
        del dl["2026-10-22"], dl["2026-10-25"]
        r = r4_acceptance.compare(r4_acceptance.orion_days(json.loads((FIX / "orion-sqlro.json").read_text()), "x"), dl)
        self.assertEqual([(x["day"], x["status"]) for x in r["days"] if x["status"] != "ok"],
                         [("2026-10-22", "exempt"), ("2026-10-25", "FAIL")])

    def test_to_limits_the_days(self):
        rc, out, _ = self.run_cli(FIX / "orion-sqlro.json", FIX / "dl-holders.json", "--dl-stamp", "end", "--to", "2026-10-23")
        self.assertEqual(rc, 0, out)
        self.assertNotIn("2026-10-24", out)

    def test_bad_inputs_exit_2(self):
        d = Path(tempfile.mkdtemp(prefix="r4-acc-"))
        try:
            (d / "report.json").write_text(json.dumps({"asset": "aero", "windowDays": 91, "incomeStatement": {}}))
            rc, _, err = self.run_cli(d / "report.json", FIX / "dl-holders.json", "--dl-stamp", "end")
            self.assertEqual(rc, 2)
            self.assertIn("a report carries window totals", err)
            (d / "dup.json").write_text(json.dumps({"rows": [{"metric_key": "flow_usd.voter_fees", "day": "2026-10-23", "value": 1},
                                                             {"metric_key": "flow_usd.voter_fees", "day": "2026-10-23", "value": 2}]}))
            rc, _, err = self.run_cli(d / "dup.json", FIX / "dl-holders.json", "--dl-stamp", "end")
            self.assertEqual(rc, 2)
            self.assertIn("two rows of flow_usd.voter_fees", err)
            (d / "dl.json").write_text(json.dumps({"totalDataChart": [[1792800001, 1]]}))
            rc, _, err = self.run_cli(FIX / "orion-sqlro.json", d / "dl.json", "--dl-stamp", "start")
            self.assertEqual(rc, 2)
            self.assertIn("not at 00:00 UTC", err)
            rc, _, _ = self.run_cli(d / "nope.json", FIX / "dl-holders.json", "--dl-stamp", "end")
            self.assertEqual(rc, 2)
        finally:
            shutil.rmtree(d)

    def test_print_sql_is_one_dollar_quoted_statement(self):
        rc, out, _ = self.run_cli("--print-sql")
        self.assertEqual(rc, 0)
        self.assertNotIn("'", out)
        self.assertNotIn(";", out)
        self.assertNotIn("\\", out)


class Checks(unittest.TestCase):
    def test_queries_travel_inside_single_quotes(self):
        for name, q in r4_check.QUERIES.items():
            self.assertNotIn("'", q, name)
            self.assertNotIn("\\", q, name)
            self.assertNotIn(";", q, name)

    def window(self, env, now):
        p = subprocess.run([sys.executable, str(HERE / "r4_check.py"), "window", env, now], capture_output=True, text=True)
        return p.returncode, p.stdout

    def test_window_refuses_the_gate_and_the_quiet_windows(self):
        cases = {
            ("prod", "2026-11-28T15:00:00Z"): 0,
            ("prod", "2026-11-28T20:44:00Z"): 1,  # 15 min before prod's gate (20:45-02:45 UTC)
            ("prod", "2026-11-28T20:30:00Z"): 1,  # exactly LEAD_MIN before
            ("prod", "2026-11-28T20:29:00Z"): 0,
            ("prod", "2026-11-29T02:00:00Z"): 1,
            ("prod", "2026-11-29T02:45:00Z"): 0,
            ("stage", "2026-11-29T02:45:00Z"): 1,  # stage's gate runs to 04:45 UTC
            ("stage", "2026-11-28T21:00:00Z"): 0,
            ("prod", "2026-11-28T13:10:00Z"): 1,  # 05:10 PST
            ("prod", "2026-11-28T14:30:00Z"): 0,  # 06:30 PST
            ("prod", "2026-07-01T12:30:00Z"): 1,  # 05:30 PDT (summer: the window follows Pacific time)
            ("prod", "2026-07-01T13:40:00Z"): 0,  # 06:40 PDT
            ("prod", "2026-07-01T23:50:00Z"): 1,  # 16:50 PDT
            ("prod", "2026-07-02T00:20:00Z"): 1,  # 17:20 PDT is clear of 16:30-17:15, but inside prod's gate
        }
        for (env, now), want in cases.items():
            rc, out = self.window(env, now)
            self.assertEqual(rc, want, f"{env} {now}: {out}")

    def test_the_evening_quiet_window_follows_pacific_time(self):
        # 16:30-17:15 PT always lies inside both envs' gates, so the gate is what a STOP names; the window is still listed.
        for now, start in (("2026-11-28T15:00:00Z", "2026-11-29T00:30:00+00:00"), ("2026-07-01T15:00:00Z", "2026-07-01T23:30:00+00:00")):
            w = [x for x in r4_check.closed_windows("prod", r4_check.instant(now)) if x[0] == "RPC quiet window 16:30-17:15 PT"]
            self.assertIn(start, [x[1].isoformat() for x in w])
            self.assertTrue(all(x[2] - x[1] == datetime.timedelta(minutes=45) for x in w))

    def test_next_days_mirrors_pool_ts_plan_days(self):
        now = r4_check.instant(NOW)
        self.assertEqual(r4_check.next_days(ALL_DAYS, now), ALL_DAYS[:7])
        # Nothing missing but two old days: they ride with the revision days, oldest first, 7 at most.
        self.assertEqual(r4_check.next_days(["2026-10-30"], now), ["2026-10-30", "2026-11-25", "2026-11-26", "2026-11-27"])
        self.assertEqual(r4_check.backfill_days(now), 37)

    def test_the_chunk_count_is_ceil_missing_over_7_plus_1(self):
        d = Path(tempfile.mkdtemp(prefix="r4-plan-"))
        try:
            stored = ALL_DAYS[:10]
            (d / "days.json").write_text(json.dumps({"rows": [{"metric_key": m, "day": x, "n": 1, "pmin": 1, "pmax": 1} for m in M5 for x in stored]}))
            p = subprocess.run([sys.executable, str(HERE / "r4_check.py"), "plan", str(d / "days.json"), NOW, str(d / "plan.json")],
                               capture_output=True, text=True)
            self.assertEqual(p.returncode, 0, p.stdout)
            plan = json.loads((d / "plan.json").read_text())
            self.assertEqual((plan["maxMissing"], plan["chunks"], plan["backfillDays"]), (27, math.ceil(27 / 7) + 1, 37))
        finally:
            shutil.rmtree(d)


class Backfill(unittest.TestCase):
    """r4-backfill.sh in --fake mode: each job stores the days r4_check.next_days predicts (pool.ts planDays)."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="r4-test-"))
        self.home = self.tmp / "home"
        self.home.mkdir()
        self.fake = self.tmp / "fake"
        self.fake.mkdir()
        self.work = self.home / "r4-prod"

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def put(self, name, obj, exit_code=None):
        (self.fake / f"{name}.json").write_text(json.dumps(obj))
        if exit_code is not None:
            (self.fake / f"{name}.exit").write_text(str(exit_code))

    @staticmethod
    def days_rows(stored, dup=()):
        return {"rows": [{"metric_key": m, "day": d, "n": 2 if (m, d) in dup else 1, "pmin": 1.0, "pmax": 1.0}
                         for m in M5 for d in sorted(stored[m])]}

    def world(self, fees=(("derived", 2), ("third_party", 306)), anomalies=(), stored_days=(), running_polls=1, fail_job=None,
              stuck_job=None, no_progress_job=None, dup=()):
        """A fake env: the fees rows, the purge, and a backfill that stores each job's predicted days."""
        self.put("sql-ro_fees.1", {"rows": [{"source_type": s, "n": n, "superseded": 0} for s, n in fees]})
        self.put("sql-ro_fees.2", {"rows": []})
        self.put("sql-ro_fees_anomalies", {"rows": [{"id": i, "kind": "source_failure_streak", "status": "open"} for i in anomalies]})
        total = sum(n for _, n in fees)
        pm = {"metric": "flow_usd.fees", "configured": False, "observations": total, "superseded": 1, "firstDay": "2025-12-03",
              "lastDay": "2026-11-27", "valueSum": 1.5e7, "latestLevels": 0, "watchState": 0, "fetchCursors": 1}
        self.put(slug("data", "purge", "aero", "--metrics", "flow_usd.fees"),
                 {"asset": "aero", "perMetric": [pm], "exportFile": None, "exportSha256": None, "applied": False})
        self.put(slug("data", "purge", "aero", "--metrics", "flow_usd.fees", "--yes"),
                 {"asset": "aero", "perMetric": [pm], "exportFile": "/home/orion-prod/home/purged/aero-flow_usd.fees-20261128T150000Z.json",
                  "exportSha256": "ab" * 32, "applied": True})
        now = r4_check.instant(NOW)
        stored = {m: set(stored_days) for m in M5}
        self.put("sql-ro_days.1", self.days_rows(stored))
        run_now = slug("job", "run-now", "backfill", "aero", "--metrics", ",".join(M5), "--backfill-days", "37")
        k = 0
        while any(set(ALL_DAYS) - stored[m] for m in M5) and k < 20:
            k += 1
            slot = f"2026-11-28T15:{k:02d}:00.000Z"
            self.put(f"{run_now}.{k}", {"id": 100 + k, "kind": "backfill", "assetId": "aero", "slot": slot, "status": "queued"})
            if k != no_progress_job:
                for m in M5:
                    stored[m] |= set(r4_check.next_days(sorted(set(ALL_DAYS) - stored[m]), now))
            job = {"id": 100 + k, "kind": "backfill", "assetId": "aero", "slot": slot, "status": "done", "lastError": None,
                   "result": {"fetchLines": [f"flow_usd.voter_fees: pool scan allocator ...; remaining_missing: {len(set(ALL_DAYS) - stored[M5[0]])}"],
                              "written": {m: 7 for m in M5}}}
            jslug = slug("jobs", "--since", slot)
            for i in range(1, running_polls + 1):
                self.put(f"{jslug}.{i}", [dict(job, status="running", result=None)])
            if k == fail_job:
                job = dict(job, status="failed", lastError="fetch_partial: pool scan: chain 57073 2026-10-29 coverage 93%")
            if k != stuck_job:
                self.put(f"{jslug}.{running_polls + 1}", [job])
            else:
                self.put(jslug, [dict(job, status="running", result=None)])
            self.put(f"sql-ro_days.{k + 1}", self.days_rows(stored, dup if not any(set(ALL_DAYS) - stored[m] for m in M5) else ()))
        self.jobs = k
        self.put(f"sql-ro_days.{k + 2}", self.days_rows(stored, dup))

    def run_script(self, *args, answer="yes\n", now=NOW, polls="5"):
        env = dict(os.environ, HOME=str(self.home), R4_NOW=now, R4_POLLS=polls)
        p = subprocess.run(["bash", str(HERE / "r4-backfill.sh"), "prod", *args, "--fake", str(self.fake)], input=answer,
                           capture_output=True, text=True, env=env, timeout=120)
        return p.returncode, p.stdout + p.stderr

    def calls(self):
        f = self.work / ".fake" / "calls.log"
        return f.read_text().splitlines() if f.exists() else []

    def stops(self, reason, *args, **kw):
        rc, out = self.run_script(*args, **kw)
        self.assertEqual(rc, 1, out)
        lines = [x for x in out.splitlines() if x.startswith("STOP: ")]
        self.assertEqual(len(lines), 1, out)
        self.assertIn(reason, lines[0])
        return out

    def test_happy_path_purges_then_backfills_in_chunks_then_verifies(self):
        self.world(running_polls=2)
        rc, out = self.run_script("--expect-fees", "308")
        self.assertEqual(rc, 0, out)
        self.assertNotIn("STOP", out)
        self.assertIn("fees ok (308 aero flow_usd.fees rows to purge: derived 2, third_party 306; 0 open anomalies)", out)
        self.assertIn("Purge all 308 aero flow_usd.fees rows on prod", out)
        self.assertIn("purge ok (308 rows deleted, == the dry run) export /home/orion-prod/home/purged/aero-flow_usd.fees-20261128T150000Z.json", out)
        self.assertIn("plan ok (--backfill-days 37; at most ceil(37 / 7) + 1 = 7 jobs)", out)
        self.assertIn("chunk 1/7: days 2026-10-22..2026-10-28 (7) on all five metrics", out)
        self.assertIn("chunk 6/7: days 2026-11-25..2026-11-27 (3) on all five metrics", out)  # 37 = 5 x 7 + 2, + revision 11-25
        self.assertIn("chunk 7/7: nothing missing on any of the five metrics: the loop is done", out)
        self.assertIn("verify ok (5 metrics x 37 days 2026-10-22..2026-11-27: exactly one active one-day row each)", out)
        self.assertIn("remaining_missing: 30", out)
        calls = self.calls()
        purges = [c for c in calls if c.startswith("data purge")]
        self.assertEqual(purges, ["data purge aero --metrics flow_usd.fees", "data purge aero --metrics flow_usd.fees --yes"])
        jobs = [c for c in calls if c.startswith("job run-now")]
        self.assertEqual(len(jobs), 6)
        self.assertTrue(all(c == f"job run-now backfill aero --metrics {','.join(M5)} --backfill-days 37" for c in jobs))
        self.assertLess(calls.index(purges[1]), calls.index(jobs[0]))
        self.assertEqual(len([c for c in calls if c.startswith("jobs --since")]), 6 * 3)  # two running polls, then done
        self.assertIn("aero-flow_usd.fees-20261128T150000Z.json", (self.work / "exports.txt").read_text())

    def test_a_declined_prompt_deletes_nothing_and_queues_nothing(self):
        self.world()
        self.stops("purge not confirmed", answer="no\n")
        self.assertFalse(any(c.endswith("--yes") or c.startswith("job ") for c in self.calls()))
        self.stops("purge not confirmed", answer="")

    def test_an_expected_count_that_differs_stops_before_the_dry_run(self):
        self.world()
        self.stops("has 308 rows", "--expect-fees", "300")
        self.assertFalse(any(c.startswith("data purge") for c in self.calls()))

    def test_already_purged_skips_the_purge_and_resumes_the_backfill(self):
        self.world(fees=(), stored_days=ALL_DAYS[:20])
        rc, out = self.run_script(answer="")
        self.assertEqual(rc, 0, out)
        self.assertIn("already purged, the purge step is skipped", out)
        self.assertIn("plan ok (--backfill-days 37; at most ceil(17 / 7) + 1 = 4 jobs)", out)
        self.assertFalse(any(c.startswith("data purge") for c in self.calls()))
        self.assertEqual(len([c for c in self.calls() if c.startswith("job run-now")]), 3)

    def test_nothing_missing_queues_no_job(self):
        self.world(fees=(), stored_days=ALL_DAYS)
        rc, out = self.run_script(answer="")
        self.assertEqual(rc, 0, out)
        self.assertIn("plan ok (nothing missing: no backfill job needed)", out)
        self.assertFalse(any(c.startswith("job ") for c in self.calls()))

    def test_an_open_anomaly_stops_before_the_purge(self):
        self.world(anomalies=(41,))
        self.stops("1 open anomaly on aero flow_usd.fees (#41 source_failure_streak)")
        self.assertFalse(any(c.startswith("data purge") for c in self.calls()))

    def test_an_unexpected_source_type_stops(self):
        self.world(fees=(("third_party", 306), ("manual", 1)))
        self.stops("source type manual")

    def test_the_old_release_refuses_the_purge(self):
        self.world()
        self.put(slug("data", "purge", "aero", "--metrics", "flow_usd.fees"),
                 {"error": {"code": "purge_configured_metric", "message": "metric \"flow_usd.fees\" is still configured"}}, exit_code=1)
        self.stops("not on the R4 release yet")
        self.assertFalse(any(c.endswith("--yes") for c in self.calls()))

    def test_a_yes_that_differs_from_the_dry_run_stops(self):
        self.world()
        y = json.loads((self.fake / (slug("data", "purge", "aero", "--metrics", "flow_usd.fees", "--yes") + ".json")).read_text())
        y["perMetric"][0]["observations"] = 307
        self.put(slug("data", "purge", "aero", "--metrics", "flow_usd.fees", "--yes"), y)
        self.stops("purge --yes != dry run: observations 308 -> 307")
        self.assertFalse(any(c.startswith("job ") for c in self.calls()))

    def test_inside_the_gate_or_a_quiet_window_nothing_is_called(self):
        self.world()
        self.stops("inside the backfill gate (prod nightly 00:45 UTC", now="2026-11-28T22:00:00Z")
        self.stops("inside the RPC quiet window 05:00-06:30 PT", now="2026-11-28T13:30:00Z")
        self.assertEqual(self.calls(), [])

    def test_a_failed_job_stops(self):
        self.world(fail_job=2)
        out = self.stops("backfill job 102 failed: fetch_partial: pool scan: chain 57073 2026-10-29 coverage 93%")
        self.assertEqual(len([c for c in self.calls() if c.startswith("job run-now")]), 2)
        self.assertIn("chunk 2/7: days 2026-10-29..2026-11-04 (7)", out)

    def test_a_job_that_never_ends_stops_after_the_polls(self):
        self.world(stuck_job=1)
        self.stops("backfill job 101 not finished after 3 polls", polls="3")

    def test_a_job_that_stores_nothing_stops(self):
        self.world(no_progress_job=1)
        self.stops("the job stored no missing day")

    def test_verify_stops_on_two_active_rows_for_a_day(self):
        self.world(dup={("flow_usd.lp_fees", "2026-11-01")})
        self.stops("flow_usd.lp_fees more than one active row on 2026-11-01")

    def test_ssh_never_reads_stdin(self):
        # The purge confirmation comes on stdin; an ssh call before `read` would swallow it.
        src = (HERE / "r4-backfill.sh").read_text()
        ssh = [x for x in src.splitlines() if x.strip().startswith("ssh ")]
        self.assertEqual(len(ssh), 1)
        self.assertIn("ssh -n ", ssh[0])

    def test_usage(self):
        p = subprocess.run(["bash", str(HERE / "r4-backfill.sh"), "dev"], capture_output=True, text=True,
                           env=dict(os.environ, HOME=str(self.home)))
        self.assertEqual(p.returncode, 1)
        self.assertIn("usage: r4-backfill.sh <stage|prod>", p.stdout)
        p = subprocess.run(["bash", str(HERE / "r4-backfill.sh"), "prod", "--expect-fees", "x"], capture_output=True, text=True,
                           env=dict(os.environ, HOME=str(self.home)))
        self.assertEqual(p.returncode, 1)
        self.assertIn("--expect-fees takes a whole number", p.stdout)


class Allowlist(unittest.TestCase):
    def test_the_skeleton_is_aero_only_and_every_entry_a_todo(self):
        entries = flatdiff.load_allowlist(HERE / "r4-allowlist.json")
        self.assertEqual(list(entries), ["aero"])
        self.assertTrue(entries["aero"])
        for e in entries["aero"]:
            self.assertIs(e.get("todo"), True, e["glob"])
            self.assertTrue(e["glob"].startswith(("incomeStatement.", "notes")), e["glob"])
            for k in ("rel", "abs", "ratio", "old", "new", "absent"):
                self.assertNotIn(k, e, e["glob"])  # values are the controller's (Task 10)

    def test_the_skeleton_allows_nothing_yet(self):
        old = {"asset": "aero", "incomeStatement": {"revenue": {"annualized": 1.0}}}
        new = {"asset": "aero", "incomeStatement": {"revenue": {"annualized": 2.0}}}
        d = Path(tempfile.mkdtemp(prefix="r4-al-"))
        try:
            (d / "o.json").write_text(json.dumps(old))
            (d / "n.json").write_text(json.dumps(new))
            p = subprocess.run([sys.executable, str(HERE / "flatdiff.py"), str(d / "o.json"), str(d / "n.json"), "--allow",
                                str(HERE / "r4-allowlist.json"), "--asset", "aero"], capture_output=True, text=True)
            self.assertEqual(p.returncode, 1, p.stdout)
            self.assertIn("WARN todo", p.stdout)
        finally:
            shutil.rmtree(d)


class Generator(unittest.TestCase):
    def test_no_home_path_in_the_generator(self):
        src = (HERE / "r4-gen-scan.py").read_text()
        self.assertNotIn(".hermes", src)
        self.assertNotIn("expanduser", src)
        p = subprocess.run([sys.executable, str(HERE / "r4-gen-scan.py")], capture_output=True, text=True)
        self.assertEqual(p.returncode, 2)  # --scoping is required
        self.assertIn("--scoping", p.stderr)

    @unittest.skipUnless(os.environ.get("R4_SCOPING_DIR"), "R4_SCOPING_DIR (the phase3-r4-scoping directory) not set")
    def test_it_reproduces_the_aero_scan_block(self):
        p = subprocess.run([sys.executable, str(HERE / "r4-gen-scan.py"), "--scoping", os.environ["R4_SCOPING_DIR"], "--indent", "10"],
                           capture_output=True, text=True)
        self.assertEqual(p.returncode, 0, p.stderr)
        lines = (REPO / "assets" / "aero.yaml").read_text().splitlines()
        start = lines.index("        scan: &aero_scan") + 1
        gen = p.stdout.splitlines()
        self.assertEqual(lines[start:start + len(gen)], gen)
        self.assertNotRegex(lines[start + len(gen)], r"^          ")  # the block ends where the generated text ends


class LiveFixture(unittest.TestCase):
    def test_the_live_golden_holds_eight_chains_and_four_figures(self):
        g = json.loads((REPO / "tests" / "fixtures" / "poolscan" / "live-2026-11-26.json").read_text())
        self.assertEqual(g["day"], "2026-11-26")
        self.assertEqual(sorted(map(int, g["chains"])), sorted([8453, 1, 10, 42161, 57073, 4663, 5042, 99901]))
        for c in g["chains"].values():
            self.assertEqual(set(c), {"chain", "gross", "allocator", "vote_incentives", "protocol_subsidy"})
            self.assertLessEqual(c["allocator"], c["gross"])
        self.assertEqual(g["tolerance"], {"rel": 0.005, "absUsd": 1})


if __name__ == "__main__":
    unittest.main()
