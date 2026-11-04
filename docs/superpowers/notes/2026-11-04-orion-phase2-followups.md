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
