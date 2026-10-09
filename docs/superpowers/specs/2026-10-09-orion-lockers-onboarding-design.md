# Orion: cvxCRV and sdCRV onboarding (design)

Date: 2026-10-09. User: "Add sdcrv and cvxcrv"; "All 3 streams for cvxcrv. Yes count sdcrv bribes."

Both are liquid claims on veCRV locked for good by a locker (Convex, StakeDAO), the yCRV pattern: separate assets,
valued per staked token (`valued_per: recipients`), no dilution, emissions 0. What is new: each pays stakers in three
tokens, each scanned on chain as its own holder flow, and `revenue_run_rate_usd` sums them.

## Engine change: `flow_annualized` over several flows

`params.metrics: [a, b, c]` (two or more distinct flow metrics) instead of `params.metric`. Summed day by day over
days every flow has (a lagging stream never shows as a drop); detail names them `a+b+c`. API-series and on-chain flows
cannot be mixed. Tests: `tests/ingest/derived.test.ts`.

## cvxCRV (`assets/cvxcrv.yaml`)

Measured at CvxCrvStakingWrapper `0xaa0c3f5f…e434` (stkcvxCRV), which holds 351.3M of the 356.3M cvxCRV in the
BaseRewardPool; its totalSupply (342.2M) is the staked base. 423.8M cvxCRV. Price 0.139 (39 percent of CRV).

| Stream | Sender into the wrapper | 91d, per year | Rule |
|---|---|---|---|
| fees (crvUSD) | crvUSD reward pool `0x191f…2289` (100% of Convex's FeeDistributor share via Booster) | 2.70M | programmatic |
| crv | cvxCRV BaseRewardPool `0x3fe6…587e` (Convex's fee on its pools' CRV) | 1.89M | programmatic |
| cvx | CvxDistribution `0x449f…ddc6` (treasury program) + CVX minted on CRV (zero address) | 0.68M | discretionary |

Total 5.27M a year, about 11 percent of the staked cvxCRV at spot. No bribes: Votium pays vlCVX, not cvxCRV. CVX is at
99.994M of its 100M cap, so minted CVX is a trickle and the CvxDistribution program is the stream; discretionary, its
own discount premium.

## sdCRV (`assets/sdcrv.yaml`)

Measured at the sdCRV gauge `0x7f50…3466` (106.9M of 119.0M staked). Price 0.183-0.191 (51 percent of CRV).

| Stream | Sender | 91d, per year | Rule |
|---|---|---|---|
| fees (crvUSD) | CurveAccumulator `0x11f7…b4cd` (85% to the gauge, 10% LP fee recipient, 5% treasury) | 0.66M | programmatic |
| crv | CurveAccumulator (StakeDAO's fee on its strategies' CRV, 66% to the gauge) | 0.22M | programmatic |
| bribes (sdCRV) | Botmarket `0xadfb…b1ff` into MultiMerkleStash `0x03e3…1db4` | 1.60M | programmatic |

Total 2.47M a year, about 12 percent at spot; bribes 65 percent of it. Merkle claimants checked: the top claimants
hold sdCRV in the gauge, not in their wallets, so the bribes go to gauge stakers, the same base as the fees. The gauge
lists SDT, but SDT's gauge weight is 0 and none was paid in 91 days: left out. Bribes are priced at sdCRV's own price.

CoinGecko's sdCRV quote ran +2 to +6 percent over DefiLlama 2026-10-03..09 (+16 percent on 10-08; median -0.3 percent
over 90 days): cross-check tolerance 5 percent.

## Capture

`captureRate` per flow is its share of the run rate (fees 0.51 / crv 0.36 / cvx 0.13 for cvxCRV; 0.27 / 0.09 / 0.65
for sdCRV). Calibration sets `capture_rate_terminal.<flow>` to those shares (1 per flow would count the run rate three
times: a scratch run at 1 gave cvxCRV +62 percent where the shares give -45 percent).

## Checkpoints

Spike (read-only), build, scratch dry fetch (both ok), then with the user: backup, merge, live fetch + persona
(onchain-dex-analyst), first tick, calibration (options for the user to pick), cron `orion-cvxcrv` / `orion-sdcrv`
at 00:30 / 00:35 UTC. Ceiling parked by the user.
