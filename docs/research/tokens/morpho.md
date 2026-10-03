# Morpho (MORPHO)

Researched 2026-09-22. Rank #19 by market cap (layer-1 tokens, stablecoins and tokenized RWAs excluded). Market cap $1.8B, FDV $2.6B, price $2.60 (CoinGecko, 2026-09-22).
Chain(s): Ethereum (ERC-20 `0x58D97B57BB95320F9a05dC918Aef65434969c2B2`), Base and other EVM chains. CoinGecko id: `morpho`. DefiLlama slug: `morpho` (children `morpho-blue`, `morpho-midnight`).

## Verdict

Orion fit: C. Morpho's markets carry large interest flows (fees $199.5M over 1y), but the protocol fee switch is off. DefiLlama shows revenue and holders revenue of $0, and nothing reaches MORPHO holders. A valuation would rest entirely on an assumed future fee switch.

## Business and revenue

- Fees: borrowers pay interest on isolated Morpho markets (Morpho Blue / Morpho v1) and liquidation bonuses. All of it goes to suppliers and liquidators. Vault curators (Steakhouse, Gauntlet, Sky.money and others) charge their own performance fees on MetaMorpho/Vault V2. Those go to the curators, not the protocol.
- DefiLlama `morpho` (2026-09-22): fees 30d $13.9M, 1y $199.5M. Revenue $0, holders revenue $0 (methodology: "No revenue for Morpho protocol").
- Trend: 30d annualized is $169M, below 1y, so activity is softer.
- Company layer: Morpho Labs (a company) builds the protocol. The Morpho Association (a French non-profit) owns Morpho Labs and serves the DAO. MIP 131 (posted 2026-04-24) requests a 150M MORPHO grant from the DAO to the Association for 2026-2030. That is a large treasury-to-circulation transfer (final vote status unconfirmed).

## Holder flows

- none.
- Fee switch: Morpho Blue has a per-market `fee` parameter (up to 25% of interest, from memory, unconfirmed) that only the owner (the Morpho DAO via its multisig) can set, with a governance-set fee recipient. It has never been turned on. A search of the forum for 2026 found no fee-switch proposal (forum search "fee", 2026-09-22). The 2026 governance items are signers (MIP 133), grants (MIP 131, MIP 132), curator and vault announcements.
- If activated, it would be a programmatic flow to the DAO treasury first. Whether it would reach holders (burn, buyback or staking) is undefined.
- MORPHO incentives to users are paid from the DAO's token reserves. That is emissions, not revenue.

Capture rate today: $0 / $0 protocol revenue. Against fees it is $0 / $199.5M = 0%.

## Supply

- Total and max 1,000,000,000 (totalSupply() 999,999,999.8 on Ethereum RPC, 2026-09-22). Circulating 699,299,916 (CoinGecko, 2026-09-22). No burns.
- Non-circulating: about 300M in DAO reserves, the Association, and remaining founder/partner vesting. The original allocation had 3-year vesting for founders and strategic partners, running to around 2027 (unconfirmed). MIP 131 would move 150M MORPHO to the Association over 2026-2030.
- Staking: no native revenue-funded staking.
- supply_basis recommendation: `effective_total` (1B), given the large DAO/Association tranches that can enter circulation.

## Data availability for Orion

| metric | source type | endpoint / contract / slug | notes |
|---|---|---|---|
| fees (gross interest) | defillama | `morpho`, dailyFees | |
| revenue / holder flow | defillama | `morpho`, dailyRevenue / dailyHoldersRevenue | both 0 |
| fee switch state | contract_read | Morpho Blue `0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb` (Ethereum), per-market `market(id).fee` | 0 today |
| supply | coingecko / erc20_supply | `morpho` | |
| grants / unlocks | manual | forum.morpho.org | |

An EVM RPC could read the fee parameter and any future fee recipient balance.

## Orion mapping

- Modules: forward_multiple on revenue 1.0 under a hypothetical fee (for example, 10% of fees), labeled as speculative. holder_cashflow only in bull scenarios that assume a fee switch plus a distribution route.
- holder_flows: none today. A scenario flow would be `{id: morpho_fee_switch, kind: fee_share or buy_and_hold (undefined), capture_rule: programmatic, recipient_base: all, starting in year N}`.
- Obstacles: no rule exists for how fees would reach holders. There is dilution from DAO/Association grants, and competition means a fee could push away curators and suppliers.

## Sources

- https://api.llama.fi/summary/fees/morpho?dataType=dailyFees / dailyRevenue / dailyHoldersRevenue (accessed 2026-09-22)
- https://api.llama.fi/summary/fees/morpho-blue?dataType=dailyHoldersRevenue: methodology ("No revenue for Morpho protocol") (accessed 2026-09-22)
- https://forum.morpho.org/search.json?q=fee: 2026 governance topics, no fee-switch proposal (accessed 2026-09-22)
- https://forum.morpho.org/t/2246: MIP 131, 150M MORPHO grant to the Morpho Association 2026-2030 (accessed 2026-09-22)
- Ethereum RPC (eth.drpc.org): MORPHO totalSupply (accessed 2026-09-22)
- https://api.coingecko.com/api/v3/coins/markets?ids=morpho: supply (accessed 2026-09-22)
