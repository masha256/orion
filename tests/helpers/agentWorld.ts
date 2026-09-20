import type { FetchedPage } from '../../src/agent/guardrails.js';
import { Ledger } from '../../src/agent/ledger.js';
import { AGENT_TOOLS, runTool, type ToolContext } from '../../src/agent/tools/index.js';
import { budgetsFor } from '../../src/config/agentPolicy.js';
import { parseAssetYaml, type LoadedAsset } from '../../src/config/load.js';
import { createAssumptionSet } from '../../src/db/assumptions.js';
import { openDb, type Db } from '../../src/db/connection.js';
import { insertObservation } from '../../src/db/observations.js';
import { MINI_ASSET_YAML, miniAssumptions } from './assets.js';
import { AS_OF, miniObservations } from './obs.js';

/**
 * The mini asset as an agent sees it: revenue is critical, manual, and allows provisional data (like VVV's); the price is
 * fetched; staked supply is manual and does not allow provisional data; base revenue growth has an agent band of [0, 1]
 * (so the default step is 0.25) and the other scenarios fall back to the key-wide bounds.
 */
export const AGENT_ASSET_YAML = MINI_ASSET_YAML
  .replace(
    'price_usd: { type: level, unit: usd, staleness_days: 3, critical: true }',
    'price_usd: { type: level, unit: usd, staleness_days: 3, critical: true, source: { type: coingecko, id: mini, field: price } }',
  )
  .replace(
    'revenue_run_rate_usd: { type: level, unit: usd, staleness_days: 60, critical: true }',
    'revenue_run_rate_usd: { type: level, unit: usd, staleness_days: 60, critical: true, allow_provisional: true }',
  )
  .replace('rev_growth_y1: { min: -0.5, max: 5 }', 'rev_growth_y1: { min: -0.5, max: 5, base: { min: 0, max: 1 } }');

export const PAGE_URL = 'https://news.example.com/mini-revenue';
export const PAGE_TEXT = '<p>Mini said its annualized revenue reached <b>$1,100</b> in September, up from $1,000.</p>';
export const QUOTE = 'annualized revenue reached $1,100 in September';

export interface AgentWorld {
  db: Db;
  loaded: LoadedAsset;
  ledger: Ledger;
  ctx: ToolContext;
  /** Observation id by metric key, for the seeded rows. */
  ids: Record<string, number>;
  pages: FetchedPage[];
  /** Runs a tool the way the loop does, and parses the JSON result. */
  call: (name: string, input: unknown) => { isError: boolean; result: Record<string, unknown> };
}

export function agentWorld(yaml: string = AGENT_ASSET_YAML, assumptionsOver: Partial<Record<string, number>> = {}): AgentWorld {
  const db = openDb(':memory:');
  const loaded = parseAssetYaml(yaml);
  const ids: Record<string, number> = {};
  for (const o of miniObservations()) {
    ids[o.metricKey] = insertObservation(db, {
      assetId: o.assetId, metricKey: o.metricKey, observedAt: o.observedAt, periodDays: o.periodDays, value: o.value, source: o.source, fetchedAt: o.fetchedAt,
    }).id;
  }
  const set = createAssumptionSet(db, { assetId: 'mini', author: 'user', rationale: 'initial', values: miniAssumptions(assumptionsOver), createdAt: AS_OF });
  const ledger = new Ledger('mini', 'analyst', set);
  const pages: FetchedPage[] = [{ url: PAGE_URL, text: PAGE_TEXT }];
  const ctx: ToolContext = { db, loaded, ledger, now: () => new Date(AS_OF), budgets: budgetsFor(loaded.config, 'weekly'), fetchedPages: () => pages };
  const call = (name: string, input: unknown) => {
    const outcome = runTool(AGENT_TOOLS, ctx, name, input);
    return { isError: outcome.isError, result: JSON.parse(outcome.content) as Record<string, unknown> };
  };
  return { db, loaded, ledger, ctx, ids, pages, call };
}
