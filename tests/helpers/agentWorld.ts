import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CitableDoc, FetchedPage } from '../../src/agent/guardrails.js';
import { Ledger } from '../../src/agent/ledger.js';
import { AGENT_TOOLS, runTool, type ToolContext } from '../../src/agent/tools/index.js';
import { budgetsFor } from '../../src/config/agentPolicy.js';
import { parseAssetYaml, type LoadedAsset } from '../../src/config/load.js';
import { assignPersona } from '../../src/db/coverage.js';
import { openDb, type Db } from '../../src/db/connection.js';
import { insertDocument, type StoredDocument } from '../../src/db/documents.js';
import { insertObservation } from '../../src/db/observations.js';
import { MINI_ASSET_YAML } from './assets.js';
import { AS_OF, miniObservations } from './obs.js';

/**
 * The mini asset as an agent sees it: revenue is critical, manual, and allows provisional data (like VVV's); the price is
 * fetched; staked supply is manual and does not allow provisional data. The base band on rev_growth_y1 is only YAML a
 * config proposal can edit: nothing reads bands any more.
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

/** The run's target document: an issuer post, stored as document 1. It carries QUOTE and STAKED_QUOTE, each in its own paragraph. */
export const DOC_TEXT = 'Mini said its annualized revenue reached $1,100 in September, up from $1,000.\n\nStaked supply now stands at 55 tokens across the network.\n';
export const STAKED_QUOTE = 'Staked supply now stands at 55 tokens across the network.';
/** A citation of the target document, as the model writes it. */
export const DOC_CITE = { source: 'doc:1', quoted_text: QUOTE };

export interface AgentWorld {
  db: Db;
  loaded: LoadedAsset;
  ledger: Ledger;
  ctx: ToolContext;
  /** Observation id by metric key, for the seeded rows. */
  ids: Record<string, number>;
  pages: FetchedPage[];
  /** The run's target document, stored as document 1. */
  doc: StoredDocument;
  /** Runs a tool the way the loop does, and parses the JSON result. */
  call: (name: string, input: unknown) => { isError: boolean; result: Record<string, unknown> };
}

export const citable = (d: Pick<StoredDocument, 'id' | 'kind' | 'sha256' | 'text'>): CitableDoc => ({ id: d.id, kind: d.kind, sha256: d.sha256, text: d.text });

/** A disclosure run on the mini asset: the seeded observations, the target document, and no assumption set (none is needed). */
export function agentWorld(yaml: string = AGENT_ASSET_YAML): AgentWorld {
  const db = openDb(':memory:');
  const loaded = parseAssetYaml(yaml);
  const ids: Record<string, number> = {};
  for (const o of miniObservations()) {
    ids[o.metricKey] = insertObservation(db, {
      assetId: o.assetId, metricKey: o.metricKey, observedAt: o.observedAt, periodDays: o.periodDays, value: o.value, source: o.source, fetchedAt: o.fetchedAt,
    }).id;
  }
  const doc = insertDocument(db, {
    assetId: 'mini', kind: 'post', sourceUrl: 'https://x.com/mini/status/1', sourceId: null, title: null, publishedAt: '2026-06-29T00:00:00.000Z',
    addedAt: AS_OF, meta: {}, text: DOC_TEXT,
  }).doc;
  const ledger = new Ledger('mini', 'analyst');
  const pages: FetchedPage[] = [{ url: PAGE_URL, text: PAGE_TEXT }];
  const target = citable(doc);
  const ctx: ToolContext = {
    db, loaded, ledger, now: () => new Date(AS_OF), budgets: budgetsFor(loaded.config, 'disclosure'), runType: 'disclosure', fetchedPages: () => pages,
    citableDocs: () => [target],
    targetDoc: target,
  };
  const call = (name: string, input: unknown) => {
    const outcome = runTool(AGENT_TOOLS, ctx, name, input);
    return { isError: outcome.isError, result: JSON.parse(outcome.content) as Record<string, unknown> };
  };
  return { db, loaded, ledger, ctx, ids, pages, doc, call };
}

export const PERSONA_MD = `---
name: analyst
temperament: skeptical
sectors: [test-assets]
---
You are the analyst covering the mini test asset.
`;

const skillMd = (name: string, runTypes: string): string => `---
name: ${name}
description: How to do ${name}.
run_types: [${runTypes}]
---
Instructions for ${name}.
`;

/** A temp ORION_HOME with one persona and the two disclosure skills, and the persona assigned to the mini asset in `db`. */
export function agentHome(db: Db): string {
  const home = mkdtempSync(join(tmpdir(), 'orion-agent-'));
  mkdirSync(join(home, 'personas'));
  mkdirSync(join(home, 'skills'));
  writeFileSync(join(home, 'personas', 'analyst.md'), PERSONA_MD);
  writeFileSync(join(home, 'skills', 'disclosure-review.md'), skillMd('disclosure-review', 'disclosure'));
  writeFileSync(join(home, 'skills', 'disclosure-research.md'), skillMd('disclosure-research', 'disclosure'));
  assignPersona(db, 'mini', 'analyst', AS_OF);
  return home;
}
