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
