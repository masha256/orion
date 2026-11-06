# Onboarding templates (T1-T10)

One template per revenue mechanism (spec `docs/superpowers/specs/2026-10-28-orion-data-strategy-income-v2-design.md`
§9). Onboarding a protocol = pick its template, fill the addresses and endpoints, run the template's scoping checklist,
measure the checks by hand once, then add `assets/<id>.yaml`. Bespoke adapters only for first-party APIs.

| Template | Mechanism | Example (live asset, or dummy values) |
|---|---|---|
| [T1](T1-fee-switch-burn.md) | DEX fee switch, fees bought and burned | UNI |
| [T2](T2-exchange-buyback.md) | exchange trading fees, token bought back | LIT |
| [T3](T3-launchpad-buyback.md) | launchpad platform fees, token bought back | PUMP |
| [T4](T4-ve-distribution.md) | admin fees paid to vote-escrow lockers | CRV |
| [T5](T5-liquid-locker-wrapper.md) | a veX wrapper passing on fees and incentives | yCRV |
| [T6](T6-cdp-stablecoin-savings.md) | CDP stablecoin surplus to stakers | SKY |
| [T7](T7-lending-market.md) | lending market reserve factor | dummy values (no live asset) |
| [T8](T8-fee-conversion-reserve.md) | service fees converted to the token and held | LINK |
| [T9](T9-disclosed-company.md) | a company's disclosed revenue, token burned | VVV |
| [T10](T10-staking-lst-fee.md) | protocol fee on staking rewards | dummy values (no live asset) |

## How a template is written

- Each doc has one ```` ```yaml skeleton ```` block: a whole asset file using only the config keys and source types on
  this branch (`src/config/schema.ts`, `src/config/incomeStatement.ts`, `src/checks/schema.ts`, the adapters in
  `src/ingest/adapters/registry.ts`). `{{name}}` marks a value to fill.
- Each doc has one ```` ```yaml example-values ```` block: a value for every placeholder, from the named live asset, or
  marked `dummy` where no live asset fits. Dummy values are there so the skeleton can be parse-tested; they are not
  real contracts.
- A line that needs a generic source type not built yet (`state_delta`, `event_sum`, `balance_delta`, `pool_scan`,
  `api_series`: built with Phase 3) is a comment starting `# needs <type> (Phase 3)`, never live YAML, so the skeleton
  still parses. The line becomes live when its type ships.
- `tests/config/templates.test.ts` reads both blocks from every doc, fills the skeleton, and loads it through
  `parseAssetObject` (the path every real asset takes). Editing a skeleton without keeping it valid fails the suite.

## Rules every template inherits

- **Deferral (spec §2, decision D6).** List a protocol only when its revenue line, its holder lines and its supply come
  from our own RPC, the protocol's first-party API or a cited disclosure. Cost-of-revenue lines may launch as
  `not_measured` (shown n/m, never 0). A revenue line that is `not_measured` means the asset waits.
- **No third-party source** (DefiLlama, Dune, community APIs) as a primary or a cross-check in a new asset.
- **Licence check.** Every new host or RPC the asset reads needs a row in `docs/ops/sources-register.md`
  (`tools/sources-register/generate.ts`; generation fails without one). `unknown` terms block only that asset's site
  export (Phase 5), never ingest.
- **Flow window 91 days** everywhere (`window_days`, holder flow `window_days`), with `ingest.backfill_days: 100`.
- **Supply terms.** `total_supply` = on-chain supply less burn addresses (the FDV basis); `circulating_supply` =
  CoinGecko's (market cap, display only); unlocks of already-minted tokens are `dilution`, never an emission.
- **Checks compare different sources.** The schema refuses a check whose two sides read the same series, or one
  computed from the other (spec §5).
- **Imminent protocol events.** Before building, search for mergers, migrations or new fee mechanisms due within weeks;
  if one would change the contracts being wired, stop and bring options.
