import type { Bucket, HolderYieldReport } from './holderYield.js';
import type { IsV2 } from './incomeStatement.js';

/**
 * Proof tooling for the Phase 2 cross-release proof (ruling R7), kept out of the report module: the parity map, the path
 * reader that mirrors tools/phase2-proof/compare.py, and PARITY, which reads both sides of every pair.
 */

/** One step of a parity path, as tools/phase2-proof/compare.py reads it: `key` or `key[field=value]`. */
const SELECT = /^([^[\]]+)\[([A-Za-z_][A-Za-z0-9_]*)=([^[\]]+)\]$/;

/** The value at a dotted path (compare.py's get_path); undefined when a step is absent or a selector is not unique. */
export function getPath(obj: unknown, dotted: string): unknown {
  let node: unknown = obj;
  for (const step of dotted.split('.')) {
    const m = SELECT.exec(step);
    const key = m ? m[1] : step;
    if (node === null || typeof node !== 'object' || Array.isArray(node) || !(key in (node as object))) return undefined;
    node = (node as Record<string, unknown>)[key];
    if (m) {
      if (!Array.isArray(node)) return undefined;
      const found = node.filter((x) => x !== null && typeof x === 'object' && (x as Record<string, unknown>)[m[2]] === m[3]);
      if (found.length !== 1) return undefined;
      node = found[0];
    }
  }
  return node;
}

type PathPair = [label: string, v2: string, v1: string];

const IS = 'incomeStatement';
const YIELD_KEYS = ['cash', 'buyback', 'shareholder', 'dilution', 'netShareholder', 'multiple', 'pegTrailing'] as const;

/**
 * The pairs every unchanged asset shares: totals and their growth (the income statement's and the published top-level
 * `revenue`), ratios, the price, yields, dilution, and its one holder-flow bucket.
 */
function commonPairs(bucket: Bucket): PathPair[] {
  return [
    ['revenue', `${IS}.revenue.annualized`, 'income.revenue.annualized'],
    ['revenue growth', `${IS}.revenue.growth.annualized`, 'income.revenue.growth.annualized'],
    ['revenue (published)', `${IS}.revenue.annualized`, 'revenue.annualized'],
    ['revenue growth (published)', `${IS}.revenue.growth.annualized`, 'revenue.growth.annualized'],
    ['holders', `${IS}.holders.annualized`, 'income.holders.annualized'],
    ['holders growth', `${IS}.holders.growth.annualized`, 'income.holders.growth.annualized'],
    ['protocol', `${IS}.protocol.annualized`, 'income.protocol.annualized'],
    ['protocol growth', `${IS}.protocol.growth.annualized`, 'income.protocol.growth.annualized'],
    ['operating costs = v1 costs', `${IS}.operatingCosts.annualized`, 'income.costs.annualized'],
    ['payout ratio', `${IS}.ratios.payoutRatio`, 'income.payoutRatio'],
    ['price', `${IS}.priceBasis.price`, 'price'],
    ['holder flow total', `${IS}.holderFlow.gross`, `buckets.${bucket}.gross`],
    ['holder flow total net', `${IS}.holderFlow.net`, `buckets.${bucket}.net`],
    [`holder flow ${bucket}`, `${IS}.holderFlow.byBucket.${bucket}.gross`, `buckets.${bucket}.gross`],
    [`holder flow ${bucket} net`, `${IS}.holderFlow.byBucket.${bucket}.net`, `buckets.${bucket}.net`],
    [`holder flow ${bucket} yield`, `${IS}.holderFlow.byBucket.${bucket}.yield`, `buckets.${bucket}.yield`],
    ['holder flow growth', `${IS}.holderFlow.growth.annualized`, 'holderFlowGrowth.annualized'],
    ...YIELD_KEYS.map((k): PathPair => [`yield ${k}`, `${IS}.yields.${k}`, `yields.${k}`]),
    ['dilution pct', `${IS}.dilution.pct`, 'yields.dilution'],
  ];
}

/** A v2 revenue line against a v1 income line (assets whose v1 revenue is the income statement's total). */
const revIncome = (v2: string, v1: string): PathPair => [`revenue line ${v2}`, `${IS}.revenue.lines[id=${v2}].annualized`, `income.lines[id=${v1}].annualized`];
/** A v2 revenue line against a v1 revenue stream: its annualized figure and its growth. */
const revStream = (id: string): PathPair[] => [
  [`revenue line ${id}`, `${IS}.revenue.lines[id=${id}].annualized`, `revenue.streams[id=${id}].annualized`],
  [`revenue line ${id} growth`, `${IS}.revenue.lines[id=${id}].growth.annualized`, `revenue.streams[id=${id}].growth.annualized`],
];
/** A v2 holders line (statement) against a v1 income line. */
const holderIncome = (v2: string, v1: string): PathPair => [`holders line ${v2}`, `${IS}.holders.lines[id=${v2}].annualized`, `income.lines[id=${v1}].annualized`];
/** A v2 holder-flow line against a v1 flow: gross, net, yield and growth. */
const flowPair = (v2: string, v1: string): PathPair[] =>
  (['gross', 'net', 'yield', 'growth.annualized'] as const).map((k): PathPair => [
    `holder flow line ${v2}${k === 'gross' ? '' : ` ${k}`}`, `${IS}.holderFlow.lines[id=${v2}].${k}`, `flows[id=${v1}].${k}`,
  ]);
const protocolIncome = (v2: string, v1: string): PathPair => [`protocol line ${v2}`, `${IS}.protocol.lines[id=${v2}].annualized`, `income.lines[id=${v1}].annualized`];
/** The volume figures (reporting.volume and income_statement.volume list the same series). */
const VOLUME: PathPair[] = [
  ['volume', `${IS}.volume.annualized`, 'volume.annualized'],
  ['volume growth', `${IS}.volume.growth.annualized`, 'volume.growth.annualized'],
];
const without = (pairs: PathPair[], ...labels: string[]): PathPair[] => pairs.filter(([label]) => !labels.includes(label));

/**
 * The parity map (ruling R7): for each of the 10 assets whose figures v2 leaves unchanged, [label, v2 path in the report
 * JSON, v1 path in today's report JSON]. Every path names one stored number. tools/phase2-proof/parity.json is this
 * object as JSON (tools/phase2-proof/write-parity.ts writes it; tests/report/parity.test.ts asserts they agree).
 */
export const PARITY_PATHS: Record<string, PathPair[]> = {
  aero: [...commonPairs('cash'), revIncome('fees', 'voter_fees'), holderIncome('voter_fees', 'voter_fees'), ...flowPair('voter_fees', 'fees')],
  cake: [
    ...commonPairs('burn'), revIncome('burn_rev', 'burn'), revIncome('treasury_rev', 'treasury'), holderIncome('burn', 'burn'), protocolIncome('treasury', 'treasury'),
    ...flowPair('burn', 'burn'), ...VOLUME,
  ],
  crv: [
    ...commonPairs('cash'), revIncome('fees', 'vecrv_fees'), revIncome('treasury_rev', 'treasury'), holderIncome('vecrv_fees', 'vecrv_fees'), protocolIncome('treasury', 'treasury'),
    ...flowPair('vecrv_fees', 'fees'), ...flowPair('vote_incentives', 'vote_incentives'),
    ['below line to holders = v1 vote incentives', `${IS}.belowLine.toHolders`, 'flows[id=vote_incentives].gross'],
  ],
  cvxcrv: [
    ...commonPairs('cash'), revIncome('vecrv_fees_rev', 'vecrv_fees'), revIncome('platform_cvxcrv', 'crv_lock_incentive'), revIncome('platform_cvx', 'cvx_stakers'),
    revIncome('platform_treasury', 'treasury'), revIncome('callers_fee', 'callers'),
    holderIncome('vecrv_fees', 'vecrv_fees'), holderIncome('crv', 'crv_lock_incentive'), protocolIncome('cvx_stakers', 'cvx_stakers'), protocolIncome('treasury', 'treasury'),
    ['operating cost line callers', `${IS}.operatingCosts.lines[id=callers].annualized`, 'income.lines[id=callers].annualized'],
    ...flowPair('vecrv_fees', 'fees'), ...flowPair('crv', 'crv'), ...flowPair('cvx_rewards', 'cvx'),
    ['below line to holders = v1 outside revenue', `${IS}.belowLine.toHolders`, 'income.outsideRevenue[id=cvx_rewards].annualized'],
    ...VOLUME,
  ],
  hype: [
    ...commonPairs('burn'), ...revStream('trading'), ...revStream('reserve_yield'), holderIncome('af_buyback', 'af_buyback'), holderIncome('reserve_yield_paid', 'reserve_yield'),
    ['revenue growth ex new streams', `${IS}.revenue.growthExNew.annualized`, 'revenue.growthExNew.annualized'],
    ...flowPair('af_buyback', 'af_buyback'), ...flowPair('reserve_yield_paid', 'reserve_yield'),
  ],
  link: [...commonPairs('hold'), ...revStream('onchain_fees'), holderIncome('reserve', 'reserve'), ...flowPair('reserve', 'reserve')],
  pump: [...commonPairs('burn'), ...revStream('protocol'), holderIncome('buyback', 'buyback'), ...flowPair('buyback', 'buyback')],
  // SKY's v1 protocol income is a remainder of the very series its holders lines read (revenue streams less the same
  // streams), so it is 0 only up to rounding (-1e-10 on synthetic data); v2 lists no protocol section and reports an
  // exact 0. A relative tolerance cannot compare a rounding residue with 0, so the protocol pairs are left out.
  sky: [
    ...without(commonPairs('cash'), 'protocol', 'protocol growth'), ...revStream('surplus_usds'), ...revStream('surplus_buyback'), holderIncome('stakers', 'stakers'),
    holderIncome('buyback', 'buyback'), ...flowPair('stakers', 'stakers'), ...flowPair('buyback', 'buyback'),
  ],
  uni: [...commonPairs('burn'), ...revStream('protocol_fees'), holderIncome('burn', 'burn'), ...flowPair('burn', 'burn'), ...VOLUME],
  // VVV's revenue is a disclosed level: v1's income statement has no growth for it (null), while the published
  // `revenue.growth` is the growth between the two latest disclosures, which v2 carries. Pair against the published one.
  vvv: [
    ...without(commonPairs('burn'), 'revenue growth'), ...revStream('business'), holderIncome('burn', 'burn'), ...flowPair('burn', 'burn'),
    ['revenue cross-check', `${IS}.revenue.lines[id=business].crossCheck.annualized`, 'revenue.crossCheck.annualized'],
  ],
};

/** PARITY[a](v2, v1): each pair's two values, read from the same paths compare.py reads in the report JSON. */
export const PARITY: Record<string, (v2: IsV2, v1: HolderYieldReport) => [label: string, a: number | null, b: number | null][]> = Object.fromEntries(
  Object.entries(PARITY_PATHS).map(([a, pairs]) => [
    a,
    (v2: IsV2, v1: HolderYieldReport) => {
      const newSide = { [IS]: v2 };
      const num = (x: unknown, where: string): number | null => {
        if (x === null) return null;
        if (typeof x !== 'number') throw new Error(`parity ${a}: ${where} is ${x === undefined ? 'missing' : JSON.stringify(x)}`);
        return x;
      };
      return pairs.map(([label, p2, p1]) => [label, num(getPath(newSide, p2), p2), num(getPath(v1, p1), p1)] as [string, number | null, number | null]);
    },
  ]),
);
