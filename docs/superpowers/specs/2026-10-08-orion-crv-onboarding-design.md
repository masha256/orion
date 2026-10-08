# Orion sub-project 8: CRV onboarding

Date: 2026-10-08. Status: draft for the user's review; not yet planned.

Extends `docs/superpowers/specs/2026-09-18-orion-valuation-framework-design.md`, `docs/superpowers/specs/2026-09-19-orion-ingestion-design.md` (sources, adapters, transfer scans), `docs/superpowers/specs/2026-09-22-orion-research-first-design.md` (bootstrap, inbox), `docs/superpowers/specs/2026-09-23-orion-aero-onboarding-design.md` (`flow_annualized`, the ve-model contrast case, the onboarding sequence) and `docs/superpowers/specs/2026-09-24-orion-hype-onboarding-design.md`. Where this document and those differ, this one wins for the items it covers.

## 1. Purpose and scope

Cover CRV (Curve DAO Token, Ethereum mainnet) as Orion's fourth live asset. It is the first asset on Ethereum mainnet, so this sub-project carries the chain work as well as the asset.

In scope:

1. **Ethereum mainnet support** in the RPC transport: chain 1, per-chain log range and block time, a default env name.
2. **A `constant` source type**: a fixed value written as a fetched observation, so structural constants do not cap the grade at B.
3. **Two `crv` adapters**: the emission schedule (the rate in force plus the next step) and nothing else; locked supply and total supply are declarative.
4. **`assets/crv.yaml`**: every metric fetched, no manual metric, one holder flow measured on chain, two modules, key-wide bounds; agent bands after calibration.
5. **Persona**: reuse `onchain-dex-analyst` (ve-model DEX, same mechanism as AERO), with a CRV paragraph if the bootstrap shows it needs one.
6. The onboarding sequence, as for AERO and HYPE.

Out of scope: bribes as a holder flow (third-party money, not revenue; section 2.3); crvUSD/LlamaLend as separate flows (they reach the same FeeDistributor and are measured there); Convex/vlCVX look-through; UNI and LINK.

### Decisions made with the user (2026-10-08)

- Ethereum RPC: the user's Alchemy key, `ORION_ETH_RPC_URL` in `<ORION_HOME>/.env` (git-ignored). Verified live: chain id 1, `eth_getLogs` over 100,000 blocks in one call, `blockTimestamp` on every log, archive `eth_call` 90 days back.
- Zero-valued structural metrics get a `constant` source so the data-quality grade stays at A (a manual row in force caps it at B).
- The emission schedule is an adapter that reads the CRV contract, including the next 13 August reduction, not a hand-entered dated row.
- Flow source: on chain (section 2.3), DefiLlama demoted to an advisory cross-check or dropped.

## 2. Reference data (as of 2026-10-08)

Confidence: **A** read from the chain or an API that day; **B** reputable secondhand; **C** inferred. All values are re-fetched by Orion; they are recorded here to justify design choices.

### 2.1 Contracts (Ethereum mainnet)

| Name | Address | Notes |
|---|---|---|
| `token` (CRV) | `0xD533a949740bb3306d119CC777fa900bA034cd52` | ERC-20 and the emission schedule (`rate()`, `start_epoch_time()`, `future_epoch_time_write()`, `mining_epoch()`, `available_supply()`) |
| `ve` (veCRV) | `0x5f3b5DfEb7B28CDbD7FAba78963EE202a494e2A2` | `supply()` = CRV locked |
| `fee_distributor` | `0xD16d5eC345Dd86Fb63C6a9C43c517210F1027914` | Blockscout name `CurveFeeDistribution`; pays veCRV in crvUSD |
| `fee_allocator` | `0x22530d384cd9915e096ead2db7f82ee81f8eb468` | Blockscout name `FeeAllocator`; the only sender into the distributor in 90 days |
| `hooker` | `0x9a9df35cd8e88565694ca6ad5093c236c7f6f69d` | Blockscout name `Hooker`; the only sender into the allocator |
| `treasury` | `0x6508ef65b0bd57eabd0f1d52685a70433b2d290b` | Blockscout name `Treasury`; the allocator's second recipient |
| `crvusd` | `0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E` | the distributor's `token()` |

### 2.2 Supply and emissions [A]

- `totalSupply` 2,424,321,556 CRV; `available_supply()` 2,434,644,854 (minted-to-date if every gauge claimed); max 3,030,303,031. No burn: `effective_total` is the ERC-20 total.
- veCRV `supply()` 840,614,647 CRV locked (34.7 percent); `CRV.balanceOf(veCRV)` 840,616,713 (agrees to 2,000 CRV).
- `rate()` 3.080982847903985532 CRV/s = 97.16M CRV a year (4.0 percent of supply); `mining_epoch()` 6; `start_epoch_time()` 1786573048 (2026-08-12T22:17:28Z); `future_epoch_time_write()` 1818109048 (2027-08-12T22:17:28Z).
- The contract's reduction constants are private (`RATE_REDUCTION_COEFFICIENT` and `RATE_REDUCTION_TIME` revert as calls): the coefficient is 1189207115002721024 (2^(1/4), 18 decimals) and the time 365 days, from the published `CRV.vy` source. At the next epoch the rate becomes `rate * 1e18 / 1189207115002721024` = 2.5908 CRV/s (81,703,072 a year), a 15.9 percent cut, every year thereafter.
- All emissions go to LP gauges. None reaches veCRV lockers directly: `staker_emission_share` is 0 by construction.

### 2.3 The holder flow: DefiLlama overstates it by about 3x [A]

Ninety days of crvUSD Transfer logs into the FeeDistributor (blocks head-650,000 to head, 2026-07-15 to 2026-10-07): **190 transfers, all from the FeeAllocator, 1,281,345 crvUSD, every Wednesday, 13 weekly payouts of 41.6K to 178.6K** — an annualized **5.20M USD** (crvUSD at 0.9993). The allocator received 1,423,717 crvUSD from the Hooker and sent 90 percent to the distributor and 10 percent (142,372) to the Treasury, matching the documented 90/10 split to the coin.

DefiLlama over the same 90 days:

| Series | `curve-finance` | `curve-dex` |
|---|---|---|
| dailyFees | 10.59M | 10.06M |
| dailyUserFees (ex-bribes) | 7.74M | 7.74M |
| bribes (fees minus user fees) | 2.85M | 2.32M |
| dailyHoldersRevenue | 3.86M | 3.58M |
| holders revenue ex-bribes | 1.01M | 1.26M |

DefiLlama's own methodology says holders revenue is "90% of the protocol's share of pool fees, distributed to veCRV holders, plus all bribes". Removing the bribes leaves 1.01M to 1.26M against 1.28M measured on chain. **The gap is the bribes**: the on-chain series is the revenue-funded flow and DefiLlama's holders revenue is not. `dailyBribesRevenue` holds one point and is unusable.

Decision: the holder flow is a `transfer_flow` of crvUSD into `fee_distributor` from the allowlist `[fee_allocator]`, unit usd priced on CoinGecko `crvusd`. An unlisted sender (a new allocator, a direct deposit) raises the standard `unlisted_sender` anomaly, which is the right behaviour after a governance change of the fee route.

Shape: weekly, not daily. Six of every seven days are zero. Two consequences:

- The daily scan already stores a day with no transfers as a 0 row (`scanFlowGroup` writes every scanned day), so weekly payouts need no scan change.
- The run rate's window must be a whole number of weeks so it always holds the same number of Wednesdays: **91 days** (13 payouts), not 90. The holder flow's `window_days` is 91 for the same reason (AERO's ruling F2: window and run rate must match, else measured capture is not 1).

### 2.4 Prices [A]

CoinGecko `curve-dao-token` 0.3933; DefiLlama `coins.llama.fi/prices/current/ethereum:0xD533…cd52` 0.3897 (0.9 percent apart; a 2 percent cross-check). Market cap 619M USD on CoinGecko circulating; 953M on the effective total.

## 3. Ethereum mainnet in the transport

`src/ingest/transport/viemRpc.ts` today refuses any chain but Base. Changes:

- A chain table: `{ 8453: { viem: base, maxLogRange: 2000n, blockTimeSec: 2, defaultUrl: 'https://mainnet.base.org' }, 1: { viem: mainnet, maxLogRange: 10000n, blockTimeSec: 12, defaultUrl: none } }`. `DEFAULT_RPC_URLS` in `run.ts` reads from it; chain 1 has no keyless default (free endpoints refuse ranged logs and archive reads), so a missing `ORION_ETH_RPC_URL` fails with the existing `missing_rpc_url` error naming the variable.
- `MAX_LOG_RANGE` becomes per chain and travels on the transport (`rpc.maxLogRange`); `getLogsChunked` reads it. 10,000 blocks is about 33 hours on mainnet, so a 100-day backfill is about 73 calls.
- `firstBlockAtOrAfter` takes `blockTimeSec` from the transport (12 on mainnet), not the literal 2.
- The `blockTimestamp` guard message names the asset's chain, not Base.
- `cleanRpcErrorMessage` already strips the URL; the Alchemy key is in the path, so add a test that a mainnet error message carries no `/v2/` segment.

Tests: the chain table; the chunker at 10,000; the block search with a 12-second estimate; the missing-URL error for chain 1.

## 4. The `constant` source

```yaml
staker_emission_share:
  type: level
  unit: ratio
  staleness_days: 7
  source: { type: constant, value: 0, note: "all CRV emissions go to LP gauges; veCRV receives none (CRV.vy, GaugeController)" }
```

- `SourceSchema` gains `{ type: 'constant', value: number, note: string (min 1) }`. Level metrics only (primary role); refused as a flow primary and as a cross-check.
- The handler returns a level stamped at the run's time with `source: 'api'`, detail `constant: <note>`. It is written like any fetched level, refreshed every tick, so it never goes stale, and its provenance is not `manual`, so the grade is not capped.
- `validateReading` today refuses a non-positive level unless the unit is `ratio`; a constant 0 on a ratio passes. A constant 0 on a non-ratio level (UNI's `staked_supply`, later) would be refused: allow 0 for `constant` sources on `tokens` and `tokens_per_year` units, nowhere else. Decide in the plan whether CRV needs it (it does not: CRV's staked supply is the veCRV lock, positive).
- The asset-file hash moves when a constant changes, so the value is versioned with the config, and an agent cannot change it (asset YAML edits are proposals).

Design question for the plan: whether to write a new observation every tick (simple, keeps staleness logic untouched) or once per config hash (fewer rows). Recommendation: every tick, as for other levels.

## 5. The `crv` adapters

`src/ingest/adapters/crv.ts`, registered beside the others; `needsRpc: true`. One multicall at the run's block: `rate()`, `start_epoch_time()`, `future_epoch_time_write()` — `future_epoch_time_write` is a state-changing function in `CRV.vy` that is safe to `eth_call` (it returns `start_epoch_time + RATE_REDUCTION_TIME` and writes only when an epoch is overdue); if a plain read is preferred, compute `start_epoch_time + 365 days` and check it against the call in tests.

- `crv.emission_rate_annual`: returns **two** schedule steps:
  - the step in force: `rate * 365 days` tokens per year, observed at the run's block time;
  - the next step: `rate / 2^(1/4) * 365 days`, observed at `start_epoch_time + 365 days`.

  The engine's `buildSchedule` already reads future-dated steps of a schedule metric (`o.observedAt > asOf`), so the 12-month horizon sees the 2027-08-12 cut. Today an adapter returns one level; the plan must either let a schedule adapter return several steps (a `schedule_steps` reading kind written as several observations) or register a second adapter `crv.emission_rate_next` writing the future step under the same metric. Recommendation: the `schedule_steps` kind — it is the general shape (CAKE, and any halving schedule, need it) and keeps one source per metric.
- Refusals by name: `rate()` zero; `start_epoch_time` in the future; the next epoch more than 366 days away (a replaced token or a changed constant); a reduction that would make the rate rise.
- Detail: `epoch <mining_epoch>, rate <r> CRV/s, next cut <ISO date> to <r'> CRV/s`.
- Rows written once a year with a future date are re-written every tick at the same `observedAt`: `insertObservation` supersedes the prior row at the same key, so there is one active future step.

A third adapter is not needed: `locked_supply` and `staked_supply` are `contract_read ve.supply()` (decimals 18), and `effective_supply` is `erc20_supply token`.

Tests: against recorded `eth_call` replies (fixtures from block 26,146,581): the step in force 97,161,875 CRV a year (rate × 31,536,000); the next step 81,703,072; the next step dated 2027-08-12T22:17:28Z; each refusal.

## 6. The asset file

`assets/crv.yaml`: `id: crv`, `symbol: CRV`, `name: Curve DAO Token`, `chain: ethereum`, `supply_basis: effective_total`, `contracts` as section 2.1, `ingest: { chain_id: 1, rpc_url_env: ORION_ETH_RPC_URL, backfill_days: 100 }`, `external_ids: { coingecko: curve-dao-token, defillama: curve-finance }`.

| Metric | Type, unit | Source | Cross-check | Notes |
|---|---|---|---|---|
| `price_usd` | level, usd, critical, staleness 3 | coingecko `curve-dao-token` | http_json DefiLlama coins, 2 percent | |
| `effective_supply` | level, tokens, critical, staleness 7 | erc20_supply `token` | none | no burn |
| `circulating_supply` | level, tokens, staleness 14 | coingecko | none | informational |
| `staked_supply` | level, tokens, staleness 7 | contract_read `ve.supply` decimals 18 | none | staking is locking, as AERO |
| `locked_supply` | level, tokens, staleness 7 | contract_read `ve.supply` decimals 18 | none | |
| `staker_emission_share` | level, ratio, staleness 7 | constant 0 | none | section 4 |
| `emission_rate_annual` | schedule, tokens_per_year, critical, staleness 45 | adapter `crv.emission_rate_annual` | none | section 5 |
| `flow_usd.fees` | flow, usd, daily, critical, staleness 10 | transfer_flow crvusd -> fee_distributor, allowlist `[fee_allocator]`, unit usd, `price_coingecko_id: crvusd` | defillama `curve-finance` `dailyHoldersRevenue`, `compare: monthly_sum`, tolerance wide (see below) | weekly payouts; staleness 10 so one missed Wednesday does not grade D |
| `revenue_run_rate_usd` | level, usd, critical, staleness 10 | derived `flow_annualized` `{ metric: flow_usd.fees, days: 91 }` | none | 13 payouts |

The DefiLlama cross-check: its series includes bribes and runs about 3x the on-chain flow, so a tolerance tight enough to mean anything would fire every month. Options: (a) no cross-check; (b) an advisory check with tolerance 250 percent, which catches only a collapse of the on-chain read. Recommendation: (a), and the persona reads DefiLlama ex-bribes as context.

`holder_flows: [{ id: fees, kind: fee_share, capture_rule: programmatic, recipient_base: locked, metric: flow_usd.fees, window_days: 91 }]`.

`modules`: `holder_cashflow` 0.6, `forward_multiple` on holder flow 0.4, as AERO; no revenue multiple (revenue and holder flow are one series). `scenario_probabilities` 25/50/25.

Assumption bounds (key-wide, before calibration): `rev_growth_y1 [-0.6, 2.0]`, `growth_fade_years [1, 8]`, `terminal_growth [0, 0.05]`, `capture_rate_terminal.fees [0.5, 1.0]`, `capture_ramp_years.fees [0, 4]`, `discount_rate_base [0.08, 0.35]`, `discount_premium_programmatic [0, 0.15]` (required: the flow is programmatic), `multiple.fm_holder_flow [3, 60]`, `regime_multiplier [0.4, 1.6]`, `staked_ratio_horizon [0.2, 0.6]` (0.35 today). Bands by the mirror rule after calibration.

`review_triggers`: `driver_deviation_pct: 25`, `provisional_move_pct: 25`; calendar `2027-08-12: CRV emission rate cut (epoch 7, 22:17Z)`.

`agent`: defaults, weekly input budget 2,000,000 as for the others.

## 7. Onboarding sequence

1. Code (sections 3 to 5) with tests, on `feat/crv`.
2. `assets/crv.yaml`; `orion asset validate`; `orion persona assign crv onchain-dex-analyst`.
3. Dry fetch from a throwaway home: `orion data fetch crv --dry-run`. Expected: 100 days of flow rows (14 non-zero), about 73 log calls; supply, lock, rate within 0.1 percent of section 2.2; next step dated 2027-08-12T22:17Z; price check inside 2 percent.
4. First tick: blocked (no set); bootstrap with an empty manual list (journal only), as AERO.
5. Calibration: sweep, priced packages under the 91-day (5.2M), 30-day and 1-year on-chain windows; the user chooses; import; bands; commit.
6. First signal; a fourth Hermes cron line `orion-crv` after `orion-aero` (17:20 PDT / 16:20 PST, delivered to orion-ops).

## 8. Risks and expectations

- **Emissions dwarf the flow.** 97.2M CRV a year is about 38M USD at spot against 5.2M USD a year to lockers: the holder-cashflow module will be strongly bearish, more than AERO's. A low base case is the model working.
- **The fee route is governance-set.** A new allocator, hook or token shows as an unlisted sender or a zero week; the anomaly blocks the signal, which is right.
- **Weekly lumps.** A 13-week window smooths them; a missed Wednesday shows as a 7.7 percent dip in the run rate, under the 25 percent deviation trigger.
- **Convex.** Most veCRV is held through Convex; lockers' look-through yield is not CRV holders' yield. Effective-total basis values the flow across all CRV, as AERO does.
- **Private constants.** The 2^(1/4) and 365-day constants are from source, not readable; pinned in the adapter with the source reference.
