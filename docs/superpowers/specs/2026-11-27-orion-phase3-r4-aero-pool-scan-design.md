# Orion Phase 3 R4: AERO revenue on chain (`pool_scan` pilot) — design

Linear: RET-20

Status: Built on ret-20-aero-pool-scan (T1-T9); proof and rollout pending (T10).
Design approved section by section by Mike in the RET-20 thread, 2026-11-27 (Q1-Q5, sections 1-4); plan
`docs/superpowers/plans/2026-11-27-orion-phase3-r4-aero-pool-scan.md`.

Parent: Phase 3 spec `2026-11-09-orion-phase3-third-party-removal-design.md` §4 (AERO), §5 (R4), D6/D8. This document
supersedes §4's AERO line where they differ (8 chains, revenue scope, incentive booking).

Scoping (2026-11-27, read-only; MEASURED = block/tx/call cited, CLAIMED = URL quoted, DEV-REF = DefiLlama/CoinGecko used
only as a dev-time reference and never by live code), in `~/.hermes/profiles/raymond/workspace/orion/phase3-r4-scoping/`:
`code-and-data.md` (code plumbing, file:line), `onchain-revenue.md` + `onchain-revenue-data/` (tape fees, allocator,
pricing, 45 chain-days), `incentives-and-events.md` + `incentives-data/` (VRM programs, events). Controller checks are in
`workspace/orion/phase3-r4-sdd/ledger.md`.

## 1. Goal

Replace AERO's DefiLlama revenue series (`flow_usd.fees`, `defillama` slug `aerodrome`, `dailyHoldersRevenue`) with
Orion's own on-chain read. No live Orion code reads DefiLlama or CoinGecko after R4 for AERO, including prices.

Success:
- AERO's income statement is built only from on-chain reads on the 8 Aero chains, priced on chain.
- From 2026-10-23 on, allocator fees + allocator-earned incentives match DefiLlama's holders revenue within ±3% on every
  day (DEV-REF, offline acceptance only; scoping saw −2.4%…+2.3% per chain-day).
- The 12 other assets are byte-identical on a read-only prod copy (flatdiff).
- Coverage is stated per chain per day, and protocol drift (a new chain, tape, hook or factory) warns instead of silently
  undercounting.

## 2. Decisions (Mike, RET-20 thread, 2026-11-27)

| # | question | decision |
|---|---|---|
| Q1 | what revenue means | **Gross pool fees** (tape). LP share is a cost line; holders get the allocator fees; incentives below the line. Matches v2 "revenue = what users pay" and CRV (vote incentives below the line). |
| Q2 | coverage | **All 8 chains now** (Base, Ethereum, OP, Arbitrum, Ink, Robinhood, Arc, Elysium), Elysium anchored on Base's Chainlink USDC/HYPE/BTC feeds; **Arc Lite** pools included through their own tapes, read per factory. |
| Q3 | incentive booking | Two below-line lines keyed on the program creator (reviewed list in config): **`vote_incentives`** = third parties + Safe 0x80f7 issuer-token programs (to holders, cash, haircut); **`protocol_subsidy`** = Foundation TGE 0x7269 + governance multisig 0x42255 (shown, not holder flow). |
| Q4 | pricing | Chainlink anchors (reviewed token addresses; tokenized-stock feeds excluded) → deepest-pool graph, **30-min TWAP on CL edges, spot on V2 edges**, priced-side depth ≥ **$10K**, ≤ **3 hops** → own-pool fallback → **unpriced** (reported, never imputed). |
| Q5 | short history | Run rate over measured days labelled **"N of 91 days"**; growth **"not meaningful"** until a full 91-day prior window exists (~2027-04-22). |
| S1 | architecture | One shared, memoized scan per (chain, UTC day); every AERO metric reads its field from it. New metric keys. |
| S2 | statement | As §5. |
| S3 | history/errors | As §6/§7, with the check correction (allocator ≤ gross bound replaces voter + lp = gross). |
| S4 | testing/rollout | As §8/§9. |

Controller decisions inside that frame (low stakes, flagged for the spec review): new metric keys (scoping O2); price
basis label `onchain_usd` (O3); `started` on below-line lines (O5); 7-day backfill chunks (O8); coverage in `detail` +
a coverage check (O9); vote-incentive haircut 3% (CRV's figure).

## 3. What is measured (scoping summary)

- **Gross fees.** `PoolTape.accumulators(pool)` (V2) / `CLPoolTape.accumulators(pool)` (CL) are per-pool cumulative fee
  counters in token units. Gross for day D = accumulator at the last block of D minus at the last block of D−1. MEASURED:
  one-hour Base spot check (11-26 12Z, 718 registered pools): V2 tape == `Fees` events to the wei; CL tape == Swap-derived
  fees except ±1 swap in 8 pools (block-boundary convention). CL fees are recorded by the pool's swap hook
  (DynamicSwapFeeHook), are the total swap fee before the staked/unstaked/gauge split, and include the MEV fee ($0-83/day).
- **Registration.** A pool reaches the tape only once the tape owner registers it; unregistered pools are dropped silently.
  MEASURED 11-26: 516 unregistered pools across 8 chains (345 on Base), one gauged (Ethereum), ~$105/day of fees (0.04%).
- **Allocator share** (what sAERO allocators earn) = Δ raw pending (CL `pool.gaugeFees()`, V2 `pool.pendingFees(gauge)`)
  + Σ VRM `FeesCollected` over the day. One `eth_getLogs` per chain-day (address = all VRMs, topic0 only; Ink needs
  chunks for its 10,000-block cap). No state-only method works (the tested one was off by 10³-10¹⁷× near-zero voting
  supply). MEASURED: allocator / gross 88.5-95.2% per day; no negative per-pool accrual on any chain-day.
- **Incentives.** VRM `incentive(id)` programs are immutable streams (token, amount, rate, start, end, creator). Allocator
  -earned stream for day D = rate × (overlap(D) − zero-allocation seconds in D), from VRM state. MEASURED: 596 VRMs, 327
  programs; `sweptAmount` 0 on all; $5.84 of $490K streamed during zero allocation. 10-22..11-26: $490K (TGE 0x7269 $220K,
  ended 10-29; 0x42255 $90K, ended 11-09; 0x80f7 $59K; third parties $121K). 11-13..11-26 average $4.1K/day.
- **Chains.** MEASURED by the controller: Base root Voter 0x49d7d4f17Ec56Ef8fA04E464AF5D1A4942CC31e6 `chains()` =
  [8453, 10, 1, 42161, 57073, 4663, 5042, 99901]; Alchemy `elysium-mainnet` answers chainId 99901. Archive reads at the
  2026-10-22 00:00Z block worked on all chains.
- **Pricing (Q4 method).** 99.99% of fee value priced over 45 chain-days; chain-day totals −0.2%…+0.6% vs DEV-REF
  (Robinhood up to +3.6%); top-30 tokens fee-weighted error 0.14%, AERO ≤ 1.04%. TWAP vs spot ≤ 0.05% on totals.
  Pitfalls: Base has six tokens named "USDC" and a spoof "LINK" (anchors are addresses, never symbols); Chainlink
  tokenized-stock feeds were 48-52 h stale and 3-17% off over weekends/holidays; `stable()` reverts on stable pools, so the
  curve comes from the creating factory.
- **Cost (MEASURED).** All 8 chains, one day: ~127 Multicall3 eth_calls (~21K inner reads), ~17 eth_getLogs, ~77 HTTP
  requests, ~52 s; incentives add ~80 requests. Backfill 10-22 → release (~40 days): ~40 min. No throttling.
- **Events.** No tape/factory change since launch; no dromos-labs commit since 11-04; legacy-gauge reactivation not
  happened (0 of 2,013 Base / 846 OP legacy gauges alive); one Arc Lite pool has a gauge, not activated. Safe 0x80f7
  received 4.2M GEN on 2026-11-27 (a GEN program is likely soon; it books as `vote_incentives`).

## 4. Architecture

### 4.1 Engine: `src/ingest/poolscan/`
Asset-agnostic. Config names contracts; nothing Aero-specific is hard-coded beyond ABIs.

For each configured chain and UTC day D:
1. **Day blocks.** `s` = first block with timestamp ≥ D 00:00Z, `e` = first block ≥ D+1 00:00Z, via the existing
   timestamp search (Base's 2 s → 0.2 s change: never block-time arithmetic). Reads are at `s−1` and `e−1` (a call at
   block N returns the state after N).
2. **Pools.** For each factory in the chain's FactoryRegistry (V2 stable/volatile, CL, Arc Lite CL/V2): `allPoolsLength`
   and `allPools(i)` at `e−1`; the factory's own `poolTape()` / `clPoolTape()`; per CL pool the swap hook
   (`getPoolSwapHook`). Pools absent at `s−1` start at 0.
3. **Gross.** `accumulators(pool)` at `s−1` and `e−1`; delta per token. Unregistered pools: fee estimate from reserves is
   NOT computed; they are counted and listed in detail (0.04%), and a gauged unregistered pool raises drift.
4. **Allocator.** Gauge per pool (`factoryToGauges` / `gaugeToTarget`), raw pending at both blocks, `FeesCollected` logs
   for the VRMs over `[s, e−1]`, chunked to the chain's log-range limit.
5. **Incentives.** VRM discovery from state (LeafVoter → FactoryRegistry → gauge factories → `votingRewardsManager()`),
   programs read once and cached per run; per program per day the allocator-earned stream, classed by creator.
6. **Prices** (§4.3) at `e−1` for every token with a non-zero amount.
7. **Result** per (chain, day): gross/allocator/lp/incentive USD by class, per-token amounts and prices, coverage %, counts
   (pools, registered, gauged, VRMs, programs), drift flags, RPC cost. LP = gross − allocator, per pool.

Memoized on the run's `SourceContext`, keyed by (params minus `field`, chain, day): the five metrics cost one scan.

### 4.2 Adapters (`src/ingest/adapters/pool.ts`, source-type rung `pool_scan`)
- `pool.tape_fees_daily` — params: `scan` (named scan block in the asset yaml), `field: gross | allocator | lp`,
  `days?` (default 3, the revision window). Returns USD per day, summed over chains; ≥ 1 day every run.
- `pool.vrm_incentives_daily` — params: `scan`, `class: vote_incentives | protocol_subsidy`. Creator lists live in the
  scan block (`subsidy_creators: [0x7269…, 0x42255…]`; everything else = `vote_incentives`).
- Both: `validateParams` / `paramsDoc`; `ADAPTER_SOURCE_TYPES` rung `pool_scan` → provenance `onchain`;
  `ADAPTER_ENDPOINTS` in `tools/sources-register/generate.ts`, regenerated `docs/ops/sources-register.md`.

### 4.3 Pricing (`src/ingest/poolscan/pricing.ts`)
1. **Anchors.** A reviewed list per chain of (token address → Chainlink USD feed proxy), `description()` asserted at load
   and on each run. Tokenized-stock feeds are never anchors. Elysium: USDC/WHYPE/UBTC → Base's USDC/USD, HYPE/USD, BTC/USD
   feeds, read on Base at the Base block nearest Elysium's `e−1` timestamp. Feed staleness > 26 h fails that anchor.
2. **Graph.** For each unpriced token, the deepest Aero pool against an already-priced token whose priced-side balance is
   ≥ $10K; ≤ 3 hops. CL edges use the 30-min TWAP (`observe`) ending at `e−1`, falling back to slot0 spot only when the
   pool lacks the observation cardinality (flagged); V2 edges use reserves at `e−1` with the curve from the creating
   factory (stable vs volatile; never `stable()`).
3. **Own-pool fallback.** A token still unpriced is valued, for that pool's fees only, at that pool's price against its
   priced side.
4. **Unpriced.** Anything left is unpriced: excluded from USD, counted in coverage, listed in detail.

AERO itself is priced by step 2 through AERO/USDC on Base, consistent with `chain.v2_pool_twap_price`.

### 4.4 Core changes
- **Chains** (`src/ingest/transport/chains.ts`, `viemRpc.ts`): rows for OP 10, Arbitrum 42161, Ink 57073, Robinhood 4663,
  Arc 5042, Elysium 99901 (ids and block times MEASURED with `eth_chainId` and a 1-day block span before pinning), log
  range limits (Ink 10,000), confirmations. Env vars `ORION_<CHAIN>_RPC_URL`; the price-deps map becomes `CHAIN_RPC_ENV`.
  No per-metric RPC setting: the adapter reaches other chains through `ctx.priceDeps.rpcFor`.
- **Origin fix**: the series writer (`apiFlow.ts:208`) and `run.ts:621` assume adapter rows are `api`; `pool_scan` rows
  are `onchain`. The writer takes the origin from the adapter's source type, so it no longer treats its own rows as
  foreign.
- **Price basis** `onchain_usd`: USD computed by the adapter from on-chain prices. Report label only (TypeScript; no
  migration).
- **Chunked multicall**: `readAll`/`readAt` gain chunking (default 400 inner calls) and a struct-return decode, each chunk
  under the 20 s request timeout.
- **`started` on below-line lines**, with the same zero-fill and short-window annualizing as revenue lines; and
  **`in_holder_flow: false`** on a below-line line (default true; requires a `note`): shown in the statement, left out
  of holder flow gross/net and yields.
- **Window label and growth** (Q5), opt-in by a statement key `history_start: YYYY-MM-DD` (AERO sets 2026-10-22;
  HYPE and PUMP opt in at R5/R6). With it, the statement carries `window: { windowDays, daysMeasured, since }`
  rendered "N of 91 days", and every growth figure is `not meaningful` until the prior window starts on or after
  `history_start`. Without it the statement is unchanged. (Ruling 2026-11-27 during the build: keying the guard on
  every line's `started` moved HYPE's and LIT's published growth and PEG, whose single young lines sit inside full
  histories; their `growthExNew` already handles that.)

## 5. AERO income statement (`assets/aero.yaml`)

`scope` changes from `protocol_share_only` to `complete` (every fee users pay is now measured; the schema's scopes are
`complete | protocol_share_only | partial`). Revenue and below-line lines carry `started: 2026-10-22`; cost and holder
lines inherit it through `of`.

| section | id | source | treatment |
|---|---|---|---|
| revenue | `voter_rev` | `flow_usd.voter_fees` (critical) | pool fees to sAERO allocators |
| revenue | `lp_rev` | `flow_usd.lp_fees` | pool fees kept by LPs (unstaked V2, ungauged, Arc Lite) |
| cost_of_revenue | `lp_fees` | of `lp_rev`, share 1 | |
| holders | `voter_fees` | of `voter_rev` | cash, haircut 2% (unchanged), recipient_base locked, capture_rule contractual |
| below_line | `vote_incentives` | `flow_usd.vote_incentives` | to holders, cash, haircut 3%, recipient_base locked, capture_rule programmatic |
| below_line | `protocol_subsidy` | `flow_usd.protocol_subsidy` | `to: holders`, `in_holder_flow: false`: Aero's own money recycled (0x7269, 0x42255); shown, not holder flow |
| dilution | `aero_upgrade`, `velo_upgrade` | unchanged | |

Two revenue lines instead of gross − cost metric: the zero-fill before `started` and the short-window annualizing apply
to revenue lines, and unreconciled stays exactly 0 (CRV's shape).

Metrics: `flow_usd.voter_fees`, `flow_usd.lp_fees`, `flow_usd.pool_fees_gross` (monitor-only, feeds the bound check),
`flow_usd.vote_incentives`, `flow_usd.protocol_subsidy`; all `flow` / `usd` / daily / `pool.*`. Removed:
`flow_usd.fees` and the DefiLlama comments. `external_ids.defillama` stays for R8.

Checks:
- **bound**: per chain-day allocator ≤ gross; fail past 0.5% and $1 (catches a double-counting log scan).
- **coverage**: a chain-day priced below 99% warns; below 95% fails the day.
- **drift** (warn, posted to #orion-ops): root Voter `chains()` differs from the configured chains; a factory's tape or a
  CL pool's hook differs from config; a FactoryRegistry factory not in config; a gauge on an unregistered pool.

At 11-26 (scoping): revenue ~$297K/day, holders $263K/day, incentives ~$2.7K-4.1K/day below the line.

## 6. History and cutover (per environment, in order)

1. Export then `data purge aero --metric flow_usd.fees --yes`: removes all 308 rows (306 `third_party` DefiLlama + 2
   `derived` 09-10 corrections) and the dead cursor; the export is kept in backups. Open anomalies on the metric are
   swept first.
2. Deploy the release (config with the new metrics).
3. Backfill 2026-10-22 → yesterday in 7-day chunks, one job per chunk; a chunk resumes from its last stored day, so a
   deploy or crash loses at most one chunk. ~40 min total, scheduled clear of the nightly (00:45Z) and the 05:00-06:30 PT
   window.
4. The nightly carries it, re-reading the last 3 days (late registration, delayed logs).

Pre-merger Aerodrome is not rebuilt (Phase 3 decision 1). At release the report shows "~36 of 91 days"; full ~2027-01-21;
growth "not meaningful" until ~2027-04-22.

## 7. Errors

- An RPC failure on any chain fails that day's metric; partial-chain sums are never stored.
- Coverage < 95% fails the chain-day; 95-99% stores and warns; unpriced fees are reported, never imputed.
- Drift warns (§5). A soak failure blocks prod as usual.
- The 3-hop graph never prices a token through a pool whose priced side is under the floor; a stale anchor feed (> 26 h)
  removes that anchor for the day (lower coverage, not a guessed price).

## 8. Testing

TDD; `fakeRpc({ callsAt })` fixtures cut from real archive blocks (`onchain-revenue-data/raw/`).
- Engine: `s−1`/`e−1` boundaries, mid-day pool creation, per-factory tapes (Arc Lite), unregistered pools, chunked
  multicall, Ink log chunking, memoization (5 metrics → 1 scan).
- Pricing: reviewed anchors only (the six Base "USDC"s and the spoof LINK refused), $10K floor, 3 hops, CL TWAP vs V2
  spot, stable-curve from factory, own-pool fallback, unpriced, stale feed, Elysium cross-chain anchor.
- Incentives: overlap minus zero-allocation seconds, creator classing, programs spanning day edges.
- Core: origin fix, `onchain_usd`, below-line `started`, window label and growth suppression, also exercised on CRV and
  LINK to prove nothing else moves.
- Live golden (opt-in, network): 2026-11-26 re-read from archive; per-chain gross, allocator and incentives equal the
  scoping numbers.
- Full suite and typecheck green (baseline at d422944: 156 files / 2032 tests).

## 9. Release proof and rollout

- Read-only prod copy (`tools/phase2-proof/prod_copy.py`), old vs new reports; `tools/phase3-proof/flatdiff.py`:
  byte-identical for the 12 untouched assets; AERO fields allowlisted one by one with signed values (revenue, holder flow,
  below-line lines, window label).
- Acceptance (offline, DEV-REF): allocator + allocator-earned incentives within ±3% of DefiLlama holders revenue on every
  day 10-23 → release; 10-22 exempt (DefiLlama had no new-AERO price that day).
- Rollout: plan → a T<n> sub-ticket per task → build on `ret-20-aero-pool-scan` → final review → **Mike**: 6 RPC env vars
  on stage → purge, deploy, backfill on stage → one soak nightly, no failed sources, coverage ≥ 99% on all 8 chains →
  prod-copy proof → **Mike's go** → prod, same steps → tag `orion-YYYY.MM.DD.1`, push to GitHub (HTTPS).

## 10. Out of scope

HYPE (R5), PUMP (R6), CRV vote incentives (R7), retiring identifiers/sources (R8). Pre-merger Aerodrome history. Legacy
Aerodrome V1/Slipstream pools (not sAERO). Fee estimates for unregistered pools.

## 11. Addresses

Verified on chain in scoping (`onchain-revenue.md` §10, `incentives-and-events.md`); the plan copies them from
`onchain-revenue-data/anchors-chainlink.json` and the raw day files, never from memory.

All chains: PoolTape `0x34bdD64B19D8631F936c2D07F19AAa6B83515992`, CLPoolTape `0x27D5EB73e7406675F6B0CbD037490ec3dba935a4`,
StablePoolFactory `0x78589E876edcEbdce72ee3436ab3c9AD3a7cEF2D`, VolatilePoolFactory
`0x8E6a9FCd1d638CC760Ffba397605Fe3355dE76D2`, DynamicSwapFeeHook `0xC0ed888AfE87ed1AcF01D9f19bB850159e3ce434`,
CLGaugeFactory `0xf437f62053ACB121665b8fDBfeA8F214FB8E589d`, LeafVoter `0x382409fad8503FbCdbB27A4211551fa03e884078`,
Multicall3 `0xcA11bde05977b3631167028862bE2a173976CA11`.

| chain | CLFactory | GaugeFactory stable | GaugeFactory volatile |
|---|---|---|---|
| Base | 0x9CB220581b91b0C83223012FE69688b92aD07a76 | 0x1e0f776E88649285f99e65Fa599aD6e0f9D97800 | 0x9FBCf2Df0DC553ce40Ef63963Bff465b76792B7E |
| Ethereum | 0xF4Fd2E6c5B60c5b365cd1B96DD6245E6D60414c2 | 0xCCe24256a8a6070A9E308f23E044C87C343F98Cd | 0x7F83235643181E440433400a027618Cd50879751 |
| OP | 0xfeaB42D90055db3a0616249f76B6002D72266778 | 0x3924b18EDd37267dab6eDd99a3Bb339bf2b668fD | 0x1B5D13975371806D699dC616A96D15B8eD26e5Ca |
| Arbitrum | 0x88a60ee77392577c355C0acb2A8d476D5a4EC03a | 0x94AF9F874e92F05F42aE55FfC793b9F4f5FFc135 | 0xBbdDdd5ac17a672B360D2dBAa996468aDBEF8692 |
| Ink | 0x7660BF2aDefC687C22906112ca323d60A00358cF | 0xd9eF1acdca62010e93370f5932E3deD127E65396 | 0x1733cD126a227066963E9B636Ad49898d1224741 |
| Robinhood | 0xc63d7338c178e805c544B8f897066bD3BBcBE136 | 0x1733cD126a227066963E9B636Ad49898d1224741 | 0xCCe24256a8a6070A9E308f23E044C87C343F98Cd |
| Arc | 0x7F83235643181E440433400a027618Cd50879751 | 0x9520C671C767B170c9f04e523B4e68c5d537779b | 0xBDcB4929b19EBcfEE5eFE100B829c9B35C16d8F8 |
| Elysium | 0xEfd7A089D3057F05189B05f74Ffcf30610c42891 | 0xb89Df768aF2CFE637ceB352c587Fe8edAf491d03 | 0xf2E6DB898840e0ae91C44E1BDDEA16B50a369862 |

Arc Lite: PoolTape `0x8Da07EfaBCF124B61671Df449BC73292D4B56c25`, CLPoolTape `0x967f5352A6448e22D7361E149103350c49345Ee9`,
CLFactory `0xb89Df768aF2CFE637ceB352c587Fe8edAf491d03`, hook `0xaAf164008441F112eB2858d9F7A2dB1B84b1E415`, CLGaugeFactory
`0xa02d1F4E4243ff0d350F478c44B0Fd37c7bF848C`. Elysium FactoryRegistry `0xdd1705e23762F4D6e44D8C31BD8Ea80c54612239`.
Base root Voter `0x49d7d4f17Ec56Ef8fA04E464AF5D1A4942CC31e6`.

Incentive creators: Foundation TGE `0x7269de76188E6597444D0859C4e5c336D3c39dDb` and governance multisig
`0x42255e3c2d0b71a0b006243148fdf1a71d054ce0` (→ `protocol_subsidy`); Safe `0x80f7153d9bc853a9bf8bc21f2517c0acee2fdf75`
and everyone else (→ `vote_incentives`).
