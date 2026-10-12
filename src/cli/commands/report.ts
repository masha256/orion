import type { Command } from 'commander';
import { listAssetIds, loadAsset } from '../../config/load.js';
import { loadHolderYieldReport } from '../../report/load.js';
import type { Growth, HolderYieldReport } from '../../report/holderYield.js';
import { OrionError } from '../../types.js';
import { output, withDb, type CliContext } from '../util.js';

const usd = (x: number | null) => (x === null ? 'n/a' : `$${(x / 1e6).toFixed(2)}M`);
const pct = (x: number | null, d = 1) => (x === null ? 'n/a' : `${(x * 100).toFixed(d)}%`);
/** Growth: the annualized change, or why there is none (too little history vs. a zero or negative window). */
const g = (x: Growth) => {
  if (x.annualized !== null) return `${pct(x.annualized)} ann. (${pct(x.change)} per window)`;
  if (x.note?.startsWith('a disclosed')) return `n/a (${x.note})`;
  if (x.current === null || x.prior === null) return 'pending (needs 2 windows of daily history)';
  return `n/m${x.change !== null ? ` (per window ${pct(x.change)})` : ''}`;
};

export function reportLines(r: HolderYieldReport): string[] {
  const y = r.yields;
  const lines = [
    `${r.asset}  day ${r.day}  window ${r.windowDays}d  price ${r.price ?? 'n/a'}  mcap ${usd(r.marketCap)}  fdv ${usd(r.fdv)}`,
    ...r.flows.map((f) => `  ${f.bucket.padEnd(4)}  ${f.id.padEnd(16)} gross ${usd(f.gross)}  haircut ${pct(f.haircut)}  net ${usd(f.net)}  yield ${pct(f.yield, 2)}  growth ${g(f.growth)}`),
    `  yields: cash ${pct(y.cash, 2)}  buyback ${pct(y.buyback, 2)}  shareholder ${pct(y.shareholder, 2)}  dilution ${pct(y.dilution, 2)}  net ${pct(y.netShareholder, 2)}`,
    ...(y.dilutionLines ?? []).map((d) => `    dilution: ${d.id} ${d.tokensPerYear === null ? 'n/a' : `${(d.tokensPerYear / 1e6).toFixed(2)}M tokens/yr`} (${pct(d.yield, 2)} of supply)`),
    `  multiple ${y.multiple === null ? 'n/a' : `${y.multiple.toFixed(1)}x`}  holder-flow growth ${g(r.holderFlowGrowth)}  trailing PEG ${y.pegTrailing === null ? 'n/m' : y.pegTrailing.toFixed(2)}`,
  ];
  if (r.supply) {
    const s = r.supply;
    const m = (x: number | null) => (x === null ? 'n/a' : `${(x / 1e6).toFixed(2)}M`);
    lines.push(`  supply (tokens/yr, ${r.windowDays}d): burned ${m(s.burnedPerYear)}  added ${m(s.addedPerYear)}  net ${m(s.netPerYear)} (${pct(s.netPct, 2)} of supply; negative shrinks)`);
  }
  if (r.revenue && r.revenue.basis !== 'income') {
    const v = r.revenue;
    lines.push(`  revenue ${usd(v.annualized)}${v.provisional ? ' (part provisional)' : ''}  growth ${g(v.growth)}${v.growthExNew ? `  ex new streams (${v.excludedFromExNew.join(', ')}) ${g(v.growthExNew)}` : ''}`);
    for (const s of v.streams) {
      const tags = [
        s.basis,
        s.daysInWindow !== null ? `run rate over ${s.daysInWindow}d` : null,
        s.provisionalDays > 0 ? `${s.provisionalDays}d provisional` : null,
        s.isNew ? `new since ${s.started}` : null,
        s.holderFlow ? `also holder flow (${s.holderFlow})` : null,
      ].filter((x) => x !== null);
      lines.push(`    stream ${s.id.padEnd(16)} ${usd(s.annualized)}  ${s.label ? `${s.label}  ` : ''}[${tags.join(', ')}]  growth ${g(s.growth)}`);
    }
    if (v.disclosedGrowth) {
      const d = v.disclosedGrowth;
      lines.push(`    disclosed growth ${d.annualized === null ? 'n/m' : `${pct(d.annualized)} ann.`}${d.gapDays !== null ? ` over ${d.gapDays}d` : ''}${d.flags.length ? `  flags: ${d.flags.join('; ')}` : ''}`);
    }
    if (v.crossCheck) lines.push(`    cross-check ${v.crossCheck.metric} ${usd(v.crossCheck.annualized)} (third-party proxy; not revenue)`);
  }
  if (r.income) {
    const i = r.income;
    lines.push(`  income statement (annualized, ${r.windowDays}d):`);
    lines.push(`    revenue          ${usd(i.revenue.annualized)}  growth ${g(i.revenue.growth)}`);
    lines.push(`    paid to holders  ${usd(i.holders.annualized)}  payout ${pct(i.payoutRatio)}  growth ${g(i.holders.growth)}`);
    if (i.costs.annualized !== null && i.costs.annualized !== 0) lines.push(`    costs            ${usd(i.costs.annualized)}`);
    lines.push(`    protocol income  ${usd(i.protocol.annualized)}  margin ${pct(i.protocolMargin)}  growth ${g(i.protocol.growth)}`);
    for (const l of i.lines) lines.push(`      ${l.to.padEnd(8)} ${l.id.padEnd(22)} ${usd(l.annualized)}${l.basis !== 'measured' ? ` (${l.basis})` : ''}`);
    for (const c of i.checks) lines.push(`    check: ${c.parts.join(' + ')} = ${usd(c.sumOfParts)} vs measured ${usd(c.measured)}${c.gapPct === null ? '' : ` (gap ${c.gapPct.toFixed(1)}%)`}`);
    for (const o of i.outsideRevenue) lines.push(`    outside revenue: ${o.id} ${usd(o.annualized)} to holders${o.note ? ` (${o.note})` : ''}`);
  }
  if (r.volume) lines.push(`  gross volume ${usd(r.volume.annualized)}  growth ${g(r.volume.growth)}`);
  if (r.revenueDisclosed && !(r.revenue && r.revenue.basis === 'disclosed')) {
    const d = r.revenueDisclosed;
    lines.push(`  disclosed revenue ${usd(d.latest)} (${d.latestAt ?? 'none'})  growth ${d.annualizedGrowth === null ? 'n/m' : pct(d.annualizedGrowth)}`);
  }
  for (const n of r.notes) lines.push(`  note: ${n}`);
  return lines;
}

export function registerReport(program: Command, ctx: CliContext): void {
  const report = program.command('report').description('report-only series: holder yield, growth, protocol revenue');
  report
    .command('yield [asset]')
    .description('holder yield by bucket (burn, hold, cash), yields on price, 90d-over-90d growth, protocol revenue; every asset with a reporting block when no asset is given')
    .option('--day <yyyy-mm-dd>', 'the last day the report covers (default: the newest day every holder flow has)')
    .option('--json', 'JSON output')
    .action((assetId: string | undefined, opts: { day?: string; json?: boolean }) => {
      if (opts.day !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(opts.day)) throw new OrionError('invalid_day', '--day must be YYYY-MM-DD');
      const ids = assetId ? [assetId] : listAssetIds(ctx.home).filter((id) => loadAsset(ctx.home, id).config.reporting !== undefined);
      const reports = withDb(ctx, (db) =>
        ids.map((id) => {
          const asset = loadAsset(ctx.home, id).config;
          if (!asset.reporting) throw new OrionError('no_reporting', `assets/${id}.yaml has no reporting block`);
          return loadHolderYieldReport(db, asset, opts.day);
        }),
      );
      output(ctx, opts.json, assetId ? reports[0] : reports, () => reports.flatMap(reportLines));
    });
}
