import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { holderFlowMetrics } from '../../src/config/incomeStatement.js';
import { listAssetIds, loadAsset, parseAssetObject, parseAssetYaml } from '../../src/config/load.js';
import { registerAdapter } from '../../src/ingest/adapters/registry.js';
import { entriesFor, loadPrices } from '../../src/prices/config.js';
import { yieldReport } from '../../src/report/load.js';
import { canonicalJson, sha256 } from '../../src/util/canonical.js';
import { MINI_ASSET_YAML, MINI_HOLDER_YAML } from '../helpers/assets.js';
import { syntheticInput } from '../helpers/syntheticReport.js';
import { INGEST_ASSET_YAML } from '../helpers/ingestAsset.js';

/** The mini ingest asset: a CoinGecko price_usd (refused wherever prices.yaml has entries) and usd transfer_flows. */
const MINI_CG_PRICE = INGEST_ASSET_YAML.replace('id: mini\n', 'id: cg\n');
const MINI_FLOW_ONLY = INGEST_ASSET_YAML;

describe('canonicalJson', () => {
  it('sorts object keys recursively and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, 1], c: null } })).toBe('{"a":{"c":null,"d":[2,1]},"b":1}');
  });
});

describe('parseAssetYaml', () => {
  it('parses a valid asset and applies defaults', () => {
    const { config, hash } = parseAssetYaml(MINI_ASSET_YAML);
    expect(config.contracts).toEqual({});
    expect(config.external_ids).toEqual({});
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('pins the mini fixture\'s parsed-config hash, so no schema default is added silently', () => {
    // A new default changes every parsed config, and so every asset's config hash. Moving this pin must be on purpose.
    // Re-pinned (Task 11, G4): MINI lost its holder_flows block (retired).
    expect(parseAssetYaml(MINI_ASSET_YAML).hash).toBe('5b2f690b96353007bc31b9d29996ed078d92a0404e64f7d05e36ff2b81ae8021');
  });

  it('gives the same hash regardless of YAML key order', () => {
    const reordered = MINI_ASSET_YAML.replace('id: mini\nsymbol: MINI', 'symbol: MINI\nid: mini');
    expect(parseAssetYaml(reordered).hash).toBe(parseAssetYaml(MINI_ASSET_YAML).hash);
  });

  it('rejects a holder-flow line whose metric is not a flow metric', () => {
    const bad = MINI_HOLDER_YAML.replace('metric: flow_usd.fees, bucket', 'metric: price_usd, bucket');
    expect(bad).not.toBe(MINI_HOLDER_YAML);
    expect(() => parseAssetYaml(bad)).toThrow(/holders\.fees metric "price_usd" is not a flow metric/);
  });

  it('rejects unknown top-level keys', () => {
    expect(() => parseAssetYaml(MINI_ASSET_YAML + '\nsurprise: true\n')).toThrow();
  });

  // Task 11 (G4, ruling R11.1): the retired keys are gone from the schema, so the strict root refuses them by name.
  it.each([
    ['holder_flows', 'holder_flows:\n  - { id: fees, kind: fee_share, capture_rule: contractual, recipient_base: all, metric: flow_usd.fees }\n'],
    ['reporting', 'reporting:\n  window_days: 90\n  haircuts: { fees: 0 }\n'],
  ])('refuses the retired %s key by name at load', (key, block) => {
    expect(() => parseAssetYaml(`${MINI_HOLDER_YAML}${block}`)).toThrow(new RegExp(`\\(root\\): Unrecognized key: "${key}"`));
  });

  it('loads an asset that pays its holders nothing (no holder flow at all: the Lido case, template T10)', () => {
    const { config } = parseAssetYaml(MINI_ASSET_YAML);
    expect(config.income_statement).toBeUndefined();
  });

  // Fix round 1, M4: template T10's shape, an income statement with revenue and the remainder to the protocol and no
  // `holders` section. It loads, and the report pins what the code does today: holder yield 0 (a number, never null and
  // never a statement error), an empty holder flow with no bucket, no flags, payout ratio 0, the revenue all protocol.
  it('the Lido shape (T10: revenue, remainder: protocol, no holders) loads and reports holder yield 0', () => {
    const yaml = `${MINI_ASSET_YAML}income_statement:\n  category: lst\n  scope: complete\n  window_days: 91\n  revenue:\n    - { id: fees_rev, metric: flow_usd.fees }\n  remainder: protocol\n`;
    const { config } = parseAssetYaml(yaml);
    expect(config.income_statement!.holders).toBeUndefined();
    expect(holderFlowMetrics(config.income_statement)).toEqual([]);
    const r = yieldReport(syntheticInput(config));
    expect(r.incomeStatementError).toBeUndefined();
    const is = r.incomeStatement!;
    expect(is.yields).toMatchObject({ cash: 0, buyback: 0, shareholder: 0, multiple: null });
    expect(is.yields.netShareholder).toBe(-is.yields.dilution!);
    expect(is.holderFlow).toMatchObject({ gross: 0, net: 0, fromRevenue: 0, fromBelowLine: 0, notMeasured: [], lines: [], byBucket: { burn: null, hold: null, cash: null } });
    expect(is.flags).toEqual([]);
    expect(is.ratios).toEqual({ takeRate: 1, payoutRatio: 0, payoutRatioBasis: 'grossProfit' });
    expect(is.multiples.mcapToHolderFlow.total).toBeNull();
    expect(is.protocol.remainder).toBe(true);
    expect(is.protocol.annualized).toBeCloseTo(is.revenue.annualized!, 6);
    expect(is.revenue.annualized).toBeGreaterThan(0);
  });
});

describe('loadAsset', () => {
  it('load: a YAML syntax error is invalid_asset_config naming the file and the line', () => {
    const root = mkdtempSync(join(tmpdir(), 'orion-load-'));
    try {
      mkdirSync(join(root, 'assets'));
      writeFileSync(join(root, 'assets', 'bad.yaml'), 'id: bad\nsymbol: BAD\nname: [unclosed\n');
      let caught: unknown;
      try {
        loadAsset(root, 'bad');
      } catch (err) {
        caught = err;
      }
      expect(caught).toMatchObject({ code: 'invalid_asset_config' });
      const msg = (caught as Error).message;
      expect(msg.startsWith(`${join(root, 'assets', 'bad.yaml')}: not valid YAML at line `)).toBe(true);
      expect(msg).toMatch(/: not valid YAML at line \d+: /);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('the valuation config keys are gone', () => {
  const messageOf = (yaml: string): string => {
    try {
      parseAssetYaml(yaml);
    } catch (err) {
      return (err as Error).message;
    }
    return '';
  };

  it('schema: each removed key is refused by name', () => {
    // A stale YAML (an old branch, a hand edit) must fail loudly and say which key, not load with the key ignored.
    const stale: [string, string][] = [
      ['modules', 'modules:\n  - { id: hc, type: holder_cashflow, kind: estimate, weight: 1 }\n'],
      ['assumptions', 'assumptions:\n  rev_growth_y1: { min: -0.5, max: 5 }\n'],
      ['scenario_probabilities', 'scenario_probabilities: { bear: 0.25, base: 0.5, bull: 0.25 }\n'],
      ['review_triggers', 'review_triggers:\n  provisional_move_pct: 25\n'],
      ['peer_set', 'peer_set: []\n'],
      ['total_return_variants', 'total_return_variants: []\n'],
      ['supply_basis', 'supply_basis: effective_total\n'],
      ['cadence', 'agent:\n  cadence: { weekly_days: 7 }\n'],
      ['max_step_fraction', 'agent:\n  max_step_fraction: 0.25\n'],
      ['weekly', 'agent:\n  budgets:\n    weekly: { input_tokens: 2000000 }\n'],
    ];
    for (const [key, snippet] of stale) {
      const message = messageOf(`${MINI_ASSET_YAML}${snippet}`);
      expect(message, key).toContain(`Unrecognized key: "${key}"`);
    }
    expect(messageOf(`${MINI_ASSET_YAML}agent:\n  cadence: { weekly_days: 7 }\n`)).toMatch(/^agent: /);
    expect(messageOf(`${MINI_ASSET_YAML}agent:\n  budgets:\n    weekly: { input_tokens: 2000000 }\n`)).toMatch(/^agent\.budgets: /);
    // The one budget kept: the disclosure run's.
    expect(messageOf(`${MINI_ASSET_YAML}agent:\n  budgets:\n    disclosure: { input_tokens: 2000000 }\n`)).toBe('');
  });

  it('schema: an asset without revenue_run_rate_usd loads', () => {
    const yaml = MINI_ASSET_YAML.replace(/^ {2}revenue_run_rate_usd:.*\n/m, '');
    expect(yaml).not.toContain('revenue_run_rate_usd');
    expect(parseAssetYaml(yaml).config.metrics.revenue_run_rate_usd).toBeUndefined();
    // Nor is staker_emission_share required any more (D1(a): kept on the 13 assets, dropped from the required list).
    expect(() => parseAssetYaml(yaml.replace(/^ {2}staker_emission_share:.*\n/m, ''))).not.toThrow();
  });

  it('schema: an asset without price_usd is refused', () => {
    // The four the report reads stay required.
    for (const key of ['price_usd', 'total_supply', 'staked_supply', 'emission_rate_annual']) {
      const yaml = MINI_ASSET_YAML.replace(new RegExp(`^ {2}${key}:.*\\n`, 'm'), '');
      expect(messageOf(yaml), key).toContain(`required standard metric "${key}" is not defined`);
    }
  });

  it('schema: a standard or holder-flow metric cannot be monitor_only', () => {
    // flow_usd.fees is a holder flow through MINI_HOLDER_YAML's holders line (Task 11: income_statement, not
    // holder_flows).
    expect(messageOf(MINI_HOLDER_YAML.replace('flow_usd.fees: { type: flow, unit: usd, staleness_days: 45, critical: true }', 'flow_usd.fees: { type: flow, unit: usd, staleness_days: 45, monitor_only: true }')))
      .toContain('"flow_usd.fees" is a standard or holder-flow metric and cannot be monitor_only');
    expect(messageOf(MINI_ASSET_YAML.replace('staker_emission_share: { type: level, unit: ratio, staleness_days: 30 }', 'staker_emission_share: { type: level, unit: ratio, staleness_days: 30, monitor_only: true }')))
      .toContain('"staker_emission_share" is a standard or holder-flow metric and cannot be monitor_only');
  });
});

describe('adapter params validation', () => {
  const ROOT = fileURLToPath(new URL('../..', import.meta.url));
  const litYaml = readFileSync(`${ROOT}/assets/lit.yaml`, 'utf8');
  const withTranches = (tranches: unknown) => {
    // Phase 3 R1: LIT's unlocks are schedule.unlocks_next_year; the team schedule's tranches are the ones varied.
    const obj = parseYaml(litYaml) as { metrics: Record<string, { source: { params: { schedules: Record<string, unknown>[] } } }> };
    obj.metrics.unlocks_next_year.source.params.schedules[0]!.tranches = tranches;
    return obj;
  };
  // A stand-in adapter whose validateParams refuses everything but { ok: true }, used as a cross-check.
  registerAdapter({ name: 'test_checked', needsRpc: false, validateParams: (p) => (p.ok === true ? [] : ['ok: must be true']), run: () => Promise.reject(new Error('not run')) });

  it('parseAssetObject surfaces the refusal with the metric path; assets/lit.yaml still loads and keeps its hash', () => {
    // Re-pinned 2026-11-04: income_statement v2 block added beside reporting (Phase 2 Task 2).
    // Re-pinned (Task 11, G4): holder_flows and reporting retired from the parsed config.
    // Re-pinned (Phase 3 R2 Task 1): the hash input includes LIT's prices.yaml entry (passed as the prices map).
    // Re-pinned (Phase 3 R2 Task 6b): price_usd reads price.token with its prices.yaml check; entriesFor reads refs (R11).
    // Re-pinned (Phase 3 R3 Task 4): circulating_supply on chain (contracts, the new source, the N5 checks); no CoinGecko field loads.
    expect(parseAssetYaml(litYaml, loadPrices(ROOT)).hash).toBe('4f2495ba6269b3f23cf1039a2f0f88c522eab41888b85079042163e378410237');
    expect(parseAssetObject(parseYaml(litYaml), loadPrices(ROOT)).hash).toBe('4f2495ba6269b3f23cf1039a2f0f88c522eab41888b85079042163e378410237');
    // Another valid schedule loads (and is a different config from the file's 36 monthly tranches).
    const good = parseAssetObject(withTranches({ first: '2027-01-29', every_months: 3, count: 12 }), loadPrices(ROOT));
    expect(good.config.metrics.unlocks_next_year.source).toMatchObject({ params: { schedules: [{ tranches: { first: '2027-01-29', every_months: 3, count: 12 } }, { label: 'investors' }] } });
    // Re-pinned (Phase 3 R2 Task 6b): price_usd reads price.token with its prices.yaml check; entriesFor reads refs (R11).
    // Re-pinned (Phase 3 R3 Task 4): circulating_supply on chain (contracts, the new source, the N5 checks); no CoinGecko field loads.
    expect(good.hash).not.toBe('4f2495ba6269b3f23cf1039a2f0f88c522eab41888b85079042163e378410237');
    // A malformed one is refused with the metric path, through the object path (filing) and the YAML path (approve).
    const bad = withTranches({ first: '2027-01-29', every_months: 13, count: 36 });
    expect(() => parseAssetObject(bad)).toThrow(expect.objectContaining({ code: 'invalid_asset_config', message: expect.stringContaining('metrics.unlocks_next_year.source.params: schedules[0].tranches.every_months') }));
    expect(() => parseAssetYaml(stringifyYaml(bad))).toThrow(/metrics\.unlocks_next_year\.source\.params: schedules\[0\]\.tranches\.every_months/);
  });

  it('checks cross-check adapter sources too, and leaves adapters without validateParams alone', () => {
    const yaml = (ok: boolean) =>
      MINI_ASSET_YAML.replace(
        'staked_supply: { type: level, unit: tokens, staleness_days: 7 }',
        `staked_supply: { type: level, unit: tokens, staleness_days: 7, source: { type: adapter, name: lit.treasury_buys_daily, params: { anything: 1 } }, cross_checks: [ { source: { type: adapter, name: test_checked, params: { ok: ${ok} } } } ] }`,
      );
    expect(yaml(true)).toContain('test_checked');
    expect(() => parseAssetYaml(yaml(true))).not.toThrow();
    expect(() => parseAssetYaml(yaml(false))).toThrow(/metrics\.staked_supply\.cross_checks\.0\.source\.params: ok: must be true/);
  });
});

describe('config hash and prices.yaml (Phase 3 R2 Task 1)', () => {
  const ROOT = fileURLToPath(new URL('../..', import.meta.url));
  const CRVUSD = 'eip155:1/0xf939e0a03fb07f59a73314e73794be0e57ac1b4e';
  const AERO = 'eip155:8453/0x3f5bf3edac59d650d8fdf9657a71f2f904a3a4ee';
  /** A config root holding copies of every asset YAML and the given prices.yaml text (none when null). */
  const homeWith = (pricesText: string | null): string => {
    const home = mkdtempSync(join(tmpdir(), 'orion-prices-hash-'));
    mkdirSync(join(home, 'assets'));
    for (const id of listAssetIds(ROOT)) writeFileSync(join(home, 'assets', `${id}.yaml`), readFileSync(join(ROOT, 'assets', `${id}.yaml`)));
    if (pricesText !== null) writeFileSync(join(home, 'prices.yaml'), pricesText);
    return home;
  };
  const hashes = (home: string) => Object.fromEntries(listAssetIds(home).map((id) => [id, loadAsset(home, id).hash]));
  const moved = (a: Record<string, string>, b: Record<string, string>) => Object.keys(a).filter((id) => a[id] !== b[id]).sort();
  const pricesText = readFileSync(join(ROOT, 'prices.yaml'), 'utf8');
  const edited = (ref: string, edit: (e: { check: Record<string, unknown> }) => void) => {
    const obj = parseYaml(pricesText) as Record<string, { check: Record<string, unknown> }>;
    edit(obj[ref]!);
    return stringifyYaml(obj);
  };

  it('the hash input is the asset config plus entriesFor sorted by ref; parsed without a prices map the hash is the config alone', () => {
    const home = homeWith(pricesText);
    const bare = homeWith(null);
    try {
      const loaded = loadAsset(home, 'ycrv');
      const entries = entriesFor(loaded.config, loadPrices(home));
      expect(entries.map((e) => e.ref)).toEqual([...entries.map((e) => e.ref)].sort());
      expect(loaded.hash).toBe(sha256(canonicalJson({ config: loaded.config, prices: entries })));
      expect(parseAssetYaml(readFileSync(join(ROOT, 'assets/ycrv.yaml'), 'utf8')).hash).toBe(sha256(canonicalJson(loaded.config)));
      // Ruling R32(a): a root without prices.yaml no longer loads a chain-priced asset with its config-only hash.
      expect(() => loadAsset(bare, 'ycrv')).toThrow(/prices\.yaml has no entries/);
      // Every asset uses at least its own ref (price.token since Task 6b, R11; AERO, which keeps its own price adapters
      // (R21), through its own token's entry since Task 6 fix E), so its hash differs from its config-only hash.
      const configOnly = Object.fromEntries(listAssetIds(ROOT).map((id) => [id, parseAssetYaml(readFileSync(join(ROOT, 'assets', `${id}.yaml`), 'utf8')).hash]));
      expect(moved(hashes(home), configOnly)).toEqual(listAssetIds(ROOT));
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it('changing an entry moves the hash of exactly the assets that use it: crvUSD moves crv, cvxcrv, sdcrv, ycrv; AERO\'s moves aero (R11, Task 6 fix E)', () => {
    const base = homeWith(pricesText);
    const crvusd = homeWith(edited(CRVUSD, (e) => { e.check.tolerance_pct = 0.6; }));
    const aero = homeWith(edited(AERO, (e) => { e.check.tolerance_pct = 2.5; }));
    try {
      const before = hashes(base);
      expect(moved(before, hashes(crvusd))).toEqual(['crv', 'cvxcrv', 'sdcrv', 'ycrv']);
      // AERO's price_usd reads its own adapters (R21), but its entry drives its history and level rebuild: the asset's own
      // token's entry is in its hash (Task 6 fix E), so a method change shows as "config" on AERO, and on no other asset.
      expect(moved(before, hashes(aero))).toEqual(['aero']);
    } finally {
      for (const h of [base, crvusd, aero]) rmSync(h, { recursive: true, force: true });
    }
  });

  it('parseAssetObject takes the prices map: the same hash as loadAsset', () => {
    const prices = loadPrices(ROOT);
    expect(parseAssetObject(parseYaml(readFileSync(join(ROOT, 'assets/crv.yaml'), 'utf8')), prices).hash).toBe(loadAsset(ROOT, 'crv').hash);
  });

  it('transfer_flow share_price takes an optional underlying contract name, checked against contracts', () => {
    const withShare = (underlying: string) => {
      const obj = parseYaml(readFileSync(join(ROOT, 'assets/ycrv.yaml'), 'utf8')) as { metrics: Record<string, { source: { share_price?: Record<string, unknown> } }> };
      for (const def of Object.values(obj.metrics)) if (def.source?.share_price) def.source.share_price.underlying = underlying;
      return obj;
    };
    expect(() => parseAssetObject(withShare('crvusd'))).not.toThrow();
    expect(() => parseAssetObject(withShare('nowhere'))).toThrow(/unknown contract "nowhere"/);
  });

  it('every ref a usd transfer_flow is valued at must be in prices.yaml (Task 6a): refused at load naming the metric and ref', () => {
    const prices = loadPrices(ROOT);
    // Every repo asset loads: each usd member's ref (the token, or a share's underlying) is priced.
    for (const id of listAssetIds(ROOT)) expect(() => loadAsset(ROOT, id), id).not.toThrow();
    const ycrv = () => parseYaml(readFileSync(join(ROOT, 'assets/ycrv.yaml'), 'utf8')) as { metrics: Record<string, { source: { share_price?: Record<string, unknown> } }> };
    // yv_crvusd's shares valued in the vault token itself, which prices.yaml does not price: refused.
    const obj = ycrv();
    obj.metrics['flow_usd.fees']!.source.share_price!.underlying = 'yv_crvusd';
    expect(() => parseAssetObject(obj, prices)).toThrow(
      /^metrics\.flow_usd\.fees\.source: yv_crvusd \(eip155:1\/0xbf319ddc2edc1eb6fdf9910e39b37be221c8805f\) has no entry in prices\.yaml/,
    );
    // Without a prices map (a hand-built test asset) there is nothing to check against; an empty map (a root whose
    // prices.yaml is missing, empty or comment-only) is refused (Ruling R32(a)).
    expect(() => parseAssetObject(obj)).not.toThrow();
    expect(() => parseAssetObject(obj, new Map())).toThrow(/prices\.yaml has no entries/);
  });
});

describe('metric watch', () => {
  const messageOf = (yaml: string) => {
    try {
      parseAssetYaml(yaml);
    } catch (err) {
      return (err as Error).message;
    }
    return '';
  };
  const withWatched = (def: string) => MINI_ASSET_YAML.replace('metrics:\n', `metrics:\n  watched: ${def}\n`);
  const level = (extra: string) => withWatched(`{ type: level, unit: ratio, staleness_days: 3, ${extra} }`);
  const flow = (extra: string) => withWatched(`{ type: flow, unit: usd, staleness_days: 3, ${extra} }`);

  it('accepts one rule on a monitor-only metric: above on a flow, change_pct or outside on a level', () => {
    expect(parseAssetYaml(flow('monitor_only: true, watch: { above: 1000 }')).config.metrics.watched.watch).toEqual({ above: 1000 });
    expect(parseAssetYaml(level('monitor_only: true, watch: { change_pct: 5 }')).config.metrics.watched.watch).toEqual({ change_pct: 5 });
    expect(parseAssetYaml(level('monitor_only: true, watch: { outside: [0.5, 0.5] }')).config.metrics.watched.watch).toEqual({ outside: [0.5, 0.5] });
    expect(parseAssetYaml(level('monitor_only: true')).config.metrics.watched.watch).toBeUndefined();
  });

  it('refuses a watch without monitor_only, naming the metric', () => {
    expect(messageOf(level('watch: { change_pct: 5 }'))).toMatch(/"watched" has a watch, which is for monitor_only metrics/);
    expect(messageOf(level('monitor_only: false, watch: { change_pct: 5 }'))).toMatch(/"watched" has a watch, which is for monitor_only metrics/);
  });

  it('refuses two rules, no rule, a change_pct not above 0, and an outside with lo above hi', () => {
    expect(messageOf(level('monitor_only: true, watch: { change_pct: 5, outside: [0.4, 0.6] }'))).toMatch(/"watched" watch takes exactly one rule/);
    expect(messageOf(level('monitor_only: true, watch: {}'))).toMatch(/"watched" watch takes exactly one rule/);
    expect(messageOf(level('monitor_only: true, watch: { change_pct: 0 }'))).toMatch(/metrics\.watched\.watch\.change_pct/);
    expect(messageOf(level('monitor_only: true, watch: { outside: [0.6, 0.5] }'))).toMatch(/"watched" watch outside \[lo, hi\] needs lo <= hi/);
    expect(messageOf(level('monitor_only: true, watch: { below: 1 }'))).toMatch(/metrics\.watched\.watch: Unrecognized key: "below"/);
  });

  it('refuses above on a level and change_pct or outside on a flow', () => {
    expect(messageOf(level('monitor_only: true, watch: { above: 1 }'))).toMatch(/"watched" watch above is for flow metrics/);
    expect(messageOf(flow('monitor_only: true, watch: { change_pct: 5 }'))).toMatch(/"watched" watch change_pct is for level metrics/);
    expect(messageOf(flow('monitor_only: true, watch: { outside: [1, 2] }'))).toMatch(/"watched" watch outside is for level metrics/);
  });

  it('an asset without watch/share keeps its hash', () => {
    const asset = (id: string) => loadAsset(fileURLToPath(new URL('../..', import.meta.url)), id).hash;
    // Re-pinned 2026-10-26: window 90 -> 91 days on every asset (Mike); no watch/share key involved.
    // Re-pinned 2026-11-01: the valuation keys and valuation-only metrics left (Phase 1); no watch/share key involved.
    // Re-pinned 2026-11-04: income_statement v2 block added (Phase 2 Task 2); no watch/share key involved.
    // Re-pinned 2026-11-09 (aero only): the Aero contracts (spec 2026-11-09-orion-aero-supply-design.md); no watch/share key involved.
    // Re-pinned (Task 11, G4): holder_flows and reporting retired from the parsed config.
    // Re-pinned (Phase 3 R2 Task 1): the production hash (loadAsset) now includes the asset's prices.yaml entries.
    // Re-pinned (Phase 3 R2 Task 6a): price_coingecko_id retired from the transfer_flow members.
    // Re-pinned (Phase 3 R2 Task 6b): price_usd reads price.token with its prices.yaml check; entriesFor reads refs (R11).
    // Re-pinned (Phase 3 R2 Task 6 fix wave, F/R22): diem_price_usd has no fetch-time cross-check (its check runs hourly in the writer).
    // Re-pinned (Phase 3 R3 Task 4): circulating_supply on chain (contracts, the new source, the N5 checks); no CoinGecko field loads.
    expect(asset('vvv')).toBe('e3cc05364004f5f28832a2271cf30a1b7a09b7ff3a75aa38dae69cc7bccf9ef9');
    // Re-pinned (Phase 3 R2 Task 6 fix wave, F/R22): no fetch-time price cross-check (its check runs hourly in the writer).
    // Re-pinned (Phase 3 R3 Task 4): circulating_supply on chain (contracts, the new source, the N5 checks); no CoinGecko field loads.
    expect(asset('hype')).toBe('d0142eb0bb5a21c73b5f8f2bced176b1fbbccbb2baad2b29aa162ad04c5b1a5a');
    // Re-pinned (Phase 3 R2 Task 6b): AERO names no ref (R11: entriesFor reads price.* params and scanned tokens; its price adapters are its own, R21).
    // Re-pinned (Phase 3 R2 Task 6 fix wave, E): entriesFor includes the asset's own token's prices.yaml entry (AERO's again).
    // Re-pinned (Phase 3 R2 Task 10 fix wave, A/R36): AERO's prices.yaml entry valid_from 2026-09-23 -> 2026-10-22.
    // Re-pinned (Phase 3 R3 Task 5, Ruling R6): circulating_supply rebuild_from 2026-11-10.
    expect(asset('aero')).toBe('4f3d7c2f690dbef0bc30f078d966ce6fb34ffc4252847dfbcfeeac2180cda99d');
  });
});

describe('prices.yaml must be usable (Ruling R32)', () => {
  const ROOT = fileURLToPath(new URL('../..', import.meta.url));
  const pricesText = readFileSync(join(ROOT, 'prices.yaml'), 'utf8');
  const RELEASE = JSON.stringify({ tag: 'orion-2026.11.14.1', commit: 'abc', schema: 8, built_at: '2026-11-14T00:00:00.000Z' });
  /** Missing, empty (0 bytes) and comment-only: every one parses to no entries. */
  const UNUSABLE: [string, string | null][] = [['missing', null], ['empty', ''], ['comment-only', '# prices go here\n# none yet\n']];
  const homeWith = (pricesFile: string | null, release = false): string => {
    const home = mkdtempSync(join(tmpdir(), 'orion-r32-'));
    mkdirSync(join(home, 'assets'));
    for (const id of listAssetIds(ROOT)) writeFileSync(join(home, 'assets', `${id}.yaml`), readFileSync(join(ROOT, 'assets', `${id}.yaml`)));
    if (pricesFile !== null) writeFileSync(join(home, 'prices.yaml'), pricesFile);
    if (release) writeFileSync(join(home, 'RELEASE'), RELEASE);
    return home;
  };
  const codeOf = (f: () => unknown): string | null => {
    try {
      f();
      return null;
    } catch (err) {
      return (err as { code?: string }).code ?? 'thrown';
    }
  };
  const withEnv = <T>(value: string | undefined, f: () => T): T => {
    const before = process.env.ORION_ENV;
    if (value === undefined) delete process.env.ORION_ENV;
    else process.env.ORION_ENV = value;
    try {
      return f();
    } finally {
      if (before === undefined) delete process.env.ORION_ENV;
      else process.env.ORION_ENV = before;
    }
  };

  for (const [what, text] of UNUSABLE) {
    it(`(a) a ${what} prices.yaml: every asset naming price.token/price.token_check or a usd transfer_flow is refused at load; AERO loads in dev`, () => {
      const home = homeWith(text);
      try {
        withEnv(undefined, () => {
          for (const id of listAssetIds(home).filter((i) => i !== 'aero')) {
            expect(codeOf(() => loadAsset(home, id)), id).toBe('invalid_asset_config');
          }
          expect(() => loadAsset(home, 'lit')).toThrow(/prices\.yaml has no entries/);
          // The usd transfer_flow alone (no price.* source) is refused too.
          const flowOnly = MINI_FLOW_ONLY;
          expect(() => parseAssetYaml(flowOnly, new Map())).toThrow(/^metrics\.flow_usd\.fees\.source \(transfer_flow, unit usd\): reads a chain price, but prices\.yaml has no entries/);
          expect(codeOf(() => loadAsset(home, 'aero'))).toBeNull();
        });
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    it(`(b) a ${what} prices.yaml in a release root, or with ORION_ENV stage/prod: every asset load refuses, AERO included`, () => {
      const release = homeWith(text, true);
      const dev = homeWith(text);
      try {
        withEnv(undefined, () => {
          for (const id of listAssetIds(release)) expect(codeOf(() => loadAsset(release, id)), id).toBe('invalid_price_config');
          expect(() => loadAsset(release, 'aero')).toThrow(/a release .* needs prices\.yaml with at least one entry/);
        });
        for (const env of ['stage', 'prod']) {
          withEnv(env, () => expect(codeOf(() => loadAsset(dev, 'aero')), env).toBe('invalid_price_config'));
        }
        withEnv('dev', () => expect(codeOf(() => loadAsset(dev, 'aero'))).toBeNull());
      } finally {
        rmSync(release, { recursive: true, force: true });
        rmSync(dev, { recursive: true, force: true });
      }
    });
  }

  it('(b) a release root with the real prices.yaml loads every asset with the repo hash; the CoinGecko price refusal runs', () => {
    const release = homeWith(pricesText, true);
    try {
      withEnv('prod', () => {
        for (const id of listAssetIds(ROOT)) expect(loadAsset(release, id).hash, id).toBe(loadAsset(ROOT, id).hash);
        writeFileSync(join(release, 'assets', 'cg.yaml'), MINI_CG_PRICE);
        expect(() => loadAsset(release, 'cg')).toThrow(/coingecko/i);
      });
    } finally {
      rmSync(release, { recursive: true, force: true });
    }
  });
});
