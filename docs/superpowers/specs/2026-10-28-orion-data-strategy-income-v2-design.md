# Orion Phase 2: data-collection strategy and income statement v2

Status: draft for review (2026-10-28, kanban t_1697d7dc). Umbrella: `2026-10-28-orion-coinrevs-core-roadmap.md`
(branch `feat/coinrevs-core` @ e666b87): standing rules 1-5, decisions 1 and 5-7, Phase 2 section. Nothing here is
built. Decisions Mike owes are collected in §11. Amended 2026-10-28 (Mike): §7 adds per-token figures for the site's
live-price layer.

Figures below are from `report yield <a> --json` (report day 2026-10-27, LIT 2026-10-26) run with the main dist
(34a9f9d) against a `.backup` copy of the live DB in a scratch home. They are 91-day windows annualized, in $M.

## 1. Goal and scope

Phase 2 defines how Orion collects every number and what it reports:

1. **A source ladder** that every metric must sit on, and the **deferral rule** for protocols that can't be sourced
   (§2).
2. **Provenance on every observation**: source type, chain, contract or endpoint, block range or tx refs, and a
   method label (measured / derived / disclosed) (§3).
3. **Token amounts and prices stored separately**, so the price source can be swapped and a lapsed CoinGecko licence
   deletes only the prices (§4).
4. **Internal reconciliation checks** that replace third-party cross-checks (§5).
5. **Income statement v2**: the config schema and the report output for rules 3-4 and decisions 5-7 (§6-7).
6. **The mapping of all 13 live assets** onto v2: revenue, cost of revenue, method, what's missing and which phase
   fills it (§8).
7. **Mechanism templates** so 80-100 protocols can be onboarded from config, with few bespoke adapters (§9).
8. **The HYPE bucket question** (§10).

Out of scope (other phases): removing valuation (Phase 1); Postgres and environments (Phase 1.5); replacing each
DefiLlama series and deleting its rows (Phase 3); the site export (Phase 5); the comparison tool (Phase 4).

**Ordering assumption.** Roadmap decision 4 puts Phase 2 after 1.5, so §3-4 are written as Postgres DDL. If 1.5 slips,
§6-7 (config and report) can be built on SQLite first; §3-4 wait for Postgres so that history is migrated once.

## 2. Source ladder

Every metric names one primary source. Allowed sources, best first (roadmap rules 1-2):

| Rung | `source_type` | What it is | Examples today |
|---|---|---|---|
| 1 | `contract_state` | A contract read at a block: counters, accrued fees, balances, supply, parameters | CRV `ve.supply`, UNI `labs_vest_rate`, SKY `splitter.burn`, PUMP supply via `getTokenSupply` |
| 2 | `log_scan` | Logs of one address (a singleton, fee collector, burn sink), one `eth_getLogs` per day | every `transfer_flow` (CRV fees, CAKE burner, LINK Reserve, UNI 0xdead) |
| 2 | `first_party_api` | The protocol's own API, operated by the protocol | Hyperliquid `info` (HYPE), Lighter `exchangeMetrics` (LIT) |
| 3 | `pool_scan` | Daily logs over a curated pool/contract list, with coverage stated | none yet (UNI v3, AERO gauges, CAKE v3 are candidates) |
| — | `disclosure` | A human-approved figure with a public citation and quote | VVV revenue run rate |
| — | `derived` | A formula over other observations (annualized rate, gross = share-of / share, remainder) | `revenue_run_rate_usd`, UNI v2 gross x6 (decision 7) |
| — | `constant` | A structural value set in config, with a citation note | CRV `staker_emission_share` = 0 |
| — | `market_data` | Licensed market data: CoinGecko price and circulating supply only (rule 5, Basic plan) | `price_usd`, `circulating_supply` |

Rules:

- **No other source types.** DefiLlama (`defillama`, `defillama_share`, `coins.llama.fi` via `http_json`) is removed in
  Phase 3; until then it is labelled `third_party` in provenance so the report can flag every number that still
  depends on it. A third-party community API (e.g. Llama Airforce's `llama.box`, used for CRV vote incentives) is also
  `third_party`, and needs a decision (§11 D4).
- **Deferral.** A protocol is listed only when its revenue and holder-flow lines and its supply sit on a rung above.
  Cost-of-revenue lines may launch as `not_measured` (shown, never zero-filled), per §11 D6.
- **Licence check per first-party API.** Before the site relies on one (Hyperliquid, Lighter, Solana RPC providers,
  the Ethereum/Base/BNB RPC providers), record its terms in `docs/ops/sources-register.md` (new file: endpoint,
  operator, terms URL, commercial use yes/no/unknown, date checked). Unknown terms block the site export for that
  asset, not ingest.
- **Method label** (on every observation, §3): `measured` (rungs 1-3, read directly), `derived` (a formula over
  measured inputs, including a contractual share applied to a measured flow), `disclosed` (a citation). A `constant`
  is `disclosed` and needs its citation; `market_data` is `measured`.
- **No indexer.** A metric that would need every pool of a factory or every user account goes to a curated
  `pool_scan` with coverage, or uses contract state (accrued counters), or is deferred.
- **Daily totals only** (unchanged). Per-transfer rows are never stored; tx refs are capped (§3).

## 3. Provenance on every observation

Today `observations.source` is one of `onchain | api | manual` and `source_detail` is a free-text or JSON string
(e.g. `{"day":"2026-10-27","blocks":[26280314,26287495],"senders":{}}`, or
`https://api.llama.fi/summary/fees/hyperliquid?dataType=dailyHoldersRevenue`). That is enough to debug but not to
publish. v2 makes provenance structured and mandatory (Postgres, Phase 1.5 schema plus this migration):

```sql
ALTER TABLE observations
  ADD COLUMN method        text NOT NULL CHECK (method IN ('measured','derived','disclosed')),
  ADD COLUMN source_type   text NOT NULL CHECK (source_type IN ('contract_state','log_scan','first_party_api',
                             'pool_scan','disclosure','derived','constant','market_data','third_party')),
  ADD COLUMN chain         text,          -- CAIP-2: 'eip155:1', 'eip155:8453', 'eip155:56', 'solana:mainnet', 'hyperliquid:core'; null off-chain
  ADD COLUMN locator       jsonb NOT NULL,-- see below
  ADD COLUMN block_from    bigint,        -- first block (EVM) or slot (Solana) read; for contract_state, the block read
  ADD COLUMN block_to      bigint,
  ADD COLUMN tx_count      integer,       -- logs/transfers counted into the value
  ADD COLUMN tx_refs       jsonb,         -- up to 50 "txhash:logIndex" (EVM) / signatures (Solana); null when more
  ADD COLUMN tx_digest     text,          -- sha256 of the sorted full ref list (always, when tx_count > 0)
  ADD COLUMN response_digest text,        -- first_party_api: sha256 of the normalized response slice used
  ADD COLUMN inputs        jsonb,         -- derived: [{"observation_id": n}] or {"metric": k, "from": d, "to": d}
  ADD COLUMN formula       text,          -- derived: 'flow_annualized@1', 'gross_from_share@1', 'remainder@1'
  ADD COLUMN coverage      jsonb,         -- pool_scan: {"listed": n, "coverage_pct": x, "basis": "...", "as_of": d}
  ADD COLUMN code_version  text NOT NULL, -- orion git sha that wrote the row
  ADD COLUMN config_hash   text NOT NULL; -- the asset config hash in force
-- existing: citation_url, quoted_text (now NOT NULL when method = 'disclosed'), fetched_at, status, superseded_by.
-- `source` (onchain|api|manual) is kept one release for readers, then dropped.
-- In the migration the NOT NULL columns are added nullable, backfilled (below), then set NOT NULL.
```

`locator` shapes (validated in code, one per source type):

- `contract_state`: `{"contracts": ["0x…"], "call": "supply()", "args": []}`
- `log_scan` / `pool_scan`: `{"contracts": ["0x…"], "event": "Transfer(address,address,uint256)", "topics": {...},
  "senders": {"fee_allocator": "0x…"}}` (pool_scan lists its pool set by a versioned list id, not inline)
- `first_party_api`: `{"endpoint": "https://api.hyperliquid.xyz/info", "request": {"type": "userFillsByTime", ...}}`.
  Host, path and request body only: **never a key or a keyed URL** (the writer strips query keys named `key`,
  `apikey`, `token` and path segments matching the RPC-key shape; a test pins it).
- `disclosure`: `{"citation_url": "...", "approved_by": "mike", "approved_at": "..."}`
- `derived`: `{"metrics": ["flow.v2_protocol_fees"], "params": {"share": 0.1666667}}`
- `constant`: `{"config_path": "metrics.staker_emission_share.source", "note": "..."}`
- `market_data`: `{"provider": "coingecko", "endpoint": "/coins/markets", "id": "uniswap", "field": "circulating_supply"}`

Sizing: 27,447 observation rows today, `source_detail` 2.5 MB total, DB 28 MB. Tx refs capped at 50 per row plus a
digest keeps provenance under ~5 KB/row worst case; at 100 protocols x ~10 flows x 365 days that is under 2 GB/year
worst case and ~200 MB typical. Lists of senders (as `source_detail.senders` today) move into `locator`.

**Provenance is per observation, not per metric**, so a source swap (e.g. HYPE DefiLlama → Hyperliquid API in Phase 3)
is visible day by day, and the report can say "91 of 91 days measured on chain".

Migration of history: every existing row is backfilled mechanically from its metric's config at write time
(`source` + `source_detail` + the config version in `config_versions`) with `method`/`source_type`/`locator`;
`block_from/to` from `source_detail.blocks` where present; `code_version = 'pre-v2'`. Rows that can't be mapped are
listed in the plan's proof and fixed by hand, never guessed.

## 4. Token amounts and prices stored separately (rule 5)

**Today.** A `transfer_flow` with `unit: usd` prices each transfer at its timestamp from CoinGecko `market_chart`
(hourly points for ranges up to 90 days, daily beyond) and stores only the USD sum. Some assets also store a
`flow_tokens.*` twin; most don't (CRV family, AERO, HYPE, SKY's USDS). So a price-source swap or a lapsed CoinGecko
licence would leave USD figures we can't recompute or must delete.

**v2.**

```sql
CREATE TABLE tokens (                 -- one row per priced token
  token_ref  text PRIMARY KEY,        -- 'eip155:1/0xf939…' | 'solana:mainnet/pump…' | 'hyperliquid:core/HYPE' | 'usd'
  symbol     text NOT NULL,
  decimals   integer,
  peg        text CHECK (peg IN ('usd')),   -- stablecoins: priced from market data like any token; peg only labels it
  coingecko_id text
);
CREATE TABLE prices (                 -- deletable as a unit if a licence lapses
  token_ref  text REFERENCES tokens,
  ts         timestamptz,             -- top of the hour, UTC
  price_usd  numeric NOT NULL,
  source     text NOT NULL,           -- 'coingecko' | 'chainlink:<feed>' | 'pool:<addr>'
  fetched_at timestamptz NOT NULL,
  PRIMARY KEY (token_ref, ts, source)
);
ALTER TABLE observations
  ADD COLUMN token_ref      text REFERENCES tokens,  -- flows and token levels: what the amount is in
  ADD COLUMN amount         numeric,                 -- in token units (flows: the day's total)
  ADD COLUMN hourly_amounts jsonb;                   -- flows: 24 numbers, token units per UTC hour; sum = amount
```

- **Every flow stores tokens**, with the day's 24 hourly sub-totals. `value` in USD is no longer written for flows; the
  report reads a view `flow_usd_v` = Σ hourly amount × that hour's price (source by a per-token priority list).
  This reproduces today's per-transfer method at the price feed's own resolution (CoinGecko is hourly), so the
  switch moves numbers only by sub-hour timing.
- **First-party APIs that report USD** (Lighter fees, Hyperliquid fills priced in USDC) store `token_ref` = the quote
  asset (`usd` when the API gives dollars), so they need no price.
- **Levels in tokens** (supplies, balances) store `amount` + `token_ref`; `price_usd` itself becomes rows in `prices`.
- **Measured cost of the shortcut** (if Mike prefers daily prices, §11 D3): on 91-day windows, tokens × the CoinGecko
  daily mean price vs today's per-transfer USD: UNI +0.11%, CAKE −0.60%, LINK −0.33%, SKY +0.04%, VVV −1.51%,
  PUMP +0.97% (per-day error median 0.04-2.1%, p90 up to 6%; LIT not measured, CoinGecko rate limit). Lumpy flows
  (VVV's monthly Safe burns) err most.
- **Backfill.** Chain flows are re-scanned to tokens + hourly buckets over the history already stored (one
  `eth_getLogs` per day: ~380 calls per CRV-family metric, ~2 min per 100 days on mainnet), and compared with the
  stored USD rows; the plan's proof lists the gap per metric. Old USD rows are kept as `legacy_usd` until the
  comparison is signed off, then dropped. DefiLlama USD rows are not converted: Phase 3 deletes them (decision 1).

## 5. Internal reconciliation checks (replace third-party cross-checks)

A check compares two numbers that come from **different source types or different contracts**; the schema refuses a
check whose two sides read the same series (the circular-check rule: a stats page that applies the protocol's split
in its own frontend always agrees). Results are stored daily (`check_results(asset, check_id, day, lhs, rhs, gap_pct,
status)`), shown in the report, and a breach past tolerance opens an anomaly (no agent; Phase 1).

| Type | Compares | Catches | Example |
|---|---|---|---|
| `sum` | a measured total vs the sum of its measured parts (existing `income.checks`) | a missed recipient, a new split | CRV fee_allocator inflow = veCRV fees + treasury (0.00% gap); sdCRV CRV fees (0.00%); yCRV splitter (0.01%) |
| `balance` | Δ balance of an account over the day vs measured in − out | missed senders, unlisted contracts, logs dropped by the RPC | LINK Reserve balance vs `flow.reserve`; LIT reserve vs buys − burns |
| `supply` | Δ total supply vs measured burns − mints | burns outside the scanned sinks | PUMP supply drop vs burn instructions; UNI 0xdead balance vs burns |
| `two_path` | the same quantity via two methods | API error or revision, contract change | LIT buybacks (Lighter fills) vs treasury LIT balance; HYPE AF buys (fills) vs AF balance (Phase 3) |
| `parameter` | a share read from the protocol daily vs the share a line assumes | a fee-split change under a derived or share line | UNI v2 `feeTo` share (x6), LIT RH share (`rh_revenue_share_app`), SKY splitter burn share |
| `coverage` | a pool_scan's listed pools vs the protocol total it can be checked against | a new pool outside the list | UNI v3 listed pools' protocol fees vs total `collectProtocol` flows |
| `price` | CoinGecko vs an on-chain oracle or a deep pool | a bad price print | Chainlink `latestAnswer` (UNI, LINK, CAKE already); otherwise a pool `slot0` |
| `revision` | stored days vs a fresh read of the last N days | an API restating history | Lighter fees (done ad hoc for LIT, t_3bfa0ba7); Hyperliquid fills |

Replacement of today's third-party cross-checks (DefiLlama ones are dropped in Phase 3 with their asset):

- `price_usd` `http_json` checks (DefiLlama `coins.llama.fi`) on 10 assets → `price` checks against a Chainlink feed
  where one exists, else a named deep pool; an asset with neither keeps CoinGecko alone plus a `change_pct` watch.
- `total_supply` vs CoinGecko `total_supply`: kept (CoinGecko is licensed market data, rule 5).
- VVV `flow_usd.burn` vs DefiLlama `venice` → `supply` check on the burn sink; LIT `flow_usd.buyback` vs DefiLlama
  `lighter` → `two_path` (fills vs reserve balance) + `balance`.
- VVV disclosed revenue's `cross_check: flow_usd.revenue_proxy` (DefiLlama) → dropped; disclosed revenue gets a
  `watch` on the on-chain `usage_index` instead (a disclosure can't be reconciled, only flagged when usage moves).
- CRV `vote_incentive_run_rate_usd` (`llama.box`) and its `http_json` check → §11 D4.

## 6. Income statement v2: config

One block replaces `reporting.revenue`, `reporting.income`, `reporting.extra_cash`, `reporting.haircuts`,
`reporting.revenue_disclosed` and the top-level `holder_flows` (whose only remaining reader after Phase 1 is the
report). `window_days`, `volume`, `dilution` and `burned_tokens` move inside it unchanged.

```yaml
income_statement:
  category: perp_dex          # dex | perp_dex | launchpad | cdp_stablecoin | lending | oracle | ai_platform | liquid_locker | lst
  window_days: 91
  revenue:                    # everything users pay (rule 3), including builder/referral/partner shares (decision 5)
    - id: core
      label: Lighter Core fees
      metric: flow.fees_core            # a measured flow (tokens; priced by §4)
      settlement: daily                 # daily | periodic (unchanged semantics)
    - id: robinhood
      metric: flow.fees_rh
      started: 2026-06-26
    - id: v2_swaps                      # UNI example, decision 7: derived gross
      derived: { from: flow.v2_protocol_fees, share: 0.1666667, share_metric: v2_protocol_share }
    - id: business                      # VVV example
      disclosed: revenue_run_rate_usd
  scope: complete             # complete | protocol_share_only | partial — what revenue covers, shown with every figure
  cost_of_revenue:            # what users paid that goes to the supply side and partners
    - id: robinhood_partner
      to: partners            # lps | lenders | savers | builders | referrers | partners | creators | deployers | node_operators | other
      of: robinhood           # a share of one revenue line ...
      share: 0.5
      share_metric: rh_revenue_share_app   # ... read daily from the protocol; a parameter check guards it
    - id: lp_fees
      to: lps
      metric: flow.lp_fees                 # ... or measured
    - id: creators
      to: creators
      not_measured: "pump.fun creator fees: fee accounts not yet scanned (Phase 3)"   # shown as n/m, never 0
  holders:                    # paid to holders out of revenue, by bucket (Mike's like-kind classes)
    - id: buyback
      bucket: burn            # burn | hold | cash
      metric: flow.buyback
      haircut: 0              # burn: must be 0
      recipient_base: all     # all | staked | locked
      valued_per: supply      # supply | recipients (yCRV), as today
  protocol:                   # kept by the protocol (treasury, the platform's cut)
    - id: treasury
      metric: flow.treasury
  operating_costs:            # paid out of gross profit for operations (keepers, callers, boost delegators)
    - id: callers
      estimate: { of: crv_lock_incentive, ratio: 0.05 }
  remainder: protocol         # optional: the one section closed as revenue − the rest; one line, labelled derived
  below_line:                 # income not paid by users (rule 3): third-party bribes, treasury programs
    - id: vote_incentives
      metric: flow.bribes
      to: holders             # holders (then bucket/haircut/recipient_base as in holders) | protocol
      bucket: cash
      haircut: 0.05
      recipient_base: staked
  checks: [ { id: splitter, type: sum, total: [flow.protocol_revenue], parts: [vecrv_fees, treasury], tolerance_pct: 2 } ]
  volume: [flow.lp_gross_crv]        # unchanged: gross handled, not revenue
  dilution: [ ... ]                  # unchanged, plus emission_rate_annual as today
  burned_tokens: [ ... ]             # unchanged
```

Validation (schema refine, same style as today): every line id unique across sections; each line has exactly one of
`metric | derived | disclosed | estimate | of+share | not_measured`; a `disclosed` revenue is the only revenue line
(as today); `remainder` names one section and that section has no other line; `burn` lines have haircut 0; a `share`
line or `derived` line with a `share_metric` gets an automatic `parameter` check; `below_line` metrics may not also be
revenue metrics; a metric used twice across sections is refused unless one use is `of`+`share` (the split of a
gross series, as LIT's 0.5 today). Unknown keys refused (strictObject).

Identities the report computes (all annualized over the window, then growth as today):

```
revenue        = Σ revenue lines
gross profit   = revenue − Σ cost_of_revenue          (n/m if any cost line is not_measured)
gross profit   = holders + protocol + operating_costs + unreconciled
unreconciled   = shown, never booked; zero by construction when a remainder is declared
take rate      = gross profit / revenue
payout ratio   = holders / gross profit               (today: holders / revenue, where revenue ≈ today's gross profit)
holder flow    = holders (by bucket) + below_line.to=holders (by bucket, flagged "not from revenue")
net holder flow= holder flow − dilution (emissions + releases, valued at price)
multiples      = market cap / revenue, / gross profit, / holder flow (per bucket and total)
```

## 7. Income statement v2: report output

`report yield --json` gains `incomeStatement` (schema 2); the old `income`, `revenue`, `buckets` and `flows` keys are
kept one release behind a `--legacy` flag for the coinrevs tables, then removed. Every line carries its method and
provenance summary, so the site can label a number without a second lookup.

```jsonc
"incomeStatement": {
  "schema": 2, "day": "2026-10-26", "windowDays": 91, "category": "perp_dex", "scope": "complete",
  "revenue":        { "annualized": 49.27, "growth": {...}, "growthExNew": {...},
                      "lines": [{ "id": "core", "annualized": 33.11, "windowSum": 8.25, "method": "measured",
                                  "sourceTypes": ["first_party_api"], "daysMeasured": 91, "provisionalDays": 0,
                                  "coverage": null, "isNew": false, "growth": {...} }, ...] },
  "costOfRevenue":  { "annualized": 8.08, "notMeasured": [], "lines": [{ "id": "robinhood_partner", "to": "partners", "share": 0.5, "method": "derived", ... }] },
  "grossProfit":    { "annualized": 41.19, "growth": {...} },
  "holders":        { "annualized": 32.72, "byBucket": { "burn": {...}, "hold": null, "cash": null }, "lines": [{ "gross", "haircut", "net", "yield", ... }] },
  "protocol":       { "annualized": 8.48, "lines": [...] },
  "operatingCosts": { "annualized": 0, "lines": [] },
  "unreconciled":   { "annualized": 0, "pct": 0 },
  "belowLine":      { "toHolders": 0, "toProtocol": 0, "lines": [] },
  "holderFlow":     { "gross": 32.72, "net": 32.72, "byBucket": {...}, "fromRevenue": 32.72, "fromBelowLine": 0 },
  "dilution":       { "emissions": {...}, "releases": [...], "tokensPerYear": ..., "pct": 0.127 },
  "ratios":         { "takeRate": 0.836, "payoutRatio": 0.794 },
  "multiples":      { "mcapToRevenue": ..., "mcapToGrossProfit": ..., "mcapToHolderFlow": { "burn": ..., "total": ... } },
  "yields":         { "cash", "buyback", "shareholder", "dilution", "netShareholder" },   // as today
  "checks":         [{ "id": "rh_share", "type": "parameter", "lhs": 0.5, "rhs": 0.5, "gapPct": 0, "status": "ok" }],
  "provenance":     { "methods": { "measured": 0.84, "derived": 0.16, "disclosed": 0 },  // share of revenue by method
                      "thirdParty": [],                                                   // any line still on DefiLlama etc.
                      "sources": ["first_party_api:api.lighter.xyz", "first_party_api:api.rh.lighter.xyz", "contract_state:eip155:1"] }
}
```

(The LIT figures above are today's numbers under v2: revenue 49.27 = Core 33.11 + Robinhood gross 16.16; cost 8.08.)

**Per-token figures for a live site (Mike, 2026-10-28).** The site computes multiples and yields from a live price, so
`incomeStatement` also carries `perToken`: `revenue`, `grossProfit`, `holderFlow` (total and `byBucket`) and `dilution`,
each = annualized USD / `circulatingSupply` (and `/ totalSupply` as `perTokenFdv`), with `circulatingSupply`,
`totalSupply` and `supplyAsOf`. The site then shows price / revenue-per-token (= market cap / revenue) and holder
flow-per-token / price (= holder yield) against its own live price. Every snapshot also states the price each USD figure
used (`priceBasis`: Orion's end-of-day price per flow day, its source and day), so a live multiple never silently mixes
bases. `multiples` and `yields` above stay, computed at Orion's day-end price, as the audited reference.

The tick's Slack holder-yield block (Phase 1) switches to: revenue, gross profit, holder flow by bucket, net holder
yield, multiples, scope, and any `third_party`/`not_measured` flags.

## 8. Mapping the 13 live assets

"v1 revenue" = today's report revenue. "v2 now" = the same stored data under v2 rules, built in Phase 2 (no new
series). "Missing" = what v2 needs that isn't stored, and the phase that fills it. Phase 3 is extended here to also
build missing gross/cost series for assets with no DefiLlama dependency (§11 D7).

| Asset | Category | v1 revenue | v2 now: revenue / cost / gross profit / holders (bucket) / protocol / opex / below line | Method now | Missing (phase) |
|---|---|---|---|---|---|
| AERO | dex | 76.93 | 76.93 (scope: protocol_share_only = gauged-pool fees to voters) / n/m / – / 76.93 cash / 0 / 0 / bribes n/m | third_party (DefiLlama dailyHoldersRevenue) | All pools' swap fees and the ungauged-LP cost; voter bribes (below line). On-chain: per-gauge `FeesVotingReward`/`BribeVotingReward` notify logs over a curated gauge list (pool_scan) (Phase 3, with the AERO+VELO post-merger rebuild) |
| CAKE | dex | 79.78 | 79.78 (protocol_share_only) / n/m / – / 58.44 burn / 21.34 / 0 / 0 | log_scan (converters → burner, treasury) | LP fees; other products (prediction, lottery, perps). v2 AMM: fixed split → derived gross; v3: per-tier protocol share, needs a `parameter` read per tier or a pool_scan of the top pools; DefiLlama dailyFees (214.26) dropped (Phase 3) |
| CRV | dex + cdp | 5.75 | 5.75 (protocol_share_only: admin fees) / n/m / – / 5.17 cash / 0.57 / 0 / 7.48 vote incentives to holders (cash) | log_scan (FeeCollector → allocator → distributor) | Split of admin fees by product (FeeCollector inflows by sender: pools vs crvUSD controllers vs LlamaLend); DEX gross = admin × 2 (decision 7) with LP cost 50%; crvUSD/LlamaLend borrower interest gross with lender cost; vote-incentive source (§11 D4) (Phase 3) |
| cvxCRV | liquid_locker | 6.02 | 6.02 (veCRV fees 2.62 + Convex CRV platform fee 3.40) / 0 / 6.02 / 4.62 cash / 1.30 (CVX stakers 0.90, treasury 0.40) / 0.10 callers / 0.47 CVX program to holders | log_scan | Nothing for decision 6. The 83% of boosted CRV passed to LPs (`volume` 19.99) stays volume, not revenue (§11 D5) |
| sdCRV | liquid_locker | 3.60 | **1.90** / 0 / 1.90 / 0.89 cash / 0.90 / 0.12 boost delegators / **1.70 bribes** to holders (cash) | log_scan | None. **Revenue drops 47%**: bribes (Votemarket, botmarket → merkle stash) are third-party vote payments, below the line under rule 3 |
| yCRV | liquid_locker | 2.31 | **2.20** (measured splitter inflow, `yearn_gross`) / 0 / 2.20 / 1.59 cash / 0.62 (+ st-yCRV fee 0.10, see note) / 0 / 0 | log_scan | Whether the st-yCRV performance fee (0.10) is taken out of YBS payouts (then holders −0.10, protocol +0.10, revenue unchanged) or is a separate stream (revenue 2.30). Plan verifies on chain (Phase 2) |
| HYPE | perp_dex | 967.43 | 967.43 (trading 790.03 + reserve yield 177.40) / n/m / – / 967.43 burn (§10) / 0 / 0 / 0 | third_party (trading, DefiLlama) + first_party_api (reserve yield) | Revenue = AF buys / 0.99 (decision 7) from the Hyperliquid API (Phase 3); cost of revenue: HLP share, builder fees, HIP-3 deployer shares, referral rebates (first-party API where it exposes them, else not_measured); reserve-yield classification (§11 D2). DefiLlama history deleted: on-chain history from ~2026-10-10 |
| LINK | oracle | 57.40 | 57.40 (protocol_share_only: fees converted via Payment Abstraction) / n/m / – / 57.40 hold / 0 / 0 / 0 | log_scan | Fees users pay to node operators (CCIP OnRamp/FeeQuoter fee-token balances = contract_state; Data Feeds paid off chain = not_measured); enterprise revenue only by disclosure (Phase 3) |
| LIT | perp_dex | 41.19 | **49.27** (Core 33.11 + Robinhood gross 16.16) / 8.08 Robinhood partner / 41.19 / 32.72 burn / 8.48 (remainder) / 0 / 0 | first_party_api | Nothing for revenue. DefiLlama checks/series (`fees`, `llama_revenue`, `dominance`) and the buyback cross-check dropped (Phase 3) |
| PUMP | launchpad | 681.84 | 681.84 (DefiLlama dailyRevenue = protocol share) / n/m / – / 316.80 burn / 365.05 (remainder) / 0 / 0 | third_party (revenue); contract_state (supply drop) | Gross fees and costs from the Solana fee accounts: bonding-curve and PumpSwap protocol fee accounts (single-address scans), creator fees and PumpSwap LP fees as costs; unlock schedule as a cited manual schedule (Phase 3) |
| SKY | cdp_stablecoin | 51.16 | 51.16 (protocol_share_only: surplus to the Splitter) / n/m / – / 51.16 cash (USDS 21.75 + flapper SKY paid on 29.41) / 0 / 0 / 0 | log_scan | Gross: stability fees from Vat state (Σ ilk Art × Δrate, per day) incl. allocator ilks; cost: savings rate (sUSDS `chi` growth × supply), PSM/Allocator shares (Phase 3, new series; no DefiLlama today) |
| UNI | dex | 133.91 | 133.91 (protocol_share_only: v2 + selected v3 fees, = UNI burned) / n/m / – / 133.91 burn / 0 / 0 / 0 | log_scan (0xdead, any sender) | v2 gross = protocol fees × 6 (derived, decision 7); v3 gross: fee switch covers selected pools only, so not derivable: pool_scan of the switched pools + coverage; v4: PoolManager `Swap` logs carry the fee (single-address scan); Unichain sequencer fees (Phase 3). DefiLlama dailyFees (1592.49) dropped |
| VVV | ai_platform | 100.00 | 100.00 (disclosed run rate) / n/m (compute costs undisclosed) / – / 10.22 burn / 89.78 (remainder, before costs) / n/m / 0 | disclosure | Nothing measurable for cost of revenue unless Venice discloses it; DefiLlama `revenue_proxy` cross-check dropped (Phase 3) |

Notes:

- **Below-line moves change three published revenue figures**: sdCRV 3.60 → 1.90 (bribes 1.70 move below the line),
  yCRV 2.31 → 2.20 (or 2.30, pending the st-yCRV check), LIT 41.19 → 49.27 (Robinhood gross in, partner share as a
  cost). CRV's vote incentives (7.48) were never in CRV's revenue; they move from `extra_cash` to `below_line`, so
  CRV's holder flow stays 12.65, now split 5.17 from revenue + 7.48 below the line. Every other asset's revenue is
  unchanged in Phase 2; only labels (scope, method) are added.
- **Payout ratio changes denominator** (holders / gross profit). Where gross profit = old revenue (cost 0 or n/m), the
  ratio is unchanged: AERO 1.00, CAKE 0.73, CRV 0.90, cvxCRV 0.77, HYPE 1.00, LINK 1.00, LIT 0.79, PUMP 0.46,
  SKY 1.00, UNI 1.00, VVV 0.10, yCRV 0.72 (was 0.69 on 2.31). sdCRV 0.72 → 0.47 (0.89 / 1.90).
- `scope: protocol_share_only` is shown beside every revenue figure (and multiple) until the gross series exist, so
  the site never compares CAKE's protocol share with LIT's gross fees without a flag.
- Third-party dependencies left after Phase 2: AERO, HYPE (trading), PUMP revenue; `dominance` metrics if Phase 1
  hasn't removed them; price `http_json` checks; CRV vote incentives. All labelled `third_party` in provenance.

## 9. Mechanism templates (onboarding 80-100 protocols)

A template is a documented config skeleton plus the generic source types it needs. Onboarding = pick the template,
fill contract addresses, run the template's scoping checklist, measure the checks, and add the asset. Bespoke
adapters only for first-party APIs. Templates live in `docs/templates/<template>.md` with a YAML skeleton and the
list of addresses to find.

New generic source types (built once, in Phase 2 or the first Phase 3 asset that needs each):

- `state_delta`: the daily change of a contract counter read at the day's last block (accrued protocol fees,
  `accruedToTreasury`, Vat debt × rate, vault `pricePerShare` × supply). Rung 1.
- `event_sum`: the sum of one event field at one address per day (v4 `Swap.fee` × amount, `CollectProtocol`,
  `RewardAdded`). Rung 2. Generalizes `transfer_flow`, which stays as a special case.
- `balance_delta`: an account's balance change per day (EVM, Solana, Hyperliquid spot), for `balance` checks and for
  flows with no logs. Rung 1.
- `pool_scan`: `event_sum` over a versioned list of contracts, writing `coverage` (listed pools' share of a total
  read on chain where possible, else of TVL from contract state).
- `api_series`: a first-party JSON daily series with `revision_days` (today's `http_json` is level-only and
  `defillama` is the only flow API source).

| Template | Examples | Revenue | Cost of revenue | Holders | Rung / contracts to find | Checks | Traps |
|---|---|---|---|---|---|---|---|
| T1 fee-switch burn | UNI, CAKE, SUSHI | swap fees: protocol fees ÷ fixed share (derived) or event_sum on swaps | LP fees (revenue − protocol) | burn of bought token | log_scan of the burn sink / converter; `feeTo`/protocol-fee parameter reads | `supply`, `parameter`, `coverage` | share differs by pool or tier (no derivation then); searchers burn on behalf (`from_any`) |
| T2 exchange buyback | HYPE, LIT, dYdX, GMX-like | trading fees (first-party API or fee-account state) | LP/vault share, builders, referrers, partners, deployers | burn or hold (§10) | first_party_api + fee account / buyback wallet | `two_path` (fills vs balance), `revision` | API revisions; partner instances (LIT Robinhood); fees in quote asset |
| T3 launchpad buyback | PUMP, Zora-like | platform fees on curve + AMM | creator fees, LP fees | burn (supply drop) or hold | fee-recipient accounts (Solana) | `supply`, `balance` | supply drop ≠ buyback if other burns exist |
| T4 ve distribution | CRV, AERO, VELO, Balancer | swap/borrow fees (admin share × 1/share, or measured) | LPs, lenders | cash to lockers (fees), bribes below line | fee distributor / voting-reward contracts | `sum` (allocator splits), `coverage` (gauge list) | bribes are third-party (below line); fee tokens vary |
| T5 liquid-locker wrapper | cvxCRV, sdCRV, yCRV, (aura, vlAERO lockers) | all veX yield through the wrapper + platform fee on boosted rewards (decision 6) | none | cash to wrapper stakers | the locker's voter proxy, fee receivers, staking contract | `sum` (splitters), `balance` | LP reward pass-through is volume, not revenue (§11 D5); treasury reward programs below line |
| T6 CDP stablecoin / savings | SKY, Liquity, crvUSD | borrower interest, PSM fees, reserve yield | savings rate, allocator shares | cash (surplus) or buyback | Vat/controller state, savings-vault `chi` | `state_delta` vs surplus transfers | reserve yield classification (§11 D2) |
| T7 lending market | Aave, Compound, Morpho, Spark | borrower interest | lender interest (revenue − reserve factor) | buyback or none | `state_delta` on reserve indices × debt, `accruedToTreasury` | `parameter` (reserve factor), `balance` | per-market reserve factors; flash-loan fees |
| T8 fee conversion reserve | LINK | service fees converted to token | node-operator payments | hold | converter → reserve log_scan | `balance` | off-chain revenue only by disclosure |
| T9 disclosed company | VVV | disclosed run rate | disclosed or n/m | burn/hold measured | disclosure + burn sink scan | watch vs on-chain usage | stale disclosures; never mix with a proxy |
| T10 staking/LST fee | Lido, Jito, Rocket Pool | protocol fee on staking rewards: total rewards (state) | stakers' share, node operators | treasury or holders | oracle report / rebase events, fee parameters | `parameter`, `state_delta` | MEV and priority-fee accounting |

Scoping checklist per new protocol (in each template doc): category and template; every revenue, cost and holder line
with its rung and contract/endpoint; licence of every first-party API; which lines are `not_measured` and why; the
checks; supply (total less burn addresses, circulating source, dilution lines in the existing terms); imminent
protocol events (orion skill rule); expected figures re-measured once by hand before launch.

## 10. HYPE bucket: burn or buy-and-hold

Today the Assistance Fund buyback is `kind: burn` (bucket burn, haircut 0), and `total_supply` subtracts the AF
balance (as CoinGecko does). The roadmap flagged that the AF "buys and holds; it is tagged burn only to match the
valuation."

Facts (checked 2026-10-28): the Hyper Foundation proposed on 2025-12-17 that validators "formally recognize the
Assistance Fund HYPE as burned, removing the tokens permanently from the circulating and total supply"; the AF is a
system address with no private key, so "funds are mathematically irretrievable without a hard fork", and a Yes vote is
"binding social consensus to never authorize a protocol upgrade to access this address" (HyperFND on X,
`x.com/HyperFND/status/2001127850754367525`). The vote passed with 85% of stake for, 7% against, 8% abstaining
(crypto.news, ~2025-12-24). Hyperliquid's site now states "HYPE in the Assistance Fund is burned".

Options:

- **A. Burn (recommended).** Matches the protocol's formal position, the vote, CoinGecko's supply and our own
  `total_supply`. Footnote on the site: "burned by validator vote (Dec 2025); tokens sit in a keyless system address,
  not destroyed on chain". No number changes.
- **B. Buy-and-hold** with an overhang haircut (as LINK's Reserve, 5%). Consistent only if the AF balance is added
  back to `total_supply` and FDV (~10% of supply), contradicting CoinGecko and the vote. Holder flow net −5%
  (~−$48M/yr at today's run rate) and every supply figure moves.
- **C. Burn, but a separate "social burn" sub-bucket** so the site can filter hard on-chain burns from consensus burns.
  More honest for purists; one more label to maintain for one asset today.

The reserve-yield stream (177.40) follows whatever HYPE's buyback is (it is paid into the AF too).

## 11. Decisions owed (Mike)

| # | Question | Options | Recommendation |
|---|---|---|---|
| D1 | HYPE bucket (§10) | A burn / B buy-and-hold (+ add AF back to supply) / C burn with a "social burn" label | **A**, with the footnote |
| D2 | Yield earned on users' deposits (HYPE AQAv2 USDC reserve yield 177.40; SKY reserve/RWA yield later): revenue or below the line? | revenue (float yield, like a bank's net interest) / below the line (not "paid by users") | **Revenue**, line labelled "reserve yield on user deposits". Below the line is for third-party payments unrelated to usage (bribes, grants, treasury programs) |
| D3 | Price storage (§4) | hourly token buckets × hourly prices / daily tokens × daily mean price (−1.5% to +1.0% on 91 days measured) / keep USD at ingest | **Hourly buckets**: matches today's method, swappable, 24 numbers per flow row |
| D4 | CRV vote incentives (7.48/yr, below the line) come from Llama Airforce's `llama.box`, a third-party community API with no stated licence | ask Llama Airforce for written permission / replace with on-chain scans of the incentive markets (Votemarket, Hidden Hand; curated list + coverage) / drop from the site at launch | **Replace on chain** in Phase 3; until then show it internally only, labelled third_party |
| D5 | Wrapper boundary (decision 6 detail): is the CRV a locker passes to its LPs (cvxCRV volume 19.99, sdCRV 6.33) revenue? | no: it's Curve gauge emission (CRV's dilution), kept as `volume` / yes: revenue with an equal cost of revenue | **No.** Revenue = veCRV fees + the platform's fee on boosted CRV; caller and boost-delegator payments are operating costs (decision 6 says cost of revenue = none) |
| D6 | Minimum bar to list a protocol | revenue + holder lines + supply sourced, cost lines may be `not_measured` / everything incl. cost of revenue | **Revenue + holders + supply**; cost lines may launch as n/m with gross profit shown n/m |
| D7 | Where new gross/cost series for assets without DefiLlama (CRV, SKY, LINK, CAKE v3, UNI v3/v4) are built | inside Phase 3 as extra tracks / a new Phase 3b after DefiLlama replacement / Phase 2 | **Phase 3 tracks**, per asset, each with its own spec; Phase 2 ships schema + reclassification only |
| D8 | Payout ratio denominator | holders / gross profit / holders / revenue | **Gross profit** (equals today's ratio wherever cost is 0 or n/m; only sdCRV moves, 0.72 → 0.47) |
| D9 | Legacy report keys (`income`, `revenue`, `buckets`, `flows`) | keep one release behind `--legacy` / remove with v2 | **Keep one release**: the coinrevs tables read them |

## 12. Build outline (for the plan, after approval)

1. Config schema `income_statement` + conversion of 13 asset files (old keys refused). Proof: v2 report on a scratch
   copy, every changed figure listed and matched to §8; every unchanged figure byte-identical.
2. Report v2 output (§7) and the Slack block.
3. Checks framework (§5): `sum`, `parameter`, `balance`, `supply`, `two_path`, `price`, `revision`; `check_results`
   table; anomalies on breach.
4. Provenance columns + writer changes per source type + history backfill (Postgres).
5. Tokens/prices tables, hourly buckets, chain re-scan backfill with a USD comparison per metric, `flow_usd_v`.
6. Template docs T1-T10 and `docs/ops/sources-register.md` (licence terms per source).
7. Generic source types `state_delta`, `event_sum`, `balance_delta`, `api_series` (built when the first Phase 3 asset
   needs each, unless Mike wants them up front).

Tests: suite green, typecheck, VVV golden replaced by a v2 report golden per asset. No live change in Phase 2 until
Mike's go at merge; no analyst spend anywhere.
