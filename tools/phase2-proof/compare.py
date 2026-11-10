#!/usr/bin/python3
"""Compare the old and the new release's outputs written by reports.sh (Phase 2 cross-release proof).

    compare.py <out> [--parity parity.json] [--reclass expected.json]

<out>/old/<a>.json and <out>/new/<a>.json are `report yield <a> --day D --json`. Per asset, by what the sides print:
- the new side has v1 keys (V1_KEYS: a release with `--legacy`, Tasks 4-10): with its top-level `incomeStatement`
  deleted it must be the same JSON value as the old side: same keys in the same order, same types, numbers exactly
  equal (no tolerance); when it has no `incomeStatement` the raw bytes must be identical too.
- the new side has no v1 key (Task 11b retired v1 and `--legacy`) and the old side has `incomeStatement` (a release
  from Task 4 on): "old side's v2 == new side's v2" (ruling R11.2): the whole objects, same keys in the same order,
  same types, every number at rel <= 1e-12 (V2_REL_TOL).
- the new side has no v1 key and the old side has no `incomeStatement` (a release before Task 4, v1 only): the header
  (HEADER_KEYS) must be equal exactly; the figures are compared through the two maps below.
anomalies.json and proposals.json must be byte-identical. Every file must be non-empty and parseable, both sides must
list the same assets, the 13 named ones (ASSETS_13) among them, and <out>/status.tsv (side, file, exit code) must
record exit 0 for every run. Each report's top-level `asset` must be its file name and its `day` the D in
<out>/run.txt, on both sides.

--parity: {"<asset>": [[label, "<v2 path in new/<a>.json>", "<v1 path in old/<a>.json>"], ...]} (ruling R7): compare
reads both values from the reports; they must agree at rel <= 1e-12. A path missing on either side fails; null equals
null only when both are null.
--reclass: {"<asset>": {"<dotted path>": expected}} (expected.py); each path, read on the new side (incomeStatement
included), must equal the value at rel <= 1e-12.
G2 decision 2 (Mike, 2026-11-07): a residual field (RESIDUAL_USD_PATHS: incomeStatement.unreconciled.annualized, a
remainder in USD a year whose expected value is a difference of large terms) also passes at |new - expected| <= $0.01,
in either map. Nothing else has the floor: unreconciled.pct is a share (no USD floor applies, and no map compares it),
unreconciled.basis a string.
Paths are dotted keys; a step `key[field=value]` selects the one element of the list at `key` whose `field` is `value`
(e.g. `income.lines[id=vecrv_fees].annualized`); none or several matches is a missing path.
Once any new-side report has `incomeStatement` while its old side has none (v1 against v2), both maps are required and
together must cover the 13 assets exactly once each: PARITY_ASSETS in --parity, RECLASS_ASSETS in --reclass, nothing
else. A v2-vs-v2 run needs neither (ruling R11.2: the maps are kept only for an old release still printing v1).

Prints one line per asset (and per list file): `PASS <name>` or `FAIL <name>: <reason>`, then a summary; with --json,
one JSON object {"ok": bool, "lines": [...]} instead (T0 M6: read the result from the exit code or that object, never
by grepping the text). Exit 0 only on a full pass.
"""
import argparse
import json
import re
import sys
from pathlib import Path

REL_TOL = 1e-12
V2_REL_TOL = 1e-12
# G2 decision 2: the residual-type fields, listed explicitly, and their absolute floor in USD.
RESIDUAL_USD_PATHS = ("incomeStatement.unreconciled.annualized",)
RESIDUAL_ABS_USD = 0.01
LIST_FILES = ("anomalies.json", "proposals.json")
NOT_ASSETS = set(LIST_FILES) | {"expected.json", "parity.json"}
PARITY_ASSETS = ("aero", "cake", "crv", "cvxcrv", "hype", "link", "pump", "sky", "uni", "vvv")
RECLASS_ASSETS = ("sdcrv", "ycrv", "lit")
# Coverage: every one of the 13 repo assets must be compared, not merely 13 of anything.
ASSETS_13 = tuple(sorted(PARITY_ASSETS + RECLASS_ASSETS))
V2_KEY = "incomeStatement"
# The v1 report's keys (Task 11b removed them): their presence on the new side means it still prints v1 (--legacy).
V1_KEYS = ("flows", "buckets", "yields", "holderFlowGrowth", "supply", "income", "revenue", "volume", "revenueDisclosed")
# The figures v1 and v2 share outside the statement, compared exactly when a v2-only side meets a v1-only side.
HEADER_KEYS = ("asset", "day", "windowDays", "price", "marketCap", "fdv")


class Bad(Exception):
    """A file that cannot take part in the comparison (empty, unreadable, unparseable)."""


def load(path):
    """(raw bytes, parsed value) of a JSON output file; Bad when missing, empty or unparseable."""
    try:
        raw = Path(path).read_bytes()
    except OSError as e:
        raise Bad(f"{path}: unreadable ({e.strerror})") from None
    if not raw.strip():
        raise Bad(f"{path}: empty")
    try:
        return raw, json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as e:
        raise Bad(f"{path}: unparseable ({e})") from None


def first_diff(a, b, path="$"):
    """The first path where two parsed JSON values differ (key order and int/float/bool types count), else None."""
    if type(a) is not type(b):
        return f"{path} ({type(a).__name__} {json.dumps(a)[:60]} vs {type(b).__name__} {json.dumps(b)[:60]})"
    if isinstance(a, dict):
        ka, kb = list(a), list(b)
        for i, (x, y) in enumerate(zip(ka, kb)):
            if x != y:
                return f"{path} (key #{i}: {x!r} vs {y!r})"
            d = first_diff(a[x], b[y], f"{path}.{x}")
            if d:
                return d
        if len(ka) != len(kb):
            extra = ka[len(kb):] or kb[len(ka):]
            return f"{path} (key {extra[0]!r} only on the {'old' if len(ka) > len(kb) else 'new'} side)"
        return None
    if isinstance(a, list):
        for i, (x, y) in enumerate(zip(a, b)):
            d = first_diff(x, y, f"{path}[{i}]")
            if d:
                return d
        if len(a) != len(b):
            return f"{path} (length {len(a)} vs {len(b)})"
        return None
    if a != b:
        return f"{path} ({json.dumps(a)} vs {json.dumps(b)})"
    return None


def is_num(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool)


def first_diff_tol(a, b, path="$"):
    """first_diff, but two numbers pass at rel <= V2_REL_TOL (int vs float of the same value too: JSON does not keep
    the distinction a JS number has none of). Key order, lengths, strings, booleans and null stay exact."""
    if is_num(a) and is_num(b):
        r = rel_diff(a, b)
        return None if r <= V2_REL_TOL else f"{path} ({json.dumps(a)} vs {json.dumps(b)}: rel {r:.3g} > {V2_REL_TOL:g})"
    if type(a) is not type(b):
        return f"{path} ({type(a).__name__} {json.dumps(a)[:60]} vs {type(b).__name__} {json.dumps(b)[:60]})"
    if isinstance(a, dict):
        ka, kb = list(a), list(b)
        for i, (x, y) in enumerate(zip(ka, kb)):
            if x != y:
                return f"{path} (key #{i}: {x!r} vs {y!r})"
            d = first_diff_tol(a[x], b[y], f"{path}.{x}")
            if d:
                return d
        if len(ka) != len(kb):
            extra = ka[len(kb):] or kb[len(ka):]
            return f"{path} (key {extra[0]!r} only on the {'old' if len(ka) > len(kb) else 'new'} side)"
        return None
    if isinstance(a, list):
        for i, (x, y) in enumerate(zip(a, b)):
            d = first_diff_tol(x, y, f"{path}[{i}]")
            if d:
                return d
        if len(a) != len(b):
            return f"{path} (length {len(a)} vs {len(b)})"
        return None
    if a != b:
        return f"{path} ({json.dumps(a)} vs {json.dumps(b)})"
    return None


def has_v1(obj):
    """True when a report object carries any v1 key (a release that still prints v1)."""
    return isinstance(obj, dict) and any(k in obj for k in V1_KEYS)


def rel_diff(a, b):
    """|a - b| / max(|a|, |b|); 0 when equal (both null included); inf when only one is null or either isn't a number."""
    if a is None and b is None:
        return 0.0
    if not (is_num(a) and is_num(b)):
        return float("inf")
    if a == b:
        return 0.0
    return abs(a - b) / max(abs(a), abs(b))


def within_tol(v2_path, got, want):
    """(ok, reason detail): rel <= REL_TOL, or for a RESIDUAL_USD_PATHS field |got - want| <= RESIDUAL_ABS_USD."""
    r = rel_diff(got, want)
    if r <= REL_TOL:
        return True, ""
    if v2_path in RESIDUAL_USD_PATHS and is_num(got) and is_num(want):
        gap = abs(got - want)
        if gap <= RESIDUAL_ABS_USD:
            return True, ""
        return False, f"rel {r:.3g} > {REL_TOL:g} and abs {gap:.3g} > {RESIDUAL_ABS_USD:g} USD"
    return False, f"rel {r:.3g} > {REL_TOL:g}"


_MISSING = object()


_SELECT = re.compile(r"^([^\[\]]+)\[([A-Za-z_][A-Za-z0-9_]*)=([^\[\]]+)\]$")


def get_path(obj, dotted):
    """obj at a dotted path ("incomeStatement.revenue.annualized", "income.lines[id=vecrv_fees].annualized");
    _MISSING when any step is absent, or a `[field=value]` selector matches no element or more than one."""
    node = obj
    for step in dotted.split("."):
        m = _SELECT.match(step)
        key = m.group(1) if m else step
        if not isinstance(node, dict) or key not in node:
            return _MISSING
        node = node[key]
        if m:
            field, want = m.group(2), m.group(3)
            if not isinstance(node, list):
                return _MISSING
            found = [x for x in node if isinstance(x, dict) and x.get(field) == want]
            if len(found) != 1:
                return _MISSING
            node = found[0]
    return node


def read_status(out):
    """{(side, file): exit} from <out>/status.tsv; Bad when missing or malformed."""
    p = Path(out) / "status.tsv"
    try:
        text = p.read_text()
    except OSError:
        raise Bad(f"{p}: missing (reports.sh did not finish)") from None
    status = {}
    for n, row in enumerate(text.splitlines(), 1):
        if not row.strip():
            continue
        parts = row.split("\t")
        if len(parts) != 3 or not parts[2].lstrip("-").isdigit():
            raise Bad(f"{p}:{n}: malformed row {row!r}")
        status[(parts[0], parts[1])] = int(parts[2])
    return status


def read_day(out):
    """D from <out>/run.txt (reports.sh writes `day=<D>`); Bad when missing or without one."""
    p = Path(out) / "run.txt"
    try:
        text = p.read_text()
    except OSError:
        raise Bad(f"{p}: missing (reports.sh did not finish)") from None
    days = [row[len("day="):] for row in text.splitlines() if row.startswith("day=")]
    if len(days) != 1 or not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", days[0]):
        raise Bad(f"{p}: need exactly one day=YYYY-MM-DD line")
    return days[0]


def load_side_map(path, what):
    if path is None:
        return None
    _, value = load(path)
    if not isinstance(value, dict):
        raise Bad(f"{path}: the {what} file must be a JSON object keyed by asset")
    return {k: v for k, v in value.items() if not k.startswith("_")}


def check_parity(asset, new_obj, old_obj, pairs):
    """Each [label, v2 path, v1 path]: the new report's value at the v2 path vs the old report's at the v1 path."""
    if not isinstance(pairs, list) or not pairs:
        return f"parity: no pairs for {asset}"
    for pair in pairs:
        if not (isinstance(pair, list) and len(pair) == 3 and all(isinstance(x, str) and x for x in pair)):
            return f"parity: malformed pair {json.dumps(pair)[:80]} (need [label, v2 path, v1 path])"
        label, v2_path, v1_path = pair
        got = get_path(new_obj, v2_path)
        if got is _MISSING:
            return f"parity {label}: {v2_path} missing on the new side"
        want = get_path(old_obj, v1_path)
        if want is _MISSING:
            return f"parity {label}: {v1_path} missing on the old side"
        ok, why = within_tol(v2_path, got, want)
        if not ok:
            return f"parity {label}: new {v2_path} {json.dumps(got)} vs old {v1_path} {json.dumps(want)} ({why})"
    return None


def check_reclass(asset, new_obj, values):
    if not isinstance(values, dict) or not values:
        return f"reclass: no expected values for {asset}"
    for path, want in values.items():
        got = get_path(new_obj, path)
        if got is _MISSING:
            return f"reclass {path}: missing on the new side"
        ok, why = within_tol(path, got, want)
        if not ok:
            return f"reclass {path}: new {json.dumps(got)} vs expected {json.dumps(want)} ({why})"
    return None


def asset_names(side_dir):
    return {p.stem for p in Path(side_dir).glob("*.json") if p.name not in NOT_ASSETS}


def coverage_errors(parity, reclass):
    """Why the two maps do not cover the 13 assets exactly once (PARITY_ASSETS by --parity, RECLASS_ASSETS by
    --reclass), or [] when they do."""
    errors = []
    for asset in sorted(set(parity) | set(reclass) | set(PARITY_ASSETS) | set(RECLASS_ASSETS)):
        where = [n for n, m in (("--parity", parity), ("--reclass", reclass)) if asset in m]
        want = "--parity" if asset in PARITY_ASSETS else "--reclass" if asset in RECLASS_ASSETS else None
        if want is None:
            errors.append(f"{asset} is not one of the 13 assets (in {', '.join(where)})")
        elif where != [want]:
            errors.append(f"{asset} must be in {want} only, found in {', '.join(where) or 'neither'}")
    return errors


def compare_asset(out, asset, status, parity, reclass, day):
    """None on a pass, else the reason."""
    for side in ("old", "new"):
        code = status.get((side, f"{asset}.json"))
        if code is None:
            return f"{side}: no exit status recorded"
        if code != 0:
            return f"{side}: exited {code} (see {side}/{asset}.json.stderr)"
    try:
        old_raw, old = load(Path(out) / "old" / f"{asset}.json")
        new_raw, new = load(Path(out) / "new" / f"{asset}.json")
    except Bad as e:
        return str(e)
    if not isinstance(new, dict) or not isinstance(old, dict):
        return "not a JSON object (an error document?)"
    for side, obj in (("old", old), ("new", new)):
        if obj.get("asset") != asset:
            return f"{side}: asset is {json.dumps(obj.get('asset'))}, not {asset!r}"
        if obj.get("day") != day:
            return f"{side}: day is {json.dumps(obj.get('day'))}, not {day!r} (run.txt)"
    has_v2 = V2_KEY in new
    if not has_v1(new) and V2_KEY in old:
        # Ruling R11.2: no v1 on the new side, v2 on both: the old side's v2 report against the new side's.
        d = first_diff_tol(old, new)
        if d:
            return f"v2 differs at {d}"
        return None
    if not has_v1(new) and has_v1(old):
        # v1 only on the old side: the shared header exactly, the figures through the maps.
        for k in HEADER_KEYS:
            if k not in old or k not in new:
                return f"header key {k!r} missing on the {'old' if k not in old else 'new'} side"
            d = first_diff(old[k], new[k], f"$.{k}")
            if d:
                return f"header differs at {d}"
    else:
        legacy = {k: v for k, v in new.items() if k != V2_KEY}
        d = first_diff(old, legacy)
        if d:
            return f"legacy differs at {d}"
        if not has_v2 and old_raw != new_raw:
            return "same JSON value but the bytes differ (formatting)"
    if parity is not None and asset in parity:
        r = check_parity(asset, new, old, parity[asset])
        if r:
            return r
    if reclass is not None and asset in reclass:
        r = check_reclass(asset, new, reclass[asset])
        if r:
            return r
    return None


def has_income_statement(path):
    """True when the file is a JSON object with a top-level incomeStatement (unreadable files fail elsewhere)."""
    try:
        _, obj = load(path)
    except Bad:
        return False
    return isinstance(obj, dict) and V2_KEY in obj


def needs_maps(out, assets):
    """True when some asset's new side has incomeStatement and its old side has none: v2 figures against v1's."""
    return any(has_income_statement(out / "new" / f"{a}.json") and not has_income_statement(out / "old" / f"{a}.json") for a in assets)


def compare_list_file(out, name, status):
    for side in ("old", "new"):
        code = status.get((side, name))
        if code is None:
            return f"{side}: no exit status recorded"
        if code != 0:
            return f"{side}: exited {code} (see {side}/{name}.stderr)"
    try:
        old_raw, old = load(Path(out) / "old" / name)
        new_raw, new = load(Path(out) / "new" / name)
    except Bad as e:
        return str(e)
    if old_raw != new_raw:
        return f"bytes differ at {first_diff(old, new) or '(formatting only)'}"
    return None


def compare_out(out, parity=None, reclass=None):
    """(ok, lines) for <out>; parity/reclass are paths or None."""
    out = Path(out)
    lines = []
    try:
        status = read_status(out)
        day = read_day(out)
        parity_map = load_side_map(parity, "parity")
        reclass_map = load_side_map(reclass, "reclass")
    except Bad as e:
        return False, [f"FAIL setup: {e}"]
    old_assets, new_assets = asset_names(out / "old"), asset_names(out / "new")
    ok = True
    for only, side in ((old_assets - new_assets, "old"), (new_assets - old_assets, "new")):
        for a in sorted(only):
            lines.append(f"FAIL {a}: output only on the {side} side")
            ok = False
    assets = sorted(old_assets & new_assets)
    missing = [a for a in ASSETS_13 if a not in assets]
    if missing:
        lines.append(f"FAIL coverage: {len(missing)} of the 13 assets not on both sides: {', '.join(missing)}")
        ok = False
    if needs_maps(out, sorted(new_assets)):
        if parity_map is None or reclass_map is None:
            lines.append(f"FAIL setup: --parity and --reclass are both required (the new side has {V2_KEY}, the old side v1)")
            ok = False
        else:
            for e in coverage_errors(parity_map, reclass_map):
                lines.append(f"FAIL coverage: {e}")
                ok = False
    passed = 0
    for a in assets:
        reason = compare_asset(out, a, status, parity_map, reclass_map, day)
        if reason is None:
            passed += 1
            lines.append(f"PASS {a}")
        else:
            ok = False
            lines.append(f"FAIL {a}: {reason}")
    for name in LIST_FILES:
        reason = compare_list_file(out, name, status)
        lines.append(f"PASS {name}" if reason is None else f"FAIL {name}: {reason}")
        ok = ok and reason is None
    checks = [s for s, m in (("parity", parity_map), ("reclass", reclass_map)) if m is not None]
    lines.append(f"{'OK' if ok else 'FAILED'}: {passed}/{len(assets)} assets identical" + (f" (+ {', '.join(checks)})" if checks else ""))
    return ok, lines


def main(argv=None):
    ap = argparse.ArgumentParser(description=(__doc__ or "").split("\n\n")[0])
    ap.add_argument("out", help="the directory reports.sh wrote (old/, new/, status.tsv)")
    ap.add_argument("--parity", help="the parity map: {asset: [[label, v2 path (new side), v1 path (old side)], ...]}")
    ap.add_argument("--reclass", help="expected.json from expected.py: {asset: {dotted path: value}}")
    ap.add_argument("--json", action="store_true", help='print {"ok": bool, "lines": [...]} instead of the text lines')
    args = ap.parse_args(argv)
    ok, lines = compare_out(args.out, parity=args.parity, reclass=args.reclass)
    if args.json:
        print(json.dumps({"ok": ok, "lines": lines}))
    else:
        for line in lines:
            print(line)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
