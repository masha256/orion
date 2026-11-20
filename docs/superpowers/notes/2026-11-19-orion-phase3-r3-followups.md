# Orion Phase 3 R3 (circulating supply on chain): followups (2026-11-19)

Spec `docs/superpowers/specs/2026-11-09-orion-phase3-third-party-removal-design.md` (§3.2, §5 R3, D4), plan
`docs/superpowers/plans/2026-11-19-orion-phase3-r3-circulating-supply.md` (Tasks 1-6 built; Task 7, the proof on a prod
copy and Mike's sign-off, next). Branch `feat/phase3-r3-supply`; built in a worktree, not merged, not tagged, not
deployed. Release steps: `docs/ops/deploy.md` "Phase 3 R3 release" (prerequisites, timing, scripts s0-s4, the
expected artifacts, soak, rollback). Source of every line below: the SDD ledger
(`.superpowers/sdd/2026-11-19-orion-phase3-r3-circulating-supply/progress.md`) and its findings files.

## Open items for Mike

- **A watched monitor-only read that fails is silent** (LIT's four watched sources: `app_fee_share`, the rh account
  value, rh fees, staking APR; also PUMP's `reserved_balance`): a source that feeds only monitor-only metrics raises no
  failure streak, and a watch over a metric that is never written never fires. Ruling R14 kept today's behaviour for
  them (only the sides of a watched `level_gap_pct`, LINK's `chainlink_circulating` from `supply.chain.link` and CRV's
  `curve_circulating`, leave the exemption). Decide whether watched reads should raise streaks. PUMP's owners are already covered by
  `supply_less_owners`' streak on the same RPC.
- ~~VVV's 2026-09-18 `disclosure` circulating row~~ **resolved by R15**: it is active on prod (id 3, 48,350,000, a
  pre-v2 seed). The rebuild now targets only `market_data` rows and `contract_state` rows of another locator; a
  `disclosure` (or hand-entered) row is listed as `kept` and untouched (N3: keep). s0 records the kept rows per asset
  from `sql-ro` and every later check expects exactly that count (vvv 1 on prod); a kept row s0 did not record stops.
- **PUMP's Blockworks schedule floor is not built** (R4): the `reserved_balance` change watch (1%) is the check for
  option B; it fires first on any custodian or dormant-vault move.
- **Task 7's sign-off writes two files the tag must carry**: `tools/phase3-proof/r3-allowlist.json` (s4's gate) and
  `tools/phase3-proof/r3-signed-circulating.json` (`{"<asset>": <signed circulating tokens>}`, s1's ±2% check after the
  first hourly `levels` run). s1 stops (before deploying) without `r3-signed-circulating.json`; s4 stops without
  `r3-allowlist.json`.
- **Prod `--yes`** (s2's rebuild, s3's purge) only on his go, or under his conditional pre-approval of the whole script;
  any refused rebuild row is his decision.
- The published `masha256/orion-data` history keeps old CoinGecko-derived figures (N3: left; Phase 5 decides).

## Decisions (Mike 2026-11-20, #orion-dev: "all recommendations")

- N1 per-asset methods as recommended: N1a staking rule (irrevocable long locks out: veCRV, veAERO; staking with an exit
  in: LINK v0.2, lsSKY, VVV, LIT, HYPE); N1b CRV Curve Treasury out, unvested grant escrows in; N1c wrappers'
  protocol-treasury holdings out (yCRV via `times`); N1d PUMP option B (mint - Token Custodian - the five dormant
  custodian-funded vaults = 403.51B, -11.9%); N1e CAKE option B (- old CAKE pool - retired veCAKE = 315.73M, -4.96%);
  N1f LIT locked team/investor by the cited schedule, staked and L2 treasury in; N1g HYPE Hyperliquid's figure less the
  two genesis wallets; N1h UNI Timelock + UF + Aera out; N1i SKY Pause Proxy + converter `take()` out, lsSKY and
  converter-held MKR-backed SKY in; N1j VVV `view_sum` primary, Venice `vvv_stats` the check at 2%.
- N2 A: rebuild at archive blocks every stored row of the EVM assets (CAKE, CRV, LINK, LIT, SKY, UNI, VVV CoinGecko rows;
  cvxCRV, sdCRV, yCRV old-locator rows), then purge the CoinGecko rows; HYPE, PUMP and AERO's 45 pre-2026-11-10 rows are
  purged without replacement (their market cap starts on the release day; AERO 2026-11-10).
- N3: keep the purge exports in `~/home/purged/` on venus; leave the `orion-data` git history.
- N4: allowlist classes S (`ratio` = signed ratio ± 0.01), L (exact label pins), G (no entry; if ever forced, R41 abs
  floor AND R43 rel 0.1%), AERO no entry.
- N5: CRV (Curve `circulating_supply()`) and LINK (`supply.chain.link`) checks as WATCH lines; VVV keeps Venice; PUMP a
  watch (built as `reserved_balance` change_pct 1, R4/R11); HYPE, SKY, UNI, CAKE none.
- N6: stage `sql-ro` installed (`orion_stage_ro`); one more `orion-host.sh` re-run at the R3 release for `data
  rebuild-supply-levels` (same flags).

## Rulings during execution

One line each with its cost if wrong (as the ledger states it).
- R1: Tasks 1-3 to one implementer as three commits, one review over the range (same layer, disjoint files). Cost: a
  bigger review package.
- R2: LIT `locked_schedule` is the plan's single-amount form (500M, one date series), not the scoping's two-schedule
  form. Cost: none (same numbers).
- R3: N5 checks need a new derived kind `level_gap_pct` {a, b} = (a/b - 1) x 100, monitor-only, with `watch: { outside:
  [-tol, tol] }` (CRV gap -0.36%, LINK 0.00%). Cost: small; a later generic check type replaces it.
- R4: PUMP's N5 check is a monitor-only reserved-balance level with `watch: { change_pct: 1 }`; the Blockworks schedule
  floor is not built. Cost: no floor alert; the change watch fires first anyway.
- R5: the rebuild runs the asset's configured source through the normal source runner with `ctx.block` =
  firstBlockAtOrAfter(observed_at), never a bespoke read path. Cost: none.
- R6: `rebuild_from` (optional ISO day under a level metric) added in Task 5 with AERO 2026-11-10; only AERO's hash moves
  there. Cost: AERO re-pinned twice (in fact once).
- R7: `locked_schedule` month addition = calendar months on the UTC day, clamped to the month's last day. Cost: a tranche
  a day early in short months.
- R8: the packs-13.json `paramsDoc` move (adapter doc text, no report byte) accepted. Cost: none.
- R9: implementer extras accepted (`locked_schedule` refused with `scale`/`plus_share`; `solana.supply_less_owners`
  origin onchain); HYPE "> total" refusal not added. Cost: a garbled API reply above total passes; WATCH/derived checks
  later.
- R10: CRV gap watch band [-1.5, 0.5] (steady gap -0.36%, the treasury), LINK [-0.5, 0.5]; PUMP reserved owners via a
  minimal `solana.owners_balance` sum adapter + change_pct 1. Cost: assessed here: a band too wide misses a small drift.
- R11: PUMP watch metric named `reserved_balance` (R4 said `pump_reserved_balance`). Cost: none.
- R12: rebuild target = a row whose (source_type, locator.adapter, locator.call) differ from the current source; a params
  change inside the same adapter is no target. Cost: a future same-adapter terms change leaves mixed history; a later
  release can add a params hash.
- R13: a balanceOf term whose ARG contract did not exist yet reads 0 at an old block; only a call ON a codeless contract
  is refused. Cost: assessed here: none (it held nothing then).
- R14 (narrows the Task 4 review I1 fix): only the sides (a/b) of a watched `level_gap_pct` leave the monitor-only
  failure-streak exemption; a plain watched monitor-only metric stays exempt. Cost: LIT's watched sources stay as silent
  as today (open item above).
- R15 (amends R12): rebuild targets = active circulating rows with `source_type` `market_data`, or `contract_state` rows
  of another locator (the wrappers' old `erc20_supply` rows); `disclosure` / hand-entered rows are never targets: listed
  as `kept` (id, observedAt, reason) and untouched; s0/s2 expect VVV kept 1. Cost: one pre-v2 disclosed point inside
  VVV's on-chain series.
- R16: Task 6 concerns 2-5 accepted as written: Task 7 creates `r3-signed-circulating.json`; stage `levels` runs every
  6 h, so s1 polls up to 6 h 30 min (deploy stage just before a :15 slot); the `staging_refresh` hold lasts until prod's
  s3; the step-3 log check is strict (any ` error` line stops). Cost: a long stage wait, or a false STOP on a benign
  "error" log line.
- R17: the R15 fix wave's concerns accepted: `contract_state` targets keep R12's (adapter, call) comparison (on shipped
  data only the wrappers' old rows; the scripts stop on any other kind); non-target rungs (e.g. a `first_party_api`
  row of an old source) are kept, not notRebuildable; the spec Status line is updated at the closing commit. Cost: none
  on the shipped data.
- R18: closing fix wave over the 176c45a..ca3be1d review: R16/R17 here and the spec Status; s1's step 4 waits for a
  `levels` job that started after the switch to be `done` (running ones ignored) and reads `latest_levels` only after
  it, with the pre-check skipped once such a job started; STOP fixtures for the wrappers' old-locator count, leftovers
  after `--yes` and the step-4 pre-check; deploy.md names which script needs which file; s2/s3 `--resume` (already
  done + remaining = step 1's counts) after a STOP mid `--yes`; review M6 accepted as R16. Cost: none.

## Deferred (minor) findings

- Task 1-3: `solana.ts` pump.fun host regex duplicated from the transport, plain Error not OrionError
  `forbidden_price_host`.
- Task 1-3: `isName` defined three times (evm, hype, solana).
- Task 1-3: hype detail prints tiny spot balances in JS exponent form.
- Task 1-3: solana supply and owner balances read at different slots (detail records each).
- Task 1-3: `locked_schedule` citation URL not in the sources register.
- Task 1-3: `view_sum` with `locked_schedule` accepts exactly 0 (hype/solana refuse 0).
- Task 4: `ownersBalance` resolves owners before validating (load-time check covers it).
- Task 4: `schema.ts` imports from the ingest layer (precedent in load.ts).
- Task 5: rebuild writes midnight `day_blocks` without flow.ts's 3600 s age check (rebuild rows are past days;
  boundaries never young).
- ~~Task 5: no tests for the rebuild conflict path, a partly committed `--yes` finished by rerun, a LIT `locked_schedule`
  rebuild at an old block, PUMP notRebuildable.~~ **Done in ca3be1d** (tests/db/supplyLevels.test.ts: all four).
- Task 5: RPC call counter counts 7 named methods only.
- Task 5: `planRebuild` has an unused `opts` param.
- Task 5: CLI NOT REBUILDABLE line says purge deletes it (true only for `market_data` rows).
