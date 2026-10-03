# Raydium (RAY)

Researched 2026-09-22. Rank #49 by market cap (layer-1 tokens, stablecoins and tokenized RWAs excluded). Market cap $0.48B, FDV $0.99B, price $1.78 (CoinGecko, 2026-09-22).
Chain(s): Solana (mint `4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R`). CoinGecko id: `raydium`. DefiLlama slug: `raydium` (parent; children `raydium-amm`, `launchlab`).

## Verdict

Orion fit: A (with a Solana caveat). 12% of all Raydium trading fees buy RAY, fixed in the pool fee configs. DefiLlama publishes the revenue and holders revenue. The bought RAY is held at a public address, which the Solana RPC can read. The flow is buy_and_hold, not a burn, and DefiLlama's holders figure is derived from the fee split, not observed.

## Business and revenue

- Revenue sources:
  - AMM v4, CPMM and CLMM swaps. Swap fees are split 84/12/4 (LP / RAY buyback / treasury) for CLMM and CPMM, and 88/12/0 for AMM v4.
  - Pool creation fees of 0.15 SOL.
  - LaunchLab bonding-curve fees: 1% pre-graduation, of which the protocol takes a slice.
  - Raydium Perps.
- Payers and recipients: traders pay; LPs, RAY buyback and treasury receive (docs.raydium.io/ray/protocol-fees).
- DefiLlama `raydium` parent (2026-09-22):
  - Revenue: 30d $5.90M (about $72M annualized); 1y $23.9M.
  - Fees: 1y $151.3M.
- Trend:
  - Monthly revenue: $5.9M (Aug 2025), falling to $0.5-1.4M (Apr-Aug 2026), then a spike in Sep 2026 ($5.5M in 22 days).
  - The spike is broad: AMM fees jumped from about $0.3M a day to $1.2-2.8M a day from 2026-09-06. The cause is unknown (possibly a launchpad or memecoin wave). Treat the 30d rate as non-representative; the 1y figure is the better base.
- The 2025 LaunchLab effect: LaunchLab was Raydium's response to Pump.fun moving graduations to PumpSwap. It adds bonding-curve fees and routes graduations to CPMM. LaunchLab's share of recent fees is about $5.5M of $35.6M in the last 30d fees.
- Company layer: the Raydium team runs the treasury share (4% of CLMM/CPMM fees). There is no disclosed equity layer.

## Holder flows

- `ray_buyback`: kind buy_and_hold; capture_rule programmatic (the split is set in each pool program's AmmConfig/fee config, which the admin can change); recipient_base all.
  - Trailing annualized: 1y $18.0M (DefiLlama holders revenue); 30d $3.93M (about $48M annualized, spike-inflated).
  - Methodology: "Fees allocated to RAY token buybacks (12% across all pool types)". The LaunchLab adapter says "25% of the protocol fee is used to buy back and burn RAY". The docs say bought RAY is held, not burned, so the LaunchLab "burn" label is doubtful.
  - Observability:
    - Collection addresses: CLMM `projjosVCPQH49d5em7VYS7fJZzaqKixqKtus7yk416`, CPMM `ProCXqRcXJjoUd1RNoo28bSizAA6EEqt9wURZYPDc5u`, AMM v4 `PNLCQcVCD26aC7ZWgRyr5ptfaR7bBrWdTFgRWwu2tvF`.
    - Holding owner: `DdHDoz94o2WJmD9myRobHCwtx1bESpHTd4SSPe6VEZaz`. It holds 87.13M RAY across five token accounts (Solana RPC getTokenAccountsByOwner, 2026-09-22). That is about 32% of circulating and 15.7% of max supply.
  - History: the buyback has been in place since 2021-22. The 12% share is unchanged in the 2026 docs. The 2026-08-17 LaunchLab upgrade folded creator LP-fee keys into platform-owned locked LP; it does not change the RAY buyback share.

Capture rate today: 1y holders $18.0M / revenue $23.9M = 75%. As a share of total fees: 12%.

## Supply

- Max/total 555M. Circulating 269.7M (CoinGecko).
- The buyback wallet holds 87.1M. It is not burned, so effective total = 555M.
- supply_basis: `circulating` minus buyback-wallet holdings (about 182.6M), or circulating with an explicit held-tokens adjustment. Held RAY could be redeployed, so a haircut applies.
- Emissions: the mining reserve (34% of supply) funds farm emissions. DefiLlama tracks outflows from `fArUAncZwVbMimiWv5cPUfFsapdLd8QMXZE4VXqFagR` (65.7M released to date) and shows no scheduled unlocks for the next 12-24 months. Team, seed and advisor vesting ended in 2024. The farm emission rate in 2026 is unknown.
- Staking: RAY staking rewards come from emissions. Staked ratio unknown.

## Data availability for Orion

| metric | source type | endpoint / contract / slug | notes |
|---|---|---|---|
| revenue | defillama | `raydium` dailyRevenue | |
| holder flow | defillama | `raydium` dailyHoldersRevenue | derived from the 12% split (Raydium API volumeFee), not observed |
| observed buyback | adapter | Solana JSON-RPC `getTokenAccountsByOwner` (owner `DdHDoz...VEZaz`, RAY mint) → balance delta | non-EVM; an adapter is needed |
| fee data cross-check | http_json | `https://api-v3.raydium.io/` (pool/volume endpoints used by the DefiLlama adapter) | public JSON |
| price, supply | coingecko | `raydium` | |

No EVM RPC applies.

## Orion mapping

- Modules: holder_cashflow 50% (`ray_buyback`, buy_and_hold, programmatic, all); forward_multiple on holder_flow 25%; forward_multiple on revenue 25%.
- Assumptions:
  - Revenue base: use the 1y figure ($23.9M), not the spiking 30d figure. Volumes are highly cyclical with memecoins.
  - Terminal capture of about 75% of revenue.
  - A haircut for held rather than burned tokens.
- Obstacles: a Solana adapter is needed for observed flows and to net held RAY from supply; the September 2026 fee spike needs explaining.

## Sources

- https://docs.raydium.io/ray/protocol-fees.md: fee splits (2026-09-22)
- https://docs.raydium.io/ray/ray-buybacks.md: buyback mechanics, collection and holding addresses (2026-09-22)
- https://docs.raydium.io/products/launchlab/tips-and-gotchas/lp-fee-distribution.md and launchlab-cpmm-fee-reference.md: LaunchLab 2026-08-17 upgrade (2026-09-22)
- https://api.llama.fi/summary/fees/raydium, /raydium-amm (all dataTypes, daily series) (2026-09-22)
- https://raw.githubusercontent.com/DefiLlama/dimension-adapters/master/dexs/raydium/index.ts and /fees/launchlab/index.ts (2026-09-22)
- https://api.mainnet-beta.solana.com getTokenSupply (RAY) and getTokenAccountsByOwner (DdHDoz...) (2026-09-22)
- https://defillama-datasets.llama.fi/emissions/raydium (2026-09-22)
- https://api.coingecko.com/api/v3/coins/markets?ids=raydium (2026-09-22)
