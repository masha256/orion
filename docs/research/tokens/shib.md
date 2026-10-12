# Shiba Inu (SHIB)

Researched 2026-09-22. Rank #7 by market cap (layer-1 tokens, stablecoins and tokenized RWAs excluded). Market cap $3.6B, FDV $3.6B, price $0.00000606 (CoinGecko, 2026-09-22).
Chain(s): Ethereum (ERC-20 `0x95ad61b0a150d79219dcf64e1e6cc01f0b64c4ce`); ecosystem L2 Shibarium (gas token BONE, not SHIB). CoinGecko id: `shiba-inu`. DefiLlama slug: none for SHIB; related `shibarium` (chain fees) and `shibaswap-v1` / `shibaswap-v2` (DEX, governance token BONE).

## Verdict

Orion fit: D. SHIB has a visible burn culture (41% of the original supply sits in a dead address), but almost all of it is the 2021 Vitalik burn plus voluntary community burns, not revenue. The revenue-funded part (Shibarium base-fee burn, small launchpad/fee-distributor burns) is economically negligible: all SHIB sent to the main burn address in the last year was about 4.2B SHIB, about $22k, 0.0007% of supply. Shibarium's own fees are under $1k per year on DefiLlama.

- A: revenue-funded holder flow exists, is measurable (on-chain or DefiLlama), and revenue is published. Config-only or near config-only in Orion.
- B: real revenue and a holder flow exist but something is hard: off-chain data, discretionary capture, non-EVM chain needing an adapter, or an equity layer that keeps most value.
- C: revenue exists but nothing reaches holders today (fee switch off, all to validators/treasury), or the flow is inflation-funded; a valuation would rest entirely on an assumed future capture.
- D: no revenue model (store of value, meme, pure inflation staking). Not suitable.

## Business and revenue

The Shiba Inu ecosystem (shib.io; docs.shib.io) comprises Shibarium (an EVM L2/sidechain whose gas token is BONE), ShibaSwap (DEX; governance/reward token BONE), Shib Name Service, a launchpad, a DAO, and tokens SHIB, BONE, LEASH, TREAT. SHIB itself is not the fee token of any of these.

- Shibarium: DefiLlama `shibarium` fees (gas paid by users, in BONE) 30d $7.75, 1y $950.76, all-time $950.76 (2026-09-22); methodology "Revenue: Burned coins". Mechanism (from memory, unconfirmed against primary docs because docs.shib.io no longer has a burn page): a share of Shibarium base fees (70% was the announced figure at the August 2023 launch) is collected in BONE, bridged to Ethereum, swapped to SHIB and sent to the dead address, with the burn triggered manually by anyone via the Shibarium burn contract/portal. At under $1k of fees per year, the SHIB bought with it is immaterial regardless of the exact split.
- ShibaSwap V1: DefiLlama fees 30d $33,546, 1y $1,017,078 (2026-09-22). Swap fees go mainly to LPs; the protocol share historically went to BONE/xSHIB stakers (unconfirmed). It is not a SHIB burn.
- Launchpad / fee distributor contracts on Ethereum burn small amounts of SHIB (see Holder flows).

No company layer shares revenue with SHIB. Annualized revenue relevant to SHIB: effectively zero (Shibarium about $1k/yr).

## Holder flows

1. id `shibarium_base_fee_burn`, kind burn, capture_rule programmatic (fee split set by the Shibarium team/contracts; trigger manual), recipient_base all.
   - Trailing: bounded above by Shibarium fees, $951 over the last year (DefiLlama `shibarium`, 2026-09-22). Not separable in the dead-address inflows without identifying the burn contract (its address could not be confirmed; docs page gone, web search budget exhausted).
   - History: announced at Shibarium launch (August 2023, unconfirmed); no 2025-2026 change found.
2. id `ecosystem_fee_burns`, kind burn, capture_rule programmatic, recipient_base all.
   - Verified contracts that send SHIB to `0xdEAD000000000000000042069420694206942069` on Ethereum: `FeeDistributor` `0x1fc39045035e37DA1880d2102c380e8DD8E69A89` (verified source: burns `amount * burnBps / 10000` per registered tokenId to DEAD, remainder to a platform address) burned 3.11B SHIB (about $15.4k) between 2026-07-25 and 2026-09-03, mostly in a burst on 2026-07-26/27; `ShibLaunchpad` `0x72171144b37F22424803aA92A61cE0d827ADd3e9` (`processAll`) burned 29.4M SHIB (about $153) in the last 30 days.
   - Trailing 1y: about $15.6k combined (Blockscout transfers into DEAD, priced with DefiLlama daily SHIB prices; 2026-09-22).
3. Voluntary burns (not revenue-funded, excluded): EOAs such as `0x9c87E5EF...3E27` and `0x1887FA9E...3cDd` send about 200k SHIB several times a day; Coinbase and others burn small amounts (shibburn.com top burners). These are donations, not holder flows.

All SHIB sent to the main burn address (Blockscout, 2026-09-22; USD at daily DefiLlama prices):
- last 30 days (since 2026-08-23): 121.9M SHIB, $649 (shibburn.com, which tracks more burn addresses, shows 381.6M SHIB, $2,025 for 30 days)
- last 90 days (since 2026-06-24): 3.59B SHIB, $17,669 (of which FeeDistributor $15,378)
- last 1 year (since 2025-09-22): 4.18B SHIB, $22,240 (FeeDistributor $15,378; the rest mostly voluntary)
- share of supply removed in 1 year: 4.18B / 589.5T effective = 0.0007%.

SHIB burn portal: the 2022 "Burn Portal" on ShibaSwap let users burn SHIB in exchange for RYOSHI-denominated rewards (from memory, unconfirmed); it is a user-funded burn, not revenue, and no current activity from it appears among top burners.

Capture rate today: revenue-funded burns about $16k/yr over revenue that is about $1k/yr (Shibarium) plus unknown launchpad fees; the ratio is not meaningful. In USD terms the holder flow is about 0.0004% of market cap per year.

## Supply

`totalSupply()` 999,982,329,055,139 SHIB (Ethereum, 2026-09-22); burns go to dead addresses and do not reduce `totalSupply`. Balance of `0xdEAD000000000000000042069420694206942069`: 410,436,800,587,759 SHIB (41.04%); balance of `0x...dEaD`: 49,458,229,658 SHIB. CoinGecko total 589,496,070,237,722 and circulating 589,238,968,463,203 (net of dead addresses). shibburn.com (2026-09-22): 410.84T burned in total, 21,860 burn transactions. No emissions, no vesting, no unlocks, no SHIB staking yield from fees (ShibaSwap "Bury" rewards were paid in BONE emissions, unconfirmed). supply_basis: `effective_total` = totalSupply minus dead-address balances (about 589.5T); CoinGecko already reports this.

## Data availability for Orion

| metric | source type | endpoint / contract / slug | notes |
|---|---|---|---|
| price, mcap, circ | coingecko | `shiba-inu` | circ already net of burns |
| Shibarium fees | defillama | `shibarium` dailyFees | about $1k/yr |
| burn flow (all) | transfer_flow | Ethereum SHIB `0x95ad...c4ce`, to `0xdEAD000000000000000042069420694206942069` | includes voluntary burns; must filter by sender |
| burn flow (revenue-funded) | transfer_flow | same, from `0x1fc39045035e37DA1880d2102c380e8DD8E69A89` and `0x72171144b37F22424803aA92A61cE0d827ADd3e9` | Shibarium burn contract address unconfirmed |
| total supply | erc20_supply + contract_read | `totalSupply()` minus `balanceOf(dead addresses)` | |
| cross-check | http_json | shibburn.com (HTML only) / Blockscout `eth.blockscout.com/api/v2/addresses/<dead>/token-transfers` | Blockscout JSON works without a key |

An EVM RPC can read the burns (Transfer logs into the dead address), but public free RPCs limit `eth_getLogs` ranges severely (drpc refused, 1rpc 50 blocks, blastapi 10 blocks); Blockscout's REST API was the practical path.

## Orion mapping

Not suitable. If forced: `holder_cashflow` on a burn flow of about $16-22k/yr against a $3.6B market cap gives a value near zero; there is no revenue for a `forward_multiple`. Open question only if Shibarium usage grew by orders of magnitude, which is not visible in 2025-2026 data.

## Sources

- https://api.coingecko.com/api/v3/coins/shiba-inu (supply, contract, links; 2026-09-22)
- https://api.llama.fi/summary/fees/shibarium?dataType=dailyFees (Shibarium fees, methodology; 2026-09-22)
- https://api.llama.fi/summary/fees/shibaswap-v1?dataType=dailyFees (ShibaSwap fees; 2026-09-22)
- https://www.shibburn.com/ (total burned, 24h/7d/30d burns, top burners; 2026-09-22)
- https://etherscan.io/token/0x95ad61b0a150d79219dcf64e1e6cc01f0b64c4ce?a=0xdead000000000000000042069420694206942069 (burn address balance; 2026-09-22)
- https://eth.blockscout.com/api/v2/addresses/0xdead000000000000000042069420694206942069/token-transfers?type=ERC-20&filter=to&token=0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE (1,544 burn transfers since 2025-09-20, by sender; 2026-09-22)
- https://eth.blockscout.com/api/v2/smart-contracts/0x1fc39045035e37DA1880d2102c380e8DD8E69A89 (FeeDistributor verified source, burnBps logic; 2026-09-22)
- https://coins.llama.fi/chart/ethereum:0x95ad61b0a150d79219dcf64e1e6cc01f0b64c4ce (daily SHIB prices for USD conversion; 2026-09-22)
- https://eth.drpc.org eth_call `totalSupply()`, `balanceOf` of dead addresses (2026-09-22)
- https://docs.shib.io/llms.txt (ecosystem overview; no burn page found; 2026-09-22)
