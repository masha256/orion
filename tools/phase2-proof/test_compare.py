"""Tests for the Phase 2 cross-release proof harness (stdlib unittest, synthetic temp dirs only).

Run: python3 -m unittest tools/phase2-proof/test_compare.py
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import cleanup  # noqa: E402
import compare  # noqa: E402
import expected  # noqa: E402

ASSETS = ["aero", "cake", "crv", "cvxcrv", "hype", "link", "lit", "pump", "sdcrv", "sky", "uni", "vvv", "ycrv"]


def js_json(obj):
    """What the CLI prints: JSON.stringify(x, null, 2) and a newline."""
    return json.dumps(obj, indent=2) + "\n"


def report(asset, revenue=100.0):
    return {
        "asset": asset,
        "day": "2026-10-27",
        "windowDays": 90,
        "price": 1.25,
        "yields": {"cash": 0.031, "buyback": None},
        "income": {"revenue": {"annualized": revenue}, "lines": [{"id": "x", "to": "holders", "annualized": 3.5}]},
        "notes": [],
    }


class OutDir:
    """A synthetic <out> as reports.sh writes it."""

    def __init__(self, root, assets=ASSETS):
        self.root = Path(root)
        for side in ("old", "new"):
            (self.root / side).mkdir(parents=True)
        status = []
        for a in assets:
            for side in ("old", "new"):
                self.write(side, f"{a}.json", js_json(report(a)))
                status.append(f"{side}\t{a}.json\t0")
        for name, body in (("anomalies.json", [{"id": 1}]), ("proposals.json", [])):
            for side in ("old", "new"):
                self.write(side, name, js_json(body))
                status.append(f"{side}\t{name}\t0")
        (self.root / "status.tsv").write_text("\n".join(status) + "\n")
        (self.root / "run.txt").write_text(f"legacy=none\nassets={' '.join(assets)}\nday=2026-10-27\nORION_DB_SCHEMA=p2proof_x\n")

    def write(self, side, name, text):
        (self.root / side / name).write_text(text)

    def new_obj(self, asset):
        return json.loads((self.root / "new" / f"{asset}.json").read_text())


class CompareTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.out = OutDir(Path(self.tmp.name) / "out")

    def tearDown(self):
        self.tmp.cleanup()

    def run_compare(self, **kw):
        return compare.compare_out(self.out.root, **kw)

    def test_identical_json_passes(self):
        ok, lines = self.run_compare()
        self.assertTrue(ok, lines)
        self.assertEqual(sum(1 for l in lines if l.startswith("PASS ")), 15)  # 13 assets + anomalies + proposals

    def test_a_different_number_fails_and_names_the_path(self):
        self.out.write("new", "crv.json", js_json(report("crv", revenue=100.00000000000001)))
        ok, lines = self.run_compare()
        self.assertFalse(ok)
        crv = [l for l in lines if " crv" in l and l.startswith("FAIL")]
        self.assertEqual(len(crv), 1, lines)
        self.assertIn("$.income.revenue.annualized", crv[0])

    def test_int_vs_float_is_a_difference(self):
        obj = report("uni")
        obj["windowDays"] = 90.0
        self.out.write("new", "uni.json", js_json(obj))
        ok, _ = self.run_compare()
        self.assertFalse(ok)

    def test_key_order_is_a_difference(self):
        obj = report("uni")
        self.out.write("new", "uni.json", js_json(dict(reversed(list(obj.items())))))
        ok, _ = self.run_compare()
        self.assertFalse(ok)

    def test_an_empty_file_fails(self):
        for side in ("old", "new"):
            with self.subTest(side=side):
                self.tearDown()
                self.setUp()
                self.out.write(side, "hype.json", "")
                ok, lines = self.run_compare()
                self.assertFalse(ok)
                self.assertTrue(any(l.startswith("FAIL hype") and "empty" in l for l in lines), lines)

    def test_an_unparseable_file_fails(self):
        self.out.write("old", "hype.json", "{not json")
        ok, _ = self.run_compare()
        self.assertFalse(ok)

    def test_an_empty_anomalies_file_fails(self):
        self.out.write("new", "anomalies.json", "")
        ok, _ = self.run_compare()
        self.assertFalse(ok)

    def test_fewer_than_13_assets_fails(self):
        with tempfile.TemporaryDirectory() as d:
            out = OutDir(Path(d) / "out", assets=ASSETS[:12])
            ok, lines = compare.compare_out(out.root)
            self.assertFalse(ok)
            self.assertTrue(any("12" in l and "13" in l for l in lines), lines)

    def test_an_asset_missing_on_one_side_fails(self):
        (self.out.root / "new" / "sky.json").unlink()
        ok, _ = self.run_compare()
        self.assertFalse(ok)

    def test_a_non_zero_exit_in_the_status_file_fails(self):
        status = self.out.root / "status.tsv"
        status.write_text(status.read_text().replace("new\tlink.json\t0", "new\tlink.json\t1"))
        ok, lines = self.run_compare()
        self.assertFalse(ok)
        self.assertTrue(any(l.startswith("FAIL link") for l in lines), lines)

    def test_a_missing_status_file_fails(self):
        (self.out.root / "status.tsv").unlink()
        ok, _ = self.run_compare()
        self.assertFalse(ok)

    def write_parity(self, pairs):
        p = self.out.root / "parity.json"
        p.write_text(json.dumps(pairs))
        return p

    def write_reclass(self, values):
        p = self.out.root / "expected.json"
        p.write_text(json.dumps(values))
        return p

    def with_income_statement(self, value=100.0, assets=ASSETS):
        for a in assets:
            obj = report(a)
            obj["incomeStatement"] = {"revenue": {"annualized": value}}
            self.out.write("new", f"{a}.json", js_json(obj))

    REV_PAIR = ["revenue", "incomeStatement.revenue.annualized", "income.revenue.annualized"]

    def parity_map(self, **override):
        return dict({a: [self.REV_PAIR] for a in compare.PARITY_ASSETS}, **override)

    def reclass_map(self, **override):
        return dict({a: {"incomeStatement.revenue.annualized": 100.0} for a in compare.RECLASS_ASSETS}, **override)

    def run_v2(self, parity=None, reclass=None):
        return self.run_compare(
            parity=self.write_parity(self.parity_map() if parity is None else parity),
            reclass=self.write_reclass(self.reclass_map() if reclass is None else reclass),
        )

    def test_deleting_income_statement_makes_a_new_side_file_comparable(self):
        self.with_income_statement()
        ok, lines = self.run_v2()
        self.assertTrue(ok, lines)
        # but anything else extra on the new side still fails
        obj = self.out.new_obj("aero")
        obj["somethingNew"] = 1
        self.out.write("new", "aero.json", js_json(obj))
        ok, _ = self.run_v2()
        self.assertFalse(ok)

    # I1 / R7: the parity map names paths; compare reads both values from the reports.
    def test_parity_reads_the_values_from_both_reports(self):
        self.with_income_statement()
        ok, lines = self.run_v2()
        self.assertTrue(ok, lines)
        self.assertIn("parity", lines[-1])

    def test_a_parity_miss_over_1e12_rel_fails(self):
        self.with_income_statement()
        obj = self.out.new_obj("cake")
        obj["incomeStatement"]["revenue"]["annualized"] = 100.0 * (1 + 5e-13)
        self.out.write("new", "cake.json", js_json(obj))
        ok, lines = self.run_v2()
        self.assertTrue(ok, lines)
        obj["incomeStatement"]["revenue"]["annualized"] = 100.0 * (1 + 3e-12)
        self.out.write("new", "cake.json", js_json(obj))
        ok, lines = self.run_v2()
        self.assertFalse(ok)
        self.assertTrue(any(l.startswith("FAIL cake") and "parity revenue" in l for l in lines), lines)

    def test_a_self_consistent_map_does_not_pass_a_new_side_that_differs(self):
        """The old triple format ([label, 100, 100]) let any report through; values now come from the reports."""
        self.with_income_statement(value=250.0)
        ok, lines = self.run_v2(reclass=self.reclass_map(**{a: {"incomeStatement.revenue.annualized": 250.0} for a in compare.RECLASS_ASSETS}))
        self.assertFalse(ok)
        self.assertEqual(sum(1 for l in lines if l.startswith("FAIL ") and "parity revenue" in l), 10, lines)
        self.assertTrue(any(l.startswith("FAIL pump") for l in lines), lines)

    def test_value_triples_are_refused(self):
        self.with_income_statement()
        ok, lines = self.run_v2(parity=self.parity_map(uni=[["revenue", 100.0, 100.0]]))
        self.assertFalse(ok)
        self.assertTrue(any(l.startswith("FAIL uni") and "parity" in l for l in lines), lines)

    def test_a_parity_path_missing_on_either_side_fails(self):
        self.with_income_statement()
        for pair in (["r", "incomeStatement.nope.annualized", "income.revenue.annualized"],
                     ["r", "incomeStatement.revenue.annualized", "income.nope.annualized"]):
            with self.subTest(pair=pair):
                ok, lines = self.run_v2(parity=self.parity_map(hype=[pair]))
                self.assertFalse(ok)
                self.assertTrue(any(l.startswith("FAIL hype") and "missing" in l for l in lines), lines)

    def test_parity_null_equals_null_only_when_both_are_null(self):
        self.with_income_statement()
        # old side: yields.buyback is null in every report; new side: sky's v2 revenue null, link's a number
        for a, value in (("sky", None), ("link", 1.0)):
            new = self.out.new_obj(a)
            new["incomeStatement"]["revenue"]["annualized"] = value
            self.out.write("new", f"{a}.json", js_json(new))
        pair_nn = ["revenue", "incomeStatement.revenue.annualized", "yields.buyback"]
        ok, lines = self.run_v2(parity=self.parity_map(sky=[pair_nn], link=[pair_nn]))
        self.assertFalse(ok)
        self.assertTrue(any(l == "PASS sky" for l in lines), lines)
        self.assertTrue(any(l.startswith("FAIL link") and "parity revenue" in l for l in lines), lines)

    def test_parity_a_v1_number_against_a_v2_null_fails(self):
        """Task 3 fix round 1 (I1): VVV's v1 revenue growth is a number; a v2 that drops it to null must not pass."""
        self.with_income_statement()
        new = self.out.new_obj("vvv")
        new["incomeStatement"]["revenue"]["growth"] = {"annualized": None}
        self.out.write("new", "vvv.json", js_json(new))
        pair = ["revenue growth", "incomeStatement.revenue.growth.annualized", "income.revenue.annualized"]
        ok, lines = self.run_v2(parity=self.parity_map(vvv=[pair]))
        self.assertFalse(ok)
        self.assertTrue(any(l.startswith("FAIL vvv") and "parity revenue growth" in l and "null" in l for l in lines), lines)
        self.assertEqual(compare.rel_diff(None, 11.83), float("inf"))
        self.assertEqual(compare.rel_diff(11.83, None), float("inf"))

    def test_a_path_may_select_an_array_element_by_id(self):
        obj = {"income": {"lines": [{"id": "vecrv_fees", "annualized": 0.6}, {"id": "vote_incentives", "annualized": 1.7}]}}
        self.assertEqual(compare.get_path(obj, "income.lines[id=vecrv_fees].annualized"), 0.6)
        self.assertEqual(compare.get_path(obj, "income.lines[id=vote_incentives]"), obj["income"]["lines"][1])
        self.assertIs(compare.get_path(obj, "income.lines[id=nope].annualized"), compare._MISSING)
        self.assertIs(compare.get_path(obj, "income[id=vecrv_fees].annualized"), compare._MISSING)  # not a list
        dup = {"income": {"lines": [{"id": "a", "annualized": 1}, {"id": "a", "annualized": 2}]}}
        self.assertIs(compare.get_path(dup, "income.lines[id=a].annualized"), compare._MISSING)  # ambiguous
        # and through compare: a parity pair whose v1 side is an income line
        self.with_income_statement(value=3.5)
        pair = ["line x", "incomeStatement.revenue.annualized", "income.lines[id=x].annualized"]
        ok, lines = self.run_v2(parity={a: [pair] for a in compare.PARITY_ASSETS},
                                reclass=self.reclass_map(**{a: {"incomeStatement.revenue.annualized": 3.5} for a in compare.RECLASS_ASSETS}))
        self.assertTrue(ok, lines)

    # I2: once the new side has incomeStatement, both maps are required and cover all 13 exactly once.
    def test_a_v2_run_without_both_maps_fails(self):
        self.with_income_statement(assets=["aero"])
        for kw in ({}, {"parity": self.write_parity(self.parity_map())}, {"reclass": self.write_reclass(self.reclass_map())}):
            with self.subTest(given=sorted(kw)):
                ok, lines = self.run_compare(**kw)
                self.assertFalse(ok)
                self.assertTrue(any(l.startswith("FAIL setup") and "--parity" in l and "--reclass" in l for l in lines), lines)

    def test_a_v1_run_needs_no_maps(self):
        ok, lines = self.run_compare()
        self.assertTrue(ok, lines)

    def test_every_asset_must_be_covered_by_exactly_one_map(self):
        self.with_income_statement()
        no_vvv = {a: v for a, v in self.parity_map().items() if a != "vvv"}
        no_lit = {a: v for a, v in self.reclass_map().items() if a != "lit"}
        cases = {
            "parity asset missing": (no_vvv, None, "vvv"),
            "reclass asset missing": (None, no_lit, "lit"),
            "in both maps": (self.parity_map(lit=[self.REV_PAIR]), None, "lit"),
            "parity asset in the reclass map": (no_vvv, self.reclass_map(vvv={"incomeStatement.revenue.annualized": 100.0}), "vvv"),
            "unknown asset": (self.parity_map(foo=[self.REV_PAIR]), None, "foo"),
        }
        for name, (parity, reclass, asset) in cases.items():
            with self.subTest(name):
                ok, lines = self.run_v2(parity=parity, reclass=reclass)
                self.assertFalse(ok)
                self.assertTrue(any(l.startswith("FAIL coverage") and asset in l for l in lines), lines)

    def test_a_reclass_value_off_by_more_than_1e12_rel_fails(self):
        self.with_income_statement()
        ok, lines = self.run_v2()
        self.assertTrue(ok, lines)
        ok, lines = self.run_v2(reclass=self.reclass_map(lit={"incomeStatement.revenue.annualized": 100.0 * (1 + 2e-12)}))
        self.assertFalse(ok)
        self.assertTrue(any(l.startswith("FAIL lit") and "incomeStatement.revenue.annualized" in l for l in lines), lines)

    # G2 decision 2 (Mike, 2026-11-07): a residual field passes at rel <= 1e-12 OR abs <= $0.01; nothing else loosened.
    def with_unreconciled(self, value):
        self.with_income_statement()
        obj = self.out.new_obj("ycrv")
        obj["incomeStatement"]["unreconciled"] = {"annualized": value, "pct": -0.0001, "basis": "grossProfit"}
        self.out.write("new", "ycrv.json", js_json(obj))

    def test_the_residual_paths_are_listed_explicitly(self):
        self.assertEqual(compare.RESIDUAL_USD_PATHS, ("incomeStatement.unreconciled.annualized",))
        self.assertEqual(compare.RESIDUAL_ABS_USD, 0.01)

    def test_g2_2_the_observed_unreconciled_pair_passes_on_the_cent_floor(self):
        new, want = -88.17694701033179, -88.1769470104482
        self.assertGreater(compare.rel_diff(new, want), compare.REL_TOL)  # it fails the relative test alone
        self.with_unreconciled(new)
        ok, lines = self.run_v2(reclass=self.reclass_map(ycrv={"incomeStatement.revenue.annualized": 100.0, "incomeStatement.unreconciled.annualized": want}))
        self.assertTrue(ok, lines)

    def test_g2_2_a_two_cent_unreconciled_gap_fails(self):
        self.with_unreconciled(-88.15)
        ok, lines = self.run_v2(reclass=self.reclass_map(ycrv={"incomeStatement.revenue.annualized": 100.0, "incomeStatement.unreconciled.annualized": -88.17}))
        self.assertFalse(ok)
        self.assertTrue(any(l.startswith("FAIL ycrv") and "unreconciled" in l for l in lines), lines)

    def test_g2_2_the_floor_does_not_reach_other_fields(self):
        self.with_income_statement(value=100.005)
        ok, lines = self.run_v2(reclass=self.reclass_map(lit={"incomeStatement.revenue.annualized": 100.0}))
        self.assertFalse(ok)
        self.assertTrue(any(l.startswith("FAIL lit") for l in lines), lines)
        # nor the parity map's (a revenue pair a fraction of a cent apart still fails)
        ok, lines = self.run_v2(parity=self.parity_map(), reclass=self.reclass_map(**{a: {"incomeStatement.revenue.annualized": 100.005} for a in compare.RECLASS_ASSETS}))
        self.assertFalse(ok)
        self.assertTrue(any(l.startswith("FAIL aero") and "parity revenue" in l for l in lines), lines)

    def test_g2_2_a_null_residual_still_needs_a_null_expectation(self):
        self.with_unreconciled(None)
        ok, _ = self.run_v2(reclass=self.reclass_map(ycrv={"incomeStatement.revenue.annualized": 100.0, "incomeStatement.unreconciled.annualized": 0.0}))
        self.assertFalse(ok)

    def test_a_reclass_path_missing_on_the_new_side_fails(self):
        self.with_income_statement()
        ok, _ = self.run_v2(reclass=self.reclass_map(sdcrv={"incomeStatement.revenue.annualized": 100.0, "incomeStatement.belowLine.toHolders": 1.7}))
        self.assertFalse(ok)

    # M1: each report is the asset it is filed under, for day D (run.txt), on both sides.
    def test_a_report_for_another_asset_or_day_fails(self):
        for key, value in (("asset", "cake"), ("day", "2026-10-26")):
            for sides in (("old", "new"), ("new",)):
                with self.subTest(key=key, sides=sides):
                    self.tearDown()
                    self.setUp()
                    obj = report("crv")
                    obj[key] = value
                    for side in sides:
                        self.out.write(side, "crv.json", js_json(obj))
                    ok, lines = self.run_compare()
                    self.assertFalse(ok)
                    self.assertTrue(any(l.startswith("FAIL crv") and key in l for l in lines), lines)

    def test_a_missing_run_txt_fails(self):
        (self.out.root / "run.txt").unlink()
        ok, lines = self.run_compare()
        self.assertFalse(ok)
        self.assertTrue(any(l.startswith("FAIL setup") and "run.txt" in l for l in lines), lines)

    def test_cli_exit_codes(self):
        script = str(HERE / "compare.py")
        r = subprocess.run([sys.executable, script, str(self.out.root)], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.out.write("new", "vvv.json", "")
        r = subprocess.run([sys.executable, script, str(self.out.root)], capture_output=True, text=True)
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertIn("FAIL vvv", r.stdout)


def line(id_, annualized, to="holders"):
    return {"id": id_, "to": to, "annualized": annualized, "basis": "measured"}


def old_side(root):
    old = Path(root) / "out" / "old"
    old.mkdir(parents=True)
    sdcrv = {
        "asset": "sdcrv",
        "income": {
            "revenue": {"annualized": 3.6},
            "holders": {"annualized": 3.48},
            "protocol": {"annualized": 0.0},
            "lines": [line("vecrv_fees", 0.6), line("crv_fee_share", 0.3), line("vote_incentives", 1.7), line("boost_delegators", 0.12, "cost")],
        },
        "revenue": None,
        "volume": None,
    }
    ycrv = {
        "asset": "ycrv",
        "income": {
            "revenue": {"annualized": 2.31},
            "holders": {"annualized": 1.5},
            "protocol": {"annualized": 0.7},
            "lines": [line("ybs_payout", 1.5), line("treasury", 0.6, "protocol"), line("styc_fee", 0.1, "protocol")],
        },
        "revenue": None,
        "volume": {"annualized": 2.2},
        "buckets": {"burn": None, "hold": None, "cash": {"gross": 1.5, "net": 1.5}},
    }
    lit = {
        "asset": "lit",
        "income": {"revenue": {"annualized": 41.19}, "holders": {"annualized": 30.0}, "protocol": {"annualized": 11.19}, "lines": [line("buyback", 30.0)]},
        "revenue": {
            "basis": "streams",
            "annualized": 41.19,
            "streams": [
                {"id": "core", "annualized": 33.11},
                {"id": "robinhood", "annualized": 8.08, "share": 0.5, "grossAnnualized": 16.16},
            ],
        },
        "volume": {"annualized": 49.27},
    }
    for obj in (sdcrv, ycrv, lit):
        (old / f"{obj['asset']}.json").write_text(js_json(obj))
    new = old.parent / "new"
    new.mkdir()
    (new / "ycrv.json").write_text(js_json(ycrv_new(YCRV_MIX)))
    return old


# Task 7b: the new side's yCRV apportion mix (fees / gross), and its incentives twin.
YCRV_MIX = 0.25


def ycrv_new(mix, incentives_mix=None):
    inc = 1 - mix if incentives_mix is None and isinstance(mix, (int, float)) else incentives_mix
    return {
        "asset": "ycrv",
        "incomeStatement": {
            "holders": {"lines": [{"id": "ybs_payout", "apportion": {"mix": mix}}]},
            "belowLine": {"lines": [{"id": "incentives_to_holders", "apportion": {"mix": inc}}]},
        },
    }


class ExpectedTest(unittest.TestCase):
    def test_reclassification_table_formulas(self):
        with tempfile.TemporaryDirectory() as d:
            old = old_side(d)
            exp = expected.expected_values(old)
            self.assertAlmostEqual(exp["sdcrv"]["incomeStatement.revenue.annualized"], 3.6 - 1.7, places=15)
            self.assertEqual(exp["sdcrv"]["incomeStatement.belowLine.toHolders"], 1.7)
            self.assertEqual(exp["sdcrv"]["incomeStatement.operatingCosts.annualized"], 0.12)
            self.assertAlmostEqual(exp["sdcrv"]["incomeStatement.ratios.payoutRatio"], (0.6 + 0.3) / (3.6 - 1.7), places=15)
            m = YCRV_MIX
            # Task 7b: revenue is the fees share of the gross; the incentives share of the payouts is below the line.
            self.assertEqual(exp["ycrv"]["incomeStatement.revenue.annualized"], 2.2 * m)
            # R6: the st-yCRV fee is not in the v2 statement, so unreconciled never subtracts it.
            self.assertAlmostEqual(exp["ycrv"]["incomeStatement.unreconciled.annualized"], 2.2 * m - 1.5 * m - 0.6 * m, places=15)
            self.assertEqual(exp["ycrv"]["incomeStatement.belowLine.toHolders"], 1.5 * (1 - m))
            self.assertEqual(exp["ycrv"]["incomeStatement.holderFlow.gross"], 1.5)
            self.assertEqual(exp["ycrv"]["incomeStatement.holderFlow.net"], 1.5)
            self.assertAlmostEqual(exp["lit"]["incomeStatement.revenue.annualized"], 41.19 + (16.16 - 8.08), places=12)
            self.assertEqual(exp["lit"]["incomeStatement.costOfRevenue.annualized"], 16.16 * 0.5)
            self.assertEqual(exp["lit"]["incomeStatement.grossProfit.annualized"], 41.19)

    def test_ycrv_styc_separate_adds_the_styc_fee_line(self):
        with tempfile.TemporaryDirectory() as d:
            exp = expected.expected_values(old_side(d), ycrv_styc_separate=True)
            m = YCRV_MIX
            self.assertAlmostEqual(exp["ycrv"]["incomeStatement.revenue.annualized"], 2.2 * m + 0.1, places=15)
            self.assertAlmostEqual(exp["ycrv"]["incomeStatement.unreconciled.annualized"], 2.2 * m + 0.1 - 1.5 * m - 0.6 * m - 0.1, places=15)

    def test_ycrv_unreconciled_reads_the_ybs_payout_and_treasury_lines_not_the_protocol_total(self):
        """R6: a protocol total that differs from treasury (+ styc_fee) must not leak into unreconciled."""
        with tempfile.TemporaryDirectory() as d:
            old = old_side(d)
            obj = json.loads((old / "ycrv.json").read_text())
            obj["income"]["protocol"]["annualized"] = 9.9
            obj["income"]["holders"]["annualized"] = 9.9
            (old / "ycrv.json").write_text(js_json(obj))
            exp = expected.expected_values(old)
            m = YCRV_MIX
            self.assertAlmostEqual(exp["ycrv"]["incomeStatement.unreconciled.annualized"], 2.2 * m - 1.5 * m - 0.6 * m, places=15)
            obj["income"]["lines"] = [l for l in obj["income"]["lines"] if l["id"] != "treasury"]
            (old / "ycrv.json").write_text(js_json(obj))
            with self.assertRaises(expected.ExpectedError):
                expected.expected_values(old)

    def test_ycrv_mix_is_read_from_the_new_side_and_must_lie_in_0_1(self):
        """Task 7b: the mix comes from the new side's apportion detail; missing, null or outside (0, 1) refuses."""
        for bad in (None, "0.25", True, 0, 1, 1.2, -0.1):
            with tempfile.TemporaryDirectory() as d:
                old = old_side(d)
                (old.parent / "new" / "ycrv.json").write_text(js_json(ycrv_new(bad, 0.75)))
                with self.assertRaises(expected.ExpectedError, msg=repr(bad)):
                    expected.expected_values(old)
        with tempfile.TemporaryDirectory() as d:
            old = old_side(d)
            obj = ycrv_new(YCRV_MIX)
            del obj["incomeStatement"]["holders"]["lines"][0]["apportion"]
            (old.parent / "new" / "ycrv.json").write_text(js_json(obj))
            with self.assertRaises(expected.ExpectedError):
                expected.expected_values(old)
        with tempfile.TemporaryDirectory() as d:
            old = old_side(d)
            (old.parent / "new" / "ycrv.json").unlink()
            with self.assertRaises(expected.ExpectedError):
                expected.expected_values(old)

    def test_ycrv_senders_must_partition_the_gross(self):
        """Task 7b stop rule: fees mix + incentives mix must be 1 within 1e-9 (an unlisted sender otherwise)."""
        with tempfile.TemporaryDirectory() as d:
            old = old_side(d)
            (old.parent / "new" / "ycrv.json").write_text(js_json(ycrv_new(0.25, 0.75 + 2e-9)))
            with self.assertRaisesRegex(expected.ExpectedError, "differ from 1"):
                expected.expected_values(old)
            (old.parent / "new" / "ycrv.json").write_text(js_json(ycrv_new(0.25, 0.75 + 5e-10)))
            self.assertEqual(expected.expected_values(old)["ycrv"]["incomeStatement.revenue.annualized"], 2.2 * 0.25)

    def test_cli_new_side_option(self):
        with tempfile.TemporaryDirectory() as d:
            old = old_side(d)
            other = Path(d) / "elsewhere"
            other.mkdir()
            (other / "ycrv.json").write_text(js_json(ycrv_new(0.5)))
            (old.parent / "new" / "ycrv.json").unlink()
            r = subprocess.run([sys.executable, str(HERE / "expected.py"), str(old), "--new", str(other)], capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
            written = json.loads((old.parent / "expected.json").read_text())
            self.assertEqual(written["ycrv"]["incomeStatement.revenue.annualized"], 2.2 * 0.5)

    def test_cli_writes_expected_json_beside_old(self):
        with tempfile.TemporaryDirectory() as d:
            old = old_side(d)
            r = subprocess.run([sys.executable, str(HERE / "expected.py"), str(old)], capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
            written = json.loads((old.parent / "expected.json").read_text())
            self.assertEqual(sorted(k for k in written if not k.startswith("_")), ["lit", "sdcrv", "ycrv"])

    def test_a_missing_line_or_null_input_refuses(self):
        with tempfile.TemporaryDirectory() as d:
            old = old_side(d)
            obj = json.loads((old / "sdcrv.json").read_text())
            obj["income"]["lines"] = [l for l in obj["income"]["lines"] if l["id"] != "vote_incentives"]
            (old / "sdcrv.json").write_text(js_json(obj))
            with self.assertRaises(expected.ExpectedError):
                expected.expected_values(old)
        with tempfile.TemporaryDirectory() as d:
            old = old_side(d)
            obj = json.loads((old / "ycrv.json").read_text())
            obj["volume"]["annualized"] = None
            (old / "ycrv.json").write_text(js_json(obj))
            with self.assertRaises(expected.ExpectedError):
                expected.expected_values(old)

    def test_expected_json_round_trips_through_compare(self):
        """expected.py's output is what compare.py --reclass reads: paths resolve on a matching new side."""
        with tempfile.TemporaryDirectory() as d:
            exp = expected.expected_values(old_side(d))
            for asset, values in exp.items():
                if asset.startswith("_"):
                    continue
                obj = {}
                for path, v in values.items():
                    node = obj
                    *parents, leaf = path.split(".")
                    for p in parents:
                        node = node.setdefault(p, {})
                    node[leaf] = v
                for path, v in values.items():
                    self.assertEqual(compare.get_path(obj, path), v)


class CleanupTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.tmpdir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def proof_dir(self, schema):
        p = self.tmpdir / "p2"
        p.mkdir()
        (p / "schema").write_text(schema + "\n")
        return p

    def test_refuses_a_schema_name_not_p2proof(self):
        for bad in ("orion", "proof_20261104t000000z", "p2proof_X", "p2proof_1; drop schema orion", "p2proof_", "p2proof_a-b"):
            with self.subTest(bad=bad):
                p = self.proof_dir(bad)
                with self.assertRaises(cleanup.CleanupError):
                    cleanup.check(p, tmpdir=self.tmpdir)
                self.assertTrue(p.exists())
                (p / "schema").unlink()
                p.rmdir()

    def test_accepts_a_p2proof_schema_under_tmpdir(self):
        p = self.proof_dir("p2proof_20261104t120000z")
        self.assertEqual(cleanup.check(p, tmpdir=self.tmpdir), "p2proof_20261104t120000z")

    def test_refuses_a_dir_outside_tmpdir(self):
        with tempfile.TemporaryDirectory() as other:
            p = Path(other) / "p2"
            p.mkdir()
            (p / "schema").write_text("p2proof_20261104t120000z\n")
            with self.assertRaises(cleanup.CleanupError):
                cleanup.check(p, tmpdir=self.tmpdir)
            # tmpdir itself is not a proof dir
            with self.assertRaises(cleanup.CleanupError):
                cleanup.check(self.tmpdir, tmpdir=self.tmpdir)
            # nor a path that escapes it with ..
            with self.assertRaises(cleanup.CleanupError):
                cleanup.check(self.tmpdir / ".." / Path(other).name / "p2", tmpdir=self.tmpdir)
            self.assertTrue(p.exists())

    def test_cli_refuses_before_touching_postgres(self):
        p = self.proof_dir("orion")
        env = dict(os.environ, TMPDIR=str(self.tmpdir), PATH="/nonexistent")  # no psql reachable either way
        r = subprocess.run([sys.executable, str(HERE / "cleanup.py"), str(p)], capture_output=True, text=True, env=env)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("refus", r.stderr)
        self.assertTrue(p.exists())


# A dist whose CLI, like a release's (src/cli/paths.ts resolvePaths), exits 1 unless ORION_HOME is set and, here,
# ORION_ENV_FILE is exactly <ORION_HOME>/.env; otherwise it prints JSON (and a --legacy-free help text).
STRICT_CLI = r"""
const home = process.env.ORION_HOME || '';
const envFile = process.env.ORION_ENV_FILE || '';
if (home.trim() === '' || envFile !== home + '/.env') {
  process.stderr.write('error: a release needs ORION_HOME and ORION_ENV_FILE set; got ORION_HOME=' + home + ' ORION_ENV_FILE=' + envFile + '\n');
  process.exit(1);
}
const args = process.argv.slice(2);
if (args.includes('--help')) { process.stdout.write('Usage: orion report yield <asset> [--day <d>] [--json]\n'); process.exit(0); }
process.stdout.write(JSON.stringify({ args }, null, 2) + '\n');
"""


class ReportsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def release(self, name):
        """An extracted release: <name>/RELEASE beside <name>/dist/cli/index.js."""
        rel = self.root / name
        (rel / "dist" / "cli").mkdir(parents=True)
        (rel / "RELEASE").write_text(json.dumps({"tag": name, "commit": "x", "schema": 1, "built_at": "2026-11-04"}))
        (rel / "dist" / "cli" / "index.js").write_text(STRICT_CLI)
        return rel / "dist"

    def home(self, name):
        h = self.root / name
        (h / "assets").mkdir(parents=True)
        for a in ASSETS:
            (h / "assets" / f"{a}.yaml").write_text(f"id: {a}\n")
        (h / ".env").write_text("ORION_DATABASE_URL=postgresql://nobody@/none\nORION_DB_SCHEMA=p2proof_20261104t000000z\n")
        return h

    def test_reports_sh_passes_orion_env_file_for_a_release_on_both_sides(self):
        old, new = self.release("orion-old"), self.release("orion-new")
        h_old, h_new, out = self.home("old"), self.home("new"), self.root / "out"
        env = {k: v for k, v in os.environ.items() if not k.startswith("ORION_")}
        r = subprocess.run(
            ["bash", str(HERE / "reports.sh"), str(old), str(new), str(h_old), str(h_new), "2026-10-27", str(out)],
            capture_output=True, text=True, env=env,
        )
        self.assertEqual(r.returncode, 0, r.stderr)
        rows = [l.split("\t") for l in (out / "status.tsv").read_text().splitlines()]
        self.assertEqual(len(rows), 2 * (len(ASSETS) + 2))
        self.assertTrue(all(row[2] == "0" for row in rows), rows)


if __name__ == "__main__":
    unittest.main()
