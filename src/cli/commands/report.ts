import type { Command } from 'commander';
import { listAssetIds, loadAsset } from '../../config/load.js';
import { loadHolderYieldReport, type YieldReport } from '../../report/load.js';
import type { Growth, HolderYieldReport } from '../../report/holderYield.js';
import type { IsV2 } from '../../report/incomeStatement.js';
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

/** Income statement v2 (spec 7) as text: each section's total, its lines, then holder flow, ratios, multiples and flags. */
export function statementLines(is: IsV2): string[] {
  const m = (x: number | null) => (x === null ? 'n/a' : `${x.toFixed(1)}x`);
  const nm = (x: { notMeasured?: string }) => (x.notMeasured !== undefined ? ` (not measured: ${x.notMeasured})` : '');
  const line = (id: string, annualized: number | null, tag: string) => `      ${id.padEnd(22)} ${usd(annualized)}${tag}`;
  const lines = [`  income statement v2 (annualized, ${is.windowDays}d; scope ${is.scope}, category ${is.category}):`];
  lines.push(`    revenue          ${usd(is.revenue.annualized)}${is.revenue.provisional ? ' (part provisional)' : ''}  growth ${g(is.revenue.growth)}${is.revenue.growthExNew ? `  ex new (${is.revenue.excludedFromExNew.join(', ')}) ${g(is.revenue.growthExNew)}` : ''}`);
  for (const l of is.revenue.lines) lines.push(line(l.id, l.annualized, `  ${l.method}${nm(l)}`));
  if (is.costOfRevenue.lines.length > 0) {
    lines.push(`    cost of revenue  ${is.costOfRevenue.annualized === null ? `n/a (measured part ${usd(is.costOfRevenue.measuredAnnualized)})` : usd(is.costOfRevenue.annualized)}`);
    for (const l of is.costOfRevenue.lines) lines.push(line(`${l.to} ${l.id}`, l.annualized, `  ${l.method}${nm(l)}`));
  }
  lines.push(`    gross profit     ${is.grossProfit.annualized === null ? 'n/a (cost of revenue not measured)' : `${usd(is.grossProfit.annualized)}  growth ${g(is.grossProfit.growth)}`}`);
  const ratio = is.ratios.payoutRatio === null ? 'n/a' : `${pct(is.ratios.payoutRatio)} of ${is.ratios.payoutRatioBasis === 'revenue' ? 'revenue' : 'gross profit'}`;
  lines.push(`    holders          ${usd(is.holders.annualized)}  payout ${ratio}  growth ${g(is.holders.growth)}`);
  for (const l of is.holders.lines) lines.push(line(`${l.bucket} ${l.id}`, l.annualized, `  ${l.method}${nm(l)}`));
  for (const [name, sec] of [['protocol', is.protocol], ['operating costs', is.operatingCosts]] as const) {
    if (sec.lines.length === 0 && sec.annualized === 0) continue;
    lines.push(`    ${name.padEnd(16)} ${usd(sec.annualized)}${sec.remainder ? ' (remainder)' : ''}`);
    if (!sec.remainder) for (const l of sec.lines) lines.push(line(l.id, l.annualized, `  ${l.method}${nm(l)}`));
  }
  // Shown unless it rounds to $0.00M (a float residue of summing the same series in another order).
  if (is.unreconciled.annualized === null || Math.abs(is.unreconciled.annualized) >= 5_000) lines.push(`    unreconciled     ${usd(is.unreconciled.annualized)} (${pct(is.unreconciled.pct)} of ${is.unreconciled.basis === 'revenue' ? 'revenue less measured costs' : 'gross profit'})`);
  if (is.belowLine.lines.length > 0) {
    lines.push(`    below the line   to holders ${usd(is.belowLine.toHolders)}  to protocol ${usd(is.belowLine.toProtocol)}`);
    for (const l of is.belowLine.lines) lines.push(line(`${l.to} ${l.id}`, l.annualized, `  ${l.method}${nm(l)}`));
  }
  const hf = is.holderFlow;
  const buckets = (['burn', 'hold', 'cash'] as const).filter((b) => hf.byBucket[b] !== null).map((b) => `${b} ${usd(hf.byBucket[b]!.net)} (yield ${pct(hf.byBucket[b]!.yield, 2)})`);
  lines.push(`  holder flow: gross ${usd(hf.gross)}  net ${usd(hf.net)}${buckets.length > 0 ? `  ${buckets.join('  ')}` : ''}  from below the line ${usd(hf.fromBelowLine)}  growth ${g(hf.growth)}`);
  const mx = is.multiples;
  lines.push(`  multiples: mcap/revenue ${m(mx.mcapToRevenue)}  mcap/gross profit ${m(mx.mcapToGrossProfit)}  mcap/holder flow ${m(mx.mcapToHolderFlow.total)}  take rate ${pct(is.ratios.takeRate)}  net holder yield ${pct(is.yields.netShareholder, 2)}`);
  if (is.flags.length > 0) lines.push(`  flags: ${is.flags.join('; ')}`);
  return lines;
}

/** `report yield` text: the header, the v2 statement block, then (with --legacy) the v1 lines, then the notes. */
export function reportLines(r: YieldReport | HolderYieldReport): string[] {
  const head = `${r.asset}  day ${r.day}  window ${r.windowDays}d  price ${r.price ?? 'n/a'}  mcap ${usd(r.marketCap)}  fdv ${usd(r.fdv)}`;
  const v2 = r.incomeStatement ? statementLines(r.incomeStatement) : [];
  const v1 = 'flows' in r ? legacyLines(r) : [];
  return [head, ...v2, ...v1, ...r.notes.map((n) => `  note: ${n}`)];
}

/** The v1 lines (`--legacy`), between the header and the notes. */
function legacyLines(r: HolderYieldReport): string[] {
  const y = r.yields;
  const lines = [
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
        s.share !== undefined ? `${pct(s.share)} of gross ${usd(s.grossAnnualized ?? null)}` : null,
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
  return lines;
}

export function registerReport(program: Command, ctx: CliContext): void {
  const report = program.command('report').description('report-only series: holder yield, growth, protocol revenue');
  report
    .command('yield [asset]')
    .description('holder yield by bucket (burn, hold, cash), yields on price, 90d-over-90d growth, protocol revenue; every asset with a reporting block when no asset is given')
    .option('--day <yyyy-mm-dd>', 'the last day the report covers (default: the newest day every holder flow has)')
    .option('--json', 'JSON output')
    .option('--legacy', 'also the v1 keys (flows, buckets, yields, holderFlowGrowth, supply, income, revenue, volume, revenueDisclosed), in v1 order with incomeStatement last; kept one release (D9)')
    .action(async (assetId: string | undefined, opts: { day?: string; json?: boolean; legacy?: boolean }) => {
      if (opts.day !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(opts.day)) throw new OrionError('invalid_day', '--day must be YYYY-MM-DD');
      const ids = assetId ? [assetId] : listAssetIds(ctx.configRoot).filter((id) => loadAsset(ctx.configRoot, id).config.reporting !== undefined);
      const reports = await withDb(ctx, async (db) => {
        const out: (YieldReport | HolderYieldReport)[] = [];
        for (const id of ids) {
          const asset = loadAsset(ctx.configRoot, id).config;
          if (!asset.reporting) throw new OrionError('no_reporting', `assets/${id}.yaml has no reporting block`);
          out.push(await loadHolderYieldReport(db, asset, opts.day, { legacy: opts.legacy === true }));
        }
        return out;
      });
      output(ctx, opts.json, assetId ? reports[0] : reports, () => reports.flatMap(reportLines));
    });
}
