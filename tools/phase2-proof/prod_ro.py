#!/usr/bin/python3
"""Read-only prod queries through orion-remote's `sql-ro` verb (prod only: a READ ONLY transaction as orion_prod_ro,
30 s statement timeout). Never writes. Stdlib only.

    P2_PROD_SSH='-i <key> -o IdentitiesOnly=yes orion-prod@<host>' prod_ro.py '<query>'

P2_PROD_SSH holds the ssh arguments (identity, options, user@host), split like a shell would; nothing about the host or
the key is built in, and an empty P2_PROD_SSH is refused. `-o BatchMode=yes` is always added, so a missing key fails
instead of prompting.

orion-remote prints `{"rows": [...]}` (or `{"error": {...}}`) and caps its output at 1 MB: a reply cut at the cap exits
0 with `orion-remote: output truncated at 1 MB` on stderr (and exactly 1 MB of stdout). Only that raises `Truncated`,
which callers that page (prod_copy.fetch_by_id) answer by halving the page. Any other reply that is not JSON (an ssh or
transport failure: exit 255 and no output, a non-zero exit, an empty reply) raises ProdRoError and is never retried.
A `json_agg(...)` column arrives as a JSON STRING, not a list: `unwrap_rows` takes either.
"""
import json
import os
import shlex
import subprocess
import sys

TIMEOUT_S = 120
# orion-remote v_sql_ro (scripts/provision/files/orion-remote): SQL_OUTPUT_CAP and the stderr line it prints on a cut.
OUTPUT_CAP_BYTES = 1024 * 1024
TRUNCATION_MARKER = "orion-remote: output truncated at 1 MB"


class ProdRoError(RuntimeError):
    pass


class Truncated(ProdRoError):
    """sql-ro's reply was cut at orion-remote's 1 MB cap (exit 0, the stderr marker or exactly the cap's bytes)."""


def quote_ident(name):
    """A Postgres identifier, double-quoted (inner quotes doubled)."""
    return '"' + str(name).replace('"', '""') + '"'


def quote_literal(text):
    """A Postgres string literal, single-quoted (inner quotes doubled; standard_conforming_strings is on)."""
    return "'" + str(text).replace("'", "''") + "'"


def remote_command(query):
    """The forced command's argument string: `sql-ro <query as one shell word>`."""
    return "sql-ro " + shlex.quote(query)


def ssh_argv(spec):
    """['ssh', '-o', 'BatchMode=yes', *spec split]; ProdRoError when spec is empty."""
    if spec is None or not str(spec).strip():
        raise ProdRoError(
            "P2_PROD_SSH is not set: give the ssh arguments for the prod forced-command key, e.g. "
            "P2_PROD_SSH='-i ~/.ssh/<prod key> -o IdentitiesOnly=yes orion-prod@<host>' (nothing is built in)"
        )
    return ["ssh", "-o", "BatchMode=yes", *shlex.split(spec)]


def is_truncated(stdout, returncode, stderr):
    """orion-remote cut the reply at its cap: exit 0 and its stderr marker, or exit 0 and exactly the cap's bytes."""
    if returncode != 0 or not stdout:
        return False
    return TRUNCATION_MARKER in (stderr or "") or len(stdout.encode("utf-8")) >= OUTPUT_CAP_BYTES


def parse_output(stdout, returncode, stderr):
    """The rows of one sql-ro reply. Not JSON: Truncated when cut at the cap (is_truncated), else ProdRoError (ssh or
    transport failure, never retried); ProdRoError on an error document or no rows."""
    try:
        doc = json.loads(stdout)
    except (json.JSONDecodeError, TypeError):
        detail = f"(exit {returncode}, {len(stdout or '')} bytes): {(stdout or '')[:200]!r} {(stderr or '')[:300]!r}"
        if is_truncated(stdout, returncode, stderr):
            raise Truncated(f"sql-ro: output truncated at the 1 MB cap {detail}") from None
        raise ProdRoError(f"sql-ro: no JSON reply, ssh or transport failure {detail}") from None
    if isinstance(doc, dict) and doc.get("error") is not None:
        raise ProdRoError(f"sql-ro error: {json.dumps(doc['error'])[:500]}")
    if not isinstance(doc, dict) or not isinstance(doc.get("rows"), list):
        raise ProdRoError(f"sql-ro: no rows list in the reply (exit {returncode}): {stdout[:200]!r}")
    return doc["rows"]


def unwrap_rows(value):
    """A json_agg column: sql-ro returns it as a JSON string; a list is taken as is; anything else is refused."""
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError:
            raise ProdRoError(f"json_agg column is not JSON: {value[:120]!r}") from None
    if not isinstance(value, list):
        raise ProdRoError(f"json_agg column is not a list: {type(value).__name__}")
    return value


def make_sql_ro(spec, run=subprocess.run):
    """sql_ro(query) -> rows, over `ssh <spec> sql-ro '<query>'`. `run` is injectable for tests."""
    argv = ssh_argv(spec)

    def sql_ro(query):
        out = run(argv + [remote_command(query)], capture_output=True, text=True, timeout=TIMEOUT_S)
        return parse_output(out.stdout, out.returncode, out.stderr)

    return sql_ro


def main(argv):
    if len(argv) != 1:
        print("usage: P2_PROD_SSH='<ssh args>' prod_ro.py '<query>'", file=sys.stderr)
        return 2
    try:
        rows = make_sql_ro(os.environ.get("P2_PROD_SSH"))(argv[0])
    except ProdRoError as e:
        print(f"prod_ro.py: {e}", file=sys.stderr)
        return 1
    print(json.dumps(rows, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
