# Supply definitions (2026-10-12)

Decided with Mike on 2026-10-12. Branch `feat/supply-defs`.

## Definitions

- **total_supply**: the on-chain supply less what CoinGecko also excludes: burn addresses, and for HYPE also the
  Assistance Fund. This is the former `effective_supply`, renamed. It uses the same per-asset sources and gives the same
  values.
- **circulating_supply**: CoinGecko's `circulating_supply`. CoinGecko has none for cvxCRV, sdCRV and yCRV, so for those
  it is the on-chain token `totalSupply()`.
- **market_cap** = price × circulating_supply. **fdv** = price × total_supply.

The valuation is still on total_supply (`supply_basis: effective_total` is unchanged). The engine never reads market cap
or FDV.

## Changes

1. **Rename.** `effective_supply` becomes `total_supply` in the code, the asset YAMLs, tests and docs. The HYPE adapter
   `hype.effective_supply` becomes `hype.total_supply`.
   - Migration 6 renames the metric key in `observations`, `anomalies` and staleness `trigger_firings`.
   - In `fetch_runs.detail_json` it renames the metric and the HYPE source id, because the failure streak looks a
     source up by id.
   - It also renames them in `config_versions.content_json`, so that `model replay` re-reads a stored config against
     the renamed rows. Config rows keep their hash.
   - Model-written prose (journal, transcripts) is left as written.
2. **Wrappers.** cvxCRV, sdCRV and yCRV gain `circulating_supply` from `erc20_supply` of the token. It is display only;
   no valuation input.
3. **Report.** `report yield` now has both `marketCap` (circulating basis) and `fdv` (total basis). The old `mcap` was
   price × total supply, which is the FDV. Yields, the multiple and the supply line are still on total supply, so the
   numbers are unchanged.
4. **Cross-check.** CoinGecko `total_supply` is a cross-check on `total_supply`, with 2% tolerance, for VVV, HYPE, AERO,
   CRV, UNI and cvxCRV.
   - sdCRV and yCRV are skipped: CoinGecko's figures for them are stale 2022 snapshots (sdCRV −81%, yCRV −95% against
     chain on 2026-10-12).
   - total_supply is critical, so a miss grades the signal down (`degrading`).
   - HYPE sits at 0.46%: CoinGecko does not subtract the Assistance Fund.

## Verification (2026-10-12, two copies of the live DB, old build vs new build, `model run --as-of 2026-10-12T13:00Z`)

- All 8 assets: the engine output (`valuation_runs.output_json`) is byte-identical (same sha256). The 6m and 12m targets
  and the grades are identical.
- Each signal lists `config` as its change cause, because every asset's config hash moved.
- `model replay` of each asset's previous run after the migration: identical (8/8).
- Live fetch in the scratch home: every CoinGecko total check passed (VVV 0.00%, HYPE 0.46%, AERO 0.00%, CRV 0.00%,
  UNI 0.00%, cvxCRV 0.00%).
- Report against CoinGecko /coins/markets (2026-10-12; our price is the day's fetch, CoinGecko's is live):

| Asset | mcap | CG mcap | Δ | fdv | CG fdv | Δ |
|---|---|---|---|---|---|---|
| VVV | $1,159.1M | $1,161.2M | −0.18% | $1,944.4M | $1,947.9M | −0.18% |
| HYPE | $19,019.1M | $19,027.6M | −0.04% | $81,301.2M | $81,715.4M | −0.51% |
| AERO | $903.2M | $903.4M | −0.02% | $1,796.2M | $1,796.5M | −0.02% |
| CRV | $573.1M | $572.4M | +0.11% | $883.3M | $882.3M | +0.11% |
| UNI | $4,712.1M | $4,714.8M | −0.06% | $6,689.4M | $6,693.3M | −0.06% |
| cvxCRV | $61.82M | n/a | | $61.82M | $61.82M | −0.00% |
| sdCRV | $23.65M | n/a | | $23.65M | $4.56M (stale) | |
| yCRV | $14.06M | n/a | | $14.06M | $0.72M (stale) | |

For the wrappers, mcap = fdv = price × on-chain `totalSupply()`.

## Deploying

Merging and building runs migration 6 on the live DB the next time any command opens it (the next cron tick or CLI
call). The usual live rules apply: back up first, merge ff-only, build, `asset validate` all 8.

The first signal after the deploy lists `config` as its cause for every asset, with targets unchanged. Push waits for
Mike.
