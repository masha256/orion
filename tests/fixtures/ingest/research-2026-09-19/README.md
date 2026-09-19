# Research captures, 2026-09-19

Real responses saved by the sub-project 2 research pass (see `docs/superpowers/specs/2026-09-19-orion-ingestion-design.md`, section 2). Use them as the shapes for ingestion test fixtures. Large files were trimmed to their most recent points; nothing was edited otherwise.

- `venice_*.json`: Venice's undocumented API (`outerface.venice.ai/api/app/vvv/*`), plain requests. `CryptoBaseUnit` values are 18-decimal integers.
- `llama_venice.json`: DefiLlama `summary/fees/venice?dataType=dailyHoldersRevenue`.
- `cg_*_last*.json`: CoinGecko `market_chart` (hourly for 30 days, daily for 120), trimmed.
- `getlogs_sample25.json`: VVV `Transfer` logs to the zero address, first 25 of a larger pull.
- `receipt.json`, `safe_info.json`, `router_info.json`: the 2026-09-08 discretionary burn and the two burn paths.
- `merged_analysis.json`: the research pass's own per-sender and per-month totals (on-chain versus Venice). Useful for validating a backfill.
- `cg_markets.json`: CoinGecko `/coins/markets?vs_currency=usd&ids=venice-token,diem`, untrimmed (captured during planning).
- `chain_reads.json`: live contract reads made during planning that settled the spec's unverified ABI units.
