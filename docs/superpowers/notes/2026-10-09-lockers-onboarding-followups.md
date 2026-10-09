# cvxCRV and sdCRV onboarding follow-ups (2026-10-09)

Live 2026-10-09: assumptions v1 (central, 91 days), signals cvxcrv-56 (12m 0.0674 vs spot 0.1429, -53 percent; staked
total return -44) and sdcrv-57 (12m 0.1176 vs 0.1920, -39 percent; -27). Cron orion-cvxcrv / orion-sdcrv at 00:30 /
00:35 UTC. Spec: docs/superpowers/specs/2026-10-09-orion-lockers-onboarding-design.md.

- **cvxCRV's CVX stream stopped.** CvxDistribution (0x449f...ddc6) was topped up with about 123k CVX every 6 days from
  ChefRewardHook; the last was a partial 45k on 2026-08-27. Daily CVX to the wrapper fell from about 4.4k USD to about 36
  USD; the reward rate is now about 4 CVX a year (period ends 2026-10-15). Capture for cvx is 0 in every scenario; the
  stream stays configured so a restart shows up (the 91-day run rate keeps the old CVX until about 2026-12-01, which is why
  capture is a share and not 1). If Convex restarts it, the 91-day share was 0.13 and the expected target would be 0.077.
- **Capture is a share.** capture_rate_terminal.<flow> is each flow's share of the summed run rate. Setting 1 per flow
  counts the run rate three times (cvxCRV +62 percent where shares give -45). Bands keep the shares near their calibrated
  values; a test checks they sum to at most 1. When the mix drifts, recalibrate the shares.
- **sdCRV bribes stay inside the holder flow** (user: count them), as yCRV, not a vote_incentives component. The bootstrap
  agent asked to reclassify; the answer is no, the stakers receive the bribes as sdCRV.
- **sdCRV price.** CoinGecko ran +2..+6 percent over DefiLlama 2026-10-03..09 (+16 on 10-08). Cross-check tolerance is 5.
- **Ceiling** (parked by the user): sdCRV constructive bull would exceed CRV; central stays under.
- **Window drift.** The 357-day cash was 31 percent (cvxCRV ex CVX) / 59 percent (sdCRV) above 91 days, the CRV-price
  decline. The calendar trigger 2027-08-12 (CRV emission cut) is on both.
