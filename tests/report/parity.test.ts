import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { incomeStatementV2, type IsV2 } from '../../src/report/incomeStatement.js';
import { getPath, PARITY, PARITY_PATHS } from '../../src/report/parity.js';
import { ALL_ASSETS, repoAsset, syntheticInput } from '../helpers/syntheticReport.js';

const PARITY_ASSETS = ['aero', 'cake', 'crv', 'cvxcrv', 'hype', 'link', 'pump', 'sky', 'uni', 'vvv'];
const REL = 1e-12;
const rel = (a: number | null, b: number | null) => (a === null && b === null ? 0 : a === null || b === null ? Infinity : a === b ? 0 : Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b)));

/**
 * The v1 report of each repo asset on the synthetic series, as cc59fa7 computed it (before Task 11 retired v1 and its
 * config): the old side of the cross-release proof, which reads it from an old release's JSON the same way.
 */
const V1_GOLDEN = JSON.parse(readFileSync(fileURLToPath(new URL('./golden/v1-report-13.json', import.meta.url)), 'utf8')) as Record<string, V1>;
type V1 = any;

/**
 * Both statements for a repo asset on synthetic series, as the report JSON carries them: v1 frozen, v2 computed now.
 */
function reports(id: string): { v1: V1; v2: IsV2 } {
  const input = syntheticInput(repoAsset(id));
  return { v1: structuredClone(V1_GOLDEN[id]), v2: JSON.parse(JSON.stringify(incomeStatementV2(input))) };
}

const num = (obj: unknown, path: string): number => {
  const x = getPath(obj, path);
  if (typeof x !== 'number') throw new Error(`${path} is ${JSON.stringify(x)}`);
  return x;
};

describe('parity map (ruling R7)', () => {
  it('covers exactly the 10 unchanged assets', () => {
    expect(Object.keys(PARITY_PATHS).sort()).toEqual(PARITY_ASSETS);
    expect(Object.keys(PARITY).sort()).toEqual(PARITY_ASSETS);
  });

  it.each(PARITY_ASSETS)('%s: every pair is equal at rel 1e-12 on synthetic 200-day series', (id) => {
    const { v1, v2 } = reports(id);
    const pairs = PARITY[id](v2, v1);
    expect(pairs.length).toBe(PARITY_PATHS[id].length);
    const bad = pairs.filter(([, a, b]) => !(rel(a, b) <= REL));
    expect(bad).toEqual([]);
    // The figures the proof leans on are real numbers, not null = null.
    const byLabel = new Map(pairs.map(([l, a]) => [l, a]));
    for (const l of ['revenue', 'holders', ...(id === 'sky' ? [] : ['protocol']), 'payout ratio', 'holder flow total', 'holder flow total net', 'yield shareholder', 'dilution pct']) {
      expect(byLabel.get(l), `${id} ${l}`).toEqual(expect.any(Number));
    }
  });

  it('covers revenue, each holders line, holder flow, protocol, costs, payout ratio, every yield and dilution for each asset', () => {
    for (const id of PARITY_ASSETS) {
      const asset = repoAsset(id);
      const v2Paths = PARITY_PATHS[id].map((p) => p[1]);
      // SKY's v1 protocol is a rounding residue of a remainder (see PARITY_PATHS.sky).
      const totals = ['revenue.annualized', 'holderFlow.gross', 'protocol.annualized', 'operatingCosts.annualized', 'ratios.payoutRatio', 'dilution.pct'].filter((p) => id !== 'sky' || p !== 'protocol.annualized');
      for (const p of totals) {
        expect(v2Paths, `${id} ${p}`).toContain(`incomeStatement.${p}`);
      }
      for (const k of ['cash', 'buyback', 'shareholder', 'dilution', 'netShareholder', 'multiple', 'pegTrailing']) expect(v2Paths).toContain(`incomeStatement.yields.${k}`);
      for (const h of asset.income_statement!.holders ?? []) {
        expect(v2Paths, `${id} holders ${h.id}`).toContain(`incomeStatement.holders.lines[id=${h.id}].annualized`);
        expect(v2Paths, `${id} holder flow ${h.id}`).toContain(`incomeStatement.holderFlow.lines[id=${h.id}].gross`);
      }
      for (const r of asset.income_statement!.revenue) expect(v2Paths, `${id} revenue ${r.id}`).toContain(`incomeStatement.revenue.lines[id=${r.id}].annualized`);
    }
  });

  it('covers what v1 publishes and v2 restates (fix round 1, M1): per-flow net/yield/growth, protocol growth, line growth, price, volume', () => {
    for (const id of PARITY_ASSETS) {
      const asset = repoAsset(id);
      const pairs = PARITY_PATHS[id];
      const v2Paths = pairs.map((p) => p[1]);
      const v1Of = new Map(pairs.map((p) => [p[1], p[2]]));
      expect(v1Of.get('incomeStatement.priceBasis.price'), id).toBe('price');
      expect(pairs.some((p) => p[1] === 'incomeStatement.revenue.annualized' && p[2] === 'income.revenue.annualized'), id).toBe(true);
      // The published top-level revenue figures too (VVV's growth is only there).
      expect(pairs.some((p) => p[1] === 'incomeStatement.revenue.annualized' && p[2] === 'revenue.annualized'), id).toBe(true);
      expect(pairs.some((p) => p[1] === 'incomeStatement.revenue.growth.annualized' && p[2] === 'revenue.growth.annualized'), id).toBe(true);
      if (id !== 'sky') expect(v2Paths, id).toContain('incomeStatement.protocol.growth.annualized');
      for (const h of asset.income_statement!.holders ?? []) {
        for (const k of ['net', 'yield', 'growth.annualized']) expect(v2Paths, `${id} ${h.id} ${k}`).toContain(`incomeStatement.holderFlow.lines[id=${h.id}].${k}`);
      }
      const v1 = V1_GOLDEN[id];
      if (v1.revenue?.basis === 'streams' || v1.revenue?.basis === 'disclosed') {
        for (const r of asset.income_statement!.revenue) expect(v2Paths, `${id} ${r.id} growth`).toContain(`incomeStatement.revenue.lines[id=${r.id}].growth.annualized`);
      }
      // Phase 3 R1: CAKE's and UNI's volume is not_measured (DefiLlama's gross fees removed), so v2 has no figure to pair.
      if (v1.volume && Array.isArray(asset.income_statement!.volume)) {
        expect(v1Of.get('incomeStatement.volume.annualized'), id).toBe('volume.annualized');
        expect(v1Of.get('incomeStatement.volume.growth.annualized'), id).toBe('volume.growth.annualized');
      }
    }
    expect(PARITY_PATHS.hype.map((p) => p[1])).toContain('incomeStatement.revenue.growthExNew.annualized');
    const vvv = new Map(PARITY_PATHS.vvv.map((p) => [p[1], p[2]]));
    // Phase 3 R1 removed VVV's revenue cross-check (DefiLlama's dailyRevenue): no pair for it.
    expect(vvv.has('incomeStatement.revenue.lines[id=business].crossCheck.annualized')).toBe(false);
    expect(vvv.get('incomeStatement.revenue.lines[id=business].growth.annualized')).toBe('revenue.streams[id=business].growth.annualized');
    expect(PARITY_PATHS.cvxcrv.map((p) => p[1])).toContain('incomeStatement.volume.annualized');
    for (const a of ['cake', 'uni']) expect(PARITY_PATHS[a].map((p) => p[1]), a).not.toContain('incomeStatement.volume.annualized');
  });

  it('VVV revenue growth is a number on both sides (I1: the null = null pair is gone)', () => {
    const { v1, v2 } = reports('vvv');
    const pairs = PARITY.vvv(v2, v1).filter(([l]) => l.includes('growth') && l.includes('revenue'));
    expect(pairs.length).toBeGreaterThanOrEqual(2);
    for (const [label, a, b] of pairs) {
      expect(a, label).toEqual(expect.any(Number));
      expect(b, label).toEqual(expect.any(Number));
    }
  });

  it('a v2 null against a v1 number fails the pair (no null-vs-number pass)', () => {
    const { v1, v2 } = reports('vvv');
    v2.revenue.growth.annualized = null;
    const bad = PARITY.vvv(v2, v1).filter(([, a, b]) => !(rel(a, b) <= REL));
    expect(bad.map(([l]) => l)).toContain('revenue growth (published)');
  });

  it('tools/phase2-proof/parity.json is PARITY_PATHS as written by write-parity.ts', () => {
    const file = readFileSync(fileURLToPath(new URL('../../tools/phase2-proof/parity.json', import.meta.url)), 'utf8');
    expect(file).toBe(`${JSON.stringify(PARITY_PATHS, null, 2)}\n`);
  });
});

/** The Reclassification Table (plan Global Constraints), from the v1 report, keyed by expected.py's paths. */
const YCRV_MIX_PATH = 'incomeStatement.holders.lines[id=ybs_payout].apportion.mix';

function reclassExpected(id: string, v1: V1, v2: IsV2): Record<string, number> {
  const line = (l: string) => num(v1, `income.lines[id=${l}].annualized`);
  if (id === 'sdcrv') {
    const revenue = num(v1, 'income.revenue.annualized') - line('vote_incentives');
    return {
      'incomeStatement.revenue.annualized': revenue,
      'incomeStatement.belowLine.toHolders': line('vote_incentives'),
      'incomeStatement.operatingCosts.annualized': line('boost_delegators'),
      'incomeStatement.ratios.payoutRatio': (line('vecrv_fees') + line('crv_fee_share')) / revenue,
    };
  }
  if (id === 'ycrv') {
    // Task 7b (Mike G1): revenue is the fees share of the gross, the vote incentives' share of the payouts is below the
    // line; the mix is read from the new side (expected.py does the same). Ruling R6: no st-yCRV line in v2.
    const mix = num({ incomeStatement: v2 }, YCRV_MIX_PATH);
    const revenue = num(v1, 'volume.annualized') * mix;
    return {
      'incomeStatement.revenue.annualized': revenue,
      'incomeStatement.unreconciled.annualized': revenue - line('ybs_payout') * mix - line('treasury') * mix,
      'incomeStatement.belowLine.toHolders': line('ybs_payout') * (1 - mix),
      'incomeStatement.holderFlow.gross': num(v1, 'buckets.cash.gross'),
      'incomeStatement.holderFlow.net': num(v1, 'buckets.cash.net'),
    };
  }
  const gross = num(v1, 'revenue.streams[id=robinhood].grossAnnualized');
  const net = num(v1, 'revenue.streams[id=robinhood].annualized');
  return {
    'incomeStatement.revenue.annualized': num(v1, 'revenue.annualized') + (gross - net),
    'incomeStatement.costOfRevenue.annualized': gross * 0.5,
    'incomeStatement.grossProfit.annualized': num(v1, 'revenue.annualized'),
  };
}

describe('the three reclassified assets', () => {
  it.each(['sdcrv', 'ycrv', 'lit'])('%s matches the Reclassification Table at rel 1e-12', (id) => {
    const { v1, v2 } = reports(id);
    const expected = reclassExpected(id, v1, v2);
    for (const [path, want] of Object.entries(expected)) expect(rel(num({ incomeStatement: v2 }, path), want), `${id} ${path}`).toBeLessThanOrEqual(REL);
  });

  it('every target path in tools/phase2-proof/expected.py resolves to a number in IsV2', () => {
    const py = readFileSync(fileURLToPath(new URL('../../tools/phase2-proof/expected.py', import.meta.url)), 'utf8');
    const paths = [...new Set([...py.matchAll(/"(incomeStatement\.[A-Za-z.]+)"/g)].map((m) => m[1]))];
    expect(paths.sort()).toEqual([
      'incomeStatement.belowLine.toHolders', 'incomeStatement.costOfRevenue.annualized', 'incomeStatement.grossProfit.annualized',
      'incomeStatement.holderFlow.gross', 'incomeStatement.holderFlow.net',
      'incomeStatement.operatingCosts.annualized', 'incomeStatement.ratios.payoutRatio', 'incomeStatement.revenue.annualized', 'incomeStatement.unreconciled.annualized',
    ]);
    // yCRV's mix (Task 7b) is read from the new side by that exact path.
    expect(py).toContain(`"${YCRV_MIX_PATH}"`);
    const { v2: y } = reports('ycrv');
    const mix = getPath({ incomeStatement: y }, YCRV_MIX_PATH);
    expect(mix).toEqual(expect.any(Number));
    expect(mix as number).toBeGreaterThan(0);
    expect(mix as number).toBeLessThan(1);
    for (const id of ['sdcrv', 'ycrv', 'lit']) {
      const { v2 } = reports(id);
      for (const p of paths) expect(typeof getPath({ incomeStatement: v2 }, p), `${id} ${p}`).toBe('number');
    }
  });

  it('the other figures of the reclassified assets stay as v1: holder flow, yields, dilution', () => {
    for (const id of ['sdcrv', 'ycrv', 'lit']) {
      const { v1, v2 } = reports(id);
      const bucket = (['burn', 'hold', 'cash'] as const).find((b) => v1.buckets[b] !== null)!;
      expect(rel(v2.holderFlow.gross, v1.buckets[bucket]!.gross), id).toBeLessThanOrEqual(REL);
      expect(rel(v2.holderFlow.net, v1.buckets[bucket]!.net), id).toBeLessThanOrEqual(REL);
      expect(rel(v2.holderFlow.growth.annualized, v1.holderFlowGrowth.annualized), id).toBeLessThanOrEqual(REL);
      expect(v2.yields).toEqual(v1.yields);
      expect(v2.dilution.pct).toBe(v1.yields.dilution);
    }
  });
});

describe('all 13 assets', () => {
  it.each([...ALL_ASSETS])('%s: computes on synthetic series with a numeric revenue and holder flow', (id) => {
    const { v2 } = reports(id);
    expect(v2.schema).toBe(2);
    expect(v2.revenue.annualized).toEqual(expect.any(Number));
    expect(v2.holderFlow.gross).toEqual(expect.any(Number));
  });
});
