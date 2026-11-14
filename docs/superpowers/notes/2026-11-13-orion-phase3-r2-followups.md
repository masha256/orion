# Orion Phase 3 R2 (the price swap): followups (2026-11-13)

Spec `docs/superpowers/specs/2026-11-09-orion-phase3-third-party-removal-design.md` (§3.1, §5 R2, D2, D3, D9 as amended),
plan `docs/superpowers/plans/2026-11-13-orion-phase3-r2-price-swap.md` (Tasks 1-9 built; its "Amendments made during
execution" section lists the rulings that changed the plan text). Branch `feat/phase3-third-party`, commits
4498513..3aca04e plus the Task 9 docs commit; built in a worktree, not merged, not tagged, not deployed. Release steps:
`docs/ops/deploy.md` "Phase 3 R2 release" (prerequisites, timing, the per-env block, the soak note, the rollback note).
Source of every line below: the SDD ledger (`.superpowers/sdd/2026-11-13-orion-phase3-r2-price-swap/progress.md`) and
its findings files.

## Open items for Mike

- **Task 10 sign-off.** The proof on a prod copy (old `orion-2026.11.12.1` vs the branch, release block steps 3-8 on the
  copy, both growth windows) gives the per-asset table, the backfill's real call count and wall time, the refused rows
  (if any) and the breaches. His sign-off writes `tools/phase3-proof/r2-allowlist.json`; no tag before it. The table
  also confirms the expected dry-run facts: zero `coingecko:*` refs other than `coingecko:crvusd` and
  `coingecko:yearn-crv`, and PUMP about 21 repriced / about 369 skipped as `defillama_history` (R29). Task 10 also has
  to move `tools/phase2-proof/compare.py` and the R1 allowlist past the new `priceBasis.flows` text (Task 5 carry).
- **HYPE's check is the same venue.** HYPE's primary is the Hyperliquid spot `@107` candle and its check the Hyperliquid
  perp `HYPE` candle (labelled `same_venue`): a venue-wide fault moves both. Mike to decide whether a second venue is
  needed.
- **sdCRV has no independent check** (M2): the second pool is ~$430 deep, so the check is a sanity bound of 0.3-1.0 CRV
  labelled `no_independent_check`; a mispriced sdCRV inside the band is not caught.
- **Prod `--yes` steps** (reprice, rebuild-price-levels, both purges) run only on his go, after the dry runs; any
  `refused` row (reprice exit 3, a rebuild refusal) is his decision.
- The licence notes stay as recorded in the spec Status (M8): Hyperliquid and Lighter terms exclude US persons; PUMP is
  read only through our own Solana RPC (R8).

## Rulings during execution

Controller rulings from the SDD ledger and its findings files, one entry each with its cost if wrong (as the ruling
states it; "assessed here" where the ruling states none).
- R1: no separate baseline run (8f50ac6's release build ran the full suite on identical code). Cost: a pre-existing red
  shows up in Task 1's full run and is attributed by stash-rerun.
- R2: `valid_from` = the first hour Orion needs, not the method's birth: every EVM ref 2025-10-13 (flows from
  2025-10-14); AERO 2026-09-23; HYPE and LIT 2026-10-01 (the M7 level rebuild needs prices from their oldest `price_usd`
  rows, 10-02 on); PUMP 2026-10-12 (level rows from ~10-13, burn days 10-24 on). Cost: an older report day lacks a
  price; fix by lowering `valid_from` and re-running `backfill-prices`.
- R3: `src/prices/types.ts` holds `HourPrice`, `PriceDeps`, `SolanaPriceTransport` (interface only), `WriteResult`;
  Tasks 3/4 import from it. Cost: a rename later.
- R4: the writer dispatches through a per-chain registry `PRICE_CHAIN_METHODS`; Task 3 registers `eip155:*`, Task 4
  `hyperliquid` and `solana`. Cost: a small refactor.
- R5: the writer prices `eip155:1` first each hour and hands its feed values (`feedUsd`) to every other chain; off-chain
  entries name the Ethereum USDC/USD feed in `usd_feed`; a failed chain-1 hour leaves the off-chain refs missing
  (`quote_missing`). Cost: HYPE/LIT/PUMP hours missing when Ethereum RPC fails (visible in `WriteResult.missing`).
- R6: `flow_usd_chain_v` breaks equal-`ts` ties by `fetched_at DESC` (newest write wins); `rebuild-price-levels` uses the
  same order. Cost: a method change mid-history picks the newer method, which is the intent.
- R7: Task 6 as two dispatches with one review over the range (superseded by R18). Cost: one red intermediate commit.
- R8: PUMP's swap-transaction history is read only from our own Solana RPC (`ORION_SOL_RPC_URL`), never a pump.fun host
  (M8); pinned by a Task 4 test. Cost: not stated (a terms breach if broken; the test guards it).
- R9: `pack.sh` and its test ship `prices.yaml` (allowed in Task 1's commit). Cost: none.
- R10: every stored or compared asset hash is the combined hash (config + `entriesFor`), with a test that a config
  proposal's approve and a fetch compute the same hash. Cost: spurious "config" changes on every signal.
- R11: `entriesFor`'s symbol match (HYPE) was interim; Task 6 made it read refs from `price.token` / `price.token_check`
  params and `transfer_flow` tokens. Cost: not stated (done in Task 6b).
- R12: Task 1 interface departures accepted (chain `lighter`; `curve_oracle` `quote_ref | usd_feed`; `v3_spot` kind;
  `curve_get_dy` `dx`; candle `usd_feed`; `bound` without tolerance); later briefs used them. Cost: not stated.
- R13: Task 1's review ran in parallel with Task 2's implementer; a Task 1 fix lands as its own commit. Cost: a
  `config.ts` conflict with Task 2's import (small).
- R14: `staging_refresh` restores `hour_blocks` from prod (block-at-hour is a chain fact, identical across envs). Cost: a
  few extra `getBlock` calls on stage after a refresh.
- R15: registry methods return `{prices, missing, feedUsd?, checks?, calls?}`; `PriceDeps.prices` and
  `WriteResult.errors` added. Cost: not stated (interface shape; Task 4 followed it).
- R16: Task 4 departures accepted (`blockSignature(slot)`, `slotAt` number | null, the R15 shape, `usdAt(feed, hourMs)`,
  `livePriceOffchain` reads USDC/USD at the Ethereum head; PUMP signatures read on the quote vault). Cost: a small
  refactor.
- R17: report/golden fixtures that seeded `coingecko` prices are re-seeded with a chain source at identical values, so
  goldens move only on price-basis/source labels. Cost: a golden hides a real value move (mitigated by the flattened
  path list each implementer reported).
- R18 (amends R7): Task 6 split so each commit is green: 6a = code plus the YAML edits the `price_coingecko_id`
  retirement forces; 6b = the `price.token` / `price.token_check` adapters, every `price_usd` source and check
  repointed, `entriesFor` from refs, goldens. Cost: none (two reviews over one task range).
- R19: a dry-run fetch computes chain prices in memory and writes no `prices` rows. Cost: dry runs would write prices.
- R20: Task 6a reviewed on its own, 6b separately. Cost: none.
- R21: AERO keeps its own `price_usd` adapters (`chain.v2_pool_twap_price` + CL spot check), byte-identical report; its
  `prices.yaml` entry serves history and the level rebuild only. Cost: two definitions of AERO's price (same pools).
- R22: `price_usd` level cross-checks only where one existed before R2 (CAKE, LINK, LIT, PUMP, UNI, VVV); the new ones on
  CRV, cvxCRV, HYPE, sdCRV, SKY, yCRV and VVV `diem_price_usd` removed (a `cross_check_mismatch` opens an anomaly, a paid
  triage on prod; P5 says price checks never do); LIT zero liquidity = no reading. Cost: those assets have no
  fetch-time level check (the hourly writer check and its WATCH line still run).
- R23: the 6a + 6b fix wave (findings A-G) as one commit, in parallel with the 6b review. Cost: overlapping findings
  merged into a second round.
- R24: a `coingecko` source with `field: price` is refused (load, filing, approve), and config-proposal filing parses
  with the run's `prices` so a bad ref is refused at filing. Cost: none.
- R25: Task 7 departures accepted: the CoinGecko price refusal lives in the loader (`parseAssetObject`, only when
  `prices.yaml` is present; zod would have failed 495 fixtures); refs match `^[A-Za-z0-9:/._@-]{1,120}$` (base58 PUMP)
  and dates `[0-9]`; op `prices` `max_attempts` 3; a stopped chain fails the job with one ALERT; progress kept in
  `jobs.result_json`. Cost: small rework.
- R26: reprice scope = rows CoinGecko-priced at write: `transfer_flow` log-scan rows and PUMP `flow_usd.buyback` rows
  from `solana.supply_burn_daily` (daily mean; amount from the `flow_tokens.buyback` twin when missing); `usd_native`,
  DefiLlama (R4-R6), periodic/disclosed and manual rows are `skipped` with a reason, never `refused`; `coingecko:*` refs
  remapped first; derived rows recomputed in the same transaction; export first. Cost: a CoinGecko-derived row
  misclassified as skipped survives (the Task 10 proof counts skipped by reason).
- R27: the prices backfill freezes `to` at enqueue (default today UTC), validates the span only at enqueue, and op
  `prices` has its own cap `PRICES_BACKFILL_MAX_DAYS` = 550 (the full history from 2025-10-13 fits until 2027-04); op
  `fetch` keeps 400. Cost: not stated in the ruling (assessed here: a range enqueued after 2027-04 must start later than
  2025-10-13 or be split).
- R28: each prices backfill run has a 10-min budget (was 20), so a deploy drain (30-min wait) never times out on it;
  with Task 7 finding 5 the lock is the namespaced `job:prices` (backfill and `purge-prices`). Cost: not stated
  (assessed here: more runs per backfill, each re-reading the stored hours it skips).
- R29: PUMP DefiLlama-history rows are told apart by the adapter's own rule (a buyback row with no amount whose day
  starts before the first stored `solana.token_supply` reading is `defillama_history`; expected ~21 repriced / ~369
  skipped on prod data); the `coingecko:*` remap covers every row of the asset; derived rows get marker basis
  `derived`; per-day apply with `reprice_conflict` on a row changed after export. Cost: the Task 10 dry run shows other
  counts and we stop.
- R30: `data reprice` recomputes every stored derived row in the asset's range whose inputs include a repriced-or-marked
  flow day, writing only when the value differs (an interrupted `--yes` is finished by a rerun; a second `--yes` is a
  no-op). Cost: not stated in the ruling (assessed here: more derived rows read per run, none written needlessly).
- R31: `rebuild-price-levels` refuses a row whose newest price is more than 6 h older than its `observed_at - 1 h` (the
  view's staleness rule). Cost: not stated in the ruling (assessed here: a refused row blocks the market_data purge for
  that asset until Mike decides; release block step 7).

Review fixes that bind like rulings (findings files): the writer checks the abort inside a chain-day and commits nothing
for an aborted day; one breach per run across midnight; a missing hour resets the consecutive count (Task 3); Meteora
reserves from the LbPair's `reserve_x` / `reserve_y` accounts, never the still-open candle, a check error keeps the
primary (Task 4); flow-scan breaches posted by the refresh job, `ORION ALERT <env> levels prices`, the PUMP burn ensures
its 24 hours, levels fills every missing hour in the last 48 h, AERO's hash covers its own entry (Task 6, findings A-G);
the open-ended backfill freeze, chain errors kept when deferring, progress merged (Task 7); derived rows recomputed over
every repriced day, the rung from the venue, the supply split ignoring rejected rows, `data reprice` exit 3 on refused
rows (Task 8).

## Deferred minors

From the reviews, by task (the ledger's `minor (deferred)` lines; the Task 8 fix-round re-review was still running when
this note was written and may add items). None blocks the release.

### Task 1
- check method not validated against a chain (Meteora check on an Ethereum ref would load)
- chain 'lighter' accepts any EVM ref, not only eip155:1
- valid_from checked by pattern only (2025-13-45 loads)
- Solana mint in a ref key not checked for 32 bytes
- missing prices.yaml gives config-only hashes silently at a config-root override (pack.sh prevents it for releases)
- check schema built with a type cast (no static typing on check fields)
- no test pins that a release root, not ORION_HOME, supplies prices.yaml

### Task 2
- usd_feed value recorded on pool rows but not its age (stale ETH/USD under VVV leaves no trace)
- failed calls cached with good ones (a transient failure at one block carries into the next hour)
- v4 currency order not checked against the pool (LIT check only)
- BlockReadCache key omits the call signature
- cache test checks multicall count only, not which block's values the older hour used
- no committed tests for pool token mismatch, unknown feed, zero/negative feed, zero reserves
- v3 mean tick is float, not floored (<=0.01%)

### Task 3
- a backfill that later fills the hour joining two breach runs can report a second breach for one run
- rpc.ts:108 comment still says ~53,556,072 (switch block is 53,556,128)
- a failed chain leaves no missing entry for its refs' later hours
- block-search fallback discards its bracket (extra getBlock calls)
- writeChainPrices ~230 lines
- an aborted chain-day does not save the hour blocks it found (re-searched next run)
- a backfill writing an older breaching hour in front of an already-reported run reports it again
- an abort leaves earlier chains of the same day committed and records no missing for skipped hours

### Task 4
- slot search 6-8 getBlockTime per hour, 15 requests per PUMP hour with its check (above ~8 estimate) — measure in Task 10
- a failed LbPair read is not cached (one extra request per PUMP hour while the pair account is bad)

### Task 5
- 0008 daily_mean count does not check each price is hour-aligned (writer only stores aligned rows)
- sumHourly field name now also covers daily_mean and usd_native days
- compare-usd --json dropped beyondHourly/beyond, gained dailyMean (consumers: none found)
- hours_priced/hours_needed read n/24 on days without hourly buckets (use usd_basis, not hours_needed > 0)

### Task 6a
- prices.yaml ref check at load runs only when the prices map is non-empty (a root without prices.yaml fails later with unknown_price_ref)
- flow scan writer call has no budget or abort (a partial write shows as 'no price point')
- view accepts non-hour-aligned prices; scan lookup does not (none stored)
- no committed test of stored value == view usd
- levels tests written after the code

### Task 6b
- consecutive:2 (cvxCRV/yCRV) does not apply at fetch time (moot after R22: no level cross-check there)
- a config parsed without prices.yaml labels LIT's price source contract_state (production always loads prices.yaml)
- VVV price_usd and diem_price_usd share one source id (a DIEM-only failure streak merges with VVV's)
- price.ts:104/111 comment says a failed read is retried by the next adapter (EVM block cache keeps failures)
- per-run block cache shared across chains, keyed by block number only
- off-chain observedAt is run start (ctx.nowIso)
- LIT's v4 check read at the Ethereum head, not the run block

### Task 6
- FetchResult.priceBreaches not printed by the CLI fetch summary
- refresh result gains an empty undelivered: [] when there are breaches
- 'no breaches on a dry run' holds only through the writer's behaviour, not enforced in flow/fetch
- CLI `orion fetch`/`tick` return breaches but neither prints nor posts them (a CLI-run scan's breach is never reported)

### Task 7
- permanently missing hours re-read every run
- http_json source pointed at a CoinGecko price URL still loads (R8)
- lease-gone progress-save path untested
- a repeatedly failing chain inside budget-limited runs posts one ALERT every 10 min until the job fails

### Task 8
- reprice refuses a log_scan row with hourly_amounts but amount null as 'no token amounts' (none known)
- CLI tests written after the code
Notes kept: CAKE/LINK/UNI keep the check id `price_chainlink` (continuity) though it now checks the pool (Task 6b).

## Carried to later releases

- **R3: circulating supply.** CoinGecko `/coins/markets` is still read for `circulating_supply` and the supply
  cross-checks (`COINGECKO_API_KEY` stays in each `.env` until then); never for a price after R2.
- **R4-R7: the DefiLlama revenue series** (AERO R4, HYPE R5, CRV R7) are untouched by R2 (their rows are `skipped`, not
  repriced).
- **R6: PUMP's DefiLlama history.** The ~369 DefiLlama-era `flow_usd.buyback` days stay as stored (`skipped` as
  `defillama_history`, R29), and so do their CoinGecko-derived token twins (`flow_tokens.buyback` amounts from those
  days); R6 replaces both with an on-chain series. Until then they are the last CoinGecko-derived values Orion keeps,
  counted by reason in the Task 10 dry run.
- **R8: drop the `coingecko` source type and `tokens.coingecko_id`**, and with it guard `http_json`: a source pointed at
  a CoinGecko price URL still loads (Task 7 minor).
- **Rollback window.** A rollback to `orion-2026.11.12.1` is a fix-forward-within-days (deploy.md rollback note): its
  nightly and hourly `levels` write CoinGecko prices and `price_usd` rows again, and a queued prices backfill fails
  silently on it.
- **Exports to keep** (with the nightly `pg_dump`, the only copies): per env `~/home/repriced/<asset>-<UTCstamp>.json`
  (reprice), `~/home/purged/prices-coingecko-<UTCstamp>.json` (purge-prices) and
  `~/home/purged/<asset>-price_usd[+1]-<UTCstamp>.json` (the market_data purges).
- **Soak prompt.** Raymond's stage soak cron prompt (outside the repo) compares stage against the Task 10 table during
  the R2 soak, not prod parity; the controller updates it before the stage deploy.
