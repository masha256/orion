# yCRV onboarding follow-ups (2026-10-09)

Spec: `docs/superpowers/specs/2026-10-09-orion-ycrv-onboarding-design.md`. yCRV is valued as staked in YearnBoostedStaker
(crvUSD rewards); the auto-compounding vault is out of scope (user's choice).

## Checkpoints (all done 2026-10-09, live)
1. `persona assign ycrv onchain-dex-analyst`; `data fetch ycrv --dry-run` all ok (price 0.1834, 0.00 percent vs DefiLlama).
2. `./run-daily.sh ycrv`: exit 2 (blocked, no_assumption_set), grade A, 2m02s. Observations 1,141 -> 1,256 (115 yCRV).
   Bootstrap run #10 (74k in / 3.6k out tokens), journal 9. Its open questions, answered: the flow is valued per staked
   token (`valued_per: recipients`); real_staking_yield reads 0 because it counts emissions only (the open yield-line
   question, CRV's too); the cash is mostly vote incentives (carried in growth); the flow driver's date is its window start
   (normal); late-September payouts were lumpy but weekly totals held.
3. Calibration: central package, 91-day window (user). Backup `backups/orion.db.pre-ycrv-calibration-20261009T140420Z`.
   `model assumptions import ycrv calibration/ycrv-assumptions.yaml` -> v1.
4. `model run ycrv` -> **ok, grade A, `ycrv-20261009T140429Z-53`**: 12m 0.1220 (bear 0.0507 / base 0.1081 / bull 0.2213),
   6m 0.1252, spot 0.1834 (-33.5 percent), dispersion 0.82; hc 0.0820, fm_holder_flow 0.1821. Inbox empty.
5. Cron `orion-ycrv` (6dc912265834), `25 17 * * *` (00:25 UTC), script `orion-tick-ycrv.sh`, orion-ops, attached; prompt
   is orion-crv's with crv/CRV -> ycrv/yCRV. DST reminder updated (-> `25 16 * * *` on Nov 1).

## Calibration table (12m expected vs spot 0.1834; packages conservative / central / constructive)
- Run rates: 28d 1.72M, 91d 1.52M, 182d 1.74M, 357d 2.38M USD a year. Monthly payouts fell from ~220k (Nov-Mar) to ~128k
  (Jul-Sep), with the CRV price.
- 91d: 0.080 / **0.122** / 0.232. 182d: 0.092 / 0.140 / 0.265. 357d: 0.126 / 0.191 / 0.363.
- Sweep around 0.125: y1 growth -30..+15 percent -> 0.082..0.194; multiple 5..16x -> 0.100..0.191; terminal growth
  -10..+2 percent -> 0.111..0.141; discount 10..25 percent -> 0.144..0.106; regime 0.7..1.3 -> 0.105..0.145; staked
  ratio at horizon: no effect.
- Spot needs about +19 percent y1 growth on the central settings, or flat bribes at an 8x multiple and an 11.5 percent
  discount rate: the market prices bribes holding up.

## Open
- **Ceiling at CRV's price.** The constructive bull case (0.455 at 91d) exceeds CRV (0.35). Not reachable from the central
  set (bull 0.221), but the agent's bands plus a CRV fall could approach it. Build before any constructive recalibration.
- **Staked total return / real staking yield** reads the price upside only (yield 0): the same yield-line question as CRV,
  deferred by the user.
- **The 10.5M veCRV gap** in Yearn's locker (unexplained; does not change cash per staked token).
- sdCRV and cvxCRV next (same pattern; `share_price` / `valued_per` / locker lines already built). The locker veCRV shares
  are recorded daily on CRV as `monitor_only` lines (`ve_power.*`, `ve_locked.*`) from 2026-10-09.
