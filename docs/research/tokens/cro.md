# Cronos (CRO)

Researched 2026-09-22. Rank #8 by market cap (layer-1 tokens, stablecoins and tokenized RWAs excluded). Market cap $3.3B, FDV $6.6B, price $0.066182 (CoinGecko, 2026-09-22).
Chain(s): Cronos POS (Cosmos SDK) and Cronos EVM, where CRO is the gas token. Also an Ethereum ERC-20 `0xa0b73e1ff0b80914ab6fe0444e65848c4c34450b`. CoinGecko id: `crypto-com-chain`. DefiLlama slug: `cronos` (chain fees only; no revenue series).

Treated here as the exchange token of Crypto.com, with the chain fee flow noted separately.

## Verdict

Orion fit: C. Crypto.com keeps its exchange revenue, and today no revenue-funded flow to CRO has a trailing record. A new commitment, announced September 2026, burns 100% of revenue from the Ult app and Cronos Launch. It has just started and has no data yet.

## Business and revenue

- Crypto.com (Foris DAX, private) is the exchange and app business. It publishes no revenue, and none of it reaches CRO by rule.
- Cronos Labs products: in September 2026, CEO Ryan Wyatt announced that the Cronos trading app is rebranded as "Ult" (launched 2026-09-17), and that "100% of revenue from both products [Ult and Cronos Launch, a launchpad] be used to buy CRO on the open market and burn it". Operating costs come from existing capital, and the burn process is to become automated (CoinGape, 2026-09-15; Cryptonews.net, 2026-09-17). No revenue figure has been published for either product.
- Chain fees: Cronos gas fees were $183k over one year (DefiLlama `cronos` dailyFees total1y; methodology lists "Revenue: Burned coins", but the revenue endpoint returns not found). Negligible.

## Holder flows

- id `cro_labs_revenue_burn` (announced, not yet measurable): kind burn, capture_rule discretionary (a Cronos Labs policy), recipient_base all. Trailing: none; it started around 2026-09-17. Burn address: not found (unknown).
- id `cro_chain_gas`: fee-funded gas goes mainly to validators and stakers (Cronos POS). If counted at all it would be a fee_share to `staked`, but it is too small to matter (about $0.18M a year in total fees).
- Burn history: 70B CRO were burned in February 2021. In March 2025 a governance vote approved re-issuing those 70B CRO into a "Cronos Strategic Reserve" (The Block, 2025-03-18; widely criticized, including by ZachXBT). The reserve's vesting schedule is not confirmed here (reported as a multi-year lock; unconfirmed). This re-mint was an increase in supply, the reverse of a holder flow.
- Staking yield on Cronos POS is inflation-funded, which is not value by Orion's positions.

Capture rate today: 0 (no trailing revenue-funded flow). Forward: 100% of Ult and Cronos Launch revenue, but the denominator is unknown.

## Supply

Max 100B, total 98.94B, circulating 49.74B (CoinGecko, 2026-09-22). The roughly 49B difference is mostly the 70B reserve re-mint of 2025 plus other reserves. The ratio of FDV to market cap is 2x. On the Ethereum ERC-20, 86.85B of 100B sit at 0x…dEaD (bridge-era accounting, not an economic burn signal). supply_basis: effective_total (98.9B) is recommended, because reserve releases are company-discretionary. Emissions: POS staking inflation (rate not researched). Unlocks: the reserve vesting schedule is unknown or unconfirmed.

## Data availability for Orion

| metric | source type | endpoint / contract / slug | notes |
|---|---|---|---|
| price, supply | coingecko | `crypto-com-chain` | |
| chain fees | defillama | `cronos` dailyFees | tiny; no revenue series |
| Ult / Launch burn | contract_read / transfer_flow | Cronos EVM (burn address not yet known) | EVM, so readable once the address is published |
| revenue | manual | none published | |

An EVM RPC (Cronos EVM) could read the new burn once its address is known.

## Orion mapping

- Modules: forward_multiple on revenue (labeled, on an estimate of Crypto.com revenue) at most. holder_cashflow only on an assumed ramp of the Ult and Launch burn.
- holder_flows: `cro_labs_revenue_burn` {burn, discretionary, all, trailing 0}.
- Obstacles: no trailing data; Crypto.com revenue does not reach CRO; the 2025 re-mint shows that supply commitments can be reversed by the issuer, which is a governance risk to any burn assumption. Revisit in Q1 2027, once the Ult burns have a quarter of history.

## Sources

- https://coingape.com/block-of-fame/pulse/cronos-rebrands-trading-app-as-ult-ceo-ryan-wyatt-unveils-new-cro-strategy/ (100% revenue buyback-and-burn; 2026-09-22)
- https://cryptonews.net/news/analytics/33454774/ (same, with burn automation; 2026-09-22)
- Google News RSS headlines on the 70B reissue: The Block 2025-03-18 "Cronos blockchain to reissue 70 billion burned tokens…", Crypto.com 2025-03-10, Yahoo Finance 2025-03-20 (headlines only; 2026-09-22)
- https://api.llama.fi/summary/fees/cronos?dataType=dailyFees (chain fees; 2026-09-22)
- https://api.coingecko.com/api/v3/coins/markets?ids=crypto-com-chain and /coins/crypto-com-chain (supply, description; 2026-09-22)
- https://eth.drpc.org JSON-RPC (ERC-20 dead-address balance; 2026-09-23)
