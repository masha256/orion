# Orion Phase 3 R2: the price swap (on-chain and first-party prices, history rebuilt, stored flows re-priced)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One release after which no live code reads a CoinGecko price, every stored USD flow is priced from chain or
first-party data, and the `prices` table holds hourly chain/first-party prices for every priced token back to
2025-10-13, with every CoinGecko price row and CoinGecko `price_usd` level row deleted (spec §3.1, §5 R2, D2, D3).

**Architecture:** One central `prices.yaml` names a method and one check per token ref. A chain price writer reads
every ref of a chain in one multicall per chain-hour at cached hour blocks and upserts `prices` rows
(`source = chain:<method>` / `first_party:<venue>`), with the check's gap stored beside each row. The nightly flow scans,
the hourly `levels` job and a resumable `backfill op: prices` job all call the same writer. A new view
`flow_usd_chain_v` (migration 0008, expand-only; `flow_usd_v` is left untouched for rollback) reads chain rows only.
`data reprice` rewrites stored `value` in place from it, `data rebuild-price-levels` writes chain `price_usd` level
rows for past days, and `data purge-prices` deletes the CoinGecko rows.

**Tech Stack:** TypeScript (Node 26, vitest, zod, viem), Postgres 18, Python 3 (`orion-remote` and the proof tools).

**Spec:** `docs/superpowers/specs/2026-11-09-orion-phase3-third-party-removal-design.md` (§3.1, §5 R2, D2, D3, D9).
Scoping (measured 2026-11-13, figures labelled measured/claimed): `~/.hermes/profiles/raymond/workspace/orion/phase3-r2-scoping/`
(`eth-tokens.md`, `wrappers.md`, `base-bnb.md`, `hype-lit-pump.md`, `code-and-data.md`). Every address below is from those files.

**Base:** `feat/phase3-third-party` at 8f50ac6 = main = prod/stage release `orion-2026.11.12.1`. Never rebase onto
local `main` (the uranus checkout is the cron fallback).

## Global Constraints

- No live read of CoinGecko or DefiLlama is added. After this release no code path reads a CoinGecko **price**
  (`/coins/markets` stays only for `circulating_supply`, which is R3). CoinGecko in tests/probes only as "dev-only reference".
- Migration 0008 is expand-only (no `-- breaking` line): `orion-2026.11.12.1` must still run on schema 8. `flow_usd_v`
  is not altered; the new view has a new name.
- Nothing CoinGecko-derived is kept after the release block runs: `prices` rows with `source = 'coingecko'`, the
  `coingecko:*` token refs, `market_data` `price_usd`/`diem_price_usd` rows, and `value` of every re-priceable flow row.
  A row that cannot be re-priced is listed, never silently kept (Task 9 dry run; Mike decides).
- Value moves allowed: USD figures move by the chain-vs-CoinGecko gap and the per-transfer -> hour-bucket method gap
  only. Token amounts, supply, grades and every non-USD field are unchanged. The proof (Task 10) is a signed per-asset
  table over both growth windows; anything outside it is a stop.
- Out of scope: `circulating_supply` (R3), the DefiLlama revenue series (AERO R4, HYPE R5, PUMP history R6, CRV R7),
  dropping `tokens.coingecko_id` and the `coingecko` source type (R8).
- Tests: `export ORION_TEST_DATABASE_URL='postgresql://orion_dev@/orion_test?host=/var/run/postgresql'`;
  `npx vitest run --maxWorkers=2`, load-sensitive files rerun alone at `--maxWorkers=1`; `npm run typecheck`;
  `python3 -m unittest scripts/provision/test/test_orion_remote.py`. RPC in tests only through `fakeRpc({ callsAt })`
  and a fake Solana/HTTP transport; no network in any test.
- Commit with explicit `git add <paths>`; never `-a`. Implementers never use the network, ssh, a `.env`, or a live DB.

## Plan decisions (Mike's "All recommendations", 2026-11-13; his go on the plan covers P1-P6)

Mike's decisions (#orion-dev 2026-11-13), recorded in the spec Status:
- **M1** CRV, CVX, SKY: the deep pool is the hourly primary, the Chainlink feed its check (24 h heartbeat feeds step).
  LINK, UNI, CAKE, crvUSD, USDS stay feed-primary.
- **M2** sdCRV: no independent check exists (second pool ~$430); a sanity bound 0.3-1.0 CRV, labelled `no_independent_check`.
- **M3** VVV = Aerodrome v2 VVV/WETH 1 h TWAP x ETH/USD, check Uniswap v3 VVV/USDC; DIEM = Aerodrome v2 DIEM/VVV TWAP x
  VVV's chain price, check Slipstream DIEM/USDC. The pool list is fixed (no dated switch to the Aero CL pools in R2).
- **M4** Re-price the full flow history (hours from 2025-10-13), not 183 days.
- **M5** PUMP: re-price its 21 on-chain burn days from PumpSwap swap transactions; the 369 DefiLlama-era days wait for R6.
- **M6** HYPE and LIT: current price; no flow needs history.
- **M7** CoinGecko `price_usd`/`diem_price_usd` level rows: rebuild each from the new prices, then purge.
- **M8** Terms: proceed; Hyperliquid/Lighter exclude US persons (noted in the spec), PUMP read only through our own
  Solana RPC, never a pump.fun endpoint.
- **M9** PUMP check = Meteora DLMM PUMP/USDC bin-20 (amends D9's "Raydium").
- **M10** Check tolerances: CRV 1.5%, CVX 2.5%, SKY 2.5%, LINK 2%, UNI 2%, CAKE 2%, stables 0.5%, cvxCRV/yCRV 3% for 2
  consecutive hours, VVV/DIEM 2%, HYPE 2%, LIT 3% (zero-liquidity hours skipped), PUMP 2%. CAKE/LINK/UNI checks move
  off their own feed onto pools.

Plan decisions (from `code-and-data.md` §4):
- **P1 Central `prices.yaml`** (repo root, beside `schedule.yaml`), keyed by token ref; asset YAMLs name refs, never
  methods. An asset's config hash includes the `prices.yaml` entries of every ref it uses (so a method change shows as
  "config" on that asset's provenance). Why not per-asset blocks: crvUSD is used by 4 assets, CRV by 3.
- **P2 Hour semantics.** A `prices` row with `ts = H` is the price of the bucket [H, H+1h), written once H+1h has a block.
  Every method reads at `B(H+1h)` = the first block at or after H+1h: a feed's answer, a Curve EMA, a v3 `observe`
  1 h TWAP ending there, a v2/Aerodrome cumulative TWAP between `B(H)` and `B(H+1h)`. First-party: the hourly candle
  of H (close). Solana: the pool reserves after the last swap before H+1h.
- **P3 New view, chain-only.** `flow_usd_chain_v` (same columns as `flow_usd_v`) reads only `chain:%` / `first_party:%`
  rows, newest at or before the hour start, no more than 6 h old; adds basis `daily_mean` (amount without hourly buckets,
  all 24 of the day's hours priced: amount x mean). The report reads it; the `pricedHourlyAtIngest` gate is removed.
- **P4 Re-price in place** (`data reprice`): `UPDATE observations SET value` per active flow row whose new view basis
  is `hourly` or `daily_mean`, one transaction per asset-day under the asset lock, old rows exported first, provenance
  `locator.repriced = { at, release, basis }`. The `coingecko:crvusd` refs become the crvUSD address ref and
  `coingecko:yearn-crv` the yCRV address ref (new `tokens` row, decimals 18) in the same pass. Stored `derived` rows
  computed from re-priced rows (VVV `usage_index`) are recomputed in the same transaction.
- **P5 Check outcomes are stored, alerted, never anomalies.** Each `prices` row carries `check_gap_pct` and `check`
  (the check's label); a breach (|gap| > tolerance for `consecutive` hours) is posted by the job that wrote it as
  `ORION WATCH <env> price <symbol> <ts>: <gap>% vs <check>` through `ctx.notify`. An anomaly would start a paid triage run.
- **P6 Writer cost.** One multicall per chain-hour, hour blocks cached in a new `hour_blocks` table and searched from the
  previous hour's block. Measured estimate (scoping): ~50k calls, ~1.1M Alchemy CU for the full rebuild; the proof
  (Task 10) measures the real count on the prod copy before the release block runs on stage.

## The price table (`prices.yaml` content, Task 1)

Refs are lowercased. Feeds are Chainlink, 8 decimals, read with `latestRoundData` (answer, updatedAt).

| ref (symbol) | primary | check (tolerance) |
|---|---|---|
| eip155:1/0xd533…cd52 CRV | Curve TriCRV 0x4eBdF703948ddCEA3B11f675B4D1Fba9d2414A14 `price_oracle(1)` (CRV in crvUSD) x crvUSD ref | feed CRV/USD 0xCd627aA160A6fA45Eb793D19Ef54f5062F20f33f (1.5%) |
| eip155:1/0x4e3f…2b CVX | Curve cvxeth 0xB576491F1E6e5E62f1d8F26062Ee822B40B0E0d4 `price_oracle()` x ETH/USD 0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419 | feed CVX/USD 0xd962fC30A72A84cE50161031391756Bf2876Af5D (2.5%) |
| eip155:1/0x5607…79 SKY | Uniswap v2 SKY/USDS 0x2621CC0B3F3c079c1Db0E80794AA24976F0b9e3c cumulative TWAP x USDS ref | feed SKY/USD 0xee10fE5E7aa92dd7b136597449c3d5813cFC5F18 (2.5%) |
| eip155:1/0x5149…ca LINK | feed LINK/USD 0x2c1d072e956AFFC0D435Cb7AC38EF18d24d9127c | Uniswap v3 LINK/WETH 0xa6Cc3C2531FdaA6Ae1A3CA84c2855806728693e8 1 h `observe` x ETH/USD (2%) |
| eip155:1/0x1f98…f984 UNI | feed UNI/USD 0x553303d460EE0afB37EdFf9bE42922D8FF63220e | Uniswap v3 UNI/WETH 0x1d42064Fc4Beb5F8aAF85F4617AE8b3b5B8Bd801 1 h `observe` x ETH/USD (2%) |
| eip155:1/0xf939…4e crvUSD | feed CRVUSD/USD 0xEEf0C605546958c1f899b6fB336C20671f9cD49F | Curve crvUSD/USDT 0x390f3595bCa2Df7d23783dFd126427CCeb997BF4 `price_oracle()` x USDT/USD 0x3E7d1eAB13ad0104d2750B8863b489D65364e32D (0.5%) |
| eip155:1/0xdc03…4f USDS | feed USDS/USD 0xfF30586cD0F29eD462364C7e81375FC0C71219b1 | feed DAI/USD 0xAed0c38402a5d19df6E4c03F4E2DceD6e29c1ee9 (0.5%) |
| eip155:1/0x62b9…aa7 cvxCRV | Curve 0x971add32Ea87f10bD192671630be3BE8A11b8623 `price_oracle()` (cvxCRV in CRV) x CRV ref | Curve 0x9D0464996170c6B9e75eED71c68B99dDEDf279e8 `get_dy` spot (3%, 2 consecutive) |
| eip155:1/0xd1b5…b5 sdCRV | Curve 0xCA0253A98D16e9C1e3614caFDA19318EE69772D0 `price_oracle()` x CRV ref | bound 0.3-1.0 CRV, `no_independent_check` |
| eip155:1/0xfcc5…5b yCRV | Curve 0x99f5aCc8EC2Da2BC0771c32814EFF52b712de1E5 `price_oracle()` x CRV ref | Curve 0x453D92C7d4263201C69aACfaf589Ed14202d83a4 `get_dy` spot (3%, 2 consecutive) |
| eip155:56/0x0e09…82 CAKE | feed CAKE/USD (BNB) 0xB6064eD41d4f67e353768aA239cA86f4F73665a1 | PancakeSwap v3 CAKE/USDT 0x7f51c8aaa6b0599abd16674e2b17fec7a9f674a1 1 h `observe` x USDT/USD (BNB) 0xB97Ad0E74fa7d920791E90258A6E2085088b4320 (2%) |
| eip155:8453/0xacfe…bf VVV | Aerodrome v2 VVV/WETH 0x01784ef301D79e4B2DF3a21ad9a536d4cF09A5Ce cumulative TWAP x ETH/USD (Base) 0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70 | Uniswap v3 VVV/USDC 0x67a11022b7b6ed66f81233f6c8ed6e48f7826530 1 h `observe` x USDC/USD (Base) 0x7e860098F58bBFC8648a4311b374B1D669a2bc6B (2%) |
| eip155:8453/0xf4d9…a024 DIEM | Aerodrome v2 DIEM/VVV 0xbb345d35450bf9ee76f3d2ce214e8e7ac5e1071d cumulative TWAP x VVV ref | Slipstream DIEM/USDC 0xbc3231036ee1eca03e5f67fecedc640d21610823 1 h `observe` x USDC/USD (2%) |
| AERO (aero.yaml's `token`) | aero.yaml's existing `price_pool` TWAP x `usdc_usd_feed` | aero.yaml's `price_check_pool` spot (2%) |
| HYPE (`hyperliquid:spot/@107`) | Hyperliquid spot `@107` hourly candle close (live: `allMids["@107"]`) x USDC/USD (Ethereum feed 0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6) | Hyperliquid perp `HYPE` candle close (2%), labelled `same_venue` |
| eip155:1/0x232c…4ee2 LIT | Lighter spot market 2049 `/api/v1/candles` hourly close (live: order-book mid) x USDC/USD | Uniswap v4 LIT/USDC pool (per `hype-lit-pump.md`) `getSlot0` via StateView, skipped when in-range liquidity is 0 (3%) |
| solana:mainnet/pumpCm…Dfn PUMP | PumpSwap PUMP/USDC vaults (per `hype-lit-pump.md`): USDC vault / PUMP vault x USDC/USD | Meteora DLMM PUMP/USDC bin-20 (2%) |

The implementer copies exact pool ids/addresses for HYPE, LIT, PUMP and AERO from the named files; nothing else is
looked up. Each entry also states `valid_from` (Task 1 measures it, Step 2). HYPE and LIT get hourly rows too (M6 still
holds: no flow reads them), because M7's level rebuild needs a price at each past `price_usd` row (from 2026-10-02); their
`valid_from` is their candle reach (HYPE `candleSnapshot` ~2026-04-19, a rolling 5,000 hours; LIT market launch
2025-12-30), about 10 requests in all. USDC/USD (Ethereum) 0x8fFf…18f6 was re-read on chain 2026-11-13 ("USDC / USD").

## Review Focus

1. **A hour with no block yet / a chain halt / Base's 0.2 s switch (2026-11-05 block 53,556,128)**: the hour-block
   search must return the first block at or after H+1h on both sides of the switch and never write a row for an hour
   whose B(H+1h) does not exist yet. Pinned in Task 3.
2. **A ref whose quote ref has no price for the hour** (DIEM before VVV; cvxCRV before CRV; a feed outage): the dependent
   ref gets no row for that hour rather than a stale-quote row. Pinned in Task 2.
3. **A feed answer older than its heartbeat** at B(H+1h) (CRV/USD up to 6.6 h stale measured): stored with its age in
   the row's detail; it is a check input, never refused, because the feed is only primary where its heartbeat is 1 h or
   its peg is tight. Pinned in Task 2.
4. **A backfill interrupted by a deploy or lease loss**: re-queued job resumes from `prices` itself, never rewrites a
   committed chain-day, and never runs into the nightly window. Pinned in Task 7.
5. **A re-price over a row with a gap hour** (one hour missing among 24): the row is refused and listed, keeps its old
   `value`, and the dry run counts it. Pinned in Task 8.

---

### Task 1: `prices.yaml`, its schema, loader and config-hash wiring

**Files:**
- Create: `prices.yaml`, `src/prices/config.ts`
- Modify: `src/config/load.ts` (hash), `src/config/schema.ts` (transfer_flow `share_price.underlying`; `price_coingecko_id` kept optional until Task 6 removes its users)
- Test: `tests/prices/config.test.ts`, `tests/config/load.test.ts`

**Interfaces:**
- Produces: `type PriceMethod` (discriminated on `kind`: `chainlink {feed}`, `curve_oracle {pool, index?, quote_ref}`,
  `curve_get_dy {pool, i, j, quote_ref}`, `v2_twap {pool, flavor: 'uniswap' | 'aerodrome', quote_ref?, usd_feed?}`,
  `v3_twap {pool, seconds: 3600, quote_ref?, usd_feed?}`, `v4_spot {state_view, pool_id, quote_ref?, usd_feed?}`,
  `hyperliquid_candle {coin}`, `lighter_candle {market_id}`, `solana_vaults {base_vault, quote_vault, usd_feed}`,
  `meteora_dlmm {pair, usd_feed}`, `bound {min_in_quote, max_in_quote, quote_ref}`);
  `interface PriceEntry { ref: string; symbol: string; decimals: number; chain: 'eip155:1' | 'eip155:56' | 'eip155:8453' | 'solana' | 'hyperliquid'; validFrom: string; primary: PriceMethod; check: PriceMethod & { tolerancePct: number; consecutive: number; label?: 'same_venue' | 'no_independent_check' } }`;
  `loadPrices(rootDir: string): Map<string, PriceEntry>`; `entriesFor(asset: AssetConfig, prices: Map<string, PriceEntry>): PriceEntry[]` (the refs the asset uses plus their quote refs, transitively);
  `methodSource(m: PriceMethod): string` -> `chain:<kind>` or `first_party:<venue>`.

- [ ] **Step 1: Failing tests** `tests/prices/config.test.ts`: loading the committed `prices.yaml` gives the 17 refs of
  the table; every `quote_ref` resolves; no cycle (`DIEM -> VVV` ok, a self-reference refused); an unknown key, a
  tolerance <= 0, an address that isn't 20 bytes, or a ref whose chain prefix contradicts `chain` is refused by name;
  `entriesFor(ycrv)` contains yCRV, CRV and crvUSD. `tests/config/load.test.ts`: changing a `prices.yaml` entry moves the
  hash of exactly the assets that use it (crvUSD moves crv, cvxcrv, sdcrv, ycrv; AERO's hash moves only on its own entry).
- [ ] **Step 2: Measure `valid_from`** (controller, not the implementer: needs RPC): for each ref, the read at the
  2025-10-13T01:00Z block for primary and check (one multicall per chain, `onchain_probe.py`). Ones that fail get the
  first working day as `validFrom`. Record results in the ledger; any ref later than 2025-10-14 for a ref that has flow
  rows before then is a stop for Mike (rows that can't be re-priced).
- [ ] **Step 3: Implement** with zod strict nodes; the hash input is the asset config plus `entriesFor` sorted by ref.
- [ ] **Step 4: Run** the two test files, then the full suite: every asset's hash moves (new hash input), so re-pin the
  asset tests' hashes in this commit (`grep -rl <old hash> tests`) and nothing else.
- [ ] **Step 5: Commit** `feat(prices): central prices.yaml with one method and one check per token ref`.

### Task 2: Price-method readers (EVM)

**Files:**
- Create: `src/prices/evmMethods.ts`
- Test: `tests/prices/evmMethods.test.ts`

**Interfaces:**
- Consumes: `PriceEntry`, `PriceMethod` (Task 1); `RpcTransport.multicall` (src/ingest/transport/rpc.ts).
- Produces: `callsFor(m: PriceMethod, at: { end: BlockRef; start: BlockRef }): ContractCall[]` and
  `decode(m: PriceMethod, raw: bigint[], at, quoteUsd: (ref: string) => number | null, feedUsd: Map<string, number>): { usd: number; detail: Record<string, unknown> } | null`;
  `priceHourEvm(rpc: RpcTransport, entries: PriceEntry[], at: { start: BlockRef; end: BlockRef }): Promise<Map<string, HourPrice>>`
  with `interface HourPrice { usd: number; source: string; checkGapPct: number | null; check: string; detail: Record<string, unknown> }`.
  One multicall for every primary, check and feed of the chain's entries; refs resolved in dependency order from that one result.

- [ ] **Step 1: Failing tests** with `fakeRpc({ callsAt })` per method, values taken from the scoping files' measured
  rows: Chainlink 8 decimals (CAKE 1.74948 at NOW row); Curve `price_oracle()` x CRV (cvxCRV 0.41377 x 0.2335 = 0.09662);
  Uniswap v2 cumulative TWAP over dt = 3600 s with `getReserves` timestamp catch-up (the pair's last-update fold);
  Aerodrome `currentCumulativePrices`; v3 `observe([3600,0])` tick mean with token0/token1 side; v4 `getSlot0` with zero
  liquidity -> check skipped (`checkGapPct: null`, detail `skipped: zero_liquidity`); `bound` outside [0.3, 1.0] -> gap
  reported as the distance to the bound. Review Focus 2: DIEM with VVV's primary call failing -> no DIEM entry in the map.
  Review Focus 3: a feed with `updatedAt` 6.6 h before `end.timestamp` -> priced, `detail.feed_age_s` = 23760.
- [ ] **Step 2: Run, see FAIL.**
- [ ] **Step 3: Implement.** Reuse the decoding already in `src/ingest/adapters/evm.ts` (`v2TwapPrice`, `clSpotPrice`,
  `side`) by moving the pure parts into `evmMethods.ts` and importing them back into `evm.ts` (AERO's adapters keep
  their output byte for byte: its asset test must stay green unchanged).
- [ ] **Step 4: Run** the new file, `tests/assets/aero*.test.ts`, typecheck.
- [ ] **Step 5: Commit** `feat(prices): EVM price methods read in one multicall per chain-hour`.

### Task 3: Hour blocks and the chain price writer

**Files:**
- Create: `src/db/pg/migrations/0008_chain_prices.sql` (this task adds the `hour_blocks` table and the `prices`
  columns; Task 5 appends the view to the same file before release), `src/db/hourBlocks.ts`, `src/prices/writer.ts`
- Modify: `src/db/prices.ts` (`upsertPrices` writes `check_gap_pct`, `check`, `detail`), `src/ingest/transport/chains.ts` (comment: the switch block is 53,556,128)
- Test: `tests/prices/writer.test.ts`, `tests/db/hourBlocks.test.ts`, `tests/db/pg/migrate.test.ts`

**Interfaces:**
- Consumes: Task 1, Task 2; `firstBlockAtOrAfter` (rpc.ts:111).
- Produces: 0008 part 1: `CREATE TABLE hour_blocks (chain_id bigint, hour timestamptz, block bigint NOT NULL, block_ts bigint NOT NULL, PRIMARY KEY (chain_id, hour))`;
  `ALTER TABLE prices ADD COLUMN check_gap_pct double precision, ADD COLUMN "check" text COLLATE "C", ADD COLUMN detail jsonb`.
  `dbHourBlocks(db, chainId): { get(hourMs): Promise<BlockRef|null>; put(hourMs, b): Promise<void> }` (first write wins, as day_blocks).
  `writeChainPrices(db: Db, deps: PriceDeps, refs: string[], fromHourMs: number, toHourMs: number, opts?: { signal?: AbortSignal; budgetMs?: number }): Promise<WriteResult>`
  with `interface WriteResult { written: Record<string, number>; skippedExisting: number; missing: { ref: string; hourMs: number; reason: string }[]; breaches: { ref: string; hourMs: number; gapPct: number; check: string }[]; calls: { [chain: string]: number }; reachedMs: number | null; stoppedByBudget: boolean }`.
  It skips hours already stored for that ref under its primary's source, walks newest hour first, commits one chain-day per transaction, and stops at `budgetMs`.
  `interface PriceDeps { rpcFor(chain: string): RpcTransport; solana: SolanaPriceTransport; http: HttpTransport; now: Date }` (Task 4 supplies `SolanaPriceTransport`).

- [ ] **Step 1: Failing tests.** Review Focus 1: a fake Base chain with 2 s blocks then 0.2 s from block 53,556,128;
  hours 2026-11-05T16:00Z..20:00Z resolve to the first block at or after each hour; the search from the previous hour's
  block costs <= 4 `getBlock` calls per hour (measured scoping: 1-2); an hour whose H+1h is after the head writes
  nothing (`missing` reason `no_block_yet`). Idempotence: running twice writes 0 rows the second time and makes no
  multicall. Budget: with `budgetMs` 0 after the first day, `stoppedByBudget` true and exactly one chain-day committed.
  Breach: cvxCRV gaps 3.4% then 3.5% -> one breach (consecutive 2); 3.4% then 0.1% -> none. Migration test: 0008 applies
  on a 0007 schema without `--breaking`, and `orion-2026.11.12.1`'s queries still run (existing migrate fixtures).
- [ ] **Step 2: Run, see FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the three files, typecheck.
- [ ] **Step 5: Commit** `feat(prices): hour-block cache and a resumable chain price writer`.

### Task 4: First-party and Solana price methods

**Files:**
- Create: `src/prices/offchainMethods.ts`, `src/ingest/transport/solanaRpc.ts` (only if `src/ingest/adapters/solana.ts`
  has no reusable JSON-RPC client; otherwise extend that one)
- Test: `tests/prices/offchainMethods.test.ts`

**Interfaces:**
- Produces: `interface SolanaPriceTransport { getMultipleAccounts(keys: string[]): Promise<...>; slotAt(tsSec: number): Promise<number>; signaturesBefore(address: string, beforeSig: string | null, limit: number): Promise<...>; getTransaction(sig: string): Promise<...> }`;
  `priceHourOffchain(deps: PriceDeps, entries: PriceEntry[], hourMs: number, usdcUsd: number | null): Promise<Map<string, HourPrice>>`;
  `livePriceOffchain(deps, entry): Promise<HourPrice>` (levels: `allMids`, order-book mid, vault reserves).
  Hyperliquid and Lighter return a whole candle range per request: `priceRangeOffchain(deps, entry, fromHourMs, toHourMs): Promise<Map<number, HourPrice>>` (HYPE: one `candleSnapshot` for up to 5,000 hours; LIT: `/api/v1/candles`, 9 calls for 183 days).

- [ ] **Step 1: Failing tests** with recorded fixtures (shape-faithful, numbers from `hype-lit-pump.md`): HYPE spot and
  perp candles -> price x USDC/USD and gap; LIT candles + v4 check; PUMP past hour: slot search with 0.215 s slots,
  `getSignaturesForAddress` `before` cursor, `getTransaction(..., { maxSupportedTransactionVersion: 1 })`, price from the
  first swap's `postTokenBalances` of the two vaults (USDC 6 decimals, PUMP 6); Meteora check from its first swap before
  the hour (fee included); an hour with no swap in the hour before it -> reserves of the newest earlier swap, detail
  `last_swap_age_s`, refused beyond 6 h (`missing`). No request goes to a pump.fun host (assert the fake saw none).
- [ ] **Step 2: Run, see FAIL. Step 3: Implement. Step 4: Run, typecheck.**
- [ ] **Step 5: Commit** `feat(prices): Hyperliquid, Lighter and PumpSwap price methods`.

### Task 5: The chain-only view and the report basis

**Files:**
- Modify: `src/db/pg/migrations/0008_chain_prices.sql` (append the view), `src/db/prices.ts` (`listFlowUsd`, `priceBasisOf`, `compareUsd`), `src/report/incomeStatement.ts` (priceBasis labels), `src/report/parity.ts`
- Test: `tests/db/prices.test.ts`, `tests/report/*` goldens

**Interfaces:**
- Produces: `CREATE VIEW flow_usd_chain_v` with `flow_usd_v`'s columns, the price lateral restricted to
  `(starts_with(pr.source, 'chain:') OR starts_with(pr.source, 'first_party:'))`, `ORDER BY pr.ts DESC`, the 6-hour
  rule, and basis `daily_mean` (`hourly_amounts` null, `amount` not null, 24 chain hours priced in the day:
  usd = amount x avg). `type PriceBasis = 'hourly' | 'daily_mean' | 'usd_native' | 'legacy'`; `priceBasisOf(usdBasis: string): PriceBasis`
  (gate removed; `HOURLY_SERIES_DAYS` and `pricedHourlyAtIngest` deleted).

- [ ] **Step 1: Failing tests**: a row with CoinGecko rows only reads `legacy_unpriced` in the new view and `hourly` in
  the old one (old view untouched); with chain rows it reads `hourly` at the chain price; a CoinGecko row newer than the
  chain row is ignored; PUMP-style row with 24 chain hours -> `daily_mean`, with 23 -> `legacy_no_hourly`. Report
  goldens: priceBasis text and `source` show the method (`chain:chainlink` etc.); re-pin only the price-basis keys.
- [ ] **Step 2-4: FAIL, implement, PASS** (full suite: goldens may move only on priceBasis keys; any other key is a stop).
- [ ] **Step 5: Commit** `feat(prices): chain-only flow USD view (0008) and the report basis without the ingest gate`.

### Task 6: Writers switch: flows, levels, `price_usd`, PUMP burn

**Files:**
- Modify: `src/ingest/flow.ts` (drop `loadPrices`/`priceAt`/series; `value` = Σ hourly_amounts[h] x chain price(h)),
  `src/ingest/tokenBackfill.ts` (price part deleted), `src/ingest/adapters/solana.ts` (`supply_burn_daily` USD =
  tokens x the day's mean chain price; no `market_chart`), `src/levels/levels.ts` (after the level reads, `writeChainPrices`
  for the hours since the newest stored hour, capped at 48 h, every ref in `prices.yaml`; `/coins/markets` only for
  `circulating_supply` ids), `src/daemon/daemon.ts` (`sharedHttpCache` removed), `assets/*.yaml` (12 assets + AERO's ref)
- Create: adapters `price.token` and `price.token_check` (in `src/ingest/adapters/price.ts`, registered; `ADAPTER_SOURCE_TYPES` rung + `ADAPTER_ENDPOINTS` line, regenerate `docs/ops/sources-register.md`)
- Delete: `src/prices/coingeckoHourly.ts`
- Test: `tests/ingest/flow*.test.ts`, `tests/levels/*.test.ts`, every asset test, `tests/agent/golden/*`, `tests/report/golden/*`

**Interfaces:**
- Consumes: Tasks 1-5.
- Produces: `price.token { ref }` (live price by the ref's primary at the run block or live first-party read) and
  `price.token_check { ref }` (its check), used as each asset's `price_usd` source and cross-check; VVV
  `diem_price_usd` the same with the DIEM ref. `type: price` checks of CAKE/LINK/UNI point at `price.token_check`.
  `transfer_flow` members: `price_coingecko_id` removed from the schema (refused by name, three-place test as in the
  skill's "Retiring a config key"); a share-priced member names `share_price.underlying: <contract>`.

- [ ] **Step 1: Failing tests**: a nightly scan with chain prices for every hour writes `value` = the bucket sum; a
  missing hour withholds the day (as today's missing CoinGecko point); the scan makes no CoinGecko request (fake http
  asserts none); levels writes the last completed hour for every ref and alerts once per breach run; `price_coingecko_id`
  refused at load, at proposal filing and at approve; PUMP burn USD = tokens x mean of 24 chain hours, refused if fewer.
- [ ] **Step 2-4: FAIL, implement, PASS.** Re-pin asset hashes and goldens: values may move only on USD figures and
  priceBasis/provenance keys; list every moved golden key in the report.
- [ ] **Step 5: Commit** `feat(prices): flows, levels and price levels read chain prices; CoinGecko price reads removed`.

### Task 7: `backfill op: prices` and its remote verb

**Files:**
- Modify: `src/daemon/jobs/backfill.ts`, `src/db/jobs.ts` (`BackfillParams` union), `src/cli/commands/job.ts`,
  `scripts/provision/files/orion-remote` (+ its tests), `docs/ops/deploy.md` (verb table)
- Test: `tests/daemon/backfill.test.ts`, `tests/cli/job*.test.ts`, `scripts/provision/test/test_orion_remote.py`

**Interfaces:**
- Produces: params `{ op: 'prices'; from: 'YYYY-MM-DD'; to?: 'YYYY-MM-DD'; refs?: string[] }`, job `assetId` null,
  run lock name `prices`; each run calls `writeChainPrices` with `budgetMs` 20 min, then returns `{ status: 'deferred', untilMs: now }`
  until no hour is missing, then `done` with the WriteResult summary (rows per ref, oldest hour, missing by reason, calls
  per chain, breaches). `backfillWaitUntil` applies unchanged. CLI `job run-now backfill-prices --from D [--to D] [--refs a,b]`;
  remote the same verb, `--refs` a comma list validated against `^[a-z0-9:/._-]{1,120}$`.

- [ ] **Step 1: Failing tests**: Review Focus 4: a job whose lease is lost mid-day re-queues and the second run skips
  every committed chain-day (no multicall for them); the job defers while the nightly window is closed; a deferred job
  keeps priority 70 (hourly levels run between budgets); `refs` with an unknown ref is refused at enqueue; the old
  `op: fetch` path is unchanged (existing tests green).
- [ ] **Step 2-4: FAIL, implement, PASS.**
- [ ] **Step 5: Commit** `feat(daemon): resumable prices backfill job and its remote verb`.

### Task 8: `data reprice`, `data rebuild-price-levels`, `data purge-prices`

**Files:**
- Create: `src/db/reprice.ts`, `src/db/priceLevels.ts`
- Modify: `src/db/purge.ts` (prices mode), `src/cli/commands/data.ts`, `scripts/provision/files/orion-remote` (+ tests), `docs/ops/deploy.md`
- Test: `tests/db/reprice.test.ts`, `tests/db/priceLevels.test.ts`, `tests/db/purge.test.ts`, CLI tests

**Interfaces:**
- Produces: `repriceAsset(db, loaded, { from?: string; yes: boolean; now: Date }): Promise<RepriceResult>` with per-metric
  `{ rows, repriced, refused: { id, day, reason }[], oldSum, newSum }`; `--yes` exports first to
  `$ORION_HOME/repriced/<asset>-<UTCstamp>.json` (fsynced, as purge), then one transaction per asset-day under the asset
  lock; remaps `coingecko:crvusd` / `coingecko:yearn-crv` token refs (P4); recomputes the stored derived rows whose inputs moved.
  `rebuildPriceLevels(db, loaded, { yes })`: per `market_data` `price_usd`/`diem_price_usd` row, a new row at the same
  `observed_at` from the newest chain/first-party price with `ts <= observed_at - 1h`, method `derived`, locator
  `{ from: 'prices', token_ref, ts, source }`; refused (listed) where none exists.
  `purgePrices(db, { source: 'coingecko'; yes })`: export, delete those `prices` rows, then the `coingecko:*` `tokens`
  rows with no remaining reference; refuses while any active observation still has a `coingecko:*` ref.
  CLI `data reprice <a> [--from D] [--yes]`, `data rebuild-price-levels <a> [--yes]`, `data purge-prices --source coingecko [--yes]`; remote the same.

- [ ] **Step 1: Failing tests**: Review Focus 5: a row with 23 of 24 hours priced is refused, keeps its value, and is
  counted; dry run writes nothing (row counts equal); `--yes` twice is a no-op the second time; the export holds every
  old row byte-for-byte; `usage_index` rows recomputed equal `derived.ts` on the new values; `purgePrices` refuses
  before the remap and succeeds after it; `rebuildPriceLevels` then `data purge --source-type market_data` leaves every
  report day with a price level.
- [ ] **Step 2-4: FAIL, implement, PASS.**
- [ ] **Step 5: Commit** `feat(data): reprice stored flows, rebuild price levels, purge CoinGecko prices`.

### Task 9: Release block and followups

**Files:**
- Modify: `docs/ops/deploy.md` ("Phase 3 R2 release" per env), `docs/superpowers/notes/2026-11-13-orion-phase3-r2-followups.md` (create), the spec Status
- No code.

The block, per env (stage first; prod only after the soak and Mike's go; every `--yes` on prod on Mike's go):
0. Save `before/` reports (13 assets, each asset's default day and that day minus 91).
1. `deploy.sh <env> <tag>` (0008, expand-only). Check: `status` on the tag, migrations 8.
2. `job run-now backfill-prices --from 2025-10-13`; poll `jobs` until `done`; record rows per ref, calls per chain, missing.
   Must finish before the env's nightly or be left to defer (it does on its own).
3. Per asset `data compare-usd <a>`: 0 `legacy_unpriced` on any flow that has tokens; otherwise stop.
4. Per asset `data reprice <a>` dry run, then `--yes` (stage: under the release go; prod: Mike's go). Refused rows: stop
   and bring to Mike.
5. Per asset `data rebuild-price-levels <a>` dry run, `--yes`.
6. `data purge-prices --source coingecko` dry run, `--yes`; `data purge <a> --metrics price_usd[,diem_price_usd] --source-type market_data` dry run, `--yes`.
7. Save `after/` reports; compare with Task 10's signed table (`flatdiff` with the R2 allowlist); anything outside is a stop.
8. Soak (stage): one scheduled nightly with no failed sources and no `ORION WATCH ... price` breach without a stated cause.

- [ ] **Step 1: Write** the block, the verb table lines, the rollback note (0008 is expand-only; a rollback to
  `orion-2026.11.12.1` reads `flow_usd_v`, whose CoinGecko rows are gone after step 6, so its reports read `value`,
  which step 4 re-priced: numbers stay chain-priced; the old code then re-adds CoinGecko rows nightly, so a rollback
  needs a forward fix within days) and the followups note.
- [ ] **Step 2: Commit** `docs: Phase 3 R2 release block and followups`.

### Task 10: Proof on a prod copy and the sign-off table (controller)

**Files:** `tools/phase3-proof/r2-allowlist.json`, `tools/phase3-proof/README.md`; results in `workspace/orion/phase3-proof/r2/`.

- [ ] **Step 1:** `prod_copy.py --breaking` into `$TMPDIR` (old = `orion-2026.11.12.1`, new = the branch dist), outside
  05:00-06:30 PT and the prod nightly -4 h/+2 h.
- [ ] **Step 2:** Old side: save all 13 reports at D (yesterday) and D-91. New side: run the release block steps 2-6 on
  the copy (real RPC, read-only chain), recording the calls and wall time of step 2.
- [ ] **Step 3:** Field-level flatdiff old vs new, both days. Build the per-asset table: price level old -> new;
  revenue, holder flow, cost of revenue and growth old -> new, split into (a) the method gap (old `flow_usd_v` usd vs
  `value`, both CoinGecko, read on the copy before step 4) and (b) the rest, chain vs CoinGecko. Expected:
  (a) within ±0.25% (scoping 3.2), (b) within the check tolerances above. Non-USD fields identical.
- [ ] **Step 4:** Bring the table, the call count, the refused rows (if any) and the breaches to Mike. His sign-off
  writes the allowlist bounds; no tag before it.
- [ ] **Step 5:** `cleanup.py` the copy; commit the allowlist and README.

## Self-review notes
- Spec §3.1 methods: Task 1 table + Tasks 2/4; checks never from the same pool (CAKE/LINK/UNI moved to pools, M10).
- D3 (re-price, no CoinGecko kept): Tasks 5, 8, 9 step 3-6; full horizon per M4; PUMP per M5 (Task 4 history method).
- D9 amended to Meteora (M9). Licence notes (M8) go into the spec Status.
- Rollback: 0008 adds only a table, columns and a new view.
