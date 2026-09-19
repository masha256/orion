import type { AssetConfig } from '../config/schema.js';
import { isChainSource } from '../config/sources.js';
import { OrionError } from '../types.js';
import { sha256 } from '../util/canonical.js';
import { getAdapter } from './adapters/registry.js';
import { DERIVED_NAMES } from './derived.js';
import { sourceId } from './sourceId.js';
import { contractResolver, type SourceRequest } from './types.js';

/** Requests that one source serves together. */
export interface SourceBatch {
  sourceId: string;
  requests: SourceRequest[];
}

/** One metric fed by a transfer scan. `countFrom` holds lowercased sender addresses. */
export interface FlowMember {
  metricKey: string;
  unit: 'usd' | 'tokens';
  countFrom: string[];
  priceCoingeckoId: string | null;
}

/** transfer_flow metrics that share a token, a sink, and an allowlist share one log scan and one cursor. Addresses are lowercased. */
export interface FlowGroup {
  scanKey: string;
  sourceId: string;
  token: string;
  sink: string;
  allowlist: { name: string; address: string }[];
  members: FlowMember[];
}

export interface FetchPlan {
  batches: SourceBatch[];
  flowGroups: FlowGroup[];
  /** Computed from stored observations after the fetch phase. */
  derived: SourceRequest[];
  needsRpc: boolean;
}

export function hasSources(asset: AssetConfig): boolean {
  return Object.values(asset.metrics).some((def) => def.source !== undefined);
}

export function buildPlan(asset: AssetConfig, opts: { metrics?: string[] } = {}): FetchPlan {
  const wanted = opts.metrics && opts.metrics.length > 0 ? new Set(opts.metrics) : null;
  for (const key of wanted ?? []) {
    const def = asset.metrics[key];
    if (!def) throw new OrionError('unknown_metric', `metric "${key}" is not defined in assets/${asset.id}.yaml`);
    if (!def.source) throw new OrionError('no_source', `metric "${key}" has no source; it is entered by hand`);
  }

  const contract = contractResolver(asset);
  const address = (name: string) => contract(name).toLowerCase();
  const batches = new Map<string, SourceBatch>();
  const groups = new Map<string, FlowGroup>();
  const derived: SourceRequest[] = [];
  let needsRpc = false;

  const enqueue = (request: SourceRequest) => {
    const s = request.source;
    if (isChainSource(s) || (s.type === 'adapter' && getAdapter(s.name).needsRpc)) needsRpc = true;
    const id = sourceId(s);
    const batch = batches.get(id) ?? { sourceId: id, requests: [] };
    batch.requests.push(request);
    batches.set(id, batch);
  };

  for (const [metricKey, def] of Object.entries(asset.metrics)) {
    const s = def.source;
    if (!s || (wanted && !wanted.has(metricKey))) continue;

    if (s.type === 'derived') {
      if (!DERIVED_NAMES.includes(s.name)) throw new OrionError('unknown_derived', `metrics.${metricKey}: unknown derived source "${s.name}"`);
      derived.push({ metricKey, role: 'primary', source: s, tolerancePct: def.tolerance_pct });
    } else if (s.type === 'transfer_flow') {
      needsRpc = true;
      const allowlist = [...s.from_allowlist].sort().map((name) => ({ name, address: address(name) }));
      const token = address(s.token);
      const sink = address(s.to);
      const scanKey = sha256(`${token}|${sink}|${allowlist.map((a) => a.address).sort().join(',')}`).slice(0, 16);
      const group = groups.get(scanKey) ?? { scanKey, sourceId: sourceId(s), token, sink, allowlist, members: [] };
      group.members.push({
        metricKey,
        unit: s.unit,
        countFrom: (s.count_from ?? s.from_allowlist).map(address),
        priceCoingeckoId: s.price_coingecko_id ?? null,
      });
      groups.set(scanKey, group);
    } else {
      enqueue({ metricKey, role: 'primary', source: s, tolerancePct: def.tolerance_pct });
    }

    for (const check of def.cross_checks ?? []) {
      enqueue({ metricKey, role: 'cross_check', source: check.source, tolerancePct: check.tolerance_pct ?? def.tolerance_pct });
    }
  }

  if (needsRpc && !asset.ingest) {
    throw new OrionError('invalid_source_config', `assets/${asset.id}.yaml reads from a chain but has no ingest block`);
  }
  return { batches: [...batches.values()], flowGroups: [...groups.values()], derived, needsRpc };
}
