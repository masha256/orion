# Mantle (MNT)

Researched 2026-09-22. Rank #12 by market cap (layer-1 tokens, stablecoins and tokenized RWAs excluded). Market cap $2.2B, FDV $4.1B, price $0.665061 (CoinGecko, 2026-09-22).
Chain(s): Ethereum (ERC-20 `0x3c3a81e81dc49A522A592e7622A7E711c06bf354`); native gas token of Mantle Network (L2). CoinGecko id: `mantle`. DefiLlama slugs: `mantle` (chain), `mantle-restaking` (cmETH), `mantle-index-four-fund` (MI4).

## Verdict

Orion fit: C. Mantle has revenue, but almost all of it is treasury investment income ($48.9M in FY 2024-25). Network sequencer revenue is tiny ($0.26M over 1y on DefiLlama). None of it reaches MNT holders: no buyback, burn or fee share was executed through 2026-09-22. Burn and buyback ideas are only forum discussions: a phased treasury burn (2026-01 and 2026-02, archived) and a revenue-based buyback temperature check (2026-09-18).

## Business and revenue

- Mantle Network sequencer: gas paid in MNT, net of L1 and DA costs, goes to the Mantle treasury. DefiLlama `mantle` revenue: 30d $12.1K, 1y $259.6K. Monthly revenue fell from $120K (2025-08) to about $5-9K (2026-06 to 2026-09). MIP-33 reported $1.76M of sequencer revenue for 2024-07 to 2025-06.
- Treasury investment income (MIP-33, 2025-08-28): Mantle's "revenue" for 2024-07 to 2025-06 was $48.86M:
  - $3.0M in stables
  - $19.3M in ETH (mETH staking)
  - $12.6M in ENA
  - $12.2M in other investments
  - $1.76M sequencer
- Treasury on 2026-09-14 (per the 2026-09-18 forum post citing the official dashboard): about $2.41B, of which MNT $1.75B (72.7%), BTC $232M, ETH $227M, stables $110M.
- Ecosystem products: mETH/cmETH (`mantle-restaking` protocol revenue 1y $1.55M) and MI4. They are Mantle-affiliated but separate from MNT.
- Company/exchange layer: Mantle is closely tied to Bybit, and the budget is run by Mantle Core Contributors under MIPs. The FY 2025-26 budget limit is 52M USDx plus 200M MNT (MIP-33). That is 200M MNT of possible treasury spend into circulation a year.

## Holder flows

- None.
  - [Archived] "Phase-Based Treasury MNT Burn (3-8% over 12-24 months)" (forum 9406, 2026-02-25; earlier draft 9404, 2026-01-23): a pre-MIP that was not adopted.
  - "Mantle Revenue-Based MNT Buyback" temperature check (forum 9463, 2026-09-18): it proposes 5/10/20% of eligible net revenue for buybacks and states "Mantle has not established a clear, systematic, and transparent framework" for value capture. It is open discussion.
  - The 2023 MIP-23 supply optimization burned treasury BIT/MNT at launch. That was a one-off supply event, not a flow.
- MNT gas fees are not burned: they go to the sequencer and treasury.

Capture rate today: 0 / $48.9M (FY 2024-25 treasury plus network revenue) = 0%. Against network revenue alone it is also 0%.

## Supply

- Total and max 6,219,316,795 MNT. Circulating 3,302,294,383 (CoinGecko, 2026-09-22). No emissions and no staking inflation.
- The treasury holds about $1.75B of MNT, about 2.63B MNT at $0.665 (derived). Most of the non-circulating supply is treasury MNT.
- supply_basis recommendation: `circulating`. The treasury MNT is a governance-controlled overhang, and a treasury burn, if ever adopted, would remove part of it. Model treasury spending (up to 200M MNT a year budget limit) as an unlock-like release.
- Staking: none paying MNT from revenue.
- Unlocks: no vesting schedule. Releases come from treasury budget spending.

## Data availability for Orion

| metric | source type | endpoint / contract / slug | notes |
|---|---|---|---|
| network revenue | defillama | `mantle` dailyRevenue | tiny |
| treasury income | manual | MIP budget reports (annual), treasury dashboard | off-chain disclosure, annual |
| holder flow | none | none | |
| treasury MNT | contract_read / manual | treasury addresses (not collected) | Mantle treasury monitor |
| supply | coingecko / erc20_supply | `mantle`; MNT on Ethereum | |

An EVM RPC could read the treasury if the addresses were collected, but there is no holder flow.

## Orion mapping

- Modules: forward_multiple on revenue 1.0, labeled "treasury and network revenue, market convention". It is effectively a treasury NAV story: about $0.66B of non-MNT assets against a $2.2B market cap. A custom NAV module may be more appropriate than a revenue multiple.
- holder_flows: none. A bull scenario could assume adoption of a 5-20% revenue buyback (forum 9463) from 2027.
- Obstacles: the revenue is mostly investment returns on treasury assets, so it is volatile and not operating income. Network fees are negligible. Treasury MNT is an overhang.

## Sources

- https://api.llama.fi/summary/fees/mantle?dataType=dailyRevenue (and dailyFees), mantle-restaking: network and cmETH revenue, monthly series (accessed 2026-09-22)
- https://forum.mantle.xyz/t/9312: MIP-33, FY 2024-25 revenue $48.86M breakdown, sequencer $1.76M, FY 2025-26 budget limits (accessed 2026-09-22)
- https://forum.mantle.xyz/t/9463: 2026-09-18 revenue-based buyback temperature check, treasury composition as of 2026-09-14 (accessed 2026-09-22)
- https://forum.mantle.xyz/t/9406 and /t/9404: phased treasury burn pre-MIP (archived) (accessed 2026-09-22)
- https://forum.mantle.xyz/search.json?q=buyback / burn / treasury: absence of any passed buyback or burn MIP (accessed 2026-09-22)
- https://api.coingecko.com/api/v3/coins/mantle: supply and market data (accessed 2026-09-22)
