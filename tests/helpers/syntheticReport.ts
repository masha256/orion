import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseAssetYaml } from '../../src/config/load.js';
import type { AssetConfig } from '../../src/config/schema.js';
import { addDays } from '../../src/ingest/time.js';
import type { ReportInput, ReportLevels } from '../../src/report/holderYield.js';
import { reportFlowMetrics } from '../../src/report/load.js';

export const ALL_ASSETS = ['aero', 'cake', 'crv', 'cvxcrv', 'hype', 'link', 'lit', 'pump', 'sdcrv', 'sky', 'uni', 'vvv', 'ycrv'] as const;
export const SYNTHETIC_DAY = '2026-11-02';

/**
 * The flows each repo asset's synthetic input carries, in the order the report read them at cc59fa7 (before Task 11): a
 * series' scale depends on its place, so this frozen list keeps every synthetic input, and the golden reports built on
 * them (tests/report/v2Golden.test.ts), unchanged. yCRV keeps its st-yCRV fee, which no line reads since Task 11.
 */
const SYNTHETIC_FLOWS: Record<string, string[]> = {
  aero: ['flow_usd.fees'],
  cake: ['flow_usd.burn', 'flow_usd.treasury', 'flow_usd.fees', 'flow_tokens.burn'],
  crv: ['flow_usd.fees', 'flow_usd.curve_treasury', 'flow_usd.protocol_revenue'],
  cvxcrv: ['flow_usd.fees', 'flow_usd.crv', 'flow_usd.cvx', 'flow_usd.convex_rev_cvxcrv', 'flow_usd.convex_rev_cvx', 'flow_usd.convex_rev_treasury', 'flow_usd.convex_gross_crv'],
  hype: ['flow_usd.af_buyback', 'flow_usd.revenue_proxy', 'flow_usd.reserve_yield'],
  link: ['flow_usd.reserve'],
  lit: ['flow_usd.buyback', 'flow_usd.fees_core', 'flow_usd.fees_rh', 'flow_tokens.buyback'],
  pump: ['flow_usd.buyback', 'flow_usd.llama_revenue', 'flow_tokens.buyback'],
  sdcrv: ['flow_usd.fees', 'flow_usd.crv', 'flow_usd.bribes', 'flow_usd.sd_rev_crv_vesdt', 'flow_usd.sd_rev_crv_treasury', 'flow_usd.sd_rev_fees_liquidity', 'flow_usd.sd_rev_fees_treasury', 'flow_usd.sd_boost_delegation', 'flow_usd.sd_rev_crv', 'flow_usd.sd_gross_crv'],
  sky: ['flow_usd.stakers', 'flow_usd.buyback'],
  uni: ['flow_usd.burn', 'flow_usd.swap_fees', 'flow_tokens.burn'],
  vvv: ['flow_usd.burn', 'flow_usd.revenue_proxy'],
  ycrv: ['flow_usd.fees', 'flow_usd.yearn_revenue', 'flow_usd.yearn_styc_fee', 'flow_usd.yearn_gross', 'flow_usd.yearn_gross_fees', 'flow_usd.yearn_gross_incentives'],
};

export function repoAsset(id: string): AssetConfig {
  return parseAssetYaml(readFileSync(fileURLToPath(new URL(`../../assets/${id}.yaml`, import.meta.url)), 'utf8')).config;
}

/** A deterministic value in (0.4, 1.6) per (metric, day index): uneven days, so window sums and growth are not trivial. */
function wiggle(metric: string, i: number): number {
  let h = 0;
  for (const c of metric) h = (h * 31 + c.charCodeAt(0)) % 100_003;
  return 1 + 0.45 * Math.sin(i * 0.37 + h) + 0.15 * Math.cos(i * 1.3 + h / 7);
}

/**
 * A report input for a repo asset with synthetic 200-day series on every flow the report reads (none before a stream's
 * `started`), the last 4 days of a periodic stream provisional, and fixed levels (run-rate, dilution and disclosed
 * levels included).
 */
export function syntheticInput(asset: AssetConfig, day = SYNTHETIC_DAY): ReportInput {
  const started = new Map<string, string>();
  for (const l of asset.income_statement?.revenue ?? []) if (l.metric && l.started) started.set(l.metric, l.started);
  const periodic = new Set((asset.income_statement?.revenue ?? []).filter((l) => l.settlement === 'periodic').map((l) => l.metric!));
  const daily = new Map<string, Map<string, number>>();
  const provisional = new Map<string, Set<string>>();
  (SYNTHETIC_FLOWS[asset.id] ?? reportFlowMetrics(asset)).forEach((m, k) => {
    const series = new Map<string, number>();
    const scale = 1000 * (k + 1) * (m.startsWith('flow_tokens.') ? 3 : 1);
    for (let i = 0; i < 200; i++) {
      const d = addDays(day, -i);
      const s = started.get(m);
      if (s !== undefined && d < s) continue;
      series.set(d, scale * wiggle(m, i) * (1 + i / 400));
    }
    daily.set(m, series);
    if (periodic.has(m)) provisional.set(m, new Set([0, 1, 2, 3].map((i) => addDays(day, -i))));
  });
  // A sum check over flow metrics alone partitions its total (yCRV's gross by sender, Task 7b): the total is the parts'
  // sum each day, as the one scan writes them, so an apportion mix lies in (0, 1).
  for (const c of asset.income_statement?.checks ?? []) {
    if (c.type !== 'sum' || c.total.length !== 1 || !c.parts.every((p) => asset.metrics[p] !== undefined && daily.has(p))) continue;
    const sum = new Map<string, number>();
    for (const d of daily.get(c.parts[0]!)!.keys()) sum.set(d, c.parts.reduce((s, p) => s + (daily.get(p)!.get(d) ?? 0), 0));
    daily.set(c.total[0]!, sum);
  }
  const extra: Record<string, number | null> = {};
  for (const b of asset.income_statement?.below_line ?? []) if (b.run_rate) extra[b.run_rate] = 4_321_000;
  const dilution: ReportLevels['dilution'] = asset.income_statement?.dilution
    ? Object.fromEntries(asset.income_statement.dilution.map((d) => [d.id, { rate: 2_000_000, cap: d.cap_metric ? 1_500_000 : null }]))
    : undefined;
  const levels: ReportLevels = {
    price: 1.7,
    totalSupply: 1_000_000_000,
    circulatingSupply: asset.metrics.circulating_supply ? 600_000_000 : null,
    stakedSupply: 300_000_000,
    lockedSupply: asset.metrics.locked_supply ? 200_000_000 : null,
    emissionRateAnnual: 10_000_000,
    extra,
    ...(dilution ? { dilution } : {}),
    disclosed: asset.income_statement?.revenue.some((l) => l.disclosed !== undefined)
      ? [{ observedAt: '2026-06-01T00:00:00.000Z', value: 90_000_000 }, { observedAt: '2026-10-01T00:00:00.000Z', value: 100_000_000 }]
      : [],
    asOf: `${addDays(day, 1)}T23:59:59.999Z`,
  };
  return { asset, day, daily, provisional, levels };
}
