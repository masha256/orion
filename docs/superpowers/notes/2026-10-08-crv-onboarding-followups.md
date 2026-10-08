# CRV onboarding follow-ups (2026-10-08)

Spec: `docs/superpowers/specs/2026-10-08-orion-crv-onboarding-design.md`. Plan: `docs/superpowers/plans/2026-10-08-orion-crv-onboarding.md`.

## Checkpoints

1. `orion persona assign crv onchain-dex-analyst`; `orion data fetch crv --dry-run` on the live home: every source ok, no anomaly.
2. First tick (`./run-daily.sh crv`, exit 2): fetch run 40 ok, 119 rows; bootstrap agent run #8, journal only. It exposed a bug: the
   valuation ran as of the newest observation the fetch wrote, which was the future emission step (2027-08-12), so signal 45 was
   dated 2027 and graded D. Fixed in `src/app/update.ts` (`c4f2914`: only a schedule metric's step in force counts). Signal 45,
   valuation run 45 and snapshot 45 were deleted and the config version's created_at reset, after a backup; `orion model run crv`
   then gave signal 46, blocked on no_assumption_set, grade A. `signals.jsonl` and `ticks.jsonl` each keep one line for signal 45.
3. Calibration, in scratch copies of the live DB with 362 days of fees backfilled (CoinGecko's free tier refuses crvUSD prices
   older than 365 days: HTTP 401). Run rates: 28 days 5.38M, 91 days 5.14M, 357 days 6.98M USD a year. Sweep from the central
   set (12m expected 0.032): rev_growth_y1 -0.3 to 2.0 moved it 0.016 to 0.160; multiple 5 to 60 moved it 0.023 to 0.082; all else
   under 0.01; staked_ratio_horizon nothing. Packages, 12m expected, 91-day window (28 / 357 / 91 without incentives):
   conservative 0.019 (0.020 / 0.024 / 0.014); central 0.032 (0.033 / 0.041 / 0.025); constructive 0.142 (0.148 / 0.189 / 0.132).
   The user chose CENTRAL on the 91-day window, imported as v1 from `calibration/crv-assumptions.yaml`. Bands by the mirror rule
   (bull rev_growth_y1 halved; capture tied at the ceiling); all keys at the edge move the 12m expected value -42 / +66 percent.
   The market prices roughly the constructive bull case (+150 percent growth at 50x); the user heard this before choosing.
4. First signal: `crv-20261008T115239Z-47`, ok, grade A, spot 0.3830; 12m expected 0.0322 (bear 0.0067 / base 0.0227 / bull
   0.0767, dispersion 0.74, upside -91.6 percent); modules hc 0.0175, fm_holder_flow 0.0361, vote_incentives 0.0072 (component).
5. Cron line `orion-crv`: job 58f7c92759f6, `20 17 * * *` PDT (00:20 UTC; 16:20 PST after DST), pre-run script `orion-tick-crv.sh` (per-asset wrapper, as vvv/hype/aero), deliver orion-ops (telegram:1620897892:16022), replies attached; prompt is the orion-aero prompt with AERO/aero → CRV/crv. The 2026-10-31 DST reminder lists it.

## Open

- Staked total return ignores cash paid to lockers (it counts only emissions to stakers, zero for CRV and nearly so for AERO), so
  it equals the price upside. Live 2026-10-08: a direct veCRV locker earns about 4.3 percent of CRV's price from fees and
  incentives; st-yCRV (Yearn, 83.1M veCRV, 10.7 percent of voting power) shows 13.9 percent net, amplified by yCRV's 43 percent
  discount to CRV (0.219 vs 0.383) and the forfeit from unstaked yCRV (43.6M of 72.0M staked). Proposed: count holder-flow and
  component cash per staked token in the staking yield; optionally a yCRV view (price, discount, st-yCRV yield). The user is
  deciding.
- Push: `git push origin main` fails (access rights); main is ahead of origin.
- The analyst's open questions from the bootstrap are answered in the spec's amendments: the holder flow's observed_at is the
  window start (as AERO), the locked share is on effective supply (as AERO), Votium is excluded, weekly zero days are expected.
