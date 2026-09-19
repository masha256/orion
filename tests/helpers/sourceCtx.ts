import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { SourceConfig } from '../../src/config/sources.js';
import { contractResolver, type SourceContext, type SourceRequest } from '../../src/ingest/types.js';
import { fakeHttp } from './fakeHttp.js';
import { ingestAsset } from './ingestAsset.js';

export const NOW_ISO = '2026-09-19T20:30:00.000Z';

/** A real response captured by the 2026-09-19 research pass. */
export function fixture(name: string): unknown {
  const path = fileURLToPath(new URL(`../fixtures/ingest/research-2026-09-19/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

export function sourceCtx(over: Partial<SourceContext> = {}): SourceContext {
  const asset = over.asset ?? ingestAsset().config;
  return { asset, nowIso: NOW_ISO, http: fakeHttp({}), rpc: null, block: null, env: {}, contract: contractResolver(asset), ...over };
}

export function req(metricKey: string, source: SourceConfig, role: SourceRequest['role'] = 'primary', tolerancePct = 1): SourceRequest {
  return { metricKey, role, source, tolerancePct };
}
