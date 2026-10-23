import { eligibleObservations } from '../app/eligibility.js';
import { calendarEvents, type RunBudgets } from '../config/agentPolicy.js';
import type { LoadedAsset } from '../config/load.js';
import { lastCompletedRun } from '../db/agentRuns.js';
import { getAnomaly, listAnomalies } from '../db/anomalies.js';
import type { Db } from '../db/connection.js';
import { docLabel, type StoredDocument } from '../db/documents.js';
import { listFetchRuns } from '../db/fetchRuns.js';
import type { Firing } from '../db/triggerFirings.js';
import { listJournal, type CatalystKind } from '../db/journal.js';
import { listProposals, recentlyDecidedProposals } from '../db/proposals.js';
import { listSignals } from '../db/runs.js';
import { computeDrivers } from '../drivers/compute.js';
import { requiredExtraMetrics } from '../engine/requirements.js';
import { getAdapter } from '../ingest/adapters/registry.js';
import { MS_PER_DAY, type RunType } from '../types.js';
import { describeAnomaly, describeAssumptions, describeDrivers, describeProposal, describeSignal } from './describe.js';
import type { Ledger } from './ledger.js';

export interface RunTrigger {
  anomalyId?: number;
  note?: string;
  /** What `orion tick` saw fire this tick. Empty on a manual run. */
  firings?: Firing[];
}

export interface ContextPackInput {
  runType: RunType;
  budgets: RunBudgets;
  now: Date;
  trigger: RunTrigger;
  /** A disclosure run's target document. Shown on disclosure runs only. */
  document?: StoredDocument;
  /** The text of `assets/<id>.yaml`, comments included. Shown on disclosure runs only. */
  assetYaml?: string;
}

const CALENDAR_DAYS = 30;
const TARGET_HISTORY = 8;
const DECIDED_PROPOSALS = 10;
const FETCH_RUNS = 7;
/** catalysts_due: the journal entries searched, and how far either side of now a catalyst's date may fall. */
const CATALYST_ENTRIES = 20;
const CATALYST_WINDOW_DAYS = 30;

/**
 * Everything the agent starts a run knowing, as one object. Every observation id in it is marked as shown on the ledger,
 * so the agent may cite what it was given without reading it again.
 */
export function buildContextPack(db: Db, loaded: LoadedAsset, ledger: Ledger, input: ContextPackInput): Record<string, unknown> {
  const asset = loaded.config;
  const nowIso = input.now.toISOString();

  const observations = eligibleObservations(db, asset, nowIso);
  ledger.markShown(observations.map((o) => o.id));
  const report = computeDrivers(asset, observations, nowIso, requiredExtraMetrics(asset));

  const previous = lastCompletedRun(db, asset.id);
  const previousDrivers = previous
    ? describeDrivers(computeDrivers(asset, eligibleObservations(db, asset, previous.startedAt), previous.startedAt, requiredExtraMetrics(asset)), previous.startedAt)
    : null;

  const anomalies = listAnomalies(db, { assetId: asset.id, includeDecided: true });
  const target = input.trigger.anomalyId === undefined ? null : getAnomaly(db, input.trigger.anomalyId);

  const signals = listSignals(db, asset.id, TARGET_HISTORY);
  const horizonEnd = input.now.getTime() + CALENDAR_DAYS * MS_PER_DAY;
  const calendar = calendarEvents(asset);

  const pack: Record<string, unknown> = {
    asset: {
      id: asset.id, symbol: asset.symbol, name: asset.name,
      // What research may write: every metric with no source. A bootstrap works through this list.
      manual_metrics: Object.entries(asset.metrics).filter(([, def]) => def.source === undefined).map(([key]) => key).sort(),
    },
    run: { type: input.runType, now: nowIso, budgets: input.budgets, assumption_set_version: ledger.startSet?.version ?? null },
    trigger: {
      anomaly: target ? describeAnomaly(target) : null,
      // A lead to verify by research. It is not an observation, so it can never be cited as evidence.
      unverified_note: input.trigger.note ?? null,
      // Conditions Orion's own data raised this tick: what to look into first. Details hold Orion's numbers and ids, never text from a model or a page (a calendar note is the user's own YAML).
      triggers_this_tick: (input.trigger.firings ?? []).map((f) => ({ kind: f.kind, key: f.key, fired_at: f.firedAt, detail: f.detail })),
    },
    drivers_now: describeDrivers(report, nowIso),
    drivers_at_previous_run: previousDrivers && { run_started_at: previous?.startedAt, ...previousDrivers },
    observations_in_force: observations.map((o) => ({ id: o.id, metric: o.metricKey, value: o.value, observed_at: o.observedAt, source: o.source, status: o.status })),
    anomalies: {
      open: anomalies.filter((a) => a.status === 'open').map((a) => describeAnomaly(a)),
      acknowledged_read_only: anomalies.filter((a) => a.status === 'acknowledged').map((a) => describeAnomaly(a)),
    },
    assumptions: ledger.startSet ? describeAssumptions(asset, ledger) : 'none yet',
    latest_signal: signals[0] ? describeSignal(signals[0]) : null,
    target_history: signals.map((s) => ({ generated_at: s.generated_at, expected_target_12m: s.horizons?.['12m'].expected_target ?? null, status: s.status })),
    proposals: {
      pending: listProposals(db, { assetId: asset.id }).map(describeProposal),
      recently_decided: recentlyDecidedProposals(db, asset.id, DECIDED_PROPOSALS).map(describeProposal),
    },
    journal: listJournal(db, asset.id, { limit: 3 }),
    // Dated claims earlier runs filed, whose date (`by`, or a range's `to`) is within 30 days of now either way.
    catalysts_due: catalystsDue(db, asset.id, input.now),
    source_failures: listFetchRuns(db, asset.id, FETCH_RUNS).flatMap((run) =>
      run.detail.sources.filter((s) => s.status === 'failed').map((s) => ({ fetch_run_started_at: run.startedAt, source: s.sourceId, error: s.error })),
    ),
    calendar: calendar.filter((e) => {
      const at = Date.parse(e.date);
      return at >= input.now.getTime() - MS_PER_DAY && at <= horizonEnd;
    }),
  };
  if (input.runType !== 'disclosure') return pack;
  const doc = input.document;
  return {
    ...pack,
    // The text is the stored text verbatim; the label says how far to trust it.
    document: doc
      ? { id: doc.id, kind: doc.kind, label: docLabel(doc), source_url: doc.sourceUrl, source_id: doc.sourceId, title: doc.title, published_at: doc.publishedAt, sha256: doc.sha256, text: doc.text }
      : null,
    // Where each of Orion's numbers comes from, in the user's own words, so a finding can be checked against the config.
    asset_config_yaml: input.assetYaml ?? null,
    adapter_params: adapterParams(loaded),
  };
}

interface DueCatalyst {
  journal_id: number;
  event: string;
  kind: CatalystKind;
  by: string | null;
  from: string | null;
  to: string | null;
}

/** From the last 20 journal entries, newest first; days compared at UTC midnight, both ends inclusive. */
function catalystsDue(db: Db, assetId: string, now: Date): DueCatalyst[] {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const window = CATALYST_WINDOW_DAYS * MS_PER_DAY;
  return listJournal(db, assetId, { limit: CATALYST_ENTRIES }).flatMap((entry) =>
    entry.catalysts
      .filter((c) => {
        const at = Date.parse(`${c.by ?? c.to}T00:00:00Z`);
        return at >= today - window && at <= today + window;
      })
      .map((c) => ({ journal_id: entry.id, event: c.event, kind: c.kind, by: c.by ?? null, from: c.from ?? null, to: c.to ?? null })),
  );
}

/** The params each adapter source on the asset accepts, for adapters that document them: what a config proposal may set. */
function adapterParams(loaded: LoadedAsset): { metric: string; adapter: string; params_doc: string }[] {
  const out: { metric: string; adapter: string; params_doc: string }[] = [];
  for (const [metric, def] of Object.entries(loaded.config.metrics).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    for (const source of [def.source, ...(def.cross_checks ?? []).map((c) => c.source)]) {
      if (source?.type !== 'adapter') continue;
      const paramsDoc = getAdapter(source.name).paramsDoc;
      if (paramsDoc !== undefined) out.push({ metric, adapter: source.name, params_doc: paramsDoc });
    }
  }
  return out;
}

/** The first user message. JSON, because every section is data the agent will quote numbers and ids from. */
export function renderContextPack(pack: Record<string, unknown>): string {
  return [
    'This is your context pack for this run. It is the current state of the asset as Orion knows it.',
    'Observation ids listed here may be cited as evidence. Use the read tools for anything more.',
    '',
    JSON.stringify(pack, null, 1),
  ].join('\n');
}
