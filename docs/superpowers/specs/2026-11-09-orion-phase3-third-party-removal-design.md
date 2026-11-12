# Orion Phase 3: remove DefiLlama and CoinGecko from live code

**Status:** APPROVED by Mike 2026-11-09 (#orion-dev): "All approved as recommended", D1-D11 as recommended in §8:
- D1 Phase 3 removes CoinGecko as well as DefiLlama; D2 price method as written; D3 A (183-day hourly history rebuilt
  from chain, stored flows re-priced); D4 A (circulating on chain, cited exclusions); D5 A (DefiLlama-only gross lines
  to `not_measured`, on-chain gross series in a later Phase 3b); D6 as written; D7 A (CRV incentive `event_sum` scans
  in R7); D8 order R0 -> R8 as written; D9 yes; D10 yes; D11 yes (CAKE fix ships alone; Mike: "cake to stage ok").
- R0 CAKE: tag `orion-2026.11.10.1` = `fix/cake-pending-burn` 0ecc69e on main 0f4b2fe. It is staged after AERO's
  orion-2026.11.09.1 reaches prod, so AERO's soak gate is not invalidated. Prod needs its own soak and Mike's go.
- 2026-11-12: R0 CAKE shipped (`orion-2026.11.10.1` on prod 2026-11-11). Phase 2 closed: prod `orion-2026.11.11.1` =
  1de531d (0006 provenance NOT NULL, `observations.source` dropped, v1/`--legacy` retired). Branch rebased onto main
  763868e; Phase 3 code builds on it (no `observations.source`, no `holder_flows`/`reporting` keys, v2-only proofs).
- 2026-11-12 (Mike: "Go"): one plan per release, each written just before its build. First plan:
  `docs/superpowers/plans/2026-11-12-orion-phase3-r1-third-party-removal.md` = R0b (remote verbs: `backfill` job kind
  with 0007 expand-only, `data purge`, `data compare-usd`) + R1, one release; plan decisions P1-P5 in it (P4: PUMP has
  no issuer vesting schedule, Blockworks filing cited; LIT unlocks +0.066% from Lighter's own 26%/24%).
Drafted 2026-11-09 (#orion-dev "go on 2"). Branch `feat/phase3-third-party` from main 0f4b2fe (release
orion-2026.11.09.1, AERO post-merger). Nothing here is built yet; the next step is the plan. Umbrella: `2026-10-28-orion-coinrevs-core-roadmap.md` (Phase 3; decision 1 history
deletion; decision 4 order: 3 and 5 in parallel). Phase 2 inputs: `2026-10-28-orion-data-strategy-income-v2-design.md`
§2 (source ladder), §5 (checks), §8 (asset mapping), §12.7 (generic source types), and the followups note's Phase 3
lists (`docs/superpowers/notes/2026-11-04-orion-phase2-followups.md`).

## 1. Goal and scope

Orion's live code reads no DefiLlama and no CoinGecko. Every published number comes from our own RPC reads, a
protocol's first-party API, or a cited disclosure. This applies to primaries, cross-checks, the hourly price history
used to value flows, and backfill helpers.

**Scope change against the roadmap (needs D1).** The roadmap removes DefiLlama in Phase 3 and keeps CoinGecko on a paid
Basic plan (rule 5, decision 3). Mike's rule of 2026-11-09 (AERO supply spec, Status) is stricter: *no live Orion code
may use CoinGecko or DefiLlama data*; development-time cross-checks outside the code are fine. This spec follows the
2026-11-09 rule, so Phase 3 removes CoinGecko as well. The site's own live-price layer (decision 12) is a site
decision and outside this spec.

Not in scope: new gross / cost-of-revenue series where today's figure is already first-party or on chain (Phase 2
D7 tracks, see D5); new assets; the Phase 2 tail (Task 10 / G3 provenance NOT NULL, Task 11 / G4 retire v1); the
comparison tool (Phase 4).

## 2. What live code reads today (main 0f4b2fe, prod DB 2026-11-10)

Measured from the asset YAMLs, `src/` greps, `docs/ops/sources-register.md` and prod via `sql-ro`.

**DefiLlama, primary or display series** (rows on prod, `source_type = third_party`):

- AERO `flow_usd.fees` (dailyHoldersRevenue, all-chain Aero parent since 10-22): **the revenue line**. 272 rows from
  2026-03-27.
- HYPE `flow_usd.af_buyback` (dailyHoldersRevenue): **the trading revenue line** (revenue_run_rate is derived from it).
  289 rows from 2026-03-27. `flow_usd.revenue_proxy`: 400 rows from 2025-10-11, cross-check.
- PUMP `flow_usd.llama_revenue` (dailyRevenue): **the revenue line** in v2 (§8 of the Phase 2 spec). 502 rows from
  2025-10-12. The adapter `solana.supply_burn_daily` also reads `api.llama.fi` dailyHoldersRevenue as history for days
  before its first on-chain supply reading (only while such a day is inside its window).
- CAKE `flow_usd.fees` (dailyFees, the `volume` line) and `flow_usd.llama_revenue`: 394 rows each from 2025-10-16.
  Display only. CAKE revenue itself is on chain (converters to burner and treasury).
- LIT `flow_usd.fees` and `flow_usd.llama_revenue`: 189 rows each from 2026-05-05. Display only. Also the
  `flow_usd.buyback` cross-check. LIT revenue is first-party (Lighter `exchangeMetrics`).
- UNI `flow_usd.swap_fees` (dailyFees): 187 rows from 2026-07-04. Display only. Revenue is the 0xdead burn, on chain.
- VVV `flow_usd.revenue_proxy`: 341 rows from 2025-12-09, cross-check of the disclosed revenue; plus the
  `flow_usd.burn` cross-check.
- LIT and PUMP `unlocks_next_year` (monitor-only): allocation sizes from `defillama-datasets.llama.fi/emissions/*`.
  27-29 rows each. LIT's timing is already Lighter's own terms; only the allocation sizes still come from DefiLlama.
- `coins.llama.fi` price cross-checks on CRV, cvxCRV, HYPE, sdCRV, SKY, yCRV (6 assets; AERO's went with its rebuild).

**CoinGecko** (every asset except AERO, which has been on chain since orion-2026.11.09.1):

- `price_usd` primary: CAKE, CRV, cvxCRV, HYPE, LINK, LIT, PUMP, sdCRV, SKY, UNI, VVV, yCRV (12), plus VVV's
  `diem_price_usd`.
- `circulating_supply` primary (the market cap basis): CAKE, CRV, HYPE, LINK, LIT, PUMP, SKY, UNI, VVV (9). cvxCRV,
  sdCRV and yCRV already use the on-chain `totalSupply()`.
- `total_supply` cross-checks: CRV, cvxCRV, HYPE, LINK, LIT, PUMP, SKY, UNI, VVV (CAKE's is removed in
  `fix/cake-pending-burn`, §6).
- **Flow valuation:** `transfer_flow` prices each transfer through CoinGecko (`price_coingecko_id`), and the Phase 2
  `prices` table holds hourly CoinGecko prices: 90,335 rows for 12 token refs from 2025-11-17 (CRV, sdCRV, USDS, SKY,
  UNI, VVV, crvUSD (two refs), yCRV, CAKE, CVX, LINK, PUMP). `solana.supply_burn_daily` prices PUMP burns from
  CoinGecko `market_chart`.

**Other third-party (not first-party):** CRV `vote_incentive_run_rate_usd` from Llama Airforce `llama.box` (34 rows,
community API, no stated licence; Phase 2 D4: replaced by on-chain scans in Phase 3). PUMP's price check from Jupiter
`lite-api.jup.ag` (aggregator; terms not checked).

First-party reads that stay: Hyperliquid `info`, Lighter (Core, Robinhood instance, explorer), Venice
`outerface.venice.ai`, Chainlink feeds and pools read over our RPC. Each still needs its licence row in the sources
register before the site export relies on it (Phase 2 §2 rule).

## 3. Shared building blocks (built once, used by every track)

### 3.1 On-chain hourly prices

Replace `src/prices/coingeckoHourly.ts` with a chain price writer that fills the same `prices` table
(`token_ref, ts, price_usd, source, fetched_at`) with `source = 'chain'`, keyed by token ref, so v2's tokens x prices
path (Phase 2 Task 8) is unchanged. Per token ref, one method from config, best first:

1. A Chainlink `<token>/USD` feed read at each hour's block (archive `latestRoundData`). Already in config: CAKE (BNB),
   LINK, UNI. To verify in the plan: CRV, CVX, crvUSD, USDS. A stablecoin with no feed and a hard peg (`tokens.peg`)
   takes its peg's feed.
2. The deepest pool's 1 h TWAP x a Chainlink stable/USD feed (`chain.v2_pool_twap_price`, built for AERO), at each
   hour's block. For wrappers (cvxCRV, sdCRV, yCRV) the pool is the Curve wrapper/CRV pool x the CRV price.
3. Non-EVM: HYPE from Hyperliquid's spot mid/candles (first-party API); PUMP from the deepest PumpSwap pool's reserves
   at slot (Solana RPC). VVV and DIEM on Base: TWAP x USDC feed.

Each price level keeps one independent check (a second pool's `slot0`, `chain.cl_pool_spot_price`, or the feed vs
the pool), never a check computed from the same pool. The `transfer_flow` price lookup and
`solana.supply_burn_daily` read the `prices` table instead of calling CoinGecko.

Cost: 12 refs x 24 hours = ~290 archive calls a day, plus a one-time history rebuild (D3) of
~52,700 calls for 183 days (12 x 24 x 183); the plan measures its Alchemy compute-unit cost first. It runs outside the
05:00-06:30 PT and the 00:45Z/02:45Z nightly windows.

### 3.2 On-chain circulating supply

`circulating_supply` = `chain.view_sum` (total minus cited non-circulating balances: treasury, team and investor
vesting, reserves, staking contracts where they lock), as AERO since orion-2026.11.09.1. Each excluded address is in
the asset YAML with a citation note. Where the protocol publishes its own circulating figure (Hyperliquid
`tokenDetails`, Venice `vvv_stats`), that first-party figure is the check, not CoinGecko. Per-asset lists are scoped in
the plan (one subagent per asset, measured vs claimed marked). History starts on the release day (no level backfill).

### 3.3 Generic source types (Phase 2 §12.7)

Built with the first track that needs each: `pool_scan` (curated pool list, coverage stated; AERO), `api_series`
(first-party daily series with revision days; HYPE fills), `balance_delta` (an account's daily change; HYPE Assistance
Fund, PUMP fee accounts), `event_sum` (one event over a contract list; CRV incentive markets). Each gets its
`ADAPTER_SOURCE_TYPES` rung, a sources-register line and tests with `fakeRpc({ callsAt })`.

### 3.4 Remote verbs for one-time backfills (Phase 2 pre-G2 decision 4)

`orion-remote` verbs (or `job run-now` kinds) for `data fetch --backfill-days`, `data backfill-tokens`,
`data compare-usd`, `db backfill-provenance`, and the new price-history rebuild, so a Phase 3 release needs no
`sudo -iu orion-<env>` from Mike. Mike re-runs `orion-host.sh` once to install them.

### 3.5 Retiring the sources

At the end: delete the `coingecko`, `defillama` and `defillama_share` source types from the zod schema (refused by
name at load, at config-proposal filing and at approve; three tests), remove `coins.llama.fi`, `api.llama.fi`,
`defillama-datasets.llama.fi`, `llama.box`, `lite-api.jup.ag` and `api.coingecko.com` from code, and add a test that
greps `src/` and `assets/` for those hosts. Then regenerate the sources register.

## 4. Per-asset tracks

Each line: what goes, what replaces it, history consequence, value impact.

- **AERO** (pilot). Revenue `flow_usd.fees` (DefiLlama) is replaced by `pool_scan` over `factory.allPools()` on the 7
  chains: `PoolTape` / `CLPoolTape` `accumulators(pool)` at day-boundary blocks plus VotingRewardsManager
  `incentive(id)` programs (scoping: `workspace/orion/aero-scoping/a-revenue-settlement.md`; matched DefiLlama within
  1% on 2026-11-07, dev-only reference). Coverage stated per chain. History: the 272 DefiLlama rows are deleted
  (decision 1). The accumulators can be read at archive blocks back to the merger (2026-10-21/22), so on-chain history
  starts there. Pre-merger Aerodrome is not rebuilt. The 91-day window fills around 2027-01-21; growth (182 days)
  around 2027-04-22. Until then the report shows the shorter window, labelled.
- **HYPE.** Trading revenue = Assistance Fund buys / 0.99 (Phase 2 decision 7) from Hyperliquid `userFills` for the
  fund's address (`api_series`), plus reserve yield (already first-party). Check: the fund's HYPE balance change
  (`balance_delta`) vs fills (a Phase 2 §5 `two_path` check). Price from Hyperliquid spot. Circulating from Hyperliquid
  `tokenDetails` (first-party) or total minus fund minus non-circulating (D4). History: 289 + 400 DefiLlama rows deleted.
  The fills API's look-back is to be measured in the plan; the roadmap expects on-chain history from about 2026-10-10.
- **PUMP.** Revenue from the Solana fee accounts (bonding-curve and PumpSwap protocol fee accounts as single-address
  `balance_delta` reads; creator fees and LP fees as cost lines where measurable, otherwise `not_measured`). The burn
  side (`solana.supply_burn_daily`) drops its DefiLlama `history` param; days before the first supply reading are
  simply absent. Unlocks become a cited manual schedule (D10). Jupiter price check replaced by a second pool (D9).
  History: 502 DefiLlama rows deleted. Fee-account history is readable by signatures back as far as the RPC serves
  them; to be measured.
- **CRV.** `vote_incentive_run_rate_usd` (llama.box) is replaced by `event_sum` over a curated list of incentive
  markets (Votemarket v1/v2 and the others the scoping finds), coverage stated. This is 7.48 of CRV's 12.65 holder flow
  ($M/yr, Phase 2 §8 figures for 2026-10-27), so it is the largest single value at stake. Until it is built the line stays internal-only,
  labelled third_party (Phase 2 D4). Price and circulating per §3.
- **CAKE.** `flow_usd.fees` and `llama_revenue` are dropped. The `volume` line becomes `not_measured` until a gross
  series exists (D5). Price per §3.1 (Chainlink CAKE/USD is already the check). Circulating per §3.2.
  The supply fix in §6 ships first.
- **UNI.** `flow_usd.swap_fees` is dropped (display); gross is `not_measured` until the v2 x6 derived line and the
  v3/v4 scans are built (D5). Price: Chainlink UNI/USD. Circulating per §3.2.
- **LIT.** `fees`, `llama_revenue` and the buyback cross-check go. The buyback check becomes the Phase 2 `two_path`
  check (fills vs the treasury account's LIT balance, first-party). Unlock allocation sizes become a cited schedule
  (D10). Price from Lighter (first-party order book, today's check) with an independent check, or a pool if LIT has a
  deep on-chain one. Circulating per §3.2.
- **VVV.** `revenue_proxy` and the `flow_usd.burn` DefiLlama check go. In their place a `usage_index` watch (Phase 2
  followups table, a watch rather than a check). Revenue stays the cited disclosure. Price: Base TWAP x USDC feed.
  Circulating: on chain, with Venice `vvv_stats` as the check (already a cross-check today). DIEM price the same way.
- **LINK, SKY.** Price (Chainlink LINK/USD; SKY via the deepest pool, because SKY's Chronicle pip reverts through
  Multicall3) and circulating only. Revenue is already on chain.
- **cvxCRV, sdCRV, yCRV.** Price only (wrapper/CRV Curve pool x CRV price); remove the `coins.llama.fi` checks.
  Circulating is already on chain. The `yearn-crv` / `crvusd` token refs move to chain prices.

## 5. Release order

Each release goes stage first, then soaks one scheduled nightly, then prod on Mike's go (standing rule). Each one
proves the other assets byte-identical on a read-only prod copy (`tools/phase2-proof/prod_copy.py`). For the assets it
changes, it gives a before/after table over both windows (the latest 91 days and the 91 days before them).

1. **R0 (now):** CAKE pending-burn supply fix (§6). The remote backfill verbs (§3.4).
2. **R1, no value change:** drop the display-only and cross-check DefiLlama reads (CAKE fees/llama_revenue, LIT
   fees/llama_revenue/buyback check, UNI swap_fees, VVV revenue_proxy and burn check, the six `coins.llama.fi` checks,
   the CoinGecko `total_supply` checks) and the LIT/PUMP unlock datasets (D10). Revenue, holder flow and yield are
   unchanged; `volume` lines become `not_measured`. Their DefiLlama rows are deleted.
3. **R2, the price swap:** §3.1 for all 12 assets and the hourly price history rebuild (D3). This changes every USD
   figure by the CoinGecko-vs-chain price gap. The proof gives the per-asset gap over both windows.
4. **R3, circulating on chain:** §3.2 per asset. This moves market cap and every yield on market cap. Per-asset
   before/after.
5. **R4 AERO revenue** (the pilot; `pool_scan`).
6. **R5 HYPE**, **R6 PUMP**: revenue replacement plus deletion of their DefiLlama history.
7. **R7 CRV vote incentives** (`event_sum`).
8. **R8 retire:** source types deleted, hosts grep test, sources register (§3.5).

After R3 nothing CoinGecko-derived is stored. After R7 no third-party figure is published.
**Phase 5 interplay:** the site export may ship before R8 only if an asset's exported fields carry no `third_party` or
CoinGecko-derived figure. The export already carries provenance, so the export can refuse such fields per asset.

## 6. R0: CAKE supply fix (built on `fix/cake-pending-burn`, 0ecc69e, from main 0f4b2fe)

Finding (2026-11-10, read-only, BNB archive via Alchemy):

- MasterChef v1's harvest mints its accrued emission in one tx: 2026-11-09 01:08Z, tx `0xbe5bd6b8...`, 43.79M CAKE
  to v2 (via the SyrupBar) and 4.38M to the burner. v2 returns about 99.7% of it to the burner, which sends it to
  dead in the weekly burn. Until that burn, the minted CAKE sits in v2 or the burner.
- `total_supply` nets only dead, so it spiked after every harvest: 375.1M (10-12), 363.5M (10-30), 394.4M (11-09),
  against a base of about 335M. That is 8-18% for days at a time, which moves FDV and dilution the same way.
- Staging raised anomaly 17 (13.85% vs CoinGecko's 339.8M on 11-09 02:45Z). Prod read the same 394.43M on 11-10, but
  raised nothing: by then CoinGecko's own figures had moved too (circulating 376.96M), so the 2.5% check passed. The
  check missed the spike because it compares against a source with the same blind spot.
- Netting dead, the burner and v2 gives a smooth series: 335.47M (10-06), 335.11M (10-17), 334.76M (10-30), 334.57M
  (11-10).

Change: `subtract_balances: [ dead, burner, masterchef_v2 ]`. The CoinGecko total cross-check is dropped: a touched
metric reads no CoinGecko, and a check built from these balances would be circular. CAKE hash re-pinned to `2d05a80b`;
`docs/ops/sources-register.md` regenerated. Suite: 1556/1560 at `--maxWorkers=2`. The 4 failures were LIT (known
load-sensitive) and the register (regenerated); both files pass alone at `--maxWorkers=1` (12/12). Typecheck clean.
Anomaly 17's disposition: resolve, with the note "MasterChef v1 harvest pending the weekly burn; total_supply now nets
burner + v2 (fix/cake-pending-burn)", on Mike's go after the fix is staged.

## 7. Proof and acceptance (every release)

- Suite green and typecheck, no skips left uncounted (load-sensitive files rerun alone).
- A read-only prod copy. Other assets: `report yield --day D` v2, `cmp` identical (`--legacy` and v1 are gone since
  `orion-2026.11.11.1`, Phase 2 Task 11: compare v2 only, `tools/phase2-proof/reports.sh` + `compare.py` as they are). Changed assets:
  before = prod's own `report yield <a> --day D`; after = the branch on the copy.
- A sign-off table covers every day the report reads (growth reads 2 x 91 days).
- `git grep` for the retired hosts returns only tests and docs at R8.

## 8. Decisions owed (Mike)

- **D1 Scope.** Phase 3 removes CoinGecko as well as DefiLlama (the 2026-11-09 rule supersedes roadmap rule 5 /
  decision 3 for Orion). *Recommend yes.*
- **D2 Price method** (§3.1): Chainlink feed > deepest-pool TWAP x Chainlink stable feed > first-party venue (HYPE,
  LIT) > Solana pool reserves (PUMP); one independent check each. *Recommend as written.*
- **D3 Price history.** (A) Rebuild the 183-day hourly history from chain and re-price stored flows, so no
  CoinGecko-derived USD is kept. Cost: about 52.7k archive calls, one time. (B) Keep the CoinGecko-priced rows,
  labelled legacy, and use chain prices from the release day only. That carries licence risk if the site publishes
  them, and two price bases sit inside one window. *Recommend A.* It also closes the Phase 2 Task 8 I-1 option
  (re-pricing the "beyond" rows), because every row gets re-priced.
- **D4 Circulating** (§3.2): (A) on chain via `chain.view_sum` with cited exclusions per asset, using the first-party
  figure as the check where one exists. (B) Publish no market cap until it is owned (FDV only). *Recommend A.*
- **D5 Gross lines DefiLlama fed** (CAKE `volume`, UNI swap fees, LIT fees): (A) drop to `not_measured` now and
  build the on-chain gross series as a later Phase 3b (UNI v2 x6 derived, v3/v4 scans, CAKE v2/v3). (B) Build the gross
  series inside Phase 3 before dropping them. *Recommend A.* No revenue or holder figure depends on them.
- **D6 History deletion** (roadmap decision 1): delete each asset's DefiLlama rows in the release that replaces them,
  and backfill on chain where the source allows it (AERO to the merger, HYPE as far as fills go). *Recommend as written.*
- **D7 CRV incentives:** (A) build `event_sum` scans in Phase 3 (R7), keeping llama.box internal-only until then.
  (B) Publish CRV with the incentive line `not_measured` from the start. *Recommend A.* It is 59% of CRV's holder flow.
- **D8 Order** (§5): R0 → R1 → R2 → R3 → AERO → HYPE → PUMP → CRV → retire. *Recommend as written.* This is the
  roadmap's easiest-first, with the price swap moved ahead of the revenue rebuilds because every rebuild needs chain
  prices.
- **D9 PUMP price check:** replace Jupiter with a second PumpSwap / Raydium pool. *Recommend yes.*
- **D10 LIT / PUMP unlocks:** cited manual schedules (disclosure rung, Lighter's terms / pump.fun's published
  schedule) instead of the DefiLlama emissions datasets. *Recommend yes.*
- **D11 R0 now:** ship `fix/cake-pending-burn` as its own release (stage, soak, prod) ahead of the rest. *Recommend yes.*
