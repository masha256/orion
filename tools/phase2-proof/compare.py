#!/usr/bin/python3
"""Compare the old and the new release's outputs written by reports.sh (Phase 2 cross-release proof).

    compare.py <out> [--parity parity.json] [--reclass expected.json]

<out>/old/<a>.json and <out>/new/<a>.json are `report yield <a> --day D --json`; with the new side's top-level
`incomeStatement` deleted, the two must be the same JSON value: same keys in the same order, same types, numbers exactly
equal (no tolerance). When the new side has no `incomeStatement` the raw bytes must be identical too. anomalies.json and
proposals.json must be byte-identical. Every file must be non-empty and parseable, both sides must list the same assets,
at least 13 of them, and <out>/status.tsv (side, file, exit code) must record exit 0 for every run.

--parity: {"<asset>": [[label, a, b], ...]}; each pair must agree at rel <= 1e-12. Required for every PARITY_ASSETS asset
whose new side has an `incomeStatement`.
--reclass: {"<asset>": {"<dotted path>": expected}} (expected.py); each path, read on the new side (incomeStatement
included), must equal the value at rel <= 1e-12. Required for every RECLASS_ASSETS asset whose new side has one.

Prints one line per asset (and per list file): `PASS <name>` or `FAIL <name>: <reason>`, then a summary. Exit 0 only on
a full pass.
"""
import argparse
import json
import sys
from pathlib import Path

MIN_ASSETS = 13
REL_TOL = 1e-12
LIST_FILES = ("anomalies.json", "proposals.json")
NOT_ASSETS = set(LIST_FILES) | {"expected.json", "parity.json"}
PARITY_ASSETS = ("aero", "cake", "crv", "cvxcrv", "hype", "link", "pump", "sky", "uni", "vvv")
RECLASS_ASSETS = ("sdcrv", "ycrv", "lit")
V2_KEY = "incomeStatement"


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


def rel_diff(a, b):
    """|a - b| / max(|a|, |b|); 0 when equal (both null included); inf when only one is null or either isn't a number."""
    if a is None and b is None:
        return 0.0
    if not (is_num(a) and is_num(b)):
        return float("inf")
    if a == b:
        return 0.0
    return abs(a - b) / max(abs(a), abs(b))


_MISSING = object()


def get_path(obj, dotted):
    """obj at a dotted path ("incomeStatement.revenue.annualized"); _MISSING when any step is absent."""
    node = obj
    for step in dotted.split("."):
        if not isinstance(node, dict) or step not in node:
            return _MISSING
        node = node[step]
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


def load_side_map(path, what):
    if path is None:
        return None
    _, value = load(path)
    if not isinstance(value, dict):
        raise Bad(f"{path}: the {what} file must be a JSON object keyed by asset")
    return {k: v for k, v in value.items() if not k.startswith("_")}


def check_parity(asset, pairs):
    if not isinstance(pairs, list) or not pairs:
        return f"parity: no pairs for {asset}"
    for pair in pairs:
        if not (isinstance(pair, list) and len(pair) == 3):
            return f"parity: malformed pair {json.dumps(pair)[:80]}"
        label, a, b = pair
        r = rel_diff(a, b)
        if not r <= REL_TOL:
            return f"parity {label}: {json.dumps(a)} vs {json.dumps(b)} (rel {r:.3g} > {REL_TOL:g})"
    return None


def check_reclass(asset, new_obj, values):
    if not isinstance(values, dict) or not values:
        return f"reclass: no expected values for {asset}"
    for path, want in values.items():
        got = get_path(new_obj, path)
        if got is _MISSING:
            return f"reclass {path}: missing on the new side"
        r = rel_diff(got, want)
        if not r <= REL_TOL:
            return f"reclass {path}: new {json.dumps(got)} vs expected {json.dumps(want)} (rel {r:.3g} > {REL_TOL:g})"
    return None


def asset_names(side_dir):
    return {p.stem for p in Path(side_dir).glob("*.json") if p.name not in NOT_ASSETS}


def compare_asset(out, asset, status, parity, reclass):
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
    has_v2 = V2_KEY in new
    legacy = {k: v for k, v in new.items() if k != V2_KEY}
    d = first_diff(old, legacy)
    if d:
        return f"legacy differs at {d}"
    if not has_v2 and old_raw != new_raw:
        return "same JSON value but the bytes differ (formatting)"
    if parity is not None and (asset in parity or (has_v2 and asset in PARITY_ASSETS)):
        if asset not in parity:
            return "parity: asset missing from the parity map"
        r = check_parity(asset, parity[asset])
        if r:
            return r
    if reclass is not None and (asset in reclass or (has_v2 and asset in RECLASS_ASSETS)):
        if asset not in reclass:
            return "reclass: asset missing from the expected file"
        r = check_reclass(asset, new, reclass[asset])
        if r:
            return r
    return None


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
    if len(assets) < MIN_ASSETS:
        lines.append(f"FAIL count: {len(assets)} assets on both sides, need at least {MIN_ASSETS}")
        ok = False
    passed = 0
    for a in assets:
        reason = compare_asset(out, a, status, parity_map, reclass_map)
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
    ap.add_argument("--parity", help="the parity map: {asset: [[label, a, b], ...]}")
    ap.add_argument("--reclass", help="expected.json from expected.py: {asset: {dotted path: value}}")
    args = ap.parse_args(argv)
    ok, lines = compare_out(args.out, parity=args.parity, reclass=args.reclass)
    for line in lines:
        print(line)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
