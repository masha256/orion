# Stacks (STX)

Researched 2026-09-22. Rank #38 by market cap (layer-1 tokens, stablecoins and tokenized RWAs excluded). Market cap $0.63B, FDV $0.63B, price $0.336131 (CoinGecko, 2026-09-22).
Chain(s): Stacks (Bitcoin layer, Clarity VM; not EVM). CoinGecko id: `blockstack`. DefiLlama slug: `stacks` (chain).

## Verdict

Orion fit: D. The BTC that stakers earn is paid out of miners' BTC bids. Miners bid BTC to win the newly minted STX coinbase, so the BTC yield is economically the market value of STX emissions passed through miners. Under Orion's rules that is inflation-funded yield, not revenue. Transaction fees ($0.2M a year) go to miners, and neither sBTC nor the protocol charges a fee that reaches STX. Supply inflation is about 3-6% a year.

## Business and revenue

- Proof of Transfer:
  - Miners commit BTC in Bitcoin transactions to win a tenure and earn the 1,000 STX coinbase plus transaction fees.
  - Under PoX-5 (SIP-045, live 2026-07-30 at Bitcoin block 960,230), all miner BTC goes to a single reward pool, auto-bridged to sBTC. It pays a waterfall: active BTC-staking "protocol bonds" at a target rate first, then STX-only stakers pro rata from the residual, then a reserve fund.
  - Nothing is burned (PoX-5 removed the burn address).
  - Bond capacity, coverage ratio and target APY are set administratively by the Stacks Endowment during the bootstrap.
- Transaction fees (DefiLlama `stacks`): 30d $47.5K, 1y $199K, paid to miners. DefiLlama revenue is 0: "Stacks transaction fees are not burned".
- Company/foundation layer: the Stacks Endowment (SIP-031) receives growth emissions and manages the treasury. Stacks Labs/Hiro are separate entities.

## Holder flows

- id `stacking_btc_yield`, kind fee_share (in form), capture_rule programmatic, recipient_base staked. For Orion treat it as not a revenue flow.
  - Source of funds: miner BTC commitments. Miners' willingness to pay is bounded by the value of the STX coinbase plus fees. The docs note that total miner spend is "less than" coinbase value in sats. Fees are about $0.2M a year against coinbase value of about $17.7M a year, so about 99% of the pool is the monetized emission.
  - Trailing annualized USD: unknown, since there is no API series here. Upper bound about $18M a year, the coinbase value at $0.336.
  - Observability: Bitcoin block-commit outputs to the PoX-5 pool and sBTC payouts. Non-EVM; needs a Stacks API adapter (Hiro API).
  - History: PoX-4 (2024-04) paid stackers' BTC addresses directly. PoX-5 (2026-07-30) added BTC bonds and the reserve fund.
- No burn and no buyback.

Capture rate today: 0 by Orion's definition. Revenue (fees) of $0.2M goes to miners, and the stacking yield is emissions-funded.

## Supply

- Circulating = total 1,868,553,460 STX (CoinGecko, 2026-09-22). No max supply.
- Emissions:
  - Coinbase of 1,000 STX per Bitcoin block (about 52,560 blocks a year), about 52.6M STX a year (2.8% of supply). SIP-045 restored it from 500 to 1,000 at Epoch 4.0 and removed the reduction schedule. The 1,000 rate is "provisional for the PoX-5 bootstrap", with reassessment deferred to PoX-6.
  - SIP-031 (2025) added five years of growth emissions to the Stacks Endowment, raising average total emissions from 3.52% to about 5.75% a year (stated under the earlier coinbase schedule). The combined current rate is unconfirmed, likely about 5-7%.
- supply_basis recommendation: `circulating` (equals total).
- Staking yield: BTC-denominated, funded by miner bids for emissions, so effectively inflation.
- Staked ratio: unknown. There is a 50,000 STX minimum per signer in aggregate.
- Unlocks: no investor cliffs remain (unconfirmed). Endowment emissions act as the release stream.

## Data availability for Orion

| metric | source type | endpoint / contract / slug | notes |
|---|---|---|---|
| tx fees | defillama | `stacks` dailyFees | to miners |
| stacking pool BTC | adapter | Hiro Stacks API / PoX-5 contract `SP000000000000000000002Q6VF78.pox-5`; Bitcoin block-commits | non-EVM |
| emissions | manual / adapter | SIP-045 (1,000 STX/block), SIP-031 schedule | |
| supply | coingecko | `blockstack` | |

No EVM RPC applies. Every flow needs a Stacks or Bitcoin adapter.

## Orion mapping

- Not suitable for holder_cashflow. If forced: forward_multiple on revenue (tx fees, about $0.2M), which is meaningless at a $0.63B market cap. Model the emission step schedule (coinbase plus SIP-031) as dilution.
- Open questions: whether PoX-5 reserve-fund inflows or sBTC-related protocol revenue will ever be routed to STX via a burn or buyback. SIP-031 mentions future "protocol revenue to support the Endowment", not holders.

## Sources

- https://docs.stacks.co/llms-full.txt: PoX description, PoX-5 waterfall, no burn, 1,000 STX coinbase history (SIP-029, SIP-045), Endowment-administered bootstrap (accessed 2026-09-22)
- https://raw.githubusercontent.com/stacksgov/sips/main/sips/sip-031/sip-031.md: five-year growth emissions, 3.52% to 5.75% average (accessed 2026-09-22)
- https://raw.githubusercontent.com/DefiLlama/dimension-adapters/master/fees/stacks.ts and https://api.llama.fi/summary/fees/stacks?dataType=dailyFees: fees, revenue 0 methodology (accessed 2026-09-22)
- https://api.coingecko.com/api/v3/coins/blockstack: supply and market data (accessed 2026-09-22)
