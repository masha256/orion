"""Trim the R4 scoping day files (2026-11-26) into the poolscan engine fixtures. Offline, read-only.

Run: python3 tests/fixtures/poolscan/trim.py   (writes <chain>-2026-11-26.json beside this file)

Sources (~/.hermes/profiles/raymond/workspace/orion/phase3-r4-scoping/):
- onchain-revenue-data/raw/2026-11-26_<chain>.json: per-pool tape snapshots at the scoping's two blocks (acc_s/acc_e),
  raw pending (g_s.raw / g_e.raw), FeesCollected sums per pool (collected), tape allowedCaller, CL swap hook, gauge, VRM,
  and the scoping's own per-pool delta `d` (the expected gross).
- incentives-data/discovery.json: FactoryRegistry address, targetFactories, gaugeFactories, gauge -> pool/gaugeFactory.
- onchain-revenue-data/2026-11-26.json + scripts/tokens.json: on-chain prices and decimals, only to rank Base pools by
  USD fees when choosing the top 10 (no USD value lands in a fixture).
Factory, tape and hook addresses are the ones in the spec §11 / onchain-revenue.md §10 (the factory getters read them).

Nothing here is synthetic except where a pool or field says `"synthetic"`; the FeesCollected logs the tests serve are
built from `collected` (one log per VRM and token: the scoping kept only the per-pool sums).
"""
import json, os

S = os.path.expanduser("~/.hermes/profiles/raymond/workspace/orion/phase3-r4-scoping/")
R = S + "onchain-revenue-data/raw/"
OUT = os.path.dirname(os.path.abspath(__file__))
DAY = "2026-11-26"
ZERO = "0x" + "0" * 40

POOL_TAPE = "0x34bdd64b19d8631f936c2d07f19aaa6b83515992"
CL_POOL_TAPE = "0x27d5eb73e7406675f6b0cbd037490ec3dba935a4"
HOOK = "0xc0ed888afe87ed1acf01d9f19bb850159e3ce434"
STABLE = "0x78589e876edcebdce72ee3436ab3c9ad3a7cef2d"
VOLATILE = "0x8e6a9fcd1d638cc760ffba397605fe3355de76d2"
LEAF_VOTER = "0x382409fad8503fbcdbb27a4211551fa03e884078"
LITE = {"pool_tape": "0x8da07efabcf124b61671df449bc73292d4b56c25", "cl_pool_tape": "0x967f5352a6448e22d7361e149103350c49345ee9",
        "hook": "0xaaf164008441f112eb2858d9f7a2db1b84b1e415", "cl": "0xb89df768af2cfe637ceb352c587fe8edaf491d03",
        "stable": "0xaed253f1ad84d99f2165256d701b2b481dd4cc16", "volatile": "0x9bc8b3f60d349d687fb44a018967025e3741f9a5"}
CL_FACTORY = {"base": "0x9cb220581b91b0c83223012fe69688b92ad07a76", "ethereum": "0xf4fd2e6c5b60c5b365cd1b96dd6245e6d60414c2",
              "ink": "0x7660bf2adefc687c22906112ca323d60a00358cf", "arc": "0x7f83235643181e440433400a027618cd50879751"}
CHAIN_ID = {"base": 8453, "ethereum": 1, "ink": 57073, "arc": 5042}


def factories(c):
    """(raw kind, factory, engine kind, tape, hook) in the scoping's factory order."""
    f = [("v2s", STABLE, "v2_stable", POOL_TAPE, None), ("v2v", VOLATILE, "v2_volatile", POOL_TAPE, None),
         ("cl", CL_FACTORY[c], "cl", CL_POOL_TAPE, HOOK)]
    if c == "arc":
        f += [("lite_v2s", LITE["stable"], "v2_stable", LITE["pool_tape"], None),
              ("lite_v2v", LITE["volatile"], "v2_volatile", LITE["pool_tape"], None),
              ("lite_cl", LITE["cl"], "cl", LITE["cl_pool_tape"], LITE["hook"])]
    return f


def acc(a):
    return None if a is None else {"fee0": str(a["fee0"]), "fee1": str(a["fee1"]), "last": a["last"], "swaps": a["swaps"]}


def pair(v):
    return None if v is None else [str(v[0]), str(v[1])]


def usd_ranker(c):
    tk = json.load(open(S + "onchain-revenue-data/scripts/tokens.json")).get(c, {})
    px = json.load(open(S + f"onchain-revenue-data/{DAY}.json"))["chains"][c]["tokens"]

    def usd(p):
        d, tot = p.get("d") or {}, 0.0
        for i, t in ((0, p["token0"]), (1, p["token1"])):
            pr = (px.get(t) or {}).get("p_onchain")
            if t in tk and pr: tot += d.get(f"fee{i}", 0) / 10 ** tk[t]["decimals"] * pr
        return tot
    return usd


def select(c, pools):
    if c in ("ink",):
        return [p["pool"] for p in pools]  # all 40
    reg = lambda p: p["tapeAllowedCaller"] != ZERO
    if c == "base":
        usd = usd_ranker(c)
        top = [p["pool"] for p in sorted(pools, key=lambda p: -usd(p))[:10]]
        first_swap = [p["pool"] for p in pools if p["acc_s"]["last"] == 0 and p["acc_e"]["last"] != 0]  # 1-wei sentinel at s
        unreg = [p["pool"] for p in pools if not reg(p) and not p["new_in_day"]][:2]
        mid_day = [p["pool"] for p in pools if p["new_in_day"]][:1]
        v2s = [p["pool"] for p in pools if p["kind"] == "v2s" and reg(p) and p.get("gauge")][:4]
        v2v = [p["pool"] for p in pools if p["kind"] == "v2v" and reg(p) and p.get("gauge") and sum(p["collected"])][:8]
        cap0 = [p["pool"] for p in pools if p.get("gauge") and p.get("emissionCap") == 0][:1]
        cl = [p["pool"] for p in pools if p["kind"] == "cl" and reg(p) and p.get("gauge") and sum(p["collected"])]
        picked = []
        for q in top + first_swap + unreg + mid_day + v2s + v2v + cap0 + cl:
            if q not in picked and len(picked) < 40: picked.append(q)
        return picked
    if c == "arc":
        lite = [p for p in pools if p["kind"] == "lite_cl"]
        lite_pick = [p["pool"] for p in lite if p.get("gauge")] + [p["pool"] for p in lite if reg(p) and not p.get("gauge")][:1] \
            + [p["pool"] for p in lite if not reg(p)][:1]
        rest = [p["pool"] for p in pools if p["kind"] in ("cl", "v2v", "v2s") and (p.get("gauge") or reg(p))]
        rest += [p["pool"] for p in pools if p["kind"] == "v2v" and not reg(p)][:1]
        return list(dict.fromkeys(lite_pick + rest))
    if c == "ethereum":
        gu = [p["pool"] for p in pools if p.get("gauge") and not reg(p)]
        other = [p["pool"] for p in pools if p.get("gauge") and reg(p) and sum(p["collected"])][:2]
        un = [p["pool"] for p in pools if not p.get("gauge") and not reg(p)][:1]
        return gu + other + un
    raise ValueError(c)


def build(c):
    raw = json.load(open(R + f"{DAY}_{c}.json"))
    disc = json.load(open(S + "incentives-data/discovery.json"))
    reg_info = disc["registry"][c]
    gauges = {g["gauge"]: g for g in disc["chains"][c]["gauges"]}
    picked = set(select(c, raw["pools"]))
    by_kind = {}
    for p in raw["pools"]: by_kind.setdefault(p["kind"], []).append(p)
    facs, pools, f2g = [], {}, {gf: [] for gf in list(reg_info["gaugeFactories"])}
    for kind, addr, ekind, tape, hook in factories(c):
        mine = [p for p in by_kind.get(kind, []) if p["pool"] in picked]
        old = [p for p in mine if not p["new_in_day"]]
        assert all(not p["new_in_day"] for p in mine[:len(old)]), "new pools must come last"
        facs.append({"address": addr, "kind": ekind, "tape": tape, **({"hook": hook} if hook else {}),
                     "raw_kind": kind, "length_s": len(old), "pools": [p["pool"] for p in mine]})
        for p in mine:
            g = p.get("gauge")
            rec = {"factory": addr, "token0": p["token0"], "token1": p["token1"], "allowed_caller": p["tapeAllowedCaller"],
                   "acc_s": acc(p["acc_s"]), "acc_e": acc(p["acc_e"]),
                   "expect": {"fee0": str(p["d"]["fee0"]), "fee1": str(p["d"]["fee1"])}, "new_in_day": p["new_in_day"]}
            if "cl" in kind: rec["hook"] = p["hook"]
            if g:
                gi = gauges[g]
                assert gi["pool"] == p["pool"] and gi["vrm"] == p["vrm"]
                f2g[gi["gaugeFactory"]].append(g)
                rec.update({"gauge": g, "gauge_factory": gi["gaugeFactory"], "vrm": p["vrm"], "emission_cap": str(p["emissionCap"]),
                            "pend_s": pair(p["g_s"]["raw"]), "pend_e": pair(p["g_e"]["raw"]), "collected": pair(p["collected"])})
            pools[p["pool"]] = rec
    cfg = {"chain_id": CHAIN_ID[c], "factory_registry": reg_info["factoryRegistry"], "leaf_voter": LEAF_VOTER, "anchors": [],
           "factories": [{k: f[k] for k in ("address", "kind", "tape", "hook") if k in f} for f in facs]}
    return {
        "_source": f"phase3-r4-scoping onchain-revenue-data/raw/{DAY}_{c}.json + incentives-data/discovery.json, trimmed by trim.py",
        "_blocks": "s/e are the blocks the scoping READ at (its block_start/block_end); the engine reads at s'-1/e'-1, so the "
                   "fake answers blockAt(D) = s+1 and blockAt(D+1) = e+1 to land on the same state",
        "chain": c, "day": DAY, "blocks": {"s": raw["block_start"], "e": raw["block_end"]},
        "scoping_counts": {"pools": len(raw["pools"]), "registered": sum(1 for p in raw["pools"] if p["tapeAllowedCaller"] != ZERO),
                           "gauged": sum(1 for p in raw["pools"] if p.get("gauge")), "fees_collected_logs": raw["n_fees_collected_logs"]},
        "config": cfg,
        "registry": {"target_factories": reg_info["targetFactories"], "gauge_factories": list(reg_info["gaugeFactories"]), "factory_to_gauges": f2g},
        "factories": facs, "pools": pools,
    }


if __name__ == "__main__":
    for c in ("base", "arc", "ink", "ethereum"):
        fx = build(c)
        path = os.path.join(OUT, f"{c}-{DAY}.json")
        json.dump(fx, open(path, "w"), indent=1)
        print(c, len(fx["pools"]), os.path.getsize(path))
