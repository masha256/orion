"""Trim the R4 incentive scoping files into tests/fixtures/poolscan/incentives.json (Task 6, RET-201).

Source (read-only): phase3-r4-scoping/incentives-data/{discovery,elysium_discovery,programs,zero_supply_cum,
program_days,daily}.json, measured 2026-11-27 (incentives-and-events.md). Run from anywhere:

    python3 tests/fixtures/poolscan/trim_incentives.py [scoping incentives-data dir]

Kept:
- discovery: per chain the FactoryRegistry gauge factories, each factory's gauges as [gauge, VRM] pairs (all 8 chains),
  plus the scoping's VRM count.
- programs: every decoded program on the chain-days the tests stream, and every program of the VRMs streaming on
  2026-11-26 (the programs() end-to-end test reads ids 1..incentiveCount of those VRMs).
- incentive_counts: incentiveCount() of those VRMs (discovery.json gauges[].incentiveCount).
- zero_points: `chain|vrm|t` -> [Z(t), getPriorSupplyIndex(t), supplyAt(t-1)] for every overlap bound of those days
  (zero_supply_cum.json; Z = cumulative zero-allocation seconds as incentives-and-events.md section 2 defines it).
- expect: program_days.json rows of those chain-days (allocated/streamed token amounts in token units, scoping class,
  day-end price) and daily.json for 2026-11-26.
Nothing is synthesized here; the test helper derives the globalRewardPointHistory answers (see poolscanIncentives.ts).
"""
import json, os, sys
from collections import defaultdict
from datetime import datetime, timezone

SRC = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser(
    "~/.hermes/profiles/raymond/workspace/orion/phase3-r4-scoping/incentives-data")
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "incentives.json")
CHAIN_IDS = {"base": 8453, "ethereum": 1, "optimism": 10, "arbitrum": 42161, "ink": 57073, "robinhood": 4663,
             "arc": 5042, "elysium": 99901}
LEAF_VOTER = "0x382409fad8503fbcdbb27a4211551fa03e884078"  # incentives-and-events.md, Addresses table


def load(f):
    return json.load(open(os.path.join(SRC, f)))


def ts(day):
    return int(datetime.fromisoformat(day + "T00:00:00+00:00").timestamp())


disc, ely = load("discovery.json"), load("elysium_discovery.json")
programs = load("programs.json")["programs"]
zcum, pdays, daily = load("zero_supply_cum.json"), load("program_days.json"), load("daily.json")

# ---- discovery (registry path B) ----
discovery = {}
for chain, c in disc["chains"].items():
    reg = disc["registry"][chain]
    by_gf = defaultdict(list)
    vrm_of = {}
    for g in c["gauges"]:
        by_gf[g["gaugeFactory"]].append(g["gauge"])
        vrm_of[g["gauge"]] = g["vrm"]
    gfs = list(reg["gaugeFactories"])
    assert set(by_gf) <= set(gfs), chain
    discovery[chain] = {"chain_id": CHAIN_IDS[chain], "factory_registry": reg["factoryRegistry"], "gauge_factories": gfs,
                        "gauges": {gf: [[g, vrm_of[g]] for g in sorted(by_gf.get(gf, []))] for gf in gfs},
                        "scoping_vrms": c["nVRM"]}
# Elysium: the scoping lists gauges and VRMs in the same order but not which gauge factory holds which gauge, so every
# gauge sits under the CL gauge factory here (the per-factory split is not measured; the count is).
assert len(ely["gauges"]) == len(ely["vrms"]) == 8
discovery["elysium"] = {"chain_id": 99901, "factory_registry": ely["factoryRegistry"], "gauge_factories": ely["gaugeFactories"],
                        "gauges": {gf: ([[g, v] for g, v in zip(ely["gauges"], ely["vrms"])] if gf.startswith("0xf437") else [])
                                   for gf in ely["gaugeFactories"]},
                        "scoping_vrms": len(set(ely["vrms"])),
                        "note": "gauge->factory split synthetic (all under CL gauge factory); gauges, VRMs and count measured"}

# ---- chain-days the tests stream ----
# (chain, day, VRMs or None = every VRM). Base 10-29 keeps three VRMs: a Foundation TGE 0x7269 AERO program that ends
# that day, the 0x80f7 RSGP program's VRM and a third-party VVV program's VRM. Base 11-17/18: the INFI VRM only.
TGE_VRM, RSGP_VRM, VVV_VRM = ("0x4d22c68f996ed9abf0d1bb02ac070462a1b4e40e", "0x4ad4efa871b9a9d943cd69fd779c4d0230eb021f",
                              "0xe43e4d06d85abfed8bd998c5df2dcfe272c4e8c9")
INFI_VRM = "0xeeb3ca51d05edd037489fe5f45e756b42bbeb652"
OP_ZERO_VRM = "0x2735e91b68298b9179a98d65bee01a2ef8981553"
DAYS = [("base", "2026-10-29", {TGE_VRM, RSGP_VRM, VVV_VRM}), ("ethereum", "2026-10-23", None),
        ("base", "2026-11-17", {INFI_VRM}), ("base", "2026-11-18", {INFI_VRM}),
        ("optimism", "2026-10-30", {OP_ZERO_VRM}), ("optimism", "2026-10-31", {OP_ZERO_VRM}),
        ("optimism", "2026-11-01", {OP_ZERO_VRM}), ("optimism", "2026-11-04", {OP_ZERO_VRM}),
        ("base", "2026-11-26", None), ("optimism", "2026-11-26", None)]
on = lambda p, chain, vrms: p["chain"] == chain and (vrms is None or p["vrm"] in vrms)
key = lambda p: (p["chain"], p["vrm"], p["id"])
active = {}
for chain, day, vs in DAYS:
    t0 = ts(day)
    for p in programs:
        if on(p, chain, vs) and p["start"] < t0 + 86400 and p["end"] > t0:
            active.setdefault(key(p), p)
# The 11-26 VRMs, plus OP 0x2735 (both of its programs are kept) for the programs() / failure tests.
vrms_1126 = sorted({(p["chain"], p["vrm"]) for p in programs if p["chain"] in ("base", "optimism")
                    and p["start"] < ts("2026-11-27") and p["end"] > ts("2026-11-26")} | {("optimism", OP_ZERO_VRM)})
counts = {}
for chain, vrm in vrms_1126:
    g = [x for x in disc["chains"][chain]["gauges"] if x["vrm"] == vrm]
    assert len(g) == 1
    counts[f"{chain}|{vrm}"] = g[0]["incentiveCount"]
    for p in programs:
        if p["chain"] == chain and p["vrm"] == vrm:
            active.setdefault(key(p), p)
    assert sum(1 for p in programs if p["chain"] == chain and p["vrm"] == vrm) == counts[f"{chain}|{vrm}"]
keep = ("chain", "vrm", "id", "token", "amount", "rate", "start", "end", "creator", "symbol", "decimals")
fx_programs = [{k: p[k] for k in keep} for p in sorted(active.values(), key=lambda p: (p["chain"], p["vrm"], p["id"]))]

# ---- zero-supply points at every overlap bound ----
zero_points = {}
for chain, day, vs in DAYS:
    t0, t1 = ts(day), ts(day) + 86400
    for p in programs:
        if on(p, chain, vs) and p["start"] < t1 and p["end"] > t0:
            for t in (max(p["start"], t0), min(p["end"], t1)):
                k = f"{chain}|{p['vrm']}|{t}"
                assert k in zcum, k
                zero_points[k] = zcum[k]

# ---- expectations ----
expect_rows = []
for chain, day, vs in DAYS:
    for x in pdays:
        if on(x, chain, vs) and x["day"] == ts(day):
            p = next(q for q in programs if key(q) == (chain, x["vrm"], x["id"]))
            expect_rows.append({"chain": chain, "day": day, "vrm": x["vrm"], "id": x["id"], "class": x["class"],
                                "streamed": x["streamed_tokens"], "allocated": x["allocated_tokens"], "price_usd": x["price_usd"]})
daily_1126 = {c: v.get("2026-11-26") for c, v in daily["daily"].items()}

out = {
    "source": "phase3-r4-scoping/incentives-data (measured 2026-11-27); trimmed by trim_incentives.py",
    "leaf_voter": LEAF_VOTER,
    "chain_ids": CHAIN_IDS,
    "discovery": discovery,
    "programs": fx_programs,
    "incentive_counts": counts,
    "zero_points": zero_points,
    "expect": {"program_days": expect_rows, "daily_2026_11_26": daily_1126},
}
with open(OUT, "w") as f:
    json.dump(out, f, separators=(",", ":"))
print(OUT, os.path.getsize(OUT), "bytes;", len(fx_programs), "programs;", len(zero_points), "zero points;",
      len(expect_rows), "expect rows")
