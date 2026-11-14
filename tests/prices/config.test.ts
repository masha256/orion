import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { loadAsset } from '../../src/config/load.js';
import { entriesFor, loadPrices, methodSource, parsePrices, quoteRefOf, type PriceMethod } from '../../src/prices/config.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

// The 17 token refs of the R2 price table (plan Task 1), lowercased; Solana mints keep their base58 case.
const REF = {
  CRV: 'eip155:1/0xd533a949740bb3306d119cc777fa900ba034cd52',
  CVX: 'eip155:1/0x4e3fbd56cd56c3e72c1403e103b45db9da5b9d2b',
  SKY: 'eip155:1/0x56072c95faa701256059aa122697b133aded9279',
  LINK: 'eip155:1/0x514910771af9ca656af840dff83e8264ecf986ca',
  UNI: 'eip155:1/0x1f9840a85d5af5bf1d1762f925bdaddc4201f984',
  crvUSD: 'eip155:1/0xf939e0a03fb07f59a73314e73794be0e57ac1b4e',
  USDS: 'eip155:1/0xdc035d45d973e3ec169d2276ddab16f1e407384f',
  cvxCRV: 'eip155:1/0x62b9c7356a2dc64a1969e19c23e4f579f9810aa7',
  sdCRV: 'eip155:1/0xd1b5651e55d4ceed36251c61c50c889b36f6abb5',
  yCRV: 'eip155:1/0xfcc5c47be19d06bf83eb04298b026f81069ff65b',
  CAKE: 'eip155:56/0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82',
  VVV: 'eip155:8453/0xacfe6019ed1a7dc6f7b508c02d1b04ec88cc21bf',
  DIEM: 'eip155:8453/0xf4d97f2da56e8c3098f3a8d538db630a2606a024',
  AERO: 'eip155:8453/0x3f5bf3edac59d650d8fdf9657a71f2f904a3a4ee',
  HYPE: 'hyperliquid:spot/@107',
  LIT: 'eip155:1/0x232ce3bd40fcd6f80f3d55a522d03f25df784ee2',
  PUMP: 'solana:mainnet/pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn',
} as const;

type Raw = Record<string, Record<string, unknown> & { primary: Record<string, unknown>; check: Record<string, unknown> }>;
/** A fresh copy of the committed file's object, to vary. */
const raw = (): Raw => parseYaml(readFileSync(`${ROOT}/prices.yaml`, 'utf8')) as Raw;
const refusal = (obj: unknown): string => {
  try {
    parsePrices(obj);
  } catch (err) {
    return `${(err as { code?: string }).code}: ${(err as Error).message}`;
  }
  return '';
};

describe('prices.yaml (the committed file)', () => {
  const prices = loadPrices(ROOT);

  it('has the 17 refs of the price table, each with its symbol', () => {
    expect([...prices.keys()].sort()).toEqual(Object.values(REF).sort());
    for (const [symbol, ref] of Object.entries(REF)) expect(prices.get(ref)!.symbol, ref).toBe(symbol);
  });

  it('every quote_ref resolves to an entry, and DIEM is quoted in VVV', () => {
    for (const e of prices.values()) {
      for (const m of [e.primary, e.check]) {
        const q = quoteRefOf(m);
        if (q !== undefined) expect(prices.has(q), `${e.ref} -> ${q}`).toBe(true);
      }
    }
    expect(quoteRefOf(prices.get(REF.DIEM)!.primary)).toBe(REF.VVV);
  });

  it('valid_from is the first hour Orion writes: 2025-10-13 for the EVM refs, AERO, HYPE, LIT, PUMP later (Ruling R2)', () => {
    const later: Record<string, string> = { [REF.AERO]: '2026-09-23', [REF.HYPE]: '2026-10-01', [REF.LIT]: '2026-10-01', [REF.PUMP]: '2026-10-12' };
    for (const e of prices.values()) expect(e.validFrom, e.ref).toBe(later[e.ref] ?? '2025-10-13');
  });

  it('reads each primary where its chain says: LIT is an Ethereum ref priced on Lighter; HYPE on Hyperliquid; PUMP on Solana', () => {
    expect(prices.get(REF.LIT)).toMatchObject({ chain: 'lighter', primary: { kind: 'lighter_candle', market_id: 2049 }, check: { kind: 'v4_spot', tolerancePct: 3 } });
    expect(prices.get(REF.HYPE)).toMatchObject({ chain: 'hyperliquid', primary: { kind: 'hyperliquid_candle', coin: '@107' }, check: { kind: 'hyperliquid_candle', coin: 'HYPE', tolerancePct: 2, label: 'same_venue' } });
    expect(prices.get(REF.PUMP)).toMatchObject({ chain: 'solana', decimals: 6, primary: { kind: 'solana_vaults' }, check: { kind: 'meteora_dlmm', tolerancePct: 2 } });
    // The off-chain primaries name the Ethereum USDC/USD feed (Ruling R5: eip155:1 is priced first each hour).
    for (const ref of [REF.HYPE, REF.LIT, REF.PUMP]) expect(prices.get(ref)!.primary).toMatchObject({ usd_feed: '0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6' });
  });

  it('LIT and PUMP carry the on-chain values verified by the controller (task-1-values.md)', () => {
    expect(prices.get(REF.LIT)!.check).toMatchObject({
      state_view: '0x7fFE42C4a5DEeA5b0feC41C94C136Cf115597227',
      pool_id: '0x8366b1dde4de12c8806985fbb599d408d92d01a6faf2e478cc6bb76189cc00f1',
    });
    expect(prices.get(REF.PUMP)!.primary).toMatchObject({
      base_vault: '8TqK4PL3x7zWR2dNinr1LMi8Uf4vTRSFE2Ev1yYW9bhC',
      quote_vault: '68Vdm7mQJ7RBxWioLVEUXbeTTpTtyiR1CL9vLRxmdr8t',
    });
    expect(prices.get(REF.PUMP)!.check).toMatchObject({ pair: '9SMp4yLKGtW9TnLimfVPkDARsyNSfJw43WMke4r7KoZj' });
  });

  it('carries the table\'s checks: tolerances, sdCRV\'s bound, cvxCRV and yCRV over 2 consecutive hours', () => {
    const tol = Object.fromEntries(Object.entries(REF).map(([s, ref]) => [s, prices.get(ref)!.check.tolerancePct]));
    expect(tol).toEqual({ CRV: 1.5, CVX: 2.5, SKY: 2.5, LINK: 2, UNI: 2, crvUSD: 0.5, USDS: 0.5, cvxCRV: 3, sdCRV: 0, yCRV: 3, CAKE: 2, VVV: 2, DIEM: 2, AERO: 2, HYPE: 2, LIT: 3, PUMP: 2 });
    expect(prices.get(REF.sdCRV)!.check).toEqual({ kind: 'bound', min_in_quote: 0.3, max_in_quote: 1, quote_ref: REF.CRV, tolerancePct: 0, consecutive: 1, label: 'no_independent_check' });
    for (const ref of [REF.cvxCRV, REF.yCRV]) expect(prices.get(ref)!.check).toMatchObject({ kind: 'curve_get_dy', i: 1, j: 0, quote_ref: REF.CRV, consecutive: 2 });
    expect(prices.get(REF.CRV)!.primary).toEqual({ kind: 'curve_oracle', pool: '0x4eBdF703948ddCEA3B11f675B4D1Fba9d2414A14', index: 1, quote_ref: REF.crvUSD });
  });

  it('AERO takes aero.yaml\'s pools and feed', () => {
    const c = loadAsset(ROOT, 'aero').config.contracts;
    expect(prices.get(REF.AERO)).toMatchObject({
      primary: { kind: 'v2_twap', flavor: 'aerodrome', pool: c.price_pool, usd_feed: c.usdc_usd_feed },
      check: { kind: 'v3_spot', pool: c.price_check_pool, usd_feed: c.usdc_usd_feed, tolerancePct: 2 },
    });
  });

  it('entriesFor(ycrv) is yCRV (price.token), CRV (its quote) and crvUSD (CRV\'s quote, and a share\'s underlying), sorted by ref', () => {
    const refs = entriesFor(loadAsset(ROOT, 'ycrv').config, prices).map((e) => e.ref);
    expect(refs).toEqual([REF.CRV, REF.crvUSD, REF.yCRV].sort());
    // AERO's price_usd reads its own adapters (R21) and it scans no token: no ref.
    expect(entriesFor(loadAsset(ROOT, 'aero').config, prices).map((e) => e.ref)).toEqual([]);
    expect(entriesFor(loadAsset(ROOT, 'hype').config, prices).map((e) => e.ref)).toEqual([REF.HYPE]);
    expect(entriesFor(loadAsset(ROOT, 'pump').config, prices).map((e) => e.ref)).toEqual([REF.PUMP]);
    expect(entriesFor(loadAsset(ROOT, 'vvv').config, prices).map((e) => e.ref)).toEqual([REF.VVV, REF.DIEM].sort());
  });

  it('entriesFor reads refs, never symbols or every contract (R11): price.* params, scanned tokens, share underlyings, quotes', () => {
    const crv = loadAsset(ROOT, 'crv').config;
    const hype = loadAsset(ROOT, 'hype').config;
    const refsOf = (metrics: Record<string, unknown>, base = crv) => entriesFor({ ...base, metrics } as unknown as typeof crv, prices).map((e) => e.ref);
    const adapter = (name: string, ref: string) => ({ type: 'level', source: { type: 'adapter', name, params: { ref } } });
    // HYPE's symbol no longer pulls its ref in: without a price source it uses none (the interim symbol match is gone).
    expect(refsOf({}, hype)).toEqual([]);
    expect(refsOf({ p: adapter('price.token', REF.HYPE) }, hype)).toEqual([REF.HYPE]);
    // A check-only ref counts, with its quote refs transitively (cvxCRV -> CRV -> crvUSD).
    expect(refsOf({ c: { type: 'level', cross_checks: [{ tolerance_pct: 3, source: adapter('price.token_check', REF.cvxCRV).source }] } })).toEqual([REF.CRV, REF.crvUSD, REF.cvxCRV].sort());
    // A contract named only in `contracts` (CRV's crvusd, its token) adds nothing; a transfer_flow's scanned token does.
    expect(refsOf({ x: { type: 'level', source: { type: 'erc20_supply', token: 'token', subtract_balances: [] } } })).toEqual([]);
    expect(refsOf({ f: { type: 'flow', source: { type: 'transfer_flow', token: 'crvusd', to: 'token', unit: 'tokens', from_any: true } } })).toEqual([REF.crvUSD]);
    // A share's underlying counts (the share itself is not priced).
    const ycrv = loadAsset(ROOT, 'ycrv').config;
    const share = Object.values(ycrv.metrics).find((d) => d.source?.type === 'transfer_flow' && d.source.share_price?.underlying === 'crvusd')!;
    expect(refsOf({ s: share }, ycrv)).toEqual([REF.crvUSD]);
  });

  it('methodSource: chain:<kind> for a chain read, first_party:<venue> for a venue API', () => {
    expect(methodSource(prices.get(REF.LINK)!.primary)).toBe('chain:chainlink');
    expect(methodSource(prices.get(REF.PUMP)!.primary)).toBe('chain:solana_vaults');
    expect(methodSource(prices.get(REF.HYPE)!.primary)).toBe('first_party:hyperliquid');
    expect(methodSource(prices.get(REF.LIT)!.primary)).toBe('first_party:lighter');
    expect(methodSource({ kind: 'v3_twap', pool: '0x67a11022b7b6ed66f81233f6c8ed6e48f7826530', seconds: 3600 } as PriceMethod)).toBe('chain:v3_twap');
  });
});

describe('parsePrices refusals (named by ref and field)', () => {
  it('refuses a self-reference and a cycle; DIEM -> VVV is fine', () => {
    const self = raw();
    self[REF.VVV]!.primary = { kind: 'v2_twap', pool: '0x01784ef301D79e4B2DF3a21ad9a536d4cF09A5Ce', flavor: 'aerodrome', quote_ref: REF.VVV };
    expect(refusal(self)).toContain(`${REF.VVV}.primary.quote_ref: a ref cannot be quoted in itself`);
    const cycle = raw();
    cycle[REF.VVV]!.primary = { kind: 'v2_twap', pool: '0x01784ef301D79e4B2DF3a21ad9a536d4cF09A5Ce', flavor: 'aerodrome', quote_ref: REF.DIEM };
    expect(refusal(cycle)).toMatch(/invalid_price_config: .*quote refs form a cycle \(.*eip155:8453\/0x(acfe|f4d9).* -> .*\)/);
    expect(refusal(raw())).toBe('');
  });

  it('refuses a quote_ref with no entry', () => {
    const o = raw();
    delete o[REF.USDS];
    expect(refusal(o)).toContain(`${REF.SKY}.primary.quote_ref: ${REF.USDS} is not in prices.yaml`);
  });

  it('refuses an unknown key on an entry and on a method', () => {
    const entry = raw();
    entry[REF.CRV]!.coingecko_id = 'curve-dao-token';
    expect(refusal(entry)).toMatch(new RegExp(`${REF.CRV.replace(/[/.]/g, '\\$&')}: Unrecognized key: "coingecko_id"`));
    const method = raw();
    method[REF.LINK]!.primary.decimals = 8;
    expect(refusal(method)).toMatch(/0x514910771af9ca656af840dff83e8264ecf986ca\.primary: Unrecognized key: "decimals"/);
  });

  it('refuses a tolerance <= 0, and a missing one except on a bound', () => {
    for (const t of [0, -1]) {
      const o = raw();
      o[REF.UNI]!.check.tolerance_pct = t;
      expect(refusal(o), String(t)).toMatch(/0x1f9840a85d5af5bf1d1762f925bdaddc4201f984\.check\.tolerance_pct: Too small/);
    }
    const missing = raw();
    delete missing[REF.UNI]!.check.tolerance_pct;
    expect(refusal(missing)).toContain(`${REF.UNI}.check.tolerance_pct: required`);
    const onBound = raw();
    onBound[REF.sdCRV]!.check.tolerance_pct = 2;
    expect(refusal(onBound)).toContain(`${REF.sdCRV}.check.tolerance_pct: a bound check has no tolerance`);
  });

  it('refuses an address that is not 20 bytes, by field', () => {
    const o = raw();
    o[REF.LINK]!.primary.feed = '0x2c1d072e956AFFC0D435Cb7AC38EF18d24d9127';
    expect(refusal(o)).toMatch(/0x514910771af9ca656af840dff83e8264ecf986ca\.primary\.feed: must be a 20-byte 0x address/);
  });

  it('refuses a Solana address that does not decode to 32 bytes, and a v4 pool_id that is not 32 bytes', () => {
    // 44 base58 'z's pass the alphabet but decode to 33 bytes; 32 '1's decode to 32 zero bytes (well-formed).
    const long = raw();
    long[REF.PUMP]!.primary.base_vault = 'z'.repeat(44);
    expect(refusal(long)).toContain(`${REF.PUMP}.primary.base_vault: must be a base58 32-byte Solana address`);
    const badChar = raw();
    badChar[REF.PUMP]!.check.pair = '0OIl' + '1'.repeat(40);
    expect(refusal(badChar)).toContain(`${REF.PUMP}.check.pair: must be a base58 32-byte Solana address`);
    const ok = raw();
    ok[REF.PUMP]!.primary.quote_vault = '1'.repeat(32);
    expect(refusal(ok)).toBe('');
    const pool = raw();
    pool[REF.LIT]!.check.pool_id = '0x8366b1dde4de12c8806985fbb599d408d92d01a6faf2e478cc6bb76189cc00';
    expect(refusal(pool)).toContain(`${REF.LIT}.check.pool_id: must be a 32-byte 0x id`);
  });

  it('refuses a ref whose chain prefix contradicts chain, and a primary not read on that chain', () => {
    const o = raw();
    o[REF.CAKE]!.chain = 'eip155:1';
    expect(refusal(o)).toContain(`${REF.CAKE}: the ref's chain contradicts chain eip155:1`);
    const hype = raw();
    hype[REF.HYPE]!.chain = 'solana';
    expect(refusal(hype)).toContain(`${REF.HYPE}: the ref's chain contradicts chain solana`);
    const lit = raw();
    lit[REF.LIT]!.chain = 'eip155:1';
    expect(refusal(lit)).toContain(`${REF.LIT}.primary: lighter_candle is not read on chain eip155:1`);
  });

  it('refuses an uppercase or malformed ref key, a bound primary, and a quoted method with both or neither quote', () => {
    const upper = raw();
    upper[REF.CRV.replace('0xd533a949740bb3306d119cc777fa900ba034cd52', '0xD533a949740bb3306d119CC777fa900bA034cd52')] = upper[REF.CRV]!;
    expect(refusal(upper)).toContain('0xD533a949740bb3306d119CC777fa900bA034cd52: not a token ref');
    const bound = raw();
    bound[REF.sdCRV]!.primary = { kind: 'bound', min_in_quote: 0.3, max_in_quote: 1, quote_ref: REF.CRV };
    expect(refusal(bound)).toContain(`${REF.sdCRV}.primary: bound is a check, never a primary`);
    const both = raw();
    both[REF.SKY]!.primary.usd_feed = '0xee10fE5E7aa92dd7b136597449c3d5813cFC5F18';
    expect(refusal(both)).toContain(`${REF.SKY}.primary: v2_twap needs exactly one of quote_ref and usd_feed`);
  });

  it('a config root without prices.yaml has no entries', () => {
    expect(loadPrices(fileURLToPath(new URL('.', import.meta.url))).size).toBe(0);
  });
});
