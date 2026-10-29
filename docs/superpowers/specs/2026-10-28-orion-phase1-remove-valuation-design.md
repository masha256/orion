# Orion Phase 1: remove the valuation layer

Status: draft for review (2026-10-28). Umbrella: `2026-10-28-orion-coinrevs-core-roadmap.md`.

## Goal

Orion stops making price judgements. What remains is ingest, storage, anomalies, the holder-yield / income-statement
report and the disclosure watcher. **No reported number changes:** `report yield` output is byte-identical before and
after for all 13 assets. Phase 1 stays on SQLite; schema changes wait for the Postgres move (Phase 1.5).

Non-goals: no new metrics, no source changes (DefiLlama replacement is Phase 3), no income statement v2 (Phase 2), no
bucket changes (HYPE stays `burn` until Phase 2).

## What stays

- `src/ingest/**`: all sources, adapters, transports, watch alerts, anomalies.
- `src/report/**`: `report yield` (its `latestLevel` helper moves from `src/drivers/select.ts` to `src/report/` or
  `src/db/observations.ts`, unchanged).
- `src/db`: observations, fetch runs and cursors, anomalies, documents, proposals, coverage, run locks, config versions,
  agent runs and transcripts (used by disclosure runs), migrations.
- CLI: `data`, `report`, `asset`, `doc`, `proposals`, `persona`, `agent` (disclosure only), `tick`, `init`.
- The disclosure watcher, unchanged in behaviour: one budget-capped `disclosure` run per new call, figures and config
  changes filed as proposals for Mike.
- Config: `contracts`, `external_ids`, `ingest`, `metrics`, `holder_flows`, `reporting`, `agent.budgets.disclosure`.

## What goes

- **Code:** `src/engine/**`, `src/drivers/compute.ts`, `src/signals/**`, `src/app/{valuation,update,deviation,
  eligibility,cadence,triggers,inbox}.ts` and the parts of `tick.ts` that call them; the `model`, `signal`, `update`
  and `inbox` commands; run types `weekly`, `triage`, `deep`, `bootstrap`; agent tools that read or change assumptions
  or write catalysts; the `assumption_value` proposal kind; their tests and fixtures (VVV golden, engine, drivers,
  signals, cadence and trigger tests).
- **Config keys** (every asset): `modules`, `scenario_probabilities`, `assumptions`, `review_triggers`, `peer_set`,
  `agent.budgets` other than `disclosure`, and the calibration notes that only explain them. Removing keys moves every
  asset's config hash; tests re-pin. The schema refuses the removed keys so a stale YAML fails loudly.
- **Metrics only the valuation reads.** Certain: `dominance_share`, `dominance_share_1y` (DefiLlama-sourced, 10 assets).
  Candidates, removed only if a code search in the plan shows nothing outside the removed code reads them:
  `staker_emission_share`, and `revenue_run_rate_usd` on assets other than VVV (VVV's carries its disclosed revenue and
  stays). Display metrics Mike wants for the site (e.g. CRV `ve_power.*`, `ve_locked.*`) stay.
- **Stored rows:** the dominance observations are deleted (roadmap decision 1), after a verified backup. Valuation
  tables (`assumption_sets`, `assumptions`, `assumption_changes`, `assumption_evidence`, `snapshots`, `valuation_runs`,
  `signals`, `journal`, `trigger_firings`) are left in place, no longer read or written, and not carried into Postgres.
  `signals.jsonl` stops growing; `ticks.jsonl` continues.

The last valuation commit is tagged `orion-valuation-final` and pushed, so the layer can be recovered.

## The new tick

`tick <asset>`: lock, ingest, anomaly detection, report, unlock. No agent run, ever, from a tick.

- Report (`ticks.jsonl` and stdout, JSON): ingest outcome and failed sources, `ingest.watch` firings, newly raised and
  still-open anomalies, and the asset's `report yield` summary for the latest complete day (revenue, holder flow by
  stream, payout ratio, yields, dilution, net yield, multiple, growth).
- Exit codes: 0 ingest ok or partial, 1 nothing fetched, 2 a source failure blocks the report. `orion-tick.sh` keeps
  its retry rule for exit 1 and drops the `run_in_progress` retry, which only an agent run produced.
- Open anomalies no longer start a paid triage run; they appear in every report until acknowledged or resolved
  (`proposals` / `data anomalies` commands, by hand).

## Cron and Slack

The 13 `orion-<asset>` jobs keep their times and #orion-ops delivery. Their prompts change together: print
`ORION WATCH` lines first, then failed sources and open anomalies, then a short holder-yield block; no target, grade or
signal lines. The disclosure watcher job is unchanged. Anthropic spend after Phase 1: the cron report agents plus
disclosure runs only.

## Proof

1. Suite green (`npx vitest run --maxWorkers=2`, CLI files rerun alone if they time out) and `npm run typecheck`.
2. **Reports unchanged:** on two `.backup` copies of the live DB, `report yield <a> --day <fixed> --json` with the old
   dist and with the new dist, for all 13 assets; `cmp` each pair. Must be identical.
3. **Ingest unchanged:** `data fetch <a> --dry-run --json` old vs new on scratch copies; the only differences allowed
   are the removed metrics.
4. **Disclosure watcher:** a dry run of a stored LIT post (`--dry-run --orion-home <scratch> --queue-file <scratch>`)
   produces the same proposals as before.
5. A scratch tick per asset shows the new report and starts no agent run.

## Rollout (live-install rules)

Check nothing is mid-run and the next cron time; tag and push `orion-valuation-final`; back up and verify the DB; ff-merge,
build, `asset validate` every asset; delete the dominance rows in one pinned transaction; rerun proof step 2 on live
read-only; update the 13 cron prompts; watch the next morning's run; push `main`.

## Questions for Mike

1. Slack report contents above (watch, failures, anomalies, holder-yield block): right, or do you want less?
2. Anomalies handled by hand with no triage run: OK?
3. Keep the `persona` / coverage machinery for disclosure runs only (needed today), or simplify it in Phase 2?
