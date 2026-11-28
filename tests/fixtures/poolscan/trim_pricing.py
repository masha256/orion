"""Trim the R4 scoping 2026-11-26 day files into the poolscan pricing fixtures. Offline, read-only.

Run: python3 tests/fixtures/poolscan/trim_pricing.py   (writes pricing-<chain>-2026-11-26.json beside this file)

Sources (~/.hermes/profiles/raymond/workspace/orion/phase3-r4-scoping/onchain-revenue-data/):
- raw/2026-11-26_<chain>.json: per pool at the scoping's end block: kind, tokens, the day's tape fee delta `d`, raw
  pending at both blocks + FeesCollected sums (allocator), CL `sqrtP` (slot0) and `twap_tick_1800` (observe([1800, 0])),
  V2 `reserves` (getReserves), token `bal` (balanceOf(pool)).
- anchors-chainlink.json: tier-A anchors (token -> feed), feed `desc` (description(), decimals()) and the day's
  latestRoundData (answer scaled by the feed decimals, updatedAt).
- scripts/tokens.json: token decimals.
- 2026-11-26.json: the scoping's results the tests compare against (`expect`).

Pools kept (Base): every pool with a non-zero gross or allocator amount, every pool with a priced side of >= $10K at the
recommended graph's prices (a superset of every edge the $10K graph can pick, so the trimmed graph prices exactly as the
full one: checked below), and every pool holding one of the Base tokens that only share a symbol with an anchor (the five
other "USDC"s and the spoof LINK). Optimism: the msUSD/USDC stable pool and the USDC anchor.

Synthetic (listed in each file's `synthetic`): the observe() tickCumulatives are [0, twap_tick_1800 * 1800] (the scoping
kept only the mean tick; observe's absolute cumulatives cancel out); the feed `answer_raw` is the scoping's scaled answer
times 10^decimals (rounded); the read block's timestamp is D+1 00:00:00Z (the scoping did not keep block timestamps; the
recorded block is the first at or after it).
"""
import json, math, os
from decimal import Decimal

S = os.path.expanduser("~/.hermes/profiles/raymond/workspace/orion/phase3-r4-scoping/onchain-revenue-data/")
OUT = os.path.dirname(os.path.abspath(__file__))
DAY = "2026-11-26"
TS_END = 1795737600  # 2026-11-27T00:00:00Z
TOK = json.load(open(S + "scripts/tokens.json"))
ANC = json.load(open(S + "anchors-chainlink.json"))
RES = json.load(open(S + f"{DAY}.json"))
Q96 = 2 ** 96
KIND = {"v2s": "v2_stable", "v2v": "v2_volatile", "cl": "cl"}
CHAIN_ID = {"base": 8453, "optimism": 10}
CL_FACTORY = {"base": "0x9cb220581b91b0c83223012fe69688b92ad07a76", "optimism": "0xfeab42d90055db3a0616249f76b6002d72266778"}
STABLE = "0x78589e876edcebdce72ee3436ab3c9ad3a7cef2d"
VOLATILE = "0x8e6a9fcd1d638cc760ffba397605fe3355de76d2"
BASE_SAME_SYMBOL = ["0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca", "0x584fbca587e2bbea9bec6cac60370f6ed20a49c4",
                    "0x9cb79dfbb336c487a77a79d040f34bd44d91a846", "0xc4c6b55196e495d7efe3273326b7b650e586ed87",
                    "0x0ac9c1d2db7b6b03100e1c675ff44b729dd9fb07", "0x26afac38d9991b0ec8990281d85e3566af16d994"]


def dec_of(c):
    return lambda t: TOK[c].get(t, {}).get("decimals") or 18


# --- the scoping's recommended method (final_eval.py composite + pricing.py), with the CL 30-min TWAP on every CL edge ---
def spot(p, d0, d1):
    if "cl" in p["kind"]:
        if not p.get("sqrtP"): return None
        return (p["sqrtP"] / Q96) ** 2 * 10 ** (d0 - d1)
    r = p.get("reserves")
    if not r or r[0] == 0 or r[1] == 0: return None
    x, y = r[0] / 10 ** d0, r[1] / 10 ** d1
    if p["kind"] == "v2s": return (3 * x * x * y + y ** 3) / (x ** 3 + 3 * x * y * y)
    return y / x


def twap(p, d0, d1):
    if "cl" in p["kind"] and p.get("twap_tick_1800") is not None: return 1.0001 ** p["twap_tick_1800"] * 10 ** (d0 - d1)
    return spot(p, d0, d1)


def graph(pools, base, floor, dec, rounds=3):
    prices = dict(base)
    for _ in range(rounds):
        cand = {}
        for p in pools:
            t0, t1 = p["token0"], p["token1"]
            f = twap(p, dec(t0), dec(t1))
            if not f or f <= 0 or not math.isfinite(f): continue
            bal = p.get("bal") or [None, None]
            for known, unk, k in ((t1, t0, 1), (t0, t1, 0)):
                if known in prices and unk not in prices and bal[k]:
                    depth = bal[k] / 10 ** dec(known) * prices[known]
                    if depth < floor: continue
                    pu = f * prices[known] if unk == t0 else prices[known] / f
                    if unk not in cand or depth > cand[unk][1]: cand[unk] = (pu, depth)
        if not cand: break
        for t, (pu, _) in cand.items(): prices[t] = pu
    return prices


def amounts(p):
    d = p.get("d") or {}
    g = [d.get("fee0", 0), d.get("fee1", 0)]
    al = None
    if p.get("gauge"):
        gs, ge = p.get("g_s") or {}, p.get("g_e") or {}
        col = p.get("collected", [0, 0])
        a, b = gs.get("raw"), ge.get("raw")
        if b is not None:
            a = a or [0, 0]
            al = [max(0, b[0] - a[0] + col[0]), max(0, b[1] - a[1] + col[1])]
    return g, al


def gross_usd(pools, prices, dec):
    usd = 0.0
    for p in pools:
        g, a = amounts(p)
        t0, t1 = p["token0"], p["token1"]
        f = twap(p, dec(t0), dec(t1))
        for k, (t, o) in enumerate(((t0, t1), (t1, t0))):
            amt = g[k] / 10 ** dec(t)
            if amt <= 0: continue
            if t in prices: pt = prices[t]
            elif o in prices and f: pt = f * prices[o] if k == 0 else prices[o] / f
            else: continue
            usd += amt * pt
    return usd


def anchors_a(c):
    out = []
    for t, v in ANC["anchors"][c].items():
        if v["tier"] != "A": continue
        desc, fdec = ANC["feeds"][c]["desc"][v["feed"]]
        fr = ANC["feeds"][c]["days"][DAY][v["feed"]]
        out.append({"token": t, "feed": v["feed"].lower(), "description": desc, "feed_decimals": fdec,
                    "answer_raw": str(int((Decimal(repr(fr["answer"])) * 10 ** fdec).to_integral_value())),
                    "answer": fr["answer"], "updated_at": fr["updatedAt"]})
    return out


def pool_entry(p, dec):
    g, a = amounts(p)
    e = {"kind": KIND[p["kind"]], "tokens": [p["token0"], p["token1"]], "fee": [str(g[0]), str(g[1])],
         "bal": [str(p["bal"][0]), str(p["bal"][1])]}
    if a is not None: e["alloc"] = [str(a[0]), str(a[1])]
    if p["kind"] == "cl":
        e["sqrt_price_x96"] = str(p["sqrtP"])
        tw = p.get("twap_tick_1800")
        e["tick_cumulatives"] = None if tw is None else ["0", str(int(round(tw * 1800)))]
        if tw is not None: assert abs(tw * 1800 - round(tw * 1800)) < 1e-6
    else:
        e["reserves"] = [str(p["reserves"][0]), str(p["reserves"][1])]
    return e


def build(c, select):
    raw = json.load(open(S + f"raw/{DAY}_{c}.json"))
    dec = dec_of(c)
    pools = [p for p in raw["pools"] if p.get("token0")]
    anchors = anchors_a(c)
    prices = graph(pools, {a["token"]: a["answer"] for a in anchors}, 10_000, dec)
    keep = select(pools, prices, dec)
    # The trimmed graph must price exactly as the full one.
    trimmed = graph(keep, {a["token"]: a["answer"] for a in anchors}, 10_000, dec)
    assert trimmed == {t: v for t, v in prices.items() if t in trimmed}, "trimmed graph differs"
    full_usd, kept_usd = gross_usd(pools, prices, dec), gross_usd(keep, trimmed, dec)
    tokens = sorted({t for p in keep for t in (p["token0"], p["token1"])})
    m = RES["chains"][c]["methods"]["rec_A_floor10k_fallback"]
    return {
        "_source": f"phase3-r4-scoping onchain-revenue-data raw/{DAY}_{c}.json, anchors-chainlink.json, scripts/tokens.json, "
                   f"{DAY}.json; trimmed by trim_pricing.py",
        "synthetic": ["pools.*.tick_cumulatives[0] = 0 (only the difference was kept)", "anchors.*.answer_raw = answer x 10^decimals",
                      "read_block_timestamp = D+1 00:00:00Z"],
        "chain": c, "chain_id": CHAIN_ID[c], "day": DAY,
        "blocks": {"s": raw["block_start"], "e": raw["block_end"]}, "read_block_timestamp": TS_END,
        "factories": {"v2_stable": STABLE, "v2_volatile": VOLATILE, "cl": CL_FACTORY[c]},
        "decimals": {t: dec(t) for t in tokens},
        "anchors": [{k: a[k] for k in ("token", "feed", "description", "feed_decimals", "answer_raw", "updated_at")} for a in anchors],
        "pools": {p["pool"]: pool_entry(p, dec) for p in keep},
        "expect": {
            "_doc": "scoping 2026-11-26.json chains.<c>: methods.rec_A_floor10k_fallback (spot edges) totals; tokens.*.p_onchain "
                    "(graph_AB_floor50k, spot). trim_pricing.py's own TWAP run of the full raw file: gross_usd_twap_full.",
            "gross_usd": m["gross_usd"], "alloc_usd": m["alloc_usd"], "gross_usd_twap_full": full_usd, "gross_usd_twap_trimmed": kept_usd,
            "p_onchain": {t: v["p_onchain"] for t, v in RES["chains"][c]["tokens"].items() if v["p_onchain"] is not None and t in tokens},
        },
    }


def base_select(pools, prices, dec):
    def fees(p):
        g, a = amounts(p)
        return any(x > 0 for x in g) or (a is not None and any(x > 0 for x in a))
    def edge(p):
        return any(t in prices and p["bal"][k] and p["bal"][k] / 10 ** dec(t) * prices[t] >= 10_000
                   for k, t in enumerate((p["token0"], p["token1"])))
    same = lambda p: p["token0"] in BASE_SAME_SYMBOL or p["token1"] in BASE_SAME_SYMBOL
    return [p for p in pools if fees(p) or edge(p) or same(p)]


def op_select(pools, prices, dec):
    return [p for p in pools if p["pool"] == "0x12e078cc562d5c422563e217c81324aaefc3bc91"]


if __name__ == "__main__":
    for c, sel in (("base", base_select), ("optimism", op_select)):
        fx = build(c, sel)
        if c == "optimism":
            usdc = "0x0b2c639c533813f4aa9d7837caf62653d097ff85"
            fx["anchors"] = [a for a in fx["anchors"] if a["token"] == usdc]
        path = os.path.join(OUT, f"pricing-{c}-{DAY}.json")
        json.dump(fx, open(path, "w"), separators=(",", ":"))
        print(c, len(fx["pools"]), "pools", len(fx["decimals"]), "tokens", os.path.getsize(path), "bytes",
              "gross twap full/trimmed", fx["expect"]["gross_usd_twap_full"], fx["expect"]["gross_usd_twap_trimmed"])
