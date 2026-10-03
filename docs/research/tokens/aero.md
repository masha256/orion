# Aerodrome Finance (AERO)

Researched 2026-09-22. Rank #37 by market cap (layer-1 tokens, stablecoins and tokenized RWAs excluded). Market cap $0.68B, FDV $1.35B, price $0.681175 (CoinGecko, 2026-09-22).
Chain(s): Base (ERC-20 `0x940181a94A35A4569E4529A3CDfB74e38FD98631`). CoinGecko id: `aerodrome-finance`. DefiLlama slug: `aerodrome` (children `aerodrome-slipstream`, `aerodrome-v1`, `aero-lite`).

## Verdict

Orion fit: A. 100% of fees from gauge-staked liquidity go, by contract, to veAERO voters (a fee_share to locked). DefiLlama publishes it as holders revenue (1y $94.5M), and it can be read on Base. The catch is dilution: gross emissions of about 249M AERO/yr (about $170M) exceed the fee share, so an emissions schedule is essential.

## Business and revenue

- Fees: traders pay swap fees on vAMM/sAMM (v1) and Slipstream concentrated-liquidity pools. Fees on liquidity staked in gauges, plus a rake (default 10%) on unstaked Slipstream LP fees, route to each pool's FeesVotingReward and are paid to the veAERO NFTs that voted for that pool in the epoch. Unstaked LPs keep the rest. The protocol treasury takes nothing ("zero-leak", DefiLlama methodology).
- DefiLlama `aerodrome` (2026-09-22): fees 30d $17.5M, 1y $131.8M. Revenue = holders revenue: 30d $14.2M, 1y $94.5M, all-time $481M.
- Trend: Slipstream holders revenue was $27.8M in 2025-09, fell to $3.8-6.6M/month in Jan-Aug 2026, then $11.9M in Sep 2026 to date. The 30d annualized rate ($173M) is inflated by the September spike, so use 1y or 90d.
- Voting incentives (bribes) paid by protocols to veAERO voters are extra income for lockers. They are not revenue-funded, and DefiLlama excludes them.
- Company layer: Dromos Labs (the team) receives a team emission share (below), not fees. Dromos announced a merger of Aerodrome and Velodrome into a unified "Aero" in late 2025. Its status on 2026-09-22 is unconfirmed. DefiLlama lists a small `aero-lite` (30d fees $4.7K).

## Holder flows

- id `veaero_fee_share`, kind fee_share, capture_rule programmatic, recipient_base locked
  - Trailing: $94.5M over 1y, $14.2M over 30d (DefiLlama holders revenue, 2026-09-22).
  - Observability: on Base, each pool's gauge fees are claimed to its FeesVotingReward contract on `Voter.distribute`. The DefiLlama methodology measures `CLPool.gaugeFees()` deltas plus CollectFees events. Locked AERO: `AERO.balanceOf(VotingEscrow 0xeBf418Fe2512e7E6bd9b87a8F0f294aCDC67e6B4)` = 990,609,860 (49.9% of supply). VotingEscrow `supply()` = 1,050,271,857 and voting power `totalSupply()` = 1,026,937,475 (2026-09-22). Many locks are permanent (max lock).
  - Rule and control: routing is hard-coded in the Voter/Gauge/Reward contracts. The unstaked-fee rake and pool fee rates are parameters controlled by the team or factory owner, so capture_rule is programmatic. This has not changed since launch (2023-08). Fee yield on locked value: $94.5M / (990.6M x $0.681 = $675M) = 14%.
- Rebase (anti-dilution emissions to veAERO) and team emissions are inflation, not holder flows.

Capture rate today: holders revenue / revenue = 100%. Against total swap fees it is $94.5M / $131.8M = 72% (1y); the rest goes to unstaked LPs.

## Supply

- AERO totalSupply 1,983,240,736 (Base RPC, 2026-09-22). There is no cap (max null on CoinGecko). Circulating 992,631,384 per CoinGecko, roughly total minus locked.
- Emissions (Minter `0xeB018363F0a9Af8f91F06FEe6613a751b2A33FE5`, epoch 160, updatePeriod tx `0xd75b5517...288f`, 2026-09-17): 4,790,434 AERO minted for the week. That is 4,154,746 to Voter (LP gauge emissions), 481,314 to RewardsDistributor (rebase to veAERO) and 220,498 to team. Annualized, about 249M AERO (12.6% of supply), about $170M at $0.681: $147M to LPs, $17M rebase, $8M team.
- Schedule: in the "Aero Fed" tail phase, weekly emissions = `tailEmissionRate` (21 bps/week today) x circulating supply, and veAERO voters nudge the rate by ±1bp each epoch (`weekly()` = 8.97M, the tail start threshold). Emissions scale with supply, so the stock grows roughly 11-13% a year unless voters cut the rate.
- Dilution vs fee share: $170M/yr of new AERO against $94.5M/yr of fees to lockers. Lockers roughly keep pace through the rebase plus fees. Unlocked holders are diluted about 12%/yr with no fee income.
- supply_basis recommendation: `effective_total` (1.98B). Locked AERO is still claim-bearing, and emissions are a percentage of supply.
- Unlocks: no vesting cliffs. The team share is streamed via emissions: 220,498 AERO in the 2026-09-17 mint, about 4.6% of it. Minter `teamRate()` returns 228 (units unconfirmed).

## Data availability for Orion

| metric | source type | endpoint / contract / slug | notes |
|---|---|---|---|
| revenue_run_rate_usd | defillama | `aerodrome`, dailyRevenue | equals holders revenue |
| holder flow (fee_share) | defillama | `aerodrome`, dailyHoldersRevenue | |
| locked ratio | contract_read | AERO.balanceOf(VotingEscrow) / totalSupply on Base | 49.9% |
| emissions | contract_read | Minter.tailEmissionRate(), Mint event per epoch | EVM Base |
| supply | erc20_supply | AERO totalSupply (Base) | |
| price | coingecko | `aerodrome-finance` | |

An EVM RPC (Base) can read the flow (FeesVotingReward claims), the lock and emissions.

## Orion mapping

- Modules: holder_cashflow 0.6 (fee_share per effective token, with emissions as dilution), forward_multiple on holder_flow 0.25, forward_multiple on revenue 0.15.
- holder_flows: `[{id: veaero_fee_share, kind: fee_share, capture_rule: programmatic, recipient_base: locked, source: defillama aerodrome dailyHoldersRevenue}]`. Locked ratio is about 0.50. Staker (locker) share of emissions is the rebase, about 10% of the weekly mint.
- Emissions: about 249M AERO/yr gross, growing with supply at 21 bps/week. Model a flat rate with a voter-cut scenario.
- Assumptions: Base DEX volume share, fee growth, whether the merger with Velodrome changes the supply or fee base, and the terminal capture (1.0 of gauge fees).
- Obstacles: the 30d DefiLlama figure is volatile (September spike), and the merger status is unconfirmed.

## Sources

- https://api.llama.fi/summary/fees/aerodrome?dataType=dailyRevenue / dailyHoldersRevenue / dailyFees (accessed 2026-09-22)
- https://api.llama.fi/summary/fees/aerodrome-slipstream and aerodrome-v1?dataType=dailyHoldersRevenue: methodology (gaugeFees, rake, zero-leak) and monthly series (accessed 2026-09-22)
- Base RPC (mainnet.base.org) via cast: AERO totalSupply, VotingEscrow balance/supply/totalSupply, Minter weekly()/tailEmissionRate()/activePeriod()/epochCount()/teamRate(), Mint log and transfers in tx 0xd75b5517829aba5956f76ddedb86ea62095bbc8efefc96b56a626d76de66288f (accessed 2026-09-22)
- https://api.coingecko.com/api/v3/coins/markets?ids=aerodrome-finance: circulating, total (accessed 2026-09-22)
