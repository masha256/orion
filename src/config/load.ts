import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { ZodError } from 'zod';
import { findAdapter } from '../ingest/adapters/registry.js';
import { OrionError } from '../types.js';
import { canonicalJson, sha256 } from '../util/canonical.js';
import { AssetConfigSchema, type AssetConfig } from './schema.js';

export interface LoadedAsset {
  config: AssetConfig;
  hash: string;
  /** The object as written, before schema defaults. Absent when a caller built the LoadedAsset by hand. */
  raw?: unknown;
}

/** What a config proposal's paths and filed-against values refer to: the config as written, else as parsed. */
export function rawConfig(loaded: LoadedAsset): unknown {
  return loaded.raw ?? loaded.config;
}

export function parseAssetObject(obj: unknown): LoadedAsset {
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
  const paramIssues = adapterParamIssues(config);
  if (paramIssues.length > 0) throw new OrionError('invalid_asset_config', paramIssues.join('\n'));
  return { config, hash: sha256(canonicalJson(config)), raw: obj };
}

/** Every adapter source (primary and cross-check) whose adapter validates its params, checked. Unknown names are left to ingest. */
function adapterParamIssues(config: AssetConfig): string[] {
  const issues: string[] = [];
  for (const [key, def] of Object.entries(config.metrics)) {
    const sources = [{ where: `metrics.${key}.source`, source: def.source }, ...(def.cross_checks ?? []).map((c, i) => ({ where: `metrics.${key}.cross_checks.${i}.source`, source: c.source }))];
    for (const { where, source } of sources) {
      if (source?.type !== 'adapter') continue;
      const validate = findAdapter(source.name)?.validateParams;
      if (validate) for (const e of validate(source.params)) issues.push(`${where}.params: ${e}`);
    }
  }
  return issues;
}

export function parseAssetYaml(text: string): LoadedAsset {
  return parseAssetObject(parseYaml(text));
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
  const loaded = parseAssetYaml(readFileSync(path, 'utf8'));
  if (loaded.config.id !== id) {
    throw new OrionError('invalid_asset_config', `${path}: id "${loaded.config.id}" does not match the file name`);
  }
  return loaded;
}
