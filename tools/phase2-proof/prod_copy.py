#!/usr/bin/python3
"""Phase 2 proof, step 1: a read-only copy of prod into a fresh local schema p2proof_<stamp> (replaces the SQLite
snapshot: since the Phase 1.5 cutover prod is Postgres on venus, and nothing may read the old SQLite database).

    P2_PROD_SSH='-i <prod key> -o IdentitiesOnly=yes orion-prod@<host>' prod_copy.py <P> <old release dir> <new worktree>

Prod is only ever read through orion-remote's `sql-ro` verb (prod_ro.py: a READ ONLY transaction as orion_prod_ro).
<P> (a new directory inside $TMPDIR) receives:
  schema            p2proof_<UTC stamp, lowercase>, written before anything is created in Postgres (cleanup.py reads it)
  old/, new/        homes. old/ gets the OLD release's assets/ personas/ skills/, new/ the worktree's; each has a
                    mode-600 .env of two lines, ORION_DATABASE_URL (orion_dev) and ORION_DB_SCHEMA (the same schema)
  migrate-old.json  `db migrate --json` by the OLD release (ORION_HOME=<P>/old, ORION_ENV_FILE=<P>/old/.env): the
                    schema then sits at the release's migration level, which must equal prod's max(schema_migrations.id)
  copy.json         per table: prod count, rows copied, local count; the observations per-asset sums, prod vs local
Steps: migrate (old release) -> refuse unless local migration level = prod's and the table and column sets match ->
truncate -> per table, page by id (`id > last and id <= top`, top = prod's max(id) read first, so rows the daemon adds
meanwhile are left out; the page halves whenever a reply is cut at orion-remote's 1 MB cap), buffer the whole table and
insert it in ONE transaction (observations.superseded_by references observations) -> local count must equal prod's
count up to top -> sequences set to max -> observations per asset: count, sum(value order by id), max(id), prod vs
local, must be equal (exactly: both sides add the same doubles in the same order). Any mismatch exits 1.
Then migrate the schema with the NEW dist (README, run order). Undo with cleanup.py <P>.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from prod_ro import ProdRoError, Unparseable, make_sql_ro, quote_ident, quote_literal, unwrap_rows  # noqa: E402

DEV_URL = "postgresql://orion_dev@/orion_dev?host=/var/run/postgresql"
SCHEMA_RE = re.compile(r"^p2proof_[0-9a-z_]+$")
CONFIG_DIRS = ("assets", "personas", "skills")
FIRST_PAGE = 400
SKIP_TABLES = ("schema_migrations",)  # written by the old release's own `db migrate`

TABLES_SQL = ("select c.relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace "
              "where n.nspname = current_schema() and c.relkind in ('r', 'p') order by 1")
# Both sides add the same doubles in the same order, so the sums must be bitwise equal.
OBS_SUMS_SQL = ("select asset_id, count(*)::int as n, sum(value order by id)::float8 as s, max(id)::bigint as m "
                "from observations where id <= {top} group by asset_id order by asset_id")


class CopyError(Exception):
    pass


def columns_sql(table):
    return ("select column_name as c from information_schema.columns where table_schema = current_schema() "
            f"and table_name = {quote_literal(table)} order by ordinal_position")


def page_sql(table, last, top, limit):
    return (f"select coalesce(json_agg(x order by x.id), '[]'::json) as j from (select * from {quote_ident(table)} "
            f"where id > {int(last)} and id <= {int(top)} order by id limit {int(limit)}) x")


def fetch_by_id(sql_ro, table, top, page=FIRST_PAGE):
    """Every prod row of `table` with id <= top, in id order. A page cut at the 1 MB cap (Unparseable) halves the page
    size and is asked again; at one row it is refused. Other errors are not retried."""
    rows, last = [], -1
    while True:
        try:
            got = unwrap_rows(sql_ro(page_sql(table, last, top, page))[0]["j"])
        except Unparseable:
            if page == 1:
                raise
            page = max(1, page // 2)
            continue
        if not got:
            return rows
        rows.extend(got)
        last = got[-1]["id"]


def fetch_all(sql_ro, table):
    """A table without an id column, in one reply (they are small: one consistent read)."""
    return unwrap_rows(sql_ro(f"select coalesce(json_agg(x), '[]'::json) as j from {quote_ident(table)} x")[0]["j"])


def insert_sql(schema, table, rows):
    """One transaction inserting every row (constraints deferred: a self-referencing FK sees the whole table)."""
    payload = json.dumps(rows)
    n = 0
    while f"$pj{n}$" in payload:
        n += 1
    tag = f"$pj{n}$"
    return (f"set search_path to {quote_ident(schema)}; begin; set constraints all deferred; "
            f"insert into {quote_ident(table)} overriding system value select * from "
            f"json_populate_recordset(null::{quote_ident(table)}, {tag}{payload}{tag}); commit;")


def copy_table(sql_ro, psql, schema, table, cols, page=FIRST_PAGE):
    """Copy one table; {prod, copied, local}; CopyError when the local count is not prod's."""
    if "id" in cols:
        top = int(sql_ro(f"select coalesce(max(id), 0)::bigint as m from {quote_ident(table)}")[0]["m"])
        n = int(sql_ro(f"select count(*)::int as n from {quote_ident(table)} where id <= {top}")[0]["n"])
        rows = fetch_by_id(sql_ro, table, top, page)
    else:
        rows = fetch_all(sql_ro, table)
        n = len(rows)
    if rows:
        psql(insert_sql(schema, table, rows))
    local = int(psql(f"select count(*) from {quote_ident(schema)}.{quote_ident(table)}").strip())
    res = {"prod": n, "copied": len(rows), "local": local}
    if local != n or len(rows) != n:
        raise CopyError(f"{table}: prod {n}, copied {len(rows)}, local {local}")
    return res


def sum_mismatches(prod, local):
    """Per asset: count (n), sum of value (s), max id (m), prod vs local; [] when every asset agrees exactly."""
    p = {r["asset_id"]: r for r in prod}
    q = {r["asset_id"]: r for r in local}
    errors = []
    for a in sorted(set(p) | set(q)):
        if a not in q or a not in p:
            errors.append(f"observations {a}: only on the {'prod' if a in p else 'local'} side")
            continue
        for k in ("n", "s", "m"):
            if p[a][k] != q[a][k]:
                errors.append(f"observations {a}: {k} prod {p[a][k]!r} vs local {q[a][k]!r}")
    return errors


def make_homes(P, release, worktree, schema):
    """old/ <- the release's config, new/ <- the worktree's; a two-line mode-600 .env in each."""
    for side, src in (("old", Path(release)), ("new", Path(worktree))):
        home = Path(P) / side
        home.mkdir()
        for d in CONFIG_DIRS:
            shutil.copytree(src / d, home / d)
        fd = os.open(home / ".env", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            os.write(fd, f"ORION_DATABASE_URL={DEV_URL}\nORION_DB_SCHEMA={schema}\n".encode())
        finally:
            os.close(fd)
        os.chmod(home / ".env", 0o600)


def make_psql(run=subprocess.run):
    def psql(sql):
        r = run(["psql", "-X", "-v", "ON_ERROR_STOP=1", "-Atq", DEV_URL], input=sql, capture_output=True, text=True)
        if r.returncode != 0:
            raise CopyError(f"psql failed ({r.returncode}): {r.stderr[-2000:]}")
        return r.stdout
    return psql


def local_json(psql, schema, query):
    out = psql(f"set search_path to {quote_ident(schema)}; select coalesce(json_agg(x), '[]'::json) from ({query}) x;")
    return json.loads(out.strip() or "[]")


def set_sequences(psql, schema):
    """Every sequence owned by a column of the schema set to that column's max (is_called false on an empty table)."""
    rows = local_json(psql, schema, (
        "select s.oid::regclass::text as seq, quote_ident(c.relname) as tbl, quote_ident(a.attname) as col "
        "from pg_class s join pg_namespace n on n.oid = s.relnamespace "
        "join pg_depend d on d.objid = s.oid and d.classid = 'pg_class'::regclass and d.refclassid = 'pg_class'::regclass "
        "and d.deptype in ('a', 'i') join pg_class c on c.oid = d.refobjid "
        "join pg_attribute a on a.attrelid = c.oid and a.attnum = d.refobjsubid "
        f"where s.relkind = 'S' and n.nspname = {quote_literal(schema)}"))
    for r in rows:
        psql(f"set search_path to {quote_ident(schema)}; select setval({quote_literal(r['seq'])}, "
             f"greatest(coalesce((select max({r['col']}) from {r['tbl']}), 0), 1), (select count(*) > 0 from {r['tbl']}));")
    return len(rows)


def copy_prod(P, release, worktree, sql_ro, psql, run=subprocess.run):
    P = Path(P)
    schema = "p2proof_" + time.strftime("%Y%m%dt%H%M%Sz", time.gmtime()).lower()
    if not SCHEMA_RE.match(schema):
        raise CopyError(f"bad schema name {schema}")
    P.mkdir()
    (P / "schema").write_text(schema + "\n")
    make_homes(P, release, worktree, schema)

    # 1. The local schema at the old release's migration level, which must be prod's.
    env = {k: v for k, v in os.environ.items() if not k.startswith("ORION_")}
    env.update(ORION_HOME=str(P / "old"), ORION_ENV_FILE=str(P / "old" / ".env"))
    r = run(["node", str(Path(release) / "dist" / "cli" / "index.js"), "db", "migrate", "--json"], cwd=str(P / "old"),
            env=env, capture_output=True, text=True)
    (P / "migrate-old.json").write_text(r.stdout + r.stderr)
    if r.returncode != 0:
        raise CopyError(f"old release db migrate failed (see {P / 'migrate-old.json'})")
    prod_mig = sql_ro("select max(id)::int as m from schema_migrations")[0]["m"]
    local_mig = psql(f"select max(id) from {quote_ident(schema)}.schema_migrations").strip()
    if str(prod_mig) != local_mig:
        raise CopyError(f"migration level: prod {prod_mig}, local {local_mig} (use the release prod runs)")

    # 2. Same tables, same columns.
    tables = [x["t"] for x in sql_ro(TABLES_SQL)]
    local_tables = [x["t"] for x in local_json(psql, schema, TABLES_SQL.replace("current_schema()", quote_literal(schema)))]
    if sorted(tables) != sorted(local_tables):
        raise CopyError(f"table sets differ: prod only {sorted(set(tables) - set(local_tables))}, local only {sorted(set(local_tables) - set(tables))}")
    copy = [t for t in tables if t not in SKIP_TABLES]
    cols = {}
    for t in copy:
        cols[t] = [x["c"] for x in sql_ro(columns_sql(t))]
        mine = [x["c"] for x in local_json(psql, schema, columns_sql(t).replace("current_schema()", quote_literal(schema)))]
        if cols[t] != mine:
            raise CopyError(f"{t}: columns differ, prod {cols[t]} vs local {mine}")

    # 3. Copy.
    if copy:
        psql(f"set search_path to {quote_ident(schema)}; truncate {', '.join(quote_ident(t) for t in copy)} cascade;")
    counts = {}
    for t in copy:
        counts[t] = copy_table(sql_ro, psql, schema, t, cols[t])
    seqs = set_sequences(psql, schema)

    # 4. Observations, per asset: count, sum(value), max(id), up to the top the copy read.
    report = {"schema": schema, "prod_migration": prod_mig, "tables": counts, "sequences_set": seqs}
    if "observations" in counts:
        top = int(local_json(psql, schema, "select coalesce(max(id), 0)::bigint as m from observations")[0]["m"])
        prod_sums = sql_ro(OBS_SUMS_SQL.format(top=top))
        local_sums = local_json(psql, schema, OBS_SUMS_SQL.format(top=top))
        report["observation_sums"] = {"prod": prod_sums, "local": local_sums}
        errors = sum_mismatches(prod_sums, local_sums)
        report["observation_sum_errors"] = errors
        (P / "copy.json").write_text(json.dumps(report, indent=1) + "\n")
        if errors:
            raise CopyError("observations per-asset sums differ: " + "; ".join(errors[:5]))
    (P / "copy.json").write_text(json.dumps(report, indent=1) + "\n")
    return report


def check_args(argv, environ):
    """(P, release, worktree, ssh spec) or CopyError; nothing is written before this passes."""
    if len(argv) != 3:
        raise CopyError("usage: P2_PROD_SSH='<ssh args>' prod_copy.py <P> <old release dir> <new worktree>")
    tmp = environ.get("TMPDIR")
    if not tmp:
        raise CopyError("TMPDIR is not set")
    root = Path(tmp).resolve()
    P = Path(argv[0]).resolve()
    if P == root or root not in P.parents:
        raise CopyError(f"{P} is not inside $TMPDIR ({root})")
    spec = environ.get("P2_PROD_SSH", "")
    if not spec.strip():
        raise CopyError("P2_PROD_SSH is not set: give the ssh arguments of the prod forced-command key, e.g. "
                        "P2_PROD_SSH='-i ~/.ssh/<prod key> -o IdentitiesOnly=yes orion-prod@<host>' (nothing is built in)")
    release, worktree = Path(argv[1]).resolve(), Path(argv[2]).resolve()
    if not (release / "dist" / "cli" / "index.js").is_file():
        raise CopyError(f"no {release}/dist/cli/index.js: the old side is an extracted release")
    for base in (release, worktree):
        for d in CONFIG_DIRS:
            if not (base / d).is_dir():
                raise CopyError(f"no {base / d}")
    if P.exists():
        raise CopyError(f"{P} exists: use a fresh directory (cleanup.py the old one)")
    return P, release, worktree, spec


def main(argv):
    try:
        P, release, worktree, spec = check_args(argv, os.environ)
    except CopyError as e:
        print(f"prod_copy.py: refused: {e}", file=sys.stderr)
        return 2
    try:
        rep = copy_prod(P, release, worktree, make_sql_ro(spec), make_psql())
    except (CopyError, ProdRoError) as e:
        print(f"prod_copy.py: FAILED: {e} (cleanup.py {P} drops what was made)", file=sys.stderr)
        return 1
    print(f"prod_copy ok: schema {rep['schema']}, {sum(v['local'] for v in rep['tables'].values())} rows in "
          f"{len(rep['tables'])} tables, observation sums equal; homes {P}/old and {P}/new")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
