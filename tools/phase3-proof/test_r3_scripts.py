"""Tests of the Phase 3 R3 release-block scripts (tools/phase3-proof/r3-s0.sh .. r3-s4.sh) in --fake mode: no ssh, no
deploy.sh; every remote call reads a fixture file (slug rule: r3-lib.sh). Fixtures: fixtures/r3/ (generate.py writes
them): happy/ passes s0..s4; each stop-*/ overlay breaks one artifact's check.

    python3 -m unittest tools/phase3-proof/test_r3_scripts.py
"""
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
FIX = HERE / "fixtures" / "r3"
NOW = "2026-11-20T12:00:00Z"
TAG = "orion-2026.11.20.1"
ASSETS = "aero cake crv cvxcrv hype link lit pump sdcrv sky uni vvv ycrv".split()


class R3Scripts(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="r3-test-"))
        self.home = self.tmp / "home"
        self.home.mkdir()
        self.work = self.home / "r3-stage"
        self.tools = self.tmp / "tag"
        shutil.copytree(FIX / "tools", self.tools)
        shutil.copy(HERE / "flatdiff.py", self.tools / "tools" / "phase3-proof" / "flatdiff.py")

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def fake(self, overlay=None):
        d = self.tmp / f"fake-{overlay or 'happy'}"
        if not d.exists():
            shutil.copytree(FIX / "happy", d)
            if overlay:
                shutil.copytree(FIX / overlay, d, dirs_exist_ok=True)
        return d

    def run_script(self, n, *args, overlay=None):
        env = dict(os.environ, HOME=str(self.home), R3_NOW=NOW, R3_POLLS="3")
        p = subprocess.run(["bash", str(HERE / f"r3-s{n}.sh"), "stage", *args, "--fake", str(self.fake(overlay))],
                           capture_output=True, text=True, env=env, timeout=120)
        return p.returncode, p.stdout + p.stderr

    def calls(self, n):
        f = self.work / ".fake" / f"r3-s{n}" / "calls.log"
        return f.read_text().splitlines() if f.exists() else []

    def ok(self, n, *args):
        rc, out = self.run_script(n, *args)
        self.assertEqual(rc, 0, out)
        self.assertNotIn("STOP", out)
        return out

    def stops(self, n, *args, overlay=None, reason=""):
        rc, out = self.run_script(n, *args, overlay=overlay)
        self.assertEqual(rc, 1, out)
        stop_lines = [line for line in out.splitlines() if line.startswith("STOP: ")]
        self.assertEqual(len(stop_lines), 1, out)
        self.assertIn(reason, stop_lines[0])
        return out

    # --- happy paths -------------------------------------------------------------------------------------------------

    def test_s0_writes_days_expected_and_before(self):
        out = self.ok(0)
        days = json.loads((self.work / "days.json").read_text())
        self.assertEqual((days["D"], days["D91"]), ("2026-11-18", "2026-08-19"))
        exp = json.loads((self.work / "expected.json").read_text())
        md = {a: x["marketData"]["active"] for a, x in exp["assets"].items() if x["marketData"]["active"]}
        self.assertEqual(md, {"aero": 45, "cake": 40, "crv": 43, "hype": 55, "link": 37, "lit": 38, "pump": 37, "sky": 36, "uni": 40, "vvv": 57})
        self.assertEqual(exp["marketDataTotal"], 428)
        self.assertEqual({a: x["oldLocator"]["active"] for a, x in exp["assets"].items() if x["oldLocator"]["active"]}, {"cvxcrv": 39, "sdcrv": 39, "ycrv": 39})
        self.assertEqual(exp["latestLevelsMarketData"], ["cake", "crv", "hype", "link", "lit", "pump", "sky", "uni", "vvv"])
        self.assertEqual({a: exp["assets"][a]["notRebuildable"] for a in ("aero", "hype", "pump", "cake")}, {"aero": 45, "hype": 55, "pump": 37, "cake": 0})
        self.assertEqual(exp["assets"]["cvxcrv"]["rebuilt"], 39)
        self.assertEqual(sorted(p.name for p in (self.work / "before").glob("*-91.json")), sorted(f"{a}-91.json" for a in ASSETS))
        self.assertIn("N6 rebuild-supply-levels verb ok", out)
        self.assertFalse(any("--yes" in c for c in self.calls(0)))

    def test_s0_refuses_a_second_run_and_keeps_days(self):
        self.ok(0)
        rc, out = self.run_script(0)
        self.assertEqual(rc, 1)
        self.assertIn("STOP: ", out)
        self.assertIn("s0 already ran", out)

    def test_s1_deploys_checks_the_switch_and_the_levels_exempt_then_zero(self):
        self.ok(0)
        out = self.ok(1, TAG, "--tools", str(self.tools))
        self.assertIn("expected pre-switch: 9 (assets cake crv hype link lit pump sky uni vvv)", out)
        self.assertIn("levels post ok (0 market_data in latest_levels", out)
        self.assertEqual(self.calls(1).count(f"jobs --since {NOW}"), 2)
        self.assertIn(f"deploy.sh stage {TAG}", self.calls(1))

    def test_s2_rebuilds_with_dry_then_yes_then_rechecks(self):
        self.ok(0)
        out = self.ok(2)
        self.assertIn("stale pre ok (expected pre-rebuild:", out)
        self.assertIn("cvxcrv market_data=0 old-locator=39", out)
        self.assertIn("stale rebuilt ok (left for step 7 (notRebuildable): aero market_data=45 hype market_data=55 pump market_data=37)", out)
        calls = self.calls(2)
        first_yes = next(i for i, c in enumerate(calls) if c.endswith("--yes"))
        dry = [i for i, c in enumerate(calls) if c.startswith("data rebuild-supply-levels") and not c.endswith("--yes")]
        self.assertEqual(len([i for i in dry if i < first_yes]), 13)  # every dry run before the first --yes
        self.assertEqual(len([c for c in calls if c.endswith("--yes")]), 13)

    def test_s3_purges_ten_assets_and_rechecks_zero(self):
        self.ok(0)
        out = self.ok(3)
        self.assertIn("hype purge dry ok (observations 55 withoutReplacement 55)", out)
        self.assertIn("cake purge dry ok (observations 40 withoutReplacement 0)", out)
        self.assertIn("market_data ok (0 rows in observations)", out)
        self.assertIn("stale purged ok (0 stale rows on all 13)", out)
        purged = [c.split()[2] for c in self.calls(3) if c.startswith("data purge") and c.endswith("--yes")]
        self.assertEqual(purged, ["aero", "cake", "crv", "hype", "link", "lit", "pump", "sky", "uni", "vvv"])
        self.assertEqual(len((self.work / "yes" / "exports.txt").read_text().splitlines()), 10)

    def test_s4_saves_after_and_passes_the_gate(self):
        self.ok(0)
        out = self.ok(4, "--tools", str(self.tools))
        self.assertIn("gate ok (26/26 flatdiff exit 0)", out)
        self.assertEqual(len(list((self.work / "after").glob("gate-*.txt"))), 26)

    # --- one STOP per artifact ---------------------------------------------------------------------------------------

    def test_s1_stops_when_latest_levels_still_holds_market_data_after_the_hourly_run(self):
        self.ok(0)
        self.stops(1, TAG, "--tools", str(self.tools), overlay="stop-levels-still-md",
                   reason="latest_levels still holds 9 market_data circulating rows after the hourly run")

    def test_s1_stops_when_no_levels_run_finishes(self):
        self.ok(0)
        self.stops(1, TAG, "--tools", str(self.tools), overlay="stop-no-levels-run", reason="no levels run on orion-2026.11.20.1 finished after 3 polls")

    def test_s1_stops_without_the_signed_values_before_deploying(self):
        self.ok(0)
        (self.tools / "tools" / "phase3-proof" / "r3-signed-circulating.json").unlink()
        self.stops(1, TAG, "--tools", str(self.tools), reason="r3-signed-circulating.json missing")
        self.assertEqual(self.calls(1), [])

    def test_s2_stops_when_a_market_data_count_differs_from_step_1(self):
        self.ok(0)
        self.stops(2, overlay="stop-md-count", reason="cake stale market_data 41 (expected 40)")
        self.assertFalse(any(c.startswith("data rebuild-supply-levels") for c in self.calls(2)))

    def test_s2_stops_on_a_refused_rebuild_row_before_any_yes(self):
        self.ok(0)
        self.stops(2, overlay="stop-refused", reason="crv rebuild dry run refused 1 rows")
        self.assertFalse(any(c.endswith("--yes") for c in self.calls(2)))

    def test_s3_stops_on_a_wrong_without_replacement_count_before_any_yes(self):
        self.ok(0)
        self.stops(3, overlay="stop-without-replacement", reason="hype purge dry run observations/withoutReplacement (55, 54), expected from step 1 (55, 55)")
        self.assertFalse(any(c.endswith("--yes") for c in self.calls(3)))

    def test_s3_stops_when_market_data_is_left_after_the_purge(self):
        self.ok(0)
        self.stops(3, overlay="stop-market-data", reason="observations with source_type market_data after the purge")

    def test_s4_stops_on_an_unallowed_path(self):
        self.ok(0)
        out = self.stops(4, "--tools", str(self.tools), overlay="stop-gate", reason="1 of 26 reports not allowed")
        self.assertIn("marketCap", out)

    def test_s4_stops_without_the_allowlist(self):
        self.ok(0)
        (self.tools / "tools" / "phase3-proof" / "r3-allowlist.json").unlink()
        self.stops(4, "--tools", str(self.tools), reason="r3-allowlist.json missing")
        self.assertEqual(self.calls(4), [])

    def test_later_scripts_stop_without_step_1s_file(self):
        self.stops(2, reason="expected.json missing")
        self.stops(4, "--tools", str(self.tools), reason="days.json missing")

    def test_no_head_pipe_anywhere(self):
        for f in sorted(HERE.glob("r3-*.sh")):
            self.assertNotIn("| head", f.read_text(), f.name)
            self.assertIn("set -u", f.read_text(), f.name)


if __name__ == "__main__":
    unittest.main()
