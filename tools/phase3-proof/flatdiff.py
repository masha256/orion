#!/usr/bin/python3
r"""Flattening diff of one asset's report before and after a release, against an allowlist (Phase 3 R1 proof).

    flatdiff.py <old.json> <new.json> --allow <allowlist.json> --asset <a> [--json]

<old.json> and <new.json> are `report yield <a> --day D --json` (a JSON object whose top-level `asset` must be <a>).
Both are flattened to `path -> scalar`: dict keys are joined with `.`; a list whose elements are all objects with a
unique scalar `id` is keyed `key[id=<id>]`, any other list by index `key[<i>]`; an empty object or list is itself a
leaf (`{}` / `[]`), so `[] -> [x]` shows. No two values share a path: `\`, `.` and `[` in a key are escaped with `\`
(`{"a.b": 1}` is `a\.b`, not `a.b`); a string id escapes `\`, `]` and a leading `#`, and a number id is tagged `#`
(id 1 is `[id=#1]`, id "1" is `[id=1]`); a collision anyway is refused (exit 2). Real reports use identifier keys and
string ids, so their paths carry no escapes. Every path that differs is printed, as `added` (only in new), `removed`
(only in old) or `changed` (old -> new). Two numbers of equal value are equal (int vs float: JSON from JS has no such
distinction); a bool is not a number.

Allowlist: {"<asset>" | "*": [{"glob": "<path glob>", "rel": <float, optional>, "abs": <float, optional>,
"reason": "<text, required>", "todo": <bool, optional>}, ...]}; top-level keys starting with `_` are comments; a
duplicate key anywhere is refused, and so is a glob that is blank or starts with `*` (a bare `*` would allow
everything: a glob must name at least its first path segment literally). In a
glob only `*` is special: it matches any run of characters, `.` and `[...]` included; everything else (brackets too)
is literal, and the glob must match the whole path. The entries that apply are <asset>'s and `*`'s. A differing path
is allowed when at least one applicable entry matches it and EVERY applicable entry matching it holds:
- an entry with no `rel`/`abs` holds for any change (added, removed, any type);
- an entry with a bound holds only for a numeric change (both sides numbers) with |new - old| <= abs, or
  |new - old| / |old| <= rel (either one, when both are given; rel with old == 0 holds only when new == old).
So an unbounded `dilution.*` never relaxes a bounded entry on one of its paths. An entry with `"todo": true` is a
placeholder the controller fills from the first diff run: it is inert (allows nothing) and is listed as a warning.
Applicable entries that matched no differing path are listed as warnings (exit unchanged).

Exit 0 iff every differing path is allowed (no difference at all included), 1 otherwise (the unallowed paths are
listed), 2 when an input is missing, empty, unparseable, not a report object for <asset>, or the allowlist is
malformed: never "identical" on empty files. With --json, one object {"ok", "asset", "diffs": [{"path", "kind",
"old", "new", "allowed", "why", "entries"}], "unallowed": [...], "unmatched": [...], "todo": [...]} instead of text
(read the result from the exit code or that object, never by grep). Stdlib only.
"""
import argparse
import json
import math
import re
import sys
from pathlib import Path

ENTRY_KEYS = {"glob", "rel", "abs", "reason", "todo"}
STAR = "*"


class Bad(Exception):
    """An input that cannot take part in the comparison (exit 2)."""


def _no_dup_keys(pairs):
    out = {}
    for k, v in pairs:
        if k in out:
            raise Bad(f"duplicate key {json.dumps(k)}")
        out[k] = v
    return out


def load_json(path, what):
    try:
        raw = Path(path).read_bytes()
    except OSError as e:
        raise Bad(f"{what} {path}: unreadable ({e.strerror})") from None
    if not raw.strip():
        raise Bad(f"{what} {path}: empty")
    try:
        return json.loads(raw.decode("utf-8"), object_pairs_hook=_no_dup_keys)
    except (UnicodeDecodeError, json.JSONDecodeError) as e:
        raise Bad(f"{what} {path}: unparseable ({e})") from None
    except Bad as e:
        raise Bad(f"{what} {path}: {e} (last-wins would hide an entry or a value)") from None


def load_report(path, what, asset):
    value = load_json(path, what)
    if not isinstance(value, dict):
        raise Bad(f"{what} {path}: not a JSON object (an error document?)")
    if "asset" not in value:
        raise Bad(f"{what} {path}: no top-level `asset` (not a report)")
    if value["asset"] != asset:
        raise Bad(f"{what} {path}: asset is {json.dumps(value['asset'])}, not {asset!r} (--asset)")
    return value


def is_num(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool)


def is_bound(x):
    return is_num(x) and math.isfinite(x) and x >= 0


def load_allowlist(path):
    """{asset or '*': [entry, ...]} with every entry validated; Bad when malformed."""
    value = load_json(path, "allowlist")
    if not isinstance(value, dict):
        raise Bad(f"allowlist {path}: must be a JSON object keyed by asset or '*'")
    out = {}
    for asset, entries in value.items():
        if asset.startswith("_"):
            continue
        if not isinstance(entries, list):
            raise Bad(f"allowlist {path}: {asset!r} must be a list of entries")
        for i, e in enumerate(entries):
            where = f"allowlist {path}: {asset}[{i}]"
            if not isinstance(e, dict):
                raise Bad(f"{where}: an entry must be an object")
            unknown = sorted(set(e) - ENTRY_KEYS)
            if unknown:
                raise Bad(f"{where}: unknown key(s) {', '.join(unknown)} (allowed: {', '.join(sorted(ENTRY_KEYS))})")
            if not isinstance(e.get("glob"), str) or not e["glob"].strip():
                raise Bad(f"{where}: `glob` must be a non-empty string")
            if e["glob"].startswith(STAR):
                raise Bad(f"{where}: `glob` {e['glob']!r} starts with `*`: name the first path segment literally")
            if not isinstance(e.get("reason"), str) or not e["reason"].strip():
                raise Bad(f"{where}: `reason` is required (non-empty string)")
            for k in ("rel", "abs"):
                if k in e and not is_bound(e[k]):
                    raise Bad(f"{where}: `{k}` must be a finite number >= 0")
            if "todo" in e and not isinstance(e["todo"], bool):
                raise Bad(f"{where}: `todo` must be true or false")
        out[asset] = entries
    return out


def key_step(k):
    """A dict key as a path segment: backslash, `.` and `[` escaped with a backslash."""
    return re.sub(r"([\\.\[])", r"\\\1", k)


def id_step(i):
    """`[id=...]` for a list element's id: a number is tagged `#`; a string escapes backslash, `]` and a leading `#`."""
    if isinstance(i, str):
        s = re.sub(r"([\\\]])", r"\\\1", i)
        return "[id=" + ("\\" if s.startswith("#") else "") + s + "]"
    return f"[id=#{json.dumps(i)}]"


def _id_keyed(items):
    if not items or not all(isinstance(x, dict) and "id" in x for x in items):
        return False
    ids = [x["id"] for x in items]
    if not all(isinstance(i, (str, int, float)) and not isinstance(i, bool) for i in ids):
        return False
    return len(set(map(id_step, ids))) == len(ids)


def flatten(value, prefix=""):
    """{path: scalar} of a parsed JSON value (see the module doc for the path syntax); Bad on a path collision."""
    out = {}

    def leaf(path, node):
        if path in out:
            raise Bad(f"two values flatten to the path {path!r}")
        out[path] = node

    def walk(node, path):
        if isinstance(node, dict) and node:
            for k, v in node.items():
                walk(v, f"{path}.{key_step(k)}" if path else key_step(k))
        elif isinstance(node, list) and node:
            keyed = _id_keyed(node)
            for i, v in enumerate(node):
                step = id_step(v["id"]) if keyed else f"[{i}]"
                walk(v, f"{path}{step}")
        else:
            leaf(path or "$", node)

    walk(value, prefix)
    return out


_GLOBS = {}


def glob_match(glob, path):
    rx = _GLOBS.get(glob)
    if rx is None:
        rx = _GLOBS[glob] = re.compile("".join(".*" if c == "*" else re.escape(c) for c in glob) + r"\Z", re.S)
    return rx.match(path) is not None


def same(a, b):
    if is_num(a) and is_num(b):
        return a == b
    return type(a) is type(b) and a == b


def entry_holds(e, old, new, kind):
    """(holds, detail) for one matching entry on one differing path."""
    if "rel" not in e and "abs" not in e:
        return True, "no bound"
    if kind != "changed" or not (is_num(old) and is_num(new)):
        return False, "bounded entry, but not a numeric change"
    gap = abs(new - old)
    if "abs" in e and gap <= e["abs"]:
        return True, f"abs {gap:.3g} <= {e['abs']:g}"
    rel = (0.0 if gap == 0 else math.inf) if old == 0 else gap / abs(old)
    if "rel" in e and rel <= e["rel"]:
        return True, f"rel {rel:.3g} <= {e['rel']:g}"
    parts = ([f"abs {gap:.3g} > {e['abs']:g}"] if "abs" in e else []) + ([f"rel {rel:.3g} > {e['rel']:g}"] if "rel" in e else [])
    return False, " and ".join(parts)


def diff(old, new, allow, asset):
    """The result object (see the module doc)."""
    fo, fn = flatten(old), flatten(new)
    applicable = [(a, i, e) for a in (asset, STAR) for i, e in enumerate(allow.get(a, []))]
    active = [x for x in applicable if not x[2].get("todo")]
    hits = {(a, i): 0 for a, i, _ in active}
    diffs = []
    for path in sorted(set(fo) | set(fn)):
        if path in fo and path in fn:
            if same(fo[path], fn[path]):
                continue
            kind = "changed"
        else:
            kind = "added" if path in fn else "removed"
        o, n = fo.get(path), fn.get(path)
        matching = [(a, i, e) for a, i, e in active if glob_match(e["glob"], path)]
        results = []
        for a, i, e in matching:
            hits[(a, i)] += 1
            ok, detail = entry_holds(e, o, n, kind)
            results.append({"asset": a, "index": i, "glob": e["glob"], "holds": ok, "detail": detail, "reason": e["reason"]})
        allowed = bool(results) and all(r["holds"] for r in results)
        if not results:
            why = "no allowlist entry matches"
        elif allowed:
            why = "; ".join(f"{r['asset']}[{r['index']}] {r['detail']}" for r in results)
        else:
            why = "; ".join(f"{r['asset']}[{r['index']}] {r['detail']}" for r in results if not r["holds"])
        diffs.append({"path": path, "kind": kind, "old": o, "new": n, "allowed": allowed, "why": why, "entries": results})
    unmatched = [{"asset": a, "index": i, "glob": e["glob"], "reason": e["reason"]} for a, i, e in active if hits[(a, i)] == 0]
    todo = [{"asset": a, "index": i, "glob": e["glob"], "reason": e["reason"]} for a, i, e in applicable if e.get("todo")]
    unallowed = [d["path"] for d in diffs if not d["allowed"]]
    return {"ok": not unallowed, "asset": asset, "diffs": diffs, "unallowed": unallowed, "unmatched": unmatched, "todo": todo}


def text_lines(res):
    lines = []
    for d in res["diffs"]:
        o = "(absent)" if d["kind"] == "added" else json.dumps(d["old"])
        n = "(absent)" if d["kind"] == "removed" else json.dumps(d["new"])
        tag = "ALLOWED    " if d["allowed"] else "NOT ALLOWED"
        lines.append(f"{tag} {d['kind']:<7} {d['path']}: {o} -> {n}  [{d['why']}]")
    for u in res["unmatched"]:
        lines.append(f"WARN unmatched allowlist entry {u['asset']}[{u['index']}] {u['glob']!r}: matched no differing path ({u['reason']})")
    for t in res["todo"]:
        lines.append(f"WARN todo allowlist entry {t['asset']}[{t['index']}] {t['glob']!r} is a placeholder and allows nothing ({t['reason']})")
    if res["unallowed"]:
        lines.append(f"unallowed: {', '.join(res['unallowed'])}")
    n, bad = len(res["diffs"]), len(res["unallowed"])
    lines.append(f"{'OK' if res['ok'] else 'FAILED'} {res['asset']}: {n} differing path(s), {n - bad} allowed, {bad} not allowed")
    return lines


def main(argv=None):
    ap = argparse.ArgumentParser(description=(__doc__ or "").split("\n\n")[0])
    ap.add_argument("old", help="the before report (report yield <a> --day D --json)")
    ap.add_argument("new", help="the after report")
    ap.add_argument("--allow", required=True, help="the allowlist JSON")
    ap.add_argument("--asset", required=True, help="the asset both reports are for")
    ap.add_argument("--json", action="store_true", help="print one JSON result object instead of text lines")
    args = ap.parse_args(argv)
    try:
        old = load_report(args.old, "old", args.asset)
        new = load_report(args.new, "new", args.asset)
        allow = load_allowlist(args.allow)
    except Bad as e:
        print(f"flatdiff: {e}", file=sys.stderr)
        return 2
    try:
        res = diff(old, new, allow, args.asset)
    except Bad as e:
        print(f"flatdiff: {e}", file=sys.stderr)
        return 2
    if args.json:
        print(json.dumps(res))
    else:
        for line in text_lines(res):
            print(line)
    return 0 if res["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
