# Official Trump (TRUMP)

Researched 2026-09-22. Rank #40 by market cap (layer-1 tokens, stablecoins and tokenized RWAs excluded). Market cap $0.62B, FDV $2.21B, price $2.21 (CoinGecko, 2026-09-22).
Chain(s): Solana (SPL `6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN`). CoinGecko id: `official-trump`. DefiLlama slug: none.

## Verdict

Orion fit: D. A political meme coin. The insiders who own 80% of supply (CIC Digital LLC, a Trump Organization affiliate, and Fight Fight Fight LLC) collect the trading fees earned by the token's own liquidity positions; nothing is distributed to holders, there is no buyback or burn, and the fee "revenue" is neither published nor a business (it is a toll on speculation in the token itself). Borderline C on the letter of the rubric, but there is no revenue series Orion could source.

- A: revenue-funded holder flow exists, is measurable (on-chain or DefiLlama), and revenue is published. Config-only or near config-only in Orion.
- B: real revenue and a holder flow exist but something is hard: off-chain data, discretionary capture, non-EVM chain needing an adapter, or an equity layer that keeps most value.
- C: revenue exists but nothing reaches holders today (fee switch off, all to validators/treasury), or the flow is inflation-funded; a valuation would rest entirely on an assumed future capture.
- D: no revenue model (store of value, meme, pure inflation staking). Not suitable.

## Business and revenue

gettrumpmemes.com (read 2026-09-22) states: "CIC Digital LLC and Celebration Cards LLC, the owner of Fight Fight Fight LLC, will receive trading revenue derived from trading activities of Trump Meme Cards", and that these two entities own 80% of supply under a three-year unlock. The trading revenue is LP fees from the launch liquidity (Meteora pools on Solana). Press estimates put these fees at roughly $300M+ within the first months of 2025 (Financial Times/Chainalysis-style estimates; from memory, unconfirmed). No official figure is published, no DefiLlama listing exists, and the fees go to the insiders, not to the token. Other activity (a 2025 holder dinner, merchandise, a TRUMP wallet, treasury-company deals by third parties) creates no holder flow (from memory, unconfirmed).

Annualized revenue attributable to the token: $0. Insider LP fee income: unknown, not published.

## Holder flows

none. The website lists no staking, burn, buyback or reward mechanism (gettrumpmemes.com, 2026-09-22).

Capture rate today: 0 / unknown (fees accrue to insiders).

## Supply

Total and max 1,000,000,000 TRUMP; CoinGecko circulating 281,867,936 (28.2%) on 2026-09-22, FDV/mcap 3.5x. Official schedule: 200M on day one (January 17, 2025), growing to 1B over three years, each group with its own three-year vesting (gettrumpmemes.com). Allocation (tokenomist, 2026-09-22): creators and CIC Digital tranches 80% (36/18/18/4/2/2%), public distribution 10%, liquidity 10%; mostly cliffs plus linear releases, ending in early 2028. Tokenomist also states "fully unlocked", which conflicts with its own 71.8% locked figure; on the official three-year schedule a large share of the insider tranches should already be unlocked by September 2026, so CoinGecko's 28.2% circulating likely excludes unlocked but unsold insider tokens (inference, unconfirmed). Either way, up to about 718M TRUMP (about $1.6B at $2.21) sits with insiders and reaches the market through early 2028. No emissions or staking. supply_basis: `effective_total` (1B); circulating understates supply overhang.

## Data availability for Orion

| metric | source type | endpoint / contract / slug | notes |
|---|---|---|---|
| price, mcap, circ | coingecko | `official-trump` | |
| revenue | manual | none published | insider LP fees, Solana (Meteora) |
| holder flow | none | n/a | none exists |
| supply / unlocks | adapter / manual | Solana SPL mint; tokenomist; gettrumpmemes.com | non-EVM, conflicting unlock sources |

Non-EVM (Solana): no EVM RPC path; would need an adapter. There is no flow to read.

## Orion mapping

No modules apply. Not suitable. If ever tracked, the relevant data are the unlock schedule (supply overhang) and price, not cash flows.

## Sources

- https://api.coingecko.com/api/v3/coins/official-trump (supply, contract, description; 2026-09-22)
- https://gettrumpmemes.com/ (ownership, trading-revenue recipients, three-year schedule; 2026-09-22)
- https://tokenomist.ai/official-trump (allocation, unlocked share; 2026-09-22)
