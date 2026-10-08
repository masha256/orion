# Orion CRV Onboarding (Sub-project 8) Implementation Plan

**Goal:** Cover CRV (Curve DAO Token, Ethereum mainnet) as Orion's fourth live asset, every metric fetched, data grade A.

**Spec:** `docs/superpowers/specs/2026-10-08-orion-crv-onboarding-design.md`. Parent specs as listed there.

**Execution mode:** implemented directly on `feat/crv` by the controller (no prototype/extraction pass, unlike sub-projects 6 and 7): one commit per task, the full suite and `tsc --noEmit` green after each. The live dry run (Task 5) is run against the user's Alchemy endpoint from a throwaway home.

## Global constraints

- Node >= 22, ESM, relative imports end in `.js`, ASCII-only sources. No new dependency (viem already ships `mainnet`).
- No network in tests. Fixtures under `tests/fixtures/crv/`.
- Never write to the repo-root `orion.db`. Manual CLI checks use `ORION_HOME=$(mktemp -d)`.
- Config hash pins for vvv, aero, hype, and mini do not move: the new zod members add no defaults to existing files.
- A reviewer checks the code against the spec's prose, not only against the tests.

## Task 1: Ethereum mainnet in the transport

Files: `src/ingest/transport/chains.ts` (create), `src/ingest/transport/rpc.ts`, `src/ingest/transport/viemRpc.ts`, `src/ingest/run.ts`, `tests/helpers/fakeRpc.ts`, `tests/ingest/rpc.test.ts`.

- `CHAINS`: `8453` base (log range 2,000, block time 2 s, default URL `https://mainnet.base.org`), `1` ethereum (log range 10,000, block time 12 s, no default URL).
- `RpcTransport` gains optional `maxLogRange` and `blockTimeSec`; `getLogsChunked` and `firstBlockAtOrAfter` read them (fallback 2,000 and 2 s, so existing fakes and callers are unchanged).
- `createViemRpc` takes the viem chain from the table; refuses an unknown chain id naming the supported ones; the `blockTimestamp` message names the chain.
- `DEFAULT_RPC_URLS` derives from the table; chain 1 has none, so a missing `ORION_ETH_RPC_URL` fails with `missing_rpc_url`.
- Tests: chunking at 10,000; the block search converging with a 12 s estimate; chain table; `createViemRpc` refusal; the missing-URL error names the env variable; a keyed URL never appears in a cleaned error.

## Task 2: The `constant` source

Files: `src/config/sources.ts`, `src/ingest/sourceId.ts`, `src/ingest/sources/constant.ts` (create), `src/ingest/sources/registry.ts`, tests.

- `{ type: constant, value: number, note: string }`; level primary only (refused as a flow primary and as a cross-check).
- Written every run, stamped at the fetch time, `source: api`, detail `constant: <note>`. Provenance is not `manual`, so the grade is not capped.
- Tests: schema and `sourceIssues`; handler; a run writes it and the driver report lists no manual metric.

## Task 3: Schedule steps and the `crv` adapter

Files: `src/ingest/types.ts` (a `schedule_steps` reading kind), `src/ingest/run.ts` (writes each step of a schedule metric), `src/ingest/adapters/crv.ts` (create), `src/ingest/adapters/registry.ts`, tests.

- `crv.emission_rate_annual`: one multicall of `rate()`, `start_epoch_time()`; private constants from `CRV.vy` (`RATE_REDUCTION_TIME` 365 days, `RATE_REDUCTION_COEFFICIENT` 1189207115002721024). If the block is past the epoch end (nobody has poked the contract yet), the adapter rolls the epoch forward as `update_mining_parameters` would. Returns two steps: the rate in force (stamped at the block) and the next (stamped at the next epoch start).
- A `schedule_steps` reading is accepted only on a `schedule` metric; every step is validated and written; on a dry run reported as would-write.
- Refusals: zero rate; epoch start after the block; a reduction that does not lower the rate.
- Tests: the live reads of block 26,146,581 give 97,161,875 and 81,703,072 a year, the next step at 2027-08-12T22:17:28Z; roll-forward; refusals; a run writes both steps and `buildSchedule` sees the future one.

## Task 4: The `vote_incentives` module

Files: `src/engine/modules/voteIncentives.ts` (create), `src/engine/modules/registry.ts`, `tests/engine/voteIncentives.test.ts`.

- Component only. Params `metric` (default `vote_incentive_run_rate_usd`), `years` (default 10, integer 1 to 30), `post_horizon_emission_decay` (default 0, in [0, 1)). Assumptions `incentive_efficiency_drift`, `incentive_discount_rate` (> 0).
- `E(tau)`: the schedule step in force at `tau` years from as-of; past the last step's date, that step times `(1 - decay)^floor(years since it)`. `E0` = `E(0)`.
- Year `t` = 1..N after the horizon, at its midpoint `m = H + t - 0.5`: `B_t = B0 * E(m)/E0 * P_H/P0 * (1 + drift)^m`; value = `sum B_t / (1 + r)^t / S_H`.
- Refuses `E0 <= 0`, `P0 <= 0`, and a component worth more than half the horizon price (`value / P_H > 0.5`).
- Tests: hand-computed fixture; flat emissions and zero drift give a plain annuity; decay and discount lower it; emissions and drift raise it; the step and decay pick-up; refusals; parameter validation; an engine run with the component converges.

## Task 5: The asset file, persona, docs, and the live dry run

Files: `assets/crv.yaml`, `personas/onchain-dex-analyst.md` (a vote-incentives paragraph; sectors unchanged), `tests/fixtures/crv/bribes-stats.json`, `tests/assets/crv.ingest.test.ts`, `README.md`, `docs/ops/hermes-daily-job.md`.

- The asset file per spec section 7; hash pinned in the asset test.
- The asset test: loads; `requiredAssumptionKeys`; no manual metric; the plan's source map; a canned fetch writes every metric (weekly payouts as zero days plus Wednesdays, the 91-day run rate, both emission steps, the constant, the vote incentives with the 30-day check inside 50 percent); a wiring set values it `ok` at grade A with the component in the breakdown.
- Live: `orion data fetch crv --dry-run` from a throwaway home with `ORION_ETH_RPC_URL`; record the figures in the spec's amendments.

## Task 6: User checkpoints (not code)

1. Persona assign and the dry fetch on the live home. 2. First tick (blocked; journal-only bootstrap). 3. Calibration (packages with and without the component). 4. First signal. 5. The `orion-crv` cron line.
