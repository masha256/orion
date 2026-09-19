import type { Command } from 'commander';
import { listAssetIds, loadAsset } from '../../config/load.js';
import { decideAnomaly, listAnomalies, type Anomaly } from '../../db/anomalies.js';
import { confirmObservation, insertObservation, listActiveObservations, rejectObservation } from '../../db/observations.js';
import { describeSources } from '../../ingest/describe.js';
import { hasSources } from '../../ingest/plan.js';
import { fetchAsset, type FetchResult } from '../../ingest/run.js';
import { OrionError, type ObservationSource } from '../../types.js';
import { fetchSummary, ingestDepsFor, output, parseNumber, withDb, withDbAsync, type CliContext } from '../util.js';

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
  source: string;
  detail?: string;
  provisional?: boolean;
  citation?: string;
  quote?: string;
  json?: boolean;
}

const collect = (value: string, previous: string[]): string[] => [...previous, value];

const anomalyLine = (a: Anomaly): string =>
  `#${a.id}  ${a.status}  ${a.severity}  ${a.kind}  ${a.metricKey || '(source)'}  ${a.dedupeKey}  x${a.occurrences}  last seen ${a.lastSeenAt}${a.note ? `  note: ${a.note}` : ''}`;

const SOURCES: ObservationSource[] = ['onchain', 'api', 'manual'];

export function registerData(program: Command, ctx: CliContext): void {
  const data = program.command('data').description('enter, confirm, and inspect observations');

  data
    .command('set <asset> <metric> <value>')
    .description('record one observation')
    .option('--at <iso>', 'observed-at timestamp (default: now). For schedule metrics this is the effective date')
    .option('--period-days <n>', 'for flow metrics: days covered, ending at --at')
    .option('--source <source>', 'onchain | api | manual', 'manual')
    .option('--detail <text>', 'where the number came from')
    .option('--provisional', 'store as provisional (requires --citation)')
    .option('--citation <url>', 'citation url')
    .option('--quote <text>', 'quoted source text')
    .option('--json', 'JSON output')
    .action((assetId: string, metric: string, value: string, opts: SetOpts) => {
      const { config } = loadAsset(ctx.home, assetId);
      const def = config.metrics[metric];
      if (!def) throw new OrionError('unknown_metric', `metric "${metric}" is not defined in assets/${assetId}.yaml`);
      if (!SOURCES.includes(opts.source as ObservationSource)) throw new OrionError('invalid_source', `source must be one of ${SOURCES.join(', ')}`);
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
      const o = withDb(ctx, (db) =>
        insertObservation(db, {
          assetId,
          metricKey: metric,
          observedAt: opts.at ?? nowIso,
          periodDays: opts.periodDays === undefined ? null : parseNumber(opts.periodDays, '--period-days'),
          value: parseNumber(value, 'value'),
          source: opts.source as ObservationSource,
          sourceDetail: opts.detail ?? null,
          status: opts.provisional ? 'provisional' : 'confirmed',
          citationUrl: opts.citation ?? null,
          quotedText: opts.quote ?? null,
          fetchedAt: nowIso,
        }),
      );
      output(ctx, opts.json, o, () => [`recorded #${o.id}: ${assetId} ${metric} = ${o.value} at ${o.observedAt} (${o.status})`]);
    });

  data
    .command('confirm <obs_id>')
    .option('--json', 'JSON output')
    .action((id: string, opts: { json?: boolean }) => {
      const o = withDb(ctx, (db) => confirmObservation(db, parseNumber(id, 'obs_id'), ctx.now().toISOString()));
      output(ctx, opts.json, o, () => [`confirmed as #${o.id}: ${o.metricKey} = ${o.value}`]);
    });

  data
    .command('reject <obs_id>')
    .description('retire an active observation, confirmed or provisional; the row is kept, never deleted')
    .option('--json', 'JSON output')
    .action((id: string, opts: { json?: boolean }) => {
      const n = parseNumber(id, 'obs_id');
      withDb(ctx, (db) => rejectObservation(db, n));
      output(ctx, opts.json, { rejected: n }, () => [`rejected #${n}`]);
    });

  data
    .command('fetch [asset]')
    .description('fetch observations from the sources in the asset YAML; with no asset, every asset that has a source')
    .option('--metric <key>', 'fetch only this metric (repeatable)', collect, [])
    .option('--backfill-days <n>', 're-scan transfer flows this many days back, ignoring the saved cursor')
    .option('--adopt', 'reject manual flow rows that overlap the fetched days, in the same transaction')
    .option('--dry-run', 'read and cross-check, print what would be written, write nothing')
    .option('--json', 'JSON output')
    .action(async (assetId: string | undefined, opts: FetchOpts) => {
      let backfillDays: number | undefined;
      if (opts.backfillDays !== undefined) {
        backfillDays = parseNumber(opts.backfillDays, '--backfill-days');
        if (!Number.isInteger(backfillDays) || backfillDays < 1) throw new OrionError('invalid_number', '--backfill-days must be a positive whole number');
      }
      const ids = assetId ? [assetId] : listAssetIds(ctx.home).filter((id) => hasSources(loadAsset(ctx.home, id).config));
      const deps = ingestDepsFor(ctx);
      const results: FetchResult[] = [];
      await withDbAsync(ctx, async (db) => {
        for (const id of ids) {
          results.push(
            await fetchAsset(db, loadAsset(ctx.home, id), ctx.now(), deps, {
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
    .command('sources <asset>')
    .description('per metric: its source and cross-checks, the last fetch outcome, and the age of the value in force')
    .option('--json', 'JSON output')
    .action((assetId: string, opts: { json?: boolean }) => {
      const { config } = loadAsset(ctx.home, assetId);
      const rows = withDb(ctx, (db) => describeSources(db, config, ctx.now()));
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
    .action((assetId: string | undefined, opts: { all?: boolean; json?: boolean }) => {
      const list = withDb(ctx, (db) => listAnomalies(db, { assetId, includeDecided: opts.all }));
      output(ctx, opts.json, list, () => (list.length === 0 ? [opts.all ? 'no anomalies' : 'no open anomalies'] : list.map(anomalyLine)));
    });

  for (const [name, status, summary] of [
    ['resolve', 'resolved', 'the cause is fixed'],
    ['ack', 'acknowledged', 'the cause is understood and accepted; it no longer affects the signal'],
  ] as const) {
    data
      .command(`${name} <id>`)
      .description(`close an open anomaly: ${summary}`)
      .requiredOption('--note <text>', 'why')
      .option('--json', 'JSON output')
      .action((id: string, opts: { note: string; json?: boolean }) => {
        const a = withDb(ctx, (db) => decideAnomaly(db, parseNumber(id, 'id'), status, opts.note, ctx.now().toISOString()));
        output(ctx, opts.json, a, () => [`anomaly #${a.id} ${a.status}: ${a.note}`]);
      });
  }

  data
    .command('show <asset> [metric]')
    .description('list active observations, newest first')
    .option('--json', 'JSON output')
    .action((assetId: string, metric: string | undefined, opts: { json?: boolean }) => {
      const list = withDb(ctx, (db) => listActiveObservations(db, assetId, metric)).reverse();
      output(ctx, opts.json, list, () =>
        list.length === 0
          ? ['no active observations']
          : list.map((o) => `#${o.id}  ${o.metricKey}  ${o.value}  ${o.observedAt}  ${o.source}  ${o.status}${o.periodDays ? `  period ${o.periodDays}d` : ''}`),
      );
    });
}
