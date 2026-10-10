# Holder yield, growth and protocol revenue (report-only) — design

Date: 2026-10-10. Status: built on `feat/holder-yield`, not merged.

## Mike's calls (2026-10-10)
- Log holder flows in three buckets, so any later metric can sum any subset: **burns** (purest, no haircut), **holds**
  (bought back and kept, an overhang haircut "in the same way slippage has an adjustment"), **cash** (stablecoins and
  liquid tokens, less a slippage haircut). Report tradfi-style yields on top.
- **Report only.** Nothing here is a driver, enters the grade, or reaches a signal. Haircuts in the valuation would
  move every target and force a recalibration of all seven assets.
- **HYPE stays a burn** in the reporting too, to keep it in sync with the valuation (economically the fund holds).
- **Haircuts sized from pool depth**, fixed per token, reviewed by hand; not live quotes.
- **Protocol revenue = the cut the protocol keeps**, not the emissions it passes through; the gross is logged
  separately as volume.
- **Daily totals only.** No raw transfer logs (DB size).
- **No new general DefiLlama dependencies** for new data. Llama Airforce stays for CRV bribes. VVV's revenue is its
  disclosures plus DefiLlama's daily series as a labelled proxy ("fine for now").

## What was built
1. **Schema.** `monitor_only` now also allowed on flow metrics (still refused on anything the valuation reads). A
   `reporting` block per asset: `window_days`, `haircuts` (one per holder flow; a burn's must be 0), optional
   `revenue` / `volume` (flow metrics summed), `revenue_disclosed` (a level), `extra_cash` (a cash run rate the
   valuation keeps outside holder_flows: CRV's vote incentives). Optional with no default: an asset without it keeps
   its hash. Every asset gets one, so every asset hash moved (re-pinned).
2. **Ingest.** A monitor-only flow raises no `unlisted_sender` anomaly, and a source feeding only monitor-only metrics
   raises no failure streak: report data never wakes the agent or degrades a signal. The grade never read fetch
   outcomes, so a failing report source cannot move a signal either way.
3. **Adapters as flow primaries** that return a daily series (written like the DefiLlama API flow: cursor, revision
   days, a missing day never a zero). First user: `hype.fund_buys_daily`, the Assistance Fund's own buy fills on the
   HYPE/USDC spot pair (`@107`) from Hyperliquid's `userFillsByTime`. **The info API keeps about 10 days of fills**
   (tested 2026-10-10: fills at 1–10 days back, none at 14+), so this series grows forward from go-live; DefiLlama's
   series still feeds the valuation and the report until the direct one has 180 days.
4. **`orion report yield [asset] [--day] [--json]`**, computed on demand from stored daily totals and the levels in
   force; nothing new is stored, any past day can be recomputed. Per flow: gross, haircut, net, yield on price (per
   token of the flow's recipient base), 90d/90d growth. Per bucket: the same. Yields: cash, buyback (burn + hold),
   shareholder, dilution (emissions / effective supply), net shareholder, multiple (1 / shareholder), trailing PEG
   (multiple / growth in percent; n/m when growth <= 0). Protocol revenue and volume with their growth. VVV's
   disclosed revenue growth between disclosures.

Growth = (current window / prior window) ^ (365 / window) − 1, null until both windows are complete, n/m when either is
zero. A first value needs 2 × window days of daily rows: the backfill is ~362 days (CoinGecko keyless limit 365).

## Protocol revenue routes (Ethereum, measured 91 days to 2026-10-10)
- **Curve:** every fee in crvUSD from the Hooker into the FeeAllocator (90% veCRV / 10% treasury). 1.42M crvUSD.
- **Convex:** Booster getters (of 10000) lockIncentive 1000 → cvxCRV BaseRewardPool, stakerIncentive 450 → cvxRewardPool,
  platformFee 200 → treasury; earmarkIncentive 50 to callers (not revenue). Measured outflows match to 4 decimals.
  Gross: VoterProxy → Booster CRV (16.36M). The crvUSD Curve fees pass through 100% to cvxCRV stakers (not revenue).
- **StakeDAO:** Accountant `getProtocolFeePercent` 16.5% of strategy CRV → FeeReceiver (split ~evenly veSDT / treasury
  / sdCRV accumulator), plus StakingV2FeeRecipient; plus 15% of the crvUSD fees the accumulator keeps (10% liquidity,
  5% treasury). Gross: locker → Accountant CRV (5.39M).
- **Yearn (yCRV):** the treasury vault `0x044f…` (SimpleTreasuryVault) takes 20% of the splitter's vault shares and the
  Receiver's 10%: about 28% of what the splitter mints (129K of 459K yvcrvUSD). Gross: crvUSD into the splitter from
  the voter and the FeeBurner (vote incentives auctioned to crvUSD).
- **HYPE:** DefiLlama `dailyRevenue`, labelled proxy (a direct read of Hyperliquid fees is a later step).
- **VVV:** disclosures (`revenue_run_rate_usd`) plus DefiLlama `dailyRevenue` as the proxy.
- **AERO:** none until the post-migration rebuild (reminder 2026-11-05).

## Haircuts (pool depth, 2026-10-10)
| Asset | Flow | Haircut | Basis |
|---|---|---|---|
| CRV | fees (crvUSD) | 0 | stable |
| CRV | vote incentives | 3% | long-tail basket |
| yCRV | fees (yvcrvUSD) | 0 | redeemable 1:1 |
| cvxCRV | fees (crvUSD) / CRV / CVX | 0 / 1% / 0.5% | TriCRV: a day's CRV (~$5K) 0.6%, a week's 4.4%; CVX/ETH deep |
| sdCRV | fees / CRV / bribes (sdCRV) | 0 / 0.5% / 5% | sdCRV/CRV pool $1.5M: a day 1.3%, a week 9%, plus 0.5% on the CRV |
| AERO | fees (pool tokens) | 2% | long-tail tokens |
| VVV, HYPE | burn | 0 | — |

## Not built (next)
- Own price and pool-depth reads replacing the `coins.llama.fi` cross-checks; and live depth feeding the haircuts.
- HYPE protocol revenue read directly from Hyperliquid.
- AERO revenue and haircut review at the rebuild.
- Moving the HYPE valuation off DefiLlama once `af_buys_direct` has 180 days and matches.
