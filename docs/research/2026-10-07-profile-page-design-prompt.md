# Profile page design prompt: supply bar, net shareholder yield, trailing-growth PEGY

A prompt for Claude Design, written 2026-10-07 and revised 2026-10-08 from the comparison-site discussion. The
sample numbers are the figures established those days (CoinGecko circulating basis, 7 October prices, holder flows
from the calibration anchors, trailing growth from the daily flow series in orion.db) and are illustrative, not a
data feed. Decisions behind the prompt: CoinGecko circulating supply is the headline number (it matches
CoinMarketCap and the protocols' own APIs for VVV and AERO; HYPE has no agreed figure); net shareholder yield is
holder flow yield minus inflation on the float; growth at launch is data-driven only, from trailing 180, 90 and 30-day
windows of the holder flow series, with operator or AI projections and the cross-asset comparison view deferred.

---

I am designing the profile page for a crypto token valuation site. A profile page shows one protocol and explains how much value reaches its token holders, built only from observed data: no analyst or AI judgement at launch. Today there are three assets (VVV, AERO, HYPE); the set will grow, so each component must work for any protocol, including ones with zero or several holder flows. Please design three components for the single-asset profile page, desktop and mobile, light and dark themes. The illustrative numbers below are real as of early October 2026; treat them as sample data.

## 1. Stacked supply bar

Purpose: reconcile the commonly quoted circulating supply to total supply, naming every tranche in between. The headline numbers must match what visitors see on the major market data sites; the site's contribution is the decomposition, not a new number. The bar shows only tokens that exist: burned tokens and tokens that can never be spent stay out of it, since over the years they would come to dominate the width while saying nothing about today; they get a label instead (see below).

Requirements:
- One horizontal bar, left to right from circulating to total, every tranche labelled with name, token amount and share of total. Tranches mean different things per asset (locked, unvested, reserve, protocol-held), so the legend belongs to the asset.
- A clear marker for "circulating supply" and "total supply". Where a figure differs between the protocol's own data and the market data sites (HYPE, on both markers), nothing changes in the visible bar; the marker's tooltip carries a one-line note with the other number.
- Each tranche is hoverable with a one-line definition and its source.
- Include a state for a tranche whose composition is not fully verified (VVV's Venice-held tokens) that reads as honest rather than broken.
- A "removed from supply" label under the bar's right end, not a segment: lifetime tokens burned or permanently unspendable, their share of all tokens ever minted, and the trailing 90-day pace of removal. The pace is the same figure the yield section uses, so the two components tie together. Omit the label for a protocol that removes nothing.

Sample data:
- VVV: circulating 48.3M; Venice-held non-circulating 32.8M (composition not verified); total 81.1M. Label: 33.9M burned since launch, 29% of all tokens ever minted, about 7M USD a year at the current pace.
- AERO: circulating 1.00B; locked as veAERO 0.99B (locks of up to 4 years; these tokens are the fee recipients); total 1.99B. No removal label.
- HYPE: circulating 222M (tooltip note: the protocol's own API reports 298M); other non-circulating 76M (composition not verified); unvested contributor and foundation tokens 242M; future emissions reserve 411M; total 951M. Label: 48M held by the assistance fund, cannot be spent, about 576M USD a year at the current buyback pace. The total marker's tooltip notes that the market data sites show 955.3M, which nets the fund at an older balance.

## 2. Net shareholder yield breakdown

Purpose: the crypto analogue of total shareholder yield. Gross yield from everything the protocol returns to holders (fees, buybacks, burns) minus dilution from emissions and scheduled unlocks, all as a percent of circulating market cap. The gross and net figures often tell opposite stories.

Requirements:
- A waterfall or diverging bar: positive segments stacked by holder flow type (fee share to lockers, programmatic buybacks, discretionary burns, programmatic burns, and so on; a protocol can have zero or several), negative segments for emissions and for scheduled unlocks, ending at a net figure that is prominent and can be negative.
- A toggle between "passive holder" and "staker or locker" view: the staker view adds the emissions and fees the staker actually receives, so the net improves. Use AERO as the example with both numbers.
- Every flow is measured over a trailing 90-day window, annualised; say so on the component.
- All three assets are negative today; the design must not treat negative as an error state.

Sample data (percent of circulating market cap, per year):
- VVV: discretionary burns +0.5; emissions −4.1; net −3.6.
- AERO: fee share to lockers +7.3; emissions −25.4; net −18.1. Locker view: fees on locked capital +8.8, rebase +2.4, dilution −12.8, net about −1.6.
- HYPE: programmatic buybacks +2.8; emissions −4.5; net −1.7.

## 3. Trailing growth and the PEGY-style multiple

Purpose: put the holder flow multiple in the context of growth, the Peter Lynch PEGY idea: multiple divided by growth plus net shareholder yield, lower is cheaper. At launch growth is data-driven only: the holder flow over the last N days against the N days before it, for N of 180, 90 and 30. These are momentum readings at three horizons, not forecasts and not scenarios; they will not line up in any fixed order.

Requirements:
- A growth strip with the three windows side by side (180d, 90d, 30d), each showing the raw window-over-window percent change, the two window totals it came from, and a small sparkline of the daily series. The 90-day window is the headline because it matches the window every yield and multiple uses.
- The PEGY block shows its inputs and result: holder flow multiple (circulating market cap over annual holder flow), growth (the annualised 90-day figure), net shareholder yield, and the result, with the formula visible or one click away. A secondary control lets the viewer see the result on the 180-day or 30-day growth instead.
- Three states that will be common, each needing a clear non-error treatment: "insufficient history" when a window's prior period has no data (true for 90d and 180d at launch, since the series start in late June 2026); "not meaningful" when growth plus net yield is zero or negative; and "volatile" when a single day accounts for a large share of a window.
- For a protocol whose revenue is disclosed rather than measured daily (VVV), growth is measured on its programmatic usage flow (subscription and credit-purchase burns), not on total burns, and the component should say what series it is reading.
- Make it visually clear that this growth is backward-looking; a later version adds forward projections alongside it (see future additions).

Sample data, 30-day window, raw change over the prior 30 days, as of 6 October 2026:
- VVV (programmatic burns): +16%, last window 0.47M USD against 0.41M. 90d and 180d: insufficient history.
- AERO (fees to lockers): +174%, last window 15.2M USD against 5.5M; flag as volatile. 90d and 180d: insufficient history.
- HYPE (buybacks): −0.3%, last window 56.4M USD against 56.6M. 90d and 180d: insufficient history.

Hypothetical PEGY example for layout only, once 90-day history exists: HYPE multiple 34x, annualised 90-day growth +40%, net yield −1.7%, PEGY about 0.9. Not-meaningful example: AERO multiple 13x, annualised 90-day growth −10%, net yield −18.1%, denominator negative.

## General

- The three components share one visual language and sit on the profile page in this order: supply, yield, growth and multiple. The page also carries a price target section elsewhere; these components explain the inputs to it, so they should feel like a "how the number is built" section.
- Sources are never named in the visible UI. Every figure carries an as-of date and a hover or tooltip state that names its source (a market data aggregator, the protocol's own API, on-chain reads, a fee data provider); the figure itself stays clean. A separate docs page discloses every source in full, so design the tooltip as a short label with a link to that page. Headline supply and market cap figures must still match the major market data sites, so that a visitor cross-checking them finds no discrepancy.
- Avoid red and green as the only encoding for negative and positive; many values are negative and that is normal here.
- Deliver: the profile page section on desktop and mobile, and a short note on component states (loading, unverified tranche, insufficient history, not meaningful, volatile).

## Future additions (not for this design, but leave room)

- A cross-asset comparison view: supply bars normalised to 100 percent of total with absolute amounts alongside; assets sorted by net yield with gross shown faintly so reversals are visible; a dot plot of multiple against growth-plus-yield with iso-PEGY lines.
- Forward growth from operator or AI projections (bear, base, bull scenarios), shown beside the trailing windows with a selector, and a PEGY computed on each.
- Scheduled unlocks as a negative segment in the yield breakdown once unlock schedules are sourced.
