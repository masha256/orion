import type { Command } from 'commander';
import { loadAsset } from '../../config/load.js';
import { confirmObservation, insertObservation, listActiveObservations, rejectObservation } from '../../db/observations.js';
import { OrionError, type ObservationSource } from '../../types.js';
import { output, parseNumber, withDb, type CliContext } from '../util.js';

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
