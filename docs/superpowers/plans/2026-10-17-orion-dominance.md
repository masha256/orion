# Category dominance input: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give 8 assets a daily, monitor-only `dominance_share` / `dominance_share_1y` (category share from DefiLlama), give LINK a manual `dominance_share`, and teach the five sector personas the durability rule. No valuation number may move.

**Architecture:** One new batch source type `defillama_share` reads a DefiLlama overview (fees or dexs, optionally per chain), groups protocols by `parentProtocol` and returns the parent's share of the category as a `level` ratio. The metrics are `monitor_only`, so `computeDrivers` ignores them, but `narrowToUsable` keeps the newest level row, so the analyst's context pack already lists them under `observations_in_force`. The rule itself is persona text.

**Tech Stack:** TypeScript, zod, vitest, existing ingest `SourceHandler` / `ctx.http.getJson` (per-run URL cache, so 8 assets reading one overview make one request).

**Spec:** `docs/superpowers/specs/2026-10-17-orion-dominance-design.md`. Mike approved every recommendation on 2026-10-17: chain-local share for AERO (Base) and CAKE (BSC); LINK manual, no DefiLlama Pro; all 8 assets at once.

## Global Constraints

- Branch `feat/dominance` (exists; holds the spec commit `10df4b6`). One commit per task. Stage with explicit `git add <paths>`, never `-a`.
- Test with `npx vitest run --maxWorkers=2` and then `npm run typecheck`. Rerun `tests/cli/*` alone before calling a failure real.
- No ENGINE_VERSION bump. The VVV golden hash stays as is, because VVV gets no metric.
- New schema fields have no defaults (existing config hashes stay put).
- Only these 8 asset files change config: aero, cake, crv, hype, lit, pump, sky, uni. LINK changes too (a manual metric). vvv, ycrv, cvxcrv and sdcrv don't change.
- Free DefiLlama endpoints only: `https://api.llama.fi/overview/fees` and `https://api.llama.fi/overview/dexs[/<chain>]`, always with `?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true`. `overview/derivatives` and the oracle endpoints answer 402: never use them.
- Window field: `30d` reads `total30d`; `1y` reads `total1y`.
- Live install untouched: no merge, no build into the live tree, no live fetch, no push. Stop at a green branch and a scratch-home fetch.

## Review Focus

1. **The parent is missing from the overview** (DefiLlama renames a slug): the source must fail loudly ("parent not found"), not write 0 (0 is a valid ratio and would pass `validateReading`). Test in Task 1.
2. **The category total is 0 or the category is misspelled:** fail with the category name in the error, never divide by zero. Test in Task 1.
3. **Rows with a null or missing `total30d`/`total1y`:** count as 0, and don't poison the sum with NaN. Test in Task 1.
4. **A child protocol listed under a different category from its parent** (HYPE spot is `Dexs`, HYPE perps are `Derivatives`): only rows of the requested category count, on both the numerator and the denominator. Test in Task 1.
5. **A failed share read** marks `defillama_share:*` failed in the fetch report and counts toward the streak, but must not degrade the signal's grade or block the valuation. Test in Task 2.

---

### Task 1: `defillama_share` source

**Files:**
- Modify: `src/config/sources.ts` (SourceSchema union; `LEVEL_PRIMARY` set; `sourceIssues`)
- Modify: `src/ingest/sourceId.ts`
- Create: `src/ingest/sources/defillamaShare.ts`
- Modify: `src/ingest/sources/registry.ts`
- Test: `tests/ingest/sources.defillamaShare.test.ts`, fixture `tests/fixtures/ingest/defillama-overview-fees.json` (trimmed: about 8 rows covering the cases below)

**Interfaces:**
- Produces: the source config `{ type: 'defillama_share', parent: string, category: string, overview: 'fees' | 'dexs', chain?: string, window: '30d' | '1y' }`. `parent` is the DefiLlama `parentProtocol` id (e.g. `parent#uniswap`), or a bare slug for a protocol with no parent. `sourceId` = `defillama_share:${overview}${chain ? '/' + chain : ''}:${category}:${parent}:${window}`. Handler `defillamaShareSource: SourceHandler`, exported from `defillamaShare.ts` and registered under `defillama_share`.

- [ ] **Step 1: Write the failing tests**

```ts
// sources.defillamaShare.test.ts: ctx.http.getJson stubbed to return the fixture; assert the URL requested.
it('share of category, grouped by parentProtocol', ...)         // parent#uniswap, Dexs, fees, 30d -> sum(children Dexs total30d)/sum(all Dexs total30d); toBeCloseTo(expected, 12)
it('1y window reads total1y', ...)
it('counts only the requested category on both sides', ...)     // parent#hyperliquid with a Dexs child and Derivatives children; category Derivatives excludes the Dexs child
it('bare slug parent for a protocol with no parentProtocol', ...)
it('null or missing totals count as 0', ...)
it('chain goes in the path', ...)                               // overview dexs, chain 'Base' -> https://api.llama.fi/overview/dexs/Base?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true
it('fails when the parent is not in the category', ...)         // result ok:false (or throws) with /parent .* not found/
it('fails when the category total is 0', ...)                   // /category "Nope" .* total is 0/
it('level reading: source api, observedAt = ctx.nowIso, detail names the URL and the parent sum/total', ...)
// config tests (tests/config or the same file via parseAssetYaml):
it('schema accepts defillama_share as a level primary and refuses it on a flow metric', ...)
it('schema refuses defillama_share as a cross-check', ...)
```

- [ ] **Step 2: Run, expect FAIL** with `npx vitest run tests/ingest/sources.defillamaShare.test.ts` (no handler / unknown source type).

- [ ] **Step 3: Implement.** Add the zod object (strict; `chain` optional with no default) to `SourceSchema`. Add `defillama_share` to `LEVEL_PRIMARY` only (not to the flow, LEVEL_CHECK or FLOW_CHECK sets). Add the `sourceId` case. The handler builds `${DEFILLAMA_API}/overview/${overview}${chain ? '/' + encodeURIComponent(chain) : ''}?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true`. It loops `body.protocols`, keeps rows with `category === s.category`, keys each by `parentProtocol ?? slug`, and returns `level(mine / total, ctx.nowIso, 'api', detail)`. Throw on a missing `protocols` array, a zero total, or `mine === 0` with the parent absent from the category. Follow how `defillama.ts` reports errors.

- [ ] **Step 4: Run, expect PASS**, then the full suite and typecheck. Every existing hash pin is unchanged.

- [ ] **Step 5: Commit** `feat(ingest): defillama_share source (category share from DefiLlama overviews, grouped by parentProtocol)`

### Task 2: Dominance metrics on the 8 assets and the LINK manual metric

**Files:**
- Modify: `assets/{uni,cake,aero,crv,hype,lit,pump,sky,link}.yaml`
- Modify: the asset tests in `tests/assets/*.ingest.test.ts` that pin config hashes (re-pin), plus one new assertion per file (below)
- Test: `tests/ingest/run.test.ts` (Review Focus 5)

**Interfaces:**
- Consumes: Task 1's source config.
- Produces: the metric keys `dominance_share` and `dominance_share_1y` (`type: level, unit: ratio, monitor_only: true, staleness_days: 7`), each with a one-line YAML comment giving the category and measure.

Per-asset source parameters (`window: 30d` on `dominance_share`, `window: 1y` on `dominance_share_1y`, otherwise identical):

| Asset | parent | category | overview | chain |
|---|---|---|---|---|
| uni | parent#uniswap | Dexs | dexs | — |
| cake | parent#pancakeswap | Dexs | dexs | BSC |
| aero | parent#aerodrome | Dexs | dexs | Base |
| crv | parent#curve-finance | Dexs | dexs | — |
| hype | parent#hyperliquid | Derivatives | fees | — |
| lit | parent#lighter | Derivatives | fees | — |
| pump | parent#pump | Launchpad | fees | — |
| sky | parent#maker | CDP | fees | — |

LINK: `dominance_share` only, with **no source** (so it appears in `manual_metrics` and research may record it), and the comment "share of oracle total value secured, DefiLlama-derived, recorded quarterly by research with a citation; DefiLlama's oracle API is paywalled". No `_1y` for LINK; the trend comes from successive observations.

- [ ] **Step 1: Write the failing tests.** In each of the 9 asset tests: `expect(config.metrics.dominance_share).toMatchObject({ type: 'level', unit: 'ratio', monitor_only: true })`. For the 8 fetched assets, also the exact source object from the table. For LINK: `source` is undefined. In `run.test.ts`: `it('a failed defillama_share read marks its source failed but the valuation still runs ungraded-down')`. A fixture asset with a valid price/supply/flow set plus a `defillama_share` metric whose HTTP stub rejects: the fetch report has `defillama_share:...` with `status: 'failed'`, and the computed driver report has `missing: []` and no stale-critical entries.

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Edit the 9 YAMLs.** Run `node dist/cli/index.js asset validate <a>` after `npm run build` *in the worktree only* (or `npx tsx src/cli/index.ts asset validate <a>`) for all 13 assets. Re-pin the changed hashes in the asset tests.

- [ ] **Step 4: Run the full suite and typecheck, expect PASS.** VVV golden is unchanged.

- [ ] **Step 5: Commit** `config: dominance_share / dominance_share_1y on uni, cake (BSC), aero (Base), crv, hype, lit, pump, sky; manual on link (Mike, 2026-10-17)`

### Task 3: Prove no value moves, then a scratch-home live fetch

**Files:**
- Create: `docs/superpowers/notes/2026-10-17-dominance-followups.md`

- [ ] **Step 1: Before → after on all 13 assets.** Scratch home `ORION_HOME=$TMPDIR/orion-dom` (assets, calibration and `.env` copied, mode 600; `sqlite3 orion.db ".backup …"` from live). Run `model whatif <a> --json` for every asset on `main`'s build, then again on this branch's build. Expected: `expectedTarget` and every scenario target identical to 1e-12 for all 13.
- [ ] **Step 2: Live fetch into the scratch home** for the 8 assets (`ingest run <a>` or the existing fetch command). Expected: one `dominance_share` and one `dominance_share_1y` row each, and no source failures. Compare with the spec's table: within ±3 points of 30 d share for each, since the 30-day window has rolled. Report a larger gap with the cause before going on.
- [ ] **Step 3: Context pack check.** In the scratch home, build the UNI context pack (the `buildContextPack` path used by tests, or the agent dry-run command if there is one). `observations_in_force` contains `dominance_share` and `dominance_share_1y`. No agent call (that costs spend).
- [ ] **Step 4: Write the followups note.** Record the measured values per asset, that history starts on the go-live day, the 8 new DefiLlama dependencies (failure streak), LINK's manual quarterly cadence, and open items (yCRV, cvxCRV and sdCRV don't carry it; a long-run durability study needs a 30+ protocol sample). Delete the scratch home (it holds `.env`).
- [ ] **Step 5: Commit** `docs(notes): dominance followups (measured shares, no value moved on 13 assets)`

### Task 4: The durability rule in the personas

**Files:**
- Modify: `personas/onchain-dex-analyst.md`, `personas/perp-exchange-analyst.md`, `personas/consumer-launchpad-analyst.md`, `personas/stablecoin-protocol-analyst.md`, `personas/oracle-network-analyst.md`
- Test: `tests/config/personas.test.ts` (or wherever `parsePersona` is tested)

- [ ] **Step 1: Write the failing test.** Each of the 5 persona files loads with `loadPersona` and its body contains `dominance_share`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Add one bullet under "How you work"** in each, with this text (verbatim; the oracle persona adds the second sentence in brackets):

  > - Dominance sets durability, not growth. `dominance_share` (and its trend against `dominance_share_1y`, or against your earlier observations) decides where inside the band `growth_fade_years`, `terminal_growth` and `discount_rate_base` sit. A leading and rising share points to the bull-side edge; a falling share points to the bear-side edge, even when the share is still high. Cite the `dominance_share` observation in every rationale that uses it. Never use it to move `rev_growth_y1` or a multiple: in Orion's 2026-10-17 test, TVL and share did not predict next-quarter growth. With no dominance observation, leave those three keys where they are.
  >
  > (oracle only:) `dominance_share` for LINK is manual: when the latest is more than 90 days old, research the share of oracle total value secured (a page that cites DefiLlama), record it with the quote, and say it is a third-party figure.

- [ ] **Step 4: Run the full suite, expect PASS.**
- [ ] **Step 5: Commit** `personas: dominance sets durability (fade, terminal, discount) inside the band, never growth or multiple`

---

**Stop here.** Report to Mike in orion-dev: the per-task commits; suite counts from the real run; the 13-asset before → after (all unchanged); the 8 measured shares vs the spec; and the merge checklist from the orion skill (pgrep, backup, `merge --ff-only`, `npm run build`, `asset validate` all 13). Merging, building live and the first live fetch wait for his go.
