# Jupiter (JUP)

Researched 2026-09-22. Rank #31 by market cap (layer-1 tokens, stablecoins and tokenized RWAs excluded). Market cap $1.00B, FDV $2.07B, price $0.301 (CoinGecko, 2026-09-22).
Chain(s): Solana (mint `JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN`). CoinGecko id: `jupiter-exchange-solana`. DefiLlama slug: `jupiter` (parent; children include `jupiter-perpetual-exchange`, `jupiter-aggregator`, `jupiter-lend`, `jupiter-staked-sol`).

## Verdict

Orion fit: B. 50% of Jupiter's on-chain protocol revenue buys JUP into the Litterbox Trust. The flow is real and visible on Solana. But the tokens are held, not burned (apart from a one-off DAO burn in Nov 2025), the policy is set by the team, and DefiLlama's holders series is modeled as 50% of revenue rather than observed.

## Business and revenue

- Revenue sources:
  - Perps: 25% of fees to protocol, 75% to JLP.
  - Ultra/aggregator platform fees.
  - Jupiter Lend, JupSOL, DCA/limit, Studio, Prediction and others.
- DefiLlama `jupiter` parent (2026-09-22):
  - Revenue: 30d $6.86M (about $83M annualized); 1y $88.2M.
  - Fees: 1y $292.5M.
  - Monthly revenue: $16-20M (Aug-Oct 2025), $4.2-6.2M (Mar-Sep 2026). Down about 70% year on year.
- Company layer: Jupiter (the team) keeps the other 50% of revenue for its treasury and operations. The DAO governs only some matters.

## Holder flows

- `jup_litterbox_buyback`: kind buy_and_hold; capture_rule discretionary (team policy since 2025-02-17, run via the Litterbox Trust; the DAO votes on disposal); recipient_base all.
  - Trailing annualized: $41.7M from 30d ($3.43M); 1y $44.1M.
  - Source: DefiLlama `jupiter` dailyHoldersRevenue. Methodology: "JUP token buybacks from 50% of platform revenue, started 2025-02-17". It is computed as 50% of revenue, not measured from the wallet.
  - On-chain: Litterbox owner `6tZT9AUcQn4iHMH79YZEXSy55kDLQ4VbA3PMtfLVNsFX`; token account `DpVH8xQZ4aapxwZ6KW9nuEUs9zEePa8HQvXny9Ajj93T` holds 171.73M JUP (Solana RPC getTokenAccountsByOwner, 2026-09-22).
  - History:
    - Feb 2025: started.
    - Oct 2025: DAO vote "Burn the Litterbox". 134.55M JUP burned on 2025-11-25, per DefiLlama emissions notes.
    - Accumulation has continued since. The 2026 policy is still "50% of protocol fees are allocated to the Litterbox Trust for JUP buybacks" (forum topic 40136, 2026-05-30).
    - Community proposals to raise it to 70% and/or burn (topics 40136, 40152, 40178, 40223; May-Sep 2026) had not become DAO votes as of 2026-09-22.
- `jup_mercurial_team_offset` (buy_and_hold, discretionary): under the Net-Zero proposal (passed Feb 2026), Jupiter's balance sheet buys the JUP that Mercurial stakeholders sell and buys team allocations from team members wishing to sell. Amounts are not published. The funding source (company balance sheet) is not clearly revenue.
- ASR (Active Staking Rewards): 50M JUP a quarter to stakers, from LFG launchpad fees and unclaimed Jupuary tokens (existing supply, not new mint). It is a transfer from reserves; treat it as dilution, not value.

Capture rate today: 50% of revenue by policy. DefiLlama: $3.43M / $6.86M (30d).

## Supply

- Original 10B; 3B burned 2025-01-26; 134.55M burned (Litterbox) plus 2.21M (VRFD fees).
- Total 6.861B (Solana RPC getTokenSupply 6,861,486,645; CoinGecko 6.861B). Circulating 3.32B (CoinGecko).
- Effective circulating net of the Litterbox: about 3.15B.
- supply_basis: `circulating`, minus Litterbox holdings. The large custody tranches listed below are not scheduled.
- Emissions/unlocks: under Net-Zero (Feb 2026), Jupuary 2026 (700M) is postponed to the Community Cold Multisig, team emissions are paused indefinitely (about 427.8M remaining), and Mercurial vesting is accelerated with sales offset by buybacks.
  - DefiLlama shows 0 scheduled unlocks over the next 12-24 months.
  - Held as TBD in custody: Jupuary 1.4B, Community Reserve 300M, Strategic Reserve 1,332.7M.
  - Plus ASR of 50M a quarter (200M a year, about 6% of circulating) from reserves.
- Staking yield: ASR APY is driven by reserve distributions, not fees. Staked ratio unknown.

## Data availability for Orion

| metric | source type | endpoint / contract / slug | notes |
|---|---|---|---|
| revenue | defillama | `jupiter` dailyRevenue | |
| holder flow | defillama | `jupiter` dailyHoldersRevenue | modeled as 50% of revenue |
| Litterbox balance (observed flow) | adapter | Solana JSON-RPC `getTokenAccountBalance` on `DpVH8xQZ4aapxwZ6KW9nuEUs9zEePa8HQvXny9Ajj93T` | public RPC works (POST); needs a Solana adapter |
| supply | coingecko / adapter | `jupiter-exchange-solana`; Solana `getTokenSupply` | |
| unlocks | http_json | `https://defillama-datasets.llama.fi/emissions/jupiter` | |

No EVM RPC applies.

## Orion mapping

- Modules: holder_cashflow 40% (`jup_litterbox_buyback`, buy_and_hold, discretionary, all); forward_multiple on holder_flow 30%; forward_multiple on revenue 30%, labeled market convention.
- Assumptions:
  - Revenue growth (bear: continued decline).
  - Terminal capture of 50%, with upside if the 70%/burn proposals pass.
  - A haircut for held tokens that the DAO or team could redeploy.
  - Treat ASR (200M a year) as dilution.
- Obstacles: the flow is not observed on DefiLlama; a Solana adapter is needed to read the Litterbox delta; the custody tranches (about 3B JUP) are an overhang with no schedule.

## Sources

- https://api.llama.fi/summary/fees/jupiter and child slugs (dailyRevenue, dailyHoldersRevenue, methodology) (2026-09-22)
- https://raw.githubusercontent.com/DefiLlama/dimension-adapters/master/fees/jupiter.ts: Litterbox address, 50% ratio from 2025-02-17 (2026-09-22)
- https://discuss.jup.ag/t/39948.json (Net-Zero proposal), /t/39974.json (FAQ), /t/39627.json (Burn the Litterbox), /t/40136.json, /t/40178.json (2026 buyback proposals) (2026-09-22)
- https://defillama-datasets.llama.fi/emissions/jupiter: burns, Net-Zero notes, TBD tranches, ASR (2026-09-22)
- https://api.mainnet-beta.solana.com getTokenSupply and getTokenAccountsByOwner (Litterbox) (2026-09-22)
- https://api.coingecko.com/api/v3/coins/markets?ids=jupiter-exchange-solana (2026-09-22)
