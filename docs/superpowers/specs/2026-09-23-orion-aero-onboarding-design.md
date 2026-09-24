# Orion sub-project 6: AERO onboarding

Date: 2026-09-23. Status: planned (`docs/superpowers/plans/2026-09-23-orion-aero-onboarding.md`, generated from a per-task prototype and verified by extraction); section 11 records the planning amendments.

Extends `docs/superpowers/specs/2026-09-18-orion-valuation-framework-design.md` (section 3.7, the AERO contrast case), `docs/superpowers/specs/2026-09-19-orion-ingestion-design.md` (sources, adapters, derived metrics), and `docs/superpowers/specs/2026-09-22-orion-research-first-design.md` (the DefiLlama flow primary, the bootstrap, the inbox). Where this document and those differ, this one wins for the items it covers.

## 1. Purpose and scope

Cover AERO (Aerodrome Finance, Base) as Orion's second live asset, through configuration plus two small, generic ingest additions. The user's rule applies: Claude drafts the asset file, the persona, and the calibration and asks only decision questions; nothing is entered by hand.

In scope:

1. `assets/aero.yaml`: every metric fetched, one holder flow, two modules, key-wide bounds; agent bands after calibration.
2. A `flow_annualized` derived source: a revenue run rate from a flow's last 30 days.
3. Two `aero` adapters: the gross annual emission rate and the lockers' rebase share, read from the Minter and the escrow.
4. A persona for DEX tokens with an on-chain fee share, `onchain-dex-analyst`.
5. The onboarding sequence: dry fetch, first tick and bootstrap, calibration by sweep, bands, first signal, the Hermes job line.

Out of scope: incentives (bribes) to lockers as a second holder flow (section 10); any engine change; HYPE (sub-project 7).

### Decisions made during brainstorming

- Approach: declarative asset plus the two ingest additions; not manual metrics researched from web pages (fragile, against the research rule) and not a generic formula source (over-engineering for two reads).
- Modules: `holder_cashflow` 0.6, `forward_multiple` on holder flow 0.4; scenario probabilities 25/50/25. AERO's revenue and holder flow are the same series (100 percent of fees to lockers), so no revenue-basis multiple.
- Supply basis: `effective_total`, as for VVV. Locked tokens are the fee recipients and permanent locks can be unlocked by governance; circulating would roughly double the per-token target for the wrong reason.
- The bootstrap runs on the first tick as designed (its manual-metrics list is empty, so it writes a journal and stops); a hand-launched deep after calibration is the way to skip it.

## 2. Reference data (as of 2026-09-23)

Gathered by a research pass on 2026-09-23. Confidence: **A** read from the chain or an API that day, **B** reputable secondhand, **C** inferred or unverified. All values must be re-fetched by Orion; they are recorded here to justify design choices.

### 2.1 Facts that shaped the design

- [A] AERO token `0x940181a94a35a4569e4529a3cdfb74e38fd98631` on Base: total supply 1,983,240,735.6 AERO at block 51,704,207 (2026-09-23T21:09Z). No burn sink; the ERC-20 total is the effective supply.
- [A] VotingEscrow `0xebf418fe2512e7e6bd9b87a8f0f294acdc67e6b4`: `supply()` (AERO locked) 1,051,061,696; `totalSupply()` (voting power) 1,027,321,406; `permanentLockBalance()` 988,339,786. About 53 percent of supply is locked, 94 percent of that permanently.
- [A] Minter `0xeB018363F0a9Af8f91F06FEe6613a751b2A33FE5` (from `AERO.minter()`): `weekly()` 8,969,149.54 (equal to the contract's `TAIL_START`, so the tail regime is on), `tailEmissionRate()` 21 basis points, `teamRate()` 228 basis points, `epochCount()` 160, `activePeriod()` 2026-09-17T00:00Z (epochs flip Thursdays 00:00 UTC), `team()` `0xBDE0c70BdC242577c52dFAD53389F82fd149EA5a`.
- [A] Minter source (`aerodrome-finance/contracts`, `Minter.sol`): in the tail regime the weekly base emission is `totalSupply * tailEmissionRate / 10_000`; the rebase is `calculateGrowth(minted) = minted * ((total - veTotal) / total)^2 / 2` with `veTotal = ve.totalSupplyAt(activePeriod - 1)`, the voting power at the epoch's start (amendment 5; the planning pass had read this as the locked amount); the team share is `teamRate * (growth + weekly) / (10_000 - teamRate)`, with `weekly` the state variable frozen at `TAIL_START` in the tail (amendment 6; the planning pass had read `emission`); growth goes to the RewardsDistributor (veAERO rebases), emission to the Voter (gauges), the team share to `team()`. `WEEKLY_DECAY` 9,900 and `TAIL_START` 8,969,150 AERO apply only outside the tail. The tail rate can be nudged one basis point per epoch by `EpochGovernor`, within `MINIMUM_TAIL_RATE` 1 and `MAXIMUM_TAIL_RATE` 100.
- [A, derived] Today's weekly base emission is therefore about 4.165M AERO, the rebase about 0.484M (on voting power 1,027,321,406 at the epoch's start), the team share about 0.220M: gross about 4.87M per week, about 253.9M per year, 12.8 percent of supply; the lockers' rebase share of gross about 0.099. The 2026-09-17 mint (tx `0xd75b...288f`, decoded from the receipt): 4,790,434 minted (the requirement less the Minter's held balance), 4,154,746 to the Voter, 481,314 to the RewardsDistributor, 220,498 to the team; the formulas reproduce all three to the coin. Consistent with the 10.9 percent "annualized emissions" figure reported for April 2026 [B].
- [A] DefiLlama `summary/fees/aerodrome` (parent slug; children Aerodrome V1, Aerodrome Slipstream, Aero Lite): `dailyHoldersRevenue` total30d 14,207,482 USD, totalAllTime 481,754,698 USD; `dailyFees` total30d 17,518,709 USD. Methodology: HoldersRevenue is "fees earned by LPs staked in the gauge, forwarded to FeeVotingReward for distribution to veAERO voters"; Revenue equals HoldersRevenue (the zero-leak model). `dailyBribesRevenue` holds one point (2024) and is unusable.
- [A] DefiLlama price endpoint `coins.llama.fi/prices/current/base:<token>` returns `{ coins: { "base:0x9401...8631": { price, decimals, symbol, timestamp, confidence } } }`; price 0.6739 at fetch.
- [A] CoinGecko id `aerodrome-finance`: price 0.6719 USD, market cap 668M, FDV 1,335M, circulating supply 992,591,966, total supply 1,983,240,736, no max supply.
- [B] Predictive Allocation replaced weekly gauge voting on 2026-07-26 (Dromos Labs; several outlets). Fees still reach lockers: the holders-revenue series continues through September.
- [B] The merger of Aerodrome and Velodrome into "Aero" was announced 2025-11-12 for Q2 2026, with one AERO token (94.5 percent to AERO holders, 5.5 percent to VELO holders) and "no new tokens". Later items: launch codebase and audit contest 2026-08-30, Arc deployment 2026-09-16. No primary source confirms a completed token migration; the token, escrow, and Minter above are live and unchanged.
- [C] The Momentum Fund (2026-02 post) mentions "market-aware buyback and burns"; no burn sink or series exists today.

### 2.2 Contracts on Base

| Contract | Address |
|---|---|
| AERO token | `0x940181a94a35a4569e4529a3cdfb74e38fd98631` |
| VotingEscrow (veAERO) | `0xebf418fe2512e7e6bd9b87a8f0f294acdc67e6b4` |
| Minter | `0xeB018363F0a9Af8f91F06FEe6613a751b2A33FE5` |
| Team | `0xBDE0c70BdC242577c52dFAD53389F82fd149EA5a` |

## 3. The asset file

`assets/aero.yaml`: `id: aero`, `symbol: AERO`, `name: Aerodrome Finance`, `chain: base`, `supply_basis: effective_total`, `ingest: { chain_id: 8453, rpc_url_env: ORION_BASE_RPC_URL, backfill_days: 90 }`, `external_ids: { coingecko: aerodrome-finance, defillama: aerodrome }`, contracts as in 2.2.

| Metric | Type, unit | Source | Cross-check | Notes |
|---|---|---|---|---|
| `price_usd` | level, usd, critical, staleness 3 | coingecko `aerodrome-finance` price | http_json `coins.llama.fi/prices/current/base:0x9401...8631`, path `coins.base:0x9401...8631.price`, 2 percent | |
| `effective_supply` | level, tokens, critical, staleness 7 | erc20_supply token, subtract nothing | none (DefiLlama's coins endpoint carries no supply) | no burn sink |
| `circulating_supply` | level, tokens, staleness 14 | coingecko circulating_supply | none | CoinGecko's definition; informational under effective_total |
| `staked_supply` | level, tokens, staleness 7 | contract_read ve `supply`, decimals 18 | none | AERO locked in veAERO |
| `locked_supply` | level, tokens, staleness 7 | contract_read ve `supply`, decimals 18 | none | the same read: staking is locking |
| `staker_emission_share` | level, ratio, staleness 30 | adapter `aero.staker_emission_share` | none | the rebase share of gross, about 0.10 |
| `emission_rate_annual` | schedule, tokens_per_year, critical, staleness 45 | adapter `aero.emission_rate_annual` | none | gross: base plus rebase plus team, tail regime |
| `flow_usd.fees` | flow, usd, daily, critical, staleness 4 | defillama slug `aerodrome`, data_type `dailyHoldersRevenue`, backfill_days 90 | none | fees to lockers |
| `revenue_run_rate_usd` | level, usd, critical, staleness 5 | derived `flow_annualized`, params `{ metric: flow_usd.fees, days: 90 }` | none | 365/90 times the 90-day sum, matching the holder flow's window (amendment 7) |

`holder_flows: [{ id: fees, kind: fee_share, capture_rule: contractual, recipient_base: locked, metric: flow_usd.fees, window_days: 90 }]`.

`modules: [{ id: hc, type: holder_cashflow, kind: estimate, weight: 0.6 }, { id: fm_holder_flow, type: forward_multiple, kind: estimate, weight: 0.4, params: { basis: holder_flow } }]`; `scenario_probabilities: { bear: 0.25, base: 0.5, bull: 0.25 }`; no `total_return_variants`; `peer_set: []`.

Assumption bounds (key-wide, before calibration): `rev_growth_y1 [-0.6, 2.0]`, `growth_fade_years [1, 8]`, `terminal_growth [0, 0.05]`, `capture_rate_terminal.fees [0.5, 1.0]`, `capture_ramp_years.fees [0, 4]`, `discount_rate_base [0.08, 0.35]`, `multiple.fm_holder_flow [3, 40]`, `regime_multiplier [0.4, 1.6]`, `staked_ratio_horizon [0.2, 0.8]`. No premium key: the capture rule is contractual. Agent bands are added after calibration by the mirror rule (research-first spec 7.6; VVV calibration note).

`review_triggers`: `driver_deviation_pct: 25`, `provisional_move_pct: 25`; no `revenue_stale_move_pct` (there is no usage index); no calendar entries until the merger has a date.

`agent`: defaults, with the weekly input budget raised to 2,000,000 as for VVV.

## 4. The `flow_annualized` derived source

In `src/ingest/derived.ts`, beside `burn_momentum`: `flowAnnualized(days: Map<string, number>, windowDays: number): { day, value }[]`, one point per day that has a complete window of `windowDays` consecutive daily rows ending on it, `value = sum * 365 / windowDays`. A missing day breaks the window, as for the momentum index. `DERIVED_NAMES` gains `flow_annualized`. The fetch runs it in the derived step over the stored daily rows of the named flow (onchain or api) plus the run's days, writes a level in usd with `source: api` (the flow's rows are api; the derivation carries the provenance of its input; `burn_momentum` writes `onchain` because its input is), `sourceDetail: derived flow_annualized(<metric>, <days>d)`, superseding a changed value. Params: `metric` (a flow metric), `days` (positive integer, default 30). Config validation as for `burn_momentum`. `sourceIssues`: `derived` is already a level primary.

## 5. The `aero` adapters

`src/ingest/adapters/aero.ts`, registered in the adapter registry beside VVV's. Both need the RPC and read, in one multicall at the run's block: `AERO.totalSupply()`, `ve.supply()`, `Minter.weekly()`, `Minter.tailEmissionRate()`, `Minter.teamRate()`. Contract names come from params with defaults `token`, `ve`, `minter`.

- `aero.emission_rate_annual`: refuses (throws, so the source fails) when `weekly() > TAIL_START` (8,969,150 AERO, a param with that default), because the formula below applies only to the tail regime. Otherwise `base = total * tailRate / 10_000`, `growth = base * ((total - veTotal) / total)^2 / 2` with `veTotal` the voting power at the epoch's start (a second multicall reads `ve.totalSupplyAt(activePeriod - 1)` after the first read `activePeriod`), `team = teamRate * (growth + weekly) / (10_000 - teamRate)` (with `weekly` the read, frozen at `TAIL_START`), `annual = (base + growth + team) * 365 / 7`. Returns a level in tokens per year at the block time, `source: onchain`, detail naming the three reads; stored on the `schedule` metric as the step in force.
- `aero.staker_emission_share`: the same reads; returns `growth / (base + growth + team)`, a ratio (about 0.102 today).

Cross-checks: none exist. The tail rate moves by governance one basis point per epoch; the daily read follows it, and a move of more than `driver_deviation_pct` in the revenue driver is what the trigger watches, not emissions.

## 6. The persona

`personas/onchain-dex-analyst.md`: frontmatter `name: onchain-dex-analyst`, `effort: high`, `temperament: skeptical, patient, specific`, `sectors: [dex, onchain-fee-share]`, default model. Body, in the register of `ai-infra-analyst`:

- The token's claim is contractual and measured: every fee dollar that reaches a locker is on chain, so the question is never whether value reaches holders but how durable the volume behind it is. Fee flow follows trading volume, which follows the chain's activity and the protocol's share of it; both can halve in a quarter.
- Emissions are the cost of that volume. Liquidity that stays only for emissions leaves when they fall; the tail rate is set by governance one basis point at a time, and the rebase means lockers are partly shielded from dilution while unlocked holders are not.
- Locking is the thesis. The locked share, and how much of it is permanent, says whether holders are committed or waiting; a falling locked share is an early signal even when fees hold.
- Announced structural changes (a merger into a unified protocol, a new allocation mechanism) are events to read from primary sources and to treat as risks to the flow, not as facts about it, until the on-chain series moves.
- The working rules of the existing persona, verbatim in spirit: change your mind by the amount the evidence supports; separate what is read from what is inferred; write for a reader who checks; say so when you do not know.

The four shipped skills load unchanged. `orion persona assign aero onchain-dex-analyst`.

## 7. Onboarding sequence

1. The code additions (sections 4 and 5) with their tests, on a feature branch.
2. `assets/aero.yaml` and the persona; `orion asset validate`; `orion persona assign`.
3. A dry fetch from a throwaway home with a fresh database: `orion data fetch aero --dry-run`. Expected: the 90-day backfill of the fee flow (about 90 rows), the two adapters' readings within a few percent of section 2.1, the price cross-check inside 2 percent.
4. The first real tick on this machine (`./run-daily.sh aero`). The fetch writes every metric; the valuation is `blocked` (no assumption set); the cadence starts a bootstrap (no deep or bootstrap attempt); its `manual_metrics` list is empty, so it writes a journal and stops. The inbox stays empty.
5. Calibration as for VVV: a sensitivity sweep over the fetched data, priced packages, the user chooses; import the set; derive bands by the mirror rule and write them into the asset file; commit.
6. The next tick produces the first signal. The Hermes job gets a second scheduled line for `aero`, a few minutes after VVV's.

## 8. Testing

- `flow_annualized`: unit tests beside the momentum index's (complete window, incomplete window, a changed value superseding, the annualization arithmetic); a fetch test on canned routes that writes the level from API flow rows with `source: api`.
- Adapters: tests against the fake RPC with section 2.1's numbers (total 1,983,240,735.6, locked 1,051,061,696, `weekly` 8,969,149.54, tail rate 21, team rate 228) pinning the annual rate (about 247M) and the share (about 0.10) to figures checkable on chain; the refusal when `weekly()` is above the threshold; the multicall count.
- The asset file, as VVV's tests do: parses; `sourceIssues` empty; every required assumption key has bounds; the hash pinned; a full fetch on canned routes writes every metric; with a synthetic set the valuation is `ok`.
- One live dry run against Base and DefiLlama from a throwaway home (step 3 of section 7) is the user's checkpoint. No network in tests.
- `tests/fixtures/aero.yaml` stays a synthetic engine fixture; it is not replaced by the live file.

## 9. Build order

1. `flow_annualized` (source, validation, fetch step, tests).
2. `aero` adapters (registry, tests).
3. Asset file, persona, asset tests, README lines (commands for `aero`, the second Hermes line).
4. The user's checkpoints: dry fetch, first tick, calibration, bands, first signal.

## 10. Known limitations and risks

- **The merger.** If "Aero" ships a new token contract, every chain source in the asset file fails at once, the failure-streak anomaly fires, and the signal goes `blocked`: the right behaviour. The primary sources say the AERO contract stays; there is no date to put on the calendar.
- **Predictive allocation.** Fees still reach lockers; the flow is measured, not modelled, so a change shows in the series, not in a broken assumption.
- **The tail rate is governed** one basis point per epoch. A regime change back above the threshold makes the adapter refuse rather than misreport; the asset file then needs a new adapter branch.
- **Incentives to lockers** (bribes) are a second income stream with no usable series; the holder flow is fees only and understates lockers' income. Revisit if a source appears.
- **CoinGecko's circulating supply** is its own definition (about 0.99B against 0.93B unlocked on chain); it is informational under `effective_total`.
- **The revenue run rate is a 90-day trailing figure**, so the deviation trigger compares a trailing average against the assumption-implied path; a sharp volume move shows up with a lag of a quarter. One 7.9M USD day (2026-09-09, real or a DefiLlama catch-up, to be settled at calibration) sits in the window until 2026-12-08.

## 11. Amendments made during planning (2026-09-23)

1. **The annual emission rate uses the engine's 365-day year (5).** The adapter multiplies the gross weekly mint by `DAYS_PER_YEAR / 7` (52.14), not 365.25/7, because the annual rate is what the engine spreads over its own year. About 246.8M AERO a year against 246.9M.
2. **`Minter.sol` confirmed (2.1):** the tail emission multiplies `aero.totalSupply()`, the regime test is `weekly < TAIL_START`, and `weekly` is not updated in the tail. The adapters follow the contract.
3. **The shared chain helpers** used by the VVV and AERO adapters live in `src/ingest/adapters/chain.ts` (5).
4. **Live dry run during planning (7, step 3):** every source ok on 2026-09-23T21:38Z; price 0.669045 against 0.6686 on DefiLlama; 90 fee days, the newest 244,825 USD; the run rate 172.9M USD a year; the rebase share 0.0972. The user's checkpoint repeats it on the live home.
5. **The rebase uses voting power at the epoch's start (2.1, 5).** Found by the Task 2 review and verified from `Minter.sol`: `calculateGrowth` reads `ve.totalSupplyAt(activePeriod - 1)`, not `ve.supply()`. The adapters read `activePeriod` in their first multicall and the voting power in a second; `ve.supply()` remains the locked-supply metric. On the 2026-09-23 reads the share is 0.1017 and the annual rate 248.0M, against 0.0972 and 246.8M under the planning pass's reading. The rate is bounded to the Minter's 1 to 100 basis points and the team rate to below 10,000, refused by name otherwise.
6. **The team term uses the frozen `weekly` (2.1, 5).** Found by the final review against the mint recorded in the user's research note and verified by the controller from the transaction receipt: the contract applies the team rate to `growth + weekly`, the state variable frozen at `TAIL_START`, not to the tail emission. The adapters now reproduce the 2026-09-17 mint to the coin; a test pins it. The gross annual rate is about 253.9M and the rebase share about 0.099.
7. **The run rate derives over 90 days (3).** With a 30-day run rate against the 90-day holder-flow window the measured capture was 0.53 by construction for one and the same series, and a single 7.9M USD day doubled the run rate. The window now matches `window_days`; the deviation lag is a quarter.
