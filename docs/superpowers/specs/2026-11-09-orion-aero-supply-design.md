# AERO supply, emissions and price after the Aero merger: design

**Status:** APPROVED by Mike 2026-11-09. Branch `feat/aero-supply` from main b354680 (release orion-2026.11.08.1).
- D1 A, D3 A, D4 A, D6 A as recommended.
- **Change (Mike): no live Orion code may use CoinGecko or DefiLlama data** (licensing). They may be used during
  development as cross-checks, outside the code. So D2 becomes B (circulating on chain), D5 becomes on-chain (price from
  an Aero pool TWAP x the Chainlink USDC/USD feed, cross-checked against a second, independent Aero pool), and every
  CoinGecko and DefiLlama cross-check on AERO's touched metrics is dropped. See section 3.4 for the amended design.
- Scope note: AERO revenue (`flow_usd.fees`, DefiLlama) stays as it is in this branch, because no on-chain source exists
  yet. It is the Phase 3 pilot (scoping in `workspace/orion/aero-scoping/`), so this branch adds no new CoinGecko or
  DefiLlama use and removes AERO's price and supply reads from them.

**Scope:** step 1 of the AERO rebuild. Supply, emissions, staked base and price move to the new Aero contracts. Revenue
keeps its DefiLlama series with no value change, but is labelled as the all-chain Aero series since 2026-10-22. Revenue,
incentives and DefiLlama removal are the Phase 3 pilot (scoping in `workspace/orion/aero-scoping/`), not this branch.

## 1. What prod reads today (release orion-2026.11.08.1, day 2026-11-08)

All of these come from the pre-merger contracts or the old CoinGecko id.

- **Price:** $0.579 (CoinGecko `aerodrome-finance`, the old token).
- **Circulating:** 305M (CoinGecko `aerodrome-finance`). This falls as holders upgrade, so the market cap of $177M is wrong.
- **Total:** 2,007.6M (the old token's `totalSupply()`). Upgrading never burns the old token, so the figure stays frozen.
- **Staked/locked:** 1,706.4M, read from the old VotingEscrow `supply()`. The old ve kept growing during the upgrade.
- **Emissions:** 202.2M/yr from the old Minter's tail formula. That Minter stopped on 10-22. This gives dilution of 10.1%.
- **Revenue:** $83.6M/yr from DefiLlama `aerodrome` `dailyHoldersRevenue`. Since 10-22 the series silently returns the
  all-chain Aero parent (`parent#aero-protocol`).

## 2. Measured on chain, 2026-11-09 (Base block 55,335,954, 20:52Z; read-only)

Contracts come from app.aero.xyz/docs/security. Source is `dromos-labs/metadex-public` (V3/src).

| Item | Value | Read |
| --- | --- | --- |
| New AERO `totalSupply()` | **2,137.66M** | token 0x3f5b…a4Ee |
| Pre-mint at launch (10-22 00:00Z) | 2,127.00M = 2,010.12M Aerodrome + 116.88M Velodrome | `Token` constructor mints both allocations to the migration contracts |
| Upgrade reserve, Aerodrome | **357.38M** | `balanceOf(AerodromeMigration 0x22a2…6721)` (= its `remaining()`) |
| Upgrade reserve, Velodrome | **27.71M** | `balanceOf(VelodromeMigrationEntrypoint 0x6daE…66c0)` |
| Upgrade reserve, total | **385.09M** (18.0% of total) | at least 2.49M of it can never be claimed: the Aerodrome allocation (2,010.12M) is larger than the old supply (2,007.63M) |
| New VotingEscrow `supply()` (sAERO) | **1,061.42M** | ve 0xBF79…3915 |
| Liquid new AERO (total − sAERO − reserve) | 691.15M | derived |
| CoinGecko `aero` (20:57Z) | circulating **689.13M**, total 2,135.58M, $0.5703 | `/coins/markets?ids=aero`: now populated (it was 0 on 11-05) |
| CoinGecko `aerodrome-finance` | circulating 304.93M, total 2,007.63M, $0.5725 | old token |
| DefiLlama coins, new address | $0.5703 | `coins.llama.fi/prices/current/base:0x3f5b…` |

**Upgrade pace** (fall in the two reserves, per UTC day):

- 10-23: 964.7M (sAERO upgrades at launch).
- 10-24 to 11-03: 2 to 61M a day.
- 11-04 to 11-05: 85.0M and 373.5M (the exchange batches: Coinbase finished on 11-04).
- 11-06 to 11-08: 16.3M, 35.7M and 10.2M.
- 11-09: 3.2M.

### 2.1 New Minter (0x5926…9C97): the emission schedule

- **Mint-on-redeem.** `mint(amount, recipient)` is callable only by the Voter. It runs when an LP redeems AERO Rewards,
  not on a weekly epoch. It also mints `teamRate` on top to the Splitter. `emissionsMinted()` is the running recipient
  total and excludes the team share.
- **Rate and cap.** `baseRate` = 13.489345 AERO/s, unchanged since activation (`ACTIVATION_TIMESTAMP` 1792627200 =
  10-22 00:00Z). `emissionsCap` accrues at the effective rate. A mint that would exceed the cap reverts.
- **Rate changes.** The operator (0xec76…a0) may move `baseRate` by at most `maxBaseRateChangePips` 12,000 (1.2%) per
  `baseRateUpdateCooldown` 169,200 s (47 h). That is up to about ±20% a month. The contract's absolute ceiling is
  `MAX_BASE_RATE_CHANGE_PIPS_CAP` 5% a week.
- **Team share.** `teamRate` = 50,000 pips = **5%** on top of each mint. The Splitter holds 0.527M, which is 5% of the
  10.537M minted.
- **Dynamic rate.** `dynamicRateModule` = 0x0, `dynamicRate` = 0 and bands 0/0, so the effective rate is `baseRate`. The
  FED (0x4225…ce0) can install a module, which would clamp the rate to a band of up to ±50% around `baseRate`.
- **Ceiling.** 13.489345 × 31.536M s × 1.05 = **446.7M/yr = 20.9% of total**. This is the "20% ceiling" in Aero's
  upgrade hub.
- **Realised.** `emissionsMinted()` is 10.537M after 18.87 days. The cap accrued so far is 21.99M, so 48% of the cap has
  been minted. Realised annual rates, including the team share:
  - Since launch (18.9 d): **214.0M/yr = 10.0%**.
  - Last 14 d: 229.6M/yr = 10.7%.
  - Last 7 d: **251.6M/yr = 11.8%**. Aero's hub claims "~12% realised".

  Daily mints rose from 0.27M on 10-22 to 0.6-0.78M in November, as more liquidity moved over.
- **The "USD cap" mechanics.** There are none in the Minter or the Voter: a grep of the whole `V3/src` tree finds USD or
  oracle logic only in pools and swap-fee hooks. The cap is a token cap. The claim of "liquidity rewards denominated in
  $ value" (the hub page) would have to come from off-chain rate setting by the operator within ±1.2% per 47 h, from
  per-gauge caps (cap admin and operator multisigs), and from a future FED dynamic-rate module. **The schedule Orion can
  read is therefore `baseRate` (the ceiling) and `emissionsMinted` (realised).**
- **Mint lag.** Rewards earned but not yet redeemed are not minted, so realised emissions lag accrual. Part of the
  cap-minus-minted gap (11.45M) is such a backlog and part is unused surplus. The split is not measured. Base xAERO
  receipt supply is 0.

### 2.2 The supply terms used here (skill definitions)

- **`total_supply`** (the FDV basis) is new AERO `totalSupply()`: **2,137.66M**. Nothing is subtracted, because the
  token has no burn sink: VotingEscrow fee burns and `burnRemaining` go through `burn()` and lower `totalSupply`
  itself. The total **includes** the 385.09M upgrade reserve, as CoinGecko's does (2,135.58M, 0.10% apart).
- **`circulating_supply`** (the market cap basis, display only) is CoinGecko `aero`: **689.13M**. It matches liquid new
  AERO on chain (691.15M = total − sAERO − reserve) to 0.29%, so CoinGecko excludes both the reserve and sAERO.
- **`staked_supply` and `locked_supply`** are the new VotingEscrow `supply()`: **1,061.42M** sAERO. This is the
  recipient base of `holder_flows.fees` (`recipient_base: locked`).
- **Upgrade reserve** is not circulating, per Mike. It goes to **`reporting.dilution`**, using the UNI/LINK pattern for
  supply already inside total that moves to circulating. There are two lines (`aero_upgrade`, `velo_upgrade`), each with
  a rate and a cap equal to that contract's balance.
- **Emissions** (`emission_rate_annual`) are the new Minter's realised rate including the 5% team share (D4).
- **`staker_emission_share`** becomes `constant 0`. sAERO receives no emissions and no rebase: the Minter mints only to
  redeeming LPs and the Splitter. sAERO earns exchange revenue instead.

## 3. Design

### 3.1 Config (`assets/aero.yaml`; moves AERO's hash only)

- **`contracts`:**
  - `token` → 0x3f5bF3EdAc59d650D8fDf9657a71F2f904A3a4Ee
  - `ve` → 0xBF7977E1521e9a3032bf7243Ee4712f311f13915
  - `minter` → 0x59268A34ba897e82368feE39839FFC661D4f9C97
  - new `aero_migration` 0x22a2F7340a3fB4C7C389D91eE954766B12476721
  - new `velo_migration` 0x6daE95FE833f190640dB1176F8C8a2e50C6a66c0
  - the old addresses stay as `legacy_token`, `legacy_ve` and `legacy_minter`, read by nothing, so the history stays
    explained. `team` is dropped, since the Splitter replaces it.
- **`external_ids.coingecko`:** `aero`. `name` becomes "Aero". `external_ids.defillama` stays `aerodrome`, because
  revenue is unchanged.
- **`price_usd`:** CoinGecko `aero`. The cross-check is DefiLlama coins at the new address (D5).
- **`total_supply`:** `erc20_supply` on the new token. The cross-check is CoinGecko `aero` `total_supply` at 2%.
- **`circulating_supply`:** CoinGecko `aero`. A new `monitor_only` level `liquid_onchain` gives the on-chain derivation
  for display. Wiring it as a 1% check is a Phase 2 checks item, so it is not part of this branch unless Mike asks.
- **`staked_supply` and `locked_supply`:** `contract_read ve.supply` on the new ve.
- **`staker_emission_share`:** `constant 0` (note: "sAERO earns exchange revenue, not emissions").
- **`emission_rate_annual`** (schedule, critical): the new adapter (3.2) on `minter.emissionsMinted()`, plus 5% read
  live from `teamRate()`, over D4's window, with `not_before` set to activation.
- **New `monitor_only` levels:**
  - `emission_ceiling_annual` (baseRate × year × (1+team)), so the ceiling and any operator move show in the report.
  - `upgrade_reserve_aero` and `upgrade_reserve_velo` (`contract_read` `balanceOf`), the caps.
  - `upgrade_release_aero` and `upgrade_release_velo`, the rates, from the new adapter in `fall` mode.
- **`reporting.dilution` and `income_statement.dilution`:** two lines, `aero_upgrade` and `velo_upgrade` (rate = release,
  cap = reserve), set up per D3.
- **Revenue:** no value change. The `income_statement.revenue[fees].label` and a `note` say: "DefiLlama `aerodrome`
  dailyHoldersRevenue: Base-only Aerodrome before 2026-10-22; the all-chain Aero parent (parent#aero-protocol, 7 chains)
  since. The 91-day window spans the change." The same note goes on `reporting.revenue`/`income`, so v1 and v2 both say
  it. Never re-backfill from DefiLlama: the 2026-09-09 manual correction row stays.
- **Delete `aero.ts`'s two adapters** (`aero.emission_rate_annual`, `aero.staker_emission_share`). They model the old
  Minter's tail and would refuse or misread the new one. `src/report/sourceTypes.ts` gets the generic adapter's entry in
  their place.

### 3.2 A new generic adapter: `chain.counter_rate`

This is a contract-state read, top of the method ladder. It needs archive `eth_call`, which Alchemy Base has.

- **What it reads.** One `uint256` view (`contract`, `function`, optional `args`, `decimals`) at the run's block and at
  the first block at or after `now − days` (with `firstBlockAtOrAfter`, the interpolating search from 895c8a1 that is
  already on main). The start is clamped to `not_before` when one is given.
- **What it returns.** `rise` is `(now − then)`; `fall` is `(then − now)`. Either is divided by the elapsed days × 365,
  as a `level`.
- **Optional team share.** `plus_share: { contract, function, denominator }` multiplies the rate by
  `1 + value/denominator`, which turns the Minter's `teamRate` 50,000/1e6 into ×1.05.
- **Optional burn guard.** `refuse_if_supply_falls: <token>` refuses the reading when the token's `totalSupply` fell over
  the window. This stops a `burnRemaining` (which burns the whole reserve) from being counted as release.
- **Refusals.** It refuses a negative result, an elapsed time under 1 day, and unknown params (`validateParams`,
  `paramsDoc`).
- **Detail.** The detail names both blocks and both readings.
- **No backfill needed.** Two reads give the window's rate on day one, so the "level history starts on go-live" gap does
  not apply.
- **Reuse.** Any cumulative counter or draining reserve fits: Minter counters, vesting contracts, treasury drains.
- **Tests first:** a mock RPC at two blocks, `rise` and `fall` cases, the `not_before` clamp, `plus_share`, the burn
  guard, and param refusals. Then an AERO asset ingest test (fixture YAML re-pinned) and report tests for the two
  dilution lines.

### 3.3 Proof and release (steps 4-5 of the brief)

1. **Before/after table.** Run `tools/phase2-proof/prod_copy.py` (read-only prod via `sql-ro`). The OLD home gets
   release `orion-2026.11.08.1`'s assets and the NEW home gets the branch's. Fetch AERO in the NEW home at a fixed block.
   The table compares `report yield aero` for marketCap, fdv, circulating, total, staked, dilution (with its lines),
   yields and revenue. For the 12 other assets, a `cmp` of each `report yield` shows them byte-identical.
2. **Release.** On Mike's go: merge, push, tag, `build.sh`, `deploy.sh stage`, then a staging `job run-now` refresh of
   AERO, then verify. Prod follows after another go.
3. **Soak.** The `orion-stage-soak` stage-vs-prod parity will diverge on AERO (price-independent fields such as total,
   staked and emissions) until prod gets the tag. This divergence is expected and should be noted in the soak thread.

### 3.4 Amended design: no CoinGecko or DefiLlama in live code (Mike, 2026-11-09)

This section replaces any CoinGecko or DefiLlama source named in 3.1. Measured at Base block ~55.34M, 2026-11-09:

- **`price_usd`** uses the new generic adapter **`chain.v2_pool_twap_price`**.
  - It reads `currentCumulativePrices()` on an Aero basic (v2) pool at the run block and at the first block on or after
    `now − seconds`. The window is 3,600 s. From the two reads it takes the time-weighted reserves, so the price is
    `reserve_quote / reserve_token`, adjusted for decimals, then multiplied by a Chainlink feed (`latestAnswer`,
    8 decimals).
  - Pool: volatile AERO/USDC `0xf634058dc94e6bf8e828e27621320c423bc8b18e` (27.2M AERO and $15.6M USDC, the deepest
    pool found). Feed: Chainlink USDC/USD on Base, `0x7e860098F58bBFC8648a4311b374B1D669a2bc6B` (0.99976).
  - It refuses a pool that does not hold the token, a window with no elapsed time, and an answer that is not positive.
  - Reading at 11-09: 1h TWAP $0.57183 x 0.99976 = **$0.5717**. Spot is $0.57177.
- **The price cross-check** uses the new generic adapter **`chain.cl_pool_spot_price`**. It reads `slot0().sqrtPriceX96`
  on an independent Slipstream pool, CL200 AERO/USDC `0xd0acf293547457fb4fe9ee32ca93e89497626816` (5.9M AERO,
  $1.0M USDC), multiplied by the same feed. Reading: **$0.5699**, 0.3% from the primary. Tolerance 2%.
  - Dev-only reference, not in code: CoinGecko `aero` $0.5703 and DefiLlama coins $0.5703.
- **`circulating_supply`** uses the new generic adapter **`chain.view_sum`**: a signed sum of `uint256` views in one
  multicall at the run block. Here it is new `totalSupply()` − `ve.supply()` − `balanceOf(aero_migration)` −
  `balanceOf(velo_migration)` = **691.15M**. It refuses a negative result.
  - Dev-only reference: CoinGecko `aero` 689.13M (0.29%). On chain, the market cap is **$395M**.
- **`total_supply`** is `erc20_supply`, with no cross-check. CoinGecko is gone, and an on-chain check against the parts
  would be circular, because circulating is computed from total.
  - Dev-only reference: CoinGecko total 2,135.58M (0.10%).
- **Old cross-checks deleted:** DefiLlama coins on price, and CoinGecko on total.
- **Kept:** `external_ids.coingecko`. It is an identifier, not a data read, so dropping it buys nothing; the sources no
  longer use it. If any code path still reads CoinGecko from it (e.g. the hourly `levels.ts` reads,
  `price_coingecko_id`), that use goes for AERO.
- **`flow_usd.fees` (DefiLlama) stays in this branch.** See the Status scope note. Its label says it is the all-chain
  series. Phase 3 replaces it.

Every adapter is generic, configured by contract names from `contracts`, and tested against a mock RPC first.

## 4. Decisions Mike owes (priced at 2026-11-09, price $0.5703, revenue $83.6M unchanged)

**D1. Total supply basis.**
- **A (recommended):** include the reserve. Total is 2,137.66M and FDV $1,219M. This matches CoinGecko and the UNI/LINK
  precedent, and the reserve is reported as dilution.
- **B:** exclude it. Total is 1,752.57M and FDV $999M, but then the dilution lines would count tokens that are outside
  total.

**D2. Circulating.**
- **A (recommended):** CoinGecko `aero`, 689.13M, market cap $393M (from $177M). The on-chain 691.15M is shown as a
  monitor line.
- **B:** on-chain only (691.15M, $394M). This adds an engine path for a level computed from three reads, for 0.3%.

**D3. Upgrade-reserve dilution rate** (cap = remaining reserve, 385.09M in both live options).
- **A:** trailing **30-day** release, annualized and capped. Today it is capped at 385.1M/yr, which adds **+18.0 pts**
  and puts total dilution at **28.0%** (corrected 2026-11-09: 29.8% was an addition error, 11.8% + 18.0%; the proof reads 28.0%). It stays at the cap until conversions run below ~1.05M a day for 30 days (11-09
  ran at 3.2M).
- **B:** trailing 365 days, as for LINK. It is also capped today, and it stays at the cap far longer.
- **C:** a rate of 0, with the cap shown. Dilution stays at the emissions-only 10.0-11.8%.
- **Recommendation: A**, as you directed: the reserve is dilution, measured and capped, and it decays on its own.
- **Caveat:** an upgrade dilutes no one. Old AERO already trades 1:1, so the +18 pts is a circulating-base effect rather
  than new supply. If the 28.0% headline reads wrong to you, C is the honest alternative (the reserve still shows as two
  lines).

**D4. Emission rate.**
- **A (recommended):** realised `emissionsMinted` × 1.05 over a **91-day** window, clamped to launch until 2027-01-21.
  Today that is 214.0M/yr = **10.0%** (was 202.2M/10.1%).
- **B:** a 30-day window. It is the same 214.0M until 11-21, then tracks faster. The current 7-day pace is 251.6M = 11.8%.
- **C:** the ceiling, 446.7M/yr = **20.9%**. This overstates realised emissions by 2.1×. Under A and B it still shows as
  `emission_ceiling_annual`.
- A follows the 91-day rule. Its weakness is that it lags the ramp-up: daily mints doubled in 18 days.

**D5. Price cross-check.**
- **A (recommended):** DefiLlama coins at the new address. It is the same dependency as today, and Phase 3 removes it.
- **B:** an on-chain pool price (a new adapter on an AERO/USDC Slipstream pool), which brings Phase 3 work forward.

**D6. Legacy metrics.**
- **A (recommended):** no legacy reads. Old AERO is still 2,007.6M on chain, and its unconverted part is the reserve.
- **B:** keep a `monitor_only` level of old-token circulating from CoinGecko `aerodrome-finance` for the coinrevs
  migration view.

### Value impact of the recommended set (D1A D2A D3A D4A D5A D6A)

| Field | Prod 11-08 | After (11-09 reads) |
| --- | --- | --- |
| price | $0.579 | $0.570 (CoinGecko `aero`) |
| circulating | 305.3M | 689.1M |
| marketCap | $176.8M | $393.0M |
| total | 2,007.6M | 2,137.7M |
| fdv | $1,162M | $1,219M |
| staked / locked | 1,706.4M | 1,061.4M |
| emissions | 202.2M/yr | 214.0M/yr |
| dilution | 10.1% | 10.0% emissions + 18.0% reserve = 28.0% (proof: 28.02%) (D3C: 10.0%) |
| cash yield (fees on staked) | 8.3% | ~13.5% |
| net shareholder | −1.8% | −14.5% (proof; D3C: ~+3.5%) |
| revenue | $83.6M | $83.6M (unchanged; relabelled all-chain since 10-22) |

The proof table in step 4 replaces these estimates with the real `report yield` output from the prod copy.

## 5. Out of scope

- Revenue re-sourcing.
- Incentives as an income line.
- DefiLlama removal: Phase 3 pilot, scoping in `workspace/orion/aero-scoping/`, built after the Foundation subsidy ends.
- Task 10 (G3).
- Any AERO DefiLlama re-backfill.

## 6. Proof (2026-11-09, read-only prod copy p2proof_20261109t213402z, report day 2026-11-08)

- Before = prod's own `report yield aero --day 2026-11-08` (orion-2026.11.08.1). After = the branch dist on the prod copy
  after `data fetch aero` of every metric except `flow_usd.fees` (Base block at 21:44:29Z; no anomalies, all sources ok,
  price check 0.571025 vs 0.569726 = 0.23%).

| Field | Before | After |
| --- | --- | --- |
| price | $0.578905 (CoinGecko) | $0.571025 (pool TWAP x Chainlink) |
| circulating | 305.32M | 691.24M |
| marketCap | $176.75M | $394.71M |
| total | 2,007.63M | 2,137.68M |
| fdv | $1,162.2M | $1,220.7M |
| staked | 1,706.4M | 1,061.4M |
| emissions | 202.20M/yr | 213.98M/yr |
| dilution | 10.07% | 28.02% (emissions 10.01% + Aerodrome reserve 16.71% + Velodrome reserve 1.30%) |
| cash yield (fees on staked) | 8.30% | 13.53% |
| net shareholder | -1.77% | -14.50% |
| multiple | 12.05x | 7.39x |
| revenue | unchanged | unchanged (label and notes only) |

- The other 12 assets: `report yield` v2 and `--legacy`, release dist vs branch dist on the same copy, byte-identical
  (24/24), at day 2026-11-09 before the AERO fetch and at day 2026-11-08 after it.
