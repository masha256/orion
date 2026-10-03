# Virtuals Protocol (VIRTUAL)

Researched 2026-09-22. Rank #44 by market cap (layer-1 tokens, stablecoins and tokenized RWAs excluded). Market cap $0.49B, FDV $0.75B, price $0.74781 (CoinGecko, 2026-09-22).
Chain(s): Base (`0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b`), Ethereum (`0x44ff8620b8cA30902395A7bD3F2407e1A091BF73`), Solana, Robinhood Chain, Arc. CoinGecko id: `virtual-protocol`. DefiLlama slug: `virtuals-protocol`.

## Verdict

Orion fit: C. Virtuals earns real platform revenue: $16.7M over 1y and $0.65M over 30d on DefiLlama, mostly the protocol's 30% of the 1% agent-token trading tax plus launch fees. It goes to the Virtuals treasury and team wallets. No VIRTUAL buyback or burn exists, and DefiLlama holders revenue is 0. veVIRTUAL lockers get airdrops of new agent tokens, which are not revenue-funded. The flows sit on EVM chains (Base), so they could be measured if a capture policy appeared.

## Business and revenue

- Agent-token launchpad and "agent economy":
  - A 1% buy/sell tax applies from launch on bonding-curve and post-graduation trades: 70% to the agent creator, 30% to the Virtuals treasury (whitepaper, Launch Mechanics).
  - Module activation fees of 10-100 VIRTUAL.
  - Anti-sniper taxes of up to 99% buy back the agent token for the team, not VIRTUAL.
- Tax flow on Base: Tax Swapper `0x8e0253dA409Faf5918FE2A15979fd878F4495D0E`, then Tax Manager `0x7e26173192d72fd6d75a759f888d61c2cdbb64b1`, which distributes in VIRTUAL or USDC to the creator and platform. The platform fee is now collected in USDC on Base, USDG on Robinhood Chain and JupUSD on Solana (DefiLlama methodology).
- DefiLlama `virtuals-protocol` (2026-09-22): fees = revenue: 30d $0.65M, 1y $16.7M, all-time $74.1M.
- Trend: monthly revenue peaked at $5.3M (2025-10), fell to $0.26-0.57M (2026-03 to 2026-06), spiked to $2.24M (2026-07), then $0.67M (2026-08) and $0.38M (2026-09, 22 days). Highly cyclical with agent-token speculation. The 1y figure is about 2x the run rate.
- Company layer: Virtuals is run by a core team. The treasury holds 35% of supply plus protocol fees. No equity token.

## Holder flows

- None revenue-funded.
  - DefiLlama holders revenue: 0 over 1y and all-time.
  - I found no VIRTUAL buyback-and-burn program in the docs (whitepaper tokenomics pages, 2026-08).
  - VIRTUAL locked in agent LPs (10-year LP locks) is a token sink, not a revenue flow.
- veVIRTUAL (lock up to 2 years): eligibility for airdrops of up to 5% of each new agent token's supply (Airdrop Distribution module). This is a distribution in kind from new launches, not from revenue, so it is not an Orion holder flow. Governance power is "coming soon".

Capture rate today: 0 / $16.7M (1y) = 0%.

## Supply

- Total and max 1,000,000,000 VIRTUAL, fully minted and "fully unlocked and vested", with no inflation. Allocation: 60% public, 5% liquidity pool, 35% ecosystem treasury (DAO multisig, emissions capped at 10% a year for three years; deployment needs governance approval).
- Circulating 658,385,842 (CoinGecko, 2026-09-22). The roughly 342M gap is mostly treasury.
- supply_basis recommendation: `circulating`, with treasury release up to 100M a year as the unlock stream. Alternatively effective_total of 1B.
- Staking yield: none paid in VIRTUAL. veVIRTUAL receives agent-token airdrops only.
- Unlocks: treasury emissions at most 10% a year (at most 100M VIRTUAL).

## Data availability for Orion

| metric | source type | endpoint / contract / slug | notes |
|---|---|---|---|
| revenue_run_rate_usd | defillama | `virtuals-protocol` dailyRevenue | multi-chain; methodology evolves often |
| platform tax inflow | transfer_flow | Tax Manager `0x7e26...64b1` outflows to the platform wallet on Base (USDC / VIRTUAL) | EVM-readable cross-check |
| holder flow | none | none | |
| supply | coingecko / erc20_supply | `virtual-protocol`; Base token | |

An EVM RPC (Base) can read the tax flows. There is no holder flow to read.

## Orion mapping

- Modules: forward_multiple on revenue 1.0, labeled "platform revenue kept by treasury, market convention". holder_cashflow only under an assumed future buyback.
- holder_flows: none.
- Assumptions: revenue is extremely cyclical (monthly swings of 10x). Use a multi-month average, about $6-8M a year, rather than the 1y $16.7M.
- Obstacles: no capture, a volatile base, and the DefiLlama methodology keeps changing (new chains and fee currencies added in 2026-08 and 2026-09).

## Sources

- https://whitepaper.virtuals.io/about-virtuals/capital-formation-layer/virtuals-launch-mechanics.md: 1% tax split 70/30, module fees, anti-sniper buybacks of agent tokens (accessed 2026-09-22)
- https://whitepaper.virtuals.io/info-hub/virtuals-builder-and-agent-token-launch-faq.md: Tax Swapper and Tax Manager addresses on Base, distribution in USDC (as of 2026-08-14) (accessed 2026-09-22)
- https://whitepaper.virtuals.io/info-hub/usdvirtual-token-base-asset-for-ai-agents/usdvirtual-token-distribution-and-tokenomics.md: supply, allocation, treasury emission cap (accessed 2026-09-22)
- https://whitepaper.virtuals.io/info-hub/usdvirtual-token-base-asset-for-ai-agents/usdvirtual-staking-and-vevirtual.md: veVIRTUAL benefits (airdrops, governance) (accessed 2026-09-22)
- https://api.llama.fi/summary/fees/virtuals-protocol?dataType=dailyRevenue (and dailyHoldersRevenue): revenue, 0 holders revenue, methodology, monthly series (accessed 2026-09-22)
- https://api.coingecko.com/api/v3/coins/virtual-protocol: supply and market data (accessed 2026-09-22)
