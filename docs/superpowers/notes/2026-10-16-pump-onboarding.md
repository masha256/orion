# PUMP (Pump.fun) onboarding notes, 2026-10-16

Decisions (Mike, 2026-10-16, "Go" on the five recommendations):

1. Bucket: buyback-and-burn, discretionary (the company sets the share: 100 percent of its fee slice from 2025-07-14, 50
   percent from 2026-04-28), 91-day window, total-supply basis.
2. Data: the burn is the daily fall in the mint's supply (one `getTokenSupply` per run), priced at the day's mean
   CoinGecko price. The year of history before the first on-chain reading is DefiLlama's `pump` dailyHoldersRevenue, read
   once (Solana cannot read a past supply; replaying ~9k burns a day for a year is not practical). DefiLlama stays the
   cross-check by eye; once on-chain readings cover a day, the chain value supersedes it.
3. Unlocks: report-only dilution (`unlocks_next_year`, team + existing investors, DefiLlama emissions): 82.5B a year.
4. Solana support, generic: `src/ingest/transport/solana.ts` (JSON-RPC over the HTTP transport, keyed URL scrubbed from
   every error) and adapters `solana.token_supply`, `solana.owner_balance`, `solana.supply_burn_daily`. RAY and JUP are
   config only on top of these. `ORION_SOL_RPC_URL` (Alchemy, same key as Ethereum) in `.env`; the public endpoint is
   the fallback.
5. Persona: `consumer-launchpad-analyst`.

Checked live on 2026-10-16:

- Mint `pumpCm...9Dfn`: Token-2022, 6 decimals, mint authority null (supply can only fall), freeze authority null.
- Burn wallets `99mRw3...F3c` and `9jHrTC...CXM`: each swaps (Jupiter, PumpSwap) and burns from the same wallet; ~1,000
  signatures per 1-2 hours each; a 60-transaction sample was 29 swaps, 26 burns, 5 fee claims. Balances 0 and 3.2k PUMP.
- Supply 832.47B (09-22) to 827.64B (10-16): 4.83B burned, 25.4M USD at the period's mean price, vs DefiLlama holders
  revenue 25.5M USD over 09-22 to 10-15 (0.4 percent apart): no other burns.
- Scratch fetch (`--backfill-days 362`, 4 s): every source ok, 0 anomalies. Price within 0.14 percent of Jupiter's;
  supply within 0.004 percent of CoinGecko's. Run rate 303.0M USD (91 days), FDV 3.60B (11.9x), market cap 2.01B;
  revenue 663.9M (45.6 percent paid to holders); burn yield 8.42 percent, unlock dilution 9.97 percent, net -1.55 percent.

Side changes:

- `validateReading`: a monitor-only level in tokens may read 0 (an empty burn wallet); drivers still may not.
- `SourceContext.observations`: adapters can read the asset's stored observations (the supply-drop adapter's readings).
- `tests/app/cadence.test.ts`: re-pinned the VVV hash for 73464de (staleness 60 -> 90 days), committed without the pin.

Open:

- The first on-chain day is the first full UTC day after go-live; until then the window is all DefiLlama.
- The day's burn is spread linearly between readings ~24 h apart; a missed run spreads two days' drop over both days.
