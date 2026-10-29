# Orion Phase 1: remove the valuation layer

Status: approved with Mike's answers (Slack #orion-dev, 2026-10-28, "go t_41314404 as recommended"): (1) the Slack report
keeps the proposed contents in this order: watch alerts, failed sources, open anomalies, a short holder-yield summary;
(2) anomalies are handled by hand, no paid triage run, the `open_anomaly` trigger path goes; (3) the persona / coverage
machinery stays for now (the disclosure run needs it); simplifying it is revisited in Phase 2. Corrections from the
plan's code search are in "Plan-time corrections" below. Plan: `../plans/2026-10-28-orion-phase1-remove-valuation.md`.
Umbrella: `2026-10-28-orion-coinrevs-core-roadmap.md`.

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

## Questions for Mike (answered 2026-10-28)

1. Slack report contents: **keep as proposed**, in this order: `ORION WATCH` lines, failed sources, open anomalies, a
   short holder-yield block.
2. Anomalies handled by hand with no triage run: **yes**. The `open_anomaly` trigger, and with it every trigger kind
   (`driver_deviation`, `staleness`, `provisional`, `calendar`), goes; `trigger_firings` is left in place, unread.
3. Persona / coverage machinery: **keep for now** (the disclosure run needs it); revisit in Phase 2.

## Plan-time corrections (code search, 2026-10-28)

The plan's code search found places where the list above was wrong or incomplete. These supersede the sections above.

1. **Stays, not removed:** `src/app/eligibility.ts` (`valueInForce`, `eligibleObservations`: read by
   `src/app/proposals.ts:125`, `src/app/inbox.ts:7` and the agent's `get_observations` tool); `src/app/inbox.ts` and the
   `inbox` command (the disclosure watcher calls `orion inbox <asset>`, `bin/disclosure_watch.py:746`, and its Slack line
   says "decide from the next orion-<asset> DECISIONS block"); the `journal` table and `write_journal` (a disclosure run
   finishes only once it has written its journal, `src/agent/run.ts:353`, and the watcher prints the journal's catalysts,
   `bin/disclosure_watch.py:1178`). So the Slack report lists pending proposals and provisional observations after the
   open anomalies, as today's DECISIONS block does.
2. **A disclosure run needs an assumption set today** (`src/agent/run.ts:286` throws `no_assumption_set` for every type
   but bootstrap). That check goes. Its context pack also carries drivers, assumptions, the latest signal, the target
   history and the calendar (`src/agent/context.ts:54-111`); those sections go, and so do the tools that read or move the
   valuation (`get_drivers`, `get_assumptions`, `get_signal_history`, `run_whatif`, `apply_assumption_change`). A
   proposal's `effect` (a 6m/12m target move computed by `whatIf`) is stored as `null` from now on. `TOOL_LAYER_VERSION`
   becomes `2.0.0`. The two disclosure skills drop their references to removed tools; the four skills that serve only
   removed run types (`anomaly-triage`, `assumption-review`, `bootstrap-research`, `tokenomics-audit`) are deleted.
3. **More config keys go:** `total_return_variants` (VVV only) and `supply_basis` (every asset, all `effective_total`)
   are read only by the engine and `asset show`; `agent.max_step_fraction` and `agent.cadence` only by the removed agent
   paths; and `review_triggers` as a whole. Its one field still used, `provisional_move_pct` (the move guard on
   `record_provisional_observation`), is 25 on all 13 assets, which is the default; it becomes a fixed constant. The
   schema's required standard metrics shrink to `price_usd`, `total_supply`, `staked_supply`, `emission_rate_annual`
   (what `src/report/load.ts:104-109` reads). Per-metric and per-flow fields the report no longer reads
   (`staleness_days`, `capture_rule`, `valued_per`) stay until Phase 2 so this phase moves no other field.
4. **Metrics resolved** (evidence in the plan): `dominance_share` / `dominance_share_1y` are on **9** assets, not 10
   (AERO, CAKE, CRV, HYPE, LIT, PUMP, SKY, UNI from DefiLlama; LINK has a manual `dominance_share` with no rows); 174
   stored rows on 2026-10-28; no code reads them. `revenue_run_rate_usd` is removed on the 12 assets other than VVV (read
   only by `src/drivers/compute.ts` and `src/app/triggers.ts`; the ingest stale-revenue check reads it only where
   `usage_index` exists, which is VVV). `staker_emission_share` and VVV's DIEM levels are read only by removed code; they
   stay or go on Mike's call (plan, decisions D1 and D2).
5. **Tick:** exit 0 when the fetch ran and the report was built (ingest ok or partial), 1 when ingest threw (nothing
   fetched), 2 when the fetch ran but `report yield` could not be built for the latest complete day. `orion-tick.sh`
   **keeps** its `run_in_progress` retry: a disclosure `agent run` holds the same per-asset lock
   (`src/cli/commands/agent.ts:83`). `tick` no longer writes `signals.jsonl`; `--no-agent` goes.
6. **Disclosure-watcher proof:** a real dry run calls the model (~$1-3) and is not deterministic, so "the same proposals"
   cannot be compared run to run. The free proof is the scripted-model e2e (`tests/agent/disclosure.e2e.test.ts`), the
   watcher's own unit tests, and a `post_run` replay of a stored run JSON. One paid dry run on the stored LIT Q3 post is a
   rollout step that needs Mike's go (plan, decision D4). `agent run --out <file>` stays accepted and ignored, because the
   watcher passes it on real runs (`bin/disclosure_watch.py:739`).
7. **Rollout additions:** the two pending `assumption_value` proposals (#1 VVV, #4 CAKE) can no longer be approved and are
   rejected with a note (decision D5); the old run-rate and staker-share rows of removed metrics are left in place, unread,
   and not carried into Postgres (decision D3).
