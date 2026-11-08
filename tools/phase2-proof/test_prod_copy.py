"""Tests for the prod read-only copy (prod_ro.py, prod_copy.py): the pure parts, with a fake sql_ro and a fake psql.

Nothing here opens ssh, Postgres or the network.
Run: /usr/bin/python3 -m unittest tools/phase2-proof/test_prod_copy.py
"""
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import prod_copy  # noqa: E402
import prod_ro  # noqa: E402


class QuotingTest(unittest.TestCase):
    def test_identifiers_are_double_quoted_with_inner_quotes_doubled(self):
        self.assertEqual(prod_ro.quote_ident("observations"), '"observations"')
        self.assertEqual(prod_ro.quote_ident('we"ird'), '"we""ird"')

    def test_literals_are_single_quoted_with_inner_quotes_doubled(self):
        self.assertEqual(prod_ro.quote_literal("check_results"), "'check_results'")
        self.assertEqual(prod_ro.quote_literal("o'brien"), "'o''brien'")

    def test_the_remote_command_is_one_shell_word_after_the_verb(self):
        q = "select 'a b' as x"
        cmd = prod_ro.remote_command(q)
        self.assertTrue(cmd.startswith("sql-ro "))
        import shlex
        self.assertEqual(shlex.split(cmd), ["sql-ro", q])

    def test_the_ssh_target_is_required(self):
        for empty in (None, "", "   "):
            with self.assertRaises(prod_ro.ProdRoError) as e:
                prod_ro.ssh_argv(empty)
            self.assertIn("P2_PROD_SSH", str(e.exception))

    def test_the_ssh_target_is_split_and_batch_mode_forced(self):
        argv = prod_ro.ssh_argv("-i /k/key -o IdentitiesOnly=yes orion-prod@host")
        self.assertEqual(argv, ["ssh", "-o", "BatchMode=yes", "-i", "/k/key", "-o", "IdentitiesOnly=yes", "orion-prod@host"])


class UnwrapTest(unittest.TestCase):
    def test_json_agg_arrives_as_a_string_and_is_parsed(self):
        self.assertEqual(prod_ro.unwrap_rows('[{"id": 1}, {"id": 2}]'), [{"id": 1}, {"id": 2}])

    def test_a_list_is_taken_as_it_is(self):
        self.assertEqual(prod_ro.unwrap_rows([{"id": 1}]), [{"id": 1}])

    def test_anything_else_is_refused(self):
        for bad in ('{"id": 1}', 3, None, '"x"'):
            with self.assertRaises(prod_ro.ProdRoError):
                prod_ro.unwrap_rows(bad)

    def test_parse_output_reads_rows_and_refuses_errors_and_truncation(self):
        self.assertEqual(prod_ro.parse_output('{"rows": [{"n": 1}]}', 0, ""), [{"n": 1}])
        cut = '{"rows": [{"j": "[{\\"id\\": 1}, {\\"id'
        with self.assertRaises(prod_ro.Truncated):  # cut at orion-remote's 1 MB cap: exit 0 and its stderr marker
            prod_ro.parse_output(cut, 0, prod_ro.TRUNCATION_MARKER + "\n")
        with self.assertRaises(prod_ro.Truncated):  # exit 0 and exactly the cap's bytes (the marker lost)
            prod_ro.parse_output("x" * prod_ro.OUTPUT_CAP_BYTES, 0, "")
        with self.assertRaises(prod_ro.ProdRoError) as e:
            prod_ro.parse_output('{"error": {"code": "sql_error", "message": "permission denied"}}', 1, "")
        self.assertNotIsInstance(e.exception, prod_ro.Truncated)
        self.assertIn("permission denied", str(e.exception))

    def test_an_ssh_or_transport_failure_is_an_error_never_truncation(self):
        for stdout, rc, stderr in (
            ("", 255, "ssh: connect to host venus port 22: Connection refused"),  # ssh failed: exit 255, no output
            ("", 0, ""),  # nothing at all
            ('{"rows": [{"j": "[{', 1, ""),  # cut, but the remote exited non-zero
            ('{"rows": [{"j": "[{', 0, ""),  # cut short of the cap with no marker
        ):
            with self.assertRaises(prod_ro.ProdRoError) as e:
                prod_ro.parse_output(stdout, rc, stderr)
            self.assertNotIsInstance(e.exception, prod_ro.Truncated, (stdout, rc))
            self.assertIn(f"exit {rc}", str(e.exception))

    def test_sql_ro_calls_ssh_with_the_quoted_query(self):
        seen = []

        def run(argv, **kw):
            seen.append(argv)
            return subprocess.CompletedProcess(argv, 0, stdout='{"rows": [{"m": 6}]}', stderr="")

        sql_ro = prod_ro.make_sql_ro("orion-prod@host", run=run)
        self.assertEqual(sql_ro("select max(id) as m from schema_migrations"), [{"m": 6}])
        self.assertEqual(seen[0][:-1], ["ssh", "-o", "BatchMode=yes", "orion-prod@host"])
        self.assertEqual(seen[0][-1], "sql-ro 'select max(id) as m from schema_migrations'")


class FakeProd:
    """sql_ro over in-memory tables; a page whose JSON would exceed `cap` bytes comes back truncated (Truncated)."""

    def __init__(self, rows, cap=10**9):
        self.rows, self.cap, self.queries = rows, cap, []

    def __call__(self, q):
        self.queries.append(q)
        import re
        m = re.search(r"where id > (-?\d+) and id <= (\d+) order by id limit (\d+)", q)
        assert m, q
        last, top, limit = (int(x) for x in m.groups())
        page = [r for r in self.rows if last < r["id"] <= top][:limit]
        text = json.dumps(page)
        if len(text) > self.cap:
            raise prod_ro.Truncated("sql-ro: output truncated at the cap")
        return [{"j": text}]  # json_agg arrives as a string


class PagingTest(unittest.TestCase):
    def rows(self, n, pad=0):
        return [{"id": i, "x": "y" * pad} for i in range(1, n + 1)]

    def test_pages_by_id_up_to_top_and_collects_every_row(self):
        prod = FakeProd(self.rows(10))
        got = prod_copy.fetch_by_id(prod, "observations", top=9, page=4)
        self.assertEqual([r["id"] for r in got], list(range(1, 10)))
        self.assertIn('from "observations"', prod.queries[0])
        self.assertIn("where id > -1 and id <= 9", prod.queries[0])
        self.assertIn("where id > 4 and id <= 9", prod.queries[1])

    def test_a_truncated_page_halves_the_page_size_and_retries(self):
        prod = FakeProd(self.rows(20, pad=50), cap=250)  # 3 rows (~210 bytes) fit, 4 (~280) do not
        got = prod_copy.fetch_by_id(prod, "t", top=20, page=16)
        self.assertEqual([r["id"] for r in got], list(range(1, 21)))
        limits = [int(q.rsplit("limit ", 1)[1].split(")")[0]) for q in prod.queries]
        self.assertEqual(limits[:4], [16, 8, 4, 2])
        self.assertTrue(all(x == 2 for x in limits[4:]), limits)

    def test_a_single_row_too_big_for_the_cap_is_refused(self):
        prod = FakeProd(self.rows(3, pad=500), cap=100)
        with self.assertRaises(prod_ro.Truncated):
            prod_copy.fetch_by_id(prod, "t", top=3, page=4)

    def test_an_ssh_failure_aborts_at_once_and_is_never_retried_as_truncation(self):
        calls = []

        def run(argv, **kw):
            calls.append(argv)
            return subprocess.CompletedProcess(argv, 255, stdout="", stderr="ssh: connect to host venus port 22: Connection refused")

        sql_ro = prod_ro.make_sql_ro("orion-prod@host", run=run)
        with self.assertRaises(prod_ro.ProdRoError) as e:
            prod_copy.fetch_by_id(sql_ro, "t", top=3, page=16)
        self.assertNotIsInstance(e.exception, prod_ro.Truncated)
        self.assertIn("Connection refused", str(e.exception))
        self.assertEqual(len(calls), 1)

    def test_a_reply_cut_at_the_cap_over_ssh_halves_the_page(self):
        rows = self.rows(3)
        calls = []

        def run(argv, **kw):
            calls.append(argv[-1])
            if len(calls) == 1:  # the first page is cut at the cap: exit 0, orion-remote's marker on stderr
                return subprocess.CompletedProcess(argv, 0, stdout='{"rows": [{"j": "[{', stderr=prod_ro.TRUNCATION_MARKER + "\n")
            import re
            last, top, limit = (int(x) for x in re.search(r"where id > (-?\d+) and id <= (\d+) order by id limit (\d+)", argv[-1]).groups())
            page = [r for r in rows if last < r["id"] <= top][:limit]
            return subprocess.CompletedProcess(argv, 0, stdout=json.dumps({"rows": [{"j": json.dumps(page)}]}), stderr="")

        got = prod_copy.fetch_by_id(prod_ro.make_sql_ro("orion-prod@host", run=run), "t", top=3, page=16)
        self.assertEqual([r["id"] for r in got], [1, 2, 3])
        self.assertIn("limit 16", calls[0])
        self.assertIn("limit 8", calls[1])

    def test_other_errors_are_not_retried(self):
        def broken(q):
            raise prod_ro.ProdRoError("sql-ro error: permission denied")

        with self.assertRaises(prod_ro.ProdRoError):
            prod_copy.fetch_by_id(broken, "t", top=3, page=4)

    def test_an_empty_table_returns_no_rows(self):
        self.assertEqual(prod_copy.fetch_by_id(FakeProd([]), "t", top=0, page=4), [])


class InsertSqlTest(unittest.TestCase):
    def test_one_transaction_with_deferred_constraints_and_a_dollar_quoted_payload(self):
        rows = [{"id": 2, "superseded_by": None}, {"id": 1, "superseded_by": 2}]
        sql = prod_copy.insert_sql("p2proof_x", "observations", rows)
        self.assertTrue(sql.startswith('set search_path to "p2proof_x"; begin; set constraints all deferred; '))
        self.assertIn('insert into "observations" overriding system value select * from json_populate_recordset(null::"observations", ', sql)
        self.assertTrue(sql.endswith("; commit;"))
        tag = sql.split("json_populate_recordset(null::\"observations\", ")[1].split("[")[0]
        self.assertTrue(tag.startswith("$") and tag.endswith("$"))
        payload = sql.split(tag)[1]
        self.assertEqual(json.loads(payload), rows)

    def test_the_dollar_tag_never_occurs_in_the_payload(self):
        rows = [{"id": 1, "note": "$pj$ and $pj0$ and $pj1$"}]
        sql = prod_copy.insert_sql("p2proof_x", "t", rows)
        tag = sql.split('json_populate_recordset(null::"t", ')[1].split("[")[0]
        self.assertNotIn(tag, json.dumps(rows))
        self.assertEqual(sql.count(tag), 2)


class SumsTest(unittest.TestCase):
    def test_equal_sums_pass(self):
        a = [{"asset_id": "crv", "n": 3, "s": 1.5, "m": 9}]
        self.assertEqual(prod_copy.sum_mismatches(a, [dict(a[0])]), [])

    def test_a_count_sum_or_max_id_mismatch_or_a_missing_asset_fails(self):
        prod = [{"asset_id": "crv", "n": 3, "s": 1.5, "m": 9}, {"asset_id": "vvv", "n": 1, "s": 2.0, "m": 4}]
        for local, word in (
            ([{"asset_id": "crv", "n": 2, "s": 1.5, "m": 9}, prod[1]], "n"),
            ([{"asset_id": "crv", "n": 3, "s": 1.5000000000000002, "m": 9}, prod[1]], "s"),
            ([{"asset_id": "crv", "n": 3, "s": 1.5, "m": 8}, prod[1]], "m"),
            ([prod[0]], "vvv"),
        ):
            errs = prod_copy.sum_mismatches(prod, local)
            self.assertTrue(errs and any(word in e for e in errs), (local, errs))

    def test_the_sum_query_is_ordered_so_both_sides_add_in_the_same_order(self):
        self.assertIn("sum(value order by id)", prod_copy.OBS_SUMS_SQL)


class HomesTest(unittest.TestCase):
    def test_old_home_gets_the_release_config_new_home_the_worktree_and_both_a_two_line_600_env(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for src, tag in (("rel", "release"), ("wt", "worktree")):
                for d in ("assets", "personas", "skills"):
                    (root / src / d).mkdir(parents=True)
                    (root / src / d / "x.txt").write_text(tag)
            P = root / "p"
            P.mkdir()
            prod_copy.make_homes(P, root / "rel", root / "wt", "p2proof_20261107t000000z")
            for side, tag in (("old", "release"), ("new", "worktree")):
                for d in ("assets", "personas", "skills"):
                    self.assertEqual((P / side / d / "x.txt").read_text(), tag, (side, d))
                env = P / side / ".env"
                self.assertEqual(stat.S_IMODE(env.stat().st_mode), 0o600)
                self.assertEqual(env.read_text().splitlines(), [
                    f"ORION_DATABASE_URL={prod_copy.DEV_URL}", "ORION_DB_SCHEMA=p2proof_20261107t000000z"])

    def test_cli_refuses_without_p2_prod_ssh_before_writing_anything(self):
        with tempfile.TemporaryDirectory() as tmp:
            P = Path(tmp) / "p"
            env = {k: v for k, v in os.environ.items() if not k.startswith(("ORION_", "P2_"))}
            env["TMPDIR"] = tmp
            r = subprocess.run([sys.executable, str(HERE / "prod_copy.py"), str(P), tmp, tmp], capture_output=True, text=True, env=env)
            self.assertEqual(r.returncode, 2, r.stderr)
            self.assertIn("P2_PROD_SSH", r.stderr)
            self.assertFalse(P.exists())

    def test_cli_refuses_a_dir_outside_tmpdir(self):
        with tempfile.TemporaryDirectory() as tmp, tempfile.TemporaryDirectory() as other:
            env = {k: v for k, v in os.environ.items() if not k.startswith(("ORION_", "P2_"))}
            env.update(TMPDIR=tmp, P2_PROD_SSH="nobody@nowhere")
            r = subprocess.run([sys.executable, str(HERE / "prod_copy.py"), str(Path(other) / "p"), tmp, tmp], capture_output=True, text=True, env=env)
            self.assertEqual(r.returncode, 2, r.stderr)
            self.assertIn("not inside $TMPDIR", r.stderr)


class CopyTableTest(unittest.TestCase):
    """copy_table end to end with fakes: prod count vs local count, one insert per table."""

    def test_counts_must_match_and_the_table_is_inserted_once(self):
        rows = [{"id": i} for i in (1, 2, 5)]
        prod = FakeProd(rows)

        def sql_ro(q):
            if "count(*)" in q:
                return [{"n": 3}]
            if "max(id)" in q:
                return [{"m": 5}]
            return prod(q)

        inserts = []

        def psql(sql):
            if sql.startswith("set search_path"):
                inserts.append(sql)
                return ""
            return "3\n"

        res = prod_copy.copy_table(sql_ro, psql, "p2proof_x", "observations", ["id", "value"], page=2)
        self.assertEqual(res, {"prod": 3, "copied": 3, "local": 3})
        self.assertEqual(len(inserts), 1)

        def psql_short(sql):
            return "" if sql.startswith("set search_path") else "2\n"

        with self.assertRaises(prod_copy.CopyError):
            prod_copy.copy_table(sql_ro, psql_short, "p2proof_x", "observations", ["id", "value"], page=2)


if __name__ == "__main__":
    unittest.main()
