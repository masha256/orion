import type { Command } from 'commander';
import { listAssetIds, loadAsset } from '../../config/load.js';
import { decideAnomaly, listAnomalies, type Anomaly } from '../../db/anomalies.js';
import { confirmObservation, getObservationsByIds, insertObservation, listActiveObservations, rejectObservation } from '../../db/observations.js';
import { compareUsd, type UsdComparison } from '../../db/prices.js';
import { describeSources } from '../../ingest/describe.js';
import { backfillTokens, type BackfillTokensResult } from '../../ingest/tokenBackfill.js';
import { lockHolder, withRunLock } from '../../app/lock.js';
import { hasSources } from '../../ingest/plan.js';
import { fetchAsset, type FetchResult } from '../../ingest/run.js';
import { confirmConfigHash } from '../../provenance/configHash.js';
import { disclosedProvenance } from '../../provenance/locator.js';
import { OrionError, type ObservationSource } from '../../types.js';
import { fetchSummary, ingestDepsFor, output, parseNumber, withDb, type CliContext } from '../util.js';

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
    ...r.prices.map((p) => `  prices ${p.coingeckoId} (${p.tokenRefs.join(', ')}): ${p.rows} hourly row(s) in ${p.requests} request(s)${p.reachedDay ? `, from ${p.reachedDay}` : ''}${p.failures.map((f) => `; FAILED ${f}`).join('')}`),
    ...r.refused.map((x) => `  REFUSED ${x.day}: ${x.reason}`),
    ...r.skipped.map((x) => `  skipped ${x.day} ${x.metricKey}: ${x.reason}`),
    ...r.notes.map((n) => `  note: ${n}`),
  ];
}

function compareLines(assetId: string, days: number, rows: UsdComparison[]): string[] {
  if (rows.length === 0) return [`${assetId.toUpperCase()}: no USD flow metric`];
  return [
    `${assetId.toUpperCase()} legacy USD vs hourly buckets, ${days} days (within the hourly series; beyond it apart, plan correction 13)`,
    ...rows.flatMap((r) => [
      `  ${r.metric}: ${r.hourlyCovered} day(s) within: legacy ${usd(r.sumLegacy)} vs hourly ${usd(r.sumHourly)} (${pct(r.gapPct)}), day gap p50 ${pct(r.p50DayGapPct)} p90 ${pct(r.p90DayGapPct)}` +
        `${r.usdNative > 0 ? ` (${r.usdNative} dollar-native)` : ''}${r.legacyZeroDays > 0 ? `; ${r.legacyZeroDays} day(s) with legacy 0 and hourly not 0, counted at 100%` : ''}`,
      `    beyond: ${r.beyondHourly} day(s): legacy ${usd(r.beyond.sumLegacy)} vs hourly ${usd(r.beyond.sumHourly)} (${pct(r.beyond.gapPct)}); ` +
        `keep value: ${r.unpriced} unpriced, ${r.noTokens} without tokens, ${r.noHourly} without hourly buckets`,
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
    .option('--source <source>', 'onchain | api | manual', 'manual')
    .option('--detail <text>', 'where the number came from')
    .option('--provisional', 'store as provisional (requires --citation)')
    .option('--citation <url>', 'citation url')
    .option('--quote <text>', 'quoted source text')
    .option('--json', 'JSON output')
    .action(async (assetId: string, metric: string, value: string, opts: SetOpts) => {
      const { config, hash } = loadAsset(ctx.configRoot, assetId);
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
      // A figure typed in by hand is a disclosure whatever --source says (that column is still written as given): its
      // provenance is the citation, so --citation is required (spec §3: citation_url NOT NULL when method = disclosed).
      const provenance = disclosedProvenance(hash, { citationUrl: opts.citation, approvedBy: 'user (data set)', approvedAt: nowIso });
      const o = await withDb(ctx, async (db) =>
        await insertObservation(db, {
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
        return await confirmObservation(db, n, ctx.now().toISOString(), { approvedBy: 'user (data confirm)', configHash: confirmConfigHash(ctx.configRoot, row.assetId) });
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
    .option('--metric <key>', 'fetch only this metric (repeatable)', collect, [])
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
    .command('compare-usd <asset>')
    .description('per USD flow metric: the stored USD (value) vs the hourly token buckets x hourly prices (flow_usd_v), days within and beyond the hourly series apart; read-only')
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
