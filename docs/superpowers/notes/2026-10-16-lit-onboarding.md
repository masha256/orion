# LIT (Lighter) onboarding notes, 2026-10-16

Decisions (Mike, 2026-10-16):

1. Holder flow from Lighter's own data: the treasury account's (L2 account 0) daily buys on the LIT/USDC spot market
   (2049), read from `mainnet.zklighter.elliot.ai/api/v1/trades`. Not DefiLlama.
2. `capture_rule: discretionary`: the burn policy dates from June 2026, the team runs each burn (Safe `0x3dd7…`, 2 of 3),
   and the burned LIT is drawn from the ecosystem reserve, not the bought LIT.
3. Supply: the standard Orion definitions (2026-10-12). `total_supply` = 1B less dead (981.91M) drives valuation and FDV;
   `circulating_supply` from CoinGecko (250M) is the report's market cap only. Team and investor unlocks are report-only
   dilution (`unlocks_next_year`, from DefiLlama's emissions dataset: no vesting contract on chain), never an emission.
4. Window 91 days; no DefiLlama stitch for older history.

## Mechanics (read on chain 2026-10-16)

- Buys: account 0 bids every day (no sells seen). The bought LIT is withdrawn to `0x1a51…160d`, which funds the staking
  rewards (via `0xADbE…` and others).
- Burns: 2026-07-10 15.64M LIT (everything bought to Q2), 2026-10-09 2.45M (Q3), from the reserve `0xe554…` via the Safe to
  dead. `flow_tokens.burn` tracks them (report only); the buys are the flow, counted once.

## Verification

- Lighter's buys match DefiLlama's `dailyHoldersRevenue` per month: June +0.00%, July -0.24%, August -0.00%, September
  -0.00% (the cross-check, 5 percent tolerance).
- Price cross-check against Lighter's own last trade; total supply 1.84 percent under CoinGecko's 1B (unnetted burns), so
  the tolerance is 2.5 percent.
- Scratch fetch (`--backfill-days 150`): every source ok, no anomalies, no 429s at 400 ms spacing, 666 trade pages.

## Code

- `lit.treasury_buys_daily`: pages the trades newest first until it passes the first day wanted; never stores a partial
  day; a sell by the account is flagged in the detail, never netted.
- The run passes `--backfill-days`, or the asset's `backfill_days` on an adapter flow's first fetch (no cursor), to the
  adapter as `ctx.backfillDays`, so a paging adapter reads its history once and then only its own 7-day window.
- `lit.unlocks_next_year`: cumulative `unlocked` 365 days out less today, for the named allocations.

## Follow-ups

- The trades API held all 150 days asked for (the explorer API's ~60k offset cap had suggested ~150 was the limit), so the
  history may reach back to the start of the buybacks: a longer backfill would give the 182 days the growth figures need.
- What `0xcd53…` (3M of the bought LIT, spread over hundreds of wallets) is.
- Whether LIT on Robinhood Chain is bridged supply or separate.
