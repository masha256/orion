import type { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { saveAssumptions } from '../../app/assumptions.js';
import { replayRun, runValuation, whatIf } from '../../app/valuation.js';
import { loadAsset } from '../../config/load.js';
import { getLatestAssumptionSet, listAssumptionSets } from '../../db/assumptions.js';
import { OrionError, SCENARIOS, type AssumptionValues, type Scenario } from '../../types.js';
import { fmt, output, parseNumber, signalSummary, withDb, type CliContext } from '../util.js';

const isScenario = (x: string): x is Scenario => (SCENARIOS as readonly string[]).includes(x);
const collect = (value: string, previous: string[]): string[] => [...previous, value];

function readImportFile(path: string): AssumptionValues {
  const raw = parseYaml(readFileSync(path, 'utf8')) as Record<string, unknown> | null;
  if (!raw || typeof raw !== 'object') throw new OrionError('invalid_import', `${path} is not a YAML map`);
  const section = (name: string): Record<string, number> => {
    const s = raw[name];
    if (s === undefined) return {};
    if (s === null || typeof s !== 'object') throw new OrionError('invalid_import', `${path}: "${name}" must be a map`);
    for (const [k, v] of Object.entries(s)) {
      if (typeof v !== 'number') throw new OrionError('invalid_import', `${path}: ${name}.${k} must be a number`);
    }
    return s as Record<string, number>;
  };
  for (const key of Object.keys(raw)) {
    if (key !== 'all' && !isScenario(key)) throw new OrionError('invalid_import', `${path}: unknown section "${key}"`);
  }
  const all = section('all');
  return { bear: { ...all, ...section('bear') }, base: { ...all, ...section('base') }, bull: { ...all, ...section('bull') } };
}

export function registerModel(program: Command, ctx: CliContext): void {
  const model = program.command('model').description('run valuations and manage assumptions');

  model
    .command('run <asset>')
    .description('snapshot data, run the engine, and persist a signal')
    .option('--as-of <iso>', 'valuation time (default: now). Use for backfills and reproducible demos')
    .option('--json', 'JSON output')
    .action((assetId: string, opts: { asOf?: string; json?: boolean }) => {
      const loaded = loadAsset(ctx.home, assetId);
      const now = opts.asOf ? new Date(opts.asOf) : ctx.now();
      if (Number.isNaN(now.getTime())) throw new OrionError('invalid_timestamp', `invalid --as-of: ${opts.asOf}`);
      const { signal } = withDb(ctx, (db) => runValuation(db, loaded, now));
      output(ctx, opts.json, signal, () => signalSummary(signal));
    });

  model
    .command('whatif <asset>')
    .description('run the engine with assumption overrides; nothing is saved and bounds are not enforced')
    .option('--set <key=value>', 'override (repeatable)', collect, [])
    .option('--scenario <scenario>', 'apply overrides to one scenario (default: all)')
    .option('--as-of <iso>', 'valuation time (default: now)')
    .option('--json', 'JSON output')
    .action((assetId: string, opts: { set: string[]; scenario?: string; asOf?: string; json?: boolean }) => {
      if (opts.scenario !== undefined && !isScenario(opts.scenario)) throw new OrionError('invalid_scenario', `unknown scenario: ${opts.scenario}`);
      const scenario = opts.scenario as Scenario | undefined;
      const overrides = opts.set.map((pair) => {
        const i = pair.indexOf('=');
        if (i <= 0) throw new OrionError('invalid_override', `expected key=value, got "${pair}"`);
        return { key: pair.slice(0, i), value: parseNumber(pair.slice(i + 1), pair.slice(0, i)), scenario };
      });
      const loaded = loadAsset(ctx.home, assetId);
      const now = opts.asOf ? new Date(opts.asOf) : ctx.now();
      if (Number.isNaN(now.getTime())) throw new OrionError('invalid_timestamp', `invalid --as-of: ${opts.asOf}`);
      const result = withDb(ctx, (db) => whatIf(db, loaded, now, overrides));
      output(ctx, opts.json, result, () => {
        if ('blocked' in result) return ['cannot run:', ...result.blocked.map((b) => `  ${b}`)];
        return Object.entries(result.output.horizons).flatMap(([name, h]) => [
          `${name}  expected ${fmt(h.expectedTarget)}  upside ${h.upsidePct.toFixed(1)}%  dispersion ${h.dispersion.toFixed(2)}`,
          '     ' + SCENARIOS.map((s) => `${s} ${fmt(h.scenarios[s].target)}`).join('  '),
        ]);
      });
    });

  const assumptions = model.command('assumptions').description('versioned assumption sets');

  assumptions
    .command('show <asset>')
    .option('--json', 'JSON output')
    .action((assetId: string, opts: { json?: boolean }) => {
      const { config } = loadAsset(ctx.home, assetId);
      const set = withDb(ctx, (db) => getLatestAssumptionSet(db, assetId));
      if (!set) throw new OrionError('no_assumption_set', `no assumption set for ${assetId}; use "orion model assumptions import"`);
      output(ctx, opts.json, set, () => [
        `${assetId} assumptions v${set.version} by ${set.author} at ${set.createdAt}: ${set.rationale}`,
        ...Object.keys(set.values.base).sort().map((key) => {
          const b = config.assumptions[key];
          const bounds = b ? `[${b.min}, ${b.max}]` : '[no bounds]';
          return `  ${key}  bear ${set.values.bear[key]}  base ${set.values.base[key]}  bull ${set.values.bull[key]}  ${bounds}`;
        }),
      ]);
    });

  assumptions
    .command('set <asset> <key> <value>')
    .description('create a new version with one value changed')
    .requiredOption('--rationale <text>', 'why this changed')
    .option('--scenario <scenario>', 'bear | base | bull | all', 'all')
    .option('--json', 'JSON output')
    .action((assetId: string, key: string, value: string, opts: { rationale: string; scenario: string; json?: boolean }) => {
      if (opts.scenario !== 'all' && !isScenario(opts.scenario)) throw new OrionError('invalid_scenario', `unknown scenario: ${opts.scenario}`);
      const { config } = loadAsset(ctx.home, assetId);
      const v = parseNumber(value, 'value');
      const set = withDb(ctx, (db) => {
        const latest = getLatestAssumptionSet(db, assetId);
        if (!latest) throw new OrionError('no_assumption_set', `no assumption set for ${assetId}; import one first`);
        const values: AssumptionValues = { bear: { ...latest.values.bear }, base: { ...latest.values.base }, bull: { ...latest.values.bull } };
        for (const s of opts.scenario === 'all' ? SCENARIOS : [opts.scenario as Scenario]) values[s][key] = v;
        return saveAssumptions(db, config, values, { author: 'user', rationale: opts.rationale, now: ctx.now() });
      });
      output(ctx, opts.json, set, () => [`${assetId} assumptions v${set.version}: ${key} = ${v} (${opts.scenario})`]);
    });

  assumptions
    .command('import <asset> <file>')
    .description('create a new version from a YAML file with all/bear/base/bull sections')
    .requiredOption('--rationale <text>', 'why this set exists')
    .option('--json', 'JSON output')
    .action((assetId: string, file: string, opts: { rationale: string; json?: boolean }) => {
      const { config } = loadAsset(ctx.home, assetId);
      const values = readImportFile(file);
      const set = withDb(ctx, (db) => saveAssumptions(db, config, values, { author: 'user', rationale: opts.rationale, now: ctx.now() }));
      output(ctx, opts.json, set, () => [`${assetId} assumptions v${set.version} imported from ${file}`]);
    });

  assumptions
    .command('history <asset>')
    .option('--json', 'JSON output')
    .action((assetId: string, opts: { json?: boolean }) => {
      const list = withDb(ctx, (db) => listAssumptionSets(db, assetId));
      output(ctx, opts.json, list, () =>
        list.length === 0 ? ['no assumption sets'] : list.map((s) => `v${s.version}  ${s.createdAt}  ${s.author}  ${s.rationale}`),
      );
    });

  model
    .command('replay <run_id>')
    .description('recompute a stored run from its frozen inputs and compare byte for byte')
    .option('--json', 'JSON output')
    .action((runId: string, opts: { json?: boolean }) => {
      const result = withDb(ctx, (db) => replayRun(db, parseNumber(runId, 'run_id')));
      output(ctx, opts.json, { run_id: Number(runId), identical: result.identical }, () => [
        result.identical ? `run ${runId}: replay is identical` : `run ${runId}: REPLAY DIFFERS from the stored output`,
      ]);
      if (!result.identical) throw new OrionError('replay_mismatch', `run ${runId} did not reproduce`);
    });
}
