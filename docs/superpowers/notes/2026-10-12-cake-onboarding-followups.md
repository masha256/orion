# CAKE onboarding: follow-ups

Date: 2026-10-12. Build notes: `docs/superpowers/notes/2026-10-12-cake-onboarding.md`.

## Checkpoints

1. Done. `persona assign cake onchain-dex-analyst`; live fetch: every source ok, no anomaly.
2. Done. `./run-daily.sh cake` (42 s): signal `cake-20261012T185508Z-92`, blocked only on `no_assumption_set`, grade A.
   Bootstrap journal flags, answered:
   - "The burn is dated 2026-07-14": the trailing-window value is stamped at its oldest day (as for UNI/CRV), not staleness.
   - "Does the flow exclude the chef's mint-and-return?": yes; the scan is of the burner with a converter allowlist,
     `from_ignore: [masterchef_v2, zero]`.
   - "Is the window spike-affected?": yes, September (7.4M USD vs 2.3-3.7M a month Apr-Aug); noted in the calibration.
   - "staked_supply 0?": veCAKE is retired; the burn is the whole claim.
3. Done. 362-day backfill on live (Mike: "We will want backfill in prod"), backup `pre-cake-backfill-20261012T191811Z`.
   It raised three `unlisted_sender` anomalies, acknowledged by Mike (#3 Safe 0xecc9 118k CAKE 2025-10; #4 Safe 0xfa20
   39.7k CAKE 2025-12, same signer 0xd099; #5 EOA 0x9f1f 702 CAKE 2026-06): one-off burns, not counted, none since.
   Calibration: Central on the 91-day window, chosen per Mike's standing instruction ("choose central one, i will adjust").
4. Done. `cake-20261012T194102Z-94`, ok, grade A. 12m expected 2.19 (bear 0.34 / base 1.36 / bull 5.71, dispersion 0.70;
   hc 1.58, fm_holder_flow 3.11). 6m expected 1.96. Inbox empty.
5. Done. Cron `orion-cake` (a0cb5d76eda8), 05:45 PT, orion-ops, wrapper `orion-tick-cake.sh`; prompt = orion-uni's with
   the symbol swapped (verified in jobs.json).

## Calibration (2026-10-12, spot 2.30, 91-day burn run rate $57.1M, market at about 14x it)

| Package | 91d | 28d | 357d |
|---|---|---|---|
| conservative | 1.13 | 1.36 | 1.28 |
| **central (picked)** | **2.19** | 2.63 | 2.49 |
| constructive | 3.93 | 4.70 | 4.46 |

- Spot needs a 14.8x holder-flow multiple in every scenario (central 10x), or +37% first-year burn growth.
- Sweep on base: y1 growth -9 / +11%, multiple -5 / +5%; every other key under 2%; staked ratio 0.
- All band edges together: -45 / +76% (1.21 / 3.86).

## Open

- Emission and burn rates are set by the team and a CAKE vote (MasterChef v2 `cakePerBlock`); a change shows in
  `emission_rate_annual` on the next tick.
- An unlisted sender into the burner raises a new anomaly; acknowledged senders no longer affect the signal.
