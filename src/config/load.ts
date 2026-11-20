import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml, YAMLParseError } from 'yaml';
import { ZodError } from 'zod';
import { findAdapter } from '../ingest/adapters/registry.js';
import { entriesFor, loadPrices, PRICES_FILE, usdFlowRefs, type PriceEntry } from '../prices/config.js';
import { notePriceVenues } from '../prices/venue.js';
import { OrionError } from '../types.js';
import { canonicalJson, sha256 } from '../util/canonical.js';
import { AssetConfigSchema, type AssetConfig } from './schema.js';
import { coingeckoIssues } from './sources.js';
import { isReleaseRoot } from '../cli/paths.js';

export interface LoadedAsset {
  config: AssetConfig;
  hash: string;
  /** The object as written, before schema defaults. Absent when a caller built the LoadedAsset by hand. */
  raw?: unknown;
  /**
   * The prices.yaml the asset was loaded with (its config root's): the chain price writer a fetch runs reads its refs
   * here. Absent when parsed without one (a test's hand-built asset); such a fetch needs FetchDeps.priceWriter.
   */
  prices?: ReadonlyMap<string, PriceEntry>;
}

/** What a config proposal's paths and filed-against values refer to: the config as written, else as parsed. */
export function rawConfig(loaded: LoadedAsset): unknown {
  return loaded.raw ?? loaded.config;
}

/**
 * Parses and validates an asset object. The hash input is the parsed config plus the `prices.yaml` entries of every ref
 * it uses (entriesFor, sorted by ref), so a price-method change moves the hash of exactly the assets that read it. With
 * no entries (no prices map, or none of its refs) the hash is the config's alone, as before prices.yaml.
 */
export function parseAssetObject(obj: unknown, prices?: ReadonlyMap<string, PriceEntry>): LoadedAsset {
  let config: AssetConfig;
  try {
    config = AssetConfigSchema.parse(obj);
  } catch (err) {
    if (err instanceof ZodError) {
      const lines = err.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
      throw new OrionError('invalid_asset_config', lines.join('\n'));
    }
    throw err;
  }
  // Ruling R32(a): a config root whose prices.yaml is missing, empty or comment-only (an empty map) cannot price the
  // chain-priced sources: refused by name, everywhere (dev and test included), never loaded with a config-only hash.
  if (prices && prices.size === 0) {
    const needs = chainPricedSources(config);
    if (needs.length > 0) throw new OrionError('invalid_asset_config', needs.map((n) => `${n}: reads a chain price, but prices.yaml has no entries (missing, empty or comment-only)`).join('\n'));
  }
  const paramIssues = adapterParamIssues(config, prices);
  if (paramIssues.length > 0) throw new OrionError('invalid_asset_config', paramIssues.join('\n'));
  if (prices && prices.size > 0) {
    // No CoinGecko read (Phase 3 R2, Ruling R24: the price; R3: every field): a config root with prices.yaml entries refuses one by name, at load,
    // at a proposal's filing (the run's prices) and at its approve (the home's). A release root or ORION_ENV stage/prod
    // always has entries (R32(b): loadAsset refuses otherwise), so there this always runs; a dev/test root without
    // entries keeps its old behaviour (R32(b)), its chain-priced assets refused above (R32(a)).
    const cg = coingeckoIssues(config);
    if (cg.length > 0) throw new OrionError('invalid_asset_config', cg.join('\n'));
    // Every usd transfer_flow is valued at its token's chain price (Phase 3 R2): the ref must be priced in prices.yaml.
    const unpriced = usdFlowRefs(config).filter((u) => !prices.has(u.ref));
    if (unpriced.length > 0) {
      throw new OrionError('invalid_asset_config', unpriced.map((u) => `metrics.${u.metricKey}.source: ${u.contract} (${u.ref}) has no entry in prices.yaml; a transfer_flow with unit usd is valued at its chain price`).join('\n'));
    }
  }
  // The rung and chain of each price.* source come from its ref's prices.yaml method (src/prices/venue.ts).
  if (prices) notePriceVenues(config.metrics, prices);
  const entries = prices ? entriesFor(config, prices) : [];
  return { config, hash: sha256(canonicalJson(entries.length === 0 ? config : { config, prices: entries })), raw: obj, ...(prices ? { prices } : {}) };
}

/** Where the asset reads a chain price: every price.token / price.token_check source and every `unit: usd` transfer_flow. */
function chainPricedSources(config: AssetConfig): string[] {
  const out: string[] = [];
  for (const [key, def] of Object.entries(config.metrics)) {
    const sources = [{ where: `metrics.${key}.source`, source: def.source }, ...(def.cross_checks ?? []).map((c, i) => ({ where: `metrics.${key}.cross_checks.${i}.source`, source: c.source }))];
    for (const { where, source } of sources) {
      if (source?.type === 'adapter' && (source.name === 'price.token' || source.name === 'price.token_check')) out.push(`${where} (${source.name})`);
      if (source?.type === 'transfer_flow' && source.unit === 'usd') out.push(`${where} (transfer_flow, unit usd)`);
    }
  }
  return out;
}

/**
 * Ruling R32(b): a release root (a RELEASE file, as src/cli/paths.ts tells one) or ORION_ENV stage/prod is strict: its
 * prices.yaml must exist with at least one entry, or every asset load refuses (AERO's own-token entry included); with
 * entries, the CoinGecko price refusal and the price-ref checks of parseAssetObject always run there.
 */
function strictPricesRoot(home: string): boolean {
  const env = process.env.ORION_ENV;
  return env === 'stage' || env === 'prod' || isReleaseRoot(home);
}

/** Every adapter source (primary and cross-check) whose adapter validates its params, checked. Unknown names are left to ingest. */
function adapterParamIssues(config: AssetConfig, prices: ReadonlyMap<string, PriceEntry> | undefined): string[] {
  const issues: string[] = [];
  for (const [key, def] of Object.entries(config.metrics)) {
    const sources = [{ where: `metrics.${key}.source`, source: def.source }, ...(def.cross_checks ?? []).map((c, i) => ({ where: `metrics.${key}.cross_checks.${i}.source`, source: c.source }))];
    for (const { where, source } of sources) {
      if (source?.type !== 'adapter') continue;
      const validate = findAdapter(source.name)?.validateParams;
      if (validate) for (const e of validate(source.params, prices ? { prices } : {})) issues.push(`${where}.params: ${e}`);
    }
  }
  return issues;
}

export function parseAssetYaml(text: string, prices?: ReadonlyMap<string, PriceEntry>): LoadedAsset {
  return parseAssetObject(parseYaml(text), prices);
}

export function listAssetIds(home: string): string[] {
  const dir = join(home, 'assets');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => f.slice(0, -'.yaml'.length))
    .sort();
}

export function loadAsset(home: string, id: string): LoadedAsset {
  const path = join(home, 'assets', `${id}.yaml`);
  if (!existsSync(path)) throw new OrionError('asset_not_found', `no asset config at ${path}`);
  const prices = loadPrices(home);
  if (prices.size === 0 && strictPricesRoot(home)) {
    const file = join(home, PRICES_FILE);
    const state = existsSync(file) ? 'has no entries' : 'is missing';
    throw new OrionError('invalid_price_config', `${file} ${state}: a release (or ORION_ENV stage/prod) needs prices.yaml with at least one entry; ${id} is not loaded`);
  }
  let loaded: LoadedAsset;
  try {
    loaded = parseAssetYaml(readFileSync(path, 'utf8'), prices);
  } catch (err) {
    // A syntax error is a config error like any other: named by file and line, so `asset validate` lists it.
    if (err instanceof YAMLParseError) {
      const line = err.linePos?.[0]?.line;
      throw new OrionError('invalid_asset_config', `${path}: not valid YAML${line === undefined ? '' : ` at line ${line}`}: ${err.message.split('\n')[0]}`);
    }
    throw err;
  }
  if (loaded.config.id !== id) {
    throw new OrionError('invalid_asset_config', `${path}: id "${loaded.config.id}" does not match the file name`);
  }
  return loaded;
}
