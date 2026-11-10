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
id; no agent run: anomalies wake nothing since Phase 1) and makes the asset's nightly block an ALERT with one line per
breached check (final review I1, plan correction 12; see "Final review fix wave" below), and the tick evaluates the report day's checks after the
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
  api_key (api-key) / token / access_token / secret / x_cg_demo_api_key / x_cg_pro_api_key / x-api-key / auth_token /
  access_key / password / auth / authorization (any case; `-` and `_` ignored) and drpc's dkey; locator object keys
  named authorization / password / secret / api_key / apikey / access_token / private_key / api_token (same matching),
  and the whole value of a `headers` or `auth` key (an object or array emptied, a string blanked; final fix wave). A
  plain `token: "USDC"` param stays. User info and fragments are dropped, every non-version path segment on a known keyed
  RPC host (Alchemy, Infura, drpc, publicnode, QuickNode, Ankr, Blast, Chainstack, Helius, NodeReal, GetBlock) is
  dropped, a key-shaped last segment after `/vN/` on any host and any 20+ character segment with a digit are dropped,
  except an EVM address or hash (`0x` + 40 or 64 hex) off the keyed hosts; URLs inside text are scrubbed too. The test fixture is the fake key of `tests/ingest/rpc.test.ts`, read from that file.
- `confirm` copies the provisional row's provenance and adds `approved_by` / `approved_at` to a disclosure locator. It
  never needs the asset YAML (`data confirm`, a `confirm_observation` approval). (Before 0006 a provisional row written
  before 0004 got `config_hash` = `unloaded` when the YAML was gone or invalid; removed in Task 10 fix round 1.)
- Income statement v2 `provenance` reads the rows when every stored day a revenue line reads has a mapped row
  (`basis: 'observations'`): `methods` splits each metric line's annualized amount by its rows' method (a manual day is
  disclosed; a periodic stream's provisional tail is derived; a derived/estimate line stays derived), `daysMeasured`
  counts the window days with a measured row (it was "days the line existed" for a young line, null otherwise), and
  `sources` lists the rows' `<rung>:<adapter | provider | host | chain>`. Otherwise (history not backfilled) it is the
  config's, as before (`basis: 'config'`; since Task 10 only for a pure input without provenance). No other v2 field and no legacy byte moves (test: tests/report/provenance.test.ts).
- `latest_levels` rows (and so the `levels` snapshot body) now carry `sourceType` and `locator`.

History backfill: `orion db backfill-provenance [--dry-run] [--json]` maps rows with no provenance by plan correction 1
(`src/provenance/backfill.ts` lists the rules): `code_version` = `config_hash` = `pre-v2`; unmappable rows are listed with
a reason (`unknown_asset`, `unknown_metric`, `manual_without_citation`, `correction_without_neighbours`,
`no_source_in_config`, `no_source_type`, `source_changed`) and never written. Manual rows without a citation follow
Mike's pre-G2 decision 2 (below). An `api` row whose `source_detail` names a DefiLlama host (api / coins / pro-api /
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
**Task 8 (after G2, built):** income statement v2 reads the view (`src/report/load.ts` `statementSeries`): per day row
`dailyOf` selects, the view's `usd` where `usd_basis` is usd_native, or hourly on a row whose stored USD was itself
hourly-priced at ingest (its day starts within `HOURLY_SERIES_DAYS` = 90 of its `fetched_at`: `pricedHourlyAtIngest`,
`src/db/prices.ts`, the one rule `compare-usd`'s within/beyond split also uses), else `value`; each statement line
carries `priceBasis` (`hourly` | `usd_native` | `legacy` | `mixed` over every day its figures read, the window and
growth's prior window; null without a daily USD series), and `incomeStatement.priceBasis.flows` says so. The legacy v1
keys (`--legacy`, the tick's v1 fields) keep reading `value`, byte for byte; the default report day is still chosen from
`value` rows. Periodic streams (HYPE reserve yield) stay on `value`, labelled legacy. Snapshot `schema` stays 1.
Task 8 review fix round 1 (controller rulings):
- I-1: G2 signed off only the within days (0.000% vs stored), so v2 equals v2 before Task 8 on real data. The older
  backfilled rows (`beyond`: priced from daily points at ingest, now fully covered by the hourly price backfill) stay on
  their stored USD, labelled legacy. **Phase 3 option for Mike:** re-price the beyond rows at hourly prices. Measured on
  a read-only prod copy, D-181..D-91 for D = 2026-11-05 (growth's prior window), Σ(hourly − stored) over the beyond rows:
  vvv `flow_usd.burn` +15,002.12 (68 rows), uni `flow_usd.burn` +43,068.12, cake `flow_usd.burn` +55,417.09, cake
  `flow_usd.treasury` +23,694.86, vvv `flow_usd.burn_programmatic` −28.54 (prior windows +0.3% to +1.9%); within rows 0.
  It needs its own per-metric beyond table over 182 days and Mike's decision.
- M-2 (no change): reconciliation checks stay on the stored `value` (`src/checks/evaluate.ts`) while v2 lines read the
  view; within the hourly series hourly == stored at 0%, and beyond rows are legacy, so `incomeStatement.checks[].lhs/rhs`
  reconcile the printed figures (yCRV `splitter`, `gross_by_sender`). Revisit if a later phase re-prices beyond rows or
  the two bases part: then read checks from the statement's basis.
- M-6 (deferred, Phase 3): `listFlowUsd` evaluates flow_usd_v over the asset's whole history (every row's 24 lateral
  price lookups) in one query; bound it by `metric_key = ANY(...)` and `observed_at` (target − 2W − 1 .. target + 1) as
  history grows.

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

### Task 7 review fix round 1 (controller rulings)
- `flow_usd_v` is timezone-independent: hour h of a row starts at `observed_at - interval '24 hours' + (h - 1) * interval
  '1 hour'` (the first version used `- make_interval(days => 1)`, calendar arithmetic in the session TimeZone: on
  2026-11-01 under America/Los_Angeles every bucket was priced one hour early). Pinned by a test that reads the view
  under `SET LOCAL TIME ZONE 'America/Los_Angeles'` on that day.
- `flow_usd_v` lists only `flow_usd.*` rows, so `legacy_usd` is always dollars. The view selects by name because the DB
  has no units: a test pins that every USD flow metric of every asset is named `flow_usd.*` and only those are.
- `backfill-tokens` fetches one market_chart range per CoinGecko id per run (yCRV's crvusd once, not once per ref),
  only for the hours of days that still have a row to fill and that are not already stored under every ref priced at
  the id; the rows are upserted under each of those refs. A re-run with nothing pending makes no CoinGecko request.
  The JSON's `prices[]` is now one entry per id with `tokenRefs[]` (was one per `tokenRef`).
- `backfill-tokens` exits 1 when any day was refused (the Step 5 stop rule fails closed in scripts).
- `compare-usd` day-gap percentiles count every day: a day with legacy 0 and hourly not 0 counts as 100% (counted in
  `legacyZeroDays`), legacy 0 and hourly 0 as 0%.
- A row superseded or rejected between the backfill's read and its day transaction is listed in `skipped`
  ("superseded or rejected during the run"), not counted as already filled.
- R18: `backfill-tokens` also fills the first-party dollar rows written before 0005 (Lighter exchangeMetrics kinds
  except `buyback`, Lighter treasury buys `unit: usd`, Hyperliquid fund fills, Hyperliquid USDC payments): `token_ref
  'usd'`, `amount = value`, `hourly_amounts` null, no request of any kind, same guard (`amount IS NULL` and active), one
  transaction per day under the asset lock. Which series qualify is the adapter's own `usdNative(params)` declaration,
  the same predicate its run uses to return `token: USD_TOKEN`. Only `api` rows the series wrote are filled: a manual
  row or a history row whose detail names a DefiLlama host is skipped and listed. HYPE (no RPC) runs it with no RPC.
- Accepted (ruling, not fixed): a transfer-scan member with no `flow_tokens.*` twin (the CRV family, AERO, cvxCRV, the
  yCRV share members) is filled unverified. If its allowlist or `from_ignore` changed after the row was written, the
  current config's tokens sit beside the old config's `value`; compare-usd's per-day p90 is the only net.

## Task 7b: yCRV vote incentives below the line (Mike G1)
- Revenue = the veCRV fees Yearn's voter sends the splitter (`flow_usd.yearn_gross_fees`, line `fees_rev`); the
  auctioned third-party vote incentives Yearn's FeeBurner sells into crvUSD (`flow_usd.yearn_gross_incentives`) are below
  the line, as sdCRV's bribes (spec rule 3). 93 days to 2026-11-04: fees $140,085 (25%), incentives $420,855 (75%).
- Generic mechanism, no yCRV code: `apportion: { by, total }` on a use or below-line line with a `metric` carries that
  flow x (window sum of `by` / window sum of `total`) (ruling R14, formula `apportion_by_mix@1`, method `derived`; the
  line's JSON carries `apportion: { by, total, mix, bySum, totalSum, formula }`). A flow may be read by more than one
  line only as an apportion set: one total, distinct `by`, and a `sum` check total = [total], parts = the by series
  (metric keys, or the revenue lines reading them) must exist, so the set splits the flow whole. Refused at load
  otherwise, as is apportion without a metric or with `paid_metric`.
- Holder flow reads an apportion set whose lines all reach holders alike (one bucket, haircut, recipient base) as its
  whole flow, once: `holderFlow.gross`/`net`, buckets, yields and growth equal v1's to the bit; only `fromRevenue` vs
  `fromBelowLine` moves. Line by line, the set's figures sum to the flow within float rounding (1e-15 relative).
- No mix (the total's window sum is 0, or a day of `by` or `total` is missing): the lines are null, flagged
  `apportion mix n/a: <ids> (<reason>)`, never divided by zero; holder flow keeps the whole flow.
- Growth of an apportioned line applies the current window's mix to both windows (the mix is not re-measured for the
  prior window), so its growth is its flow's growth.
- Sum check parts may now be a line id or a metric key. An apportioned line in a sum check must come with every line of
  its set (they read the flow once, factor 1): yCRV `splitter` = gross vs [ybs_payout, incentives_to_holders, treasury,
  incentives_to_protocol] = gross vs flow_usd.fees + flow_usd.yearn_revenue, the same comparison as before. New check
  `gross_by_sender`: gross vs fees + incentives, tolerance 0.000001 percent. It is an invariant guard, not a data check
  (fix round 1, M-2): the three series are members of one scan, so it holds by construction (within float rounding) and
  fails only if the scan planning changes (a member moved to its own scan, or an allowlist sender with no by series). It
  cannot catch an unlisted sender: all three series exclude one alike.
- Fix round 1 (review I-1, M-1): the `by` series decides an apportioned line's side. A holders/protocol/cost/opex line's
  `by` must be read by a revenue line (its `metric` or `derived.from`); a below_line line's `by` must be read by none.
  Swapping the by series (the user-paid share below the line) is refused at load, in config proposals too. The sum check
  proving a set's partition must be daily (`window_days` 1 or absent) with `tolerance_pct` <= 0.000001; a looser or
  windowed check is refused.
- The two by-sender flows copy `flow_usd.yearn_gross`'s source (same token, sink and `from_allowlist [voter,
  fee_burner]`) with `count_from: [voter]` / `[fee_burner]`, so all three are members of ONE scan (one cursor, one
  pricing pass) and partition the gross by construction for the rows one scan wrote; separate allowlists would be a
  second scan priced at another time, and their sum could drift from the stored gross by CoinGecko revisions alone.
  That holds only for rows written by one scan (final review M1): R20-backfilled history is not. The rollout rescan
  writes only the two by-sender series, priced at backfill time (CoinGecko daily points for days more than 90 back,
  correction 13), while the stored `yearn_gross` rows keep their write-time prices. On backfilled days Σfees + Σinc
  differs from Σgross by those price revisions (crvUSD, so small), the two apportion mixes need not sum to exactly 1,
  and the set's lines need not sum to the flow within 1e-15 for the backfilled windows. `gross_by_sender` is
  evaluated only for the report day, so it never sees those days; holder flow is unaffected (the set collapses to the
  whole flow). The controller measures Σfees + Σinc vs Σgross over the current and prior windows in the G2 rehearsal. Consequence for rollout: the
  members share a cursor, so the new series start empty and need `data fetch ycrv --metric flow_usd.yearn_gross_fees
  --metric flow_usd.yearn_gross_incentives --backfill-days 183` (on the proof copy, then staging and prod at rollout;
  183, not 100, so v2 revenue growth, 91 days vs the prior 91, is measured from the first report: final review M2).
  Since ruling R20 that rescan writes only the two listed series: `flow_usd.yearn_gross`, the scan's other member, keeps
  its rows (id, value, fetched_at), so the rollout backfill cannot move the gross. Until the backfill, yCRV's v2 revenue and apportioned lines
  are null (a missing day), flagged `apportion mix n/a: ... (a day of ... is missing)`.
- Rollout ordering (fix round 1, M-4; corrected by the final fix wave, review M4): the default report day is v1's
  exactly. `lastCompleteReportDay` reads only the v1 report flows (`defaultDayFlowMetrics`), so the two v2-only
  by-sender series never hold yCRV's default day back: `report yield ycrv` without `--day` (v2 and `--legacy`) and the
  snapshot report the same day the previous release would, and the v2 statement shows the missing days as its own
  flag. The first nightly fetch writes yesterday for every member of the shared scan, so the flag clears for the report
  day after it; the window figures (revenue, growth) stay null until the history is there. The rollout still runs the
  183-day backfill of the two flows right after the deploy, before the first nightly, so the first v2 report on the
  new release is complete (docs/ops/deploy.md, "Phase 2 release").
- R14's approximation: the splitter sends 87.3 percent of fees but 78.0 percent of incentives to YBS, so splitting the
  measured payouts by the sender mix understates from-revenue holder flow (and overstates below-line) slightly.
  R14 error on real data: (controller)

## Ruling R20: `--metric` writes only the listed metrics on a shared scan
- `data fetch <a> --metric <k>...` still pulls every member of a listed transfer_flow's scan into the plan, so the scan
  (one cursor key, one `eth_getLogs` pass, one pricing pass) runs once. Only the listed members' rows are inserted; the
  other members' rows are neither inserted nor superseded, their manual rows are not adopted, and the fetch outcome notes
  `--metric: wrote only ...; ... share this scan and were left untouched`. Values written for listed metrics are the same
  as before (the scan counts every member exactly as before).
- While a member is withheld the shared cursor does not move (`fetch_cursors` untouched), so the next full fetch scans
  those days for every member and no member is left with a gap. Cost: that full fetch re-writes the listed members' rows
  for the days past the old cursor once more (same transfers, same prices unless CoinGecko revised them).
- Before R20 a narrowed fetch wrote every member and advanced the cursor (2026-09-19 ingestion fix wave). Callers checked
  (`--metric` / `metrics:` in src, tools, scripts, docs/ops, tests): none in src/tools/scripts/docs/ops depends on the
  old behaviour. `data backfill-tokens --metric` already filled only the listed members. `levels` passes level metrics
  on a dry run. Asset tests' onboarding backfills (pump, link, sky) pass unchanged;
  `tests/ingest/run.flows.test.ts` pinned the old behaviour and now pins R20 (writes one member, cursor untouched, the
  next full fetch fills the rest). Past followups notes (LIT 2026-10-23, dominance, window-91) name `--metric` fetches
  of API series or derived levels, which share no transfer scan and are unaffected.

## Task 9: onboarding templates and the sources register
- `docs/templates/T1-*.md` .. `T10-*.md` (+ README): one per spec §9 row, each with its lines and rungs, the addresses
  to find, checks, traps, a scoping checklist, a ```` ```yaml skeleton ```` asset file and a ```` ```yaml
  example-values ```` block. Example values come from a live asset (T1 UNI, T2 LIT, T3 PUMP, T4 CRV, T5 yCRV, T6 SKY,
  T8 LINK, T9 VVV); T7 (lending) and T10 (LST) have no live asset and use dummy values, labelled as such. T1's
  fee-share read is dummy too (UNI has none). `tests/config/templates.test.ts` fills each skeleton from its own doc and
  loads it through `parseAssetObject`, so the docs cannot drift from the schema. Skeletons use only keys and source
  types on this branch; the Phase 3 types (`state_delta`, `event_sum`, `balance_delta`, `pool_scan`, `api_series`)
  appear only as `# needs <type> (Phase 3)` comments. T5 uses the Task 7b apportion sets; T3 notes that a `supply`
  check on Solana is refused as circular (`solana.supply_burn_daily` is computedFrom `solana.token_supply`).
- Finding for Phase 3 / Task 11: top-level `holder_flows` is still required (min 1), so a protocol that pays its token
  holders nothing (Lido today, T10) cannot be onboarded until that requirement goes with the move to
  `income_statement`. T3 (launchpad) revenue is `not_measured` until `balance_delta`, so a T3 asset is deferred
  (spec §2, D6) unless its fee recipient is an EVM address a `transfer_flow` can scan.
- `docs/ops/sources-register.md` is generated by `tools/sources-register/generate.ts` from the 13 asset YAMLs: 16
  rows (4 RPCs named by env var: Ethereum `ORION_ETH_RPC_URL`, BNB `ORION_BNB_RPC_URL`, Base `ORION_BASE_RPC_URL`,
  Solana `ORION_SOL_RPC_URL`; Hyperliquid; four Lighter hosts; Venice; CoinGecko; three DefiLlama hosts; Jupiter;
  Llama Airforce), plus a per-asset table of what blocks each asset's export. Adapter endpoints come from a map in the
  script (defaults copied from `src/ingest/adapters/*.ts`, params override); the test pins that the map covers every
  registered adapter, that the committed file equals the generated one (`--check` does the same from the CLI), and
  that an unlisted host or a stale entry fails generation. No terms page was fetched.
- Commercial use filled only where the repo quotes the terms (date checked 2026-11-05): CoinGecko `yes` on the paid
  Basic plan (roadmap rule 5; blocks until bought), DefiLlama `no` below Enterprise (roadmap rule 1; api.llama.fi,
  coins.llama.fi, defillama-datasets.llama.fi). Every other row is `unknown`: the four RPC providers, Hyperliquid
  (HYPE), Lighter's four hosts (LIT), Venice (VVV), Jupiter (PUMP), Llama Airforce (CRV; spec D4: no stated licence).
  An `unknown` blocks only the Phase 5 export of the assets that read it, never ingest. Open for a human: read each
  terms page, fill the TERMS entry (URL, verdict, date), regenerate. Dune is not read by any asset, so it has no row.


## Final review fix wave (controller rulings on the final whole-branch review)
- I1 (plan correction 12): a check breach makes the asset's nightly block an ALERT. The tick adds the `check_breach`
  anomalies `recordChecks` raised to `ingest.anomalies_raised`, and `isAlert` also counts any `checks[]` entry with
  status `breach` (a re-tick of a day already breached raises no new anomaly but still alerts). The block prints one
  `ALERT <SYM> check breach: <id> (<type>) day <report day> gap <pct>%` line per breached check, after the holder-yield
  block's first line. No tolerance changed: sdCRV's dust breach (R15) now alerts on its days until Mike decides
  `tolerance_abs` at G2.
- M3: `listCheckResults` and the provenance read (`provenanceByDay`) run inside C4's isolation. A throw there gives
  `incomeStatement: null` and `incomeStatementError: income statement inputs unavailable: <msg>`; the legacy report,
  the tick's `holder_yield` (`statement_error`) and the snapshot never fail because of them.
- M4: the default report day reads only the v1 report flows (`defaultDayFlowMetrics` = `reportFlowMetrics` without
  `income_statement`, with v1's periodic streams), so it equals the previous release's for all 13 assets; v2-only series
  (yCRV's by-sender flows) show as the statement's missing-day flag instead.
- Scrub coverage (Task 6 deferred minor): see the Task 6 section's credential list.
- M1 (note wording, Task 7b section), M2 (`--backfill-days 183`, in the runbook), M5 (T5 template line 37), the two T7b
  tests (an incremental `--metric` run on a group with a cursor; yCRV R20 step 3 checks every member's active row count).
- Phase 2 release runbook: `docs/ops/deploy.md`, "Phase 2 release (migrations 0003-0005)"; pointer from
  `docs/ops/postgres.md`. `orion-remote` has no verb for `db backfill-provenance`, `data fetch`, `data backfill-tokens`
  or `data compare-usd`, so the runbook has Mike run them as the env user; remote verbs are Phase 3 (pre-G2 decision 4).

## Pre-G2 decisions (Mike, 2026-11-07, "proceed and apply recommendations")
1. **Dust is not a breach.** The CRV-family `sum` checks (crv `splitter`, sdcrv `crv_fee`, ycrv `splitter`) carry
   `tolerance_abs: 1` (USD) beside `tolerance_pct: 2`. `sum` checks gained the optional key (no default, so no other
   hash moved); its meaning is the one balance/supply checks already had in `src/checks/evaluate.ts` (`judged`): a day
   breaches only past BOTH the relative tolerance and the absolute floor. sdCRV 2026-08-31 ($0.046 in, parts 0, gap
   100%) is now `ok`; a $2 gap at 100% still breaches. yCRV's partition guard `gross_by_sender` keeps 1e-6 % and no
   floor; the apportion validator now refuses a partition check with `tolerance_abs` > $1 (M-1: <= 1e-6 % or <= $1).
   crv, sdcrv, ycrv hashes re-pinned. The v2 report's `checks[]` shows `tolerancePct` only (the floor is in each
   stored result's `detail.tolerance_abs`).
2. **R17, pre-v2 manual rows without a citation** (`src/provenance/backfill.ts` rule 2, on content, never ids; rejected
   rows alike; values never change):
   a. `source_detail` starting "DefiLlama artifact" (AERO `flow_usd.fees` 2026-09-10, ids 11831 / 515): `derived`,
      source_type `derived`, formula `manual_mean_of_neighbours@1`, inputs = the metric's rows in force on the day
      before and after (`{metric, observation_id, observed_at, value}`), locator `{note}`. A missing or ambiguous
      neighbour leaves the row listed as `correction_without_neighbours`.
   b. Any other (the VVV 2026-09-18 research-pass seeds, ids 1-16): `disclosed`, source_type `disclosure`, locator
      `{note, legacy_seed: true}`, `quoted_text` = `source_detail` where it is null, `citation_url` null. A row with
      neither a detail nor a quote stays `manual_without_citation` (nothing to quote).
   The null citation is allowed only on `code_version = 'pre-v2'`: every new disclosed row still needs one
   (`disclosedProvenance`). Task 10 (0006) must keep that exemption in any citation constraint it adds, e.g.
   `CHECK (source_type <> 'disclosure' OR citation_url IS NOT NULL OR code_version = 'pre-v2')`.
3. `data set` keeps requiring `--citation` (no change).
4. The release-2 backfills run as the env user (`sudo -iu orion-<env>`), as the runbook says; `orion-remote` verbs for
   them move to Phase 3 (table below).
5. R21: the runbook's command prefix is a shell function `o() { ... }` (a quoted `O='... $HOME ...'` variable never
   expanded `$HOME`); every use in the Phase 2 section is `o ...`.
6. The P4 rule is lifted: the Phase 1.5 cutover is done (prod releases `orion-2026.11.05.1` = f1d2a23,
   `orion-2026.11.07.1` = 895c8a1). Staging deploys of this branch still need Mike's go.

### Open items
For Mike at G2:
- [DECIDED, pre-G2 1] R15 / review M4 of Task 5: `tolerance_abs: 1` on the CRV-family sum checks. `two_path` checks
  have no floor (none breached on dust).
- [DECIDED, pre-G2 2] R17: the 18 provenance rows are mapped by rule 2a/2b; the runbook's dry run expects an empty
  unmapped list.
- Review M6: the `levels` snapshot body gained `sourceType`/`locator` per level (P2 approved the `full` body only):
  confirm, or drop the two keys from `levelsBody` until Phase 5.
- G2 rehearsal (controller): Σfees + Σinc vs Σgross on yCRV after the 183-day backfill, current and prior windows
  (M1); one N-1 write (old release's `data fetch` on a cheap asset, `db status`) on the 0005 proof copy, and a real
  `pg_dump -Fc` + `planRestore` + `pg_restore -L` of the filtered TOC into a scratch schema (M7).
- [DECIDED, pre-G2 3] `data set` requires `--citation` for every metric (spec §3): kept.

Rollout (before Phase 2 reaches staging):
- `orion-stage-soak.py` reads the v1 report keys; `orion-remote report yield` passes no `--legacy` (runbook step 1).

Can wait (final review triage), by phase:

| Origin | Item | Phase |
|---|---|---|
| T0 M4 | proof `out`/homes not confined to `$TMPDIR` | Task 11 proof (harness hardening) |
| T0 M6 | proof `ok` read by grep | Task 11 proof |
| T0 M7 | proof refusal paths untested | Task 11 proof |
| T0 | coverage check doesn't require the 13 named assets (the count >= 13 rule already fails short runs) | Task 11 |
| T1 | `paid_metric` guard untested for share_metric/run_rate readers | Phase 3 (unreachable by a flow today) |
| T4 M2 | Slack yields/multiples lines mix v1 and v2 sources | Task 11 (removing v1 resolves it) |
| T4 M3 | fragile CLI text assertion `tests/cli/cli.test.ts:1089` | Task 11 (rewrites the text output) |
| T3/4 M-a | `ratioOf` drops disclosed growth on estimate/of lines | Phase 3 (unreachable) |
| T3/4 M-b | `sourceLabelOf` not given asset metrics | Phase 3 (latent label) |
| T3/4 M-c | listing bar uses third_party inheritance | report-only; consistent with M4 |
| T3/4 M-d | 'missing day' flag fires on a null cost level | Task 11 |
| T5 M2 | price cross-check record matched by sourceId + label, not contract | Phase 3 (when llama price checks are replaced) |
| T5 M3 | UNI/LINK/CAKE price checks duplicate the existing cross-check | Phase 3 |
| T5 | circular rule doesn't follow mixed derived-of-adapter chains | Phase 3, before the first such check is wired |
| T6 M6 | after a rollback N-1's latest_levels upsert leaves stale provenance | documented in the runbook's rollback note |
| T7 | backfillPrices may refetch an id for a ref with no day to fill | quota only |
| T7 | one contiguous range refetches stored hours between gaps | quota only |
| T7 | R18 uses the current config's `usdNative` for history | same class as accepted M3; compare-usd p90 is the net |
| T9 | no drift test on copied adapter URLs | Phase 3 |
| T9 | unknown adapter/derived names pass the template test | Phase 3 |
| T9 | no-URL test checks TERMS, not generated output | Phase 5 export |
| T9 | fallback hosts (Base/Solana public RPC, pro-api.coingecko.com) not register rows | Phase 5, before the export reads the register |
| T9 | 'date checked' on quoted rows | Phase 5 |
| T8 M-6 | bound `listFlowUsd`'s flow_usd_v read by metric and `observed_at` (whole history today) | Phase 3 |
| T8 I-1 | option: re-price the `beyond` (daily-priced backfill) rows at hourly prices (deltas in the Task 8 paragraph) | Phase 3, Mike's decision |
| pre-G2 4 | `orion-remote` verbs (or `job run-now` kinds) for `db backfill-provenance`, `data fetch --backfill-days`, `data backfill-tokens`, `data compare-usd`, so a release step needs no `sudo -iu` | Phase 3 |

Dropped (final review triage): T0 M2, M3, M8, `get_path` and ids containing `.`; T2 statementShape ids/of-only pins
and the disclosure.e2e `preApprovalLitYaml` NOTE_NOW; T9 CoinGecko note wording.

## Task 10 (gate G3): 0006 provenance NOT NULL, `observations.source` dropped (breaking release)

Built: `0006_provenance_not_null.sql` (first line `-- breaking`): `observations.method`, `source_type`, `locator`,
`code_version`, `config_hash` NOT NULL; `observations_disclosure_citation` = `CHECK (source_type <> 'disclosure' OR
citation_url IS NOT NULL OR code_version = 'pre-v2')` (R17 exemption kept); `DROP COLUMN source`;
`latest_levels.source_type` / `locator` NOT NULL. `latest_levels.source` stays: the `levels` snapshot body publishes it
and the table has no method to derive it from.
- One derivation (`src/provenance/origin.ts`): `originOf({method, sourceType, locator, formula})` / `originOfRow` gives
  the old `source` value; `Observation.source` (so the CLI's and the analyst pack's `source` field, the flow-conflict
  and `--adopt` rule, the DefiLlama revision-window manual-row rule, the token backfill's skips, Solana's supply drop,
  the revision check) all read it. Inputs are the method, the rung, `locator.adapter` (`ADAPTER_ORIGINS`: the
  contract-state adapters only, the one rung `originOf` reads it for; `solana.supply_burn_daily` is the one `api`),
  `locator.input_origin` (R10.7, below) and the formula prefix (`manual_*` is manual), per R10.2a. Table test:
  `tests/provenance/origin.test.ts` (the controller's prod matrix plus the writer shapes prod lacks).
- Writers no longer pass `source`. A fetched level or schedule reading whose stamp would read back differently is
  refused (`origin_mismatch`, `src/ingest/run.ts`), never stored under the wrong origin. The series writers
  (`writeApiFlow`, `writePeriodicPayments`) stamp `SERIES_ORIGIN` (`api`); `tests/provenance/adapterOrigins.test.ts`
  runs every registered adapter once on fakes and fails when its writer's stamp is not what `originOf` reads back
  (a contract-state series declared `onchain` would otherwise see its own rows as foreign conflicts and stall).
- Derived rows (fix round 1, ruling R10.7): a derivation whose input metrics are sourced from DefiLlama or an adapter
  (run.ts's `apiInputs > 0`, the old stamp) writes `input_origin: "api"` merged into its configured locator, and only
  then, so a derivation over transfer scans keeps a byte-identical provenance; `originOf(derived)` = `manual` for
  `manual_*`, else `api` with `input_origin`, else `api` on a third-party rung (rows written before R10.7), else
  `onchain`. Every prod derived row has no `input_origin` and stays `onchain`. The derived branch of the guard is gone,
  so Phase 3 R5's derivations over a first-party adapter are stored (as `api`).
- `data set` lost `--source` (R10.3, the smaller change: a hand-entered row is a disclosure, origin `manual`;
  `--citation` stays required). `db backfill-provenance` and `src/provenance/backfill.ts` are gone (nothing can be
  null; it read `source`); `defillamaUrlOf` moved to `src/provenance/locator.ts` (the token backfill uses it).
- `tools/import-sqlite` writes a schema at exactly 0005 (`IMPORT_SCHEMA_LEVEL`); then a release-2 build's
  `db backfill-provenance`, then `db migrate --breaking`. `tools/phase2-proof/origin-check.ts` compares derived vs
  stored origin on a prod copy before the copy is migrated (README run order); `prod_copy.py` needs no change (the copy
  is migrated by the old release, so its columns match prod's), the new side's `db migrate` needs `--breaking`.
- Runbook: `docs/ops/deploy.md`, "Phase 2 tail: release with 0006 (breaking)" (pre-deploy null check, stage then prod
  with `--breaking`, no rollback past it). `deploy.sh` / `orion-remote switch` already refuse a pending breaking
  migration without `--breaking`, dump first with it, and refuse a rollback after it: no gap, no new test.
- Fallbacks 0006 made unreachable, removed in fix round 1 (M-4): `confirmObservation`'s `by.configHash` /
  `unloaded` branch (and `src/provenance/configHash.ts`): a confirm copies the row's own provenance; the income
  statement's per-day "unbackfilled window" fallback to `basis: 'config'`: with the loader's provenance the basis is
  always `observations`. `basis: 'config'` remains only for a pure input without provenance (unit tests, `yieldReport`).

## Task 11 (gate G4): v1 retired, `holder_flows` / `reporting` gone, `--legacy` removed

Built in two commits (ruling R11.1).
- 11a (config): `holder_flows` and `reporting` deleted from the asset schema: refused by name at load, at config-proposal
  filing and at approve (YAML untouched). Eligibility and the agent pack read `income_statement`; the pack's flow set
  (holders + below-line-to-holders metrics) equals the old `holder_flows` metrics per asset (pinned against cc59fa7).
  The "at least one holder_flows" requirement is lifted, so a protocol paying holders nothing (Lido-type) can be
  onboarded, and T10 lost its dummy buyback flow. All 13 config hashes re-pinned. Fixture edits (R11.7):
  `tests/fixtures/hype.yaml` and `aero.yaml` lose `holder_flows`; `lit-q3-run.json` edit path `reporting.dilution` ->
  `income_statement.dilution`.
- 11b (report): `report yield` has no `--legacy` and no v1 key (JSON and text); `src/report/legacy.ts` is gone. The tick's
  `holder_yield` and the nightly Slack block read only the statement (T4 M2); v1's `revenue_annualized`,
  `revenue_growth_annualized`, `payout_ratio` are optional, read only from an older release's job row. Snapshot `full`
  bodies are v2 only: `SNAPSHOT_SCHEMA` = `orion.snapshot/2`, `KNOWN_SNAPSHOT_SCHEMAS` still verifies a queued `/1`
  envelope. T4 M3 (fragile cli text assertion) rewritten; T3/4 M-d (a "missing day" flag fired on a null cost level)
  fixed.
- Default report day unchanged for 12 assets (pinned per asset against cc59fa7). **R11.6 yCRV:** its default day is now
  gated on the statement's flows (`yearn_gross_fees`, `yearn_gross_incentives`, ...); `yearn_styc_fee` dropped from the
  gate because no statement line reads it. The by-sender flows come from the same shared transfer scan as
  `yearn_gross` (R20: the nightly writes every member), so they advance together; the controller verifies yCRV's
  default day on a prod copy equals cc59fa7's.
- Proof harness (R11.2): `reports.sh` runs both sides with identical flags (no `--help` probe, no `--legacy`) and refuses
  an `<out>` or home outside `$TMPDIR` (T0 M4); `compare.py` compares v2 vs v2 (rel 1e-12) when the new side prints no
  v1, keeps the parity/reclass maps only for a v1-only old release, requires the 13 named assets, and has `--json` (T0
  M6); every `reports.sh` refusal is tested (T0 M7).
- **Phase 3 proof note:** Phase 3's spec §7 compares `--legacy` output across releases. After this release there is no
  `--legacy`: Phase 3 (and every later phase) compares v2 only, `reports.sh` + `compare.py` as they are now.
- Left in place on purpose: `src/report/parity.ts` / `tools/phase2-proof/parity.json` (v1 paths, read only against an
  old v1-only release) and `tools/import-sqlite/reports.ts` (the retired SQLite cutover proof; its `--legacy` probe is
  optional and finds none).

