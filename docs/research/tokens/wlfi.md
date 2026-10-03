# World Liberty Financial (WLFI)

Researched 2026-09-22. Rank #18 by market cap (layer-1 tokens, stablecoins and tokenized RWAs excluded). Market cap $1.8B, FDV $5.8B, price $0.058252 (CoinGecko, 2026-09-22).
Chain(s): Ethereum (ERC-20 `0xda5e1988097297dcdc1f90d4dfe7909e847cbef6`, canonical), BNB Chain (`0x47474747477b199288bf72a1d702f7fe0fb1deea`, bridged), Solana (`WLFinEv6ypjkczcS83FZqFpgFZYwQXutRbxGe7oC16g`). CoinGecko id: `world-liberty-financial`. DefiLlama slug: `world-liberty-financial` (USD1 reserve yield).

## Verdict

Orion fit: C. The company behind WLFI earns real, published revenue (USD1 reserve yield, $122.7M over the last year on DefiLlama), but it stays with World Liberty Financial and its owners. The one revenue-funded holder flow, a governance-approved buyback and burn of protocol-owned-liquidity fees, executed once (about $1.45M of fees from 2025-09-01 to 09-26, burned 2025-09-26) and has been dormant since; on-chain supply shows no revenue-funded burn after October 2025. A pending September 2026 proposal would pay stakers from WLFI Markets fees (discretionary, staked-only), which could lift this to B if it passes and is funded.

- A: revenue-funded holder flow exists, is measurable (on-chain or DefiLlama), and revenue is published. Config-only or near config-only in Orion.
- B: real revenue and a holder flow exist but something is hard: off-chain data, discretionary capture, non-EVM chain needing an adapter, or an equity layer that keeps most value.
- C: revenue exists but nothing reaches holders today (fee switch off, all to validators/treasury), or the flow is inflation-funded; a valuation would rest entirely on an assumed future capture.
- D: no revenue model (store of value, meme, pure inflation staking). Not suitable.

## Business and revenue

World Liberty Financial (WLF) issues the USD1 stablecoin (circulating $4.39B, DefiLlama stablecoins, 2026-09-22), operates the WLFI app with a lend/borrow market ("World Liberty Markets provided by Dolomite", described by the team as a top-10 lending market, governance post 54462, 2026-09-14), and holds protocol-owned liquidity (POL) in WLFI pools on Ethereum, BNB Chain and Solana.

- USD1 reserve yield: DefiLlama `world-liberty-financial` fees = revenue = "All yields from USD1 backing assets investments (Fidelity money market funds) collected by World Liberty Financial": 30d $10,892,725, 1y $122,745,174, all-time $147,261,641; holders revenue 0 (2026-09-22). Monthly revenue rose from $5.3M (June 2025) to $10-12M per month in January-August 2026; September 1-22 is $8.1M. 30d annualized about $132M.
- WLFI Markets fees accrue to WLF (not separately listed on DefiLlama; the Dolomite slug shows $11.1M of 1y fees for all of Dolomite).
- POL trading fees: about $1.45M over 26 days in September 2025 (see below); no later disclosure.

Equity layer: WLF is a private company; the team repeats that "WLFI remains solely a governance utility token" with no "ownership interest in, or economic rights relating to, the WLF platform" (post 54462). A Trump-family entity (DT Marks DEFI LLC) is reported to be entitled to 75% of token-sale net revenues (from memory, unconfirmed). The company keeps USD1 revenue: 0% reaches WLFI.

## Holder flows

1. id `pol_fee_buyback_burn`, kind burn, capture_rule discretionary (a Snapshot vote directs it, but WLF claims and executes the fees manually and has not done so since 2025), recipient_base all.
   - Rule: "Use 100% of WLFI Treasury Liquidity Fees for Buyback & Burn", posted 2025-09-01, passed 2025-09-18 (4.43B FOR, about 0 against; Snapshot space `worldlibertyfinancial.com`). Only fees from WLFI-controlled liquidity; covers Ethereum, BSC and Solana.
   - Execution: one round on 2025-09-26 covering fees accrued 2025-09-01 to 09-26 (Uniswap V3 on Ethereum, PancakeSwap V3 on BSC): 3,109,321 WLFI from fee claims burned plus 3,814,096 WLFI bought with $798,339 of USD1/USDC/USDT at $0.2093 average (community analysis, governance post 50239, matching the team's X post). Ethereum `totalSupply()` fell by exactly 6,923,416 WLFI between 2025-09-25 and 2025-10-15. Value about $1.45M (the WLFI leg at about $0.21).
   - Since then: Ethereum `totalSupply()` is flat from 2025-10-15 to 2026-05-10; later decreases are vesting-election burns, not buybacks (below). A 2026-03-18 community open letter (post 53154) complains that "no meaningful, consistent buyback or burn has been executed" since late 2025 with no official explanation. No team reply found.
   - Trailing: 1y about $1.45M (the single September 2025 round, just inside the window); 90d $0.
2. Pending: id `markets_fee_staking_rewards`, kind fee_share, capture_rule discretionary, recipient_base staked (180-day lock, must vote at least once per 90 days). "$WLFI Governance Engagement Incentive Program" (post 54462, Snapshot vote ends 2026-09-28, 1.29B YES / 0.19B NO at 2026-09-22): rewards pool "may be funded from ... fees received by WLF from World Liberty Markets" plus marketing incentives, topped up bi-weekly into a public rewards address. No fixed share of fees is committed, so the revenue-funded part cannot be known ahead of time. It replaces the March 2026 staking system (target about 2% APR paid from treasury WLFI, "not tied to or contingent on revenues"). Under Orion's rules treasury-token rewards are a transfer, not value.
3. Other proposals with no status: 75% of USD1 reserve yield to buyback and burn (community post 42588, September 2025), and a USD1 payments wallet with fee-funded buyback (post 54688, 2026-09-21). Neither was put to a vote.

Non-revenue burns (excluded): 47,000,000 WLFI burned in early September 2025 (supply 100B to 99.953B; reportedly tokens from compromised/blacklisted wallets, unconfirmed), and 3.2233B WLFI burned by founders/team/advisors electing the new vesting (10% of their locked tokens): 3.1833B in May 2026 (between blocks 25,065,051 and 25,137,051), 20M on 2026-06 (block 25,152,807) and 20M in September 2026 (block 25,926,019, tx `0xd94c39d1...0f64`, method `electVestingUpdate`, burned from the vesting proxy `0x74b4f6a2e579d730aacb9dd23cfbbaeb95029583`).

Capture rate today: trailing 1y revenue-funded burn about $1.45M / USD1 revenue $122.7M = about 1.2%; on the last 90 days, $0 / about $33M = 0%.

## Supply

- Ethereum `totalSupply()` 96,722,743,250 WLFI (2026-09-22), down from 100B at launch; CoinGecko still shows total/max 100B (stale). BSC `totalSupply()` 637,538,928 is the bridged representation (not additive, unconfirmed). CoinGecko circulating 31,777,798,056 (32.9% of on-chain total).
- Transferability: WLFI became tradable on 2025-09-01 (Snapshot "Make $WLFI Token Tradable", passed 2025-07-16, 11.14B yes). At launch 20% of early-supporter (presale) tokens unlocked; the remaining 80% stayed locked.
- Unlock proposal "Early Supporter & Founder/Team/Partner Token Unlock" passed (Snapshot closed 2026-05-06, 11.2B yes / 0.01B no): early-supporter locked tokens (17.04B) get a 2-year cliff then 2-year linear vest from passage (unlocks begin about May 2028, complete about May 2030) for holders who accept; founder/team/advisor/partner locked tokens (45.24B) burn 10% and move to a 2-year cliff then 3-year linear vest (from about May 2028 to May 2031). Holders who do not accept remain locked indefinitely. Supply data show about 32.2B of team tokens have elected so far (3.22B burned, 10%).
- Next 12-24 months: no scheduled vesting unlocks under the passed proposal (first cliff about May 2028). Supply can still grow through discretionary treasury use: "Utilize Unlocked $WLFI Treasury Holdings to Support the Growth of USD1" passed 2026-01-04 (3.31B vs 0.94B), and staking rewards are paid in treasury WLFI.
- Staking: none live as of 2026-09-22 beyond the program under vote; any yield so far is treasury-funded, not fee-funded.
- supply_basis: `circulating` is defensible for 24 months because cliffs start in 2028, but the treasury's unlocked holdings are discretionary supply; use `effective_total` (96.72B) for a conservative per-token value.

## Data availability for Orion

| metric | source type | endpoint / contract / slug | notes |
|---|---|---|---|
| price, mcap, circ | coingecko | `world-liberty-financial` | CoinGecko total is stale (100B) |
| revenue (USD1 yield) | defillama | `world-liberty-financial` dailyRevenue | company revenue, not token revenue |
| holder flow: POL buyback burn | contract_read / derived | Ethereum `totalSupply()` on `0xda5e...bef6`, differenced; or transfer_flow of Transfer(to=0x0) | must exclude vesting-election burns (from `0x74b4f6a2...9583`, method `electVestingUpdate`) and admin burns; BSC and Solana legs were bridged to Ethereum before burning in 2025 |
| holder flow: staking rewards (pending) | transfer_flow | public rewards address (not yet published) | discretionary top-ups; revenue-funded share unknown |
| effective supply | erc20_supply | Ethereum `totalSupply()` | reflects burns (burns go to 0x0) |
| unlocks | manual | governance post 53266 / Snapshot `worldlibertyfinancial.com` | cliffs from about May 2028 |
| governance status | http_json | `https://hub.snapshot.org/graphql` (space `worldlibertyfinancial.com`); Discourse `governance.worldlibertyfinancial.com/t/<id>.json` | |

An EVM RPC can read the burn: WLFI burns reduce `totalSupply()` on Ethereum, and historical `eth_call` at past blocks works on eth.drpc.org. Free RPCs limit `eth_getLogs`; supply differencing plus sender filtering is the practical method.

## Orion mapping

- Modules (if included): `forward_multiple` on revenue (market convention on USD1 revenue, explicitly labeled as company revenue the token has no claim on), weight 0.6; `holder_cashflow` on `pol_fee_buyback_burn` with base-case capture near 0 (dormant) and a bull case with resumed POL burns plus the fee-funded staking pool, weight 0.4.
- holder_flows: `pol_fee_buyback_burn` (burn, discretionary, all; trailing about $1.45M/yr, 90d $0); optional `markets_fee_staking_rewards` (fee_share, discretionary, staked) only once the rewards address and funding are observable.
- Assumptions needed: USD1 revenue growth and rate sensitivity (reserve yield falls with T-bill rates); terminal capture (0-5% bear/base, a USD1-yield-linked buyback in bull only if governance ever adopts one); revenue multiple for stablecoin issuers.
- Obstacles: every holder flow is company discretion; the one approved rule went unexecuted for about 12 months; the token explicitly carries no economic rights; political and regulatory risk; circulating supply is a third of total.

## Sources

- https://api.coingecko.com/api/v3/coins/world-liberty-financial (price, supply, contracts; 2026-09-22)
- https://api.llama.fi/summary/fees/world-liberty-financial?dataType=dailyRevenue / dailyFees / dailyHoldersRevenue (USD1 revenue, methodology, monthly series; 2026-09-22)
- https://stablecoins.llama.fi/stablecoins (USD1 circulating; 2026-09-22)
- https://governance.worldlibertyfinancial.com/t/41226.json (POL fee buyback and burn proposal text; 2026-09-22)
- https://governance.worldlibertyfinancial.com/t/50239.json (community analysis of the 2025-09-26 burn with tx links; 2026-09-22)
- https://governance.worldlibertyfinancial.com/t/53154.json (2026-03-18 open letter on suspended buybacks; 2026-09-22)
- https://governance.worldlibertyfinancial.com/t/53266.json (unlock/vesting proposal; 2026-09-22)
- https://governance.worldlibertyfinancial.com/t/52645.json (March 2026 staking system, treasury-funded 2% APR; 2026-09-22)
- https://governance.worldlibertyfinancial.com/t/54462.json (September 2026 incentive program funded partly by WLFI Markets fees; 2026-09-22)
- https://governance.worldlibertyfinancial.com/t/54688.json and /t/42588.json (unvoted buyback proposals; 2026-09-22)
- https://hub.snapshot.org/graphql, space `worldlibertyfinancial.com` (all vote outcomes and dates; 2026-09-22)
- https://eth.drpc.org historical eth_call `totalSupply()` at 14 dates and bisection to burn blocks; eth_getLogs at those blocks (2026-09-22)
- https://eth.blockscout.com/api/v2/transactions/0xd94c39d13aca0eb3ef39067f602249b758016e83b912636f262c3f3b242f0f64 (burn is `electVestingUpdate`; 2026-09-22)
- https://bsc-dataseed.binance.org eth_call `totalSupply()` on BSC WLFI (2026-09-22)
