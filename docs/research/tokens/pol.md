# Polygon Ecosystem Token (POL)

Researched 2026-09-22. Rank #28 by market cap (layer-1 tokens, stablecoins and tokenized RWAs excluded). Market cap $1.2B, FDV $1.2B, price $0.108667 (CoinGecko, 2026-09-22).
Chain(s): Ethereum (ERC-20 `0x455e53CBB86018Ac2B8092FdCd39d8444aFFC3F6`, the canonical supply and emission contract); gas token of Polygon PoS (native, `0x...1010`). CoinGecko id: `polygon-ecosystem-token`. DefiLlama slug: `polygon` (chain).

## Verdict

Orion fit: B. Two fee-funded flows exist on paper.
- The EIP-1559 base fee, labeled a burn: it has not actually been destroyed since November 2023. About 174.7M POL (about $19M) sits in an upgradeable "temporary holder" contract and a Safe multisig.
- The priority-fee share to stakers (PIP-85, 2026): a fee_share to `staked`, distributed off-chain through Merkle claims.
Both are programmatic but depend on Polygon Labs operations. Against them stands a 2% a year emission (about 214M POL, about $23M a year). Net supply is inflationary.

## Business and revenue

- Polygon PoS users pay gas in POL. The base fee goes to the configured `burntContract`, and the priority fee goes to block producers and validators under the PIP-65 distribution system, run by Polygon Labs and Regen Financial.
- DefiLlama `polygon` (2026-09-22): fees 30d $2.19M, 1y $28.35M. Revenue 30d $2.19M, 1y $28.30M. DefiLlama computes "revenue" as gross gas minus Ethereum checkpoint costs, not as burned fees. Monthly fees ran $2.2-4.9M from 2026-01 to 2026-08, against $0.3-1.0M in 2025-08 to 2025-12: payments and stablecoin traffic grew and the gas floor was raised.
- Split, estimated: the base-fee flow into the Safe collector was about 47.6M POL over about 180 days (balance 5.49M at block 86,506,825, about 2026-03-26, rising to 53.05M on 2026-09-22). That is about 96M POL a year, or about $10.5M. The priority-fee remainder is about $18M a year. PIP-85 states over 5.4M POL of priority fees went to validators in the February 2026 distribution alone.
- Other revenue: Agglayer/CDK and chain-licensing income accrues to Polygon Labs or the Foundation, not to POL, and is not quantified. Polygon Labs is a private company, and the Community Treasury is run by the Polygon Community Treasury Board.
- Announced (PIP-87, 2026-04-30; adoption status unconfirmed): a fixed-cost payments program under which fiat revenue from payment firms buys POL. Part goes to stakers and part to the burn collector, split by the trailing priority/base fee ratio.

## Holder flows

- id `base_fee_burn`, kind burn, capture_rule programmatic, recipient_base all
  - Status: not currently destroying supply.
    - PIP-24 (2023-10) moved the base-fee recipient to `0x7A8ed27F4C30512326878652d20fC85727401854`, an upgradeable "temporary holder contract that will collect MATIC/POL to be burned" pending an LxLy bridge path. It holds 121,624,850 POL (2026-09-22), unchanged over the last 90 days apart from a 13 POL transfer.
    - PIP-82 (Lisovo hardfork, block 83,756,500 on 2026-03-04) redirected the base fee to Safe `0x3EF57dEf668054dD750BD260526105C4EEEf104F`. It holds 53,054,992 POL. That PIP recycles up to $1M of x402 "agentic commerce" base fees as rebates through 2026-12-31 and forwards the rest to 0x7A8e, but no forwarding is visible in the last 90 days.
    - On Ethereum, POL at 0xdead is 116.7 POL, and POL totalSupply() equals the emission schedule exactly. So no POL has been burned on Ethereum.
  - Trailing: about 96M POL a year accrues to the collectors, about $10.5M a year at $0.109 (derived from Polygon PoS balance reads, 2026-03-26 to 2026-09-22). There is no DefiLlama holders-revenue series.
  - Observability: native POL balances of the two collector addresses on Polygon PoS (EVM). No Transfer events: the base fee is credited by consensus, so this needs `eth_getBalance` deltas on an archive RPC, not `transfer_flow`.
  - Treatment: if Orion counts it as a burn, add a haircut for custody risk (upgradeable contract, then multisig).
- id `priority_fee_staker_share`, kind fee_share, capture_rule programmatic, recipient_base staked
  - PIP-85 (2026-03-25) takes 50% of the validator pool of priority fees and pays it to stakers (delegators) through periodic Merkle claimers on Ethereum. The rest is split 75% equal-weighted and 25% by stake among validators. Block producers take their own cut first (PIP-65).
  - Trailing: unknown. It started in 2026 and the distributions are off-chain computed. At an estimated $18M a year of priority fees, the staker share might be a few million dollars a year (unconfirmed).
  - Observability: Merkle distributor contracts on Ethereum, addresses not collected. Monthly reports by Regen Financial.
- Staking reward from emissions (1% a year of supply to the stake manager) is inflation, so it is not a holder flow.

Capture rate today: counting the held base fee as a burn, about $10.5M / $28.3M = 37% of fees. Counting only destroyed supply it is 0%. With the PIP-85 staker share added: unknown, possibly 45-50%.

## Supply

- totalSupply() on Ethereum = 10,719,336,776 POL (RPC, 2026-09-22), matching `inflatedSupplyAfter()` of the emission manager (10,719,387,730).
- Emission manager `0xbC9f74b3b14f460a6c47dCdDFd17411cBc7b6c53` (DefaultEmissionManager v1.4.0, reset on 2025-07-09 with START_SUPPLY_1_4_0 = 10,466,456,329):
  - 2% a year compounded (INTEREST_PER_YEAR_LOG2 = log2(1.02)).
  - Half goes to the stake manager (validator and staker rewards) and half to the community treasury. That is about 214M POL a year now.
  - The mint is permissionless on schedule. The rate changes only by contract upgrade through Polygon governance.
- A 2025-10 forum proposal to cut inflation to 0% and add a treasury buyback got 42 replies and no PIP adoption that I could find.
- Effective supply: 10.719B. Optionally subtract the 174.7M POL held for burn (effective 10.545B). The MATIC remnant at 0xdead (28.05M MATIC) is legacy.
- Circulating: 10.72B per CoinGecko, which counts the treasury as circulating.
- supply_basis recommendation: `effective_total`, with the held base-fee POL either left in supply or subtracted with a custody haircut. Staked: about 3.6B POL sits in the stake manager `0x5e3E...D908` (about 34% of supply).
- Net inflation: +2.0% gross. About +1.1% if the held base fees are counted as burned.
- Unlocks: none. MATIC-to-POL migration is ongoing: 379M POL in the migration contract.

## Data availability for Orion

| metric | source type | endpoint / contract / slug | notes |
|---|---|---|---|
| revenue_run_rate_usd (gas fees) | defillama | `polygon` dailyFees | "revenue" is gas minus checkpoint cost, not burn |
| base-fee "burn" | contract_read (balance) / adapter | native balance deltas of `0x3ef57def668054dd750bd260526105c4eeef104f` + `0x7A8ed27F4C30512326878652d20fC85727401854` on Polygon PoS | needs archive RPC; not Transfer events |
| staker priority share | manual / adapter | PIP-85 Merkle claimers on Ethereum; Regen Financial reports | off-chain computed |
| emissions | contract_read | `inflatedSupplyAfter(t)` on `0xbC9f74b3...6c53` (Ethereum) | exact schedule |
| supply | erc20_supply | POL `0x455e53...F3F6` totalSupply | |
| staked ratio | contract_read | POL.balanceOf(stake manager `0x5e3Ef299fDDf15eAa0432E6e66473ace8c13D908`) | |
| price | coingecko | `polygon-ecosystem-token` | |

An EVM RPC can read the collectors and the emissions (Polygon PoS and Ethereum are both EVM). The base-fee flow needs balance-at-block reads, which 1rpc.io only partly served.

## Orion mapping

- Modules: holder_cashflow 0.4, forward_multiple on revenue 0.4 (L2/chain fee multiple convention), forward_multiple on holder_flow 0.2.
- holder_flows:
  - `{id: base_fee_burn, kind: burn, capture_rule: programmatic, recipient_base: all, source: contract_read collector balance delta}`, with a custody haircut.
  - `{id: priority_fee_staker_share, kind: fee_share, capture_rule: programmatic, recipient_base: staked, source: manual}`.
- Supply: a 2%/yr compounding emission step schedule, with staker share of emissions 50%.
- Assumptions: fee growth follows payments and stablecoin volume. Terminal capture is about 0.35-0.5. The bear case keeps the base fee held forever or rebated (PIP-82 style); the bull case adds PIP-87 fiat buybacks and an emission cut.
- Obstacles and open questions:
  - When or if the 174.7M POL is actually destroyed.
  - Whether PIP-87 is live.
  - Addresses and amounts of the PIP-85 staker Merkle drops.
  - DefiLlama carries no holders revenue for Polygon.

## Sources

- https://api.llama.fi/summary/fees/polygon?dataType=dailyFees (and dailyRevenue): fees, revenue, methodology, monthly series (accessed 2026-09-22)
- https://raw.githubusercontent.com/DefiLlama/dimension-adapters/master/fees/polygon.ts: DefiLlama revenue = gas minus L1 checkpoint cost (accessed 2026-09-22)
- https://raw.githubusercontent.com/0xPolygon/bor/master/builder/files/genesis-mainnet-v1.json: burntContract history (block 50,523,000: 0x7A8e; block 83,756,500: 0x3ef5) (accessed 2026-09-22)
- https://forum.polygon.technology/t/13007: PIP-24, base fee to a temporary holder contract (accessed 2026-09-22)
- https://forum.polygon.technology/t/21713 and /t/21721: PIP-81 Lisovo hardfork, PIP-82 base-fee recipient change and x402 rebate (accessed 2026-09-22)
- https://forum.polygon.technology/t/21829: PIP-85, 50% of the validator priority-fee pool to stakers, 5.4M POL February distribution (accessed 2026-09-22)
- https://forum.polygon.technology/t/21865: PIP-87 fixed-cost payments revenue program with POL buybacks (accessed 2026-09-22)
- https://forum.polygon.technology/t/21323: 2025-10 proposal to end 2% inflation (discussion only) (accessed 2026-09-22)
- https://eth.blockscout.com/api/v2/smart-contracts/0x282FD46E108E40A45e4CE425bA75f80245e6C2E0: DefaultEmissionManager source, 2%/yr, 50/50 split (accessed 2026-09-22)
- Ethereum RPC https://1rpc.io/eth (cast): POL totalSupply, START_SUPPLY_1_4_0, inflatedSupplyAfter, balances at 0xdead, stake manager, migration (accessed 2026-09-22)
- Polygon RPC https://1rpc.io/matic and https://polygon.blockscout.com/api/v2/addresses/...: collector balances, current and historical (accessed 2026-09-22)
- https://api.coingecko.com/api/v3/coins/polygon-ecosystem-token: market data (accessed 2026-09-22)
