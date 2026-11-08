#!/usr/bin/python3
"""Drop a Phase 2 proof's Postgres schema and delete its scratch directory.

    cleanup.py <P>

<P> is the directory prod_copy.py filled; <P>/schema names the schema in orion_dev. Refuses (exit 2, nothing touched)
a <P> that is not strictly inside $TMPDIR, or a schema name not matching ^p2proof_[0-9a-z_]+$. Then runs
`DROP SCHEMA IF EXISTS "<s>" CASCADE` with psql, checks the schema is gone, and removes <P> with shutil.rmtree.
Without <P>/schema (prod_copy.py stopped before naming one) only <P> is removed.
"""
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

DEV_URL = "postgresql://orion_dev@/orion_dev?host=/var/run/postgresql"
SCHEMA_RE = re.compile(r"^p2proof_[0-9a-z_]+$")


class CleanupError(Exception):
    pass


def check(p, tmpdir=None):
    """The schema to drop (None when <P>/schema is absent); CleanupError on any refusal."""
    tmpdir = tmpdir if tmpdir is not None else os.environ.get("TMPDIR")
    if not tmpdir:
        raise CleanupError("TMPDIR is not set: cannot tell whether the directory is scratch")
    root = Path(tmpdir).resolve()
    target = Path(p).resolve()
    if target == root or root not in target.parents:
        raise CleanupError(f"{target} is not inside $TMPDIR ({root})")
    if not target.is_dir():
        raise CleanupError(f"{target} is not a directory")
    schema_file = target / "schema"
    if not schema_file.exists():
        return None
    schema = schema_file.read_text().strip()
    if not SCHEMA_RE.match(schema):
        raise CleanupError(f"schema {schema!r} does not match {SCHEMA_RE.pattern}")
    return schema


def psql(sql):
    r = subprocess.run(["psql", "-X", "-v", "ON_ERROR_STOP=1", "-At", DEV_URL, "-c", sql], capture_output=True, text=True)
    if r.returncode != 0:
        raise CleanupError(f"psql failed ({r.returncode}): {r.stderr.strip()}")
    return r.stdout.strip()


def main(argv):
    if len(argv) != 1:
        print("usage: cleanup.py <P>", file=sys.stderr)
        return 2
    try:
        schema = check(argv[0])
    except CleanupError as e:
        print(f"cleanup.py: refused: {e}", file=sys.stderr)
        return 2
    target = Path(argv[0]).resolve()
    try:
        if schema is not None:
            psql(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE')
            left = psql(f"SELECT count(*) FROM information_schema.schemata WHERE schema_name = '{schema}'")
            if left != "0":
                raise CleanupError(f"schema {schema} still exists after the drop")
            print(f"dropped schema {schema}")
    except CleanupError as e:
        print(f"cleanup.py: {e}; {target} kept", file=sys.stderr)
        return 1
    shutil.rmtree(target)
    print(f"removed {target}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
