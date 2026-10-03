# Top-50 token revenue models: candidates for Orion

Researched 2026-09-22. Snapshot prices and ranks from CoinGecko on that day; every figure in the per-token notes carries its own date and source.

## Universe and method

The universe is the top 50 tokens by market cap after excluding three groups: layer-1 gas tokens (BTC, ETH, SOL, BNB, XRP, TRX, ZEC, DOGE, XMR, ADA, XLM, BCH, NEAR, AVAX, LTC, CC, HBAR, SUI, TON, DOT, ICP, ETC, TAO, M, FIL, INJ, APT, ATOM, ALGO, PI, KAS and the like), stablecoins, and tokenized real-world assets or funds (USDT, USDC, USDS, USDe, DAI, USD1, USDG, PYUSD, XAUT, USYC, RLUSD, BUIDL, USDY, PAXG, FIGR_HELOC, BCAP, and the like). VVV is excluded because Orion already covers it. HYPE and CRO are kept although each has its own chain: their revenue is an exchange's, which is what Orion values.

Each token was researched against the same brief: what generates revenue, who keeps it, which revenue-funded flow reaches holders and under what rule, how observable that flow is with Orion's existing source types, and what the supply schedule looks like. The vocabulary is Orion's (`docs/superpowers/specs/2026-09-18-orion-valuation-framework-design.md` section 3):

- Holder flow `kind`: `burn`, `buy_and_hold`, `fee_share`.
- `capture_rule`: `contractual`, `programmatic` (an on-chain parameter governance can change), `discretionary` (a company or foundation decides each time).
- `recipient_base`: `all`, `staked`, `locked`.
- Emission-funded staking yield is never a holder flow.

Fit grades:

- **A**: revenue-funded holder flow exists, is measurable on-chain or on DefiLlama, and revenue is published. Config-only or near config-only in Orion.
- **B**: real revenue and a holder flow exist but something is hard: off-chain data, discretionary capture, a non-EVM chain needing an adapter, or an equity layer that keeps most of the value.
- **C**: revenue exists but nothing reaches holders today, or the flow is inflation-funded. A valuation would rest entirely on an assumed future capture.
- **D**: no revenue model. Not suitable.

Per-token notes: `docs/research/tokens/<symbol>.md`.

## Headline

Seven of the fifty have a measurable, revenue-funded holder flow that Orion could value with config only (fit A). Seventeen more have a real flow with one obstacle each (fit B). Fifteen have revenue but nothing reaching holders today (fit C), and eleven have no revenue model (fit D). Two design questions came up in nearly every group and are worth settling before any of these is onboarded: how to treat buybacks that are held rather than burned, and which revenue window to underwrite when the trailing year and the trailing month disagree by 3x or more.

## Ranking

Sorted by fit, then by the size of the trailing holder flow. Ranks are within the filtered universe. Flow and revenue figures are trailing-year USD unless marked; "30d ann." is the last 30 days annualized. Details and sources in each token's note.

| Rank | Token | Fit | Holder flow: kind, rule, base | Holder flow $/yr | Revenue $/yr | Capture | Data path | Note |
|---|---|---|---|---|---|---|---|---|
| 1 | HYPE | A | burn, programmatic, all | 692M | 692M (708M 30d ann.) | ~100% | defillama + http_json (Hyperliquid info API) | Assistance Fund buys ~99% of fees; docs call it a burn, the API still counts it in total supply. Team unlocks (~10M/month, unconfirmed) roughly match the buyback. Staking yield is pure emissions. |
| 37 | AERO | A | fee_share, programmatic, locked | 94.5M (14.2M 30d) | 94.5M | 100% | defillama + evm (Base) | Gross emissions ~249M AERO/yr exceed the fee share; tail rate 21 bps/week. Already a design contrast case in the framework spec. |
| 35 | CAKE | A | burn, programmatic, all | 56.9M (4.9M 30d) | 86.8M | 66% | defillama + evm (BNB Chain, 0xdead) | Tokenomics 3.0 (2025) turned the veCAKE share into more burn. Monthly burn ranged $1.5M to $17.4M. |
| 6 | UNI | A | burn, programmatic, all | 50.5M since 2025-12-28 (194M 30d ann.) | = flow | 100% | defillama + evm (transfer_flow to 0xdead) | Fee switch on since 2025-12-28, still ramping; 1y understates the run rate. totalSupply() does not fall, so effective supply = 1B minus the 0xdead balance. |
| 41 | CRV | A | fee_share (crvUSD), programmatic, locked | 28.6M ex-bribes (5.9M 30d ann.) | 29.2M | ~100% | defillama + evm (FeeDistributor) | DefiLlama holders revenue includes third-party bribes. Flow down ~80% year on year; gauge emissions (~97M CRV/yr) exceed it. |
| 49 | RAY | A | buy_and_hold, programmatic (12% of fees), all | 18.0M | 23.9M (72M 30d ann., Sept spike) | 75% | defillama; Solana adapter to observe | 87.1M RAY held, not burned. Needs the held-token policy and a Solana adapter. |
| 32 | RENDER | A | burn, programmatic, all | 1.7M | 1.8M | 95% | defillama (Solana) | Burn-and-mint works as designed but emissions (~5.9M RENDER/yr, ~6x the burn) dominate. Revenue flat for 12 months. |
| 2 | WBT | B | burn, discretionary, all | ~200M (174M last quarter ann.) | ~600M implied from the 33%/5% rule | by construction | evm (Ethereum erc20_supply) + manual | Largest exchange-token burn. No published revenue; burns on Tron and Whitechain may add to the Ethereum figure. Circulating supply disputed (119M CoinGecko vs ~214M Kraken). |
| 48 | PONS | B | burn, discretionary, all | ~182M (30d ann.; 7d ann. ~$85M) | ~308M (30d ann.) | ~60% | defillama (Robinhood Chain EVM once an RPC is found) | Memecoin launchpad, two months of history at a fading peak; the 80% buyback is manual, "not immutable yet". |
| 27 | GT | B | burn, discretionary, all | ~94M | ~470M profit implied at 20% (rule undocumented) | by construction | evm (Ethereum burn-address balance) | Quarterly burns; token count per burn steady while price halved. |
| 33 | JST | B | burn, discretionary, all | 82.4M | 12.75M JustLend fees + 4.2M USDD | >100% | adapter (TronGrid) | Burns release an accumulated reserve backlog that ends Q4 2026; model a 2027 step-down to recurring single-digit-million revenue. |
| 21 | SKY | B | fee_share (USDS), programmatic, staked; buy_and_hold, programmatic, all | 63.2M (stakers 14.9M, buyback ~48M) | 207.8M (158M 30d ann.) | 30% | defillama + http_json + evm | "Smart Burn Engine" burns nothing; bought SKY passes through the Pause Proxy. Flow down ~75% from late 2025. |
| 3 | LINK | B | buy_and_hold, discretionary, all | 58.5M (53.5M 30d ann.) | 62.7M on-chain fees; total Chainlink revenue unpublished | ~93% of on-chain fees | defillama + evm (Reserve 0x9A70…9eC6) | Chainlink Labs decides what revenue is routed on-chain; Reserve withdrawal policy unwritten. Staking rewards from the token allocation. |
| 22 | HTX | B | burn, discretionary, all | ~55-75M (Q4 2025 23.3M, Q1 2026 19.2M, Q2 2026 13.6M) | 110-150M implied at "50% of revenue" | by construction | Tron JSON-RPC eth_call + manual | Declining trend; revenue base undefined. |
| 15 | PUMP | B | burn, discretionary, all | 281M (286M 30d ann.) | 455M (640M 30d ann.) | ~45-60% | defillama; Solana adapter | Company sets the share (cut from 100% to 50% on 2026-04-28). ~82.5B/yr insider unlocks. On-chain burns are observed, not modeled. |
| 31 | JUP | B | buy_and_hold, discretionary, all | 44M (42M 30d ann.) | 88M | 50% | defillama + Solana adapter | Litterbox holds 171.7M JUP; one-off 134.5M burn Nov 2025. DefiLlama models the flow as 50% of revenue. ~3B JUP in custody with no schedule. |
| 25 | LIT | B | buy_and_hold, discretionary, all | ~37M (30d ann.) | ~54M (30d ann.) | ~69% | defillama + http_json (Lighter explorer) | 25% float; ~166M/yr team and investor unlock from 2026-12-29. Revenue down ~80% from peak. |
| 17 | ASTER | B | fee_share (bought ASTER to veASTER), discretionary, locked | ~77M est. (not observed) | ~78M fees (30d ann.) | ~99% claimed | defillama fees + evm (BSC dead address) + manual | Buyback wallet inactive on BSC, likely on closed-source Aster Chain. Fees down ~95% from the 2025 peak. Matching reserve burns are supply events, not flows. |
| 5 | LEO | B | burn, discretionary, all | 29.7M | up to ~110M implied at 27% | by construction | adapter (EOS Hyperion) | Non-EVM; implied revenue looks low for Bitfinex; possible one-off hack-recovery burn (unconfirmed). |
| 28 | POL | B | "burn", programmatic, all (held, not destroyed); fee_share, programmatic, staked (PIP-85) | ~10.5M base fee accruing to collectors | 28.3M gas fees | ~37% | evm (archive balance deltas) + manual | 174.7M POL "burned" sits in an upgradeable holder and a Safe; nothing at 0xdead. 2% emission (~214M POL/yr) outweighs the flows. |
| 47 | ZRO | B | buy_and_hold, discretionary, all | 3.4M (2.3M 30d ann.) | Stargate 1.1M (3.8M 30d ann.); messaging fees go to DVNs | >100% of Stargate revenue | defillama + evm (Ethereum OneSig wallet) | Fee switch off; monthly unlocks ~10x the buyback. |
| 50 | DRV | B | buy_and_hold, discretionary (DAO-set 35%), all | ~2.1M est. (DefiLlama shows 0) | 4.0M (6.0M 30d ann.) | 35% by rule | defillama + manual | No buyback address; held DRV can fund incentives; 500M strategic mint. |
| 42 | PYTH | B | buy_and_hold, discretionary (monthly DAO votes), all | ~0.7-1.0M (forum-reported) | 2.3M DAO share (5.2M latest month ann.) | ~35% | adapter (Solana) / manual | Strategic Reserve V2 would make it programmatic at ~100% of DAO revenue. ~2.1B PYTH cliff May 2027. |
| 4 | RAIN | B | burn, discretionary, all | 1.0M | 1.0M (1.5M fees) | ~100% | defillama + evm (Arbitrum erc20_supply) | Prediction-market platform at ~9,400x its holder flow; September activity near zero. |
| 11 | AAVE | C | buy_and_hold, discretionary, all; paused since 2026-04-19 | 0 (21M 1y, all pre-pause) | 97.5M (62M 30d ann.) | 0 today | defillama + evm | Paused after the rsETH exploit; DAO runs an operating deficit; bought AAVE partly recycled into stkAAVE emissions. |
| 13 | ENA | C | none today; fee switch voted 2026-09-08, programmatic, all | 0 | ~237M gross (30d ann.) | 0 | defillama + http_json (USDe supply) | Buyback activates at $7.5B USDe (now $4.9B), 5% take rising to 20% at $20B. The 2025 $310M Foundation buyback was PIPE cash, not revenue. |
| 36 | ETHFI | C | buy_and_hold, discretionary, all; stopped | 0 since 2026-04 (9.9M 1y) | ~44M | 0 today | defillama + evm | Buybacks stopped or moved; cause unknown. |
| 19 | MORPHO | C | none (fee switch off) | 0 | 0 (fees 199.5M) | 0 | defillama | No fee-switch proposal in 2026; no defined route to holders. |
| 23 | ARB | C | none | 0 | ~18M (43M 30d ann., AEP-driven) | 0 | defillama | Everything to the DAO treasury; buyback and staking proposals not adopted. |
| 12 | MNT | C | none (temperature check 2026-09-18) | 0 | 48.9M FY25, mostly treasury investment income; 1.8M sequencer | 0 | manual + defillama | Treasury is 73% MNT. |
| 18 | WLFI | C | burn, discretionary, all (executed once); pending fee_share to staked | ~1.5M 1y, 0 in 90d | 122.7M | ~1% | defillama + evm (totalSupply at past blocks) | Token has no claim on USD1 reserve yield; the approved burn has been dormant ~12 months. Vesting-election burns are not revenue-funded. |
| 44 | VIRTUAL | C | none | 0 | 16.7M (0.65M 30d) | 0 | defillama + evm (Base) | Treasury keeps 30% of the agent-token tax; no VIRTUAL buyback found. |
| 8 | CRO | C | burn, discretionary, all (started 2026-09-17, no data) | 0 trailing | unknown (Cronos fees 0.18M) | n/a | evm (Cronos) + manual | 2025 re-mint of 70B previously burned tokens; new burn tied to Ult app and Cronos Launch revenue. |
| 24 | BGB | C | burn, discretionary, all | ~21.8M | unknown | unknown | evm (Ethereum 0xdead) | Burns no longer tied to revenue or profit (rule changed three times in 2025); Morph release adds 52.8M BGB/yr. |
| 9 | OKB | C | burn, programmatic, all (X Layer gas only) | ~0.07M | unknown (OKX private) | n/a | defillama | Fixed at 21M in Aug 2025; the token no longer has a claim on OKX economics. |
| 30 | KCS | C | burn, discretionary, all (paused Dec 2025); KCS Bonus fee_share (unverified) | 0 current (1.5M 1y) | unknown | n/a | evm (KCC) | Burn appears stopped; bonus source unverifiable. |
| 34 | NEXO | C | buy_and_hold, discretionary, all (none since 2022) | 0 | unknown | 0 | manual | Interest on NEXO comes from company holdings, not a revenue share. |
| 10 | BTW | C | none | 0 | ~1.5M (30d ann.) | 0 | defillama | Bitway Earn vault fees; no token claim; price up ~65x since May 2026. |
| 29 | QNT | C | none | 0 | ~15M (£11.5M FY to Sep 2025, audited) | 0 | manual | Company keeps all revenue; the accounts do not mention the token. |
| 14 | ONDO | D | none | 0 | 0 protocol; company unpublished | 0 | coingecko | DefiLlama's "holders revenue" is USDY product yield, not ONDO. 1.71B unlock 2027-01-17. |
| 20 | WLD | D | none (grants are emissions) | 0 | ~0.2M World Chain gas, not captured | 0 | none | Up to ~1.07B WLD/yr of unlocks; TFH equity is separate. |
| 38 | STX | D | stacking BTC yield: fee_share in form, emissions-funded in substance | 0 by Orion rules | 0.2M tx fees | 0 | adapter (Hiro) | Miner bids for the STX coinbase fund the BTC yield; 3-6%/yr supply growth. |
| 40 | TRUMP | D | none | 0 | insider LP fees, unpublished | 0 | adapter (Solana) | ~718M tokens held by insiders until 2028. |
| 7 | SHIB | D | burn, programmatic, all (Shibarium base fee) | ~0.02M | ~0.001M | n/a | evm (0xdEAD…2069, filtered by sender) | 0.0007% of supply per year; Shibarium gas is paid in BONE. |
| 39 | PENGU | D | none | 0 | company revenue unpublished | 0 | manual | Igloo Inc. keeps toy and licensing revenue. |
| 26 | AKE | D | promised burn and fee_share, none observed | 0 | unknown | 0 | manual | ~130x rally since June 2026; ~2.2B AKE/month unlocking. |
| 45 | PIEVERSE | D | none | 0 | unknown | 0 | manual | No token utility found; 27.5% float. |
| 16 | PEPE | D | none | 0 | 0 | 0 | none | |
| 43 | 币安人生 | D | none | 0 | 0 | 0 | evm (supply only) | four.meme BNB Chain meme; fixed 1B supply. |
| 46 | SPX | D | none | 0 | 0 | 0 | evm (supply only) | |

## Shortlist for integration

**Tier 1, config-only next assets.** Each has an observed flow, a published revenue series, and a rule that is not a company's monthly decision.

1. **UNI.** EVM, burn to 0xdead, DefiLlama revenue, programmatic. The closest analogue to VVV's burn scan. The open question is the base year: $50M since December against a $194M run rate.
2. **HYPE.** The largest flow in the universe and capture near 100%. Not EVM, but the Hyperliquid info API is a plain JSON endpoint, so `http_json` covers supply and the fund balance without an adapter. Needs a decision on whether the Assistance Fund balance is netted from supply.
3. **CAKE.** EVM (BNB Chain), burn to 0xdead, programmatic shares of several fee lines. Needs the post-2025 emission rate, which the docs do not state.
4. **AERO.** EVM (Base), `fee_share` to lockers, and already the framework's `recipient_base = locked` contrast case. Emissions exceed the fee share, so the emission schedule must be in the config.
5. **CRV.** EVM, `fee_share` in crvUSD via the FeeDistributor. Strip bribes from DefiLlama's holders revenue.

**Tier 2, one obstacle each.** Worth onboarding once the obstacle is addressed.

- Solana adapter: PUMP (burn, largest DEX-style flow after HYPE), JUP and RAY (buy-and-hold). A JSON-RPC adapter using `getTokenSupply` and `getTokenAccountsByOwner` was tested working by the research agent.
- Held-token policy: SKY, LINK, JUP, RAY, LIT, DRV, PYTH, ZRO. See the design notes below.
- Exchange tokens with a stated rule: WBT (largest, Ethereum-readable), GT, HTX (Tron), LEO (EOS). Revenue is implied from the burn, so only the holder-flow modules apply; the market-convention revenue multiple would be circular.
- Young or backlog-driven: PONS (two months of history), JST (burns release a reserve backlog that ends Q4 2026).
- Small flow against a large supply schedule: ZRO, PYTH, RENDER, POL. Valuable mainly as tests of the supply forecast.

**Watchlist, catalyst-driven.** Nothing reaches holders today, but a dated trigger exists: ENA (buyback activates at $7.5B USDe), AAVE (buyback paused since April 2026), CRO (new burn started 2026-09-17), POL (PIP-85 priority-fee share to stakers), WLFI (fee share to stakers pending), ETHFI (buyback stopped, cause unknown), MORPHO and ARB and MNT (fee-switch and buyback discussions only).

**Not suitable.** The eleven fit-D tokens: memes and brand coins (PEPE, SHIB, SPX, 币安人生, PENGU, TRUMP), tokens whose revenue belongs entirely to a company or whose yield is inflation (ONDO, WLD, STX), and low-float listings with no observed flow (AKE, PIEVERSE).

Just outside the universe and worth a later pass: PENDLE, LDO, JTO, SYRUP, ENS, GNO, OHM, COMP, TWT.

## Findings that bear on Orion's design

1. **Buy-and-hold is the common case, not burn.** Of the 24 tokens with a flow, ten put bought tokens into a treasury or reserve (LINK, SKY, JUP, RAY, LIT, DRV, PYTH, ZRO, ETHFI, AAVE) and several of those recycle them into incentives (AAVE into stkAAVE, SKY via the Pause Proxy, DRV). The framework has the `buy_and_hold` kind but no rule for whether held tokens net from effective supply, and no haircut. A proposal: never net them from supply, value them through `holder_cashflow` at the discretionary premium, and expose a per-flow `retention` assumption (share expected to stay off the market) with bear/base/bull bands.
2. **Labels lie; balances do not.** Polygon's EIP-1559 "burn" has destroyed nothing since November 2023 (the fees sit in an upgradeable holder and a Safe). Sky's "Smart Burn Engine" burns nothing. Hyperliquid's docs call the Assistance Fund a burn while the API counts it in total supply. Supply config should be built from on-chain balances at named addresses, as `vvv.yaml` already does with `subtract_balances`.
3. **DefiLlama holders revenue is often a formula.** JUP is modeled as 50% of revenue, RAY as 12% of fees, ONDO's series is product yield, RAIN's is assumed burns, and JST and DRV show zero despite real flows. Use it as the cross-check it is for VVV, not as the source of truth, and observe the flow on-chain wherever an address exists.
4. **The revenue window is the dominant assumption.** For UNI, AERO, CRV, ASTER, LIT, JUP, ETHFI and SKY the trailing-year and trailing-month figures differ by 3x to 20x, mostly because DEX and launchpad revenue fell sharply after late 2025 while UNI's is ramping. The engine's `revenue_run_rate` needs an explicit window per asset, and the scenario spread should sit on the revenue path rather than on capture, which is near 100% for most fit-A tokens.
5. **Emissions exceed the flow for ve-models and infrastructure tokens.** AERO (~249M/yr), CRV (~97M/yr), RENDER (~6x its burn), POL (2%/yr) and the exchange-token cousin BGB (Morph release) all emit more than they return. Holder cash flow is positive only for lockers, and the supply forecast decides the answer. Step schedules (AERO tail rate, CRV's cut every 13 August) are data, not assumptions, per methodological position 3.
6. **Non-revenue supply events must be filtered.** ASTER's reserve burns, ENA's PIPE-funded 2025 buyback, WLFI's vesting-election burns, JUP's one-off 134.5M burn and CRO's 70B re-mint all show up in supply deltas without being holder flows. The sender allowlist that VVV's burn scan uses is the right tool; every burn-based asset needs one.
7. **Exchange tokens are VVV-shaped, only more so.** A company keeps all revenue, publishes none, and burns under a stated rule at its own discretion. Capture is then the stated share by construction, and the implied revenue cannot be checked. Value them on the holder-flow modules only; treat the "27%" or "33%" as the capture assumption itself, with the discretionary premium.
8. **Adapters, in priority order.** Solana JSON-RPC (PUMP, JUP, RAY, RENDER, PYTH), then Tron's `eth_call` endpoint (HTX, JST), then EOS (LEO only). Hyperliquid needs none: `http_json` suffices.
9. **Free Ethereum RPCs cannot serve `transfer_flow` for mainnet.** Every public endpoint the agents tried capped `eth_getLogs` at 10 to 50 blocks or refused ranges outright. Blockscout's keyless REST API and historical `eth_call` worked. Before onboarding UNI, CRV or LINK, Orion needs either a paid archive RPC or a Blockscout-backed source type. Base's public RPC, which VVV uses, is the exception.

## Caveats

- This is a one-day snapshot. Prices, ranks and 30-day figures are from 2026-09-22.
- Four of the six research agents ran out of web-search budget partway through and relied on primary docs, DefiLlama, CoinGecko, governance forums and RPC reads. Claims that rest on memory are marked "unconfirmed" in the token notes; the notable ones are HYPE's monthly unlock sizes, the Chainlink Reserve launch details, the AERO and Velodrome merger status, GT's 20% rule, the KCS bonus, and TRUMP's fee totals.
- Ranks are by CoinGecko market cap within the filtered universe, and CoinGecko's supply figures disagreed with on-chain or exchange figures for WBT, WLFI and HYPE. The notes say which figure they used.
- Nothing here is investment advice. Orion emits signals only.
