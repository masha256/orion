import type { SourceConfig } from '../../config/sources.js';
import { OrionError } from '../../types.js';
import type { SourceHandler } from '../types.js';
import { adapterSource } from './adapter.js';
import { coingeckoSource } from './coingecko.js';
import { defillamaSource } from './defillama.js';
import { httpJsonSource } from './httpJson.js';

/** Batch handlers by source type. transfer_flow and derived are not batch handlers: fetchAsset runs them itself. */
const HANDLERS: Partial<Record<SourceConfig['type'], SourceHandler>> = {
  coingecko: coingeckoSource,
  http_json: httpJsonSource,
  defillama: defillamaSource,
  adapter: adapterSource,
};

export function getSourceHandler(type: SourceConfig['type']): SourceHandler {
  const handler = HANDLERS[type];
  if (!handler) throw new OrionError('unknown_source_type', `no batch handler for source type "${type}"`);
  return handler;
}
