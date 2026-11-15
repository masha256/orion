import { join } from 'node:path';
import type { Command } from 'commander';
import { listAssetIds, loadAsset } from '../../config/load.js';
import { decideAnomaly, listAnomalies, type Anomaly } from '../../db/anomalies.js';
import { confirmObservation, getObservationsByIds, insertObservation, listActiveObservations, rejectObservation } from '../../db/observations.js';
import { compareUsd, type UsdComparison } from '../../db/prices.js';
import { rebuildPriceLevels, type RebuildResult } from '../../db/priceLevels.js';
import { purgeMetrics, purgePrices, type PurgePricesResult, type PurgeResult } from '../../db/purge.js';
import { repriceAsset, type RepriceResult } from '../../db/reprice.js';
import { describeSources } from '../../ingest/describe.js';
import { backfillTokens, type BackfillTokensResult } from '../../ingest/tokenBackfill.js';
import { lockHolder, withRunLock } from '../../app/lock.js';
import { hasSources } from '../../ingest/plan.js';
import { fetchAsset, type FetchResult } from '../../ingest/run.js';
import { disclosedProvenance } from '../../provenance/locator.js';
import type { SourceType } from '../../report/sourceTypes.js';
import { OrionError } from '../../types.js';
import { fetchSummary, guarded, ingestDepsFor, output, parseNumber, withDb, type CliContext } from '../util.js';

interface FetchOpts {
  metric: string[];
  backfillDays?: string;
  adopt?: boolean;
  dryRun?: boolean;
  json?: boolean;
}

interface SetOpts {
  at?: string;
  periodDays?: string;
  detail?: string;
  provisional?: boolean;
  citation?: string;
  quote?: string;
  json?: boolean;
}

const collect = (value: string, previous: string[]): string[] => [...previous, value];

/** `data reprice`'s exit when a row is refused (distinct from 1, an error): the refused rows are still listed. */
export const REPRICE_REFUSED_EXIT = 3;

const anomalyLine = (a: Anomaly): string =>
  `#${a.id}  ${a.status}  ${a.severity}  ${a.kind}  ${a.metricKey || '(source)'}  ${a.dedupeKey}  x${a.occurrences}  last seen ${a.lastSeenAt}${a.note ? `  note: ${a.note}` : ''}`;


function positiveDays(text: string | undefined, label: string): number | undefined {
  if (text === undefined) return undefined;
  const n = parseNumber(text, label);
  if (!Number.isInteger(n) || n < 1) throw new OrionError('invalid_number', `${label} must be a positive whole number`);
  return n;
}

const pct = (v: number | null): string => (v === null ? 'n/a' : `${v >= 0 ? '+' : ''}${v.toFixed(3)}%`);
const usd = (v: number): string => v.toFixed(2);

function backfillTokenLines(r: BackfillTokensResult): string[] {
  return [
    `${r.assetId.toUpperCase()} backfill-tokens${r.dryRun ? ' (dry run: nothing was written)' : ''}: ${r.range ? `${r.range.from} to ${r.range.to}` : 'no range'}; ` +
      `${r.dryRun ? 'would fill' : 'filled'} ${r.filled} row(s), ${r.alreadyFilled} already had tokens, ${r.skipped.length} skipped, ${r.refused.length} day(s) refused`,
    ...r.refused.map((x) => `  REFUSED ${x.day}: ${x.reason}`),
    ...r.skipped.map((x) => `  skipped ${x.day} ${x.metricKey}: ${x.reason}`),
    ...r.notes.map((n) => `  note: ${n}`),
  ];
}

function purgeLines(r: PurgeResult, sourceType: string | undefined, exportDir: string): string[] {
  return [
    `${r.asset.toUpperCase()} purge${r.applied ? '' : ' (dry run)'}, ${sourceType === undefined ? 'all source types' : `source type ${sourceType}`}:`,
    ...r.perMetric.flatMap((m) => [
      `  ${m.metric} (${m.configured ? 'configured' : 'not configured'}): ${m.observations} observation(s), ${m.superseded} superseded, ` +
        `${m.firstDay === null ? 'no rows' : `${m.firstDay} to ${m.lastDay}`}, value sum ${m.valueSum}; ` +
        `latest_levels ${m.latestLevels}, watch_state ${m.watchState}, fetch_cursors ${m.fetchCursors}` +
        // A market_data price-level purge (Ruling R38): the rows before valid_from it deletes with no rebuilt row.
        (m.withoutReplacement !== undefined ? `; ${m.withoutReplacement.length} without replacement` : ''),
      ...(m.withoutReplacement ?? []).map((x) => `    WITHOUT REPLACEMENT #${x.id} ${x.day} (${x.observedAt}): before valid_from, deleted with no rebuilt row`),
    ]),
    !r.applied
      ? `dry run: nothing deleted; --yes deletes and exports to ${exportDir}`
      : r.exportFile === null
        ? 'nothing to delete'
        : `deleted; exported to ${r.exportFile} sha256 ${r.exportSha256}`,
  ];
}

function repriceLines(r: RepriceResult, exportDir: string): string[] {
  const skipped = (s: Record<string, number>): string => {
    const e = Object.entries(s).sort(([a], [b]) => (a < b ? -1 : 1));
    return e.length === 0 ? 'none' : e.map(([k, v]) => `${v} ${k}`).join(', ');
  };
  return [
    `${r.asset.toUpperCase()} reprice${r.applied ? '' : ' (dry run)'}, ${r.from === null ? 'every day' : `from ${r.from}`}:`,
    ...r.remapped.map((m) => `  remap ${m.from} -> ${m.to}: ${m.rows} row(s)`),
    ...r.perMetric.flatMap((m) => [
      `  ${m.metric}: ${m.rows} row(s): ${m.repriced} repriced (value sum ${usd(m.oldSum)} -> ${usd(m.newSum)}), ${m.unchanged} unchanged, ` +
        `${m.refused.length} refused; skipped: ${skipped(m.skipped)}; inactive: ${m.inactiveCoingeckoRows} superseded/rejected CoinGecko-priced row(s), kept as written`,
      ...m.refused.map((x) => `    REFUSED #${x.id} ${x.day}: ${x.reason}`),
    ]),
    ...r.derived.map((d) => `  derived ${d.metric}: ${d.rows} row(s), ${d.recomputed} recomputed, ${d.unchanged} unchanged, ${d.incomplete} with an incomplete window`),
    !r.applied
      ? `dry run: nothing written; --yes reprices (one transaction per day) after exporting to ${exportDir}`
      : r.exportFile === null
        ? 'nothing to reprice'
        : `repriced ${r.days} day(s); exported to ${r.exportFile} sha256 ${r.exportSha256}`,
  ];
}

function rebuildLines(r: RebuildResult): string[] {
  return [
    `${r.asset.toUpperCase()} rebuild-price-levels${r.applied ? '' : ' (dry run)'}:`,
    ...(r.perMetric.length === 0 ? ['  no price_usd or diem_price_usd metric'] : []),
    ...r.perMetric.flatMap((m) => [
      `  ${m.metric} (${m.tokenRef ?? 'no price ref'}): ${m.rows} CoinGecko row(s), ${m.rebuilt} ${r.applied ? 'rebuilt' : 'to rebuild'}, ${m.refused.length} refused` +
        (m.beforeValidFrom.length > 0 ? `, ${m.beforeValidFrom.length} before valid_from (never rebuilt; data purge deletes them without replacement)` : ''),
      ...m.refused.map((x) => `    REFUSED #${x.id} ${x.observedAt}: ${x.reason}`),
      ...m.beforeValidFrom.map((x) => `    BEFORE VALID_FROM #${x.id} ${x.observedAt}`),
    ]),
    r.applied ? `wrote ${r.days} day(s); the CoinGecko rows are superseded (data purge --source-type market_data deletes them)` : 'dry run: nothing written; --yes writes the rebuilt rows',
  ];
}

function purgePricesLines(r: PurgePricesResult, exportDir: string): string[] {
  return [
    `purge-prices ${r.source}${r.applied ? '' : ' (dry run)'}:`,
    ...(r.prices.length === 0 ? ['  no prices rows of this source'] : r.prices.map((p) => `  ${p.tokenRef}: ${p.rows} row(s), ${p.firstTs} to ${p.lastTs}`)),
    `  tokens rows to delete: ${r.deletedTokens.length === 0 ? 'none' : r.deletedTokens.join(', ')}`,
    ...r.keptTokens.map((k) => `  kept tokens row ${k.tokenRef}: ${k.reason}`),
    !r.applied
      ? `dry run: nothing deleted; --yes deletes and exports to ${exportDir}`
      : r.exportFile === null
        ? 'nothing to delete'
        : `deleted; exported to ${r.exportFile} sha256 ${r.exportSha256}`,
  ];
}

function compareLines(assetId: string, days: number, rows: UsdComparison[]): string[] {
  if (rows.length === 0) return [`${assetId.toUpperCase()}: no USD flow metric`];
  return [
    `${assetId.toUpperCase()} legacy USD vs the chain-priced USD (flow_usd_chain_v), ${days} days`,
    ...rows.flatMap((r) => [
      `  ${r.metric}: ${r.hourlyCovered} day(s) priced: legacy ${usd(r.sumLegacy)} vs chain ${usd(r.sumHourly)} (${pct(r.gapPct)}), day gap p50 ${pct(r.p50DayGapPct)} p90 ${pct(r.p90DayGapPct)}` +
        `${r.dailyMean > 0 ? ` (${r.dailyMean} on the daily mean)` : ''}${r.usdNative > 0 ? ` (${r.usdNative} dollar-native)` : ''}` +
        `${r.legacyZeroDays > 0 ? `; ${r.legacyZeroDays} day(s) with legacy 0 and chain not 0, counted at 100%` : ''}`,
      `    keep value: ${r.unpriced} unpriced, ${r.noTokens} without tokens, ${r.noHourly} without hourly buckets`,
    ]),
  ];
}

export function registerData(program: Command, ctx: CliContext): void {
  const data = program.command('data').description('enter, confirm, and inspect observations');

  data
    .command('set <asset> <metric> <value>')
    .description('record one observation')
    .option('--at <iso>', 'observed-at timestamp (default: now). For schedule metrics this is the effective date')
    .option('--period-days <n>', 'for flow metrics: days covered, ending at --at')
    .option('--detail <text>', 'where the number came from')
    .option('--provisional', 'store as provisional (requires --citation)')
    .option('--citation <url>', 'citation url')
    .option('--quote <text>', 'quoted source text')
    .option('--json', 'JSON output')
    .action(async (assetId: string, metric: string, value: string, opts: SetOpts) => {
      const { config, hash } = loadAsset(ctx.configRoot, assetId);
      const def = config.metrics[metric];
      if (!def) throw new OrionError('unknown_metric', `metric "${metric}" is not defined in assets/${assetId}.yaml`);
      if (def.type === 'flow' && opts.periodDays === undefined) {
        throw new OrionError(
          'missing_period_days',
          `metric "${metric}" is a flow: pass --period-days <n>, the number of days the value covers, ending at --at`,
        );
      }
      if (def.type !== 'flow' && opts.periodDays !== undefined) {
        throw new OrionError('unexpected_period_days', `metric "${metric}" is a ${def.type} metric: --period-days applies only to flow metrics`);
      }
      const nowIso = ctx.now().toISOString();
      // A figure typed in by hand is a disclosure (its origin reads `manual`; there is no --source since 0006): its
      // provenance is the citation, so --citation is required (spec §3: citation_url NOT NULL when method = disclosed).
      const provenance = disclosedProvenance(hash, { citationUrl: opts.citation, approvedBy: 'user (data set)', approvedAt: nowIso });
      const o = await withDb(ctx, async (db) =>
        await insertObservation(db, {
          assetId,
          metricKey: metric,
          observedAt: opts.at ?? nowIso,
          periodDays: opts.periodDays === undefined ? null : parseNumber(opts.periodDays, '--period-days'),
          value: parseNumber(value, 'value'),
          sourceDetail: opts.detail ?? null,
          status: opts.provisional ? 'provisional' : 'confirmed',
          citationUrl: opts.citation ?? null,
          quotedText: opts.quote ?? null,
          fetchedAt: nowIso,
          provenance,
        }),
      );
      output(ctx, opts.json, o, () => [`recorded #${o.id}: ${assetId} ${metric} = ${o.value} at ${o.observedAt} (${o.status})`]);
    });

  data
    .command('confirm <obs_id>')
    .option('--json', 'JSON output')
    .action(async (id: string, opts: { json?: boolean }) => {
      const n = parseNumber(id, 'obs_id');
      const o = await withDb(ctx, async (db) => {
        const [row] = await getObservationsByIds(db, [n]);
        if (!row) throw new OrionError('observation_not_found', `no observation with id ${n}`);
        return await confirmObservation(db, n, ctx.now().toISOString(), { approvedBy: 'user (data confirm)' });
      });
      output(ctx, opts.json, o, () => [`confirmed as #${o.id}: ${o.metricKey} = ${o.value}`]);
    });

  data
    .command('reject <obs_id>')
    .description('retire an active observation, confirmed or provisional; the row is kept, never deleted')
    .option('--json', 'JSON output')
    .action(async (id: string, opts: { json?: boolean }) => {
      const n = parseNumber(id, 'obs_id');
      await withDb(ctx, (db) => rejectObservation(db, n));
      output(ctx, opts.json, { rejected: n }, () => [`rejected #${n}`]);
    });

  data
    .command('fetch [asset]')
    .description('fetch observations from the sources in the asset YAML; with no asset, every asset that has a source')
    .option('--metric <key>', 'fetch and write only this metric (repeatable; a shared transfer scan still runs once, writing only the listed members)', collect, [])
    .option('--backfill-days <n>', 're-scan flows (transfer scans and API series) this many days back, ignoring the saved cursor')
    .option('--adopt', 'reject manual flow rows that overlap the fetched days, in the same transaction')
    .option('--dry-run', 'read and cross-check, print what would be written, write nothing')
    .option('--json', 'JSON output')
    .action(async (assetId: string | undefined, opts: FetchOpts) => {
      let backfillDays: number | undefined;
      if (opts.backfillDays !== undefined) {
        backfillDays = parseNumber(opts.backfillDays, '--backfill-days');
        if (!Number.isInteger(backfillDays) || backfillDays < 1) throw new OrionError('invalid_number', '--backfill-days must be a positive whole number');
      }
      const ids = assetId ? [assetId] : listAssetIds(ctx.configRoot).filter((id) => hasSources(loadAsset(ctx.configRoot, id).config));
      const deps = ingestDepsFor(ctx);
      const results: FetchResult[] = [];
      await withDb(ctx, async (db) => {
        for (const id of ids) {
          results.push(
            await fetchAsset(db, loadAsset(ctx.configRoot, id), ctx.now(), deps, {
              metrics: opts.metric, backfillDays, adopt: opts.adopt, dryRun: opts.dryRun, onProgress: (line) => ctx.stderr?.(line),
            }),
          );
        }
      });
      output(ctx, opts.json, assetId ? results[0] : results, () =>
        results.length === 0 ? ['no asset defines a source; nothing to fetch'] : results.flatMap(fetchSummary),
      );
    });

  data
    .command('backfill-tokens <asset>')
    .description('fill token amounts on flow rows written before 0005: transfer scans re-scanned by day (hourly buckets), first-party dollar series as token usd (amount = value); never changes value or adds a row; exits 1 when a day was refused; --dry-run writes nothing')
    .option('--metric <key>', 'only this transfer_flow metric or first-party dollar series (repeatable)', collect, [])
    .option('--days <n>', 'days back from now (default: from the oldest stored row)')
    .option('--dry-run', 're-scan and report what would be filled; write nothing, fetch no prices')
    .option('--json', 'JSON output')
    .action(async (assetId: string, opts: { metric: string[]; days?: string; dryRun?: boolean; json?: boolean }) => {
      const days = positiveDays(opts.days, '--days');
      const loaded = loadAsset(ctx.configRoot, assetId);
      const deps = ingestDepsFor(ctx);
      const run = (db: Parameters<typeof backfillTokens>[0]) =>
        backfillTokens(db, loaded, deps, { metrics: opts.metric, days, dryRun: opts.dryRun, onProgress: (line) => ctx.stderr?.(line) });
      const result = await withDb(ctx, async (db) =>
        opts.dryRun ? await run(db) : await withRunLock(db, assetId, lockHolder('orion data backfill-tokens'), ctx.now(), async () => await run(db)),
      );
      output(ctx, opts.json, result, () => backfillTokenLines(result));
      // A refused day is the Step 5 stop rule: scripted runs fail closed on it.
      if (result.refused.length > 0) ctx.setExitCode?.(1);
    });

  data
    .command('purge <asset>')
    .description(
      'delete the stored history of a metric no longer configured, or of a configured metric only the rows of a retired source type (--source-type); ' +
        'a dry run unless --yes, which first writes every row it deletes to $ORION_HOME/purged. Refused for the current source\'s type, an open anomaly, or a kept row pointing at a deleted one',
    )
    .option('--metric <key>', 'metric to purge (repeatable)', collect, [])
    .option('--source-type <type>', 'purge only rows of this source type (required for a configured metric; never its current one)')
    .option('--yes', 'delete, after writing the export')
    .option('--json', 'JSON output')
    .action(async (assetId: string, opts: { metric: string[]; sourceType?: string; yes?: boolean; json?: boolean }) =>
      await guarded(ctx, opts.json, async () => {
        const loaded = loadAsset(ctx.configRoot, assetId);
        const exportDir = join(ctx.home, 'purged');
        const result = await withDb(ctx, async (db) =>
          await purgeMetrics(db, loaded, { metrics: opts.metric, sourceType: opts.sourceType as SourceType | undefined, apply: opts.yes === true, exportDir, now: ctx.now() }),
        );
        output(ctx, opts.json, result, () => purgeLines(result, opts.sourceType, exportDir));
      }),
    );

  data
    .command('reprice <asset>')
    .description(
      'rewrite, in place, the stored USD value of every CoinGecko-priced flow row (transfer scans, the Solana supply drop) from the chain prices ' +
        'flow_usd_chain_v reads; remaps coingecko:crvusd / coingecko:yearn-crv refs and recomputes the derived rates over them. ' +
        'A dry run unless --yes, which first writes every row it touches to $ORION_HOME/repriced. Rows with an unpriced hour are refused and keep their value; ' +
        `exits ${REPRICE_REFUSED_EXIT} when any row is refused`,
    )
    .option('--from <day>', 'first UTC day (YYYY-MM-DD) to reprice (default: every day)')
    .option('--yes', 'write, after the export')
    .option('--json', 'JSON output')
    .action(async (assetId: string, opts: { from?: string; yes?: boolean; json?: boolean }) =>
      await guarded(ctx, opts.json, async () => {
        const loaded = loadAsset(ctx.configRoot, assetId);
        const exportDir = join(ctx.home, 'repriced');
        const result = await withDb(ctx, async (db) =>
          await repriceAsset(db, loaded, { from: opts.from, yes: opts.yes === true, now: ctx.now(), exportDir, ...(ctx.release ? { release: ctx.release.tag } : {}) }),
        );
        output(ctx, opts.json, result, () => repriceLines(result, exportDir));
        // A refused row keeps its CoinGecko value: exit 3 (dry run and --yes) so an operator or script can't miss it.
        if (result.perMetric.some((m) => m.refused.length > 0)) ctx.setExitCode?.(REPRICE_REFUSED_EXIT);
      }),
    );

  data
    .command('rebuild-price-levels <asset>')
    .description(
      'for every CoinGecko price_usd / diem_price_usd level row: a new row at the same observed_at from the newest chain/first-party price ' +
        'at least 1 h before it (refused beyond 6 h: the row keeps its CoinGecko value); a dry run unless --yes. Deletes nothing (data purge --source-type market_data does); ' +
          `exits ${REPRICE_REFUSED_EXIT} when any row is refused`,
    )
    .option('--yes', 'write the rebuilt rows')
    .option('--json', 'JSON output')
    .action(async (assetId: string, opts: { yes?: boolean; json?: boolean }) =>
      await guarded(ctx, opts.json, async () => {
        const loaded = loadAsset(ctx.configRoot, assetId);
        const result = await withDb(ctx, async (db) =>
          await rebuildPriceLevels(db, loaded, { yes: opts.yes === true, now: ctx.now(), ...(ctx.release ? { release: ctx.release.tag } : {}) }),
        );
        output(ctx, opts.json, result, () => rebuildLines(result));
        // A refused row keeps its CoinGecko row: exit 3 (dry run and --yes), as data reprice, so the release block stops.
        if (result.perMetric.some((m) => m.refused.length > 0)) ctx.setExitCode?.(REPRICE_REFUSED_EXIT);
      }),
    );

  data
    .command('purge-prices')
    .description(
      'delete every prices row of a source (only coingecko), then the coingecko:* tokens rows nothing references; refused while an active ' +
        'observation still has a coingecko:* token ref (data reprice --yes remaps them). A dry run unless --yes, which first exports to $ORION_HOME/purged',
    )
    .requiredOption('--source <source>', 'the price source to delete (coingecko)')
    .option('--yes', 'delete, after writing the export')
    .option('--json', 'JSON output')
    .action(async (opts: { source: string; yes?: boolean; json?: boolean }) =>
      await guarded(ctx, opts.json, async () => {
        const exportDir = join(ctx.home, 'purged');
        const result = await withDb(ctx, async (db) =>
          await purgePrices(db, { source: opts.source as 'coingecko', yes: opts.yes === true, exportDir, now: ctx.now() }),
        );
        output(ctx, opts.json, result, () => purgePricesLines(result, exportDir));
      }),
    );

  data
    .command('compare-usd <asset>')
    .description('per USD flow metric: the stored USD (value) vs the chain-priced USD (flow_usd_chain_v: hourly buckets, or the daily mean, x chain/first-party prices); read-only')
    .option('--days <n>', 'window in days, ending now', '91')
    .option('--json', 'JSON output')
    .action(async (assetId: string, opts: { days: string; json?: boolean }) => {
      const days = positiveDays(opts.days, '--days')!;
      const { config } = loadAsset(ctx.configRoot, assetId);
      const rows = await withDb(ctx, (db) => compareUsd(db, config, days, { now: ctx.now() }));
      output(ctx, opts.json, rows, () => compareLines(assetId, days, rows));
    });

  data
    .command('sources <asset>')
    .description('per metric: its source and cross-checks, the last fetch outcome, and the age of the value in force')
    .option('--json', 'JSON output')
    .action(async (assetId: string, opts: { json?: boolean }) => {
      const { config } = loadAsset(ctx.configRoot, assetId);
      const rows = await withDb(ctx, (db) => describeSources(db, config, ctx.now()));
      output(ctx, opts.json, rows, () =>
        rows.length === 0
          ? ['no metric has a source; everything is entered by hand']
          : rows.flatMap((r) => [
              `${r.metric}  ${r.sourceId}  last fetch ${r.lastFetch ? r.lastFetch.status : 'never'}  ` +
                (r.valueInForce ? `value ${r.valueInForce.value} (${r.valueInForce.ageDays.toFixed(1)} days old)` : 'no value yet'),
              ...(r.lastFetch?.error ? [`    error: ${r.lastFetch.error}`] : []),
              ...r.crossChecks.map((c) => `    cross-check ${c.sourceId} (tolerance ${c.tolerancePct}%)`),
            ]),
      );
    });

  data
    .command('anomalies [asset]')
    .description('open anomalies, newest first; --all includes resolved and acknowledged ones')
    .option('--all', 'include resolved and acknowledged anomalies')
    .option('--json', 'JSON output')
    .action(async (assetId: string | undefined, opts: { all?: boolean; json?: boolean }) => {
      const list = await withDb(ctx, (db) => listAnomalies(db, { assetId, includeDecided: opts.all }));
      output(ctx, opts.json, list, () => (list.length === 0 ? [opts.all ? 'no anomalies' : 'no open anomalies'] : list.map(anomalyLine)));
    });

  for (const [name, status, summary] of [
    ['resolve', 'resolved', 'the cause is fixed; if it recurs, a new anomaly opens. Also withdraws an acknowledgement'],
    ['ack', 'acknowledged', 'the cause is understood and accepted; it is no longer listed in the daily report, also when seen again'],
  ] as const) {
    data
      .command(`${name} <id>`)
      .description(`close an anomaly: ${summary}`)
      .requiredOption('--note <text>', 'why')
      .option('--json', 'JSON output')
      .action(async (id: string, opts: { note: string; json?: boolean }) => {
        const a = await withDb(ctx, (db) => decideAnomaly(db, parseNumber(id, 'id'), status, opts.note, ctx.now().toISOString()));
        output(ctx, opts.json, a, () => [`anomaly #${a.id} ${a.status}: ${a.note}`]);
      });
  }

  data
    .command('show <asset> [metric]')
    .description('list active observations, newest first')
    .option('--json', 'JSON output')
    .action(async (assetId: string, metric: string | undefined, opts: { json?: boolean }) => {
      const list = (await withDb(ctx, (db) => listActiveObservations(db, assetId, metric))).reverse();
      output(ctx, opts.json, list, () =>
        list.length === 0
          ? ['no active observations']
          : list.map((o) => `#${o.id}  ${o.metricKey}  ${o.value}  ${o.observedAt}  ${o.source}  ${o.status}${o.periodDays ? `  period ${o.periodDays}d` : ''}`),
      );
    });
}
