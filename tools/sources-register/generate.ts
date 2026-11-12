/**
 * The sources register (spec 2026-10-28 §2, "Licence check per first-party API"): one row per distinct external source
 * the asset YAMLs read (every HTTP host, each RPC chain by its env var name, each adapter's endpoint, CoinGecko), with its
 * operator and what its terms say about commercial use. The rows come from `assets/*.yaml`; the terms come from TERMS
 * below, which a human edits after reading a terms page. A source an asset reads with no TERMS entry, or a TERMS entry
 * no asset reads, fails generation, so a new asset or adapter cannot slip past the register.
 *
 *   npx tsx tools/sources-register/generate.ts           # rewrite docs/ops/sources-register.md
 *   npx tsx tools/sources-register/generate.ts --check   # exit 1 when the committed file is stale
 *
 * No network: nothing here fetches a terms page. Never put a URL with a key or an RPC URL in TERMS: RPC rows name the
 * environment variable only.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listAssetIds, loadAsset } from '../../src/config/load.js';
import type { AssetConfig } from '../../src/config/schema.js';
import type { SourceConfig } from '../../src/config/sources.js';
import { COINGECKO_API } from '../../src/ingest/sources/coingecko.js';
import { DEFILLAMA_API } from '../../src/ingest/sources/defillama.js';
import { chainInfo } from '../../src/ingest/transport/chains.js';
import { DEFAULT_SOL_RPC_ENV } from '../../src/ingest/transport/solana.js';

export const REGISTER_PATH = 'docs/ops/sources-register.md';

/** Where one source reads: an HTTP URL, an EVM chain's RPC (by env var), or Solana's RPC (by env var). */
export type Endpoint = { kind: 'http'; url: string } | { kind: 'rpc'; chainId: number; env: string } | { kind: 'solana_rpc'; env: string };

export type Kind = 'rpc' | 'first_party_api' | 'third_party' | 'market_data';

export interface Terms {
  /** The row's name in the register. */
  label: string;
  kind: Kind;
  operator: string;
  /** Only a URL the repo or spec already names; blank until a human records it. */
  termsUrl?: string;
  /** `unknown` until a human reads the terms (or the repo/spec quotes them). Anything but `yes` blocks the Phase 5 export. */
  commercial: 'yes' | 'no' | 'unknown';
  /** What the terms say, and where in the repo that is quoted. */
  terms?: string;
  /** A `yes` that holds only once something is done (CoinGecko: the paid plan bought): it blocks the export until then. */
  until?: string;
  /** The day the quoted terms text was checked; blank when nothing is quoted. */
  checked?: string;
  note?: string;
}

const LIGHTER_API = 'https://mainnet.zklighter.elliot.ai/api/v1'; // src/ingest/adapters/lit.ts DEFAULT_API
const LIGHTER_EXPLORER = 'https://explorer.elliot.ai/api'; // src/ingest/adapters/lit.ts DEFAULT_EXPLORER
const LIGHTER_APP = 'https://app.lighter.xyz/stats'; // src/ingest/adapters/lit.ts appFeeShare default
const LLAMA_EMISSIONS = 'https://defillama-datasets.llama.fi/emissions/lighter'; // src/ingest/adapters/lit.ts unlocks default
const HYPERLIQUID_INFO = 'https://api.hyperliquid.xyz/info'; // src/ingest/adapters/hype.ts DEFAULT_INFO_URL

type AdapterParams = Record<string, unknown>;
const str = (params: AdapterParams, key: string, fallback: string): string => (typeof params[key] === 'string' && params[key] !== '' ? (params[key] as string) : fallback);
const http = (url: string): Endpoint => ({ kind: 'http', url });
const chainRpc = (asset: AssetConfig, adapter: string): Endpoint[] => {
  if (asset.ingest === undefined) throw new Error(`asset ${asset.id}: adapter ${adapter} reads the chain but the asset has no ingest block`);
  return [{ kind: 'rpc', chainId: asset.ingest.chain_id, env: asset.ingest.rpc_url_env }];
};
const citationUrl = (params: AdapterParams): string => {
  const c = params.citation;
  return c !== null && typeof c === 'object' && typeof (c as { url?: unknown }).url === 'string' ? (c as { url: string }).url : '';
};
const solRpc = (params: AdapterParams): Endpoint => ({ kind: 'solana_rpc', env: str(params, 'rpc_url_env', DEFAULT_SOL_RPC_ENV) });

/**
 * Every registered adapter's endpoints, as its code reads them (defaults and the params that override them). The test
 * pins that this covers every adapter in src/ingest/adapters/registry.ts, so a new adapter needs a line here.
 */
export const ADAPTER_ENDPOINTS: Record<string, (params: AdapterParams, asset: AssetConfig) => Endpoint[]> = {
  'chain.counter_rate': (_p, a) => chainRpc(a, 'chain.counter_rate'),
  'chain.view_sum': (_p, a) => chainRpc(a, 'chain.view_sum'),
  'chain.v2_pool_twap_price': (_p, a) => chainRpc(a, 'chain.v2_pool_twap_price'),
  'chain.cl_pool_spot_price': (_p, a) => chainRpc(a, 'chain.cl_pool_spot_price'),
  'cake.emission_rate_annual': (_p, a) => chainRpc(a, 'cake.emission_rate_annual'),
  'crv.emission_rate_annual': (_p, a) => chainRpc(a, 'crv.emission_rate_annual'),
  'vvv.staker_emission_share': (_p, a) => chainRpc(a, 'vvv.staker_emission_share'),
  'vvv.diem_target_supply': (_p, a) => chainRpc(a, 'vvv.diem_target_supply'),
  'vvv.staker_share_from_api': (p) => [http(str(p, 'url', ''))],
  'vvv.burn_history_tokens': (p) => [http(str(p, 'url', ''))],
  // The Hyperliquid info URL: params.url, else the asset's external_ids.hyperliquid_info, else the default.
  'hype.total_supply': (p, a) => [http(str(p, 'url', a.external_ids.hyperliquid_info ?? HYPERLIQUID_INFO))],
  'hype.staked_supply': (p, a) => [http(str(p, 'url', a.external_ids.hyperliquid_info ?? HYPERLIQUID_INFO))],
  'hype.emission_rate_annual': (p, a) => [http(str(p, 'url', a.external_ids.hyperliquid_info ?? HYPERLIQUID_INFO))],
  'hype.fund_buys_daily': (p, a) => [http(str(p, 'url', a.external_ids.hyperliquid_info ?? HYPERLIQUID_INFO))],
  'hype.reserve_yield_payments': (p, a) => [http(str(p, 'url', a.external_ids.hyperliquid_info ?? HYPERLIQUID_INFO))],
  'lit.treasury_buys_daily': (p) => [http(str(p, 'api', LIGHTER_API))],
  'lit.exchange_fees_daily': (p) => [http(str(p, 'api', LIGHTER_API))],
  'lit.app_fee_share': (p) => [http(str(p, 'url', LIGHTER_APP))],
  'lit.staking_pool': (p) => [http(str(p, 'api', LIGHTER_API)), http(str(p, 'explorer', LIGHTER_EXPLORER))],
  'lit.unlocks_next_year': (p) => [http(str(p, 'url', LLAMA_EMISSIONS))],
  // Reads nothing: the schedule is in the asset YAML. Its citation url is the source a reader (and the register) checks.
  'schedule.unlocks_next_year': (p) => [http(citationUrl(p))],
  'solana.token_supply': (p) => [solRpc(p)],
  'solana.owner_balance': (p) => [solRpc(p)],
  // The day's price from CoinGecko's market chart; `history` stitches DefiLlama's summary before the first supply read.
  'solana.supply_burn_daily': (p) => [solRpc(p), http(COINGECKO_API), ...(p.history !== undefined ? [http(DEFILLAMA_API)] : [])],
};

/**
 * What each source's terms say, keyed as `sourceKey` keys it. Commercial use is `unknown` unless the repo or the spec
 * quotes the terms; `checked` is set only on those rows. Edit this table after reading a terms page, then regenerate.
 */
export const TERMS: Record<string, Terms> = {
  'api.coingecko.com': {
    label: 'CoinGecko API', kind: 'market_data', operator: 'CoinGecko',
    commercial: 'yes',
    terms: 'paid Basic plan: commercial licence, attribution required, no redistribution of raw data, stored data deleted if the plan lapses (roadmap rule 5)',
    until: 'the paid Basic plan is bought (roadmap rule 5: before launch)',
    checked: '2026-11-05',
    note: 'price, price history and circulating supply only (spec §2 rung market_data); a paid key moves to pro-api.coingecko.com (COINGECKO_PLAN=pro)',
  },
  'api.llama.fi': {
    label: 'DefiLlama API', kind: 'third_party', operator: 'DefiLlama',
    commercial: 'no',
    terms: 'below Enterprise, use is restricted to internal / non-commercial (roadmap rule 1)',
    checked: '2026-11-05',
    note: 'removed per asset in Phase 3; labelled third_party in provenance until then',
  },
  'llama.box': {
    label: 'Llama Airforce API', kind: 'third_party', operator: 'Llama Airforce (community)',
    commercial: 'unknown',
    note: 'no stated licence (spec §11 D4): internal only, labelled third_party, until replaced by on-chain incentive-market scans (Phase 3)',
  },
  'blockworks.com': {
    label: 'Blockworks Token Transparency filing', kind: 'third_party', operator: 'Blockworks',
    commercial: 'unknown',
    note: 'PUMP unlock schedule (schedule.unlocks_next_year citation): compiled by Blockworks, not the issuer (pump.fun publishes no vesting schedule); cited by hand, not read by code',
  },
  'lite-api.jup.ag': {
    label: 'Jupiter price API', kind: 'third_party', operator: 'Jupiter',
    commercial: 'unknown',
    note: 'PUMP price cross-check only (priced from Solana pools)',
  },
  'api.hyperliquid.xyz': {
    label: 'Hyperliquid info API', kind: 'first_party_api', operator: 'Hyperliquid',
    commercial: 'unknown',
    note: 'URL from the asset\'s external_ids.hyperliquid_info',
  },
  'x.com': {
    label: 'Lighter on X (its own post)', kind: 'first_party_api', operator: 'Lighter',
    commercial: 'unknown',
    note: 'LIT unlock schedule (schedule.unlocks_next_year citation): Lighter\'s own post, first party; cited by hand, not read by code',
  },
  'mainnet.zklighter.elliot.ai': {
    label: 'Lighter API (Core)', kind: 'first_party_api', operator: 'Lighter',
    commercial: 'unknown',
  },
  'api.rh.lighter.xyz': {
    label: 'Lighter API (Robinhood instance)', kind: 'first_party_api', operator: 'Lighter',
    commercial: 'unknown',
  },
  'app.lighter.xyz': {
    label: 'Lighter app (stats page bundle)', kind: 'first_party_api', operator: 'Lighter',
    commercial: 'unknown',
    note: 'the Robinhood revenue split constant, read from the page\'s JS chunk',
  },
  'explorer.elliot.ai': {
    label: 'Lighter explorer API', kind: 'first_party_api', operator: 'Lighter',
    commercial: 'unknown',
    note: 'staking pool reward logs (lit.staking_pool)',
  },
  'outerface.venice.ai': {
    label: 'Venice app API', kind: 'first_party_api', operator: 'Venice',
    commercial: 'unknown',
    note: 'VVV supply, staking and burn-history cross-checks',
  },
  'rpc:eip155:1:ORION_ETH_RPC_URL': {
    label: 'Ethereum RPC', kind: 'rpc', operator: 'the provider ORION_ETH_RPC_URL names (chains.ts sizes its log range on Alchemy)',
    commercial: 'unknown',
    note: 'no keyless default: the env var must be set',
  },
  'rpc:eip155:8453:ORION_BASE_RPC_URL': {
    label: 'Base RPC', kind: 'rpc', operator: 'the provider ORION_BASE_RPC_URL names',
    commercial: 'unknown',
    note: 'unset, Orion falls back to the chain\'s public endpoint (src/ingest/transport/chains.ts), whose terms are a second row to check',
  },
  'rpc:eip155:56:ORION_BNB_RPC_URL': {
    label: 'BNB Chain RPC', kind: 'rpc', operator: 'the provider ORION_BNB_RPC_URL names (chains.ts sizes its log range on Alchemy)',
    commercial: 'unknown',
    note: 'no keyless default: the env var must be set',
  },
  'rpc:solana:ORION_SOL_RPC_URL': {
    label: 'Solana RPC', kind: 'rpc', operator: 'the provider ORION_SOL_RPC_URL names (Alchemy, per src/ingest/transport/solana.ts)',
    commercial: 'unknown',
    note: 'unset, Orion falls back to the public Solana endpoint (src/ingest/transport/solana.ts), whose terms are a second row to check',
  },
};

/** The register key of an endpoint: the host for HTTP, the chain and env var for RPC (never a URL). */
export function sourceKey(e: Endpoint): string {
  switch (e.kind) {
    case 'http': {
      if (e.url === '') throw new Error('an adapter source has no URL (a required url param is missing)');
      return new URL(e.url).host;
    }
    case 'rpc':
      return `rpc:eip155:${e.chainId}:${e.env}`;
    case 'solana_rpc':
      return `rpc:solana:${e.env}`;
  }
}

/** One read of a source: which asset, through what (source type or adapter, and its role). */
export interface Use {
  asset: string;
  via: string;
}

function sourceEndpoints(asset: AssetConfig, s: SourceConfig): { endpoint: Endpoint; via: string }[] {
  const rpc = (via: string) => {
    if (asset.ingest === undefined) throw new Error(`asset ${asset.id}: a ${s.type} source needs an ingest block`);
    return [{ endpoint: { kind: 'rpc', chainId: asset.ingest.chain_id, env: asset.ingest.rpc_url_env } as Endpoint, via }];
  };
  switch (s.type) {
    case 'coingecko':
      return [{ endpoint: http(COINGECKO_API), via: 'coingecko' }];
    case 'http_json':
      return [{ endpoint: http(s.url), via: 'http_json' }];
    case 'defillama':
    case 'defillama_share':
      return [{ endpoint: http(DEFILLAMA_API), via: s.type }];
    case 'erc20_supply':
    case 'contract_read':
      return rpc(s.type);
    case 'transfer_flow':
      return [...rpc('transfer_flow'), ...(s.price_coingecko_id !== undefined ? [{ endpoint: http(COINGECKO_API), via: 'transfer_flow pricing' }] : [])];
    case 'adapter': {
      const endpoints = ADAPTER_ENDPOINTS[s.name];
      if (endpoints === undefined) throw new Error(`asset ${asset.id}: adapter ${s.name} has no ADAPTER_ENDPOINTS entry in tools/sources-register/generate.ts`);
      return endpoints(s.params, asset).map((endpoint) => ({ endpoint, via: `adapter ${s.name}` }));
    }
    case 'constant':
    case 'derived':
      return [];
  }
}

/** Every source key the assets read, with who reads it. */
export function collectUses(assets: AssetConfig[]): Map<string, Use[]> {
  const out = new Map<string, Use[]>();
  for (const asset of assets) {
    for (const def of Object.values(asset.metrics)) {
      const sources = [...(def.source ? [{ s: def.source, role: '' }] : []), ...(def.cross_checks ?? []).map((c) => ({ s: c.source, role: ' (cross-check)' }))];
      for (const { s, role } of sources) {
        for (const { endpoint, via } of sourceEndpoints(asset, s)) {
          const key = sourceKey(endpoint);
          const uses = out.get(key) ?? [];
          const use = { asset: asset.id, via: `${via}${role}` };
          if (!uses.some((u) => u.asset === use.asset && u.via === use.via)) uses.push(use);
          out.set(key, uses);
        }
      }
    }
  }
  return out;
}

const KIND_ORDER: Kind[] = ['rpc', 'first_party_api', 'market_data', 'third_party'];
const cell = (s: string | undefined) => (s ?? '').replace(/\|/g, '\\|');

/** The register as markdown. Throws on a source with no TERMS entry and on a TERMS entry no asset reads. */
export function renderRegister(assets: AssetConfig[]): string {
  const uses = collectUses(assets);
  const missing = [...uses.keys()].filter((k) => TERMS[k] === undefined).sort();
  if (missing.length > 0) {
    const who = missing.map((k) => `${k} (read by ${[...new Set(uses.get(k)!.map((u) => u.asset))].join(', ')})`);
    throw new Error(`sources with no register entry: ${who.join('; ')}. Add each to TERMS in tools/sources-register/generate.ts`);
  }
  const stale = Object.keys(TERMS).filter((k) => !uses.has(k)).sort();
  if (stale.length > 0) throw new Error(`register entries no asset reads: ${stale.join(', ')}. Remove them from TERMS in tools/sources-register/generate.ts`);

  const keys = [...uses.keys()].sort((a, b) => KIND_ORDER.indexOf(TERMS[a]!.kind) - KIND_ORDER.indexOf(TERMS[b]!.kind) || a.localeCompare(b));
  const rpcName = (k: string) => {
    const [, family, id, env] = k.split(':');
    const chain = family === 'eip155' ? `eip155:${id} (${chainInfo(Number(id))?.name ?? 'unknown chain'})` : 'solana';
    return `${chain} via \`${family === 'eip155' ? env : id}\``;
  };
  const sourceCell = (k: string) => (TERMS[k]!.kind === 'rpc' ? rpcName(k) : `\`${k}\``);
  const usedBy = (k: string) => {
    const byAsset = new Map<string, string[]>();
    for (const u of uses.get(k)!) byAsset.set(u.asset, [...(byAsset.get(u.asset) ?? []), u.via]);
    return [...byAsset.keys()].sort().map((a) => `${a}: ${[...byAsset.get(a)!].sort().join(', ')}`).join('; ');
  };
  const commercialCell = (t: Terms) => [t.commercial, t.terms ? `: ${t.terms}` : '', t.until ? `; blocks the export until ${t.until}` : ''].join('');
  const blocks = (t: Terms) => t.commercial !== 'yes' || t.until !== undefined;

  const lines: string[] = [];
  lines.push('# Sources register');
  lines.push('');
  lines.push('<!-- Generated by tools/sources-register/generate.ts from assets/*.yaml. Do not edit by hand: edit TERMS in the');
  lines.push('     script, then run `npx tsx tools/sources-register/generate.ts` (`--check` fails when this file is stale;');
  lines.push('     tests/tools/sourcesRegister.test.ts runs the same comparison). -->');
  lines.push('');
  lines.push('Every external source the asset configs read, one row each: every HTTP host, each RPC by chain and the environment');
  lines.push('variable that holds its URL (never the URL: RPC URLs carry keys), each adapter\'s endpoint, and CoinGecko (spec');
  lines.push('2026-10-28 §2, "Licence check per first-party API").');
  lines.push('');
  lines.push('- **Commercial use** is `unknown` until a human reads the source\'s terms page and records what it says here (with');
  lines.push('  the terms URL and the date read). Only rows whose terms are quoted in the repo or spec are filled today: CoinGecko');
  lines.push('  (roadmap rule 5) and DefiLlama (roadmap rule 1). Nothing in this file was fetched from the network.');
  lines.push('- **`unknown` or `no` blocks only the Phase 5 site export** for the assets that read the source (table 2). Ingest');
  lines.push('  and internal reports are never blocked by it.');
  lines.push('- A source a new asset reads with no row fails generation, so onboarding cannot skip this step.');
  lines.push('');
  lines.push('## 1. Sources');
  lines.push('');
  lines.push('| Source | Kind | Operator | Terms URL | Commercial use | Date checked | Used by | Notes |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const k of keys) {
    const t = TERMS[k]!;
    lines.push(`| ${[t.label + ': ' + sourceCell(k), `\`${t.kind}\``, t.operator, t.termsUrl, commercialCell(t), t.checked, usedBy(k), t.note].map(cell).join(' | ')} |`);
  }
  lines.push('');
  lines.push('## 2. What blocks each asset\'s site export');
  lines.push('');
  lines.push('A source listed here must turn `yes` (and meet its condition) before Phase 5 exports that asset, or the asset must');
  lines.push('stop reading it (Phase 3 removes DefiLlama).');
  lines.push('');
  lines.push('| Asset | Commercial use `unknown` | Commercial use `no` | `yes`, on a condition |');
  lines.push('|---|---|---|---|');
  for (const asset of [...assets].map((a) => a.id).sort()) {
    const mine = keys.filter((k) => uses.get(k)!.some((u) => u.asset === asset) && blocks(TERMS[k]!));
    const label = (k: string) => (TERMS[k]!.kind === 'rpc' ? TERMS[k]!.label : `\`${k}\``);
    const of = (c: Terms['commercial'], until: boolean) => mine.filter((k) => TERMS[k]!.commercial === c && (TERMS[k]!.until !== undefined) === until).map(label).join(', ');
    lines.push(`| ${[asset, of('unknown', false), of('no', false), of('yes', true)].map(cell).join(' | ')} |`);
  }
  lines.push('');
  return lines.join('\n');
}

/** The assets in `<root>/assets`, parsed the way Orion loads them. */
export function loadAssets(root: string): AssetConfig[] {
  return listAssetIds(root).map((id) => loadAsset(root, id).config);
}

/** True when the committed register equals what the assets generate. */
export function registerIsCurrent(root: string): boolean {
  return readFileSync(join(root, REGISTER_PATH), 'utf8') === renderRegister(loadAssets(root));
}

function main(argv: string[]): number {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  if (argv.includes('--check')) {
    if (registerIsCurrent(root)) return 0;
    process.stderr.write(`${REGISTER_PATH} is stale: run npx tsx tools/sources-register/generate.ts\n`);
    return 1;
  }
  writeFileSync(join(root, REGISTER_PATH), renderRegister(loadAssets(root)));
  process.stdout.write(`wrote ${REGISTER_PATH}\n`);
  return 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
