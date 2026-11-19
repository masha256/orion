# Orion Phase 3 R3: circulating supply on chain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One release after which no live code reads CoinGecko at all and nothing CoinGecko-derived is stored: every
asset's `circulating_supply` comes from an owned method (chain `view_sum`, a first-party API, or a cited schedule), the
EVM assets' stored CoinGecko circulating rows are rebuilt from archive reads, and every `market_data` row is purged
(spec §3.2, §5 R3, D4).

**Architecture:** Twelve asset YAMLs change their `circulating_supply` source (AERO already done). Two small `view_sum`
extensions (`times` per term, `locked_schedule`) and two adapters (`hype.circulating_supply`,
`solana.supply_less_owners`) cover what `view_sum` can't. The loader refuses every `coingecko` source field (R24's
price refusal extended), so `/coins/markets` is never called (code deleted in R8). A new `data rebuild-supply-levels`
re-reads each stored circulating row's source at the block of its `observed_at`; `data purge --source-type
market_data` then deletes the CoinGecko rows, refusing any that a rebuild could have replaced. No migration.

**Tech Stack:** TypeScript (Node 26, vitest, zod, viem), Postgres 18, Python 3 (`orion-remote`, proof tools).

**Spec:** `docs/superpowers/specs/2026-11-09-orion-phase3-third-party-removal-design.md` (§3.2, §5 R3, D4).
Scoping (measured 2026-11-19, measured/claimed marked, CoinGecko dev-only): `~/.hermes/profiles/raymond/workspace/orion/phase3-r3-scoping/`
(`README.md` = the table and decisions' numbers; `code-and-data.md`; per asset `crv-wrappers.md`, `link-uni.md`,
`sky-lit.md`, `cake-vvv-aero.md`, `hype-pump.md`). **Every address in this plan's YAML work is copied from those files.**

**Base:** GitHub `main` 06955e0 = `orion-2026.11.15.1` code (02f39e3) + RET-41 (`chore/r2-followups`, merged
2026-11-19 by another session: stage `sql-ro` design, R43 allowlist and `r2-prod-6to10.sh` in `tools/phase3-proof/`,
deploy.md section 7 "expected pre-remap artifacts"). Stage `sql-ro` is live only after Mike re-runs `orion-host.sh`
from a snapshot at or after 06955e0; the R3 `orion-host.sh` re-run (Task 6 prerequisite) installs both. Branch
`feat/phase3-r3-supply`; if main moves again, rebase onto GitHub main, never local `main`.

## Global Constraints

- No live read of CoinGecko or DefiLlama is added. After this release no code path calls `api.coingecko.com`
  (`/coins/markets` included); a config naming a `coingecko` source of any field is refused at load, filing and approve.
  The `coingecko` type and its code stay until R8 (spec §3.5).
- No migration. The release must run on schema 8; `orion-2026.11.15.1` must still run after it (rollback, Task 6).
- Value moves allowed: `circulating_supply` itself and what it feeds — `marketCap`, `incomeStatement.multiples.mcapTo*`,
  `incomeStatement.perToken.{revenue,grossProfit,holderFlow.*,dilution,circulatingSupply}` — plus provenance/source
  labels of that metric. Every other field (prices, flows, revenue, growth, PEG, every `yields.*`, `perTokenFdv`,
  dilution, grades) is byte-identical. Anything else in the proof is a stop.
- Staking rule (decision N1a): tokens in irrevocable long locks (veCRV, veAERO) are not circulating; staking with an
  exit (cooldown, fee-free withdraw) is circulating (LINK v0.2, lsSKY, VVV, LIT, HYPE).
- Every excluded address is a named `contracts:` entry with a comment carrying its citation or on-chain evidence.
- Tests: `export ORION_TEST_DATABASE_URL='postgresql://orion_dev@/orion_test?host=/var/run/postgresql'`;
  `npx vitest run --maxWorkers=2`, load-sensitive files rerun alone at `--maxWorkers=1`; `npm run typecheck`;
  `python3 -m unittest scripts/provision/test/test_orion_remote.py`. RPC only through `fakeRpc({ callsAt })` and fake
  HTTP/Solana transports; no network in any test.
- Commit with explicit `git add <paths>`; never `-a`. Implementers never use the network, ssh, a `.env`, or a live DB.

## Plan decisions (owed by Mike; recommendations marked)

- **N1 Per-asset methods** (scoping `README.md` table): as recommended there. Sub-decisions:
  - N1a staking rule above (rec). N1b CRV: Curve Treasury out (rec), unvested grant escrows in (rec: they appear only
    from 2025-12 and end 2027-04). N1c wrappers: protocol-treasury holdings out (rec; yCRV needs `times`).
  - N1d **PUMP**: (A) mint - Token Custodian = 592.51B (+29.4% vs prod), (B, rec) also - the five custodian-funded
    vaults untouched since 2025-07-14 (189.0B; one holds exactly the published 2.4% ecosystem fund) = 403.51B
    (-11.9%), (C) also - three 1/48-monthly vesting vaults (46.67B) = 356.8B (-22%). B treats issuer-controlled
    dormant vaults as treasury, as Orion does for UNI/VVV/CRV; the evidence is on-chain provenance, not a label.
  - N1e **CAKE**: (B, rec) - old CAKE pool - retired veCAKE = 315.73M (-4.96%); (A) total = 334.25M; (C) B - MasterChef
    v1 dormant stakes = 308.5M.
  - N1f LIT: locked team/investor by the cited schedule (rec), staked and L2 treasury in. N1g HYPE: Hyperliquid's
    figure less the two genesis wallets (rec) vs raw (+26.9%). N1h UNI: Timelock + UF + Aera out (rec). N1i SKY: Pause
    Proxy + converter `take()` out, lsSKY and converter-held MKR-backed SKY in (rec). N1j VVV: view_sum primary, Venice
    `vvv_stats` stays the check at 2% (rec).
- **N2 History of stored circulating rows.** (A, rec) Rebuild at archive blocks every stored row of the EVM assets
  (CAKE, CRV, LINK, LIT, SKY, UNI, VVV CoinGecko rows; cvxCRV, sdCRV, yCRV contract_state rows, so each asset has one
  definition), then purge the CoinGecko rows; HYPE, PUMP and AERO's 45 pre-rebuild rows have no rebuild (no archive,
  or pre-migration token): purged, their market cap starts on the release day (AERO: 2026-11-10). (B) Purge all
  CoinGecko rows, no rebuild: market cap null on every past report day of the 9 assets. (C) Keep them labelled until
  R8: contradicts R3's goal. Under A, UNI's past market caps drop ~2.8% before 2026-11-02 (CoinGecko began excluding
  the UF/Aera wallets then); CAKE's pending-burn spikes (up to 377M) disappear.
- **N3 Purge.** `data purge <a> --metrics circulating_supply --source-type market_data --yes` after the rebuild: 428
  rows on 2026-11-19 plus 9 a night until the release. Exports go to `~/home/purged/` on venus as every purge does:
  (rec) keep them there (rollback evidence, never served). The published `masha256/orion-data` git history keeps old
  CoinGecko-derived figures: (rec) leave it (Phase 5 decides the site's history).
- **N4 Allowlist classes** (Task 7): (S) the circulating-derived paths above, on the 12 changed assets, as a `ratio`
  pin = the signed proof's new/old ratio ± 0.01 (a new flatdiff bound, Task 7 Step 1); (L) exact `old`/`new` value
  pins for the metric's source labels; everything else no entry (fail closed): growth, PEG and yields must not move. Any
  growth entry that ever has to be added carries the abs floor AND a rel alternative (R43 lesson). AERO: no entry at all.
- **N5 Checks.** New first-party checks for CRV (Curve `circulating_supply()`, 1%) and LINK (`supply.chain.link`,
  0.5%) as `watch` lines (ORION WATCH, never an anomaly: a level cross-check opens a paid triage run, R22) (rec), or
  none. VVV keeps its existing Venice cross-check. PUMP's schedule floor (custodian >= Blockworks still-locked) as a
  watch. HYPE, SKY, UNI, CAKE: no first-party figure exists; none.

## Review Focus

1. **A rebuild at a block where a term's contract did not exist yet** (CRV grant escrows, AERO's new token, a vault
   created later): the row is refused and listed, keeps its CoinGecko value, never a partial sum. Pinned in Task 5.
2. **A `view_sum` term that reverts at the run block** (an unverified Safe, a `take()` on an upgraded converter): the
   level fails (source failure, grade drop), never a sum missing one term. Pinned in Task 1.
3. **The LIT schedule across tranche boundaries** (exactly 2027-01-29T00:00Z, the last tranche, a run after full
   vesting): locked never negative, 0 after the last tranche. Pinned in Task 1.
4. **A Hyperliquid wallet with spot only, staked only, or a pending withdrawal**: all three counted; an unknown address
   (empty reply) is 0, not an error. Pinned in Task 2.
5. **A purge run before the rebuild**: refused for every EVM asset row that a rebuild could replace
   (`purge_unreplaced_supply_level`); allowed and listed (`withoutReplacement`) only for the not-rebuildable set.
   Pinned in Task 5.

---

### Task 1: `chain.view_sum` extensions: `times` and `locked_schedule`

**Files:** Modify `src/ingest/adapters/evm.ts` (validateViewSum, the view_sum run, paramsDoc); Test
`tests/ingest/adapters/viewSum.test.ts` (create, or extend the existing view_sum tests).

**Interfaces:** Produces two optional params (no default; an asset without them keeps its config hash):
- term `times?: { contract: string; function: string; decimals: number }`: the term's value x (that view's value /
  10^decimals), read in the same multicall at the same block (yCRV: `st_ycrv.balanceOf(treasury) x
  st_ycrv.pricePerShare()`).
- `locked_schedule?: { amount: number; first_tranche: string /* ISO day */; tranches: number; every_months: number;
  citation: string }`: subtracts `amount x (tranches - k) / tranches`, k = tranches whose date (first_tranche + i x
  every_months, i = 0..tranches-1, 00:00Z) is <= the run block's time; refused when the result is negative.
- Locator/detail gains each term's `times` value and the schedule's locked amount.

- [ ] **Step 1: Write the failing tests**: `times` multiplies (balance 1000e18, pps 2.68e18 -> 2680 tokens subtracted);
  a reverting term fails the level (no partial sum); `locked_schedule` {500e6, 2027-01-29, 36, 1}: run at
  2026-11-19 -> 500,000,000 locked; 2027-01-29T00:00Z -> 486,111,111.11; 2027-01-28T23:59Z -> 500,000,000;
  2029-12-29T00:00Z (i = 35) -> 0; validate refuses unknown keys, tranches < 1, a bad date, a missing citation.
- [ ] **Step 2: Run, verify FAIL.** `npx vitest run tests/ingest/adapters/viewSum.test.ts`
- [ ] **Step 3: Implement** in `evm.ts`; the existing AERO view_sum test and every hash pin stay unchanged.
- [ ] **Step 4: Run, verify PASS**, plus `tests/assets/aero*.test.ts` unchanged.
- [ ] **Step 5: Commit** `feat(ingest): view_sum times terms and locked_schedule`.

### Task 2: `hype.circulating_supply`

**Files:** Modify `src/ingest/adapters/hype.ts`, `src/report/sourceTypes.ts` (`first_party_api`),
`tools/sources-register/generate.ts`; Test `tests/ingest/adapters/hype.test.ts`.

**Interfaces:** adapter `hype.circulating_supply` params `{ subtract: string[] /* contract names */, url? }`: one
`spotMetaAndAssetCtxs` request (the @107 context's `circulatingSupply`; HYPE's token index from the meta, not
hard-coded), then per subtracted address `spotClearinghouseState` (HYPE `total`) + `delegatorSummary` (`delegated` +
`undelegated` + `totalPendingWithdrawal`); value = circ - sum; refused <= 0. Detail lists each wallet's spot and staked
parts. Reuse `balanceAt` for the spot read; add `stakedAt`.

- [ ] **Step 1: Failing tests** with a fake HTTP transport: 301,557,370 - (60,642,286 + 2,979,878) = 237,935,206 (the
  scoping figures); spot-only, staked-only and pending-withdrawal wallets; unknown wallet (empty balances) = 0; a meta
  without HYPE refuses; `circulatingSupply` missing refuses.
- [ ] **Steps 2-4: FAIL, implement, PASS.**
- [ ] **Step 5: Commit** `feat(hype): circulating supply from Hyperliquid less the genesis wallets`.

### Task 3: `solana.supply_less_owners`

**Files:** Modify `src/ingest/adapters/solana.ts`, `src/report/sourceTypes.ts` (`contract_state`),
`tools/sources-register/generate.ts`; Test `tests/ingest/adapters/solana.test.ts`.

**Interfaces:** adapter `solana.supply_less_owners` params `{ mint: string; subtract: string[]; rpc_url_env? }`
(contract names of owners, not token accounts): `tokenSupply(mint)` - sum of `ownerBalance(owner, mint)` (existing
transport, all of an owner's token accounts), one finalized read each; refused <= 0; detail names each owner, balance
and slot. Never a pump.fun host (R8 test pattern: only `ORION_SOL_RPC_URL`).

- [ ] **Step 1: Failing tests**: 821,771.9M - 229,261.9M - 189,000M (N1d B) with a fake transport; an owner with two
  token accounts sums both; an owner with none = 0; result <= 0 refuses; a transport error fails the level.
- [ ] **Steps 2-4: FAIL, implement, PASS.**
- [ ] **Step 5: Commit** `feat(solana): supply less named owners' balances`.

### Task 4: The YAML sweep and the CoinGecko refusal

**Files:** Modify `assets/{cake,crv,cvxcrv,hype,link,lit,pump,sdcrv,sky,uni,vvv,ycrv}.yaml` (`circulating_supply`
source, `contracts:` entries with citation comments, the N5 watches), `src/config/sources.ts` (`coingeckoPriceIssues`
-> `coingeckoIssues`, every field), `src/config/load.ts`, `src/agent/tools/write.ts` (filing uses it),
`docs/ops/sources-register.md` (regenerated), the asset tests' hash pins, `docs/templates/*` (no CoinGecko
circulating left); Test `tests/config/sources.test.ts`, `tests/config/templates.test.ts`, the 12 asset tests.

**Interfaces:** Consumes Tasks 1-3. Each asset's terms exactly as its scoping file's "Proposed method" section under
the N1 picks (controller fills N1 picks into the brief). `levelMetricKeys` unchanged; `coingeckoIds` returns [] for
every asset (pinned).

- [ ] **Step 1: Failing tests**: a `coingecko` source with `field: circulating_supply` (and `total_supply`,
  `market_cap`) is refused at load, at config-proposal filing and at approve (three tests, R24 pattern); every shipped
  asset loads; `coingeckoIds` is empty for all 13 shipped assets; each asset test asserts the new circulating
  source's adapter and its term count.
- [ ] **Step 2: Run, FAIL.**
- [ ] **Step 3: Edit the 12 YAMLs** (addresses copied from the scoping files only), regenerate the register
  (`npx tsx tools/sources-register/generate.ts`), re-pin exactly these 12 assets' hashes (any other pin moving = stop).
- [ ] **Step 4: Run** the asset tests, `tests/config`, the register test: PASS; full suite + typecheck.
- [ ] **Step 5: Commit** `feat(assets): circulating supply on chain for 12 assets; CoinGecko refused in every field`.

### Task 5: `data rebuild-supply-levels` and the purge refusal

**Files:** Create `src/db/supplyLevels.ts`; Modify `src/cli/commands/data.ts`, `src/db/purge.ts`,
`scripts/provision/files/orion-remote` (+ usage, `docs/ops/deploy.md` verb table); Test
`tests/db/supplyLevels.test.ts`, `tests/db/purge.test.ts`, `scripts/provision/test/test_orion_remote.py`.

**Interfaces:**
- `rebuildSupplyLevels(db: OrionDb, loaded: LoadedAsset, deps: { rpc: RpcFactory; http: HttpTransport }, opts: { yes:
  boolean; now: string; release?: string }): Promise<SupplyRebuildResult>`; `SupplyRebuildResult = { asset, applied,
  metric: 'circulating_supply', rows, rebuilt, unchanged, refused: { id, observedAt, reason }[], notRebuildable: { id,
  observedAt, day }[], calls }`.
- Targets: every active `circulating_supply` row whose source differs from the current config's (CoinGecko rows; the
  wrappers' old totalSupply rows). Per row: block = `firstBlockAtOrAfter(observed_at)` (cached in `day_blocks`), run
  the asset's current source with `ctx.block` = that block, insert a new active row at the same `observed_at`
  (supersedes the old one), provenance method `measured`, locator `{ ..., rebuilt: { at, release, from_id } }`.
- `notRebuildable`: the asset's source is not an EVM `view_sum`/`erc20_supply` (HYPE, PUMP), or `observed_at` is before
  the asset's `rebuild_from` (new optional YAML key under `circulating_supply`, AERO `2026-11-10`): listed, untouched.
- `refused`: the read fails or reverts at that block (Review Focus 1): listed, untouched, exit 3.
- CLI `orion data rebuild-supply-levels <asset> [--yes] [--json]`, dry run by default, exit 3 on any refused row;
  orion-remote `data rebuild-supply-levels <a> [--yes]` (passthrough with `--json`, as `rebuild-price-levels`).
- `purge.ts`: a `market_data` purge of `circulating_supply` refuses (`purge_unreplaced_supply_level`) any targeted row
  with no active row of another source type at its `observed_at`, except rows the rebuild classes `notRebuildable`
  (deleted, listed `withoutReplacement`) (Review Focus 5; R38 pattern).

- [ ] **Step 1: Failing tests**: a CoinGecko row at 2026-10-20 rebuilt from `fakeRpc({ callsAt })` at the found block;
  a second dry run after `--yes` rebuilds 0; a term reverting at an old block -> refused, exit 3, row untouched; HYPE
  rows -> notRebuildable; AERO rows before `rebuild_from` -> notRebuildable; a wrapper contract_state row with the old
  locator is rebuilt; purge before rebuild refused for CAKE, allowed and listed for HYPE; orion-remote usage + passthrough.
- [ ] **Steps 2-4: FAIL, implement, PASS** (focused + full suite, typecheck, py tests).
- [ ] **Step 5: Commit** `feat(data): rebuild-supply-levels and the unreplaced circulating purge refusal`.

### Task 6: Release block, followups, spec Status

**Files:** Modify `docs/ops/deploy.md` ("Phase 3 R3 release"), create
`docs/superpowers/notes/2026-11-19-orion-phase3-r3-followups.md`, spec Status. No code.

The block, per env (stage first; prod after one scheduled stage nightly and Mike's go). **One script per
pre-approved stage** (`tools/phase3-proof/r3-<stage>.sh <env>`), each `set -u`, each step `|| stop`, exit 1 at the
first deviation, every expected count read from the stage-0 file, never typed in the script:

- **Prerequisites:** Task 7 signed; Mike re-runs `orion-host.sh` from a snapshot at the release sha (new verb; check:
  `$ST data rebuild-supply-levels` exits 64 with the usage line); merge + tag on main; outside 05:00-06:30 PT and each
  env's nightly -4 h/+2 h.
- **Stage 0 (read-only, no approval):** before/ = 26 reports at D = today-2 (so D+1 is a complete past day and no
  hourly price can move D's report) and D-91. Expected-counts file `r3-<env>-expected.json` from `sql-ro` (prod; stage
  via the stage `sql-ro` installed by the prerequisite re-run; if its self-check fails, the R2 waiver: prod's counts
  + stage `data show`): per asset active
  `market_data` circulating rows, `contract_state` wrapper rows, rows before AERO's `rebuild_from`.
- **Stage 1 deploy:** `deploy.sh <env> <tag>`; checks: `status` on the tag; migrations max 8 (unchanged); the first
  hourly `levels` run after the switch: `latest_levels` circulating rows with `source_type = 'market_data'` 9 before ->
  0 after (pre-switch artifact: 9 is expected until that run), 0 `api.coingecko.com` requests in its result; each
  asset's new circulating within ±2% of the proof table's value at that time.
- **Stage 2 rebuild:** dry run 13 assets; expected exactly: `rebuilt` = the expected file's count for CAKE, CRV, LINK,
  LIT, SKY, UNI, VVV, cvxCRV, sdCRV, yCRV; `notRebuildable` = all rows for HYPE and PUMP and AERO's 45; `refused` 0
  everywhere (any refusal = stop, Mike decides). `--yes`; yes == dry per asset; a second dry run rebuilds 0.
- **Stage 3 purge:** dry run `data purge <a> --metrics circulating_supply --source-type market_data` on the 10 assets
  with rows; expected `observations` = the expected file's count; `withoutReplacement` = HYPE all, PUMP all, AERO 45,
  others 0; `--yes`; yes == dry; then `sql-ro`: `count(*) from observations where source_type = $$market_data$$` = 0
  and `latest_levels` market_data rows = 0. Pre-purge artifact: a nightly between stages 1 and 3 adds on-chain rows
  only, so the market_data counts at stage 3 equal stage 0's exactly (a mismatch = stop).
- **Stage 4 gate:** after/ = 26 reports at the same days; `flatdiff` with `tools/phase3-proof/r3-allowlist.json` from
  the tag: 26/26 exit 0, else stop with every unallowed path before -> after.
- **Soak (stage):** one scheduled nightly, no failed source, no `ORION WATCH ... circulating` without a stated cause;
  snapshot `full` shows the new `marketCap`.
- **Rollback:** no migration; `deploy.sh <env> orion-2026.11.15.1` runs. The old code reads CoinGecko circulating
  again at its first hourly run and nightly (new `market_data` rows); rebuilt rows stay; a rollback needs a forward fix.

- [ ] **Step 1: Write** the block, the four stage scripts (tested with a dry `--env fake` mode that reads fixture
  JSON), the followups note (rulings, deferred minors, N-decisions as recorded).
- [ ] **Step 2: Commit** `docs: Phase 3 R3 release block, stage scripts, followups`.

### Task 7: Proof on a prod copy and the sign-off table (controller)

**Files:** `tools/phase3-proof/flatdiff.py` (`ratio` bound + test), `tools/phase3-proof/r3-allowlist.json`,
`tools/phase3-proof/README.md`; results in `workspace/orion/phase3-proof/r3/`.

- [ ] **Step 1:** flatdiff gains `"ratio": [lo, hi]` (holds when both numbers and lo <= new/old <= hi); test in
  `test_flatdiff.py` (RED first); commit.
- [ ] **Step 2:** `prod_copy.py --breaking` into `$TMPDIR` (old = `orion-2026.11.15.1`, new = branch), outside
  05:00-06:30 PT and the prod nightly -4 h/+2 h. Old side: 26 reports (D = today-2, D-91).
- [ ] **Step 3:** New side: stages 2-3 on the copy (real RPC, read-only chain); record archive calls and wall time per
  chain; counts per asset vs the expected file.
- [ ] **Step 4:** Field-level flatdiff old vs new: only the N4 class S/L paths move; build the per-asset table
  (circulating, marketCap, mcap/revenue, mcap/holder flow, HF/mcap, old -> new) for D and every stored day 09-20..D
  (the rebuilt history), plus a D-91 identical check.
- [ ] **Step 5:** Bring the table, the call count, refused/notRebuildable lists to Mike. His sign-off writes the
  allowlist (`ratio` = signed ratio ± 0.01; label pins exact). No tag before it. `cleanup.py` the copy; commit.

## Self-review notes

- Spec §3.2: owned circulating on every asset (Task 4), cited exclusions in YAML comments (Task 4), first-party checks
  where they exist (N5), history policy (N2, Task 5). §5 R3 "nothing CoinGecko-derived stored": stage 3's global
  `market_data` = 0 check plus the loader refusal.
- R2 lessons carried: one script per pre-approved stage (Task 6); expected counts for every check incl. pre-switch /
  pre-purge artifacts (Task 6 stages 1, 3); growth entries carry abs + rel (N4); D chosen so no price moves between
  before and after (stage 0).
- Proportion: 7 tasks; the YAML terms live in the scoping files, not repeated here.
