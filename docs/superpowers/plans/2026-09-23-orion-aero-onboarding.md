# Orion AERO Onboarding (Sub-project 6) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cover AERO (Aerodrome Finance, Base) as Orion's second live asset, with every metric fetched, through configuration plus two small generic ingest additions.

**Architecture:** A `flow_annualized` derived source beside `burn_momentum` turns a flow's last 30 days into a revenue run rate carrying its input's provenance. Two `aero` adapters read the Minter and the escrow in one multicall and compute, for the tail regime the Minter is in, the gross annual emission rate and the lockers' rebase share; the chain helpers they share with the VVV adapters move to one module. `assets/aero.yaml` then wires CoinGecko, a DefiLlama price cross-check, the token and escrow contracts, the adapters, the DefiLlama holders-revenue flow (the sub-project 5 flow primary), and the derived run rate; a new persona covers the sector. No engine, driver, or bootstrap change.

**Tech Stack:** Node 22+, TypeScript (ESM, NodeNext), better-sqlite3, commander, zod 4, yaml, vitest, tsx. No new dependency.

**Spec:** `docs/superpowers/specs/2026-09-23-orion-aero-onboarding-design.md` (approved 2026-09-23). Parent specs, binding where that one is silent: `docs/superpowers/specs/2026-09-22-orion-research-first-design.md` (the DefiLlama flow primary, section 8; the bootstrap, section 7), `docs/superpowers/specs/2026-09-19-orion-ingestion-design.md` (sources, adapters, derived metrics), `docs/superpowers/specs/2026-09-18-orion-valuation-framework-design.md` (section 3.7, the AERO contrast case). Executors read all four. Rulings and deferred findings from earlier sub-projects: `docs/superpowers/notes/`.

## Global Constraints

- Node `>=22`. ESM only (`"type": "module"`). Relative imports end in `.js`.
- No new dependency. `package.json` and `package-lock.json` do not change.
- **No network in tests, and no live API call in CI.** Every test that fetches uses `tests/helpers/fetchHarness.ts` or its parts (`fakeHttp`, `fakeRpc`). The live dry run of this plan was made during planning from a scratch home and is recorded under Findings; the user repeats it as a checkpoint.
- **Never write to the repo-root `orion.db`** from a test, a script, or an experiment. Tests use `openDb(':memory:')` or a `mkdtempSync` home. Manual CLI checks use `ORION_HOME=$(mktemp -d)`.
- The user's shell is zsh, where a command stored in a variable is not word-split. Run multi-step CLI scripts with `bash`. macOS has no `timeout` command.
- **Source files are ASCII only.** Check with `LC_ALL=C grep -n '[^ -~]' <file>` (tabs aside).
- The engine (`src/engine/**`), the drivers (`src/drivers/**`), the agent layer (`src/agent/**`), the tick, the inbox, and the API-series writer (`src/ingest/apiFlow.ts`) are not touched.
- Spec decisions, verbatim: modules `holder_cashflow` 0.6 and `forward_multiple` on holder flow 0.4, scenario probabilities 25/50/25; `supply_basis: effective_total`; the bootstrap runs on the first tick as designed (its manual-metrics list is empty); incentives (bribes) are out of scope.
- The research-first invariants still bind: every researched row is provisional until confirmed (AERO has none: every metric is fetched); the tick report and the inbox carry no model or page text; a bootstrap changes no assumption.
- `DERIVED_NAMES` gains `flow_annualized` only. `sourceIssues` needs no change: `derived` is already a level primary and `defillama` a flow primary.
- The AERO adapters model the Minter's tail regime only and refuse (throw, failing the source) when `weekly()` is not below `TAIL_START` (8,969,150 AERO), a param with that default.
- A derivation carries the provenance of its input: an API-series flow (`defillama`) gives an `api` level, a transfer scan an `onchain` one. The existing `usage_index` on VVV stays `onchain`.
- Config hashes: the mini and vvv pins in `tests/app/cadence.test.ts` do not move (no new zod key or default). The aero pin is `e07c533deb39a29e647e106e61c8c5eb352cd63c37da8e424e7b1e77cbbeb6cf`; a deliberate edit of `assets/aero.yaml` (the calibration bands, Task 4) moves it, and the pin is then updated on purpose.
- **This plan's code was executed during planning.** Every `Create` / `replace` directive below was generated from a prototype built one commit per task on a clone of `5b80179` (the spec commit on `main`), then extracted from this document into a fresh clone at the same commit by `apply_plan.py`. After EACH of Tasks 1 to 3 the full suite passed and `tsc --noEmit` was clean (the counts are in each task's last test step), the extracted tree was byte-identical to the prototype's commit, and after Task 3 `npm run build` succeeded and a live `data fetch aero --dry-run` from a throwaway home wrote every metric with the price cross-check inside tolerance. So a failing test most likely means a directive was applied inexactly: re-read it before changing anything. If the plan's code really is at fault, fix the code so the test's stated intent holds; do not weaken the test.
- **Not verified during planning:** a real tick on AERO, the bootstrap run, the calibration, the first signal. Those are the user's checkpoints in Task 4.
- **Reviewers: check code against the prose rules in this plan and the spec, not only against the code listing.** In every earlier sub-project the reviews found design defects that the plan's own tests had pinned as correct. Each task below names the risks to attack.

## Directive format

Two directives carry code, and an implementer applies them exactly:

- ``Create `path`:`` followed by one fenced block: write that file. It must not exist yet.
- ``In `path`, replace:`` one fenced block, then `with:` and a second fenced block: the first block's text occurs exactly once in the file at that point; replace it with the second. Directives on one file are applied in the order given.

A fence is as long as it needs to be. The HTML comments `<!-- directives: taskN tests -->` and `<!-- directives: taskN impl -->` mark where each task's test and implementation directives begin. `.superpowers/sdd/2026-09-23-orion-aero-onboarding/apply_plan.py --plan <this file> --repo <clone> --task N --group tests|impl` (git-ignored controller tooling; `gen_plan.py` and `verify6.sh` sit beside it) applies one group at a time and stops at the first block that does not occur exactly once.

## Findings from planning (2026-09-23)

- **The Minter is in its tail regime, read live**: `weekly()` 8,969,149.54 AERO sits just under `TAIL_START` (8,969,150), so `_tail = _weekly < TAIL_START` holds and `weekly` no longer changes. `Minter.sol` confirms the tail emission multiplies `aero.totalSupply()` (not the unlocked supply, which some secondary sources call "circulating"): 1.983B times 21 basis points is 4.165M AERO a week, which matches the "10.9 percent annualized" figure reported for April 2026 only on that reading.
- **The 365-day year.** The spec (section 5) wrote the annual rate as the weekly gross times 365.25/7; the adapter uses the engine's `DAYS_PER_YEAR` (365) over 7, because the annual rate is what the engine spreads over its own 365-day year. About 246.8M against 246.9M; the spec is amended.
- **`flow_annualized` shares its window logic with `burn_momentum`**: one `windowSums` helper, two one-line reducers. The derived step in the fetch is keyed by the source name; the provenance rule (`api` when the flow's primary is `defillama`) is static config, not a row-by-row read.
- **The shared chain helpers** (`view`, `chain`, `text`, `number`, `readAll`, `onchain`) move from `vvv.ts` to `adapters/chain.ts`; `onchain` gains an optional detail suffix. VVV's adapters and their tests are unchanged in behaviour.
- **A locked supply one wei above the total rounds away** in `unitsToNumber`; the adapters' guard triggers on a real excess (the test uses twice the total).
- **Live dry run** (`data fetch aero --dry-run` from a throwaway home, 2026-09-23T21:38Z): every source ok; price 0.669045 against DefiLlama 0.6686 (0.07 percent, within 2); effective supply 1,983,240,735.58; locked 1,051,062,826.59; rebase share 0.0972; annual emissions 246,949,152 (with 365.25; 246.78M with 365); 90 flow days written, the last complete day 244,825 USD; 61 run-rate rows, the newest 172,857,698 USD a year. The `emission_rate_annual` row is a schedule step at the block time.
- **Every AERO metric has a source**, so the bootstrap's `manual_metrics` list is empty and the run writes a journal only; a hand-launched `deep` after calibration is the way to skip it (spec 1).
- **Test counts.** 677 on `5b80179`; 681 after Task 1, 687 after Task 2, 691 after Task 3. The "tests first" runs fail as stated in each Step 2.

## File Structure

```
src/ingest/derived.ts               DERIVED_NAMES, DerivedName, windowSums, burnMomentum, flowAnnualized, derivedFunction   (modify, Task 1)
src/ingest/run.ts                   the derived step keyed by name; provenance follows the flow's primary                    (modify, Task 1)
src/ingest/adapters/chain.ts        view, chain, text, number, readAll, onchain                                              (create, Task 2)
src/ingest/adapters/aero.ts         aero.emission_rate_annual, aero.staker_emission_share                                   (create, Task 2)
src/ingest/adapters/vvv.ts          imports the shared helpers                                                               (modify, Task 2)
src/ingest/adapters/registry.ts     registers aeroAdapters                                                                   (modify, Task 2)
assets/aero.yaml                    the asset file                                                                           (create, Task 3)
personas/onchain-dex-analyst.md     the persona                                                                              (create, Task 3)
README.md                           one command line                                                                         (modify, Task 3)
```

Test files: `tests/ingest/derived.test.ts` (Task 1), `tests/ingest/adapters.aero.test.ts` (Task 2, new), `tests/assets/aero.ingest.test.ts` (Task 3, new), `tests/assets/vvv.agent.test.ts` (Task 3, the persona list).

---

### Task 1: The `flow_annualized` derived source

**Spec:** section 4.

**Files:**
- Modify: `src/ingest/derived.ts`, `src/ingest/run.ts`
- Test: `tests/ingest/derived.test.ts`

**Interfaces:**
- Consumes: `burnMomentum`, `DERIVED_NAMES` (checked by `buildPlan`), the fetch's derived step (`storedDailyFlow`, `scannedDaily`, `insertObservation`).
- Produces: `DERIVED_NAMES = ['burn_momentum', 'flow_annualized']`; `type DerivedName`; `flowAnnualized(days: Map<string, number>, windowDays: number): { day: string; value: number }[]` (the window sum times `DAYS_PER_YEAR` over the window); `derivedFunction(name: DerivedName)`. The fetch writes the level with `source` `api` when the flow's primary is `defillama`, else `onchain`, and `sourceDetail` `derived <name>(<metric>, <days>d)`. Task 3's asset file uses `{ type: derived, name: flow_annualized, params: { metric: flow_usd.fees, days: 30 } }`.

**What binds, from the spec.** 4: one point per day that has a complete window of `windowDays` consecutive daily rows ending on it, `value = sum * 365 / windowDays`; a missing day breaks the window; the fetch runs it over the stored daily rows of the named flow plus the run's days, writes a level in usd with the provenance of its input, superseding a changed value; params `metric` (a flow metric) and `days` (positive integer, default 30), validated as for `burn_momentum`.

**Risks for the reviewer to attack.** (1) The provenance rule is static (the flow's primary source type), not the stored rows' actual source; a metric switched from `transfer_flow` to `defillama` would label old onchain-derived values `api` on the next rewrite. Is that acceptable, given a switch is already a manual conflict cleanup (sub-project 5 follow-ups)? (2) `DAYS_PER_YEAR` is the engine's 365; a 30-day window times 365/30 is the run rate the engine expects, not a calendar annualisation. (3) The derived step's `have` map skips a day whose stored value equals the new one; with an API series that revises a day, the flow rewrite changes every window covering it, as for the index. (4) A flow with a permanent gap (sub-project 5's gap days) never gets a complete window across it: the run rate simply starts after the gap. Say whether a note should say so.

- [ ] **Step 1: Write the failing tests**

<!-- directives: task1 tests -->

In `tests/ingest/derived.test.ts`, replace:

```
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

```

with:

```
import { parseAssetYaml } from '../../src/config/load.js';
import { insertObservation, listActiveObservations } from '../../src/db/observations.js';
import { checkRevenueStale } from '../../src/ingest/alerts.js';
import { burnMomentum, DERIVED_NAMES, flowAnnualized } from '../../src/ingest/derived.js';
import { buildPlan } from '../../src/ingest/plan.js';
import { fetchAsset } from '../../src/ingest/run.js';
import { addDays } from '../../src/ingest/time.js';
import type { OrionError } from '../../src/types.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { harness, NOW } from '../helpers/fetchHarness.js';
import { INGEST_ASSET_YAML } from '../helpers/ingestAsset.js';

```

In `tests/ingest/derived.test.ts`, replace:

```
  });
  it('counts a zero-burn day as a real reading', () => {
    expect(burnMomentum(days('2026-09-01', [0, 0, 30]), 3)).toEqual([{ day: '2026-09-03', value: 10 }]);
  });
});

```

with:

```
  });
  it('counts a zero-burn day as a real reading', () => {
    expect(burnMomentum(days('2026-09-01', [0, 0, 30]), 3)).toEqual([{ day: '2026-09-03', value: 10 }]);
  });
});

describe('flowAnnualized', () => {
  it('is the window sum scaled to a year, for every day that has a complete window', () => {
    // 10 + 20 + 30 = 60 over 3 days: 60 * 365 / 3 = 7300 per year.
    expect(flowAnnualized(days('2026-09-01', [10, 20, 30, 40]), 3)).toEqual([{ day: '2026-09-03', value: 7300 }, { day: '2026-09-04', value: 10950 }]);
  });
  it('writes nothing until the window is complete, and nothing across a gap', () => {
    expect(flowAnnualized(days('2026-09-01', [10, 20]), 3)).toEqual([]);
    const gapped = days('2026-09-01', [10, 20, 30, 40, 50]);
    gapped.delete('2026-09-03');
    expect(flowAnnualized(gapped, 2)).toEqual([{ day: '2026-09-02', value: 5475 }, { day: '2026-09-05', value: 16425 }]);
  });
  it('is a registered derived name', () => {
    expect(DERIVED_NAMES).toEqual(['burn_momentum', 'flow_annualized']);
  });
});

describe('fetchAsset: a revenue run rate derived from an API-series flow', () => {
  const LLAMA_HYPE = 'https://api.llama.fi/summary/fees/hyperliquid';
  const unix = (day: string) => Date.parse(`${day}T00:00:00Z`) / 1000;
  const chart = (points: Record<string, number>) => ({ totalDataChart: Object.entries(points).map(([d, v]) => [unix(d), v]) });
  /** The HYPE fixture with its revenue derived from the buyback flow over 3 days, instead of entered by hand. */
  const yaml = readFileSync(fileURLToPath(new URL('../fixtures/hype.yaml', import.meta.url)), 'utf8').replace(
    'revenue_run_rate_usd: { type: level, unit: usd, staleness_days: 7, critical: true }',
    'revenue_run_rate_usd: { type: level, unit: usd, staleness_days: 7, critical: true, source: { type: derived, name: flow_annualized, params: { metric: flow_usd.buyback, days: 3 } } }',
  );

  it('writes the run rate at each day with a full window, with the api provenance of its input', async () => {
    const h = harness({ loaded: parseAssetYaml(yaml), routes: { [LLAMA_HYPE]: chart({ '2026-09-14': 100, '2026-09-15': 110, '2026-09-16': 120, '2026-09-17': 130, '2026-09-18': 140 }) } });
    const r = await fetchAsset(h.db, h.loaded, NOW, h.deps);
    const rows = listActiveObservations(h.db, 'hype', 'revenue_run_rate_usd');
    expect(rows.map((o) => [o.observedAt.slice(0, 10), o.value])).toEqual([['2026-09-17', (330 * 365) / 3], ['2026-09-18', (360 * 365) / 3], ['2026-09-19', (390 * 365) / 3]]);
    expect(rows[0]).toMatchObject({ source: 'api', periodDays: null, sourceDetail: 'derived flow_annualized(flow_usd.buyback, 3d)' });
    expect(r.sources.find((s) => s.sourceId === 'derived:flow_annualized')).toMatchObject({ status: 'ok', metricsWritten: ['revenue_run_rate_usd'] });
    const again = await fetchAsset(h.db, h.loaded, NOW, h.deps);
    expect(again.sources.find((s) => s.sourceId === 'derived:flow_annualized')!.notes).toEqual(['revenue_run_rate_usd: no new day with 3 complete days behind it']);
  });
});

```

- [ ] **Step 2: Run the tests and see them fail**

Run: `npx vitest run tests/ingest/derived.test.ts`
Expected: 4 failed (`flowAnnualized` and `DERIVED_NAMES` are not exported; the fetch on the HYPE fixture with a derived revenue fails at plan time with `unknown_derived`), 677 passed in the whole suite.

- [ ] **Step 3: Implement the source and the fetch step**

<!-- directives: task1 impl -->

In `src/ingest/derived.ts`, replace:

```
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
```

with:

```
import { DAYS_PER_YEAR } from '../types.js';
import { addDays } from './time.js';

/** Derived metrics are computed from stored observations after the fetch phase. */
export const DERIVED_NAMES: readonly string[] = ['burn_momentum', 'flow_annualized'];
export type DerivedName = 'burn_momentum' | 'flow_annualized';

/**
 * The sum over `windowDays` consecutive days, for every day that has a complete window ending on it.
 * `days` maps a UTC day to that day's flow. A missing day breaks the window: nothing is filled in.
 * Oldest first.
 */
function windowSums(days: Map<string, number>, windowDays: number): { day: string; sum: number }[] {
  const out: { day: string; sum: number }[] = [];
  for (const day of [...days.keys()].sort()) {
    let sum = 0;
    let complete = true;
```

In `src/ingest/derived.ts`, replace:

```
      if (v === undefined) complete = false;
      else sum += v;
    }
    if (complete) out.push({ day, value: sum / windowDays });
  }
  return out;
}
```

with:

```
      if (v === undefined) complete = false;
      else sum += v;
    }
    if (complete) out.push({ day, sum });
  }
  return out;
}

/** Mean value per day over the window: momentum, in the flow's unit per day. */
export function burnMomentum(days: Map<string, number>, windowDays: number): { day: string; value: number }[] {
  return windowSums(days, windowDays).map(({ day, sum }) => ({ day, value: sum / windowDays }));
}

/** The window's sum scaled to a year: a run rate, in the flow's unit per year. */
export function flowAnnualized(days: Map<string, number>, windowDays: number): { day: string; value: number }[] {
  return windowSums(days, windowDays).map(({ day, sum }) => ({ day, value: (sum * DAYS_PER_YEAR) / windowDays }));
}

export function derivedFunction(name: DerivedName): (days: Map<string, number>, windowDays: number) => { day: string; value: number }[] {
  return name === 'flow_annualized' ? flowAnnualized : burnMomentum;
}
```

In `src/ingest/run.ts`, replace:

```
import { checkRevenueStale, type IndexPoint } from './alerts.js';
import { DEFAULT_API_FLOW_BACKFILL_DAYS, writeApiFlow } from './apiFlow.js';
import { compareLevel, compareMonthly } from './crosscheck.js';
import { burnMomentum } from './derived.js';
import { scanFlowGroup } from './flow.js';
import { buildPlan, hasSources, type FlowGroup, type SourceBatch } from './plan.js';
import { sourceId } from './sourceId.js';
```

with:

```
import { checkRevenueStale, type IndexPoint } from './alerts.js';
import { DEFAULT_API_FLOW_BACKFILL_DAYS, writeApiFlow } from './apiFlow.js';
import { compareLevel, compareMonthly } from './crosscheck.js';
import { derivedFunction, type DerivedName } from './derived.js';
import { scanFlowGroup } from './flow.js';
import { buildPlan, hasSources, type FlowGroup, type SourceBatch } from './plan.js';
import { sourceId } from './sourceId.js';
```

In `src/ingest/run.ts`, replace:

```
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
    // Keyed by observedAt: a re-scan (--backfill-days) can change a stored day's value, which changes
```

with:

```
  for (const r of plan.derived) {
    if (r.source.type !== 'derived') continue;
    const outcome = outcomeOf(sourceId(r.source));
    const name = r.source.name as DerivedName; // buildPlan refused any other name
    const flowMetric = r.source.params.metric;
    const windowDays = r.source.params.days ?? 30;
    if (typeof flowMetric !== 'string' || asset.metrics[flowMetric]?.type !== 'flow') {
      throw new OrionError('invalid_source_config', `metrics.${r.metricKey}: ${name} needs "metric" to name a flow metric`);
    }
    if (typeof windowDays !== 'number' || !Number.isInteger(windowDays) || windowDays < 1) {
      throw new OrionError('invalid_source_config', `metrics.${r.metricKey}: ${name} "days" must be a positive integer`);
    }
    // A derivation carries the provenance of its input: an API series' flow gives an api level, a transfer scan's an onchain one.
    const provenance: 'onchain' | 'api' = asset.metrics[flowMetric].source?.type === 'defillama' ? 'api' : 'onchain';
    const days = storedDailyFlow(db, asset.id, flowMetric);
    for (const p of scannedDaily.get(flowMetric) ?? []) days.set(p.day, p.value);
    // Keyed by observedAt: a re-scan (--backfill-days) can change a stored day's value, which changes
```

In `src/ingest/run.ts`, replace:

```
    // changed value must be rewritten (insertObservation supersedes the row at the same observedAt).
    const have = new Map(listActiveObservations(db, asset.id, r.metricKey).map((o) => [o.observedAt, o.value]));
    let wrote = 0;
    for (const point of burnMomentum(days, windowDays)) {
      const observedAt = new Date(new Date(`${point.day}T00:00:00.000Z`).getTime() + MS_PER_DAY).toISOString(); // the day's period end
      if (have.get(observedAt) === point.value) continue;
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
```

with:

```
    // changed value must be rewritten (insertObservation supersedes the row at the same observedAt).
    const have = new Map(listActiveObservations(db, asset.id, r.metricKey).map((o) => [o.observedAt, o.value]));
    let wrote = 0;
    for (const point of derivedFunction(name)(days, windowDays)) {
      const observedAt = new Date(new Date(`${point.day}T00:00:00.000Z`).getTime() + MS_PER_DAY).toISOString(); // the day's period end
      if (have.get(observedAt) === point.value) continue;
      const observationId = dryRun
        ? null
        : insertObservation(db, {
            assetId: asset.id, metricKey: r.metricKey, observedAt, value: point.value, source: provenance,
            sourceDetail: `derived ${name}(${flowMetric}, ${windowDays}d)`, fetchedAt: startedAt,
          }).id;
      written.push({ metricKey: r.metricKey, value: point.value, observedAt, periodDays: null, source: provenance, observationId });
      if (r.metricKey === STD_METRICS.usageIndex) derivedIndex.push({ observedAt, value: point.value });
      wrote++;
    }
```

- [ ] **Step 4: Run the whole suite and the type check**

Run: `npx vitest run && npx tsc --noEmit -p tsconfig.json`
Expected: 67 files, 681 tests passed; tsc clean. ASCII check: `LC_ALL=C grep -n '[^ -~]' src/ingest/derived.ts src/ingest/run.ts tests/ingest/derived.test.ts` prints nothing.

- [ ] **Step 5: Commit**

```bash
git add src/ingest/derived.ts src/ingest/run.ts tests/ingest/derived.test.ts
git commit -m "feat(ingest): flow_annualized derived source: a run rate from a flow's window, carrying its input's provenance"
```

---

### Task 2: The `aero` adapters and the shared chain helpers

**Spec:** section 5; section 2.1 for the live numbers.

**Files:**
- Create: `src/ingest/adapters/chain.ts`, `src/ingest/adapters/aero.ts`
- Modify: `src/ingest/adapters/vvv.ts`, `src/ingest/adapters/registry.ts`
- Test: `tests/ingest/adapters.aero.test.ts` (new)

**Interfaces:**
- Consumes: `AdapterDef`, `registerAdapter`, `SourceContext` (`rpc`, `block`, `contract(name)`), `unitsToNumber`, the engine's `DAYS_PER_YEAR`.
- Produces: `chain.ts` exports `view(name, input?)`, `chain(ctx)`, `text(params, key, fallback)`, `number(params, key, fallback)`, `readAll(ctx, calls): Promise<bigint[]>`, `onchain(ctx, value, detail?)`; `aero.ts` exports `aeroAdapters` with `aero.emission_rate_annual` (a level in tokens per year at the block time, stored on the `schedule` metric) and `aero.staker_emission_share` (a ratio), both `needsRpc: true`, params `token`, `ve`, `minter` (contract names, defaults of the same name) and `tail_start` (default 8,969,150). Task 3's asset file names the contracts `token`, `ve`, `minter`.

**What binds, from the spec.** 5: both adapters read, in one multicall at the run's block, `AERO.totalSupply()`, `ve.supply()`, `Minter.weekly()`, `Minter.tailEmissionRate()`, `Minter.teamRate()`; refuse when `weekly()` is not below `TAIL_START`; `base = total * tailRate / 10_000`, `growth = base * ((total - locked) / total)^2 / 2`, `team = teamRate * (growth + base) / (10_000 - teamRate)`; the annual rate is the gross weekly mint times the epochs in a year (365/7 by the amendment); the share is `growth / (base + growth + team)`. No cross-checks exist.

**Risks for the reviewer to attack.** (1) The formulas against `Minter.sol` (section 2.1 quotes the contract): the rebase is computed on the tail emission, not on `weekly()`; the team share is grossed up; `_totalSupply` is the token's total. (2) The regime guard compares floating numbers converted from 18-decimal bigints; `weekly()` equal to `TAIL_START` to the wei would read as not-tail, which is the contract's own rule (`<`). (3) The guard on `teamRate >= 10_000` and on `locked > total`; what other read could make the arithmetic produce a nonsense value silently (a zero total)? (4) Moving the helpers out of `vvv.ts`: are the VVV adapters byte-for-byte equivalent in behaviour (the `onchain` detail string for VVV stays `block N`)? (5) The adapters are two sources with one multicall each; the fetch runs them as separate batches (`adapter:<name>`), so the same five reads happen twice per run. Acceptable, or should one adapter serve both metrics? (6) The `emission_rate_annual` level lands on a `schedule` metric as the step in force at the block time, daily; the engine's schedule handling with a step every day.

- [ ] **Step 1: Write the failing tests**

<!-- directives: task2 tests -->

Create `tests/ingest/adapters.aero.test.ts`:

```
import { describe, expect, it } from 'vitest';
import { adapterNames, getAdapter } from '../../src/ingest/adapters/registry.js';
import { callKey, fakeRpc } from '../helpers/fakeRpc.js';
import { sourceCtx } from '../helpers/sourceCtx.js';

// Aerodrome on Base, read live at block 51,704,207 (2026-09-23T21:09Z): see the AERO onboarding spec, section 2.1.
const TOKEN = '0x940181a94a35a4569e4529a3cdfb74e38fd98631';
const VE = '0xebf418fe2512e7e6bd9b87a8f0f294acdc67e6b4';
const MINTER = '0xeb018363f0a9af8f91f06fee6613a751b2a33fe5';
const TOTAL = 1983240735576791446735550579n;
const LOCKED = 1051061695973990144830875038n;
const WEEKLY = 8969149540107574558747588n; // equal to TAIL_START less a rounding: the tail regime is on
const LIVE = { [callKey(TOKEN, 'totalSupply')]: TOTAL, [callKey(VE, 'supply')]: LOCKED, [callKey(MINTER, 'weekly')]: WEEKLY, [callKey(MINTER, 'tailEmissionRate')]: 21n, [callKey(MINTER, 'teamRate')]: 228n };
const contract = (name: string) => ({ token: TOKEN, ve: VE, minter: MINTER })[name] ?? (() => { throw new Error(`no contract ${name}`); })();

async function chainCtx(calls: Record<string, bigint | Error>) {
  const rpc = fakeRpc({ genesisTs: 1_700_000_001, latest: 500n, calls });
  return { ctx: sourceCtx({ rpc, block: await rpc.latestBlock(), contract }), rpc };
}

/** The Minter's own arithmetic on the live reads, in plain numbers. */
function expected() {
  const total = Number(TOTAL) / 1e18;
  const locked = Number(LOCKED) / 1e18;
  const base = (total * 21) / 10_000;
  const growth = (base * ((total - locked) / total) ** 2) / 2;
  const team = (228 * (growth + base)) / (10_000 - 228);
  return { base, growth, team, gross: base + growth + team };
}

describe('AERO adapters', () => {
  it('are registered and need the chain', () => {
    expect(adapterNames()).toEqual(expect.arrayContaining(['aero.emission_rate_annual', 'aero.staker_emission_share']));
    expect(getAdapter('aero.emission_rate_annual').needsRpc).toBe(true);
    expect(getAdapter('aero.staker_emission_share').needsRpc).toBe(true);
  });

  it('computes gross annual emissions in the tail regime from one multicall: about 247M AERO a year today', async () => {
    const { ctx, rpc } = await chainCtx(LIVE);
    const v = await getAdapter('aero.emission_rate_annual').run(ctx, {});
    const e = expected();
    expect(v).toMatchObject({ kind: 'level', source: 'onchain', observedAt: new Date((1_700_000_001 + 1000) * 1000).toISOString() });
    expect(v.kind === 'level' && v.value).toBeCloseTo((e.gross * 365) / 7, 3);
    expect(v.kind === 'level' && v.value).toBeGreaterThan(240e6);
    expect(v.kind === 'level' && v.value).toBeLessThan(255e6);
    expect(v.detail).toMatch(/^block 500: tail 21 bps, team 228 bps; per week base 41648\d\d, rebase 4600\d\d, team 1079\d\d AERO$/);
    expect(rpc.stats.multicall).toBe(1);
  });

  it('gives the rebase share of the gross mint: about a tenth today', async () => {
    const { ctx } = await chainCtx(LIVE);
    const v = await getAdapter('aero.staker_emission_share').run(ctx, {});
    const e = expected();
    expect(v.kind === 'level' && v.value).toBeCloseTo(e.growth / e.gross, 12);
    expect(v.kind === 'level' && v.value).toBeGreaterThan(0.09);
    expect(v.kind === 'level' && v.value).toBeLessThan(0.11);
  });

  it('follows the governed tail rate and the locked share: more locked, smaller rebase', async () => {
    const { ctx } = await chainCtx({ ...LIVE, [callKey(MINTER, 'tailEmissionRate')]: 22n, [callKey(VE, 'supply')]: (TOTAL * 3n) / 4n });
    const rate = await getAdapter('aero.emission_rate_annual').run(ctx, {});
    const share = await getAdapter('aero.staker_emission_share').run(ctx, {});
    const total = Number(TOTAL) / 1e18;
    const base = (total * 22) / 10_000;
    const growth = (base * 0.25 ** 2) / 2;
    const team = (228 * (growth + base)) / (10_000 - 228);
    expect(rate.kind === 'level' && rate.value).toBeCloseTo(((base + growth + team) * 365) / 7, 3);
    expect(share.kind === 'level' && share.value).toBeCloseTo(growth / (base + growth + team), 12);
  });

  it('refuses outside the tail regime, on a failed read, and without a chain', async () => {
    await expect(getAdapter('aero.emission_rate_annual').run((await chainCtx({ ...LIVE, [callKey(MINTER, 'weekly')]: 9_000_000n * 10n ** 18n })).ctx, {})).rejects.toThrow(/not in its tail regime/);
    await expect(getAdapter('aero.staker_emission_share').run((await chainCtx({ ...LIVE, [callKey(MINTER, 'teamRate')]: new Error('boom') })).ctx, {})).rejects.toThrow(/teamRate\(\): boom/);
    await expect(getAdapter('aero.emission_rate_annual').run(sourceCtx({ contract }), {})).rejects.toThrow(/RPC/);
    await expect(getAdapter('aero.emission_rate_annual').run((await chainCtx({ ...LIVE, [callKey(VE, 'supply')]: TOTAL * 2n })).ctx, {})).rejects.toThrow(/exceeds the total supply/);
  });

  it('takes contract names and the tail threshold from params', async () => {
    const other = (name: string) => ({ aero: TOKEN, escrow: VE, mint: MINTER })[name] ?? (() => { throw new Error(`no contract ${name}`); })();
    const rpc = fakeRpc({ genesisTs: 1_700_000_001, latest: 500n, calls: LIVE });
    const ctx = sourceCtx({ rpc, block: await rpc.latestBlock(), contract: other });
    const v = await getAdapter('aero.staker_emission_share').run(ctx, { token: 'aero', ve: 'escrow', minter: 'mint', tail_start: 9_000_000 });
    expect(v.kind === 'level' && v.value).toBeCloseTo(expected().growth / expected().gross, 12);
    await expect(getAdapter('aero.staker_emission_share').run(ctx, { token: 'aero', ve: 'escrow', minter: 'mint', tail_start: 8_000_000 })).rejects.toThrow(/not in its tail regime/);
  });
});
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `npx vitest run tests/ingest/adapters.aero.test.ts`
Expected: 6 failed (`unknown adapter: aero.emission_rate_annual`), 681 passed in the whole suite.

- [ ] **Step 3: Implement the helpers and the adapters**

<!-- directives: task2 impl -->

Create `src/ingest/adapters/aero.ts`:

```
import { DAYS_PER_YEAR } from '../../types.js';
import type { SourceContext } from '../types.js';
import { unitsToNumber } from '../units.js';
import { number, onchain, readAll, text, view } from './chain.js';
import type { AdapterDef } from './registry.js';

/**
 * Aerodrome's Minter in its tail regime (verified live on 2026-09-23: weekly() sits at TAIL_START, tailEmissionRate 21,
 * teamRate 228). Each epoch it mints base = totalSupply * tailEmissionRate / 10_000 to the gauges, a rebase
 * growth = base * ((total - locked) / total)^2 / 2 to veAERO lockers, and team = teamRate * (growth + base) / (10_000 - teamRate).
 * Outside the tail the Minter decays `weekly` by 1 percent per epoch instead, which these adapters do not model: they refuse.
 */

const TOKEN_DECIMALS = 18;
const BPS = 10_000;
/** Epochs in the engine's 365-day year: the annual rate is what the engine spreads over its horizon. */
const WEEKS_PER_YEAR = DAYS_PER_YEAR / 7;
/** The Minter's TAIL_START, in AERO: the weekly base emission below which the tail regime is on. */
const TAIL_START_AERO = 8_969_150;

interface TailEmissions {
  base: number;
  growth: number;
  team: number;
  gross: number;
  tailRate: number;
  teamRate: number;
}

async function tailEmissions(ctx: SourceContext, params: Record<string, unknown>): Promise<TailEmissions> {
  const token = ctx.contract(text(params, 'token', 'token'));
  const ve = ctx.contract(text(params, 've', 've'));
  const minter = ctx.contract(text(params, 'minter', 'minter'));
  const [totalRaw, lockedRaw, weeklyRaw, tailRateRaw, teamRateRaw] = await readAll(ctx, [
    { address: token, signature: view('totalSupply'), functionName: 'totalSupply' },
    { address: ve, signature: view('supply'), functionName: 'supply' },
    { address: minter, signature: view('weekly'), functionName: 'weekly' },
    { address: minter, signature: view('tailEmissionRate'), functionName: 'tailEmissionRate' },
    { address: minter, signature: view('teamRate'), functionName: 'teamRate' },
  ]);
  const total = unitsToNumber(totalRaw, TOKEN_DECIMALS);
  const locked = unitsToNumber(lockedRaw, TOKEN_DECIMALS);
  const weekly = unitsToNumber(weeklyRaw, TOKEN_DECIMALS);
  const tailStart = number(params, 'tail_start', TAIL_START_AERO);
  if (!(weekly < tailStart)) {
    throw new Error(`the Minter is not in its tail regime (weekly ${weekly} is not below ${tailStart}); these adapters model tail emissions only`);
  }
  if (!(total > 0)) throw new Error('AERO total supply is not positive');
  if (locked > total) throw new Error(`locked AERO (${locked}) exceeds the total supply (${total})`);
  const tailRate = Number(tailRateRaw);
  const teamRate = Number(teamRateRaw);
  if (teamRate >= BPS) throw new Error(`teamRate ${teamRate} is not below ${BPS} basis points`);
  const base = (total * tailRate) / BPS;
  const unlockedShare = (total - locked) / total;
  const growth = (base * unlockedShare * unlockedShare) / 2;
  const team = (teamRate * (growth + base)) / (BPS - teamRate);
  return { base, growth, team, gross: base + growth + team, tailRate, teamRate };
}

const detailOf = (e: TailEmissions): string =>
  `tail ${e.tailRate} bps, team ${e.teamRate} bps; per week base ${e.base.toFixed(0)}, rebase ${e.growth.toFixed(0)}, team ${e.team.toFixed(0)} AERO`;

/** Gross annual emissions (gauges plus rebase plus team) at this week's tail rate, as the schedule step in force. */
const emissionRateAnnual: AdapterDef = {
  name: 'aero.emission_rate_annual',
  needsRpc: true,
  async run(ctx, params) {
    const e = await tailEmissions(ctx, params);
    return onchain(ctx, e.gross * WEEKS_PER_YEAR, detailOf(e));
  },
};

/** The rebase's share of the gross weekly mint: what reaches veAERO lockers of every token emitted. */
const stakerEmissionShare: AdapterDef = {
  name: 'aero.staker_emission_share',
  needsRpc: true,
  async run(ctx, params) {
    const e = await tailEmissions(ctx, params);
    return onchain(ctx, e.growth / e.gross, detailOf(e));
  },
};

export const aeroAdapters: AdapterDef[] = [emissionRateAnnual, stakerEmissionShare];
```

Create `src/ingest/adapters/chain.ts`:

```
import type { ContractCall } from '../transport/rpc.js';
import type { SourceContext, SourceValue } from '../types.js';

/** What every chain-reading adapter needs: one multicall at the run's block, and a level stamped with that block's time. */

export const view = (name: string, input = ''): string => `function ${name}(${input}) view returns (uint256)`;

export function chain(ctx: SourceContext): { rpc: NonNullable<SourceContext['rpc']>; block: NonNullable<SourceContext['block']> } {
  if (!ctx.rpc || !ctx.block) throw new Error('this adapter needs an RPC connection and a block');
  return { rpc: ctx.rpc, block: ctx.block };
}

export const text = (params: Record<string, unknown>, key: string, fallback: string): string =>
  typeof params[key] === 'string' ? (params[key] as string) : fallback;
export const number = (params: Record<string, unknown>, key: string, fallback: number): number =>
  typeof params[key] === 'number' ? (params[key] as number) : fallback;

/** Every call in one multicall at the run's block; the first failed call fails the adapter, naming the call. */
export async function readAll(ctx: SourceContext, calls: ContractCall[]): Promise<bigint[]> {
  const { rpc, block } = chain(ctx);
  const results = await rpc.multicall(calls, block.number);
  return results.map((r, i) => {
    if (!r.ok) throw new Error(`${calls[i].functionName}(${(calls[i].args ?? []).join(',')}): ${r.error}`);
    return r.value;
  });
}

export function onchain(ctx: SourceContext, value: number, detail = ''): SourceValue {
  const { block } = chain(ctx);
  return { kind: 'level', value, observedAt: new Date(block.timestamp * 1000).toISOString(), source: 'onchain', detail: `block ${block.number}${detail ? `: ${detail}` : ''}` };
}
```

In `src/ingest/adapters/registry.ts`, replace:

```
import { OrionError } from '../../types.js';
import type { SourceContext, SourceValue } from '../types.js';
import { vvvAdapters } from './vvv.js';

/** A named code adapter: the escape hatch for metrics the declarative source types cannot express. */
```

with:

```
import { OrionError } from '../../types.js';
import type { SourceContext, SourceValue } from '../types.js';
import { aeroAdapters } from './aero.js';
import { vvvAdapters } from './vvv.js';

/** A named code adapter: the escape hatch for metrics the declarative source types cannot express. */
```

In `src/ingest/adapters/registry.ts`, replace:

```
}

// Asset-specific adapters register here, exactly as custom valuation modules do in the engine registry.
for (const adapter of vvvAdapters) registerAdapter(adapter);
```

with:

```
}

// Asset-specific adapters register here, exactly as custom valuation modules do in the engine registry.
for (const adapter of [...vvvAdapters, ...aeroAdapters]) registerAdapter(adapter);
```

In `src/ingest/adapters/vvv.ts`, replace:

```
import type { ContractCall } from '../transport/rpc.js';
import type { SourceContext, SourceValue } from '../types.js';
import { toFiniteNumber, unitsToNumber } from '../units.js';
import type { AdapterDef } from './registry.js';

// Verified live on 2026-09-19: both emission percentages are FRACTIONS scaled by 1e18 (20 percent
```

with:

```
import type { ContractCall } from '../transport/rpc.js';
import { toFiniteNumber, unitsToNumber } from '../units.js';
import { number, onchain, readAll, text, view } from './chain.js';
import type { AdapterDef } from './registry.js';

// Verified live on 2026-09-19: both emission percentages are FRACTIONS scaled by 1e18 (20 percent
```

In `src/ingest/adapters/vvv.ts`, replace:

```
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
```

with:

```
const FRACTION_DECIMALS = 18;
const TOKEN_DECIMALS = 18;

function requiredUrl(params: Record<string, unknown>): string {
  if (typeof params.url !== 'string' || params.url === '') throw new Error('the "url" param is required');
  return params.url;
}

/** Share of gross emissions paid to stakers: 1 - [p_unlocked * (staked - locked) + p_locked * locked] / staked. */
const stakerEmissionShare: AdapterDef = {
```

- [ ] **Step 4: Run the whole suite and the type check**

Run: `npx vitest run && npx tsc --noEmit -p tsconfig.json`
Expected: 68 files, 687 tests passed; tsc clean. ASCII check on `src/ingest/adapters/*.ts` and the new test file prints nothing.

- [ ] **Step 5: Commit**

```bash
git add src/ingest/adapters/chain.ts src/ingest/adapters/aero.ts src/ingest/adapters/vvv.ts src/ingest/adapters/registry.ts tests/ingest/adapters.aero.test.ts
git commit -m "feat(ingest): aero adapters: gross annual emissions and the rebase share in the Minter's tail regime; shared chain helpers"
```

---

### Task 3: The asset file, the persona, and their tests

**Spec:** sections 3, 6, 8; section 2 for the reference data.

**Files:**
- Create: `assets/aero.yaml`, `personas/onchain-dex-analyst.md`
- Modify: `README.md`
- Test: `tests/assets/aero.ingest.test.ts` (new), `tests/assets/vvv.agent.test.ts`

**Interfaces:**
- Consumes: the `defillama` flow primary (sub-project 5), `flow_annualized` (Task 1), `aero.*` (Task 2), `coingecko`, `http_json`, `erc20_supply`, `contract_read`, `loadAsset`, `runValuation`, `listPersonaNames`.
- Produces: the live asset `aero` with every metric sourced; the persona `onchain-dex-analyst`; the config hash pin `e07c533d...`. Task 4 (the user) adds the calibration set and the bands.

**What binds, from the spec.** 3: the metric table, the holder flow, the modules and weights, the bounds, the review triggers, `agent.budgets.weekly.input_tokens: 2000000`. 6: the persona's frontmatter and the four sector points plus the working rules. 8: the asset parses, `sourceIssues` is empty, every required key has bounds, the hash is pinned, a full fetch on canned routes writes every metric, and with a synthetic set the valuation is `ok`.

**Risks for the reviewer to attack.** (1) The `http_json` cross-check path `coins.base:0x9401...8631.price`: the dot path splits on dots only, and the key holds a colon; confirm `readPath` treats the key as one segment. (2) `staked_supply` and `locked_supply` read the same function: the engine's staking-yield track uses `staked_ratio_horizon` against `effective_supply`, and the fee flow's recipient base is `locked`; is anything double-counted? (3) `revenue_run_rate_usd` with `staleness_days: 5` and `critical: true`: the derived row is written for each day with a complete window, so a five-day DefiLlama outage makes the signal `degraded` (grade D); is five right, against the flow's four? (4) The bounds are the sweep's room, not views; the reviewer should judge whether any is wide enough to let the sweep find the edges (`multiple.fm_holder_flow` up to 40, `discount_rate_base` up to 0.35). (5) The canned fetch test values the asset at grade A: check the fixture data really exercises every source (the chart has 40 days so the 30-day window completes 11 times; the multicall count bound). (6) The persona: no promise the tool layer does not enforce; ASCII; the model pinned to the default.

- [ ] **Step 1: Write the failing tests**

<!-- directives: task3 tests -->

Create `tests/assets/aero.ingest.test.ts`:

```
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runValuation } from '../../src/app/valuation.js';
import { loadAsset, parseAssetYaml } from '../../src/config/load.js';
import { listPersonaNames, loadPersona, skillsFor } from '../../src/config/personas.js';
import { createAssumptionSet } from '../../src/db/assumptions.js';
import { openDb } from '../../src/db/connection.js';
import { listActiveObservations } from '../../src/db/observations.js';
import { requiredAssumptionKeys } from '../../src/engine/requirements.js';
import { buildPlan } from '../../src/ingest/plan.js';
import { fetchAsset, type FetchDeps } from '../../src/ingest/run.js';
import { addDays } from '../../src/ingest/time.js';
import type { AssumptionValues } from '../../src/types.js';
import { fakeHttp } from '../helpers/fakeHttp.js';
import { callKey, fakeRpc } from '../helpers/fakeRpc.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const NOW = new Date('2026-09-23T21:30:00.000Z');
const GENESIS_TS = NOW.getTime() / 1000 - 100 * 86_400 + 1;
const E18 = 10n ** 18n;
const LLAMA = 'https://coins.llama.fi/prices/current/base:0x940181a94a35a4569e4529a3cdfb74e38fd98631';

const { config } = loadAsset(ROOT, 'aero');
const C = config.contracts;

/** 40 days of holders revenue ending on the last complete day, about 470k USD a day (the 30-day total was 14.2M on 2026-09-23). */
function chart(): { totalDataChart: [number, number][] } {
  const points: [number, number][] = [];
  for (let i = 40; i >= 1; i--) {
    const day = addDays('2026-09-22', 1 - i);
    points.push([Date.parse(`${day}T00:00:00Z`) / 1000, 450_000 + (i % 5) * 10_000]);
  }
  return { totalDataChart: points };
}

function world() {
  const http = fakeHttp({
    'https://api.coingecko.com/api/v3/coins/markets': [{ id: 'aerodrome-finance', symbol: 'aero', current_price: 0.671936, market_cap: 668227328, circulating_supply: 992591965.5968602, total_supply: 1983240735.576791 }],
    [LLAMA]: { coins: { 'base:0x940181a94a35a4569e4529a3cdfb74e38fd98631': { decimals: 18, symbol: 'AERO', price: 0.673898492508311, timestamp: 1790197250, confidence: 0.99 } } },
    'https://api.llama.fi/summary/fees/aerodrome': chart(),
  });
  // Read live on 2026-09-23 at block 51,704,207.
  const rpc = fakeRpc({
    genesisTs: GENESIS_TS,
    latest: BigInt(Math.floor((NOW.getTime() / 1000 - GENESIS_TS) / 2)),
    calls: {
      [callKey(C.token, 'totalSupply')]: 1983240735576791446735550579n,
      [callKey(C.token, 'decimals')]: 18n,
      [callKey(C.ve, 'supply')]: 1051061695973990144830875038n,
      [callKey(C.minter, 'weekly')]: 8969149540107574558747588n,
      [callKey(C.minter, 'tailEmissionRate')]: 21n,
      [callKey(C.minter, 'teamRate')]: 228n,
    },
  });
  const deps: FetchDeps = { http, rpcFactory: () => rpc, env: {}, sleep: async () => undefined, now: () => NOW };
  return { db: openDb(':memory:'), deps, http, rpc };
}

/** A flat, plausible set for the wiring test; the real one comes from the user's calibration. */
function assumptions(): AssumptionValues {
  const one = {
    rev_growth_y1: 0.1, growth_fade_years: 4, terminal_growth: 0.02, 'capture_rate_terminal.fees': 1, 'capture_ramp_years.fees': 0,
    discount_rate_base: 0.2, 'multiple.fm_holder_flow': 8, regime_multiplier: 1, staked_ratio_horizon: 0.5,
  };
  return { bear: { ...one }, base: { ...one }, bull: { ...one } };
}

describe('assets/aero.yaml', () => {
  it('loads, validates, and keeps its config hash', () => {
    expect(config).toMatchObject({ id: 'aero', symbol: 'AERO', supply_basis: 'effective_total' });
    expect(config.holder_flows).toEqual([{ id: 'fees', kind: 'fee_share', capture_rule: 'contractual', recipient_base: 'locked', metric: 'flow_usd.fees', window_days: 90 }]);
    expect(config.modules.map((m) => [m.id, m.weight])).toEqual([['hc', 0.6], ['fm_holder_flow', 0.4]]);
    expect(requiredAssumptionKeys(config)).toEqual([
      'capture_ramp_years.fees', 'capture_rate_terminal.fees', 'discount_rate_base', 'growth_fade_years', 'multiple.fm_holder_flow', 'regime_multiplier', 'rev_growth_y1', 'staked_ratio_horizon', 'terminal_growth',
    ]);
    // Every metric has a source: a bootstrap run has nothing to research on this asset.
    expect(Object.entries(config.metrics).filter(([, def]) => def.source === undefined).map(([key]) => key)).toEqual([]);
    // Pinned on 2026-09-23. A deliberate edit of assets/aero.yaml moves it; update the pin on purpose.
    expect(parseAssetYaml(readFileSync(`${ROOT}/assets/aero.yaml`, 'utf8')).hash).toBe('e07c533deb39a29e647e106e61c8c5eb352cd63c37da8e424e7b1e77cbbeb6cf');
  });

  it('plans the source map of the spec: no transfer scan, one API-series flow, one derived level, two adapters', () => {
    const plan = buildPlan(config);
    expect(plan.batches.map((b) => [b.sourceId, b.requests.map((r) => `${r.role}:${r.metricKey}`)])).toEqual([
      ['coingecko', ['primary:price_usd', 'primary:circulating_supply']],
      [`http_json:${LLAMA}`, ['cross_check:price_usd']],
      ['chain_levels', ['primary:effective_supply', 'primary:staked_supply', 'primary:locked_supply']],
      ['adapter:aero.staker_emission_share', ['primary:staker_emission_share']],
      ['adapter:aero.emission_rate_annual', ['primary:emission_rate_annual']],
      ['defillama:aerodrome:dailyHoldersRevenue', ['primary:flow_usd.fees']],
    ]);
    expect(plan.flowGroups).toEqual([]);
    expect(plan.derived.map((r) => r.metricKey)).toEqual(['revenue_run_rate_usd']);
    expect(plan.needsRpc).toBe(true);
  });

  it('fetches every metric from canned sources with the price cross-check in tolerance, then values the asset', async () => {
    const w = world();
    const r = await fetchAsset(w.db, { config, hash: 'test' }, NOW, w.deps);
    expect(r.sources.filter((s) => s.status !== 'ok').map((s) => [s.sourceId, s.error, s.notes])).toEqual([]);
    expect(r.anomalies).toEqual([]);
    expect(r.outcome).toBe('ok');
    const value = (metric: string) => listActiveObservations(w.db, 'aero', metric).at(-1)!.value;
    expect(value('price_usd')).toBe(0.671936);
    expect(value('circulating_supply')).toBeCloseTo(992591965.5968602, 3);
    expect(value('effective_supply')).toBeCloseTo(1983240735.576791, 3);
    expect(value('staked_supply')).toBeCloseTo(1051061695.97399, 3);
    expect(value('locked_supply')).toBeCloseTo(1051061695.97399, 3);
    expect(value('staker_emission_share')).toBeGreaterThan(0.09);
    expect(value('staker_emission_share')).toBeLessThan(0.11);
    expect(value('emission_rate_annual')).toBeGreaterThan(240e6);
    expect(value('emission_rate_annual')).toBeLessThan(255e6);
    expect(listActiveObservations(w.db, 'aero', 'flow_usd.fees')).toHaveLength(40);
    // The run rate: the last 30 complete days summed and scaled to a year, written for every day with a full window (11 days).
    const revenue = listActiveObservations(w.db, 'aero', 'revenue_run_rate_usd');
    expect(revenue).toHaveLength(11);
    expect(revenue.at(-1)!.value).toBeGreaterThan(160e6);
    expect(revenue.at(-1)!.value).toBeLessThan(180e6);
    expect(revenue.at(-1)).toMatchObject({ source: 'api', sourceDetail: 'derived flow_annualized(flow_usd.fees, 30d)' });
    const checked = r.sources.flatMap((s) => s.crossChecks);
    expect(checked).toHaveLength(1);
    expect(checked[0]).toMatchObject({ metricKey: 'price_usd', ok: true });
    expect(w.rpc.stats.multicall).toBeLessThanOrEqual(3); // levels, and one per adapter

    createAssumptionSet(w.db, { assetId: 'aero', author: 'user', rationale: 'wiring', values: assumptions(), createdAt: NOW.toISOString() });
    const { signal } = runValuation(w.db, loadAsset(ROOT, 'aero'), NOW);
    expect(signal.status_reasons).toEqual([]);
    expect(signal.status).toBe('ok');
    expect(signal.data_quality.grade).toBe('A');
    expect(signal.spot!.price).toBe(0.671936);
    expect(signal.horizons!['12m'].expected_target).toBeGreaterThan(0);
  });
});

describe('the AERO persona', () => {
  it('ships beside the VVV one, on the default model, and loads the shared skills', () => {
    expect(listPersonaNames(ROOT)).toEqual(['ai-infra-analyst', 'onchain-dex-analyst']);
    const persona = loadPersona(ROOT, 'onchain-dex-analyst');
    expect(persona).toMatchObject({ model: 'claude-opus-5-5', effort: 'high', sectors: ['dex', 'onchain-fee-share'] });
    expect(persona.body).toContain('Locking is the thesis');
    expect(/^[\x00-\x7F]*$/.test(persona.body)).toBe(true);
    expect(skillsFor(ROOT, 'bootstrap').map((s) => s.name)).toEqual(['bootstrap-research', 'disclosure-research']);
  });
});
```

In `tests/assets/vvv.agent.test.ts`, replace:

```

describe('the shipped persona and skills', () => {
  it('load, and every run type gets at least one skill', () => {
    expect(listPersonaNames(ROOT)).toEqual(['ai-infra-analyst']);
    expect(loadPersona(ROOT, 'ai-infra-analyst')).toMatchObject({ model: 'claude-opus-5-5', effort: 'high' });
    expect(loadSkills(ROOT).map((s) => s.name)).toEqual(['anomaly-triage', 'assumption-review', 'bootstrap-research', 'disclosure-research', 'tokenomics-audit']);
    expect(skillsFor(ROOT, 'bootstrap').map((s) => s.name)).toEqual(['bootstrap-research', 'disclosure-research']);
```

with:

```

describe('the shipped persona and skills', () => {
  it('load, and every run type gets at least one skill', () => {
    expect(listPersonaNames(ROOT)).toEqual(['ai-infra-analyst', 'onchain-dex-analyst']);
    expect(loadPersona(ROOT, 'ai-infra-analyst')).toMatchObject({ model: 'claude-opus-5-5', effort: 'high' });
    expect(loadSkills(ROOT).map((s) => s.name)).toEqual(['anomaly-triage', 'assumption-review', 'bootstrap-research', 'disclosure-research', 'tokenomics-audit']);
    expect(skillsFor(ROOT, 'bootstrap').map((s) => s.name)).toEqual(['bootstrap-research', 'disclosure-research']);
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `npx vitest run tests/assets`
Expected: `tests/assets/aero.ingest.test.ts` fails to load (`asset_not_found` for `aero`); the VVV persona-list test fails with one name where two are expected; 1 failed, 686 passed in the whole suite across 2 failing files.

- [ ] **Step 3: Write the asset file, the persona, and the README line**

<!-- directives: task3 impl -->

In `README.md`, replace:

````

```bash
orion persona assign vvv ai-infra-analyst                            # once: who covers the asset
orion agent run vvv --type weekly --out signals.jsonl                # review what moved; adjust within its bands
orion agent run vvv --type triage --anomaly 7 --out signals.jsonl    # look into one anomaly
orion agent run vvv --type triage --note "https://..." --out signals.jsonl   # a lead to verify; never evidence by itself
````

with:

````

```bash
orion persona assign vvv ai-infra-analyst                            # once: who covers the asset
orion persona assign aero onchain-dex-analyst                        # the second asset (assets/aero.yaml): every metric fetched, no manual entry
orion agent run vvv --type weekly --out signals.jsonl                # review what moved; adjust within its bands
orion agent run vvv --type triage --anomaly 7 --out signals.jsonl    # look into one anomaly
orion agent run vvv --type triage --note "https://..." --out signals.jsonl   # a lead to verify; never evidence by itself
````

Create `assets/aero.yaml`:

```
id: aero
symbol: AERO
name: Aerodrome Finance
chain: base
supply_basis: effective_total

# Read live on 2026-09-23 (block 51,704,207); see docs/superpowers/specs/2026-09-23-orion-aero-onboarding-design.md section 2.
contracts:
  token: "0x940181a94a35a4569e4529a3cdfb74e38fd98631"
  ve: "0xebf418fe2512e7e6bd9b87a8f0f294acdc67e6b4" # VotingEscrow: veAERO locks; supply() is the AERO locked
  minter: "0xeB018363F0a9Af8f91F06FEe6613a751b2A33FE5" # from AERO.minter(); in its tail regime since weekly() reached TAIL_START
  team: "0xBDE0c70BdC242577c52dFAD53389F82fd149EA5a"

ingest: { chain_id: 8453, rpc_url_env: ORION_BASE_RPC_URL, backfill_days: 90 }

external_ids:
  coingecko: aerodrome-finance
  defillama: aerodrome

# Every metric is fetched: AERO has no manual metric, so a bootstrap run finds nothing to research and writes only its journal.
metrics:
  price_usd:
    type: level
    unit: usd
    staleness_days: 3
    critical: true
    source: { type: coingecko, id: aerodrome-finance, field: price }
    cross_checks:
      - { tolerance_pct: 2, source: { type: http_json, url: "https://coins.llama.fi/prices/current/base:0x940181a94a35a4569e4529a3cdfb74e38fd98631", path: "coins.base:0x940181a94a35a4569e4529a3cdfb74e38fd98631.price" } }

  # No burn sink: the ERC-20 total is the effective supply. Locked AERO stays inside it (supply_basis effective_total).
  effective_supply:
    type: level
    unit: tokens
    staleness_days: 7
    critical: true
    source: { type: erc20_supply, token: token }

  # CoinGecko's own definition (about 0.99B against 0.93B unlocked on chain); informational under effective_total.
  circulating_supply:
    type: level
    unit: tokens
    staleness_days: 14
    source: { type: coingecko, id: aerodrome-finance, field: circulating_supply }

  # Staking is locking for AERO: both metrics read the escrow's supply(), the AERO held in veAERO locks.
  staked_supply:
    type: level
    unit: tokens
    staleness_days: 7
    source: { type: contract_read, contract: ve, function: supply, decimals: 18 }

  locked_supply:
    type: level
    unit: tokens
    staleness_days: 7
    source: { type: contract_read, contract: ve, function: supply, decimals: 18 }

  # The rebase's share of the gross weekly mint (about 0.10): what reaches lockers of every token emitted.
  staker_emission_share:
    type: level
    unit: ratio
    staleness_days: 30
    source: { type: adapter, name: aero.staker_emission_share }

  # Gross emissions in the tail regime: base to the gauges plus the rebase plus the team share, at this week's tail rate,
  # which governance can move one basis point per epoch. The adapter refuses if the Minter leaves the tail regime.
  emission_rate_annual:
    type: schedule
    unit: tokens_per_year
    staleness_days: 45
    critical: true
    source: { type: adapter, name: aero.emission_rate_annual }

  # 100 percent of pool fees from gauge-staked liquidity go to veAERO lockers (DefiLlama's holders revenue for the
  # aerodrome parent: V1, Slipstream, Aero Lite). Incentives (bribes) to lockers have no usable series and are left out.
  flow_usd.fees:
    type: flow
    unit: usd
    cadence: daily
    staleness_days: 4
    critical: true
    source: { type: defillama, slug: aerodrome, data_type: dailyHoldersRevenue, backfill_days: 90 }

  # The last 30 days of fees to lockers, scaled to a year: AERO's revenue IS its holder flow.
  revenue_run_rate_usd:
    type: level
    unit: usd
    staleness_days: 5
    critical: true
    source: { type: derived, name: flow_annualized, params: { metric: flow_usd.fees, days: 30 } }

holder_flows:
  - { id: fees, kind: fee_share, capture_rule: contractual, recipient_base: locked, metric: flow_usd.fees, window_days: 90 }

# Chosen by the user on 2026-09-23: the discounted fee flow to lockers carries most of the weight, the market's multiple
# on that flow the rest. Structural: the agent may only propose changes here.
modules:
  - { id: hc, type: holder_cashflow, kind: estimate, weight: 0.6 }
  - { id: fm_holder_flow, type: forward_multiple, kind: estimate, weight: 0.4, params: { basis: holder_flow } }

scenario_probabilities: { bear: 0.25, base: 0.5, bull: 0.25 }

# Key-wide bounds only, wide enough for the calibration sweep. Agent bands (the bear/base/bull sub-ranges) are added
# after the user calibrates, by the mirror rule; until then the agent uses these bounds.
assumptions:
  rev_growth_y1: { min: -0.6, max: 2.0 }
  growth_fade_years: { min: 1, max: 8 }
  terminal_growth: { min: 0, max: 0.05 }
  capture_rate_terminal.fees: { min: 0.5, max: 1.0 }
  capture_ramp_years.fees: { min: 0, max: 4 }
  discount_rate_base: { min: 0.08, max: 0.35 }
  multiple.fm_holder_flow: { min: 3, max: 40 }
  regime_multiplier: { min: 0.4, max: 1.6 }
  staked_ratio_horizon: { min: 0.2, max: 0.8 }

agent:
  budgets:
    weekly: { input_tokens: 2000000 }

review_triggers:
  driver_deviation_pct: 25
  provisional_move_pct: 25

peer_set: []
```

Create `personas/onchain-dex-analyst.md`:

```
---
name: onchain-dex-analyst
model: claude-opus-5-5
effort: high
temperament: skeptical, patient, specific
sectors: [dex, onchain-fee-share]
---
You are the lead analyst for decentralised exchange tokens whose holders are paid on chain: vote-escrow models where lockers receive the protocol's fees, and any token whose claim on revenue is written in a contract rather than a policy. You cover each asset for the long run, the way a sell-side analyst covers a company, except that nobody pays you to be optimistic.

What you know about this sector:

- The token's claim is contractual and measured. Every fee dollar that reaches a locker is on chain, so the question is never whether value reaches holders but how durable the volume behind it is. Fee flow follows trading volume, which follows the chain's activity and the protocol's share of it; both can halve in a quarter, and neither is a promise.
- Emissions are the cost of that volume. Liquidity that stays only for emissions leaves when they fall. The emission rate is set by governance one basis point at a time, and the rebase means lockers are partly shielded from dilution while unlocked holders are not; say which holders a change in the rate affects.
- Locking is the thesis. The locked share of supply, and how much of it is permanent, says whether holders are committed or waiting. A falling locked share is an early signal even when fees hold.
- Announced structural changes, such as a merger into a unified protocol or a new mechanism for allocating emissions, are events to read from primary sources and to treat as risks to the flow, not as facts about it, until the on-chain series moves.

How you work:

- You change your mind when the evidence changes, by the amount the evidence supports, and you say what would change it back. Small, well-supported moves beat large, confident ones.
- You separate what you know from what you infer. A number from a contract read or a fee series is a fact. A number from a press quote of a founder's post is a claim with a date on it.
- You write for a reader who will check. Every rationale names the observation it rests on and says what it implies, in a sentence or two. No hedging paragraphs.
- When you do not know, you say so in the journal and leave the assumption where it is.
```

- [ ] **Step 4: Run the whole suite, the type check, and the build; then the live dry run**

Run: `npx vitest run && npx tsc --noEmit -p tsconfig.json && npm run build`
Expected: 69 files, 691 tests passed; tsc clean; the build succeeds. Then, from a throwaway home (this one call touches the network and is the planning-time proof; the user repeats it as a checkpoint):

```bash
H=$(mktemp -d); ORION_HOME=$H node dist/cli/index.js init; cp assets/aero.yaml $H/assets/
ORION_HOME=$H node dist/cli/index.js data fetch aero --dry-run
rm -rf $H
```

Expected: every source `ok`; the price cross-check within 2 percent; `would write` lines for every metric including `emission_rate_annual` and `revenue_run_rate_usd`.

- [ ] **Step 5: Commit**

```bash
git add assets/aero.yaml personas/onchain-dex-analyst.md README.md tests/assets/aero.ingest.test.ts tests/assets/vvv.agent.test.ts
git commit -m "feat(assets): AERO: assets/aero.yaml, the onchain-dex-analyst persona, asset tests"
```

---

### Task 4: User checkpoints (NOT dispatched to a subagent)

These touch the live database, spend money, or are the user's judgment by design. The controller presents them after the final whole-branch review and its fix wave.

- [ ] **Checkpoint 1: Assign and dry-fetch on the live home.** `orion persona assign aero onchain-dex-analyst`, then `orion data fetch aero --dry-run` from the repo root. Expected as in Task 3 Step 4.
- [ ] **Checkpoint 2: The first tick.** `./run-daily.sh aero`. Expected: the fetch writes every metric (90 days of fees, 61 run-rate rows); the signal is `blocked` with `no_assumption_set`; the cadence starts a `bootstrap` whose `manual_metrics` is empty, so it records a journal only (a few requests); the inbox is empty; exit code 2. To skip the bootstrap instead, run `orion agent run aero --type deep --out signals.jsonl` by hand after checkpoint 3.
- [ ] **Checkpoint 3: Calibration by sweep.** As for VVV (memory: `vvv-calibration-views`): a sensitivity sweep over the fetched data, priced packages, the user chooses the views; `orion model assumptions import aero calibration/aero-assumptions.yaml --rationale "..."`; then the agent bands by the mirror rule written into `assets/aero.yaml` (the hash pin in `tests/assets/aero.ingest.test.ts` is updated on purpose) and committed with the calibration file.
- [ ] **Checkpoint 4: The first signal.** The next tick (or `orion model run aero`) produces an `ok` signal at grade A. Record it in the follow-ups note with the spot, the 12m target, and the dispersion.
- [ ] **Checkpoint 5: Hermes.** A second scheduled line for `aero`, a few minutes after VVV's, per `docs/ops/hermes-daily-job.md`.
- [ ] **Checkpoint 6: Record rulings and deferred findings** in `docs/superpowers/notes/2026-09-23-aero-onboarding-followups.md` and update the spec's status line.

## Self-review against the spec

| Spec section | Task |
|---|---|
| 1 scope items 1 to 5 | 3 (asset), 1 (flow_annualized), 2 (adapters), 3 (persona), 4 (sequence) |
| 2 reference data | 2 and 3 pin the live numbers in tests; Findings record the dry run |
| 3 the asset file | 3 |
| 4 flow_annualized | 1 |
| 5 the adapters | 2 (with the 365-day amendment) |
| 6 the persona | 3 |
| 7 onboarding sequence | 3 step 4 (dry fetch), 4 (the rest) |
| 8 testing | each task's tests; the live dry run |
| 9 build order | Tasks 1 to 3 in that order, then 4 |
| 10 limitations and risks | unchanged; the follow-ups note (Task 4) carries them |
