#!/usr/bin/python3
"""Read-only prod queries through orion-remote's `sql-ro` verb (prod only: a READ ONLY transaction as orion_prod_ro,
30 s statement timeout). Never writes. Stdlib only.

    P2_PROD_SSH='-i <key> -o IdentitiesOnly=yes orion-prod@<host>' prod_ro.py '<query>'

P2_PROD_SSH holds the ssh arguments (identity, options, user@host), split like a shell would; nothing about the host or
the key is built in, and an empty P2_PROD_SSH is refused. `-o BatchMode=yes` is always added, so a missing key fails
instead of prompting.

orion-remote prints `{"rows": [...]}` (or `{"error": {...}}`) and caps its output at 1 MB: a reply cut at the cap is
not JSON and raises `Unparseable`, which callers that page (prod_copy.fetch_by_id) answer by halving the page.
A `json_agg(...)` column arrives as a JSON STRING, not a list: `unwrap_rows` takes either.
"""
import json
import os
import shlex
import subprocess
import sys

TIMEOUT_S = 120


class ProdRoError(RuntimeError):
    pass


class Unparseable(ProdRoError):
    """sql-ro printed something that is not JSON: most often a reply truncated at orion-remote's 1 MB cap."""


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


def parse_output(stdout, returncode, stderr):
    """The rows of one sql-ro reply; Unparseable when not JSON, ProdRoError on an error document or no rows."""
    try:
        doc = json.loads(stdout)
    except (json.JSONDecodeError, TypeError):
        raise Unparseable(f"sql-ro: unparseable output (exit {returncode}, {len(stdout or '')} bytes): "
                          f"{(stdout or '')[:200]!r} {(stderr or '')[:300]!r}") from None
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
