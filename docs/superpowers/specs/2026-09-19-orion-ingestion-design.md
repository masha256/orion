# Orion Sub-project 2: Ingestion, Anomalies, and the Dilution Fix

Date: 2026-09-19
Status: Draft for review
Parent: `docs/superpowers/specs/2026-09-18-orion-valuation-framework-design.md` (the umbrella spec; binding where this document is silent)
Builds on: sub-project 1 (core and engine), merged to `main` at `12ef356`, engine version 1.1.0

## 1. Purpose and scope

Replace hand-entered VVV observations with fetched ones, so a daily signal updates itself, and know when the data cannot be trusted.

In scope:

1. Declarative data sources in the asset YAML, with named code adapters for unusual metrics.
2. Fetchers for CoinGecko, DefiLlama, generic JSON endpoints, and Base contract reads and event scans.
3. A 90-day on-chain burn backfill, resumable.
4. Cross-checks between sources, and an anomaly lifecycle that feeds the signal.
5. A usage momentum index from on-chain burns, and an advisory alert when disclosed revenue looks stale.
6. `orion update <asset>`: fetch, run, emit. One cron line gives a daily signal.
7. An engine change: `holder_cashflow` accounts for dilution after the horizon (engine 1.2.0).
8. Two items deferred from sub-project 1 that daily operation makes necessary: narrowed snapshot eligibility, and latest-signal ordering.

Out of scope (later sub-projects): the AI agent, personas, proposals, triggers, the run lock, webhooks, per-scenario assumption bounds.

### Decisions made during brainstorming

| Topic | Decision |
|---|---|
| Burn flow source | On-chain transfers to the burn sink from allowlisted senders only. Any other sender is recorded, excluded from the flow, and raises a degrading anomaly. |
| Where asset knowledge lives | A small vocabulary of declarative source types in the asset YAML, plus named code adapters as the escape hatch. |
| Revenue proxy | A revenue level cannot be estimated honestly from burns. Instead: a momentum index (`usage_index`) and an advisory `revenue_disclosure_stale` anomaly. |
| Post-horizon dilution | Per-year supply path. `holder_cashflow` discounts per-token flows. No new assumption. |
| Cross-check values | Never stored as observations. Kept in the fetch log; become an anomaly only when out of tolerance. |
| Backfill depth | 90 days, matching the flow window and CoinGecko's hourly price depth. |

## 2. Verified facts this design rests on

From a research pass on 2026-09-19 that tested each item directly. Re-verify anything marked (unverified) before relying on it.

- Over 120 days, exactly two addresses sent VVV to the zero address: the Aerodrome volatile WETH/VVV pool `0x01784ef301D79e4B2DF3a21ad9a536d4cF09A5Ce` (programmatic; about 285k burns, each under 1 VVV, via one router and one bot EOA), and a Safe `0x35FB3b67C57849bF57eB24B061EeF0b5e560DC57` (discretionary; four burns of 9k to 27k VVV, roughly monthly, each a direct `transfer` to the zero address). There is no size tier between them.
- The address previously recorded as "treasury Safe" (`0x2D8CB8DC…`) is an emissions recipient, not a burner.
- On-chain monthly VVV burned equals Venice's `vvv_burn_history` to four decimal places for 2026-06, 07, and 08. USD figures differ by up to 16 percent because of intraday price moves: valuing the 2026-09-08 buyback at its execution-hour price gives about 391k USD (matching the reported figure) versus 305k at the daily close.
- Burn events rose from about 1,200 per day in June to about 3,900 per day in mid-September.
- Pool burns cluster tightly at 2, 5, and 10 USD. The 5 USD band mixes new Pro+ subscriptions and credit purchases (5 percent of a 100 USD pack); they cannot be separated on-chain.
- Burns fire on new subscriptions only, not renewals.
- `https://mainnet.base.org`: `eth_getLogs` is capped at exactly 2,000 blocks per call (error `-32614`); no rate limiting observed across 2,592 sequential calls; `eth_call` at historical blocks works. Base block time was exactly 2.000 seconds over the window.
- Blockscout's keyless API allows 10 requests and then returns 429 for 20 minutes or more. Not used.
- CoinGecko keyless: about 2 rapid requests, then 429. `market_chart` returns hourly points for `days <= 90` and daily points beyond. `/coins/markets` returns price, market cap, and circulating supply for several ids in one call.
- DefiLlama `summary/fees/venice?dataType=dailyHoldersRevenue`: daily `[unixTs, usd]` pairs in `totalDataChart`, no key, within about 1 percent of Venice's monthly USD for completed months.
- Venice's undocumented API (`https://outerface.venice.ai/api/app/vvv/`) answers plain requests. Field names: `vvv_stats` {`price`, `marketCap`, `circulatingSupplyCryptoBaseUnit`, `totalSupplyCryptoBaseUnit`, `totalStakedCryptoBaseUnit`, `totalLockedCryptoBaseUnit`}; `vvv_staking_yield` {`stakingAprRatio`, `totalEmissionsCryptoBaseUnit`, `stakerDistributionCryptoBaseUnit`}; `vvv_burn_history.burnHistory[]` {`yearMonth`, `burnedCryptoBaseUnit`, `burnedFiatUsd`}; `diem_stats` {`totalSupplyCryptoBaseUnit`, `targetSupplyCryptoBaseUnit`, `mintRateDiemPerStakedVvv`}. `CryptoBaseUnit` values are 18-decimal integers. Venice's `totalSupply` field equals `totalSupply() - balanceOf(0x0)`, the same definition as Orion's `effective_supply`.
- DIEM supply is about 37,760 tokens (18 decimals) at about 1,950 USD. (A research note that called this price implausible misread base units as whole tokens.)
- (unverified) The integer units of `veniceEmissionsPercentage()` and `veniceEmissionsPercentageWhenLocked()` (percent, or basis points), and the scale of the `diemSupply(i)` / `diemMintRates(i)` tables. The plan reads these live before the adapters are written.

## 3. Components

| Unit | Responsibility | Depends on |
|---|---|---|
| `src/ingest/transport/http.ts` | JSON GET with timeout, retry with backoff, per-host minimum spacing, `Retry-After` handling. Injected. | nothing |
| `src/ingest/transport/rpc.ts` | viem public client over a configurable URL. `readContract`, `multicall`, `getBlock`, and `getLogsChunked` (2,000-block chunks). Injected. | viem |
| `src/ingest/sources/*.ts` | One handler per source type (section 4). Validates its params with zod. Returns raw readings with the source's own timestamps. | transport |
| `src/ingest/adapters/vvv.ts` | Named adapter functions (section 4.2). | transport |
| `src/ingest/plan.ts` | Asset YAML to fetch plan: per metric a primary source and cross-checks; batches by source. | config |
| `src/ingest/crosscheck.ts` | Compares primary and cross-check readings against `tolerance_pct`. Pure. | nothing |
| `src/ingest/run.ts` | `fetchAsset(db, loaded, now, opts)`: executes the plan with per-source isolation, writes observations, records `fetch_runs`, raises anomalies. | all of the above, db |
| `src/db/anomalies.ts`, `src/db/fetchRuns.ts`, `src/db/fetchCursors.ts` | New tables (migration 2). | db |
| `src/app/update.ts` | `updateAsset`: fetch, then `runValuation`, then return the signal. | ingest, app |
| `src/cli/commands/data.ts`, `update.ts` | Command surface (section 9). | app |

### Invariants (additions to the umbrella spec)

1. **Fetchers write only what a source returned, with the source's own timestamp.** Block time for chain reads; fetch time for API levels. No interpolation, no gap filling.
2. **All observation writes go through `insertObservation`.** ISO normalization, supersede rules, and the ordering contract stay in one place.
3. **Sources fail independently.** One source's failure never prevents another's observations from landing.
4. **Cross-check readings are never observations.** They live in `fetch_runs.detail` and, when out of tolerance, in `anomalies`.
5. **An undocumented API is never the primary source of a required driver.**
6. **Flows are written for completed UTC days only.**

## 4. Sources

### 4.1 Declarative source types

Each metric in the asset YAML may carry `source:` (primary) and `cross_checks:` (a list). A metric with no `source` stays manual. Contract names refer to keys in the asset's `contracts` map.

| Type | Params | Produces |
|---|---|---|
| `coingecko` | `id`, `field` (`price`, `market_cap`, `circulating_supply`) | Level. All `coingecko` metrics for an asset are served by one `/coins/markets` call. |
| `http_json` | `url`, `path` (dot path into the JSON), `scale` (default 1), `decimals` (default 0; divides by 10^decimals) | Level at fetch time. Requests to the same URL within one run are made once. |
| `defillama` | `slug`, `data_type`, `compare` (`monthly_sum`) | A daily USD series. Cross-check use only in this sub-project. |
| `erc20_supply` | `token`, `subtract_balances` (contract names) | Level: `totalSupply()` minus listed balances, divided by the token's decimals. |
| `contract_read` | `contract`, `function`, `abi_type` (default `uint256`), `decimals`, `scale`, `offset` | Level: `offset + scale * raw / 10^decimals`. |
| `transfer_flow` | `token`, `to`, `from_allowlist` (contract names), `count_from` (optional subset of the allowlist to sum; default all of it), `unit` (`usd` or `tokens`), `price_coingecko_id` | Daily flow rows (section 5). Metrics sharing the same token, sink, and allowlist share one log scan. |
| `adapter` | `name`, plus adapter-specific params | Whatever the named adapter returns. |
| `derived` | `name`, plus params | Computed from stored observations after the fetch phase (section 7). |

All `erc20_supply`, `contract_read`, and adapter level reads in one run are made at the same block (the latest block at plan start), and are stamped with that block's timestamp.

### 4.2 Adapters (VVV)

- `vvv.staker_emission_share`: reads `veniceEmissionsPercentage()`, `veniceEmissionsPercentageWhenLocked()`, staking `totalSupply()`, and `totalLockedStakedVVV()`. Share to stakers = `1 - [p_unlocked * (staked - locked) + p_locked * locked] / staked`, with `p` as fractions.
- `vvv.diem_target_supply`: reads the 256-entry `diemSupply(i)` / `diemMintRates(i)` tables by multicall and returns the supply at which the mint rate equals `mint_base_rate * e^mint_curve_k` (665.015 for the VVV parameters), interpolating linearly between the two bracketing buckets.

- `vvv.staker_share_from_api` (cross-check only): `stakerDistributionCryptoBaseUnit / totalEmissionsCryptoBaseUnit` from `vvv_staking_yield`. It is an adapter because `http_json` reads one field, not a ratio of two.
- `vvv.burn_history_tokens` (cross-check only): turns `vvv_burn_history.burnHistory[]` into a monthly token series for the `monthly_sum` comparison.

An adapter is a function `(ctx, params) -> RawReading[]`, registered by name, exactly as custom valuation modules are.

### 4.3 VVV source map

| Metric | Primary | Cross-check (tolerance) |
|---|---|---|
| `price_usd` | `coingecko` venice-token `price` | `http_json` `vvv_stats.price` (2%) |
| `diem_price_usd` | `coingecko` diem `price` | none |
| `circulating_supply` | `coingecko` venice-token `circulating_supply` | `http_json` `vvv_stats.circulatingSupplyCryptoBaseUnit` (2%) |
| `effective_supply` | `erc20_supply` token minus `burn_sink` balance | `http_json` `vvv_stats.totalSupplyCryptoBaseUnit` (0.1%) |
| `staked_supply` | `contract_read` staking `totalSupply()` | `http_json` `vvv_stats.totalStakedCryptoBaseUnit` (0.1%) |
| `locked_supply` | `contract_read` staking `totalLockedStakedVVV()` | `http_json` `vvv_stats.totalLockedCryptoBaseUnit` (0.1%) |
| `emission_rate_annual` | `contract_read` staking `emissionRatePerSecond()`, scale 31,536,000 | `http_json` `vvv_staking_yield.totalEmissionsCryptoBaseUnit`, scale 365 (1%) |
| `staker_emission_share` | `adapter` `vvv.staker_emission_share` | `adapter` `vvv.staker_share_from_api` (1%) |
| `flow_usd.burn` | `transfer_flow`, allowlist `[aerodrome_pool, buyback_safe]`, unit `usd` | `defillama` venice `dailyHoldersRevenue`, completed months (5%) |
| `flow_tokens.burn` (new, informational) | same scan, unit `tokens` | `adapter` `vvv.burn_history_tokens`, completed months (0.1%) |
| `flow_usd.burn_programmatic` (new, informational) | same scan, unit `usd`, `count_from: [aerodrome_pool]` | none |
| `diem_supply` | `contract_read` diem `totalSupply()` | `http_json` `diem_stats.totalSupplyCryptoBaseUnit` (0.1%) |
| `diem_target_supply` | `adapter` `vvv.diem_target_supply` | `http_json` `diem_stats.targetSupplyCryptoBaseUnit` (5%; this field is known to lag) |
| `diem_locked_yield_share` | `contract_read` staking `veniceEmissionsPercentageWhenLocked()`, `offset 1`, negative `scale` per verified units | none |
| `usage_index` (new) | `derived` `burn_momentum` (section 7) | none |
| `revenue_run_rate_usd` | manual or provisional, unchanged | advisory staleness alert (section 7) |

Announced future emission cuts stay manual (they exist only on Venice's blog). Once the announced date passes, the daily on-chain read is the newest schedule row and governs; if a cut is delayed, the signal follows the chain.

`assets/vvv.yaml` `contracts` gains `aerodrome_pool` and `buyback_safe`. The `treasury` entry keeps its address; its comment changes to "emissions recipient".

## 5. Flow ingestion (`transfer_flow`)

1. **Scan.** From the cursor (or `now - backfill_days` on first run) to the latest block, in 2,000-block chunks, filter `Transfer(from, to=sink)` on the token.
2. **Classify.** A transfer whose `from` is on the allowlist counts. Any other sender is collected as an unlisted transfer: excluded from the flow, reported with its transaction hash, amount, and sender.
3. **Value.** `unit: usd`: each transfer is valued at the newest price point at or before its block time, from one CoinGecko `market_chart?days=90` call (hourly points). Transfers older than the hourly series use the newest daily point at or before them, from a second `market_chart` call made only during a backfill deeper than 90 days. Prices are never interpolated. If no price point exists at or before a transfer, the scan fails for that day rather than valuing it. `unit: tokens`: the token amount.
4. **Bucket.** Sum per UTC day. A day is complete when the scan has covered every block up to the first block at or after the next UTC midnight.
5. **Write.** One observation per completed day: `observed_at` = the following UTC midnight, `period_days: 1`, `source: onchain`, `source_detail` = counts and token totals per sender. A day with no burns is written as `0` (a real reading, not invented data: the scan covered it).
6. **Commit.** A day's rows for every metric sharing the scan, and the cursor advance to that day's last block, commit in one transaction. An interrupted backfill resumes from the last committed day.

Re-running over an already written day writes rows with the same `observed_at`, which supersede the earlier ones. The scan is idempotent.

### 5.1 Adopting fetched flows over manual rows

Fetched daily rows overlap hand-entered monthly rows, and overlapping flow periods block a run. Therefore:

- Before writing, `transfer_flow` checks each metric for active rows from a different `source` whose period overlaps a row it is about to write.
- Without `--adopt`: nothing is written for that metric; the fetch outcome lists each conflicting row and states that `--adopt` would reject them.
- With `--adopt`: the conflicting rows are rejected and the fetched rows written in the same transaction; the outcome lists what was retired. `--adopt` only ever rejects rows whose `source` is `manual`.

## 6. Cross-checks and anomalies

### 6.1 Comparison

For a level metric: `abs(primary - check) / abs(primary) * 100 > tolerance_pct` is a mismatch. For a monthly-sum comparison, only calendar months fully covered by both series are compared, each month on its own.

### 6.2 Anomaly kinds

| Kind | Raised when | Severity |
|---|---|---|
| `cross_check_mismatch` | A cross-check is out of tolerance | `degrading` if the metric is `critical`, else `advisory` |
| `unlisted_sender` | A transfer to the sink came from a sender not on the allowlist | `degrading` |
| `source_failure_streak` | The same source failed in 3 consecutive fetch runs | `advisory` |
| `revenue_disclosure_stale` | Section 7 | `advisory` |

### 6.3 Lifecycle

`open` to `resolved` (with a note) or `acknowledged` (with a note). An acknowledged anomaly no longer affects the signal. A repeat of an open anomaly with the same `(asset, kind, metric, dedupe_key)` increments `occurrences` and updates `last_seen_at` and `detail` rather than inserting a row. `dedupe_key` is the cross-check source id, the sender address, or the source id, by kind. A resolved or acknowledged anomaly that recurs opens a new row.

### 6.4 Effect on the signal

- `data_quality.open_anomalies` is the count of open anomalies for the asset.
- `data_quality.anomalies` (new, additive) lists `{ id, kind, metric, severity }` for each.
- An open `degrading` anomaly on a critical metric sets grade `D`, and the signal is `degraded` with reason `open_anomaly:<kind>:<metric>`. This extends the umbrella spec's section 9 rule unchanged.
- Advisory anomalies appear in the list and do not change grade or status.
- Schema version stays 1: fields are added, none changed.

Open anomalies are read at run time and are not part of the snapshot. Replay reproduces engine output, which anomalies do not enter.

## 7. Usage momentum and the stale-revenue alert

- `usage_index` (the umbrella spec's optional, informational driver) for VVV is `derived` `burn_momentum` with params `{ metric: flow_usd.burn_programmatic, days: 30 }`: the mean USD per day over the last 30 completed days of programmatic burns (new paid subscriptions and credit purchases). It is written as a level observation stamped at the newest day's period end, and only when all 30 days are present.
- It is not a revenue estimate and never feeds a valuation module.
- `revenue_disclosure_stale`: let `t0` be the `observed_at` of the revenue observation in force, `u0` the `usage_index` value nearest `t0` (within 7 days), and `u1` the latest. If `abs(u1 / u0 - 1) * 100 > revenue_stale_move_pct` (asset YAML `review_triggers`, default 30), raise the advisory anomaly with both values and dates. If no `usage_index` exists within 7 days of `t0` (for example the disclosure predates the backfill), the check uses the earliest available index value and says so in the detail.

## 8. Engine change: post-horizon dilution (engine 1.2.0)

`holder_cashflow` today divides aggregate present value by supply at the horizon. It changes to discount per-token flows.

```
supply path after the horizon, yearly steps from S(H):
  y_b   = sum of burn-kind flows at H (annualized USD) / (priceAtHorizon * S(H))     burn yield, held constant
          (on the circulating basis, buy_and_hold flows count too)
  E     = last known emission schedule step, held flat
  S(n+1) = S(n) * (1 - y_b) + E [+ scheduled unlocks falling in that year, circulating basis only]
  S(H + tau) for fractional tau: linear interpolation between yearly steps

per flow k, discount rate r_k, N explicit years:
  f_k(t)   = F_k(H + t - 0.5) / S(H + t - 0.5)
  delta    = E / S(H + N) - y_b                                   terminal net dilution (may be negative)
  g_pt     = (1 + g) / (1 + delta) - 1                            terminal per-token growth
  value_k  = sum_{t=1..N} f_k(t) / (1 + r_k)^t  +  [ f_k(N) * (1 + g_pt) / (r_k - g_pt) ] / (1 + r_k)^N
value = sum over k
```

- `r_k <= g_pt` raises `EngineError`; the signal is `blocked` with `engine_error:`.
- `1 + delta <= 0` or `y_b >= 1` raises `EngineError`.
- When `priceAtHorizon` is not positive (a fixed-point iterate clamped at zero), `y_b` is 0 for that iteration.
- The constant burn yield is the one simplification: past the horizon, price is assumed to move with holder flows.
- `forward_multiple` and `utility_claim` are unchanged.
- The supply path is computed by the engine and passed to modules as `ctx.supplyAfterHorizon(tau)`, a pure function. `run.ts` builds it from the same `forecastSupply` inputs.
- Breakdown gains `burn_yield_at_horizon`, `net_dilution_terminal`, `per_token_growth_terminal`, and `supply_path` (yearly values).
- With zero emissions and no burn-kind flows the result equals the 1.1.0 value exactly.
- `ENGINE_VERSION` becomes `1.2.0`. The golden hash is updated. Stored 1.1.0 runs correctly refuse replay.

## 9. Command surface and configuration

```
orion data fetch [asset] [--metric key ...] [--backfill-days n] [--adopt] [--dry-run]
orion data sources <asset>
orion data anomalies [asset] [--all]
orion data resolve <id> --note text
orion data ack <id> --note text
orion update <asset> [--out file]
```

- `data fetch` with no asset fetches every asset that has at least one `source`. `--dry-run` executes reads and cross-checks and prints what would be written; it writes nothing, including cursors and anomalies.
- `data sources` shows, per metric: source type and key params, cross-checks, last fetch outcome, and the age of the value in force.
- `update`: `fetchAsset`, then `runValuation`, then emit the signal as one JSON line (and append to `--out`). It runs the valuation even when some sources failed. Exit code `0` for `ok` or `degraded`, `2` for `blocked`, `1` for an error.
- Every command accepts `--json`.

Configuration: `ORION_BASE_RPC_URL` (default `https://mainnet.base.org`), `COINGECKO_API_KEY` (optional; sent as the demo-key header when set). Read from the environment, and from `<ORION_HOME>/.env` when present. `.env` is already git-ignored. The asset YAML gains `ingest: { chain_id: 8453, rpc_url_env: ORION_BASE_RPC_URL, backfill_days: 90 }`.

## 10. Data model (migration 2)

| Table | Columns |
|---|---|
| `fetch_runs` | id, asset_id, started_at, ended_at, outcome (`ok`, `partial`, `failed`), detail JSON (per source: outcome, error, metrics written, cross-check readings, unlisted transfers, conflicts) |
| `fetch_cursors` | asset_id, scan_key (token + sink + allowlist hash), last_block, last_day, updated_at; primary key (asset_id, scan_key) |
| `anomalies` | id, asset_id, kind, metric_key, dedupe_key, severity, status, detail JSON, occurrences, first_seen_at, last_seen_at, note, decided_at |

`anomalies` and `fetch_cursors` are operational state and are updated in place. Observations remain append-only.

### 10.1 Snapshot eligibility (deferred from sub-project 1)

A snapshot currently freezes every active eligible observation, which grows without bound under daily fetching. It narrows to what drivers can use: per `level` metric the newest observation at or before `as_of`; per `flow` metric every observation whose period intersects `[newest period end - window_days - 1 day, as_of]`; per `schedule` metric the step in force and all later steps; per `event` metric all events after `as_of`. The existing provisional and confirmed-over-provisional rules apply first. Overlap detection consequently considers only flow rows in that range, which also removes the sub-project 1 follow-up where a long-past overlap blocked runs forever. Replay is unaffected: it loads by stored id.

### 10.2 Latest-signal ordering (deferred from sub-project 1)

"Latest signal" becomes the greatest `generated_at`, then greatest id, so a backfilled `--as-of` run never becomes the signal that `emit` sends or that the next run compares against.

## 11. Failure handling

- HTTP: 3 attempts, exponential backoff from 1 second, on timeout, 429, and 5xx. `Retry-After` honored up to 60 seconds; beyond that the source fails for this run.
- RPC: a failed chunk is retried 3 times; then the scan stops, keeping the days already committed.
- A source failure is recorded in `fetch_runs.detail`; the run outcome is `partial`. The last good observation stays in force until it goes stale.
- A reading that is not a finite number, or a supply or price that is not positive, is a source failure, never an observation.
- `fetchAsset` never throws for a source failure. It throws only for configuration errors (unknown source type, unknown contract name, missing RPC URL when a chain source is configured).

## 12. Testing

No network in CI. Transports are injected; fixtures are the real response shapes captured by the research pass, stored under `tests/fixtures/ingest/`.

- Transport: retry, backoff, `Retry-After`, per-host spacing, with a fake clock and fake fetch.
- Each source handler against a fake transport, including malformed and non-finite responses.
- `transfer_flow` against synthetic logs: allowlist and unlisted senders, UTC day boundaries, hourly pricing with daily fallback, completed-days-only, zero-burn days, cursor resume after an interrupted backfill, idempotent re-run, multiple metrics sharing one scan.
- Adoption: manual monthly rows plus fetched daily rows; refused without `--adopt`; with it, the run is `ok` and only `manual` rows were rejected.
- Cross-checks: tolerance edges, monthly-sum comparison over partially covered months.
- Anomalies: dedupe and `occurrences`, lifecycle, recurrence after resolve, severity to grade and status, `data_quality.anomalies` in the signal.
- `burn_momentum` and `revenue_disclosure_stale`, including the no-index-near-t0 case.
- Snapshot narrowing: the narrowed snapshot yields identical engine output to the full set on the same data; replay identical; a long-past overlap no longer blocks.
- Dilution: zero-emission non-burn case equals the 1.1.0 value; a constant-emission case against a hand-derived closed form; a net-deflation case with `g_pt > g`; `r <= g_pt` blocks; AERO fixture direction and magnitude; golden hash updated once.
- `update` exit codes.
- Live verification steps in the plan (not in CI): read the unverified ABI units from the chain before writing the adapters; a `--dry-run` fetch against the real endpoints.

## 13. Build order

1. Dilution fix (engine 1.2.0). Independent; first.
2. Migration 2, asset-schema additions (`source`, `cross_checks`, `ingest`, `revenue_stale_move_pct`), anomaly and fetch-run stores.
3. Transports and the generic sources (`coingecko`, `http_json`, `defillama`, `erc20_supply`, `contract_read`).
4. `transfer_flow`, backfill, cursors, `--adopt`.
5. Cross-checks, anomalies, signal integration.
6. VVV adapters, the VVV source map in `assets/vvv.yaml`, `burn_momentum`, the stale-revenue alert.
7. CLI including `update`; snapshot narrowing; latest-signal ordering; README.
8. User checkpoint: live `data fetch vvv --dry-run`, then `--adopt` on the real database, then `orion update vvv`.

New dependency: `viem`.

## 14. Known limitations carried forward

- The 5 USD burn band mixes Pro+ sign-ups and credit purchases; `usage_index` does not separate them.
- `usage_index` rose partly because credit burns began on 2026-07-17; a step change in burn policy moves the index without any change in the business. The alert is advisory for this reason.
- DIEM price has no cross-check.
- Assumption bounds are per key, not per scenario (sub-project 3).
- `change.cause` has no value for a config or as-of change; commander errors are not JSON under `--json`; offset-less timestamps parse as local time (all deferred again).
