import type { Command } from 'commander';
import { listAssetIds, loadAsset } from '../../config/load.js';
import { loadHolderYieldReport } from '../../report/load.js';
import type { Growth, HolderYieldReport } from '../../report/holderYield.js';
import { OrionError } from '../../types.js';
import { output, withDb, type CliContext } from '../util.js';

const usd = (x: number | null) => (x === null ? 'n/a' : `$${(x / 1e6).toFixed(2)}M`);
const pct = (x: number | null, d = 1) => (x === null ? 'n/a' : `${(x * 100).toFixed(d)}%`);
const g = (x: Growth) => (x.annualized === null ? `n/m${x.change !== null ? ` (90d/90d ${pct(x.change)})` : ''}` : `${pct(x.annualized)} ann. (${pct(x.change)} per window)`);

export function reportLines(r: HolderYieldReport): string[] {
  const y = r.yields;
  const lines = [
    `${r.asset}  day ${r.day}  window ${r.windowDays}d  price ${r.price ?? 'n/a'}  mcap ${usd(r.marketCap)}`,
    ...r.flows.map((f) => `  ${f.bucket.padEnd(4)}  ${f.id.padEnd(16)} gross ${usd(f.gross)}  haircut ${pct(f.haircut)}  net ${usd(f.net)}  yield ${pct(f.yield, 2)}  growth ${g(f.growth)}`),
    `  yields: cash ${pct(y.cash, 2)}  buyback ${pct(y.buyback, 2)}  shareholder ${pct(y.shareholder, 2)}  dilution ${pct(y.dilution, 2)}  net ${pct(y.netShareholder, 2)}`,
    `  multiple ${y.multiple === null ? 'n/a' : `${y.multiple.toFixed(1)}x`}  holder-flow growth ${g(r.holderFlowGrowth)}  trailing PEG ${y.pegTrailing === null ? 'n/m' : y.pegTrailing.toFixed(2)}`,
  ];
  if (r.revenue) lines.push(`  protocol revenue ${usd(r.revenue.annualized)}  growth ${g(r.revenue.growth)}`);
  if (r.volume) lines.push(`  gross volume ${usd(r.volume.annualized)}  growth ${g(r.volume.growth)}`);
  if (r.revenueDisclosed) {
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
