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
            self.assertFalse(any(e.get("todo") for e in entries[a]), a)  # the addendum replaced every placeholder
        forbidden = ("incomeStatement.revenue.annualized", "incomeStatement.costOfRevenue.annualized", "incomeStatement.holderFlow.net",
                     "incomeStatement.yields.cash")
        for a, es in entries.items():
            for e in es:
                for p in forbidden:
                    self.assertFalse(flatdiff.glob_match(e["glob"], p), (a, e["glob"], p))

    def test_the_committed_allowlist_bounds_lit_dilution_derived_fields(self):
        # R21: LIT's +0.066% unlock change (Lighter's 500M vs DefiLlama's 499.67M) moves every dilution-derived field.
        golden = json.loads((HERE.parent.parent / "tests" / "report" / "golden" / "v2-report-13.json").read_text())
        old = json.loads(golden["lit/stored"]["report"])
        allow = (HERE / "r1-allowlist.json").read_text()

        def bumped(f):
            r = json.loads(json.dumps(old))
            s = r["incomeStatement"]
            d, y, pt = s["dilution"], s["yields"], s["perToken"]
            unlocks = next(x for x in d["releases"] if x["id"] == "unlocks")
            line = next(x for x in y["dilutionLines"] if x["id"] == "unlocks")
            for obj, k in ((d, "pct"), (d, "tokensPerYear"), (unlocks, "tokensPerYear"), (unlocks, "yield"),
                           (line, "tokensPerYear"), (line, "yield"), (y, "dilution"), (y, "netShareholder"),
                           (s["holderFlow"], "netOfDilution"), (pt, "dilution"), (pt["holderFlow"], "netOfDilution")):
                obj[k] *= f
            sup = d["supply"]
            sup["netPerYear"] += sup["addedPerYear"] * (f - 1)
            sup["addedPerYear"] *= f
            sup["netPct"] = sup["netPerYear"] / pt["totalSupply"]
            fdv = pt["perTokenFdv"]
            fdv["dilution"] *= f
            fdv["holderFlow"]["netOfDilution"] *= f
            return r

        moved = ["incomeStatement.yields.dilution", "incomeStatement.yields.netShareholder", "incomeStatement.holderFlow.netOfDilution",
                 "incomeStatement.perToken.dilution", "incomeStatement.perToken.holderFlow.netOfDilution",
                 "incomeStatement.perToken.perTokenFdv.dilution", "incomeStatement.perToken.perTokenFdv.holderFlow.netOfDilution",
                 "incomeStatement.dilution.pct", "incomeStatement.dilution.tokensPerYear",
                 "incomeStatement.dilution.releases[id=unlocks].yield", "incomeStatement.yields.dilutionLines[id=unlocks].yield",
                 "incomeStatement.dilution.supply.netPerYear"]
        code, res, _ = self.run_cli(old, bumped(1.00066), allow)
        self.assertEqual(code, 0, res["unallowed"])
        for p in moved:
            entries = next(d for d in res["diffs"] if d["path"] == p)["entries"]
            self.assertTrue(any("rel" in e["detail"] or "abs" in e["detail"] for e in entries), (p, entries))
        code, res, _ = self.run_cli(old, bumped(1.001), allow)
        self.assertEqual(code, 1)
        # Every rel-0.0007 path fails at +0.1% (supply.addedPerYear too, since fix round 1); supply.netPerYear (+12k
        # tokens) and supply.netPct (+1.2e-5) stay inside their abs 100000 / 0.0001.
        rel_paths = [p for p in moved if not p.endswith("netPerYear")] + [
            "incomeStatement.dilution.releases[id=unlocks].tokensPerYear", "incomeStatement.yields.dilutionLines[id=unlocks].tokensPerYear",
            "incomeStatement.dilution.supply.addedPerYear"]
        self.assertEqual(sorted(res["unallowed"]), sorted(rel_paths))
        # PUMP: the same paths, rel 1e-12.
        pump = {e["glob"]: e for e in flatdiff.load_allowlist(HERE / "r1-allowlist.json")["pump"]}
        for p in moved[:-1]:
            self.assertTrue(any(flatdiff.glob_match(g, p) and e.get("rel") == 1e-12 for g, e in pump.items() if g != "incomeStatement.dilution.*"), p)

    # --- fix round 1 -----------------------------------------------------------------------------------------------

    def golden_lit(self):
        golden = json.loads((HERE.parent.parent / "tests" / "report" / "golden" / "v2-report-13.json").read_text())
        return json.loads(golden["lit/stored"]["report"])

    def test_the_committed_allowlist_bounds_lit_dilution_outside_the_unlocks_line(self):
        # I-1: holder-flow-derived burnedPerYear, emissionsPerYear and the supply totals must not move freely, and no
        # release line may appear or vanish.
        old = self.golden_lit()
        allow = (HERE / "r1-allowlist.json").read_text()
        D = "incomeStatement.dilution"

        def mutated(fn):
            r = json.loads(json.dumps(old))
            fn(r["incomeStatement"]["dilution"])
            return r

        def setk(*keys, value=None, scale=None):
            def fn(d):
                obj = d
                for k in keys[:-1]:
                    obj = obj[k]
                obj[keys[-1]] = obj[keys[-1]] * scale if scale is not None else value
            return fn

        probes = {
            "burnedPerYear -> 0": (setk("supply", "burnedPerYear", value=0), [f"{D}.supply.burnedPerYear"]),
            "burnedPerYear -> null": (setk("supply", "burnedPerYear", value=None), [f"{D}.supply.burnedPerYear"]),
            "burnedPerYear +1e-12": (setk("supply", "burnedPerYear", scale=1 + 1e-12), [f"{D}.supply.burnedPerYear"]),
            "emissionsPerYear x2": (setk("emissionsPerYear", scale=2), [f"{D}.emissionsPerYear"]),
            "emissionsPerYear +1 token": (setk("emissionsPerYear", value=old["incomeStatement"]["dilution"]["emissionsPerYear"] + 1),
                                          [f"{D}.emissionsPerYear"]),
            "addedPerYear x1.001": (setk("supply", "addedPerYear", scale=1.001), [f"{D}.supply.addedPerYear"]),
            "netPct +0.0002": (setk("supply", "netPct", value=old["incomeStatement"]["dilution"]["supply"]["netPct"] + 0.0002),
                               [f"{D}.supply.netPct"]),
            "a new 9e9 release line": (lambda d: d["releases"].append({"id": "x", "tokensPerYear": 9e9, "yield": 9.0}),
                                       [f"{D}.releases[id=x].id", f"{D}.releases[id=x].tokensPerYear", f"{D}.releases[id=x].yield"]),
            "the unlocks line removed": (lambda d: d["releases"].clear(),
                                         [f"{D}.releases", f"{D}.releases[id=unlocks].id", f"{D}.releases[id=unlocks].tokensPerYear",
                                          f"{D}.releases[id=unlocks].yield"]),
            "a new field under dilution": (lambda d: d.update(newField=1), [f"{D}.newField"]),
        }
        for name, (fn, bad) in probes.items():
            code, res, err = self.run_cli(old, mutated(fn), allow)
            self.assertEqual(code, 1, (name, res))
            for p in bad:
                self.assertIn(p, res["unallowed"], name)
        # In bound: addedPerYear +0.066%, netPct +0.00005 pass.
        ok = mutated(lambda d: (setk("supply", "addedPerYear", scale=1.00066)(d),
                                setk("supply", "netPct", value=d["supply"]["netPct"] + 0.00005)(d)))
        self.assertEqual(self.run_cli(old, ok, allow)[0], 0)
        lit = {e["glob"]: e for e in flatdiff.load_allowlist(HERE / "r1-allowlist.json")["lit"]}
        self.assertEqual(lit[f"{D}.supply.burnedPerYear"]["abs"], 0)
        self.assertEqual(lit[f"{D}.emissionsPerYear"]["abs"], 0)
        self.assertEqual(lit[f"{D}.supply.addedPerYear"]["rel"], 0.0007)
        self.assertEqual(lit[f"{D}.supply.netPct"]["abs"], 0.0001)
        # No unbounded LIT entry matches any release-line path, existing or new.
        for g, e in lit.items():
            if "rel" not in e and "abs" not in e and not e.get("todo"):
                for p in (f"{D}.releases[id=x].tokensPerYear", f"{D}.releases[id=unlocks].tokensPerYear", f"{D}.releases",
                          f"{D}.supply.burnedPerYear"):
                    self.assertFalse(flatdiff.glob_match(g, p), (g, p))

    def test_the_committed_allowlist_never_matches_holder_flow_paths(self):
        entries = flatdiff.load_allowlist(HERE / "r1-allowlist.json")
        for p in ("incomeStatement.dilution.supply.burnedPerYear", "incomeStatement.holderFlow.byBucket.burn.net",
                  "incomeStatement.holders.byBucket.burn.annualized"):
            for a, es in entries.items():
                for e in es:
                    if flatdiff.glob_match(e["glob"], p):
                        # Only an exact entry (abs 0, or PUMP's rel 1e-12) may match a holder-flow path.
                        self.assertTrue(e.get("todo") or (e.get("abs") == 0 and "rel" not in e) or (e.get("rel", 1) <= 1e-12 and "abs" not in e),
                                        (a, e["glob"], p))

    def test_a_dotted_key_and_nested_keys_do_not_collide(self):
        self.assertNotEqual(set(flatdiff.flatten({"a": {"b": 1}})), set(flatdiff.flatten({"a.b": 1})))
        self.assertEqual(flatdiff.flatten({"a.b": 1}), {"a\\.b": 1})
        # Brackets and backslashes in a key are escaped too, so a key can't fake a list step or an escape.
        self.assertNotEqual(set(flatdiff.flatten({"a": [1]})), set(flatdiff.flatten({"a[0]": 1})))
        self.assertNotEqual(set(flatdiff.flatten({"a\\": {"b": 1}})), set(flatdiff.flatten({"a\\.b": 1})))
        # The reviewer's probe: the nested value changed, the dotted one did not -> both paths differ, exit 1.
        old = {**report(), "x": {"a": {"b": 1}, "a.b": 1}}
        new = {**report(), "x": {"a": {"b": 2}, "a.b": 1}}
        code, res, _ = self.run_cli(old, new, {"lit": []})
        self.assertEqual(code, 1)
        self.assertEqual(res["unallowed"], ["x.a.b"])
        old2 = {**report(), "x": {"a": {"b": 1}}}
        new2 = {**report(), "x": {"a.b": 1}}
        code, res, _ = self.run_cli(old2, new2, {"lit": []})
        self.assertEqual(code, 1)
        self.assertEqual(sorted(res["unallowed"]), ["x.a.b", "x.a\\.b"])

    def test_numeric_and_string_ids_do_not_collide(self):
        flat = flatdiff.flatten({"l": [{"id": 1, "v": 10}, {"id": "1", "v": 20}]})
        self.assertEqual(flat, {"l[id=#1].id": 1, "l[id=#1].v": 10, "l[id=1].id": "1", "l[id=1].v": 20})
        # A string id that looks like a tag or holds a bracket is escaped.
        self.assertEqual(set(flatdiff.flatten({"l": [{"id": "#1"}, {"id": 1}]})), {"l[id=\\#1].id", "l[id=#1].id"})
        self.assertEqual(set(flatdiff.flatten({"l": [{"id": "a]b"}]})), {"l[id=a\\]b].id"})
        # The reviewer's probe: the first element's value changed -> exit 1.
        old = {**report(), "l": [{"id": 1, "v": 10}, {"id": "1", "v": 20}]}
        new = {**report(), "l": [{"id": 1, "v": 11}, {"id": "1", "v": 20}]}
        code, res, _ = self.run_cli(old, new, {"lit": []})
        self.assertEqual(code, 1)
        self.assertEqual(res["unallowed"], ["l[id=#1].v"])
        # A number id changing type is a removed + added element, not "same".
        code, res, _ = self.run_cli({**report(), "l": [{"id": 1}]}, {**report(), "l": [{"id": "1"}]}, {"lit": []})
        self.assertEqual(code, 1)

    def test_golden_report_paths_are_unescaped(self):
        # Real reports use identifier keys and string ids, so the committed globs keep their plain form.
        golden = json.loads((HERE.parent.parent / "tests" / "report" / "golden" / "v2-report-13.json").read_text())
        for k, v in golden.items():
            if isinstance(v, dict) and isinstance(v.get("report"), str):
                for p in flatdiff.flatten(json.loads(v["report"])):
                    self.assertNotIn("\\", p, (k, p))
                    self.assertNotIn("[id=#", p, (k, p))

    def test_a_duplicate_asset_key_in_the_allowlist_exits_2(self):
        dup = '{"lit": [{"glob": "price", "reason": "x"}], "lit": []}'
        code, _, err = self.run_cli({**report(), "price": 1.8}, report(), dup)
        self.assertEqual(code, 2)
        self.assertIn("duplicate", err)
        # A duplicate key inside an entry too (the second glob would silently win).
        dup2 = '{"lit": [{"glob": "price", "glob": "incomeStatement.*", "reason": "x"}]}'
        self.assertEqual(self.run_cli(report(), report(), dup2)[0], 2)

    def test_a_bare_star_or_blank_glob_exits_2(self):
        for g in ("*", "**", "*.burnedPerYear", " ", ""):
            for where in ("lit", "*"):
                code, _, err = self.run_cli(report(), report(), {where: [{"glob": g, "reason": "y"}]})
                self.assertEqual(code, 2, (g, where))
                self.assertIn("glob", err)
        # A glob with a literal first segment is fine.
        self.assertEqual(self.run_cli(report(), report(), {"lit": [{"glob": "incomeStatement.*", "reason": "y"}]})[0], 0)

    # --- controller addendum (the real prod-copy run) ---------------------------------------------------------------

    def test_flatdiff_compiles_without_warnings(self):
        import warnings
        with warnings.catch_warnings():
            warnings.simplefilter("error")
            compile((HERE / "flatdiff.py").read_text(), "flatdiff.py", "exec")

    def test_lit_net_of_dilution_fields_are_bounded_rel_0_0008_on_their_own(self):
        lit = flatdiff.load_allowlist(HERE / "r1-allowlist.json")["lit"]
        net = ["incomeStatement.holderFlow.netOfDilution", "incomeStatement.perToken.holderFlow.netOfDilution",
               "incomeStatement.perToken.perTokenFdv.holderFlow.netOfDilution", "incomeStatement.yields.netShareholder"]
        old = self.golden_lit()
        for p in net:
            matching = [e for e in lit if flatdiff.glob_match(e["glob"], p)]
            self.assertEqual([(e["glob"], e.get("rel"), "abs" in e) for e in matching], [(p, 0.0008, False)], p)
        # rel 0.000729 (the real run) passes, 0.00081 fails, on each of the four.
        for f, want in ((1.000729, 0), (1.00081, 1)):
            new = json.loads(json.dumps(old))
            s = new["incomeStatement"]
            for obj in (s["holderFlow"], s["perToken"]["holderFlow"], s["perToken"]["perTokenFdv"]["holderFlow"]):
                obj["netOfDilution"] *= f
            s["yields"]["netShareholder"] *= f
            code, res, _ = self.run_cli(old, new, (HERE / "r1-allowlist.json").read_text())
            self.assertEqual(code, want, (f, res["unallowed"]))
            if want:
                self.assertEqual(sorted(res["unallowed"]), sorted(net))

    def test_the_committed_allowlist_has_exact_provenance_entries_and_no_todo(self):
        entries = flatdiff.load_allowlist(HERE / "r1-allowlist.json")
        for a, es in entries.items():
            for e in es:
                self.assertNotIn("todo", e, (a, e["glob"]))
                if a in ("lit", "vvv") and not e["glob"].startswith(("incomeStatement.dilution", "incomeStatement.yields",
                                                                      "incomeStatement.holderFlow", "incomeStatement.perToken",
                                                                      "incomeStatement.revenue.lines[id=business].crossCheck")):
                    self.assertNotIn("*", e["glob"], (a, e["glob"]))
        listing = lambda a: sorted(e["glob"] for e in entries[a] if e["glob"].startswith(("incomeStatement.flags", "incomeStatement.provenance", "incomeStatement.checks")))
        self.assertEqual(listing("lit"), sorted(["incomeStatement.flags", "incomeStatement.flags[0]", "incomeStatement.provenance.thirdParty",
                                                 "incomeStatement.provenance.thirdParty[0]"]))
        self.assertEqual(listing("vvv"), sorted(["incomeStatement.flags[3]", "incomeStatement.provenance.sources[2]", "incomeStatement.provenance.thirdParty",
                                                 "incomeStatement.provenance.thirdParty[0]", "incomeStatement.provenance.thirdParty[1]"]))
        for a in ("crv", "cvxcrv", "hype", "link", "sdcrv", "sky", "ycrv", "cake", "uni", "pump"):
            self.assertEqual(listing(a), [], a)
        # A provenance / flags / checks change on a no-diff asset now fails.
        old = {**report("crv"), "incomeStatement": {**report("crv")["incomeStatement"], "flags": ["x"]}}
        new = {**report("crv"), "incomeStatement": {**report("crv")["incomeStatement"], "flags": []}}
        code, res, _ = self.run_cli(old, new, (HERE / "r1-allowlist.json").read_text(), asset="crv")
        self.assertEqual(code, 1)
        self.assertEqual(sorted(res["unallowed"]), ["incomeStatement.flags", "incomeStatement.flags[0]"])


if __name__ == "__main__":
    unittest.main()
