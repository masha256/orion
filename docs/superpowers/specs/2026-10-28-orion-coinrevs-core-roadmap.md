# Orion as the coinrevs data core: roadmap and decisions

Status: decisions recorded 2026-10-28 (Mike, Slack DM). This file is the umbrella record; each phase gets its own
design spec, plan and followups note under `docs/superpowers/`.

## Goal

Orion becomes the data core that powers the coinrevs site (working name): it collects, verifies and stores protocol
revenue, cost of revenue, holder flows, supply and dilution, with provenance on every number. It makes no price
judgement and has no DefiLlama dependency. Valuation may return later as a separate project that reads Orion's data.
Comparison with other platforms (DefiLlama, Token Terminal, Artemis) is a separate internal tool.

## Standing rules (Mike, 2026-10-27/28)

1. **No commercial data licences for launch.** A protocol whose numbers can't come from our own RPC, the protocol's
   first-party API, or a cited disclosure is deferred until a realistic source exists. DefiLlama and Dune both restrict
   non-Enterprise use to internal / non-commercial, so neither is a source.
2. **No indexer.** Method ladder, cheapest first: contract state (counters, accrued fees, recipient balances) >
   single-address log scans (singletons, fee collectors, first-party APIs) > daily scans of a curated pool list with the
   coverage stated. Daily totals only, as today.
3. **Revenue = everything users pay to use the protocol**, then a **cost of revenue** line (LPs, lenders, savings
   rate, builder / referral / partner shares, creators), then gross profit, split into paid to holders (by bucket),
   protocol income and operating costs. Income not from users (third-party bribes, treasury programs) sits below the
   line, then dilution. This replaces the 2026-10-12 rule (revenue = fees less supply side).
4. **Multiples:** market cap / revenue (size), market cap / gross profit, market cap / holder flow by bucket, shown
   with take rate and payout ratio and a category tag so unlike businesses aren't compared on gross revenue.
5. **CoinGecko** (price, price history for flow valuation, circulating supply): move to the paid Basic plan before
   launch (commercial licence; attribution required; no redistribution of raw data; stored data must be deleted if the
   plan lapses). Store token amounts and prices separately so a price source can be swapped. Owning circulating supply
   is a later step.

## Decisions (2026-10-28)

| # | Question | Decision |
|---|---|---|
| 1 | Stored DefiLlama-sourced history (HYPE, AERO, PUMP, ...) | **Delete** it and accept shorter history. Each asset's DefiLlama rows are deleted in the phase that replaces its source (Phase 3); valuation-only DefiLlama metrics (dominance) go in Phase 1. |
| 2 | Disclosure watcher | **Keep**, aimed at changes in how protocols pay holders (governance alerts). Every recorded disclosure is human-approved with a public citation. |
| 3 | CoinGecko | Move to **Basic** before launch. |
| 4 | Phase order | 1 → 1.5 → 2 → (3 and 5 in parallel) → 4. |
| 5 | Builder / referral / partner shares passing through the protocol | **Included** in revenue, then cost of revenue (matches DefiLlama's boundary). |
| 6 | Wrappers (cvxCRV, sdCRV, yCRV) | Revenue = all veCRV yield flowing through the wrapper; cost of revenue = none; paid to holders = what wrapper holders receive; protocol income = the platform's cut. |
| 7 | Derived gross revenue | **Allowed**, labelled "derived", where the protocol's share is fixed and covers every pool (gross = protocol fee / share, e.g. UNI v2 x6, Curve DEX x2). |
| 8 | Postgres hosting | **Prod: DigitalOcean managed Postgres.** Two DO servers: one for the prod website, one for prod + staging Orion. Dev stays on the current host with a local Postgres install. |
| 9 | Staging | On the prod Orion server as a **separate Unix user** (one user for prod, one for staging), so staging mirrors prod exactly: same layout relative to the user's home, own `.env`, own schedule, own database and database role on the managed Postgres cluster. Raymond deploys over SSH from the dev host. |

## Phases

- **Phase 1: remove the valuation layer** (SQLite, no change to any reported number). Spec:
   `2026-10-28-orion-phase1-remove-valuation-design.md`.
- **Phase 1.5: platform.** Dev / staging / prod split with a release process. On the Orion DO host, users `orion-prod` and
   `orion-stage` (names to confirm) each run a tagged release from their own home, never a working tree; the same deploy
   script serves both, taking the user as its target. Each environment has its own Postgres database and role, and the
   staging role has no rights on the prod database. Secrets live in each user's `.env` (mode 600). Raymond deploys over
   SSH with one key per environment (this host has no SSH key today, so one is created for this). Staging is refreshed
   from a prod dump on a schedule. Scheduling moves off Hermes cron to each user's own timers (systemd user timers or
   crontab), so how the daily Slack reports and alerts reach #orion-ops is decided in the 1.5 spec.
   Move to Postgres with the post-Phase-1 schema; the valuation and analyst
   tables are not carried over (the last SQLite file is archived). `better-sqlite3` is synchronous, so the DB layer and
   its callers become async; tests move to a test Postgres. A read-only role for the site.
- **Phase 2: data strategy + income statement v2.** Written strategy (source ladder, provenance on every observation:
   source type, contract / endpoint, block range or tx refs; method label measured / derived / disclosed; internal
   reconciliation checks), income statement v2 (rules 3-4, decisions 5-7), mechanism templates (fee-switch burn, perp
   buyback, ve distribution, liquid-locker wrapper) so 80-100 protocols are onboardable. Token amounts and prices stored
   separately. Revisit HYPE's bucket (the Assistance Fund buys and holds; it is tagged burn only to match the valuation).
- **Phase 3: replace DefiLlama**, easiest first: price cross-checks (coins.llama.fi) and VVV/LIT proxies and checks;
   UNI (per-version sub-models: v2 fee-to mints, v3 accrued protocol fees, v4 PoolManager swaps, Unichain burns) and
   CAKE; PUMP (fee accounts on Solana; unlock schedule as a cited manual schedule); AERO (with the post-merger rebuild);
   HYPE (Assistance Fund balance change via the Hyperliquid API; revenue ~ AF buys / 0.99 + reserve yield). Each asset's
   DefiLlama rows are deleted when its replacement is live (decision 1).
- **Phase 5: site interface**: a versioned read-only export (views on the read-only role or a JSON snapshot) carrying the
   income statement, holder flow by bucket, net holder yield after dilution, supply, provenance and change log.
- **Phase 4: comparison tool** (separate repo, internal only): reads Orion read-only, pulls other platforms, reports
   divergences with causes. Its third-party figures are never republished on the site without a licence.

## Known consequences

- Deleting DefiLlama history (decision 1) leaves HYPE with on-chain history from ~2026-10-10 only: a 91-day window
  around 2027-01-09, 182-day growth around 2027-04-10. AERO and PUMP restart from their replacement's first day unless
  the replacement can backfill on chain.
- With the analyst gone, an open anomaly no longer starts a paid triage run; it is reported and resolved by hand.
