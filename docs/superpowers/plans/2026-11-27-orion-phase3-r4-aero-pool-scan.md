# Orion Phase 3 R4: AERO revenue on chain (`pool_scan` pilot) Implementation Plan

Linear: RET-20

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One release after which AERO's income statement comes only from Orion's own reads on the 8 Aero chains: gross
pool fees (tape accumulators), the allocator share, and VRM incentives, all priced on chain. The DefiLlama
`flow_usd.fees` series is purged and the new series is backfilled from the 2026-10-22 merger.

**Architecture:** A generic engine (`src/ingest/poolscan/`) scans one (chain, UTC day) at a time: day blocks, pools per
factory and tape, accumulator deltas, gauge accrual + `FeesCollected` logs, VRM programs, and an on-chain price graph.
Two adapters (`pool.tape_fees_daily`, `pool.vrm_incentives_daily`) memoize that scan per run and expose one field each as
five new AERO metrics. Core gets six chains, a per-chain RPC on every adapter context, raw multicall and log reads, the
series-writer origin fix, the `onchain_usd` price basis, `started` on below-line lines, and the Q5 window label and
growth guard. No migration.

**Tech Stack:** TypeScript (Node 26, vitest, zod, viem 2.56.8), Postgres 18, Python 3 (proof tools).

**Spec:** `docs/superpowers/specs/2026-11-27-orion-phase3-r4-aero-pool-scan-design.md` (approved by Mike 2026-11-27).
Scoping (MEASURED/CLAIMED/DEV-REF marked) is in `~/.hermes/profiles/raymond/workspace/orion/phase3-r4-scoping/`:
`code-and-data.md` (file:line map, read it for your task's files), `onchain-revenue.md` + `onchain-revenue-data/`
(`raw/<day>_<chain>.json` = per-pool snapshots at both blocks, logs, reserves, slot0, TWAP ticks; `scripts/` = the
measurement code, which holds every ABI signature used), `incentives-and-events.md` + `incentives-data/` (`programs.json`,
`zero_supply_cum.json`, `discovery.json`, `scripts/aero_rpc.py`). **Every address and ABI signature in this plan's work
is copied from those files, never typed from memory.**

**Base:** GitHub `main` 2635cae (= `orion-2026.11.21.1`, live on prod and stage) + `d422944` (.hermes-linear.yaml) +
`9b44bc9` (spec). Branch `ret-20-aero-pool-scan`, worktree `.worktrees/ret-20-aero-pool-scan`. Baseline: 156 files /
2032 tests green, typecheck clean.

## Global Constraints

- No live read of DefiLlama or CoinGecko is added; AERO stops reading DefiLlama entirely (`external_ids.defillama`
  stays for R8). Prices are on chain only.
- No migration. Schema 8; `orion-2026.11.21.1` must still run on the database after this release (rollback).
- Byte-identical for the 12 other assets: every report field, hash and golden of CAKE, CRV, cvxCRV, HYPE, LINK, LIT,
  PUMP, SKY, sdCRV, UNI, VVV, yCRV is unchanged. Only AERO values move. Shared code changes (window label, growth guard,
  below-line `started`, origin fix) must be no-ops for lines without `started` / with full history.
- Chains (MEASURED by the controller 2026-11-27, eth_chainId + mean block time over 200k blocks + eth_getLogs span on
  Alchemy): OP 10 / 2.0 s / span ≥ 1M; Arbitrum 42161 / 0.3048 s / ≥ 1M; Ink 57073 / 1.0 s / **10,000**; Robinhood 4663
  / 0.1123 s / ≥ 1M; Arc 5042 / 0.5081 s / ≥ 1M; Elysium 99901 / 0.151 s / ≥ 1M. Env vars `ORION_OP_RPC_URL`,
  `ORION_ARB_RPC_URL`, `ORION_INK_RPC_URL`, `ORION_ROBINHOOD_RPC_URL`, `ORION_ARC_RPC_URL`, `ORION_ELYSIUM_RPC_URL`.
- Reads at `s−1` and `e−1` where `s` = first block with timestamp ≥ D 00:00Z and `e` = first block ≥ D+1 00:00Z; block
  search only through `firstBlockAtOrAfter` (never block-time arithmetic).
- Pricing (Q4): reviewed anchor addresses → Chainlink USD feeds; tokenized-stock feeds are never anchors; graph floor
  **$10,000** priced-side balance, **≤ 3 hops**; CL edge = **30-min TWAP** ending at `e−1` (slot0 spot only when the
  pool's observations can't cover 30 min, flagged `spot_fallback`); V2 edge = reserves at `e−1`, curve from the creating
  factory (stable/volatile), never `stable()`; own-pool fallback; rest **unpriced** (never imputed). Anchor feed older
  than **26 h** at `e−1` is dropped for that day.
- Failure semantics: any RPC failure, a chain-day priced below **95%**, or allocator > gross on a chain-day by more than
  **0.5% and $1** fails the adapter run (`ok: false`, nothing written). 95-99% coverage writes and warns. Drift warns.
- Warnings become advisory `cross_check_mismatch` anomalies (existing kind; no migration) with `dedupeKey`
  `pool_scan:<what>:<chain>[:<id>]`; they reach #orion-ops through the existing nightly anomaly post.
- Tests: `export ORION_TEST_DATABASE_URL='postgresql://orion_dev@/orion_test?host=/var/run/postgresql'`;
  `npx vitest run --maxWorkers=2` (rerun load-sensitive files alone at `--maxWorkers=1`); `npm run typecheck`. No network
  in any test except Task 9's opt-in live golden (`ORION_LIVE_RPC=1`, skipped by default).
- Commit with explicit `git add <paths>`, never `-a`; commit messages carry the task's sub-ticket ID. Implementers never
  use the network, ssh, a `.env`, or a live DB; fixtures come from the scoping `raw/` files.

## Review Focus

1. **A pool created mid-day** (absent at `s−1`): its whole `e−1` accumulator is the day's fee, never a negative delta or
   a skipped pool. Test in Task 4.
2. **A token that symbol-matches an anchor** (the five non-canonical Base "USDC"s, the spoof Base "LINK"): priced only
   through the graph, never as $1 / the LINK feed. Test in Task 5.
3. **An incentive program spanning midnight or starting while the VRM has zero allocation**: streamed = rate × (overlap
   − zero-allocation seconds), never the raw overlap. Test in Task 6.
4. **A routine run after the backfill** must not rescan 40 days: it scans only the revision window (3 days) plus
   missing days, at most `max_scan_days` per run, oldest missing first. Test in Task 7.
5. **The 12 other assets' reports when the window/growth code changes**: unchanged byte for byte (CRV with its two
   revenue lines, LINK with buy-and-hold, PUMP with a young series). Test in Task 3 via the v2 golden.

---

### Task 1: Six chains and a per-chain RPC on every adapter context — RET-196

**Files:**
- Modify: `src/ingest/transport/chains.ts` (rows), `src/ingest/transport/viemRpc.ts` (`VIEM_CHAINS`; Elysium via
  viem `defineChain`, multicall3 `0xcA11bde05977b3631167028862bE2a173976CA11`), `src/prices/writer.ts:500` (re-export)
- Create: `src/ingest/transport/chainRpcEnv.ts`
- Modify: `src/ingest/types.ts` (`SourceContext`), `src/ingest/run.ts` (wire `rpcFor`)
- Modify: `tools/sources-register/generate.ts` (env names), regenerate `docs/ops/sources-register.md`
- Test: `tests/ingest/rpc.test.ts`, `tests/ingest/run.test.ts`, `tests/prices/writer.test.ts`

**Interfaces:**
- Produces: `CHAIN_RPC_ENV: Readonly<Record<number, string>>` (1, 56, 8453 + the six above), `PRICE_RPC_ENV` kept as an
  alias of the same object (existing imports unchanged). `SourceContext.rpcFor?: (chainId: number) => RpcTransport`
  (cached per chain per run; throws `OrionError('no_rpc_url', …)` naming the env var when unset).
- CHAINS rows: `{ id, name, maxLogRange, blockTimeSec, defaultRpcUrl: null, confirmations }` = OP `{10,'optimism',
  1_000_000, 2, null, 900}`, Arbitrum `{42161,'arbitrum',1_000_000,0.3,null,7200}`, Ink `{57073,'ink',10_000,1,null,
  1800}`, Robinhood `{4663,'robinhood',1_000_000,0.11,null,18000}`, Arc `{5042,'arc',1_000_000,0.5,null,3600}`, Elysium
  `{99901,'elysium',1_000_000,0.15,null,12000}`.

- [ ] **Step 1: Failing tests.** `rpc.test.ts` chain table: each new id resolves its row with the values above;
  `viemRpc` creates a client for each (no `unsupported_chain`). `run.test.ts` `'rpcFor resolves ORION_OP_RPC_URL and
  caches one transport per chain'`; `'rpcFor names the missing env var'` (error message contains `ORION_INK_RPC_URL`).
  `writer.test.ts`: `PRICE_RPC_ENV[8453] === 'ORION_BASE_RPC_URL'` still.
- [ ] **Step 2: Run them; they fail.** `npx vitest run tests/ingest/rpc.test.ts tests/ingest/run.test.ts`
- [ ] **Step 3: Implement.** `rpcFor` is set on every run that has an env, built with the same RPC factory the run uses
  for `ctx.rpc` (so tests inject `fakeRpc` per chain through the existing factory seam).
- [ ] **Step 4: Regenerate the register** `npx tsx tools/sources-register/generate.ts`; full suite + typecheck green;
  every golden and hash pin unchanged.
- [ ] **Step 5: Commit** `feat(chains): OP, Arbitrum, Ink, Robinhood, Arc, Elysium + ctx.rpcFor (<T1 ID>)`.

### Task 2: Core ingest: raw multicall, logs, stored days, warnings, origin fix — RET-197

**Files:**
- Modify: `src/ingest/transport/rpc.ts` (types), `src/ingest/transport/viemRpc.ts`, `tests/helpers/fakeRpc.ts`
- Modify: `src/ingest/types.ts`, `src/ingest/apiFlow.ts:77,132,208`, `src/ingest/run.ts:341-357,621-625`,
  `src/provenance/origin.ts`, `tests/provenance/adapterOrigins.test.ts:39-62`
- Test: `tests/ingest/rpc.test.ts`, `tests/ingest/run.apiFlows.test.ts`, `tests/provenance/adapterOrigins.test.ts`

**Interfaces:**
- Produces on `RpcTransport` (optional members; viemRpc implements both):
  - `multicallData?(calls: { address: string; data: `0x${string}` }[], blockNumber: bigint, opts?: { chunk?: number }):
    Promise<({ ok: true; data: `0x${string}` } | { ok: false; error: string })[]>` — Multicall3 `aggregate3`,
    `allowFailure`, chunked (default **400** inner calls per eth_call), each chunk its own request under the 20 s timeout.
  - `getLogs?(q: { address: string[]; topic0: string; fromBlock: bigint; toBlock: bigint }): Promise<(ReceiptLog & {
    blockNumber: bigint })[]>` — splits the range at the chain's `maxLogRange`, and halves a range on a provider
    "too many results / range" error (≤ 8 halvings, then throws).
- `fakeRpc` gains `dataCalls?: (address: string, data: string, block: bigint) => string | null` and `logs?: (q) => …`;
  `stats.multicallData`, `stats.getLogs` counters.
- `SourceContext.storedFlowDays?: (metricKey: string) => Promise<Set<string>>` — active stored days of the run's own
  series for that metric (the query `apiFlow.ts:77` uses).
- `SourceValue` `daily_series` gains `warnings?: AdapterWarning[]`, `AdapterWarning = { dedupeKey: string; detail:
  Record<string, unknown> }`; run.ts raises each as `{ kind: 'cross_check_mismatch', severity: 'advisory', metricKey,
  dedupeKey }` once per run per key.
- Origin fix: the series writer's origin = `originOf(fetchedProvenance(source))` (`'onchain'` for a `pool_scan` adapter,
  `'api'` for every existing adapter), used for the stamp, the stored-day filter and `findFlowConflicts`; run.ts:621
  counts an adapter input as `api` only when its origin is `api`.

- [ ] **Step 1: Failing tests.**
  - `'multicallData chunks 1000 calls into 3 eth_calls and keeps order'`; `'a failed inner call is reported in its slot'`.
  - `'getLogs splits 25,000 blocks at Ink maxLogRange 10,000 into 3 requests'`; `'getLogs halves on a range error'`.
  - `run.apiFlows`: `'a pool_scan series stamps onchain, reads its own rows back as stored, and does not conflict'`
    (second identical run writes 0 rows); `'adapter warnings raise one advisory cross_check_mismatch each, deduped'`;
    `'storedFlowDays returns the active days of the series'`.
  - `adapterOrigins`: every registered adapter's stamp equals `originOf` of its provenance (unchanged for existing ones).
- [ ] **Step 2: Run; they fail.**
- [ ] **Step 3: Implement** the four pieces; existing adapters' behaviour unchanged.
- [ ] **Step 4: Full suite + typecheck green; goldens unchanged.**
- [ ] **Step 5: Commit** `feat(ingest): multicallData, getLogs, storedFlowDays, adapter warnings, series origin from provenance (<T2 ID>)`.

### Task 3: Report: `onchain_usd`, below-line `started` and `in_holder_flow`, window label, growth guard — RET-198

**Files:**
- Modify: `src/db/prices.ts:218-245` (`PriceBasis`, `listFlowUsd`), `src/report/incomeStatement.ts` (:42 basis doc,
  :354-375 fill, :508-518 basis, :550-552, the statement output), `src/report/holderYield.ts:137-156` (`growthOf`),
  `src/config/incomeStatement.ts:89-103,246-248` (schema), the report text renderer that prints the statement header
- Test: `tests/report/revenueStreams.test.ts`, `tests/report/incomeStatement.test.ts`, `tests/report/v2Golden.test.ts`

**Interfaces:**
- `PriceBasis` adds `'onchain_usd'`: a row whose stored `source_type` is `pool_scan` and has no token columns.
- below_line `metric` lines accept `started: YYYY-MM-DD` (same validation as revenue: only with `metric`); the same
  zero-fill before `started` and `youngWeight` run rate apply. below_line lines accept `in_holder_flow: false` (default
  true; requires `note`): the line is rendered but excluded from `holderFlow.gross/net` and every yield. The key is
  optional with no default written, so no other asset's config hash moves.
- Statement JSON gains `window: { windowDays: number; daysMeasured: number; since: string | null }` (`daysMeasured` =
  min over measured lines of their own measured days; `since` = latest `started` among lines, null when none). Text
  render: `window: 36 of 91 days (since 2026-10-22)` only when `daysMeasured < windowDays`; nothing otherwise.
- Growth guard: `growthOf` returns `{ change: null, annualized: null, note: 'not meaningful: the prior window starts
  before <since>' }` when any contributing line's `started` is after the prior window's first day.

- [ ] **Step 1: Failing tests.**
  - `'a pool_scan row without token columns has priceBasis onchain_usd'`.
  - `'below-line started zero-fills and annualizes over its own days; holder flow stays non-null'` (fixture: 36 days).
  - `'in_holder_flow false is rendered and excluded from holder flow and yields'`; `'in_holder_flow without note is refused'`.
  - `'window reads 36 of 91 days since 2026-10-22'`; `'no window line when every line has full history'`.
  - `'growth is not meaningful while the prior window starts before started'` at started+120 days (prior partly filled:
    today's code prints a finite number; the test asserts null + note); `'growth is computed once both windows are
    after started'` at started+182.
  - `v2Golden`: the 12 non-AERO entries byte-identical (AERO is re-pinned in Task 8, not here).
- [ ] **Step 2: Run; they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Full suite + typecheck green; non-AERO goldens unchanged.**
- [ ] **Step 5: Commit** `feat(report): onchain_usd basis, below-line started, window label, growth guard (<T3 ID>)`.

### Task 4: `poolscan` engine: day blocks, pools, gross, allocator, drift — RET-199

**Files:**
- Create: `src/ingest/poolscan/types.ts`, `src/ingest/poolscan/abi.ts`, `src/ingest/poolscan/reader.ts`,
  `src/ingest/poolscan/scan.ts`
- Test: `tests/ingest/poolscan/scan.test.ts`, fixtures `tests/fixtures/poolscan/` (trimmed from scoping
  `raw/2026-11-26_<chain>.json`: Base ≤ 40 pools incl. the top 10 by fees, 2 unregistered, 1 mid-day pool; Arc incl. 3
  Lite pools; Ink with a log range > 10,000 blocks)

**Interfaces:**
- `ScanConfig` (zod, from adapter params): `{ chains: ChainScan[]; subsidy_creators: string[]; root_voter?: { chain_id:
  8453; address: string } }`, `ChainScan = { chain_id: number; factories: { address: string; kind: 'v2_stable' |
  'v2_volatile' | 'cl' ; tape: string; hook?: string }[]; factory_registry: string; leaf_voter: string;
  anchors: Anchor[]; log_range?: number }` (Anchor in Task 5).
- `ChainReader` (`reader.ts`): `{ chainId; blockAt(tsSec): Promise<BlockRef>; call<T>(calls: TypedCall[], block):
  Promise<(T | null)[]>; logs(address[], topic0, from, to): Promise<Log[]> }` over `RpcTransport` (viem
  `encodeFunctionData` / `decodeFunctionResult` on `multicallData`). Tests fake `ChainReader` directly.
- `scanChainDay(reader: ChainReader, cfg: ChainScan, day: string): Promise<ChainDayScan>` with `ChainDayScan = {
  chainId; day; blocks: { s: bigint; e: bigint }; pools: PoolFees[]; counts: { pools; registered; gauged };
  allocatorByPool: Map<string, TokenAmounts>; drift: Drift[]; rpc: { calls; requests; logs } }`,
  `PoolFees = { pool; factory; token0; token1; fee0: bigint; fee1: bigint; registered: boolean }`.
- Method (spec §4.1, scoping `onchain-revenue.md` §3-§6 and `scripts/measure.py`, `poolenum.py`):
  gross = `accumulators(pool)` at `e−1` minus at `s−1` (absent at `s−1` → 0); registration from the tape; allocator =
  Δ raw pending (CL `pool.gaugeFees()`, V2 `pool.pendingFees(gauge)`) + Σ VRM `FeesCollected` in `[s, e−1]`; drift =
  factory `poolTape()`/`clPoolTape()` ≠ config tape, CL `getPoolSwapHook(pool)` ≠ config hook, a FactoryRegistry
  factory not in config, a gauge on an unregistered pool, root `Voter.chains()` ≠ configured ids.

- [ ] **Step 1: Failing tests** (fixtures; numbers are the scoping values for 2026-11-26):
  - `'Base fixture gross per pool equals the scoping raw deltas'`; `'reads at s-1 and e-1'` (asserts block args).
  - `'a pool absent at s-1 contributes its whole e-1 accumulator'` (Review Focus 1).
  - `'unregistered pools are counted, excluded from gross, listed'`; `'a gauged unregistered pool raises drift'`.
  - `'Arc Lite pools read the Lite tape named by their factory'`.
  - `'allocator = delta pending + FeesCollected; never negative per pool'`.
  - `'Ink logs over 25,000 blocks take 3 requests'`; `'root chains() with 9 ids raises drift chain:<id>'`.
- [ ] **Step 2: Run; they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Tests + typecheck green.**
- [ ] **Step 5: Commit** `feat(poolscan): day scan engine (<T4 ID>)`.

### Task 5: `poolscan` pricing — RET-200

**Files:**
- Create: `src/ingest/poolscan/pricing.ts`
- Test: `tests/ingest/poolscan/pricing.test.ts` (fixtures from scoping `raw/2026-11-26_*.json` reserves/slot0/TWAP
  ticks and `anchors-chainlink.json`)

**Interfaces:**
- `Anchor = { token: string; feed: string; description: string; feed_chain_id?: number }` (`feed_chain_id` 8453 for
  Elysium's three; the feed is read on Base at `firstBlockAtOrAfter(Base, ts(e−1))`).
- `priceDay(readers: Map<number, ChainReader>, cfg: ChainScan, scan: ChainDayScan, opts?: { floorUsd = 10_000; maxHops
  = 3; twapSec = 1800; feedMaxAgeSec = 93_600 }): Promise<PriceBook>`; `PriceBook = { usd: Map<token, number>; how:
  Map<token, 'anchor' | 'graph' | 'graph_spot_fallback'>; fallback(pool, token): number | null; anchorsDropped: string[] }`.
- `valueScan(scan, book) → { grossUsd; allocatorUsd; lpUsd; pricedPct; unpriced: { token; amount; pool }[] }`
  (fees priced by anchor, graph or the own-pool fallback count as priced). `pricedPct` = 100 × priced USD / (priced USD
  + `coverageEstimateUsd`), where `coverageEstimateUsd` values the still-unpriced fees with the same graph run with
  floor 0 and up to 6 hops (used for coverage only, never stored as value); fees no floorless path reaches count 0 and
  are listed with their token amounts.
- Anchor load check: `description()` must equal the configured string, else the run fails (`anchor_feed_mismatch`).

- [ ] **Step 1: Failing tests.**
  - `'only configured anchor addresses are anchors: the five other Base USDCs and the spoof LINK are graph-priced'`
    (Review Focus 2).
  - `'a CL edge uses the 30-min TWAP; spot only when observations are short, flagged spot_fallback'`.
  - `'a V2 stable pool uses the stable curve from its factory'` (msUSD/OP fixture: within 0.5% of the scoping price,
    not 52% off).
  - `'an edge whose priced side holds under $10K is not used'`; `'a 4-hop token is unpriced'`.
  - `'own-pool fallback prices only that pool'`; `'a feed older than 26 h drops its anchor'`.
  - `'Elysium anchors read Base feeds at the Base block for Elysium e-1'`.
  - `'2026-11-26 Base fixture: grossUsd within 0.1% of the scoping 241,793'`.
- [ ] **Step 2: Run; they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Tests + typecheck green.**
- [ ] **Step 5: Commit** `feat(poolscan): on-chain price graph (<T5 ID>)`.

### Task 6: `poolscan` incentives — RET-201

**Files:**
- Create: `src/ingest/poolscan/incentives.ts`
- Test: `tests/ingest/poolscan/incentives.test.ts` (fixtures from `incentives-data/programs.json`,
  `zero_supply_cum.json`, `discovery.json`)

**Interfaces:**
- `discoverVrms(reader, cfg): Promise<string[]>` — LeafVoter → FactoryRegistry → gauge factories → `factoryToGauges` →
  `votingRewardsManager()` (state only).
- `programs(reader, vrms, block): Promise<Program[]>` — `incentiveCount()`, `incentive(id)`; `Program = { vrm; id;
  token; rate: bigint; start: number; end: number; creator: string }`. Read once per run at the run's latest scanned day.
- `streamedDay(reader, programs, day, blocks): Promise<{ byClass: Record<'vote_incentives' | 'protocol_subsidy',
  TokenAmounts>; programsActive: number }>` — per program `rate × (overlap(D) − zeroAllocSeconds(vrm, D))`, with
  zero-allocation seconds from `getPriorSupplyIndex` / `globalRewardPointHistory(idx).zeroSupplySeconds` as
  `incentives-and-events.md` §2 describes; class = `protocol_subsidy` iff creator ∈ `subsidy_creators`.

- [ ] **Step 1: Failing tests.**
  - `'a program spanning midnight splits by overlap'`; `'zero-allocation seconds are excluded'` (OP 0x5c1e… USDC
    program: allocator-earned 0 for its zero-allocation day) (Review Focus 3).
  - `'creator 0x7269… and 0x42255… book protocol_subsidy; 0x80f7… books vote_incentives'`.
  - `'discovery by state finds the scoping VRM count per chain'` (fixture counts: Base 321, OP 32, …).
  - `'2026-11-26: vote_incentives and protocol_subsidy token amounts equal incentives-data/daily.json'`.
- [ ] **Step 2: Run; they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Tests + typecheck green.**
- [ ] **Step 5: Commit** `feat(poolscan): VRM incentive streams (<T6 ID>)`.

### Task 7: Adapters `pool.tape_fees_daily` and `pool.vrm_incentives_daily` — RET-202

**Files:**
- Create: `src/ingest/adapters/pool.ts`
- Modify: `src/ingest/adapters/registry.ts:80`, `src/report/sourceTypes.ts:31-63` (`pool_scan` for both),
  `tools/sources-register/generate.ts:82-119` (`ADAPTER_ENDPOINTS`: one rpc endpoint per chain env), regenerate
  `docs/ops/sources-register.md`
- Test: `tests/ingest/adapters.pool.test.ts`, `tests/provenance/adapterOrigins.test.ts`

**Interfaces:**
- Params (validated by `validateParams`; `paramsDoc` written): `pool.tape_fees_daily { scan: ScanConfig; field:
  'gross' | 'allocator' | 'lp'; max_scan_days?: number (default 7, max 14) }`; `pool.vrm_incentives_daily { scan:
  ScanConfig; class: 'vote_incentives' | 'protocol_subsidy'; max_scan_days? }`.
- Days scanned per run: `D = revision days (yesterday, −1, −2) ∪ (days in [today − backfillDays, yesterday] missing from
  storedFlowDays(metric))`, then the oldest `max_scan_days` of D; detail records `remaining_missing: n`. Without
  `backfillDays` the missing-days set is limited to the asset's `ingest.backfill_days` window as today.
- Memo: one `Map` per `SourceContext` (a `WeakMap<SourceContext, …>`) keyed `hash(scan) + chain + day`; the five
  metrics of one run cost one scan per chain-day.
- Return: `daily_series` USD, no `token` (→ `onchain_usd`), `slice` per point = `{ chains: { [id]: { s, e, grossUsd,
  allocatorUsd, pricedPct, unpricedUsd } } }`, `warnings` for drift and 95-99% coverage. Fail (`ok: false`) per the
  Global Constraints.

- [ ] **Step 1: Failing tests** (fake `ChainReader`s for 2 chains):
  - `'five metrics in one run scan each chain-day once'` (stats).
  - `'routine run scans the 3 revision days only'`; `'a backfill of 40 missing days scans the oldest 7 and reports
    remaining_missing 33'`; `'the next run scans the next 7'` (Review Focus 4).
  - `'coverage 94.9% on one chain fails the run; 97% writes and warns'`.
  - `'allocator over gross by 0.6% and $2 fails; by 0.4% writes'`.
  - `'an RPC failure on any chain fails the run; nothing is written'`.
  - `'lp = gross - allocator per day'`; `adapterOrigins` covers both adapters as `onchain`.
  - `validateParams` refuses: unknown chain id, an anchor without `description`, a duplicate factory, `max_scan_days 30`.
- [ ] **Step 2: Run; they fail.**
- [ ] **Step 3: Implement**; regenerate the register.
- [ ] **Step 4: Full suite + typecheck green.**
- [ ] **Step 5: Commit** `feat(adapters): pool.tape_fees_daily, pool.vrm_incentives_daily (<T7 ID>)`.

### Task 8: AERO config and the re-pins — RET-203

**Files:**
- Modify: `assets/aero.yaml`
- Modify: `tests/assets/aero.ingest.test.ts` (plan batches, drop the `api.llama.fi` fake, hash pin :101),
  `tests/config/load.test.ts:367`, `tests/agent/packGolden.test.ts:93`, `tests/report/v2Golden.test.ts` +
  `golden/v2-report-13.json` (AERO entries only), `tests/assets/r1-third-party.test.ts` (stays green)

**Interfaces:**
- One YAML anchor `&aero_scan` holding the `ScanConfig` (8 chains; addresses from spec §11 and
  `anchors-chainlink.json`; Arc carries its Lite CL factory with tape `0x967f5352A6448e22D7361E149103350c49345Ee9` and
  hook `0xaAf164008441F112eB2858d9F7A2dB1B84b1E415`; `subsidy_creators: [0x7269…9dDb, 0x42255…4ce0]` full addresses
  from the spec); each metric's `params.scan: *aero_scan`. Every address has a comment naming its scoping file.
- Metrics: `flow_usd.voter_fees` (critical, `field: allocator`), `flow_usd.lp_fees` (`lp`), `flow_usd.pool_fees_gross`
  (`gross`, monitor_only), `flow_usd.vote_incentives`, `flow_usd.protocol_subsidy`; all `type: flow`, `unit: usd`,
  `cadence: daily`, `staleness_days: 3`. `flow_usd.fees` and the DefiLlama comments removed.
- Income statement exactly as spec §5: `scope: complete`; revenue `voter_rev`, `lp_rev`; cost `lp_fees { to: lps, of:
  lp_rev }`; holders `voter_fees { of: voter_rev, bucket: cash, haircut: 0.02, recipient_base: locked, capture_rule:
  contractual }`; below_line `vote_incentives { metric: flow_usd.vote_incentives, to: holders, bucket: cash, haircut:
  0.03, recipient_base: locked, capture_rule: programmatic, started: 2026-10-22 }`, `protocol_subsidy { metric:
  flow_usd.protocol_subsidy, to: holders, in_holder_flow: false, note: "Aero Foundation TGE wallet and governance multisig
  programs: Aero's own money recycled", started: 2026-10-22 }`; all revenue lines
  `started: 2026-10-22`; dilution lines unchanged; checks: none new (bound/coverage/drift live in the adapter).

- [ ] **Step 1: Write the config; run the AERO tests; they fail on the pins.**
- [ ] **Step 2: Re-pin on purpose** (each pin's new value in the commit message): config hash ×2, packGolden holder-flow
  metrics `['flow_usd.voter_fees','flow_usd.vote_incentives']`, v2 golden AERO entries. Diff `golden/v2-report-13.json`:
  only AERO keys move.
- [ ] **Step 3: Full suite + typecheck green;** `grep -n 'defillama\|llama' assets/aero.yaml` shows only
  `external_ids.defillama`.
- [ ] **Step 4: Commit** `feat(aero): revenue on chain via pool_scan; flow_usd.fees retired (<T8 ID>)`.

### Task 9: Live golden, backfill runner, release docs — RET-204

**Files:**
- Create: `tests/live/aeroPoolScan.live.test.ts` (skipped unless `ORION_LIVE_RPC=1`), `tools/phase3-proof/r4-backfill.sh`,
  `tools/phase3-proof/r4_acceptance.py` (dev-only DL reference, offline, reads a saved JSON), `tools/phase3-proof/r4-allowlist.json`
- Modify: `docs/ops/deploy.md` (the six env vars), `docs/superpowers/notes/2026-11-12-orion-phase3-followups.md` (R4
  items closed/carried), spec Status line, `tools/phase3-proof/README.md` (R4 class)

**Interfaces:**
- Live test: re-reads 2026-11-26 for all 8 chains through the adapters; asserts per-chain gross, allocator and
  incentives within 0.5% of `onchain-revenue-data/summary-table.json` / `incentives-data/daily.json` (copied into
  `tests/fixtures/poolscan/live-2026-11-26.json`).
- `r4-backfill.sh <env>`: purge export + `data purge aero --metric flow_usd.fees` (dry run, then `--yes` on a prompt),
  then loops `job run-now backfill aero` with `--metric` repeated for all five new metrics and `--backfill-days <days
  since 2026-10-22>`, ceil(missing / 7) + 1 times, waiting for each job; then verifies over `sql-ro` that every metric
  has one active row for every day 2026-10-22 → yesterday; refuses to start inside the backfill gate; prints each
  chunk's days.
- `r4_acceptance.py <orion report json> <dl-devref json>`: per day 10-23 → D, `voter_fees + vote_incentives +
  protocol_subsidy` vs DL holders revenue (stamp D+1 = day D), fails on any |gap| > 3%; 10-22 exempt.
- `r4-allowlist.json`: AERO paths only, signed values filled by the controller in Task 10.

- [ ] **Step 1: Write the live test; run it once with the controller's env** (controller-only step; implementers skip).
- [ ] **Step 2: Scripts with `--fake` fixtures and `python3 -m unittest` tests in `tools/phase3-proof/test_r4.py`.**
- [ ] **Step 3: Docs.**
- [ ] **Step 4: Full suite + typecheck green.**
- [ ] **Step 5: Commit** `tools/docs(r4): live golden, backfill runner, acceptance, deploy notes (<T9 ID>)`.

### Task 10: Proof on a prod copy and the sign-off table (controller) — RET-205

**Files:**
- Create: `~/.hermes/profiles/raymond/workspace/orion/phase3-r4-sdd/proof/` (outputs), fill `tools/phase3-proof/r4-allowlist.json`

- [ ] **Step 1:** `tools/phase2-proof/prod_copy.py` → `p2proof_*` schema; run old (`orion-2026.11.21.1`) vs new reports
  for day D on the copy (the new one after a purge + backfill on the copy, RPC live, outside the forbidden windows).
- [ ] **Step 2:** `flatdiff.py` for the 12 untouched assets: zero differences. AERO: before/after table (revenue, gross
  profit, holder flow gross/net, below-line lines, window label, growth note, priceBasis `onchain_usd`).
- [ ] **Step 3:** `r4_acceptance.py` on the backfilled days against a saved DefiLlama dev-only pull: every day 10-23 → D
  within ±3%.
- [ ] **Step 4:** Post the sign-off table to RET-20 and stop for Mike: env vars on stage → stage rollout (purge, deploy,
  backfill) → one soak nightly (no failed sources, coverage ≥ 99% all chains) → Mike's go → prod → tag, push (HTTPS).

## Self-review notes

- Spec coverage: §4.1 → T4; §4.2 → T7; §4.3 → T5; §4.4 → T1-T3; §5 → T8; §6 → T9 (`r4-backfill.sh`) + T10; §7 → T7
  (fail/warn) + T2 (warnings); §8 → T3-T9; §9 → T9-T10; §11 → T8.
- The spec's "coverage check" and "bound check" are enforced inside the adapter (T7) rather than as
  `income_statement.checks`: the existing `sum`/`coverage` check types compare window sums with a symmetric tolerance,
  which cannot express a one-sided bound or a per-chain coverage floor. Drift and coverage warnings reach #orion-ops as
  advisory `cross_check_mismatch` anomalies (no new anomaly kind → no migration).
- Spec §5 said each line is `started`; cost and holder lines inherit their `started` through `of` (CRV's shape), so only
  revenue and below-line lines carry the key.
- Backfill chunks are runs of one backfill job capped by `max_scan_days`, resumed from stored days (T7); a lost lease
  loses at most one chunk.
