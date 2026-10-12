# Uniswap (UNI)

Researched 2026-09-22. Rank #6 by market cap (layer-1 tokens, stablecoins and tokenized RWAs excluded). Market cap $6.1B, FDV $8.7B, price $9.76 (CoinGecko, 2026-09-22).
Chain(s): Ethereum (ERC-20 `0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984`). Fees are collected on 11+ chains and burned on Ethereum. CoinGecko id: `uniswap`. DefiLlama slug: `uniswap` (parent; `uniswap-v3` carries the combined v2/v3/v4 protocol-fee series).

## Verdict

Orion fit: A. Since the UNIfication vote in December 2025, protocol fees have burned UNI through a programmatic, governance-set fee switch. The burn is on DefiLlama as holders revenue ($16.0M in the last 30d) and can be read on-chain as UNI sent to 0xdead. Revenue is ramping, so the 1y figure understates the run rate.

## Business and revenue

- Fees: traders pay swap fees on Uniswap v2/v3/v4 pools. Most go to LPs. The protocol fee (the switch) takes a slice. v2: 0.05% of the 0.30% fee. v3: 1/4 of LP fees on 0.01%/0.05% pools and 1/6 on 0.30%/1% pools. v4: the V4FeePolicy curve, with aggregator-hook pools at 10bp (3bp on Base) (UNIfication and v4 temp check).
- The protocol fee flows to a TokenJar on each chain. The assets are released only when someone burns UNI, through the Firepit mechanism. UNI burned on L2s is bridged back and sent to `0x000000000000000000000000000000000000dEaD` (v4 temp check 2026-07-07).
- Unichain sequencer fees (net of L1 costs and the 15% to Optimism) also go to the burn. They are small: DefiLlama `unichain` revenue was $108K over 1y.
- DefiLlama `uniswap` (2026-09-22): LP+protocol fees 30d $208.5M, 1y $962.5M. Revenue = holders revenue: 30d $15.96M, 1y $50.5M (the series starts 2025-12-28).
- Run rate: 30d x 365/30 = $194M. Monthly burn value rose from $2.7M (2026-01) to $9.3M (2026-08) and $12.5M in September to date as fees went live on more chains (2026-03-08: OP, Arbitrum, Base, WC, Zora, XLayer; 2026-06-02: Polygon, BSC, Celo; 2026-07-27: Robinhood chain and v4 pools).
- Company layer: Uniswap Labs (private company) turned off interface, wallet and API fees under UNIfication (DefiLlama `uniswap-labs` 30d revenue: $0.51) and committed contractually to align with DUNI (the DAO's legal wrapper). It is now funded by the treasury. A growth budget in UNI from the treasury to Labs was part of UNIfication (size unconfirmed; about 20M UNI a year from memory). That is dilution from treasury tokens entering circulation.

## Holder flows

- id `fee_switch_burn`, kind burn, capture_rule programmatic, recipient_base all
  - Trailing: $50.5M since 2025-12-28 (about 9 months), $15.96M over 30d ($194M annualized) (DefiLlama holders revenue, 2026-09-22).
  - Observability: UNI.balanceOf(0xdead) = 112,047,581 UNI on 2026-09-22 (Ethereum RPC). That includes the one-off treasury burn of 100M UNI, so about 12.05M UNI (about $118M at $9.76) came from fee-funded burns, assuming a negligible pre-existing 0xdead balance (unconfirmed). A `transfer_flow` of UNI to 0xdead gives the daily burn in tokens.
  - Rule and control: fee levels are pool-level and family-level parameters set by UNI governance, through an expedited Snapshot then an on-chain vote. The burn-to-release TokenJar/Firepit mechanism is encoded in contracts. So capture_rule is programmatic.
  - History: UNIfication posted 2025-11-10 and went on-chain 2025-12-18/19. Fees went live on Ethereum v2 and v3 on 2025-12-28. The expansion is listed above. v4 fees were activated on 2026-07-27 (DefiLlama methodology). A temp check for Arc chain fees is open (2026-09-18). A record 186,000 UNI was burned in one day in June 2026 (v4 temp check). An RFC (2026-06-25) proposing to pivot from burn to staking distribution is only discussion.
- id `treasury_burn_100m`: one-off, 100M UNI from the treasury (the UNIfication specification). It is a supply event, not a flow.
- Future: Protocol Fee Discount Auctions (winning bids burn UNI) and more chains or v4 families.

Capture rate today: holder flow / protocol revenue = 100% (all protocol revenue burns UNI). Against total swap fees (the protocol's "gross") it is $15.96M / $208.5M = 7.7% (30d), or $50.5M / $962.5M = 5.2% (1y, partial). For Orion, set revenue_run_rate = protocol-fee revenue and capture_rate = 1.0, or use swap fees with capture of about 8%.

## Supply

- Max supply 1,000,000,000 minted at genesis. totalSupply() still reports 1,000,000,000 because burns go to 0xdead, not a supply-reducing burn. Effective total = 1B - 112.05M = 887.95M (CoinGecko total 887,956,419). Circulating 620,708,423 (CoinGecko, 2026-09-22).
- The rest of the non-circulating supply is mostly the DAO treasury, from which the Labs growth budget and grants come.
- Inflation: the UNI contract allows governance to mint up to 2% a year. It has not been used (unconfirmed for 2026).
- There is no staking and no staking yield today.
- supply_basis recommendation: `effective_total` (887.95M). Treasury UNI can be spent into circulation, and the burn applies to the whole supply.
- Unlocks: the original team and investor vesting finished in 2024. Treasury spending (the Labs growth budget) is the remaining release source (size unconfirmed).

## Data availability for Orion

| metric | source type | endpoint / contract / slug | notes |
|---|---|---|---|
| revenue_run_rate_usd | defillama | `uniswap`, dailyRevenue (or `uniswap-v3`, which carries all protocol fees) | ramping, so use 30d |
| swap fees (gross) | defillama | `uniswap`, dailyFees | |
| holder flow (burn) | defillama | `uniswap`, dailyHoldersRevenue | equals revenue |
| burn in tokens (cross-check) | transfer_flow | UNI Transfer to `0x000...dEaD` on Ethereum | includes the one-off 100M burn (Dec 2025) |
| total supply | contract_read | 1e9 - UNI.balanceOf(0xdead) | totalSupply() does not fall |
| price / circulating | coingecko | `uniswap` | |

An EVM RPC can read the flow (burns to 0xdead on Ethereum).

## Orion mapping

- Modules: holder_cashflow 0.6 (burn), forward_multiple on holder_flow 0.2, forward_multiple on revenue 0.2 (swap fees x capture).
- holder_flows: `[{id: fee_switch_burn, kind: burn, capture_rule: programmatic, recipient_base: all, source: defillama uniswap dailyHoldersRevenue}]`.
- Assumptions: base revenue should be the 30d run rate (about $190M), not 1y. Growth comes from more chains, v4 families, aggregator hooks and PFDA, minus LP migration risk to venues without the fee. Terminal capture of protocol revenue is 1.0. Fee levels are governance-adjustable (bear case: fees cut to keep LPs).
- Obstacles: the 1y DefiLlama figure mixes pre- and post-rollout periods, and the total supply must be computed from the 0xdead balance, not totalSupply().

## Sources

- https://api.llama.fi/summary/fees/uniswap?dataType=dailyRevenue / dailyHoldersRevenue / dailyFees: totals (accessed 2026-09-22)
- https://api.llama.fi/summary/fees/uniswap-v3 (also v2, v4)?dataType=dailyHoldersRevenue: methodology with rollout dates and monthly burn series (accessed 2026-09-22)
- https://api.llama.fi/summary/fees/unichain?dataType=dailyRevenue: Unichain revenue (accessed 2026-09-22)
- https://gov.uniswap.org/t/unification-proposal/25881: UNIfication (fee levels, 100M burn, Unichain fees, PFDA, Labs fee shutdown) (accessed 2026-09-22)
- https://gov.uniswap.org/t/26162: [Temp Check] Activate v4 Protocol Fees (TokenJar, 0xdead, fee families, chains live, 186k UNI record day) (accessed 2026-09-22)
- https://gov.uniswap.org/search.json?q=fee: list of 2026 fee proposals (Arc, Robinhood Chain, burn-to-staking RFC) (accessed 2026-09-22)
- Ethereum RPC (eth.drpc.org), UNI.totalSupply() and UNI.balanceOf(0xdead) (accessed 2026-09-22)
- https://api.coingecko.com/api/v3/coins/markets?ids=uniswap: circulating and total (accessed 2026-09-22)
