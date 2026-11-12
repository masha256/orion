"""Tests for the Phase 3 R1 proof's flattening diff (stdlib unittest, synthetic temp files only).

Run: python3 -m unittest tools/phase3-proof/test_flatdiff.py
"""
import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import flatdiff  # noqa: E402


def report(asset="lit", unlocks=2000000, volume=None, cross_check=True):
    """A cut-down v2 report in the shape `report yield <a> --day D --json` prints."""
    lines = [{"id": "business", "method": "disclosed", "annualized": 100.0}]
    if cross_check:
        lines[0]["crossCheck"] = {"metric": "flow_usd.revenue_proxy", "annualized": 830741.3, "sourceType": "third_party"}
    return {
        "asset": asset,
        "day": "2026-11-11",
        "windowDays": 91,
        "price": 1.7,
        "incomeStatement": {
            "schema": 2,
            "revenue": {"annualized": 100.0, "lines": lines},
            "volume": volume if volume is not None else {"metrics": ["flow_usd.fees"], "annualized": 1212199.9, "growth": {"current": 3.0, "note": None}},
            "dilution": {"pct": 0.012, "tokensPerYear": 10000000 + unlocks, "releases": [{"id": "unlocks", "tokensPerYear": unlocks, "yield": 0.002}]},
            "provenance": {"thirdParty": ["revenue.business.cross_check"], "sources": ["disclosure:manual", "third_party:defillama"]},
            "checks": [],
        },
        "notes": [],
    }


class Files:
    def __init__(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def write(self, name, value):
        p = self.root / name
        p.write_text(value if isinstance(value, str) else json.dumps(value, indent=2) + "\n")
        return str(p)


class FlatdiffTest(unittest.TestCase):
    def setUp(self):
        self.f = Files()

    def tearDown(self):
        self.f.tmp.cleanup()

    def run_cli(self, old, new, allow, asset="lit", as_json=True):
        argv = [self.f.write("old.json", old), self.f.write("new.json", new), "--allow", self.f.write("allow.json", allow), "--asset", asset]
        if as_json:
            argv.append("--json")
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = flatdiff.main(argv)
        text = out.getvalue()
        return code, (json.loads(text) if as_json and code != 2 else text), err.getvalue()

    # --- flatten ---------------------------------------------------------------------------------------------------

    def test_flatten_keys_lists_by_id_and_scalars_by_index(self):
        flat = flatdiff.flatten(report())
        self.assertEqual(flat["incomeStatement.dilution.releases[id=unlocks].tokensPerYear"], 2000000)
        self.assertEqual(flat["incomeStatement.revenue.lines[id=business].crossCheck.sourceType"], "third_party")
        self.assertEqual(flat["incomeStatement.provenance.sources[1]"], "third_party:defillama")
        self.assertEqual(flat["incomeStatement.volume.growth.note"], None)
        # Empty containers are leaves, so [] -> [x] is visible.
        self.assertEqual(flat["incomeStatement.checks"], [])
        self.assertEqual(flat["notes"], [])

    def test_list_with_duplicate_or_missing_ids_is_keyed_by_index(self):
        self.assertEqual(flatdiff.flatten({"l": [{"id": "a", "v": 1}, {"id": "a", "v": 2}]}), {"l[0].id": "a", "l[0].v": 1, "l[1].id": "a", "l[1].v": 2})
        self.assertEqual(flatdiff.flatten({"l": [{"id": "a"}, {"v": 2}]}), {"l[0].id": "a", "l[1].v": 2})

    def test_glob_brackets_are_literal_and_star_crosses_dots(self):
        self.assertTrue(flatdiff.glob_match("a.lines[id=x].*", "a.lines[id=x].crossCheck.metric"))
        self.assertFalse(flatdiff.glob_match("a.lines[id=x].*", "a.lines[id=y].crossCheck.metric"))
        self.assertFalse(flatdiff.glob_match("a.lines[id=x]", "a.lines[i]"))
        self.assertTrue(flatdiff.glob_match("a.volume.*", "a.volume.growth.current"))
        self.assertFalse(flatdiff.glob_match("a.volume.*", "a.volume"))

    # --- exit codes ------------------------------------------------------------------------------------------------

    def test_identical_reports_exit_0(self):
        code, res, _ = self.run_cli(report(), report(), {"lit": []})
        self.assertEqual(code, 0)
        self.assertTrue(res["ok"])
        self.assertEqual(res["diffs"], [])

    def test_allowed_in_bound_change_exits_0(self):
        allow = {"lit": [{"glob": "incomeStatement.dilution.releases[id=unlocks].tokensPerYear", "rel": 0.0007, "reason": "cited schedule"}]}
        code, res, _ = self.run_cli(report(unlocks=2000000), report(unlocks=2001300), allow)  # +0.065%
        # tokensPerYear (the total) also moved and has no entry: the unlocks entry alone must not cover it.
        self.assertEqual(code, 1)
        self.assertEqual(res["unallowed"], ["incomeStatement.dilution.tokensPerYear"])
        allow["lit"].append({"glob": "incomeStatement.dilution.*", "reason": "dilution moves with the unlocks"})
        code, res, _ = self.run_cli(report(unlocks=2000000), report(unlocks=2001300), allow)
        self.assertEqual(code, 0, res)
        self.assertEqual(sorted(d["path"] for d in res["diffs"]), ["incomeStatement.dilution.releases[id=unlocks].tokensPerYear", "incomeStatement.dilution.tokensPerYear"])
        self.assertTrue(all(d["allowed"] for d in res["diffs"]))

    def test_out_of_bound_change_exits_1(self):
        # Both entries match the unlocks path: every bound that matches must hold (the unbounded one never relaxes it).
        allow = {"lit": [{"glob": "incomeStatement.dilution.*", "reason": "dilution"},
                         {"glob": "incomeStatement.dilution.releases[id=unlocks].tokensPerYear", "rel": 0.0007, "reason": "cited schedule"}]}
        code, res, _ = self.run_cli(report(unlocks=2000000), report(unlocks=2002000), allow)  # +0.1%
        self.assertEqual(code, 1)
        self.assertEqual(res["unallowed"], ["incomeStatement.dilution.releases[id=unlocks].tokensPerYear"])

    def test_abs_bound_and_either_bound_passes(self):
        allow = {"lit": [{"glob": "price", "abs": 0.01, "reason": "x"}]}
        self.assertEqual(self.run_cli(report(), {**report(), "price": 1.705}, allow)[0], 0)
        self.assertEqual(self.run_cli(report(), {**report(), "price": 1.72}, allow)[0], 1)
        allow = {"lit": [{"glob": "price", "abs": 0.001, "rel": 0.02, "reason": "x"}]}
        self.assertEqual(self.run_cli(report(), {**report(), "price": 1.72}, allow)[0], 0)

    def test_bounded_entry_refuses_a_non_numeric_change(self):
        allow = {"lit": [{"glob": "price", "rel": 0.5, "reason": "x"}]}
        self.assertEqual(self.run_cli(report(), {**report(), "price": None}, allow)[0], 1)
        allow = {"lit": [{"glob": "price", "reason": "x"}]}
        self.assertEqual(self.run_cli(report(), {**report(), "price": None}, allow)[0], 0)

    def test_int_vs_float_of_the_same_value_is_no_diff_but_bool_is(self):
        self.assertEqual(self.run_cli({**report(), "price": 2}, {**report(), "price": 2.0}, {})[0], 0)
        self.assertEqual(self.run_cli({**report(), "price": 1}, {**report(), "price": True}, {})[0], 1)

    def test_unlisted_path_exits_1(self):
        allow = {"lit": [{"glob": "incomeStatement.dilution.*", "reason": "dilution"}]}
        code, res, _ = self.run_cli(report(), {**report(), "price": 1.8}, allow)
        self.assertEqual(code, 1)
        self.assertEqual(res["unallowed"], ["price"])
        d = [x for x in res["diffs"] if x["path"] == "price"][0]
        self.assertEqual((d["kind"], d["old"], d["new"], d["allowed"]), ("changed", 1.7, 1.8, False))

    def test_entries_of_another_asset_do_not_apply(self):
        allow = {"cake": [{"glob": "price", "reason": "x"}]}
        self.assertEqual(self.run_cli(report(), {**report(), "price": 1.8}, allow)[0], 1)

    def test_star_entry_applies_to_every_asset(self):
        allow = {"*": [{"glob": "price", "rel": 0.1, "reason": "x"}]}
        for a in ("lit", "cake"):
            code, _, _ = self.run_cli(report(asset=a), {**report(asset=a), "price": 1.8}, allow, asset=a)
            self.assertEqual(code, 0, a)
        code, _, _ = self.run_cli(report(), {**report(), "price": 2.5}, allow)
        self.assertEqual(code, 1)

    def test_volume_to_not_measured_with_the_volume_globs(self):
        nm = {"metrics": [], "annualized": None, "growth": {"current": None, "note": "not measured"}, "notMeasured": "DefiLlama removed"}
        allow = {"cake": [{"glob": "incomeStatement.volume", "reason": "x"}, {"glob": "incomeStatement.volume.*", "reason": "x"}]}
        code, res, _ = self.run_cli(report(asset="cake"), report(asset="cake", volume=nm), allow, asset="cake")
        self.assertEqual(code, 0, res)
        kinds = {d["path"]: d["kind"] for d in res["diffs"]}
        self.assertEqual(kinds["incomeStatement.volume.metrics[0]"], "removed")
        self.assertEqual(kinds["incomeStatement.volume.metrics"], "added")  # the [] leaf
        self.assertEqual(kinds["incomeStatement.volume.notMeasured"], "added")
        self.assertEqual(kinds["incomeStatement.volume.annualized"], "changed")

    def test_id_keyed_element_removed_and_added(self):
        old, new = report(), report()
        new["incomeStatement"]["dilution"]["releases"] = [{"id": "labs_vest", "tokensPerYear": 5, "yield": 0.1}]
        code, res, _ = self.run_cli(old, new, {"lit": []})
        self.assertEqual(code, 1)
        kinds = {d["path"]: d["kind"] for d in res["diffs"]}
        self.assertEqual(kinds["incomeStatement.dilution.releases[id=unlocks].tokensPerYear"], "removed")
        self.assertEqual(kinds["incomeStatement.dilution.releases[id=labs_vest].tokensPerYear"], "added")
        allow = {"lit": [{"glob": "incomeStatement.dilution.releases[id=unlocks].*", "reason": "gone"},
                         {"glob": "incomeStatement.dilution.releases[id=labs_vest].*", "reason": "new"}]}
        self.assertEqual(self.run_cli(old, new, allow)[0], 0)

    def test_cross_check_removed_on_the_business_line(self):
        allow = {"vvv": [{"glob": "incomeStatement.revenue.lines[id=business].crossCheck.*", "reason": "cross-check dropped"}]}
        code, res, _ = self.run_cli(report(asset="vvv"), report(asset="vvv", cross_check=False), allow, asset="vvv")
        self.assertEqual(code, 0, res)
        self.assertEqual(len(res["diffs"]), 3)
        self.assertTrue(all(d["kind"] == "removed" for d in res["diffs"]))

    # --- warnings --------------------------------------------------------------------------------------------------

    def test_unmatched_entry_is_a_warning_not_a_failure(self):
        allow = {"lit": [{"glob": "incomeStatement.volume.*", "reason": "unused"}], "*": [{"glob": "nothing.here", "reason": "unused too"}],
                 "cake": [{"glob": "other.asset", "reason": "not this run"}]}
        code, res, _ = self.run_cli(report(), report(), allow)
        self.assertEqual(code, 0)
        self.assertEqual(sorted((u["asset"], u["glob"]) for u in res["unmatched"]), [("*", "nothing.here"), ("lit", "incomeStatement.volume.*")])
        code, text, _ = self.run_cli(report(), report(), allow, as_json=False)
        self.assertEqual(code, 0)
        self.assertIn("WARN unmatched", text)
        self.assertIn("incomeStatement.volume.*", text)

    def test_todo_entry_is_inert_and_listed(self):
        allow = {"lit": [{"glob": "price", "todo": True, "reason": "TODO: fill from the first diff run"}]}
        code, res, _ = self.run_cli(report(), {**report(), "price": 1.8}, allow)
        self.assertEqual(code, 1)
        self.assertEqual(res["unallowed"], ["price"])
        self.assertEqual([t["glob"] for t in res["todo"]], ["price"])
        code, text, _ = self.run_cli(report(), report(), allow, as_json=False)
        self.assertEqual(code, 0)
        self.assertIn("WARN todo", text)

    def test_text_output_lists_old_to_new_and_the_unallowed(self):
        code, text, _ = self.run_cli(report(), {**report(), "price": 1.8}, {"lit": []}, as_json=False)
        self.assertEqual(code, 1)
        self.assertIn("price: 1.7 -> 1.8", text)
        self.assertIn("NOT ALLOWED", text)
        self.assertIn("FAILED", text)

    # --- refusals (exit 2) -----------------------------------------------------------------------------------------

    def test_empty_file_exits_2_never_identical(self):
        for old, new in (("", ""), ("  \n", json.dumps(report())), (json.dumps(report()), "")):
            code, _, err = self.run_cli(old, new, {"lit": []})
            self.assertEqual(code, 2)
            self.assertIn("empty", err)

    def test_missing_unparseable_and_wrong_asset_exit_2(self):
        out = io.StringIO()
        with redirect_stdout(out), redirect_stderr(io.StringIO()):
            code = flatdiff.main([str(self.f.root / "nope.json"), self.f.write("n.json", report()), "--allow", self.f.write("a.json", {}), "--asset", "lit"])
        self.assertEqual(code, 2)
        self.assertEqual(self.run_cli("{not json", report(), {})[0], 2)
        self.assertEqual(self.run_cli(report(asset="cake"), report(), {})[0], 2)  # top-level asset != --asset
        self.assertEqual(self.run_cli([1, 2], [1, 2], {})[0], 2)  # not a report object
        self.assertEqual(self.run_cli({"error": "x"}, {"error": "x"}, {})[0], 2)  # no asset key

    def test_malformed_allowlist_exits_2(self):
        bad = [
            [],
            {"lit": {"glob": "x", "reason": "y"}},
            {"lit": [{"glob": "x"}]},
            {"lit": [{"glob": "x", "reason": ""}]},
            {"lit": [{"glob": "", "reason": "y"}]},
            {"lit": [{"glob": "x", "reason": "y", "rel": -1}]},
            {"lit": [{"glob": "x", "reason": "y", "abs": "0.1"}]},
            {"lit": [{"glob": "x", "reason": "y", "typo": 1}]},
            {"lit": [{"glob": "x", "reason": "y", "todo": "yes"}]},
        ]
        for allow in bad:
            code, _, err = self.run_cli(report(), report(), allow)
            self.assertEqual(code, 2, allow)
            self.assertTrue(err, allow)
        self.assertEqual(self.run_cli(report(), report(), {"_comment": "ignored", "lit": []})[0], 0)

    def test_the_committed_allowlist_loads(self):
        entries = flatdiff.load_allowlist(HERE / "r1-allowlist.json")
        self.assertNotIn("aero", entries)
        for a in ("cake", "uni"):
            self.assertIn("incomeStatement.volume.*", [e["glob"] for e in entries[a]])
        lit = {e["glob"]: e for e in entries["lit"]}
        self.assertEqual(lit["incomeStatement.dilution.releases[id=unlocks].tokensPerYear"]["rel"], 0.0007)
        pump = {e["glob"]: e for e in entries["pump"]}
        self.assertEqual(pump["incomeStatement.dilution.releases[id=unlocks].tokensPerYear"]["rel"], 1e-12)
        self.assertTrue(any(e["glob"].startswith("incomeStatement.revenue.lines[id=business].crossCheck") for e in entries["vvv"]))
        twelve = ["cake", "crv", "cvxcrv", "hype", "link", "lit", "pump", "sdcrv", "sky", "uni", "vvv", "ycrv"]
        for a in twelve:
            self.assertTrue(any(e.get("todo") for e in entries[a]), a)
        forbidden = ("incomeStatement.revenue.annualized", "incomeStatement.costOfRevenue.annualized", "incomeStatement.holderFlow.net",
                     "incomeStatement.yields.cash")
        for a, es in entries.items():
            for e in es:
                for p in forbidden:
                    self.assertFalse(flatdiff.glob_match(e["glob"], p), (a, e["glob"], p))


if __name__ == "__main__":
    unittest.main()
