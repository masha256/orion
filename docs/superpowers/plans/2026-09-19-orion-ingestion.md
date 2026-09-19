# Orion Ingestion, Anomalies, and the Dilution Fix (Sub-project 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace hand-entered VVV observations with fetched ones, so that one cron line (`orion update vvv`) produces a daily signal, and make the signal say when its data cannot be trusted.

**Architecture:** A new `src/ingest/` layer reads a small vocabulary of declarative `source:` blocks from the asset YAML, fetches through two injected transports (HTTP JSON, and a viem-backed Base RPC), and writes observations only through the existing `insertObservation`. Cross-check readings never become observations: they live in a fetch log and, when out of tolerance, in an anomaly table that the signal reads at run time. The engine changes once, first: `holder_cashflow` discounts per-token flows along a post-horizon supply path (engine 1.2.0).

**Tech Stack:** Node 22+, TypeScript (ESM, NodeNext), better-sqlite3, commander, zod 4, yaml, vitest, tsx. New dependency: `viem` (2.x).

**Spec:** `docs/superpowers/specs/2026-09-19-orion-ingestion-design.md` (approved 2026-09-19; section 8 was amended the same day during planning, see Task 1). Parent spec, binding where that one is silent: `docs/superpowers/specs/2026-09-18-orion-valuation-framework-design.md`. Executors read both. Rulings and deferred findings from sub-project 1: `docs/superpowers/notes/2026-09-18-core-and-engine-followups.md`.

## Global Constraints

- Node `>=22`. ESM only (`"type": "module"`). Relative imports end in `.js`.
- The only new dependency is `viem`. No `dotenv`, no HTTP client library: use the global `fetch`.
- **No network in tests.** Transports are injected. Every test uses the fakes in `tests/helpers/fakeHttp.ts` and `tests/helpers/fakeRpc.ts`. Fixtures are the real captures under `tests/fixtures/ingest/research-2026-09-19/`.
- **Never write to the repo-root `orion.db`** from a test, a script, or an experiment. Tests use `openDb(':memory:')` or a `mkdtempSync` home. Manual CLI checks use `ORION_HOME=$(mktemp -d)`.
- The user's shell is zsh, where a command stored in a variable is not word-split. Run multi-step CLI scripts with `bash`.
- The engine (`src/engine/**`) and drivers (`src/drivers/**`) stay pure: no `Date.now()`, no `new Date()` without an argument, no file, DB, or network access. `src/ingest/crosscheck.ts` is pure too.
- Spec invariants, verbatim:
  1. Fetchers write only what a source returned, with the source's own timestamp. Block time for chain reads; fetch time for API levels. No interpolation, no gap filling.
  2. All observation writes go through `insertObservation`.
  3. Sources fail independently. One source's failure never prevents another's observations from landing.
  4. Cross-check readings are never observations. They live in `fetch_runs.detail` and, when out of tolerance, in `anomalies`.
  5. An undocumented API is never the primary source of a required driver.
  6. Flows are written for completed UTC days only.
- Observations remain append-only (only `superseded_by` and `status -> 'rejected'` change in place). `anomalies` and `fetch_cursors` are operational state and are updated in place.
- `fetchAsset` never throws for a source failure. It throws `OrionError` only for configuration errors (unknown adapter or derived name, missing RPC URL, unsupported chain, an asset with no sources).
- A reading that is not a finite number, or a supply or price that is not positive, is a source failure, never an observation.
- `eth_getLogs` is called with at most 2,000 blocks per request. All contract level reads in one run go through ONE multicall at ONE block (the public Base RPC throttles bursts of separate `eth_call`s; verified during planning).
- Signal schema version stays `1`: fields are added, none changed or removed.
- Percent fields (`*_pct`) are in percent units. One year is 365 days. One day is 86,400,000 ms. "Day" always means a UTC calendar day.
- Every CLI command accepts `--json`.
- **This plan's code was executed during planning.** Every `Create` / `replace` / `Append` directive below was extracted from this document into a scratch copy of the repo at `d2a15c5`. After EACH of Tasks 1 to 20 the full suite passed and `tsc --noEmit` was clean (142 tests after Task 1, 320 after Task 20), `npm run build` succeeded, and a live `data fetch vvv --dry-run --backfill-days 1` from a throwaway `ORION_HOME` returned every source `ok` with every cross-check in tolerance (4,190 burn transfers on 2026-09-18). So a failing test most likely means a directive was applied inexactly: re-read it before changing anything. If the plan's code really is at fault, fix the code so the test's stated intent holds; do not weaken the test.
- **Reviewers: check code against the prose rules in this plan and the spec, not only against the code listing.** In sub-project 1, reviewers caught plan-supplied code that contradicted the plan's own stated rules. Passing tests do not prove the rules are met.

## Facts verified live during planning (2026-09-19, Base block 51530033)

Recorded in `tests/fixtures/ingest/research-2026-09-19/chain_reads.json` and `cg_markets.json`.

- `veniceEmissionsPercentage()` = `0`; `veniceEmissionsPercentageWhenLocked()` = `200000000000000000`. Both are fractions scaled by 1e18 (so 20 percent). Hence `diem_locked_yield_share` = `1 - raw / 1e18` = `0.8`: `contract_read` with `decimals: 18, scale: -1, offset: 1`.
- `emissionRatePerSecond()` = `79274479959411466` (18 decimals): times 31,536,000 is 2,500,000 VVV per year.
- `diemSupply(i)` = `500 * (i + 1)` DIEM, `diemMintRates(i)` = VVV per DIEM, both 18-decimal, for `i` in `0..255`. Index 256 reverts. Bucket 79 is 40,000 DIEM at a rate of 665.0150, which is `90 * e^2`: the on-chain DIEM target supply is 40,000.
- Separate `eth_call`s in a burst fail on `https://mainnet.base.org` after about five. One viem `multicall` with `batchSize: 100_000` carrying all 512 table reads succeeds.
- `eth_getLogs` on Base returns `blockTimestamp` on every log, so transfers carry their own block time and no per-log `getBlock` is needed. Base blocks land on odd seconds, two seconds apart.
- Venice endpoints: `https://outerface.venice.ai/api/app/vvv/vvv_stats`, `/vvv_staking_yield`, `/vvv_burn_history`, `/diem_stats`. Numbers arrive as strings, some in scientific notation (`"3.95e+22"`).
- CoinGecko `/coins/markets?vs_currency=usd&ids=venice-token,diem` returns an array of `{ id, current_price, market_cap, circulating_supply, last_updated, ... }`.

## File Structure

```
src/
  engine/supply.ts                 MODIFY  add postHorizonSupply
  engine/modules/types.ts          MODIFY  ModuleContext gains supplyAfterHorizon, terminalEmissionRate
  engine/modules/holderCashflow.ts MODIFY  per-token discounting
  engine/run.ts                    MODIFY  build the post-horizon path and pass it to modules
  engine/version.ts                MODIFY  1.2.0
  db/migrations.ts                 MODIFY  migration 2
  db/fetchRuns.ts                  CREATE  fetch log + the SourceOutcome detail types
  db/fetchCursors.ts               CREATE  resumable scan cursors
  db/anomalies.ts                  CREATE  anomaly lifecycle
  db/runs.ts                       MODIFY  latest-signal ordering
  config/sources.ts                CREATE  zod SourceSchema (the declarative source vocabulary)
  config/schema.ts                 MODIFY  source, cross_checks, ingest, review-trigger validation
  ingest/time.ts                   CREATE  UTC day and month helpers
  ingest/units.ts                  CREATE  bigint base units to number, numeric-string parsing
  ingest/types.ts                  CREATE  SourceValue, ReadingResult, SourceRequest, SourceContext, SourceHandler
  ingest/sourceId.ts               CREATE  stable id per source (batch key, dedupe key, fetch-log key)
  ingest/transport/http.ts         CREATE  JSON GET: timeout, retry, Retry-After, per-host spacing, run cache
  ingest/transport/rpc.ts          CREATE  RpcTransport interface, getLogsChunked, firstBlockAtOrAfter
  ingest/transport/viemRpc.ts      CREATE  the only file that imports viem
  ingest/sources/coingecko.ts      CREATE
  ingest/sources/httpJson.ts       CREATE
  ingest/sources/defillama.ts      CREATE
  ingest/sources/chainLevels.ts    CREATE  erc20_supply and contract_read, one multicall
  ingest/sources/adapter.ts        CREATE  dispatches to named adapters
  ingest/sources/registry.ts       CREATE  handler lookup by source type
  ingest/adapters/registry.ts      CREATE  named adapter functions
  ingest/adapters/vvv.ts           CREATE  the four VVV adapters
  ingest/crosscheck.ts             CREATE  pure comparisons (level, monthly sums)
  ingest/plan.ts                   CREATE  asset YAML -> fetch plan
  ingest/flow.ts                   CREATE  transfer_flow: scan, classify, value, bucket, write, cursor, adopt
  ingest/derived.ts                CREATE  burn_momentum
  ingest/alerts.ts                 CREATE  revenue_disclosure_stale
  ingest/run.ts                    CREATE  fetchAsset
  ingest/deps.ts                   CREATE  real transports and env for the CLI
  app/eligibility.ts               CREATE  eligibleObservations with snapshot narrowing (moved out of valuation.ts)
  app/valuation.ts                 MODIFY  use eligibility.ts; pass open anomalies to the signal
  app/update.ts                    CREATE  updateAsset: fetch, run, return the signal
  signals/schema.ts, quality.ts, build.ts   MODIFY  anomalies in data_quality, grade D, degraded reason
  cli/env.ts                       CREATE  <ORION_HOME>/.env loader
  cli/util.ts                      MODIFY  CliContext gains ingestDeps, stderr, setExitCode; withDbAsync
  cli/commands/data.ts             MODIFY  fetch, sources, anomalies, resolve, ack
  cli/commands/update.ts           CREATE
  cli/program.ts, cli/index.ts     MODIFY
assets/vvv.yaml                    MODIFY  contracts, ingest, the VVV source map
README.md                          MODIFY
tests/helpers/fakeHttp.ts, fakeRpc.ts, ingestAsset.ts   CREATE
tests/...                          one test file per new unit, listed in each task
```

Dependency direction: `db` and `config` depend on nothing; `ingest` depends on `db`, `config`, `drivers` (read-only helpers); `app` depends on `ingest`; `cli` depends on `app`. Only `ingest/transport/viemRpc.ts` imports `viem`.

## How steps name file changes

Three directives are used, always followed by a code block:

- **Create `path`:** the block is the whole file.
- **In `path`, replace:** (block) **with:** (block): an exact, unique text replacement.
- **Append to `path`:** the block goes at the end of the file.

Run one test file with `npx vitest run <path>`; the whole suite with `npm test`; types with `npm run typecheck`.

---

## Task group A: engine

### Task 1: Post-horizon dilution in `holder_cashflow` (engine 1.2.0)

`holder_cashflow` divides aggregate present value by supply at the horizon, which ignores every token emitted after the horizon. It changes to discount per-token flows along a supply path.

**The amended rule (spec section 8).** The supply path after the horizon is `S(n+1) = S(n) + E`, plus scheduled unlocks that fall in that year on the circulating basis, where `E` is the last known emission schedule step. **Burns do not shrink this path.** The first draft of the spec subtracted a burn yield; a prototype during planning showed that this double counts (the module already values burn dollars as holder cash flow) and makes every burn-funded asset raise `EngineError`. The user approved the amendment on 2026-09-19. Burns before the horizon still reduce `S(H)` through `forecastSupply`, unchanged.

```
f_k(t)   = F_k(H + t - 0.5) / S(H + t - 0.5)
delta    = E / S(H + N)
g_pt     = (1 + g) / (1 + delta) - 1
value_k  = sum_{t=1..N} f_k(t) / (1 + r_k)^t  +  [ f_k(N) * (1 + g_pt) / (r_k - g_pt) ] / (1 + r_k)^N
```

**Files:**
- Modify: `src/engine/supply.ts`, `src/engine/modules/types.ts`, `src/engine/modules/holderCashflow.ts`, `src/engine/run.ts`, `src/engine/version.ts`
- Create: `tests/engine/dilution.test.ts`
- Modify: `tests/engine/modules.test.ts`, `tests/engine/utilityClaim.test.ts`, `tests/engine/run.test.ts`, `tests/engine/contrast.test.ts`, `tests/assets/vvv.golden.test.ts`

**Interfaces:**
- Consumes: `forecastSupply`, `yearsBetween` (`src/engine/supply.ts`); `flowUsdAt`, `need` (`src/engine/paths.ts`); `discountRateFor` (`src/engine/modules/keys.ts`).
- Produces:
  - `postHorizonSupply(args: { asset: AssetConfig; drivers: Drivers; horizonYears: number; supplyAtHorizon: number; basis?: 'effective_total' | 'circulating' }): PostHorizonSupply`
  - `interface PostHorizonSupply { supplyAt(tau: number): number; terminalEmission: number }`
  - `ModuleContext` gains `supplyAfterHorizon(tau: number): number` and `terminalEmissionRate: number`. Every test that builds a `ModuleContext` by hand must supply both.
  - `ENGINE_VERSION === '1.2.0'`.

- [ ] **Step 1: Write the failing tests**

Create `tests/engine/dilution.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { computeDrivers, type Drivers } from '../../src/drivers/compute.js';
import { EngineError } from '../../src/engine/errors.js';
import { getModule } from '../../src/engine/modules/registry.js';
import type { ModuleContext } from '../../src/engine/modules/types.js';
import { postHorizonSupply } from '../../src/engine/supply.js';
import { hypeObservations, loadFixture } from '../fixtures/contrast.js';
import { miniAsset, miniAssumptions } from '../helpers/assets.js';
import { AS_OF, miniObservations } from '../helpers/obs.js';

const asset = miniAsset();
const a = miniAssumptions().base;
const driversFor = (emission: number): Drivers => computeDrivers(asset, miniObservations({ emission }), AS_OF).drivers!;

describe('postHorizonSupply', () => {
  it('holds supply flat with no emissions', () => {
    const post = postHorizonSupply({ asset, drivers: driversFor(0), horizonYears: 1, supplyAtHorizon: 100 });
    expect(post.terminalEmission).toBe(0);
    expect(post.supplyAt(0)).toBe(100);
    expect(post.supplyAt(3.5)).toBe(100);
  });

  it('adds the last emission step each year and interpolates linearly inside a year', () => {
    const post = postHorizonSupply({ asset, drivers: driversFor(10), horizonYears: 1, supplyAtHorizon: 110 });
    expect(post.terminalEmission).toBe(10);
    expect(post.supplyAt(1)).toBeCloseTo(120, 12);
    expect(post.supplyAt(2.5)).toBeCloseTo(135, 12);
  });

  it('does not shrink supply for burn flows: holder_cashflow already values those dollars', () => {
    const drivers = driversFor(0);
    drivers.holderFlows[0].kind = 'burn';
    const post = postHorizonSupply({ asset, drivers, horizonYears: 1, supplyAtHorizon: 100 });
    expect(post.supplyAt(5)).toBe(100);
  });

  it('adds scheduled unlocks in the year they fall, on the circulating basis only', () => {
    const hype = loadFixture('hype');
    const list = hypeObservations(100).map((o) =>
      o.metricKey === 'scheduled_unlock_tokens' ? { ...o, observedAt: '2028-03-31T00:00:00.000Z' } : o, // 1.75 years out
    );
    const drivers = computeDrivers(hype, list, AS_OF).drivers!;
    const args = { asset: hype, drivers, horizonYears: 1, supplyAtHorizon: 300 };
    expect(postHorizonSupply(args).supplyAt(0.5)).toBeCloseTo(350, 9); // the unlock lands in the first year after H
    expect(postHorizonSupply(args).supplyAt(1)).toBeCloseTo(400, 9);
    expect(postHorizonSupply(args).supplyAt(2)).toBeCloseTo(400, 9);
    expect(postHorizonSupply({ ...args, basis: 'effective_total' }).supplyAt(2)).toBeCloseTo(300, 9);
  });
});

describe('holder_cashflow per-token discounting', () => {
  const m = getModule('holder_cashflow');
  const ctxFor = (drivers: Drivers, supplyAtHorizon: number, over: Partial<ModuleContext> = {}): ModuleContext => {
    const post = postHorizonSupply({ asset, drivers, horizonYears: 1, supplyAtHorizon });
    return {
      instanceId: 'hc', params: {}, drivers, assumptions: a, horizonYears: 1, supplyAtHorizon, priceAtHorizon: 10,
      stakingYieldAtHorizon: 0, supplyAfterHorizon: post.supplyAt, terminalEmissionRate: post.terminalEmission, ...over,
    };
  };

  it('equals the 1.1.0 value when nothing dilutes after the horizon', () => {
    const r = m.compute(ctxFor(driversFor(0), 100));
    expect(r.valuePerToken).toBeCloseTo(10, 10); // 100 / 0.10 / 100
    expect(r.breakdown.aggregate_pv_usd).toBeCloseTo(1000, 8);
    expect(r.breakdown.net_dilution_terminal).toBe(0);
    expect(r.breakdown.per_token_growth_terminal).toBe(0);
    expect(r.breakdown.supply_path).toEqual([100, 100, 100, 100, 100, 100]);
  });

  it('matches the hand-derived value for constant emissions', () => {
    // Flat 100 USD per year; supply 110 at the horizon growing by 10 per year; r = 10 percent; g = 0.
    //   explicit: 100/115/1.1 + 100/125/1.1^2 + 100/135/1.1^3 + 100/145/1.1^4 + 100/155/1.1^5 = 2.8798385...
    //   terminal: delta = 10/160 = 0.0625; g_pt = 1/1.0625 - 1 = -1/17;
    //             (100/155) * (1 + g_pt) / (0.1 - g_pt) / 1.1^5 = 2.3738927...
    const r = m.compute(ctxFor(driversFor(10), 110));
    expect(r.valuePerToken).toBeCloseTo(5.253731257665621, 10);
    expect(r.breakdown.net_dilution_terminal).toBeCloseTo(0.0625, 12);
    expect(r.breakdown.per_token_growth_terminal).toBeCloseTo(-1 / 17, 12);
    expect(r.breakdown.supply_path).toEqual([110, 120, 130, 140, 150, 160]);
    const flows = r.breakdown.flows as Record<string, { explicit_pv_per_token: number; terminal_pv_per_token: number; explicit_pv_usd: number }>;
    expect(flows.fees.explicit_pv_per_token).toBeCloseTo(2.879838505229187, 10);
    expect(flows.fees.terminal_pv_per_token).toBeCloseTo(2.3738927524364346, 10);
    expect(flows.fees.explicit_pv_usd).toBeCloseTo(2.879838505229187 * 110, 8);
  });

  it('values a burn flow exactly like a fee flow: burns are cash flow, not extra shrinkage', () => {
    const burning = driversFor(10);
    burning.holderFlows[0].kind = 'burn';
    expect(m.compute(ctxFor(burning, 110)).valuePerToken).toBeCloseTo(5.253731257665621, 10);
  });

  it('throws when the discount rate does not exceed terminal per-token growth', () => {
    const c = ctxFor(driversFor(0), 100, { assumptions: { ...a, terminal_growth: 0.1 } });
    expect(() => m.compute(c)).toThrow(EngineError);
    expect(() => m.compute(c)).toThrow(/per-token growth/);
  });

  it('lets dilution rescue a discount rate equal to aggregate growth, because per-token growth is lower', () => {
    const c = ctxFor(driversFor(10), 110, { assumptions: { ...a, terminal_growth: 0.1 } });
    expect(Number.isFinite(m.compute(c).valuePerToken)).toBe(true);
  });
});
```

In `tests/engine/modules.test.ts`, replace:

```ts
    stakingYieldAtHorizon: 0,
    ...over,
```

with:

```ts
    stakingYieldAtHorizon: 0,
    supplyAfterHorizon: () => 100,
    terminalEmissionRate: 0,
    ...over,
```

In `tests/engine/utilityClaim.test.ts`, replace:

```ts
    horizonYears: 1, supplyAtHorizon: 1000, priceAtHorizon: 5, stakingYieldAtHorizon: 0.1,
```

with:

```ts
    horizonYears: 1, supplyAtHorizon: 1000, priceAtHorizon: 5, stakingYieldAtHorizon: 0.1,
    supplyAfterHorizon: () => 1000, terminalEmissionRate: 0,
```

In `tests/engine/run.test.ts`, replace:

```ts
    const diluted = run({ emission: 10 }).horizons['12m'];
    expect(diluted.expectedTarget).toBeCloseTo(1000 / 110, 6);
    // staker APR = 10 / (0.5 * 110); total return = (target/spot) * (1 + y) - 1
    const y = 10 / (0.5 * 110);
    expect(diluted.stakedTotalReturnPct).toBeCloseTo(((1000 / 110 / 10) * (1 + y) - 1) * 100, 6);
```

with:

```ts
    const diluted = run({ emission: 10 }).horizons['12m'];
    // Supply is 110 at the horizon and keeps growing by 10 per year, so the target is below the
    // 1.1.0 figure of 1000 / 110. Hand derivation: tests/engine/dilution.test.ts.
    expect(diluted.expectedTarget).toBeCloseTo(DILUTED_MINI, 6);
    expect(diluted.expectedTarget).toBeLessThan(1000 / 110);
    // staker APR = 10 / (0.5 * 110); total return = (target/spot) * (1 + y) - 1
    const y = 10 / (0.5 * 110);
    expect(diluted.stakedTotalReturnPct).toBeCloseTo(((DILUTED_MINI / 10) * (1 + y) - 1) * 100, 6);
```

In `tests/engine/run.test.ts`, replace:

```ts
describe('runEngine', () => {
  it('values the flat mini asset at its perpetuity value in every scenario', () => {
```

with:

```ts
/** Mini asset with emission 10: per-token holder_cashflow value, derived by hand in tests/engine/dilution.test.ts. */
const DILUTED_MINI = 5.253731257665621;

describe('runEngine', () => {
  it('values the flat mini asset at its perpetuity value in every scenario', () => {
```

In `tests/engine/run.test.ts`, replace:

```ts
    expect(h.extras.locked_total_return_pct).toBeCloseTo(((1000 / 110 / 10) * (1 + y) - 1) * 100, 6);
```

with:

```ts
    expect(h.extras.locked_total_return_pct).toBeCloseTo(((DILUTED_MINI / 10) * (1 + y) - 1) * 100, 6);
```

In `tests/engine/contrast.test.ts`, replace:

```ts
    // flat fees of 1000: hc = 1000/0.2 = 5000, fm = 1000*5 = 5000, both over supply 1200
    expect(heavy.expectedTarget).toBeCloseTo(5000 / 1200, 6);
    expect(heavy.stakedTotalReturnPct).toBeGreaterThan(heavy.upsidePct);
```

with:

```ts
    // fm = 1000 * 5 / 1200. hc no longer equals it: supply runs 1200, 1400, ... 2200 after the horizon,
    // so delta = 200/2200 and g_pt = -1/12, and twenty percent inflation costs hc about 40 percent.
    expect(heavy.modules.fm_flow.value).toBeCloseTo(5000 / 1200, 9);
    expect(heavy.modules.hc.value).toBeCloseTo(2.508729350189619, 9);
    expect(heavy.modules.hc.breakdown.supply_path).toEqual([1200, 1400, 1600, 1800, 2000, 2200]);
    expect(heavy.expectedTarget).toBeCloseTo(0.6 * 2.508729350189619 + 0.4 * (5000 / 1200), 9);
    expect(none.modules.hc.value).toBeCloseTo(5, 9); // no emissions: the 1.1.0 value, 1000 / 0.2 / 1000
    expect(heavy.stakedTotalReturnPct).toBeGreaterThan(heavy.upsidePct);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/engine`
Expected: FAIL. `dilution.test.ts` fails on the missing export `postHorizonSupply`; `npm run typecheck` reports the unknown `supplyAfterHorizon` property.

- [ ] **Step 3: Implement**

Append to `src/engine/supply.ts`:

```ts

export interface PostHorizonSupply {
  /** S(H + tau): supply tau years after the horizon. Yearly steps, linear in between. */
  supplyAt(tau: number): number;
  /** E: the last known emission schedule step in tokens per year, held flat after the horizon. */
  terminalEmission: number;
}

/**
 * Supply path after the horizon: S(n+1) = S(n) + E, plus scheduled unlocks that fall in that year on
 * the circulating basis. Burns are deliberately absent: holder_cashflow already values burn dollars
 * as holder cash flow, and shrinking supply by the same burns would count them twice.
 * Pure: the yearly steps are a deterministic function of the arguments.
 */
export function postHorizonSupply(args: {
  asset: AssetConfig;
  drivers: Drivers;
  horizonYears: number;
  supplyAtHorizon: number;
  basis?: AssetConfig['supply_basis'];
}): PostHorizonSupply {
  const { asset, drivers, horizonYears: H, supplyAtHorizon } = args;
  const circulating = (args.basis ?? asset.supply_basis) === 'circulating';
  const terminalEmission = drivers.emissionSchedule.at(-1)?.value ?? 0;

  const yearly = [supplyAtHorizon];
  const extendTo = (n: number) => {
    while (yearly.length <= n) {
      const year = yearly.length - 1; // this step covers (H + year, H + year + 1]
      let next = yearly[year] + terminalEmission;
      if (circulating) {
        for (const u of drivers.scheduledUnlocks) {
          const t = yearsBetween(drivers.asOf, u.at) - H;
          if (t > year && t <= year + 1) next += u.tokens;
        }
      }
      yearly.push(next);
    }
  };

  return {
    terminalEmission,
    supplyAt(tau: number): number {
      if (tau <= 0) return supplyAtHorizon;
      const n = Math.floor(tau);
      extendTo(n + 1);
      return yearly[n] + (yearly[n + 1] - yearly[n]) * (tau - n);
    },
  };
}
```

In `src/engine/modules/types.ts`, replace:

```ts
  stakingYieldAtHorizon: number;
}
```

with:

```ts
  stakingYieldAtHorizon: number;
  /** S(H + tau): forecast supply tau years after the horizon. Computed by the engine; pure. */
  supplyAfterHorizon(tau: number): number;
  /** E: the last known emission schedule step in tokens per year, held flat after the horizon. */
  terminalEmissionRate: number;
}
```

In `src/engine/run.ts`, replace:

```ts
import { emissionsBetween, forecastSupply } from './supply.js';
```

with:

```ts
import { emissionsBetween, forecastSupply, postHorizonSupply } from './supply.js';
```

In `src/engine/run.ts`, replace:

```ts
    modules = {};
    let next = 0;
```

with:

```ts
    const post = postHorizonSupply({ asset, drivers, horizonYears: H, supplyAtHorizon: supply });
    modules = {};
    let next = 0;
```

In `src/engine/run.ts`, replace:

```ts
        stakingYieldAtHorizon: stakingYield,
      });
```

with:

```ts
        stakingYieldAtHorizon: stakingYield,
        supplyAfterHorizon: post.supplyAt,
        terminalEmissionRate: post.terminalEmission,
      });
```

In `src/engine/modules/holderCashflow.ts`, replace:

```ts
  compute(ctx) {
    const N = years(ctx.params);
    const H = ctx.horizonYears;
    const g = need(ctx.assumptions, 'terminal_growth');
    let aggregate = 0;
    const flows: Record<string, unknown> = {};

    for (const f of ctx.drivers.holderFlows) {
      const r = discountRateFor(f.captureRule, ctx.assumptions);
      if (r <= g) throw new EngineError(`discount rate ${r} must exceed terminal growth ${g} (flow ${f.id})`);
      let pv = 0;
      let last = 0;
      for (let t = 1; t <= N; t++) {
        last = flowUsdAt(H + t - 0.5, f, ctx.drivers, ctx.assumptions);
        pv += last / Math.pow(1 + r, t);
      }
      const terminal = (last * (1 + g)) / (r - g) / Math.pow(1 + r, N);
      aggregate += pv + terminal;
      flows[f.id] = {
        discount_rate: r,
        capture_rule: f.captureRule,
        recipient_base: f.recipientBase,
        explicit_pv_usd: pv,
        terminal_pv_usd: terminal,
      };
    }

    return {
      valuePerToken: aggregate / ctx.supplyAtHorizon,
      breakdown: {
        aggregate_pv_usd: aggregate,
        supply_at_horizon: ctx.supplyAtHorizon,
        explicit_years: N,
        flows,
        note: 'Aggregate holder-flow value divided by total forecast supply, whatever the recipient base.',
      },
    };
  },
```

with:

```ts
  compute(ctx) {
    const N = years(ctx.params);
    const H = ctx.horizonYears;
    const g = need(ctx.assumptions, 'terminal_growth');
    const supplyAtHorizon = ctx.supplyAtHorizon;

    // Per-token discounting: each year's flow is divided by the supply forecast for that year, so
    // emissions after the horizon dilute the claim instead of being ignored.
    const supplyPath = Array.from({ length: N + 1 }, (_, n) => ctx.supplyAfterHorizon(n));
    const delta = ctx.terminalEmissionRate / supplyPath[N];
    const gPerToken = (1 + g) / (1 + delta) - 1;

    let value = 0;
    const flows: Record<string, unknown> = {};
    for (const f of ctx.drivers.holderFlows) {
      const r = discountRateFor(f.captureRule, ctx.assumptions);
      if (r <= gPerToken) {
        throw new EngineError(`discount rate ${r} must exceed terminal per-token growth ${gPerToken} (flow ${f.id})`);
      }
      let pv = 0;
      let last = 0;
      for (let t = 1; t <= N; t++) {
        last = flowUsdAt(H + t - 0.5, f, ctx.drivers, ctx.assumptions) / ctx.supplyAfterHorizon(t - 0.5);
        pv += last / Math.pow(1 + r, t);
      }
      const terminal = (last * (1 + gPerToken)) / (r - gPerToken) / Math.pow(1 + r, N);
      value += pv + terminal;
      flows[f.id] = {
        discount_rate: r,
        capture_rule: f.captureRule,
        recipient_base: f.recipientBase,
        explicit_pv_per_token: pv,
        terminal_pv_per_token: terminal,
        explicit_pv_usd: pv * supplyAtHorizon,
        terminal_pv_usd: terminal * supplyAtHorizon,
      };
    }

    return {
      valuePerToken: value,
      breakdown: {
        aggregate_pv_usd: value * supplyAtHorizon,
        supply_at_horizon: supplyAtHorizon,
        explicit_years: N,
        net_dilution_terminal: delta,
        per_token_growth_terminal: gPerToken,
        supply_path: supplyPath,
        flows,
        note:
          'Per-token holder flows, discounted. Supply after the horizon follows supply_path (emissions and ' +
          'unlocks; burns are valued as cash flow, not counted again as shrinkage), whatever the recipient base. ' +
          'The *_usd figures are the per-token values times supply at the horizon.',
      },
    };
  },
```

In `src/engine/version.ts`, replace:

```ts
export const ENGINE_VERSION = '1.1.0';
```

with:

```ts
export const ENGINE_VERSION = '1.2.0';
```

- [ ] **Step 4: Run the engine tests**

Run: `npx vitest run tests/engine && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Update the VVV golden test once**

Only `holder_cashflow` moved on purpose; `fm_*` and `diem` move slightly because the blended target feeds the supply fixed point. These numbers came from the planning prototype.

In `tests/assets/vvv.golden.test.ts`, replace:

```ts
    expect(h12.expectedTarget).toBeCloseTo(34.43742233806968, 6);
    expect(h12.modules.hc.value).toBeCloseTo(17.093183770490626, 6);
    expect(h12.modules.fm_revenue.value).toBeCloseTo(73.2339498272557, 6);
    expect(h12.modules.fm_holder_flow.value).toBeCloseTo(18.10575418426764, 6);
    expect(h12.modules.diem.value).toBeCloseTo(0.19823762641642734, 6);
    expect(h12.scenarios.base.supplyAtHorizon).toBeCloseTo(82482168.27988559, 2);
```

with:

```ts
    expect(h12.expectedTarget).toBeCloseTo(33.09189067465379, 6);
    expect(h12.modules.hc.value).toBeCloseTo(13.680588298103167, 6); // 17.0932 under engine 1.1.0, before post-horizon dilution
    expect(h12.modules.fm_revenue.value).toBeCloseTo(73.24089032332991, 6);
    expect(h12.modules.fm_holder_flow.value).toBeCloseTo(18.10761428046546, 6);
    expect(h12.modules.diem.value).toBeCloseTo(0.215103974273912, 6);
    expect(h12.scenarios.base.supplyAtHorizon).toBeCloseTo(82479613.28300588, 2);
    expect(h12.modules.hc.breakdown.net_dilution_terminal).toBeCloseTo(2000000 / 92479613.28300588, 9);
```

In `tests/assets/vvv.golden.test.ts`, replace:

```ts
    expect(h6.expectedTarget).toBeCloseTo(24.881156582397576, 6);
    expect(h6.modules.hc.value).toBeCloseTo(16.21213497987913, 6);
    expect(h6.modules.fm_revenue.value).toBeCloseTo(49.77223505431847, 6);
    expect(h6.modules.fm_holder_flow.value).toBeCloseTo(10.604722452813144, 6);
    expect(h6.modules.diem.value).toBeCloseTo(0.2832153383064402, 6);
    expect(h6.scenarios.base.supplyAtHorizon).toBeCloseTo(81776568.7907713, 2);
```

with:

```ts
    expect(h6.expectedTarget).toBeCloseTo(23.54875825524369, 6);
    expect(h6.modules.hc.value).toBeCloseTo(12.840285411368317, 6);
    expect(h6.modules.fm_revenue.value).toBeCloseTo(49.7747476937811, 6);
    expect(h6.modules.fm_holder_flow.value).toBeCloseTo(10.605299526641362, 6);
    expect(h6.modules.diem.value).toBeCloseTo(0.29862992456962256, 6);
    expect(h6.scenarios.base.supplyAtHorizon).toBeCloseTo(81775278.851763, 2);
```

In `tests/assets/vvv.golden.test.ts`, replace:

```ts
    expect(hash).toBe('ef7604ad419e5db2f96f64762f061bd9e3ca1ca18d602fbf3ee5a8be6ef54860');
```

with:

```ts
    expect(hash).toBe('6b3f9fa36241c2071c0108d5b5d0b2cf5dba2d0ccd574c65f53da9e3c519311a');
```

The hash covers the breakdown, including the `note` text. If the readable assertions above pass and only the hash differs, a breakdown string differs from this plan: compare it with Step 3 first. Pin the hash the test reports only after that check.

- [ ] **Step 6: Run the whole suite**

Run: `npm test && npm run typecheck`
Expected: PASS. (The test count grows by 9 from the 133 on `main`.)

- [ ] **Step 7: Commit**

```bash
git add src/engine tests/engine tests/assets/vvv.golden.test.ts
git commit -m "feat(engine): holder_cashflow discounts per-token flows along a post-horizon supply path (engine 1.2.0)"
```

---

## Task group B: storage and configuration

### Task 2: Migration 2, the fetch log, and scan cursors

**Files:**
- Modify: `src/db/migrations.ts`, `tests/db/connection.test.ts`
- Create: `src/db/fetchRuns.ts`, `src/db/fetchCursors.ts`, `tests/db/fetchRuns.test.ts`, `tests/db/fetchCursors.test.ts`

**Interfaces:**
- Consumes: `Db`, `openDb` (`src/db/connection.ts`).
- Produces (`src/db/fetchRuns.ts`). These detail types are the shape of `fetch_runs.detail` and are used by every ingest task:

```ts
export type FetchOutcome = 'ok' | 'partial' | 'failed';
export type SourceStatus = 'ok' | 'failed' | 'skipped';
export interface CrossCheckRecord { metricKey: string; sourceId: string; label: string; primary: number; check: number; diffPct: number; tolerancePct: number; ok: boolean }
export interface UnlistedTransfer { txHash: string; logIndex: number; blockNumber: number; from: string; tokens: number; day: string }
export interface FlowConflict { metricKey: string; observationId: number; source: string; observedAt: string; periodDays: number | null; adoptable: boolean }
export interface SourceOutcome { sourceId: string; status: SourceStatus; error: string | null; metricsWritten: string[]; crossChecks: CrossCheckRecord[]; unlistedTransfers: UnlistedTransfer[]; conflicts: FlowConflict[]; retiredObservationIds: number[]; notes: string[] }
export interface FetchRunDetail { sources: SourceOutcome[] }
export interface FetchRun { id: number; assetId: string; startedAt: string; endedAt: string; outcome: FetchOutcome; detail: FetchRunDetail }
export function emptySourceOutcome(sourceId: string): SourceOutcome
export function insertFetchRun(db: Db, run: Omit<FetchRun, 'id'>): number
export function listFetchRuns(db: Db, assetId: string, limit: number): FetchRun[]            // newest first
export function recentSourceStatuses(db: Db, assetId: string, sourceId: string, limit: number): SourceStatus[]  // newest first
```

- Produces (`src/db/fetchCursors.ts`):

```ts
export interface FetchCursor { lastBlock: number; lastDay: string }   // lastDay is 'YYYY-MM-DD'
export function getCursor(db: Db, assetId: string, scanKey: string): FetchCursor | null
export function advanceCursor(db: Db, assetId: string, scanKey: string, cursor: FetchCursor, nowIso: string): void  // never moves backwards
```

`label` on a `CrossCheckRecord` is `'level'` for a level comparison and the month (`'2026-08'`) for a monthly-sum comparison. `recentSourceStatuses` looks only at runs whose detail mentions the source, and ignores `skipped` entries: a source that was not attempted neither extends nor breaks a failure streak.

- [ ] **Step 1: Write the failing tests**

Create `tests/db/fetchRuns.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/connection.js';
import { emptySourceOutcome, insertFetchRun, listFetchRuns, recentSourceStatuses, type SourceStatus } from '../../src/db/fetchRuns.js';

let db: Db;
beforeEach(() => {
  db = openDb(':memory:');
});

function run(at: string, sources: [string, SourceStatus][], assetId = 'mini'): number {
  return insertFetchRun(db, {
    assetId, startedAt: at, endedAt: at, outcome: sources.every(([, s]) => s === 'ok') ? 'ok' : 'partial',
    detail: { sources: sources.map(([id, status]) => ({ ...emptySourceOutcome(id), status })) },
  });
}

describe('fetch runs', () => {
  it('round-trips the detail JSON and lists newest first', () => {
    const first = run('2026-09-18T00:00:00.000Z', [['coingecko', 'ok']]);
    const second = insertFetchRun(db, {
      assetId: 'mini', startedAt: '2026-09-19T00:00:00.000Z', endedAt: '2026-09-19T00:00:05.000Z', outcome: 'partial',
      detail: { sources: [{ ...emptySourceOutcome('chain_levels'), status: 'failed', error: 'boom', notes: ['n'] }] },
    });
    const list = listFetchRuns(db, 'mini', 10);
    expect(list.map((r) => r.id)).toEqual([second, first]);
    expect(list[0].outcome).toBe('partial');
    expect(list[0].endedAt).toBe('2026-09-19T00:00:05.000Z');
    expect(list[0].detail.sources[0]).toEqual({ ...emptySourceOutcome('chain_levels'), status: 'failed', error: 'boom', notes: ['n'] });
    expect(listFetchRuns(db, 'mini', 1)).toHaveLength(1);
    expect(listFetchRuns(db, 'other', 10)).toEqual([]);
  });

  it('reports the recent statuses of one source, newest first', () => {
    run('2026-09-16T00:00:00.000Z', [['coingecko', 'ok'], ['chain_levels', 'ok']]);
    run('2026-09-17T00:00:00.000Z', [['coingecko', 'failed'], ['chain_levels', 'ok']]);
    run('2026-09-18T00:00:00.000Z', [['coingecko', 'failed']]);
    expect(recentSourceStatuses(db, 'mini', 'coingecko', 2)).toEqual(['failed', 'failed']);
    expect(recentSourceStatuses(db, 'mini', 'coingecko', 5)).toEqual(['failed', 'failed', 'ok']);
  });

  it('skips runs that did not include the source, and skipped entries', () => {
    run('2026-09-16T00:00:00.000Z', [['flow', 'failed']]);
    run('2026-09-17T00:00:00.000Z', [['coingecko', 'ok']]); // a --metric run that never touched "flow"
    run('2026-09-18T00:00:00.000Z', [['flow', 'skipped']]);
    run('2026-09-19T00:00:00.000Z', [['flow', 'failed']]);
    expect(recentSourceStatuses(db, 'mini', 'flow', 5)).toEqual(['failed', 'failed']);
    expect(recentSourceStatuses(db, 'other', 'flow', 5)).toEqual([]);
  });
});
```

Create `tests/db/fetchCursors.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/connection.js';
import { advanceCursor, getCursor } from '../../src/db/fetchCursors.js';

let db: Db;
beforeEach(() => {
  db = openDb(':memory:');
});

describe('fetch cursors', () => {
  it('returns null before the first scan', () => {
    expect(getCursor(db, 'mini', 'scan-a')).toBeNull();
  });

  it('stores and advances one cursor per asset and scan key', () => {
    advanceCursor(db, 'mini', 'scan-a', { lastBlock: 100, lastDay: '2026-09-16' }, '2026-09-19T00:00:00.000Z');
    advanceCursor(db, 'mini', 'scan-b', { lastBlock: 7, lastDay: '2026-09-01' }, '2026-09-19T00:00:00.000Z');
    advanceCursor(db, 'mini', 'scan-a', { lastBlock: 200, lastDay: '2026-09-17' }, '2026-09-19T00:01:00.000Z');
    expect(getCursor(db, 'mini', 'scan-a')).toEqual({ lastBlock: 200, lastDay: '2026-09-17' });
    expect(getCursor(db, 'mini', 'scan-b')).toEqual({ lastBlock: 7, lastDay: '2026-09-01' });
  });

  it('never moves backwards, so a forced re-scan of old days leaves the cursor alone', () => {
    advanceCursor(db, 'mini', 'scan-a', { lastBlock: 200, lastDay: '2026-09-17' }, '2026-09-19T00:00:00.000Z');
    advanceCursor(db, 'mini', 'scan-a', { lastBlock: 50, lastDay: '2026-09-10' }, '2026-09-19T00:01:00.000Z');
    expect(getCursor(db, 'mini', 'scan-a')).toEqual({ lastBlock: 200, lastDay: '2026-09-17' });
  });
});
```

In `tests/db/connection.test.ts`, replace:

```ts
    for (const t of ['observations', 'assumption_sets', 'assumptions', 'config_versions', 'snapshots', 'valuation_runs', 'signals']) {
      expect(names).toContain(t);
    }
  });
```

with:

```ts
    for (const t of ['observations', 'assumption_sets', 'assumptions', 'config_versions', 'snapshots', 'valuation_runs', 'signals']) {
      expect(names).toContain(t);
    }
  });

  it('creates the sub-project 2 tables in migration 2', () => {
    const db = openDb(':memory:');
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => (r as { name: string }).name);
    for (const t of ['fetch_runs', 'fetch_cursors', 'anomalies']) expect(names).toContain(t);
  });
```

In `tests/db/connection.test.ts`, replace:

```ts
    expect(row.n).toBe(1);
```

with:

```ts
    expect(row.n).toBe(2);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/db`
Expected: FAIL (missing modules `fetchRuns.js` and `fetchCursors.js`; `fetch_runs` table absent).

- [ ] **Step 3: Implement**

In `src/db/migrations.ts`, replace:

```ts
  emitted_at TEXT NOT NULL
);
`,
  },
];
```

with:

```ts
  emitted_at TEXT NOT NULL
);
`,
  },
  {
    id: 2,
    sql: `
CREATE TABLE fetch_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('ok','partial','failed')),
  detail_json TEXT NOT NULL
);
CREATE INDEX idx_fetch_runs_asset ON fetch_runs (asset_id, id);

CREATE TABLE fetch_cursors (
  asset_id TEXT NOT NULL,
  scan_key TEXT NOT NULL,
  last_block INTEGER NOT NULL,
  last_day TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (asset_id, scan_key)
);

CREATE TABLE anomalies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('cross_check_mismatch','unlisted_sender','source_failure_streak','revenue_disclosure_stale')),
  metric_key TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('degrading','advisory')),
  status TEXT NOT NULL CHECK (status IN ('open','resolved','acknowledged')),
  detail_json TEXT NOT NULL,
  occurrences INTEGER NOT NULL DEFAULT 1,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  note TEXT,
  decided_at TEXT
);
CREATE INDEX idx_anomalies_asset ON anomalies (asset_id, status);
CREATE UNIQUE INDEX idx_anomalies_one_open ON anomalies (asset_id, kind, metric_key, dedupe_key) WHERE status = 'open';
`,
  },
];
```

Create `src/db/fetchRuns.ts`:

```ts
import type { Db } from './connection.js';

export type FetchOutcome = 'ok' | 'partial' | 'failed';
export type SourceStatus = 'ok' | 'failed' | 'skipped';

/** One cross-check comparison. `label` is 'level', or the month ('2026-08') of a monthly-sum comparison. */
export interface CrossCheckRecord {
  metricKey: string;
  sourceId: string;
  label: string;
  primary: number;
  check: number;
  diffPct: number;
  tolerancePct: number;
  ok: boolean;
}

/** A transfer to the sink from a sender that is not on the allowlist. Excluded from the flow. */
export interface UnlistedTransfer {
  txHash: string;
  logIndex: number;
  blockNumber: number;
  from: string;
  tokens: number;
  day: string;
}

/** An active row from another source whose period overlaps a flow row the scan wants to write. */
export interface FlowConflict {
  metricKey: string;
  observationId: number;
  source: string;
  observedAt: string;
  periodDays: number | null;
  /** True when --adopt may reject it: only rows whose source is 'manual'. */
  adoptable: boolean;
}

export interface SourceOutcome {
  sourceId: string;
  status: SourceStatus;
  error: string | null;
  metricsWritten: string[];
  crossChecks: CrossCheckRecord[];
  unlistedTransfers: UnlistedTransfer[];
  conflicts: FlowConflict[];
  retiredObservationIds: number[];
  notes: string[];
}

export interface FetchRunDetail {
  sources: SourceOutcome[];
}

export interface FetchRun {
  id: number;
  assetId: string;
  startedAt: string;
  endedAt: string;
  outcome: FetchOutcome;
  detail: FetchRunDetail;
}

export function emptySourceOutcome(sourceId: string): SourceOutcome {
  return {
    sourceId, status: 'ok', error: null, metricsWritten: [], crossChecks: [], unlistedTransfers: [],
    conflicts: [], retiredObservationIds: [], notes: [],
  };
}

interface Row {
  id: number;
  asset_id: string;
  started_at: string;
  ended_at: string;
  outcome: FetchOutcome;
  detail_json: string;
}

function fromRow(r: Row): FetchRun {
  return {
    id: r.id, assetId: r.asset_id, startedAt: r.started_at, endedAt: r.ended_at, outcome: r.outcome,
    detail: JSON.parse(r.detail_json) as FetchRunDetail,
  };
}

export function insertFetchRun(db: Db, run: Omit<FetchRun, 'id'>): number {
  const info = db
    .prepare('INSERT INTO fetch_runs (asset_id, started_at, ended_at, outcome, detail_json) VALUES (?, ?, ?, ?, ?)')
    .run(run.assetId, run.startedAt, run.endedAt, run.outcome, JSON.stringify(run.detail));
  return Number(info.lastInsertRowid);
}

export function listFetchRuns(db: Db, assetId: string, limit: number): FetchRun[] {
  const rows = db.prepare('SELECT * FROM fetch_runs WHERE asset_id = ? ORDER BY id DESC LIMIT ?').all(assetId, limit) as Row[];
  return rows.map(fromRow);
}

/**
 * The last `limit` attempted outcomes of one source, newest first. Runs that did not include the
 * source (a --metric run, say) and 'skipped' entries are passed over: a source that was not
 * attempted neither extends nor breaks a failure streak.
 */
export function recentSourceStatuses(db: Db, assetId: string, sourceId: string, limit: number): SourceStatus[] {
  const out: SourceStatus[] = [];
  const rows = db.prepare('SELECT * FROM fetch_runs WHERE asset_id = ? ORDER BY id DESC').iterate(assetId) as IterableIterator<Row>;
  for (const row of rows) {
    const entry = fromRow(row).detail.sources.find((s) => s.sourceId === sourceId);
    if (!entry || entry.status === 'skipped') continue;
    out.push(entry.status);
    if (out.length >= limit) break;
  }
  return out;
}
```

Create `src/db/fetchCursors.ts`:

```ts
import type { Db } from './connection.js';

/** Where a resumable log scan stopped: the last fully written UTC day and that day's last block. */
export interface FetchCursor {
  lastBlock: number;
  lastDay: string;
}

export function getCursor(db: Db, assetId: string, scanKey: string): FetchCursor | null {
  const row = db.prepare('SELECT last_block, last_day FROM fetch_cursors WHERE asset_id = ? AND scan_key = ?').get(assetId, scanKey) as
    | { last_block: number; last_day: string }
    | undefined;
  return row ? { lastBlock: row.last_block, lastDay: row.last_day } : null;
}

/** Moves the cursor forward. A cursor never moves backwards: a forced re-scan of old days leaves it alone. */
export function advanceCursor(db: Db, assetId: string, scanKey: string, cursor: FetchCursor, nowIso: string): void {
  db.prepare(
    `INSERT INTO fetch_cursors (asset_id, scan_key, last_block, last_day, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (asset_id, scan_key) DO UPDATE SET
       last_block = excluded.last_block, last_day = excluded.last_day, updated_at = excluded.updated_at
     WHERE excluded.last_day > fetch_cursors.last_day`,
  ).run(assetId, scanKey, cursor.lastBlock, cursor.lastDay, nowIso);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/db && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db tests/db
git commit -m "feat(db): migration 2 with the fetch log, scan cursors, and the anomalies table"
```

### Task 3: Anomaly store and lifecycle

Lifecycle (spec 6.3): `open` to `resolved` or `acknowledged`, each with a note. A repeat of an OPEN anomaly with the same `(asset, kind, metric, dedupe_key)` increments `occurrences` and updates `last_seen_at`, `detail`, and `severity` instead of inserting a row. A resolved or acknowledged anomaly that recurs opens a NEW row. `dedupe_key` is the cross-check source id, the sender address, the source id, or (for `revenue_disclosure_stale`) the disclosure's `observed_at`. `metric_key` is `''` for `source_failure_streak`, which belongs to a source rather than a metric.

**Files:**
- Create: `src/db/anomalies.ts`, `tests/db/anomalies.test.ts`

**Interfaces:**
- Consumes: the `anomalies` table from Task 2; `OrionError`.
- Produces:

```ts
export type AnomalyKind = 'cross_check_mismatch' | 'unlisted_sender' | 'source_failure_streak' | 'revenue_disclosure_stale';
export type AnomalySeverity = 'degrading' | 'advisory';
export type AnomalyStatus = 'open' | 'resolved' | 'acknowledged';
export interface Anomaly { id: number; assetId: string; kind: AnomalyKind; metricKey: string; dedupeKey: string; severity: AnomalySeverity; status: AnomalyStatus; detail: Record<string, unknown>; occurrences: number; firstSeenAt: string; lastSeenAt: string; note: string | null; decidedAt: string | null }
export interface RaiseAnomalyInput { assetId: string; kind: AnomalyKind; metricKey: string; dedupeKey: string; severity: AnomalySeverity; detail: Record<string, unknown>; seenAt: string }
export function raiseAnomaly(db: Db, input: RaiseAnomalyInput): Anomaly
export function getAnomaly(db: Db, id: number): Anomaly | null
export function listAnomalies(db: Db, filter?: { assetId?: string; includeDecided?: boolean }): Anomaly[]   // newest first; open only unless includeDecided
export function listOpenAnomalies(db: Db, assetId: string): Anomaly[]                                        // oldest first
export function decideAnomaly(db: Db, id: number, status: 'resolved' | 'acknowledged', note: string, nowIso: string): Anomaly
```

`decideAnomaly` throws `OrionError` with code `note_required` (blank note), `anomaly_not_found`, or `anomaly_not_open`.

- [ ] **Step 1: Write the failing test**

Create `tests/db/anomalies.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { decideAnomaly, getAnomaly, listAnomalies, listOpenAnomalies, raiseAnomaly, type RaiseAnomalyInput } from '../../src/db/anomalies.js';
import { openDb, type Db } from '../../src/db/connection.js';
import type { OrionError } from '../../src/types.js';

let db: Db;
beforeEach(() => {
  db = openDb(':memory:');
});

const mismatch = (over: Partial<RaiseAnomalyInput> = {}): RaiseAnomalyInput => ({
  assetId: 'mini', kind: 'cross_check_mismatch', metricKey: 'price_usd', dedupeKey: 'http_json:https://x.test/stats',
  severity: 'degrading', detail: { primary: 10, check: 11 }, seenAt: '2026-09-18T00:00:00.000Z', ...over,
});

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (err) {
    return (err as OrionError).code;
  }
  return undefined;
};

describe('anomalies', () => {
  it('opens a row on first sight', () => {
    const a = raiseAnomaly(db, mismatch());
    expect(a).toMatchObject({
      assetId: 'mini', kind: 'cross_check_mismatch', metricKey: 'price_usd', severity: 'degrading', status: 'open',
      occurrences: 1, firstSeenAt: '2026-09-18T00:00:00.000Z', lastSeenAt: '2026-09-18T00:00:00.000Z', note: null, decidedAt: null,
    });
    expect(a.detail).toEqual({ primary: 10, check: 11 });
    expect(getAnomaly(db, a.id)).toEqual(a);
  });

  it('counts a repeat of an open anomaly instead of inserting a row', () => {
    const first = raiseAnomaly(db, mismatch());
    const again = raiseAnomaly(db, mismatch({ seenAt: '2026-09-19T00:00:00.000Z', detail: { primary: 10, check: 12 }, severity: 'advisory' }));
    expect(again.id).toBe(first.id);
    expect(again.occurrences).toBe(2);
    expect(again.firstSeenAt).toBe('2026-09-18T00:00:00.000Z');
    expect(again.lastSeenAt).toBe('2026-09-19T00:00:00.000Z');
    expect(again.detail).toEqual({ primary: 10, check: 12 });
    expect(again.severity).toBe('advisory');
    expect(listAnomalies(db)).toHaveLength(1);
  });

  it('keeps anomalies apart by asset, kind, metric, and dedupe key', () => {
    raiseAnomaly(db, mismatch());
    raiseAnomaly(db, mismatch({ assetId: 'other' }));
    raiseAnomaly(db, mismatch({ metricKey: 'effective_supply' }));
    raiseAnomaly(db, mismatch({ dedupeKey: 'coingecko' }));
    raiseAnomaly(db, mismatch({ kind: 'unlisted_sender', dedupeKey: '0xabc' }));
    expect(listAnomalies(db)).toHaveLength(5);
    expect(listOpenAnomalies(db, 'mini')).toHaveLength(4);
  });

  it('resolves and acknowledges with a note, after which the anomaly is no longer open', () => {
    const a = raiseAnomaly(db, mismatch());
    const b = raiseAnomaly(db, mismatch({ metricKey: 'effective_supply' }));
    const resolved = decideAnomaly(db, a.id, 'resolved', 'source fixed upstream', '2026-09-20T00:00:00.000Z');
    expect(resolved).toMatchObject({ status: 'resolved', note: 'source fixed upstream', decidedAt: '2026-09-20T00:00:00.000Z' });
    expect(decideAnomaly(db, b.id, 'acknowledged', 'known lag', '2026-09-20T00:00:00.000Z').status).toBe('acknowledged');
    expect(listOpenAnomalies(db, 'mini')).toEqual([]);
    expect(listAnomalies(db, { assetId: 'mini' })).toEqual([]);
    expect(listAnomalies(db, { assetId: 'mini', includeDecided: true })).toHaveLength(2);
  });

  it('opens a new row when a decided anomaly recurs', () => {
    const first = raiseAnomaly(db, mismatch());
    decideAnomaly(db, first.id, 'resolved', 'fixed', '2026-09-20T00:00:00.000Z');
    const second = raiseAnomaly(db, mismatch({ seenAt: '2026-09-21T00:00:00.000Z' }));
    expect(second.id).not.toBe(first.id);
    expect(second.occurrences).toBe(1);
    expect(getAnomaly(db, first.id)!.status).toBe('resolved');
  });

  it('refuses a blank note, an unknown id, and a second decision', () => {
    const a = raiseAnomaly(db, mismatch());
    expect(codeOf(() => decideAnomaly(db, a.id, 'resolved', '  ', '2026-09-20T00:00:00.000Z'))).toBe('note_required');
    expect(codeOf(() => decideAnomaly(db, 999, 'resolved', 'x', '2026-09-20T00:00:00.000Z'))).toBe('anomaly_not_found');
    decideAnomaly(db, a.id, 'acknowledged', 'ok', '2026-09-20T00:00:00.000Z');
    expect(codeOf(() => decideAnomaly(db, a.id, 'resolved', 'again', '2026-09-21T00:00:00.000Z'))).toBe('anomaly_not_open');
  });

  it('lists newest first, and open anomalies oldest first', () => {
    const a = raiseAnomaly(db, mismatch());
    const b = raiseAnomaly(db, mismatch({ metricKey: 'effective_supply', seenAt: '2026-09-19T00:00:00.000Z' }));
    expect(listAnomalies(db).map((x) => x.id)).toEqual([b.id, a.id]);
    expect(listOpenAnomalies(db, 'mini').map((x) => x.id)).toEqual([a.id, b.id]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/db/anomalies.test.ts`
Expected: FAIL (cannot find `src/db/anomalies.js`).

- [ ] **Step 3: Implement**

Create `src/db/anomalies.ts`:

```ts
import { OrionError } from '../types.js';
import type { Db } from './connection.js';

export type AnomalyKind = 'cross_check_mismatch' | 'unlisted_sender' | 'source_failure_streak' | 'revenue_disclosure_stale';
export type AnomalySeverity = 'degrading' | 'advisory';
export type AnomalyStatus = 'open' | 'resolved' | 'acknowledged';

export interface Anomaly {
  id: number;
  assetId: string;
  kind: AnomalyKind;
  /** '' for anomalies that belong to a source rather than a metric (source_failure_streak). */
  metricKey: string;
  dedupeKey: string;
  severity: AnomalySeverity;
  status: AnomalyStatus;
  detail: Record<string, unknown>;
  occurrences: number;
  firstSeenAt: string;
  lastSeenAt: string;
  note: string | null;
  decidedAt: string | null;
}

export interface RaiseAnomalyInput {
  assetId: string;
  kind: AnomalyKind;
  metricKey: string;
  dedupeKey: string;
  severity: AnomalySeverity;
  detail: Record<string, unknown>;
  seenAt: string;
}

interface Row {
  id: number;
  asset_id: string;
  kind: AnomalyKind;
  metric_key: string;
  dedupe_key: string;
  severity: AnomalySeverity;
  status: AnomalyStatus;
  detail_json: string;
  occurrences: number;
  first_seen_at: string;
  last_seen_at: string;
  note: string | null;
  decided_at: string | null;
}

function fromRow(r: Row): Anomaly {
  return {
    id: r.id, assetId: r.asset_id, kind: r.kind, metricKey: r.metric_key, dedupeKey: r.dedupe_key, severity: r.severity,
    status: r.status, detail: JSON.parse(r.detail_json) as Record<string, unknown>, occurrences: r.occurrences,
    firstSeenAt: r.first_seen_at, lastSeenAt: r.last_seen_at, note: r.note, decidedAt: r.decided_at,
  };
}

export function getAnomaly(db: Db, id: number): Anomaly | null {
  const row = db.prepare('SELECT * FROM anomalies WHERE id = ?').get(id) as Row | undefined;
  return row ? fromRow(row) : null;
}

/** Opens an anomaly, or counts a repeat when the same one is already open. A decided anomaly that recurs opens a new row. */
export function raiseAnomaly(db: Db, input: RaiseAnomalyInput): Anomaly {
  const seenAt = new Date(input.seenAt).toISOString();
  const detail = JSON.stringify(input.detail);
  const id = db.transaction(() => {
    const open = db
      .prepare("SELECT id FROM anomalies WHERE asset_id = ? AND kind = ? AND metric_key = ? AND dedupe_key = ? AND status = 'open'")
      .get(input.assetId, input.kind, input.metricKey, input.dedupeKey) as { id: number } | undefined;
    if (open) {
      db.prepare('UPDATE anomalies SET occurrences = occurrences + 1, last_seen_at = ?, detail_json = ?, severity = ? WHERE id = ?').run(
        seenAt, detail, input.severity, open.id,
      );
      return open.id;
    }
    const info = db
      .prepare(
        `INSERT INTO anomalies (asset_id, kind, metric_key, dedupe_key, severity, status, detail_json, occurrences, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, 'open', ?, 1, ?, ?)`,
      )
      .run(input.assetId, input.kind, input.metricKey, input.dedupeKey, input.severity, detail, seenAt, seenAt);
    return Number(info.lastInsertRowid);
  })();
  return getAnomaly(db, id)!;
}

/** Newest first. Open anomalies only, unless `includeDecided`. */
export function listAnomalies(db: Db, filter: { assetId?: string; includeDecided?: boolean } = {}): Anomaly[] {
  const where: string[] = [];
  const params: string[] = [];
  if (filter.assetId !== undefined) {
    where.push('asset_id = ?');
    params.push(filter.assetId);
  }
  if (!filter.includeDecided) where.push("status = 'open'");
  const sql = `SELECT * FROM anomalies ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC`;
  return (db.prepare(sql).all(...params) as Row[]).map(fromRow);
}

/** Oldest first: the order a signal lists them in. */
export function listOpenAnomalies(db: Db, assetId: string): Anomaly[] {
  const rows = db.prepare("SELECT * FROM anomalies WHERE asset_id = ? AND status = 'open' ORDER BY id").all(assetId) as Row[];
  return rows.map(fromRow);
}

export function decideAnomaly(db: Db, id: number, status: 'resolved' | 'acknowledged', note: string, nowIso: string): Anomaly {
  if (note.trim() === '') throw new OrionError('note_required', 'a note is required: say why this anomaly is resolved or acknowledged');
  const current = getAnomaly(db, id);
  if (!current) throw new OrionError('anomaly_not_found', `no anomaly with id ${id}`);
  if (current.status !== 'open') throw new OrionError('anomaly_not_open', `anomaly ${id} is already ${current.status}`);
  db.prepare('UPDATE anomalies SET status = ?, note = ?, decided_at = ? WHERE id = ?').run(status, note.trim(), new Date(nowIso).toISOString(), id);
  return getAnomaly(db, id)!;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/db/anomalies.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/anomalies.ts tests/db/anomalies.test.ts
git commit -m "feat(db): anomaly store with dedupe, occurrences, and the resolve/acknowledge lifecycle"
```

### Task 4: Asset schema: `source`, `cross_checks`, `ingest`, and the stale-revenue trigger

Each metric may carry `source:` (primary) and `cross_checks:` (a list of `{ source, tolerance_pct? }`; a missing tolerance falls back to the metric's own `tolerance_pct`). A metric with no `source` stays manual. Contract names refer to keys in the asset's `contracts` map. Both new metric fields and `ingest` are OPTIONAL with no default, so configs that do not use them keep their current hash, and stored `config_versions` (which carry the legacy `fetcher` key) still parse for replay. Do not remove `fetcher`.

Validation rules this task enforces:

1. Every contract name a source uses exists in `contracts`.
2. Primary source by metric type: a `flow` metric takes only `transfer_flow`; `level` and `schedule` metrics take `coingecko`, `http_json`, `erc20_supply`, `contract_read`, `adapter`, or `derived`; an `event` metric takes none. `defillama` is never a primary (spec 4.1: cross-check use only).
3. Cross-check by metric type: on a `flow` metric only `defillama` or `adapter`; on `level` and `schedule` metrics `coingecko`, `http_json`, `erc20_supply`, `contract_read`, or `adapter`. Never `transfer_flow` or `derived`. `cross_checks` without a `source` is an error.
4. `transfer_flow` with `unit: usd` needs `price_coingecko_id`; `count_from` must be a subset of `from_allowlist`.
5. Invariant 5: `http_json` may not be the primary source of a required standard metric.
6. Any chain source (`erc20_supply`, `contract_read`, `transfer_flow`) requires the `ingest` block.
7. `review_triggers.revenue_stale_move_pct`, when present, is a positive number.

**Files:**
- Create: `src/config/sources.ts`, `tests/helpers/ingestAsset.ts`, `tests/config/sources.test.ts`
- Modify: `src/config/schema.ts`

**Interfaces:**
- Consumes: `AssetConfigSchema` (`src/config/schema.ts`), `parseAssetYaml`.
- Produces (`src/config/sources.ts`):

```ts
export const SourceSchema            // zod discriminated union on `type`
export type SourceConfig = z.infer<typeof SourceSchema>
export type SourceOf<T extends SourceConfig['type']> = Extract<SourceConfig, { type: T }>
export const CrossCheckSchema        // { source: SourceSchema, tolerance_pct?: number }
export const IngestSchema            // { chain_id, rpc_url_env, backfill_days (default 90) }
export function isChainSource(s: SourceConfig): boolean
export function contractNames(s: SourceConfig): string[]
export function sourceIssues(asset: SourceBearingAsset, requiredMetrics: string[]): string[]
```

  Source shapes (all strict objects):
  - `{ type: 'coingecko', id, field: 'price' | 'market_cap' | 'circulating_supply' }`
  - `{ type: 'http_json', url, path, scale = 1, decimals = 0 }`
  - `{ type: 'defillama', slug, data_type, compare: 'monthly_sum' }`
  - `{ type: 'erc20_supply', token, subtract_balances = [] }`
  - `{ type: 'contract_read', contract, function, abi_type = 'uint256', decimals = 0, scale = 1, offset = 0 }`
  - `{ type: 'transfer_flow', token, to, from_allowlist, count_from?, unit: 'usd' | 'tokens', price_coingecko_id? }`
  - `{ type: 'adapter', name, params = {} }`
  - `{ type: 'derived', name, params = {} }`
- Produces (`src/config/schema.ts`): `MetricDef` gains `source?: SourceConfig` and `cross_checks?: { source: SourceConfig; tolerance_pct?: number }[]`; `AssetConfig` gains `ingest?: { chain_id: number; rpc_url_env: string; backfill_days: number }`; and `export function revenueStaleMovePct(asset: AssetConfig): number` (default 30).
- Produces (`tests/helpers/ingestAsset.ts`): `INGEST_ASSET_YAML`, `ingestAsset(): LoadedAsset`, and the address constants `TOKEN`, `STAKING`, `SINK`, `POOL`, `SAFE`. Later ingest tests all use this asset.

- [ ] **Step 1: Write the failing test and the shared test asset**

Create `tests/helpers/ingestAsset.ts`:

```ts
import { parseAssetYaml, type LoadedAsset } from '../../src/config/load.js';

export const TOKEN = '0x1111111111111111111111111111111111111111';
export const STAKING = '0x2222222222222222222222222222222222222222';
export const SINK = '0x0000000000000000000000000000000000000000';
export const POOL = '0x3333333333333333333333333333333333333333';
export const SAFE = '0x4444444444444444444444444444444444444444';

/** The mini asset with every declarative source type wired up. Uses the same assumptions as miniAssumptions(). */
export const INGEST_ASSET_YAML = `
id: mini
symbol: MINI
name: Mini Ingest Asset
contracts:
  token: "${TOKEN}"
  staking: "${STAKING}"
  burn_sink: "${SINK}"
  pool: "${POOL}"
  safe: "${SAFE}"
ingest: { chain_id: 8453, rpc_url_env: TEST_RPC_URL, backfill_days: 3 }
metrics:
  price_usd:
    type: level
    unit: usd
    staleness_days: 3
    critical: true
    source: { type: coingecko, id: mini-token, field: price }
    cross_checks:
      - { tolerance_pct: 2, source: { type: http_json, url: "https://api.example.test/stats", path: price } }
  circulating_supply:
    type: level
    unit: tokens
    staleness_days: 14
    source: { type: coingecko, id: mini-token, field: circulating_supply }
  revenue_run_rate_usd: { type: level, unit: usd, staleness_days: 60, critical: true }
  effective_supply:
    type: level
    unit: tokens
    staleness_days: 7
    critical: true
    tolerance_pct: 0.1
    source: { type: erc20_supply, token: token, subtract_balances: [burn_sink] }
    cross_checks:
      - { source: { type: http_json, url: "https://api.example.test/stats", path: supply.totalBaseUnit, decimals: 18 } }
  staked_supply:
    type: level
    unit: tokens
    staleness_days: 7
    source: { type: contract_read, contract: staking, function: totalSupply, decimals: 18 }
  staker_emission_share: { type: level, unit: ratio, staleness_days: 30 }
  emission_rate_annual:
    type: schedule
    unit: tokens_per_year
    staleness_days: 400
    source: { type: contract_read, contract: staking, function: emissionRatePerSecond, decimals: 18, scale: 31536000 }
  flow_usd.fees:
    type: flow
    unit: usd
    staleness_days: 45
    critical: true
    source: { type: transfer_flow, token: token, to: burn_sink, from_allowlist: [pool, safe], unit: usd, price_coingecko_id: mini-token }
    cross_checks:
      - { tolerance_pct: 5, source: { type: defillama, slug: mini, data_type: dailyHoldersRevenue, compare: monthly_sum } }
  flow_tokens.fees:
    type: flow
    unit: tokens
    staleness_days: 45
    source: { type: transfer_flow, token: token, to: burn_sink, from_allowlist: [pool, safe], unit: tokens }
  flow_usd.fees_programmatic:
    type: flow
    unit: usd
    staleness_days: 45
    source: { type: transfer_flow, token: token, to: burn_sink, from_allowlist: [pool, safe], count_from: [pool], unit: usd, price_coingecko_id: mini-token }
holder_flows:
  - { id: fees, kind: fee_share, capture_rule: contractual, recipient_base: all, metric: flow_usd.fees }
modules:
  - { id: hc, type: holder_cashflow, kind: estimate, weight: 1 }
assumptions:
  rev_growth_y1: { min: -0.5, max: 5 }
  growth_fade_years: { min: 0, max: 10 }
  terminal_growth: { min: 0, max: 0.05 }
  capture_rate_terminal.fees: { min: 0, max: 1 }
  capture_ramp_years.fees: { min: 0, max: 10 }
  discount_rate_base: { min: 0.05, max: 0.5 }
  staked_ratio_horizon: { min: 0.05, max: 0.95 }
`;

export function ingestAsset(): LoadedAsset {
  return parseAssetYaml(INGEST_ASSET_YAML);
}
```

Create `tests/config/sources.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseAssetYaml } from '../../src/config/load.js';
import { revenueStaleMovePct } from '../../src/config/schema.js';
import { contractNames, isChainSource } from '../../src/config/sources.js';
import { MINI_ASSET_YAML } from '../helpers/assets.js';
import { INGEST_ASSET_YAML, ingestAsset } from '../helpers/ingestAsset.js';

const bad = (yaml: string): string => {
  try {
    parseAssetYaml(yaml);
  } catch (err) {
    return (err as Error).message;
  }
  return '';
};

describe('declarative sources in the asset config', () => {
  it('parses every source type and fills in defaults', () => {
    const { config } = ingestAsset();
    expect(config.ingest).toEqual({ chain_id: 8453, rpc_url_env: 'TEST_RPC_URL', backfill_days: 3 });
    expect(config.metrics.price_usd.source).toEqual({ type: 'coingecko', id: 'mini-token', field: 'price' });
    expect(config.metrics.price_usd.cross_checks).toEqual([
      { tolerance_pct: 2, source: { type: 'http_json', url: 'https://api.example.test/stats', path: 'price', scale: 1, decimals: 0 } },
    ]);
    expect(config.metrics.staked_supply.source).toEqual({
      type: 'contract_read', contract: 'staking', function: 'totalSupply', abi_type: 'uint256', decimals: 18, scale: 1, offset: 0,
    });
    expect(config.metrics.revenue_run_rate_usd.source).toBeUndefined();
  });

  it('leaves the hash of a config without sources unchanged by the new optional fields', () => {
    const { config } = parseAssetYaml(MINI_ASSET_YAML);
    expect('ingest' in config).toBe(false);
    expect('source' in config.metrics.price_usd).toBe(false);
    expect('cross_checks' in config.metrics.price_usd).toBe(false);
  });

  it('still parses a stored config that carries the legacy fetcher key', () => {
    const { config } = parseAssetYaml(MINI_ASSET_YAML);
    expect(config.metrics.price_usd.fetcher).toBe('manual');
  });

  it('defaults backfill_days to 90', () => {
    const yaml = INGEST_ASSET_YAML.replace('ingest: { chain_id: 8453, rpc_url_env: TEST_RPC_URL, backfill_days: 3 }', 'ingest: { chain_id: 8453, rpc_url_env: TEST_RPC_URL }');
    expect(parseAssetYaml(yaml).config.ingest!.backfill_days).toBe(90);
  });

  it('names the contracts a source needs and tells chain sources apart', () => {
    const { config } = ingestAsset();
    expect(contractNames(config.metrics.effective_supply.source!)).toEqual(['token', 'burn_sink']);
    expect(contractNames(config.metrics['flow_usd.fees_programmatic'].source!)).toEqual(['token', 'burn_sink', 'pool', 'safe', 'pool']);
    expect(contractNames(config.metrics.price_usd.source!)).toEqual([]);
    expect(isChainSource(config.metrics.staked_supply.source!)).toBe(true);
    expect(isChainSource(config.metrics.price_usd.source!)).toBe(false);
  });

  it('rejects an unknown contract name', () => {
    expect(bad(INGEST_ASSET_YAML.replace('subtract_balances: [burn_sink]', 'subtract_balances: [nowhere]'))).toMatch(
      /effective_supply.*unknown contract "nowhere"/,
    );
  });

  it('rejects a source type that does not fit the metric type', () => {
    expect(bad(INGEST_ASSET_YAML.replace('source: { type: coingecko, id: mini-token, field: price }', 'source: { type: transfer_flow, token: token, to: burn_sink, from_allowlist: [pool], unit: tokens }')))
      .toMatch(/price_usd.*transfer_flow cannot be the source of a level metric/);
    expect(bad(INGEST_ASSET_YAML.replace('source: { type: transfer_flow, token: token, to: burn_sink, from_allowlist: [pool, safe], unit: tokens }', 'source: { type: coingecko, id: mini-token, field: price }')))
      .toMatch(/flow_tokens\.fees.*coingecko cannot be the source of a flow metric/);
  });

  it('never allows defillama as a primary, or transfer_flow and derived as cross-checks', () => {
    expect(bad(INGEST_ASSET_YAML.replace('source: { type: coingecko, id: mini-token, field: circulating_supply }', 'source: { type: defillama, slug: mini, data_type: x, compare: monthly_sum }')))
      .toMatch(/circulating_supply.*defillama cannot be the source/);
    expect(bad(INGEST_ASSET_YAML.replace('- { tolerance_pct: 2, source: { type: http_json, url: "https://api.example.test/stats", path: price } }', '- { source: { type: derived, name: x } }')))
      .toMatch(/price_usd.*derived cannot be a cross-check/);
  });

  it('rejects cross_checks on a metric that has no source', () => {
    expect(bad(INGEST_ASSET_YAML.replace('revenue_run_rate_usd: { type: level, unit: usd, staleness_days: 60, critical: true }',
      'revenue_run_rate_usd: { type: level, unit: usd, staleness_days: 60, critical: true, cross_checks: [ { source: { type: coingecko, id: x, field: price } } ] }')))
      .toMatch(/revenue_run_rate_usd.*cross_checks need a primary source/);
  });

  it('requires a price id for a USD flow and keeps count_from inside the allowlist', () => {
    expect(bad(INGEST_ASSET_YAML.replace('from_allowlist: [pool, safe], unit: usd, price_coingecko_id: mini-token }\n    cross_checks', 'from_allowlist: [pool, safe], unit: usd }\n    cross_checks')))
      .toMatch(/flow_usd\.fees.*price_coingecko_id/);
    expect(bad(INGEST_ASSET_YAML.replace('count_from: [pool]', 'count_from: [staking]'))).toMatch(/count_from "staking" is not in from_allowlist/);
  });

  it('never lets an undocumented JSON endpoint be the primary source of a required metric', () => {
    expect(bad(INGEST_ASSET_YAML.replace('source: { type: coingecko, id: mini-token, field: price }', 'source: { type: http_json, url: "https://api.example.test/stats", path: price }')))
      .toMatch(/price_usd.*http_json cannot be the primary source of a required metric/);
  });

  it('requires the ingest block when a chain source is configured', () => {
    expect(bad(INGEST_ASSET_YAML.replace('ingest: { chain_id: 8453, rpc_url_env: TEST_RPC_URL, backfill_days: 3 }\n', ''))).toMatch(/ingest.*required/);
  });

  it('reads the stale-revenue threshold, defaulting to 30, and rejects a bad one', () => {
    expect(revenueStaleMovePct(ingestAsset().config)).toBe(30);
    expect(revenueStaleMovePct(parseAssetYaml(`${INGEST_ASSET_YAML}review_triggers: { revenue_stale_move_pct: 45 }\n`).config)).toBe(45);
    expect(bad(`${INGEST_ASSET_YAML}review_triggers: { revenue_stale_move_pct: -1 }\n`)).toMatch(/revenue_stale_move_pct must be a positive number/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/config/sources.test.ts`
Expected: FAIL (cannot find `src/config/sources.js`).

- [ ] **Step 3: Implement**

Create `src/config/sources.ts`:

```ts
import { z } from 'zod';

const name = z.string().min(1);
const params = z.record(z.string(), z.unknown()).default({});

/** The declarative source vocabulary (ingestion spec 4.1). Contract names are keys of the asset's `contracts` map. */
export const SourceSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('coingecko'), id: name, field: z.enum(['price', 'market_cap', 'circulating_supply']) }),
  z.strictObject({
    type: z.literal('http_json'),
    url: z.url(),
    /** Dot path into the JSON; numeric segments index arrays. */
    path: name,
    scale: z.number().default(1),
    decimals: z.number().int().min(0).max(36).default(0),
  }),
  z.strictObject({ type: z.literal('defillama'), slug: name, data_type: name, compare: z.literal('monthly_sum') }),
  z.strictObject({ type: z.literal('erc20_supply'), token: name, subtract_balances: z.array(name).default([]) }),
  z.strictObject({
    type: z.literal('contract_read'),
    contract: name,
    function: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    abi_type: z.string().regex(/^uint(8|16|32|64|128|256)$/).default('uint256'),
    decimals: z.number().int().min(0).max(36).default(0),
    scale: z.number().default(1),
    offset: z.number().default(0),
  }),
  z.strictObject({
    type: z.literal('transfer_flow'),
    token: name,
    to: name,
    from_allowlist: z.array(name).min(1),
    /** Subset of the allowlist to sum. Default: all of it. */
    count_from: z.array(name).min(1).optional(),
    unit: z.enum(['usd', 'tokens']),
    price_coingecko_id: name.optional(),
  }),
  z.strictObject({ type: z.literal('adapter'), name, params }),
  z.strictObject({ type: z.literal('derived'), name, params }),
]);

export type SourceConfig = z.infer<typeof SourceSchema>;
export type SourceOf<T extends SourceConfig['type']> = Extract<SourceConfig, { type: T }>;

/** A missing tolerance falls back to the metric's own tolerance_pct. */
export const CrossCheckSchema = z.strictObject({ source: SourceSchema, tolerance_pct: z.number().nonnegative().optional() });

export const IngestSchema = z.strictObject({
  chain_id: z.number().int().positive(),
  /** Name of the environment variable that holds the RPC URL. */
  rpc_url_env: name,
  backfill_days: z.number().int().positive().default(90),
});

export function isChainSource(s: SourceConfig): boolean {
  return s.type === 'erc20_supply' || s.type === 'contract_read' || s.type === 'transfer_flow';
}

export function contractNames(s: SourceConfig): string[] {
  switch (s.type) {
    case 'erc20_supply':
      return [s.token, ...s.subtract_balances];
    case 'contract_read':
      return [s.contract];
    case 'transfer_flow':
      return [s.token, s.to, ...s.from_allowlist, ...(s.count_from ?? [])];
    default:
      return [];
  }
}

const LEVEL_PRIMARY: ReadonlySet<string> = new Set(['coingecko', 'http_json', 'erc20_supply', 'contract_read', 'adapter', 'derived']);
const LEVEL_CHECK: ReadonlySet<string> = new Set(['coingecko', 'http_json', 'erc20_supply', 'contract_read', 'adapter']);
const FLOW_CHECK: ReadonlySet<string> = new Set(['defillama', 'adapter']);

export interface SourceBearingAsset {
  contracts: Record<string, string>;
  ingest?: unknown;
  metrics: Record<
    string,
    { type: 'level' | 'flow' | 'schedule' | 'event'; source?: SourceConfig; cross_checks?: { source: SourceConfig; tolerance_pct?: number }[] }
  >;
}

/** Cross-field validation of every source in an asset. `requiredMetrics` are the standard metrics the engine cannot run without. */
export function sourceIssues(asset: SourceBearingAsset, requiredMetrics: string[]): string[] {
  const issues: string[] = [];
  let usesChain = false;

  const checkShape = (where: string, s: SourceConfig) => {
    for (const c of contractNames(s)) if (asset.contracts[c] === undefined) issues.push(`${where}: unknown contract "${c}"`);
    if (s.type === 'transfer_flow') {
      if (s.unit === 'usd' && s.price_coingecko_id === undefined) issues.push(`${where}: a transfer_flow with unit usd needs price_coingecko_id`);
      for (const c of s.count_from ?? []) if (!s.from_allowlist.includes(c)) issues.push(`${where}: count_from "${c}" is not in from_allowlist`);
    }
    if (isChainSource(s)) usesChain = true;
  };

  for (const [key, def] of Object.entries(asset.metrics)) {
    const where = `metrics.${key}`;
    const checks = def.cross_checks ?? [];
    if (def.source === undefined) {
      if (checks.length > 0) issues.push(`${where}: cross_checks need a primary source`);
      continue;
    }
    const s = def.source;
    const fits = def.type === 'flow' ? s.type === 'transfer_flow' : def.type === 'event' ? false : LEVEL_PRIMARY.has(s.type);
    if (!fits) issues.push(`${where}: ${s.type} cannot be the source of a ${def.type} metric`);
    if (s.type === 'http_json' && requiredMetrics.includes(key)) {
      issues.push(`${where}: http_json cannot be the primary source of a required metric (use it as a cross-check)`);
    }
    checkShape(where, s);

    checks.forEach((c, i) => {
      const allowed = def.type === 'flow' ? FLOW_CHECK : LEVEL_CHECK;
      if (!allowed.has(c.source.type)) issues.push(`${where}.cross_checks.${i}: ${c.source.type} cannot be a cross-check of a ${def.type} metric`);
      checkShape(`${where}.cross_checks.${i}`, c.source);
    });
  }

  if (usesChain && asset.ingest === undefined) issues.push('ingest: required when a metric reads from a chain (erc20_supply, contract_read, transfer_flow)');
  return issues;
}
```

In `src/config/schema.ts`, replace:

```ts
import { z } from 'zod';
import { STD_METRICS } from '../types.js';

const MetricDefSchema = z.strictObject({
```

with:

```ts
import { z } from 'zod';
import { STD_METRICS } from '../types.js';
import { CrossCheckSchema, IngestSchema, SourceSchema, sourceIssues } from './sources.js';

const MetricDefSchema = z.strictObject({
```

In `src/config/schema.ts`, replace:

```ts
  allow_provisional: z.boolean().default(false),
  critical: z.boolean().default(false),
});
```

with:

```ts
  allow_provisional: z.boolean().default(false),
  critical: z.boolean().default(false),
  /** Primary source. A metric without one stays manual. Optional with no default, so existing config hashes do not move. */
  source: SourceSchema.optional(),
  cross_checks: z.array(CrossCheckSchema).optional(),
});
```

In `src/config/schema.ts`, replace:

```ts
    contracts: z.record(z.string(), z.string()).default({}),
    external_ids: z.record(z.string(), z.string()).default({}),
```

with:

```ts
    contracts: z.record(z.string(), z.string()).default({}),
    external_ids: z.record(z.string(), z.string()).default({}),
    ingest: IngestSchema.optional(),
```

In `src/config/schema.ts`, replace:

```ts
    for (const v of a.total_return_variants) {
      if (a.metrics[v.yield_multiplier_metric]?.type !== 'level') {
        issue(`total_return_variants: "${v.id}" must reference a level metric`);
      }
    }
  });
```

with:

```ts
    for (const v of a.total_return_variants) {
      if (a.metrics[v.yield_multiplier_metric]?.type !== 'level') {
        issue(`total_return_variants: "${v.id}" must reference a level metric`);
      }
    }

    for (const message of sourceIssues(a, required)) issue(message);
    const move = a.review_triggers.revenue_stale_move_pct;
    if (move !== undefined && !(typeof move === 'number' && Number.isFinite(move) && move > 0)) {
      issue('review_triggers: revenue_stale_move_pct must be a positive number');
    }
  });
```

Append to `src/config/schema.ts`:

```ts

/** Percent move in usage_index since the revenue disclosure that raises the stale-revenue alert. Default 30. */
export function revenueStaleMovePct(asset: AssetConfig): number {
  const v = asset.review_triggers.revenue_stale_move_pct;
  return typeof v === 'number' ? v : 30;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/config && npm test && npm run typecheck`
Expected: PASS. The full suite matters here: every existing asset config (VVV, HYPE, AERO, golden) must still parse.

- [ ] **Step 5: Commit**

```bash
git add src/config tests/config tests/helpers/ingestAsset.ts
git commit -m "feat(config): declarative metric sources, cross-checks, and the ingest block in the asset schema"
```

---

## Task group C: transports and generic sources

### Task 5: HTTP transport

JSON GET with a timeout, retry with exponential backoff, `Retry-After` handling, per-host minimum spacing, and a per-run cache. Everything time-related is injected so tests run on a fake clock.

Rules (spec 11 and section 2):
- 3 attempts. Backoff starts at 1 second and doubles (1 s, then 2 s). Retried: a rejected fetch (timeout or network error), HTTP 429, HTTP 5xx. Anything else fails at once.
- `Retry-After` (seconds or an HTTP date) replaces the backoff delay when present. Above 60 seconds the source fails for this run immediately, without sleeping.
- Per-host minimum spacing between request starts: 2,500 ms for `api.coingecko.com` (keyless CoinGecko allows about 2 rapid requests, then 429), 250 ms for every other host.
- A 2xx body that is not JSON is a failure and is not retried.
- `withRunCache` makes one request per URL per run ("requests to the same URL within one run are made once").

**Files:**
- Create: `src/ingest/transport/http.ts`, `tests/ingest/http.test.ts`

**Interfaces:**
- Produces:

```ts
export interface HttpTransport { getJson(url: string, headers?: Record<string, string>): Promise<unknown> }
export class HttpError extends Error { readonly status: number | null }
export interface HttpResponseLike { status: number; headers: { get(name: string): string | null }; text(): Promise<string> }
export interface HttpDeps { fetch(url: string, init: { headers: Record<string, string>; signal: AbortSignal }): Promise<HttpResponseLike>; sleep(ms: number): Promise<void>; now(): number }
export interface HttpOptions { timeoutMs: number; attempts: number; backoffMs: number; maxRetryAfterMs: number; defaultSpacingMs: number; hostSpacingMs: Record<string, number> }
export const DEFAULT_HTTP_OPTIONS: HttpOptions
export function createHttpTransport(deps: HttpDeps, options?: Partial<HttpOptions>): HttpTransport
export function realHttpDeps(): HttpDeps
export function withRunCache(inner: HttpTransport): HttpTransport
```

- [ ] **Step 1: Write the failing test**

Create `tests/ingest/http.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createHttpTransport, HttpError, withRunCache, type HttpDeps, type HttpOptions } from '../../src/ingest/transport/http.js';

interface FakeResponse {
  status: number;
  body?: string;
  headers?: Record<string, string>;
}

function harness(responses: (FakeResponse | Error)[], options: Partial<HttpOptions> = {}) {
  let t = 1_000_000;
  const sleeps: number[] = [];
  const calls: { url: string; headers: Record<string, string>; at: number }[] = [];
  const deps: HttpDeps = {
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
    fetch: async (url, init) => {
      calls.push({ url, headers: init.headers, at: t });
      const r = responses.shift();
      if (!r) throw new Error('test bug: no response queued');
      if (r instanceof Error) throw r;
      return { status: r.status, headers: { get: (n) => r.headers?.[n.toLowerCase()] ?? null }, text: async () => r.body ?? '' };
    },
  };
  return { http: createHttpTransport(deps, options), sleeps, calls };
}

const ok = (value: unknown): FakeResponse => ({ status: 200, body: JSON.stringify(value) });

describe('http transport', () => {
  it('returns parsed JSON and sends the headers it was given', async () => {
    const h = harness([ok({ a: 1 })]);
    expect(await h.http.getJson('https://x.test/a', { 'x-key': 'k' })).toEqual({ a: 1 });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].headers).toMatchObject({ accept: 'application/json', 'x-key': 'k' });
    expect(h.sleeps).toEqual([]);
  });

  it('retries a 5xx with exponential backoff from one second', async () => {
    const h = harness([{ status: 503 }, { status: 500 }, ok({ done: true })]);
    expect(await h.http.getJson('https://x.test/a')).toEqual({ done: true });
    expect(h.sleeps).toEqual([1000, 2000]);
  });

  it('gives up after three attempts and reports the status', async () => {
    const h = harness([{ status: 503 }, { status: 503 }, { status: 503 }]);
    const err = await h.http.getJson('https://x.test/a').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(503);
    expect(h.calls).toHaveLength(3);
    expect(h.sleeps).toEqual([1000, 2000]);
  });

  it('retries a rejected fetch (timeout or network error)', async () => {
    const h = harness([new Error('The operation was aborted due to timeout'), ok(1)]);
    expect(await h.http.getJson('https://x.test/a')).toBe(1);
    expect(h.sleeps).toEqual([1000]);
  });

  it('does not retry a 404', async () => {
    const h = harness([{ status: 404 }, ok(1)]);
    await expect(h.http.getJson('https://x.test/a')).rejects.toThrow(/HTTP 404/);
    expect(h.calls).toHaveLength(1);
  });

  it('does not retry a 2xx body that is not JSON', async () => {
    const h = harness([{ status: 200, body: '<html>' }, ok(1)]);
    await expect(h.http.getJson('https://x.test/a')).rejects.toThrow(/not JSON/);
    expect(h.calls).toHaveLength(1);
  });

  it('honors Retry-After in seconds on a 429', async () => {
    const h = harness([{ status: 429, headers: { 'retry-after': '5' } }, ok(1)]);
    expect(await h.http.getJson('https://x.test/a')).toBe(1);
    expect(h.sleeps).toEqual([5000]);
  });

  it('honors Retry-After as an HTTP date', async () => {
    const h = harness([{ status: 429, headers: { 'retry-after': new Date(1_000_000 + 7000).toUTCString() } }, ok(1)]);
    expect(await h.http.getJson('https://x.test/a')).toBe(1);
    expect(h.sleeps).toHaveLength(1);
    expect(h.sleeps[0]).toBeGreaterThan(6000 - 1000); // HTTP dates have one-second resolution
    expect(h.sleeps[0]).toBeLessThanOrEqual(7000);
  });

  it('fails at once, without sleeping, when Retry-After exceeds sixty seconds', async () => {
    const h = harness([{ status: 429, headers: { 'retry-after': '1200' } }, ok(1)]);
    await expect(h.http.getJson('https://x.test/a')).rejects.toThrow(/Retry-After/);
    expect(h.calls).toHaveLength(1);
    expect(h.sleeps).toEqual([]);
  });

  it('spaces requests to one host, and only that host', async () => {
    const h = harness([ok(1), ok(2), ok(3), ok(4)]);
    await h.http.getJson('https://api.coingecko.com/api/v3/a');
    await h.http.getJson('https://api.coingecko.com/api/v3/b');
    await h.http.getJson('https://x.test/a');
    await h.http.getJson('https://x.test/b');
    expect(h.sleeps).toEqual([2500, 250]);
    expect(h.calls[1].at - h.calls[0].at).toBe(2500);
  });

  it('caches one request per URL per run, failures included', async () => {
    const h = harness([ok({ n: 1 }), { status: 404 }]);
    const cached = withRunCache(h.http);
    expect(await cached.getJson('https://x.test/a')).toEqual({ n: 1 });
    expect(await cached.getJson('https://x.test/a')).toEqual({ n: 1 });
    await expect(cached.getJson('https://x.test/b')).rejects.toThrow(/404/);
    await expect(cached.getJson('https://x.test/b')).rejects.toThrow(/404/);
    expect(h.calls).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/ingest/http.test.ts`
Expected: FAIL (cannot find `src/ingest/transport/http.js`).

- [ ] **Step 3: Implement**

Create `src/ingest/transport/http.ts`:

```ts
export interface HttpTransport {
  getJson(url: string, headers?: Record<string, string>): Promise<unknown>;
}

export class HttpError extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export interface HttpResponseLike {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

/** Everything the transport needs from the outside world, so tests can run it on a fake clock. */
export interface HttpDeps {
  fetch(url: string, init: { headers: Record<string, string>; signal: AbortSignal }): Promise<HttpResponseLike>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface HttpOptions {
  timeoutMs: number;
  attempts: number;
  backoffMs: number;
  maxRetryAfterMs: number;
  defaultSpacingMs: number;
  hostSpacingMs: Record<string, number>;
}

export const DEFAULT_HTTP_OPTIONS: HttpOptions = {
  timeoutMs: 15_000,
  attempts: 3,
  backoffMs: 1000,
  maxRetryAfterMs: 60_000,
  defaultSpacingMs: 250,
  // Keyless CoinGecko allows about two rapid requests and then answers 429.
  hostSpacingMs: { 'api.coingecko.com': 2500 },
};

/** Retry-After is either a number of seconds or an HTTP date. Returns milliseconds to wait, or null. */
function retryAfterMs(header: string | null, nowMs: number): number | null {
  if (header === null || header.trim() === '') return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : Math.max(0, at - nowMs);
}

export function createHttpTransport(deps: HttpDeps, options: Partial<HttpOptions> = {}): HttpTransport {
  const o: HttpOptions = { ...DEFAULT_HTTP_OPTIONS, ...options };
  const lastStart = new Map<string, number>();

  const waitForSlot = async (host: string): Promise<void> => {
    const last = lastStart.get(host);
    if (last !== undefined) {
      const wait = last + (o.hostSpacingMs[host] ?? o.defaultSpacingMs) - deps.now();
      if (wait > 0) await deps.sleep(wait);
    }
    lastStart.set(host, deps.now());
  };

  return {
    async getJson(url, headers = {}) {
      const host = new URL(url).host;
      let failure = new HttpError(`${url}: no attempt was made`, null);
      for (let attempt = 1; attempt <= o.attempts; attempt++) {
        await waitForSlot(host);
        let delay = o.backoffMs * 2 ** (attempt - 1);
        let res: HttpResponseLike;
        try {
          res = await deps.fetch(url, { headers: { accept: 'application/json', ...headers }, signal: AbortSignal.timeout(o.timeoutMs) });
        } catch (err) {
          failure = new HttpError(`${url}: ${err instanceof Error ? err.message : String(err)}`, null);
          if (attempt < o.attempts) await deps.sleep(delay);
          continue;
        }
        if (res.status >= 200 && res.status < 300) {
          const text = await res.text();
          try {
            return JSON.parse(text) as unknown;
          } catch {
            throw new HttpError(`${url}: the response is not JSON`, res.status);
          }
        }
        failure = new HttpError(`${url}: HTTP ${res.status}`, res.status);
        if (res.status !== 429 && res.status < 500) throw failure;
        const retryAfter = retryAfterMs(res.headers.get('retry-after'), deps.now());
        if (retryAfter !== null) {
          if (retryAfter > o.maxRetryAfterMs) {
            throw new HttpError(
              `${url}: HTTP ${res.status} with Retry-After ${Math.ceil(retryAfter / 1000)}s, above the ${o.maxRetryAfterMs / 1000}s limit`,
              res.status,
            );
          }
          delay = retryAfter;
        }
        if (attempt < o.attempts) await deps.sleep(delay);
      }
      throw failure;
    },
  };
}

export function realHttpDeps(): HttpDeps {
  return {
    fetch: (url, init) => fetch(url, init),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  };
}

/** One request per URL per run. A failure is cached too: the transport already retried it. */
export function withRunCache(inner: HttpTransport): HttpTransport {
  const cache = new Map<string, Promise<unknown>>();
  return {
    getJson(url, headers) {
      let pending = cache.get(url);
      if (!pending) {
        pending = inner.getJson(url, headers);
        cache.set(url, pending);
      }
      return pending;
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/ingest/http.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ingest/transport/http.ts tests/ingest/http.test.ts
git commit -m "feat(ingest): HTTP JSON transport with retry, Retry-After, per-host spacing, and a run cache"
```

### Task 6: RPC transport

A narrow interface of our own, so that sources and tests never touch viem. `viemRpc.ts` is the only file that imports it.

Rules:
- `getTransferLogs` covers ONE range of at most 2,000 blocks. `getLogsChunked` walks a longer range in 2,000-block chunks (`from .. from + 1999`), tries each chunk up to 4 times (one attempt plus the spec's 3 retries) with backoff from 1 second, and throws when a chunk still fails. The caller keeps whatever it already committed.
- Every `TransferLog` carries its own block time. Base's `eth_getLogs` returns `blockTimestamp` on each log (verified during planning); the viem implementation throws a clear error if an RPC does not.
- `multicall` sends ONE `eth_call` (viem `batchSize: 100_000`) at a fixed block and never throws for a single failed call (`allowFailure`).
- `firstBlockAtOrAfter(rpc, targetTs, anchor, latest)` finds the first block whose timestamp is at or after `targetTs`: estimate from the anchor at 2 seconds per block, then correct. It must also converge when block times are irregular. It throws when `latest` is still before `targetTs`.
- Only chain id 8453 (Base) is supported; anything else is a configuration error.

**Files:**
- Modify: `package.json`, `package-lock.json` (add `viem`)
- Create: `src/ingest/transport/rpc.ts`, `src/ingest/transport/viemRpc.ts`, `tests/helpers/fakeRpc.ts`, `tests/ingest/rpc.test.ts`

**Interfaces:**
- Produces (`src/ingest/transport/rpc.ts`):

```ts
export interface BlockRef { number: bigint; timestamp: number }            // timestamp in unix seconds
export interface ContractCall { address: string; signature: string; functionName: string; args?: readonly unknown[] }
export type CallResult = { ok: true; value: bigint } | { ok: false; error: string }
export interface TransferLog { blockNumber: bigint; logIndex: number; txHash: string; from: string; value: bigint; timestamp: number }
export interface LogQuery { token: string; to: string; fromBlock: bigint; toBlock: bigint }
export interface RpcTransport {
  latestBlock(): Promise<BlockRef>;
  getBlock(number: bigint): Promise<BlockRef>;
  multicall(calls: ContractCall[], blockNumber: bigint): Promise<CallResult[]>;
  getTransferLogs(q: LogQuery): Promise<TransferLog[]>;
}
export type RpcFactory = (url: string, chainId: number) => RpcTransport
export const MAX_LOG_RANGE = 2000n
export function getLogsChunked(rpc: RpcTransport, q: LogQuery, opts: { sleep(ms: number): Promise<void>; attempts?: number; backoffMs?: number }): AsyncGenerator<{ fromBlock: bigint; toBlock: bigint; logs: TransferLog[] }>
export function firstBlockAtOrAfter(rpc: RpcTransport, targetTs: number, anchor: BlockRef, latest: BlockRef, blockTimeSec?: number): Promise<BlockRef>
```

  `signature` is a human-readable ABI item, for example `'function totalSupply() view returns (uint256)'`. All reads return unsigned integers, delivered as `bigint`.
- Produces (`src/ingest/transport/viemRpc.ts`): `export const createViemRpc: RpcFactory`.
- Produces (`tests/helpers/fakeRpc.ts`): `fakeRpc(options)`, `callKey(address, functionName, args?)`, used by every later chain test:

```ts
export interface FakeRpcOptions { genesisTs: number; latest: bigint; blockTimeSec?: number; timestampOf?: (n: bigint) => number; calls?: Record<string, bigint | Error>; logs?: Omit<TransferLog, 'timestamp'>[] }
export interface FakeRpc extends RpcTransport { stats: { getBlock: number; multicall: number; logRanges: [bigint, bigint][] }; failNextLogCalls(n: number): void; timestampOf(n: bigint): number; blockAtOrAfter(ts: number): bigint }
```

- [ ] **Step 1: Add the dependency**

Run: `npm install viem@^2.56.8`
Expected: `package.json` gains `"viem"` under `dependencies`; `npm test` still passes.

- [ ] **Step 2: Write the fake and the failing test**

Create `tests/helpers/fakeRpc.ts`:

```ts
import type { BlockRef, CallResult, ContractCall, LogQuery, RpcTransport, TransferLog } from '../../src/ingest/transport/rpc.js';

export interface FakeRpcOptions {
  /** Timestamp of block 0, in unix seconds. */
  genesisTs: number;
  latest: bigint;
  blockTimeSec?: number;
  /** Override for irregular chains. Must be non-decreasing in n. */
  timestampOf?: (n: bigint) => number;
  /** Contract call results by callKey(). An Error makes that one call fail. */
  calls?: Record<string, bigint | Error>;
  logs?: Omit<TransferLog, 'timestamp'>[];
}

export interface FakeRpc extends RpcTransport {
  stats: { getBlock: number; multicall: number; logRanges: [bigint, bigint][] };
  failNextLogCalls(n: number): void;
  timestampOf(n: bigint): number;
  /** First block whose timestamp is at or after `ts`. Regular chains only. */
  blockAtOrAfter(ts: number): bigint;
}

export function callKey(address: string, functionName: string, args: readonly unknown[] = []): string {
  return `${address.toLowerCase()}.${functionName}(${args.map((a) => String(a).toLowerCase()).join(',')})`;
}

export function fakeRpc(o: FakeRpcOptions): FakeRpc {
  const blockTime = o.blockTimeSec ?? 2;
  const timestampOf = o.timestampOf ?? ((n: bigint) => o.genesisTs + Number(n) * blockTime);
  const stats: FakeRpc['stats'] = { getBlock: 0, multicall: 0, logRanges: [] };
  let failures = 0;

  const block = (n: bigint): BlockRef => {
    if (n < 0n || n > o.latest) throw new Error(`fake chain has no block ${n}`);
    return { number: n, timestamp: timestampOf(n) };
  };

  return {
    stats,
    timestampOf,
    blockAtOrAfter: (ts) => BigInt(Math.max(0, Math.ceil((ts - o.genesisTs) / blockTime))),
    failNextLogCalls(n) {
      failures = n;
    },
    async latestBlock() {
      return block(o.latest);
    },
    async getBlock(n) {
      stats.getBlock++;
      return block(n);
    },
    async multicall(calls: ContractCall[], _blockNumber: bigint): Promise<CallResult[]> {
      stats.multicall++;
      return calls.map((c) => {
        const hit = o.calls?.[callKey(c.address, c.functionName, c.args)];
        if (hit === undefined) return { ok: false, error: `no fake result for ${callKey(c.address, c.functionName, c.args)}` };
        return hit instanceof Error ? { ok: false, error: hit.message } : { ok: true, value: hit };
      });
    },
    async getTransferLogs(q: LogQuery): Promise<TransferLog[]> {
      stats.logRanges.push([q.fromBlock, q.toBlock]);
      if (q.toBlock - q.fromBlock + 1n > 2000n) throw new Error('query exceeds max block range 2000');
      if (failures > 0) {
        failures--;
        throw new Error('fake RPC failure');
      }
      return (o.logs ?? [])
        .filter((l) => l.blockNumber >= q.fromBlock && l.blockNumber <= q.toBlock)
        .map((l) => ({ ...l, timestamp: timestampOf(l.blockNumber) }));
    },
  };
}
```

Create `tests/ingest/rpc.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { firstBlockAtOrAfter, getLogsChunked, type TransferLog } from '../../src/ingest/transport/rpc.js';
import { createViemRpc } from '../../src/ingest/transport/viemRpc.js';
import type { OrionError } from '../../src/types.js';
import { fakeRpc } from '../helpers/fakeRpc.js';

const noSleep = { sleep: async () => undefined };
const log = (blockNumber: bigint, logIndex = 0): Omit<TransferLog, 'timestamp'> => ({
  blockNumber, logIndex, txHash: `0x${blockNumber.toString(16)}`, from: '0xabc', value: 1n,
});
const Q = { token: '0xt', to: '0x0' };

async function collect(gen: AsyncGenerator<{ fromBlock: bigint; toBlock: bigint; logs: TransferLog[] }>) {
  const out: { fromBlock: bigint; toBlock: bigint; logs: TransferLog[] }[] = [];
  for await (const chunk of gen) out.push(chunk);
  return out;
}

describe('getLogsChunked', () => {
  it('walks a range in chunks of at most 2000 blocks and stamps each log with its block time', async () => {
    const rpc = fakeRpc({ genesisTs: 1_000_001, latest: 10_000n, logs: [log(5n), log(1999n), log(2000n), log(4500n, 3), log(4500n, 1)] });
    const chunks = await collect(getLogsChunked(rpc, { ...Q, fromBlock: 0n, toBlock: 4500n }, noSleep));
    expect(chunks.map((c) => [c.fromBlock, c.toBlock])).toEqual([[0n, 1999n], [2000n, 3999n], [4000n, 4500n]]);
    expect(chunks[0].logs.map((l) => l.blockNumber)).toEqual([5n, 1999n]);
    expect(chunks[0].logs[0].timestamp).toBe(1_000_001 + 10);
    expect(chunks[2].logs.map((l) => l.logIndex)).toEqual([1, 3]); // sorted by block, then log index
  });

  it('retries a failed chunk and carries on', async () => {
    const rpc = fakeRpc({ genesisTs: 0, latest: 10_000n, logs: [log(10n)] });
    rpc.failNextLogCalls(3);
    const sleeps: number[] = [];
    const chunks = await collect(getLogsChunked(rpc, { ...Q, fromBlock: 0n, toBlock: 100n }, { sleep: async (ms) => void sleeps.push(ms) }));
    expect(chunks).toHaveLength(1);
    expect(sleeps).toEqual([1000, 2000, 4000]);
  });

  it('throws after one attempt and three retries, naming the block range', async () => {
    const rpc = fakeRpc({ genesisTs: 0, latest: 10_000n });
    rpc.failNextLogCalls(4);
    await expect(collect(getLogsChunked(rpc, { ...Q, fromBlock: 0n, toBlock: 100n }, noSleep))).rejects.toThrow(/blocks 0-100.*4 attempts/);
  });
});

describe('firstBlockAtOrAfter', () => {
  it('lands exactly on a regular two-second chain in a handful of calls', async () => {
    const rpc = fakeRpc({ genesisTs: 1_000_001, latest: 5_000_000n }); // odd seconds, like Base
    const latest = await rpc.latestBlock();
    const target = 1_000_001 + 2 * 1_234_567 - 1; // between two blocks
    const found = await firstBlockAtOrAfter(rpc, target, latest, latest);
    expect(found.number).toBe(1_234_567n);
    expect(found.timestamp).toBeGreaterThanOrEqual(target);
    expect(rpc.timestampOf(found.number - 1n)).toBeLessThan(target);
    expect(rpc.stats.getBlock).toBeLessThanOrEqual(4);
  });

  it('returns a block whose timestamp equals the target', async () => {
    const rpc = fakeRpc({ genesisTs: 1_000_000, latest: 1_000_000n });
    const latest = await rpc.latestBlock();
    expect((await firstBlockAtOrAfter(rpc, 1_000_000 + 2 * 777, latest, latest)).number).toBe(777n);
  });

  it('still converges when block times are irregular', async () => {
    // Two-second blocks with a ten-minute halt after block 1000.
    const timestampOf = (n: bigint) => 5_000 + Number(n) * 2 + (n > 1000n ? 600 : 0);
    const rpc = fakeRpc({ genesisTs: 5_000, latest: 100_000n, timestampOf });
    const latest = await rpc.latestBlock();
    for (const target of [5_000 + 2 * 1000 + 1, 5_000 + 2 * 1000 + 300, 5_000 + 2 * 50_000 + 601]) {
      const found = await firstBlockAtOrAfter(rpc, target, latest, latest);
      expect(found.timestamp).toBeGreaterThanOrEqual(target);
      expect(timestampOf(found.number - 1n)).toBeLessThan(target);
    }
  });

  it('refuses a target the chain has not reached', async () => {
    const rpc = fakeRpc({ genesisTs: 0, latest: 100n });
    const latest = await rpc.latestBlock();
    await expect(firstBlockAtOrAfter(rpc, 10_000, latest, latest)).rejects.toThrow(/no block at or after/);
  });
});

describe('createViemRpc', () => {
  it('supports Base only', () => {
    expect(() => createViemRpc('http://localhost:1', 8453)).not.toThrow();
    let code: string | undefined;
    try {
      createViemRpc('http://localhost:1', 1);
    } catch (err) {
      code = (err as OrionError).code;
    }
    expect(code).toBe('unsupported_chain');
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/ingest/rpc.test.ts`
Expected: FAIL (cannot find `src/ingest/transport/rpc.js`).

- [ ] **Step 4: Implement**

Create `src/ingest/transport/rpc.ts`:

```ts
/** A block number and its timestamp in unix seconds. */
export interface BlockRef {
  number: bigint;
  timestamp: number;
}

/** `signature` is a human-readable ABI item, e.g. 'function totalSupply() view returns (uint256)'. */
export interface ContractCall {
  address: string;
  signature: string;
  functionName: string;
  args?: readonly unknown[];
}

/** Every read Orion makes returns an unsigned integer. */
export type CallResult = { ok: true; value: bigint } | { ok: false; error: string };

/** A decoded ERC-20 Transfer to the queried sink, stamped with its own block time (unix seconds). */
export interface TransferLog {
  blockNumber: bigint;
  logIndex: number;
  txHash: string;
  from: string;
  value: bigint;
  timestamp: number;
}

export interface LogQuery {
  token: string;
  to: string;
  fromBlock: bigint;
  toBlock: bigint;
}

export interface RpcTransport {
  latestBlock(): Promise<BlockRef>;
  getBlock(number: bigint): Promise<BlockRef>;
  /** One eth_call at one block. A failed call is reported in its slot; the batch itself only throws on transport failure. */
  multicall(calls: ContractCall[], blockNumber: bigint): Promise<CallResult[]>;
  /** One range of at most MAX_LOG_RANGE blocks. */
  getTransferLogs(q: LogQuery): Promise<TransferLog[]>;
}

export type RpcFactory = (url: string, chainId: number) => RpcTransport;

/** https://mainnet.base.org caps eth_getLogs at 2,000 blocks per call (error -32614 beyond that). */
export const MAX_LOG_RANGE = 2000n;

/**
 * Walks [fromBlock, toBlock] in chunks. Each chunk gets one attempt plus three retries; when it
 * still fails the generator throws, and the caller keeps whatever it already committed.
 */
export async function* getLogsChunked(
  rpc: RpcTransport,
  q: LogQuery,
  opts: { sleep(ms: number): Promise<void>; attempts?: number; backoffMs?: number },
): AsyncGenerator<{ fromBlock: bigint; toBlock: bigint; logs: TransferLog[] }> {
  const attempts = opts.attempts ?? 4;
  const backoffMs = opts.backoffMs ?? 1000;
  for (let from = q.fromBlock; from <= q.toBlock; from += MAX_LOG_RANGE) {
    const to = from + MAX_LOG_RANGE - 1n < q.toBlock ? from + MAX_LOG_RANGE - 1n : q.toBlock;
    let logs: TransferLog[] | null = null;
    let failure = '';
    for (let attempt = 1; attempt <= attempts && logs === null; attempt++) {
      try {
        logs = await rpc.getTransferLogs({ token: q.token, to: q.to, fromBlock: from, toBlock: to });
      } catch (err) {
        failure = err instanceof Error ? err.message : String(err);
        if (attempt < attempts) await opts.sleep(backoffMs * 2 ** (attempt - 1));
      }
    }
    if (logs === null) throw new Error(`eth_getLogs failed for blocks ${from}-${to} after ${attempts} attempts: ${failure}`);
    logs.sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1));
    yield { fromBlock: from, toBlock: to, logs };
  }
}

/**
 * The first block whose timestamp is at or after `targetTs`. Estimates from the anchor at
 * `blockTimeSec` per block, then corrects; it converges on irregular chains too, just more slowly.
 */
export async function firstBlockAtOrAfter(
  rpc: RpcTransport,
  targetTs: number,
  anchor: BlockRef,
  latest: BlockRef,
  blockTimeSec = 2,
): Promise<BlockRef> {
  if (latest.timestamp < targetTs) throw new Error(`no block at or after ${new Date(targetTs * 1000).toISOString()} yet`);
  const clamp = (n: bigint): bigint => (n < 0n ? 0n : n > latest.number ? latest.number : n);
  const estimateFrom = (b: BlockRef): bigint => b.number + BigInt(Math.round((targetTs - b.timestamp) / blockTimeSec));

  // Bracket the answer: `lo` is the highest block known to be before the target, `hi` the lowest
  // known to be at or after it. Probe the time-based estimate while it falls strictly inside the
  // bracket; otherwise bisect. A pure estimate-and-jump search ping-pongs across a chain halt.
  let lo: BlockRef | null = null;
  let hi: BlockRef = latest;
  let next = clamp(estimateFrom(anchor));
  for (let i = 0; i < 64; i++) {
    if (hi.number === 0n || (lo !== null && hi.number - lo.number === 1n)) return hi;
    const b = await rpc.getBlock(next);
    if (b.timestamp < targetTs) lo = b;
    else hi = b;
    const lowest: bigint = lo === null ? 0n : lo.number + 1n;
    const highest: bigint = hi.number - 1n;
    if (lowest > highest) continue; // adjacent (or hi is block 0): the check at the top of the loop returns
    const estimate = estimateFrom(b);
    next = estimate >= lowest && estimate <= highest ? estimate : lo === null ? highest : (lowest + highest) / 2n;
  }
  throw new Error(`could not locate the first block at or after ${new Date(targetTs * 1000).toISOString()}`);
}
```

Create `src/ingest/transport/viemRpc.ts`:

```ts
import { createPublicClient, http, parseAbi, parseAbiItem, type Address } from 'viem';
import { base } from 'viem/chains';
import { OrionError } from '../../types.js';
import type { CallResult, RpcFactory } from './rpc.js';

const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

/** The only file that imports viem. Base only, until a second chain is actually needed. */
export const createViemRpc: RpcFactory = (url, chainId) => {
  if (chainId !== base.id) throw new OrionError('unsupported_chain', `chain_id ${chainId} is not supported; only Base (${base.id}) is`);
  const client = createPublicClient({ chain: base, transport: http(url, { retryCount: 3, retryDelay: 1000, timeout: 20_000 }) });

  return {
    async latestBlock() {
      const b = await client.getBlock();
      return { number: b.number, timestamp: Number(b.timestamp) };
    },
    async getBlock(number) {
      const b = await client.getBlock({ blockNumber: number });
      return { number: b.number, timestamp: Number(b.timestamp) };
    },
    async multicall(calls, blockNumber) {
      // One eth_call: the public Base RPC throttles bursts of separate calls, and the default
      // viem batch size would split a large read into many requests.
      const results = await client.multicall({
        allowFailure: true,
        blockNumber,
        batchSize: 100_000,
        contracts: calls.map((c) => ({
          address: c.address as Address,
          abi: parseAbi([c.signature]),
          functionName: c.functionName,
          args: c.args ?? [],
        })),
      });
      return results.map(
        (r): CallResult => (r.status === 'success' ? { ok: true, value: BigInt(r.result as bigint | number) } : { ok: false, error: r.error.message }),
      );
    },
    async getTransferLogs(q) {
      const logs = await client.getLogs({
        address: q.token as Address,
        event: TRANSFER,
        args: { to: q.to as Address },
        fromBlock: q.fromBlock,
        toBlock: q.toBlock,
      });
      return logs.map((l) => {
        const ts = (l as { blockTimestamp?: bigint | null }).blockTimestamp;
        if (ts === undefined || ts === null) {
          throw new Error('the RPC did not return blockTimestamp on logs; use a Base RPC that does (https://mainnet.base.org does)');
        }
        if (l.blockNumber === null || l.logIndex === null || l.transactionHash === null || l.args.from === undefined || l.args.value === undefined) {
          throw new Error('the RPC returned a pending or malformed Transfer log');
        }
        return { blockNumber: l.blockNumber, logIndex: l.logIndex, txHash: l.transactionHash, from: l.args.from, value: l.args.value, timestamp: Number(ts) };
      });
    },
  };
};
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/ingest/rpc.test.ts && npm run typecheck`
Expected: PASS. `viemRpc.ts` is covered by the type checker here and by the live checkpoint in Task 21; nothing in CI touches the network.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/ingest/transport tests/helpers/fakeRpc.ts tests/ingest/rpc.test.ts
git commit -m "feat(ingest): RPC transport interface, chunked log scan, block-by-time search, and the viem implementation"
```

### Task 7: Ingest core types and the API sources (`coingecko`, `http_json`, `defillama`, `adapter`)

A source handler turns a batch of requests for one source into one `ReadingResult` per request, in order. A handler THROWS when the whole batch failed (the endpoint is down); it returns `{ ok: false }` in a slot when only that reading failed (a missing field). Handlers return raw readings and never write to the database.

Rules:
- An API level is stamped at fetch time (`ctx.nowIso`), source `api`.
- `coingecko`: all requests are served by ONE `/coins/markets?vs_currency=usd&ids=...` call (ids sorted, de-duplicated). `COINGECKO_API_KEY`, when set, is sent as the `x-cg-demo-api-key` header.
- `http_json`: `path` is a dot path (numeric segments index arrays). The value may be a number or a numeric string, including scientific notation (`"3.95e+22"`). Result: `scale * value / 10^decimals`. One request per distinct URL.
- `defillama`: `https://api.llama.fi/summary/fees/<slug>?dataType=<data_type>`; `totalDataChart` is `[unixSeconds, usd][]`, one entry per UTC day. Returned as a daily series; it is never an observation.
- `adapter`: looks the adapter up by name and runs it. An adapter that throws fails only its own reading.
- Non-finite values are failures.

**Files:**
- Create: `src/ingest/time.ts`, `src/ingest/units.ts`, `src/ingest/types.ts`, `src/ingest/sourceId.ts`, `src/ingest/adapters/registry.ts`, `src/ingest/sources/coingecko.ts`, `src/ingest/sources/httpJson.ts`, `src/ingest/sources/defillama.ts`, `src/ingest/sources/adapter.ts`, `src/ingest/sources/registry.ts`
- Create: `tests/helpers/fakeHttp.ts`, `tests/helpers/sourceCtx.ts`, `tests/ingest/units.test.ts`, `tests/ingest/sources.api.test.ts`

**Interfaces:**
- Consumes: `HttpTransport` (Task 5), `RpcTransport`, `BlockRef` (Task 6), `SourceConfig`, `SourceOf` (Task 4).
- Produces (`src/ingest/time.ts`): `utcDay(ms: number): string` (`'YYYY-MM-DD'`), `dayStartMs(day: string): number`, `addDays(day: string, n: number): string`, `monthOf(day: string): string` (`'YYYY-MM'`), `daysInMonth(month: string): number`.
- Produces (`src/ingest/units.ts`): `unitsToNumber(raw: bigint, decimals: number): number`, `toFiniteNumber(v: unknown): number | null`.
- Produces (`src/ingest/types.ts`):

```ts
export interface DailyPoint { day: string; value: number }        // the UTC day the value covers
export interface MonthlyPoint { month: string; value: number }
export type SourceValue =
  | { kind: 'level'; value: number; observedAt: string; source: 'onchain' | 'api'; detail: string }
  | { kind: 'daily_series'; points: DailyPoint[]; detail: string }
  | { kind: 'monthly_series'; points: MonthlyPoint[]; detail: string }
export type ReadingResult = { ok: true; value: SourceValue } | { ok: false; error: string }
export function failed(error: string): ReadingResult
export function level(value: number, observedAt: string, source: 'onchain' | 'api', detail: string): ReadingResult
export interface SourceRequest { metricKey: string; role: 'primary' | 'cross_check'; source: SourceConfig; tolerancePct: number }
export interface SourceContext { asset: AssetConfig; nowIso: string; http: HttpTransport; rpc: RpcTransport | null; block: BlockRef | null; env: Record<string, string | undefined>; contract(name: string): string }
export interface SourceHandler { id: string; fetch(requests: SourceRequest[], ctx: SourceContext): Promise<ReadingResult[]> }
export function narrow<T extends SourceConfig['type']>(s: SourceConfig, type: T): SourceOf<T>
export function contractResolver(asset: AssetConfig): (name: string) => string
```

- Produces (`src/ingest/sourceId.ts`): `sourceId(s: SourceConfig): string`. Values: `coingecko`; `http_json:<url>`; `defillama:<slug>:<data_type>`; `chain_levels` (both `erc20_supply` and `contract_read`); `transfer_flow:<token>><to>[<sorted allowlist names>]`; `adapter:<name>`; `derived:<name>`. This string is the batch key, the key in `fetch_runs.detail`, and the `dedupe_key` of cross-check and failure-streak anomalies.
- Produces (`src/ingest/adapters/registry.ts`): `interface AdapterDef { name: string; needsRpc: boolean; run(ctx: SourceContext, params: Record<string, unknown>): Promise<SourceValue> }`, `registerAdapter(def)`, `getAdapter(name)` (throws `OrionError('unknown_adapter')`), `adapterNames()`.
- Produces (`src/ingest/sources/coingecko.ts`): `COINGECKO_API`, `coingeckoHeaders(env)`, `coingeckoSource`.
- Produces (`src/ingest/sources/registry.ts`): `getSourceHandler(type: SourceConfig['type']): SourceHandler` (throws `OrionError('unknown_source_type')` for `transfer_flow` and `derived`, which are not batch handlers).
- Produces (`tests/helpers/fakeHttp.ts`): `fakeHttp(routes): HttpTransport & { calls: { url: string; headers: Record<string, string> }[] }`. A route key matches a URL that equals it or starts with it (longest key wins); a route value may be JSON, an `Error` (thrown), or a function of the URL.
- Produces (`tests/helpers/sourceCtx.ts`): `sourceCtx(over?)`, `fixture(name)`, `req(metricKey, source, role?, tolerancePct?)`.

- [ ] **Step 1: Write the helpers and the failing tests**

Create `tests/helpers/fakeHttp.ts`:

```ts
import type { HttpTransport } from '../../src/ingest/transport/http.js';

export type Route = unknown | Error | ((url: string) => unknown);

export interface FakeHttp extends HttpTransport {
  calls: { url: string; headers: Record<string, string> }[];
}

/** A route key matches a URL that equals it or starts with it; the longest matching key wins. */
export function fakeHttp(routes: Record<string, Route>): FakeHttp {
  const calls: FakeHttp['calls'] = [];
  return {
    calls,
    async getJson(url, headers = {}) {
      calls.push({ url, headers });
      const key = Object.keys(routes)
        .filter((k) => url === k || url.startsWith(k))
        .sort((a, b) => b.length - a.length)[0];
      if (key === undefined) throw new Error(`fakeHttp: no route for ${url}`);
      const route = routes[key];
      if (route instanceof Error) throw route;
      return typeof route === 'function' ? (route as (u: string) => unknown)(url) : structuredClone(route);
    },
  };
}
```

Create `tests/helpers/sourceCtx.ts`:

```ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { SourceConfig } from '../../src/config/sources.js';
import { contractResolver, type SourceContext, type SourceRequest } from '../../src/ingest/types.js';
import { fakeHttp } from './fakeHttp.js';
import { ingestAsset } from './ingestAsset.js';

export const NOW_ISO = '2026-09-19T20:30:00.000Z';

/** A real response captured by the 2026-09-19 research pass. */
export function fixture(name: string): unknown {
  const path = fileURLToPath(new URL(`../fixtures/ingest/research-2026-09-19/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

export function sourceCtx(over: Partial<SourceContext> = {}): SourceContext {
  const asset = over.asset ?? ingestAsset().config;
  return { asset, nowIso: NOW_ISO, http: fakeHttp({}), rpc: null, block: null, env: {}, contract: contractResolver(asset), ...over };
}

export function req(metricKey: string, source: SourceConfig, role: SourceRequest['role'] = 'primary', tolerancePct = 1): SourceRequest {
  return { metricKey, role, source, tolerancePct };
}
```

Create `tests/ingest/units.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { addDays, dayStartMs, daysInMonth, monthOf, utcDay } from '../../src/ingest/time.js';
import { toFiniteNumber, unitsToNumber } from '../../src/ingest/units.js';

describe('unitsToNumber', () => {
  it('converts base units without losing the whole part to float rounding', () => {
    expect(unitsToNumber(114886562770481399543309743n, 18)).toBeCloseTo(114886562.7704814, 6);
    expect(unitsToNumber(200000000000000000n, 18)).toBe(0.2);
    expect(unitsToNumber(18n, 0)).toBe(18);
    expect(unitsToNumber(0n, 18)).toBe(0);
  });
});

describe('toFiniteNumber', () => {
  it('accepts numbers and numeric strings, including scientific notation', () => {
    expect(toFiniteNumber(26.03)).toBe(26.03);
    expect(toFiniteNumber('26.699999999999999289')).toBeCloseTo(26.7, 12);
    expect(toFiniteNumber('3.95e+22')).toBe(3.95e22);
  });
  it('rejects everything else', () => {
    for (const v of ['', '  ', 'abc', null, undefined, true, {}, [], NaN, Infinity, '1e999']) expect(toFiniteNumber(v)).toBeNull();
  });
});

describe('UTC day helpers', () => {
  it('round-trips days and crosses month and year ends', () => {
    expect(utcDay(Date.parse('2026-09-19T23:59:59.999Z'))).toBe('2026-09-19');
    expect(dayStartMs('2026-09-19')).toBe(Date.parse('2026-09-19T00:00:00.000Z'));
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(monthOf('2026-09-19')).toBe('2026-09');
    expect(daysInMonth('2026-02')).toBe(28);
    expect(daysInMonth('2028-02')).toBe(29);
    expect(daysInMonth('2026-09')).toBe(30);
  });
});
```

Create `tests/ingest/sources.api.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { getAdapter, registerAdapter } from '../../src/ingest/adapters/registry.js';
import { sourceId } from '../../src/ingest/sourceId.js';
import { readPath } from '../../src/ingest/sources/httpJson.js';
import { getSourceHandler } from '../../src/ingest/sources/registry.js';
import type { ReadingResult } from '../../src/ingest/types.js';
import type { OrionError } from '../../src/types.js';
import { fakeHttp } from '../helpers/fakeHttp.js';
import { fixture, NOW_ISO, req, sourceCtx } from '../helpers/sourceCtx.js';

const VENICE = 'https://outerface.venice.ai/api/app/vvv';
const levelOf = (r: ReadingResult): number => {
  if (!r.ok || r.value.kind !== 'level') throw new Error(`expected a level reading, got ${JSON.stringify(r)}`);
  return r.value.value;
};

describe('sourceId', () => {
  it('gives one stable id per source', () => {
    expect(sourceId({ type: 'coingecko', id: 'a', field: 'price' })).toBe('coingecko');
    expect(sourceId({ type: 'http_json', url: `${VENICE}/vvv_stats`, path: 'price', scale: 1, decimals: 0 })).toBe(`http_json:${VENICE}/vvv_stats`);
    expect(sourceId({ type: 'defillama', slug: 'venice', data_type: 'dailyHoldersRevenue', compare: 'monthly_sum' })).toBe('defillama:venice:dailyHoldersRevenue');
    expect(sourceId({ type: 'erc20_supply', token: 'token', subtract_balances: [] })).toBe('chain_levels');
    expect(sourceId({ type: 'contract_read', contract: 'staking', function: 'f', abi_type: 'uint256', decimals: 0, scale: 1, offset: 0 })).toBe('chain_levels');
    expect(sourceId({ type: 'transfer_flow', token: 'token', to: 'burn_sink', from_allowlist: ['safe', 'pool'], unit: 'tokens' })).toBe('transfer_flow:token>burn_sink[pool,safe]');
    expect(sourceId({ type: 'adapter', name: 'vvv.x', params: {} })).toBe('adapter:vvv.x');
    expect(sourceId({ type: 'derived', name: 'burn_momentum', params: {} })).toBe('derived:burn_momentum');
  });
});

describe('coingecko source', () => {
  const handler = getSourceHandler('coingecko');
  const requests = [
    req('price_usd', { type: 'coingecko', id: 'venice-token', field: 'price' }),
    req('diem_price_usd', { type: 'coingecko', id: 'diem', field: 'price' }),
    req('circulating_supply', { type: 'coingecko', id: 'venice-token', field: 'circulating_supply' }),
    req('missing', { type: 'coingecko', id: 'not-a-coin', field: 'market_cap' }),
  ];

  it('serves every request from one /coins/markets call, stamped at fetch time', async () => {
    const http = fakeHttp({ 'https://api.coingecko.com/api/v3/coins/markets': fixture('cg_markets.json') });
    const out = await handler.fetch(requests, sourceCtx({ http }));
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0].url).toBe('https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=diem,not-a-coin,venice-token');
    expect(http.calls[0].headers).toEqual({});
    expect(levelOf(out[0])).toBe(26.03);
    expect(levelOf(out[1])).toBe(1941.6);
    expect(levelOf(out[2])).toBeCloseTo(48058904.92603289, 6);
    expect(out[0]).toMatchObject({ ok: true, value: { observedAt: NOW_ISO, source: 'api' } });
    expect(out[3]).toEqual({ ok: false, error: 'coingecko: no market row for id "not-a-coin"' });
  });

  it('sends the demo key header when COINGECKO_API_KEY is set', async () => {
    const http = fakeHttp({ 'https://api.coingecko.com/': fixture('cg_markets.json') });
    await handler.fetch(requests.slice(0, 1), sourceCtx({ http, env: { COINGECKO_API_KEY: 'secret' } }));
    expect(http.calls[0].headers).toEqual({ 'x-cg-demo-api-key': 'secret' });
  });

  it('throws for the whole batch when the response is not an array', async () => {
    const http = fakeHttp({ 'https://api.coingecko.com/': { status: { error_code: 429 } } });
    await expect(handler.fetch(requests, sourceCtx({ http }))).rejects.toThrow(/did not return an array/);
  });

  it('fails one reading when its field is not a finite number', async () => {
    const http = fakeHttp({ 'https://api.coingecko.com/': [{ id: 'venice-token', current_price: null, circulating_supply: 5 }] });
    const out = await handler.fetch([requests[0], requests[2]], sourceCtx({ http }));
    expect(out[0]).toEqual({ ok: false, error: 'coingecko: venice-token.current_price is not a finite number' });
    expect(levelOf(out[1])).toBe(5);
  });
});

describe('http_json source', () => {
  const handler = getSourceHandler('http_json');
  const stats = `${VENICE}/vvv_stats`;
  const http = () =>
    fakeHttp({ [stats]: fixture('venice_vvv_stats.json'), [`${VENICE}/diem_stats`]: fixture('venice_diem_stats.json'), [`${VENICE}/vvv_staking_yield`]: fixture('venice_vvv_staking_yield.json') });

  it('reads numeric strings, applies decimals and scale, and fetches each URL once', async () => {
    const h = http();
    const out = await handler.fetch(
      [
        req('price_usd', { type: 'http_json', url: stats, path: 'price', scale: 1, decimals: 0 }, 'cross_check'),
        req('circulating_supply', { type: 'http_json', url: stats, path: 'circulatingSupplyCryptoBaseUnit', scale: 1, decimals: 18 }, 'cross_check'),
        req('diem_target_supply', { type: 'http_json', url: `${VENICE}/diem_stats`, path: 'targetSupplyCryptoBaseUnit', scale: 1, decimals: 18 }, 'cross_check'),
        req('emission_rate_annual', { type: 'http_json', url: `${VENICE}/vvv_staking_yield`, path: 'totalEmissionsCryptoBaseUnit', scale: 365, decimals: 18 }, 'cross_check'),
      ],
      sourceCtx({ http: h }),
    );
    expect(levelOf(out[0])).toBeCloseTo(26.7, 12);
    expect(levelOf(out[1])).toBeCloseTo(48356944.49576091, 4);
    expect(levelOf(out[2])).toBeCloseTo(39500, 6); // "3.95e+22"
    expect(levelOf(out[3])).toBeCloseTo(2497395.8333333335, 3);
    expect(h.calls.map((c) => c.url)).toEqual([stats, `${VENICE}/diem_stats`, `${VENICE}/vvv_staking_yield`]);
    expect(out[0]).toMatchObject({ ok: true, value: { observedAt: NOW_ISO, source: 'api' } });
  });

  it('fails only the reading whose path is missing or not numeric', async () => {
    const out = await handler.fetch(
      [
        req('a', { type: 'http_json', url: stats, path: 'nope.deeper', scale: 1, decimals: 0 }),
        req('b', { type: 'http_json', url: stats, path: 'price', scale: 1, decimals: 0 }),
      ],
      sourceCtx({ http: http() }),
    );
    expect(out[0]).toEqual({ ok: false, error: `http_json: "nope.deeper" is not a finite number in ${stats}` });
    expect(levelOf(out[1])).toBeCloseTo(26.7, 12);
  });

  it('fails the readings of a URL that cannot be fetched, and only those', async () => {
    const h = fakeHttp({ [stats]: new Error('HTTP 503'), [`${VENICE}/diem_stats`]: fixture('venice_diem_stats.json') });
    const out = await handler.fetch(
      [
        req('a', { type: 'http_json', url: stats, path: 'price', scale: 1, decimals: 0 }),
        req('b', { type: 'http_json', url: `${VENICE}/diem_stats`, path: 'totalSupplyCryptoBaseUnit', scale: 1, decimals: 18 }),
      ],
      sourceCtx({ http: h }),
    );
    expect(out[0]).toEqual({ ok: false, error: 'HTTP 503' });
    expect(levelOf(out[1])).toBeCloseTo(37713.45712758114, 6);
  });

  it('walks dot paths through objects and arrays', () => {
    const body = { a: { b: [{ c: 7 }, { c: 8 }] } };
    expect(readPath(body, 'a.b.1.c')).toBe(8);
    expect(readPath(body, 'a.x.c')).toBeUndefined();
    expect(readPath(null, 'a')).toBeUndefined();
  });
});

describe('defillama source', () => {
  const handler = getSourceHandler('defillama');
  const source = { type: 'defillama', slug: 'venice', data_type: 'dailyHoldersRevenue', compare: 'monthly_sum' } as const;

  it('returns the daily USD series, one point per UTC day', async () => {
    const http = fakeHttp({ 'https://api.llama.fi/summary/fees/venice?dataType=dailyHoldersRevenue': fixture('llama_venice.json') });
    const [out] = await handler.fetch([req('flow_usd.burn', source, 'cross_check', 5)], sourceCtx({ http }));
    if (!out.ok || out.value.kind !== 'daily_series') throw new Error('expected a daily series');
    expect(out.value.points).toHaveLength(286);
    expect(out.value.points[0]).toEqual({ day: '2025-12-08', value: 64402 });
    expect(out.value.points.at(-1)).toEqual({ day: '2026-09-19', value: 14949 });
    const august = out.value.points.filter((p) => p.day.startsWith('2026-08'));
    expect(august).toHaveLength(31);
    expect(august.reduce((s, p) => s + p.value, 0)).toBe(697337);
  });

  it('throws when totalDataChart is missing or malformed', async () => {
    await expect(handler.fetch([req('m', source)], sourceCtx({ http: fakeHttp({ 'https://api.llama.fi/': {} }) }))).rejects.toThrow(/totalDataChart/);
    const bad = fakeHttp({ 'https://api.llama.fi/': { totalDataChart: [[1765152000, 'x']] } });
    await expect(handler.fetch([req('m', source)], sourceCtx({ http: bad }))).rejects.toThrow(/totalDataChart/);
  });
});

describe('adapter source and registry', () => {
  it('runs a registered adapter and isolates one that throws', async () => {
    registerAdapter({ name: 'test.ok', needsRpc: false, run: async (ctx, params) => ({ kind: 'level', value: Number(params.n), observedAt: ctx.nowIso, source: 'api', detail: 'test' }) });
    registerAdapter({ name: 'test.boom', needsRpc: false, run: async () => { throw new Error('boom'); } });
    const handler = getSourceHandler('adapter');
    const out = await handler.fetch(
      [req('a', { type: 'adapter', name: 'test.ok', params: { n: 4 } }), req('b', { type: 'adapter', name: 'test.boom', params: {} })],
      sourceCtx(),
    );
    expect(levelOf(out[0])).toBe(4);
    expect(out[1]).toEqual({ ok: false, error: 'adapter test.boom: boom' });
  });

  it('rejects an unknown adapter name and an unbatchable source type', () => {
    const codeOf = (fn: () => unknown) => {
      try {
        fn();
      } catch (err) {
        return (err as OrionError).code;
      }
      return undefined;
    };
    expect(codeOf(() => getAdapter('nope'))).toBe('unknown_adapter');
    expect(codeOf(() => getSourceHandler('transfer_flow'))).toBe('unknown_source_type');
    expect(codeOf(() => getSourceHandler('derived'))).toBe('unknown_source_type');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/ingest/units.test.ts tests/ingest/sources.api.test.ts`
Expected: FAIL (missing modules under `src/ingest/`).

- [ ] **Step 3: Implement**

Create `src/ingest/time.ts`:

```ts
import { MS_PER_DAY } from '../types.js';

/** 'YYYY-MM-DD' of the UTC day containing `ms`. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function dayStartMs(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`);
}

export function addDays(day: string, n: number): string {
  return utcDay(dayStartMs(day) + n * MS_PER_DAY);
}

/** 'YYYY-MM' of a 'YYYY-MM-DD' day. */
export function monthOf(day: string): string {
  return day.slice(0, 7);
}

export function daysInMonth(month: string): number {
  const [year, m] = month.split('-').map(Number);
  return new Date(Date.UTC(year, m, 0)).getUTCDate();
}
```

Create `src/ingest/units.ts`:

```ts
/** Integer base units to a float, splitting whole and fraction so the whole part is not rounded twice. */
export function unitsToNumber(raw: bigint, decimals: number): number {
  const base = 10n ** BigInt(decimals);
  return Number(raw / base) + Number(raw % base) / Number(base);
}

/** A finite number from a number or a numeric string ("26.69", "3.95e+22"). Anything else is null. */
export function toFiniteNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string' || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
```

Create `src/ingest/types.ts`:

```ts
import type { AssetConfig } from '../config/schema.js';
import type { SourceConfig, SourceOf } from '../config/sources.js';
import { OrionError } from '../types.js';
import type { HttpTransport } from './transport/http.js';
import type { BlockRef, RpcTransport } from './transport/rpc.js';

/** `day` is the UTC day ('YYYY-MM-DD') the value covers. */
export interface DailyPoint {
  day: string;
  value: number;
}

/** `month` is 'YYYY-MM'. */
export interface MonthlyPoint {
  month: string;
  value: number;
}

/** What a source returned, with the source's own timestamp. Series are for cross-checks only; they never become observations. */
export type SourceValue =
  | { kind: 'level'; value: number; observedAt: string; source: 'onchain' | 'api'; detail: string }
  | { kind: 'daily_series'; points: DailyPoint[]; detail: string }
  | { kind: 'monthly_series'; points: MonthlyPoint[]; detail: string };

export type ReadingResult = { ok: true; value: SourceValue } | { ok: false; error: string };

export function failed(error: string): ReadingResult {
  return { ok: false, error };
}

export function level(value: number, observedAt: string, source: 'onchain' | 'api', detail: string): ReadingResult {
  return { ok: true, value: { kind: 'level', value, observedAt, source, detail } };
}

export interface SourceRequest {
  metricKey: string;
  role: 'primary' | 'cross_check';
  source: SourceConfig;
  /** For a cross-check: its own tolerance, or the metric's. Unused for a primary. */
  tolerancePct: number;
}

export interface SourceContext {
  asset: AssetConfig;
  /** Fetch time. API levels are stamped with it. */
  nowIso: string;
  http: HttpTransport;
  rpc: RpcTransport | null;
  /** The latest block at plan start. Every chain level in one run is read at this block and stamped with its time. */
  block: BlockRef | null;
  env: Record<string, string | undefined>;
  /** Address of a named contract from the asset's `contracts` map. */
  contract(name: string): string;
}

/**
 * Serves one batch of requests for one source. Returns one result per request, in order.
 * Throws when the whole batch failed; returns { ok: false } in a slot when only that reading failed.
 */
export interface SourceHandler {
  id: string;
  fetch(requests: SourceRequest[], ctx: SourceContext): Promise<ReadingResult[]>;
}

export function narrow<T extends SourceConfig['type']>(s: SourceConfig, type: T): SourceOf<T> {
  if (s.type !== type) throw new Error(`expected a ${type} source, got ${s.type}`);
  return s as SourceOf<T>;
}

export function contractResolver(asset: AssetConfig): (name: string) => string {
  return (name) => {
    const address = asset.contracts[name];
    if (address === undefined) throw new OrionError('unknown_contract', `contract "${name}" is not defined in assets/${asset.id}.yaml`);
    return address;
  };
}
```

Create `src/ingest/sourceId.ts`:

```ts
import type { SourceConfig } from '../config/sources.js';

/**
 * One stable id per source. It is the batch key (requests with the same id are served together),
 * the key of the source's entry in fetch_runs.detail, and the dedupe key of cross-check and
 * failure-streak anomalies.
 */
export function sourceId(s: SourceConfig): string {
  switch (s.type) {
    case 'coingecko':
      return 'coingecko';
    case 'http_json':
      return `http_json:${s.url}`;
    case 'defillama':
      return `defillama:${s.slug}:${s.data_type}`;
    case 'erc20_supply':
    case 'contract_read':
      return 'chain_levels';
    case 'transfer_flow':
      return `transfer_flow:${s.token}>${s.to}[${[...s.from_allowlist].sort().join(',')}]`;
    case 'adapter':
      return `adapter:${s.name}`;
    case 'derived':
      return `derived:${s.name}`;
  }
}
```

Create `src/ingest/adapters/registry.ts`:

```ts
import { OrionError } from '../../types.js';
import type { SourceContext, SourceValue } from '../types.js';

/** A named code adapter: the escape hatch for metrics the declarative source types cannot express. */
export interface AdapterDef {
  name: string;
  /** True when the adapter reads the chain, so the run must open an RPC connection. */
  needsRpc: boolean;
  run(ctx: SourceContext, params: Record<string, unknown>): Promise<SourceValue>;
}

const ADAPTERS = new Map<string, AdapterDef>();

export function registerAdapter(def: AdapterDef): void {
  ADAPTERS.set(def.name, def);
}

export function getAdapter(name: string): AdapterDef {
  const def = ADAPTERS.get(name);
  if (!def) throw new OrionError('unknown_adapter', `unknown adapter: ${name}`);
  return def;
}

export function adapterNames(): string[] {
  return [...ADAPTERS.keys()].sort();
}
```

Create `src/ingest/sources/coingecko.ts`:

```ts
import { failed, level, narrow, type SourceHandler } from '../types.js';
import { toFiniteNumber } from '../units.js';

export const COINGECKO_API = 'https://api.coingecko.com/api/v3';

/** The demo-key header, when a key is configured. Keyless works too, at a lower rate limit. */
export function coingeckoHeaders(env: Record<string, string | undefined>): Record<string, string> {
  return env.COINGECKO_API_KEY ? { 'x-cg-demo-api-key': env.COINGECKO_API_KEY } : {};
}

const FIELD = { price: 'current_price', market_cap: 'market_cap', circulating_supply: 'circulating_supply' } as const;

/** All coingecko metrics of an asset come from one /coins/markets call. */
export const coingeckoSource: SourceHandler = {
  id: 'coingecko',
  async fetch(requests, ctx) {
    const sources = requests.map((r) => narrow(r.source, 'coingecko'));
    const ids = [...new Set(sources.map((s) => s.id))].sort();
    const url = `${COINGECKO_API}/coins/markets?vs_currency=usd&ids=${ids.map(encodeURIComponent).join(',')}`;
    const body = await ctx.http.getJson(url, coingeckoHeaders(ctx.env));
    if (!Array.isArray(body)) throw new Error('coingecko: /coins/markets did not return an array');

    const rows = new Map<string, Record<string, unknown>>();
    for (const row of body) {
      if (row !== null && typeof row === 'object' && typeof (row as { id?: unknown }).id === 'string') {
        rows.set((row as { id: string }).id, row as Record<string, unknown>);
      }
    }
    return sources.map((s) => {
      const row = rows.get(s.id);
      if (!row) return failed(`coingecko: no market row for id "${s.id}"`);
      const value = toFiniteNumber(row[FIELD[s.field]]);
      if (value === null) return failed(`coingecko: ${s.id}.${FIELD[s.field]} is not a finite number`);
      return level(value, ctx.nowIso, 'api', `coingecko /coins/markets ${s.id}.${FIELD[s.field]}`);
    });
  },
};
```

Create `src/ingest/sources/httpJson.ts`:

```ts
import { failed, level, narrow, type ReadingResult, type SourceHandler } from '../types.js';
import { toFiniteNumber } from '../units.js';

/** Dot path into parsed JSON. Numeric segments index arrays. Undefined when any step is missing. */
export function readPath(body: unknown, path: string): unknown {
  let current: unknown = body;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** A level from one field of a JSON endpoint: scale * value / 10^decimals, stamped at fetch time. */
export const httpJsonSource: SourceHandler = {
  id: 'http_json',
  async fetch(requests, ctx) {
    const bodies = new Map<string, { body: unknown } | { error: string }>();
    const results: ReadingResult[] = [];
    for (const r of requests) {
      const s = narrow(r.source, 'http_json');
      let fetched = bodies.get(s.url);
      if (!fetched) {
        try {
          fetched = { body: await ctx.http.getJson(s.url) };
        } catch (err) {
          fetched = { error: err instanceof Error ? err.message : String(err) };
        }
        bodies.set(s.url, fetched);
      }
      if ('error' in fetched) {
        results.push(failed(fetched.error));
        continue;
      }
      const raw = toFiniteNumber(readPath(fetched.body, s.path));
      results.push(
        raw === null
          ? failed(`http_json: "${s.path}" is not a finite number in ${s.url}`)
          : level((s.scale * raw) / 10 ** s.decimals, ctx.nowIso, 'api', `${s.url} ${s.path}`),
      );
    }
    return results;
  },
};
```

Create `src/ingest/sources/defillama.ts`:

```ts
import { utcDay } from '../time.js';
import { narrow, type DailyPoint, type ReadingResult, type SourceHandler } from '../types.js';

export const DEFILLAMA_API = 'https://api.llama.fi';

/** A daily USD series from DefiLlama's fees summary. Cross-check use only: it is never an observation. */
export const defillamaSource: SourceHandler = {
  id: 'defillama',
  async fetch(requests, ctx) {
    const results: ReadingResult[] = [];
    for (const r of requests) {
      const s = narrow(r.source, 'defillama');
      const url = `${DEFILLAMA_API}/summary/fees/${encodeURIComponent(s.slug)}?dataType=${encodeURIComponent(s.data_type)}`;
      const body = (await ctx.http.getJson(url)) as { totalDataChart?: unknown } | null;
      const chart = body?.totalDataChart;
      if (!Array.isArray(chart)) throw new Error(`defillama: ${url} has no totalDataChart`);
      const points: DailyPoint[] = chart.map((entry) => {
        const [ts, usd] = Array.isArray(entry) ? (entry as unknown[]) : [];
        if (typeof ts !== 'number' || typeof usd !== 'number' || !Number.isFinite(ts) || !Number.isFinite(usd)) {
          throw new Error(`defillama: malformed totalDataChart entry ${JSON.stringify(entry)}`);
        }
        return { day: utcDay(ts * 1000), value: usd };
      });
      results.push({ ok: true, value: { kind: 'daily_series', points, detail: url } });
    }
    return results;
  },
};
```

Create `src/ingest/sources/adapter.ts`:

```ts
import { getAdapter } from '../adapters/registry.js';
import { failed, narrow, type ReadingResult, type SourceHandler } from '../types.js';

/** Dispatches to named adapters. An adapter that throws fails only its own reading. */
export const adapterSource: SourceHandler = {
  id: 'adapter',
  async fetch(requests, ctx) {
    const results: ReadingResult[] = [];
    for (const r of requests) {
      const s = narrow(r.source, 'adapter');
      const def = getAdapter(s.name); // an unknown name is a configuration error and propagates
      try {
        results.push({ ok: true, value: await def.run(ctx, s.params) });
      } catch (err) {
        results.push(failed(`adapter ${s.name}: ${err instanceof Error ? err.message : String(err)}`));
      }
    }
    return results;
  },
};
```

Create `src/ingest/sources/registry.ts`:

```ts
import type { SourceConfig } from '../../config/sources.js';
import { OrionError } from '../../types.js';
import type { SourceHandler } from '../types.js';
import { adapterSource } from './adapter.js';
import { coingeckoSource } from './coingecko.js';
import { defillamaSource } from './defillama.js';
import { httpJsonSource } from './httpJson.js';

/** Batch handlers by source type. transfer_flow and derived are not batch handlers: fetchAsset runs them itself. */
const HANDLERS: Partial<Record<SourceConfig['type'], SourceHandler>> = {
  coingecko: coingeckoSource,
  http_json: httpJsonSource,
  defillama: defillamaSource,
  adapter: adapterSource,
};

export function getSourceHandler(type: SourceConfig['type']): SourceHandler {
  const handler = HANDLERS[type];
  if (!handler) throw new OrionError('unknown_source_type', `no batch handler for source type "${type}"`);
  return handler;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/ingest && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ingest tests/ingest tests/helpers/fakeHttp.ts tests/helpers/sourceCtx.ts
git commit -m "feat(ingest): source handler contract and the coingecko, http_json, defillama, and adapter sources"
```

### Task 8: Chain level sources (`erc20_supply`, `contract_read`)

Both are served by one handler, because all chain levels in a run are read in ONE multicall at ONE block (`ctx.block`) and stamped with that block's time.

- `erc20_supply`: `(totalSupply() - sum of balanceOf(each subtract_balances contract)) / 10^decimals()`, with the token's own `decimals()` read in the same multicall.
- `contract_read`: `offset + scale * raw / 10^decimals`, where the call is `function <function>() view returns (<abi_type>)`.
- A failed call fails only the readings that needed it. No RPC or no block is a whole-batch failure.

**Files:**
- Create: `src/ingest/sources/chainLevels.ts`, `tests/ingest/sources.chain.test.ts`
- Modify: `src/ingest/sources/registry.ts`

**Interfaces:**
- Consumes: `SourceHandler`, `SourceContext`, `level`, `failed` (Task 7); `ContractCall` (Task 6); `unitsToNumber` (Task 7); `fakeRpc`, `callKey` (Task 6).
- Produces: `chainLevelsSource: SourceHandler` (id `chain_levels`); `getSourceHandler('erc20_supply')` and `getSourceHandler('contract_read')` both return it. Also exports the ABI strings `ERC20_ABI.totalSupply | decimals | balanceOf` for reuse by the flow scan and the adapters.

- [ ] **Step 1: Write the failing test**

Create `tests/ingest/sources.chain.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { getSourceHandler } from '../../src/ingest/sources/registry.js';
import type { ReadingResult } from '../../src/ingest/types.js';
import { callKey, fakeRpc } from '../helpers/fakeRpc.js';
import { SINK, STAKING, TOKEN } from '../helpers/ingestAsset.js';
import { req, sourceCtx } from '../helpers/sourceCtx.js';

// Values read live from Base on 2026-09-19 (tests/fixtures/ingest/research-2026-09-19/chain_reads.json).
const CALLS = {
  [callKey(TOKEN, 'totalSupply')]: 114886562770481399543309743n,
  [callKey(TOKEN, 'decimals')]: 18n,
  [callKey(TOKEN, 'balanceOf', [SINK])]: 33877292523889967424801955n,
  [callKey(STAKING, 'totalSupply')]: 33941208987993140790795723n,
  [callKey(STAKING, 'emissionRatePerSecond')]: 79274479959411466n,
  [callKey(STAKING, 'veniceEmissionsPercentageWhenLocked')]: 200000000000000000n,
};

const read = (fn: string, over: Partial<{ decimals: number; scale: number; offset: number }> = {}) =>
  ({ type: 'contract_read', contract: 'staking', function: fn, abi_type: 'uint256', decimals: 18, scale: 1, offset: 0, ...over }) as const;
const levelOf = (r: ReadingResult): number => {
  if (!r.ok || r.value.kind !== 'level') throw new Error(`expected a level reading, got ${JSON.stringify(r)}`);
  return r.value.value;
};

describe('chain level sources', () => {
  const requests = [
    req('effective_supply', { type: 'erc20_supply', token: 'token', subtract_balances: ['burn_sink'] }),
    req('staked_supply', read('totalSupply')),
    req('emission_rate_annual', read('emissionRatePerSecond', { scale: 31_536_000 })),
    req('diem_locked_yield_share', read('veniceEmissionsPercentageWhenLocked', { scale: -1, offset: 1 })),
  ];

  it('reads every level in one multicall at one block and stamps it with the block time', async () => {
    const rpc = fakeRpc({ genesisTs: 1_700_000_001, latest: 1000n, calls: CALLS });
    const block = await rpc.latestBlock();
    const out = await getSourceHandler('erc20_supply').fetch(requests, sourceCtx({ rpc, block }));
    expect(rpc.stats.multicall).toBe(1);
    expect(levelOf(out[0])).toBeCloseTo(81009270.24659143, 4); // totalSupply minus the zero-address balance
    expect(levelOf(out[1])).toBeCloseTo(33941208.98799314, 4);
    expect(levelOf(out[2])).toBeCloseTo(2_500_000, 3);
    expect(levelOf(out[3])).toBeCloseTo(0.8, 12); // 1 - 0.2: fractions are scaled by 1e18
    const stamp = new Date((1_700_000_001 + 2000) * 1000).toISOString();
    for (const r of out) expect(r).toMatchObject({ ok: true, value: { observedAt: stamp, source: 'onchain', detail: 'block 1000' } });
  });

  it('serves both source types from the same handler', () => {
    expect(getSourceHandler('contract_read')).toBe(getSourceHandler('erc20_supply'));
  });

  it('fails only the readings that needed a failed call', async () => {
    const rpc = fakeRpc({ genesisTs: 0, latest: 10n, calls: { ...CALLS, [callKey(TOKEN, 'balanceOf', [SINK])]: new Error('execution reverted') } });
    const out = await getSourceHandler('contract_read').fetch(requests, sourceCtx({ rpc, block: await rpc.latestBlock() }));
    expect(out[0]).toEqual({ ok: false, error: 'balanceOf(burn_sink) on token: execution reverted' });
    expect(out[1].ok).toBe(true);
  });

  it('fails the whole batch without an RPC connection or a block', async () => {
    await expect(getSourceHandler('contract_read').fetch(requests, sourceCtx())).rejects.toThrow(/RPC/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/ingest/sources.chain.test.ts`
Expected: FAIL (`no batch handler for source type "erc20_supply"`).

- [ ] **Step 3: Implement**

Create `src/ingest/sources/chainLevels.ts`:

```ts
import type { CallResult, ContractCall } from '../transport/rpc.js';
import { failed, level, type ReadingResult, type SourceHandler } from '../types.js';
import { unitsToNumber } from '../units.js';

export const ERC20_ABI = {
  totalSupply: 'function totalSupply() view returns (uint256)',
  decimals: 'function decimals() view returns (uint8)',
  balanceOf: 'function balanceOf(address) view returns (uint256)',
} as const;

interface Slot {
  index: number;
  label: string;
}

type Need =
  | { kind: 'erc20'; total: Slot; decimals: Slot; balances: Slot[] }
  | { kind: 'read'; call: Slot; decimals: number; scale: number; offset: number };

/** erc20_supply and contract_read: every chain level of a run in one multicall at one block. */
export const chainLevelsSource: SourceHandler = {
  id: 'chain_levels',
  async fetch(requests, ctx) {
    if (!ctx.rpc || !ctx.block) throw new Error('chain sources need an RPC connection and a block');

    const calls: ContractCall[] = [];
    const slot = (call: ContractCall, label: string): Slot => ({ index: calls.push(call) - 1, label });
    const needs: Need[] = requests.map((r) => {
      const s = r.source;
      if (s.type === 'erc20_supply') {
        const address = ctx.contract(s.token);
        return {
          kind: 'erc20',
          total: slot({ address, signature: ERC20_ABI.totalSupply, functionName: 'totalSupply' }, `totalSupply() on ${s.token}`),
          decimals: slot({ address, signature: ERC20_ABI.decimals, functionName: 'decimals' }, `decimals() on ${s.token}`),
          balances: s.subtract_balances.map((holder) =>
            slot({ address, signature: ERC20_ABI.balanceOf, functionName: 'balanceOf', args: [ctx.contract(holder)] }, `balanceOf(${holder}) on ${s.token}`),
          ),
        };
      }
      if (s.type === 'contract_read') {
        const call = { address: ctx.contract(s.contract), signature: `function ${s.function}() view returns (${s.abi_type})`, functionName: s.function };
        return { kind: 'read', call: slot(call, `${s.function}() on ${s.contract}`), decimals: s.decimals, scale: s.scale, offset: s.offset };
      }
      throw new Error(`chain_levels cannot serve a ${s.type} source`);
    });

    const results: CallResult[] = await ctx.rpc.multicall(calls, ctx.block.number);
    const observedAt = new Date(ctx.block.timestamp * 1000).toISOString();
    const detail = `block ${ctx.block.number}`;

    return needs.map((need): ReadingResult => {
      const slots = need.kind === 'erc20' ? [need.total, need.decimals, ...need.balances] : [need.call];
      const values: bigint[] = [];
      for (const s of slots) {
        const r = results[s.index];
        if (!r.ok) return failed(`${s.label}: ${r.error}`);
        values.push(r.value);
      }
      if (need.kind === 'read') return level(need.offset + need.scale * unitsToNumber(values[0], need.decimals), observedAt, 'onchain', detail);
      const [total, decimals, ...balances] = values;
      const net = balances.reduce((left, b) => left - b, total);
      return level(unitsToNumber(net, Number(decimals)), observedAt, 'onchain', detail);
    });
  },
};
```

In `src/ingest/sources/registry.ts`, replace:

```ts
import { adapterSource } from './adapter.js';
import { coingeckoSource } from './coingecko.js';
```

with:

```ts
import { adapterSource } from './adapter.js';
import { chainLevelsSource } from './chainLevels.js';
import { coingeckoSource } from './coingecko.js';
```

In `src/ingest/sources/registry.ts`, replace:

```ts
  defillama: defillamaSource,
  adapter: adapterSource,
};
```

with:

```ts
  defillama: defillamaSource,
  erc20_supply: chainLevelsSource,
  contract_read: chainLevelsSource,
  adapter: adapterSource,
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/ingest && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ingest/sources tests/ingest/sources.chain.test.ts
git commit -m "feat(ingest): erc20_supply and contract_read levels from one multicall at one block"
```

### Task 9: Cross-check comparisons (pure)

Spec 6.1. For a level metric, `abs(primary - check) / abs(primary) * 100 > tolerance_pct` is a mismatch (exactly at the tolerance is fine). For a monthly-sum comparison, only calendar months fully covered by BOTH series are compared, each month on its own. No I/O, no clock: the current month is passed in.

- A daily series covers a month when it has a point for EVERY day of that month.
- A monthly series (Venice's burn history) covers a month when the month is strictly before `currentMonth`: the running month is present in that API but incomplete.
- When the primary is `0`: the difference is `0` if the check is also `0`, otherwise it is reported as `100` percent.

**Files:**
- Create: `src/ingest/crosscheck.ts`, `tests/ingest/crosscheck.test.ts`

**Interfaces:**
- Consumes: `DailyPoint`, `MonthlyPoint`, `SourceValue` (Task 7); `monthOf`, `daysInMonth` (Task 7).
- Produces:

```ts
export function compareLevel(primary: number, check: number, tolerancePct: number): { diffPct: number; ok: boolean }
export function fullMonthSums(points: DailyPoint[]): Map<string, number>
export interface MonthComparison { month: string; primary: number; check: number; diffPct: number; ok: boolean }
export function compareMonthly(primary: DailyPoint[], check: Extract<SourceValue, { kind: 'daily_series' | 'monthly_series' }>, tolerancePct: number, currentMonth: string): MonthComparison[]
```

- [ ] **Step 1: Write the failing test**

Create `tests/ingest/crosscheck.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { compareLevel, compareMonthly, fullMonthSums } from '../../src/ingest/crosscheck.js';
import { addDays } from '../../src/ingest/time.js';
import type { DailyPoint } from '../../src/ingest/types.js';

/** `count` consecutive days starting at `first`, each with `value`. */
const days = (first: string, count: number, value: number): DailyPoint[] =>
  Array.from({ length: count }, (_, i) => ({ day: addDays(first, i), value }));

describe('compareLevel', () => {
  it('is fine exactly at the tolerance and a mismatch just beyond it', () => {
    expect(compareLevel(100, 102, 2)).toEqual({ diffPct: 2, ok: true });
    expect(compareLevel(100, 97.99, 2).ok).toBe(false);
    expect(compareLevel(100, 100, 0)).toEqual({ diffPct: 0, ok: true });
  });
  it('measures against the absolute primary value', () => {
    expect(compareLevel(-50, -55, 5).diffPct).toBeCloseTo(10, 12);
  });
  it('reports 100 percent when the primary is zero and the check is not', () => {
    expect(compareLevel(0, 0, 1)).toEqual({ diffPct: 0, ok: true });
    expect(compareLevel(0, 3, 1)).toEqual({ diffPct: 100, ok: false });
  });
});

describe('fullMonthSums', () => {
  it('sums only months in which every day is present', () => {
    const points = [...days('2026-06-21', 10, 1), ...days('2026-07-01', 31, 2), ...days('2026-08-01', 30, 3)]; // August lacks the 31st
    expect([...fullMonthSums(points)]).toEqual([['2026-07', 62]]);
  });
  it('counts a day once even if it appears twice', () => {
    const points = [...days('2026-02-01', 28, 1), { day: '2026-02-10', value: 1 }];
    expect(fullMonthSums(points).get('2026-02')).toBe(29); // summed, but the month still needs 28 distinct days
    expect(fullMonthSums([...days('2026-02-01', 27, 1), { day: '2026-02-10', value: 1 }]).size).toBe(0);
  });
});

describe('compareMonthly', () => {
  const primary = [...days('2026-06-21', 10, 100), ...days('2026-07-01', 31, 100), ...days('2026-08-01', 31, 100), ...days('2026-09-01', 18, 100)];

  it('compares only months fully covered by both daily series', () => {
    const check = { kind: 'daily_series' as const, detail: 'x', points: [...days('2026-07-01', 31, 103), ...days('2026-08-01', 31, 110), ...days('2026-09-01', 19, 100)] };
    const out = compareMonthly(primary, check, 5, '2026-09');
    expect(out.map((m) => m.month)).toEqual(['2026-07', '2026-08']);
    expect(out[0]).toMatchObject({ primary: 3100, check: 3193, ok: true });
    expect(out[0].diffPct).toBeCloseTo(3, 9);
    expect(out[1]).toMatchObject({ ok: false });
    expect(out[1].diffPct).toBeCloseTo(10, 9);
  });

  it('treats a monthly series as complete only for months before the current one', () => {
    const check = {
      kind: 'monthly_series' as const, detail: 'x',
      points: [{ month: '2026-06', value: 1 }, { month: '2026-07', value: 3100 }, { month: '2026-08', value: 3100.5 }, { month: '2026-09', value: 1800 }],
    };
    const out = compareMonthly(primary, check, 0.1, '2026-09');
    expect(out.map((m) => [m.month, m.ok])).toEqual([['2026-07', true], ['2026-08', true]]); // June is partial on-chain, September is running
  });

  it('returns nothing when no month is covered by both', () => {
    expect(compareMonthly(days('2026-09-01', 10, 1), { kind: 'daily_series', detail: 'x', points: days('2026-09-01', 10, 1) }, 5, '2026-09')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/ingest/crosscheck.test.ts`
Expected: FAIL (cannot find `src/ingest/crosscheck.js`).

- [ ] **Step 3: Implement**

Create `src/ingest/crosscheck.ts`:

```ts
import { daysInMonth, monthOf } from './time.js';
import type { DailyPoint, SourceValue } from './types.js';

/** Pure comparisons between a primary reading and a cross-check reading. No I/O, no clock. */
export function compareLevel(primary: number, check: number, tolerancePct: number): { diffPct: number; ok: boolean } {
  const diffPct = primary === 0 ? (check === 0 ? 0 : 100) : (Math.abs(primary - check) / Math.abs(primary)) * 100;
  return { diffPct, ok: diffPct <= tolerancePct };
}

/** Month -> sum, for the months in which every calendar day has a point. */
export function fullMonthSums(points: DailyPoint[]): Map<string, number> {
  const seen = new Map<string, Set<string>>();
  const sums = new Map<string, number>();
  for (const p of points) {
    const month = monthOf(p.day);
    const set = seen.get(month) ?? new Set<string>();
    set.add(p.day);
    seen.set(month, set);
    sums.set(month, (sums.get(month) ?? 0) + p.value);
  }
  const full = new Map<string, number>();
  for (const month of [...sums.keys()].sort()) {
    if (seen.get(month)!.size === daysInMonth(month)) full.set(month, sums.get(month)!);
  }
  return full;
}

export interface MonthComparison {
  month: string;
  primary: number;
  check: number;
  diffPct: number;
  ok: boolean;
}

/**
 * Compares calendar months fully covered by both series, each month on its own. A monthly check
 * series counts as complete for months strictly before `currentMonth`.
 */
export function compareMonthly(
  primary: DailyPoint[],
  check: Extract<SourceValue, { kind: 'daily_series' | 'monthly_series' }>,
  tolerancePct: number,
  currentMonth: string,
): MonthComparison[] {
  const ours = fullMonthSums(primary);
  const theirs =
    check.kind === 'daily_series'
      ? fullMonthSums(check.points)
      : new Map(check.points.filter((p) => p.month < currentMonth).map((p) => [p.month, p.value] as const));
  const out: MonthComparison[] = [];
  for (const [month, value] of ours) {
    const other = theirs.get(month);
    if (other === undefined) continue;
    out.push({ month, primary: value, check: other, ...compareLevel(value, other, tolerancePct) });
  }
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/ingest/crosscheck.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ingest/crosscheck.ts tests/ingest/crosscheck.test.ts
git commit -m "feat(ingest): pure cross-check comparisons for levels and monthly sums"
```

### Task 10: The fetch plan

`buildPlan` turns the asset YAML into work: per metric a primary source and its cross-checks, batched by `sourceId`. `transfer_flow` metrics are grouped by scan (same token, sink, and allowlist share ONE log scan). `derived` metrics are listed separately, to be computed after the fetch phase. Configuration errors surface here, as `OrionError`.

**Files:**
- Create: `src/ingest/plan.ts`, `tests/ingest/plan.test.ts`

**Interfaces:**
- Consumes: `sourceId`, `SourceRequest`, `narrow`, `contractResolver`, `getAdapter` (Task 7); `isChainSource` (Task 4); `sha256` (`src/util/canonical.ts`).
- Produces:

```ts
export interface SourceBatch { sourceId: string; requests: SourceRequest[] }
export interface FlowMember { metricKey: string; unit: 'usd' | 'tokens'; countFrom: string[]; priceCoingeckoId: string | null }   // countFrom: lowercased addresses
export interface FlowGroup { scanKey: string; sourceId: string; token: string; sink: string; allowlist: { name: string; address: string }[]; members: FlowMember[] }   // addresses lowercased
export interface FetchPlan { batches: SourceBatch[]; flowGroups: FlowGroup[]; derived: SourceRequest[]; needsRpc: boolean }
export function hasSources(asset: AssetConfig): boolean
export function buildPlan(asset: AssetConfig, opts?: { metrics?: string[] }): FetchPlan
```

  `scanKey` is the first 16 hex characters of `sha256("<token>|<sink>|<sorted allowlist addresses, comma separated>")`, all lowercased: it keys `fetch_cursors`. Errors: `unknown_metric`, `no_source` (a `--metric` that has no `source`), `unknown_adapter`, `invalid_source_config` (an RPC is needed but the asset has no `ingest` block).

- [ ] **Step 1: Write the failing test**

Create `tests/ingest/plan.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseAssetYaml } from '../../src/config/load.js';
import { registerAdapter } from '../../src/ingest/adapters/registry.js';
import { buildPlan, hasSources } from '../../src/ingest/plan.js';
import type { OrionError } from '../../src/types.js';
import { miniAsset } from '../helpers/assets.js';
import { INGEST_ASSET_YAML, ingestAsset, POOL, SAFE, SINK, TOKEN } from '../helpers/ingestAsset.js';

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (err) {
    return (err as OrionError).code;
  }
  return undefined;
};

describe('buildPlan', () => {
  const plan = buildPlan(ingestAsset().config);

  it('batches requests by source, primaries and cross-checks alike, in config order', () => {
    expect(plan.batches.map((b) => [b.sourceId, b.requests.map((r) => `${r.role}:${r.metricKey}`)])).toEqual([
      ['coingecko', ['primary:price_usd', 'primary:circulating_supply']],
      ['http_json:https://api.example.test/stats', ['cross_check:price_usd', 'cross_check:effective_supply']],
      ['chain_levels', ['primary:effective_supply', 'primary:staked_supply', 'primary:emission_rate_annual']],
      ['defillama:mini:dailyHoldersRevenue', ['cross_check:flow_usd.fees']],
    ]);
    expect(plan.needsRpc).toBe(true);
    expect(plan.derived).toEqual([]);
  });

  it('uses the cross-check tolerance, falling back to the metric tolerance', () => {
    const checks = plan.batches[1].requests;
    expect(checks[0].tolerancePct).toBe(2);
    expect(checks[1].tolerancePct).toBe(0.1); // effective_supply.tolerance_pct
  });

  it('groups transfer_flow metrics that share token, sink, and allowlist into one scan', () => {
    expect(plan.flowGroups).toHaveLength(1);
    const g = plan.flowGroups[0];
    expect(g.scanKey).toMatch(/^[0-9a-f]{16}$/);
    expect(g.sourceId).toBe('transfer_flow:token>burn_sink[pool,safe]');
    expect(g.token).toBe(TOKEN);
    expect(g.sink).toBe(SINK);
    expect(g.allowlist).toEqual([{ name: 'pool', address: POOL }, { name: 'safe', address: SAFE }]);
    expect(g.members).toEqual([
      { metricKey: 'flow_usd.fees', unit: 'usd', countFrom: [POOL, SAFE], priceCoingeckoId: 'mini-token' },
      { metricKey: 'flow_tokens.fees', unit: 'tokens', countFrom: [POOL, SAFE], priceCoingeckoId: null },
      { metricKey: 'flow_usd.fees_programmatic', unit: 'usd', countFrom: [POOL], priceCoingeckoId: 'mini-token' },
    ]);
  });

  it('starts a separate scan for a different allowlist, with a different cursor key', () => {
    const yaml = INGEST_ASSET_YAML.replace('from_allowlist: [pool, safe], unit: tokens }', 'from_allowlist: [pool], unit: tokens }');
    const groups = buildPlan(parseAssetYaml(yaml).config).flowGroups;
    expect(groups).toHaveLength(2);
    expect(groups[0].scanKey).not.toBe(groups[1].scanKey);
  });

  it('narrows to the requested metrics, cross-checks included', () => {
    const p = buildPlan(ingestAsset().config, { metrics: ['price_usd'] });
    expect(p.batches.map((b) => b.sourceId)).toEqual(['coingecko', 'http_json:https://api.example.test/stats']);
    expect(p.batches.flatMap((b) => b.requests).every((r) => r.metricKey === 'price_usd')).toBe(true);
    expect(p.flowGroups).toEqual([]);
    expect(p.needsRpc).toBe(false);
    expect(buildPlan(ingestAsset().config, { metrics: ['flow_tokens.fees'] }).flowGroups[0].members.map((m) => m.metricKey)).toEqual(['flow_tokens.fees']);
  });

  it('lists derived metrics apart and flags adapters that need the chain', () => {
    registerAdapter({ name: 'test.chain', needsRpc: true, run: async () => ({ kind: 'level', value: 1, observedAt: '', source: 'onchain', detail: '' }) });
    const yaml = INGEST_ASSET_YAML
      .replace('  staker_emission_share: { type: level, unit: ratio, staleness_days: 30 }',
        '  staker_emission_share: { type: level, unit: ratio, staleness_days: 30, source: { type: adapter, name: test.chain } }\n' +
        '  usage_index: { type: level, unit: usd_per_day, staleness_days: 7, source: { type: derived, name: burn_momentum, params: { metric: flow_usd.fees_programmatic, days: 30 } } }');
    const p = buildPlan(parseAssetYaml(yaml).config, { metrics: ['staker_emission_share', 'usage_index'] });
    expect(p.batches.map((b) => b.sourceId)).toEqual(['adapter:test.chain']);
    expect(p.derived.map((r) => r.metricKey)).toEqual(['usage_index']);
    expect(p.needsRpc).toBe(true);
  });

  it('rejects bad requests and bad configuration', () => {
    const asset = ingestAsset().config;
    expect(codeOf(() => buildPlan(asset, { metrics: ['nope'] }))).toBe('unknown_metric');
    expect(codeOf(() => buildPlan(asset, { metrics: ['revenue_run_rate_usd'] }))).toBe('no_source');
    const unknown = INGEST_ASSET_YAML.replace('  staker_emission_share: { type: level, unit: ratio, staleness_days: 30 }',
      '  staker_emission_share: { type: level, unit: ratio, staleness_days: 30, source: { type: adapter, name: never.registered } }');
    expect(codeOf(() => buildPlan(parseAssetYaml(unknown).config))).toBe('unknown_adapter');
  });

  it('needs an ingest block when only an adapter reads the chain', () => {
    registerAdapter({ name: 'test.chain', needsRpc: true, run: async () => ({ kind: 'level', value: 1, observedAt: '', source: 'onchain', detail: '' }) });
    const asset = miniAsset();
    asset.metrics.staker_emission_share.source = { type: 'adapter', name: 'test.chain', params: {} };
    expect(codeOf(() => buildPlan(asset))).toBe('invalid_source_config');
  });

  it('knows whether an asset has anything to fetch', () => {
    expect(hasSources(ingestAsset().config)).toBe(true);
    expect(hasSources(miniAsset())).toBe(false);
    expect(buildPlan(miniAsset())).toEqual({ batches: [], flowGroups: [], derived: [], needsRpc: false });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/ingest/plan.test.ts`
Expected: FAIL (cannot find `src/ingest/plan.js`).

- [ ] **Step 3: Implement**

Create `src/ingest/plan.ts`:

```ts
import type { AssetConfig } from '../config/schema.js';
import { isChainSource } from '../config/sources.js';
import { OrionError } from '../types.js';
import { sha256 } from '../util/canonical.js';
import { getAdapter } from './adapters/registry.js';
import { sourceId } from './sourceId.js';
import { contractResolver, type SourceRequest } from './types.js';

/** Requests that one source serves together. */
export interface SourceBatch {
  sourceId: string;
  requests: SourceRequest[];
}

/** One metric fed by a transfer scan. `countFrom` holds lowercased sender addresses. */
export interface FlowMember {
  metricKey: string;
  unit: 'usd' | 'tokens';
  countFrom: string[];
  priceCoingeckoId: string | null;
}

/** transfer_flow metrics that share a token, a sink, and an allowlist share one log scan and one cursor. Addresses are lowercased. */
export interface FlowGroup {
  scanKey: string;
  sourceId: string;
  token: string;
  sink: string;
  allowlist: { name: string; address: string }[];
  members: FlowMember[];
}

export interface FetchPlan {
  batches: SourceBatch[];
  flowGroups: FlowGroup[];
  /** Computed from stored observations after the fetch phase. */
  derived: SourceRequest[];
  needsRpc: boolean;
}

export function hasSources(asset: AssetConfig): boolean {
  return Object.values(asset.metrics).some((def) => def.source !== undefined);
}

export function buildPlan(asset: AssetConfig, opts: { metrics?: string[] } = {}): FetchPlan {
  const wanted = opts.metrics && opts.metrics.length > 0 ? new Set(opts.metrics) : null;
  for (const key of wanted ?? []) {
    const def = asset.metrics[key];
    if (!def) throw new OrionError('unknown_metric', `metric "${key}" is not defined in assets/${asset.id}.yaml`);
    if (!def.source) throw new OrionError('no_source', `metric "${key}" has no source; it is entered by hand`);
  }

  const contract = contractResolver(asset);
  const address = (name: string) => contract(name).toLowerCase();
  const batches = new Map<string, SourceBatch>();
  const groups = new Map<string, FlowGroup>();
  const derived: SourceRequest[] = [];
  let needsRpc = false;

  const enqueue = (request: SourceRequest) => {
    const s = request.source;
    if (isChainSource(s) || (s.type === 'adapter' && getAdapter(s.name).needsRpc)) needsRpc = true;
    const id = sourceId(s);
    const batch = batches.get(id) ?? { sourceId: id, requests: [] };
    batch.requests.push(request);
    batches.set(id, batch);
  };

  for (const [metricKey, def] of Object.entries(asset.metrics)) {
    const s = def.source;
    if (!s || (wanted && !wanted.has(metricKey))) continue;

    if (s.type === 'derived') {
      derived.push({ metricKey, role: 'primary', source: s, tolerancePct: def.tolerance_pct });
    } else if (s.type === 'transfer_flow') {
      needsRpc = true;
      const allowlist = [...s.from_allowlist].sort().map((name) => ({ name, address: address(name) }));
      const token = address(s.token);
      const sink = address(s.to);
      const scanKey = sha256(`${token}|${sink}|${allowlist.map((a) => a.address).sort().join(',')}`).slice(0, 16);
      const group = groups.get(scanKey) ?? { scanKey, sourceId: sourceId(s), token, sink, allowlist, members: [] };
      group.members.push({
        metricKey,
        unit: s.unit,
        countFrom: (s.count_from ?? s.from_allowlist).map(address),
        priceCoingeckoId: s.price_coingecko_id ?? null,
      });
      groups.set(scanKey, group);
    } else {
      enqueue({ metricKey, role: 'primary', source: s, tolerancePct: def.tolerance_pct });
    }

    for (const check of def.cross_checks ?? []) {
      enqueue({ metricKey, role: 'cross_check', source: check.source, tolerancePct: check.tolerance_pct ?? def.tolerance_pct });
    }
  }

  if (needsRpc && !asset.ingest) {
    throw new OrionError('invalid_source_config', `assets/${asset.id}.yaml reads from a chain but has no ingest block`);
  }
  return { batches: [...batches.values()], flowGroups: [...groups.values()], derived, needsRpc };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/ingest/plan.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ingest/plan.ts tests/ingest/plan.test.ts
git commit -m "feat(ingest): fetch plan that batches sources and groups transfer scans"
```

---

## Task group D: `fetchAsset`, flows, and anomalies

### Task 11: `fetchAsset` for level metrics: isolation, validation, cross-checks, the fetch log, dry run

`fetchAsset(db, loaded, now, deps, opts)` executes the plan. This task covers everything except transfer scans (Task 13) and derived metrics (Task 16); the code below leaves two marked places for them.

Order inside one run:
1. Build the plan. Open the RPC connection if the plan needs one and read the latest block ONCE: every chain level of the run is read at that block. If that read fails, every chain source fails with that message and the others carry on.
2. Fetch each batch, in plan order, one after another (no parallel requests: rate limits). A handler that throws fails every request of its batch. An `OrionError` is a configuration error and propagates.
3. Write primaries. A reading is refused (a source failure, never an observation) when it is not finite; when a `level` is not positive, or, for unit `ratio`, outside `[0, 1]`; when a `schedule` or `flow` value is negative. Everything is written through `insertObservation` with the reading's own `observedAt` and `fetchedAt = now`.
4. Level cross-checks: compare against the primary reading OF THIS RUN. A cross-check whose own reading fails the same validation is a source failure, not a mismatch. No primary reading this run means the check is skipped with a note. A mismatch raises `cross_check_mismatch`: `degrading` if the metric is `critical`, else `advisory`; `dedupe_key` is the cross-check's source id.
5. `source_failure_streak` (advisory, `metric_key ''`, `dedupe_key` = source id) when a source failed now and in its two previous attempted runs.
6. Outcome: `ok` when every source is ok; `failed` when every source failed; otherwise `partial`. One `fetch_runs` row.

`--dry-run` executes reads and cross-checks and reports what would be written; it writes NOTHING: no observations, no cursors, no anomalies, no `fetch_runs` row. In the result, would-be observations carry `observationId: null` and would-be anomalies `id: null`.

**Files:**
- Create: `src/ingest/run.ts`, `tests/helpers/fetchHarness.ts`, `tests/ingest/run.test.ts`
- Modify: `src/ingest/types.ts` (append result types)

**Interfaces:**
- Consumes: `buildPlan`, `hasSources` (Task 10); `getSourceHandler` (Task 7); `compareLevel` (Task 9); `raiseAnomaly` (Task 3); `insertFetchRun`, `recentSourceStatuses`, `emptySourceOutcome` (Task 2); `insertObservation`; `withRunCache` (Task 5); `RpcFactory` (Task 6).
- Produces (`src/ingest/types.ts`):

```ts
export interface WrittenObservation { metricKey: string; value: number; observedAt: string; periodDays: number | null; source: 'onchain' | 'api'; observationId: number | null }
export interface RaisedAnomaly { id: number | null; kind: AnomalyKind; metricKey: string; dedupeKey: string; severity: AnomalySeverity; detail: Record<string, unknown> }
```

- Produces (`src/ingest/run.ts`):

```ts
export const DEFAULT_RPC_URLS: Record<number, string>          // { 8453: 'https://mainnet.base.org' }
export interface FetchDeps { http: HttpTransport; rpcFactory: RpcFactory; env: Record<string, string | undefined>; sleep(ms: number): Promise<void>; now(): Date }
export interface FetchOptions { metrics?: string[]; backfillDays?: number; adopt?: boolean; dryRun?: boolean; onProgress?: (line: string) => void }
export interface FetchResult { assetId: string; dryRun: boolean; fetchRunId: number | null; outcome: FetchOutcome; startedAt: string; endedAt: string; sources: SourceOutcome[]; written: WrittenObservation[]; anomalies: RaisedAnomaly[] }
export function validateReading(def: MetricDef, value: number): string | null      // null when acceptable
export function fetchAsset(db: Db, loaded: LoadedAsset, now: Date, deps: FetchDeps, opts?: FetchOptions): Promise<FetchResult>
```

  Errors thrown (all `OrionError`): `no_sources`, `missing_rpc_url`, plus whatever `buildPlan` and the RPC factory throw.
- Produces (`tests/helpers/fetchHarness.ts`): `NOW`, `GENESIS_TS`, `LATEST`, `CG_MARKETS`, `CG_CHART`, `STATS`, `LLAMA`, `defaultRoutes()`, `defaultCalls()`, `hourlyPrices(fromIso, toIso, priceAt)`, and `harness(over?)` returning `{ db, loaded, deps, http, rpc }`. Every later ingest test builds on it.

- [ ] **Step 1: Write the harness and the failing test**

Create `tests/helpers/fetchHarness.ts`:

```ts
import type { LoadedAsset } from '../../src/config/load.js';
import { openDb, type Db } from '../../src/db/connection.js';
import type { FetchDeps } from '../../src/ingest/run.js';
import type { TransferLog } from '../../src/ingest/transport/rpc.js';
import { fakeHttp, type FakeHttp, type Route } from './fakeHttp.js';
import { callKey, fakeRpc, type FakeRpc } from './fakeRpc.js';
import { ingestAsset, SINK, STAKING, TOKEN } from './ingestAsset.js';

export const NOW = new Date('2026-09-19T12:00:00.000Z');
/** Block 0 is ten days before NOW, on an odd second like Base. Two-second blocks. */
export const GENESIS_TS = NOW.getTime() / 1000 - 10 * 86_400 + 1;
/** The newest block at NOW. */
export const LATEST = BigInt(Math.floor((NOW.getTime() / 1000 - GENESIS_TS) / 2));

export const CG_MARKETS = 'https://api.coingecko.com/api/v3/coins/markets';
export const CG_CHART = 'https://api.coingecko.com/api/v3/coins/mini-token/market_chart';
export const STATS = 'https://api.example.test/stats';
export const LLAMA = 'https://api.llama.fi/summary/fees/mini';

const E18 = 10n ** 18n;

/** One price point per hour from `fromIso` up to and including `toIso`. */
export function hourlyPrices(fromIso: string, toIso: string, priceAt: (ms: number) => number): { prices: [number, number][] } {
  const prices: [number, number][] = [];
  for (let t = Date.parse(fromIso); t <= Date.parse(toIso); t += 3_600_000) prices.push([t, priceAt(t)]);
  return { prices };
}

/** A healthy world: price 10 everywhere, 100 tokens of effective supply, 50 staked, no emissions. */
export function defaultRoutes(): Record<string, Route> {
  return {
    [CG_MARKETS]: [{ id: 'mini-token', current_price: 10, market_cap: 600, circulating_supply: 60 }],
    [CG_CHART]: hourlyPrices('2026-09-10T00:00:00Z', '2026-09-19T12:00:00Z', () => 10),
    [STATS]: { price: '10.1', supply: { totalBaseUnit: (100n * E18).toString() } },
    [LLAMA]: { totalDataChart: [] },
  };
}

export function defaultCalls(): Record<string, bigint | Error> {
  return {
    [callKey(TOKEN, 'totalSupply')]: 150n * E18,
    [callKey(TOKEN, 'decimals')]: 18n,
    [callKey(TOKEN, 'balanceOf', [SINK])]: 50n * E18,
    [callKey(STAKING, 'totalSupply')]: 50n * E18,
    [callKey(STAKING, 'emissionRatePerSecond')]: 0n,
  };
}

export interface Harness {
  db: Db;
  loaded: LoadedAsset;
  deps: FetchDeps;
  http: FakeHttp;
  rpc: FakeRpc;
}

export function harness(
  over: {
    db?: Db;
    loaded?: LoadedAsset;
    routes?: Record<string, Route>;
    calls?: Record<string, bigint | Error>;
    logs?: Omit<TransferLog, 'timestamp'>[];
    env?: Record<string, string | undefined>;
    now?: Date;
  } = {},
): Harness {
  const now = over.now ?? NOW;
  const http = fakeHttp({ ...defaultRoutes(), ...over.routes });
  const rpc = fakeRpc({
    genesisTs: GENESIS_TS,
    latest: BigInt(Math.floor((now.getTime() / 1000 - GENESIS_TS) / 2)),
    calls: { ...defaultCalls(), ...over.calls },
    logs: over.logs ?? [],
  });
  const deps: FetchDeps = {
    http,
    rpcFactory: () => rpc,
    env: over.env ?? { TEST_RPC_URL: 'http://rpc.test' },
    sleep: async () => undefined,
    now: () => new Date(now.getTime() + 5000),
  };
  return { db: over.db ?? openDb(':memory:'), loaded: over.loaded ?? ingestAsset(), deps, http, rpc };
}
```

Create `tests/ingest/run.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseAssetYaml } from '../../src/config/load.js';
import { listAnomalies } from '../../src/db/anomalies.js';
import type { Db } from '../../src/db/connection.js';
import { listFetchRuns } from '../../src/db/fetchRuns.js';
import { listActiveObservations } from '../../src/db/observations.js';
import { fetchAsset, validateReading, type FetchResult } from '../../src/ingest/run.js';
import type { OrionError } from '../../src/types.js';
import { MINI_ASSET_YAML } from '../helpers/assets.js';
import { CG_MARKETS, GENESIS_TS, harness, LATEST, NOW, STATS } from '../helpers/fetchHarness.js';
import { INGEST_ASSET_YAML } from '../helpers/ingestAsset.js';

const source = (r: FetchResult, id: string) => {
  const s = r.sources.find((x) => x.sourceId === id);
  if (!s) throw new Error(`no source outcome for ${id}; have ${r.sources.map((x) => x.sourceId).join(', ')}`);
  return s;
};
const count = (db: Db, table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const STATS_ID = `http_json:${STATS}`;

describe('validateReading', () => {
  const def = (type: 'level' | 'flow' | 'schedule', unit: string) => parseAssetYaml(INGEST_ASSET_YAML).config.metrics[type === 'level' ? (unit === 'ratio' ? 'staker_emission_share' : 'price_usd') : type === 'flow' ? 'flow_usd.fees' : 'emission_rate_annual'];
  it('refuses non-finite values, non-positive levels, ratios outside 0..1, and negative flows or schedules', () => {
    expect(validateReading(def('level', 'usd'), 10)).toBeNull();
    expect(validateReading(def('level', 'usd'), 0)).toMatch(/not positive/);
    expect(validateReading(def('level', 'usd'), NaN)).toMatch(/finite/);
    expect(validateReading(def('level', 'ratio'), 0)).toBeNull();
    expect(validateReading(def('level', 'ratio'), 1.2)).toMatch(/outside/);
    expect(validateReading(def('schedule', 'x'), 0)).toBeNull();
    expect(validateReading(def('flow', 'x'), -1)).toMatch(/negative/);
  });
});

describe('fetchAsset: levels', () => {
  it('writes every primary with the source own timestamp, and logs the run', async () => {
    const h = harness();
    const r = await fetchAsset(h.db, h.loaded, NOW, h.deps);

    const obs = Object.fromEntries(listActiveObservations(h.db, 'mini').map((o) => [o.metricKey, o]));
    expect(obs.price_usd).toMatchObject({ value: 10, source: 'api', observedAt: NOW.toISOString(), fetchedAt: NOW.toISOString(), status: 'confirmed' });
    expect(obs.circulating_supply.value).toBe(60);
    const blockTime = new Date((GENESIS_TS + Number(LATEST) * 2) * 1000).toISOString();
    expect(obs.effective_supply).toMatchObject({ value: 100, source: 'onchain', observedAt: blockTime, sourceDetail: `block ${LATEST}` });
    expect(obs.staked_supply.value).toBe(50);
    expect(obs.emission_rate_annual.value).toBe(0);
    expect(h.rpc.stats.multicall).toBeGreaterThanOrEqual(1);

    expect(source(r, 'coingecko')).toMatchObject({ status: 'ok', metricsWritten: ['price_usd', 'circulating_supply'] });
    expect(source(r, 'chain_levels').metricsWritten).toEqual(['effective_supply', 'staked_supply', 'emission_rate_annual']);
    expect(source(r, STATS_ID).crossChecks).toEqual([
      { metricKey: 'price_usd', sourceId: STATS_ID, label: 'level', primary: 10, check: 10.1, diffPct: expect.closeTo(1, 9), tolerancePct: 2, ok: true },
      { metricKey: 'effective_supply', sourceId: STATS_ID, label: 'level', primary: 100, check: 100, diffPct: 0, tolerancePct: 0.1, ok: true },
    ]);
    expect(r.anomalies).toEqual([]);
    expect(r.outcome).toBe('ok');
    expect(r.startedAt).toBe(NOW.toISOString());
    expect(r.endedAt).toBe(new Date(NOW.getTime() + 5000).toISOString());

    const [logged] = listFetchRuns(h.db, 'mini', 5);
    expect(logged.id).toBe(r.fetchRunId);
    expect(logged.outcome).toBe('ok');
    expect(logged.detail.sources).toEqual(r.sources);
  });

  it('never stores a cross-check reading as an observation', async () => {
    const h = harness();
    await fetchAsset(h.db, h.loaded, NOW, h.deps);
    expect(listActiveObservations(h.db, 'mini', 'price_usd').map((o) => o.value)).toEqual([10]);
  });

  it('raises a degrading anomaly for a mismatch on a critical metric, and counts repeats', async () => {
    const h = harness({ routes: { [STATS]: { price: 11, supply: { totalBaseUnit: (100n * 10n ** 18n).toString() } } } });
    const r = await fetchAsset(h.db, h.loaded, NOW, h.deps);
    expect(r.anomalies).toHaveLength(1);
    expect(r.anomalies[0]).toMatchObject({ kind: 'cross_check_mismatch', metricKey: 'price_usd', dedupeKey: STATS_ID, severity: 'degrading' });
    expect(r.anomalies[0].detail).toMatchObject({ primary: 10, check: 11, tolerance_pct: 2, primary_source: 'coingecko', check_source: STATS_ID });
    expect(listActiveObservations(h.db, 'mini', 'price_usd')[0].value).toBe(10); // the primary value is still stored

    await fetchAsset(h.db, h.loaded, new Date(NOW.getTime() + 86_400_000), h.deps);
    const [open] = listAnomalies(h.db, { assetId: 'mini' });
    expect(open.occurrences).toBe(2);
    expect(open.id).toBe(r.anomalies[0].id);
  });

  it('raises an advisory anomaly when the metric is not critical', async () => {
    const loaded = parseAssetYaml(INGEST_ASSET_YAML.replace('    staleness_days: 3\n    critical: true\n', '    staleness_days: 3\n'));
    const h = harness({ loaded, routes: { [STATS]: { price: 11, supply: { totalBaseUnit: (100n * 10n ** 18n).toString() } } } });
    expect((await fetchAsset(h.db, h.loaded, NOW, h.deps)).anomalies[0].severity).toBe('advisory');
  });

  it('lets one source fail without touching the others', async () => {
    const h = harness({ routes: { [CG_MARKETS]: new Error('HTTP 429') } });
    const r = await fetchAsset(h.db, h.loaded, NOW, h.deps);
    expect(source(r, 'coingecko')).toMatchObject({ status: 'failed', metricsWritten: [] });
    expect(source(r, 'coingecko').error).toMatch(/price_usd: HTTP 429/);
    expect(source(r, 'chain_levels').status).toBe('ok');
    expect(listActiveObservations(h.db, 'mini', 'price_usd')).toEqual([]);
    expect(listActiveObservations(h.db, 'mini', 'effective_supply')).toHaveLength(1);
    expect(source(r, STATS_ID).notes).toContain('price_usd: cross-check skipped, the primary source gave no reading this run');
    expect(r.outcome).toBe('partial');
    expect(r.anomalies).toEqual([]);
  });

  it('treats an implausible reading as a source failure, never as an observation', async () => {
    const h = harness({ routes: { [CG_MARKETS]: [{ id: 'mini-token', current_price: 0, circulating_supply: 60 }] } });
    const r = await fetchAsset(h.db, h.loaded, NOW, h.deps);
    expect(source(r, 'coingecko')).toMatchObject({ status: 'failed', metricsWritten: ['circulating_supply'] });
    expect(source(r, 'coingecko').error).toMatch(/price_usd: 0 is not positive/);
    expect(listActiveObservations(h.db, 'mini', 'price_usd')).toEqual([]);
  });

  it('treats an implausible cross-check reading as a source failure, not as a mismatch', async () => {
    const h = harness({ routes: { [STATS]: { price: '0', supply: { totalBaseUnit: (100n * 10n ** 18n).toString() } } } });
    const r = await fetchAsset(h.db, h.loaded, NOW, h.deps);
    expect(source(r, STATS_ID).status).toBe('failed');
    expect(source(r, STATS_ID).error).toMatch(/price_usd: 0 is not positive/);
    expect(r.anomalies).toEqual([]);
  });

  it('fails every chain source, and only those, when the latest block cannot be read', async () => {
    const h = harness();
    h.rpc.latestBlock = async () => {
      throw new Error('connection refused');
    };
    const r = await fetchAsset(h.db, h.loaded, NOW, h.deps);
    expect(source(r, 'chain_levels').error).toMatch(/could not read the latest block: connection refused/);
    expect(source(r, 'coingecko').status).toBe('ok');
  });

  it('raises an advisory streak anomaly on the third consecutive failure of one source', async () => {
    const h = harness({ routes: { [CG_MARKETS]: new Error('HTTP 429') } });
    for (const day of [0, 1]) expect((await fetchAsset(h.db, h.loaded, new Date(NOW.getTime() + day * 86_400_000), h.deps)).anomalies).toEqual([]);
    const third = await fetchAsset(h.db, h.loaded, new Date(NOW.getTime() + 2 * 86_400_000), h.deps);
    expect(third.anomalies).toHaveLength(1);
    expect(third.anomalies[0]).toMatchObject({ kind: 'source_failure_streak', metricKey: '', dedupeKey: 'coingecko', severity: 'advisory' });
  });

  it('narrows to the requested metrics', async () => {
    const h = harness();
    const r = await fetchAsset(h.db, h.loaded, NOW, h.deps, { metrics: ['price_usd'] });
    expect(r.sources.map((s) => s.sourceId)).toEqual(['coingecko', STATS_ID]);
    expect(r.written.map((w) => w.metricKey)).toEqual(['price_usd']);
  });

  it('writes nothing at all on a dry run, and still reports what it would do', async () => {
    const h = harness({ routes: { [STATS]: { price: 11, supply: { totalBaseUnit: (100n * 10n ** 18n).toString() } } } });
    const r = await fetchAsset(h.db, h.loaded, NOW, h.deps, { dryRun: true });
    for (const table of ['observations', 'fetch_runs', 'anomalies', 'fetch_cursors']) expect(count(h.db, table)).toBe(0);
    expect(r.dryRun).toBe(true);
    expect(r.fetchRunId).toBeNull();
    expect(r.written.find((w) => w.metricKey === 'price_usd')).toMatchObject({ value: 10, observationId: null });
    expect(r.anomalies[0]).toMatchObject({ id: null, kind: 'cross_check_mismatch' });
  });

  it('throws only for configuration errors', async () => {
    const codeOf = async (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => (e as OrionError).code);
    const plain = harness({ loaded: parseAssetYaml(MINI_ASSET_YAML) });
    expect(await codeOf(fetchAsset(plain.db, plain.loaded, NOW, plain.deps))).toBe('no_sources');
    const otherChain = harness({ loaded: parseAssetYaml(INGEST_ASSET_YAML.replace('chain_id: 8453', 'chain_id: 1')), env: {} });
    expect(await codeOf(fetchAsset(otherChain.db, otherChain.loaded, NOW, otherChain.deps))).toBe('missing_rpc_url');
    const fallback = harness({ env: {} }); // Base has a default public RPC URL
    expect((await fetchAsset(fallback.db, fallback.loaded, NOW, fallback.deps)).outcome).toBe('ok');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/ingest/run.test.ts`
Expected: FAIL (cannot find `src/ingest/run.js`).

- [ ] **Step 3: Implement**

Append to `src/ingest/types.ts`:

```ts

/** An observation a fetch wrote, or (on a dry run, observationId null) would have written. */
export interface WrittenObservation {
  metricKey: string;
  value: number;
  observedAt: string;
  periodDays: number | null;
  source: 'onchain' | 'api';
  observationId: number | null;
}

/** An anomaly a fetch raised, or (on a dry run, id null) would have raised. */
export interface RaisedAnomaly {
  id: number | null;
  kind: import('../db/anomalies.js').AnomalyKind;
  metricKey: string;
  dedupeKey: string;
  severity: import('../db/anomalies.js').AnomalySeverity;
  detail: Record<string, unknown>;
}
```

Create `src/ingest/run.ts`:

```ts
import type { LoadedAsset } from '../config/load.js';
import type { MetricDef } from '../config/schema.js';
import { isChainSource } from '../config/sources.js';
import { raiseAnomaly } from '../db/anomalies.js';
import type { Db } from '../db/connection.js';
import { emptySourceOutcome, insertFetchRun, recentSourceStatuses, type FetchOutcome, type SourceOutcome } from '../db/fetchRuns.js';
import { insertObservation } from '../db/observations.js';
import { OrionError } from '../types.js';
import { getAdapter } from './adapters/registry.js';
import { compareLevel } from './crosscheck.js';
import { buildPlan, hasSources, type SourceBatch } from './plan.js';
import { sourceId } from './sourceId.js';
import { getSourceHandler } from './sources/registry.js';
import { withRunCache, type HttpTransport } from './transport/http.js';
import type { BlockRef, RpcFactory, RpcTransport } from './transport/rpc.js';
import {
  contractResolver, failed, type RaisedAnomaly, type ReadingResult, type SourceContext, type SourceRequest, type WrittenObservation,
} from './types.js';

/** Used when the asset's rpc_url_env variable is not set. */
export const DEFAULT_RPC_URLS: Record<number, string> = { 8453: 'https://mainnet.base.org' };

export interface FetchDeps {
  http: HttpTransport;
  rpcFactory: RpcFactory;
  env: Record<string, string | undefined>;
  sleep(ms: number): Promise<void>;
  now(): Date;
}

export interface FetchOptions {
  metrics?: string[];
  /** Scan this many days back, ignoring the cursor. Default: resume from the cursor, or the asset's backfill_days on a first run. */
  backfillDays?: number;
  adopt?: boolean;
  dryRun?: boolean;
  onProgress?: (line: string) => void;
}

export interface FetchResult {
  assetId: string;
  dryRun: boolean;
  fetchRunId: number | null;
  outcome: FetchOutcome;
  startedAt: string;
  endedAt: string;
  sources: SourceOutcome[];
  written: WrittenObservation[];
  anomalies: RaisedAnomaly[];
}

/**
 * Null when a fetched value may be stored. A reading that is not finite, or a supply or price that
 * is not positive, is a source failure, never an observation.
 */
export function validateReading(def: MetricDef, value: number): string | null {
  if (!Number.isFinite(value)) return `${value} is not a finite number`;
  if (def.type === 'level') {
    if (def.unit === 'ratio') return value >= 0 && value <= 1 ? null : `ratio ${value} is outside [0, 1]`;
    return value > 0 ? null : `${value} is not positive`;
  }
  return value >= 0 ? null : `${value} is negative`;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function markFailed(outcome: SourceOutcome, text: string): void {
  outcome.status = 'failed';
  outcome.error = outcome.error === null ? text : `${outcome.error}; ${text}`;
}

function readsChain(batch: SourceBatch): boolean {
  return batch.requests.some((r) => isChainSource(r.source) || (r.source.type === 'adapter' && getAdapter(r.source.name).needsRpc));
}

export async function fetchAsset(db: Db, loaded: LoadedAsset, now: Date, deps: FetchDeps, opts: FetchOptions = {}): Promise<FetchResult> {
  const asset = loaded.config;
  if (!hasSources(asset)) throw new OrionError('no_sources', `assets/${asset.id}.yaml defines no metric source; there is nothing to fetch`);
  const plan = buildPlan(asset, { metrics: opts.metrics });
  const startedAt = now.toISOString();
  const dryRun = opts.dryRun ?? false;

  let rpc: RpcTransport | null = null;
  let block: BlockRef | null = null;
  let chainError: string | null = null;
  if (plan.needsRpc) {
    const ingest = asset.ingest!; // buildPlan guarantees it
    const url = deps.env[ingest.rpc_url_env] ?? DEFAULT_RPC_URLS[ingest.chain_id];
    if (!url) throw new OrionError('missing_rpc_url', `set ${ingest.rpc_url_env}: there is no default RPC URL for chain ${ingest.chain_id}`);
    rpc = deps.rpcFactory(url, ingest.chain_id);
    try {
      block = await rpc.latestBlock();
    } catch (err) {
      chainError = `could not read the latest block: ${message(err)}`;
    }
  }

  const ctx: SourceContext = {
    asset, nowIso: startedAt, http: withRunCache(deps.http), rpc, block, env: deps.env, contract: contractResolver(asset),
  };

  const outcomes = new Map<string, SourceOutcome>();
  const outcomeOf = (id: string): SourceOutcome => {
    let o = outcomes.get(id);
    if (!o) {
      o = emptySourceOutcome(id);
      outcomes.set(id, o);
    }
    return o;
  };
  const written: WrittenObservation[] = [];
  const anomalies: RaisedAnomaly[] = [];
  const raise = (a: Omit<RaisedAnomaly, 'id'>): void => {
    const id = dryRun ? null : raiseAnomaly(db, { assetId: asset.id, ...a, seenAt: startedAt }).id;
    anomalies.push({ id, ...a });
  };

  // 1. Fetch phase: one batch at a time. A thrown handler fails its whole batch and nothing else.
  const readings = new Map<SourceRequest, ReadingResult>();
  for (const batch of plan.batches) {
    outcomeOf(batch.sourceId);
    let results: ReadingResult[];
    if (chainError !== null && readsChain(batch)) {
      results = batch.requests.map(() => failed(chainError));
    } else {
      try {
        results = await getSourceHandler(batch.requests[0].source.type).fetch(batch.requests, ctx);
      } catch (err) {
        if (err instanceof OrionError) throw err; // configuration error
        results = batch.requests.map(() => failed(message(err)));
      }
    }
    batch.requests.forEach((r, i) => readings.set(r, results[i] ?? failed('the source returned no result for this request')));
  }

  // 2. Primaries: validate, then write through insertObservation with the source's own timestamp.
  const primaryValue = new Map<string, number>();
  for (const batch of plan.batches) {
    for (const r of batch.requests) {
      if (r.role !== 'primary') continue;
      const outcome = outcomeOf(batch.sourceId);
      const result = readings.get(r)!;
      if (!result.ok) {
        markFailed(outcome, `${r.metricKey}: ${result.error}`);
        continue;
      }
      if (result.value.kind !== 'level') {
        markFailed(outcome, `${r.metricKey}: a ${result.value.kind} cannot be stored as an observation`);
        continue;
      }
      const v = result.value;
      const refusal = validateReading(asset.metrics[r.metricKey], v.value);
      if (refusal !== null) {
        markFailed(outcome, `${r.metricKey}: ${refusal}`);
        continue;
      }
      const observationId = dryRun
        ? null
        : insertObservation(db, {
            assetId: asset.id, metricKey: r.metricKey, observedAt: v.observedAt, value: v.value, source: v.source,
            sourceDetail: v.detail, fetchedAt: startedAt,
          }).id;
      outcome.metricsWritten.push(r.metricKey);
      written.push({ metricKey: r.metricKey, value: v.value, observedAt: v.observedAt, periodDays: null, source: v.source, observationId });
      primaryValue.set(r.metricKey, v.value);
    }
  }

  // 3. Level cross-checks, against the primary reading of this run. Never stored as observations.
  for (const batch of plan.batches) {
    for (const r of batch.requests) {
      const def = asset.metrics[r.metricKey];
      if (r.role !== 'cross_check' || def.type === 'flow') continue;
      const outcome = outcomeOf(batch.sourceId);
      const result = readings.get(r)!;
      if (!result.ok) {
        markFailed(outcome, `${r.metricKey}: ${result.error}`);
        continue;
      }
      if (result.value.kind !== 'level') {
        markFailed(outcome, `${r.metricKey}: expected a level reading, got a ${result.value.kind}`);
        continue;
      }
      const check = result.value.value;
      const refusal = validateReading(def, check);
      if (refusal !== null) {
        markFailed(outcome, `${r.metricKey}: ${refusal}`);
        continue;
      }
      const primary = primaryValue.get(r.metricKey);
      if (primary === undefined) {
        outcome.notes.push(`${r.metricKey}: cross-check skipped, the primary source gave no reading this run`);
        continue;
      }
      const cmp = compareLevel(primary, check, r.tolerancePct);
      outcome.crossChecks.push({
        metricKey: r.metricKey, sourceId: batch.sourceId, label: 'level', primary, check, diffPct: cmp.diffPct, tolerancePct: r.tolerancePct, ok: cmp.ok,
      });
      if (!cmp.ok) {
        raise({
          kind: 'cross_check_mismatch', metricKey: r.metricKey, dedupeKey: batch.sourceId, severity: def.critical ? 'degrading' : 'advisory',
          detail: {
            primary, check, diff_pct: cmp.diffPct, tolerance_pct: r.tolerancePct,
            primary_source: sourceId(def.source!), check_source: batch.sourceId,
          },
        });
      }
    }
  }

  // [Task 13 inserts the transfer scans and the monthly cross-checks here]

  // [Task 16 inserts the derived metrics and the stale-revenue alert here]

  // Failure streaks: this run plus the two previous attempts of the same source.
  for (const outcome of outcomes.values()) {
    if (outcome.status !== 'failed') continue;
    const previous = recentSourceStatuses(db, asset.id, outcome.sourceId, 2);
    if (previous.length === 2 && previous.every((s) => s === 'failed')) {
      raise({
        kind: 'source_failure_streak', metricKey: '', dedupeKey: outcome.sourceId, severity: 'advisory',
        detail: { source: outcome.sourceId, error: outcome.error, consecutive_failures_at_least: 3 },
      });
    }
  }

  const sources = [...outcomes.values()];
  const outcome: FetchOutcome = sources.every((s) => s.status === 'ok') ? 'ok' : sources.every((s) => s.status === 'failed') ? 'failed' : 'partial';
  const endedAt = deps.now().toISOString();
  const fetchRunId = dryRun ? null : insertFetchRun(db, { assetId: asset.id, startedAt, endedAt, outcome, detail: { sources } });
  return { assetId: asset.id, dryRun, fetchRunId, outcome, startedAt, endedAt, sources, written, anomalies };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/ingest/run.test.ts && npm run typecheck`
Expected: PASS. (The ingest asset's `transfer_flow` metrics and its `defillama` cross-check are fetched or ignored here without effect; Task 13 brings them in.)

- [ ] **Step 5: Commit**

```bash
git add src/ingest/run.ts src/ingest/types.ts tests/ingest/run.test.ts tests/helpers/fetchHarness.ts
git commit -m "feat(ingest): fetchAsset for level metrics with source isolation, cross-check anomalies, and dry run"
```

### Task 12: `transfer_flow`: the resumable transfer scan

Spec section 5, as one function, `scanFlowGroup`. It scans one `FlowGroup` (Task 10) and writes one row per member metric per COMPLETED UTC day.

1. **Range.** The last complete day is the day before the most recent UTC midnight at or before the latest block's time. The first day is the day after the cursor's `lastDay`; with no cursor, or with `rescan: true`, it is the UTC day of `now - backfillDays` (that whole day is scanned). Nothing to do is not an error.
2. **Conflicts first (5.1).** For every member metric, find ACTIVE rows whose `source` is not `onchain` and whose period overlaps the range. If there are any and `adopt` is false, or any of them is not `manual`: the WHOLE group is skipped (`status: 'skipped'`), nothing is written for any member, and the cursor does not move, so a later `--adopt` run covers the same days. (The spec words this per metric; doing it per scan group is deliberately stricter, because the cursor is shared: writing some members and advancing the cursor would silently leave a permanent gap in the refused one.) With `adopt`, each conflicting `manual` row is rejected in the SAME transaction as the first fetched day it overlaps.
3. **Day boundaries.** `firstBlockAtOrAfter` finds the first block of each day; a day is complete when the scan covered every block up to the one before the next day's first block. Logs are fetched with `getLogsChunked`.
4. **Classify.** A sender on the allowlist counts (for each member whose `countFrom` includes it). Any other sender is an unlisted transfer: excluded from every sum and reported.
5. **Value.** `unit: tokens`: the token amount. `unit: usd`: tokens times the newest price point at or before the transfer's own block time. Prices come from `market_chart?vs_currency=usd&days=90` (hourly). Only when the range starts before the first hourly point is a second call made (`days = max(91, days back + 1)`, daily points), and a transfer older than the hourly series uses the newest daily point at or before it. Prices are never interpolated. No price point at or before a transfer fails that day: it is not written, and the scan stops there.
6. **Write.** Per day, in ONE transaction: adoptions, one row per member (`observed_at` = the following UTC midnight, `period_days: 1`, `source: onchain`, `source_detail` = JSON with the day, the block range, and count and token total per sender), and the cursor advance. A day with no transfers is written as `0`: the scan covered it. Re-scanning a day writes rows with the same `observed_at`, which supersede the old ones.
7. **Failure.** A chunk that still fails after its retries, or a missing price, stops the scan with `status: 'failed'`; days already committed stay, and the next run resumes after them.

Known limitation, accepted: between an interrupted `--adopt` backfill and its resumption, a rejected manual row may cover days that are not fetched yet, so the flow can read low until the scan completes. The fetch outcome says `failed` in that case.

**Files:**
- Create: `src/ingest/flow.ts`, `tests/ingest/flow.test.ts`

**Interfaces:**
- Consumes: `FlowGroup` (Task 10); `getLogsChunked`, `firstBlockAtOrAfter`, `RpcTransport`, `BlockRef` (Task 6); `HttpTransport` (Task 5); `COINGECKO_API`, `coingeckoHeaders` (Task 7); `ERC20_ABI` (Task 8); `getCursor`, `advanceCursor` (Task 2); `insertObservation`, `rejectObservation`, `listActiveObservations`; `SourceOutcome`, `UnlistedTransfer`, `FlowConflict` (Task 2); `WrittenObservation`, `DailyPoint` (Tasks 7 and 11).
- Produces:

```ts
export interface PricePoint { ts: number; price: number }                 // ts in ms
export interface PriceSeries { hourly: PricePoint[]; daily: PricePoint[] }
export function parseMarketChart(body: unknown, what: string): PricePoint[]
export function priceAt(series: PriceSeries, tsMs: number): number | null
export function findFlowConflicts(db: Db, assetId: string, metricKey: string, startMs: number, endMs: number): FlowConflict[]
export interface FlowScanArgs { db: Db; asset: AssetConfig; group: FlowGroup; rpc: RpcTransport; latest: BlockRef; http: HttpTransport; env: Record<string, string | undefined>; sleep(ms: number): Promise<void>; now: Date; backfillDays: number; rescan: boolean; adopt: boolean; dryRun: boolean; onProgress?: (line: string) => void }
export interface FlowScanResult { outcome: SourceOutcome; written: WrittenObservation[]; unlisted: UnlistedTransfer[]; daily: Map<string, DailyPoint[]> }
export function scanFlowGroup(args: FlowScanArgs): Promise<FlowScanResult>
```

  `scanFlowGroup` never throws for a source failure (it reports it in `outcome`); an `OrionError` propagates. `outcome.unlistedTransfers` holds at most the first 50; `unlisted` holds all of them. `daily` maps each member metric to the day values of this scan (also on a dry run).

- [ ] **Step 1: Write the failing test**

Create `tests/ingest/flow.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/connection.js';
import { getCursor } from '../../src/db/fetchCursors.js';
import { getObservationsByIds, insertObservation, listActiveObservations } from '../../src/db/observations.js';
import { findFlowConflicts, parseMarketChart, priceAt, scanFlowGroup, type FlowScanArgs } from '../../src/ingest/flow.js';
import { buildPlan } from '../../src/ingest/plan.js';
import type { RpcTransport, TransferLog } from '../../src/ingest/transport/rpc.js';
import { CG_CHART, harness, hourlyPrices, NOW, type Harness } from '../helpers/fetchHarness.js';
import { POOL, SAFE } from '../helpers/ingestAsset.js';

const STRANGER = '0x9999999999999999999999999999999999999999';
const E18 = 10n ** 18n;
const ms = (iso: string) => Date.parse(iso);

/** Price 10 until 2026-09-17T00:00Z, 20 from then on. */
const stepPrices = () => hourlyPrices('2026-09-10T00:00:00Z', '2026-09-19T12:00:00Z', (t) => (t < ms('2026-09-17T00:00:00Z') ? 10 : 20));

function world(over: Parameters<typeof harness>[0] = {}): Harness & { logs: Omit<TransferLog, 'timestamp'>[] } {
  const probe = harness();
  const at = (iso: string) => probe.rpc.blockAtOrAfter(ms(iso) / 1000);
  let n = 0;
  const log = (iso: string, from: string, tokens: bigint): Omit<TransferLog, 'timestamp'> => ({
    blockNumber: at(iso), logIndex: n++, txHash: `0xtx${n}`, from, value: tokens * E18,
  });
  const logs = [
    log('2026-09-16T10:00:00Z', POOL, 2n),
    log('2026-09-16T23:59:58Z', SAFE.toUpperCase().replace('0X', '0x'), 100n), // last block of the 16th; mixed-case sender
    log('2026-09-17T00:00:00Z', POOL, 3n), // first block of the 17th (its timestamp is 00:00:01)
    log('2026-09-17T12:00:00Z', STRANGER, 5n),
    log('2026-09-19T01:00:00Z', POOL, 7n), // the 19th is not complete at NOW
  ];
  return { ...harness({ routes: { [CG_CHART]: stepPrices() }, logs, ...over }), logs };
}

function argsFor(h: Harness, over: Partial<FlowScanArgs> = {}): Promise<FlowScanArgs> {
  return h.rpc.latestBlock().then((latest) => ({
    db: h.db, asset: h.loaded.config, group: buildPlan(h.loaded.config).flowGroups[0], rpc: h.rpc, latest, http: h.http, env: {},
    sleep: async () => undefined, now: h.deps.now(), backfillDays: 3, rescan: false, adopt: false, dryRun: false, ...over,
  }));
}

const rows = (db: Db, metric: string) => listActiveObservations(db, 'mini', metric).map((o) => [o.observedAt.slice(0, 10), o.value]);

describe('price series', () => {
  it('parses market_chart prices and refuses malformed or non-positive points', () => {
    expect(parseMarketChart({ prices: [[2000, 5], [1000, 4]] }, 'x')).toEqual([{ ts: 1000, price: 4 }, { ts: 2000, price: 5 }]);
    expect(() => parseMarketChart({}, 'x')).toThrow(/x: no prices/);
    expect(() => parseMarketChart({ prices: [[1000, 0]] }, 'x')).toThrow(/malformed/);
  });
  it('uses the newest hourly point at or before the time, then the newest daily point, and never interpolates', () => {
    const series = { hourly: [{ ts: 1000, price: 10 }, { ts: 2000, price: 20 }], daily: [{ ts: 100, price: 1 }, { ts: 500, price: 5 }] };
    expect(priceAt(series, 1999)).toBe(10);
    expect(priceAt(series, 2000)).toBe(20);
    expect(priceAt(series, 999)).toBe(5);
    expect(priceAt(series, 100)).toBe(1);
    expect(priceAt(series, 99)).toBeNull();
  });
});

describe('scanFlowGroup', () => {
  it('writes one row per metric per completed UTC day, valued at the hour of each transfer', async () => {
    const h = world();
    const r = await scanFlowGroup(await argsFor(h));
    expect(r.outcome).toMatchObject({ status: 'ok', error: null, metricsWritten: ['flow_usd.fees', 'flow_tokens.fees', 'flow_usd.fees_programmatic'] });
    // 16th: 2 + 100 tokens at 10 USD. 17th: 3 tokens at 20 USD (the stranger's 5 are excluded). 18th: nothing, written as 0.
    expect(rows(h.db, 'flow_usd.fees')).toEqual([['2026-09-17', 1020], ['2026-09-18', 60], ['2026-09-19', 0]]);
    expect(rows(h.db, 'flow_tokens.fees')).toEqual([['2026-09-17', 102], ['2026-09-18', 3], ['2026-09-19', 0]]);
    expect(rows(h.db, 'flow_usd.fees_programmatic')).toEqual([['2026-09-17', 20], ['2026-09-18', 60], ['2026-09-19', 0]]); // pool only

    const first = listActiveObservations(h.db, 'mini', 'flow_usd.fees')[0];
    expect(first).toMatchObject({ observedAt: '2026-09-17T00:00:00.000Z', periodDays: 1, source: 'onchain', status: 'confirmed' });
    const detail = JSON.parse(first.sourceDetail!) as { day: string; blocks: number[]; senders: Record<string, { count: number; tokens: number }> };
    expect(detail.day).toBe('2026-09-16');
    expect(detail.senders).toEqual({ pool: { count: 1, tokens: 2 }, safe: { count: 1, tokens: 100 } });
    expect(detail.blocks[1] - detail.blocks[0] + 1).toBe(43_200);
    expect(r.written).toHaveLength(9);
    expect(r.daily.get('flow_tokens.fees')).toEqual([{ day: '2026-09-16', value: 102 }, { day: '2026-09-17', value: 3 }, { day: '2026-09-18', value: 0 }]);
  });

  it('reports unlisted senders and keeps them out of every sum', async () => {
    const h = world();
    const r = await scanFlowGroup(await argsFor(h));
    expect(r.unlisted).toEqual([{ txHash: '0xtx4', logIndex: 3, blockNumber: Number(h.logs[3].blockNumber), from: STRANGER, tokens: 5, day: '2026-09-17' }]);
    expect(r.outcome.unlistedTransfers).toEqual(r.unlisted);
  });

  it('asks for at most 2000 blocks per call and covers the range without gaps', async () => {
    const h = world();
    await scanFlowGroup(await argsFor(h));
    const ranges = h.rpc.stats.logRanges;
    expect(ranges.every(([from, to]) => to - from + 1n <= 2000n)).toBe(true);
    expect(ranges[0][0]).toBe(h.rpc.blockAtOrAfter(ms('2026-09-16T00:00:00Z') / 1000));
    expect(ranges.at(-1)![1]).toBe(h.rpc.blockAtOrAfter(ms('2026-09-19T00:00:00Z') / 1000) - 1n);
    for (let i = 1; i < ranges.length; i++) expect(ranges[i][0]).toBe(ranges[i - 1][1] + 1n);
  });

  it('advances the cursor to the last block of the last complete day, and resumes from it', async () => {
    const h = world();
    const group = buildPlan(h.loaded.config).flowGroups[0];
    await scanFlowGroup(await argsFor(h));
    expect(getCursor(h.db, 'mini', group.scanKey)).toEqual({
      lastDay: '2026-09-18', lastBlock: Number(h.rpc.blockAtOrAfter(ms('2026-09-19T00:00:00Z') / 1000)) - 1,
    });

    const calls = h.rpc.stats.logRanges.length;
    const again = await scanFlowGroup(await argsFor(h));
    expect(again.outcome.status).toBe('ok');
    expect(again.outcome.notes[0]).toMatch(/no completed day/);
    expect(h.rpc.stats.logRanges.length).toBe(calls);

    const nextDay = world({ db: h.db, now: new Date(NOW.getTime() + 86_400_000) });
    const r = await scanFlowGroup(await argsFor(nextDay));
    expect(r.written.map((w) => [w.metricKey, w.observedAt.slice(0, 10), w.value])).toEqual([
      ['flow_usd.fees', '2026-09-20', 140], ['flow_tokens.fees', '2026-09-20', 7], ['flow_usd.fees_programmatic', '2026-09-20', 140],
    ]);
  });

  it('keeps committed days when a chunk keeps failing, and resumes after them', async () => {
    const h = world();
    const secondDay = h.rpc.blockAtOrAfter(ms('2026-09-17T00:00:00Z') / 1000);
    const flaky: RpcTransport = { ...h.rpc, getTransferLogs: async (q) => (q.fromBlock >= secondDay ? Promise.reject(new Error('rate limited')) : h.rpc.getTransferLogs(q)) };
    const broken = await scanFlowGroup(await argsFor(h, { rpc: flaky }));
    expect(broken.outcome.status).toBe('failed');
    expect(broken.outcome.error).toMatch(/eth_getLogs failed.*rate limited/);
    expect(rows(h.db, 'flow_tokens.fees')).toEqual([['2026-09-17', 102]]);
    expect(getCursor(h.db, 'mini', buildPlan(h.loaded.config).flowGroups[0].scanKey)!.lastDay).toBe('2026-09-16');

    const resumed = await scanFlowGroup(await argsFor(h));
    expect(resumed.written.map((w) => w.observedAt.slice(0, 10))).not.toContain('2026-09-17');
    expect(rows(h.db, 'flow_tokens.fees')).toEqual([['2026-09-17', 102], ['2026-09-18', 3], ['2026-09-19', 0]]);
  });

  it('is idempotent: a forced re-scan supersedes the same days', async () => {
    const h = world();
    await scanFlowGroup(await argsFor(h));
    const before = listActiveObservations(h.db, 'mini', 'flow_usd.fees').map((o) => o.id);
    await scanFlowGroup(await argsFor(h, { rescan: true }));
    expect(rows(h.db, 'flow_usd.fees')).toEqual([['2026-09-17', 1020], ['2026-09-18', 60], ['2026-09-19', 0]]);
    expect(getObservationsByIds(h.db, before).every((o) => o.supersededBy !== null)).toBe(true);
  });

  it('falls back to the newest daily price for transfers older than the hourly series', async () => {
    const h = world({
      routes: {
        [`${CG_CHART}?vs_currency=usd&days=90`]: hourlyPrices('2026-09-17T00:00:00Z', '2026-09-19T12:00:00Z', () => 20),
        [`${CG_CHART}?vs_currency=usd&days=91`]: { prices: [[ms('2026-09-15T00:00:00Z'), 7], [ms('2026-09-16T00:00:00Z'), 8], [ms('2026-09-17T00:00:00Z'), 9]] },
      },
    });
    await scanFlowGroup(await argsFor(h));
    expect(rows(h.db, 'flow_usd.fees')[0]).toEqual(['2026-09-17', 102 * 8]);
    expect(h.http.calls.map((c) => c.url)).toEqual([`${CG_CHART}?vs_currency=usd&days=90`, `${CG_CHART}?vs_currency=usd&days=91`]);
  });

  it('does not make the daily call when the hourly series covers the range', async () => {
    const h = world();
    await scanFlowGroup(await argsFor(h));
    expect(h.http.calls.map((c) => c.url)).toEqual([`${CG_CHART}?vs_currency=usd&days=90`]);
  });

  it('fails the day rather than value a transfer that has no earlier price point', async () => {
    const h = world({
      routes: {
        [`${CG_CHART}?vs_currency=usd&days=90`]: hourlyPrices('2026-09-17T00:00:00Z', '2026-09-19T12:00:00Z', () => 20),
        [`${CG_CHART}?vs_currency=usd&days=91`]: { prices: [[ms('2026-09-17T00:00:00Z'), 9]] },
      },
    });
    const r = await scanFlowGroup(await argsFor(h));
    expect(r.outcome.status).toBe('failed');
    expect(r.outcome.error).toMatch(/no mini-token price point at or before 2026-09-16T10:00:01.000Z/);
    expect(listActiveObservations(h.db, 'mini')).toEqual([]);
  });

  it('refuses to write over manual rows without --adopt, and says what --adopt would do', async () => {
    const h = world();
    const manual = insertObservation(h.db, { assetId: 'mini', metricKey: 'flow_usd.fees', observedAt: '2026-09-18', periodDays: 30, value: 5000, source: 'manual', fetchedAt: NOW.toISOString() });
    const r = await scanFlowGroup(await argsFor(h));
    expect(r.outcome.status).toBe('skipped');
    expect(r.outcome.conflicts).toEqual([
      { metricKey: 'flow_usd.fees', observationId: manual.id, source: 'manual', observedAt: '2026-09-18T00:00:00.000Z', periodDays: 30, adoptable: true },
    ]);
    expect(r.outcome.notes.join(' ')).toMatch(/--adopt/);
    expect(listActiveObservations(h.db, 'mini').map((o) => o.id)).toEqual([manual.id]); // no member of the group was written
    expect(getCursor(h.db, 'mini', buildPlan(h.loaded.config).flowGroups[0].scanKey)).toBeNull();
    expect(h.rpc.stats.logRanges).toEqual([]);
  });

  it('with --adopt, rejects the manual rows and writes the fetched ones', async () => {
    const h = world();
    const manual = insertObservation(h.db, { assetId: 'mini', metricKey: 'flow_usd.fees', observedAt: '2026-09-18', periodDays: 30, value: 5000, source: 'manual', fetchedAt: NOW.toISOString() });
    const older = insertObservation(h.db, { assetId: 'mini', metricKey: 'flow_usd.fees', observedAt: '2026-08-19', periodDays: 30, value: 4000, source: 'manual', fetchedAt: NOW.toISOString() });
    const r = await scanFlowGroup(await argsFor(h, { adopt: true }));
    expect(r.outcome.status).toBe('ok');
    expect(r.outcome.retiredObservationIds).toEqual([manual.id]);
    expect(getObservationsByIds(h.db, [manual.id])[0].status).toBe('rejected');
    expect(getObservationsByIds(h.db, [older.id])[0].status).toBe('confirmed'); // it ends before the scanned days: no overlap
    expect(rows(h.db, 'flow_usd.fees')).toEqual([['2026-08-19', 4000], ['2026-09-17', 1020], ['2026-09-18', 60], ['2026-09-19', 0]]);
  });

  it('never adopts over a row that is not manual', async () => {
    const h = world();
    insertObservation(h.db, { assetId: 'mini', metricKey: 'flow_tokens.fees', observedAt: '2026-09-18', periodDays: 2, value: 9, source: 'api', fetchedAt: NOW.toISOString() });
    const r = await scanFlowGroup(await argsFor(h, { adopt: true }));
    expect(r.outcome.status).toBe('skipped');
    expect(r.outcome.conflicts[0]).toMatchObject({ source: 'api', adoptable: false });
    expect(r.outcome.notes.join(' ')).toMatch(/orion data reject/);
  });

  it('finds conflicts by overlap, ignoring rows that only touch the range', () => {
    const h = world();
    const touching = insertObservation(h.db, { assetId: 'mini', metricKey: 'flow_usd.fees', observedAt: '2026-09-16', periodDays: 30, value: 1, source: 'manual', fetchedAt: NOW.toISOString() });
    expect(findFlowConflicts(h.db, 'mini', 'flow_usd.fees', ms('2026-09-16T00:00:00Z'), ms('2026-09-19T00:00:00Z'))).toEqual([]);
    expect(findFlowConflicts(h.db, 'mini', 'flow_usd.fees', ms('2026-09-15T00:00:00Z'), ms('2026-09-19T00:00:00Z')).map((c) => c.observationId)).toEqual([touching.id]);
  });

  it('writes nothing on a dry run and still returns the day values', async () => {
    const h = world();
    const r = await scanFlowGroup(await argsFor(h, { dryRun: true }));
    expect(listActiveObservations(h.db, 'mini')).toEqual([]);
    expect(getCursor(h.db, 'mini', buildPlan(h.loaded.config).flowGroups[0].scanKey)).toBeNull();
    expect(r.written).toHaveLength(9);
    expect(r.written.every((w) => w.observationId === null)).toBe(true);
    expect(r.daily.get('flow_usd.fees')![0]).toEqual({ day: '2026-09-16', value: 1020 });
  });

  it('reports progress once per day', async () => {
    const h = world();
    const lines: string[] = [];
    await scanFlowGroup(await argsFor(h, { onProgress: (l) => lines.push(l) }));
    expect(lines).toEqual([
      'transfer_flow:token>burn_sink[pool,safe] 2026-09-16: 2 transfers',
      'transfer_flow:token>burn_sink[pool,safe] 2026-09-17: 1 transfers, 1 unlisted',
      'transfer_flow:token>burn_sink[pool,safe] 2026-09-18: 0 transfers',
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/ingest/flow.test.ts`
Expected: FAIL (cannot find `src/ingest/flow.js`).

- [ ] **Step 3: Implement**

Create `src/ingest/flow.ts`:

```ts
import type { AssetConfig } from '../config/schema.js';
import type { Db } from '../db/connection.js';
import { advanceCursor, getCursor } from '../db/fetchCursors.js';
import { emptySourceOutcome, type FlowConflict, type SourceOutcome, type UnlistedTransfer } from '../db/fetchRuns.js';
import { insertObservation, listActiveObservations, rejectObservation } from '../db/observations.js';
import { MS_PER_DAY, OrionError } from '../types.js';
import type { FlowGroup } from './plan.js';
import { ERC20_ABI } from './sources/chainLevels.js';
import { COINGECKO_API, coingeckoHeaders } from './sources/coingecko.js';
import { addDays, dayStartMs, utcDay } from './time.js';
import type { HttpTransport } from './transport/http.js';
import { firstBlockAtOrAfter, getLogsChunked, type BlockRef, type RpcTransport } from './transport/rpc.js';
import type { DailyPoint, WrittenObservation } from './types.js';
import { unitsToNumber } from './units.js';

const SECONDS_PER_DAY = 86_400;
const MAX_LISTED_UNLISTED = 50;

/** `ts` is in milliseconds. */
export interface PricePoint {
  ts: number;
  price: number;
}

export interface PriceSeries {
  hourly: PricePoint[];
  daily: PricePoint[];
}

export function parseMarketChart(body: unknown, what: string): PricePoint[] {
  const prices = (body as { prices?: unknown } | null)?.prices;
  if (!Array.isArray(prices) || prices.length === 0) throw new Error(`${what}: no prices in the market_chart response`);
  const points = prices.map((entry) => {
    const [ts, price] = Array.isArray(entry) ? (entry as unknown[]) : [];
    if (typeof ts !== 'number' || typeof price !== 'number' || !Number.isFinite(ts) || !(price > 0) || !Number.isFinite(price)) {
      throw new Error(`${what}: malformed market_chart point ${JSON.stringify(entry)}`);
    }
    return { ts, price };
  });
  return points.sort((a, b) => a.ts - b.ts);
}

function newestAtOrBefore(points: PricePoint[], tsMs: number): number | null {
  let lo = 0;
  let hi = points.length - 1;
  let found: number | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].ts <= tsMs) {
      found = points[mid].price;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/** The newest hourly point at or before `tsMs`; failing that, the newest daily point. Never interpolated. */
export function priceAt(series: PriceSeries, tsMs: number): number | null {
  return newestAtOrBefore(series.hourly, tsMs) ?? newestAtOrBefore(series.daily, tsMs);
}

async function loadPrices(http: HttpTransport, env: Record<string, string | undefined>, id: string, startMs: number, nowMs: number): Promise<PriceSeries> {
  const chart = (days: number) => `${COINGECKO_API}/coins/${encodeURIComponent(id)}/market_chart?vs_currency=usd&days=${days}`;
  const hourly = parseMarketChart(await http.getJson(chart(90), coingeckoHeaders(env)), `coingecko ${id} hourly`);
  let daily: PricePoint[] = [];
  if (startMs < hourly[0].ts) {
    // CoinGecko returns daily points beyond 90 days. Made only when the scan reaches back past the hourly series.
    const days = Math.max(91, Math.ceil((nowMs - startMs) / MS_PER_DAY) + 1);
    daily = parseMarketChart(await http.getJson(chart(days), coingeckoHeaders(env)), `coingecko ${id} daily`);
  }
  return { hourly, daily };
}

/** Active rows from another source whose period overlaps (startMs, endMs). Periods that only touch do not overlap. */
export function findFlowConflicts(db: Db, assetId: string, metricKey: string, startMs: number, endMs: number): FlowConflict[] {
  return listActiveObservations(db, assetId, metricKey)
    .filter((o) => {
      if (o.source === 'onchain') return false;
      const end = new Date(o.observedAt).getTime();
      const start = end - (o.periodDays ?? 1) * MS_PER_DAY;
      return Math.min(end, endMs) - Math.max(start, startMs) > 0;
    })
    .map((o) => ({
      metricKey, observationId: o.id, source: o.source, observedAt: o.observedAt, periodDays: o.periodDays, adoptable: o.source === 'manual',
    }));
}

export interface FlowScanArgs {
  db: Db;
  asset: AssetConfig;
  group: FlowGroup;
  rpc: RpcTransport;
  /** The latest block at plan start. */
  latest: BlockRef;
  http: HttpTransport;
  env: Record<string, string | undefined>;
  sleep(ms: number): Promise<void>;
  now: Date;
  backfillDays: number;
  /** Ignore the cursor and scan `backfillDays` back again. Rows for the same day supersede the old ones. */
  rescan: boolean;
  adopt: boolean;
  dryRun: boolean;
  onProgress?: (line: string) => void;
}

export interface FlowScanResult {
  outcome: SourceOutcome;
  written: WrittenObservation[];
  /** Every unlisted transfer. `outcome.unlistedTransfers` lists at most the first 50. */
  unlisted: UnlistedTransfer[];
  /** Day values of this scan per member metric, also on a dry run. */
  daily: Map<string, DailyPoint[]>;
}

export async function scanFlowGroup(args: FlowScanArgs): Promise<FlowScanResult> {
  const { db, asset, group, rpc, latest, dryRun } = args;
  const outcome = emptySourceOutcome(group.sourceId);
  const result: FlowScanResult = { outcome, written: [], unlisted: [], daily: new Map(group.members.map((m) => [m.metricKey, []])) };
  const nowIso = args.now.toISOString();

  try {
    // 1. Range: completed UTC days only.
    const lastMidnightSec = Math.floor(latest.timestamp / SECONDS_PER_DAY) * SECONDS_PER_DAY;
    const lastCompleteDay = utcDay(lastMidnightSec * 1000 - MS_PER_DAY);
    const cursor = getCursor(db, asset.id, group.scanKey);
    const startDay = cursor && !args.rescan ? addDays(cursor.lastDay, 1) : utcDay(args.now.getTime() - args.backfillDays * MS_PER_DAY);
    if (startDay > lastCompleteDay) {
      outcome.notes.push(`no completed day to scan: the last complete day is ${lastCompleteDay} and the scan is already there`);
      return result;
    }
    const rangeStartMs = dayStartMs(startDay);
    const rangeEndMs = dayStartMs(lastCompleteDay) + MS_PER_DAY;

    // 2. Conflicts with rows from other sources decide whether the group runs at all.
    const conflicts = group.members.flatMap((m) => findFlowConflicts(db, asset.id, m.metricKey, rangeStartMs, rangeEndMs));
    outcome.conflicts = conflicts;
    const stuck = conflicts.filter((c) => !c.adoptable);
    if (conflicts.length > 0 && (!args.adopt || stuck.length > 0)) {
      outcome.status = 'skipped';
      const ids = (list: FlowConflict[]) => list.map((c) => `#${c.observationId}`).join(', ');
      if (stuck.length > 0) {
        outcome.notes.push(
          `nothing was written: ${ids(stuck)} overlap the days ${startDay} to ${lastCompleteDay} and are not manual rows, so --adopt cannot reject them. ` +
            'Reject them by hand with "orion data reject <id>", then fetch again.',
        );
      } else {
        outcome.notes.push(
          `nothing was written: ${conflicts.length} active manual row(s) (${ids(conflicts)}) overlap the days ${startDay} to ${lastCompleteDay}. ` +
            'Re-run with --adopt to reject them and write the fetched rows in the same transaction.',
        );
      }
      return result;
    }

    // 3. Token decimals and price series.
    const [decimalsCall] = await rpc.multicall([{ address: group.token, signature: ERC20_ABI.decimals, functionName: 'decimals' }], latest.number);
    if (!decimalsCall.ok) throw new Error(`decimals() on the token: ${decimalsCall.error}`);
    const decimals = Number(decimalsCall.value);
    const series = new Map<string, PriceSeries>();
    for (const m of group.members) {
      if (m.unit !== 'usd') continue;
      if (m.priceCoingeckoId === null) throw new OrionError('invalid_source_config', `${m.metricKey}: a transfer_flow with unit usd needs price_coingecko_id`);
      if (!series.has(m.priceCoingeckoId)) {
        series.set(m.priceCoingeckoId, await loadPrices(args.http, args.env, m.priceCoingeckoId, rangeStartMs, args.now.getTime()));
      }
    }

    // 4. One day at a time, oldest first. Each day commits on its own, so an interrupted backfill resumes.
    const allow = new Map(group.allowlist.map((a) => [a.address, a.name]));
    const retired = new Set<number>();
    const wroteAny = new Set<string>();
    let from = await firstBlockAtOrAfter(rpc, rangeStartMs / 1000, latest, latest);

    for (let day = startDay; day <= lastCompleteDay; day = addDays(day, 1)) {
      const dayEndMs = dayStartMs(day) + MS_PER_DAY;
      const next = await firstBlockAtOrAfter(rpc, dayEndMs / 1000, from, latest);
      const sums = new Map(group.members.map((m) => [m.metricKey, 0]));
      const senders = new Map<string, { count: number; tokens: number }>();
      let counted = 0;
      let unlistedToday = 0;

      for await (const chunk of getLogsChunked(rpc, { token: group.token, to: group.sink, fromBlock: from.number, toBlock: next.number - 1n }, { sleep: args.sleep })) {
        for (const log of chunk.logs) {
          const sender = log.from.toLowerCase();
          const tokens = unitsToNumber(log.value, decimals);
          const name = allow.get(sender);
          if (name === undefined) {
            result.unlisted.push({ txHash: log.txHash, logIndex: log.logIndex, blockNumber: Number(log.blockNumber), from: sender, tokens, day });
            unlistedToday++;
            continue;
          }
          counted++;
          const tally = senders.get(name) ?? { count: 0, tokens: 0 };
          tally.count++;
          tally.tokens += tokens;
          senders.set(name, tally);
          for (const m of group.members) {
            if (!m.countFrom.includes(sender)) continue;
            let amount = tokens;
            if (m.unit === 'usd') {
              const price = priceAt(series.get(m.priceCoingeckoId!)!, log.timestamp * 1000);
              if (price === null) {
                throw new Error(
                  `no ${m.priceCoingeckoId} price point at or before ${new Date(log.timestamp * 1000).toISOString()}; day ${day} was not written`,
                );
              }
              amount = tokens * price;
            }
            sums.set(m.metricKey, sums.get(m.metricKey)! + amount);
          }
        }
      }

      const observedAt = new Date(dayEndMs).toISOString();
      const detail = JSON.stringify({
        day,
        blocks: [Number(from.number), Number(next.number) - 1],
        senders: Object.fromEntries([...senders.entries()].sort(([a], [b]) => (a < b ? -1 : 1))),
      });
      const ids = new Map<string, number | null>(group.members.map((m) => [m.metricKey, null]));
      if (!dryRun) {
        db.transaction(() => {
          for (const m of group.members) {
            for (const c of conflicts) {
              if (c.metricKey !== m.metricKey || retired.has(c.observationId)) continue;
              const end = new Date(c.observedAt).getTime();
              const start = end - (c.periodDays ?? 1) * MS_PER_DAY;
              if (Math.min(end, dayEndMs) - Math.max(start, dayEndMs - MS_PER_DAY) <= 0) continue;
              rejectObservation(db, c.observationId);
              retired.add(c.observationId);
              outcome.retiredObservationIds.push(c.observationId);
            }
            const o = insertObservation(db, {
              assetId: asset.id, metricKey: m.metricKey, observedAt, periodDays: 1, value: sums.get(m.metricKey)!, source: 'onchain',
              sourceDetail: detail, fetchedAt: nowIso,
            });
            ids.set(m.metricKey, o.id);
          }
          advanceCursor(db, asset.id, group.scanKey, { lastBlock: Number(next.number) - 1, lastDay: day }, nowIso);
        })();
      }
      for (const m of group.members) {
        const value = sums.get(m.metricKey)!;
        result.written.push({ metricKey: m.metricKey, value, observedAt, periodDays: 1, source: 'onchain', observationId: ids.get(m.metricKey)! });
        result.daily.get(m.metricKey)!.push({ day, value });
        wroteAny.add(m.metricKey);
      }
      args.onProgress?.(`${group.sourceId} ${day}: ${counted} transfers${unlistedToday > 0 ? `, ${unlistedToday} unlisted` : ''}`);
      from = next;
    }

    outcome.metricsWritten = group.members.map((m) => m.metricKey).filter((k) => wroteAny.has(k));
    if (dryRun && conflicts.length > 0) outcome.notes.push(`--adopt would reject ${conflicts.map((c) => `#${c.observationId}`).join(', ')}`);
  } catch (err) {
    if (err instanceof OrionError) throw err;
    outcome.status = 'failed';
    outcome.error = err instanceof Error ? err.message : String(err);
    outcome.metricsWritten = [...new Set(result.written.map((w) => w.metricKey))];
  } finally {
    outcome.unlistedTransfers = result.unlisted.slice(0, MAX_LISTED_UNLISTED);
    if (result.unlisted.length > MAX_LISTED_UNLISTED) {
      outcome.notes.push(`${result.unlisted.length} unlisted transfers in total; the first ${MAX_LISTED_UNLISTED} are listed`);
    }
  }
  return result;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/ingest/flow.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ingest/flow.ts tests/ingest/flow.test.ts
git commit -m "feat(ingest): resumable transfer scan with hourly pricing, completed days only, and --adopt"
```

### Task 13: Flows in `fetchAsset`: scans, `unlisted_sender`, and monthly cross-checks

- Each flow group is scanned after the level phase, at the same latest block. If the latest block could not be read, the group fails with that message.
- `opts.backfillDays`, when given, forces a re-scan of that many days (`rescan: true`); otherwise the scan resumes from the cursor, or goes `asset.ingest.backfill_days` back on a first run.
- `unlisted_sender` (spec 6.2): `degrading`, one anomaly per sender (`dedupe_key` = the sender address), raised against each CRITICAL member metric of the group, or against the first member when none is critical. The flow is still written without those transfers.
- Monthly cross-checks (spec 6.1): for a cross-check on a `flow` metric, the primary side is the metric's stored daily `onchain` rows (`period_days` 1), with this run's day values laid over them (that is what makes a dry run meaningful). Each compared month is one `CrossCheckRecord` whose `label` is the month. All out-of-tolerance months of one (metric, source) pair go into ONE anomaly, listed in `detail.months`.

**Files:**
- Modify: `src/ingest/run.ts`
- Create: `tests/ingest/run.flows.test.ts`

**Interfaces:**
- Consumes: `scanFlowGroup`, `FlowScanResult` (Task 12); `compareMonthly` (Task 9); `monthOf`, `utcDay` (Task 7); `listActiveObservations`.
- Produces: no new exports. `FetchResult.sources` gains one `SourceOutcome` per flow group; `FetchResult.written` gains the daily rows.

- [ ] **Step 1: Write the failing test**

Create `tests/ingest/run.flows.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { listAnomalies } from '../../src/db/anomalies.js';
import { insertObservation, listActiveObservations } from '../../src/db/observations.js';
import { fetchAsset, type FetchDeps, type FetchResult } from '../../src/ingest/run.js';
import { addDays } from '../../src/ingest/time.js';
import type { TransferLog } from '../../src/ingest/transport/rpc.js';
import { fakeRpc } from '../helpers/fakeRpc.js';
import { CG_CHART, defaultCalls, GENESIS_TS, harness, hourlyPrices, LLAMA } from '../helpers/fetchHarness.js';
import { POOL } from '../helpers/ingestAsset.js';

const FLOW_ID = 'transfer_flow:token>burn_sink[pool,safe]';
const LLAMA_ID = 'defillama:mini:dailyHoldersRevenue';
const STRANGER = '0x9999999999999999999999999999999999999999';
const E18 = 10n ** 18n;
const source = (r: FetchResult, id: string) => r.sources.find((s) => s.sourceId === id)!;
const blockAt = (iso: string) => BigInt(Math.ceil((Date.parse(iso) / 1000 - GENESIS_TS) / 2));
const log = (iso: string, from: string, tokens: bigint, i: number): Omit<TransferLog, 'timestamp'> => ({
  blockNumber: blockAt(iso), logIndex: i, txHash: `0xtx${i}`, from, value: tokens * E18,
});

describe('fetchAsset: flows', () => {
  it('scans each flow group once and reports it as its own source', async () => {
    const h = harness({ logs: [log('2026-09-17T12:00:00Z', POOL, 4n, 0)] });
    const lines: string[] = [];
    const r = await fetchAsset(h.db, h.loaded, h.deps.now(), h.deps, { onProgress: (l) => lines.push(l) });
    expect(source(r, FLOW_ID)).toMatchObject({ status: 'ok', metricsWritten: ['flow_usd.fees', 'flow_tokens.fees', 'flow_usd.fees_programmatic'] });
    expect(listActiveObservations(h.db, 'mini', 'flow_usd.fees').map((o) => o.value)).toEqual([0, 40, 0]);
    expect(r.written.filter((w) => w.periodDays === 1)).toHaveLength(9);
    expect(lines).toHaveLength(3);
    expect(r.outcome).toBe('ok');
  });

  it('raises one degrading unlisted_sender anomaly per sender, on the critical metric only', async () => {
    const h = harness({ logs: [log('2026-09-17T12:00:00Z', STRANGER, 5n, 0), log('2026-09-18T12:00:00Z', STRANGER, 6n, 1)] });
    const r = await fetchAsset(h.db, h.loaded, h.deps.now(), h.deps);
    expect(r.anomalies).toHaveLength(1);
    expect(r.anomalies[0]).toMatchObject({ kind: 'unlisted_sender', metricKey: 'flow_usd.fees', dedupeKey: STRANGER, severity: 'degrading' });
    expect(r.anomalies[0].detail).toMatchObject({ sender: STRANGER, transfers: 2, tokens: 11, first: { tx: '0xtx0', day: '2026-09-17' }, last: { tx: '0xtx1', day: '2026-09-18' } });
    expect(listActiveObservations(h.db, 'mini', 'flow_tokens.fees').map((o) => o.value)).toEqual([0, 0, 0]); // excluded from the flow
    expect(listAnomalies(h.db, { assetId: 'mini' })).toHaveLength(1);
  });

  it('forces a re-scan when --backfill-days is given, and resumes from the cursor otherwise', async () => {
    const h = harness();
    await fetchAsset(h.db, h.loaded, h.deps.now(), h.deps);
    const scanned = h.rpc.stats.logRanges.length;
    await fetchAsset(h.db, h.loaded, h.deps.now(), h.deps);
    expect(h.rpc.stats.logRanges.length).toBe(scanned);
    await fetchAsset(h.db, h.loaded, h.deps.now(), h.deps, { backfillDays: 2 });
    expect(h.rpc.stats.logRanges.length).toBeGreaterThan(scanned);
    expect(listActiveObservations(h.db, 'mini', 'flow_usd.fees')).toHaveLength(3);
  });

  it('passes --adopt and --dry-run through to the scan', async () => {
    const h = harness();
    insertObservation(h.db, { assetId: 'mini', metricKey: 'flow_usd.fees', observedAt: '2026-09-18', periodDays: 30, value: 5000, source: 'manual', fetchedAt: '2026-09-18T00:00:00Z' });
    const refused = await fetchAsset(h.db, h.loaded, h.deps.now(), h.deps);
    expect(source(refused, FLOW_ID).status).toBe('skipped');
    expect(refused.outcome).toBe('partial');
    const dry = await fetchAsset(h.db, h.loaded, h.deps.now(), h.deps, { adopt: true, dryRun: true });
    expect(source(dry, FLOW_ID).notes.join(' ')).toMatch(/--adopt would reject/);
    expect(listActiveObservations(h.db, 'mini', 'flow_usd.fees')).toHaveLength(1);
    const adopted = await fetchAsset(h.db, h.loaded, h.deps.now(), h.deps, { adopt: true });
    expect(source(adopted, FLOW_ID).retiredObservationIds).toHaveLength(1);
    expect(listActiveObservations(h.db, 'mini', 'flow_usd.fees')).toHaveLength(3);
  });

  it('fails the flow group when the latest block cannot be read', async () => {
    const h = harness();
    h.rpc.latestBlock = async () => {
      throw new Error('connection refused');
    };
    const r = await fetchAsset(h.db, h.loaded, h.deps.now(), h.deps);
    expect(source(r, FLOW_ID)).toMatchObject({ status: 'failed', error: 'could not read the latest block: connection refused' });
  });

  describe('monthly cross-check', () => {
    // A 50-day backfill from 2026-09-19 covers all of August.
    const august = (value: number) => Array.from({ length: 31 }, (_, i) => [Date.parse(addDays('2026-08-01', i)) / 1000, value]);

    /** Sixty more days of chain history than the default harness, with 10 tokens (100 USD) burned at noon on every day of August. */
    const longHarness = (llamaPerDay: number) => {
      const h = harness({
        routes: {
          [LLAMA]: { totalDataChart: [...august(llamaPerDay), [Date.parse('2026-09-01') / 1000, 1]] },
          [CG_CHART]: hourlyPrices('2026-07-01T00:00:00Z', '2026-09-19T12:00:00Z', () => 10),
        },
      });
      const genesis = GENESIS_TS - 60 * 86_400;
      const blockAtNoon = (day: string) => BigInt(Math.ceil((Date.parse(`${day}T12:00:00Z`) / 1000 - genesis) / 2));
      const logs = Array.from({ length: 31 }, (_, i) => ({
        blockNumber: blockAtNoon(addDays('2026-08-01', i)), logIndex: 0, txHash: `0xaug${i}`, from: POOL, value: 10n * E18,
      }));
      const rpc = fakeRpc({ genesisTs: genesis, latest: BigInt(Math.floor((h.deps.now().getTime() / 1000 - genesis) / 2)), calls: defaultCalls(), logs });
      const deps: FetchDeps = { ...h.deps, rpcFactory: () => rpc };
      return { h, deps };
    };

    it('compares completed months and stays quiet within tolerance', async () => {
      const { h, deps } = longHarness(103);
      const r = await fetchAsset(h.db, h.loaded, h.deps.now(), deps, { backfillDays: 50 });
      expect(source(r, LLAMA_ID).crossChecks).toEqual([
        { metricKey: 'flow_usd.fees', sourceId: LLAMA_ID, label: '2026-08', primary: 3100, check: 3193, diffPct: expect.closeTo(3, 9), tolerancePct: 5, ok: true },
      ]);
      expect(r.anomalies).toEqual([]);
    });

    it('raises one anomaly listing the months that are out of tolerance, from a dry run too', async () => {
      const { h, deps } = longHarness(120);
      const r = await fetchAsset(h.db, h.loaded, h.deps.now(), deps, { backfillDays: 50, dryRun: true });
      expect(r.anomalies).toHaveLength(1);
      expect(r.anomalies[0]).toMatchObject({ kind: 'cross_check_mismatch', metricKey: 'flow_usd.fees', dedupeKey: LLAMA_ID, severity: 'degrading', id: null });
      expect(r.anomalies[0].detail).toMatchObject({ tolerance_pct: 5, check_source: LLAMA_ID, months: [{ month: '2026-08', primary: 3100, check: 3720 }] });
    });
  });

  it('notes when no month is covered by both series yet', async () => {
    const h = harness();
    const r = await fetchAsset(h.db, h.loaded, h.deps.now(), h.deps);
    expect(source(r, LLAMA_ID)).toMatchObject({ status: 'ok', crossChecks: [] });
    expect(source(r, LLAMA_ID).notes).toEqual(['flow_usd.fees: no calendar month is fully covered by both series yet']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/ingest/run.flows.test.ts`
Expected: FAIL (no source outcome for the flow group; no monthly cross-check records).

- [ ] **Step 3: Implement**

In `src/ingest/run.ts`, replace:

```ts
import { compareLevel } from './crosscheck.js';
import { buildPlan, hasSources, type SourceBatch } from './plan.js';
```

with:

```ts
import { listActiveObservations } from '../db/observations.js';
import { MS_PER_DAY } from '../types.js';
import { compareLevel, compareMonthly } from './crosscheck.js';
import { scanFlowGroup } from './flow.js';
import { buildPlan, hasSources, type FlowGroup, type SourceBatch } from './plan.js';
import { monthOf, utcDay } from './time.js';
import type { DailyPoint } from './types.js';
```

In `src/ingest/run.ts`, replace:

```ts
function readsChain(batch: SourceBatch): boolean {
```

with:

```ts
/** An unlisted sender degrades the group's critical metrics; with none critical, its first metric. */
function unlistedAnomalyMetrics(loaded: LoadedAsset, group: FlowGroup): string[] {
  const critical = group.members.map((m) => m.metricKey).filter((k) => loaded.config.metrics[k].critical);
  return critical.length > 0 ? critical : [group.members[0].metricKey];
}

/** The metric's stored daily on-chain rows, keyed by the UTC day each one covers. */
function storedDailyFlow(db: Db, assetId: string, metricKey: string): Map<string, number> {
  const days = new Map<string, number>();
  for (const o of listActiveObservations(db, assetId, metricKey)) {
    if (o.source === 'onchain' && o.periodDays === 1) days.set(utcDay(new Date(o.observedAt).getTime() - MS_PER_DAY), o.value);
  }
  return days;
}

function readsChain(batch: SourceBatch): boolean {
```

In `src/ingest/run.ts`, replace:

```ts
  // [Task 13 inserts the transfer scans and the monthly cross-checks here]
```

with:

```ts
  // 4. Transfer scans: one per flow group, at the same latest block as the level reads.
  const scannedDaily = new Map<string, DailyPoint[]>();
  for (const group of plan.flowGroups) {
    if (rpc === null || block === null) {
      markFailed(outcomeOf(group.sourceId), chainError ?? 'no RPC connection');
      continue;
    }
    const scan = await scanFlowGroup({
      db, asset, group, rpc, latest: block, http: ctx.http, env: deps.env, sleep: deps.sleep, now,
      backfillDays: opts.backfillDays ?? asset.ingest!.backfill_days, rescan: opts.backfillDays !== undefined,
      adopt: opts.adopt ?? false, dryRun, onProgress: opts.onProgress,
    });
    outcomes.set(group.sourceId, scan.outcome);
    written.push(...scan.written);
    for (const [metricKey, points] of scan.daily) scannedDaily.set(metricKey, points);

    const bySender = new Map<string, typeof scan.unlisted>();
    for (const t of scan.unlisted) bySender.set(t.from, [...(bySender.get(t.from) ?? []), t]);
    for (const [sender, transfers] of bySender) {
      const first = transfers[0];
      const last = transfers[transfers.length - 1];
      for (const metricKey of unlistedAnomalyMetrics(loaded, group)) {
        raise({
          kind: 'unlisted_sender', metricKey, dedupeKey: sender, severity: 'degrading',
          detail: {
            sender, transfers: transfers.length, tokens: transfers.reduce((s, t) => s + t.tokens, 0),
            first: { tx: first.txHash, day: first.day }, last: { tx: last.txHash, day: last.day }, scan: group.sourceId,
          },
        });
      }
    }
  }

  // 5. Monthly cross-checks of flow metrics: stored daily rows, with this run's days laid over them.
  const currentMonth = monthOf(utcDay(now.getTime()));
  for (const batch of plan.batches) {
    for (const r of batch.requests) {
      const def = asset.metrics[r.metricKey];
      if (r.role !== 'cross_check' || def.type !== 'flow') continue;
      const outcome = outcomeOf(batch.sourceId);
      const result = readings.get(r)!;
      if (!result.ok) {
        markFailed(outcome, `${r.metricKey}: ${result.error}`);
        continue;
      }
      if (result.value.kind === 'level') {
        markFailed(outcome, `${r.metricKey}: expected a daily or monthly series, got a level`);
        continue;
      }
      const days = storedDailyFlow(db, asset.id, r.metricKey);
      for (const p of scannedDaily.get(r.metricKey) ?? []) days.set(p.day, p.value);
      const primary = [...days.entries()].map(([day, value]) => ({ day, value }));
      const months = compareMonthly(primary, result.value, r.tolerancePct, currentMonth);
      if (months.length === 0) outcome.notes.push(`${r.metricKey}: no calendar month is fully covered by both series yet`);
      for (const m of months) {
        outcome.crossChecks.push({
          metricKey: r.metricKey, sourceId: batch.sourceId, label: m.month, primary: m.primary, check: m.check, diffPct: m.diffPct,
          tolerancePct: r.tolerancePct, ok: m.ok,
        });
      }
      const bad = months.filter((m) => !m.ok);
      if (bad.length > 0) {
        raise({
          kind: 'cross_check_mismatch', metricKey: r.metricKey, dedupeKey: batch.sourceId, severity: def.critical ? 'degrading' : 'advisory',
          detail: {
            months: bad.map((m) => ({ month: m.month, primary: m.primary, check: m.check, diff_pct: m.diffPct })),
            tolerance_pct: r.tolerancePct, primary_source: sourceId(def.source!), check_source: batch.sourceId,
          },
        });
      }
    }
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/ingest && npm run typecheck`
Expected: PASS, including `tests/ingest/run.test.ts` from Task 11 (its runs now scan three empty days as well).

- [ ] **Step 5: Commit**

```bash
git add src/ingest/run.ts tests/ingest/run.flows.test.ts
git commit -m "feat(ingest): transfer scans, unlisted_sender anomalies, and monthly cross-checks in fetchAsset"
```

### Task 14: Open anomalies in the signal

Spec 6.4. Open anomalies are read at RUN time and are not part of the snapshot: replay reproduces engine output, which anomalies never enter.

- `data_quality.open_anomalies` is the count of open anomalies for the asset.
- `data_quality.anomalies` (new, additive) lists `{ id, kind, metric, severity }` for each, oldest first.
- An open `degrading` anomaly on a `critical` metric sets grade `D`, and an otherwise-ok signal becomes `degraded` with reason `open_anomaly:<kind>:<metric>`. A blocked signal stays blocked with its own reasons; its grade and anomaly list still reflect the anomalies.
- Advisory anomalies, and degrading ones on non-critical metrics, appear in the list and change neither grade nor status.
- `schema_version` stays `1`. Stored signals from before this task have no `anomalies` key: code that reads stored signals must tolerate its absence.

**Files:**
- Modify: `src/signals/schema.ts`, `src/signals/quality.ts`, `src/signals/build.ts`, `src/app/valuation.ts`, `src/cli/util.ts`
- Modify: `tests/signals/build.test.ts`, `tests/app/valuation.test.ts`

**Interfaces:**
- Consumes: `listOpenAnomalies`, `Anomaly` (Task 3).
- Produces:
  - `BuildSignalInput` gains `openAnomalies?: SignalAnomaly[]`, where `export interface SignalAnomaly { id: number; kind: string; metricKey: string; severity: 'degrading' | 'advisory' }`.
  - `gradeDataQuality(report: DriverReport, degradedByAnomaly = false): Grade`.
  - `Signal['data_quality']` gains `anomalies: { id: number; kind: string; metric: string; severity: 'degrading' | 'advisory' }[]`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/signals/build.test.ts`:

```ts

describe('buildSignal with open anomalies', () => {
  const degrading = { id: 7, kind: 'cross_check_mismatch', metricKey: 'price_usd', severity: 'degrading' as const };

  it('reports no anomalies by default', () => {
    const s = buildSignal(input());
    expect(s.data_quality.open_anomalies).toBe(0);
    expect(s.data_quality.anomalies).toEqual([]);
  });

  it('degrades to grade D for an open degrading anomaly on a critical metric', () => {
    const s = buildSignal({ ...input(), openAnomalies: [degrading] });
    expect(s.status).toBe('degraded');
    expect(s.status_reasons).toEqual(['open_anomaly:cross_check_mismatch:price_usd']);
    expect(s.data_quality).toMatchObject({ grade: 'D', open_anomalies: 1, anomalies: [{ id: 7, kind: 'cross_check_mismatch', metric: 'price_usd', severity: 'degrading' }] });
    expect(s.horizons).toBeDefined();
    expect(SignalSchema.safeParse(s).success).toBe(true);
  });

  it('lists advisory anomalies, and degrading ones on non-critical metrics, without changing grade or status', () => {
    const s = buildSignal({
      ...input(),
      openAnomalies: [
        { id: 1, kind: 'revenue_disclosure_stale', metricKey: 'revenue_run_rate_usd', severity: 'advisory' },
        { id: 2, kind: 'cross_check_mismatch', metricKey: 'staked_supply', severity: 'degrading' }, // staked_supply is not critical
        { id: 3, kind: 'source_failure_streak', metricKey: '', severity: 'advisory' },
      ],
    });
    expect(s.status).toBe('ok');
    expect(s.data_quality.grade).toBe('A');
    expect(s.data_quality.open_anomalies).toBe(3);
    expect(s.data_quality.anomalies.map((a) => a.id)).toEqual([1, 2, 3]);
  });

  it('keeps a blocked signal blocked with its own reasons, and still reports the anomalies', () => {
    const s = buildSignal({ ...input(miniObservations().filter((o) => o.metricKey !== 'effective_supply')), openAnomalies: [degrading] });
    expect(s.status).toBe('blocked');
    expect(s.status_reasons).toEqual(['missing_metric:effective_supply']);
    expect(s.data_quality.grade).toBe('D');
    expect(s.data_quality.open_anomalies).toBe(1);
  });
});
```

In `tests/app/valuation.test.ts`, replace:

```ts
import { createAssumptionSet } from '../../src/db/assumptions.js';
```

with:

```ts
import { decideAnomaly, raiseAnomaly } from '../../src/db/anomalies.js';
import { createAssumptionSet } from '../../src/db/assumptions.js';
```

Append to `tests/app/valuation.test.ts`:

```ts

describe('runValuation and open anomalies', () => {
  const raise = (severity: 'degrading' | 'advisory', metricKey = 'price_usd') =>
    raiseAnomaly(db, { assetId: 'mini', kind: 'cross_check_mismatch', metricKey, dedupeKey: 'coingecko', severity, detail: {}, seenAt: AS_OF });

  it('degrades while a degrading anomaly on a critical metric is open, and recovers once it is acknowledged', () => {
    seedObservations();
    seedAssumptions();
    const anomaly = raise('degrading');
    const degraded = runValuation(db, loaded, NOW).signal;
    expect(degraded.status).toBe('degraded');
    expect(degraded.status_reasons).toEqual(['open_anomaly:cross_check_mismatch:price_usd']);
    expect(degraded.data_quality).toMatchObject({ grade: 'D', open_anomalies: 1 });
    expect(degraded.data_quality.anomalies).toEqual([{ id: anomaly.id, kind: 'cross_check_mismatch', metric: 'price_usd', severity: 'degrading' }]);
    expect(degraded.horizons!['12m'].expected_target).toBeCloseTo(10, 6); // the target itself is untouched

    decideAnomaly(db, anomaly.id, 'acknowledged', 'venice api lags by an hour', AS_OF);
    const ok = runValuation(db, loaded, NOW).signal;
    expect(ok.status).toBe('ok');
    expect(ok.data_quality).toMatchObject({ grade: 'A', open_anomalies: 0, anomalies: [] });
  });

  it('ignores anomalies of other assets and leaves advisory ones in the list only', () => {
    seedObservations();
    seedAssumptions();
    raise('advisory');
    raiseAnomaly(db, { assetId: 'other', kind: 'unlisted_sender', metricKey: 'price_usd', dedupeKey: '0x1', severity: 'degrading', detail: {}, seenAt: AS_OF });
    const signal = runValuation(db, loaded, NOW).signal;
    expect(signal.status).toBe('ok');
    expect(signal.data_quality.open_anomalies).toBe(1);
  });

  it('keeps anomalies out of the replayed engine output', () => {
    seedObservations();
    seedAssumptions();
    const { runId } = runValuation(db, loaded, NOW);
    raise('degrading');
    expect(replayRun(db, runId).identical).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/signals tests/app`
Expected: FAIL (`anomalies` is undefined on `data_quality`; `openAnomalies` is not a known property).

- [ ] **Step 3: Implement**

In `src/signals/schema.ts`, replace:

```ts
    open_anomalies: z.number().int().nonnegative(),
  }),
```

with:

```ts
    open_anomalies: z.number().int().nonnegative(),
    /** Added in sub-project 2 (additive, schema_version stays 1). Signals stored before it have no such key. */
    anomalies: z
      .array(z.strictObject({ id: z.number().int(), kind: z.string(), metric: z.string(), severity: z.enum(['degrading', 'advisory']) }))
      .default([]),
  }),
```

In `src/signals/quality.ts`, replace:

```ts
export function gradeDataQuality(report: DriverReport): Grade {
  if (report.staleCritical.length > 0) return 'D';
```

with:

```ts
/** `degradedByAnomaly`: an open degrading anomaly exists on a critical metric. */
export function gradeDataQuality(report: DriverReport, degradedByAnomaly = false): Grade {
  if (report.staleCritical.length > 0 || degradedByAnomaly) return 'D';
```

In `src/signals/build.ts`, replace:

```ts
  /** Price observation to report when drivers are null (blocked) but a price exists. */
  spotFallback?: { price: number; ts: string } | null;
}
```

with:

```ts
  /** Price observation to report when drivers are null (blocked) but a price exists. */
  spotFallback?: { price: number; ts: string } | null;
  /** Open anomalies for the asset, read at run time. They are not part of the snapshot. */
  openAnomalies?: SignalAnomaly[];
}

export interface SignalAnomaly {
  id: number;
  kind: string;
  /** '' for an anomaly that belongs to a source rather than a metric. */
  metricKey: string;
  severity: 'degrading' | 'advisory';
}
```

In `src/signals/build.ts`, replace:

```ts
  const { report, engine } = input;
  const grade = gradeDataQuality(report);

  let status: Signal['status'];
  let reasons: string[];
  if (!engine) {
    status = 'blocked';
    reasons = input.blockedReasons;
  } else {
    reasons = report.staleCritical.map((m) => `stale_critical:${m}`);
    if (!engine.converged) reasons.push('supply_forecast_not_converged');
```

with:

```ts
  const { report, engine } = input;
  const openAnomalies = input.openAnomalies ?? [];
  // Only a degrading anomaly on a critical metric affects grade and status. The rest are listed.
  const degrading = openAnomalies.filter((a) => a.severity === 'degrading' && input.asset.metrics[a.metricKey]?.critical === true);
  const grade = gradeDataQuality(report, degrading.length > 0);

  let status: Signal['status'];
  let reasons: string[];
  if (!engine) {
    status = 'blocked';
    reasons = input.blockedReasons;
  } else {
    reasons = report.staleCritical.map((m) => `stale_critical:${m}`);
    reasons.push(...degrading.map((a) => `open_anomaly:${a.kind}:${a.metricKey}`));
    if (!engine.converged) reasons.push('supply_forecast_not_converged');
```

In `src/signals/build.ts`, replace:

```ts
      open_anomalies: 0,
    },
```

with:

```ts
      open_anomalies: openAnomalies.length,
      anomalies: openAnomalies.map((a) => ({ id: a.id, kind: a.kind, metric: a.metricKey, severity: a.severity })),
    },
```

In `src/app/valuation.ts`, replace:

```ts
import { getAssumptionSetById, getLatestAssumptionSet } from '../db/assumptions.js';
```

with:

```ts
import { listOpenAnomalies } from '../db/anomalies.js';
import { getAssumptionSetById, getLatestAssumptionSet } from '../db/assumptions.js';
```

In `src/app/valuation.ts`, replace:

```ts
      spotFallback: priceObs ? { price: priceObs.value, ts: priceObs.observedAt } : null,
      change: {
```

with:

```ts
      spotFallback: priceObs ? { price: priceObs.value, ts: priceObs.observedAt } : null,
      // Read at run time and deliberately outside the snapshot: replay reproduces engine output only.
      openAnomalies: listOpenAnomalies(db, asset.id),
      change: {
```

In `src/cli/util.ts`, replace:

```ts
  if (s.data_quality.provisional_metrics.length > 0) lines.push(`provisional: ${s.data_quality.provisional_metrics.join(', ')}`);
```

with:

```ts
  if (s.data_quality.provisional_metrics.length > 0) lines.push(`provisional: ${s.data_quality.provisional_metrics.join(', ')}`);
  const anomalies = s.data_quality.anomalies ?? []; // signals stored before sub-project 2 have no list
  if (anomalies.length > 0) {
    lines.push(`open anomalies: ${anomalies.map((a) => `#${a.id} ${a.kind}${a.metric ? ` on ${a.metric}` : ''} (${a.severity})`).join('; ')}`);
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/signals src/app/valuation.ts src/cli/util.ts tests/signals tests/app
git commit -m "feat(signals): open anomalies in data_quality; a degrading anomaly on a critical metric degrades the signal"
```

---

## Task group E: VVV adapters, usage momentum, and the stale-revenue alert

### Task 15: The VVV adapters

Four named adapters (spec 4.2), registered exactly as custom valuation modules are. ABI units were verified live during planning (see the top of this plan): the two emission percentages are FRACTIONS scaled by 1e18, and both DIEM tables are 18-decimal with 256 entries.

- `vvv.staker_emission_share` (chain): share to stakers = `1 - [p_unlocked * (staked - locked) + p_locked * locked] / staked`, from `veniceEmissionsPercentage()`, `veniceEmissionsPercentageWhenLocked()`, `totalSupply()`, and `totalLockedStakedVVV()` on the staking contract, in one multicall at the run's block.
- `vvv.diem_target_supply` (chain): reads `diemSupply(i)` and `diemMintRates(i)` for `i` in `0..entries-1` in ONE multicall, and returns the supply at which the mint rate equals `mint_base_rate * e^mint_curve_k` (665.015 for VVV), interpolating linearly between the two bracketing buckets. It fails when the table never reaches that rate or already exceeds it at the first bucket.
- `vvv.staker_share_from_api` (cross-check only): `stakerDistributionCryptoBaseUnit / totalEmissionsCryptoBaseUnit` from `vvv_staking_yield`. An adapter because `http_json` reads one field, not a ratio of two.
- `vvv.burn_history_tokens` (cross-check only): `vvv_burn_history.burnHistory[]` as a monthly token series (`burnedCryptoBaseUnit / 1e18`).

Params: the chain adapters take `staking_contract` (a contract NAME, default `staking`); `vvv.diem_target_supply` also takes `entries` (256), `mint_base_rate` (90), `mint_curve_k` (2). The API adapters REQUIRE `url`: asset knowledge stays in the YAML.

**Files:**
- Create: `src/ingest/adapters/vvv.ts`, `tests/ingest/adapters.vvv.test.ts`
- Modify: `src/ingest/adapters/registry.ts`

**Interfaces:**
- Consumes: `AdapterDef` (Task 7), `SourceContext`, `SourceValue`, `unitsToNumber`, `toFiniteNumber`, `ContractCall`.
- Produces: `vvvAdapters: AdapterDef[]`; after this task `getAdapter('vvv.staker_emission_share' | 'vvv.diem_target_supply' | 'vvv.staker_share_from_api' | 'vvv.burn_history_tokens')` resolve. The first two have `needsRpc: true`.

- [ ] **Step 1: Write the failing test**

Create `tests/ingest/adapters.vvv.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { adapterNames, getAdapter } from '../../src/ingest/adapters/registry.js';
import { fakeHttp } from '../helpers/fakeHttp.js';
import { callKey, fakeRpc } from '../helpers/fakeRpc.js';
import { STAKING } from '../helpers/ingestAsset.js';
import { fixture, NOW_ISO, sourceCtx } from '../helpers/sourceCtx.js';

const VENICE = 'https://outerface.venice.ai/api/app/vvv';

/** The on-chain tables follow 90 * e^(2 * (supply / target)^3) in 500-DIEM buckets (verified live, target 40,000). */
function diemTables(target: number, entries = 256): Record<string, bigint> {
  const calls: Record<string, bigint> = {};
  for (let i = 0; i < entries; i++) {
    const supply = 500 * (i + 1);
    const rate = Math.min(90 * Math.exp(2 * (supply / target) ** 3), 1e30); // capped: a uint256 cannot hold Infinity
    calls[callKey(STAKING, 'diemSupply', [BigInt(i)])] = BigInt(supply) * 10n ** 18n;
    calls[callKey(STAKING, 'diemMintRates', [BigInt(i)])] = BigInt(Math.round(rate * 1e6)) * 10n ** 12n;
  }
  return calls;
}

async function chainCtx(calls: Record<string, bigint | Error>) {
  const rpc = fakeRpc({ genesisTs: 1_700_000_001, latest: 500n, calls });
  return { ctx: sourceCtx({ rpc, block: await rpc.latestBlock() }), rpc };
}

describe('VVV adapters', () => {
  it('are registered by name', () => {
    expect(adapterNames()).toEqual(expect.arrayContaining(['vvv.burn_history_tokens', 'vvv.diem_target_supply', 'vvv.staker_emission_share', 'vvv.staker_share_from_api']));
    expect(getAdapter('vvv.staker_emission_share').needsRpc).toBe(true);
    expect(getAdapter('vvv.diem_target_supply').needsRpc).toBe(true);
    expect(getAdapter('vvv.staker_share_from_api').needsRpc).toBe(false);
  });

  it('computes the staker emission share from fractions scaled by 1e18', async () => {
    // Values read live on 2026-09-19: Venice takes 0 percent on unlocked stake and 20 percent on DIEM-locked stake.
    const { ctx, rpc } = await chainCtx({
      [callKey(STAKING, 'veniceEmissionsPercentage')]: 0n,
      [callKey(STAKING, 'veniceEmissionsPercentageWhenLocked')]: 200000000000000000n,
      [callKey(STAKING, 'totalSupply')]: 33941208987993140790795723n,
      [callKey(STAKING, 'totalLockedStakedVVV')]: 8954489934888212779041642n,
    });
    const v = await getAdapter('vvv.staker_emission_share').run(ctx, {});
    expect(v).toMatchObject({ kind: 'level', source: 'onchain', observedAt: new Date((1_700_000_001 + 1000) * 1000).toISOString(), detail: 'block 500' });
    expect(v.kind === 'level' && v.value).toBeCloseTo(0.9472352918362107, 12);
    expect(rpc.stats.multicall).toBe(1);
  });

  it('weights both percentages: a take on unlocked stake lowers the share too', async () => {
    const { ctx } = await chainCtx({
      [callKey(STAKING, 'veniceEmissionsPercentage')]: 100000000000000000n, // 10 percent
      [callKey(STAKING, 'veniceEmissionsPercentageWhenLocked')]: 200000000000000000n,
      [callKey(STAKING, 'totalSupply')]: 100n * 10n ** 18n,
      [callKey(STAKING, 'totalLockedStakedVVV')]: 25n * 10n ** 18n,
    });
    const v = await getAdapter('vvv.staker_emission_share').run(ctx, { staking_contract: 'staking' });
    expect(v.kind === 'level' && v.value).toBeCloseTo(1 - (0.1 * 75 + 0.2 * 25) / 100, 12);
  });

  it('fails the staker share when a read fails or nothing is staked', async () => {
    const base = {
      [callKey(STAKING, 'veniceEmissionsPercentage')]: 0n,
      [callKey(STAKING, 'veniceEmissionsPercentageWhenLocked')]: 200000000000000000n,
      [callKey(STAKING, 'totalLockedStakedVVV')]: 0n,
    };
    await expect(getAdapter('vvv.staker_emission_share').run((await chainCtx({ ...base, [callKey(STAKING, 'totalSupply')]: 0n })).ctx, {})).rejects.toThrow(/nothing is staked/);
    await expect(getAdapter('vvv.staker_emission_share').run((await chainCtx(base)).ctx, {})).rejects.toThrow(/totalSupply/);
    await expect(getAdapter('vvv.staker_emission_share').run(sourceCtx(), {})).rejects.toThrow(/RPC/);
  });

  it('finds the DIEM target supply where the mint rate reaches base * e^k, in one multicall', async () => {
    const { ctx, rpc } = await chainCtx(diemTables(40_000));
    const v = await getAdapter('vvv.diem_target_supply').run(ctx, {});
    expect(v.kind === 'level' && v.value).toBeCloseTo(40_000, 2);
    expect(v).toMatchObject({ source: 'onchain', detail: 'block 500' });
    expect(rpc.stats.multicall).toBe(1);
  });

  it('interpolates linearly between the two bracketing buckets', async () => {
    const { ctx } = await chainCtx(diemTables(42_250)); // between the 42,000 and 42,500 buckets
    const v = await getAdapter('vvv.diem_target_supply').run(ctx, {});
    // Linear interpolation of a convex curve lands slightly below the true 42,250.
    expect(v.kind === 'level' && v.value).toBeCloseTo(42_244.08, 1);
  });

  it('fails the DIEM target when the table cannot bracket the rate or a read fails', async () => {
    await expect(getAdapter('vvv.diem_target_supply').run((await chainCtx(diemTables(40_000, 8))).ctx, { entries: 8 })).rejects.toThrow(/never reaches/);
    await expect(getAdapter('vvv.diem_target_supply').run((await chainCtx(diemTables(100))).ctx, {})).rejects.toThrow(/first bucket/);
    const broken = { ...diemTables(40_000), [callKey(STAKING, 'diemMintRates', [7n])]: new Error('reverted') };
    await expect(getAdapter('vvv.diem_target_supply').run((await chainCtx(broken)).ctx, {})).rejects.toThrow(/diemMintRates\(7\)/);
  });

  it('reads the staker share from the Venice API as a ratio of two fields', async () => {
    const url = `${VENICE}/vvv_staking_yield`;
    const ctx = sourceCtx({ http: fakeHttp({ [url]: fixture('venice_vvv_staking_yield.json') }) });
    const v = await getAdapter('vvv.staker_share_from_api').run(ctx, { url });
    expect(v).toMatchObject({ kind: 'level', source: 'api', observedAt: NOW_ISO });
    expect(v.kind === 'level' && v.value).toBeCloseTo(0.9471936034203345, 12);
    await expect(getAdapter('vvv.staker_share_from_api').run(ctx, {})).rejects.toThrow(/url/);
  });

  it('turns the Venice burn history into a monthly token series', async () => {
    const url = `${VENICE}/vvv_burn_history`;
    const ctx = sourceCtx({ http: fakeHttp({ [url]: fixture('venice_vvv_burn_history.json') }) });
    const v = await getAdapter('vvv.burn_history_tokens').run(ctx, { url });
    if (v.kind !== 'monthly_series') throw new Error('expected a monthly series');
    expect(v.points).toHaveLength(12);
    expect(v.points.find((p) => p.month === '2026-08')!.value).toBeCloseTo(55498.417825166835, 6);
    expect(v.points.find((p) => p.month === '2026-10')!.value).toBe(0);
    const bad = sourceCtx({ http: fakeHttp({ [url]: { burnHistory: [{ yearMonth: 'August', burnedCryptoBaseUnit: '1' }] } }) });
    await expect(getAdapter('vvv.burn_history_tokens').run(bad, { url })).rejects.toThrow(/malformed/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/ingest/adapters.vvv.test.ts`
Expected: FAIL (cannot find `src/ingest/adapters/vvv.js`; `unknown adapter`).

- [ ] **Step 3: Implement**

Create `src/ingest/adapters/vvv.ts`:

```ts
import type { ContractCall } from '../transport/rpc.js';
import type { SourceContext, SourceValue } from '../types.js';
import { toFiniteNumber, unitsToNumber } from '../units.js';
import type { AdapterDef } from './registry.js';

// Verified live on 2026-09-19: both emission percentages are FRACTIONS scaled by 1e18 (20 percent
// reads as 200000000000000000), and both DIEM tables are 18-decimal with 256 entries.
const FRACTION_DECIMALS = 18;
const TOKEN_DECIMALS = 18;

const view = (name: string, input = ''): string => `function ${name}(${input}) view returns (uint256)`;

function chain(ctx: SourceContext) {
  if (!ctx.rpc || !ctx.block) throw new Error('this adapter needs an RPC connection and a block');
  return { rpc: ctx.rpc, block: ctx.block };
}

const text = (params: Record<string, unknown>, key: string, fallback: string): string =>
  typeof params[key] === 'string' ? (params[key] as string) : fallback;
const number = (params: Record<string, unknown>, key: string, fallback: number): number =>
  typeof params[key] === 'number' ? (params[key] as number) : fallback;

function requiredUrl(params: Record<string, unknown>): string {
  if (typeof params.url !== 'string' || params.url === '') throw new Error('the "url" param is required');
  return params.url;
}

async function readAll(ctx: SourceContext, calls: ContractCall[]): Promise<bigint[]> {
  const { rpc, block } = chain(ctx);
  const results = await rpc.multicall(calls, block.number);
  return results.map((r, i) => {
    if (!r.ok) throw new Error(`${calls[i].functionName}(${(calls[i].args ?? []).join(',')}): ${r.error}`);
    return r.value;
  });
}

const onchain = (ctx: SourceContext, value: number): SourceValue => {
  const { block } = chain(ctx);
  return { kind: 'level', value, observedAt: new Date(block.timestamp * 1000).toISOString(), source: 'onchain', detail: `block ${block.number}` };
};

/** Share of gross emissions paid to stakers: 1 - [p_unlocked * (staked - locked) + p_locked * locked] / staked. */
const stakerEmissionShare: AdapterDef = {
  name: 'vvv.staker_emission_share',
  needsRpc: true,
  async run(ctx, params) {
    const address = ctx.contract(text(params, 'staking_contract', 'staking'));
    const names = ['veniceEmissionsPercentage', 'veniceEmissionsPercentageWhenLocked', 'totalSupply', 'totalLockedStakedVVV'];
    const [pUnlockedRaw, pLockedRaw, stakedRaw, lockedRaw] = await readAll(ctx, names.map((n) => ({ address, signature: view(n), functionName: n })));
    const staked = unitsToNumber(stakedRaw, TOKEN_DECIMALS);
    if (!(staked > 0)) throw new Error('nothing is staked, so the staker share is undefined');
    const locked = unitsToNumber(lockedRaw, TOKEN_DECIMALS);
    const pUnlocked = unitsToNumber(pUnlockedRaw, FRACTION_DECIMALS);
    const pLocked = unitsToNumber(pLockedRaw, FRACTION_DECIMALS);
    return onchain(ctx, 1 - (pUnlocked * (staked - locked) + pLocked * locked) / staked);
  },
};

/** The DIEM supply at which the mint rate reaches mint_base_rate * e^mint_curve_k: the target supply of the on-chain curve. */
const diemTargetSupply: AdapterDef = {
  name: 'vvv.diem_target_supply',
  needsRpc: true,
  async run(ctx, params) {
    const address = ctx.contract(text(params, 'staking_contract', 'staking'));
    const entries = number(params, 'entries', 256);
    const threshold = number(params, 'mint_base_rate', 90) * Math.exp(number(params, 'mint_curve_k', 2));

    const calls: ContractCall[] = [];
    for (let i = 0; i < entries; i++) {
      calls.push({ address, signature: view('diemSupply', 'uint256'), functionName: 'diemSupply', args: [BigInt(i)] });
      calls.push({ address, signature: view('diemMintRates', 'uint256'), functionName: 'diemMintRates', args: [BigInt(i)] });
    }
    const raw = await readAll(ctx, calls); // one multicall: the public RPC throttles bursts of separate calls
    const supply = (i: number) => unitsToNumber(raw[2 * i], TOKEN_DECIMALS);
    const rate = (i: number) => unitsToNumber(raw[2 * i + 1], TOKEN_DECIMALS);

    let at = -1;
    for (let i = 0; i < entries && at < 0; i++) if (rate(i) >= threshold) at = i;
    if (at < 0) throw new Error(`the mint-rate table never reaches ${threshold.toFixed(3)} VVV per DIEM`);
    if (at === 0) throw new Error(`the mint rate already exceeds ${threshold.toFixed(3)} at the first bucket; the target cannot be bracketed`);
    const fraction = (threshold - rate(at - 1)) / (rate(at) - rate(at - 1));
    return onchain(ctx, supply(at - 1) + fraction * (supply(at) - supply(at - 1)));
  },
};

/** Cross-check only: staker distribution over total emissions, from Venice's vvv_staking_yield. */
const stakerShareFromApi: AdapterDef = {
  name: 'vvv.staker_share_from_api',
  needsRpc: false,
  async run(ctx, params) {
    const url = requiredUrl(params);
    const body = (await ctx.http.getJson(url)) as Record<string, unknown> | null;
    const stakers = toFiniteNumber(body?.stakerDistributionCryptoBaseUnit);
    const total = toFiniteNumber(body?.totalEmissionsCryptoBaseUnit);
    if (stakers === null || total === null || !(total > 0)) throw new Error(`${url}: stakerDistribution or totalEmissions is missing or not positive`);
    return { kind: 'level', value: stakers / total, observedAt: ctx.nowIso, source: 'api', detail: `${url} stakerDistribution / totalEmissions` };
  },
};

/** Cross-check only: Venice's monthly burn history in tokens, for the monthly_sum comparison. */
const burnHistoryTokens: AdapterDef = {
  name: 'vvv.burn_history_tokens',
  needsRpc: false,
  async run(ctx, params) {
    const url = requiredUrl(params);
    const history = ((await ctx.http.getJson(url)) as { burnHistory?: unknown } | null)?.burnHistory;
    if (!Array.isArray(history)) throw new Error(`${url}: no burnHistory array`);
    const points = history.map((entry) => {
      const e = entry as { yearMonth?: unknown; burnedCryptoBaseUnit?: unknown } | null;
      const burned = toFiniteNumber(e?.burnedCryptoBaseUnit);
      if (typeof e?.yearMonth !== 'string' || !/^\d{4}-\d{2}$/.test(e.yearMonth) || burned === null) {
        throw new Error(`${url}: malformed burnHistory entry ${JSON.stringify(entry)}`);
      }
      return { month: e.yearMonth, value: burned / 10 ** TOKEN_DECIMALS };
    });
    return { kind: 'monthly_series', points, detail: `${url} burnHistory[].burnedCryptoBaseUnit` };
  },
};

export const vvvAdapters: AdapterDef[] = [stakerEmissionShare, diemTargetSupply, stakerShareFromApi, burnHistoryTokens];
```

In `src/ingest/adapters/registry.ts`, replace:

```ts
import { OrionError } from '../../types.js';
import type { SourceContext, SourceValue } from '../types.js';
```

with:

```ts
import { OrionError } from '../../types.js';
import type { SourceContext, SourceValue } from '../types.js';
import { vvvAdapters } from './vvv.js';
```

Append to `src/ingest/adapters/registry.ts`:

```ts

// Asset-specific adapters register here, exactly as custom valuation modules do in the engine registry.
for (const adapter of vvvAdapters) registerAdapter(adapter);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/ingest && npm run typecheck`
Expected: PASS. (`vvv.ts` imports only a TYPE from `registry.ts`, so there is no runtime import cycle.)

- [ ] **Step 5: Commit**

```bash
git add src/ingest/adapters tests/ingest/adapters.vvv.test.ts
git commit -m "feat(ingest): VVV adapters for staker emission share, DIEM target supply, and two API cross-checks"
```

### Task 16: `burn_momentum` and the `revenue_disclosure_stale` alert

Spec section 7.

- `usage_index` for VVV is `derived` `burn_momentum` with params `{ metric: flow_usd.burn_programmatic, days: 30 }`: the mean USD per day over 30 consecutive completed days of that flow metric's stored daily on-chain rows. It is written as a LEVEL observation stamped at the last day's period end (the following UTC midnight), source `onchain`, and ONLY when all 30 days are present. It is not a revenue estimate and never feeds a valuation module.
- **Deliberate extension of the spec:** the spec writes the index for the newest day only. This task writes it for EVERY day that has 30 complete days behind it and no index row yet. Each value is still derived only from real rows. Without the history, the alert below has nothing near the disclosure date to compare against until a month after the first backfill. Flag this to the user at the Task 21 checkpoint.
- `revenue_disclosure_stale` (advisory): let `t0` be the `observed_at` of the revenue observation in force (confirmed, or provisional when the metric allows it), `u0` the `usage_index` value nearest `t0` within 7 days, and `u1` the latest. If `abs(u1 / u0 - 1) * 100 > revenue_stale_move_pct`, raise the anomaly on `revenue_run_rate_usd` with both values and dates; `dedupe_key` is `t0`, so a new disclosure starts a new anomaly. If no index value lies within 7 days of `t0`, the check uses the EARLIEST available index value and says so in the detail (`basis: 'earliest_available'`).
- Both run inside `fetchAsset`, after the scans. On a dry run nothing is written, and the alert is evaluated over stored rows plus the rows the run would write.
- `derived` names are validated by `buildPlan` (`unknown_derived`); bad params are `invalid_source_config`.

**Files:**
- Create: `src/ingest/derived.ts`, `src/ingest/alerts.ts`, `tests/ingest/derived.test.ts`
- Modify: `src/ingest/plan.ts`, `src/ingest/run.ts`

**Interfaces:**
- Consumes: `storedDailyFlow`, `raise`, `outcomeOf`, `scannedDaily` (inside `fetchAsset`, Tasks 11 and 13); `revenueStaleMovePct` (Task 4); `latestLevel` (`src/drivers/select.ts`); `STD_METRICS`.
- Produces (`src/ingest/derived.ts`):

```ts
export const DERIVED_NAMES: readonly string[]                                   // ['burn_momentum']
export function burnMomentum(days: Map<string, number>, windowDays: number): { day: string; value: number }[]   // every day with a full window behind it, oldest first
```

- Produces (`src/ingest/alerts.ts`):

```ts
export interface IndexPoint { observedAt: string; value: number }
export interface StaleRevenueFinding { moveAbsPct: number; detail: Record<string, unknown> }
export function checkRevenueStale(revenueObservedAt: string, index: IndexPoint[], movePct: number): StaleRevenueFinding | null
```

- [ ] **Step 1: Write the failing test**

Create `tests/ingest/derived.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseAssetYaml } from '../../src/config/load.js';
import { insertObservation, listActiveObservations } from '../../src/db/observations.js';
import { checkRevenueStale } from '../../src/ingest/alerts.js';
import { burnMomentum } from '../../src/ingest/derived.js';
import { buildPlan } from '../../src/ingest/plan.js';
import { fetchAsset } from '../../src/ingest/run.js';
import { addDays } from '../../src/ingest/time.js';
import type { OrionError } from '../../src/types.js';
import { harness, NOW } from '../helpers/fetchHarness.js';
import { INGEST_ASSET_YAML } from '../helpers/ingestAsset.js';

const days = (first: string, values: number[]) => new Map(values.map((v, i) => [addDays(first, i), v] as const));
const iso = (day: string) => `${day}T00:00:00.000Z`;

describe('burnMomentum', () => {
  it('is the mean per day over a full window, for every day that has one', () => {
    expect(burnMomentum(days('2026-09-01', [10, 20, 30, 40]), 3)).toEqual([{ day: '2026-09-03', value: 20 }, { day: '2026-09-04', value: 30 }]);
  });
  it('writes nothing until the window is complete, and nothing across a gap', () => {
    expect(burnMomentum(days('2026-09-01', [10, 20]), 3)).toEqual([]);
    const gapped = days('2026-09-01', [10, 20, 30, 40, 50]);
    gapped.delete('2026-09-03');
    expect(burnMomentum(gapped, 2)).toEqual([{ day: '2026-09-02', value: 15 }, { day: '2026-09-05', value: 45 }]);
  });
  it('counts a zero-burn day as a real reading', () => {
    expect(burnMomentum(days('2026-09-01', [0, 0, 30]), 3)).toEqual([{ day: '2026-09-03', value: 10 }]);
  });
});

describe('checkRevenueStale', () => {
  const index = [
    { observedAt: iso('2026-08-10'), value: 90 },
    { observedAt: iso('2026-08-16'), value: 100 },
    { observedAt: iso('2026-08-20'), value: 105 },
    { observedAt: iso('2026-09-19'), value: 140 },
  ];

  it('compares the latest index with the one nearest the disclosure, within seven days', () => {
    const found = checkRevenueStale(iso('2026-08-17'), index, 30)!;
    expect(found.moveAbsPct).toBeCloseTo(40, 9);
    expect(found.detail).toMatchObject({
      revenue_observed_at: iso('2026-08-17'), basis: 'near_disclosure', threshold_pct: 30,
      index_at_disclosure: { value: 100, observed_at: iso('2026-08-16') }, index_latest: { value: 140, observed_at: iso('2026-09-19') },
    });
    expect((found.detail.move_pct as number)).toBeCloseTo(40, 9);
  });

  it('stays quiet at or below the threshold, and fires on a fall as well as a rise', () => {
    expect(checkRevenueStale(iso('2026-08-17'), index, 40)).toBeNull();
    const fallen = [...index.slice(0, 3), { observedAt: iso('2026-09-19'), value: 60 }];
    expect(checkRevenueStale(iso('2026-08-17'), fallen, 30)!.detail.move_pct).toBeCloseTo(-40, 9);
  });

  it('falls back to the earliest index value when none is within seven days, and says so', () => {
    const found = checkRevenueStale(iso('2026-06-01'), index, 30)!;
    expect(found.detail).toMatchObject({ basis: 'earliest_available', index_at_disclosure: { value: 90, observed_at: iso('2026-08-10') } });
    expect(String(found.detail.note)).toMatch(/earliest available/);
  });

  it('has nothing to say without an index, with a single point, or with a non-positive base', () => {
    expect(checkRevenueStale(iso('2026-08-17'), [], 30)).toBeNull();
    expect(checkRevenueStale(iso('2026-08-17'), [index[1]], 30)).toBeNull();
    expect(checkRevenueStale(iso('2026-08-17'), [{ observedAt: iso('2026-08-17'), value: 0 }, index[3]], 30)).toBeNull();
  });
});

describe('fetchAsset: derived metrics and the stale-revenue alert', () => {
  const WITH_INDEX = INGEST_ASSET_YAML.replace(
    '  staker_emission_share: { type: level, unit: ratio, staleness_days: 30 }',
    '  staker_emission_share: { type: level, unit: ratio, staleness_days: 30 }\n' +
      '  usage_index: { type: level, unit: usd_per_day, staleness_days: 7, source: { type: derived, name: burn_momentum, params: { metric: flow_usd.fees_programmatic, days: 3 } } }',
  ).replace('revenue_run_rate_usd: { type: level, unit: usd, staleness_days: 60, critical: true }', 'revenue_run_rate_usd: { type: level, unit: usd, staleness_days: 60, critical: true, allow_provisional: true }');

  /** Stored daily rows for the programmatic flow: `values[i]` covers the day `first + i`. */
  const seedDaily = (db: Parameters<typeof insertObservation>[0], first: string, values: number[]) =>
    values.forEach((value, i) =>
      insertObservation(db, { assetId: 'mini', metricKey: 'flow_usd.fees_programmatic', observedAt: addDays(first, i + 1), periodDays: 1, value, source: 'onchain', fetchedAt: NOW.toISOString() }),
    );

  it('validates derived names and params as configuration', async () => {
    const codeOf = async (fn: () => unknown) => Promise.resolve().then(fn).then(() => undefined, (e: unknown) => (e as OrionError).code);
    expect(await codeOf(() => buildPlan(parseAssetYaml(WITH_INDEX.replace('name: burn_momentum', 'name: nope')).config))).toBe('unknown_derived');
    const h = harness({ loaded: parseAssetYaml(WITH_INDEX.replace('metric: flow_usd.fees_programmatic', 'metric: price_usd')) });
    expect(await codeOf(() => fetchAsset(h.db, h.loaded, NOW, h.deps))).toBe('invalid_source_config');
  });

  it('writes the index for every day with a full window and no index row yet, stamped at the period end', async () => {
    const h = harness({ loaded: parseAssetYaml(WITH_INDEX) });
    seedDaily(h.db, '2026-09-10', [30, 60, 90, 120, 150, 180]); // days 10..15; the scan then adds zeros for 16, 17, 18
    const r = await fetchAsset(h.db, h.loaded, NOW, h.deps);
    const index = listActiveObservations(h.db, 'mini', 'usage_index');
    expect(index.map((o) => [o.observedAt.slice(0, 10), o.value])).toEqual([
      ['2026-09-13', 60], ['2026-09-14', 90], ['2026-09-15', 120], ['2026-09-16', 150], ['2026-09-17', 110], ['2026-09-18', 60], ['2026-09-19', 0],
    ]);
    expect(index[0]).toMatchObject({ source: 'onchain', periodDays: null, sourceDetail: 'derived burn_momentum(flow_usd.fees_programmatic, 3d)' });
    expect(r.sources.find((s) => s.sourceId === 'derived:burn_momentum')).toMatchObject({ status: 'ok', metricsWritten: ['usage_index'] });

    const again = await fetchAsset(h.db, h.loaded, NOW, h.deps);
    expect(again.written.filter((w) => w.metricKey === 'usage_index')).toEqual([]);
    expect(again.sources.find((s) => s.sourceId === 'derived:burn_momentum')!.notes).toEqual(['usage_index: no new day with 3 complete days behind it']);
    expect(listActiveObservations(h.db, 'mini', 'usage_index')).toHaveLength(7);
  });

  it('raises the advisory alert when usage has moved since the revenue disclosure, once per disclosure', async () => {
    const h = harness({ loaded: parseAssetYaml(WITH_INDEX) });
    seedDaily(h.db, '2026-09-10', [100, 100, 100, 100, 100, 100]);
    insertObservation(h.db, {
      assetId: 'mini', metricKey: 'revenue_run_rate_usd', observedAt: '2026-09-14', value: 1000, source: 'manual', status: 'provisional',
      citationUrl: 'https://example.com', fetchedAt: NOW.toISOString(),
    });
    const r = await fetchAsset(h.db, h.loaded, NOW, h.deps);
    // index: 100 through 2026-09-16, then 66.7, 33.3, 0 as three zero-burn days roll in. Nearest the disclosure: 100. Latest: 0.
    const alert = r.anomalies.find((a) => a.kind === 'revenue_disclosure_stale')!;
    expect(alert).toMatchObject({ metricKey: 'revenue_run_rate_usd', severity: 'advisory', dedupeKey: '2026-09-14T00:00:00.000Z' });
    expect(alert.detail).toMatchObject({ basis: 'near_disclosure', threshold_pct: 30, index_at_disclosure: { value: 100 }, index_latest: { value: 0 } });
  });

  it('evaluates a dry run over the rows it would write, and writes none', async () => {
    const h = harness({ loaded: parseAssetYaml(WITH_INDEX) });
    seedDaily(h.db, '2026-09-10', [100, 100, 100, 100, 100, 100]);
    insertObservation(h.db, { assetId: 'mini', metricKey: 'revenue_run_rate_usd', observedAt: '2026-09-14', value: 1000, source: 'manual', fetchedAt: NOW.toISOString() });
    const r = await fetchAsset(h.db, h.loaded, NOW, h.deps, { dryRun: true });
    expect(listActiveObservations(h.db, 'mini', 'usage_index')).toEqual([]);
    expect(r.written.filter((w) => w.metricKey === 'usage_index')).toHaveLength(7);
    expect(r.anomalies.find((a) => a.kind === 'revenue_disclosure_stale')).toMatchObject({ id: null });
  });

  it('does nothing for an asset without a usage_index metric', async () => {
    const h = harness();
    const r = await fetchAsset(h.db, h.loaded, NOW, h.deps);
    expect(r.sources.some((s) => s.sourceId.startsWith('derived:'))).toBe(false);
    expect(r.anomalies).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/ingest/derived.test.ts`
Expected: FAIL (cannot find `src/ingest/derived.js` and `src/ingest/alerts.js`).

- [ ] **Step 3: Implement**

Create `src/ingest/derived.ts`:

```ts
import { addDays } from './time.js';

/** Derived metrics are computed from stored observations after the fetch phase. */
export const DERIVED_NAMES: readonly string[] = ['burn_momentum'];

/**
 * Mean value per day over `windowDays` consecutive days, for every day that has a complete window
 * ending on it. `days` maps a UTC day to that day's flow. A missing day breaks the window: nothing
 * is filled in. Oldest first.
 */
export function burnMomentum(days: Map<string, number>, windowDays: number): { day: string; value: number }[] {
  const out: { day: string; value: number }[] = [];
  for (const day of [...days.keys()].sort()) {
    let sum = 0;
    let complete = true;
    for (let i = 0; i < windowDays && complete; i++) {
      const v = days.get(addDays(day, -i));
      if (v === undefined) complete = false;
      else sum += v;
    }
    if (complete) out.push({ day, value: sum / windowDays });
  }
  return out;
}
```

Create `src/ingest/alerts.ts`:

```ts
import { MS_PER_DAY } from '../types.js';

export interface IndexPoint {
  observedAt: string;
  value: number;
}

export interface StaleRevenueFinding {
  moveAbsPct: number;
  detail: Record<string, unknown>;
}

const NEAR_DAYS = 7;

/**
 * Has usage moved enough since the revenue disclosure that the disclosed figure looks stale?
 * Compares the latest usage index with the one nearest the disclosure (within seven days), or,
 * when there is none, with the earliest available one, and says which. Pure.
 */
export function checkRevenueStale(revenueObservedAt: string, index: IndexPoint[], movePct: number): StaleRevenueFinding | null {
  if (index.length < 2) return null;
  const sorted = [...index].sort((a, b) => (a.observedAt < b.observedAt ? -1 : a.observedAt > b.observedAt ? 1 : 0));
  const t0 = new Date(revenueObservedAt).getTime();
  const distance = (p: IndexPoint) => Math.abs(new Date(p.observedAt).getTime() - t0);

  let base: IndexPoint | null = null;
  for (const p of sorted) {
    if (distance(p) <= NEAR_DAYS * MS_PER_DAY && (base === null || distance(p) < distance(base))) base = p;
  }
  const basis = base === null ? 'earliest_available' : 'near_disclosure';
  base ??= sorted[0];
  const latest = sorted[sorted.length - 1];
  if (latest === base || !(base.value > 0)) return null;

  const move = (latest.value / base.value - 1) * 100;
  if (!(Math.abs(move) > movePct)) return null;
  return {
    moveAbsPct: Math.abs(move),
    detail: {
      revenue_observed_at: revenueObservedAt,
      index_at_disclosure: { value: base.value, observed_at: base.observedAt },
      index_latest: { value: latest.value, observed_at: latest.observedAt },
      move_pct: move,
      threshold_pct: movePct,
      basis,
      note:
        basis === 'earliest_available'
          ? `no usage_index value lies within ${NEAR_DAYS} days of the disclosure; compared against the earliest available one instead`
          : 'usage_index has moved since the revenue figure was disclosed; the disclosed revenue may be stale',
    },
  };
}
```

In `src/ingest/plan.ts`, replace:

```ts
import { getAdapter } from './adapters/registry.js';
import { sourceId } from './sourceId.js';
```

with:

```ts
import { getAdapter } from './adapters/registry.js';
import { DERIVED_NAMES } from './derived.js';
import { sourceId } from './sourceId.js';
```

In `src/ingest/plan.ts`, replace:

```ts
    if (s.type === 'derived') {
      derived.push({ metricKey, role: 'primary', source: s, tolerancePct: def.tolerance_pct });
```

with:

```ts
    if (s.type === 'derived') {
      if (!DERIVED_NAMES.includes(s.name)) throw new OrionError('unknown_derived', `metrics.${metricKey}: unknown derived source "${s.name}"`);
      derived.push({ metricKey, role: 'primary', source: s, tolerancePct: def.tolerance_pct });
```

In `src/ingest/run.ts`, replace:

```ts
import { compareLevel, compareMonthly } from './crosscheck.js';
import { scanFlowGroup } from './flow.js';
```

with:

```ts
import { revenueStaleMovePct } from '../config/schema.js';
import { latestLevel } from '../drivers/select.js';
import { STD_METRICS } from '../types.js';
import { checkRevenueStale, type IndexPoint } from './alerts.js';
import { compareLevel, compareMonthly } from './crosscheck.js';
import { burnMomentum } from './derived.js';
import { scanFlowGroup } from './flow.js';
```

In `src/ingest/run.ts`, replace:

```ts
  // [Task 16 inserts the derived metrics and the stale-revenue alert here]
```

with:

```ts
  // 6. Derived metrics, from stored observations plus this run's days (so a dry run sees them too).
  const derivedIndex: IndexPoint[] = [];
  for (const r of plan.derived) {
    if (r.source.type !== 'derived') continue;
    const outcome = outcomeOf(sourceId(r.source));
    const flowMetric = r.source.params.metric;
    const windowDays = r.source.params.days ?? 30;
    if (typeof flowMetric !== 'string' || asset.metrics[flowMetric]?.type !== 'flow') {
      throw new OrionError('invalid_source_config', `metrics.${r.metricKey}: burn_momentum needs "metric" to name a flow metric`);
    }
    if (typeof windowDays !== 'number' || !Number.isInteger(windowDays) || windowDays < 1) {
      throw new OrionError('invalid_source_config', `metrics.${r.metricKey}: burn_momentum "days" must be a positive integer`);
    }
    const days = storedDailyFlow(db, asset.id, flowMetric);
    for (const p of scannedDaily.get(flowMetric) ?? []) days.set(p.day, p.value);
    const have = new Set(listActiveObservations(db, asset.id, r.metricKey).map((o) => o.observedAt));
    let wrote = 0;
    for (const point of burnMomentum(days, windowDays)) {
      const observedAt = new Date(new Date(`${point.day}T00:00:00.000Z`).getTime() + MS_PER_DAY).toISOString(); // the day's period end
      if (have.has(observedAt)) continue;
      const observationId = dryRun
        ? null
        : insertObservation(db, {
            assetId: asset.id, metricKey: r.metricKey, observedAt, value: point.value, source: 'onchain',
            sourceDetail: `derived burn_momentum(${flowMetric}, ${windowDays}d)`, fetchedAt: startedAt,
          }).id;
      written.push({ metricKey: r.metricKey, value: point.value, observedAt, periodDays: null, source: 'onchain', observationId });
      if (r.metricKey === STD_METRICS.usageIndex) derivedIndex.push({ observedAt, value: point.value });
      wrote++;
    }
    if (wrote > 0) outcome.metricsWritten.push(r.metricKey);
    else outcome.notes.push(`${r.metricKey}: no new day with ${windowDays} complete days behind it`);
  }

  // 7. The stale-revenue alert: advisory, and only for assets that define a usage index.
  const revenueDef = asset.metrics[STD_METRICS.revenue];
  if (asset.metrics[STD_METRICS.usageIndex] !== undefined && revenueDef !== undefined) {
    const usable = listActiveObservations(db, asset.id, STD_METRICS.revenue).filter((o) => o.status === 'confirmed' || revenueDef.allow_provisional);
    const revenue = latestLevel(usable, startedAt);
    if (revenue) {
      const stored = listActiveObservations(db, asset.id, STD_METRICS.usageIndex).map((o) => ({ observedAt: o.observedAt, value: o.value }));
      const index = dryRun ? [...stored, ...derivedIndex] : stored; // a real run has already stored them
      const finding = checkRevenueStale(revenue.observedAt, index, revenueStaleMovePct(asset));
      if (finding) {
        raise({ kind: 'revenue_disclosure_stale', metricKey: STD_METRICS.revenue, dedupeKey: revenue.observedAt, severity: 'advisory', detail: finding.detail });
      }
    }
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/ingest && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ingest tests/ingest/derived.test.ts
git commit -m "feat(ingest): burn_momentum usage index and the advisory revenue_disclosure_stale alert"
```

---

## Task group F: daily operation

### Task 17: Snapshot narrowing and latest-signal ordering

Two items deferred from sub-project 1 that daily fetching makes necessary (spec 10.1 and 10.2).

**Snapshot narrowing.** A snapshot freezes every active eligible observation, which grows without bound under daily fetching. It narrows to what drivers can use. The existing rules apply FIRST (a provisional row only when the metric allows it; a confirmed row beats a provisional one at the same metric and time). Then, per metric:

- `level`: the newest observation at or before `as_of`.
- `flow`: only metrics that a `holder_flows` entry references (informational flows such as `flow_tokens.burn` never reach a driver). Of those, every observation at or before `as_of` whose period end is after `newest period end - (window_days + 1 day)`. When two holder flows share a metric, the larger window wins.
- `schedule`: the step in force at `as_of` and every later step.
- `event`: every event after `as_of`.

Overlap detection in `computeDrivers` therefore sees only flow rows in that range, which removes the sub-project 1 follow-up where a long-past overlap blocked runs forever. Replay is unaffected: it loads by stored id. The narrowed snapshot must give byte-identical engine output to the full set.

**Latest signal.** "Latest" becomes the greatest `generated_at`, then the greatest id, so a backfilled `--as-of` run never becomes the signal that `emit` sends or that the next run compares against. `signals.emitted_at` already stores `generated_at`.

**Files:**
- Create: `src/app/eligibility.ts`, `tests/app/eligibility.test.ts`
- Modify: `src/app/valuation.ts`, `src/db/runs.ts`

**Interfaces:**
- Consumes: `listActiveObservations`, `Observation`; `latestLevel`, `buildSchedule` (`src/drivers/select.ts`).
- Produces (`src/app/eligibility.ts`):

```ts
export function narrowToUsable(asset: AssetConfig, observations: Observation[], asOf: string): Observation[]   // pure; sorted by (observedAt, id)
export function eligibleObservations(db: Db, asset: AssetConfig, asOf: string): Observation[]
```

  `runValuation` and `whatIf` call `eligibleObservations(db, asset, asOf)`; the private copy in `valuation.ts` is deleted.

- [ ] **Step 1: Write the failing test**

Create `tests/app/eligibility.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { eligibleObservations, narrowToUsable } from '../../src/app/eligibility.js';
import { replayRun, runValuation } from '../../src/app/valuation.js';
import { parseAssetYaml, type LoadedAsset } from '../../src/config/load.js';
import { createAssumptionSet } from '../../src/db/assumptions.js';
import { openDb, type Db } from '../../src/db/connection.js';
import { insertObservation } from '../../src/db/observations.js';
import { getLatestSignal, getSnapshot, listSignals } from '../../src/db/runs.js';
import { computeDrivers } from '../../src/drivers/compute.js';
import { runEngine } from '../../src/engine/run.js';
import { canonicalJson } from '../../src/util/canonical.js';
import { MINI_ASSET_YAML, miniAsset, miniAssumptions } from '../helpers/assets.js';
import { AS_OF, miniObservations, obs } from '../helpers/obs.js';

const DAY = 86_400_000;
const NOW = new Date(AS_OF);
const dayBefore = (n: number) => new Date(NOW.getTime() - n * DAY).toISOString();

/** 200 daily flow rows ending at AS_OF, 100 USD per year, plus 200 daily prices. */
function dailyHistory() {
  const list = miniObservations().filter((o) => o.metricKey !== 'flow_usd.fees' && o.metricKey !== 'price_usd');
  for (let n = 199; n >= 0; n--) {
    list.push(obs('flow_usd.fees', 100 / 365, dayBefore(n), { periodDays: 1 }));
    list.push(obs('price_usd', 10 + n / 1000, dayBefore(n + 0.5)));
  }
  return list;
}

describe('narrowToUsable', () => {
  const asset = miniAsset();

  it('keeps the newest level, the flow window plus a day, the schedule in force and later, and future events', () => {
    const list = [
      ...dailyHistory(),
      obs('emission_rate_annual', 5, '2025-01-01'),
      obs('emission_rate_annual', 3, '2026-08-01'),
      obs('scheduled_unlock_tokens', 7, '2026-05-01'),
      obs('scheduled_unlock_tokens', 9, '2026-12-01'),
    ];
    const withEvents = parseAssetYaml(MINI_ASSET_YAML.replace('holder_flows:', '  scheduled_unlock_tokens: { type: event, unit: tokens, staleness_days: 400 }\nholder_flows:')).config;
    const kept = narrowToUsable(withEvents, list, AS_OF);
    const of = (key: string) => kept.filter((o) => o.metricKey === key);
    expect(of('price_usd')).toHaveLength(1);
    expect(of('price_usd')[0].observedAt).toBe(dayBefore(0.5));
    expect(of('flow_usd.fees')).toHaveLength(91); // the 90-day window plus one day of margin
    expect(of('emission_rate_annual').map((o) => o.value)).toEqual([0, 3]); // in force since 2026-01-01, and the later step
    expect(of('scheduled_unlock_tokens').map((o) => o.value)).toEqual([9]);
    expect(kept.length).toBeLessThan(110);
    expect(kept.map((o) => [o.observedAt, o.id])).toEqual([...kept].sort((a, b) => (a.observedAt === b.observedAt ? a.id - b.id : a.observedAt < b.observedAt ? -1 : 1)).map((o) => [o.observedAt, o.id]));
  });

  it('gives byte-identical engine output to the full set', () => {
    const full = dailyHistory();
    const run = (list: typeof full) => canonicalJson(runEngine({ asset, drivers: computeDrivers(asset, list, AS_OF).drivers!, assumptions: miniAssumptions({ 'capture_ramp_years.fees': 5 }) }));
    expect(run(narrowToUsable(asset, full, AS_OF))).toBe(run(full));
    expect(computeDrivers(asset, narrowToUsable(asset, full, AS_OF), AS_OF)).toEqual(computeDrivers(asset, full, AS_OF));
  });

  it('drops flow metrics that no holder flow uses, and metrics the asset does not define', () => {
    const withInfo = parseAssetYaml(MINI_ASSET_YAML.replace('holder_flows:', '  flow_tokens.fees: { type: flow, unit: tokens, staleness_days: 45 }\nholder_flows:')).config;
    const list = [...miniObservations(), obs('flow_tokens.fees', 5, AS_OF, { periodDays: 1 }), obs('not_defined', 1, AS_OF)];
    const keys = new Set(narrowToUsable(withInfo, list, AS_OF).map((o) => o.metricKey));
    expect(keys.has('flow_tokens.fees')).toBe(false);
    expect(keys.has('not_defined')).toBe(false);
    expect(keys.has('flow_usd.fees')).toBe(true);
  });

  it('ignores observations after as_of, except schedule steps and events', () => {
    const list = [...miniObservations(), obs('price_usd', 99, '2026-07-05'), obs('flow_usd.fees', 50, '2026-07-05', { periodDays: 1 })];
    const kept = narrowToUsable(asset, list, AS_OF);
    expect(kept.some((o) => o.value === 99)).toBe(false);
    expect(kept.filter((o) => o.metricKey === 'flow_usd.fees')).toHaveLength(1);
  });
});

describe('runValuation on a narrowed snapshot', () => {
  let db: Db;
  let loaded: LoadedAsset;
  const store = (list: ReturnType<typeof miniObservations>) => {
    for (const o of list) insertObservation(db, { assetId: o.assetId, metricKey: o.metricKey, observedAt: o.observedAt, periodDays: o.periodDays, value: o.value, source: o.source, fetchedAt: o.fetchedAt });
  };

  beforeEach(() => {
    db = openDb(':memory:');
    loaded = parseAssetYaml(MINI_ASSET_YAML);
    createAssumptionSet(db, { assetId: 'mini', author: 'user', rationale: 'initial', values: miniAssumptions(), createdAt: AS_OF });
  });

  it('freezes only usable observations, and replays identically', () => {
    store(dailyHistory());
    const { runId, signal } = runValuation(db, loaded, NOW);
    expect(signal.status).toBe('ok');
    expect(getSnapshot(db, signal.provenance.snapshot_id)!.observationIds.length).toBeLessThan(110);
    expect(eligibleObservations(db, loaded.config, AS_OF)).toHaveLength(getSnapshot(db, signal.provenance.snapshot_id)!.observationIds.length);
    expect(replayRun(db, runId).identical).toBe(true);
  });

  it('is no longer blocked by an overlap far in the past', () => {
    store(miniObservations());
    store([obs('flow_usd.fees', 10, dayBefore(300), { periodDays: 30 }), obs('flow_usd.fees', 4, dayBefore(310), { periodDays: 10 })]);
    expect(runValuation(db, loaded, NOW).signal.status).toBe('ok');
  });

  it('is still blocked by an overlap inside the window', () => {
    store(miniObservations());
    store([obs('flow_usd.fees', 4, dayBefore(10), { periodDays: 5 })]);
    expect(runValuation(db, loaded, NOW).signal.status_reasons).toContain('overlapping_flow_periods:flow_usd.fees');
  });
});

describe('latest signal ordering', () => {
  it('never lets a backfilled --as-of run become the latest signal', () => {
    const db = openDb(':memory:');
    const loaded = parseAssetYaml(MINI_ASSET_YAML);
    for (const o of miniObservations()) insertObservation(db, { assetId: o.assetId, metricKey: o.metricKey, observedAt: o.observedAt, periodDays: o.periodDays, value: o.value, source: o.source, fetchedAt: o.fetchedAt });
    createAssumptionSet(db, { assetId: 'mini', author: 'user', rationale: 'initial', values: miniAssumptions(), createdAt: AS_OF });

    const today = runValuation(db, loaded, NOW).signal;
    const backfilled = runValuation(db, loaded, new Date(NOW.getTime() - 60_000)).signal; // stored later, generated earlier
    expect(getLatestSignal(db, 'mini')!.signal_id).toBe(today.signal_id);
    expect(listSignals(db, 'mini', 10).map((s) => s.signal_id)).toEqual([today.signal_id, backfilled.signal_id]);
    expect(backfilled.change.prev_signal_id).toBe(today.signal_id);

    const next = runValuation(db, loaded, new Date(NOW.getTime() + 60_000)).signal;
    expect(next.change.prev_signal_id).toBe(today.signal_id); // compared against the latest by time, not by insertion
  });

  it('breaks a tie on generated_at by the greater id', () => {
    const db = openDb(':memory:');
    const loaded = parseAssetYaml(MINI_ASSET_YAML);
    const first = runValuation(db, loaded, NOW).signal;
    const second = runValuation(db, loaded, NOW).signal;
    expect(first.generated_at).toBe(second.generated_at);
    expect(getLatestSignal(db, 'mini')!.signal_id).toBe(second.signal_id);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/app/eligibility.test.ts`
Expected: FAIL (cannot find `src/app/eligibility.js`).

- [ ] **Step 3: Implement**

Create `src/app/eligibility.ts`:

```ts
import type { AssetConfig } from '../config/schema.js';
import type { Db } from '../db/connection.js';
import { listActiveObservations, type Observation } from '../db/observations.js';
import { buildSchedule, latestLevel } from '../drivers/select.js';
import { MS_PER_DAY } from '../types.js';

const ms = (iso: string): number => new Date(iso).getTime();
const byTimeThenId = (a: Observation, b: Observation): number =>
  a.observedAt === b.observedAt ? a.id - b.id : a.observedAt < b.observedAt ? -1 : 1;

/**
 * Narrows eligible observations to what drivers can use at `asOf`, so a snapshot stays small under
 * daily fetching. Engine output must not change: everything dropped here is something computeDrivers
 * would ignore anyway. Pure.
 */
export function narrowToUsable(asset: AssetConfig, observations: Observation[], asOf: string): Observation[] {
  const byMetric = new Map<string, Observation[]>();
  for (const o of observations) byMetric.set(o.metricKey, [...(byMetric.get(o.metricKey) ?? []), o]);

  // Only flow metrics that a holder flow references ever reach a driver. The larger window wins when two share a metric.
  const windowDays = new Map<string, number>();
  for (const f of asset.holder_flows) windowDays.set(f.metric, Math.max(windowDays.get(f.metric) ?? 0, f.window_days));

  const kept: Observation[] = [];
  for (const [key, all] of byMetric) {
    const def = asset.metrics[key];
    if (!def) continue;
    const list = [...all].sort(byTimeThenId);
    if (def.type === 'level') {
      const newest = latestLevel(list, asOf);
      if (newest) kept.push(newest);
    } else if (def.type === 'schedule') {
      kept.push(...buildSchedule(list, asOf).used);
    } else if (def.type === 'event') {
      kept.push(...list.filter((o) => o.observedAt > asOf));
    } else {
      const window = windowDays.get(key);
      if (window === undefined) continue;
      const past = list.filter((o) => o.observedAt <= asOf);
      if (past.length === 0) continue;
      // One day of margin beyond the trailing window: every row the window can touch is inside.
      const rangeStart = Math.max(...past.map((o) => ms(o.observedAt))) - (window + 1) * MS_PER_DAY;
      kept.push(...past.filter((o) => ms(o.observedAt) > rangeStart));
    }
  }
  return kept.sort(byTimeThenId);
}

export function eligibleObservations(db: Db, asset: AssetConfig, asOf: string): Observation[] {
  const active = listActiveObservations(db, asset.id).filter((o) => {
    const def = asset.metrics[o.metricKey];
    return def !== undefined && (o.status === 'confirmed' || def.allow_provisional);
  });
  // A confirmed and a provisional row can both be active at one key. Confirmed data wins, which
  // also keeps flows from counting the same period twice.
  const key = (o: Observation) => `${o.metricKey}@${o.observedAt}`;
  const confirmedKeys = new Set(active.filter((o) => o.status === 'confirmed').map(key));
  const eligible = active.filter((o) => o.status !== 'provisional' || !confirmedKeys.has(key(o)));
  return narrowToUsable(asset, eligible, asOf);
}
```

In `src/app/valuation.ts`, replace:

```ts
function eligibleObservations(db: Db, asset: AssetConfig): Observation[] {
  const active = listActiveObservations(db, asset.id).filter((o) => {
    const def = asset.metrics[o.metricKey];
    return def !== undefined && (o.status === 'confirmed' || def.allow_provisional);
  });
  // A confirmed and a provisional row can both be active at one key. Confirmed data wins, which
  // also keeps flows from counting the same period twice.
  const key = (o: Observation) => `${o.metricKey}@${o.observedAt}`;
  const confirmedKeys = new Set(active.filter((o) => o.status === 'confirmed').map(key));
  return active.filter((o) => o.status !== 'provisional' || !confirmedKeys.has(key(o)));
}

```

with:

```ts
```

In `src/app/valuation.ts`, replace:

```ts
import { getObservationsByIds, listActiveObservations, type Observation } from '../db/observations.js';
```

with:

```ts
import { getObservationsByIds } from '../db/observations.js';
```

In `src/app/valuation.ts`, replace:

```ts
import { OrionError, SCENARIOS, STD_METRICS, type AssumptionValues, type Scenario } from '../types.js';
import { canonicalJson } from '../util/canonical.js';
```

with:

```ts
import { OrionError, SCENARIOS, STD_METRICS, type AssumptionValues, type Scenario } from '../types.js';
import { canonicalJson } from '../util/canonical.js';
import { eligibleObservations } from './eligibility.js';
```

In `src/app/valuation.ts`, replace:

```ts
    const observations = eligibleObservations(db, asset);
```

with:

```ts
    const observations = eligibleObservations(db, asset, asOf);
```

In `src/app/valuation.ts`, replace:

```ts
  const report = computeDrivers(asset, eligibleObservations(db, asset), asOf, requiredExtraMetrics(asset));
```

with:

```ts
  const report = computeDrivers(asset, eligibleObservations(db, asset, asOf), asOf, requiredExtraMetrics(asset));
```

In `src/db/runs.ts`, replace:

```ts
  const rows = db.prepare('SELECT payload_json FROM signals WHERE asset_id = ? ORDER BY id DESC LIMIT ?').all(assetId, limit) as {
```

with:

```ts
  // Newest by generated_at (stored in emitted_at), then by id: a backfilled --as-of run never becomes "latest".
  const rows = db.prepare('SELECT payload_json FROM signals WHERE asset_id = ? ORDER BY emitted_at DESC, id DESC LIMIT ?').all(assetId, limit) as {
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test && npm run typecheck`
Expected: PASS, including every existing test in `tests/app/valuation.test.ts` and the VVV golden test (the golden test calls `computeDrivers` directly and is unaffected).

- [ ] **Step 5: Commit**

```bash
git add src/app src/db/runs.ts tests/app/eligibility.test.ts
git commit -m "feat(app): snapshots freeze only usable observations; the latest signal is the newest by generated_at"
```

### Task 18: CLI: `data fetch`, `data sources`, `data anomalies`, `data resolve`, `data ack`

Spec section 9.

```
orion data fetch [asset] [--metric key ...] [--backfill-days n] [--adopt] [--dry-run]
orion data sources <asset>
orion data anomalies [asset] [--all]
orion data resolve <id> --note text
orion data ack <id> --note text
```

- `data fetch` with no asset fetches every asset that has at least one `source`, one after another; its JSON output is then an ARRAY of results. With an asset, the JSON output is that one result.
- Scan progress goes to `ctx.stderr` (never to stdout, which may be JSON). Tests leave `stderr` unset and nothing is printed.
- Configuration: `ORION_BASE_RPC_URL` and `COINGECKO_API_KEY` are read from the process environment and from `<ORION_HOME>/.env` when present. The process environment wins. `.env` is already git-ignored. No `dotenv` dependency: the format is `KEY=value` lines, optional `export `, optional single or double quotes, `#` comments.
- `CliContext` gains three OPTIONAL members, so every existing test keeps compiling: `ingestDeps?: () => FetchDeps` (tests inject fakes; the default builds the real transports), `stderr?: (line: string) => void`, `setExitCode?: (code: number) => void` (used by Task 19).
- `data sources` shows, per metric that has a source: source type and id, cross-checks with their tolerances, the last fetch outcome of that source (looked up in the last 20 fetch runs), and the age of the value in force.

**Files:**
- Create: `src/cli/env.ts`, `src/ingest/deps.ts`, `src/ingest/describe.ts`, `tests/cli/env.test.ts`, `tests/cli/ingest.cli.test.ts`
- Modify: `src/cli/util.ts`, `src/cli/commands/data.ts`, `src/cli/index.ts`

**Interfaces:**
- Consumes: `fetchAsset`, `FetchDeps`, `FetchResult` (Task 11); `hasSources` (Task 10); `sourceId` (Task 7); `listFetchRuns` (Task 2); `listAnomalies`, `decideAnomaly` (Task 3); `createHttpTransport`, `realHttpDeps` (Task 5); `createViemRpc` (Task 6); `harness` (Task 11).
- Produces:
  - `src/cli/env.ts`: `parseEnvFile(text: string): Record<string, string>`, `loadEnv(home: string, processEnv: Record<string, string | undefined>): Record<string, string | undefined>`.
  - `src/ingest/deps.ts`: `realFetchDeps(env: Record<string, string | undefined>, now: () => Date): FetchDeps`.
  - `src/ingest/describe.ts`: `describeSources(db: Db, asset: AssetConfig, now: Date): SourceRow[]` with `interface SourceRow { metric: string; type: string; sourceId: string; crossChecks: { sourceId: string; tolerancePct: number }[]; lastFetch: { at: string; status: SourceStatus; error: string | null } | null; valueInForce: { value: number; observedAt: string; ageDays: number } | null }`.
  - `src/cli/util.ts`: `CliContext` gains `ingestDeps?`, `stderr?`, `setExitCode?`; new `withDbAsync<T>(ctx, fn: (db: Db) => Promise<T>): Promise<T>`, `ingestDepsFor(ctx: CliContext): FetchDeps`, `fetchSummary(r: FetchResult): string[]`.

- [ ] **Step 1: Write the failing tests**

Create `tests/cli/env.test.ts`:

```ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadEnv, parseEnvFile } from '../../src/cli/env.js';

describe('.env loading', () => {
  it('parses KEY=value lines with comments, export, and quotes', () => {
    const text = ['# comment', '', 'A=1', 'export B="two words"', "C='x=y'", 'D = spaced ', 'not a line', 'E='].join('\n');
    expect(parseEnvFile(text)).toEqual({ A: '1', B: 'two words', C: 'x=y', D: 'spaced', E: '' });
  });

  it('lets the process environment win over <ORION_HOME>/.env, and works without a file', () => {
    const home = mkdtempSync(join(tmpdir(), 'orion-env-'));
    expect(loadEnv(home, { X: 'proc' })).toEqual({ X: 'proc' });
    writeFileSync(join(home, '.env'), 'ORION_BASE_RPC_URL=https://rpc.example\nX=file\n');
    expect(loadEnv(home, { X: 'proc' })).toEqual({ ORION_BASE_RPC_URL: 'https://rpc.example', X: 'proc' });
  });
});
```

Create `tests/cli/ingest.cli.test.ts`:

```ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildProgram } from '../../src/cli/program.js';
import { harness, NOW, STATS } from '../helpers/fetchHarness.js';
import type { Route } from '../helpers/fakeHttp.js';
import { INGEST_ASSET_YAML } from '../helpers/ingestAsset.js';

let home: string;
let routes: Record<string, Route>;
let stderr: string[];

async function orion(...args: string[]): Promise<string> {
  const lines: string[] = [];
  const h = harness({ routes });
  const program = buildProgram({ home, stdout: (l) => lines.push(l), now: () => NOW, ingestDeps: () => h.deps, stderr: (l) => stderr.push(l) });
  await program.parseAsync(args, { from: 'user' });
  return lines.join('\n');
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'orion-ingest-cli-'));
  routes = {};
  stderr = [];
  await orion('init');
  writeFileSync(join(home, 'assets', 'mini.yaml'), INGEST_ASSET_YAML);
});

describe('orion data fetch', () => {
  it('fetches one asset, writes observations, and reports each source', async () => {
    const result = JSON.parse(await orion('data', 'fetch', 'mini', '--json'));
    expect(result.outcome).toBe('ok');
    expect(result.sources.map((s: { sourceId: string }) => s.sourceId)).toContain('coingecko');
    const shown = JSON.parse(await orion('data', 'show', 'mini', 'price_usd', '--json'));
    expect(shown[0]).toMatchObject({ value: 10, source: 'api' });
    expect(stderr.some((l) => /transfer_flow.*2026-09-18: 0 transfers/.test(l))).toBe(true);
  });

  it('prints a readable summary', async () => {
    const text = await orion('data', 'fetch', 'mini');
    expect(text).toMatch(/^MINI fetch ok$/m);
    expect(text).toMatch(/ok\s+coingecko\s+wrote price_usd, circulating_supply/);
    expect(text).toMatch(/check price_usd vs http_json:.*10 vs 10\.1 \(1\.00% within 2%\)/);
  });

  it('with no asset, fetches every asset that has a source and returns an array', async () => {
    writeFileSync(join(home, 'assets', 'manual.yaml'), (await import('../helpers/assets.js')).MINI_ASSET_YAML.replace('id: mini', 'id: manual'));
    const results = JSON.parse(await orion('data', 'fetch', '--dry-run', '--json'));
    expect(results.map((r: { assetId: string }) => r.assetId)).toEqual(['mini']);
    expect(results[0].dryRun).toBe(true);
    expect(JSON.parse(await orion('data', 'show', 'mini', '--json'))).toEqual([]);
  });

  it('narrows with repeatable --metric and validates --backfill-days', async () => {
    const result = JSON.parse(await orion('data', 'fetch', 'mini', '--metric', 'price_usd', '--metric', 'circulating_supply', '--json'));
    expect(result.written.map((w: { metricKey: string }) => w.metricKey)).toEqual(['price_usd', 'circulating_supply']);
    await expect(orion('data', 'fetch', 'mini', '--backfill-days', 'abc')).rejects.toThrow(/--backfill-days/);
    await expect(orion('data', 'fetch', 'mini', '--backfill-days', '0')).rejects.toThrow(/positive whole number/);
    await expect(orion('data', 'fetch', 'mini', '--metric', 'nope')).rejects.toThrow(/not defined/);
  });

  it('explains conflicts, and adopts with --adopt', async () => {
    await orion('data', 'set', 'mini', 'flow_usd.fees', '5000', '--at', '2026-09-18', '--period-days', '30');
    const refused = await orion('data', 'fetch', 'mini');
    expect(refused).toMatch(/^MINI fetch partial$/m);
    expect(refused).toMatch(/skipped\s+transfer_flow/);
    expect(refused).toMatch(/conflict #\d+ flow_usd\.fees manual .*adoptable/);
    expect(refused).toMatch(/--adopt/);
    const adopted = JSON.parse(await orion('data', 'fetch', 'mini', '--adopt', '--json'));
    expect(adopted.sources.find((s: { sourceId: string }) => s.sourceId.startsWith('transfer_flow')).retiredObservationIds).toHaveLength(1);
  });
});

describe('orion data sources', () => {
  it('shows each sourced metric, its cross-checks, the last fetch outcome, and the age of the value in force', async () => {
    const before = JSON.parse(await orion('data', 'sources', 'mini', '--json'));
    expect(before.find((r: { metric: string }) => r.metric === 'price_usd')).toEqual({
      metric: 'price_usd', type: 'coingecko', sourceId: 'coingecko', crossChecks: [{ sourceId: `http_json:${STATS}`, tolerancePct: 2 }],
      lastFetch: null, valueInForce: null,
    });
    expect(before.some((r: { metric: string }) => r.metric === 'revenue_run_rate_usd')).toBe(false);

    await orion('data', 'fetch', 'mini');
    const after = JSON.parse(await orion('data', 'sources', 'mini', '--json'));
    const price = after.find((r: { metric: string }) => r.metric === 'price_usd');
    expect(price.lastFetch).toEqual({ at: NOW.toISOString(), status: 'ok', error: null });
    expect(price.valueInForce).toEqual({ value: 10, observedAt: NOW.toISOString(), ageDays: 0 });
    const flow = after.find((r: { metric: string }) => r.metric === 'flow_usd.fees');
    expect(flow.valueInForce.ageDays).toBeCloseTo(0.5, 9); // the last complete day ended at midnight, twelve hours before NOW
    expect(await orion('data', 'sources', 'mini')).toMatch(/price_usd\s+coingecko\s+last fetch ok\s+value 10 \(0\.0 days old\)/);
  });
});

describe('orion data anomalies, resolve, ack', () => {
  it('lists open anomalies, then hides them once they are decided', async () => {
    routes = { [STATS]: { price: 12, supply: { totalBaseUnit: (100n * 10n ** 18n).toString() } } };
    await orion('data', 'fetch', 'mini');
    const open = JSON.parse(await orion('data', 'anomalies', '--json'));
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ assetId: 'mini', kind: 'cross_check_mismatch', metricKey: 'price_usd', severity: 'degrading', status: 'open' });
    expect(await orion('data', 'anomalies', 'mini')).toMatch(/#1\s+open\s+degrading\s+cross_check_mismatch\s+price_usd/);

    const acked = JSON.parse(await orion('data', 'ack', String(open[0].id), '--note', 'venice lags', '--json'));
    expect(acked).toMatchObject({ status: 'acknowledged', note: 'venice lags' });
    expect(await orion('data', 'anomalies', 'mini')).toBe('no open anomalies');
    expect(JSON.parse(await orion('data', 'anomalies', 'mini', '--all', '--json'))).toHaveLength(1);

    await orion('data', 'fetch', 'mini'); // the mismatch recurs: a new anomaly opens
    const again = JSON.parse(await orion('data', 'anomalies', 'mini', '--json'));
    expect(again[0].id).not.toBe(open[0].id);
    expect(JSON.parse(await orion('data', 'resolve', String(again[0].id), '--note', 'fixed', '--json')).status).toBe('resolved');
  });

  it('requires a note and an open anomaly', async () => {
    await expect(orion('data', 'ack', '1')).rejects.toThrow(/note/);
    await expect(orion('data', 'resolve', '99', '--note', 'x')).rejects.toThrow(/no anomaly with id 99/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/cli`
Expected: FAIL (missing `src/cli/env.js`; `ingestDeps` is not a known `CliContext` property; unknown command `fetch`).

- [ ] **Step 3: Implement**

Create `src/cli/env.ts`:

```ts
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** KEY=value lines; optional "export "; optional single or double quotes; # comments. Anything else is ignored. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    out[match[1]] = value;
  }
  return out;
}

/** The process environment, over <ORION_HOME>/.env when that file exists. */
export function loadEnv(home: string, processEnv: Record<string, string | undefined>): Record<string, string | undefined> {
  const path = join(home, '.env');
  const fromFile = existsSync(path) ? parseEnvFile(readFileSync(path, 'utf8')) : {};
  return { ...fromFile, ...processEnv };
}
```

Create `src/ingest/deps.ts`:

```ts
import type { FetchDeps } from './run.js';
import { createHttpTransport, realHttpDeps } from './transport/http.js';
import { createViemRpc } from './transport/viemRpc.js';

/** The real transports. Everything that touches the network is built here and nowhere else. */
export function realFetchDeps(env: Record<string, string | undefined>, now: () => Date): FetchDeps {
  return {
    http: createHttpTransport(realHttpDeps()),
    rpcFactory: createViemRpc,
    env,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now,
  };
}
```

Create `src/ingest/describe.ts`:

```ts
import type { AssetConfig } from '../config/schema.js';
import type { Db } from '../db/connection.js';
import { listFetchRuns, type SourceStatus } from '../db/fetchRuns.js';
import { listActiveObservations } from '../db/observations.js';
import { latestLevel } from '../drivers/select.js';
import { MS_PER_DAY } from '../types.js';
import { sourceId } from './sourceId.js';

export interface SourceRow {
  metric: string;
  type: string;
  sourceId: string;
  crossChecks: { sourceId: string; tolerancePct: number }[];
  /** The source's entry in the most recent of the last 20 fetch runs that attempted it. */
  lastFetch: { at: string; status: SourceStatus; error: string | null } | null;
  valueInForce: { value: number; observedAt: string; ageDays: number } | null;
}

/** One row per metric that has a source: what feeds it, what checks it, how the last fetch went, how old its value is. */
export function describeSources(db: Db, asset: AssetConfig, now: Date): SourceRow[] {
  const runs = listFetchRuns(db, asset.id, 20);
  const nowIso = now.toISOString();
  const rows: SourceRow[] = [];
  for (const [metric, def] of Object.entries(asset.metrics)) {
    if (!def.source) continue;
    const id = sourceId(def.source);
    let lastFetch: SourceRow['lastFetch'] = null;
    for (const run of runs) {
      const entry = run.detail.sources.find((s) => s.sourceId === id);
      if (entry) {
        lastFetch = { at: run.startedAt, status: entry.status, error: entry.error };
        break;
      }
    }
    const newest = latestLevel(listActiveObservations(db, asset.id, metric), nowIso);
    rows.push({
      metric,
      type: def.source.type,
      sourceId: id,
      crossChecks: (def.cross_checks ?? []).map((c) => ({ sourceId: sourceId(c.source), tolerancePct: c.tolerance_pct ?? def.tolerance_pct })),
      lastFetch,
      valueInForce: newest
        ? { value: newest.value, observedAt: newest.observedAt, ageDays: (now.getTime() - new Date(newest.observedAt).getTime()) / MS_PER_DAY }
        : null,
    });
  }
  return rows;
}
```

In `src/cli/util.ts`, replace:

```ts
import { join } from 'node:path';
import { openDb, type Db } from '../db/connection.js';
import type { Signal } from '../signals/schema.js';
import { OrionError } from '../types.js';

export interface CliContext {
  home: string;
  stdout: (line: string) => void;
  now: () => Date;
}
```

with:

```ts
import { join } from 'node:path';
import { openDb, type Db } from '../db/connection.js';
import { realFetchDeps } from '../ingest/deps.js';
import type { FetchDeps, FetchResult } from '../ingest/run.js';
import type { Signal } from '../signals/schema.js';
import { OrionError } from '../types.js';
import { loadEnv } from './env.js';

export interface CliContext {
  home: string;
  stdout: (line: string) => void;
  now: () => Date;
  /** Transports and environment for fetching. Tests inject fakes; by default the real ones are built. */
  ingestDeps?: () => FetchDeps;
  /** Progress lines. Never stdout, which may be carrying JSON. */
  stderr?: (line: string) => void;
  setExitCode?: (code: number) => void;
}

export function ingestDepsFor(ctx: CliContext): FetchDeps {
  return ctx.ingestDeps ? ctx.ingestDeps() : realFetchDeps(loadEnv(ctx.home, process.env), ctx.now);
}

export async function withDbAsync<T>(ctx: CliContext, fn: (db: Db) => Promise<T>): Promise<T> {
  const db = openDb(dbPath(ctx));
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}
```

Append to `src/cli/util.ts`:

```ts

const trim = (n: number): string => String(Number(n.toPrecision(10)));

export function fetchSummary(r: FetchResult): string[] {
  const lines = [`${r.assetId.toUpperCase()} fetch ${r.outcome}${r.dryRun ? ' (dry run: nothing was written)' : ''}`];
  for (const s of r.sources) {
    const status = s.status === 'failed' ? 'FAILED' : s.status;
    const wrote = s.metricsWritten.length > 0 ? `${r.dryRun ? 'would write' : 'wrote'} ${s.metricsWritten.join(', ')}` : '';
    lines.push(`  ${status.padEnd(8)} ${s.sourceId}  ${wrote}`.trimEnd());
    if (s.error) lines.push(`    error: ${s.error}`);
    for (const c of s.crossChecks) {
      const where = c.label === 'level' ? '' : ` ${c.label}`;
      lines.push(
        `    check ${c.metricKey}${where} vs ${c.sourceId}: ${trim(c.primary)} vs ${trim(c.check)} (${c.diffPct.toFixed(2)}% ${c.ok ? 'within' : 'OUTSIDE'} ${c.tolerancePct}%)`,
      );
    }
    for (const c of s.conflicts) {
      lines.push(
        `    conflict #${c.observationId} ${c.metricKey} ${c.source} ${c.observedAt}${c.periodDays ? ` (${c.periodDays}d)` : ''} ${c.adoptable ? 'adoptable' : 'NOT adoptable'}`,
      );
    }
    if (s.retiredObservationIds.length > 0) lines.push(`    rejected manual rows: ${s.retiredObservationIds.map((id) => `#${id}`).join(', ')}`);
    for (const t of s.unlistedTransfers) lines.push(`    unlisted sender ${t.from}: ${trim(t.tokens)} tokens on ${t.day} (tx ${t.txHash})`);
    for (const note of s.notes) lines.push(`    note: ${note}`);
  }
  for (const a of r.anomalies) {
    lines.push(`  anomaly ${a.id === null ? '(not recorded)' : `#${a.id}`} ${a.kind}${a.metricKey ? ` on ${a.metricKey}` : ''} (${a.severity})`);
  }
  return lines;
}
```

In `src/cli/commands/data.ts`, replace:

```ts
import type { Command } from 'commander';
import { loadAsset } from '../../config/load.js';
import { confirmObservation, insertObservation, listActiveObservations, rejectObservation } from '../../db/observations.js';
import { OrionError, type ObservationSource } from '../../types.js';
import { output, parseNumber, withDb, type CliContext } from '../util.js';
```

with:

```ts
import type { Command } from 'commander';
import { listAssetIds, loadAsset } from '../../config/load.js';
import { decideAnomaly, listAnomalies, type Anomaly } from '../../db/anomalies.js';
import { confirmObservation, insertObservation, listActiveObservations, rejectObservation } from '../../db/observations.js';
import { describeSources } from '../../ingest/describe.js';
import { hasSources } from '../../ingest/plan.js';
import { fetchAsset, type FetchResult } from '../../ingest/run.js';
import { OrionError, type ObservationSource } from '../../types.js';
import { fetchSummary, ingestDepsFor, output, parseNumber, withDb, withDbAsync, type CliContext } from '../util.js';

interface FetchOpts {
  metric: string[];
  backfillDays?: string;
  adopt?: boolean;
  dryRun?: boolean;
  json?: boolean;
}

const collect = (value: string, previous: string[]): string[] => [...previous, value];

const anomalyLine = (a: Anomaly): string =>
  `#${a.id}  ${a.status}  ${a.severity}  ${a.kind}  ${a.metricKey || '(source)'}  ${a.dedupeKey}  x${a.occurrences}  last seen ${a.lastSeenAt}${a.note ? `  note: ${a.note}` : ''}`;
```

In `src/cli/commands/data.ts`, replace:

```ts
  data
    .command('show <asset> [metric]')
```

with:

```ts
  data
    .command('fetch [asset]')
    .description('fetch observations from the sources in the asset YAML; with no asset, every asset that has a source')
    .option('--metric <key>', 'fetch only this metric (repeatable)', collect, [])
    .option('--backfill-days <n>', 're-scan transfer flows this many days back, ignoring the saved cursor')
    .option('--adopt', 'reject manual flow rows that overlap the fetched days, in the same transaction')
    .option('--dry-run', 'read and cross-check, print what would be written, write nothing')
    .option('--json', 'JSON output')
    .action(async (assetId: string | undefined, opts: FetchOpts) => {
      let backfillDays: number | undefined;
      if (opts.backfillDays !== undefined) {
        backfillDays = parseNumber(opts.backfillDays, '--backfill-days');
        if (!Number.isInteger(backfillDays) || backfillDays < 1) throw new OrionError('invalid_number', '--backfill-days must be a positive whole number');
      }
      const ids = assetId ? [assetId] : listAssetIds(ctx.home).filter((id) => hasSources(loadAsset(ctx.home, id).config));
      const deps = ingestDepsFor(ctx);
      const results: FetchResult[] = [];
      await withDbAsync(ctx, async (db) => {
        for (const id of ids) {
          results.push(
            await fetchAsset(db, loadAsset(ctx.home, id), ctx.now(), deps, {
              metrics: opts.metric, backfillDays, adopt: opts.adopt, dryRun: opts.dryRun, onProgress: (line) => ctx.stderr?.(line),
            }),
          );
        }
      });
      output(ctx, opts.json, assetId ? results[0] : results, () =>
        results.length === 0 ? ['no asset defines a source; nothing to fetch'] : results.flatMap(fetchSummary),
      );
    });

  data
    .command('sources <asset>')
    .description('per metric: its source and cross-checks, the last fetch outcome, and the age of the value in force')
    .option('--json', 'JSON output')
    .action((assetId: string, opts: { json?: boolean }) => {
      const { config } = loadAsset(ctx.home, assetId);
      const rows = withDb(ctx, (db) => describeSources(db, config, ctx.now()));
      output(ctx, opts.json, rows, () =>
        rows.length === 0
          ? ['no metric has a source; everything is entered by hand']
          : rows.flatMap((r) => [
              `${r.metric}  ${r.sourceId}  last fetch ${r.lastFetch ? r.lastFetch.status : 'never'}  ` +
                (r.valueInForce ? `value ${r.valueInForce.value} (${r.valueInForce.ageDays.toFixed(1)} days old)` : 'no value yet'),
              ...(r.lastFetch?.error ? [`    error: ${r.lastFetch.error}`] : []),
              ...r.crossChecks.map((c) => `    cross-check ${c.sourceId} (tolerance ${c.tolerancePct}%)`),
            ]),
      );
    });

  data
    .command('anomalies [asset]')
    .description('open anomalies, newest first; --all includes resolved and acknowledged ones')
    .option('--all', 'include resolved and acknowledged anomalies')
    .option('--json', 'JSON output')
    .action((assetId: string | undefined, opts: { all?: boolean; json?: boolean }) => {
      const list = withDb(ctx, (db) => listAnomalies(db, { assetId, includeDecided: opts.all }));
      output(ctx, opts.json, list, () => (list.length === 0 ? [opts.all ? 'no anomalies' : 'no open anomalies'] : list.map(anomalyLine)));
    });

  for (const [name, status, summary] of [
    ['resolve', 'resolved', 'the cause is fixed'],
    ['ack', 'acknowledged', 'the cause is understood and accepted; it no longer affects the signal'],
  ] as const) {
    data
      .command(`${name} <id>`)
      .description(`close an open anomaly: ${summary}`)
      .requiredOption('--note <text>', 'why')
      .option('--json', 'JSON output')
      .action((id: string, opts: { note: string; json?: boolean }) => {
        const a = withDb(ctx, (db) => decideAnomaly(db, parseNumber(id, 'id'), status, opts.note, ctx.now().toISOString()));
        output(ctx, opts.json, a, () => [`anomaly #${a.id} ${a.status}: ${a.note}`]);
      });
  }

  data
    .command('show <asset> [metric]')
```

In `src/cli/index.ts`, replace:

```ts
  stdout: (line) => console.log(line),
  now: () => new Date(),
});
```

with:

```ts
  stdout: (line) => console.log(line),
  now: () => new Date(),
  stderr: (line) => console.error(line),
  setExitCode: (code) => {
    process.exitCode = code;
  },
});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/cli && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli src/ingest/deps.ts src/ingest/describe.ts tests/cli
git commit -m "feat(cli): data fetch, sources, anomalies, resolve, and ack; .env loading"
```

### Task 19: `orion update <asset>`

Spec section 9: `fetchAsset`, then `runValuation`, then emit the signal as ONE JSON line on stdout (and append it to `--out`). It runs the valuation even when some sources failed. Exit code `0` for `ok` or `degraded`, `2` for `blocked`, `1` for an error (the existing top-level handler in `src/cli/index.ts` already sets `1` for anything thrown). The fetch summary goes to stderr so that stdout carries nothing but the signal line. One cron line gives a daily signal.

**Files:**
- Create: `src/app/update.ts`, `src/cli/commands/update.ts`, `tests/app/update.test.ts`
- Modify: `src/cli/program.ts`, `tests/cli/ingest.cli.test.ts`

**Interfaces:**
- Consumes: `fetchAsset`, `FetchDeps`, `FetchResult` (Task 11); `runValuation`; `emitSignal` (`src/signals/emit.ts`); `fetchSummary`, `ingestDepsFor`, `withDbAsync`, `CliContext.setExitCode` (Task 18).
- Produces:
  - `src/app/update.ts`: `updateAsset(db: Db, loaded: LoadedAsset, now: Date, deps: FetchDeps, opts?: { onProgress?: (line: string) => void }): Promise<{ fetch: FetchResult; runId: number; signal: Signal }>`.
  - `src/cli/commands/update.ts`: `registerUpdate(program: Command, ctx: CliContext): void`.

- [ ] **Step 1: Write the failing tests**

Create `tests/app/update.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { updateAsset } from '../../src/app/update.js';
import { createAssumptionSet } from '../../src/db/assumptions.js';
import { insertObservation } from '../../src/db/observations.js';
import { miniAssumptions } from '../helpers/assets.js';
import { CG_MARKETS, harness, NOW } from '../helpers/fetchHarness.js';

/** The two metrics the ingest asset leaves manual, and an assumption set. */
function seedManual(h: ReturnType<typeof harness>) {
  for (const [metricKey, value] of [['revenue_run_rate_usd', 1000], ['staker_emission_share', 1]] as const) {
    insertObservation(h.db, { assetId: 'mini', metricKey, observedAt: '2026-09-18', value, source: 'manual', fetchedAt: NOW.toISOString() });
  }
  createAssumptionSet(h.db, { assetId: 'mini', author: 'user', rationale: 'initial', values: miniAssumptions(), createdAt: NOW.toISOString() });
}

describe('updateAsset', () => {
  it('fetches, runs the valuation on the fetched data, and returns the signal', async () => {
    const h = harness();
    seedManual(h);
    const { fetch, signal, runId } = await updateAsset(h.db, h.loaded, NOW, h.deps);
    expect(fetch.outcome).toBe('ok');
    expect(signal.status).toBe('ok');
    expect(signal.provenance.run_id).toBe(runId);
    expect(signal.spot).toEqual({ price: 10, ts: NOW.toISOString() });
    expect(signal.generated_at).toBe(NOW.toISOString());
    expect(signal.data_quality.grade).toBe('B'); // two manual metrics remain
  });

  it('still runs the valuation when a source failed, on the last good observation', async () => {
    const h = harness();
    seedManual(h);
    await updateAsset(h.db, h.loaded, NOW, h.deps);
    const broken = harness({ db: h.db, routes: { [CG_MARKETS]: new Error('HTTP 429') }, now: new Date(NOW.getTime() + 86_400_000) });
    const { fetch, signal } = await updateAsset(broken.db, broken.loaded, new Date(NOW.getTime() + 86_400_000), broken.deps);
    expect(fetch.outcome).toBe('partial');
    expect(signal.status).toBe('ok');
    expect(signal.spot!.ts).toBe(NOW.toISOString()); // yesterday's price is still in force
  });

  it('returns a blocked signal when required data is missing', async () => {
    const h = harness();
    const { signal } = await updateAsset(h.db, h.loaded, NOW, h.deps);
    expect(signal.status).toBe('blocked');
    expect(signal.status_reasons).toEqual(expect.arrayContaining(['missing_metric:revenue_run_rate_usd', 'no_assumption_set']));
  });
});
```

Append to `tests/cli/ingest.cli.test.ts`:

```ts

describe('orion update', () => {
  let exitCodes: number[];

  async function update(...args: string[]): Promise<string> {
    const lines: string[] = [];
    const h = harness({ routes });
    const program = buildProgram({
      home, stdout: (l) => lines.push(l), now: () => NOW, ingestDeps: () => h.deps, stderr: (l) => stderr.push(l), setExitCode: (c) => exitCodes.push(c),
    });
    await program.parseAsync(['update', ...args], { from: 'user' });
    return lines.join('\n');
  }

  beforeEach(() => {
    exitCodes = [];
  });

  const ASSUMPTIONS = 'all:\n  rev_growth_y1: 0\n  growth_fade_years: 1\n  terminal_growth: 0\n  capture_rate_terminal.fees: 0.1\n  capture_ramp_years.fees: 0\n  discount_rate_base: 0.1\n  staked_ratio_horizon: 0.5\n';

  it('emits one JSON signal line on stdout, the fetch summary on stderr, and exits 0 when ok', async () => {
    await orion('data', 'set', 'mini', 'revenue_run_rate_usd', '1000', '--at', '2026-09-18');
    await orion('data', 'set', 'mini', 'staker_emission_share', '1', '--at', '2026-09-18');
    writeFileSync(join(home, 'a.yaml'), ASSUMPTIONS);
    await orion('model', 'assumptions', 'import', 'mini', join(home, 'a.yaml'), '--rationale', 'initial');

    const out = join(home, 'signals.jsonl');
    const text = await update('mini', '--out', out);
    expect(text.split('\n')).toHaveLength(1);
    const signal = JSON.parse(text);
    expect(signal.status).toBe('ok');
    expect(JSON.parse((await import('node:fs')).readFileSync(out, 'utf8').trim()).signal_id).toBe(signal.signal_id);
    expect(stderr.some((l) => l === 'MINI fetch ok')).toBe(true);
    expect(exitCodes).toEqual([]);
    expect(JSON.parse(await orion('signal', 'latest', 'mini', '--json')).signal_id).toBe(signal.signal_id);
    expect(JSON.parse(await update('mini', '--json')).status).toBe('ok'); // --json is accepted; the output is JSON either way
  });

  it('exits 2 for a blocked signal, and still emits it', async () => {
    const signal = JSON.parse(await update('mini'));
    expect(signal.status).toBe('blocked');
    expect(exitCodes).toEqual([2]);
  });

  it('throws for a configuration error, which the entry point turns into exit 1', async () => {
    writeFileSync(join(home, 'assets', 'manual.yaml'), (await import('../helpers/assets.js')).MINI_ASSET_YAML.replace('id: mini', 'id: manual'));
    await expect(update('manual')).rejects.toThrow(/nothing to fetch/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/app/update.test.ts tests/cli/ingest.cli.test.ts`
Expected: FAIL (cannot find `src/app/update.js`; unknown command `update`).

- [ ] **Step 3: Implement**

Create `src/app/update.ts`:

```ts
import type { LoadedAsset } from '../config/load.js';
import type { Db } from '../db/connection.js';
import { fetchAsset, type FetchDeps, type FetchResult } from '../ingest/run.js';
import type { Signal } from '../signals/schema.js';
import { runValuation } from './valuation.js';

/**
 * Fetch, then value, then hand back the signal. The valuation runs even when some sources failed:
 * the last good observation stays in force until it goes stale, and the signal says so.
 * Only a configuration error throws.
 */
export async function updateAsset(
  db: Db,
  loaded: LoadedAsset,
  now: Date,
  deps: FetchDeps,
  opts: { onProgress?: (line: string) => void } = {},
): Promise<{ fetch: FetchResult; runId: number; signal: Signal }> {
  const fetch = await fetchAsset(db, loaded, now, deps, { onProgress: opts.onProgress });
  const { runId, signal } = runValuation(db, loaded, now);
  return { fetch, runId, signal };
}
```

Create `src/cli/commands/update.ts`:

```ts
import type { Command } from 'commander';
import { updateAsset } from '../../app/update.js';
import { loadAsset } from '../../config/load.js';
import { emitSignal } from '../../signals/emit.js';
import { fetchSummary, ingestDepsFor, withDbAsync, type CliContext } from '../util.js';

export function registerUpdate(program: Command, ctx: CliContext): void {
  program
    .command('update <asset>')
    .description('fetch, run the valuation, and emit the signal as one JSON line; exit 0 ok or degraded, 2 blocked, 1 error')
    .option('--out <file>', 'JSONL file to append the signal to')
    .option('--json', 'accepted for consistency; update always writes JSON')
    .action(async (assetId: string, opts: { out?: string }) => {
      const loaded = loadAsset(ctx.home, assetId);
      const { fetch, signal } = await withDbAsync(ctx, (db) =>
        updateAsset(db, loaded, ctx.now(), ingestDepsFor(ctx), { onProgress: (line) => ctx.stderr?.(line) }),
      );
      for (const line of fetchSummary(fetch)) ctx.stderr?.(line);
      emitSignal(signal, { write: ctx.stdout, outFile: opts.out });
      if (signal.status === 'blocked') ctx.setExitCode?.(2);
    });
}
```

In `src/cli/program.ts`, replace:

```ts
import { registerSignal } from './commands/signal.js';
```

with:

```ts
import { registerSignal } from './commands/signal.js';
import { registerUpdate } from './commands/update.js';
```

In `src/cli/program.ts`, replace:

```ts
  registerSignal(program, ctx);
  return program;
```

with:

```ts
  registerSignal(program, ctx);
  registerUpdate(program, ctx);
  return program;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/update.ts src/cli tests/app/update.test.ts tests/cli/ingest.cli.test.ts
git commit -m "feat(cli): orion update fetches, values, and emits one signal line, with cron-friendly exit codes"
```

### Task 20: The VVV source map, an end-to-end test on the real captures, and the README

Wire `assets/vvv.yaml` to the sources of spec 4.3. Everything else in the file (modules, weights, bounds, comments about calibration) stays exactly as it is: those are the user's calibration.

Changes to `assets/vvv.yaml`:
- `contracts` gains `aerodrome_pool` and `buyback_safe`; `treasury` keeps its address and is commented as an emissions recipient, not a burner.
- New `ingest` block.
- The `metrics` block is rewritten with sources. New metrics: `flow_tokens.burn` and `flow_usd.burn_programmatic` (informational; not referenced by `holder_flows`, so they never enter a snapshot), and `usage_index`.
- `flow_usd.burn` becomes a daily on-chain flow: `cadence: daily`, `staleness_days: 4`. (It was monthly manual entry with 45 days; with daily rows, 45 days would let a dead fetcher go unnoticed for six weeks on a critical metric.)
- `revenue_run_rate_usd` stays manual or provisional. Announced future emission cuts stay manual: enter them with `orion data set vvv emission_rate_annual ... --at <effective date>`; once the date passes, the daily on-chain read is the newest schedule row and governs.
- `review_triggers` gains `revenue_stale_move_pct: 30`.

**Files:**
- Modify: `assets/vvv.yaml`, `README.md`
- Create: `tests/assets/vvv.ingest.test.ts`

**Interfaces:**
- Consumes: everything above. No new exports.

- [ ] **Step 1: Write the failing test**

Create `tests/assets/vvv.ingest.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { runValuation } from '../../src/app/valuation.js';
import { loadAsset } from '../../src/config/load.js';
import { createAssumptionSet } from '../../src/db/assumptions.js';
import { openDb } from '../../src/db/connection.js';
import { insertObservation, listActiveObservations } from '../../src/db/observations.js';
import { buildPlan } from '../../src/ingest/plan.js';
import { fetchAsset, type FetchDeps } from '../../src/ingest/run.js';
import type { AssumptionValues } from '../../src/types.js';
import { fakeHttp } from '../helpers/fakeHttp.js';
import { callKey, fakeRpc } from '../helpers/fakeRpc.js';
import { fixture } from '../helpers/sourceCtx.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const NOW = new Date('2026-09-19T20:30:00.000Z');
const GENESIS_TS = NOW.getTime() / 1000 - 10 * 86_400 + 1;
const VENICE = 'https://outerface.venice.ai/api/app/vvv';
const E18 = 10n ** 18n;

const { config } = loadAsset(ROOT, 'vvv');
const C = config.contracts;
const chain = fixture('chain_reads.json') as { token: Record<string, string>; staking: Record<string, string>; diem: Record<string, string> };

function diemTables(): Record<string, bigint> {
  const calls: Record<string, bigint> = {};
  for (let i = 0; i < 256; i++) {
    const supply = 500 * (i + 1);
    const rate = Math.min(90 * Math.exp(2 * (supply / 40_000) ** 3), 1e30);
    calls[callKey(C.staking, 'diemSupply', [BigInt(i)])] = BigInt(supply) * E18;
    calls[callKey(C.staking, 'diemMintRates', [BigInt(i)])] = BigInt(Math.round(rate * 1e6)) * 10n ** 12n;
  }
  return calls;
}

function world() {
  // The Venice capture was taken an hour before the CoinGecko one and its price differs by 2.6 percent.
  // Align it, so that this test is about wiring. Tolerances have their own tests.
  const stats = { ...(fixture('venice_vvv_stats.json') as Record<string, unknown>), price: '26.03' };
  const http = fakeHttp({
    'https://api.coingecko.com/api/v3/coins/markets': fixture('cg_markets.json'),
    'https://api.coingecko.com/api/v3/coins/venice-token/market_chart': fixture('cg_venice_30_last72.json'),
    [`${VENICE}/vvv_stats`]: stats,
    [`${VENICE}/vvv_staking_yield`]: fixture('venice_vvv_staking_yield.json'),
    [`${VENICE}/vvv_burn_history`]: fixture('venice_vvv_burn_history.json'),
    [`${VENICE}/diem_stats`]: fixture('venice_diem_stats.json'),
    'https://api.llama.fi/summary/fees/venice': fixture('llama_venice.json'),
  });
  const blockAt = (iso: string) => BigInt(Math.ceil((Date.parse(iso) / 1000 - GENESIS_TS) / 2));
  const rpc = fakeRpc({
    genesisTs: GENESIS_TS,
    latest: BigInt(Math.floor((NOW.getTime() / 1000 - GENESIS_TS) / 2)),
    calls: {
      [callKey(C.token, 'totalSupply')]: BigInt(chain.token.totalSupply),
      [callKey(C.token, 'decimals')]: 18n,
      [callKey(C.token, 'balanceOf', [C.burn_sink])]: BigInt(chain.token.balanceOf_zero_address),
      [callKey(C.staking, 'totalSupply')]: BigInt(chain.staking.totalSupply),
      [callKey(C.staking, 'totalLockedStakedVVV')]: BigInt(chain.staking.totalLockedStakedVVV),
      [callKey(C.staking, 'emissionRatePerSecond')]: BigInt(chain.staking.emissionRatePerSecond),
      [callKey(C.staking, 'veniceEmissionsPercentage')]: BigInt(chain.staking.veniceEmissionsPercentage),
      [callKey(C.staking, 'veniceEmissionsPercentageWhenLocked')]: BigInt(chain.staking.veniceEmissionsPercentageWhenLocked),
      [callKey(C.diem, 'totalSupply')]: BigInt(chain.diem.totalSupply),
      ...diemTables(),
    },
    logs: [
      { blockNumber: blockAt('2026-09-17T10:00:00Z'), logIndex: 0, txHash: '0xa', from: C.aerodrome_pool, value: 400n * E18 },
      { blockNumber: blockAt('2026-09-18T10:00:00Z'), logIndex: 0, txHash: '0xb', from: C.buyback_safe, value: 10_000n * E18 },
    ],
  });
  const deps: FetchDeps = { http, rpcFactory: () => rpc, env: {}, sleep: async () => undefined, now: () => NOW };
  return { db: openDb(':memory:'), deps, http, rpc };
}

describe('assets/vvv.yaml ingestion', () => {
  it('plans the VVV source map of the spec', () => {
    const plan = buildPlan(config);
    expect(plan.batches.map((b) => b.sourceId).sort()).toEqual([
      'adapter:vvv.burn_history_tokens', 'adapter:vvv.diem_target_supply', 'adapter:vvv.staker_emission_share', 'adapter:vvv.staker_share_from_api',
      'chain_levels', 'coingecko', 'defillama:venice:dailyHoldersRevenue',
      `http_json:${VENICE}/diem_stats`, `http_json:${VENICE}/vvv_staking_yield`, `http_json:${VENICE}/vvv_stats`,
    ]);
    expect(plan.flowGroups).toHaveLength(1);
    expect(plan.flowGroups[0].members.map((m) => [m.metricKey, m.unit, m.countFrom.length])).toEqual([
      ['flow_usd.burn', 'usd', 2], ['flow_tokens.burn', 'tokens', 2], ['flow_usd.burn_programmatic', 'usd', 1],
    ]);
    expect(plan.derived.map((r) => r.metricKey)).toEqual(['usage_index']);
    expect(config.metrics.revenue_run_rate_usd.source).toBeUndefined();
    expect(config.contracts.aerodrome_pool).toBe('0x01784ef301D79e4B2DF3a21ad9a536d4cF09A5Ce');
    expect(config.contracts.buyback_safe).toBe('0x35FB3b67C57849bF57eB24B061EeF0b5e560DC57');
  });

  it('fetches every sourced metric from the real captures with every cross-check in tolerance', async () => {
    const w = world();
    const r = await fetchAsset(w.db, { config, hash: 'test' }, NOW, w.deps, { backfillDays: 2 });
    expect(r.sources.filter((s) => s.status !== 'ok').map((s) => [s.sourceId, s.error])).toEqual([]);
    expect(r.anomalies).toEqual([]);
    expect(r.outcome).toBe('ok');

    const value = (metric: string) => listActiveObservations(w.db, 'vvv', metric).at(-1)!.value;
    expect(value('price_usd')).toBe(26.03);
    expect(value('diem_price_usd')).toBe(1941.6);
    expect(value('circulating_supply')).toBeCloseTo(48058904.92603289, 4);
    expect(value('effective_supply')).toBeCloseTo(81009270.24659143, 3);
    expect(value('staked_supply')).toBeCloseTo(33941208.98799314, 3);
    expect(value('locked_supply')).toBeCloseTo(8954489.934888212, 3);
    expect(value('emission_rate_annual')).toBeCloseTo(2_500_000, 2);
    expect(value('staker_emission_share')).toBeCloseTo(0.9472352918362107, 9);
    expect(value('diem_supply')).toBeCloseTo(37713.657734473534, 6);
    expect(value('diem_target_supply')).toBeCloseTo(40_000, 1);
    expect(value('diem_locked_yield_share')).toBeCloseTo(0.8, 12);
    expect(listActiveObservations(w.db, 'vvv', 'flow_tokens.burn').map((o) => o.value)).toEqual([400, 10_000]);
    expect(listActiveObservations(w.db, 'vvv', 'flow_usd.burn_programmatic').map((o) => o.value > 0)).toEqual([true, false]);

    const checked = r.sources.flatMap((s) => s.crossChecks).map((c) => c.metricKey).sort();
    expect(checked).toEqual([
      'circulating_supply', 'diem_supply', 'diem_target_supply', 'effective_supply', 'emission_rate_annual', 'locked_supply', 'price_usd',
      'staked_supply', 'staker_emission_share',
    ]);
    expect(w.rpc.stats.multicall).toBeLessThanOrEqual(4); // levels, two adapters, token decimals: never one call per read
  });

  it('produces a signal once the manual metrics and the calibrated assumptions are in', async () => {
    const w = world();
    await fetchAsset(w.db, { config, hash: 'test' }, NOW, w.deps, { backfillDays: 2 });
    insertObservation(w.db, {
      assetId: 'vvv', metricKey: 'revenue_run_rate_usd', observedAt: '2026-08-17', value: 100_000_000, source: 'manual', status: 'provisional',
      citationUrl: 'https://example.com/revenue', fetchedAt: NOW.toISOString(),
    });
    const raw = parseYaml(readFileSync(`${ROOT}/calibration/vvv-assumptions.yaml`, 'utf8')) as Record<string, Record<string, number>>;
    const values: AssumptionValues = { bear: { ...raw.all, ...raw.bear }, base: { ...raw.all, ...raw.base }, bull: { ...raw.all, ...raw.bull } };
    createAssumptionSet(w.db, { assetId: 'vvv', author: 'user', rationale: 'calibrated', values, createdAt: NOW.toISOString() });

    const { signal } = runValuation(w.db, loadAsset(ROOT, 'vvv'), NOW);
    expect(signal.status_reasons).toEqual([]);
    expect(signal.status).toBe('ok');
    expect(signal.data_quality.grade).toBe('C'); // the revenue figure is provisional
    expect(signal.spot!.price).toBe(26.03);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/assets/vvv.ingest.test.ts`
Expected: FAIL (`assets/vvv.yaml` defines no source yet).

- [ ] **Step 3: Update `assets/vvv.yaml`**

In `assets/vvv.yaml`, replace:

```yaml
  burn_sink: "0x0000000000000000000000000000000000000000"
  treasury: "0x2D8CB8DC596daD0e1E34E2042E7ae6Df93B11524"
```

with:

```yaml
  burn_sink: "0x0000000000000000000000000000000000000000"
  # An emissions recipient, not a burner (the 2026-09-19 research pass corrected the earlier "treasury Safe" label).
  treasury: "0x2D8CB8DC596daD0e1E34E2042E7ae6Df93B11524"
  # The only two addresses that sent VVV to the zero address over 120 days. Any other sender raises a degrading anomaly.
  aerodrome_pool: "0x01784ef301D79e4B2DF3a21ad9a536d4cF09A5Ce" # programmatic: per-subscription and credit-purchase burns, each under 1 VVV
  buyback_safe: "0x35FB3b67C57849bF57eB24B061EeF0b5e560DC57" # discretionary: roughly monthly buybacks of 9k to 27k VVV

# ORION_BASE_RPC_URL is optional: https://mainnet.base.org is the default for Base.
ingest: { chain_id: 8453, rpc_url_env: ORION_BASE_RPC_URL, backfill_days: 90 }
```

In `assets/vvv.yaml`, replace:

```yaml
# All fetchers are "manual" in sub-project 1. Sub-project 2 points them at base-rpc, venice-api, coingecko, defillama.
metrics:
  price_usd: { type: level, unit: usd, staleness_days: 3, critical: true }
  revenue_run_rate_usd: { type: level, unit: usd, cadence: event, staleness_days: 60, critical: true, allow_provisional: true }
  effective_supply: { type: level, unit: tokens, staleness_days: 7, critical: true }
  circulating_supply: { type: level, unit: tokens, staleness_days: 14 }
  staked_supply: { type: level, unit: tokens, staleness_days: 7 }
  locked_supply: { type: level, unit: tokens, staleness_days: 14 }
  staker_emission_share: { type: level, unit: ratio, staleness_days: 30 }
  emission_rate_annual: { type: schedule, unit: tokens_per_year, cadence: event, staleness_days: 45, critical: true }
  flow_usd.burn: { type: flow, unit: usd, cadence: monthly, staleness_days: 45, critical: true }
  diem_supply: { type: level, unit: diem, staleness_days: 14 }
  diem_target_supply: { type: level, unit: diem, staleness_days: 45 }
  diem_price_usd: { type: level, unit: usd, staleness_days: 7 }
  diem_locked_yield_share: { type: level, unit: ratio, cadence: event, staleness_days: 90 }
```

with:

```yaml
# Sources (ingestion spec 4.3). A metric without a `source` is entered by hand. Venice's own API
# (outerface.venice.ai) is undocumented, so it only ever appears as a cross-check: a cross-check
# reading is never stored, it can only raise an anomaly.
metrics:
  price_usd:
    type: level
    unit: usd
    staleness_days: 3
    critical: true
    source: { type: coingecko, id: venice-token, field: price }
    cross_checks:
      - { tolerance_pct: 2, source: { type: http_json, url: "https://outerface.venice.ai/api/app/vvv/vvv_stats", path: price } }

  # Manual, or agent-researched and provisional: revenue settles off-chain and has no API. The
  # advisory revenue_disclosure_stale anomaly says when usage has moved since the figure was disclosed.
  revenue_run_rate_usd: { type: level, unit: usd, cadence: event, staleness_days: 60, critical: true, allow_provisional: true }

  effective_supply:
    type: level
    unit: tokens
    staleness_days: 7
    critical: true
    source: { type: erc20_supply, token: token, subtract_balances: [burn_sink] }
    cross_checks:
      - { tolerance_pct: 0.1, source: { type: http_json, url: "https://outerface.venice.ai/api/app/vvv/vvv_stats", path: totalSupplyCryptoBaseUnit, decimals: 18 } }

  circulating_supply:
    type: level
    unit: tokens
    staleness_days: 14
    source: { type: coingecko, id: venice-token, field: circulating_supply }
    cross_checks:
      - { tolerance_pct: 2, source: { type: http_json, url: "https://outerface.venice.ai/api/app/vvv/vvv_stats", path: circulatingSupplyCryptoBaseUnit, decimals: 18 } }

  staked_supply:
    type: level
    unit: tokens
    staleness_days: 7
    source: { type: contract_read, contract: staking, function: totalSupply, decimals: 18 }
    cross_checks:
      - { tolerance_pct: 0.1, source: { type: http_json, url: "https://outerface.venice.ai/api/app/vvv/vvv_stats", path: totalStakedCryptoBaseUnit, decimals: 18 } }

  locked_supply:
    type: level
    unit: tokens
    staleness_days: 14
    source: { type: contract_read, contract: staking, function: totalLockedStakedVVV, decimals: 18 }
    cross_checks:
      - { tolerance_pct: 0.1, source: { type: http_json, url: "https://outerface.venice.ai/api/app/vvv/vvv_stats", path: totalLockedCryptoBaseUnit, decimals: 18 } }

  staker_emission_share:
    type: level
    unit: ratio
    staleness_days: 30
    source: { type: adapter, name: vvv.staker_emission_share }
    cross_checks:
      - { tolerance_pct: 1, source: { type: adapter, name: vvv.staker_share_from_api, params: { url: "https://outerface.venice.ai/api/app/vvv/vvv_staking_yield" } } }

  # The chain gives the rate in force. An ANNOUNCED future cut exists only on Venice's blog: enter it by
  # hand with its effective date (orion data set vvv emission_rate_annual <n> --at <date>). Once that
  # date passes, the daily on-chain read is the newest schedule row and governs; if the cut is delayed,
  # the signal follows the chain.
  emission_rate_annual:
    type: schedule
    unit: tokens_per_year
    cadence: event
    staleness_days: 45
    critical: true
    source: { type: contract_read, contract: staking, function: emissionRatePerSecond, decimals: 18, scale: 31536000 }
    cross_checks:
      # Venice reports emissions per day.
      - { tolerance_pct: 1, source: { type: http_json, url: "https://outerface.venice.ai/api/app/vvv/vvv_staking_yield", path: totalEmissionsCryptoBaseUnit, decimals: 18, scale: 365 } }

  # On-chain transfers to the zero address from the allowlisted senders, one row per completed UTC
  # day, each transfer valued at the CoinGecko hourly price at its own block time.
  flow_usd.burn:
    type: flow
    unit: usd
    cadence: daily
    staleness_days: 4
    critical: true
    source: { type: transfer_flow, token: token, to: burn_sink, from_allowlist: [aerodrome_pool, buyback_safe], unit: usd, price_coingecko_id: venice-token }
    cross_checks:
      - { tolerance_pct: 5, source: { type: defillama, slug: venice, data_type: dailyHoldersRevenue, compare: monthly_sum } }

  # Informational: same scan, in tokens. Matches Venice's burn history to four decimals per completed month.
  flow_tokens.burn:
    type: flow
    unit: tokens
    cadence: daily
    staleness_days: 4
    source: { type: transfer_flow, token: token, to: burn_sink, from_allowlist: [aerodrome_pool, buyback_safe], unit: tokens }
    cross_checks:
      - { tolerance_pct: 0.1, source: { type: adapter, name: vvv.burn_history_tokens, params: { url: "https://outerface.venice.ai/api/app/vvv/vvv_burn_history" } } }

  # Informational: same scan, pool burns only (new paid subscriptions and credit purchases). Feeds usage_index.
  flow_usd.burn_programmatic:
    type: flow
    unit: usd
    cadence: daily
    staleness_days: 4
    source: { type: transfer_flow, token: token, to: burn_sink, from_allowlist: [aerodrome_pool, buyback_safe], count_from: [aerodrome_pool], unit: usd, price_coingecko_id: venice-token }

  # Momentum, not a revenue estimate: mean programmatic burn USD per day over 30 completed days.
  # It never feeds a valuation module. Known limits: the 5 USD band mixes Pro+ sign-ups and credit
  # purchases, and a change of burn policy (credit burns began 2026-07-17) moves it without any
  # change in the business.
  usage_index:
    type: level
    unit: usd_per_day
    staleness_days: 7
    source: { type: derived, name: burn_momentum, params: { metric: flow_usd.burn_programmatic, days: 30 } }

  diem_supply:
    type: level
    unit: diem
    staleness_days: 14
    source: { type: contract_read, contract: diem, function: totalSupply, decimals: 18 }
    cross_checks:
      - { tolerance_pct: 0.1, source: { type: http_json, url: "https://outerface.venice.ai/api/app/vvv/diem_stats", path: totalSupplyCryptoBaseUnit, decimals: 18 } }

  diem_target_supply:
    type: level
    unit: diem
    staleness_days: 45
    source: { type: adapter, name: vvv.diem_target_supply }
    cross_checks:
      # Venice's field is known to lag the on-chain table (39,500 against 40,000 on 2026-09-19).
      - { tolerance_pct: 5, source: { type: http_json, url: "https://outerface.venice.ai/api/app/vvv/diem_stats", path: targetSupplyCryptoBaseUnit, decimals: 18 } }

  # No second source exists for the DIEM price.
  diem_price_usd:
    type: level
    unit: usd
    staleness_days: 7
    source: { type: coingecko, id: diem, field: price }

  # 1 minus Venice's take on DIEM-locked stake. The contract returns a fraction scaled by 1e18 (verified 2026-09-19).
  diem_locked_yield_share:
    type: level
    unit: ratio
    cadence: event
    staleness_days: 90
    source: { type: contract_read, contract: staking, function: veniceEmissionsPercentageWhenLocked, decimals: 18, scale: -1, offset: 1 }
```

In `assets/vvv.yaml`, replace:

```yaml
review_triggers:
  driver_deviation_pct: 25
```

with:

```yaml
review_triggers:
  driver_deviation_pct: 25
  revenue_stale_move_pct: 30 # usage_index move since the revenue disclosure that raises the advisory stale-revenue anomaly
```

- [ ] **Step 4: Run the tests**

Run: `npm test && npm run typecheck`
Expected: PASS, including `tests/assets/vvv.test.ts` (the config still validates, and the calibrated assumptions still fit the bounds) and the golden test (it reads the frozen fixture copy, not `assets/vvv.yaml`).

- [ ] **Step 5: Update the README**

In `README.md`, replace:

```md
Every command accepts `--json`. Signals follow schema v1 (spec section 9). Orion emits signals only. It is not investment advice.
```

with:

````md
## Daily operation

Metrics with a `source:` in `assets/<id>.yaml` are fetched; the rest are entered by hand. Design: `docs/superpowers/specs/2026-09-19-orion-ingestion-design.md`.

```bash
orion data fetch vvv --dry-run      # read and cross-check everything, write nothing
orion data fetch vvv --adopt        # first real run: a 90-day burn backfill (about 2,000 RPC calls, several minutes);
                                    # --adopt rejects the hand-entered monthly burn rows the daily rows replace
orion data sources vvv              # per metric: source, cross-checks, last fetch outcome, age of the value in force
orion update vvv --out signals.jsonl   # fetch, value, emit one JSON line. Exit 0 ok or degraded, 2 blocked, 1 error
```

One cron line gives a daily signal:

```
15 0 * * *  cd /path/to/orion && ORION_HOME="$PWD" orion update vvv --out signals.jsonl 2>> update.log
```

- A backfill is resumable: each completed UTC day commits on its own, and the next run carries on after the last one. `--backfill-days <n>` re-scans the last `n` days; re-scanned days supersede the old rows.
- Fetched flow rows never silently overwrite hand-entered ones. Without `--adopt`, a fetch that would overlap them writes nothing for that scan and lists the conflicting rows. `--adopt` rejects only rows whose source is `manual`.
- Cross-check readings are never stored. A reading outside its tolerance opens an anomaly:

```bash
orion data anomalies vvv                       # open anomalies (--all includes decided ones)
orion data ack 3 --note "Venice's API lags"    # understood and accepted: it stops affecting the signal
orion data resolve 4 --note "allowlisted the new buyback Safe"
```

  An open `degrading` anomaly on a critical metric makes the signal `degraded` with grade D until it is resolved or acknowledged. Advisory anomalies (a usage move since the last revenue disclosure, a source failing three runs in a row) are listed in `data_quality.anomalies` and change nothing else.
- Configuration, from the environment or `<ORION_HOME>/.env` (git-ignored): `ORION_BASE_RPC_URL` (default `https://mainnet.base.org`; the RPC must return `blockTimestamp` on logs, which Base's does) and `COINGECKO_API_KEY` (optional demo key; keyless works, more slowly).
- Still manual for VVV: `revenue_run_rate_usd`, and ANNOUNCED future emission cuts (`orion data set vvv emission_rate_annual <n> --at <effective date>`). Once the date passes, the daily on-chain read governs.

Every command accepts `--json`. Signals follow schema v1 (spec section 9). Orion emits signals only. It is not investment advice.
````

In `README.md`, replace:

```md
Design: `docs/superpowers/specs/2026-09-18-orion-valuation-framework-design.md`
```

with:

```md
Design: `docs/superpowers/specs/2026-09-18-orion-valuation-framework-design.md` (framework) and `docs/superpowers/specs/2026-09-19-orion-ingestion-design.md` (ingestion, anomalies, engine 1.2.0).
```

- [ ] **Step 6: Check the CLI by hand against a throwaway home (no network)**

Run with `bash` (the user's shell is zsh, which does not word-split a command held in a variable):

```bash
bash -c 'set -e; export ORION_HOME=$(mktemp -d); mkdir -p "$ORION_HOME/assets"; cp assets/vvv.yaml "$ORION_HOME/assets/"; npm run -s orion -- init >/dev/null; npm run -s orion -- asset validate vvv; npm run -s orion -- data sources vvv | head -5'
```

Expected: `vvv: ok`, then source rows such as `price_usd  coingecko  last fetch never  no value yet`. Nothing here touches the network or the repo-root `orion.db`.

- [ ] **Step 7: Commit**

```bash
git add assets/vvv.yaml README.md tests/assets/vvv.ingest.test.ts
git commit -m "feat(vvv): fetch VVV observations from CoinGecko, Base, and DefiLlama, cross-checked against Venice's API"
```

### Task 21: User checkpoint: the first live fetch (NOT dispatched to a subagent)

This task touches the network and the user's real `orion.db`. The controller presents it to the user at the end and runs each step only with the user watching. Nothing here is automated.

- [ ] **Step 1: Build and back up**

```bash
npm run build
cp orion.db "orion.db.before-ingestion-$(date +%Y%m%d)"
```

- [ ] **Step 2: Dry run against the real endpoints**

```bash
ORION_HOME="$PWD" node dist/cli/index.js data fetch vvv --dry-run --backfill-days 2
```

Expected: every source `ok`; every `check` line `within` its tolerance, except possibly `price_usd` (CoinGecko and Venice can differ by more than 2 percent in a fast market) and the two `--adopt would reject` notes about the hand-entered September rows. Read the values: `effective_supply` near 81.0M, `emission_rate_annual` 2,500,000 (2,000,000 after 2026-10-01), `staker_emission_share` near 0.947, `diem_target_supply` 40,000, `diem_locked_yield_share` 0.8. If a source fails here, stop and debug it with the user before writing anything.

- [ ] **Step 3: The real backfill, adopting over the hand-entered burn rows**

```bash
ORION_HOME="$PWD" node dist/cli/index.js data fetch vvv --adopt
```

Expected: about 2,000 `eth_getLogs` calls and several minutes, one progress line per day on stderr. If it is interrupted, run it again: it resumes after the last committed day. Then compare the on-chain monthly token totals with `tests/fixtures/ingest/research-2026-09-19/merged_analysis.json` (`month_totals`: 2026-07 = 38,093.246, 2026-08 = 55,498.418): the `check flow_tokens.burn 2026-07` and `2026-08` lines must be within 0.1 percent.

- [ ] **Step 4: Review anomalies with the user**

```bash
ORION_HOME="$PWD" node dist/cli/index.js data anomalies vvv
```

A `cross_check_mismatch` on `flow_usd.burn` against DefiLlama for a month that contains a large discretionary buyback is plausible: the spec records that hourly and daily pricing of the 2026-09-08 buyback differ by about 28 percent. The user decides whether to `ack` it (with a note) or widen the tolerance in `assets/vvv.yaml`. An `unlisted_sender` anomaly means a new burner appeared since the research pass: look at the transaction before allowlisting anything.

- [ ] **Step 5: First fetched signal**

```bash
ORION_HOME="$PWD" node dist/cli/index.js update vvv --out signals.jsonl
ORION_HOME="$PWD" node dist/cli/index.js signal latest vvv
```

Expected: `engine_version` 1.2.0. Against run 3 (12m expected 36.90 under engine 1.1.0), the target is lower: `holder_cashflow` now carries post-horizon dilution (about 3.4 USD per token lower on the golden data, which is about 1.3 USD on the blended 12m target), and the inputs are fresh. Walk the user through `change.cause` and the module breakdown. Stored runs 1 to 3 now correctly refuse replay (`engine_version_mismatch`).

- [ ] **Step 6: Tell the user what to decide**

1. The cron line from the README, if they want the daily signal now.
2. `usage_index` history: this plan writes the index for every day that has 30 complete days behind it, not only the newest (Task 16), so that the stale-revenue alert has a value near the 2026-08-17 disclosure from day one. If they would rather follow the spec to the letter, it is a three-line change.
3. Anomalies never close themselves. A transient price mismatch keeps the signal `degraded` until someone acknowledges it. If that proves noisy in daily use, auto-resolution on the next in-tolerance reading is a candidate for sub-project 4 alongside triggers.
4. Carried forward, unchanged: the data-quality grade counts every manual metric, required or not (sub-project 1 ruling, Task 12); `change.cause` has no value for a config or as-of change; commander errors are not JSON under `--json`; offset-less timestamps parse as local time.

---

## Self-review record

Spec coverage, checked against `2026-09-19-orion-ingestion-design.md` section by section:

| Spec | Task |
|---|---|
| 3 components table | 5, 6 (transports); 7, 8, 15 (sources, adapters); 10 (plan); 9 (crosscheck); 11, 13, 16 (run); 2, 3 (stores); 19 (update); 18, 19 (CLI) |
| 3 invariants 1 to 6 | 1: Tasks 7, 8, 12 (own timestamps, no interpolation). 2: Tasks 11, 12, 16. 3: Task 11. 4: Tasks 11, 13. 5: Task 4. 6: Task 12 |
| 4.1 source types | 4 (schema), 7, 8, 12, 15, 16 |
| 4.2 adapters | 15 |
| 4.3 VVV source map | 20 |
| 5 flow ingestion, 5.1 adoption | 12, 13 |
| 6.1 comparison | 9 |
| 6.2 anomaly kinds | 11 (mismatch, streak), 13 (unlisted sender, monthly mismatch), 16 (stale revenue) |
| 6.3 lifecycle | 3, 18 |
| 6.4 effect on the signal | 14 |
| 7 usage momentum, stale-revenue alert | 16 |
| 8 engine 1.2.0 (as amended) | 1 |
| 9 command surface, configuration | 18, 19 |
| 10 migration 2 | 2 |
| 10.1 snapshot narrowing | 17 |
| 10.2 latest-signal ordering | 17 |
| 11 failure handling | 5 (HTTP), 6 (RPC chunk retries), 11 (isolation, validation, config errors only) |
| 12 testing | each task; live verification in 21 (the ABI units were already verified during planning) |
| 13 build order | followed, except snapshot narrowing and ordering (17) come before the CLI (18, 19) so that `update` is tested on narrowed snapshots |

Deviations from the spec, all deliberate and all stated where they occur: the section 8 amendment (Task 1, approved by the user); conflicts block a whole scan group rather than one metric (Task 12); `usage_index` history (Task 16).

