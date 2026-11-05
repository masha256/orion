# Orion Phase 2 (data strategy, income statement v2): followups (2026-11-04)

Spec `docs/superpowers/specs/2026-10-28-orion-data-strategy-income-v2-design.md`, plan
`docs/superpowers/plans/2026-11-04-orion-phase2-data-strategy-income-v2.md`. Branch `feat/data-strategy`, built in a
worktree, not merged, not pushed.

## yCRV st-yCRV fee probe (Task 2 Step 1)

Run by the controller (read-only, Alchemy mainnet RPC, 91 days to head, 2026-11-04).

Question (spec §8 yCRV row): is Yearn's st-yCRV performance fee (`flow_usd.yearn_styc_fee`, v1 ~0.10 $M/yr) taken out
of what YBS stakers are paid, or charged on yield outside the splitter?

Measured:
- st-yCRV vault `0x27b5739e22ad9033bcbf192059122d163b60349d` (yVault 0.4.3) has ONE strategy in its withdrawal queue:
  `0xe3974e44bc08f435da2c6db7d01e1758496da119`, name() = "StrategyYBSFarmer".
- That strategy holds 42,470,762 yCRV staked in YBS (`ybs.balanceOf`), of YBS totalSupply 63,273,579 = 67.1% of all
  staked yCRV. Vault totalAssets 42,470,877 yCRV (114 yCRV idle in the vault).
- Distributor `0xb226c52e…` paid 337,042 yvcrvUSD-2 shares over 91 days; 236,920 (70.3%) went to the StrategyYBSFarmer
  (13 claims). The strategy also received 273,952 crvUSD from the yvcrvUSD vault (redemptions) and yCRV from swaps/YBS.
- Fee: 91 transfers of st-yCRV shares from the vault to the Yearn treasury `0x044f9c86…`, 58,241.5 shares
  (pricePerShare 2.6537 yCRV/share now). No fee mints from 0x0.

Verdict: INSIDE. The st-yCRV vault's gains are the YBS crvUSD rewards it claims (70% of all YBS payouts), compounded
into yCRV; its 10% performance fee is carved out of payouts that `flow_usd.fees` (ybs_payout, measured at the
distributor) already counts. Adding it to revenue (v1's 2.31) double-counts.

Ruling (controller, for Task 2 and this note): yCRV v2 revenue = `yearn_gross` only (2.20 on 2026-10-27).
The st-yCRV fee is a fee of a wrapper product above YBS (charged only to st-yCRV depositors), not yCRV revenue and not
the protocol's take from YBS stakers: it is left OUT of the v2 statement (no revenue, holders or protocol line), so
yCRV holder flow (YBS staker yield) stays unchanged as the plan requires; `flow_usd.yearn_styc_fee` stays collected
(monitor_only) and in the legacy `income` lines until Task 11. The spec's alternative (holders −0.10, protocol +0.10)
would move yCRV holder flow by ~−6% and understate a direct YBS staker's yield; raised to Mike at G1 as a flip-able
ruling.

Controller ruling R6 (Task 2, binding): yCRV v2 revenue = `yearn_gross` only; NO styc line anywhere in yCRV's income_statement (flow_usd.yearn_styc_fee stays a metric and stays in reporting.income). holders `ybs_payout` = flow_usd.fees; protocol `treasury` = flow_usd.yearn_revenue; check sum total [flow_usd.yearn_gross] parts [ybs_payout, treasury] tol 2.

## The 13 income_statement blocks (Task 2)

Each asset carries `income_statement` beside `reporting` (both read by nothing new until Task 3; `holder_flows` and
`reporting` untouched). `window_days` 91 everywhere; `volume`, `dilution`, `burned_tokens` copied from `reporting`;
`capture_rule`, `recipient_base`, `valued_per` and haircuts copied from `holder_flows` / `reporting.haircuts`. Line ids
are unique across sections (ruling R8): a revenue line that a use line passes on under the same name is `<name>_rev`.

| Asset | category / scope | revenue | cost_of_revenue | holders (bucket, haircut, base) | protocol / opex / remainder | below_line | checks |
|---|---|---|---|---|---|---|---|
| aero | dex / protocol_share_only | `fees` = flow_usd.fees | `lp_fees` n/m (lps) | `voter_fees` of fees (cash 0.02 locked, contractual) | – | `bribes` n/m to holders | – |
| cake | dex / protocol_share_only | `burn_rev` = flow_usd.burn, `treasury_rev` = flow_usd.treasury | `lp_fees` n/m (lps) | `burn` of burn_rev (burn 0 all, programmatic) | protocol `treasury` of treasury_rev | – | – |
| crv | dex / protocol_share_only | `fees` = flow_usd.fees, `treasury_rev` = flow_usd.curve_treasury | `lp_fees` n/m (lps) | `vecrv_fees` of fees (cash 0 locked, programmatic) | protocol `treasury` of treasury_rev | `vote_incentives` run_rate vote_incentive_run_rate_usd (holders, cash 0.03 locked, programmatic: ruling M3) | `splitter`: [flow_usd.protocol_revenue] = vecrv_fees + treasury, 2% |
| cvxcrv | liquid_locker / complete | `vecrv_fees_rev` = flow_usd.fees, `platform_cvxcrv` = convex_rev_cvxcrv, `platform_cvx` = convex_rev_cvx, `platform_treasury` = convex_rev_treasury, `callers_fee` estimate 0.05 of platform_cvxcrv | – | `vecrv_fees` of vecrv_fees_rev (cash 0 staked, recipients); `crv` of platform_cvxcrv, paid_metric flow_usd.crv (cash 0.01 staked, recipients) | protocol `cvx_stakers` of platform_cvx, `treasury` of platform_treasury; opex `callers` of callers_fee | `cvx_rewards` flow_usd.cvx (holders, cash 0.005 staked, recipients, discretionary) | – |
| hype | perp_dex / protocol_share_only | `trading` = flow_usd.revenue_proxy (third_party), `reserve_yield` = flow_usd.reserve_yield periodic from 2026-08-26, "reserve yield on user deposits" (D2) | `hlp` (lps), `builders`, `deployers`, `referrers` n/m | `af_buyback` = flow_usd.af_buyback (burn 0 all, D1 footnote); `reserve_yield_paid` of reserve_yield (burn 0 all) | remainder protocol | – | – |
| link | oracle / protocol_share_only | `onchain_fees` = flow_usd.reserve | `node_operators` n/m | `reserve` of onchain_fees (hold 0.05 all, discretionary) | – | – | – |
| lit | perp_dex / complete | `core` = flow_usd.fees_core, `robinhood` = flow_usd.fees_rh from 2026-06-26 | `robinhood_partner` (partners) of robinhood, share 0.5, share_metric rh_revenue_share_app | `buyback` = flow_usd.buyback (burn 0 all, discretionary) | remainder protocol | – | parameter check (automatic, Task 5) |
| pump | launchpad / protocol_share_only | `protocol` = flow_usd.llama_revenue (third_party) | `creators`, `lps` n/m | `buyback` = flow_usd.buyback (burn 0 all, discretionary) | remainder protocol | – | – |
| sdcrv | liquid_locker / complete | `vecrv_fees_rev` = fees, `crv_fee_share_rev` = crv, `vesdt_rev` = sd_rev_crv_vesdt, `treasury_crv_rev` = sd_rev_crv_treasury, `liquidity_fee_rev` = sd_rev_fees_liquidity, `treasury_fees_rev` = sd_rev_fees_treasury, `boost_delegators_rev` = sd_boost_delegation | – | `vecrv_fees` of vecrv_fees_rev (cash 0 staked, recipients); `crv_fee_share` of crv_fee_share_rev (cash 0.005 staked, recipients) | protocol `vesdt`, `treasury_crv`, `liquidity_fee`, `treasury_fees` (each of its `_rev`); opex `boost_delegators` of boost_delegators_rev | `bribes` flow_usd.bribes (holders, cash 0.05 staked, recipients) | `crv_fee`: [flow_usd.sd_rev_crv] = vesdt + treasury_crv + crv_fee_share + boost_delegators, 2% |
| sky | cdp_stablecoin / protocol_share_only | `surplus_usds` = flow_usd.stakers, `surplus_buyback` = flow_usd.buyback | `savers` n/m | `stakers` of surplus_usds, `buyback` of surplus_buyback (cash 0 staked) | – | – | – |
| uni | dex / protocol_share_only | `protocol_fees` = flow_usd.burn | `lps` n/m | `burn` of protocol_fees (burn 0 all) | – | – | – |
| vvv | ai_platform / complete | `business` disclosed revenue_run_rate_usd, cross_check flow_usd.revenue_proxy (third_party) | `compute` n/m (other) | `burn` = flow_usd.burn (burn 0 all, discretionary) | remainder protocol | – | – |
| ycrv | liquid_locker / complete | `yearn_gross` = flow_usd.yearn_gross (no st-yCRV line: probe above) | – | `ybs_payout` = flow_usd.fees (cash 0 staked, recipients) | protocol `treasury` = flow_usd.yearn_revenue | – | `splitter`: [flow_usd.yearn_gross] = ybs_payout + treasury, 2% |

Scope rule used: `protocol_share_only` where revenue is the protocol's share and the cost of revenue is `not_measured`
(gross not stored yet); `complete` where revenue is the whole of what users pay (the three lockers, LIT, VVV's disclosed
business revenue). CRV is `dex + cdp` in the spec; the schema takes one category, so it is `dex`.

## Task 3 review fix round 1 (income statement v2 shape)

Controller rulings on the Task 3 review (ledger `task-3-findings.md`), as built:
- Disclosed revenue (VVV): the disclosed line carries v1's disclosure-to-disclosure growth (one shared computation,
  `disclosedGrowthOf` in `src/report/holderYield.ts`), its `disclosedGrowth` gap/age/flags and its `crossCheck`
  (annualized, with the rung: `third_party` for VVV's DefiLlama proxy); `revenue.growth` is that growth. The disclosure
  flags are also statement flags (`disclosed revenue: ...`).
- `holderFlow.gross` / `holderFlow.net` stay as spec §7 shows them (net = after haircuts); `holderFlow.netOfDilution` =
  net less dilution in USD a year (emissions + releases at price, = `yields.dilution` x FDV) is spec §6's "net holder
  flow", also per token (`perToken.holderFlow.netOfDilution`).
- Not measured is never 0: below the line, `toHolders`/`toProtocol` and `holderFlow.fromBelowLine` are null when no line
  to that side is measured (AERO's bribes); with some measured, the measured sum, the rest listed. A not_measured line in
  holders, protocol or operating costs makes that section's total null (`notMeasured` on each section) and every figure
  built on it: the remainder, unreconciled, the payout ratio (flag `payout ratio n/a: holders not measured: ...`) and,
  for a holders line, holder flow's totals and that bucket. No asset has such a line today.
- Unreconciled is exactly 0 when every use passes on a revenue series whole (CAKE, CRV, cvxCRV, sdCRV, ...); a real gap
  (yCRV) is still from the totals, in expected.py's order.
- A cost line missing a day flags `payout ratio on revenue: cost of revenue has a missing day`, apart from not measured.
- Provenance: a derived metric inherits `third_party` from any input; a statement line whose series has a third-party
  metric-level `cross_checks` entry is listed as `<section>.<id>.cross_checks` (LIT `holders.buyback`, VVV
  `holders.burn`, CRV `below_line.vote_incentives`).
- Shape: `incomeStatement.volume` (v1's figure over the statement's volume list), `dilution.tokensPerYear`, and
  `method` + `sourceTypes` on every holder-flow line. The parity map moved to `src/report/parity.ts`; it now also pairs
  the published `revenue.annualized`/`revenue.growth`, per-flow net/yield/growth, protocol growth, revenue line growth,
  HYPE growthExNew, the price, volume (CAKE, cvxCRV, UNI) and VVV's cross-check (361 pairs; VVV's growth is paired
  against the published v1 figure, never null = null).
- The statement's disclosed line reads the metric its own `disclosed` key names (`levels.statementDisclosed`): the
  same rows as v1 when the keys agree, its own when they differ.
- Kept in v1 / top level only (not under `incomeStatement`): `income.protocolMargin`, bucket growth, `marketCap` and
  `fdv` (top-level report keys).

For Mike at G1 (table notes):
- The listing bar checks the holders section only (D6). With below-line lines to holders included, CRV would fail on
  its llama.box vote-incentive run rate.
- Implementer choices where the spec is silent: multiples and per-token holder flow use net (after haircut) holder
  flow; per-token dilution is in USD (pct x FDV); with a cost not measured, the remainder and unreconciled use revenue
  less the measured costs (PUMP 365.05, VVV 89.78 "before costs"); below-line `toHolders` sums the measured lines and
  lists the rest; revenue is null when a revenue line is not measured; `priceBasis.asOf`/`supplyAsOf` are the levels'
  read as-of (end of D+1), not each observation's time.

## Gate G1: v2 income statement table (controller, 2026-11-04)

Cross-release proof on c7eed0e (old side: release orion-2026.11.04.2 @ f5f36fa; live `.backup` imported into
`p2proof_20261104t214336z`; report day D = 2026-11-02, 91-day windows, $M a year): legacy JSON 13/13 byte-identical,
361 parity pairs (10 assets) and 3 reclassification assets PASS; anomalies and proposals identical. Suite at c7eed0e:
117 files / 1375 tests, typecheck and lint:promises clean (controller rerun).

| asset | scope | revenue | cost of rev | gross profit | holders (bucket) | protocol | opex | below line to holders | unreconciled | payout (basis) | third-party lines | cost not measured |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| aero | protocol_share_only | 79.81 | — | — | cash:79.81 | 0.00 | 0.00 | — | 0.00 | 1.00 (revenue) | revenue.fees,holders.voter_fees | lp_fees |
| cake | protocol_share_only | 79.74 | — | — | burn:58.37 | 21.37 | 0.00 | 0.00 | 0.00 | 0.73 (revenue) | – | lp_fees |
| crv | protocol_share_only | 5.84 | — | — | cash:5.26 | 0.58 | 0.00 | 7.12 | 0.00 | 0.90 (revenue) | below_line.vote_incentives,below_line.vote_incentives.cross_checks | lp_fees |
| cvxcrv | complete | 6.11 | 0.00 | 6.11 | cash:4.70 | 1.31 | 0.10 | 0.41 | 0.00 | 0.77 (grossProfit) | – | – |
| hype | protocol_share_only | 1012.28 | — | — | burn:1012.28 | -0.00 | 0.00 | 0.00 | 0.00 | 1.00 (revenue) | revenue.trading,holders.af_buyback | hlp,builders,deployers,referrers |
| link | protocol_share_only | 57.17 | — | — | hold:57.17 | 0.00 | 0.00 | 0.00 | 0.00 | 1.00 (revenue) | – | node_operators |
| lit | complete | 51.89 | 9.01 | 42.89 | burn:37.81 | 5.08 | 0.00 | 0.00 | 0.00 | 0.88 (grossProfit) | holders.buyback.cross_checks | – |
| pump | protocol_share_only | 687.60 | — | — | burn:317.71 | 369.89 | 0.00 | 0.00 | 0.00 | 0.46 (revenue) | revenue.protocol | creators,lps |
| sdcrv | complete | 1.91 | 0.00 | 1.91 | cash:0.90 | 0.90 | 0.12 | 1.70 | 0.00 | 0.47 (grossProfit) | – | – |
| sky | protocol_share_only | 54.65 | — | — | cash:54.65 | 0.00 | 0.00 | 0.00 | 0.00 | 1.00 (revenue) | – | savers |
| uni | protocol_share_only | 142.04 | — | — | burn:142.04 | 0.00 | 0.00 | 0.00 | 0.00 | 1.00 (revenue) | – | lps |
| vvv | complete | 150.00 | — | — | burn:10.53 | 139.47 | 0.00 | 0.00 | 0.00 | 0.07 (revenue) | revenue.business.cross_check,holders.burn.cross_checks | compute |
| ycrv | complete | 2.25 | 0.00 | 2.25 | cash:1.62 | 0.63 | 0.00 | 0.00 | -0.00 | 0.72 (grossProfit) | – | – |

Reclassifications vs v1 (D = 2026-11-02): sdCRV revenue 3.62 -> 1.91 (bribes 1.70 below the line), payout 0.72 -> 0.47;
yCRV revenue 2.35 -> 2.25 (st-yCRV fee out, R6); LIT revenue 42.89 -> 51.89 (Robinhood gross, 9.01 partner cost), gross
profit 42.89. Every holder-flow, yield, supply and dilution figure is unchanged for all 13.

Open for Mike at G1:
- yCRV vote incentives (Task 2 review M2): the splitter's crvUSD over 93 days to 2026-11-04 was $560,940, of which the
  voter (veCRV fees) sent $140,085 (25%) and Yearn's FeeBurner (auctioned third-party vote incentives) $420,855 (75%).
  sdCRV's bribes are below the line under rule 3; yCRV's are inside revenue. Consistent treatment: yCRV revenue
  ~0.56, ~1.69 below the line (needs a per-sender split of the splitter inflow and of the YBS payout: a model change).
- Listing bar (M7): checks revenue + holders + supply (D6); counting below-line-to-holders lines would also fail CRV
  (llama.box vote incentives). AERO, HYPE, PUMP fail the bar today (third-party revenue), reported, not blocked.
- Implementer choices where the spec is silent (Task 3 review, "Open for Mike" 1-6 above in this note).

## Task 5: internal reconciliation checks (spec §5)

Built: `income_statement.checks` takes all eight types (`src/checks/schema.ts`), results are stored per (asset, check,
day) in `check_results` (migration 0003), a breach opens one advisory `check_breach` anomaly per check (dedupe = check
id; no agent run: anomalies wake nothing since Phase 1), and the tick evaluates the report day's checks after the
holder-yield report, inside the run lock (`checks` in the tick report; v2 `incomeStatement.checks` reads the stored
rows). A side with no row for the day is `incomplete`, never a breach. Circular checks are refused at load: the same
series on both sides, an adapter `computedFrom` the other side's adapter (set on `solana.supply_burn_daily`), a derived
metric of the other side, a `parameter` on a `constant`, a `price` against the level's own primary contract.
`computedFrom` and derived inputs are followed transitively, and a derived metric's array params (`metrics: [a, b]`)
count (fix round 1, M1). A checks step that throws prints `ALERT <SYM> checks unavailable: <msg>` in the nightly block
and makes the asset an alert, like an income statement that throws (fix round 1, I1). Occurrences of a `check_breach`
count breached days: re-evaluating a day already stored as a breach (a stale report day, a re-tick) raises nothing more
(fix round 1, M5).

Conventions chosen (review before Phase 3 relies on them):
- gap_pct = |lhs - rhs| / max(|lhs|, |rhs|) x 100, unsigned (0 when both are 0); lhs/rhs are stored, so the sign is not lost.
- A level for day D is its first reading on D+1 (the report's rule). `balance`/`supply` use the readings within
  6 h after each midnight (nightly 00:45 UTC, staging 02:45); the SQLite-era readings at ~12:05 UTC leave them
  `incomplete`, which is right: a noon-to-noon change is not a midnight-to-midnight flow. Edge risk: a transfer in the
  00:00-00:45 slot lands in the next day's balance change.
- A `price` check `against` a contract reads the price cross-check's reading that the first fetch run on D+1 stored in
  its detail (`chain_levels`); against a metric it reads that level's first reading on D+1.
- A `revision` check compares, per day of the last `days`, the first row the source wrote with the row in force (the
  adapter re-reads its last 3 days and supersedes a changed row; the superseded row is kept). LIT's Lighter adapter
  re-reads only 3 days (`REVISION_DAYS`), so a restatement older than that is never seen by Orion at all, and LIT's
  check is set to `days: 3` to match (fix round 1, I2; the adapter's depth is unchanged, since a deeper re-read would
  change stored values). Catching restatements 4-30 days back needs a periodic deep re-read of the Lighter series:
  Phase 3 LIT.
- Automatic checks: `<line>_share` (`parameter`, tolerance 0) per `share_metric`; `<line>_paid` (`two_path`, the
  statement window, tolerance 5 percent: a payout measured at the recipients lags its source) per `paid_metric`, skipped
  when the paid series is the line's own.

Wired (per asset):

| asset | check | type | sides | tolerance |
|---|---|---|---|---|
| CRV | splitter | sum | flow_usd.protocol_revenue vs vecrv_fees + treasury (daily) | 2% |
| sdCRV | crv_fee | sum | flow_usd.sd_rev_crv vs vesdt + treasury_crv + crv_fee_share + boost_delegators (daily) | 2% |
| yCRV | splitter | sum | flow_usd.yearn_gross vs ybs_payout + treasury (daily) | 2% |
| LIT | robinhood_partner_share (auto) | parameter | rh_revenue_share_app vs 0.5 | 0 |
| LIT | fees_core_revision | revision | flow_usd.fees_core, 3 days (the adapter's re-read depth) | 0.01% |
| cvxCRV | crv_paid (auto) | two_path | flow_usd.convex_rev_cvxcrv vs flow_usd.crv, 91-day sums | 5% |
| UNI | price_chainlink | price | price_usd (CoinGecko) vs chainlink_uni_usd | 2% |
| LINK | price_chainlink | price | price_usd vs chainlink_link_usd | 2% |
| LINK | reserve_balance | balance | Δ reserve_link vs flow_tokens.reserve (no outflows) | 1%, or 10 LINK |
| CAKE | price_chainlink | price | price_usd vs chainlink_cake_usd (BNB Chain) | 2% |

The CRV-family sums were already in `income_statement.checks` (Task 2); their YAML is unchanged and their hashes did not
move. They are now evaluated daily: the spec's 0.00 / 0.00 / 0.01 percent gaps are 91-day figures, so a split paid out
in a later transaction than the inflow would breach on single days. If the proof copy shows that, set `window_days` on
the check (a hash move), and do not raise the tolerance.

Deferred (spec §5 examples), with the metric each lacks and the track that adds it:

| check | type | lacks | track |
|---|---|---|---|
| LIT reserve vs buys - burns | balance | a level of the L1 ecosystem reserve's LIT and a burns-in-tokens flow from it | Phase 3 LIT |
| LIT buybacks (fills) vs treasury LIT balance | two_path | a level of the treasury account's (index 0) LIT balance on Lighter | Phase 3 LIT |
| PUMP supply drop vs burn instructions | supply | an independent burn-instruction series: `flow_tokens.buyback` IS the supply drop (refused as circular) | Phase 3 PUMP |
| UNI 0xdead balance vs burns | supply | nothing: `total_supply` (less 0xdead) and `flow_tokens.burn` are stored; not in this task's list, so not wired (one YAML line, UNI hash moves) | Phase 3 UNI, or a follow-up |
| VVV burn vs DefiLlama `venice` -> supply on the burn sink | supply | nothing structural (`total_supply`, `flow_tokens.burn` stored); left for Phase 3 with the DefiLlama removal | Phase 3 VVV |
| HYPE AF buys (fills) vs AF balance | two_path | a first-party fills series and a level of the Assistance Fund's HYPE | Phase 3 HYPE |
| Hyperliquid fills | revision | the first-party fills series (today `flow_usd.af_buyback` is DefiLlama) | Phase 3 HYPE |
| UNI v2 `feeTo` share (x6) | parameter | a `v2_protocol_share` level and a derived v2 gross line (decision 7) | Phase 3 UNI |
| SKY splitter burn share | parameter | a statement line that assumes the share: `splitter_burn_share` is stored, but both SKY flows are measured, so nothing states 0.55 | Phase 3 SKY |
| UNI v3 listed pools vs total `collectProtocol` | coverage | the v3 pool_scan series and the protocol total | Phase 3 UNI v3 |
| `price` on the 7 assets with a `coins.llama.fi` cross-check (AERO, CRV, cvxCRV, HYPE, sdCRV, SKY, yCRV) | price | a Chainlink feed or a deep-pool `slot0` level (SKY's Chronicle pip reverts through Multicall3) | Phase 3 per asset; the llama checks stay, labelled third_party |
| VVV disclosed revenue | watch | `usage_index` watch in place of the DefiLlama `revenue_proxy` cross-check (a watch, not a check) | Phase 3 VVV |

Task 5 review, deferred (controller rulings):
- M2: a `price` check `against` a contract matches its cross-check reading by sourceId (`chain_levels`) and label, not by
  contract. Harmless while each level has one `contract_read` cross-check; before a second one on a checked level (a
  Phase 3 pool `slot0`), refuse it or store and match the contract in the run detail.
- M3: UNI/LINK/CAKE `price_chainlink` repeat their ingest cross-check at the same 2 percent, so one bad print raises both
  `cross_check_mismatch` and `check_breach`. Revisit in Phase 3 when the llama checks go.
- M4 (decision for Mike at G2): gaps are relative only, so `sum`/`two_path` breach at dust (sdCRV 2026-08-31: $0.046 vs
  $0, gap 100 percent). Recommendation: `tolerance_abs` $1 on sum checks (a schema change and a hash move).

## Task 6: provenance on every observation (spec §3)

Built: migration 0004 (expand-only: every column nullable; `tx_count` bigint per baseline 7.1, `locator`/`tx_refs`/
`inputs`/`coverage` jsonb; `latest_levels.source_type` + `locator`; index `(asset_id, metric_key, method)`).
`NewObservation.provenance` is required, so every writer fills it (`src/provenance/`): the fetch writers from the asset
config (rung = `sourceTypeOf`, the report's own mapping; method measured / derived / disclosed for constants; CAIP-2
chain; locator per source type), plus what the read measured: a transfer scan's `block_from/to` (= `source_detail.blocks`)
and its counted `txhash:logIndex` refs (first 50 of the sorted list, `tx_digest` = sha256 of the JSON of the full sorted
list); a chain level's block; an API row's `response_digest` (sha256 of the key-sorted raw response slice the value was
read from: a DefiLlama chart entry, the coingecko row's id + field, an http_json path's value, a defillama_share
category's rows, Lighter's exchangeMetrics rows / bought trades of the day, Hyperliquid's fund fills of the day / the
ledger sends of a payment; null where a source exposes none: the Hyperliquid and Lighter levels that combine several
replies or read a JS bundle); a derived row's
`formula` (`flow_annualized@1`) and `inputs` (`[{metric, from, to}]`). `code_version` = RELEASE.commit, else `dev`;
`config_hash` = the loaded asset hash. Values, `source` and `source_detail` are written exactly as before.

Conventions chosen (review):
- **A hand-entered figure is a disclosure.** `data set` (any `--source`), an approved `observation` proposal and the
  analyst ledger's staged rows are `disclosed` / `disclosure`, with the citation required (spec: citation_url NOT NULL
  when disclosed). `data set` without `--citation` is now refused (`citation_required`); the README line says so. A
  correction row typed in without a citation (as AERO's 2026-09-09 manual day may be) can no longer be entered that way.
- Locators never hold a key (`scrubLocator`, applied by the builders and again in `insertObservation` and
  `upsertLatestLevels`). Secrets go by context, not by a name's suffix: URL query parameters named key / apikey /
  api_key (api-key) / token / access_token / secret (any case) and drpc's dkey; locator object keys named
  authorization / password / secret / api_key / apikey, and every key inside a `headers` or `auth` object (a plain
  `token: "USDC"` param stays). User info and fragments are dropped, every non-version path segment on a known keyed
  RPC host (Alchemy, Infura, drpc, publicnode, QuickNode, Ankr, Blast, Chainstack, Helius, NodeReal, GetBlock) is
  dropped, a key-shaped last segment after `/vN/` on any host and any 20+ character segment with a digit are dropped,
  except an EVM address or hash (`0x` + 40 or 64 hex) off the keyed hosts; URLs inside text are scrubbed too. The test fixture is the fake key of `tests/ingest/rpc.test.ts`, read from that file.
- `confirm` copies the provisional row's provenance and adds `approved_by` / `approved_at` to a disclosure locator. It
  never needs the asset YAML: a provisional row written before 0004 gets `config_hash` = `unloaded` when the YAML is
  gone or invalid (`data confirm`, a `confirm_observation` approval).
- Income statement v2 `provenance` reads the rows when every stored day a revenue line reads has a mapped row
  (`basis: 'observations'`): `methods` splits each metric line's annualized amount by its rows' method (a manual day is
  disclosed; a periodic stream's provisional tail is derived; a derived/estimate line stays derived), `daysMeasured`
  counts the window days with a measured row (it was "days the line existed" for a young line, null otherwise), and
  `sources` lists the rows' `<rung>:<adapter | provider | host | chain>`. Otherwise (history not backfilled) it is the
  config's, as before (`basis: 'config'`). No other v2 field and no legacy byte moves (test: tests/report/provenance.test.ts).
- `latest_levels` rows (and so the `levels` snapshot body) now carry `sourceType` and `locator`.

History backfill: `orion db backfill-provenance [--dry-run] [--json]` maps rows with no provenance by plan correction 1
(`src/provenance/backfill.ts` lists the rules): `code_version` = `config_hash` = `pre-v2`; unmappable rows are listed with
a reason (`unknown_asset`, `unknown_metric`, `manual_without_citation`, `no_source_in_config`, `no_source_type`,
`source_changed`) and never written. An `api` row whose `source_detail` names a DefiLlama host (api / coins / pro-api /
yields.llama.fi) is `third_party` whatever its metric reads now; `block N` and `block N: <detail>` give block_from =
block_to = N. Writes are bounded: at most 1,000 rows per transaction (one set-based UPDATE), each under the asset lock;
a crash leaves whole batches and a re-run resumes (`method IS NULL`). The dry run on the proof copy (controller, Step 4) records the per-metric mapped
counts and the full unmapped list here; a non-empty unmapped list goes to Mike (the fix is a rule).

Review Focus 5: the importer inserts named columns, so on a schema at 0004 the provenance columns stay null and the
row-hash proof covers only the carried columns (tests/tools/importSqlite.test.ts, tests/tools/proof.test.ts). The
cutover importer leaves history unmapped until `db backfill-provenance` runs. `staging_refresh` refuses a dump whose
migrations differ, so after the cutover prod and stage must apply 0004 (and 0005) in the same release step.

## Task 7: token amounts and prices stored apart (spec §4)

Built: migration 0005 (expand-only): `tokens` (`token_ref` PK, symbol, `decimals` bigint per baseline 7.1, `peg`,
`coingecko_id`; seeded with `usd`), `prices` (`token_ref`, `ts` = top of the UTC hour, `price_usd` double precision,
`source`, `fetched_at`; PK `(token_ref, ts, source)`), nullable `observations.token_ref` / `amount` (double precision) /
`hourly_amounts` (jsonb, 24 numbers), and the view `flow_usd_v` (per active flow row: `usd_hourly` = sum of hour amount x
the newest `prices` row at or before the hour, coingecko first, at most 6 hours old; `hours_priced`, `hours_needed`,
`legacy_usd` = `value`, and `usd` / `usd_basis` = hourly | usd_native | legacy_unpriced | legacy_no_hourly |
legacy_no_tokens). No report code reads the view; the report still reads `value` (Task 8 switches it after G2).

Dual write (values unchanged, plan correction 2):
- Transfer scans (`src/ingest/flow.ts`): the per-day count moved into `openDayScanner`, shared with the backfill, so both
  count the same transfers. Per member it sums the day's amount and 24 UTC-hour buckets in the member's token (tokens x
  share price for a vault share), beside the USD it priced per transfer exactly as before. Token refs:
  `eip155:<chain>/<token>`; a vault share valued at pricePerShare is in its underlying, `coingecko:<price id>` (the config
  names no underlying address: yCRV's yvcrvUSD -> `coingecko:crvusd`, st-yCRV -> `coingecko:yearn-crv`). Every hourly
  market_chart point the scan already loaded is upserted into `prices` (floored to the hour, the earlier of two points
  in an hour kept); no new request. A dry run writes no tokens or prices.
- USD-native first-party series: `token_ref = 'usd'`, `amount = value` (Lighter exchangeMetrics kinds except `buyback`,
  Lighter treasury buys `unit: usd`, Hyperliquid fund fills, Hyperliquid USDC reserve-yield payments). DefiLlama series
  and Lighter's `unit: tokens` series get no token columns.
- Solana supply drop: `amount` = the day's fall in tokens (`solana:mainnet/<mint>`), `hourly_amounts` null; days from the
  DefiLlama history carry none.

`orion data backfill-tokens <a> [--metric k]... [--days N] [--dry-run] [--json]` (`src/ingest/tokenBackfill.ts`):
re-scans each day with the writer's day scanner and fills only `token_ref`/`amount`/`hourly_amounts` on the active
row (`UPDATE ... WHERE id = <id> AND amount IS NULL` and still active), one transaction per day under the asset lock,
the whole run under the asset's run lock; never `insertObservation`. A day whose re-scanned amount differs from a stored
`flow_tokens.*` twin (same group, same senders, no share price; a tokens member is its own twin) by more than 1e-9
relative is refused whole; a member-day with no active row (or a non-scan active row) is skipped and listed; a row that
already has tokens is counted, never rewritten, so a re-run resumes. Prices for the range come from
`market_chart/range` in windows of at most 89 days (hourly), newest first, one id at a time through the run's
transport (keyless spacing 2.5 s); the first failing window stops the walk and is listed (the key's history reach,
correction 13). A dry run fetches nothing and writes nothing. Without `--days` the range starts at the oldest stored
row of the metrics; a day with nothing to fill is not re-scanned (no log request).

`orion data compare-usd <a> [--days 91] [--json]` (`compareUsd` in `src/db/prices.ts`): per `unit: usd` flow metric,
over rows observed in (now - days, now]: within the hourly series (rows whose day starts no more than 90 days before
the row's `fetched_at`, so the legacy USD was priced at hourly points; dollar-native rows included and counted) sum
legacy vs sum hourly, gap %, and nearest-rank p50/p90 of the per-day |hourly - legacy| / legacy; days beyond (legacy
priced at daily points) reported apart in `beyond`; `unpriced` (an hour with an amount has no price: keeps value),
`noTokens`, `noHourly` counted. The G2 table (Step 5, controller) comes from this.
